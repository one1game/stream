#!/usr/bin/env python3
"""Локальный предпросмотр эфира в браузере.

Гонит ту же связку, что уходит на YouTube (игры + радио), но вместо RTMP
пишет HLS в папку и отдаёт её по HTTP. Ничего не отправляется наружу,
ключ трансляции не нужен.

    python tools/preview.py                  # обычный режим, сцены по музыке
    python tools/preview.py --rehearse 12    # менять сцену каждые 12 секунд
    python tools/preview.py --genre cyber    # зафиксировать один жанр
    python tools/preview.py --quality light  # полегче, если машина слабая

FFmpeg берётся из PATH. Если его там нет, путь можно задать переменной FFMPEG.
"""

from __future__ import annotations

import argparse
import http.server
import os
import socketserver
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "scripts"))
import start_stream as ss  # noqa: E402  — переиспользуем пресеты и адреса портов

OUT_DIR = ROOT / "tools" / "preview_out"
PORT = 8765


def find_ffmpeg() -> str:
    """FFmpeg для локального показа.

    Сначала переменная окружения, потом своя сборка в tools/ffmpeg (её кладут
    рядом, чтобы предпросмотр не зависел от системного PATH), и только затем
    ffmpeg из PATH.
    """
    override = os.environ.get("FFMPEG")
    if override:
        return override
    local = ROOT / "tools" / "ffmpeg" / "bin"
    for name in ("ffmpeg.exe", "ffmpeg"):
        if (local / name).exists():
            return str(local / name)
    return "ffmpeg"


FFMPEG = find_ffmpeg()

PLAYER = """<!DOCTYPE html>
<html lang="ru"><head><meta charset="UTF-8">
<title>Предпросмотр эфира</title>
<style>
  html,body{margin:0;height:100%;background:#0b0a12;color:#c9bda8;
    font:14px/1.5 -apple-system,"Segoe UI",sans-serif;
    display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px}
  video{max-width:92vw;max-height:80vh;background:#000;border-radius:10px;
    box-shadow:0 20px 60px rgba(0,0,0,.7)}
  .hint{opacity:.6}
</style></head>
<body>
<video id="v" controls autoplay muted playsinline></video>
<div class="hint">Это ровно тот поток, что уходит на YouTube — только вместо RTMP он пишется в HLS.
Задержка 6-10 секунд, это нормально. Звук включи кнопкой на плеере.</div>
<script src="https://cdn.jsdelivr.net/npm/hls.js@1/dist/hls.min.js"></script>
<script>
  const v = document.getElementById('v');
  const src = 'stream.m3u8';
  if (window.Hls && Hls.isSupported()) {
    const hls = new Hls({ liveSyncDurationCount: 2, lowLatencyMode: false });
    hls.loadSource(src); hls.attachMedia(v);
    hls.on(Hls.Events.ERROR, (e, d) => { if (d.fatal) setTimeout(() => location.reload(), 2000); });
  } else {
    v.src = src;   // Safari играет HLS сам
  }
</script>
</body></html>
"""


def hls_command(src: tuple[int, int, int], out: tuple[int, int, int],
                video_port: int, audio_port: int, grain: bool = True) -> list[str]:
    width, height, fps = src
    out_w, out_h, out_fps = out
    filters = []
    if (width, height) != (out_w, out_h):
        # Тот же сглаженный подъём, что и в эфире: иначе предпросмотр показывал
        # бы крупный пиксель там, где на YouTube картинка мягкая.
        filters.append(f"scale={out_w}:{out_h}:flags=bicubic")
    # Источник рисует реже эфира — сначала добираем кадры до эфирной частоты,
    # потом зерно, чтобы дублированные кадры друг от друга отличались.
    filters.append(f"fps={out_fps}")
    if grain:
        filters.append("noise=alls=5:allf=t")
    return [
        FFMPEG, "-hide_banner", "-nostdin", "-loglevel", "warning",
        "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{width}x{height}", "-r", str(fps),
        "-i", f"tcp://127.0.0.1:{video_port}",
        "-f", "f32le", "-ar", "44100", "-ac", "2",
        "-i", f"tcp://127.0.0.1:{audio_port}",
        "-map", "0:v", "-map", "1:a",
        "-vf", ",".join(filters),
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        "-g", str(out_fps * 2), "-keyint_min", str(out_fps * 2), "-sc_threshold", "0",
        "-b:v", ss.VIDEO_BITRATE, "-maxrate", ss.VIDEO_BITRATE, "-bufsize", "6000k",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
        "-f", "hls", "-hls_time", "2", "-hls_list_size", "4",
        "-hls_flags", "delete_segments+omit_endlist",
        "-hls_segment_filename", str(OUT_DIR / "seg%05d.ts"),
        str(OUT_DIR / "stream.m3u8"),
    ]


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(OUT_DIR), **kw)

    def end_headers(self):
        # Плейлист меняется каждые пару секунд — кэш только мешает.
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Access-Control-Allow-Origin", "*")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description="Предпросмотр эфира в браузере")
    parser.add_argument("--quality", default="normal", choices=sorted(ss.QUALITY))
    parser.add_argument("--minutes", type=float, default=180, help="длительность показа")
    parser.add_argument("--rehearse", type=float, default=0,
                        help="менять сцену каждые N секунд, не дожидаясь трека")
    parser.add_argument("--genre", default="", help="зафиксировать один слой или жанр")
    parser.add_argument("--video", default=ss.VIDEO_FILE,
                        help="что показывать: newvideo.html — улица, game_video.html — игры")
    parser.add_argument("--seed", type=int, default=0)
    args = parser.parse_args()

    if not OUT_DIR.exists():
        OUT_DIR.mkdir(parents=True)
    for stale in list(OUT_DIR.glob("*.ts")) + list(OUT_DIR.glob("*.m3u8")):
        stale.unlink()
    (OUT_DIR / "index.html").write_text(PLAYER, encoding="utf-8")

    src, out = ss.sizes(args.video, args.quality)
    seed = args.seed or int(time.time()) & 0xffffffff

    command = ss.source_command(seed, src, args.video)
    if args.rehearse:
        command.append(f"--rehearse={args.rehearse}")
    if args.genre:
        command.append(f"--genre={args.genre}")

    print(f"Источник {src[0]}x{src[1]}@{src[2]}, эфир {out[0]}x{out[1]}@{out[2]}, "
          f"режим {args.quality}, звук {ss.audio_for(args.video)}.", flush=True)
    source = subprocess.Popen(
        command, cwd=str(ROOT),
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
    )

    ports: dict[str, tuple[int, int, int]] = {}
    ready = threading.Event()

    def pump() -> None:
        for line in source.stderr:
            line = line.rstrip()
            if line.startswith("ready "):
                a, b, fps = line.split()[1:4]
                ports["p"] = (int(a), int(b), int(fps))
                ready.set()
            elif line:
                print(f"[source] {line}", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    if not ready.wait(60):
        source.kill()
        print("Источник не поднялся.", file=sys.stderr)
        return 1

    video_port, audio_port, src_fps = ports["p"]
    encoder = subprocess.Popen(
        hls_command((src[0], src[1], src_fps), out, video_port, audio_port,
                    ss.grain_for(args.video)),
        cwd=str(ROOT))

    server = socketserver.ThreadingTCPServer(("127.0.0.1", PORT), Handler)
    server.daemon_threads = True
    threading.Thread(target=server.serve_forever, daemon=True).start()

    print(f"\nОткрывай в браузере: http://localhost:{PORT}/")
    print("Запустится через несколько секунд, когда наберётся пара сегментов.")
    print("Остановить — Ctrl+C.\n", flush=True)

    deadline = time.time() + args.minutes * 60
    try:
        while time.time() < deadline and encoder.poll() is None:
            time.sleep(1)
    except KeyboardInterrupt:
        print("\nОстанавливаю.")
    finally:
        encoder.terminate()
        source.terminate()
        server.shutdown()
    return 0


if __name__ == "__main__":
    sys.exit(main())

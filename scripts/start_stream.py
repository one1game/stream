#!/usr/bin/env python3
"""Гонит процедурный эфир на YouTube по постоянному stream key.

Картинку и звук отдаёт scripts/stream_source.mjs — он исполняет reneratorvideo.html
на Skia-канвасе и радио-движок из radio/ прямо в Node, без браузера. Этот скрипт
только связывает источник с FFmpeg и следит за дедлайном.

    python start_stream.py --minutes 348
"""

from __future__ import annotations

import argparse
import os
import random
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

RTMP_BASE = "rtmp://a.rtmp.youtube.com/live2"
SOURCE = Path(__file__).with_name("stream_source.mjs")
ROOT = Path(__file__).resolve().parent.parent

# Источник рисует кадры реже и мельче, чем идёт эфир.
#
# Замеры генератора пейзажа: 640x360 — ~49 мс на кадр, 960x540 — ~61 мс,
# 1280x720 — ~62 мс. Цена почти не зависит от разрешения, потому что платим
# не за пиксели, а за количество графических вызовов на кадр: 800 песчинок
# зерна, 200 звёзд, сотня линий дождя и пять полноэкранных наложений.
# Отсюда потолок около 20 fps в любом разрешении, и 30 fps этот генератор
# на двух ядрах не отдаёт.
#
# Поэтому рисуем 15 кадров в секунду (для медленного пейзажа дубли достаточно),
# а масштаб до эфирного разрешения и добор кадров до 30 делает FFmpeg:
# растянуть картинку в разы дешевле, чем растеризовать её заново.
QUALITY = {
    "light":  ((640, 360, 15), (854, 480, 30)),
    "normal": ((854, 480, 15), (1280, 720, 30)),
    "high":   ((1280, 720, 12), (1280, 720, 30)),
}
VIDEO_BITRATE = "3000k"

# GitHub-hosted job живёт максимум 360 минут, выше не поднять.
MAX_MINUTES = 350
MAX_RETRIES = 5
READY_TIMEOUT = 60


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {message}", flush=True)


def source_command(seed: int, src: tuple[int, int, int]) -> list[str]:
    width, height, fps = src
    return [
        "node", str(SOURCE),
        f"--width={width}", f"--height={height}", f"--fps={fps}",
        f"--seed={seed}",
    ]


def ffmpeg_command(
    stream_key: str, seconds: int, video_port: int, audio_port: int,
    src: tuple[int, int, int], out: tuple[int, int, int],
) -> list[str]:
    src_w, src_h, src_fps = src
    out_w, out_h, out_fps = out
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "info",
        # Не даём FFmpeg виснуть вечно на RTMP/tcp: через 20 с без I/O он
        # сам упадёт и оставит в логе причину, а не молча зависнет.
        "-rw_timeout", "20000000",
        # -re здесь не нужен: источник сам отдаёт кадры по реальному времени,
        # он считает их по wall clock.
        "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{src_w}x{src_h}", "-r", str(src_fps),
        "-i", f"tcp://127.0.0.1:{video_port}",
        "-f", "f32le", "-ar", "44100", "-ac", "2",
        "-i", f"tcp://127.0.0.1:{audio_port}",
        "-map", "0:v", "-map", "1:a",
        # Растягиваем до эфирного разрешения и добираем кадры: источник отдаёт
        # меньше, чем 30 в секунду, FFmpeg дублирует недостающие.
        "-vf", f"scale={out_w}:{out_h}:flags=bicubic",
        "-r", str(out_fps),
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        # Ключевой кадр каждые 2 секунды — требование YouTube.
        "-g", str(out_fps * 2), "-keyint_min", str(out_fps * 2), "-sc_threshold", "0",
        "-b:v", VIDEO_BITRATE, "-maxrate", VIDEO_BITRATE, "-bufsize", "6000k",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
        # FFmpeg сам выйдет ровно в дедлайн.
        "-t", str(seconds),
        "-f", "flv", f"{RTMP_BASE}/{stream_key}",
    ]


def start_source(seed: int, src: tuple[int, int, int]) -> tuple[subprocess.Popen, int, int]:
    """Поднимает источник и ждёт строку `ready <порт видео> <порт звука>`."""
    process = subprocess.Popen(
        source_command(seed, src), cwd=str(ROOT),
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace", bufsize=1,
    )
    ready = threading.Event()
    found: dict[str, tuple[int, int]] = {}

    def pump() -> None:
        for line in process.stderr:
            line = line.rstrip()
            if line.startswith("ready "):
                video_port, audio_port = line.split()[1:3]
                found["ports"] = (int(video_port), int(audio_port))
                ready.set()
            elif line:
                print(f"[source] {line}", flush=True)

    threading.Thread(target=pump, daemon=True).start()
    if not ready.wait(READY_TIMEOUT):
        process.kill()
        raise RuntimeError("источник не поднялся за минуту")
    return process, *found["ports"]


def attempt(
    stream_key: str, seconds: int, seed: int,
    src: tuple[int, int, int], out: tuple[int, int, int],
) -> int:
    source, video_port, audio_port = start_source(seed, src)
    log(f"Источник готов, порты {video_port}/{audio_port}. "
        f"Запускаю FFmpeg на {seconds // 60} мин.")
    encoder = subprocess.Popen(
        ffmpeg_command(stream_key, seconds, video_port, audio_port, src, out),
        stdin=subprocess.DEVNULL, cwd=str(ROOT),
    )
    returncode = encoder.wait()
    if source.poll() is None:
        source.terminate()
        try:
            source.wait(timeout=10)
        except subprocess.TimeoutExpired:
            source.kill()
    return returncode


def run(
    stream_key: str, deadline: float,
    src: tuple[int, int, int], out: tuple[int, int, int],
) -> bool:
    tries = 0
    while True:
        remaining = int(deadline - time.time())
        if remaining <= 30:
            return True
        tries += 1
        if tries > MAX_RETRIES:
            log(f"Поток падал {MAX_RETRIES} раз подряд — сдаёмся.")
            return False
        try:
            code = attempt(stream_key, remaining, random.randrange(1 << 31), src, out)
        except RuntimeError as error:
            log(f"{error}. Пробую ещё раз.")
            time.sleep(5)
            continue
        if code == 0:
            log("FFmpeg завершился штатно (достигнут дедлайн).")
            return True
        log(f"FFmpeg упал с кодом {code}, переподключаюсь.")
        time.sleep(5)


def main() -> int:
    parser = argparse.ArgumentParser(description="Процедурный эфир на YouTube")
    parser.add_argument("--minutes", type=int, default=348, help="длительность эфира")
    parser.add_argument(
        "--key", default=os.environ.get("YT_STREAM_KEY", "").strip(),
        help="stream key (по умолчанию из YT_STREAM_KEY)",
    )
    parser.add_argument(
        "--quality", default=os.environ.get("STREAM_QUALITY", "light"),
        choices=sorted(QUALITY),
        help="light — экономно, normal — сбалансированно, high — максимум",
    )
    args = parser.parse_args()

    if not args.key:
        sys.exit("Не задан stream key: заполни GitHub Secret YT_STREAM_KEY.")
    if not re.fullmatch(r"[\w-]{8,}", args.key):
        sys.exit("Stream key выглядит битым: ожидаю 5 групп по 4 символа.")

    src, out = QUALITY[args.quality]
    minutes = max(1, min(args.minutes, MAX_MINUTES))
    # Маскируем ключ в логах Actions на случай, если он куда-то попадёт.
    print(f"::add-mask::{args.key}", flush=True)
    log(f"Эфир на {minutes} мин. Режим {args.quality}: "
        f"источник {src[0]}x{src[1]}@{src[2]}, эфир {out[0]}x{out[1]}@{out[2]}.")

    deadline = time.time() + minutes * 60
    return 0 if run(args.key, deadline, src, out) else 1


if __name__ == "__main__":
    sys.exit(main())

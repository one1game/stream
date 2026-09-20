#!/usr/bin/env python3
"""Гонит процедурный поток на YouTube по постоянному stream key.

Ключ берётся один раз в YouTube Studio (Create → Go Live → вкладка Stream)
и передаётся через переменную окружения YT_STREAM_KEY. Больше ничего не нужно:
YouTube сам создаёт и запускает трансляцию, как только пойдут данные.

    python start_stream.py --minutes 348
"""

from __future__ import annotations

import argparse
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

RTMP_BASE = "rtmp://a.rtmp.youtube.com/live2"
AUDIO_GEN = Path(__file__).with_name("gen_audio.py")

# Раннер GitHub: 2 ядра / 7 ГБ. 720p30 с veryfast — безопасный потолок.
WIDTH, HEIGHT, FPS = 1280, 720, 30
VIDEO_BITRATE = "3000k"

# GitHub-hosted job живёт максимум 360 минут, выше не поднять.
MAX_MINUTES = 350
MAX_RETRIES = 5


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {message}", flush=True)


def ffmpeg_command(stream_key: str, seconds: int) -> list[str]:
    # Графику делает сам FFmpeg (lavfi): Python не потянет 30 fps кадров на 2 ядрах.
    background = (
        f"gradients=s={WIDTH}x{HEIGHT}:rate={FPS}:nb_colors=3"
        ":c0=0x1a1430:c1=0x3a2463:c2=0x0a0912"
        f":speed=0.004:duration={seconds + 120}"
        ",noise=alls=3:allf=t+u,vignette=PI/5,format=yuv420p"
    )
    # Музыка приходит из pipe сырым PCM и рисует себя сама: волна сверху и её
    # зеркальная копия снизу — симметричная фигура, дышащая вместе с треком.
    wave_height = HEIGHT // 2 - 20
    graph = (
        f"[1:a]showwaves=s={WIDTH}x{wave_height}:mode=cline:rate={FPS}"
        ":colors=0xc9a7ff@0.85[wv];"
        "[wv]split=2[wv1][wv2];"
        "[wv2]vflip[wvf];"
        "[0:v][wv1]overlay=0:y=20:format=auto[top];"
        f"[top][wvf]overlay=0:y={HEIGHT // 2}[v]"
    )
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "warning",
        # -re обязателен: без него lavfi отдаёт кадры быстрее реального времени.
        "-re", "-f", "lavfi", "-i", background,
        "-f", "s16le", "-ar", "44100", "-ac", "2", "-i", "pipe:0",
        "-filter_complex", graph,
        "-map", "[v]", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        # Ключевой кадр каждые 2 секунды — требование YouTube.
        "-g", str(FPS * 2), "-keyint_min", str(FPS * 2), "-sc_threshold", "0",
        "-b:v", VIDEO_BITRATE, "-maxrate", VIDEO_BITRATE, "-bufsize", "6000k",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
        "-af", "aresample=44100,alimiter=limit=0.95",
        # FFmpeg сам выйдет ровно в дедлайн — ждать снаружи нечего.
        "-t", str(seconds),
        "-f", "flv", f"{RTMP_BASE}/{stream_key}",
    ]


def run(stream_key: str, deadline: float) -> bool:
    attempt = 0
    while True:
        remaining = int(deadline - time.time())
        if remaining <= 30:
            return True
        attempt += 1
        if attempt > MAX_RETRIES:
            log(f"FFmpeg упал {MAX_RETRIES} раз подряд — сдаёмся.")
            return False

        log(f"Запуск FFmpeg (попытка {attempt}), осталось {remaining // 60} мин.")
        generator = subprocess.Popen(
            [sys.executable, str(AUDIO_GEN), "--seed", str(random.randrange(1 << 30))],
            stdout=subprocess.PIPE,
            cwd=str(Path(__file__).resolve().parent.parent),
        )
        encoder = subprocess.Popen(
            ffmpeg_command(stream_key, remaining), stdin=generator.stdout
        )
        # Закрываем свою копию дескриптора: когда генератор умрёт,
        # FFmpeg увидит EOF и корректно завершит поток.
        generator.stdout.close()

        returncode = encoder.wait()
        if generator.poll() is None:
            generator.terminate()
            generator.wait(timeout=10)

        if returncode == 0:
            log("FFmpeg завершился штатно (достигнут дедлайн).")
            return True
        log(f"FFmpeg упал с кодом {returncode}, переподключаюсь.")
        time.sleep(5)


def main() -> int:
    parser = argparse.ArgumentParser(description="Процедурный эфир на YouTube")
    parser.add_argument("--minutes", type=int, default=348, help="длительность эфира")
    parser.add_argument(
        "--key",
        default=os.environ.get("YT_STREAM_KEY", "").strip(),
        help="stream key (по умолчанию из YT_STREAM_KEY)",
    )
    args = parser.parse_args()

    if not args.key:
        sys.exit("Не задан stream key: заполни GitHub Secret YT_STREAM_KEY.")

    minutes = max(1, min(args.minutes, MAX_MINUTES))
    # Маскируем ключ в логах Actions на случай, если он куда-то попадёт.
    print(f"::add-mask::{args.key}", flush=True)
    log(f"Эфир на {minutes} мин, разрешение {WIDTH}x{HEIGHT}@{FPS}.")

    deadline = time.time() + minutes * 60
    return 0 if run(args.key, deadline) else 1


if __name__ == "__main__":
    sys.exit(main())

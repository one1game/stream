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

# Раннер GitHub: 2 ядра / 7 ГБ. Замеры источника: пейзаж 1280x720 — 86 fps,
# радио — 5x реального времени, то есть на поток 30 fps уходит примерно
# 0.4 ядра на видео и 0.2 на звук; остальное достаётся x264.
WIDTH, HEIGHT, FPS = 1280, 720, 30
VIDEO_BITRATE = "3000k"

# GitHub-hosted job живёт максимум 360 минут, выше не поднять.
MAX_MINUTES = 350
MAX_RETRIES = 5
READY_TIMEOUT = 60


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {message}", flush=True)


def source_command(seed: int) -> list[str]:
    return [
        "node", str(SOURCE),
        f"--width={WIDTH}", f"--height={HEIGHT}", f"--fps={FPS}",
        f"--seed={seed}",
    ]


def ffmpeg_command(stream_key: str, seconds: int, video_port: int, audio_port: int) -> list[str]:
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "warning",
        # Оба входа идут по localhost. -re на видео обязателен: без него FFmpeg
        # шлёт кадры с временными метками быстрее реального времени, и YouTube
        # отбрасывает такой поток, не показывая эфир. Аудио FFmpeg сам тянет
        # в темпе видео.
        "-re", "-f", "rawvideo", "-pix_fmt", "rgba",
        "-s", f"{WIDTH}x{HEIGHT}", "-r", str(FPS),
        "-i", f"tcp://127.0.0.1:{video_port}",
        "-f", "f32le", "-ar", "44100", "-ac", "2",
        "-i", f"tcp://127.0.0.1:{audio_port}",
        "-map", "0:v", "-map", "1:a",
        "-c:v", "libx264", "-preset", "veryfast", "-tune", "zerolatency",
        "-profile:v", "high", "-pix_fmt", "yuv420p",
        # Ключевой кадр каждые 2 секунды — требование YouTube.
        "-g", str(FPS * 2), "-keyint_min", str(FPS * 2), "-sc_threshold", "0",
        "-b:v", VIDEO_BITRATE, "-maxrate", VIDEO_BITRATE, "-bufsize", "6000k",
        "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
        # FFmpeg сам выйдет ровно в дедлайн.
        "-t", str(seconds),
        "-f", "flv", f"{RTMP_BASE}/{stream_key}",
    ]


def start_source(seed: int) -> tuple[subprocess.Popen, int, int]:
    """Поднимает источник и ждёт строку `ready <порт видео> <порт звука>`."""
    process = subprocess.Popen(
        source_command(seed), cwd=str(ROOT),
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


def attempt(stream_key: str, seconds: int, seed: int) -> int:
    source, video_port, audio_port = start_source(seed)
    log(f"Источник готов, порты {video_port}/{audio_port}. "
        f"Запускаю FFmpeg на {seconds // 60} мин.")
    encoder = subprocess.Popen(
        ffmpeg_command(stream_key, seconds, video_port, audio_port),
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


def run(stream_key: str, deadline: float) -> bool:
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
            code = attempt(stream_key, remaining, random.randrange(1 << 31))
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
    args = parser.parse_args()

    if not args.key:
        sys.exit("Не задан stream key: заполни GitHub Secret YT_STREAM_KEY.")
    if not re.fullmatch(r"[\w-]{8,}", args.key):
        sys.exit("Stream key выглядит битым: ожидаю 5 групп по 4 символа.")

    minutes = max(1, min(args.minutes, MAX_MINUTES))
    # Маскируем ключ в логах Actions на случай, если он куда-то попадёт.
    print(f"::add-mask::{args.key}", flush=True)
    log(f"Эфир на {minutes} мин, {WIDTH}x{HEIGHT}@{FPS}.")

    deadline = time.time() + minutes * 60
    return 0 if run(args.key, deadline) else 1


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""Гонит процедурный эфир на YouTube по постоянному stream key.

Картинку и звук отдаёт scripts/stream_source.mjs — он исполняет сцену
(newvideo.html — улица, либо muxa.html — автоплатформер «стрим мухи», либо
game_video.html — генератор игр) на Skia-канвасе и звук игры из
scripts/webaudio.mjs либо радио-движок из radio/ прямо в Node, без браузера.
Этот скрипт только связывает источник с FFmpeg и следит за дедлайном.

    python start_stream.py --minutes 300

Пять часов — длина забега в muxa.html: эфир кончается ровно тогда, когда игра
показывает финал, и последние минуты в кадре стоит плашка про пройденные часы.
"""

from __future__ import annotations

import argparse
import os
import random
import re
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

RTMP_BASE = "rtmp://a.rtmp.youtube.com/live2"
SOURCE = Path(__file__).with_name("stream_source.mjs")
ROOT = Path(__file__).resolve().parent.parent

# Пресеты эфира: что получает YouTube.
#
# Частота источника здесь только пожелание: сколько кадров тянет машина,
# источник измеряет сам при запуске (см. калибровку в stream_source.mjs) и
# называет в строке ready. FFmpeg добирает кадры до эфирных 30 и кладёт своё
# зерно на каждый.
QUALITY = {
    "light":  (960, 540, 30),
    "normal": (1280, 720, 30),
    "high":   (1920, 1080, 30),
}

# Доля эфирного разрешения, в которой рисует источник.
#
# Улица — это сотни операций рисования на кадр, и Skia в этом билде тратит на
# чтение пикселей больше, чем на само рисование: кадр 960x540 стоит вдвое
# дешевле кадра 1280x720. Поэтому источник рисует 960x540, а FFmpeg тянет
# картинку до эфирных 1280x720 сглаженно и кладёт зерно — выходит мягко и
# плёночно, зато движения заметно больше. Генератору игр растяжка вредна: она
# мылит пиксель-арт, поэтому он рисует ровно в эфирном разрешении.
RENDER_SCALE = {"newvideo.html": 0.75, "game_video.html": 1.0, "muxa.html": 0.75}

# Чей звук в эфире. Улица живёт под процедурное радио, у игры свой звук: она
# собирает его через Web Audio, а в эфире сводит офлайн-движок источника.
AUDIO_BY_VIDEO = {"newvideo.html": "radio", "game_video.html": "radio", "muxa.html": "game"}

# Кладём ли в кадр зерно.
#
# Улице оно нужно: картинка мягкая под плёнку, и повторённые кадры друг от
# друга отличаются. Игре — нет: спрайты от зерна только мылятся, а кодировщику
# оно стоит дороже всех остальных фильтров вместе (замер: +41% CPU). На
# четырёх ядрах раннера это уводило ядра у источника: кадров 1330 из 1800 за
# минуту, повторов 26%. Без зерна повторов 5% — игра едет ровно.
GRAIN_BY_VIDEO = {"muxa.html": False}


def grain_for(video: str) -> bool:
    """Кладём ли в кадр этой сцены зерно."""
    return GRAIN_BY_VIDEO.get(video, True)


def sizes(video: str, quality: str) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    """Что рисует источник и что уходит в эфир."""
    out = QUALITY[quality]
    scale = RENDER_SCALE.get(video, 1.0)
    src = (round(out[0] * scale) & ~1, round(out[1] * scale) & ~1, out[2])
    return src, out


VIDEO_BITRATE = "3000k"

# Что показывать в эфире. Сейчас это улица (newvideo.html): она живёт по
# музыке — смена трека пересобирает квартал, час суток, сезон и погоду.
# Генератор игр (game_video.html) остался в репозитории и включается сменой
# этого значения или флагом --video.
VIDEO_FILE = "newvideo.html"

# GitHub-hosted job живёт максимум 360 минут, выше не поднять.
MAX_MINUTES = 350
# Жёсткий предел считается от старта job'а: установка зависимостей и закрытие
# RTMP тоже занимают время, и в 360 минут они входить не должны.
JOB_LIMIT_MINUTES = 355
MAX_RETRIES = 5
# Попытка, прожившая столько, считается удачной: счётчик падений обнуляется.
# На пятичасовом эфире редкие обрывы в сумме иначе выбирают весь лимит
# повторов, и поток сдаётся задолго до конца.
RETRY_RESET_SEC = 600
READY_TIMEOUT = 60

# Сюда складываем запущенные процессы, чтобы обработчик сигнала мог их
# остановить: GitHub при отмене шлёт SIGTERM, и лучше закрыть RTMP самим.
running: dict[str, subprocess.Popen | None] = {"encoder": None, "source": None}
stopping = threading.Event()


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {message}", flush=True)


def audio_for(video: str) -> str:
    """Чей звук идёт в эфир вместе с этой сценой."""
    return AUDIO_BY_VIDEO.get(video, "radio")


def source_command(seed: int, src: tuple[int, int, int],
                   video: str = VIDEO_FILE, audio: str | None = None) -> list[str]:
    width, height, fps = src
    return [
        "node", str(SOURCE),
        f"--width={width}", f"--height={height}", f"--fps={fps}",
        f"--seed={seed}",
        f"--video={video}",
        f"--audio={audio or audio_for(video)}",
    ]


def ffmpeg_command(
    stream_key: str, seconds: int, video_port: int, audio_port: int,
    src: tuple[int, int, int], out: tuple[int, int, int], grain: bool = True,
) -> list[str]:
    src_w, src_h, src_fps = src
    out_w, out_h, out_fps = out
    # Растяжка нужна, когда источник рисует мельче эфира. Тянем сглаженно:
    # уличная картинка мягкая и зернистая, соседний пиксель её только изломает.
    filters = []
    if (src_w, src_h) != (out_w, out_h):
        filters.append(f"scale={out_w}:{out_h}:flags=bicubic")
    # Источник рисует реже эфира (см. калибровку в stream_source.mjs), поэтому
    # сначала добираем кадры до эфирной частоты, и только потом кладём зерно:
    # тогда дублированные кадры отличаются зерном друг от друга и движение
    # остаётся живым, а не залипает одной картинкой.
    filters.append(f"fps={out_fps}")
    if grain:
        filters.append("noise=alls=5:allf=t")
    return [
        "ffmpeg", "-hide_banner", "-nostdin", "-nostats", "-loglevel", "info",
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
        "-vf", ",".join(filters),
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


def start_source(seed: int, src: tuple[int, int, int],
                 video: str = VIDEO_FILE) -> tuple[subprocess.Popen, int, int, int]:
    """Поднимает источник и ждёт строку `ready <порт видео> <порт звука> <fps>`.

    Частоту источник называет сам: он измеряет, сколько кадров тянет машина,
    и эфир подстраивается под неё — иначе видео отстало бы от звука.
    """
    process = subprocess.Popen(
        source_command(seed, src, video), cwd=str(ROOT),
        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True,
        encoding="utf-8", errors="replace", bufsize=1,
    )
    ready = threading.Event()
    found: dict[str, tuple[int, int, int]] = {}

    def pump() -> None:
        for line in process.stderr:
            line = line.rstrip()
            if line.startswith("ready "):
                video_port, audio_port, fps = line.split()[1:4]
                found["ports"] = (int(video_port), int(audio_port), int(fps))
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
    video: str = VIDEO_FILE,
) -> int:
    source, video_port, audio_port, src_fps = start_source(seed, src, video)
    # Источник нарисовал первые кадры и сказал, сколько тянет: с этой частотой
    # FFmpeg и читает его поток.
    src = (src[0], src[1], src_fps)
    log(f"Источник готов, порты {video_port}/{audio_port}, "
        f"кадр {src_fps} fps. Запускаю FFmpeg на {seconds // 60} мин.")
    encoder = subprocess.Popen(
        ffmpeg_command(stream_key, seconds, video_port, audio_port, src, out, grain_for(video)),
        stdin=subprocess.DEVNULL, cwd=str(ROOT),
    )
    running["encoder"] = encoder
    try:
        while True:
            try:
                return encoder.wait(timeout=1)
            except subprocess.TimeoutExpired:
                if stopping.is_set():
                    # SIGTERM, а не SIGKILL: FFmpeg дописывает поток и сам
                    # закрывает RTMP-соединение, по обрыву YouTube завершает
                    # трансляцию (Auto-stop в Studio).
                    log("Останавливаю FFmpeg — закрываю RTMP, дальше YouTube сам "
                        "завершит трансляцию по автостопу.")
                    encoder.terminate()
                    try:
                        encoder.wait(timeout=15)
                    except subprocess.TimeoutExpired:
                        log("FFmpeg не ответил на SIGTERM, снимаю принудительно.")
                        encoder.kill()
                        encoder.wait(timeout=10)
                    return encoder.returncode or 0
    finally:
        running["encoder"] = None
        if source.poll() is None:
            source.terminate()
            try:
                source.wait(timeout=10)
            except subprocess.TimeoutExpired:
                source.kill()


def run(
    stream_key: str, deadline: float,
    src: tuple[int, int, int], out: tuple[int, int, int],
    video: str = VIDEO_FILE,
) -> bool:
    tries = 0
    while not stopping.is_set():
        remaining = int(deadline - time.time())
        if remaining <= 30:
            return True
        tries += 1
        if tries > MAX_RETRIES:
            log(f"Поток падал {MAX_RETRIES} раз подряд — сдаёмся.")
            return False
        began = time.time()
        try:
            code = attempt(stream_key, remaining, random.randrange(1 << 31),
                           src, out, video)
        except RuntimeError as error:
            log(f"{error}. Пробую ещё раз.")
            time.sleep(5)
            continue
        ended = time.time()
        if ended - began >= RETRY_RESET_SEC:
            tries = 0
        # Ноль значит «FFmpeg дожил до -t», но ровно так же он выходит, когда
        # YouTube закрыл приём. Разница только во времени: дошли до дедлайна —
        # эфир окончен, вышли раньше — это обрыв, и его надо переподключить,
        # иначе пятичасовой эфир тихо закончится через десять минут.
        if code == 0 and ended >= deadline - 60:
            log("FFmpeg завершился штатно (достигнут дедлайн).")
            return True
        log(f"FFmpeg завершился на {ended - began:.0f} с (код {code}), переподключаюсь.")
        time.sleep(5)
    return True


def handle_signal(signum: int, _frame: object) -> None:
    stopping.set()
    log(f"Пришёл сигнал {signum} — сворачиваю эфир.")


def main() -> int:
    parser = argparse.ArgumentParser(description="Процедурный эфир на YouTube")
    parser.add_argument("--minutes", type=int, default=300,
                        help="длительность эфира, по умолчанию 5 часов — длина забега мухи")
    parser.add_argument(
        "--key", default=os.environ.get("YT_STREAM_KEY", "").strip(),
        help="stream key (по умолчанию из YT_STREAM_KEY)",
    )
    parser.add_argument(
        "--quality", default=os.environ.get("STREAM_QUALITY", "normal"),
        choices=sorted(QUALITY),
        help="light — 960x540, normal — 1280x720, high — 1920x1080",
    )
    parser.add_argument(
        "--started-at", default=os.environ.get("JOB_STARTED_AT", ""),
        help="epoch-время старта job'а: по нему считается жёсткий предел в 355 мин",
    )
    parser.add_argument(
        "--video", default=os.environ.get("STREAM_VIDEO", VIDEO_FILE),
        help="что показывать: newvideo.html — улица, game_video.html — игры",
    )
    args = parser.parse_args()

    if not args.key:
        sys.exit("Не задан stream key: заполни GitHub Secret YT_STREAM_KEY.")
    if not re.fullmatch(r"[\w-]{8,}", args.key):
        sys.exit("Stream key выглядит битым: ожидаю 5 групп по 4 символа.")

    src, out = sizes(args.video, args.quality)
    minutes = max(1, min(args.minutes, MAX_MINUTES))
    # Если GitHub отменяет job, приходит SIGTERM: закрываем RTMP сами и
    # оставляем в логе причину, вместо того чтобы оборвать соединение насильно.
    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, handle_signal)
        except (ValueError, OSError):       # не на всех платформах есть
            pass
    # Маскируем ключ в логах Actions на случай, если он куда-то попадёт.
    print(f"::add-mask::{args.key}", flush=True)
    log(f"Эфир на {minutes} мин. Режим {args.quality}: "
        f"источник {src[0]}x{src[1]}@{src[2]}, эфир {out[0]}x{out[1]}@{out[2]}, "
        f"картинка {args.video}, звук {audio_for(args.video)}.")

    started = time.time()
    if args.started_at:
        try:
            started = float(args.started_at)
        except ValueError:
            log(f"Не понял старт job'а {args.started_at!r}, считаю от себя.")
    hard_stop = started + JOB_LIMIT_MINUTES * 60
    deadline = min(time.time() + minutes * 60, hard_stop)
    log(f"Конец эфира в {datetime.fromtimestamp(deadline, timezone.utc):%H:%M:%S} UTC "
        f"(жёсткий предел job'а — {JOB_LIMIT_MINUTES} мин от старта). "
        "После этого FFmpeg закроет RTMP, и YouTube завершит трансляцию сам, "
        "если в Studio включён автостоп.")

    ok = run(args.key, deadline, src, out, args.video)
    log("RTMP закрыт. Трансляция на YouTube завершается по автостопу.")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())

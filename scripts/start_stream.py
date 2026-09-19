#!/usr/bin/env python3
"""Оркестратор YouTube-эфира.

Полный цикл:
  1. авторизация по refresh token (три GitHub Secret'а);
  2. liveBroadcasts().insert()  -> новая трансляция;
  3. liveStreams().insert()     -> НОВЫЙ stream key (решает проблему duplicate key);
  4. liveBroadcasts().bind()    -> связать одно с другим;
  5. запуск FFmpeg: процедурная графика (lavfi) + процедурный звук (pipe из gen_audio.py);
  6. ожидание дедлайна, затем liveBroadcasts().transition(complete) и удаление потока.

Режимы:
  python start_stream.py --minutes 348     # полный цикл
  python start_stream.py --stop            # закрыть то, что создал предыдущий запуск
"""

from __future__ import annotations

import argparse
import json
import os
import random
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path

from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]
RTMP_BASE = "rtmp://a.rtmp.youtube.com/live2"
STATE_FILE = Path(".stream_state.json")
AUDIO_GEN = Path(__file__).with_name("gen_audio.py")

# Раннер GitHub: 2 ядра / 7 ГБ. 720p30 с preset veryfast — безопасный потолок.
WIDTH, HEIGHT, FPS = 1280, 720, 30
VIDEO_BITRATE = "3000k"

# GitHub-hosted job живёт максимум 360 минут. Оставляем запас на установку
# зависимостей и на корректное завершение трансляции через API.
MAX_MINUTES = 350
MAX_FFMPEG_RETRIES = 5

# Подсказки к самым частым ошибкам API.
ERROR_HINTS = {
    "quotaExceeded": "исчерпана суточная квота YouTube API (10 000 units, сброс в 00:00 по Тихоокеанскому времени).",
    "liveStreamingNotEnabled": "у канала не включены прямые трансляции: подтвердите номер телефона на https://www.youtube.com/features и подождите до 24 часов.",
    "forbidden": "нет прав на управление эфиром: проверьте scope youtube.force-ssl и что эфир разрешён на канале.",
    "invalid_grant": "refresh token мёртв или отозван — получите новый через scripts/get_refresh_token.py.",
    "redundantTransition": "трансляция уже находится в этом статусе.",
    "rateLimitExceeded": "слишком частые запросы к API, повторите позже.",
}


def log(message: str) -> None:
    print(f"[{datetime.now(timezone.utc):%H:%M:%S}] {message}", flush=True)


def env(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        sys.exit(f"Не задана переменная окружения {name} (см. GitHub Secrets).")
    return value


def explain(error: HttpError) -> str:
    """Человекочитаемое объяснение ошибки YouTube API."""
    try:
        payload = json.loads(error.content.decode("utf-8"))
        details = payload["error"]
        reasons = [d.get("reason", "") for d in details.get("errors", [])]
        text = f"HTTP {error.resp.status}: {details.get('message')}"
        for reason in reasons:
            if reason in ERROR_HINTS:
                text += f"\n  -> {ERROR_HINTS[reason]}"
        return text
    except Exception:
        return f"HTTP {error.resp.status}: {error}"


# --- YouTube API ------------------------------------------------------------


def build_service():
    credentials = Credentials(
        token=None,
        refresh_token=env("YT_REFRESH_TOKEN"),
        client_id=env("YT_CLIENT_ID"),
        client_secret=env("YT_CLIENT_SECRET"),
        token_uri="https://oauth2.googleapis.com/token",
        scopes=SCOPES,
    )
    # Если refresh token просрочен или отозван — падаем здесь, до всякой работы.
    credentials.refresh(Request())
    return build("youtube", "v3", credentials=credentials, cache_discovery=False)


def create_broadcast(service, title: str, privacy: str) -> str:
    start_at = datetime.now(timezone.utc) + timedelta(seconds=60)
    body = {
        "snippet": {
            "title": title,
            "scheduledStartTime": start_at.isoformat().replace("+00:00", "Z"),
        },
        "status": {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": False,
        },
        "contentDetails": {
            # YouTube сам переведёт эфир в live, как только пойдут данные от FFmpeg.
            "enableAutoStart": True,
            # Ключевое для таймаута GitHub: когда поток оборвётся, YouTube
            # закроет трансляцию без нашего участия.
            "enableAutoStop": True,
            "enableDvr": True,
            "recordFromStart": True,
            "latencyPrecision": "normal",
        },
    }
    response = service.liveBroadcasts().insert(
        part="snippet,status,contentDetails", body=body
    ).execute()
    return response["id"]


def create_stream(service, title: str) -> tuple[str, str, str]:
    """Создаёт НОВЫЙ поток. Возвращает (stream_id, rtmp_url, stream_key)."""
    body = {
        "snippet": {"title": title},
        "cdn": {
            "frameRate": f"{FPS}fps",
            "resolution": "720p",
            "ingestionType": "rtmp",
        },
    }
    response = service.liveStreams().insert(part="snippet,cdn", body=body).execute()
    ingestion = response["cdn"]["ingestionInfo"]
    return response["id"], ingestion["ingestionAddress"], ingestion["streamName"]


def bind(service, broadcast_id: str, stream_id: str) -> None:
    service.liveBroadcasts().bind(
        part="id,contentDetails", id=broadcast_id, streamId=stream_id
    ).execute()


def lifecycle(service, broadcast_id: str) -> str:
    response = service.liveBroadcasts().list(
        part="status", id=broadcast_id
    ).execute()
    items = response.get("items", [])
    return items[0]["status"]["lifeCycleStatus"] if items else "unknown"


def wait_until_live(service, broadcast_id: str, timeout: int = 180) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        state = lifecycle(service, broadcast_id)
        if state == "live":
            log("YouTube подтвердил: эфир в статусе live.")
            return True
        if state in ("complete", "revoked"):
            log(f"Трансляция завершилась на стороне YouTube (status={state}).")
            return False
        time.sleep(5)
    log("Не дождались статуса live за 3 минуты — продолжаем, стрим идёт.")
    return True


def complete_broadcast(service, broadcast_id: str) -> None:
    try:
        service.liveBroadcasts().transition(
            broadcastStatus="complete", part="status", id=broadcast_id
        ).execute()
        log("Трансляция переведена в статус complete.")
    except HttpError as error:
        text = explain(error)
        if "redundantTransition" in text or "already" in text.lower():
            log("Трансляция уже завершена.")
        else:
            log(f"Не удалось завершить трансляцию: {text}")


def delete_stream(service, stream_id: str) -> None:
    try:
        service.liveStreams().delete(id=stream_id).execute()
        log("Поток удалён — старые stream key не копятся на канале.")
    except HttpError as error:
        log(f"Поток удалить не удалось (не критично): {explain(error)}")


def save_state(broadcast_id: str, stream_id: str) -> None:
    STATE_FILE.write_text(
        json.dumps({"broadcast_id": broadcast_id, "stream_id": stream_id}),
        encoding="utf-8",
    )


def load_state() -> dict:
    if not STATE_FILE.exists():
        return {}
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}


# --- FFmpeg -----------------------------------------------------------------


def ffmpeg_command(stream_key: str, seconds: int) -> list[str]:
    # Графика целиком на стороне FFmpeg (lavfi) — процессор не тратится
    # на генерацию кадров в Python.
    background = (
        f"gradients=s={WIDTH}x{HEIGHT}:rate={FPS}:nb_colors=3"
        ":c0=0x120c1f:c1=0x2b1b46:c2=0x090910"
        f":speed=0.005:duration={seconds + 120}"
        ",noise=alls=7:allf=t+u,vignette=PI/5,format=yuv420p"
    )
    # Аудио приходит из pipe как сырой PCM и рисует себе волну поверх фона.
    graph = (
        f"[1:a]showwaves=s={WIDTH}x200:mode=cline:rate={FPS}:colors=0xb59bff@0.9[w];"
        "[0:v][w]overlay=x=0:y=H-h-90[v]"
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
        "-t", str(seconds),
        "-f", "flv", f"{RTMP_BASE}/{stream_key}",
    ]


def run_ffmpeg(service, broadcast_id: str, stream_key: str, deadline: float) -> bool:
    """Гонит поток до дедлайна. Перезапускает FFmpeg при обрыве."""
    attempt = 0
    while True:
        remaining = int(deadline - time.time())
        if remaining <= 30:
            return True
        attempt += 1
        if attempt > MAX_FFMPEG_RETRIES:
            log(f"FFmpeg упал {MAX_FFMPEG_RETRIES} раз подряд — сдаёмся.")
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
        # Закрываем копию дескриптора у себя: когда генератор умрёт,
        # FFmpeg увидит EOF и корректно завершит поток.
        generator.stdout.close()

        returncode = encoder.wait()
        if generator.poll() is None:
            generator.terminate()
            generator.wait(timeout=10)

        if returncode == 0:
            log("FFmpeg завершился штатно (достигнут дедлайн).")
            return True

        log(f"FFmpeg упал с кодом {returncode}.")
        state = lifecycle(service, broadcast_id)
        if state in ("complete", "revoked"):
            log("Трансляция уже закрыта YouTube — перезапускаться нет смысла.")
            return False
        time.sleep(5)


# --- Режимы -----------------------------------------------------------------


def stream(args) -> int:
    minutes = max(1, min(args.minutes, MAX_MINUTES))
    title = args.title.strip() or f"live {datetime.now(timezone.utc):%Y-%m-%d %H:%M} UTC"

    service = build_service()
    log("Авторизация прошла, создаю трансляцию.")

    broadcast_id = create_broadcast(service, title, args.privacy)
    stream_id, rtmp_url, stream_key = create_stream(service, title)
    save_state(broadcast_id, stream_id)

    # Маскируем ключ в логах Actions на случай, если он куда-то попадёт.
    print(f"::add-mask::{stream_key}", flush=True)
    log(f"Трансляция: https://youtube.com/watch?v={broadcast_id}")
    log(f"Ingest: {rtmp_url}")

    bind(service, broadcast_id, stream_id)
    log("Поток привязан к трансляции.")

    deadline = time.time() + minutes * 60
    started = run_ffmpeg(service, broadcast_id, stream_key, deadline)

    log("Закрываю трансляцию.")
    complete_broadcast(service, broadcast_id)
    delete_stream(service, stream_id)
    STATE_FILE.unlink(missing_ok=True)
    return 0 if started else 1


def stop() -> int:
    state = load_state()
    if not state:
        log("Состояния прошлого запуска нет — закрывать нечего.")
        return 0
    service = build_service()
    complete_broadcast(service, state["broadcast_id"])
    delete_stream(service, state["stream_id"])
    STATE_FILE.unlink(missing_ok=True)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="YouTube Live оркестратор")
    parser.add_argument("--minutes", type=int, default=348, help="длительность эфира")
    parser.add_argument("--title", default="", help="заголовок трансляции")
    parser.add_argument("--privacy", default="public", choices=["public", "unlisted", "private"])
    parser.add_argument("--stop", action="store_true", help="только закрыть трансляцию")
    args = parser.parse_args()

    try:
        return stop() if args.stop else stream(args)
    except HttpError as error:
        print(f"Ошибка YouTube API. {explain(error)}", file=sys.stderr)
        return 1
    except Exception as error:  # noqa: BLE001 — наверх должен уйти код возврата
        print(f"Непредвиденная ошибка: {error!r}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())

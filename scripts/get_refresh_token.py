#!/usr/bin/env python3
"""Одноразовый локальный скрипт: получает REFRESH_TOKEN для YouTube API.

Запуск (на своей машине, не в Actions):
    1. Скачать client_secret_*.json из Google Cloud Console (OAuth client типа Desktop app)
    2. pip install google-auth-oauthlib
    3. python scripts/get_refresh_token.py --client-secret client_secret_xxx.json

В консоль выведется refresh_token — положить его в GitHub Secret YT_REFRESH_TOKEN.
"""

from __future__ import annotations

import argparse

from google_auth_oauthlib.flow import InstalledAppFlow

SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"]


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--client-secret", required=True, help="путь к client_secret_*.json")
    parser.add_argument("--port", type=int, default=8080)
    args = parser.parse_args()

    flow = InstalledAppFlow.from_client_secrets_file(args.client_secret, SCOPES)
    credentials = flow.run_local_server(
        port=args.port,
        access_type="offline",   # без этого Google не выдаст refresh token
        prompt="consent",        # форсируем выдачу даже при повторной авторизации
    )

    print("\n" + "=" * 60)
    print("CLIENT_ID     :", credentials.client_id)
    print("CLIENT_SECRET :", credentials.client_secret)
    print("REFRESH_TOKEN :", credentials.refresh_token)
    print("=" * 60)
    print(
        "\nПроверь, что OAuth consent screen переведён в статус 'In production'.\n"
        "В статусе 'Testing' Google убивает refresh token через 7 дней —\n"
        "эфир упадёт с invalid_grant."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

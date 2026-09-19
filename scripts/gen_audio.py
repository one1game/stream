#!/usr/bin/env python3
"""Пример процедурного музыкального генератора (lo-fi пэд + винил + кик).

ЭТО ЗАГЛУШКА-ЗАМЕНА. Контракт для FFmpeg предельно простой:
пиши в stdout сырой PCM (s16le, 44100 Гц, стерео) бесконечным потоком,
а все логи — в stderr. Тогда FFmpeg читает это как `-f s16le -ar 44100 -ac 2 -i pipe:0`
и сам тормозит генератор до реального времени через backpressure пайпа.

Свой скрипт можно просто положить рядом под этим именем, ничего больше не меняя.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

BLOCK = 4096
# Am7 - Fmaj7 - Cmaj7 - G6, по 8 секунд на аккорд
CHORDS = [
    [220.00, 261.63, 329.63, 392.00],
    [174.61, 220.00, 261.63, 329.63],
    [130.81, 196.00, 261.63, 329.63],
    [196.00, 246.94, 293.66, 392.00],
]
BEAT = 0.5  # 120 BPM


def render(seed: int, rate: int):
    rng = np.random.default_rng(seed)
    chord = np.array(CHORDS)
    phase = np.zeros(4)
    position = 0
    stdout = sys.stdout.buffer

    while True:
        index = np.arange(position, position + BLOCK, dtype=np.float64)
        seconds = index / rate
        position += BLOCK

        # Медленный lo-fi пэд с расстройкой голосов.
        pad = np.zeros(BLOCK)
        for voice in range(4):
            freq = chord[((index // (rate * 8)) % len(CHORDS)).astype(int), voice]
            freq = freq * (1.0 + 0.0015 * np.sin(2 * np.pi * 0.07 * seconds + voice))
            accumulated = phase[voice] + 2 * np.pi * np.cumsum(freq) / rate
            phase[voice] = accumulated[-1] % (2 * np.pi)
            pad += np.sin(accumulated + voice)

        tremolo = 1.0 + 0.18 * np.sin(2 * np.pi * 0.05 * seconds)
        voice_mix = pad / 4.0 * tremolo

        # Кик на каждый бит.
        beat_pos = np.mod(seconds, BEAT)
        kick = np.sin(2 * np.pi * 55.0 * seconds) * np.exp(-beat_pos * 18.0) * 0.5

        # Винил: редкие щелчки плюс шумовой пол.
        crackle = (rng.random(BLOCK) < 0.0007) * rng.normal(0, 0.35, BLOCK)
        hiss = rng.normal(0, 0.006, BLOCK)

        mix = np.tanh((voice_mix + kick) * 1.1) * 0.8 + crackle + hiss
        # Правая колонка чуть шире — дешёвая стереофония без второго прохода.
        right = np.tanh((voice_mix + kick) * 1.1) * 0.8 * 0.94 + crackle + hiss

        block = np.stack([mix, right], axis=1)
        try:
            stdout.write(np.clip(block, -1.0, 1.0).astype("<i2").tobytes())
            stdout.flush()
        except (BrokenPipeError, OSError):
            return


def main() -> int:
    parser = argparse.ArgumentParser(description="Процедурный аудиогенератор в stdout")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--rate", type=int, default=44100)
    args = parser.parse_args()
    print("audio generator started", file=sys.stderr, flush=True)
    render(args.seed, args.rate)
    return 0


if __name__ == "__main__":
    sys.exit(main())

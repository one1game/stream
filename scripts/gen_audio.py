#!/usr/bin/env python3
"""Процедурный lo-fi генератор: пэд, мелодия, мягкая перкуссия, винил.

Контракт для FFmpeg: сырой PCM (s16le, 44100 Гц, стерео) в stdout бесконечным
потоком, логи — в stderr. FFmpeg читает это как `-f s16le -ar 44100 -ac 2 -i pipe:0`
и сам тормозит генератор до реального времени через backpressure пайпа.

Мелодия не записана заранее: ноты выбирает генератор случайных чисел из
ля-минорной пентатоники поверх фиксированной прогрессии аккордов.
"""

from __future__ import annotations

import argparse
import sys

import numpy as np

BLOCK = 4096
BPM = 75.0
STEP = 60.0 / BPM / 2        # восьмая нота, 0.4 с
BEAT = 60.0 / BPM
BAR = BEAT * 4

# Am7 - Fmaj7 - Cmaj7 - G6 — низкий тёплый пэд
CHORDS = (
    (45, 48, 52, 55),
    (41, 45, 48, 52),
    (36, 40, 43, 47),
    (43, 47, 50, 52),
)
# ля-минорная пентатоника в двух октавах
MELODY_NOTES = (57, 60, 62, 64, 67, 69, 72, 74, 76, 79)
MELODY_STEPS = 200_000       # ~22 часа, больше любого прогона


def midi_to_hz(notes: np.ndarray) -> np.ndarray:
    return 440.0 * np.power(2.0, (notes - 69.0) / 12.0)


def build_melody(rng: np.random.Generator) -> tuple[np.ndarray, np.ndarray]:
    """Раскладывает ноты по сетке шагов. Возвращает (ноты, начало ноты).

    Ноль в нотах означает паузу — по нему же глушится конверт.
    """
    notes = np.zeros(MELODY_STEPS, dtype=np.float64)
    starts = np.zeros(MELODY_STEPS, dtype=np.int32)
    step = 0
    while step < MELODY_STEPS:
        if rng.random() < 0.3:      # пауза
            step += 1
            continue
        length = int(rng.integers(1, 4))
        note = float(MELODY_NOTES[rng.integers(0, len(MELODY_NOTES))])
        end = min(step + length, MELODY_STEPS)
        notes[step:end] = note
        starts[step:end] = step
        step = end
    return notes, starts


def render(seed: int, rate: int) -> None:
    rng = np.random.default_rng(seed)
    melody, note_start = build_melody(rng)

    step_samples = STEP * rate
    bar_samples = BAR * rate
    delay = int(0.375 * rate)          # эхо на восьмую с точкой
    # В таблице аккордов номера MIDI-нот, а не герцы.
    chord = midi_to_hz(np.array(CHORDS, dtype=np.float64))

    pad_phase = np.zeros(len(CHORDS[0]))
    melody_phase = 0.0
    echo_buffer = np.zeros(delay * 2)
    position = 0
    stdout = sys.stdout.buffer

    while True:
        index = np.arange(position, position + BLOCK, dtype=np.float64)
        seconds = index / rate
        position += BLOCK

        # --- пэд: четыре голоса со лёгкой расстройкой и тремоло
        chords_now = chord[((index // bar_samples) % len(CHORDS)).astype(np.int64)]
        pad = np.zeros(BLOCK)
        for voice in range(chord.shape[1]):
            freq = chords_now[:, voice] * (
                1.0 + 0.002 * np.sin(2 * np.pi * 0.08 * seconds + voice)
            )
            accumulated = pad_phase[voice] + 2 * np.pi * np.cumsum(freq) / rate
            pad_phase[voice] = accumulated[-1] % (2 * np.pi)
            pad += np.sin(accumulated + voice)
        pad /= chord.shape[1]
        pad *= 1.0 + 0.15 * np.sin(2 * np.pi * 0.07 * seconds)

        # --- мелодия: нота из пентатоники с быстрой атакой и мягким спадом
        step_index = (index // step_samples).astype(np.int64)
        note = melody[step_index]
        note_position = (index - note_start[step_index] * step_samples) / rate
        envelope = (1.0 - np.exp(-note_position * 60.0)) * np.exp(-note_position * 2.2)
        envelope[note == 0.0] = 0.0
        freq = midi_to_hz(np.where(note == 0.0, 220.0, note))
        freq *= 1.0 + 0.005 * np.sin(2 * np.pi * 5.0 * seconds)
        accumulated = melody_phase + 2 * np.pi * np.cumsum(freq) / rate
        melody_phase = accumulated[-1] % (2 * np.pi)
        lead = (
            np.sin(accumulated)
            + 0.35 * np.sin(2 * accumulated)
            + 0.12 * np.sin(3 * accumulated)
        ) * envelope * 0.5

        # --- эхо: два разных тапа уходят в разные колонки, отсюда стерео
        line = np.concatenate([echo_buffer, lead])
        echo_near = line[delay:delay + BLOCK]
        echo_far = line[:BLOCK]
        echo_buffer = line[BLOCK:BLOCK + delay * 2]

        # --- перкуссия: мягкий кик на долю и тихий тик на восьмые
        kick = np.sin(2 * np.pi * 48.0 * seconds) * np.exp(-np.mod(seconds, BEAT) * 14.0)
        tick = rng.normal(0, 1, BLOCK) * np.exp(-np.mod(seconds, STEP) * 45.0) * 0.05

        # --- винил
        crackle = (rng.random(BLOCK) < 0.0006) * rng.normal(0, 0.35, BLOCK)
        hiss = rng.normal(0, 0.005, BLOCK)

        body = pad * 0.5 + kick * 0.35 + tick
        left = np.tanh((body + lead + echo_near * 0.35) * 1.15) * 0.75 + crackle + hiss
        right = np.tanh((body + lead + echo_far * 0.35) * 1.15) * 0.75 + crackle + hiss

        block = np.stack([left, right], axis=1)
        # Умножаем на 32767 до приведения к int16: astype сам масштаб не делает.
        pcm = (np.clip(block, -1.0, 1.0) * 32767.0).astype("<i2")
        try:
            stdout.write(pcm.tobytes())
            stdout.flush()
        except (BrokenPipeError, OSError):
            return


def main() -> int:
    parser = argparse.ArgumentParser(description="Процедурный аудиогенератор в stdout")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--rate", type=int, default=44100)
    args = parser.parse_args()
    print(f"audio generator started (seed={args.seed})", file=sys.stderr, flush=True)
    render(args.seed, args.rate)
    return 0


if __name__ == "__main__":
    sys.exit(main())

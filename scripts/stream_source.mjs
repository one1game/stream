#!/usr/bin/env node
/* =====================================================
   Единый источник эфира: видео из reneratorvideo.html, звук из radio/.

   Оба приложения исполняются headless, без браузера:
     · видео — на Skia-канвасе с шимом DOM (document/window/requestAnimationFrame);
     · звук — на самом lofi-processor.js с шимом AudioWorklet, как в
       radio/tools/qa-render.mjs. Треки идут один за другим: lofi-processor
       по окончании трека сам вызывает restartTrack() и начинает новый
       с другим темпом, китом, тональностью и прогрессией.

   Каналы наружу:
     stdout   — сырые кадры rgba   (ffmpeg -f rawvideo -pix_fmt rgba)
     tcp:port — сырое аудио f32le  (ffmpeg -f f32le -ar 44100 -ac 2)

   Запуск:
     node scripts/stream_source.mjs --port=45001 --width=1280 --height=720
   ===================================================== */

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createCanvas } from '@napi-rs/canvas';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));

const W = Number(args.width || 960);
const H = Number(args.height || 540);
// Кадры рисуются реже, чем идёт эфир: растеризация пейзажа в Skia стоит
// десятки миллисекунд на кадр, и 30 fps в 720p два ядра не тянут. FFmpeg
// сам доберёт кадры до 30 и растянет картинку до нужного разрешения.
const FPS = Number(args.fps || 20);
const PORT = Number(args.port || 0);      // 0 — порт выберет система
const SR = 44100;
const SAMPLES_PER_FRAME = SR / FPS;
const FRAME_MS = 1000 / FPS;
const SEED = Number(args.seed || Math.floor(Math.random() * 0xffffffff)) >>> 0;

const fail = (msg) => { process.stderr.write(`stream_source: ${msg}\n`); process.exit(1); };

// ============================================================
//  ВИДЕО: reneratorvideo.html на Skia-канвасе
// ============================================================
const videoFile = path.join(ROOT, args.video || 'game_video.html');
if (!fs.existsSync(videoFile)) fail(`нет файла ${videoFile}`);

// Сцену рисует обычная страница: исполняем её inline-скрипт на Skia-канвасе.
const blocks = [...fs.readFileSync(videoFile, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) fail(`в ${videoFile} нет inline-скрипта`);
const videoCode = blocks.at(-1)[1];

// Состояние музыки для режиссёра сцены: генератор игр читает его через
// globalThis.getMusicState() и по нему выбирает жанр следующей сцены.
const musicState = { mood: null, bpm: null, kit: null, key: null, scale: null, track: 0 };
globalThis.getMusicState = () => musicState;

const canvas = createCanvas(W, H);
canvas.style = {};                       // страница выставляет размер через CSS
let pendingFrame = null;
let clockMs = 0;

const hudStub = () => ({
  innerHTML: '', textContent: '',
  classList: { toggle() {}, add() {}, remove() {} },
});
const hud = hudStub();

globalThis.document = {
  getElementById: (id) => (id === 'c' ? canvas : hud),
  createElement: () => { const c = createCanvas(1, 1); c.style = {}; return c; },
};
globalThis.window = { innerWidth: W, innerHeight: H, addEventListener() {} };
globalThis.performance = { now: () => clockMs };
globalThis.requestAnimationFrame = (cb) => { pendingFrame = cb; };

new Function(videoCode)();
if (!pendingFrame) fail('скрипт пейзажа не запустил кадровый цикл');

// ============================================================
//  ЗВУК: lofi-processor + mastering из radio/
// ============================================================
const radioDir = path.join(ROOT, 'radio');
const registry = {};
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = { postMessage() {}, onmessage: null };
  }
};
globalThis.registerProcessor = (name, cls) => { registry[name] = cls; };

for (const rel of ['lofi-processor.js', 'plugins/mastering.js']) {
  const abs = path.join(radioDir, rel);
  if (!fs.existsSync(abs)) fail(`нет файла ${abs}`);
  vm.runInThisContext(fs.readFileSync(abs, 'utf8'), { filename: abs });
}
if (!registry['lofi-processor'] || !registry['mastering-processor']) {
  fail('радио-движок не зарегистрировал процессоры');
}

const generator = new registry['lofi-processor']({
  // oneShot не включаем: трек доигрывает — движок сам запускает следующий.
  processorOptions: { seed: SEED, autoStart: true, mood: args.mood || undefined },
});
const mastering = new registry['mastering-processor']();

// Смена трека — это вызов mkSession из restartTrack. Считаем их, чтобы сцена
// менялась ровно тогда, когда радио начинает новый трек.
let trackCount = 1;
const baseMkSession = generator.mkSession.bind(generator);
generator.mkSession = () => { trackCount++; return baseMkSession(); };
const syncMusicState = () => {
  musicState.mood = generator.mood ? generator.mood.name : null;
  musicState.bpm = generator.bpm ?? null;
  musicState.kit = generator.kitName ?? null;
  musicState.key = generator.keyName ?? null;
  musicState.scale = generator.scaleName ?? null;
  musicState.track = trackCount;
};
syncMusicState();

const blockL = new Float32Array(128);
const blockR = new Float32Array(128);
const outL = new Float32Array(128);
const outR = new Float32Array(128);
const sink = [[outL, outR]];
let totalSamples = 0;
let carryL = new Float32Array(0);
let carryR = new Float32Array(0);

function renderAudio(frames) {
  const buffer = Buffer.allocUnsafe(frames * 8);
  let written = 0;
  while (written < frames) {
    if (carryL.length === 0) {
      globalThis.currentTime = totalSamples / SR;
      generator.process([], [[blockL, blockR]]);
      mastering.process([[blockL, blockR]], sink);
      totalSamples += 128;
      carryL = Float32Array.from(outL);
      carryR = Float32Array.from(outR);
    }
    const take = Math.min(frames - written, carryL.length);
    for (let i = 0; i < take; i++) {
      buffer.writeFloatLE(carryL[i], (written + i) * 8);
      buffer.writeFloatLE(carryR[i], (written + i) * 8 + 4);
    }
    carryL = carryL.subarray(take);
    carryR = carryR.subarray(take);
    written += take;
  }
  return buffer;
}

// ============================================================
//  ЭМИССИЯ: видео и звук идут независимо, каждый по своим часам.
//
//  Связывать их одним циклом нельзя. Кадр 1280x720 в RGBA — это 3.5 МБ,
//  он мигом забивает сокет, и write() отдаёт false. Если после этого
//  остановить весь цикл, то звук тоже встанет, а FFmpeg в это время
//  открывает второй вход и ждёт оттуда пакеты, не читая первый. Оба ждут
//  друг друга — эфир не доходит до YouTube вообще.
//
//  Поэтому: один таймер, но два независимых счётчика по wall clock.
//  Отставание каждого потока своё и на соседа не влияет.
// ============================================================
const FRAME_BYTES = W * H * 4;
const TICK_MS = 4;
// Потолок буфера видео: выше — кадры пропускаем, чтобы не съесть память.
const MAX_BUFFERED_FRAMES = 15;
const AUDIO_BURST = SAMPLES_PER_FRAME * 4;

let videoSocket = null;
let audioSocket = null;
let videoStartedAt = 0;
let audioStartedAt = 0;
let sentFrames = 0;
let sentSamples = 0;
let droppedFrames = 0;
let lastReport = 0;
let ticks = 0;
let videoMs = 0;
let audioMs = 0;

const audioQueue = [];
let queuedBytes = 0;
const QUEUE_LIMIT = 16 * 1024 * 1024;

function emitVideo(now) {
  const want = Math.floor((now - videoStartedAt) * FPS / 1000);
  // Не больше трёх кадров за тик: длинный догон заблокировал бы цикл
  // событий и снова заморил бы звук.
  const limit = Math.min(want, sentFrames + 3);
  while (sentFrames < limit) {
    const cb = pendingFrame;
    pendingFrame = null;
    cb(clockMs);                       // нарисовать следующий кадр пейзажа
    clockMs += FRAME_MS;
    sentFrames++;

    if (videoSocket.writableLength > MAX_BUFFERED_FRAMES * FRAME_BYTES) {
      droppedFrames++;                 // сокет забит — кадр пропускаем
      continue;
    }
    // canvas.data() отдаёт ту же память, которую Skia перезапишет следующим
    // кадром, поэтому копируем: сокет пишет асинхронно, и без копии в очередь
    // уйдёт уже испорченный кадр. getImageData() тут не годится — он втрое
    // дороже бюджета кадра.
    videoSocket.write(Buffer.from(canvas.data()));
  }
}

function emitAudio(now) {
  const want = Math.min(
    Math.floor((now - audioStartedAt) * SR / 1000),
    sentSamples + AUDIO_BURST,
  );
  if (want <= sentSamples) return;

  const chunk = renderAudio(want - sentSamples);
  sentSamples = want;
  globalThis.currentTime = sentSamples / SR;
  syncMusicState();                 // трек мог смениться во время рендера

  if (audioSocket) {
    audioSocket.write(chunk);
  } else if (queuedBytes + chunk.length <= QUEUE_LIMIT) {
    audioQueue.push(chunk);
    queuedBytes += chunk.length;
  }
}

function tick() {
  const t0 = Date.now();
  if (videoSocket) emitVideo(t0);
  const t1 = Date.now();
  if (audioStartedAt) emitAudio(t1);
  const t2 = Date.now();
  ticks++;
  videoMs += t1 - t0;
  audioMs += t2 - t1;
  const now = t2;

  if (now - lastReport >= 60000) {
    const span = now - lastReport;
    lastReport = now;
    const videoReal = videoStartedAt ? (now - videoStartedAt) / 1000 : 0;
    const audioReal = audioStartedAt ? (now - audioStartedAt) / 1000 : 0;
    process.stderr.write(
      `source: тиков ${ticks} за ${(span / 1000).toFixed(0)} с, `
      + `видео ${videoMs} мс, звук ${audioMs} мс, `
      + `кадров ${sentFrames}/${(videoReal * FPS).toFixed(0)} (пропущено ${droppedFrames}), `
      + `звук ${(sentSamples / SR).toFixed(1)} из ${audioReal.toFixed(1)} с, `
      + `в буфере ${(videoSocket ? videoSocket.writableLength / 1048576 : 0).toFixed(0)} МБ, `
      + `трек ${generator.kitName ?? '?'} ${generator.bpm ?? '?'} bpm\n`,
    );
    ticks = 0; videoMs = 0; audioMs = 0;
  }
  setTimeout(tick, TICK_MS);
}

const videoServer = net.createServer((conn) => {
  if (videoSocket) { conn.destroy(); return; }
  conn.setNoDelay(true);
  videoSocket = conn;
  conn.on('error', () => {});
  conn.on('close', () => process.exit(0));
  videoStartedAt = Date.now();
  lastReport = videoStartedAt;
  process.stderr.write(`source: видео подключено, рисую ${W}x${H}@${FPS} (seed ${SEED})\n`);
});

const audioServer = net.createServer((conn) => {
  if (audioSocket) { conn.destroy(); return; }
  conn.setNoDelay(true);
  audioSocket = conn;
  conn.on('error', () => {});
  conn.on('close', () => process.exit(0));
  for (const chunk of audioQueue) conn.write(chunk);
  const caught = queuedBytes / (SR * 8);
  audioQueue.length = 0;
  queuedBytes = 0;
  // Часы звука стартуют от момента подключения: FFmpeg открывает входы
  // по очереди, и это расхождение в доли секунды — норма.
  audioStartedAt = Date.now();
  process.stderr.write(`source: звук подключён, отдал очередь ${caught.toFixed(2)} с\n`);
});

const failSocket = (what) => (e) => fail(`сокет ${what}: ${e.message}`);
videoServer.on('error', failSocket('видео'));
audioServer.on('error', failSocket('звука'));

let opened = 0;
const announce = () => {
  if (++opened === 2) {
    process.stderr.write(`ready ${videoServer.address().port} ${audioServer.address().port}\n`);
    tick();
  }
};
videoServer.listen(0, '127.0.0.1', announce);
audioServer.listen(0, '127.0.0.1', announce);

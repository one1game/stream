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

const W = Number(args.width || 1280);
const H = Number(args.height || 720);
const FPS = Number(args.fps || 30);
const PORT = Number(args.port || 0);      // 0 — порт выберет система
const SR = 44100;
const SAMPLES_PER_FRAME = SR / FPS;
const FRAME_MS = 1000 / FPS;
const SEED = Number(args.seed || Math.floor(Math.random() * 0xffffffff)) >>> 0;

const fail = (msg) => { process.stderr.write(`stream_source: ${msg}\n`); process.exit(1); };

// ============================================================
//  ВИДЕО: reneratorvideo.html на Skia-канвасе
// ============================================================
const videoFile = path.join(ROOT, args.video || 'reneratorvideo.html');
if (!fs.existsSync(videoFile)) fail(`нет файла ${videoFile}`);

const blocks = [...fs.readFileSync(videoFile, 'utf8').matchAll(/<script>([\s\S]*?)<\/script>/g)];
if (!blocks.length) fail(`в ${videoFile} нет inline-скрипта`);
const videoCode = blocks.at(-1)[1];

const canvas = createCanvas(W, H);
canvas.style = {};                       // страница выставляет размер через CSS
const ctx = canvas.getContext('2d');
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
//  ЭМИССИЯ: один кадр видео + ровно один кадр аудио на такт
//  Оба потока уходят по localhost-сокетам, а не через stdin: у FFmpeg только
//  один stdin, а запись в трубу на Windows ещё и синхронная — связка встаёт.
//  Порядок такой: FFmpeg открывает и пробует первый вход, потом второй,
//  поэтому видео льём сразу, а звук копим до его подключения.
// ============================================================
let videoSocket = null;
let audioSocket = null;
let sent = 0;
let startedAt = 0;
let videoBusy = false;
let audioBusy = false;
let lastReport = 0;
let behind = 0;

const audioQueue = [];
let queuedBytes = 0;
const QUEUE_LIMIT = 64 * 1024 * 1024;

const scheduleAt = (frameIndex) => {
  const wait = startedAt + frameIndex * FRAME_MS - Date.now();
  if (wait > 1) setTimeout(tick, wait);
  else { behind++; setImmediate(tick); }
};
const maybeRun = () => { if (!videoBusy && !audioBusy) scheduleAt(sent + 1); };

function tick() {
  if (!videoSocket) return;
  clockMs += FRAME_MS;
  const cb = pendingFrame;
  pendingFrame = null;
  cb(clockMs);                                  // нарисовать следующий кадр

  const pixels = ctx.getImageData(0, 0, W, H).data;
  const frame = Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength);
  const audio = renderAudio(SAMPLES_PER_FRAME);
  sent++;

  videoBusy = videoSocket.write(frame) === false;
  if (audioSocket) {
    audioBusy = audioSocket.write(audio) === false;
  } else if (queuedBytes + audio.length <= QUEUE_LIMIT) {
    audioQueue.push(audio);
    queuedBytes += audio.length;
  }

  const now = Date.now();
  if (now - lastReport >= 30000) {
    lastReport = now;
    const real = (now - startedAt) / 1000;
    process.stderr.write(
      `source: ${sent} кадров за ${real.toFixed(0)} с (${(sent / real).toFixed(1)} fps), `
      + `отставаний ${behind}, трек ${generator.kitName ?? '?'} `
      + `${generator.bpm ?? '?'} bpm ${generator.keyName ?? '?'} ${generator.scaleName ?? ''}\n`,
    );
  }
  maybeRun();
}

const videoServer = net.createServer((conn) => {
  if (videoSocket) { conn.destroy(); return; }
  conn.setNoDelay(true);
  videoSocket = conn;
  conn.on('drain', () => { videoBusy = false; maybeRun(); });
  conn.on('error', () => {});
  conn.on('close', () => process.exit(0));
  process.stderr.write(`source: видео подключено, рисую ${W}x${H}@${FPS} (seed ${SEED})\n`);
  startedAt = Date.now();
  lastReport = startedAt;
  tick();
});

const audioServer = net.createServer((conn) => {
  if (audioSocket) { conn.destroy(); return; }
  conn.setNoDelay(true);
  audioSocket = conn;
  conn.on('drain', () => { audioBusy = false; maybeRun(); });
  conn.on('error', () => {});
  conn.on('close', () => process.exit(0));
  for (const chunk of audioQueue) {
    if (conn.write(chunk) === false) audioBusy = true;
  }
  const caught = queuedBytes / (SR * 8);
  audioQueue.length = 0;
  queuedBytes = 0;
  process.stderr.write(`source: звук подключён, отдал очередь ${caught.toFixed(2)} с\n`);
  maybeRun();
});

const failSocket = (what) => (e) => fail(`сокет ${what}: ${e.message}`);
videoServer.on('error', failSocket('видео'));
audioServer.on('error', failSocket('звука'));

let opened = 0;
const announce = () => {
  if (++opened === 2) {
    process.stderr.write(`ready ${videoServer.address().port} ${audioServer.address().port}\n`);
  }
};
videoServer.listen(0, '127.0.0.1', announce);
audioServer.listen(0, '127.0.0.1', announce);

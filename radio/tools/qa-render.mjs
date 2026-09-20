/* =====================================================
   QA · оффлайн-рендер и замеры качества

   Гоняет настоящий тракт (lofi-processor → mastering) в Node:
   шимит AudioWorklet-глобали, рендерит трек по зерну и снимает
   мастер-метрики — громкость, пик, динамику, спектр, стерео, шум.

   Запуск:
     node tools/qa-render.mjs                     все слои, только замеры
     node tools/qa-render.mjs --sec=80            длина рендера
     node tools/qa-render.mjs --moods=dusty,piano ограничить слои
     node tools/qa-render.mjs --wav=dusty,piano   ещё и WAV в qa/
   ===================================================== */

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SR = 44100;
const BLOCK = 128;

// ---------- шим AudioWorklet ----------
const registry = {};
globalThis.sampleRate = SR;
globalThis.currentTime = 0;
globalThis.AudioWorkletProcessor = class {
  constructor() {
    this.port = {
      postMessage: (m) => { (globalThis.__msgs ||= []).push(m); },
      onmessage: null,
    };
  }
};
globalThis.registerProcessor = (name, cls) => { registry[name] = cls; };

const loadScript = (rel) => {
  const abs = path.join(ROOT, rel);
  vm.runInThisContext(fs.readFileSync(abs, 'utf8'), { filename: abs });
};
loadScript('lofi-processor.js');
loadScript('plugins/mastering.js');

const moodNames = () => {
  const src = fs.readFileSync(path.join(ROOT, 'lofi-processor.js'), 'utf8');
  const out = [];
  const re = /name:'([\w-]+)',\s*bpm:/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
};

// ---------- рендер ----------
function renderTrack(mood, seed, seconds) {
  globalThis.__msgs = [];
  const gen = new registry['lofi-processor']({
    processorOptions: { seed, autoStart: true, oneShot: true, mood },
  });
  const mast = new registry['mastering-processor']();
  // Диагностика: подмена шин микса после старта сессии (d — барабаны, b — бас,
  // m — клавиши). mkSession читает mix на каждом блоке, поэтому подмена работает.
  if (globalThis.__mix) gen.mood.mix = globalThis.__mix;

  const frames = Math.ceil(seconds * SR);
  const L = new Float32Array(frames);
  const R = new Float32Array(frames);
  const gL = new Float32Array(BLOCK), gR = new Float32Array(BLOCK);
  const mL = new Float32Array(BLOCK), mR = new Float32Array(BLOCK);

  for (let off = 0; off < frames; off += BLOCK) {
    gen.process([], [[gL, gR]]);
    mast.process([[gL, gR]], [[mL, mR]]);
    const n = Math.min(BLOCK, frames - off);
    L.set(mL.subarray(0, n), off);
    R.set(mR.subarray(0, n), off);
  }
  const masterMsgs = globalThis.__msgs.filter((x) => x.type === 'mastering');
  return { L, R, kit: gen.kitName, bpm: gen.bpm, key: gen.keyName, scale: gen.scaleName,
    msg: masterMsgs.at(-1), msgs: globalThis.__msgs };
}

// ---------- FFT ----------
function makeFFT(n) {
  const levels = Math.round(Math.log2(n));
  const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos(2 * Math.PI * i / n);
    sin[i] = Math.sin(2 * Math.PI * i / n);
  }
  const rev = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let x = i, r = 0;
    for (let j = 0; j < levels; j++) { r = (r << 1) | (x & 1); x >>= 1; }
    rev[i] = r;
  }
  return (re, im) => {
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = i, k = 0; j < i + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre; im[l] = im[j] - tim;
          re[j] += tre; im[j] += tim;
        }
      }
    }
  };
}

const FFT_N = 4096;
let A_SR = SR;             // частота анализируемого материала (референс может быть другой)
const fft = makeFFT(FFT_N);
const WIN = new Float64Array(FFT_N);
for (let i = 0; i < FFT_N; i++) WIN[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / FFT_N));

// средний спектр мощности сигнала (для M и S отдельно)
function avgSpectrum(x, from, to) {
  const acc = new Float64Array(FFT_N / 2 + 1);
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  let count = 0;
  const hop = FFT_N / 2;
  for (let i = from; i + FFT_N <= to; i += hop) {
    for (let k = 0; k < FFT_N; k++) { re[k] = x[i + k] * WIN[k]; im[k] = 0; }
    fft(re, im);
    for (let k = 0; k <= FFT_N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
    count++;
  }
  if (count) for (let k = 0; k < acc.length; k++) acc[k] /= count;
  return acc;
}

const binHz = (k) => k * A_SR / FFT_N;
const bandEnergy = (spec, lo, hi) => {
  let s = 0;
  for (let k = Math.ceil(lo / (A_SR / FFT_N)); k <= Math.floor(hi / (A_SR / FFT_N)) && k < spec.length; k++) s += spec[k];
  return s;
};
const toDb = (x) => 10 * Math.log10(x + 1e-20);

// ---------- K-взвешивание и LUFS (ITU-R BS.1770-4) ----------
function biquadCoeffs(kind, f0, Q, gainDb) {
  const w0 = 2 * Math.PI * f0 / A_SR;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  let b0, b1, b2, a0, a1, a2;
  if (kind === 'highshelf') {
    const A = Math.pow(10, gainDb / 40);
    const alpha = sw / (2 * Q);
    const sA = 2 * Math.sqrt(A) * alpha;
    b0 = A * ((A + 1) + (A - 1) * cw + sA);
    b1 = -2 * A * ((A - 1) + (A + 1) * cw);
    b2 = A * ((A + 1) + (A - 1) * cw - sA);
    a0 = (A + 1) - (A - 1) * cw + sA;
    a1 = 2 * ((A - 1) - (A + 1) * cw);
    a2 = (A + 1) - (A - 1) * cw - sA;
  } else {
    const alpha = sw / (2 * Q);
    b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2;
    a0 = 1 + alpha; a1 = -2 * cw; a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function kWeight(x) {
  const stages = [
    biquadCoeffs('highshelf', 1681.974450955533, 0.7071752369554196, 3.999843853973347),
    biquadCoeffs('highpass', 38.13547087602444, 0.5003270373238773, 0),
  ];
  let y = Float64Array.from(x);
  for (const [b0, b1, b2, a1, a2] of stages) {
    const out = new Float64Array(y.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const xn = y[i];
      const yn = b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1; x1 = xn; y2 = y1; y1 = yn;
      out[i] = yn;
    }
    y = out;
  }
  return y;
}

// возвращает { lufs, lra, blocks }
function loudness(L, R, from, to) {
  const kl = kWeight(L.subarray(from, to));
  const kr = kWeight(R.subarray(from, to));
  const blockLen = Math.round(0.4 * SR);
  const hop = Math.round(0.1 * SR);
  const blocks = [];
  for (let i = 0; i + blockLen <= kl.length; i += hop) {
    let s = 0;
    for (let k = 0; k < blockLen; k++) s += kl[i + k] * kl[i + k] + kr[i + k] * kr[i + k];
    const ms = s / blockLen;
    blocks.push(-0.691 + 10 * Math.log10(ms + 1e-20));
  }
  const above = blocks.filter((v) => v > -70);
  if (!above.length) return { lufs: -Infinity, lra: 0, blocks: blocks.length };
  const mean = (a) => a.reduce((s, v) => s + Math.pow(10, v / 10), 0) / a.length;
  const abs = mean(above);
  const rel = -0.691 + 10 * Math.log10(abs) - 10;
  const gated = above.filter((v) => v > rel);
  const lufs = -0.691 + 10 * Math.log10(mean(gated.length ? gated : above));
  const sorted = above.slice().sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return { lufs, lra: p(0.95) - p(0.10), blocks: blocks.length };
}

// true peak приблизительно: 4x передискретизация (оконный sinc, 32 тапа)
function truePeak(x) {
  const TAPS = 32;
  const h = new Float64Array(TAPS * 4);
  for (let i = 0; i < TAPS * 4; i++) {
    const t = (i - (TAPS * 4 - 1) / 2) / 4;
    const s = t === 0 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
    const w = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (TAPS * 4 - 1));
    h[i] = s * w;
  }
  let peak = 0;
  const step = Math.max(1, Math.floor(x.length / 400000)); // прореживаем для скорости
  for (let i = TAPS; i < x.length - TAPS; i += step) {
    for (let ph = 0; ph < 4; ph++) {
      let acc = 0;
      for (let k = 0; k < TAPS; k++) acc += x[i - k] * h[k * 4 + ph];
      const a = Math.abs(acc);
      if (a > peak) peak = a;
    }
  }
  for (let i = 0; i < x.length; i += step) { const a = Math.abs(x[i]); if (a > peak) peak = a; }
  return peak;
}

// ---------- метрики ----------
function analyze(L, R, warmSec) {
  const from = Math.round(warmSec * SR);
  const to = L.length;
  const n = to - from;
  const out = {};

  let sumL = 0, sumR = 0, sumLR = 0, peak = 0, dcL = 0, dcR = 0;
  for (let i = from; i < to; i++) {
    const l = L[i], r = R[i];
    sumL += l * l; sumR += r * r; sumLR += l * r;
    dcL += l; dcR += r;
    const a = Math.max(Math.abs(l), Math.abs(r));
    if (a > peak) peak = a;
  }
  out.rmsDb = 10 * Math.log10((sumL + sumR) / (2 * n) + 1e-20);
  out.peakDb = 20 * Math.log10(peak + 1e-20);
  out.crestDb = out.peakDb - out.rmsDb;
  out.corr = sumLR / Math.sqrt(sumL * sumR + 1e-20);
  out.dcDb = 20 * Math.log10(Math.max(Math.abs(dcL), Math.abs(dcR)) / n + 1e-20);

  const tp = Math.max(truePeak(L.subarray(from, to)), truePeak(R.subarray(from, to)));
  out.truePeakDb = 20 * Math.log10(tp + 1e-20);

  let clip = 0;
  for (let i = from; i < to; i++) if (Math.abs(L[i]) >= 0.999 || Math.abs(R[i]) >= 0.999) clip++;
  out.clip = clip;

  const lo = loudness(L, R, from, to);
  out.lufs = lo.lufs;
  out.lra = lo.lra;

  // шумовой пол: 5-й процентиль по 200-мс блокам
  const bLen = Math.round(0.2 * A_SR);
  const rmsBlocks = [];
  for (let i = from; i + bLen <= to; i += bLen) {
    let s = 0;
    for (let k = 0; k < bLen; k++) s += L[i + k] * L[i + k] + R[i + k] * R[i + k];
    rmsBlocks.push(10 * Math.log10(s / bLen / 2 + 1e-20));
  }
  rmsBlocks.sort((a, b) => a - b);
  out.floorDb = rmsBlocks[Math.floor(rmsBlocks.length * 0.05)] ?? -Infinity;

  // спектр: моно и сайд
  const M = new Float32Array(n), S = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const l = L[from + i], r = R[from + i];
    M[i] = (l + r) * 0.5; S[i] = (l - r) * 0.5;
  }
  const specM = avgSpectrum(M, 0, n);
  const specS = avgSpectrum(S, 0, n);

  const total = bandEnergy(specM, 20, 20000);
  const bands = [
    ['sub', 20, 60], ['low', 60, 150], ['lowmid', 150, 500], ['mid', 500, 2000],
    ['himid', 2000, 6000], ['high', 6000, 12000], ['air', 12000, 20000],
  ];
  out.bands = {};
  for (const [name, a, b] of bands) {
    out.bands[name] = 10 * Math.log10(bandEnergy(specM, a, b) / total + 1e-20);
  }

  // спектральный центр и rolloff 95%
  let num = 0, den = 0, cum = 0, roll = 0;
  for (let k = 1; k < specM.length; k++) { num += binHz(k) * specM[k]; den += specM[k]; }
  out.centroid = den ? num / den : 0;
  for (let k = 1; k < specM.length; k++) {
    cum += specM[k];
    if (cum >= 0.95 * den) { roll = binHz(k); break; }
  }
  out.rolloff95 = roll;
  out.over16k = toDb(bandEnergy(specM, 16000, 22050) / total);
  out.over18k = toDb(bandEnergy(specM, 18000, 22050) / total);

  // наклон 200 Гц — 8 кГц, дБ/октаву
  const e200 = bandEnergy(specM, 100, 400), e8k = bandEnergy(specM, 4000, 16000);
  out.tilt = (10 * Math.log10(e8k / (e200 + 1e-20)) + 1e-20) / (Math.log2(8000 / 200));
  if (!isFinite(out.tilt)) out.tilt = 0;

  // стерео по полосам: side/mid, дБ
  out.sideMidLow = toDb(bandEnergy(specS, 20, 150) / (bandEnergy(specM, 20, 150) + 1e-20));
  out.sideMidMid = toDb(bandEnergy(specS, 150, 2000) / (bandEnergy(specM, 150, 2000) + 1e-20));
  out.sideMidHigh = toDb(bandEnergy(specS, 2000, 16000) / (bandEnergy(specM, 2000, 16000) + 1e-20));

  return out;
}

// ---------- WAV ----------
function writeWav(file, L, R) {
  const n = L.length;
  const buf = Buffer.alloc(44 + n * 4);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 4, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28);
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 4, 40);
  let o = 44;
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), o); o += 2;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), o); o += 2;
  }
  fs.writeFileSync(file, buf);
  return buf.length;
}

// ---------- чтение внешнего референса ----------
function readWav(file) {
  const buf = fs.readFileSync(file);
  if (buf.toString('ascii', 0, 4) !== 'RIFF') throw new Error('не RIFF/WAV: ' + file);
  let pos = 12, fmt = null, dataOff = 0, dataLen = 0;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4);
    const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10),
        sr: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22),
      };
    } else if (id === 'data') { dataOff = pos + 8; dataLen = Math.min(size, buf.length - dataOff); break; }
    pos += 8 + size + (size & 1);
  }
  if (!fmt || !dataOff) throw new Error('нет fmt/data: ' + file);
  const ch = fmt.channels, bits = fmt.bits;
  const bytes = bits / 8;
  const frames = Math.floor(dataLen / (bytes * ch));
  const L = new Float32Array(frames), R = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < Math.min(2, ch); c++) {
      const o = dataOff + (i * ch + c) * bytes;
      let v;
      if (fmt.format === 3 && bits === 32) v = buf.readFloatLE(o);
      else if (bits === 16) v = buf.readInt16LE(o) / 32768;
      else if (bits === 24) v = (buf.readUInt8(o) | (buf.readUInt8(o + 1) << 8) | (buf.readInt8(o + 2) << 16)) / 8388608;
      else if (bits === 32) v = buf.readInt32LE(o) / 2147483648;
      else throw new Error('не поддержано: ' + bits + ' бит');
      if (c === 0) L[i] = v; else R[i] = v;
    }
    if (ch === 1) R[i] = L[i];
  }
  return { L, R, sr: fmt.sr, seconds: frames / fmt.sr };
}

function printRow(label, m, note = '') {
  console.log(
    label.padEnd(13) +
    fmt(m.lufs) + fmt(m.lra, 0) + fmt(m.peakDb) + fmt(m.truePeakDb) + fmt(m.crestDb) +
    fmt(m.floorDb, 0) + fmt(m.corr, 2).padEnd(5) + fmt(m.centroid, 0) + fmt(m.rolloff95, 0) +
    fmt(m.tilt, 2) + fmt(m.sideMidLow, 0).padEnd(7) + fmt(m.sideMidHigh, 0).padEnd(7) + note
  );
}
// ---------- CLI ----------
const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const [k, v] = a.replace(/^--/, '').split('=');
  return [k, v ?? true];
}));
const seconds = Number(args.sec || 80);
const warm = Math.min(15, seconds * 0.25);
if (args.mix) {
  const [d, b, m] = String(args.mix).split(',').map(Number);
  globalThis.__mix = { d, b, m };
}
const all = moodNames();
const chosen = args.moods ? String(args.moods).split(',') : all;
const wavList = args.wav ? (args.wav === true ? chosen : String(args.wav).split(',')) : [];
const outDir = path.join(ROOT, 'qa');
if (wavList.length) fs.mkdirSync(outDir, { recursive: true });

const fmt = (v, d = 1) => (v === -Infinity ? '  -inf' : v.toFixed(d).padStart(6));
const rows = [];
const HEAD = [['слой', 13], ['LUFS', 6], ['LRA', 4], ['peak', 6], ['trueP', 6], ['crest', 6],
  ['floor', 6], ['corr', 5], ['cent', 6], ['roll', 6], ['tilt', 6], ['S/M lo', 7], ['S/M hi', 7], ['кит', 0]];
const head = HEAD.map(([t, w]) => String(t).padEnd(w)).join('');
console.log(`\nрендер ${seconds} с, анализ с ${warm.toFixed(0)} с, ${SR} Гц\n`);
console.log(head);
console.log('─'.repeat(head.length));

for (const mood of chosen) {
  const seed = 0x1234567 + all.indexOf(mood) * 7919;
  const t0 = Date.now();
  const { L, R, kit, bpm, msg, msgs } = renderTrack(mood, seed, seconds);
  const m = analyze(L, R, warm);
  rows.push({ mood, kit, ...m });
  printRow(mood, m, `  ${kit} ${bpm}  norm ${(msg ? msg.norm : 0).toFixed(1)} / замер ${(msg ? msg.lufs : 0).toFixed(1)} / комп ${(msg ? msg.compGr : 0).toFixed(1)} / лим ${(msg ? msg.limGr : 0).toFixed(1)}  (${((Date.now() - t0) / 1000).toFixed(0)} с)`);
  if (args.dyn) {
    const mm = msgs.filter((x) => x.type === 'mastering');
    const step = Math.max(1, Math.floor(mm.length / 12));
    console.log('  динамика AGC (каждая ' + step + '-я посылка из ' + mm.length + '):');
    for (let i = 0; i < mm.length; i += step) {
      const x = mm[i];
      console.log(`    norm ${x.norm.toFixed(1).padStart(6)} · замер ${x.lufs.toFixed(1).padStart(6)} · комп ${x.compGr.toFixed(1)} · лим ${x.limGr.toFixed(1)}`);
    }
  }
  if (wavList.includes(mood)) {
    const bytes = writeWav(path.join(outDir, `${mood}.wav`), L, R);
    console.log(`   → qa/${mood}.wav, ${(bytes / 1048576).toFixed(1)} МБ`);
  }
}

const avg = (f) => rows.reduce((s, r) => s + (isFinite(f(r)) ? f(r) : 0), 0) / rows.length;
const spread = (f) => {
  const v = rows.map(f).filter(isFinite);
  return Math.max(...v) - Math.min(...v);
};
console.log('─'.repeat(head.length));
console.log(`средние: LUFS ${avg((r) => r.lufs).toFixed(1)} · crest ${avg((r) => r.crestDb).toFixed(1)} дБ · `
  + `центр ${avg((r) => r.centroid).toFixed(0)} Гц · corr ${avg((r) => r.corr).toFixed(2)}`);
console.log(`разброс: LUFS ${spread((r) => r.lufs).toFixed(1)} дБ · crest ${spread((r) => r.crestDb).toFixed(1)} дБ · `
  + `центр ${spread((r) => r.centroid).toFixed(0)} Гц\n`);

if (args.bands) {
  const BN = ['sub', 'low', 'lowmid', 'mid', 'himid', 'high', 'air'];
  const bh = 'спектр, дБ'.padEnd(13) + BN.map((b) => b.padStart(7)).join('');
  console.log(bh);
  console.log('─'.repeat(bh.length));
  for (const r of rows) {
    console.log(r.mood.padEnd(13) + BN.map((b) => r.bands[b].toFixed(1).padStart(7)).join(''));
  }
  console.log('─'.repeat(bh.length));
  const mean = (b) => rows.reduce((s, r) => s + r.bands[b], 0) / rows.length;
  const span = (b) => {
    const v = rows.map((r) => r.bands[b]);
    return Math.max(...v) - Math.min(...v);
  };
  console.log('среднее'.padEnd(13) + BN.map((b) => mean(b).toFixed(1).padStart(7)).join(''));
  console.log('разброс'.padEnd(13) + BN.map((b) => span(b).toFixed(1).padStart(7)).join(''));
  console.log();
}

if (args.ref) {
  console.log('референс (внешний файл):');
  console.log(head);
  console.log('─'.repeat(head.length));
  for (const f of String(args.ref).split(',')) {
    const w = readWav(f);
    A_SR = w.sr;
    const m = analyze(w.L, w.R, Math.min(15, w.seconds * 0.25));
    printRow(path.basename(f).replace(/\.[^.]+$/, '').slice(0, 13), m,
      `  (${w.sr} Гц, ${w.seconds.toFixed(0)} с)`);
    if (args.bands) {
      const BN = ['sub', 'low', 'lowmid', 'mid', 'himid', 'high', 'air'];
      console.log(' '.repeat(13) + BN.map((b) => m.bands[b].toFixed(1).padStart(7)).join(''));
    }
  }
  console.log();
}

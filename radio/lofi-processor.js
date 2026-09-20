/* =====================================================
   LO-FI ENGINE · AudioWorkletProcessor
   Процедурный генератор lo-fi hip hop во всём диапазоне жанра:
   dusty boom-bap (Dilla), jazzhop (Nujabes), chillhop, midnight,
   ambient/sleep, lo-fi house и экспериментальная ветка (SP-1200,
   глитч, тейп-стопы).

   Каждая сессия = свой жанровый слой: набор инструментов, драм-кит,
   лад и гармония, грув, текстуры (винил/шипение/вау-флаттер),
   форма трека и плотность. Ноты в треке — мотив, а не случайные
   пики, как принято в жанре.

   Выход: генератор → plugins/mastering.js → destination.
   ===================================================== */

// ===== Утилиты =====
// Источник случайности для всего движка. На время трека он подменяется
// детерминированным генератором от зерна (см. mkSession): тогда по зерну
// воспроизводится трек целиком — и скелет, и исполнение. Поэтому эфир,
// ссылка ?t=<зерно> и скачанный файл звучат одинаково, до последнего фильтра.
let RNG = Math.random;

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function rnd(min, max) { return min + RNG() * (max - min); }
function pick(arr) { return arr[Math.floor(RNG() * arr.length)]; }
function chance(p) { return RNG() < p; }
function clamp(x, lo, hi) { return x < lo ? lo : (x > hi ? hi : x); }
function polyBlep(t, dt) {
  if (t < dt) { const x = t / dt; return x + x - x * x - 1; }
  if (t > 1 - dt) { const x = (t - 1) / dt; return x * x + x + x + 1; }
  return 0;
}
// ===== Фильтр состояний (SVF, 2-полюсник): lp / bp / hp без аллокаций =====
// Коэффициенты считаются один раз на триггер (set), в сэмпловом цикле только арифметика.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.oLp = 0; this.oBp = 0; this.oHp = 0; this.a1 = 0; this.a2 = 0; this.a3 = 0; this.k = 1; }
  set(f, q, sr) {
    const fc = f > sr * 0.45 ? sr * 0.45 : (f < 20 ? 20 : f);
    const g = Math.tan(Math.PI * fc / sr);
    this.k = 1 / q;
    this.a1 = 1 / (1 + g * (g + this.k));
    this.a2 = g * this.a1;
    this.a3 = g * this.a2;
  }
  process(x) {
    const v3 = x - this.ic2;
    const v1 = this.a1 * this.ic1 + this.a2 * v3;
    const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.oLp = this.ic2;
    this.oBp = this.ic1;
    this.oHp = x - this.k * this.ic1 - this.ic2;
    return this.oBp;
  }
}

const NOTE = { C:0, 'C#':1, D:2, 'D#':3, E:4, F:5, 'F#':6, G:7, 'G#':8, A:9, 'A#':10, B:11 };
const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'];

// Дрейф строя (wow/flutter + тейп-стоп), обновляется процессором раз в сэмпл.
// Глубина разная по шинам: клавиши и лид плывут сильнее всех, барабаны — как
// сэмплы, снятые с ленты (30%), бас держим у кика (15%), иначе низ «разъезжается».
let PITCH_DRIFT = 0;
let PITCH_DRIFT_DRUM = 0;
let PITCH_DRIFT_BASS = 0;
let PITCH_DRIFT_LEAD = 0;

// Верхняя граница барабанов: у лофая верх всегда срезан (лента/кассета).
// Значение задаёт сессия из характера кита, барабаны берут его по умолчанию.
let DRUM_TOP = 8000;

function noteFreq(name, octave) {
  const n = NOTE[name] + (octave - 4) * 12;
  return 440 * Math.pow(2, (n - 9) / 12);
}

// ===== Гармония =====
const SCALES = {
  aeolian:       [0,2,3,5,7,8,10],
  dorian:        [0,2,3,5,7,9,10],
  lydian:        [0,2,4,6,7,9,11],
  mixolydian:    [0,2,4,5,7,9,10],
  harmonicMinor: [0,2,3,5,7,8,11],
  major:         [0,2,4,5,7,9,11],
};

const CHORDS = {
  m7:[0,3,7,10], m9:[0,3,7,10,14], m11:[0,3,7,14,17], m6:[0,3,7,9],
  maj7:[0,4,7,11], maj9:[0,4,7,11,14], add9:[0,4,7,14], six9:[0,4,9,14],
  dom7:[0,4,7,10], dom9:[0,4,7,10,14], dom13:[0,4,10,14,21],
  m7b5:[0,3,6,10], dim7:[0,3,6,9], sus4:[0,5,7,10], quartal:[0,5,10,15],
};

// Прогрессии: [качество, ступень лада, альтерация в полутонах]
const PROGRESSIONS = [
  { name:'ii-V-I',       jazz:1, chords:[['m9',2],['dom9',5],['maj9',1]] },
  { name:'vi-ii-V-I',    jazz:1, chords:[['m9',6],['m9',2],['dom9',5],['maj9',1]] },
  { name:'IV-iii-ii-I',  jazz:1, chords:[['maj9',4],['m9',3],['m9',2],['maj9',1]] },
  { name:'i-iv-VII-III', jazz:0, chords:[['m9',1],['m9',4],['dom7',7],['maj9',3]] },
  { name:'i-VI-III-VII', jazz:0, chords:[['m9',1],['maj9',6],['maj9',3],['dom7',7]] },
  { name:'i-VII-VI-VII', jazz:0, chords:[['m9',1],['maj7',7],['maj9',6],['dom7',7]] },
  { name:'vamp',         jazz:0, chords:[['m9',1],['m11',4]] },
  { name:'backdoor',     jazz:1, chords:[['maj9',1],['m9',4,-1],['maj9',1],['dom9',5]] },
  { name:'tritone',      jazz:1, chords:[['m9',2],['dom9',2,-1],['maj9',1]] },
  { name:'modal-float',  jazz:0, chords:[['m11',1],['maj9',6],['maj9',3],['m9',4]] },
  { name:'quartal',      jazz:0, weird:1, chords:[['quartal',1],['quartal',4],['quartal',6]] },
  { name:'chromatic',    jazz:1, chords:[['m9',1],['maj9',6],['m9',3],['dom9',2,-1]] },
];

// ===== Синтез-движки (тембры) =====
const VOICES = {
  // «Тёмное» семейство (клавиши, гитара, чап) держит всю lo-fi палитру, поэтому
  // именно ему нужна верхняя середина: раньше h3/h5 были почти нулевые, и всё
  // выше 2 кГц приходилось вытягивать мастеру — а ему уже нечего было поднимать.
  rhodes:  { type:'fm',   ratio:2.0,  index:2.0, modDecay:1.2, trem:5.2, tremDepth:0.18, attack:0.012, release:0.9, lp:7200 },
  wurli:   { type:'fm',   ratio:3.0,  index:1.5, modDecay:2.0, trem:6.4, tremDepth:0.26, attack:0.010, release:0.7, lp:6400 },
  // Индекс у колокольчика был 2.6 при срезе 9 кГц: звон стоял выше всей
  // палитры и на длинных нотах бил по ушам. Индекс 1.9 и срез 6.8 к всё ещё
  // оставляли его самым ярким голосом (замер: у ambient/dark/vapor полоса
  // 2–6 кГц выше остальных на 8–9 дБ). Тембр тот же, но теперь он в палитре.
  bell:    { type:'fm',   ratio:3.51, index:1.15, modDecay:1.1, attack:0.005, release:1.6, lp:4700 },
  keys:    { type:'add',  h2:0.28, h3:0.22, h5:0.07, h7:0.04, hDecay:0.8, attack:0.008, release:0.8, lp:7200 },
  pluck:   { type:'add',  h2:0.50, h3:0.24, h5:0.09, h7:0.035, hDecay:4.5, attack:0.004, release:0.5, lp:6800 },
  organ:   { type:'add',  h2:0.05, h3:0.50, h5:0.22, attack:0.05, release:0.6, lp:5200 },
  saw:     { type:'saw',  attack:0.55, release:1.5, detune:10, lp:2600 },
  soft:    { type:'add',  h2:0.20, h3:0.14, h7:0.05, attack:0.35, release:1.2, lp:5000 },
  tone:    { type:'add',  h2:0.35, h3:0.10, attack:0.010, release:0.1, lp:4000 },
  snareTone:{ type:'add', h2:0.06, h3:0.00, attack:0.002, release:0.12, lp:3000 },
  sub:     { type:'add',  h2:0.00, h3:0.00, attack:0.012, release:0.45, lp:900 },
  upright: { type:'add',  h2:0.22, h3:0.05, hDecay:3.0, attack:0.012, release:0.5, lp:1200 },
  elbass:  { type:'saw',  attack:0.012, release:0.35, detune:4, lp:420 },
  // Гитарная и «хрустальная» группа: щипок с быстрым спадом гармоник
  nylon:   { type:'add',  h2:0.46, h3:0.26, h5:0.09, h7:0.05, hDecay:5.5, attack:0.006, release:0.45, lp:5400 },
  kalimba: { type:'add',  h2:0.40, h3:0.16, h5:0.06, h7:0.02, hDecay:7.5, attack:0.003, release:0.30, lp:4700 },
  // Струнный ансамбль: пила с медленной атакой и расстройкой (ширину даёт второй голос)
  strings: { type:'saw',  attack:0.42, release:1.7, lp:1500 },
  // Вокальный чап: форманта из h2/h3 через низкий срез + вибрато
  voice:   { type:'add',  h2:0.60, h3:0.34, h5:0.10, h7:0.04, attack:0.060, release:0.55, lp:2300,
                         vib:5.0, vibDepth:9 },
};

// ===== Драм-машины (10 характеров) =====
// Архитектура как у реальных машин: кик = суб + тело + клик битера,
// снейр = два тона разной высоты + шумовой слой, железо = шум в верхней полосе
// (тело + короткий край). Металлического кластера нет нигде: ни в железе,
// ни в райде — значит нет и «колокольного» звона мимо тональности.
// Частоты слоёв разнесены по зонам спектра, чтобы не было маскирования:
//   кик суб 40-65 Гц, тело 80-100 Гц, клик 3-5 кГц
//   снейр тело 130-185 Гц, шум 1.5-4.5 кГц (HP 180 Гц — не лезет в низ)
//   железо 4.6-9.5 кГц, тело/край задаются полосой bp/hp ниже
const KITS = {
  tr808: {
    kick:  { subTune:[40,60], subDec:[0.45,0.75], subAmp:0.95, bodyDrop:[1.6,2.0], bodyShape:[10,18], bodyDec:[0.05,0.09], bodyAmp:0.45, clickAmp:[0.03,0.07], clickFc:[3200,4200], clickDec:[0.003,0.006] },
    snare: { toneTune:[150,185], tone2:1.83, toneDec:[0.12,0.2], toneAmp:0.42, nFc:[1800,3000], nQ:1.0, nDec:[0.15,0.25], nAmp:1.08 },
    hat:   { bp:[5200,6800], bpQ:0.55, hp:[2000,2900], dec:[0.03,0.06], openDec:[0.30,0.50], peak:0.05 },
    perc: null, crush: 0.15, drive: 1.15, tilt:[2400,3400], hi:[1.05,1.20],
  },
  // 909 в лоу-фае: клик срезан вдвое, верх заглушён лентой, больше шершавости
  tr909: {
    kick:  { subTune:[42,62], subDec:[0.28,0.44], subAmp:0.85, bodyDrop:[2.2,2.8], bodyShape:[16,24], bodyDec:[0.04,0.06], bodyAmp:0.6, clickAmp:[0.06,0.13], clickFc:[3200,4000], clickDec:[0.003,0.006] },
    snare: { toneTune:[160,195], tone2:2.0, toneDec:[0.10,0.16], toneAmp:0.45, nFc:[2000,3200], nQ:0.9, nDec:[0.13,0.20], nAmp:0.90, clapLayer:[0.20,0.32] },
    hat:   { bp:[5400,7000], bpQ:0.55, hp:[2100,2900], dec:[0.03,0.06], openDec:[0.22,0.38], peak:0.05 },
    perc: null, crush: 0.45, drive: 1.15, tilt:[2600,3600], hi:[1.07,1.20],
  },
  sp1200: {
    kick:  { subTune:[40,58], subDec:[0.22,0.35], subAmp:0.9, bodyDrop:[2.3,2.8], bodyShape:[18,30], bodyDec:[0.03,0.05], bodyAmp:0.55, clickAmp:[0.20,0.32], clickFc:[3600,4600], clickDec:[0.004,0.007] },
    snare: { toneTune:[140,180], tone2:1.9, toneDec:[0.08,0.13], toneAmp:0.5, nFc:[2200,3600], nQ:1.2, nDec:[0.09,0.15], nAmp:0.8 },
    hat:   { bp:[5600,7200], bpQ:0.55, hp:[2200,3100], dec:[0.02,0.04], openDec:[0.15,0.25], peak:0.06 },
    perc: 'rim', crush: 0.55, drive: 1.30, tilt:[2600,3800], hi:[1.10,1.25],
  },
  mpc60: {
    kick:  { subTune:[42,62], subDec:[0.30,0.45], subAmp:0.75, bodyDrop:[2.0,2.4], bodyShape:[12,20], bodyDec:[0.05,0.08], bodyAmp:0.75, clickAmp:[0.08,0.16], clickFc:[3000,3800], clickDec:[0.004,0.008] },
    snare: { toneTune:[145,185], tone2:1.83, toneDec:[0.11,0.17], toneAmp:0.385, nFc:[2000,3200], nQ:1.0, nDec:[0.12,0.20], nAmp:0.98 },
    hat:   { bp:[5000,6600], bpQ:0.5, hp:[1900,2700], dec:[0.03,0.07], openDec:[0.25,0.40], peak:0.05 },
    perc: null, crush: 0.40, drive: 1.25, tilt:[2600,3700], hi:[1.08,1.22],
  },
  linn: {
    kick:  { subTune:[45,65], subDec:[0.18,0.30], subAmp:0.7, bodyDrop:[1.9,2.2], bodyShape:[16,26], bodyDec:[0.06,0.10], bodyAmp:0.85, clickAmp:[0.12,0.20], clickFc:[3400,4200], clickDec:[0.004,0.007] },
    snare: { toneTune:[150,185], tone2:1.6, toneDec:[0.12,0.18], toneAmp:0.49, nFc:[2800,4200], nQ:0.9, nDec:[0.14,0.22], nAmp:1.14 },
    hat:   { bp:[5400,7000], bpQ:0.55, hp:[2200,3100], dec:[0.03,0.06], openDec:[0.20,0.35], peak:0.05 },
    perc: null, crush: 0.05, drive: 1.15, tilt:[2600,3600], hi:[1.05,1.18],
  },
  dmx: {
    kick:  { subTune:[40,60], subDec:[0.22,0.32], subAmp:0.85, bodyDrop:[2.2,2.6], bodyShape:[16,26], bodyDec:[0.04,0.07], bodyAmp:0.6, clickAmp:[0.18,0.28], clickFc:[3600,4800], clickDec:[0.004,0.007] },
    snare: { toneTune:[150,190], tone2:1.7, toneDec:[0.10,0.16], toneAmp:0.385, nFc:[3000,4500], nQ:0.9, nDec:[0.10,0.16], nAmp:1.24 },
    hat:   { bp:[5800,7500], bpQ:0.55, hp:[2400,3300], dec:[0.02,0.05], openDec:[0.18,0.28], peak:0.055 },
    perc: 'rim', crush: 0.10, drive: 1.2, tilt:[2800,4000], hi:[1.08,1.22],
  },
  dusty: {
    kick:  { subTune:[40,58], subDec:[0.28,0.42], subAmp:0.7, bodyDrop:[2.0,2.4], bodyShape:[13,22], bodyDec:[0.05,0.08], bodyAmp:0.75, clickAmp:[0.06,0.14], clickFc:[2800,3600], clickDec:[0.004,0.008] },
    snare: { toneTune:[140,175], tone2:1.75, toneDec:[0.11,0.17], toneAmp:0.35, nFc:[1600,2600], nQ:0.8, nDec:[0.14,0.22], nAmp:0.96 },
    hat:   { bp:[4600,6200], bpQ:0.5, hp:[1700,2500], dec:[0.03,0.07], openDec:[0.18,0.30], peak:0.05 },
    perc: null, crush: 0.20, drive: 1.20, tilt:[2600,3600], hi:[1.05,1.18],
  },
  brush: {
    kick:  { subTune:[42,60], subDec:[0.20,0.32], subAmp:0.6, bodyDrop:[1.8,2.1], bodyShape:[15,24], bodyDec:[0.04,0.07], bodyAmp:0.5, clickAmp:[0.03,0.08], clickFc:[2600,3400], clickDec:[0.003,0.006] },
    snare: { toneTune:[150,190], tone2:1.65, toneDec:[0.16,0.24], toneAmp:0.3, nFc:[3000,5000], nQ:0.7, nDec:[0.25,0.45], nAmp:0.88, brush:true },
    hat:   { bp:[5600,7200], bpQ:0.5, hp:[2300,3200], dec:[0.04,0.09], openDec:[0.25,0.40], peak:0.05 },
    perc: 'shaker', crush: 0, drive: 1.10, tilt:[2600,3600], hi:[1.05,1.18],
  },
  jazz: {
    kick:  { subTune:[48,65], subDec:[0.16,0.26], subAmp:0.55, bodyDrop:[1.7,2.0], bodyShape:[18,28], bodyDec:[0.03,0.05], bodyAmp:0.6, clickAmp:[0.04,0.10], clickFc:[3000,4000], clickDec:[0.003,0.006] },
    snare: { toneTune:[160,200], tone2:1.5, toneDec:[0.06,0.10], toneAmp:0.54, nFc:[2500,4000], nQ:1.0, nDec:[0.05,0.09], nAmp:0.74 },
    hat:   { bp:[6000,7800], bpQ:0.55, hp:[2500,3400], dec:[0.03,0.06], openDec:[0.30,0.50], peak:0.05 },
    perc: 'ride', crush: 0, drive: 1.05, tilt:[3000,4200], hi:[1.10,1.25],
  },
  // хаус-кит в лоу-фае: держим грув 4/4 и клэп, но клик и верх срезаны лентой
  house: {
    kick:  { subTune:[42,58], subDec:[0.24,0.36], subAmp:0.9, bodyDrop:[2.4,3.0], bodyShape:[18,26], bodyDec:[0.03,0.05], bodyAmp:0.55, clickAmp:[0.07,0.15], clickFc:[3200,4200], clickDec:[0.003,0.006] },
    snare: { toneTune:[160,200], tone2:2.0, toneDec:[0.09,0.14], toneAmp:0.35, nFc:[2200,3400], nQ:0.95, nDec:[0.11,0.17], nAmp:0.70, clapLayer:[0.32,0.48] },
    hat:   { bp:[5600,7200], bpQ:0.55, hp:[2100,3000], dec:[0.03,0.06], openDec:[0.16,0.26], peak:0.05 },
    perc: null, crush: 0.35, drive: 1.15, tilt:[2600,3600], hi:[1.07,1.20],
  },
  glitch: {
    kick:  { subTune:[44,62], subDec:[0.10,0.20], subAmp:0.85, bodyDrop:[3.0,4.0], bodyShape:[24,40], bodyDec:[0.02,0.04], bodyAmp:0.5, clickAmp:[0.25,0.40], clickFc:[5000,7000], clickDec:[0.002,0.005] },
    snare: { toneTune:[170,230], tone2:2.2, toneDec:[0.05,0.10], toneAmp:0.4, nFc:[4000,6500], nQ:1.4, nDec:[0.05,0.10], nAmp:0.7 },
    hat:   { bp:[6600,8600], bpQ:0.7, hp:[2800,3800], dec:[0.02,0.04], openDec:[0.09,0.16], peak:0.05 },
    perc: 'wood', crush: 0.65, drive: 1.35, tilt:[3200,5200], hi:[1.15,1.35],
  },
};

// ===== Паттерны (16 шагов) =====
const PATTERNS = {
  dusty: [
    { name:'MIDNIGHT', kick:[1,0,0,0,0,0,1,0,0,0,0,0,1,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,0] },
    { name:'DUSTY',    kick:[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[0,1,0,1,0,1,0,1,0,1,0,1,0,1,1,0] },
    { name:'SMOKE',    kick:[1,0,0,0,0,0,0,0,1,0,1,0,0,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[1,1,0,1,0,1,1,0,1,0,1,1,0,1,0,1] },
    { name:'VELVET',   kick:[1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[1,0,0,1,0,0,1,0,1,0,0,1,0,0,1,0] },
  ],
  brush: [
    { name:'BRUSHED',  kick:[1,0,0,0,0,0,0,0,0,0,1,0,0,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[1,0,1,0,1,0,1,0,1,0,1,0,1,0,1,1] },
    { name:'SOFT',     kick:[1,0,0,0,0,0,1,0,0,0,0,0,0,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[1,1,1,0,1,1,1,0,1,1,1,0,1,1,1,0] },
    { name:'JAZZ',     kick:[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], snare:[0,0,0,0,1,0,0,1,0,0,0,0,1,0,1,0], hat:[1,0,1,1,1,0,1,0,1,0,1,1,1,0,1,0] },
  ],
  house: [
    { name:'FOUR',     kick:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[0,0,1,0,0,0,1,0,0,0,1,0,0,0,1,1] },
    { name:'DEEP',     kick:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,1,0], hat:[0,1,1,0,0,1,1,0,0,1,1,0,0,1,1,1] },
  ],
  sparse: [
    { name:'DRIFT',    kick:[1,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0], snare:[0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0], hat:[0,0,1,0,0,0,0,0,0,0,1,0,0,0,0,0] },
    { name:'HALF',     kick:[1,0,0,0,0,0,0,0,1,0,0,0,0,0,0,0], snare:[0,0,0,0,0,0,0,0,0,0,0,0,1,0,0,0], hat:[1,0,0,0,1,0,0,0,1,0,0,0,1,0,0,0] },
  ],
  // Босса: синкопа 3-3-2, лёгкий малый, ровные щётки
  bossa: [
    { name:'BOSSA',    kick:[1,0,0,1,0,0,1,0,1,0,0,1,0,0,1,0], snare:[0,0,0,0,0,0,0,0,1,0,0,0,1,0,0,0], hat:[1,0,1,1,1,0,1,0,1,0,1,1,1,0,1,0] },
    { name:'IPANEMA',  kick:[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], snare:[0,0,0,0,0,0,0,0,1,0,0,0,1,0,0,1], hat:[1,1,0,1,0,1,1,0,1,1,0,1,0,1,1,0] },
  ],
  // Трэп: хэты в 1/16 подряд (ролл даёт ghost-слой), кик по 3-3-2
  trap: [
    { name:'ROLL',     kick:[1,0,0,0,0,0,1,0,0,0,1,0,0,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,0], hat:[1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1] },
    { name:'HALFTIME', kick:[1,0,0,0,0,0,0,1,0,0,1,0,0,0,0,0], snare:[0,0,0,0,1,0,0,0,0,0,0,0,1,0,0,1], hat:[1,0,1,0,1,1,0,1,1,0,1,1,0,1,1,0] },
  ],
};

// ===== Жанровые слои (moods) =====
const MOODS = [
  {
    name:'dusty', bpm:[74,86], scales:['aeolian','dorian'], jazz:0.5,
    pad:'wurli', lead:'pluck', bass:'upright', kits:['sp1200','mpc60','dusty'], patterns:'dusty',
    swing:[0.55,0.63], density:0.9, ghost:0.25, lp:[3000,4200], chordBars:[2,2],
    reverb:0.35, delay:0.22, mix:{ d:0.50, b:0.30, m:1.00 },
    form:'loop', bassSteps:[0,6,10], leadOct:[4,5], motifLen:2, tapeStop:0.10, sweep:0.5,
  },
  {
    name:'jazzhop', bpm:[78,94], scales:['dorian','major'], jazz:1,
    pad:'rhodes', lead:'keys', bass:'upright', kits:['jazz','brush','linn'], patterns:'brush',
    swing:[0.56,0.64], density:0.95, ghost:0.30, lp:[3800,5200], chordBars:[1,2],
    reverb:0.40, delay:0.30, mix:{ d:0.45, b:0.32, m:1.05 },
    form:'loop', bassSteps:[0,4,8,12], leadOct:[4,6], motifLen:4, tapeStop:0.05, sweep:0.4,
  },
  {
    name:'chillhop', bpm:[70,86], scales:['major','lydian'], jazz:0.8,
    pad:'rhodes', lead:'keys', bass:'elbass', kits:['mpc60','linn','dusty'], patterns:'dusty',
    swing:[0.52,0.58], density:1.0, ghost:0.20, lp:[4500,6000], chordBars:[1,1],
    reverb:0.45, delay:0.35, mix:{ d:0.50, b:0.28, m:1.00 },
    form:'sections', bassSteps:[0,6,10], leadOct:[4,5], motifLen:4, tapeStop:0.04, sweep:0.6,
  },
  {
    name:'midnight', bpm:[64,76], scales:['aeolian','harmonicMinor'], jazz:0.6,
    pad:'saw', lead:'bell', bass:'sub', kits:['tr808','mpc60','dusty'], patterns:'dusty',
    swing:[0.53,0.60], density:0.85, ghost:0.15, lp:[2600,3600], chordBars:[2,2],
    reverb:0.60, delay:0.30, mix:{ d:0.50, b:0.34, m:0.92 },
    form:'sections', bassSteps:[0,10], leadOct:[4,5], motifLen:2, tapeStop:0.12, sweep:0.7,
  },
  {
    name:'ambient', bpm:[52,66], scales:['lydian','aeolian'], jazz:0.4,
    pad:'saw', lead:'bell', bass:'sub', kits:['brush','linn'], patterns:'sparse',
    swing:[0.50,0.55], density:0.4, ghost:0.05, lp:[2200,3200], chordBars:[2,4],
    reverb:0.9, delay:0.45, mix:{ d:0.30, b:0.20, m:1.15 },
    form:'ambient', bassSteps:[0], leadOct:[5,6], motifLen:4, tapeStop:0.0, sweep:0.9,
  },
  {
    name:'experimental', bpm:[72,100], scales:['dorian','harmonicMinor','lydian'], jazz:0.7,
    pad:'organ', lead:'pluck', bass:'elbass', kits:['sp1200','glitch','tr909'], patterns:'dusty',
    swing:[0.50,0.66], density:0.9, ghost:0.35, lp:[3000,6200], chordBars:[1,2],
    reverb:0.50, delay:0.40, mix:{ d:0.55, b:0.30, m:1.00 },
    form:'glitch', bassSteps:[0,6,10,14], leadOct:[4,6], motifLen:4, tapeStop:0.5, sweep:0.8,
  },
  {
    name:'lofi-house', bpm:[110,122], scales:['aeolian','dorian'], jazz:0.4,
    pad:'rhodes', lead:'keys', bass:'elbass', kits:['house','tr909','sp1200'], patterns:'house',
    swing:[0.50,0.55], density:1.0, ghost:0.10, lp:[4000,6000], chordBars:[1,1],
    reverb:0.45, delay:0.35, mix:{ d:0.62, b:0.34, m:0.95 },
    form:'sections', bassSteps:[2,6,10,14], leadOct:[4,5], motifLen:4, tapeStop:0.05, sweep:0.5,
  },
  {
    // lo-fi R&B / соул-нарезка: медленно, тепло, много свинга
    name:'soul', bpm:[68,80], scales:['aeolian','dorian'], jazz:0.6,
    pad:'wurli', lead:'rhodes', bass:'upright', kits:['mpc60','dusty','sp1200'], patterns:'dusty',
    swing:[0.58,0.66], density:0.85, ghost:0.30, lp:[2600,3800], chordBars:[2,2],
    reverb:0.50, delay:0.25, mix:{ d:0.48, b:0.34, m:1.05 },
    form:'loop', bassSteps:[0,6,10], leadOct:[4,5], motifLen:2, tapeStop:0.08, sweep:0.5,
  },
  {
    // босса-лофи: синкопа 3-3-2, щётки, светлая гармония
    name:'bossa', bpm:[84,98], scales:['major','lydian','dorian'], jazz:0.9,
    pad:'rhodes', lead:'pluck', bass:'upright', kits:['brush','jazz','linn'], patterns:'bossa',
    swing:[0.52,0.58], density:0.80, ghost:0.35, lp:[3400,4800], chordBars:[1,2],
    reverb:0.40, delay:0.20, mix:{ d:0.42, b:0.30, m:1.05 },
    form:'sections', bassSteps:[0,3,8,11], leadOct:[4,6], motifLen:4, tapeStop:0.02, sweep:0.4,
  },
  {
    // peaceful piano: почти без барабанов, всё держат клавиши
    name:'piano', bpm:[58,72], scales:['major','aeolian','lydian'], jazz:0.7,
    pad:'soft', lead:'keys', bass:'upright', kits:['brush','linn','jazz'], patterns:'sparse',
    swing:[0.50,0.56], density:0.45, ghost:0.10, lp:[2600,3600], chordBars:[2,4],
    reverb:0.75, delay:0.30, mix:{ d:0.26, b:0.22, m:1.20 },
    form:'ambient', bassSteps:[0,8], leadOct:[5,6], motifLen:4, tapeStop:0.0, sweep:0.8,
  },
  {
    // тёмный эмбиент: дрон, длинная реверберация, барабанов почти нет
    name:'dark', bpm:[46,58], scales:['harmonicMinor','aeolian'], jazz:0.3,
    pad:'saw', lead:'bell', bass:'sub', kits:['brush','linn'], patterns:'sparse',
    swing:[0.50,0.54], density:0.30, ghost:0.03, lp:[1500,2400], chordBars:[4,4],
    reverb:1.05, delay:0.50, mix:{ d:0.22, b:0.26, m:1.25 },
    form:'ambient', bassSteps:[0], leadOct:[5,6], motifLen:4, tapeStop:0.0, sweep:1.0,
  },
  {
    // lo-fi трэп: 808-суб, ролл-хэты, медленный хэтфул
    name:'trap', bpm:[126,144], scales:['aeolian','harmonicMinor'], jazz:0.4,
    pad:'rhodes', lead:'bell', bass:'sub', kits:['tr808','sp1200','tr909'], patterns:'trap',
    swing:[0.50,0.55], density:0.90, ghost:0.15, lp:[2800,4200], chordBars:[2,2],
    reverb:0.45, delay:0.30, mix:{ d:0.62, b:0.42, m:0.95 },
    form:'sections', bassSteps:[0,6,10,14], leadOct:[5,6], motifLen:2, tapeStop:0.10, sweep:0.6,
  },
  {
    // даб-лофи: длинные дилэи, пустота, низ
    name:'dub', bpm:[60,74], scales:['aeolian','dorian'], jazz:0.4,
    pad:'organ', lead:'bell', bass:'sub', kits:['tr808','dusty','mpc60'], patterns:'sparse',
    swing:[0.52,0.58], density:0.50, ghost:0.06, lp:[2000,3000], chordBars:[2,4],
    reverb:0.95, delay:0.65, mix:{ d:0.34, b:0.40, m:1.05 },
    form:'ambient', bassSteps:[0,8], leadOct:[4,5], motifLen:2, tapeStop:0.06, sweep:0.9,
  },
  {
    // slowed + warped: всё растянуто, много тейп-стопа и реверба
    name:'vapor', bpm:[54,68], scales:['lydian','major','mixolydian'], jazz:0.7,
    pad:'rhodes', lead:'bell', bass:'elbass', kits:['linn','mpc60','brush'], patterns:'sparse',
    swing:[0.54,0.62], density:0.55, ghost:0.12, lp:[2200,3200], chordBars:[2,4],
    reverb:0.95, delay:0.45, mix:{ d:0.34, b:0.28, m:1.15 },
    form:'sections', bassSteps:[0,8], leadOct:[5,6], motifLen:4, tapeStop:0.35, sweep:0.9,
  },
  {
    // chiptune / пиксельный лофи: быстрее, ярче, но всё так же срезано лентой
    name:'chip', bpm:[88,108], scales:['major','lydian','mixolydian'], jazz:0.6,
    pad:'organ', lead:'pluck', bass:'elbass', kits:['dmx','linn','tr909'], patterns:'dusty',
    swing:[0.50,0.56], density:0.95, ghost:0.25, lp:[3800,5600], chordBars:[1,2],
    reverb:0.35, delay:0.35, mix:{ d:0.52, b:0.28, m:1.05 },
    form:'loop', bassSteps:[0,4,8,12], leadOct:[5,6], motifLen:4, tapeStop:0.15, sweep:0.5,
  },
  {
    // lo-fi гитара: нейлон, домашняя запись, много ленты
    name:'guitar', bpm:[70,84], scales:['dorian','aeolian','major'], jazz:0.6,
    pad:'nylon', lead:'nylon', bass:'upright', kits:['mpc60','dusty','brush'], patterns:'dusty',
    swing:[0.55,0.62], density:0.85, ghost:0.28, lp:[3000,4200], chordBars:[2,2],
    reverb:0.42, delay:0.24, mix:{ d:0.46, b:0.30, m:1.05 },
    form:'loop', bassSteps:[0,6,10], leadOct:[4,5], motifLen:2, tapeStop:0.12, sweep:0.5,
  },
  {
    // неоклассика: струнный ансамбль, длинный хвост, барабанов почти нет
    name:'strings', bpm:[56,70], scales:['aeolian','dorian','harmonicMinor'], jazz:0.5,
    pad:'strings', lead:'soft', bass:'upright', kits:['brush','linn'], patterns:'sparse',
    swing:[0.50,0.56], density:0.35, ghost:0.05, lp:[2200,3200], chordBars:[4,4],
    reverb:1.0, delay:0.35, mix:{ d:0.18, b:0.22, m:1.25 },
    form:'ambient', bassSteps:[0], leadOct:[5,6], motifLen:4, tapeStop:0.0, sweep:0.95,
  },
  {
    // lo-fi R&B с вокальным чапом
    name:'vocal', bpm:[74,90], scales:['aeolian','dorian'], jazz:0.5,
    pad:'voice', lead:'voice', bass:'elbass', kits:['tr808','mpc60','dusty'], patterns:'dusty',
    swing:[0.56,0.64], density:0.90, ghost:0.25, lp:[3000,4000], chordBars:[2,2],
    reverb:0.60, delay:0.30, mix:{ d:0.52, b:0.34, m:1.10 },
    form:'sections', bassSteps:[0,6,10], leadOct:[4,5], motifLen:2, tapeStop:0.14, sweep:0.6,
  },
  {
    // музыкальная шкатулка: калимба, очень мягко, для сна
    name:'musicbox', bpm:[62,76], scales:['major','lydian','aeolian'], jazz:0.7,
    pad:'soft', lead:'kalimba', bass:'upright', kits:['brush','linn'], patterns:'sparse',
    swing:[0.52,0.58], density:0.50, ghost:0.08, lp:[3200,4600], chordBars:[2,4],
    reverb:0.85, delay:0.40, mix:{ d:0.24, b:0.24, m:1.20 },
    form:'ambient', bassSteps:[0,8], leadOct:[5,6], motifLen:4, tapeStop:0.0, sweep:0.8,
  },
  {
    // bedroom pop: гитара + вокал, светлая инди-петля
    name:'bedroom', bpm:[80,96], scales:['major','mixolydian','dorian'], jazz:0.6,
    pad:'nylon', lead:'voice', bass:'elbass', kits:['dusty','mpc60','linn'], patterns:'dusty',
    swing:[0.54,0.60], density:0.90, ghost:0.22, lp:[3400,4800], chordBars:[1,2],
    reverb:0.50, delay:0.32, mix:{ d:0.52, b:0.30, m:1.05 },
    form:'loop', bassSteps:[0,4,8,12], leadOct:[4,6], motifLen:4, tapeStop:0.06, sweep:0.5,
  },
];

// ===== Фазы: что играет и насколько плотно =====
const PHASES = {
  introChords: { bars:4, drums:0.0,  bass:0.15, chords:1.0,  lead:0.10, pad:0.9, wet:1.0, lpMul:0.75 },
  introDrums:  { bars:4, drums:0.55, bass:0.35, chords:0.35, lead:0.05, pad:0.5, wet:0.6, lpMul:0.85 },
  introMotif:  { bars:4, drums:0.0,  bass:0.0,  chords:0.6,  lead:0.9,  pad:0.7, wet:0.9, lpMul:0.8 },
  introSweep:  { bars:4, drums:0.2,  bass:0.3,  chords:1.0,  lead:0.2,  pad:1.0, wet:1.1, lpMul:0.55 },
  verse:       { bars:8, drums:0.7,  bass:0.7,  chords:0.85, lead:0.35, pad:0.45, wet:0.6, lpMul:1.0 },
  drop:        { bars:8, drums:1.0,  bass:0.95, chords:0.9,  lead:0.7,  pad:0.55, wet:0.55, lpMul:1.05 },
  break:       { bars:4, drums:0.25, bass:0.4,  chords:1.0,  lead:0.5,  pad:0.9, wet:1.0, lpMul:0.85 },
  bridge:      { bars:4, drums:0.5,  bass:0.5,  chords:0.95, lead:0.6,  pad:0.85, wet:0.9, lpMul:0.9 },
  glitch:      { bars:2, drums:0.6,  bass:0.3,  chords:0.6,  lead:0.3,  pad:0.7, wet:1.0, lpMul:0.6 },
  outro:       { bars:4, drums:0.3,  bass:0.2,  chords:0.9,  lead:0.1,  pad:1.0, wet:1.2, lpMul:0.7 },
};

const FORMS = {
  loop:     ['introChords','verse','drop','verse','drop','break','drop','outro'],
  sections: ['introChords','verse','drop','verse','drop','bridge','drop','outro'],
  ambient:  ['introSweep','break','bridge','break','bridge','outro'],
  glitch:   ['introDrums','verse','glitch','drop','break','glitch','drop','outro'],
};

const TRACK_SEC = [110, 132];

// ===== Голос =====
class Voice {
  constructor() {
    this.active = false;
    this.freq = 220;
    this.phase = 0;
    this.env = 0;
    this.envStage = 0;
    this.envTime = 0;
    this.attack = 0.01;
    this.hold = 0.1;
    this.release = 0.2;
    this.peak = 0.2;
    this.age = 0;
    this.bus = 'pad';
    this.engine = VOICES.soft;
    this.detune = 0;
    this.tremPhase = 0;
    this.vibPhase = 0;
    this.vibCents = 0;
    this.lpState = 0;
    this.lpState2 = 0;
    this.filt = new SVF();
    this.filtMode = null;
    this.gl = 0.7071;
    this.gr = 0.7071;
  }
  trigger(o) {
    const eng = o.engine || VOICES.soft;
    this.active = true;
    this.freq = o.freq;
    this.peak = o.peak;
    this.bus = o.bus || 'pad';
    this.engine = eng;
    this.attack = o.attack !== undefined ? o.attack : eng.attack;
    this.hold = o.dur;
    this.release = o.release !== undefined ? o.release : eng.release;
    this.detune = o.detune || 0;
    this.phase = 0;
    this.age = 0;
    this.env = 0;
    this.envStage = 0;
    this.envTime = 0;
    this.tremPhase = RNG() * 6.28;
    this.vibPhase = RNG() * 6.28;
    // Зона спектра этого слоя (kick sub LP / snare noise BP / hats HP)
    this.filtMode = o.filt ? o.filt.mode : null;
    if (this.filtMode) this.filt.set(o.filt.fc, o.filt.q || 0.9, sampleRate);
    const pan = o.pan || 0;
    this.gl = Math.cos((pan + 1) * Math.PI / 4);
    this.gr = Math.sin((pan + 1) * Math.PI / 4);
  }
  process(sr) {
    if (!this.active) return 0;

    // Огибающая: attack → hold → release
    if (this.envStage === 0) {
      this.envTime += 1 / sr;
      if (this.envTime >= this.attack) { this.envStage = 1; this.envTime = 0; }
      else this.env = this.envTime / this.attack;
    } else if (this.envStage === 1) {
      this.envTime += 1 / sr;
      this.env = 1;
      if (this.envTime >= this.hold) { this.envStage = 2; this.envTime = 0; }
    } else if (this.envStage === 2) {
      this.envTime += 1 / sr;
      if (this.envTime >= this.release) { this.active = false; return 0; }
      this.env = 1 - (this.envTime / this.release);
    }
    this.age += 1 / sr;

    const eng = this.engine;
    // Дрейф ленты: у подложки он полный, у лида 55% — звонкая нота не должна
    // заметно «уплывать» от баса и бочки, у барабанов 30% (они сняты с ленты
    // сэмплом), у баса 15% — низ не должен «плавать» относительно бочки.
    const drift = this.bus === 'drum' ? PITCH_DRIFT_DRUM
      : this.bus === 'bass' ? PITCH_DRIFT_BASS
      : this.bus === 'lead' ? PITCH_DRIFT_LEAD
      : PITCH_DRIFT;
    // Вибрато (вокал, смычковые) — своё, поверх общего дрейфа
    if (eng.vib) {
      this.vibPhase += 2 * Math.PI * eng.vib / sr;
      if (this.vibPhase > 6.2832) this.vibPhase -= 6.2832;
      this.vibCents = eng.vibDepth * Math.sin(this.vibPhase);
    } else if (this.vibCents !== 0) this.vibCents = 0;
    const cents = this.detune + this.vibCents + drift;
    const f = this.freq * Math.pow(2, cents / 1200);
    this.phase += (2 * Math.PI * f) / sr;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;

    let out;
    if (eng.type === 'fm') {
      const idx = eng.index * Math.exp(-eng.modDecay * this.age);
      out = Math.sin(this.phase + idx * Math.sin(this.phase * eng.ratio));
    } else if (eng.type === 'saw') {
      const t = this.phase / (2 * Math.PI);
      let s = 2 * t - 1;
      s -= polyBlep(t, f / sr);
      out = s * 0.6;
    } else {
      const s1 = Math.sin(this.phase);
      out = s1;
      if (eng.h2) out += eng.h2 * Math.exp(-(eng.hDecay || 0) * this.age) * 2 * s1 * Math.cos(this.phase);
      if (eng.h3) out += eng.h3 * Math.exp(-(eng.hDecay || 0) * this.age) * s1 * (3 - 4 * s1 * s1);
      if (eng.h5) out += eng.h5 * Math.exp(-(eng.hDecay || 0) * this.age) * s1 * (16 * s1 * s1 * s1 * s1 - 20 * s1 * s1 + 5);
      // 7-я гармоника: аккорды играют в низком регистре (150-400 Гц), и до этой
      // правки выше 5-й гармоники энергии не было вообще — полоса 2-6 кГц стояла
      // пустой, пока мастер её вытягивал. Отсюда же «одеяло» у клавишных слоёв.
      if (eng.h7) {
        const s2 = s1 * s1;
        out += eng.h7 * Math.exp(-(eng.hDecay || 0) * this.age) *
          (64 * s1 * s2 * s2 * s2 - 112 * s1 * s2 * s2 + 56 * s1 * s2 - 7 * s1);
      }
    }

    // Тремоло электрического пиано
    if (eng.trem) {
      this.tremPhase += 2 * Math.PI * eng.trem / sr;
      out *= 1 - eng.tremDepth * (0.5 + 0.5 * Math.sin(this.tremPhase));
    }

    // Зона спектра слоя (2-полюсник) или ленточный срез голоса
    if (this.filtMode) {
      this.filt.process(out);
      out = this.filtMode === 'lp' ? this.filt.oLp : (this.filtMode === 'hp' ? this.filt.oHp : this.filt.oBp);
    } else if (eng.lp) {
      const a = 1 - Math.exp(-2 * Math.PI * eng.lp / sr);
      this.lpState += (out - this.lpState) * a;
      out = this.lpState;
      // Второй полюс: 12 дБ/окт вместо 6. Одного мало — у пилы (струнные,
      // синт-пэд), у FM (колокольчик, родес) и у голосов с 7-й гармоникой
      // верхние составляющие проходили выше среза ровно в 6–12 кГц. Замер:
      // там у ambient и струнных было на 4–5 дБ больше остальных слоёв — это
      // и есть верх, который бьёт по ушам. Срез сдвинут вниз по крутизне,
      // а не по частоте, поэтому тембр голосов сохранён.
      this.lpState2 += (out - this.lpState2) * a;
      out = this.lpState2;
    }

    return out * this.env * this.peak;
  }
}

// ===== Шумовой голос (барабаны) =====
class NoiseVoice {
  constructor() {
    this.active = false;
    this.env = 0;
    this.envStage = 0;
    this.envTime = 0;
    this.attack = 0.002;
    this.hold = 0.05;
    this.release = 0.05;
    this.peak = 0.2;
    this.filterState = 0;
    this.filterCoeff = 0.9;
    this.filt = new SVF();
    this.filt2 = new SVF();
    this.post = new SVF();
    this.post2 = new SVF();
    this.filtMode = null;
    this.filt2Mode = null;
    this.postFc = 0;
    this.gl = 0.7071;
    this.gr = 0.7071;
  }
  trigger(o) {
    this.active = true;
    this.env = 0;
    this.envStage = 0;
    this.envTime = 0;
    this.attack = o.attack;
    this.hold = o.dur;
    this.release = o.release;
    this.peak = o.peak;
    this.filterCoeff = clamp(o.bright, 0.05, 0.985);
    this.lp2 = o.bright2 !== undefined ? o.bright2 : 0;
    this.lp2State = 0;
    // Зона спектра: bp/hp/lp 2-полюсником (крэк снейра, верх хэта, шейкер)
    this.filtMode = o.filt ? o.filt.mode : null;
    if (this.filtMode) this.filt.set(o.filt.fc, o.filt.q || 0.9, sampleRate);
    this.filt2Mode = o.filt2 ? o.filt2.mode : null;
    if (this.filt2Mode) this.filt2.set(o.filt2.fc, o.filt2.q || 0.9, sampleRate);
    // Ленточный срез верха: у лофая выше этой границы барабанов нет
    this.postFc = o.postFc || DRUM_TOP;
    if (this.postFc) { this.post.set(this.postFc, 0.6, sampleRate); this.post2.set(this.postFc * 1.05, 0.6, sampleRate); }
    const pan = o.pan || 0;
    this.gl = Math.cos((pan + 1) * Math.PI / 4);
    this.gr = Math.sin((pan + 1) * Math.PI / 4);
  }
  process(sr) {
    if (!this.active) return 0;
    if (this.envStage === 0) {
      this.envTime += 1 / sr;
      if (this.envTime >= this.attack) { this.envStage = 1; this.envTime = 0; }
      else this.env = this.envTime / this.attack;
    } else if (this.envStage === 1) {
      this.envTime += 1 / sr;
      this.env = 1;
      if (this.envTime >= this.hold) { this.envStage = 2; this.envTime = 0; }
    } else if (this.envStage === 2) {
      this.envTime += 1 / sr;
      if (this.envTime >= this.release) { this.active = false; return 0; }
      this.env = 1 - (this.envTime / this.release);
    }
    let n = RNG() * 2 - 1;
    this.filterState += (n - this.filterState) * this.filterCoeff;
    n = this.filterState;
    if (this.lp2) {                       // второй полюс — мягче верх
      this.lp2State += (n - this.lp2State) * this.lp2;
      n = this.lp2State;
    }
    if (this.filtMode) {
      this.filt.process(n);
      n = this.filtMode === 'lp' ? this.filt.oLp : (this.filtMode === 'hp' ? this.filt.oHp : this.filt.oBp);
    }
    if (this.filt2Mode) {
      this.filt2.process(n);
      n = this.filt2Mode === 'lp' ? this.filt2.oLp : (this.filt2Mode === 'hp' ? this.filt2.oHp : this.filt2.oBp);
    }
    // ленточный срез верха
    if (this.postFc) { this.post.process(n); n = this.post.oLp; this.post2.process(n); n = this.post2.oLp; }
    return n * this.env * this.peak;
  }
}

// ===== Кик (питч-дроп) =====
class KickVoice {
  constructor() {
    this.active = false;
    this.env = 0;
    this.envStage = 0;
    this.envTime = 0;
    this.peak = 0.3;
    this.attack = 0.008;
    this.hold = 0.05;
    this.release = 0.4;
    this.phase = 0;
    this.tune = 50;
    this.drop = 2.2;
    this.shape = 20;   // скорость падения питча
    this.gl = 0.7071;
    this.gr = 0.7071;
  }
  trigger(o) {
    this.active = true;
    this.env = 0;
    this.envStage = 0;
    this.envTime = 0;
    this.peak = o.peak;
    this.tune = o.tune;
    this.drop = o.drop;
    this.hold = o.hold;
    this.release = o.release;
    this.attack = o.attack;
    this.shape = o.shape !== undefined ? o.shape : 20;
    this.phase = 0;
  }
  process(sr) {
    if (!this.active) return 0;
    if (this.envStage === 0) {
      this.envTime += 1 / sr;
      if (this.envTime >= this.attack) { this.envStage = 1; this.envTime = 0; }
      else this.env = this.envTime / this.attack;
    } else if (this.envStage === 1) {
      this.envTime += 1 / sr;
      this.env = 1;
      if (this.envTime >= this.hold) { this.envStage = 2; this.envTime = 0; }
    } else if (this.envStage === 2) {
      this.envTime += 1 / sr;
      if (this.envTime >= this.release) { this.active = false; return 0; }
      this.env = Math.exp(-5 * (this.envTime / this.release));
    }
    const freq = this.tune * (1 + (this.drop - 1) * Math.exp(-this.shape * this.envTime));
    this.phase += (2 * Math.PI * freq) / sr;
    if (this.phase > 2 * Math.PI) this.phase -= 2 * Math.PI;
    return Math.sin(this.phase) * this.env * this.peak;
  }
}

// ===== Процессор =====
class LofiProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.sr = sampleRate;
    this.isPlaying = false;
    this.step = 0;
    this.totalStep = 0;
    this.stepCounter = 0;
    this.pendingStep = 0;

    // Пул голосов
    this.voices = [];
    for (let i = 0; i < 96; i++) this.voices.push(new Voice());
    this.noiseVoices = [];
    for (let i = 0; i < 48; i++) this.noiseVoices.push(new NoiseVoice());
    this.kickVoices = [];
    for (let i = 0; i < 16; i++) this.kickVoices.push(new KickVoice());

    // Очередь отложенных ударов: микро-тайминг по линиям (кик/снейр тянут за сеткой)
    this.pend = [];
    for (let i = 0; i < 8; i++) this.pend.push({ active: false, t: 0, fn: null });
    this.laneOff = { kick: 0, snare: 0, hat: 0, perc: 0 };

    // Дакинг баса по кику
    this.bassDuck = 0;
    this.duckDecay = Math.exp(-1 / (this.sr * 0.12));

    // Wow/flutter
    this.wowPhase = 0;
    this.flutterPhase = 0;
    this.wowDepth = 3;

    // Тейп-стоп
    this.stopAmt = 0;
    this.stopStage = 0;

    // «Плёнка» на мелодик-шине
    this.tapeL = 0;
    this.tapeR = 0;
    this.tapeLfoPhase = 0;
    this.lpNow = 3500;

    // Дакинг-компрессор драм-шины
    this.drumEnv = 0;
    this.drumCompA = Math.exp(-1 / (this.sr * 0.020));
    this.drumCompR = Math.exp(-1 / (this.sr * 0.120));

    // 12-битный сэмплер (SP-1200 / MPC60): своя децимация у драм-шины
    // и своя, более мягкая, у клавиш — в реальной машине оцифровано всё.
    this.crushAcc = 0;
    this.crushL = 0;
    this.crushR = 0;
    this.crushAcc2 = 0;
    this.crushL2 = 0;
    this.crushR2 = 0;

    // Тембр драм-шины по киту: наклон низ/верх (одна полка + наклон)
    this.drumLpL = 0;
    this.drumLpR = 0;
    // Ленточный срез верха драм-шины (страховка: выше DRUM_TOP барабанов нет)
    this.topL = new SVF();
    this.topR = new SVF();
    this.topFc = 8500;

    // Реверб: пластинчатая схема (6 гребёнок + 3 всепропускающих на канал)
    // с предилэем и демпфированием в обратной связи. Даёт настоящий хвост
    // 0.6…3.5 с вместо прежнего короткого эха — иначе ambient/dark/piano пустые.
    const combTune = [1116, 1188, 1277, 1356, 1422, 1491];
    const apTune = [556, 441, 341];
    const spread = 23;                     // сдвиг правого канала = стерео хвоста
    this.comb = [];
    for (let i = 0; i < combTune.length; i++) {
      this.comb.push({
        l: new Float32Array(Math.round(combTune[i] * this.sr / 44100)),
        r: new Float32Array(Math.round((combTune[i] + spread) * this.sr / 44100)),
        iL: 0, iR: 0, fL: 0, fR: 0,
      });
    }
    this.ap = [];
    for (let i = 0; i < apTune.length; i++) {
      this.ap.push({
        l: new Float32Array(Math.round(apTune[i] * this.sr / 44100)),
        r: new Float32Array(Math.round((apTune[i] + spread) * this.sr / 44100)),
        iL: 0, iR: 0,
      });
    }
    this.preBufL = new Float32Array(Math.round(this.sr * 0.04));
    this.preBufR = new Float32Array(Math.round(this.sr * 0.04));
    this.preWrite = 0;
    this.preDelay = Math.round(this.sr * 0.02);
    this.revRoom = 0.84;      // размер «комнаты» → длина хвоста
    this.revDamp = 0.26;      // демпфирование хвоста
    this.revWet = 0.34;       // уровень влажного сигнала
    this.revSend = 1;

    // Дилэй
    this.delayBufferL = new Float32Array(this.sr * 1.5);
    this.delayBufferR = new Float32Array(this.sr * 1.5);
    this.delayWrite = 0;
    // Срез в обратной связи дилэя: без него каждый повтор приходит с полным
    // верхом, и на длинных хвостах копится именно та полоса 2–6 кГц, что звенит.
    this.delayLpL = 0;
    this.delayLpR = 0;

    // DC / HPF / лимитер
    this.dcL = 0; this.dcR = 0; this.dcPrevL = 0; this.dcPrevR = 0;
    this.hpCoeff = 1 - Math.exp(-2 * Math.PI * 30 / this.sr);
    this.hpL = 0; this.hpR = 0;

    // Кроссфейд перелистывания
    this.fade = 1;
    this.fadeStage = 0;

    // Служебное
    this.drumBright = 1;
    this.prevMood = null;
    this.passVar = { rootless:false, extend:0, invert:false };
    this.lastVoicing = null;
    this.motif = [];
    this.motifLen = 32;
    this.motifTranspose = 0;
    this.pendingMotif = false;
    // Модуляция (уход в бридже) и интервал гармонии лида
    this.keyShift = 0;
    this.modulate = false;
    this.modInterval = 5;
    this.leadHarmSteps = 2;

    // Номер трека и зерно сессии: по ним страница детерминированно рисует
    // название и обложку — у каждой композиции своя картинка.
    this.trackNo = 0;
    this.seed = (Math.random() * 0xffffffff) >>> 0;
    // Зерно, пришедшее снаружи (ссылка ?t= или синхронное окно)
    this.pendingSeed = null;
    // Стартовые параметры можно отдать конструктором. В OfflineAudioContext
    // сообщение через port приходит уже после рендера, и трек выходит тихим:
    // processorOptions доступны до первого process(), поэтому офлайн идёт так.
    const init = (options && options.processorOptions) || {};
    this.startOnLoad = false;
    this.oneShot = false;
    // Слой, заданный снаружи: страница станции просит играть только его
    this.forcedMood = typeof init.mood === 'string' ? init.mood : null;
    if (typeof init.seed === 'number') {
      this.pendingSeed = init.seed >>> 0;
      this.startOnLoad = init.autoStart === true;
      this.oneShot = init.oneShot === true;
    }

    this.mkSession();

    this.port.onmessage = (e) => {
      const t = e.data.type;
      if (t === 'start') {
        // Слой можно задать на ходу: страница станции держит свой жанр
        if (typeof e.data.mood === 'string') this.forcedMood = e.data.mood;
        // Зерно снаружи: играем ровно тот трек, что в ссылке ?t= или в общем окне
        if (typeof e.data.seed === 'number') {
          this.pendingSeed = e.data.seed >>> 0;
          this.restartTrack();
        }
        this.isPlaying = true;
        this.stepCounter = 0;
        this.step = 0;
        this.totalStep = 0;
        this.pendingStep = 0;
      } else if (t === 'seed') {
        // Переключение на конкретное зерно на ходу
        this.pendingSeed = e.data.seed >>> 0;
        this.restartTrack();
      } else if (t === 'stop') {
        this.isPlaying = false;
        for (const v of this.voices) v.active = false;
        for (const v of this.noiseVoices) v.active = false;
        for (const v of this.kickVoices) v.active = false;
      } else if (t === 'next') {
        if (this.isPlaying) this.fadeStage = 1;
        else this.restartTrack();
      }
    };

    // Офлайн-рендер: играем сразу, не дожидаясь сообщения через порт
    if (this.startOnLoad) {
      this.isPlaying = true;
      this.step = 0;
      this.totalStep = 0;
      this.stepCounter = 0;
      this.pendingStep = 0;
    }
  }

  // ---------- Сессия (трек) ----------
  mkSession() {
    // Зерно задаёт трек целиком. Если оно пришло снаружи (ссылка ?t= или
    // синхронное окно), трек воспроизводится тем же — вплоть до микро-деталей
    // исполнения: иначе ссылка и скачанный файл расходились бы с эфиром.
    const pinned = this.pendingSeed !== null;
    const seed = pinned ? (this.pendingSeed >>> 0)
      : ((Math.random() * 0xffffffff) >>> 0);
    this.pendingSeed = null;
    this.seed = seed;
    this.trackNo++;
    RNG = mulberry32(seed ^ 0x9e3779b9);

    // жанровый слой: не повторяем предыдущий. При внешнем зерне правило
    // выключаем — иначе слой зависел бы от предыдущего трека и ссылка
    // перестала бы воспроизводить то же самое. Если слой задан снаружи
    // (страница станции, ?m=<слой>), всегда играем только его.
    let mood = this.forcedMood
      ? (MOODS.find((m) => m.name === this.forcedMood) || pick(MOODS))
      : pick(MOODS);
    if (!this.forcedMood && !pinned && MOODS.length > 1 && this.prevMood) {
      let guard = 0;
      while (mood.name === this.prevMood && guard++ < 12) mood = pick(MOODS);
    }
    this.mood = mood;
    this.prevMood = mood.name;

    this.bpm = Math.round(rnd(mood.bpm[0], mood.bpm[1]));
    this.scaleName = pick(mood.scales);
    this.scale = SCALES[this.scaleName];
    const rootName = pick(NOTE_NAMES);
    this.keyName = rootName;
    this.keyFreq = noteFreq(rootName, 4);

    // гармоническая палитра: джазовые слои тянут ii-V-I, модальные — минорные петли,
    // квартальные «странности» — только в экспериментальных и ambient слоях
    const jazzPool = PROGRESSIONS.filter(p => p.jazz === 1);
    const modalPool = PROGRESSIONS.filter(p => p.jazz === 0);
    const quirky = mood.name === 'experimental' || mood.name === 'ambient';
    let pool = mood.jazz >= 0.7 ? jazzPool : (mood.jazz <= 0.45 ? modalPool : PROGRESSIONS);
    if (!quirky) pool = pool.filter(p => !p.weird);
    this.progression = pick(pool);
    this.chordBars = Math.round(rnd(mood.chordBars[0], mood.chordBars[1]));

    // инструменты
    this.enginePad = VOICES[mood.pad] || VOICES.soft;
    this.engineLead = VOICES[mood.lead] || VOICES.keys;
    this.engineBass = VOICES[mood.bass] || VOICES.sub;
    this.kitName = pick(mood.kits);
    this.kit = KITS[this.kitName] || KITS.dusty;
    this.patternSet = PATTERNS[mood.patterns] || PATTERNS.dusty;
    this.pattern = pick(this.patternSet);

    this.swing = rnd(mood.swing[0], mood.swing[1]);
    this.density = mood.density * rnd(0.92, 1.08);
    // «Плёнка» мелодик-шины: по жанру клавиши/пэды режут на 8-10 кГц,
    // поэтому берём характер слоя и поднимаем срез в эту зону (1-полюсник, мягко).
    // Коэффициент был 2.2 (поднимали, когда мастер тянул 2-6 кГц): теперь верх
    // у голосов срезан у самого источника, и шина снова чуть темнее.
    this.lpBase = rnd(mood.lp[0], mood.lp[1]) * 1.9;
    this.kitLpF = rnd(this.kit.tilt[0], this.kit.tilt[1]);
    // Полка тембра кита: у ярких китов она больше 1, то есть поднимает верх
    // (до +3 дБ у насыщенных машин). Замер показал, что этого много: вместе
    // с кликом и хвостом железа она и делала драм-шину резкой, поэтому подъём
    // оставляем вполовину — характер кита слышен, резкость ушла.
    this.kitHi = 1 + (rnd(this.kit.hi[0], this.kit.hi[1]) - 1) * 0.5;
    // Верх барабанов всегда срезан (лента): тёмные киты — ниже граница среза
    this.topFc = clamp(2400 + (this.kit.tilt[1] - 1400) * 1.0 + (this.kit.hi[1] - 1) * 1600, 5200, 8000) * rnd(0.94, 1.06);
    DRUM_TOP = this.topFc;
    this.wowDepth = rnd(2.2, 4.6);
    this.drumBright = rnd(0.82, 1.12);
    this.crush = this.kit.crush;

    // Реверб под характер слоя: сухие слои — короткий тёмный хвост,
    // ambient/dark — длинный и светлый. Предилэй тоже свой у каждого трека.
    this.revRoom = clamp(0.74 + mood.reverb * 0.18, 0.70, 0.945);
    // Демпфирование хвоста: чем выше, тем темнее. Светлые хвосты (низкий
    // коэффициент) у ambient/dark делали общий спектр ярче сухого микса —
    // на замере наклон у ambient уходил в плюс. Держим хвост тёмным всегда.
    this.revDamp = clamp(0.44 - mood.reverb * 0.10, 0.26, 0.46);
    this.revWet = 0.16 + mood.reverb * 0.34;
    this.preDelay = Math.round(this.sr * rnd(0.010, 0.038));

    // Модуляция: уход в бридже на кварту/терцию — не в каждом треке
    this.modulate = chance(0.55);
    this.modInterval = pick([5, 7, -5, 3, -4, 8]);
    this.keyShift = 0;
    // Гармония лида: терция или секста вверх, диатонически к ладу
    this.leadHarmSteps = chance(0.5) ? 2 : 5;
    this.form = FORMS[mood.form] || FORMS.loop;

    // интро-вариант: начало не должно быть одинаковым у всех треков
    const introVariants = mood.form === 'ambient' ? ['introSweep','introMotif']
      : mood.form === 'glitch' ? ['introDrums','introSweep']
      : ['introChords','introDrums','introMotif','introSweep'];
    this.introPhase = pick(introVariants);
    this.phaseList = this.buildPhases();

    // Микро-тайминг линий: кик и снейр тянут за сеткой (5-30 мс), железо почти ровно.
    // Это и есть «пьяный» грув Dilla — у бочки, снейра и хэта своё время.
    const ms = this.sr / 1000;
    const drag = rnd(4, 26);
    this.laneOff = {
      kick: Math.round(drag * rnd(0.6, 1.3) * ms),
      snare: Math.round(drag * rnd(0.9, 1.8) * ms),
      hat: Math.round(rnd(-6, 4) * ms),
      perc: Math.round(rnd(-4, 18) * ms),
    };

    this.chordIdx = 0;
    this.barInPhase = 0;
    this.totalBar = 0;
    this.phaseIndex = 0;
    this.bassDuck = 0;
    this.lastVoicing = null;
    this.motifTranspose = 0;
    this.makeMotif();
    this.rollPassVar();
    RNG = mulberry32(seed ^ 0x85ebca6b);   // и весь трек, до последней ноты
    this.sendStatus();
  }

  restartTrack() {
    for (const v of this.voices) v.active = false;
    for (const v of this.noiseVoices) v.active = false;
    for (const v of this.kickVoices) v.active = false;
    this.mkSession();
    this.step = 0;
    this.totalStep = 0;
    this.stepCounter = 0;
    this.pendingStep = 0;
  }

  // Фазы под ~2 минуты в текущем темпе
  buildPhases() {
    const barSec = 240 / this.bpm;
    let budget = Math.max(14, Math.round(rnd(TRACK_SEC[0], TRACK_SEC[1]) / barSec));
    const body = this.form.filter(p => !p.startsWith('intro') && p !== 'outro');
    const list = [this.introPhase];
    budget -= PHASES[this.introPhase].bars;
    let i = 0;
    while (budget > PHASES.outro.bars + 2) {
      const ph = body[i % body.length];
      const len = PHASES[ph].bars;
      if (len > budget - PHASES.outro.bars) break;
      list.push(ph);
      budget -= len;
      i++;
    }
    const rest = budget - PHASES.outro.bars;
    if (rest >= 4) list.push('break');
    else if (rest >= 2) list.push('glitch');
    list.push('outro');
    return list;
  }

  // Мотив: короткая фраза из ступеней лада, повторяется с вариациями
  makeMotif() {
    const len = this.mood.motifLen * 16;
    const notes = [];
    let pos = Math.floor(rnd(0, 3));
    while (pos < len - 2) {
      const deg = 1 + Math.floor(RNG() * 7);
      notes.push({ step: pos, semi: this.semiOf(deg, 0) });
      pos += pick([3, 4, 4, 6, 6, 8]);
    }
    this.motif = notes;
    this.motifLen = len;
  }

  // Вариация аккорда на проход формы
  rollPassVar() {
    this.passVar = {
      rootless: chance(0.55),
      extend: chance(0.35) ? pick([14, 17]) : 0,
      invert: chance(0.3),
    };
    this.pendingMotif = chance(0.4);
  }

  // Полутон ступени лада (1..7), с альтерацией
  semiOf(degree, alt) {
    const d = degree - 1;
    const oct = Math.floor(d / 7);
    const idx = ((d % 7) + 7) % 7;
    return this.scale[idx] + 12 * oct + (alt || 0);
  }

  // Транспозиция всей гармонии: keyShift != 0 в бридже, если трек модулирует.
  // Через freqOf проходят и барабаны (drumTune), поэтому строй уезжает вместе.
  freqOf(semi, baseOct) {
    return this.keyFreq * Math.pow(2, (semi + this.keyShift + 12 * (baseOct - 4)) / 12);
  }

  // Диатонический интервал вверх от полутона мотива: ищем ступень лада
  // и отсчитываем steps ступеней — так терция/секста всегда в ладу.
  diatonicAbove(semi, steps) {
    const l = this.scale.length;
    for (let oct = -2; oct <= 2; oct++) {
      for (let d = 0; d < l; d++) {
        if (this.scale[d] + 12 * oct !== semi) continue;
        const up = d + steps;
        return this.scale[up % l] + 12 * (oct + Math.floor(up / l));
      }
    }
    return semi + (steps >= 4 ? 9 : 3);
  }

  phaseDef() { return PHASES[this.phaseList[this.phaseIndex]] || PHASES.verse; }

  sendStatus() {
    let bars = 0;
    for (const ph of this.phaseList) bars += (PHASES[ph] || PHASES.verse).bars;
    const dur = Math.round(bars * 240 / this.bpm);
    this.port.postMessage({
      type: 'status',
      seed: this.seed,
      trackNo: this.trackNo,
      mood: this.mood.name,
      kit: this.kitName,
      voices: this.mood.pad + '/' + this.mood.lead + '/' + this.mood.bass,
      pattern: this.pattern.name,
      form: this.mood.form,
      bpm: this.bpm,
      key: this.keyName,
      scale: this.scaleName,
      phase: this.phaseList[this.phaseIndex],
      bar: this.totalBar + 1,
      bars,
      dur,
      progression: this.progression.name,
      chord: this.progression.chords[this.chordIdx][0],
    });
  }

  // ---------- Голоса ----------
  getVoice(pool) {
    let quietest = pool[0];
    let min = Infinity;
    for (const v of pool) {
      if (!v.active) return v;
      const level = v.env * v.peak;
      if (level < min) { min = level; quietest = v; }
    }
    return quietest;
  }

  note(engine, freq, dur, peak, bus, pan, relOverride, filt) {
    const v = this.getVoice(this.voices);
    if (!v) return;
    v.trigger({
      freq, dur, peak, bus, pan, engine, filt,
      // Разброс был ±3.5 цента: на длинных звонких нотах это уже слышно
      // как расстроенность, а не как «живая» игра. Оставляем разумный минимум.
      detune: (RNG() - 0.5) * 3.2,
      release: relOverride || (bus === 'pad' ? engine.release : Math.max(engine.release, dur * 1.4)),
    });
  }

  // ---------- Барабаны ----------
  // Микро-тайминг по линиям (фишка Dilla): кик и снейр тянут за сеткой,
  // железо идёт почти ровно — так удар «плывёт», а не стоит по клетке.
  hitLane(lane, fn) {
    const off = this.laneOff[lane];
    if (off <= 0) { fn(); return; }
    for (const p of this.pend) {
      if (!p.active) { p.active = true; p.t = off; p.fn = fn; return; }
    }
    fn();
  }

  // Тон барабана = тон текущего аккорда, приведённый в нужный диапазон
  drumTune(semis, lo, hi) {
    const chord = this.progression.chords[this.chordIdx];
    const rootSemi = this.semiOf(chord[1], chord[2] || 0);
    const f0 = this.freqOf(rootSemi + semis, 4);
    // Любая октава корня гармонична, поэтому сдвигаем в рабочий диапазон слоя
    // целиком: попадание в диапазон важнее всего, внутри него — ближе к центру.
    // «Зажимать» в границы нельзя — это ломает строй (кик уезжает с тона аккорда).
    const center = Math.sqrt(lo * hi);
    let best = f0, bestErr = Infinity;
    for (let k = -6; k <= 6; k++) {
      const c = f0 * Math.pow(2, k);
      const err = c < lo ? Math.log(lo / c)
        : c > hi ? Math.log(c / hi)
        : Math.abs(Math.log(c / center)) * 0.25;
      if (err < bestErr) { bestErr = err; best = c; }
    }
    return best;
  }

  // Второй тон снейра: интервал берём из текущего аккорда, а не «магическое» 1.83.
  // 1.83 — это 1046 центов, ровно между малым и большим септаккордом: мимо
  // тональности, и ухо слышит в снейре металлическую ноту. Ближайший тон аккорда
  // оставляет кит в своём характере (1.5 квинта, 1.78 малая септима, 2.0 октава),
  // но снейр перестаёт «звенеть не в ту сторону».
  snareTone2(s) {
    const ivs = CHORDS[this.progression.chords[this.chordIdx][0]] || CHORDS.m7;
    let best = 2, bestErr = Infinity;
    for (const iv of ivs) {
      for (let oct = 0; oct < 2; oct++) {
        const r = Math.pow(2, (iv + oct * 12) / 12);
        if (r < 1.25 || r > 3.2) continue;
        const err = Math.abs(r - s.tone2);
        if (err < bestErr) { bestErr = err; best = r; }
      }
    }
    return best;
  }

  // Кик: суб (фундамент 40-65 Гц) + тело (питч-дроп в 80-130) + клик битера (3-5 кГц)
  kickHit(peak) {
    const k = this.kit.kick;
    const root = this.drumTune(0, k.subTune[0], k.subTune[1]);
    this.note(VOICES.sub, root, 0.02, peak * k.subAmp * rnd(0.95, 1.05), 'drum', 0,
      rnd(k.subDec[0], k.subDec[1]), { mode: 'lp', fc: 140, q: 0.8 });
    const bv = this.getVoice(this.kickVoices);
    if (bv) bv.trigger({
      peak: peak * k.bodyAmp * rnd(0.92, 1.05),
      tune: root * 2 * rnd(0.995, 1.005),
      drop: rnd(k.bodyDrop[0], k.bodyDrop[1]),
      hold: 0.012,
      release: rnd(k.bodyDec[0], k.bodyDec[1]),
      attack: 0.003,
      shape: rnd(k.bodyShape[0], k.bodyShape[1]),
    });
    const c = this.getVoice(this.noiseVoices);
    if (c) c.trigger({
      dur: rnd(k.clickDec[0], k.clickDec[1]),
      peak: peak * rnd(k.clickAmp[0], k.clickAmp[1]),
      attack: 0.0012, release: 0.02, bright: 0.5, pan: 0,
      filt: { mode: 'bp', fc: rnd(k.clickFc[0], k.clickFc[1]), q: 0.9 },
    });
    this.bassDuck = 1;
  }

  // Том в тоне аккорда — для филлов
  tomHit(peak, pan) {
    const f = this.drumTune(pick([0, 0, 7]), 110, 240);
    const v = this.getVoice(this.kickVoices);
    if (v) v.trigger({
      peak: peak * rnd(0.85, 1.05),
      tune: f * rnd(0.995, 1.005),
      drop: rnd(1.3, 1.8), hold: rnd(0.02, 0.04),
      release: rnd(0.16, 0.30), attack: 0.004, shape: rnd(16, 26),
    });
    this.bassDuck = Math.max(this.bassDuck, 0.35);
  }

  // Римшот: тон в зоне снейра + полосовой щелчок
  rimHit(peak) {
    const v = this.getVoice(this.kickVoices);
    if (v) v.trigger({
      peak: peak * rnd(0.5, 0.65), tune: this.drumTune(0, 220, 320),
      drop: rnd(1.3, 1.7), hold: 0.006, release: rnd(0.03, 0.06), attack: 0.001, shape: 30,
    });
    const n = this.getVoice(this.noiseVoices);
    if (n) n.trigger({
      dur: rnd(0.005, 0.012), peak: peak * rnd(0.4, 0.6), attack: 0.001, release: 0.02,
      bright: 0.9, pan: rnd(-0.25, 0.25),
      filt: { mode: 'bp', fc: rnd(2600, 3600), q: 1.0 },
    });
  }

  // Вудблок: узкий тон в тоне аккорда
  woodHit(peak) {
    const v = this.getVoice(this.kickVoices);
    if (v) v.trigger({
      peak: peak * rnd(0.6, 0.8), tune: this.drumTune(0, 700, 1200),
      drop: rnd(1.02, 1.12), hold: 0.004, release: rnd(0.02, 0.05), attack: 0.001, shape: 40,
    });
  }

  // Райд без металла: мягкий шумовой «хвост» + отдельный удар палочки.
  // Никаких несоизмеримых пиков — только две шумовые полосы, поэтому
  // ни звона, ни тональной высоты у райда нет.
  rideHit(peak) {
    const pan = rnd(-0.3, 0.3);
    const n = this.getVoice(this.noiseVoices);
    if (n) n.trigger({
      dur: rnd(0.04, 0.10), peak: peak * rnd(0.85, 1.35), attack: rnd(0.004, 0.012),
      release: rnd(0.30, 0.65), bright: 0.82, pan,
      filt: { mode: 'bp', fc: rnd(5600, 7800), q: 0.5 },
      postFc: this.topFc,
    });
    const a = this.getVoice(this.noiseVoices);
    if (a) a.trigger({
      dur: rnd(0.004, 0.010), peak: peak * rnd(0.30, 0.55), attack: rnd(0.0012, 0.0032),
      release: rnd(0.03, 0.06), bright: 0.85, pan,
      filt: { mode: 'hp', fc: rnd(4800, 6800) },
      postFc: this.topFc,
    });
  }

  // Шейкер: узкий верхний шум в ленточной полосе (без цифрового сиза)
  shakerHit() {
    const n = this.getVoice(this.noiseVoices);
    if (n) n.trigger({
      dur: rnd(0.02, 0.05), peak: rnd(0.03, 0.055), attack: rnd(0.008, 0.02),
      release: 0.05, bright: 0.9, pan: rnd(-0.5, 0.5),
      filt: { mode: 'hp', fc: rnd(2800, 4200), q: 0.7 },
      postFc: this.topFc * 0.85,
    });
  }

  // Хлопок: несколько всплесков (архитектура 808/909)
  clapHit(peak, pan, fc, cnt) {
    const n = cnt || 3;
    for (let i = 0; i < n; i++) {
      const v = this.getVoice(this.noiseVoices);
      if (v) v.trigger({
        dur: rnd(0.02, 0.035),
        peak: peak * (0.85 - i * 0.16) * rnd(0.9, 1.1),
        attack: 0.002 + i * 0.006,
        release: 0.03, bright: 0.6, pan,
        filt: { mode: 'bp', fc: fc || 1500, q: 0.9 },
      });
    }
  }

  // Снейр: два тона (тело 130-185 Гц) + полосовой шум (крэк 1.5-4.5 кГц)
  snareHit(peak, ghost) {
    const s = this.kit.snare;
    const pan = rnd(-0.15, 0.15);
    const amp = peak * rnd(0.9, 1.05);
    if (!ghost) {
      const f1 = this.drumTune(0, s.toneTune[0], s.toneTune[1]);
      this.note(VOICES.snareTone, f1, 0.01, amp * s.toneAmp, 'drum', pan,
        rnd(s.toneDec[0], s.toneDec[1]), { mode: 'lp', fc: 900, q: 0.7 });
      this.note(VOICES.snareTone, f1 * this.snareTone2(s) * rnd(0.998, 1.002), 0.01, amp * s.toneAmp * 0.7, 'drum', pan,
        rnd(s.toneDec[0], s.toneDec[1]) * 0.8, { mode: 'lp', fc: 1400, q: 0.7 });
    }
    const nv = this.getVoice(this.noiseVoices);
    if (nv) nv.trigger({
      dur: s.brush ? rnd(0.05, 0.09) : rnd(0.03, 0.06),
      peak: amp * s.nAmp * (ghost ? 0.35 : 1),
      attack: s.brush ? rnd(0.012, 0.025) : 0.002,
      release: rnd(s.nDec[0], s.nDec[1]),
      bright: 0.6, pan,
      filt: { mode: 'bp', fc: rnd(s.nFc[0], s.nFc[1]), q: s.nQ },
      filt2: { mode: 'hp', fc: 200, q: 0.7 },   // в низ не лезет — не маскирует кик
    });
    if (s.clapLayer && !ghost) this.clapHit(peak * rnd(s.clapLayer[0], s.clapLayer[1]), pan, rnd(1400, 2000), 4);
    if (s.brush && !ghost) {   // щётка: «шорох» узким верхом
      const br = this.getVoice(this.noiseVoices);
      if (br) br.trigger({
        dur: rnd(0.02, 0.05), peak: amp * 0.2, attack: 0.02, release: 0.25,
        bright: 0.8, pan, filt: { mode: 'hp', fc: 3000, q: 0.6 },
      });
    }
  }

  // Хэт без металла: два шумовых слоя вместо кластера.
  //   тело — широкая полоса кита, задаёт «шшш»;
  //   край — короткий верхний всплеск, по которому удар читается.
  // Полосы, Q, длина и акцент берутся из кита, плюс разброс на каждый удар,
  // поэтому хэты разные и внутри кита, и между китами. Никаких комбов —
  // значит нет ни звона, ни тональной высоты.
  hatHit(step) {
    const h = this.kit.hat;
    const open = step === 14 && chance(0.35);
    const accent = step % 4 === 0 ? 1.0 : 0.72;
    const pan = rnd(-0.45, 0.45);
    const dec = open ? rnd(h.openDec[0], h.openDec[1]) : rnd(h.dec[0], h.dec[1]);
    const bright = 0.95 + 0.1 * this.drumBright;
    // Шумовая полоса шире металлического комба, поэтому железо режем жёстче
    // общего верха. С 8.8 к границу опустили на 7.4 к: замер показал, что
    // «бьющий» верх у хэта живёт как раз в 6–8 кГц, а выше у лоу-фая ничего
    // полезного нет — только сиз.
    const top = Math.min(this.topFc, 7400);
    const body = this.getVoice(this.noiseVoices);
    if (body) body.trigger({
      dur: rnd(0.005, 0.016), peak: h.peak * rnd(1.8, 2.5) * accent,
      attack: rnd(0.0016, 0.0042),            // мягкий фронт: у лофая железо не щёлкает
      release: dec, bright: 0.80, pan,
      filt: { mode: 'bp', fc: rnd(h.bp[0], h.bp[1]) * 0.82 * bright, q: h.bpQ * 0.62 },
      postFc: top,
    });
    const edge = this.getVoice(this.noiseVoices);
    if (edge) edge.trigger({
      dur: rnd(0.002, 0.006), peak: h.peak * rnd(0.35, 0.7) * accent,
      attack: rnd(0.0012, 0.0032),
      release: Math.min(dec, rnd(0.02, 0.05)), bright: 0.88, pan,
      filt: { mode: 'hp', fc: rnd(h.hp[0], h.hp[1]) * 0.95 },
      postFc: top,
    });
  }

  // ---------- Гармония ----------
  playChord(peak) {
    const chord = this.progression.chords[this.chordIdx];
    const quality = chord[0];
    const rootSemi = this.semiOf(chord[1], chord[2] || 0);
    let ivs = (CHORDS[quality] || CHORDS.m7).slice();
    const pv = this.passVar;
    if (pv.rootless && ivs.length > 3) ivs = ivs.slice(1);      // без корня — его держит бас
    if (pv.invert && ivs.length > 2) ivs = ivs.slice(1).concat([ivs[0] + 12]);
    if (pv.extend) ivs = ivs.concat([pv.extend]);               // 9-я или 11-я

    // закрытая позиция + голосоведение по ближайшему тону
    const voiced = [];
    const prev = this.lastVoicing;
    for (let i = 0; i < ivs.length; i++) {
      let s = ivs[i];
      while (s > 18) s -= 12;
      if (prev && i < prev.length) {
        while (s - prev[i] > 6) s -= 12;
        while (prev[i] - s > 6) s += 12;
      }
      voiced.push(s);
    }
    this.lastVoicing = voiced;

    const barDur = 240 / this.bpm;
    const dur = barDur * this.chordBars * 0.95;
    const spread = voiced.length > 1 ? voiced.length - 1 : 1;
    for (let i = 0; i < voiced.length; i++) {
      const semi = rootSemi + voiced[i];
      const freq = this.freqOf(semi, 3);
      const pan = (i / spread - 0.5) * 0.85;
      const amp = peak * this.mood.mix.m / voiced.length;
      this.note(this.enginePad, freq, dur, amp, 'pad', pan);
      // пила-пэд (струнные/синт) играет в два голоса с расстройкой:
      // без сдвига это просто +3 дБ, а не хор — поэтому второй голос уводим
      if (this.enginePad.type === 'saw') {
        this.note(this.enginePad, freq * 1.0032, dur, amp * 0.7, 'pad', pan * 0.7);
      }
    }
  }

  playBass(step, phase) {
    const chord = this.progression.chords[this.chordIdx];
    const rootSemi = this.semiOf(chord[1], chord[2] || 0);
    const steps = this.mood.bassSteps;
    const idx = steps.indexOf(step);
    if (idx < 0) return;
    const last = idx === steps.length - 1;
    let semi = rootSemi;
    if (idx === 1 && chance(0.45)) semi += 7;                       // пятая
    else if (idx >= 2 && chance(0.4)) semi += 12;                    // октава
    if (last && chance(0.5)) {
      const next = this.progression.chords[(this.chordIdx + 1) % this.progression.chords.length];
      semi = this.semiOf(next[1], next[2] || 0) - 1;                 // подход к следующему аккорду
    }
    const stepDur = 60 / this.bpm / 4;
    const freq = this.freqOf(semi, 1);
    const dur = stepDur * (last ? 1.6 : 2.4);
    const amp = 0.2 * phase.bass * this.mood.mix.b / 0.3;
    this.note(this.engineBass, freq, dur, amp, 'bass', 0);
    if (this.mood.bass === 'sub' || this.mood.bass === 'upright') {
      this.note(this.engineBass, freq / 2, dur, amp * 0.35, 'bass', 0);
    }
  }

  playLead(step, phase) {
    if (!this.motif.length) return;
    const pos = this.totalStep % this.motifLen;
    const oct = pick(this.mood.leadOct);
    for (const n of this.motif) {
      if (n.step !== pos) continue;
      if (!chance(0.15 + phase.lead * 0.85)) continue;
      const semi = n.semi + this.motifTranspose;
      const freq = this.freqOf(semi, oct);
      const stepDur = 60 / this.bpm / 4;
      const dur = stepDur * rnd(1.4, 3.2);
      const pan = rnd(-0.3, 0.3);
      const amp = 0.14 * phase.lead * this.mood.mix.m / 1.0;
      this.note(this.engineLead, freq, dur, amp, 'lead', pan);
      if (this.engineLead === VOICES.keys || this.engineLead === VOICES.rhodes) {
        this.note(this.engineLead, freq * 2, dur * 0.7, amp * 0.22, 'lead', pan * 0.6);
      }
      // Гармония: терция/секста вверх по ладу — лид перестаёт быть одноголосным.
      // В плотных фазах чаще, в разреженных почти нет.
      if (chance(0.18 + phase.lead * 0.42)) {
        const hSemi = this.diatonicAbove(semi, this.leadHarmSteps);
        const hFreq = this.freqOf(hSemi, oct);
        this.note(this.engineLead, hFreq, dur * 0.85, amp * 0.52, 'lead', -pan * 0.8);
      }
    }
  }

  // ---------- Секвенсор ----------
  onStep() {
    const phase = this.phaseDef();
    const step = this.step;
    const dr = phase.drums * this.density;

    // барабаны: каждая линия со своим микро-сдвигом за сеткой
    if (dr > 0 && this.stopAmt < 0.5) {
      const p = this.pattern;
      if (p.kick[step] && chance(dr + 0.08)) {
        const amp = 0.34 * (step === 0 ? 1 : 0.86);
        this.hitLane('kick', () => this.kickHit(amp));
      }
      if (p.snare[step] && chance(dr)) {
        const amp = 0.2 * (step % 8 === 4 ? 1 : 0.9);
        this.hitLane('snare', () => this.snareHit(amp, false));
      }
      if (p.hat[step] && chance(dr + 0.1)) this.hitLane('hat', () => this.hatHit(step));
      if (chance(this.mood.ghost * dr * 0.5)) {
        const amp = rnd(0.05, 0.09);
        this.hitLane('snare', () => this.snareHit(amp, true));
      }

      // перкуссия конкретного кита
      const perc = this.kit.perc;
      if (perc === 'shaker' && step % 4 === 2 && chance(0.55 * dr + 0.15)) this.hitLane('perc', () => this.shakerHit());
      else if (perc === 'ride' && step % 4 === 0 && chance(0.7 * dr)) this.hitLane('perc', () => this.rideHit(0.055));
      else if (perc === 'rim' && (step === 7 || step === 15) && chance(0.45 * dr)) this.hitLane('perc', () => this.rimHit(0.13));
      else if (perc === 'wood' && (step === 3 || step === 11) && chance(0.4 * dr)) this.hitLane('perc', () => this.woodHit(0.11));

      // филл в конце 4-тактовой фразы: снейр или том (том в тоне аккорда)
      if (this.barInPhase % 4 === 3 && step >= 12 && chance((step === 14 ? 0.8 : 0.4) * dr)) {
        if (chance(0.35)) {
          const pan = rnd(-0.35, 0.35);
          this.hitLane('perc', () => this.tomHit(0.15, pan));
        } else {
          const amp = step === 14 ? 0.18 : 0.12;
          this.hitLane('snare', () => this.snareHit(amp, false));
        }
      }
      // редкий сдвоенный удар хэта
      if (step === 13 && chance(0.12 * dr)) this.hitLane('hat', () => this.hatHit(11));
    }

    // бас
    if (phase.bass > 0 && this.stopAmt < 0.4) this.playBass(step, phase);

    // мелодия
    if (phase.lead > 0) this.playLead(step, phase);

    // аккорды: смена по гармоническому ритму
    if (step === 0 && this.barInPhase % this.chordBars === 0 && phase.chords > 0) {
      this.playChord(0.14 * phase.chords);
    }

    // продвижение
    this.step = (this.step + 1) % 16;
    this.totalStep++;
    if (this.step === 0) {
      this.barInPhase++;
      this.totalBar++;
      if (this.barInPhase % this.chordBars === 0) {
        this.chordIdx = (this.chordIdx + 1) % this.progression.chords.length;
      }
      // вариация каждый проход формы
      if (this.totalBar % 8 === 0) this.rollPassVar();
      if (this.pendingMotif && this.totalStep % (this.motifLen * 2) === 0) {
        this.motifTranspose = pick([0, 0, 3, 5, 7, -2]);   // транспозиция мотива
        this.pendingMotif = false;
      }
      const ph = this.phaseDef();
      if (this.barInPhase >= ph.bars) {
        this.barInPhase = 0;
        this.phaseIndex++;
        if (this.phaseIndex >= this.phaseList.length) {
          this.fadeStage = 1;   // трек кончился — уходим в следующий
          return;
        }
        // Модуляция: в бридже уходим в другую тональность, из бриджа — обратно
        const np = this.phaseList[this.phaseIndex];
        this.keyShift = (this.modulate && np === 'bridge') ? this.modInterval : 0;
      }
      this.sendStatus();
    }
  }

  // ---------- Аудио ----------
  process(inputs, outputs) {
    const output = outputs[0];
    const left = output[0];
    const right = output[1];
    const sr = this.sr;

    if (!this.isPlaying) {
      for (let i = 0; i < left.length; i++) { left[i] = 0; right[i] = 0; }
      return true;
    }

    const stepDur = 60 / this.bpm / 4;
    const stepSamples = Math.floor(stepDur * sr);
    const swingSamples = Math.floor(stepSamples * this.swing);
    const blockSec = left.length / sr;

    // Кроссфейд перелистывания
    const fadeStep = blockSec / 0.08;
    if (this.fadeStage === 1) {
      this.fade -= fadeStep;
      if (this.fade <= 0) {
        this.fade = 0;
        // Экспорт однократный: трек доиграл и замолк. Иначе в файл просочилось
        // бы начало следующего трека — он ведь тоже идёт по кругу.
        if (this.oneShot) this.isPlaying = false;
        else { this.restartTrack(); this.fadeStage = 2; }
      }
    } else if (this.fadeStage === 2) {
      this.fade += fadeStep;
      if (this.fade >= 1) { this.fade = 1; this.fadeStage = 0; }
    }
    const fade = this.fade;

    // Тейп-стоп (в экспериментальных слоях случается на границах)
    if (this.stopStage === 1) {
      this.stopAmt = Math.min(1, this.stopAmt + blockSec * 5);
      if (this.stopAmt >= 1) this.stopStage = 2;
    } else if (this.stopStage === 2) {
      this.stopAmt = Math.max(0, this.stopAmt - blockSec * 1.6);
      if (this.stopAmt <= 0) this.stopStage = 0;
    }

    // «Плёнка»: срез дрейфует медленным LFO и открывается по фазам
    const ph = this.phaseDef();
    const lpTarget = this.lpBase * ph.lpMul * (1 - 0.35 * this.stopAmt);
    this.lpNow += (lpTarget - this.lpNow) * 0.02;
    this.tapeLfoPhase += 2 * Math.PI * 0.06 * blockSec;
    const lpFc = clamp(this.lpNow * (1 + 0.1 * Math.sin(this.tapeLfoPhase)), 400, 12000);
    const tapeA = 1 - Math.exp(-2 * Math.PI * lpFc / sr);

    const mix = this.mood.mix;
    const crushAmt = this.crush;
    // Клавиши в реальной машине оцифрованы так же, как барабаны: децимация
    // мелодик-шины мягче, но есть всегда — иначе клавиши звучат «слишком чисто».
    const musicCrush = 0.45 + crushAmt * 0.35;
    const kitLpA = 1 - Math.exp(-2 * Math.PI * this.kitLpF / sr);
    // Срез обратной связи дилэя: 4.2 кГц — повтор темнеет с каждым кругом.
    const delayA = 1 - Math.exp(-2 * Math.PI * 4200 / sr);
    this.topL.set(this.topFc * 1.2, 0.6, sr);
    this.topR.set(this.topFc * 1.2, 0.6, sr);

    for (let i = 0; i < left.length; i++) {
      // секвенсор
      this.stepCounter++;
      if (this.pendingStep > 0) {
        if (--this.pendingStep === 0) { this.stepCounter = swingSamples; this.onStep(); }
      } else if (this.stepCounter >= stepSamples) {
        if (this.step % 2 === 1 && swingSamples > 0) this.pendingStep = swingSamples;
        else { this.stepCounter = 0; this.onStep(); }
      }

      // wow/flutter + тейп-стоп по строю; глубина разводится по шинам
      this.wowPhase += 2 * Math.PI * 0.35 / sr;
      this.flutterPhase += 2 * Math.PI * 6.3 / sr;
      const driftBase = this.wowDepth * Math.sin(this.wowPhase)
        + 0.7 * Math.sin(this.flutterPhase)
        - 2600 * this.stopAmt * this.stopAmt;
      PITCH_DRIFT = driftBase;
      PITCH_DRIFT_DRUM = driftBase * 0.3;
      PITCH_DRIFT_BASS = driftBase * 0.15;
      PITCH_DRIFT_LEAD = driftBase * 0.55;

      // отложенные удары: свой микро-сдвиг у каждой линии
      for (const p of this.pend) {
        if (!p.active) continue;
        if (--p.t <= 0) { p.active = false; const f = p.fn; p.fn = null; f(); }
      }

      // суммируем голоса по шинам (стерео, с панорамой)
      let drumL = 0, drumR = 0, bassL = 0, bassR = 0, padL = 0, padR = 0, leadL = 0, leadR = 0;
      for (const v of this.voices) {
        if (!v.active) continue;
        const s = v.process(sr);
        if (v.bus === 'bass') { bassL += s * v.gl; bassR += s * v.gr; }
        else if (v.bus === 'pad') { padL += s * v.gl; padR += s * v.gr; }
        else if (v.bus === 'lead') { leadL += s * v.gl; leadR += s * v.gr; }
        else { drumL += s * v.gl; drumR += s * v.gr; }
      }
      for (const v of this.noiseVoices) {
        if (!v.active) continue;
        const s = v.process(sr);
        drumL += s * v.gl; drumR += s * v.gr;
      }
      for (const v of this.kickVoices) {
        if (!v.active) continue;
        const s = v.process(sr);
        drumL += s * v.gl; drumR += s * v.gr;
      }
      // громкости шин и дакинг баса
      drumL *= mix.d; drumR *= mix.d;
      // ленточный срез верха драм-шины: страховка от цифрового сиза
      this.topL.process(drumL); drumL = this.topL.oLp;
      this.topR.process(drumR); drumR = this.topR.oLp;
      bassL *= mix.b; bassR *= mix.b;
      this.bassDuck *= this.duckDecay;
      const duck = 1 - 0.4 * this.bassDuck;
      bassL *= duck; bassR *= duck;

      // 12-битный сэмплер (SP-1200/MPC60): децимация + квантование
      if (crushAmt > 0) {
        this.crushAcc += crushAmt * 0.35;
        if (this.crushAcc >= 1) {
          this.crushAcc -= 1;
          this.crushL = Math.round(drumL * 1024) / 1024;
          this.crushR = Math.round(drumR * 1024) / 1024;
        }
        drumL = this.crushL; drumR = this.crushR;
      }

      // тембр драм-шины по киту: полка + наклон (ярче/темнее)
      this.drumLpL += (drumL - this.drumLpL) * kitLpA;
      this.drumLpR += (drumR - this.drumLpR) * kitLpA;
      drumL = this.drumLpL + (drumL - this.drumLpL) * this.kitHi;
      drumR = this.drumLpR + (drumR - this.drumLpR) * this.kitHi;

      // glue драм-шины + сатурация
      const dPeak = Math.abs(drumL) > Math.abs(drumR) ? Math.abs(drumL) : Math.abs(drumR);
      const dCoef = dPeak > this.drumEnv ? this.drumCompA : this.drumCompR;
      this.drumEnv = dPeak + dCoef * (this.drumEnv - dPeak);
      let dGr = 1;
      if (this.drumEnv > 0.0631) dGr = Math.pow(this.drumEnv / 0.0631, -0.5);
      const drive = this.kit.drive;
      drumL = Math.tanh(drumL * dGr * drive) / drive;
      drumR = Math.tanh(drumR * dGr * drive) / drive;

      // мелодик-шина: «плёнка» → 12-битный сэмплер → сатурация
      this.tapeL += (padL + leadL - this.tapeL) * tapeA;
      this.tapeR += (padR + leadR - this.tapeR) * tapeA;
      this.crushAcc2 += musicCrush;
      if (this.crushAcc2 >= 1) {
        this.crushAcc2 -= 1;
        this.crushL2 = Math.round(this.tapeL * 1024) / 1024;
        this.crushR2 = Math.round(this.tapeR * 1024) / 1024;
      }
      const musicL = Math.tanh(this.crushL2 * 1.12) / 1.12;
      const musicR = Math.tanh(this.crushR2 * 1.12) / 1.12;

      // реверб: предилэй → 6 гребёнок (демпфер в обратной связи) → 3 всепропускающих.
      // Правый канал гребёнок сдвинут на 23 отсчёта — отсюда стерео хвоста.
      const revIn = this.mood.reverb * ph.wet * this.revSend;
      this.preBufL[this.preWrite] = musicL * 0.5 * revIn + drumL * 0.05;
      this.preBufR[this.preWrite] = musicR * 0.5 * revIn + drumR * 0.05;
      let pIdx = this.preWrite - this.preDelay;
      if (pIdx < 0) pIdx += this.preBufL.length;
      const preL = this.preBufL[pIdx], preR = this.preBufR[pIdx];
      this.preWrite = this.preWrite + 1 >= this.preBufL.length ? 0 : this.preWrite + 1;

      const rvIn = (preL + preR) * 0.017;      // gain входа гребёнок
      const rvFb = this.revRoom, rvDp = this.revDamp;
      let wetL = 0, wetR = 0;
      for (let c = 0; c < this.comb.length; c++) {
        const cb = this.comb[c];
        const yL = cb.l[cb.iL], yR = cb.r[cb.iR];
        cb.fL += (yL - cb.fL) * rvDp;
        cb.fR += (yR - cb.fR) * rvDp;
        cb.l[cb.iL] = rvIn + cb.fL * rvFb;
        cb.r[cb.iR] = rvIn + cb.fR * rvFb;
        cb.iL = cb.iL + 1 >= cb.l.length ? 0 : cb.iL + 1;
        cb.iR = cb.iR + 1 >= cb.r.length ? 0 : cb.iR + 1;
        wetL += yL; wetR += yR;
      }
      for (let a = 0; a < this.ap.length; a++) {
        const ap = this.ap[a];
        const bL = ap.l[ap.iL], bR = ap.r[ap.iR];
        ap.l[ap.iL] = wetL + bL * 0.5;
        ap.r[ap.iR] = wetR + bR * 0.5;
        wetL = bL - wetL;
        wetR = bR - wetR;
        ap.iL = ap.iL + 1 >= ap.l.length ? 0 : ap.iL + 1;
        ap.iR = ap.iR + 1 >= ap.r.length ? 0 : ap.iR + 1;
      }
      const revL = wetL, revR = wetR;

      // дилэй: эхо мелодии. В обратной связи — свой ленточный срез (см. выше),
      // иначе повторы копят верх и эхо звенит поверх музыки.
      const dIdx = (this.delayWrite - Math.floor(sr * stepDur * 2) + this.delayBufferL.length) % this.delayBufferL.length;
      const delL = this.delayBufferL[dIdx];
      const delR = this.delayBufferR[dIdx];
      const delIn = this.mood.delay;
      this.delayLpL += (delL - this.delayLpL) * delayA;
      this.delayLpR += (delR - this.delayLpR) * delayA;
      this.delayBufferL[this.delayWrite] = drumL * 0.08 + musicL * 0.3 * delIn + this.delayLpL * 0.22;
      this.delayBufferR[this.delayWrite] = drumR * 0.08 + musicR * 0.3 * delIn + this.delayLpR * 0.22;
      this.delayWrite = (this.delayWrite + 1) % this.delayBufferL.length;

      // микс
      let mixL = drumL + bassL + musicL + revL * this.revWet + delL * 0.14;
      let mixR = drumR + bassR + musicR + revR * this.revWet + delR * 0.14;

      // DC blocker
      const dcOutL = mixL - this.dcPrevL + 0.995 * this.dcL;
      const dcOutR = mixR - this.dcPrevR + 0.995 * this.dcR;
      this.dcPrevL = mixL; this.dcPrevR = mixR;
      this.dcL = dcOutL; this.dcR = dcOutR;

      // HPF 30 Гц (эквалайзер живёт в plugins/mastering.js)
      this.hpL += (dcOutL - this.hpL) * this.hpCoeff;
      this.hpR += (dcOutR - this.hpR) * this.hpCoeff;
      const hpOutL = dcOutL - this.hpL;
      const hpOutR = dcOutR - this.hpR;

      // мягкий лимитер + громкость тейп-стопа
      const stopGain = 1 - 0.85 * this.stopAmt;
      // Уровень на выходе: мастер (plugins/mastering.js) нормирует по LUFS,
      // но у него есть предел буста — поэтому шину держим в рабочей зоне.
      mixL = Math.tanh(hpOutL * 1.2) * 0.86 * stopGain;
      mixR = Math.tanh(hpOutR * 1.2) * 0.86 * stopGain;

      left[i] = mixL * fade;
      right[i] = mixR * fade;
    }

    // тейп-стоп начинается на границе фазы glitch
    if (chance(0.0006 * this.mood.tapeStop) && this.stopStage === 0) this.stopStage = 1;

    return true;
  }
}

registerProcessor('lofi-processor', LofiProcessor);

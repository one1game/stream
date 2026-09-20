/* =====================================================
   MASTERING PLUGIN · AudioWorkletProcessor
   Профессиональная финальная обработка тракта.
   Ставится последним: lofi-processor → analyser → mastering → destination.

   Цепочка (все настройки — в MASTER ниже):
     1. EQ      : 24 Гц HPF → −2 дБ @55 (саб) → +2 дБ @110 (плотность)
                  → −2 дБ @320 (муть) → −2.5 дБ @2.8к (резкость)
                  → +1.5 дБ @9к (воздух) → LP 16 кГц (мягкая лента)
     2. Стерео  : низ моно ниже 140 Гц (elliptical), ширина низа 1.0 / верха 1.06
     3. Сатурация: мягкая лента (tanh), трогает только пики
     4. Glue    : компрессор 1.6:1, knee 8 дБ, −28 дБ, 40/250 мс, makeup +3 дБ (1–3 дБ GR)
     5. Loudness: нормализация к −14 LUFS по K-взвешиванию (ITU-R BS.1770),
                  окно 3 с, гейт −70 LUFS
     6. Limiter : lookahead 3 мс, release 150 мс, потолок −1 dBFS, hard-safety
   ===================================================== */

const MASTER = {
  eq: {
    hpf:    { f: 24,    q: 0.707 },
    sub:    { f: 55,    gain: -2.0, q: 0.9 },
    bass:   { f: 110,   gain:  2.0 },
    mud:    { f: 320,   gain: -2.0, q: 0.9 },
    // Срез резкости был −2.5 дБ на 2.8к и попадал ровно в зону разборчивости:
    // вместе с бедными гармониками голосов он и делал «одеяло». Теперь мягче,
    // а presence возвращает 4-5 кГц.
    // Верх поднимали на +2.6/+2.5 дБ, пока голоса были бедные. С новыми
    // гармониками этого уже много: на слоях с колокольчиком верх уходил на
    // 10-15 дБ выше остальных и звенел. Держим ровно, без «воздуха в уши».
    harsh:  { f: 3000,  gain: -1.0, q: 0.7 },
    presence:{ f: 4200, gain:  1.4, q: 0.7 },
    air:    { f: 9000,  gain:  1.2 },
    tapeLP: { f: 16000, q: 0.707 },
  },
  stereo:  { monoBelow: 140, width: 1.35 },
  sat:     { drive: 1.35 },
  // release длинный (0.6 с): glue держит уровень между ударами барабанов,
  // иначе огибающая падает в паузах и компрессор не работает вовсе.
  // Порог ниже и ratio выше — плотность: раньше крест-фактор был 15 дБ,
  // из-за чего трек звучал рыхлее соседей по плейлисту при равной громкости.
  comp:    { thresholdDb: -40, ratio: 2.0, kneeDb: 8, attack: 0.055, release: 0.600, makeupDb: 3.0 },
  // speedSec длиннее окна измерения (3 с): если регулятор быстрее окна, он
  // раскачивает громкость на ±3 дБ. Цель -12 LUFS, пределы поправки -12…+24 дБ.
  loudness:{ targetLufs: -12, windowSec: 3.0, gateLufs: -70, maxBoostDb: 24, maxCutDb: -12, speedSec: 4.0 },
  limiter: { ceilingDb: -1.0, lookaheadMs: 3.0, releaseMs: 150 },
};

// ---- Biquad (RBJ cookbook + K-взвешивание), transposed direct form II ----
class Biquad {
  constructor() {
    this.b0 = 1; this.b1 = 0; this.b2 = 0; this.a1 = 0; this.a2 = 0;
    this.z1 = 0; this.z2 = 0;
  }
  _set(b0, b1, b2, a0, a1, a2) {
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0;
    this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  process(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }
  highpass(sr, f, q) {
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this._set((1 + c) / 2, -(1 + c), (1 + c) / 2, 1 + al, -2 * c, 1 - al);
    return this;
  }
  lowpass(sr, f, q) {
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this._set((1 - c) / 2, 1 - c, (1 - c) / 2, 1 + al, -2 * c, 1 - al);
    return this;
  }
  lowShelf(sr, f, gainDb, S) {
    const A = Math.pow(10, gainDb / 40);
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const beta = 2 * Math.sqrt(A) * al;
    this._set(
      A * ((A + 1) - (A - 1) * c + beta),
      2 * A * ((A - 1) - (A + 1) * c),
      A * ((A + 1) - (A - 1) * c - beta),
      (A + 1) + (A - 1) * c + beta,
      -2 * ((A - 1) + (A + 1) * c),
      (A + 1) + (A - 1) * c - beta
    );
    return this;
  }
  highShelf(sr, f, gainDb, S) {
    const A = Math.pow(10, gainDb / 40);
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w);
    const al = s / 2 * Math.sqrt((A + 1 / A) * (1 / S - 1) + 2);
    const beta = 2 * Math.sqrt(A) * al;
    this._set(
      A * ((A + 1) + (A - 1) * c + beta),
      -2 * A * ((A - 1) + (A + 1) * c),
      A * ((A + 1) + (A - 1) * c - beta),
      (A + 1) - (A - 1) * c + beta,
      2 * ((A - 1) - (A + 1) * c),
      (A + 1) - (A - 1) * c - beta
    );
    return this;
  }
  peaking(sr, f, gainDb, q) {
    const A = Math.pow(10, gainDb / 40);
    const w = 2 * Math.PI * f / sr, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q);
    this._set(1 + al * A, -2 * c, 1 - al * A, 1 + al / A, -2 * c, 1 - al / A);
    return this;
  }
  // Полка из аналогового прототипа BS.1770 (нормировка громкости)
  kHighShelf(sr, f, gainDb, q) {
    const K = Math.tan(Math.PI * f / sr);
    const Vh = Math.pow(10, gainDb / 20);
    const Vb = Math.pow(Vh, 0.4996667741545416);
    const a0 = 1 + K / q + K * K;
    this._set(
      (Vh + Vb * K / q + K * K),
      2 * (K * K - Vh),
      (Vh - Vb * K / q + K * K),
      a0,
      2 * (K * K - 1),
      1 - K / q + K * K
    );
    return this;
  }
  kHighPass(sr, f, q) {
    const K = Math.tan(Math.PI * f / sr);
    const a0 = 1 + K / q + K * K;
    this._set(1, -2, 1, a0, 2 * (K * K - 1), 1 - K / q + K * K);
    return this;
  }
}

class MasteringProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const sr = sampleRate;
    this.sr = sr;

    // 1. EQ (порядок в массиве = порядок обработки)
    this.eqL = this.makeEq(sr);
    this.eqR = this.makeEq(sr);

    // 2. Стерео: HPF на side-канале = низ в моно
    this.sideHp = new Biquad().highpass(sr, MASTER.stereo.monoBelow, 0.707);
    this.width = MASTER.stereo.width;

    // 3. Сатурация
    this.satDrive = MASTER.sat.drive;
    this.satComp = 1 / this.satDrive;

    // 4. Glue-компрессор (linked stereo, soft knee, auto-makeup)
    const c = MASTER.comp;
    this.compAttackC = Math.exp(-1 / (sr * c.attack));
    this.compReleaseC = Math.exp(-1 / (sr * c.release));
    this.compEnv = 0;
    this.thr = Math.pow(10, c.thresholdDb / 20);
    this.kneeTop = Math.pow(10, (c.thresholdDb + c.kneeDb) / 20);
    this.compRatioInv = 1 - 1 / c.ratio;
    this.compMakeup = Math.pow(10, c.makeupDb / 20);

    // 5. Loudness-нормализация (K-взвешивание + измерение по блокам)
    this.kL = [new Biquad().kHighShelf(sr, 1681.974450955533, 3.999843853973347, 0.7071752369554196),
               new Biquad().kHighPass(sr, 38.13547087602444, 0.5003270373238773)];
    this.kR = [new Biquad().kHighShelf(sr, 1681.974450955533, 3.999843853973347, 0.7071752369554196),
               new Biquad().kHighPass(sr, 38.13547087602444, 0.5003270373238773)];
    const L = MASTER.loudness;
    this.targetLufs = L.targetLufs;
    this.maxBoostDb = L.maxBoostDb;
    this.maxCutDb = L.maxCutDb;
    this.gateMs = Math.pow(10, (L.gateLufs + 0.691) / 10);
    this.ms = Math.pow(10, (L.targetLufs + 0.691) / 10); // старт = целевая громкость, буста на тишине нет
    this.measC = Math.exp(-1 / ((sr / 128) * L.windowSec));
    this.normSpeedC = Math.exp(-1 / ((sr / 128) * L.speedSec));
    this.normGainDb = 0;
    this.normGain = 1;

    // 6. Limiter с lookahead
    const lim = MASTER.limiter;
    this.ceiling = Math.pow(10, lim.ceilingDb / 20);
    this.lookahead = Math.max(1, Math.round(sr * lim.lookaheadMs / 1000));
    this.limReleaseC = Math.exp(-1 / (sr * lim.releaseMs / 1000));
    this.limEnv = 0;
    this.limGain = 1;
    this.delayL = new Float32Array(this.lookahead);
    this.delayR = new Float32Array(this.lookahead);
    this.delayIdx = 0;

    // Отчёт в UI
    this.uiCounter = 0;
    this.grAcc = 0;
  }

  makeEq(sr) {
    const e = MASTER.eq;
    return [
      new Biquad().highpass(sr, e.hpf.f, e.hpf.q),
      new Biquad().peaking(sr, e.sub.f, e.sub.gain, e.sub.q),
      new Biquad().lowShelf(sr, e.bass.f, e.bass.gain, 0.75),
      new Biquad().peaking(sr, e.mud.f, e.mud.gain, e.mud.q),
      new Biquad().peaking(sr, e.harsh.f, e.harsh.gain, e.harsh.q),
      new Biquad().peaking(sr, e.presence.f, e.presence.gain, e.presence.q),
      new Biquad().highShelf(sr, e.air.f, e.air.gain, 0.7),
      new Biquad().lowpass(sr, e.tapeLP.f, e.tapeLP.q),
    ];
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const outL = output[0];
    const outR = output[1] || output[0];
    const n = outL.length;

    if (!input || !input.length || !input[0]) {
      for (let i = 0; i < n; i++) { outL[i] = 0; outR[i] = 0; }
      return true;
    }

    const inL = input[0];
    const inR = input[1] || input[0];

    const eqL = this.eqL, eqR = this.eqR;
    const eqCount = eqL.length;
    const kL = this.kL, kR = this.kR;
    const width = this.width, satDrive = this.satDrive, satComp = this.satComp;
    const thr = this.thr, kneeTop = this.kneeTop, ratioInv = this.compRatioInv, makeup = this.compMakeup;
    const ceiling = this.ceiling, lookahead = this.lookahead;
    const dL = this.delayL, dR = this.delayR;
    const normGain = this.normGain;

    let limGain = this.limGain;
    let kSum = 0;
    let grSum = 0;

    for (let i = 0; i < n; i++) {
      // --- 1. EQ ---
      let l = inL[i], r = inR[i];
      for (let b = 0; b < eqCount; b++) l = eqL[b].process(l);
      for (let b = 0; b < eqCount; b++) r = eqR[b].process(r);

      // --- 2. Стерео: низ в моно, верх с шириной ---
      const mid = (l + r) * 0.5;
      const side = this.sideHp.process((l - r) * 0.5) * width;
      l = mid + side;
      r = mid - side;

      // --- 3. Ленточная сатурация (только пики) ---
      l = Math.tanh(l * satDrive) * satComp;
      r = Math.tanh(r * satDrive) * satComp;

      // --- 4. Glue-компрессор: soft knee + linked stereo ---
      const peak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      const cC = peak > this.compEnv ? this.compAttackC : this.compReleaseC;
      this.compEnv = peak + cC * (this.compEnv - peak);

      let gr = 1;
      if (this.compEnv > thr) {
        const hard = Math.pow(this.compEnv / thr, -ratioInv);
        if (this.compEnv < kneeTop) {
          const w = (this.compEnv - thr) / (kneeTop - thr); // 0..1 внутри knee
          gr = 1 + (hard - 1) * w;
        } else {
          gr = hard;
        }
      }
      grSum += gr;
      l *= gr * makeup;
      r *= gr * makeup;

      // --- 5. Нормализация громкости ---
      l *= normGain;
      r *= normGain;

      // --- 6. Limiter: lookahead-задержка + пик-детектор ---
      const dl = dL[this.delayIdx], dr = dR[this.delayIdx];
      dL[this.delayIdx] = l;
      dR[this.delayIdx] = r;
      this.delayIdx = this.delayIdx + 1 >= lookahead ? 0 : this.delayIdx + 1;

      const limPeak = Math.abs(l) > Math.abs(r) ? Math.abs(l) : Math.abs(r);
      this.limEnv *= this.limReleaseC;
      if (limPeak > this.limEnv) this.limEnv = limPeak;

      const target = this.limEnv > ceiling ? ceiling / this.limEnv : 1;
      if (target < limGain) limGain = target;                    // сброс мгновенный — запас даёт lookahead
      else limGain = target + this.limReleaseC * (limGain - target);

      let ol = dl * limGain, or = dr * limGain;
      if (ol > ceiling) ol = ceiling; else if (ol < -ceiling) ol = -ceiling;
      if (or > ceiling) or = ceiling; else if (or < -ceiling) or = -ceiling;

      // --- 7. Измерение громкости на выходе ---
      // Меряем то, что реально уходит в файл. Раньше точка замера стояла до
      // нормировки: регулятор не видел работы лимитера, упирался в предел буста,
      // и слои разъезжались по громкости (0.6 дБ → 2.2 дБ при правках верха).
      let kl = ol, kr = or;
      for (let b = 0; b < 2; b++) kl = kL[b].process(kl);
      for (let b = 0; b < 2; b++) kr = kR[b].process(kr);
      kSum += kl * kl + kr * kr;

      outL[i] = ol;
      outR[i] = or;
    }

    this.limGain = limGain;

    // --- Обновление измерений раз в блок ---
    const blockMs = kSum / n;
    if (blockMs > this.gateMs) {
      this.ms = blockMs + this.measC * (this.ms - blockMs);
      const lufs = -0.691 + 10 * Math.log10(this.ms + 1e-12);
      // Замер стоит на выходе, поэтому want — это недостающие дБ, а не абсолютная
      // цель: поправку надо копить. Пропорциональный вариант делил буст вдвое —
      // регулятор застревал на +10 дБ вместо +21 и слой играл на -22 LUFS.
      const want = this.targetLufs - lufs;
      let g = this.normGainDb + want * (1 - this.normSpeedC);
      if (g > this.maxBoostDb) g = this.maxBoostDb;
      else if (g < this.maxCutDb) g = this.maxCutDb;
      this.normGainDb = g;
      this.normGain = Math.pow(10, g / 20);
    }

    // --- Отчёт в UI (~15 раз/сек) ---
    this.uiCounter++;
    this.grAcc += grSum / n;
    if (this.uiCounter >= 15) {
      const limDb = 20 * Math.log10(limGain);
      const measured = -0.691 + 10 * Math.log10(this.ms + 1e-12);
      this.port.postMessage({
        type: 'mastering',
        lufs: measured, // замер уже на выходе, нормировку прибавлять не нужно
        compGr: 20 * Math.log10(this.grAcc / this.uiCounter),
        limGr: limDb,
        norm: this.normGainDb,
      });
      this.uiCounter = 0;
      this.grAcc = 0;
    }

    return true;
  }
}

registerProcessor('mastering-processor', MasteringProcessor);

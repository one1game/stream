/* =====================================================
   Офлайн-версия Web Audio для эфира.

   В браузере звук игры собирает сам браузер: страница создаёт AudioContext,
   вешает на него осцилляторы и гейны, а тот сводит всё в колонки. В эфире
   страницы нет — есть Node и TCP, куда надо отдавать готовые сэмплы. Поэтому
   здесь живёт маленький движок, который понимает ровно тот набор Web Audio,
   что нужен сцене (см. AudioEngine в muxa.html): осцилляторы с автоматизацией
   частоты, гейны с огибающей, биквады, буферы шума, задержку, волновую кривую
   (сатурация и «бит-краш»), панораму и микширование в стерео.

   Как пользоваться:
     const audio = createOfflineAudio(44100);
     globalThis.window.AudioContext = audio.AudioContext;
     ... исполнить сцену ...
     audio.render(1024)  -> { left, right }   сводит 1024 сэмпла

   Время контекста (currentTime) — это часы самого движка: сколько сэмплов уже
   сведено. Сцена читает его и назначает время нот, поэтому звук идёт ровно
   вместе с эфиром, без опоры на настенные часы.
   ===================================================== */

const TAU = Math.PI * 2;
const BLOCK = 128;                 // как в Web Audio: блок рендера

class Param {
  constructor(value) {
    this.value = value;
    this.events = [];
    this._t = 0;
  }

  setValueAtTime(v, t) { return this._add({ type: 'set', v, t }); }
  linearRampToValueAtTime(v, t) { return this._add({ type: 'lin', v, t }); }
  exponentialRampToValueAtTime(v, t) { return this._add({ type: 'exp', v, t }); }
  setTargetAtTime(v, t, tau) { return this._add({ type: 'target', v, t, tau }); }

  _add(e) {
    this.events.push(e);
    this.events.sort((a, b) => a.t - b.t);
    return this;
  }

  /**
   * Значение параметра в момент t (в секундах), по ходу часов движка.
   *
   * Наступившие события применяются к текущему значению и выбрасываются —
   * иначе массив рос бы без конца: дрон шлёт setTargetAtTime каждые полсекунды,
   * за пять часов это десятки тысяч записей, и каждый сэмпл перебирал бы их все.
   */
  at(t) {
    const ev = this.events;
    while (ev.length && ev[0].t <= t) {
      const e = ev.shift();
      if (e.type === 'target') {
        // Асимптотический подход: считаем от значения на момент t.
        this.value = e.v + (this.value - e.v) * Math.exp(-(t - e.t) / Math.max(1e-6, e.tau));
        this._t = t;
      } else {
        this.value = e.v;
        this._t = e.t;
      }
    }
    if (!ev.length) return this.value;
    const next = ev[0];
    const span = next.t - this._t;
    if (span <= 0) return this.value;
    const k = Math.min(1, Math.max(0, (t - this._t) / span));
    if (next.type === 'lin') return this.value + (next.v - this.value) * k;
    if (next.type === 'exp') {
      if (this.value > 0 && next.v > 0) return this.value * Math.pow(next.v / this.value, k);
      return this.value + (next.v - this.value) * k;
    }
    return this.value;            // до события set/target значение держится
  }
}

class Node {
  constructor(ctx) {
    this.ctx = ctx;
    this.sr = ctx.sampleRate;
    this.inputs = [];
    this.persistent = false;       // шины микшера: их не убираем никогда
    this._memoL = new Float32Array(BLOCK);   // посчитанный за этот проход блок
    this._memoR = new Float32Array(BLOCK);
    this._blk = -1;
    this._blkN = 0;
    this._gone = false;            // уже вычтен из счётчика узлов
  }

  connect(target) {
    if (target && target.inputs) target.inputs.push(this);
    return target;
  }

  /** Отработал и больше ничего не даст. */
  finished() { return false; }

  /** Убирает отработавшие источники из своих входов (и из чужих тоже). */
  sweep() {
    for (let i = this.inputs.length - 1; i >= 0; i--) {
      const n = this.inputs[i];
      n.sweep();
      if (n.finished()) {
        this.inputs.splice(i, 1);
        // Один узел может питать несколько выходов (сухой путь и посыл), и
        // тогда его вычитают из графа дважды. Считаем только один раз.
        if (!n._gone) { n._gone = true; this.ctx._alive--; }
      }
    }
  }

  /**
   * Узел, который считает себя по шагам (осциллятор, фильтр, задержка), обязан
   * отдать один и тот же блок всем своим выходам: второй проход испортил бы и
   * звук, и счёт узлов. Поэтому такие узлы пишут результат в memo, а наружу
   * отдают его копию. Узлы без состояния (гейн, панорама, кривая) могут
   * пересчитываться сколько угодно — им это не нужно.
   */
  cached(startSample, n) { return this._blk === startSample && this._blkN >= n; }

  beginBlock(startSample, n) {
    this._blk = startSample;
    this._blkN = n;
    this._memoL.fill(0, 0, n);
    this._memoR.fill(0, 0, n);
  }

  emit(startSample, n, outL, outR, offset) {
    for (let i = 0; i < n; i++) {
      outL[offset + i] += this._memoL[i];
      outR[offset + i] += this._memoR[i];
    }
  }

  pull() {}
}

class Destination extends Node {
  constructor(ctx) { super(ctx); this.persistent = true; }

  pull(startSample, n, outL, outR, offset) {
    for (const src of this.inputs) src.pull(startSample, n, outL, outR, offset);
    this.sweep();
  }
}

class GainNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.gain = new Param(1);
    this._bufL = new Float32Array(BLOCK);
    this._bufR = new Float32Array(BLOCK);
  }

  finished() { return !this.persistent && this.inputs.length === 0; }

  pull(startSample, n, outL, outR, offset) {
    if (!this.inputs.length) return;
    if (this.cached(startSample, n)) { this.emit(startSample, n, outL, outR, offset); return; }
    this.beginBlock(startSample, n);
    this._bufL.fill(0, 0, n);
    this._bufR.fill(0, 0, n);
    for (const src of this.inputs) src.pull(startSample, n, this._bufL, this._bufR, 0);
    // Огибающую берём раз на блок и ведём линейно между его краями. Считать
    // её на каждый сэмпл — сотни тысяч вызовов в секунду на пустом месте,
    // а на 128 сэмплах (2.9 мс) разницы не слышно.
    const g0 = Math.max(0, this.gain.at(startSample / this.sr));
    const g1 = Math.max(0, this.gain.at((startSample + n) / this.sr));
    const dg = (g1 - g0) / n;
    let k = g0;
    for (let i = 0; i < n; i++) {
      this._memoL[i] = this._bufL[i] * k;
      this._memoR[i] = this._bufR[i] * k;
      k += dg;
    }
    this.emit(startSample, n, outL, outR, offset);
  }
}

class OscillatorNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.type = 'sine';
    this.frequency = new Param(440);
    this.phase = 0;
    this._startS = -1;
    this._stopS = -1;
  }

  start(t = this.ctx.currentTime) { this._startS = Math.round(t * this.sr); }
  stop(t = this.ctx.currentTime) { this._stopS = Math.round(t * this.sr); }
  setPeriodicWave() {}
  finished() { return this._stopS >= 0 && this.ctx._pos >= this._stopS; }

  _wave(p) {
    switch (this.type) {
      case 'square': return p < 0.5 ? 1 : -1;
      case 'sawtooth': return p * 2 - 1;
      case 'triangle': return 4 * Math.abs(p - 0.5) - 1;
      default: return Math.sin(p * TAU);
    }
  }

  pull(startSample, n, outL, outR, offset) {
    if (this._startS < 0) return;
    if (this.cached(startSample, n)) { this.emit(startSample, n, outL, outR, offset); return; }
    this.beginBlock(startSample, n);
    // Частоту тоже берём раз на блок: слайд от этого остаётся плавным, а
    // вызовов на порядки меньше.
    const f0 = Math.max(0, this.frequency.at(startSample / this.sr));
    const f1 = Math.max(0, this.frequency.at((startSample + n) / this.sr));
    const dF = (f1 - f0) / n;
    let f = f0;
    for (let i = 0; i < n; i++) {
      const s = startSample + i;
      if (s < this._startS) { f += dF; continue; }
      if (this._stopS >= 0 && s >= this._stopS) break;
      this.phase += f / this.sr;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
      const v = this._wave(this.phase);
      this._memoL[i] = v;
      this._memoR[i] = v;
      f += dF;
    }
    this.emit(startSample, n, outL, outR, offset);
  }
}

class BiquadFilterNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.type = 'lowpass';
    this.frequency = new Param(350);
    this.Q = new Param(1);
    this._x = [[0, 0], [0, 0]];
    this._y = [[0, 0], [0, 0]];
    this._bufL = new Float32Array(BLOCK);
    this._bufR = new Float32Array(BLOCK);
  }

  finished() { return !this.persistent && this.inputs.length === 0; }

  pull(startSample, n, outL, outR, offset) {
    if (!this.inputs.length) return;
    if (this.cached(startSample, n)) { this.emit(startSample, n, outL, outR, offset); return; }
    this.beginBlock(startSample, n);
    this._bufL.fill(0, 0, n);
    this._bufR.fill(0, 0, n);
    for (const src of this.inputs) src.pull(startSample, n, this._bufL, this._bufR, 0);

    // Коэффициенты RBJ — те же, что в браузере, пересчитываем раз на блок.
    const f0 = Math.min(this.sr * 0.49, Math.max(10, this.frequency.at(startSample / this.sr)));
    const w0 = (TAU * f0) / this.sr;
    const alpha = Math.sin(w0) / (2 * Math.max(0.01, this.Q.at(startSample / this.sr)));
    const cos = Math.cos(w0);
    let b0 = 1, b1 = 0, b2 = 0, a0 = 1, a1 = 0, a2 = 0;
    if (this.type === 'lowpass') {
      b0 = (1 - cos) / 2; b1 = 1 - cos; b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else if (this.type === 'highpass') {
      b0 = (1 + cos) / 2; b1 = -(1 + cos); b2 = b0;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    } else {                                  // bandpass
      b0 = alpha; b1 = 0; b2 = -alpha;
      a0 = 1 + alpha; a1 = -2 * cos; a2 = 1 - alpha;
    }

    const chans = [
      { in: this._bufL, out: this._memoL, st: this._x[0], yst: this._y[0] },
      { in: this._bufR, out: this._memoR, st: this._x[1], yst: this._y[1] },
    ];
    for (let c = 0; c < 2; c++) {
      const { in: src, out, st, yst } = chans[c];
      for (let i = 0; i < n; i++) {
        const x = src[i];
        const y = (b0 / a0) * x + (b1 / a0) * st[0] + (b2 / a0) * st[1]
          - (a1 / a0) * yst[0] - (a2 / a0) * yst[1];
        st[1] = st[0]; st[0] = x;
        yst[1] = yst[0]; yst[0] = y;
        out[i] = y;
      }
    }
    this.emit(startSample, n, outL, outR, offset);
  }
}

/**
 * Задержка без обратной связи: граф здесь считается «вперёд», поэтому петля
 * (задержка → гейн → задержка) ушла бы в бесконечную рекурсию. Сцене этого
 * хватает: пространство она собирает из нескольких отражений подряд.
 */
class DelayNode extends Node {
  constructor(ctx, maxDelay) {
    super(ctx);
    this.delayTime = new Param(0.5);
    this._size = Math.max(2, Math.ceil((maxDelay || 1) * ctx.sampleRate) + 1);
    this._lineL = new Float32Array(this._size);
    this._lineR = new Float32Array(this._size);
    this._write = 0;
    this._inL = new Float32Array(BLOCK);
    this._inR = new Float32Array(BLOCK);
  }

  finished() { return !this.persistent && this.inputs.length === 0; }

  pull(startSample, n, outL, outR, offset) {
    if (!this.inputs.length) return;
    if (this.cached(startSample, n)) { this.emit(startSample, n, outL, outR, offset); return; }
    this.beginBlock(startSample, n);
    this._inL.fill(0, 0, n);
    this._inR.fill(0, 0, n);
    for (const src of this.inputs) src.pull(startSample, n, this._inL, this._inR, 0);
    const ms = this.delayTime.at(startSample / this.sr);
    const back = Math.min(this._size - 1, Math.max(1, Math.round(Math.max(0.001, ms) * this.sr)));
    for (let i = 0; i < n; i++) {
      let read = this._write - back;
      if (read < 0) read += this._size;
      this._memoL[i] = this._lineL[read];
      this._memoR[i] = this._lineR[read];
      this._lineL[this._write] = this._inL[i];
      this._lineR[this._write] = this._inR[i];
      this._write = (this._write + 1) % this._size;
    }
    this.emit(startSample, n, outL, outR, offset);
  }
}

/** Волновая кривая: мягкий клип, ступени «бит-краша», любая окраска. */
class WaveShaperNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.curve = null;
    this._inL = new Float32Array(BLOCK);
    this._inR = new Float32Array(BLOCK);
  }

  finished() { return !this.persistent && this.inputs.length === 0; }

  pull(startSample, n, outL, outR, offset) {
    if (!this.inputs.length) return;
    if (this.cached(startSample, n)) { this.emit(startSample, n, outL, outR, offset); return; }
    this.beginBlock(startSample, n);
    this._inL.fill(0, 0, n);
    this._inR.fill(0, 0, n);
    for (const src of this.inputs) src.pull(startSample, n, this._inL, this._inR, 0);
    const c = this.curve;
    if (!c || c.length < 2) {
      for (let i = 0; i < n; i++) {
        this._memoL[i] = this._inL[i];
        this._memoR[i] = this._inR[i];
      }
      this.emit(startSample, n, outL, outR, offset);
      return;
    }
    const half = (c.length - 1) / 2;
    const top = c.length - 1;
    for (let i = 0; i < n; i++) {
      let k = this._inL[i];
      k = (k < -1 ? -1 : k > 1 ? 1 : k) * half + half;
      const k0 = Math.floor(k), k1 = k0 < top ? k0 + 1 : k0;
      this._memoL[i] = c[k0] + (c[k1] - c[k0]) * (k - k0);
      let j = this._inR[i];
      j = (j < -1 ? -1 : j > 1 ? 1 : j) * half + half;
      const j0 = Math.floor(j), j1 = j0 < top ? j0 + 1 : j0;
      this._memoR[i] = c[j0] + (c[j1] - c[j0]) * (j - j0);
    }
    this.emit(startSample, n, outL, outR, offset);
  }
}

/**
 * Панорама по правилу Web Audio для стерео-входа: на центре сигнал проходит
 * как есть, к краю перетекает в одно ухо. Формулы из спеки — чтобы в браузере
 * и в эфире звучало одинаково.
 */
class StereoPannerNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.pan = new Param(0);
    this._inL = new Float32Array(BLOCK);
    this._inR = new Float32Array(BLOCK);
  }

  finished() { return !this.persistent && this.inputs.length === 0; }

  pull(startSample, n, outL, outR, offset) {
    if (!this.inputs.length) return;
    if (this.cached(startSample, n)) { this.emit(startSample, n, outL, outR, offset); return; }
    this.beginBlock(startSample, n);
    this._inL.fill(0, 0, n);
    this._inR.fill(0, 0, n);
    for (const src of this.inputs) src.pull(startSample, n, this._inL, this._inR, 0);
    // Панорама за блок постоянна, а тригонометрию считаем один раз: раньше
    // и значение, и синус с косинусом брались на каждый сэмпл.
    const p = Math.min(1, Math.max(-1, this.pan.at(startSample / this.sr)));
    const x = (p <= 0 ? (p + 1) : p) * Math.PI * 0.5;
    const cs = Math.cos(x), sn = Math.sin(x);
    for (let i = 0; i < n; i++) {
      const l = this._inL[i], r = this._inR[i];
      if (p <= 0) {
        this._memoL[i] = l + r * cs;
        this._memoR[i] = r * sn;
      } else {
        this._memoL[i] = l * cs;
        this._memoR[i] = r + l * sn;
      }
    }
    this.emit(startSample, n, outL, outR, offset);
  }
}

class BufferSourceNode extends Node {
  constructor(ctx) {
    super(ctx);
    this.buffer = null;
    this._startS = -1;
  }

  start(t = this.ctx.currentTime) { this._startS = Math.round(t * this.sr); }
  stop() {}
  finished() {
    if (!this.buffer || this._startS < 0) return true;
    return this.ctx._pos >= this._startS + this.buffer.length;
  }

  pull(startSample, n, outL, outR, offset) {
    if (!this.buffer || this._startS < 0) return;
    if (this.cached(startSample, n)) { this.emit(startSample, n, outL, outR, offset); return; }
    this.beginBlock(startSample, n);
    const data = this.buffer.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const pos = startSample + i - this._startS;
      if (pos < 0) continue;
      if (pos >= data.length) break;
      const v = data[pos];
      this._memoL[i] = v;
      this._memoR[i] = v;
    }
    this.emit(startSample, n, outL, outR, offset);
  }
}

/**
 * Офлайн-контекст: умеет всё, что нужно сцене, и сводит звук по требованию.
 */
export function createOfflineAudio(sampleRate) {
  class OfflineAudioContext {
    constructor() {
      this.sampleRate = sampleRate;
      this.state = 'running';
      this._pos = 0;                 // часы движка в сэмплах
      this._alive = 0;               // узлов в графе: следим, чтобы не росли
      this.destination = new Destination(this);
      this.outL = new Float32Array(BLOCK);
      this.outR = new Float32Array(BLOCK);
    }

    get currentTime() { return this._pos / this.sampleRate; }

    /**
     * Сцена делает `new (window.AudioContext || window.webkitAudioContext)()`,
     * а контекст у неё ровно один: конструктор отдаёт уже собранный.
     */
    get AudioContext() {
      const self = this;
      return class { constructor() { return self; } };
    }

    _add(node) { this._alive++; return node; }

    createGain() { return this._add(new GainNode(this)); }
    createOscillator() { return this._add(new OscillatorNode(this)); }
    createBiquadFilter() { return this._add(new BiquadFilterNode(this)); }
    createBufferSource() { return this._add(new BufferSourceNode(this)); }
    createDelay(maxDelay) { return this._add(new DelayNode(this, maxDelay)); }
    createWaveShaper() { return this._add(new WaveShaperNode(this)); }
    createStereoPanner() { return this._add(new StereoPannerNode(this)); }

    createBuffer(channels, length, sampleRate) {
      const data = [];
      for (let i = 0; i < channels; i++) data.push(new Float32Array(length));
      return {
        numberOfChannels: channels,
        length,
        sampleRate,
        getChannelData: (i) => data[i],
      };
    }

    resume() { this.state = 'running'; }
    suspend() { this.state = 'suspended'; }
    close() { this.state = 'closed'; }

    /** Подсказка движку: эти узлы — шины микшера, их не убирать. */
    __persistent(node) { if (node) node.persistent = true; return node; }

    /** Сколько узлов сейчас в графе — для отчёта в логе эфира. */
    get nodeCount() { return this._alive; }

    /**
     * Сводит frames сэмплов. Возвращает два канала, которые источник
     * раскладывает в interleaved f32le и отдаёт в FFmpeg.
     */
    render(frames) {
      if (this.outL.length < frames) {
        this.outL = new Float32Array(frames);
        this.outR = new Float32Array(frames);
      }
      this.outL.fill(0, 0, frames);
      this.outR.fill(0, 0, frames);
      for (let done = 0; done < frames; done += BLOCK) {
        const n = Math.min(BLOCK, frames - done);
        this.destination.pull(this._pos, n, this.outL, this.outR, done);
        this._pos += n;
      }
      return { left: this.outL, right: this.outR, frames };
    }
  }

  return new OfflineAudioContext();
}

/* =====================================================
   Офлайн-версия Web Audio для эфира.

   В браузере звук игры собирает сам браузер: страница создаёт AudioContext,
   вешает на него осцилляторы и гейны, а тот сводит всё в колонки. В эфире
   страницы нет — есть Node и TCP, куда надо отдавать готовые сэмплы. Поэтому
   здесь живёт маленький движок, который понимает ровно тот набор Web Audio,
   что нужен сцене (см. AudioEngine в muxa.html): осцилляторы с автоматизацией
   частоты, гейны с огибающей, биквады, буферы шума и микширование в стерео.

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
        this.ctx._alive--;
      }
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
    this._bufL.fill(0, 0, n);
    this._bufR.fill(0, 0, n);
    for (const src of this.inputs) src.pull(startSample, n, this._bufL, this._bufR, 0);
    for (let i = 0; i < n; i++) {
      const k = Math.max(0, this.gain.at((startSample + i) / this.sr));
      outL[offset + i] += this._bufL[i] * k;
      outR[offset + i] += this._bufR[i] * k;
    }
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
    for (let i = 0; i < n; i++) {
      const s = startSample + i;
      if (s < this._startS) continue;
      if (this._stopS >= 0 && s >= this._stopS) break;
      const f = Math.max(0, this.frequency.at(s / this.sr));
      this.phase += f / this.sr;
      if (this.phase >= 1) this.phase -= Math.floor(this.phase);
      const v = this._wave(this.phase);
      outL[offset + i] += v;
      outR[offset + i] += v;
    }
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
      { in: this._bufL, out: outL, st: this._x[0], yst: this._y[0] },
      { in: this._bufR, out: outR, st: this._x[1], yst: this._y[1] },
    ];
    for (let c = 0; c < 2; c++) {
      const { in: src, out, st, yst } = chans[c];
      for (let i = 0; i < n; i++) {
        const x = src[i];
        const y = (b0 / a0) * x + (b1 / a0) * st[0] + (b2 / a0) * st[1]
          - (a1 / a0) * yst[0] - (a2 / a0) * yst[1];
        st[1] = st[0]; st[0] = x;
        yst[1] = yst[0]; yst[0] = y;
        out[offset + i] += y;
      }
    }
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
    const data = this.buffer.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const pos = startSample + i - this._startS;
      if (pos < 0) continue;
      if (pos >= data.length) break;
      const v = data[pos];
      outL[offset + i] += v;
      outR[offset + i] += v;
    }
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

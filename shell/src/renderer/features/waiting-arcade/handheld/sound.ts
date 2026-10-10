// 掌机音效：全部用 WebAudio 现场合成，不带音频文件。
// 按键是一声很短的带通噪声（塑料按键的「咔哒」），按下比松开更实；
// 游戏事件用方波小音符，模仿掌机蜂鸣器的音色。音量刻意压低。

import type { ScreenSound } from './screen';

type Note = [freq: number, startMs: number, durMs: number];

const SOUNDS: Record<ScreenSound, { wave: OscillatorType; gain: number; notes: Note[] }> = {
  boot: { wave: 'sine', gain: 0.07, notes: [[1046.5, 0, 140], [2093, 110, 520]] },
  move: { wave: 'square', gain: 0.025, notes: [[1318.5, 0, 35]] },
  confirm: { wave: 'square', gain: 0.03, notes: [[987.8, 0, 50], [1568, 50, 90]] },
  score: { wave: 'square', gain: 0.022, notes: [[1760, 0, 40], [2349, 35, 50]] },
  pause: { wave: 'square', gain: 0.025, notes: [[1568, 0, 60], [1046.5, 70, 80]] },
  over: { wave: 'square', gain: 0.03, notes: [[784, 0, 120], [622, 130, 120], [523, 260, 120], [392, 390, 300]] },
  bonus: { wave: 'square', gain: 0.024, notes: [[1318.5, 0, 45], [1661, 45, 45], [1976, 90, 80]] },
  levelup: { wave: 'square', gain: 0.028, notes: [[784, 0, 70], [988, 70, 70], [1175, 140, 70], [1568, 210, 180]] },
  hit: { wave: 'triangle', gain: 0.05, notes: [[660, 0, 25]] },
  tick: { wave: 'triangle', gain: 0.035, notes: [[1200, 0, 15]] },
  clear: { wave: 'square', gain: 0.026, notes: [[1046.5, 0, 50], [1318.5, 50, 50], [1568, 100, 110]] },
  big: { wave: 'square', gain: 0.03, notes: [[1046.5, 0, 60], [1318.5, 60, 60], [1568, 120, 60], [2093, 180, 260]] },
  lose: { wave: 'square', gain: 0.028, notes: [[523, 0, 90], [392, 100, 160]] },
};

export class HandheldSound {
  private ctx: AudioContext | null = null;
  private noise: AudioBuffer | null = null;

  constructor(private muted: boolean) {}

  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /** 必须在用户手势（点击「玩一把」/ 按键）里首次调用，浏览器才允许出声。 */
  private ensure(): AudioContext | null {
    if (this.muted) return null;
    if (!this.ctx) {
      const Ctor = typeof window !== 'undefined' ? window.AudioContext : undefined;
      if (!Ctor) return null;
      try {
        this.ctx = new Ctor();
      } catch {
        return null;
      }
      const length = Math.floor(this.ctx.sampleRate * 0.03);
      this.noise = this.ctx.createBuffer(1, length, this.ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  click(down: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = down ? 1800 : 3200;
    filter.Q.value = 1.4;
    const gain = ctx.createGain();
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(down ? 0.22 : 0.09, t);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + (down ? 0.028 : 0.018));
    src.connect(filter).connect(gain).connect(ctx.destination);
    src.start(t);
    src.stop(t + 0.03);
  }

  play(sound: ScreenSound): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const spec = SOUNDS[sound];
    const t0 = ctx.currentTime;
    for (const [freq, startMs, durMs] of spec.notes) {
      const osc = ctx.createOscillator();
      osc.type = spec.wave;
      osc.frequency.value = freq;
      const gain = ctx.createGain();
      const start = t0 + startMs / 1000;
      const end = start + durMs / 1000;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(spec.gain, start + 0.005);
      gain.gain.exponentialRampToValueAtTime(0.0001, end);
      osc.connect(gain).connect(ctx.destination);
      osc.start(start);
      osc.stop(end + 0.02);
    }
  }

  dispose(): void {
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
  }
}

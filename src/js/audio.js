// Audio engine: realtime scheduling for playback, offline mixdown for export,
// and the deterministic spectrum feed that drives the visualiser element.
//
// Video clips play their audio from the same decoded AudioBuffer the mixdown
// uses, so what you hear in the preview is exactly what gets exported.

import { getCtx, resumeCtx } from './media.js';
import { clipEnd, fadeAmount } from './store.js';
import { clamp } from './util.js';
import { magnitudes, toBands } from './fft.js';

const FFT_SIZE = 2048;

export function audibleClips(project, media) {
  const out = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      if (!clip.enabled) continue;
      if (clip.type !== 'audio' && clip.type !== 'video') continue;
      if (track.muted) continue;
      const asset = media.get(clip.assetId);
      if (!asset?.audioBuffer) continue;
      out.push({ clip, track, buffer: asset.audioBuffer });
    }
  }
  return out;
}

/** Schedule one clip onto a (realtime or offline) context. */
function scheduleClip(ctx, dest, { clip, track, buffer }, timelineStart, contextStart) {
  const end = clipEnd(clip);
  if (end <= timelineStart + 1e-4) return null;
  const startAt = Math.max(clip.start, timelineStart);
  const when = contextStart + (startAt - timelineStart);
  const rate = clip.speed || 1;
  const offset = clip.inPoint + (startAt - clip.start) * rate;
  const playDur = (end - startAt) * rate;
  if (offset >= buffer.duration) return null;

  const src = ctx.createBufferSource();
  src.buffer = buffer;
  src.playbackRate.value = rate;
  const g = ctx.createGain();
  src.connect(g).connect(dest);

  const base = clamp(clip.gain ?? 1, 0, 4) * clamp(track.volume ?? 1, 0, 4);
  const f = clip.fade || { in: 0, out: 0 };
  const p = g.gain;
  p.cancelScheduledValues(when);
  const atStart = base * fadeAmount(clip, startAt);
  p.setValueAtTime(atStart, when);
  if (f.in > 0 && startAt < clip.start + f.in) {
    p.linearRampToValueAtTime(base, contextStart + (clip.start + f.in - timelineStart));
  }
  if (f.out > 0) {
    const outStart = Math.max(startAt, end - f.out);
    p.setValueAtTime(base * fadeAmount(clip, outStart), contextStart + (outStart - timelineStart));
    p.linearRampToValueAtTime(0.0001, contextStart + (end - timelineStart));
  }
  src.start(when, offset, Math.min(playDur, Math.max(0, buffer.duration - offset)));
  return { src, gain: g };
}

export class AudioEngine {
  constructor(store, media) {
    this.store = store;
    this.media = media;
    this.nodes = [];
    this.master = null;
    this.muted = false;
    this.volume = 1;
    this._prevBands = new Map();
  }

  get ctx() {
    return getCtx();
  }

  ensureMaster() {
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
    }
    this.master.gain.value = this.muted ? 0 : this.volume;
    return this.master;
  }

  /** Start every audible clip in sync with timeline position `from`.
   *  `extraDest` lets a recorder tap the same mix (used by WebM export). */
  start(from, extraDest = null) {
    this.stop();
    resumeCtx();
    const dest = this.ensureMaster();
    if (extraDest) {
      this.master.connect(extraDest);
      this._extraDest = extraDest;
    }
    const t0 = this.ctx.currentTime + 0.06; // small lead-in so nothing clips
    this.contextStart = t0;
    this.timelineStart = from;
    for (const entry of audibleClips(this.store.project, this.media)) {
      const n = scheduleClip(this.ctx, dest, entry, from, t0);
      if (n) this.nodes.push(n);
    }
    return t0;
  }

  stop() {
    if (this._extraDest) {
      try {
        this.master.disconnect(this._extraDest);
      } catch {}
      this._extraDest = null;
    }
    for (const n of this.nodes) {
      try {
        n.src.stop();
      } catch {}
      try {
        n.src.disconnect();
        n.gain.disconnect();
      } catch {}
    }
    this.nodes.length = 0;
  }

  setVolume(v) {
    this.volume = clamp(v, 0, 2);
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }
  setMuted(m) {
    this.muted = !!m;
    if (this.master) this.master.gain.value = this.muted ? 0 : this.volume;
  }

  resetSmoothing() {
    this._prevBands.clear();
  }

  /**
   * Normalised spectrum bands at time t for a visualiser clip. Reads straight
   * from the decoded buffers, so it is identical in preview and export.
   */
  spectrumAt(t, clip) {
    const v = clip.visualizer;
    const bars = v.bars;
    const sr = this.store.project.sampleRate || 48000;
    const win = new Float32Array(FFT_SIZE);
    let any = false;

    for (const entry of audibleClips(this.store.project, this.media)) {
      const { clip: ac, track, buffer } = entry;
      if (v.source !== 'master' && ac.assetId !== v.source) continue;
      if (t < ac.start || t >= clipEnd(ac)) continue;
      const rate = ac.speed || 1;
      const srcT = ac.inPoint + (t - ac.start) * rate;
      const g = clamp(ac.gain ?? 1, 0, 4) * clamp(track.volume ?? 1, 0, 4) * fadeAmount(ac, t);
      if (g <= 0.0001) continue;
      const bsr = buffer.sampleRate;
      const centre = Math.floor(srcT * bsr);
      const start = centre - FFT_SIZE / 2;
      const chans = Math.min(2, buffer.numberOfChannels);
      for (let c = 0; c < chans; c++) {
        const data = buffer.getChannelData(c);
        const k = g / chans;
        for (let i = 0; i < FFT_SIZE; i++) {
          const idx = start + i;
          if (idx >= 0 && idx < data.length) win[i] += data[idx] * k;
        }
      }
      any = true;
    }

    const key = clip.id;
    if (!any) {
      const prev = this._prevBands.get(key);
      if (!prev) return new Float32Array(bars);
      for (let i = 0; i < prev.length; i++) prev[i] *= 0.82;
      return prev;
    }
    const mags = magnitudes(win);
    const bands = toBands(mags, sr, bars, v.minFreq, v.maxFreq, v.floorDb, v.gain);
    const prev = this._prevBands.get(key);
    const s = clamp(v.smoothing, 0, 0.95);
    if (prev && prev.length === bars && s > 0) {
      for (let i = 0; i < bars; i++) {
        // attack fast, release slow -- reads much better on a trailer
        bands[i] = bands[i] > prev[i] ? bands[i] : prev[i] * s + bands[i] * (1 - s);
      }
    }
    this._prevBands.set(key, bands);
    return bands;
  }

  /** Render the whole timeline (or a range) to a single AudioBuffer. */
  async mixdown(from = 0, to = null) {
    const project = this.store.project;
    const sr = project.sampleRate || 48000;
    const end = to ?? Math.max(0.001, this.store.duration());
    const length = Math.max(1, Math.ceil((end - from) * sr));
    const off = new OfflineAudioContext(2, length, sr);
    const master = off.createGain();
    master.gain.value = 1;
    master.connect(off.destination);
    for (const entry of audibleClips(project, this.media)) {
      scheduleClip(off, master, entry, from, 0);
    }
    return off.startRendering();
  }
}

/** 16-bit PCM WAV. */
export function encodeWav(buffer) {
  const chans = buffer.numberOfChannels;
  const len = buffer.length;
  const bytes = 44 + len * chans * 2;
  const ab = new ArrayBuffer(bytes);
  const dv = new DataView(ab);
  const str = (off, s) => {
    for (let i = 0; i < s.length; i++) dv.setUint8(off + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  dv.setUint32(4, bytes - 8, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, chans, true);
  dv.setUint32(24, buffer.sampleRate, true);
  dv.setUint32(28, buffer.sampleRate * chans * 2, true);
  dv.setUint16(32, chans * 2, true);
  dv.setUint16(34, 16, true);
  str(36, 'data');
  dv.setUint32(40, len * chans * 2, true);
  const data = [];
  for (let c = 0; c < chans; c++) data.push(buffer.getChannelData(c));
  let off = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < chans; c++) {
      const s = clamp(data[c][i], -1, 1);
      dv.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      off += 2;
    }
  }
  return new Blob([ab], { type: 'audio/wav' });
}

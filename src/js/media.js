// Asset library: import files, probe them, decode audio, build waveform peaks
// and thumbnails. Assets are kept out of the undo history (they hold blobs).

import { uid, emitter, fmtBytes } from './util.js';

export const PEAK_RATE = 400; // peak buckets per second

let _ctx = null;
export function getCtx() {
  if (!_ctx) {
    _ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  }
  return _ctx;
}
export const resumeCtx = () => {
  const c = getCtx();
  if (c.state === 'suspended') c.resume();
  return c;
};

export const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|avif)$/i;
export const VIDEO_RE = /\.(mp4|webm|mov|m4v|mkv|ogv)$/i;
export const AUDIO_RE = /\.(mp3|wav|ogg|m4a|aac|flac|opus)$/i;

export function kindOf(file) {
  const t = file.type || '';
  if (t.startsWith('image/')) return 'image';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('audio/')) return 'audio';
  if (IMAGE_RE.test(file.name)) return 'image';
  if (VIDEO_RE.test(file.name)) return 'video';
  if (AUDIO_RE.test(file.name)) return 'audio';
  return null;
}

export class MediaLibrary {
  constructor() {
    this.assets = new Map();
    this.bus = emitter();
    this._videoPool = new Map(); // clipId -> HTMLVideoElement
  }
  on(e, f) {
    return this.bus.on(e, f);
  }
  list() {
    return [...this.assets.values()];
  }
  get(id) {
    return this.assets.get(id) || null;
  }

  async importFiles(files) {
    const out = [];
    for (const file of files) {
      const kind = kindOf(file);
      if (!kind) {
        this.bus.emit('error', `Unsupported file: ${file.name}`);
        continue;
      }
      try {
        out.push(await this.importFile(file, kind));
      } catch (err) {
        console.error(err);
        this.bus.emit('error', `Could not read ${file.name}`);
      }
    }
    this.bus.emit('change');
    return out;
  }

  async importFile(file, kind = kindOf(file)) {
    const asset = {
      id: uid('asset'),
      name: file.name,
      kind,
      file,
      url: URL.createObjectURL(file),
      size: file.size,
      sizeLabel: fmtBytes(file.size),
      width: 0,
      height: 0,
      duration: 0,
      el: null,
      audioBuffer: null,
      peaks: null,
      thumb: null,
      hasAudio: false,
    };
    if (kind === 'image') await loadImageAsset(asset);
    if (kind === 'video') await loadVideoAsset(asset);
    if (kind === 'audio') await loadAudioAsset(asset);
    this.assets.set(asset.id, asset);
    this.bus.emit('change');

    // Decoding audio for waveforms is slow; do it after the asset appears.
    if (kind === 'audio' || kind === 'video') {
      decodeAudio(asset)
        .then(() => this.bus.emit('change'))
        .catch(() => {});
    }
    return asset;
  }

  remove(id) {
    const a = this.assets.get(id);
    if (!a) return;
    URL.revokeObjectURL(a.url);
    this.assets.delete(id);
    this.bus.emit('change');
  }

  /** A dedicated <video> per clip so overlapping uses of one asset stay independent. */
  videoFor(clip) {
    let v = this._videoPool.get(clip.id);
    if (v && v.dataset.assetId === clip.assetId) return v;
    const asset = this.get(clip.assetId);
    if (!asset || asset.kind !== 'video') return null;
    v = document.createElement('video');
    v.src = asset.url;
    v.dataset.assetId = asset.id;
    v.preload = 'auto';
    v.muted = true; // audio is routed through the Web Audio graph instead
    v.playsInline = true;
    v.crossOrigin = 'anonymous';
    this._videoPool.set(clip.id, v);
    return v;
  }

  releaseVideo(clipId) {
    const v = this._videoPool.get(clipId);
    if (v) {
      v.pause();
      v.removeAttribute('src');
      v.load();
    }
    this._videoPool.delete(clipId);
  }
}

function loadImageAsset(asset) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => {
      asset.el = img;
      asset.width = img.naturalWidth;
      asset.height = img.naturalHeight;
      asset.thumb = makeThumb(img, img.naturalWidth, img.naturalHeight);
      res(asset);
    };
    img.onerror = () => rej(new Error('image decode failed'));
    img.src = asset.url;
  });
}

function loadVideoAsset(asset) {
  return new Promise((res, rej) => {
    const v = document.createElement('video');
    v.preload = 'auto';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () => {
      asset.el = v;
      asset.width = v.videoWidth;
      asset.height = v.videoHeight;
      asset.duration = Number.isFinite(v.duration) ? v.duration : 0;
      const grab = () => {
        asset.thumb = makeThumb(v, v.videoWidth, v.videoHeight);
        res(asset);
      };
      v.onseeked = grab;
      try {
        v.currentTime = Math.min(0.2, (asset.duration || 1) * 0.1);
      } catch {
        grab();
      }
      setTimeout(() => res(asset), 2500);
    };
    v.onerror = () => rej(new Error('video load failed'));
    v.src = asset.url;
  });
}

async function loadAudioAsset(asset) {
  await new Promise((res) => {
    const a = document.createElement('audio');
    a.preload = 'metadata';
    a.onloadedmetadata = () => {
      asset.duration = Number.isFinite(a.duration) ? a.duration : 0;
      res();
    };
    a.onerror = () => res();
    a.src = asset.url;
    setTimeout(res, 4000);
  });
  return asset;
}

async function decodeAudio(asset) {
  if (asset.audioBuffer) return asset.audioBuffer;
  const buf = await asset.file.arrayBuffer();
  const ctx = getCtx();
  const decoded = await ctx.decodeAudioData(buf.slice(0));
  asset.audioBuffer = decoded;
  asset.hasAudio = decoded.numberOfChannels > 0 && decoded.length > 0;
  if (!asset.duration) asset.duration = decoded.duration;
  asset.peaks = computePeaks(decoded, PEAK_RATE);
  return decoded;
}

/** Interleaved [min,max] pairs per bucket, mixed down to mono. */
export function computePeaks(buffer, rate = PEAK_RATE) {
  const per = Math.max(1, Math.round(buffer.sampleRate / rate));
  const buckets = Math.ceil(buffer.length / per);
  const out = new Float32Array(buckets * 2);
  const chans = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
  const inv = 1 / chans.length;
  for (let b = 0; b < buckets; b++) {
    let lo = 1;
    let hi = -1;
    const s0 = b * per;
    const s1 = Math.min(buffer.length, s0 + per);
    for (let i = s0; i < s1; i++) {
      let v = 0;
      for (let c = 0; c < chans.length; c++) v += chans[c][i];
      v *= inv;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (s1 <= s0) {
      lo = 0;
      hi = 0;
    }
    out[b * 2] = lo;
    out[b * 2 + 1] = hi;
  }
  return out;
}

function makeThumb(source, w, h, max = 160) {
  if (!w || !h) return null;
  const k = Math.min(max / w, max / h, 1);
  const cv = document.createElement('canvas');
  cv.width = Math.max(1, Math.round(w * k));
  cv.height = Math.max(1, Math.round(h * k));
  const g = cv.getContext('2d');
  g.imageSmoothingQuality = 'high';
  try {
    g.drawImage(source, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/png');
  } catch {
    return null;
  }
}

export const media = new MediaLibrary();

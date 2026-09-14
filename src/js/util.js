export const uid = (p = 'id') => `${p}_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;
export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;

export function fmtTime(sec, fps = 30, withFrames = true) {
  const neg = sec < 0;
  let s = Math.max(0, Math.abs(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const f = Math.min(fps - 1, Math.floor((s % 1) * fps + 1e-6));
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const base = h > 0 ? `${pad(h)}:${pad(m)}:${pad(ss)}` : `${pad(m)}:${pad(ss)}`;
  return `${neg ? '-' : ''}${base}${withFrames ? `:${pad(f)}` : ''}`;
}

export function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

export const EASINGS = {
  linear: (t) => t,
  easeIn: (t) => t * t,
  easeOut: (t) => 1 - (1 - t) * (1 - t),
  easeInOut: (t) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2),
  smoothStep: (t) => t * t * (3 - 2 * t),
};
export const EASING_LABELS = {
  linear: 'Linear',
  easeIn: 'Ease in',
  easeOut: 'Ease out',
  easeInOut: 'Ease in-out',
  easeInOutCubic: 'Ease in-out (strong)',
  smoothStep: 'Smooth step',
};
export const ease = (name, t) => (EASINGS[name] || EASINGS.linear)(clamp(t, 0, 1));

/** Tiny event bus. */
export function emitter() {
  const map = new Map();
  return {
    on(evt, fn) {
      if (!map.has(evt)) map.set(evt, new Set());
      map.get(evt).add(fn);
      return () => map.get(evt)?.delete(fn);
    },
    emit(evt, payload) {
      map.get(evt)?.forEach((fn) => fn(payload));
      map.get('*')?.forEach((fn) => fn(evt, payload));
    },
  };
}

export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [prop, val] of Object.entries(v)) {
        if (prop.startsWith('--')) n.style.setProperty(prop, val);
        else n.style[prop] = val;
      }
    }
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'dataset') Object.assign(n.dataset, v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return n;
}

/** Drag helper: onMove receives {dx,dy,x,y,e}; returns cleanup automatically. */
export function drag(startEvent, { onMove, onEnd, cursor } = {}) {
  startEvent.preventDefault();
  const x0 = startEvent.clientX;
  const y0 = startEvent.clientY;
  const prevCursor = document.body.style.cursor;
  const prevSelect = document.body.style.userSelect;
  if (cursor) document.body.style.cursor = cursor;
  document.body.style.userSelect = 'none';
  let moved = false;
  const move = (e) => {
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
    onMove?.({ dx, dy, x: e.clientX, y: e.clientY, e });
  };
  const up = (e) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    document.body.style.cursor = prevCursor;
    document.body.style.userSelect = prevSelect;
    onEnd?.({ moved, e });
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 20_000);
}

export const deepClone = (o) => (typeof structuredClone === 'function' ? structuredClone(o) : JSON.parse(JSON.stringify(o)));

// --- light ------------------------------------------------------------------
// sRGB is a storage curve, not a measure of light: byte 128 carries about 22% of
// the light of byte 255, not half of it. Anything that averages pixels — a
// shutter integrating an exposure, a blur kernel — has to do it on light.
export const TO_LIGHT = new Float32Array(256);
for (let i = 0; i < 256; i++) {
  const c = i / 255;
  TO_LIGHT[i] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}
// Back again, off a table because the curve is far too slow to run per pixel.
export const TO_BYTE = new Uint8ClampedArray(4096);
for (let i = 0; i < 4096; i++) {
  const c = i / 4095;
  TO_BYTE[i] = Math.round(255 * (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055));
}

/**
 * A separable Gaussian, in linear light, returning a new canvas.
 *
 * This exists to be run on a source image *before* it is translated by a
 * fraction of a pixel. Detail finer than the sampling grid has no stable
 * representation at a fractional offset, so it pulses as the offset walks
 * across a pixel — text and hairlines crawl on a slow pan. Taking that detail
 * out first costs a little sharpness and buys a picture that holds still.
 *
 * Sub-pixel sigmas are the point, so this cannot be `ctx.filter = 'blur()'`:
 * Chromium rounds that to whole pixels, where 0.5 px is a no-op and 1 px takes
 * a third of the detail with it.
 */
export function soften(source, sigma) {
  const w = source.naturalWidth || source.width;
  const h = source.naturalHeight || source.height;
  if (!(sigma > 0) || !w || !h) return source;

  const read = document.createElement('canvas');
  read.width = w;
  read.height = h;
  const rg = read.getContext('2d', { alpha: false });
  rg.drawImage(source, 0, 0);
  const src = rg.getImageData(0, 0, w, h).data;

  const rad = Math.max(1, Math.ceil(sigma * 3));
  const k = new Float32Array(rad * 2 + 1);
  let sum = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + rad] = v;
    sum += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= sum;

  const lin = new Float32Array(w * h * 3);
  for (let p = 0, q = 0; p < src.length; p += 4, q += 3) {
    lin[q] = TO_LIGHT[src[p]];
    lin[q + 1] = TO_LIGHT[src[p + 1]];
    lin[q + 2] = TO_LIGHT[src[p + 2]];
  }
  const tmp = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = -rad; i <= rad; i++) {
        const o = (y * w + clamp(x + i, 0, w - 1)) * 3;
        const wt = k[i + rad];
        r += lin[o] * wt; g += lin[o + 1] * wt; b += lin[o + 2] * wt;
      }
      const o = (y * w + x) * 3;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b;
    }
  }
  const out = document.createElement('canvas');
  out.width = w;
  out.height = h;
  const og = out.getContext('2d', { alpha: false });
  const img = og.createImageData(w, h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let i = -rad; i <= rad; i++) {
        const o = (clamp(y + i, 0, h - 1) * w + x) * 3;
        const wt = k[i + rad];
        r += tmp[o] * wt; g += tmp[o + 1] * wt; b += tmp[o + 2] * wt;
      }
      const p = (y * w + x) * 4;
      img.data[p] = TO_BYTE[(r * 4095) | 0];
      img.data[p + 1] = TO_BYTE[(g * 4095) | 0];
      img.data[p + 2] = TO_BYTE[(b * 4095) | 0];
      img.data[p + 3] = 255;
    }
  }
  og.putImageData(img, 0, 0);
  return out;
}

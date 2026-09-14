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

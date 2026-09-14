// Iterative radix-2 FFT + a Hann window, used to drive the audio visualiser.
// Deterministic and offline-safe, so the exported video matches the preview.

const cache = new Map();

function tables(n) {
  let t = cache.get(n);
  if (t) return t;
  const cos = new Float32Array(n / 2);
  const sin = new Float32Array(n / 2);
  const rev = new Uint32Array(n);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((-2 * Math.PI * i) / n);
    sin[i] = Math.sin((-2 * Math.PI * i) / n);
  }
  const bits = Math.log2(n) | 0;
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const win = new Float32Array(n);
  for (let i = 0; i < n; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (n - 1)));
  t = { cos, sin, rev, win };
  cache.set(n, t);
  return t;
}

export function hann(n) {
  return tables(n).win;
}

/** In-place complex FFT. re/im are Float32Array(n), n a power of two. */
export function fft(re, im) {
  const n = re.length;
  const { cos, sin, rev } = tables(n);
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let tmp = re[i];
      re[i] = re[j];
      re[j] = tmp;
      tmp = im[i];
      im[i] = im[j];
      im[j] = tmp;
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let i = 0; i < n; i += size) {
      for (let j = i, k = 0; j < i + half; j++, k += step) {
        const l = j + half;
        const tre = re[l] * cos[k] - im[l] * sin[k];
        const tim = re[l] * sin[k] + im[l] * cos[k];
        re[l] = re[j] - tre;
        im[l] = im[j] - tim;
        re[j] += tre;
        im[j] += tim;
      }
    }
  }
}

/**
 * Magnitude spectrum (linear, normalised by window size) for a mono block.
 * Returns Float32Array(n/2).
 */
export function magnitudes(samples) {
  const n = samples.length;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  const w = hann(n);
  for (let i = 0; i < n; i++) re[i] = samples[i] * w[i];
  fft(re, im);
  const out = new Float32Array(n / 2);
  const norm = 2 / n;
  for (let i = 0; i < n / 2; i++) out[i] = Math.hypot(re[i], im[i]) * norm;
  return out;
}

/**
 * Fold a magnitude spectrum into `bars` log-spaced bands, converted to a
 * normalised 0..1 height using a dB floor.
 */
export function toBands(mags, sampleRate, bars, minFreq, maxFreq, floorDb, gain) {
  const out = new Float32Array(bars);
  const binHz = sampleRate / (mags.length * 2);
  const lo = Math.log(Math.max(20, minFreq));
  const hi = Math.log(Math.max(minFreq + 1, maxFreq));
  for (let b = 0; b < bars; b++) {
    const f0 = Math.exp(lo + ((hi - lo) * b) / bars);
    const f1 = Math.exp(lo + ((hi - lo) * (b + 1)) / bars);
    let i0 = Math.floor(f0 / binHz);
    let i1 = Math.ceil(f1 / binHz);
    i0 = Math.max(1, Math.min(mags.length - 1, i0));
    i1 = Math.max(i0 + 1, Math.min(mags.length, i1));
    let peak = 0;
    for (let i = i0; i < i1; i++) if (mags[i] > peak) peak = mags[i];
    // gentle high-frequency lift so the top end stays visible
    const tilt = 1 + 1.8 * (b / bars);
    const db = 20 * Math.log10(peak * tilt * gain + 1e-9);
    out[b] = Math.max(0, Math.min(1, (db - floorDb) / -floorDb));
  }
  return out;
}

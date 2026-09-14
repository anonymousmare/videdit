// The compositor. Everything you see in the preview and everything that lands
// in an export goes through render(). It is deliberately side-effect free so
// preview and export produce identical frames.
//
// THE RULE: source pixels are never resized to fit the canvas. A clip's scale
// defaults to 1 and the frame simply crops whatever falls outside it.

import { clipEnd, fadeAmount, transformAt, hasMotion } from './store.js';
import { clamp } from './util.js';

export class Renderer {
  /** @param {{canvas:HTMLCanvasElement, store:object, media:object, spectrum?:Function}} o */
  constructor({ canvas, store, media, spectrum = null }) {
    this.canvas = canvas;
    this.store = store;
    this.media = media;
    this.spectrum = spectrum;
    // Sub-pixel prefilter applied to moving stills. The preview gets this effect
    // for free by being displayed fitted to its pane; a frame written at 1:1
    // does not, so the export asks for it explicitly.
    this.motionSoftness = 0;
    this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
    this.syncSize();
  }

  syncSize() {
    const { width, height } = this.store.project;
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
  }

  /** Clips that should be on screen at absolute time t, bottom track first. */
  visibleClips(t) {
    const out = [];
    const tracks = this.store.project.tracks;
    for (let i = tracks.length - 1; i >= 0; i--) {
      const tr = tracks[i];
      if (tr.kind !== 'video' || tr.hidden) continue;
      for (const c of tr.clips) {
        if (!c.enabled) continue;
        if (t >= c.start - 1e-6 && t < clipEnd(c) - 1e-6) out.push({ clip: c, track: tr });
      }
    }
    return out;
  }

  render(t = this.store.playhead) {
    this.syncSize();
    const { ctx } = this;
    const p = this.store.project;
    ctx.save();
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.fillStyle = p.background || '#000';
    ctx.fillRect(0, 0, p.width, p.height);

    let veil = { a: 0, color: '#000000' };
    for (const { clip } of this.visibleClips(t)) {
      const f = fadeAmount(clip, t);
      if (clip.fade?.mode === 'black' && f < 1) {
        const a = 1 - f;
        if (a > veil.a) veil = { a, color: clip.fade.color || '#000000' };
      }
      const alpha = clip.opacity * (clip.fade?.mode === 'opacity' ? f : 1);
      if (alpha <= 0.0005) continue;
      this.drawClip(clip, t, alpha);
    }

    if (veil.a > 0.0005) {
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = clamp(veil.a, 0, 1);
      ctx.fillStyle = veil.color;
      ctx.fillRect(0, 0, p.width, p.height);
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  }

  drawClip(clip, t, alpha) {
    const { ctx } = this;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.globalCompositeOperation = clip.blend || 'source-over';
    try {
      if (clip.type === 'image' || clip.type === 'video') this.drawMedia(clip, t);
      else if (clip.type === 'text') this.drawText(clip, t);
      else if (clip.type === 'visualizer') this.drawVisualizer(clip, t);
    } catch (err) {
      console.warn('draw failed', clip.type, err);
    }
    ctx.restore();
  }

  /** Source rectangle after cropping, in source pixels. */
  static sourceRect(clip, srcW, srcH) {
    const cr = clip.crop || { top: 0, right: 0, bottom: 0, left: 0 };
    const sx = clamp(cr.left, 0, srcW - 1);
    const sy = clamp(cr.top, 0, srcH - 1);
    const sw = clamp(srcW - cr.right - sx, 1, srcW - sx);
    const sh = clamp(srcH - cr.bottom - sy, 1, srcH - sy);
    return { sx, sy, sw, sh };
  }

  /**
   * Destination box in canvas pixels. Used for drawing AND for preview handles.
   * Pass `{ snapPixels: false }` for the true sub-pixel box — alignment
   * snapping works in that space, so that a box whose width is fractional
   * still lands dead on the guide instead of half a pixel beside it.
   */
  boxFor(clip, t, { snapPixels = true } = {}) {
    const src = this.sourceSizeOf(clip);
    if (!src) return null;
    const { sw, sh } = Renderer.sourceRect(clip, src.w, src.h);
    const tr = transformAt(clip, t);
    const p = this.store.project;
    const dw = sw * tr.scale;
    const dh = sh * tr.scale;
    let left = p.width / 2 + tr.x - dw / 2;
    let top = p.height / 2 + tr.y - dh / 2;
    // Pixel snap keeps a still screenshot bit-exact. On a moving clip it does
    // the opposite of what it promises: a pan travelling 0.8 px per frame comes
    // out as hold, jump, jump, hold — a stepped crawl rather than a glide. So
    // stills stay snapped and motion runs at subpixel precision.
    if (snapPixels && clip.pixelSnap && !tr.rotation && !hasMotion(clip)) {
      left = Math.round(left);
      top = Math.round(top);
    }
    return { left, top, w: dw, h: dh, rotation: tr.rotation, cx: left + dw / 2, cy: top + dh / 2 };
  }

  sourceSizeOf(clip) {
    if (clip.type === 'image' || clip.type === 'video') {
      const a = this.media.get(clip.assetId);
      if (!a || !a.width) return null;
      return { w: a.width, h: a.height };
    }
    if (clip.type === 'visualizer') return { w: clip.visualizer.width, h: clip.visualizer.height };
    if (clip.type === 'text') {
      const m = this.measureText(clip);
      return { w: m.width, h: m.height };
    }
    return null;
  }

  drawMedia(clip, t) {
    const { ctx } = this;
    const asset = this.media.get(clip.assetId);
    if (!asset) return;
    const moving = hasMotion(clip);
    let source = asset.el;
    if (clip.type === 'video') {
      source = this.media.videoFor(clip) || asset.el;
      if (!source || source.readyState < 2) return;
    } else if (moving && this.motionSoftness > 0) {
      source = this.media.softened(clip.assetId, this.motionSoftness) || source;
    }
    if (!source) return;
    const srcW = clip.type === 'video' ? source.videoWidth || asset.width : asset.width;
    const srcH = clip.type === 'video' ? source.videoHeight || asset.height : asset.height;
    if (!srcW || !srcH) return;

    const { sx, sy, sw, sh } = Renderer.sourceRect(clip, srcW, srcH);
    const box = this.boxFor(clip, t);
    if (!box) return;

    // A moving clip lands on fractional pixels, and nearest-neighbour would
    // snap it straight back onto whole texels — undoing the subpixel placement
    // and putting the stepping right back. Smooth what moves, leave stills hard.
    ctx.imageSmoothingEnabled = !!clip.smooth || moving;
    if (ctx.imageSmoothingEnabled) ctx.imageSmoothingQuality = 'high';

    const flipX = clip.flipX ? -1 : 1;
    const flipY = clip.flipY ? -1 : 1;
    if (box.rotation || clip.flipX || clip.flipY) {
      ctx.translate(box.cx, box.cy);
      ctx.rotate((box.rotation * Math.PI) / 180);
      ctx.scale(flipX, flipY);
      ctx.drawImage(source, sx, sy, sw, sh, -box.w / 2, -box.h / 2, box.w, box.h);
    } else {
      // Axis-aligned. A still clip sits on an integer position here, so this
      // stays an exact 1:1 texel copy; a moving one carries its fractional offset.
      ctx.drawImage(source, sx, sy, sw, sh, box.left, box.top, box.w, box.h);
    }
  }

  // --- text ---------------------------------------------------------------
  fontString(ts) {
    return `${ts.italic ? 'italic ' : ''}${ts.weight} ${ts.size}px ${ts.font}`;
  }

  layoutText(clip) {
    const ts = clip.text;
    const { ctx } = this;
    ctx.save();
    ctx.font = this.fontString(ts);
    const paras = String(ts.content ?? '').split('\n');
    const lines = [];
    for (const para of paras) {
      if (!ts.maxWidth) {
        lines.push(para);
        continue;
      }
      const words = para.split(/(\s+)/);
      let cur = '';
      for (const w of words) {
        const test = cur + w;
        if (measure(ctx, test, ts.letterSpacing) > ts.maxWidth && cur.trim()) {
          lines.push(cur.trimEnd());
          cur = w.trimStart();
        } else {
          cur = test;
        }
      }
      lines.push(cur.trimEnd());
    }
    const widths = lines.map((l) => measure(ctx, l, ts.letterSpacing));
    ctx.restore();
    const lineH = ts.size * ts.lineHeight;
    // A wrap width is a COLUMN, not just a limit: the block keeps that width
    // even when the text falls short of it, which is the only thing that gives
    // left/centre/right anywhere to align to. Without one the block shrinks to
    // the longest line, so alignment only shifts the shorter lines under it.
    const content = Math.max(1, ...widths);
    const width = ts.maxWidth > 0 ? Math.max(ts.maxWidth, content) : content;
    return { lines, widths, lineH, width, height: Math.max(1, lines.length * lineH) };
  }

  measureText(clip) {
    const l = this.layoutText(clip);
    const ts = clip.text;
    const pad = ts.box?.enabled ? { x: ts.box.padX, y: ts.box.padY } : { x: 0, y: 0 };
    return { width: l.width + pad.x * 2, height: l.height + pad.y * 2, layout: l, pad };
  }

  drawText(clip, t) {
    const { ctx } = this;
    const ts = clip.text;
    const p = this.store.project;
    const m = this.measureText(clip);
    const tr = transformAt(clip, t);
    const w = m.width * tr.scale;
    const h = m.height * tr.scale;
    let left = p.width / 2 + tr.x - w / 2;
    let top = p.height / 2 + tr.y - h / 2;
    if (clip.pixelSnap && !tr.rotation && !hasMotion(clip)) {
      left = Math.round(left);
      top = Math.round(top);
    }
    ctx.translate(left + w / 2, top + h / 2);
    if (tr.rotation) ctx.rotate((tr.rotation * Math.PI) / 180);
    ctx.scale(tr.scale, tr.scale);
    ctx.translate(-m.width / 2, -m.height / 2);

    if (ts.box?.enabled) {
      ctx.save();
      ctx.globalAlpha *= clamp(ts.box.opacity, 0, 1);
      ctx.fillStyle = ts.box.color;
      roundRect(ctx, 0, 0, m.width, m.height, ts.box.radius);
      ctx.fill();
      ctx.restore();
    }

    ctx.font = this.fontString(ts);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    const { lines, widths, lineH } = m.layout;

    for (let i = 0; i < lines.length; i++) {
      const lw = widths[i];
      let x = m.pad.x;
      if (ts.align === 'center') x = (m.width - lw) / 2;
      else if (ts.align === 'right') x = m.width - m.pad.x - lw;
      const y = m.pad.y + i * lineH + lineH / 2;

      if (ts.shadow?.enabled) {
        ctx.save();
        ctx.shadowColor = withAlpha(ts.shadow.color, ts.shadow.opacity);
        ctx.shadowBlur = ts.shadow.blur;
        ctx.shadowOffsetX = ts.shadow.offsetX;
        ctx.shadowOffsetY = ts.shadow.offsetY;
        // Paint once purely to lay down the shadow, then again cleanly on top
        // so the glyph edges stay sharp instead of muddied by the blur.
        ctx.fillStyle = ts.color;
        drawLine(ctx, lines[i], x, y, ts.letterSpacing, 'fill');
        ctx.restore();
      }
      if (ts.stroke?.enabled && ts.stroke.width > 0) {
        ctx.lineJoin = 'round';
        ctx.lineWidth = ts.stroke.width;
        ctx.strokeStyle = ts.stroke.color;
        drawLine(ctx, lines[i], x, y, ts.letterSpacing, 'stroke');
      }
      ctx.fillStyle = ts.color;
      drawLine(ctx, lines[i], x, y, ts.letterSpacing, 'fill');
    }
  }

  // --- audio visualiser ----------------------------------------------------
  drawVisualizer(clip, t) {
    const { ctx } = this;
    const v = clip.visualizer;
    const bands = this.spectrum ? this.spectrum(t, clip) : null;
    const box = this.boxFor(clip, t);
    if (!box) return;
    const n = v.bars;
    const data = bands && bands.length === n ? bands : new Float32Array(n);

    ctx.translate(box.cx, box.cy);
    if (box.rotation) ctx.rotate((box.rotation * Math.PI) / 180);
    ctx.translate(-box.w / 2, -box.h / 2);
    const sc = box.w / v.width;
    ctx.scale(sc, box.h / v.height);

    const W = v.width;
    const H = v.height;
    const grad = ctx.createLinearGradient(0, H, 0, 0);
    grad.addColorStop(0, v.color);
    grad.addColorStop(1, v.color2);
    ctx.fillStyle = grad;
    ctx.strokeStyle = grad;
    if (v.glow > 0) {
      ctx.shadowColor = withAlpha(v.color2, 0.65);
      ctx.shadowBlur = v.glow;
    }

    if (v.style === 'bars' || v.style === 'mirror') {
      const slot = W / n;
      const bw = Math.max(1, slot * (1 - v.gap));
      for (let i = 0; i < n; i++) {
        const mag = data[i];
        const x = i * slot + (slot - bw) / 2;
        if (v.style === 'mirror') {
          const half = (H / 2) * mag;
          roundRect(ctx, x, H / 2 - half, bw, Math.max(1, half * 2), Math.min(v.radius, bw / 2));
        } else {
          const bh = Math.max(1, H * mag);
          roundRect(ctx, x, H - bh, bw, bh, Math.min(v.radius, bw / 2));
        }
        ctx.fill();
      }
    } else if (v.style === 'line') {
      ctx.lineWidth = Math.max(1.5, H * 0.012);
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H - Math.max(1, H * data[i]);
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.stroke();
    } else if (v.style === 'radial') {
      const r0 = Math.min(W, H) * 0.22;
      const r1 = Math.min(W, H) * 0.48;
      ctx.lineWidth = Math.max(1.5, ((2 * Math.PI * r0) / n) * (1 - v.gap));
      ctx.lineCap = 'round';
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2 - Math.PI / 2;
        const len = r0 + (r1 - r0) * data[i];
        ctx.beginPath();
        ctx.moveTo(W / 2 + Math.cos(a) * r0, H / 2 + Math.sin(a) * r0);
        ctx.lineTo(W / 2 + Math.cos(a) * len, H / 2 + Math.sin(a) * len);
        ctx.stroke();
      }
    }
  }
}

function measure(ctx, text, spacing) {
  const base = ctx.measureText(text).width;
  return spacing ? base + spacing * Math.max(0, text.length - 1) : base;
}

function drawLine(ctx, text, x, y, spacing, op) {
  if (!spacing) {
    op === 'fill' ? ctx.fillText(text, x, y) : ctx.strokeText(text, x, y);
    return;
  }
  let cx = x;
  for (const ch of text) {
    op === 'fill' ? ctx.fillText(ch, cx, y) : ctx.strokeText(ch, cx, y);
    cx += ctx.measureText(ch).width + spacing;
  }
}

export function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

export function withAlpha(hex, a) {
  const h = String(hex || '#000').replace('#', '');
  const n = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(n.slice(0, 2), 16) || 0;
  const g = parseInt(n.slice(2, 4), 16) || 0;
  const b = parseInt(n.slice(4, 6), 16) || 0;
  return `rgba(${r},${g},${b},${clamp(a ?? 1, 0, 1)})`;
}

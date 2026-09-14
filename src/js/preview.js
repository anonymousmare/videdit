// The stage: preview scaling, selection overlay, and dragging clips directly
// on the frame (which is how you set a pan's start and end points).

import { transformAt, motionK } from './store.js';
import { clamp, drag } from './util.js';

const HANDLE = 7;

export class Preview {
  constructor({ store, media, renderer, playback }) {
    this.store = store;
    this.media = media;
    this.renderer = renderer;
    this.playback = playback;
    this.view = document.getElementById('stageView');
    this.wrap = document.getElementById('canvasWrap');
    this.canvas = document.getElementById('preview');
    this.overlay = document.getElementById('overlay');
    this.octx = this.overlay.getContext('2d');
    this.zoomMode = 'fit';
    this.z = 1;
    this.bind();
    this.resize();
  }

  bind() {
    new ResizeObserver(() => this.resize()).observe(this.view);
    this.store.on('change', () => {
      this.resize();
      this.playback.invalidate();
    });
    this.store.on('selection', () => this.drawOverlay());
    this.store.on('seek', () => this.drawOverlay());
    this.store.on('live', () => this.drawOverlay());
    this.playback.on('tick', () => this.drawOverlay());

    document.getElementById('zoomSel').addEventListener('change', (e) => {
      this.zoomMode = e.target.value === 'fit' ? 'fit' : Number(e.target.value);
      this.resize();
    });
    this.overlay.addEventListener('pointerdown', (e) => this.onPointerDown(e));
  }

  resize() {
    const p = this.store.project;
    const availW = this.view.clientWidth - 32;
    const availH = this.view.clientHeight - 32;
    const fit = Math.min(availW / p.width, availH / p.height);
    this.z = this.zoomMode === 'fit' ? fit : this.zoomMode;
    const w = Math.max(1, Math.round(p.width * this.z));
    const h = Math.max(1, Math.round(p.height * this.z));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.classList.toggle('crisp', this.z >= 1);
    const dpr = window.devicePixelRatio || 1;
    this.overlay.width = Math.round(w * dpr);
    this.overlay.height = Math.round(h * dpr);
    this.overlay.style.width = `${w}px`;
    this.overlay.style.height = `${h}px`;
    this.octx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const sel = document.getElementById('zoomSel');
    sel.options[0].textContent = `Fit (${Math.round(fit * 100)}%)`;
    this.drawOverlay();
  }

  /** Client point -> canvas pixel coordinates. */
  toCanvas(e) {
    const r = this.canvas.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.z, y: (e.clientY - r.top) / this.z };
  }

  selectedVisual() {
    const t = this.store.playhead;
    return this.store
      .selectedClips()
      .filter((c) => c.type !== 'audio' && t >= c.start - 1e-6 && t < c.start + c.duration);
  }

  hitTest(pt) {
    const t = this.store.playhead;
    const list = this.renderer.visibleClips(t);
    for (let i = list.length - 1; i >= 0; i--) {
      const { clip } = list[i];
      const box = this.renderer.boxFor(clip, t);
      if (!box) continue;
      if (pt.x >= box.left && pt.x <= box.left + box.w && pt.y >= box.top && pt.y <= box.top + box.h) return clip;
    }
    return null;
  }

  handleAt(pt) {
    const sel = this.selectedVisual();
    if (sel.length !== 1) return null;
    const box = this.renderer.boxFor(sel[0], this.store.playhead);
    if (!box) return null;
    const r = HANDLE / this.z;
    const corners = {
      nw: [box.left, box.top],
      ne: [box.left + box.w, box.top],
      sw: [box.left, box.top + box.h],
      se: [box.left + box.w, box.top + box.h],
    };
    for (const [name, [x, y]] of Object.entries(corners)) {
      if (Math.abs(pt.x - x) <= r && Math.abs(pt.y - y) <= r) return { name, clip: sel[0], box };
    }
    return null;
  }

  onPointerDown(e) {
    if (e.button !== 0) return;
    const pt = this.toCanvas(e);
    const handle = this.handleAt(pt);
    if (handle) return this.dragScale(e, handle);

    const hit = this.hitTest(pt);
    if (!hit) {
      this.store.select([]);
      return;
    }
    if (!this.store.selection.includes(hit.id)) this.store.select([hit.id], e.shiftKey);
    this.dragPosition(e, hit);
  }

  /** Which part of a clip's transform a drag should edit right now. */
  motionTarget(clip) {
    const m = clip.motion;
    if (!m?.enabled) return 'static';
    const local = this.store.playhead - clip.start;
    const s = clamp(m.start, 0, clip.duration);
    const en = m.end > 0 ? m.end : clip.duration;
    if (local <= s + 1e-4) return 'from';
    if (local >= en - 1e-4) return 'to';
    return 'both';
  }

  dragPosition(e, clip) {
    const before = this.store.snapshot();
    const mode = this.motionTarget(clip);
    const o = {
      x: clip.x,
      y: clip.y,
      from: { ...clip.motion.from },
      to: { ...clip.motion.to },
    };
    drag(e, {
      cursor: 'grabbing',
      onMove: ({ dx, dy, e: ev }) => {
        let mx = dx / this.z;
        let my = dy / this.z;
        if (ev.shiftKey) Math.abs(mx) > Math.abs(my) ? (my = 0) : (mx = 0);
        if (clip.pixelSnap) {
          mx = Math.round(mx);
          my = Math.round(my);
        }
        if (mode === 'static') {
          clip.x = o.x + mx;
          clip.y = o.y + my;
        } else if (mode === 'from') {
          clip.motion.from.x = o.from.x + mx;
          clip.motion.from.y = o.from.y + my;
        } else if (mode === 'to') {
          clip.motion.to.x = o.to.x + mx;
          clip.motion.to.y = o.to.y + my;
        } else {
          clip.motion.from.x = o.from.x + mx;
          clip.motion.from.y = o.from.y + my;
          clip.motion.to.x = o.to.x + mx;
          clip.motion.to.y = o.to.y + my;
        }
        this.playback.invalidate();
        this.store.emit('live');
        this.drawOverlay();
      },
      onEnd: ({ moved }) => {
        if (!moved) return;
        this.store.push(mode === 'static' ? 'Move' : `Move pan ${mode}`, before);
        this.store.changed();
      },
    });
  }

  dragScale(e, { name, clip, box }) {
    const before = this.store.snapshot();
    const mode = this.motionTarget(clip);
    const start = mode === 'from' ? clip.motion.from.scale : mode === 'to' ? clip.motion.to.scale : clip.scale;
    const sign = name === 'se' || name === 'ne' ? 1 : -1;
    const src = this.renderer.sourceSizeOf(clip);
    const srcW = Math.max(1, src ? src.w : box.w);
    drag(e, {
      cursor: `${name}-resize`,
      onMove: ({ dx, e: ev }) => {
        let s = clamp(start + (2 * sign * dx) / (srcW * this.z), 0.02, 40);
        if (ev.shiftKey) s = Math.round(s * 4) / 4;
        if (mode === 'from') clip.motion.from.scale = s;
        else if (mode === 'to') clip.motion.to.scale = s;
        else if (mode === 'both') {
          clip.motion.from.scale = s;
          clip.motion.to.scale = s;
        } else clip.scale = s;
        this.playback.invalidate();
        this.store.emit('live');
        this.drawOverlay();
      },
      onEnd: ({ moved }) => {
        if (!moved) return;
        this.store.push('Scale', before);
        this.store.changed();
      },
    });
  }

  // ------------------------------------------------------------- overlay
  drawOverlay() {
    const g = this.octx;
    const p = this.store.project;
    const w = p.width * this.z;
    const h = p.height * this.z;
    g.clearRect(0, 0, w, h);
    const t = this.store.playhead;
    const sel = this.selectedVisual();
    if (!sel.length) return;

    for (const clip of sel) {
      const box = this.renderer.boxFor(clip, t);
      if (!box) continue;
      const x = box.left * this.z;
      const y = box.top * this.z;
      const bw = box.w * this.z;
      const bh = box.h * this.z;

      if (clip.motion?.enabled) this.drawMotionPath(g, clip, box);

      g.save();
      g.translate(x + bw / 2, y + bh / 2);
      if (box.rotation) g.rotate((box.rotation * Math.PI) / 180);
      g.translate(-bw / 2, -bh / 2);
      g.lineWidth = 1;
      g.strokeStyle = 'rgba(0,0,0,.65)';
      g.strokeRect(0.5, 0.5, bw - 1, bh - 1);
      g.strokeStyle = '#6e8dff';
      g.setLineDash([5, 4]);
      g.strokeRect(0.5, 0.5, bw - 1, bh - 1);
      g.setLineDash([]);
      if (sel.length === 1) {
        g.fillStyle = '#fff';
        g.strokeStyle = '#6e8dff';
        for (const [hx, hy] of [
          [0, 0],
          [bw, 0],
          [0, bh],
          [bw, bh],
        ]) {
          g.beginPath();
          g.rect(hx - HANDLE / 2, hy - HANDLE / 2, HANDLE, HANDLE);
          g.fill();
          g.stroke();
        }
      }
      g.restore();

      // size readout, so you can confirm 1:1 at a glance
      const src = this.renderer.sourceSizeOf(clip);
      if (src && sel.length === 1) {
        const tr = transformAt(clip, t);
        const label = `${Math.round(src.w * tr.scale)} x ${Math.round(src.h * tr.scale)}${
          Math.abs(tr.scale - 1) < 1e-6 ? '  1:1' : `  ${Math.round(tr.scale * 100)}%`
        }`;
        g.font = '11px ui-monospace, monospace';
        const tw = g.measureText(label).width + 12;
        const ly = Math.max(0, y - 22);
        g.fillStyle = 'rgba(5,6,10,.82)';
        g.fillRect(x, ly, tw, 18);
        g.fillStyle = Math.abs(tr.scale - 1) < 1e-6 ? '#00d6b2' : '#e8eaf2';
        g.fillText(label, x + 6, ly + 13);
      }
    }
  }

  drawMotionPath(g, clip, box) {
    const p = this.store.project;
    const m = clip.motion;
    const src = this.renderer.sourceSizeOf(clip);
    if (!src) return;
    const pt = (k) => ({
      x: (p.width / 2 + (k === 0 ? m.from.x : m.to.x)) * this.z,
      y: (p.height / 2 + (k === 0 ? m.from.y : m.to.y)) * this.z,
    });
    const a = pt(0);
    const b = pt(1);
    g.save();
    g.lineWidth = 1.5;
    g.strokeStyle = 'rgba(0,214,178,.85)';
    g.setLineDash([6, 5]);
    g.beginPath();
    g.moveTo(a.x, a.y);
    g.lineTo(b.x, b.y);
    g.stroke();
    g.setLineDash([]);
    const mark = (q, fill, label) => {
      g.beginPath();
      g.arc(q.x, q.y, 5, 0, Math.PI * 2);
      g.fillStyle = fill;
      g.fill();
      g.strokeStyle = '#05060a';
      g.stroke();
      g.font = '10px ui-monospace, monospace';
      g.fillStyle = fill;
      g.fillText(label, q.x + 8, q.y + 3);
    };
    mark(a, '#00d6b2', 'A');
    mark(b, '#ffb02e', 'B');
    // current position along the ramp
    const k = motionK(clip, this.store.playhead - clip.start);
    const cx = a.x + (b.x - a.x) * k;
    const cy = a.y + (b.y - a.y) * k;
    g.beginPath();
    g.arc(cx, cy, 3.5, 0, Math.PI * 2);
    g.fillStyle = '#fff';
    g.fill();
    g.restore();
  }
}

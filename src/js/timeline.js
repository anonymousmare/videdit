// Timeline: tracks, clips, trimming, fade handles, snapping, scrubbing.

import { clipEnd, makeClip, sortClips, MIN_CLIP } from './store.js';
import { icon, hydrateIcons } from './icons.js';
import { clamp, drag, el, fmtTime } from './util.js';
import { PEAK_RATE } from './media.js';

const CLIP_COLORS = {
  image: 'var(--clip-image)',
  video: 'var(--clip-video)',
  audio: 'var(--clip-audio)',
  text: 'var(--clip-text)',
  visualizer: 'var(--clip-viz)',
};
const DEFAULT_STILL = 5;
const HEAD_W = 150;
// How close to the viewport edge a scrub drag has to get before it scrolls.
const EDGE_ZONE = 30;

export class Timeline {
  constructor({ store, media, playback }) {
    this.store = store;
    this.media = media;
    this.playback = playback;
    this.scroll = document.getElementById('tlScroll');
    this.heads = document.getElementById('tlHeads');
    this.lanes = document.getElementById('tlLanes');
    this.ruler = document.getElementById('ruler');
    this.rulerCanvas = document.getElementById('rulerCanvas');
    this.playheadEl = document.getElementById('playhead');
    this.snapEl = document.getElementById('snapline');
    this.laneEls = new Map();
    this.clipEls = new Map();
    this.dragAsset = null;
    this.ghostEl = null;
    this.bind();
  }

  get zoom() {
    return this.store.zoom;
  }
  timeToX(t) {
    return t * this.zoom;
  }
  xToTime(x) {
    return x / this.zoom;
  }
  contentWidth() {
    const dur = Math.max(this.store.duration(), 10);
    return Math.max(dur * this.zoom + 240, this.scroll.clientWidth - HEAD_W);
  }

  bind() {
    this.store.on('change', () => this.render());
    this.store.on('live', () => this.layout());
    this.store.on('selection', () => this.paintSelection());
    this.store.on('seek', () => this.updatePlayhead());
    this.playback.on('tick', () => this.updatePlayhead());
    this.media.on('change', () => this.render());

    // Scrub from the ruler.
    this.ruler.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.scrub(e);
    });

    // Drag through empty lane space to scrub as well; the click deselects.
    this.lanes.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.clip')) return;
      this.store.select([]);
      this.scrub(e);
    });

    // Dragging an asset off the lanes entirely must take its preview with it;
    // moving between a lane and a clip inside it is not leaving.
    this.lanes.addEventListener('dragleave', (e) => {
      if (!this.lanes.contains(e.relatedTarget)) {
        this.hideGhost();
        this.showSnap(null);
      }
    });

    // The wheel runs *along* the timeline — jumping back and forth in time is
    // the constant move, walking the track stack is not. Ctrl/Cmd+wheel zooms
    // around the pointer; Alt+wheel, and the wheel over the track-head column,
    // keep the ordinary vertical scroll.
    this.scroll.addEventListener(
      'wheel',
      (e) => {
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          const rect = this.lanes.getBoundingClientRect();
          const anchorT = this.xToTime(e.clientX - rect.left);
          this.setZoom(this.zoom * (e.deltaY < 0 ? 1.14 : 1 / 1.14));
          const nx = this.timeToX(anchorT) - (e.clientX - rect.left);
          this.scroll.scrollLeft = Math.max(0, this.scroll.scrollLeft + nx);
          return;
        }
        if (e.altKey || (!e.shiftKey && e.target?.closest?.('.tl-heads'))) return;
        // A trackpad puts a sideways swipe on deltaX; a wheel only has deltaY.
        const raw = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
        if (!raw) return;
        // deltaMode 1 = lines, 2 = pages; both need turning into pixels.
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? this.scroll.clientWidth : 1;
        e.preventDefault();
        this.scroll.scrollLeft = Math.max(0, this.scroll.scrollLeft + raw * unit);
      },
      { passive: false },
    );
    this.scroll.addEventListener('scroll', () => this.drawRuler());
    new ResizeObserver(() => this.layout()).observe(this.scroll);
  }

  setZoom(z) {
    this.store.zoom = clamp(z, 8, 900);
    document.getElementById('tlZoom').value = String(Math.round(this.store.zoom));
    this.layout();
  }

  fit() {
    const dur = Math.max(this.store.duration(), 1);
    this.setZoom((this.scroll.clientWidth - HEAD_W - 40) / dur);
    this.scroll.scrollLeft = 0;
  }

  // ------------------------------------------------------------- rendering
  render() {
    const tracks = this.store.project.tracks;
    this.hideGhost();
    this.heads.textContent = '';
    // keep the playhead + snapline nodes, rebuild the lanes
    [...this.lanes.querySelectorAll('.lane')].forEach((n) => n.remove());
    this.laneEls.clear();
    this.clipEls.clear();

    for (const track of tracks) {
      this.heads.append(this.buildHead(track));
      const lane = el('div', {
        class: `lane${track.locked ? ' locked' : ''}`,
        style: { height: `${track.height}px` },
        dataset: { trackId: track.id },
      });
      this.wireDrop(lane, track);
      for (const clip of track.clips) {
        const node = this.buildClip(clip, track);
        this.clipEls.set(clip.id, node);
        lane.append(node);
      }
      this.laneEls.set(track.id, lane);
      this.lanes.append(lane);
    }
    hydrateIcons(this.heads);
    this.layout();
    this.paintSelection();
  }

  buildHead(track) {
    const h = el(
      'div',
      { class: 'thead', style: { height: `${track.height}px` }, dataset: { trackId: track.id } },
      el('span', { class: 'nm' }, track.name),
    );
    const tb = (name, tip, on, fn) => {
      const b = el('button', { class: `tbtn${on ? ' off' : ''}`, 'data-tip': tip, type: 'button' });
      b.append(icon(name, 14));
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        fn();
        this.store.changed();
      });
      return b;
    };
    if (track.kind === 'video') {
      h.append(tb(track.hidden ? 'eyeOff' : 'eye', 'Hide track', track.hidden, () => (track.hidden = !track.hidden)));
    } else {
      h.append(tb(track.muted ? 'volumeOff' : 'volume', 'Mute track', track.muted, () => (track.muted = !track.muted)));
    }
    h.append(tb(track.locked ? 'lock' : 'unlock', 'Lock track', track.locked, () => (track.locked = !track.locked)));
    h.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (confirm(`Delete track ${track.name} and its clips?`)) this.store.removeTrack(track.id);
    });
    return h;
  }

  buildClip(clip, track) {
    const node = el('div', {
      class: `clip${clip.enabled ? '' : ' disabled'}`,
      dataset: { clipId: clip.id, type: clip.type },
      style: { '--c': CLIP_COLORS[clip.type] || 'var(--clip-image)' },
    });
    node.append(el('div', { class: 'fill' }));
    // An unresolvable assetId means the media is offline: say so on the clip
    // rather than leaving a blank block that looks like a broken render.
    if (clip.assetId && !this.media.get(clip.assetId)) {
      node.classList.add('offline');
      const badge = el('div', { class: 'offline-badge', title: 'Media offline — relink it from the Media panel' });
      badge.append(icon('info', 10));
      node.append(badge);
    }
    if (clip.type === 'image' || clip.type === 'video') {
      const asset = this.media.get(clip.assetId);
      if (asset?.thumb) {
        node.append(el('div', { class: 'thumbstrip', style: { backgroundImage: `url(${asset.thumb})` } }));
      }
    }
    if (clip.type === 'audio' || (clip.type === 'video' && this.media.get(clip.assetId)?.peaks)) {
      const cv = el('canvas', { class: 'wave' });
      node.append(cv);
      node._wave = cv;
    }
    node.append(el('div', { class: 'label' }, clip.name));
    node.append(el('div', { class: 'sub' }, fmtTime(clip.duration, this.store.project.fps, false)));
    if (clip.motion?.enabled) {
      const b = el('div', { class: 'motion-badge' });
      b.append(icon('move', 10));
      node.append(b);
    }
    node.append(el('div', { class: 'fadeg in' }), el('div', { class: 'fadeg out' }));
    node.append(
      el('div', { class: 'fadeknob in', 'data-fade': 'in' }),
      el('div', { class: 'fadeknob out', 'data-fade': 'out' }),
    );
    node.append(el('div', { class: 'handle l' }), el('div', { class: 'handle r' }));
    node.addEventListener('pointerdown', (e) => this.onClipPointerDown(e, clip, track));
    node.addEventListener('dblclick', () => {
      this.store.select([clip.id]);
      this.playback.seek(clip.start);
    });
    return node;
  }

  layout() {
    const w = this.contentWidth();
    this.lanes.style.width = `${w}px`;
    this.lanes.style.minWidth = `${w}px`;
    this.ruler.style.width = `${w}px`;
    for (const track of this.store.project.tracks) {
      const lane = this.laneEls.get(track.id);
      if (!lane) continue;
      for (const clip of track.clips) {
        const node = this.clipEls.get(clip.id);
        if (!node) continue;
        this.layoutClip(node, clip);
      }
    }
    this.drawRuler();
    this.updatePlayhead();
  }

  layoutClip(node, clip) {
    const left = this.timeToX(clip.start);
    const width = Math.max(2, this.timeToX(clip.duration));
    node.style.left = `${left}px`;
    node.style.width = `${width}px`;
    node.querySelector('.sub').textContent = fmtTime(clip.duration, this.store.project.fps, false);
    const fin = this.timeToX(clip.fade?.in || 0);
    const fout = this.timeToX(clip.fade?.out || 0);
    node.querySelector('.fadeg.in').style.width = `${fin}px`;
    node.querySelector('.fadeg.out').style.width = `${fout}px`;
    // Keep the fade knobs clear of the trim handles at the very edges.
    const inset = 11;
    const knobIn = node.querySelector('.fadeknob.in');
    const knobOut = node.querySelector('.fadeknob.out');
    const roomy = width >= 46;
    knobIn.style.display = knobOut.style.display = roomy ? '' : 'none';
    if (roomy) {
      knobIn.style.left = `${clamp(fin, inset, width - inset)}px`;
      knobOut.style.left = `${clamp(width - fout, inset, width - inset)}px`;
    }
    if (node._wave) this.drawWave(node._wave, clip, width);
  }

  /**
   * The canvas is stretched to the clip box by CSS, so it has to be sized in
   * *device* pixels — a fixed 44px-tall buffer blown up to the lane height on
   * a 2x screen is what made the waveform look smeared. Every bar is then one
   * whole device pixel wide, on an integer boundary, so nothing antialiases.
   */
  drawWave(cv, clip, width) {
    const asset = this.media.get(clip.assetId);
    const peaks = asset?.peaks;
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    // The laid-out box, not the clip width: the canvas sits inside the clip's
    // 1px border, and a buffer even two pixels out gets resampled on the way in.
    const cssW = clamp(Math.round(cv.clientWidth || width), 2, 4000);
    const cssH = Math.max(8, Math.round(cv.clientHeight || 44));
    const w = Math.min(8192, Math.round(cssW * dpr));
    const h = Math.round(cssH * dpr);
    if (cv.width !== w || cv.height !== h) {
      cv.width = w;
      cv.height = h;
    }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, w, h);
    const mid = Math.round(h / 2);
    if (!peaks) {
      g.fillStyle = 'rgba(255,255,255,.22)';
      g.fillRect(0, mid - Math.round(dpr / 2), w, Math.max(1, Math.round(dpr)));
      return;
    }
    const rate = clip.speed || 1;
    const t0 = clip.inPoint;
    const t1 = clip.inPoint + clip.duration * rate;
    const b0 = t0 * PEAK_RATE;
    const b1 = t1 * PEAK_RATE;
    const n = peaks.length / 2;
    const amp = Math.max(1, mid - Math.round(2 * dpr));
    g.fillStyle = 'rgba(255,255,255,.62)';
    for (let x = 0; x < w; x++) {
      const i0 = Math.floor(b0 + ((b1 - b0) * x) / w);
      const i1 = Math.max(i0 + 1, Math.floor(b0 + ((b1 - b0) * (x + 1)) / w));
      let lo = 0;
      let hi = 0;
      for (let i = i0; i < i1; i++) {
        if (i < 0 || i >= n) continue;
        lo = Math.min(lo, peaks[i * 2]);
        hi = Math.max(hi, peaks[i * 2 + 1]);
      }
      const y0 = Math.round(mid - hi * amp);
      const y1 = Math.round(mid - lo * amp);
      g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
    }
  }

  /** Only the visible window is drawn; the canvas sticks to the viewport. */
  drawRuler() {
    const cv = this.rulerCanvas;
    const dpr = window.devicePixelRatio || 1;
    const view = Math.max(1, this.scroll.clientWidth - HEAD_W);
    const h = 28;
    if (cv.width !== Math.round(view * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(view * dpr);
      cv.height = Math.round(h * dpr);
    }
    cv.style.width = `${view}px`;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, view, h);

    const off = this.scroll.scrollLeft;
    const steps = [1 / 30, 1 / 10, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const step = steps.find((s) => s * this.zoom >= 62) ?? steps.at(-1);
    const t0 = Math.floor(this.xToTime(off) / step) * step;
    const t1 = this.xToTime(off + view);
    g.font = '10px ui-monospace, monospace';
    g.textBaseline = 'alphabetic';
    for (let t = t0; t <= t1 + step; t += step) {
      if (t < -1e-9) continue;
      const x = Math.round(this.timeToX(t) - off) + 0.5;
      g.strokeStyle = 'rgba(255,255,255,.20)';
      g.beginPath();
      g.moveTo(x, 16);
      g.lineTo(x, 28);
      g.stroke();
      g.fillStyle = 'rgba(232,234,242,.62)';
      g.fillText(fmtTime(t, this.store.project.fps, step < 1), x + 4, 13);
      g.strokeStyle = 'rgba(255,255,255,.09)';
      for (let k = 1; k < 4; k++) {
        const mx = Math.round(this.timeToX(t + (step * k) / 4) - off) + 0.5;
        g.beginPath();
        g.moveTo(mx, 22);
        g.lineTo(mx, 28);
        g.stroke();
      }
    }
  }

  updatePlayhead() {
    const x = this.timeToX(this.store.playhead);
    this.playheadEl.style.left = `${x}px`;
    this.playheadEl.style.top = '-28px';
    if (this.playback.playing && this.follow !== false) this.keepVisible(x);
  }

  keepVisible(x) {
    const view = this.scroll.clientWidth - HEAD_W;
    const left = this.scroll.scrollLeft;
    if (x < left || x > left + view - 60) this.scroll.scrollLeft = Math.max(0, x - view * 0.35);
  }

  paintSelection() {
    const sel = new Set(this.store.selection);
    for (const [id, node] of this.clipEls) node.classList.toggle('sel', sel.has(id));
    for (const h of this.heads.children) {
      const tid = h.dataset.trackId;
      const has = this.store.project.tracks.find((t) => t.id === tid)?.clips.some((c) => sel.has(c.id));
      h.classList.toggle('sel', !!has);
    }
  }

  // ------------------------------------------------------------- snapping
  snapTargets(exclude = new Set()) {
    const out = [0, this.store.playhead];
    for (const t of this.store.project.tracks) {
      for (const c of t.clips) {
        if (exclude.has(c.id)) continue;
        out.push(c.start, clipEnd(c));
      }
    }
    return out;
  }

  snap(time, targets) {
    if (!this.store.snapping) return { time, hit: null };
    const tol = 9 / this.zoom;
    let best = null;
    let bestD = tol;
    for (const t of targets) {
      const d = Math.abs(t - time);
      if (d < bestD) {
        bestD = d;
        best = t;
      }
    }
    return best == null ? { time, hit: null } : { time: best, hit: best };
  }

  showSnap(t) {
    if (t == null) {
      this.snapEl.style.display = 'none';
      return;
    }
    this.snapEl.style.display = 'block';
    this.snapEl.style.left = `${this.timeToX(t)}px`;
  }

  /** Where the playhead itself may land: every clip edge, plus zero. */
  playheadTargets() {
    const out = [0];
    for (const t of this.store.project.tracks) {
      for (const c of t.clips) out.push(c.start, clipEnd(c));
    }
    return out;
  }

  /**
   * Scrubbing lands on a clip edge when one is near, and on the frame grid
   * otherwise — parking the playhead exactly on the end of a clip is the whole
   * point, and free-floating sub-frame times make that impossible by hand.
   */
  snapPlayhead(time) {
    if (!this.store.snapping) return { time, hit: null };
    const s = this.snap(time, this.playheadTargets());
    if (s.hit != null) return s;
    const fps = this.store.project.fps || 30;
    return { time: Math.round(time * fps) / fps, hit: null };
  }

  /**
   * Drag the playhead from the ruler or from empty lane space. Holding the
   * pointer past either edge of the viewport scrolls the timeline along.
   */
  scrub(startEvent) {
    let clientX = startEvent.clientX;
    let raf = null;
    const seekTo = () => {
      const raw = Math.max(0, this.xToTime(clientX - this.lanes.getBoundingClientRect().left));
      const s = this.snapPlayhead(raw);
      this.showSnap(s.hit);
      this.playback.seek(Math.max(0, s.time));
    };
    const edgeScroll = () => {
      raf = requestAnimationFrame(edgeScroll);
      const r = this.scroll.getBoundingClientRect();
      const lo = r.left + HEAD_W + EDGE_ZONE;
      const hi = r.right - EDGE_ZONE;
      const over = clientX < lo ? clientX - lo : clientX > hi ? clientX - hi : 0;
      if (!over) return;
      const was = this.scroll.scrollLeft;
      this.scroll.scrollLeft = Math.max(0, was + clamp(over, -EDGE_ZONE, EDGE_ZONE) * 0.5);
      if (this.scroll.scrollLeft !== was) seekTo();
    };

    this.follow = false; // don't let playback yank the view around mid-drag
    seekTo();
    edgeScroll();
    drag(startEvent, {
      cursor: 'ew-resize',
      onMove: ({ x }) => {
        clientX = x;
        seekTo();
      },
      onEnd: () => {
        cancelAnimationFrame(raf);
        this.showSnap(null);
        this.follow = true;
      },
    });
  }

  // ------------------------------------------------------------- interaction
  onClipPointerDown(e, clip, track) {
    e.stopPropagation();
    if (e.button !== 0) return;
    if (track.locked) return;
    const fade = e.target.dataset?.fade;
    const handle = e.target.classList?.contains('handle') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;

    if (!this.store.selection.includes(clip.id)) {
      this.store.select([clip.id], e.shiftKey);
    } else if (e.shiftKey) {
      this.store.select([clip.id], true);
    }

    if (fade) return this.dragFade(e, clip, fade);
    if (handle) return this.dragTrim(e, clip, track, handle);
    return this.dragMove(e, clip, track);
  }

  dragFade(e, clip, side) {
    const before = this.store.snapshot();
    const start = clip.fade[side];
    const node = this.clipEls.get(clip.id);
    drag(e, {
      cursor: 'ew-resize',
      onMove: ({ dx }) => {
        const delta = this.xToTime(side === 'in' ? dx : -dx);
        const other = clip.fade[side === 'in' ? 'out' : 'in'];
        clip.fade[side] = clamp(start + delta, 0, Math.max(0, clip.duration - other));
        this.layoutClip(node, clip);
        this.playback.invalidate();
        this.store.emit('live');
      },
      onEnd: ({ moved }) => {
        if (moved) {
          this.store.push(`Fade ${side}`, before);
          this.store.changed();
        }
      },
    });
  }

  dragTrim(e, clip, track, side) {
    const before = this.store.snapshot();
    const o = { start: clip.start, duration: clip.duration, inPoint: clip.inPoint };
    const node = this.clipEls.get(clip.id);
    const targets = this.snapTargets(new Set([clip.id]));
    const rate = clip.speed || 1;
    const srcDur = clip.sourceDuration;
    drag(e, {
      cursor: 'ew-resize',
      onMove: ({ dx }) => {
        const dt = this.xToTime(dx);
        if (side === 'l') {
          let ns = o.start + dt;
          const s = this.snap(ns, targets);
          ns = s.time;
          this.showSnap(s.hit);
          const maxLeft = srcDur != null ? o.start - o.inPoint / rate : -Infinity;
          ns = clamp(ns, Math.max(0, maxLeft), o.start + o.duration - MIN_CLIP);
          clip.start = ns;
          clip.duration = o.duration - (ns - o.start);
          clip.inPoint = o.inPoint + (ns - o.start) * rate;
        } else {
          let ne = o.start + o.duration + dt;
          const s = this.snap(ne, targets);
          ne = s.time;
          this.showSnap(s.hit);
          const maxDur = srcDur != null ? (srcDur - clip.inPoint) / rate : Infinity;
          clip.duration = clamp(ne - o.start, MIN_CLIP, maxDur);
        }
        clip.fade.in = Math.min(clip.fade.in, clip.duration);
        clip.fade.out = Math.min(clip.fade.out, clip.duration - clip.fade.in);
        this.layoutClip(node, clip);
        this.playback.invalidate();
        this.store.emit('live');
      },
      onEnd: ({ moved }) => {
        this.showSnap(null);
        if (moved) {
          this.store.push('Trim', before);
          this.store.changed();
        }
      },
    });
  }

  dragMove(e, clip, track) {
    const before = this.store.snapshot();
    const ids = this.store.selection.includes(clip.id) ? [...this.store.selection] : [clip.id];
    const picked = ids.map((id) => ({ clip: this.store.clip(id), track: this.store.trackOf(id) })).filter((p) => p.clip && !p.track.locked);
    const origin = picked.map((p) => ({ id: p.clip.id, start: p.clip.start, trackId: p.track.id }));
    const targets = this.snapTargets(new Set(ids));
    const laneRects = this.store.project.tracks.map((t) => ({
      track: t,
      rect: this.laneEls.get(t.id)?.getBoundingClientRect(),
    }));
    const anchor = origin.find((o) => o.id === clip.id);
    let lastTrackId = track.id;

    drag(e, {
      cursor: 'grabbing',
      onMove: ({ dx, y, e: ev }) => {
        const dt = this.xToTime(dx);
        // horizontal, snapped on the dragged clip's own edges
        let ns = anchor.start + dt;
        const a = this.snap(ns, targets);
        const b = this.snap(ns + clip.duration, targets);
        let hit = null;
        if (a.hit != null && (b.hit == null || Math.abs(a.time - ns) <= Math.abs(b.time - clip.duration - ns))) {
          ns = a.time;
          hit = a.hit;
        } else if (b.hit != null) {
          ns = b.time - clip.duration;
          hit = b.hit;
        }
        ns = Math.max(0, ns);
        const shift = ns - anchor.start;
        this.showSnap(hit);

        // vertical: move to whichever lane of the same kind is under the cursor
        let destTrackId = lastTrackId;
        if (!ev.shiftKey) {
          const over = laneRects.find((l) => l.rect && y >= l.rect.top && y <= l.rect.bottom);
          if (over && over.track.kind === track.kind && !over.track.locked) destTrackId = over.track.id;
        }
        const laneShift = destTrackId !== lastTrackId;
        lastTrackId = destTrackId;

        for (const o of origin) {
          const c = this.store.clip(o.id);
          if (!c) continue;
          c.start = Math.max(0, o.start + shift);
        }
        if (laneShift && origin.length === 1) this.moveToTrack(clip, destTrackId);
        for (const o of origin) {
          const c = this.store.clip(o.id);
          const node = this.clipEls.get(o.id);
          if (c && node) this.layoutClip(node, c);
        }
        this.playback.invalidate();
        this.store.emit('live');
      },
      onEnd: ({ moved }) => {
        this.showSnap(null);
        if (!moved) return;
        for (const t of this.store.project.tracks) sortClips(t);
        this.resolveOverlaps(ids);
        this.store.push('Move clip', before);
        this.store.changed();
      },
    });
  }

  moveToTrack(clip, trackId) {
    const from = this.store.trackOf(clip.id);
    const to = this.store.track(trackId);
    if (!from || !to || from.id === to.id) return;
    from.clips = from.clips.filter((c) => c.id !== clip.id);
    to.clips.push(clip);
    const node = this.clipEls.get(clip.id);
    this.laneEls.get(to.id)?.append(node);
  }

  /** Clips must not overlap on one track: push the intruder to a free lane. */
  resolveOverlaps(movedIds) {
    for (const track of this.store.project.tracks) {
      sortClips(track);
      for (const c of [...track.clips]) {
        if (!movedIds.includes(c.id)) continue;
        const hit = track.clips.find(
          (o) => o.id !== c.id && c.start < clipEnd(o) - 1e-6 && clipEnd(c) > o.start + 1e-6,
        );
        if (!hit) continue;
        const free = this.store.findSlot(track.kind, c.start, c.duration);
        if (free && free.id !== track.id) {
          track.clips = track.clips.filter((x) => x.id !== c.id);
          free.clips.push(c);
          sortClips(free);
        } else {
          const t = this.store.addTrackSilently(track.kind);
          track.clips = track.clips.filter((x) => x.id !== c.id);
          t.clips.push(c);
        }
      }
    }
  }

  // ------------------------------------------------------------- drop
  /**
   * The one place a drag pointer turns into a start time. The drag image is
   * anchored so its left edge sits on the pointer (see Library.assetCard), so
   * the pointer *is* the clip start — no guessing where the dropped block
   * begins, and the same number is used for the preview and for the drop.
   */
  dropTime(clientX) {
    const raw = Math.max(0, this.xToTime(clientX - this.lanes.getBoundingClientRect().left));
    const s = this.snap(raw, this.snapTargets());
    return { time: Math.max(0, s.time), hit: s.hit };
  }

  /** Held while an asset is dragged out of the library, for the live preview. */
  beginAssetDrag(asset) {
    this.dragAsset = asset;
  }

  endAssetDrag() {
    this.dragAsset = null;
    this.hideGhost();
    this.showSnap(null);
  }

  /** Outline of exactly where — and on which lane — the drop will land. */
  showGhost(lane, start, dur) {
    if (!this.ghostEl) {
      this.ghostEl = el('div', { class: 'drop-ghost' });
      this.lanes.append(this.ghostEl);
    }
    const g = this.ghostEl;
    g.style.display = 'block';
    g.style.left = `${this.timeToX(start)}px`;
    g.style.width = `${Math.max(2, this.timeToX(dur))}px`;
    g.style.top = `${lane.offsetTop + 3}px`;
    g.style.height = `${Math.max(6, lane.offsetHeight - 7)}px`;
  }

  hideGhost() {
    if (this.ghostEl) this.ghostEl.style.display = 'none';
  }

  previewDrop(lane, track, clientX) {
    const asset = this.dragAsset;
    if (!asset || (asset.kind === 'audio') !== (track.kind === 'audio')) {
      this.hideGhost();
      this.showSnap(null);
      return;
    }
    const dur = clipForAsset(asset).duration;
    const { time, hit } = this.dropTime(clientX);
    // A busy lane sends the clip elsewhere; show it where it will actually go.
    const dest = this.store.findSlot(track.kind, time, dur, track.id) || track;
    this.showSnap(hit);
    this.showGhost(this.laneEls.get(dest.id) || lane, time, dur);
  }

  wireDrop(lane, track) {
    lane.addEventListener('dragover', (e) => {
      const kind = e.dataTransfer.types.includes('text/videdit-asset') ? 'asset' : null;
      if (!kind || track.locked) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      lane.classList.add('drop');
      this.previewDrop(lane, track, e.clientX);
    });
    lane.addEventListener('dragleave', () => lane.classList.remove('drop'));
    lane.addEventListener('drop', (e) => {
      e.preventDefault();
      lane.classList.remove('drop');
      this.endAssetDrag();
      const assetId = e.dataTransfer.getData('text/videdit-asset');
      if (!assetId) return;
      this.dropAsset(assetId, track, this.dropTime(e.clientX).time);
    });
  }

  /** `time` is already snapped by dropTime(); it is the clip's start. */
  dropAsset(assetId, track, time) {
    const asset = this.media.get(assetId);
    if (!asset) return;
    const wantAudioTrack = asset.kind === 'audio';
    if (wantAudioTrack !== (track.kind === 'audio')) {
      this.store.emit('toast', `${asset.name} belongs on ${wantAudioTrack ? 'an audio' : 'a video'} track`);
      return;
    }
    const clip = clipForAsset(asset);
    clip.start = Math.max(0, time);
    const dest = this.store.findSlot(track.kind, clip.start, clip.duration, track.id) || track;
    this.store.addClip(dest.id, clip, { label: `Add ${asset.name}` });
  }

  /** Drop a ready-made clip on the first free lane at the playhead. */
  insert(clip, kind = 'video', at = null) {
    clip.start = Math.max(0, at ?? this.store.playhead);
    const dest = this.store.findSlot(kind, clip.start, clip.duration) || this.store.addTrack(kind);
    return this.store.addClip(dest.id, clip, { label: `Add ${clip.name}` });
  }

  /** Append an asset to the first free slot — used by the media pool. */
  appendAsset(assetId, at = null) {
    const asset = this.media.get(assetId);
    if (!asset) return;
    const clip = clipForAsset(asset);
    return this.insert(clip, asset.kind === 'audio' ? 'audio' : 'video', at);
  }
}

export function clipForAsset(asset) {
  const type = asset.kind;
  const dur = type === 'image' ? DEFAULT_STILL : Math.max(0.1, asset.duration || DEFAULT_STILL);
  return makeClip(type, {
    assetId: asset.id,
    name: asset.name.replace(/\.[^.]+$/, ''),
    duration: dur,
    sourceDuration: type === 'image' ? null : asset.duration || null,
  });
}

export { HEAD_W, DEFAULT_STILL };

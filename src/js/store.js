// Project model + selection + undo history.
//
// Design note that drives this whole app: imported media is NEVER auto-fitted
// to the canvas. A clip's `scale` defaults to 1, meaning one source pixel maps
// to exactly one canvas pixel. Media larger than the canvas simply overflows
// and is cropped by the frame, which is what keeps screenshots crisp.

import { uid, clamp, lerp, ease, emitter, deepClone } from './util.js';

export const TRACK_H = { video: 66, audio: 56 };
export const MIN_CLIP = 1 / 120;

export function createProject(preset = {}) {
  const p = {
    name: 'Untitled trailer',
    width: 1024,
    height: 1024,
    fps: 30,
    background: '#000000',
    sampleRate: 48000,
    tracks: [
      makeTrack('video', 'V2'),
      makeTrack('video', 'V1'),
      makeTrack('audio', 'A1'),
    ],
    ...preset,
  };
  return p;
}

export function makeTrack(kind, name) {
  return {
    id: uid('trk'),
    kind,
    name,
    hidden: false,
    muted: false,
    locked: false,
    volume: 1,
    height: TRACK_H[kind],
    clips: [],
  };
}

const baseFade = (mode) => ({ in: 0, out: 0, mode, color: '#000000' });

/** Motion = "move this image from A to B over N seconds" (the pan tool). */
export function makeMotion(x = 0, y = 0, scale = 1) {
  return {
    enabled: false,
    from: { x, y, scale },
    to: { x, y, scale },
    start: 0, // seconds from clip start
    end: 0, // 0 == run until the end of the clip
    easing: 'easeInOut',
  };
}

export function makeTextStyle(over = {}) {
  return {
    content: 'Your text here',
    font: 'Inter, "Segoe UI", system-ui, sans-serif',
    size: 72,
    weight: 700,
    italic: false,
    color: '#ffffff',
    align: 'center',
    lineHeight: 1.2,
    letterSpacing: 0,
    maxWidth: 0, // 0 = no wrapping
    shadow: {
      enabled: true,
      color: '#000000',
      opacity: 0.75,
      blur: 18,
      offsetX: 0,
      offsetY: 6,
    },
    stroke: { enabled: false, color: '#000000', width: 4 },
    box: { enabled: false, color: '#000000', opacity: 0.5, padX: 28, padY: 16, radius: 8 },
    ...over,
  };
}

export function makeVisualizer(over = {}) {
  return {
    source: 'master', // 'master' | assetId
    style: 'bars', // bars | mirror | line | radial
    bars: 64,
    width: 900,
    height: 260,
    gap: 0.32,
    cap: true,
    radius: 3,
    minFreq: 40,
    maxFreq: 14000,
    gain: 1.6,
    floorDb: -70,
    smoothing: 0.55,
    color: '#7aa2ff',
    color2: '#00e5c0',
    glow: 10,
    ...over,
  };
}

/**
 * Create a clip. Placement rule: x/y are an OFFSET IN CANVAS PIXELS from the
 * canvas centre, so 0,0 means "dead centre, native size, nothing resized".
 */
export function makeClip(type, opts = {}) {
  const c = {
    id: uid('clip'),
    type, // image | video | audio | text | visualizer
    name: opts.name || type,
    assetId: opts.assetId || null,
    start: opts.start ?? 0,
    duration: opts.duration ?? 5,
    inPoint: opts.inPoint ?? 0, // offset into the source media
    sourceDuration: opts.sourceDuration ?? null, // null = unbounded (stills/text)
    enabled: true,
    // transform
    x: 0,
    y: 0,
    scale: 1,
    rotation: 0,
    opacity: 1,
    flipX: false,
    flipY: false,
    smooth: false, // false = nearest-neighbour = crisp screenshots
    pixelSnap: true,
    blend: 'source-over',
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    // fades
    fade: baseFade(type === 'audio' ? 'audio' : type === 'text' || type === 'visualizer' ? 'opacity' : 'black'),
    // audio
    gain: 1,
    speed: 1,
    // motion
    motion: makeMotion(),
    // per-type payloads
    text: type === 'text' ? makeTextStyle(opts.text) : null,
    visualizer: type === 'visualizer' ? makeVisualizer(opts.visualizer) : null,
    color: opts.color || null,
  };
  return Object.assign(c, opts.overrides || {});
}

export const clipEnd = (c) => c.start + c.duration;
export const isVisual = (c) => c.type !== 'audio';

export function projectDuration(project) {
  let d = 0;
  for (const t of project.tracks) for (const c of t.clips) d = Math.max(d, clipEnd(c));
  return d;
}

export function sortClips(track) {
  track.clips.sort((a, b) => a.start - b.start);
}

/** Fade multiplier for a clip at absolute time t (0..1). */
export function fadeAmount(clip, t) {
  const local = t - clip.start;
  const f = clip.fade || { in: 0, out: 0 };
  let a = 1;
  if (f.in > 0 && local < f.in) a = Math.min(a, clamp(local / f.in, 0, 1));
  if (f.out > 0 && local > clip.duration - f.out) {
    a = Math.min(a, clamp((clip.duration - local) / f.out, 0, 1));
  }
  return a;
}

/**
 * True when a clip's transform actually animates — a pan, a push, a zoom.
 *
 * Motion changes how a clip has to be drawn. A still frame wants whole-pixel
 * placement and nearest-neighbour sampling, which is what keeps an imported
 * screenshot bit-exact. A moving one wants the opposite: quantising a pan to
 * whole pixels turns smooth travel into a stepped crawl, because a pan rarely
 * advances by a whole pixel per frame — it holds, jumps one, holds, jumps two.
 *
 * Deliberately time-independent, so a clip does not change its drawing rule
 * part-way through and pop as the ramp starts or ends.
 */
export function hasMotion(clip) {
  const m = clip.motion;
  if (!m?.enabled) return false;
  return m.from.x !== m.to.x || m.from.y !== m.to.y || m.from.scale !== m.to.scale;
}

/** Resolve transform at absolute time t, applying the motion ramp if enabled. */
export function transformAt(clip, t) {
  const base = { x: clip.x, y: clip.y, scale: clip.scale, rotation: clip.rotation };
  const m = clip.motion;
  if (!m?.enabled) return base;
  base.__k = motionK(clip, t - clip.start);
  base.x = lerp(m.from.x, m.to.x, base.__k);
  base.y = lerp(m.from.y, m.to.y, base.__k);
  base.scale = lerp(m.from.scale, m.to.scale, base.__k);
  return base;
}

/** Eased 0..1 progress of a clip's motion ramp at `local` seconds into it. */
export function motionK(clip, local) {
  const m = clip.motion;
  const s = clamp(m.start, 0, clip.duration);
  const e = m.end > 0 ? clamp(m.end, s + 1e-4, clip.duration) : clip.duration;
  const raw = e <= s ? 1 : clamp((local - s) / (e - s), 0, 1);
  return ease(m.easing, raw);
}

export class Store {
  constructor() {
    this.bus = emitter();
    this.project = createProject();
    this.selection = [];
    this.playhead = 0;
    this.zoom = 90; // pixels per second
    this.snapping = true;
    this.rippleDelete = false;
    this.history = [];
    this.future = [];
    this.dirty = false;
  }

  on(evt, fn) {
    return this.bus.on(evt, fn);
  }
  emit(evt, p) {
    this.bus.emit(evt, p);
  }

  // --- lookups -------------------------------------------------------------
  track(id) {
    return this.project.tracks.find((t) => t.id === id) || null;
  }
  clip(id) {
    for (const t of this.project.tracks) {
      const c = t.clips.find((x) => x.id === id);
      if (c) return c;
    }
    return null;
  }
  trackOf(clipId) {
    return this.project.tracks.find((t) => t.clips.some((c) => c.id === clipId)) || null;
  }
  allClips() {
    return this.project.tracks.flatMap((t) => t.clips);
  }
  selectedClips() {
    return this.selection.map((id) => this.clip(id)).filter(Boolean);
  }
  duration() {
    return projectDuration(this.project);
  }

  // --- history -------------------------------------------------------------
  snapshot() {
    return deepClone({ project: this.project, selection: this.selection });
  }
  push(label, before) {
    this.history.push({ label, state: before || this.snapshot() });
    if (this.history.length > 120) this.history.shift();
    this.future.length = 0;
    this.dirty = true;
    this.emit('history');
  }
  /** Mutate + record in one call. */
  commit(label, fn) {
    const before = this.snapshot();
    const r = fn(this.project);
    if (r === false) return r; // mutator aborted
    this.push(label, before);
    this.changed();
    return r;
  }
  undo() {
    if (!this.history.length) return;
    const entry = this.history.pop();
    this.future.push({ label: entry.label, state: this.snapshot() });
    this.project = entry.state.project;
    this.selection = entry.state.selection.filter((id) => this.clip(id));
    this.changed();
    this.emit('history');
    this.emit('toast', `Undo · ${entry.label}`);
  }
  redo() {
    if (!this.future.length) return;
    const entry = this.future.pop();
    this.history.push({ label: entry.label, state: this.snapshot() });
    this.project = entry.state.project;
    this.selection = entry.state.selection.filter((id) => this.clip(id));
    this.changed();
    this.emit('history');
    this.emit('toast', `Redo · ${entry.label}`);
  }

  changed() {
    this.dirty = true;
    this.emit('change');
  }

  // --- selection -----------------------------------------------------------
  select(ids, additive = false) {
    const list = Array.isArray(ids) ? ids : ids ? [ids] : [];
    if (additive) {
      const set = new Set(this.selection);
      for (const id of list) (set.has(id) ? set.delete(id) : set.add(id));
      this.selection = [...set];
    } else {
      this.selection = list;
    }
    this.emit('selection');
  }

  seek(t) {
    this.playhead = Math.max(0, t);
    this.emit('seek', this.playhead);
  }

  // --- editing -------------------------------------------------------------
  addClip(trackId, clip, { label = 'Add clip' } = {}) {
    return this.commit(label, () => {
      const t = this.track(trackId);
      if (!t) return false;
      t.clips.push(clip);
      sortClips(t);
      this.selection = [clip.id];
      return clip;
    });
  }

  removeClips(ids, label = 'Delete') {
    if (!ids.length) return;
    this.commit(label, () => {
      for (const t of this.project.tracks) t.clips = t.clips.filter((c) => !ids.includes(c.id));
      this.selection = [];
    });
  }

  /** Split every selected (or all, if none selected) clip crossing `t`. */
  splitAt(t, ids = null) {
    const targets = [];
    for (const track of this.project.tracks) {
      if (track.locked) continue;
      for (const c of track.clips) {
        if (ids && !ids.includes(c.id)) continue;
        if (t > c.start + MIN_CLIP && t < clipEnd(c) - MIN_CLIP) targets.push([track, c]);
      }
    }
    if (!targets.length) return 0;
    this.commit('Split', () => {
      const newIds = [];
      for (const [trackRef, clipRef] of targets) {
        const track = this.track(trackRef.id);
        const c = track.clips.find((x) => x.id === clipRef.id);
        const right = deepClone(c);
        right.id = uid('clip');
        const cut = t - c.start;
        right.start = t;
        right.duration = c.duration - cut;
        right.inPoint = c.inPoint + cut * (c.speed || 1);
        c.duration = cut;
        // fades stay attached to the outer edges of the original clip
        c.fade = { ...c.fade, out: 0 };
        right.fade = { ...right.fade, in: 0 };
        // motion: split the ramp so the pan continues seamlessly
        if (c.motion?.enabled) splitMotion(c, right, cut);
        track.clips.push(right);
        newIds.push(right.id);
        sortClips(track);
      }
      this.selection = newIds;
    });
    return targets.length;
  }

  addTrack(kind, at = null) {
    return this.commit(`Add ${kind} track`, () => {
      const same = this.project.tracks.filter((t) => t.kind === kind);
      const t = makeTrack(kind, `${kind === 'video' ? 'V' : 'A'}${same.length + 1}`);
      if (kind === 'video') {
        this.project.tracks.splice(at ?? 0, 0, t);
      } else {
        const idx = at ?? this.project.tracks.length;
        this.project.tracks.splice(idx, 0, t);
      }
      return t;
    });
  }

  /** Add a track without its own history entry (used inside another mutation). */
  addTrackSilently(kind) {
    const same = this.project.tracks.filter((t) => t.kind === kind);
    const t = makeTrack(kind, `${kind === 'video' ? 'V' : 'A'}${same.length + 1}`);
    if (kind === 'video') this.project.tracks.unshift(t);
    else this.project.tracks.push(t);
    return t;
  }

  removeTrack(id) {
    this.commit('Delete track', () => {
      const i = this.project.tracks.findIndex((t) => t.id === id);
      if (i < 0) return false;
      const kindLeft = this.project.tracks.filter((t) => t.kind === this.project.tracks[i].kind).length;
      if (kindLeft <= 1) return false;
      this.project.tracks.splice(i, 1);
      this.selection = [];
    });
  }

  /**
   * Pick the track a new clip should land on.
   *  - nothing else occupies that time  -> the bottom-most (main) track
   *  - something does                   -> the nearest free track ABOVE it,
   *    so overlays stack on top like they do in a normal NLE
   * Returns null when a new track has to be created.
   */
  findSlot(kind, start, dur, preferId = null) {
    const free = (t) => t.clips.every((c) => start >= clipEnd(c) - 1e-6 || start + dur <= c.start + 1e-6);
    const pref = preferId ? this.track(preferId) : null;
    if (pref && pref.kind === kind && !pref.locked && free(pref)) return pref;

    const idx = [];
    this.project.tracks.forEach((t, i) => t.kind === kind && idx.push(i));
    if (!idx.length) return null;

    const occupied = idx.filter((i) => !free(this.project.tracks[i]));
    if (!occupied.length) {
      for (let k = idx.length - 1; k >= 0; k--) {
        const t = this.project.tracks[idx[k]];
        if (!t.locked) return t;
      }
      return null;
    }
    const topOccupied = Math.min(...occupied);
    for (let i = topOccupied - 1; i >= 0; i--) {
      const t = this.project.tracks[i];
      if (t.kind === kind && !t.locked && free(t)) return t;
    }
    return null;
  }
}

function splitMotion(left, right, cut) {
  const m = left.motion;
  const s = clamp(m.start, 0, left.duration + right.duration);
  const e = m.end > 0 ? m.end : left.duration + right.duration;
  const at = (local) => {
    if (e <= s) return 1;
    return clamp((local - s) / (e - s), 0, 1);
  };
  const kCut = ease(m.easing, at(cut));
  const mid = {
    x: lerp(m.from.x, m.to.x, kCut),
    y: lerp(m.from.y, m.to.y, kCut),
    scale: lerp(m.from.scale, m.to.scale, kCut),
  };
  right.motion = {
    ...deepClone(m),
    from: mid,
    to: deepClone(m.to),
    start: Math.max(0, s - cut),
    end: Math.max(0, e - cut),
  };
  left.motion = { ...m, to: mid, start: s, end: Math.min(e, cut) };
}

export const store = new Store();

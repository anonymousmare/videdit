// Right-hand properties panel. Rebuilds on selection change; on live edits it
// only refreshes values so the field you are typing in keeps focus.

import { el, clamp, drag, round, EASING_LABELS, fmtTime } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { makeMotion } from './store.js';

const FONTS = [
  ['Inter, "Segoe UI", system-ui, sans-serif', 'Inter / System'],
  ['"Helvetica Neue", Helvetica, Arial, sans-serif', 'Helvetica'],
  ['"Arial Black", Arial, sans-serif', 'Arial Black'],
  ['Impact, "Haettenschweiler", sans-serif', 'Impact'],
  ['Georgia, "Times New Roman", serif', 'Georgia'],
  ['"Times New Roman", Times, serif', 'Times'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['"Courier New", ui-monospace, monospace', 'Courier'],
  ['ui-monospace, "SF Mono", Menlo, monospace', 'Mono'],
];
const BLENDS = ['source-over', 'screen', 'lighter', 'multiply', 'overlay', 'soft-light', 'difference'];

export class Inspector {
  constructor({ store, media, renderer, playback, timeline }) {
    this.store = store;
    this.media = media;
    this.renderer = renderer;
    this.playback = playback;
    this.timeline = timeline;
    this.root = document.getElementById('inspector');
    this.updaters = [];
    this.collapsed = new Set();
    this._sig = '';
    this._before = null;

    this.store.on('selection', () => this.render());
    this.store.on('change', () => {
      const sig = this.signature();
      if (sig !== this._sig) this.render();
      else this.refresh();
    });
    this.store.on('live', () => this.refresh());
    this.store.on('seek', () => this.refresh());
    this.playback.on('tick', () => this.refresh());
    this.render();
  }

  signature() {
    return this.store.selection.join(',') + '|' + this.store.selectedClips().map((c) => c.type).join(',');
  }

  refresh() {
    for (const u of this.updaters) {
      try {
        u();
      } catch {}
    }
  }

  // ---------------------------------------------------------------- helpers
  /** Snapshot before the first keystroke/drag of an edit. */
  begin() {
    if (!this._before) this._before = this.store.snapshot();
  }
  live() {
    this.playback.invalidate();
    this.store.emit('live');
  }
  commit(label) {
    if (!this._before) return;
    this.store.push(label, this._before);
    this._before = null;
    this.store.changed();
  }

  section(title, iconName, body, { key = title, badge = null } = {}) {
    const sec = el('div', { class: `sec${this.collapsed.has(key) ? ' collapsed' : ''}` });
    const head = el('div', { class: 'sec-head' });
    head.append(icon('chevronDown', 13));
    head.firstChild.classList.add('chev');
    head.append(icon(iconName, 13), el('span', {}, title));
    if (badge) head.append(el('span', { class: 'badge' }, badge));
    head.addEventListener('click', () => {
      sec.classList.toggle('collapsed');
      this.collapsed.has(key) ? this.collapsed.delete(key) : this.collapsed.add(key);
    });
    sec.append(head, el('div', { class: 'sec-body' }, ...body.filter(Boolean)));
    return sec;
  }

  row(label, ...controls) {
    if (label == null) return el('div', { class: 'row wide' }, ...controls);
    const l = el('label', {}, label);
    return el('div', { class: 'row' }, l, ...controls);
  }

  num(get, set, { step = 1, min = -1e9, max = 1e9, unit = '', label = 'value', precision = 3 } = {}) {
    const input = el('input', { class: 'inp num', type: 'number', step, value: round(get(), precision) });
    const wrap = el('div', { class: 'numfield' }, input, unit ? el('span', { class: 'unit' }, unit) : null);
    const apply = (v, commit) => {
      const n = clamp(Number(v), min, max);
      if (!Number.isFinite(n)) return;
      this.begin();
      set(n);
      this.live();
      if (commit) this.commit(label);
    };
    input.addEventListener('focus', () => this.begin());
    input.addEventListener('input', () => apply(input.value, false));
    input.addEventListener('change', () => apply(input.value, true));
    input.addEventListener('blur', () => this.commit(label));
    this.updaters.push(() => {
      if (document.activeElement !== input) input.value = round(get(), precision);
    });
    wrap._scrub = (labelEl) => {
      labelEl.style.cursor = 'ew-resize';
      labelEl.addEventListener('pointerdown', (e) => {
        const start = get();
        this.begin();
        drag(e, {
          cursor: 'ew-resize',
          onMove: ({ dx, e: ev }) => {
            const mul = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
            set(clamp(start + dx * step * mul, min, max));
            this.live();
            this.refresh();
          },
          onEnd: ({ moved }) => (moved ? this.commit(label) : (this._before = null)),
        });
      });
    };
    return wrap;
  }

  numRow(label, get, set, opts = {}) {
    const f = this.num(get, set, { ...opts, label });
    const row = this.row(label, f);
    f._scrub?.(row.firstChild);
    return row;
  }

  pairRow(label, a, b) {
    return this.row(label, el('div', { class: 'pair' }, a, b));
  }

  range(get, set, { min = 0, max = 1, step = 0.01, label = 'value', fmt = (v) => round(v, 2) } = {}) {
    const r = el('input', { class: 'slider', type: 'range', min, max, step, value: get() });
    const out = el('input', { class: 'inp num', type: 'number', min, max, step, value: fmt(get()) });
    const sync = (v, commit) => {
      this.begin();
      set(Number(v));
      this.live();
      if (commit) this.commit(label);
    };
    r.addEventListener('pointerdown', () => this.begin());
    r.addEventListener('input', () => {
      sync(r.value, false);
      out.value = fmt(Number(r.value));
    });
    r.addEventListener('change', () => sync(r.value, true));
    out.addEventListener('input', () => {
      sync(out.value, false);
      r.value = out.value;
    });
    out.addEventListener('change', () => sync(out.value, true));
    this.updaters.push(() => {
      if (document.activeElement !== r) r.value = get();
      if (document.activeElement !== out) out.value = fmt(get());
    });
    return el('div', { class: 'slider-row' }, r, out);
  }

  color(get, set, label = 'colour') {
    const c = el('input', { class: 'swatch', type: 'color', value: get() });
    c.addEventListener('input', () => {
      this.begin();
      set(c.value);
      this.live();
    });
    c.addEventListener('change', () => this.commit(label));
    this.updaters.push(() => {
      if (document.activeElement !== c) c.value = get();
    });
    return c;
  }

  select(options, get, set, label = 'option') {
    const s = el('select', { class: 'inp' });
    for (const [v, t] of options) s.append(el('option', { value: v }, t));
    s.value = get();
    s.addEventListener('change', () => {
      this.begin();
      set(s.value);
      this.live();
      this.commit(label);
    });
    this.updaters.push(() => {
      if (document.activeElement !== s) s.value = get();
    });
    return s;
  }

  check(text, get, set, label = 'toggle') {
    const i = el('input', { type: 'checkbox' });
    i.checked = !!get();
    i.addEventListener('change', () => {
      this.begin();
      set(i.checked);
      this.live();
      this.commit(label);
    });
    this.updaters.push(() => {
      i.checked = !!get();
    });
    return el('label', { class: 'check' }, i, el('span', {}, text));
  }

  seg(items, get, set, label = 'option') {
    const wrap = el('div', { class: 'seg' });
    const btns = [];
    for (const [val, content, isIcon] of items) {
      const b = el('button', { type: 'button', 'data-val': val });
      if (isIcon) b.append(icon(content, 14));
      else b.textContent = content;
      b.addEventListener('click', () => {
        this.begin();
        set(val);
        this.live();
        this.commit(label);
        paint();
      });
      btns.push(b);
      wrap.append(b);
    }
    const paint = () => btns.forEach((b) => b.classList.toggle('on', b.dataset.val === String(get())));
    paint();
    this.updaters.push(paint);
    return wrap;
  }

  text(get, set, { area = false, label = 'text', rows = 3, placeholder = '' } = {}) {
    const t = area ? el('textarea', { class: 'inp', rows, placeholder }) : el('input', { class: 'inp', type: 'text', placeholder });
    t.value = get();
    t.addEventListener('focus', () => this.begin());
    t.addEventListener('input', () => {
      this.begin();
      set(t.value);
      this.live();
    });
    t.addEventListener('change', () => this.commit(label));
    t.addEventListener('blur', () => this.commit(label));
    this.updaters.push(() => {
      if (document.activeElement !== t) t.value = get();
    });
    return t;
  }

  /** A segmented strip of one-shot actions (no selected state to paint). */
  actions(items) {
    const wrap = el('div', { class: 'seg' });
    for (const [iconName, fn, tip] of items) {
      const b = el('button', { type: 'button', title: tip });
      b.append(icon(iconName, 14));
      b.addEventListener('click', fn);
      wrap.append(b);
    }
    return wrap;
  }

  /**
   * Put the clip's box against an edge or the centre line of the frame.
   * Works off the box as rendered, so it accounts for scale, crop and the
   * text block's real measured size — and it moves a pan by shifting both of
   * its ends, exactly the way an arrow-key nudge does.
   */
  alignToFrame(clip, axis, where) {
    const box = this.renderer.boxFor(clip, this.store.playhead);
    if (!box) return;
    const p = this.store.project;
    const size = axis === 'x' ? box.w : box.h;
    const span = axis === 'x' ? p.width : p.height;
    const now = axis === 'x' ? box.cx : box.cy;
    const want = where === 'start' ? size / 2 : where === 'end' ? span - size / 2 : span / 2;
    const d = want - now;
    if (!d) return;
    this.begin();
    if (clip.motion?.enabled) {
      clip.motion.from[axis] += d;
      clip.motion.to[axis] += d;
    } else {
      clip[axis] += d;
    }
    this.live();
    this.commit('Align to frame');
    this.refresh();
  }

  btn(text, iconName, fn, cls = '') {
    const b = el('button', { class: `btn sm ${cls}`, type: 'button' });
    if (iconName) b.append(icon(iconName, 13));
    if (text) b.append(el('span', {}, text));
    b.addEventListener('click', fn);
    return b;
  }

  // ---------------------------------------------------------------- render
  render() {
    this.updaters = [];
    this._before = null;
    this._sig = this.signature();
    this.root.textContent = '';
    const sel = this.store.selectedClips();
    if (!sel.length) return this.renderProject();
    if (sel.length > 1) return this.renderMulti(sel);
    this.renderClip(sel[0]);
    hydrateIcons(this.root);
  }

  renderProject() {
    const p = this.store.project;
    const body = [
      this.pairRow(
        'Canvas',
        this.num(() => p.width, (v) => (p.width = Math.round(v)), { min: 16, max: 8192, step: 1, label: 'Canvas size' }),
        this.num(() => p.height, (v) => (p.height = Math.round(v)), { min: 16, max: 8192, step: 1, label: 'Canvas size' }),
      ),
      this.row(
        'Presets',
        this.select(
          [
            ['', 'Choose...'],
            ['1024x1024', 'Square 1024'],
            ['1080x1080', 'Square 1080'],
            ['1920x1080', 'Landscape 1080p'],
            ['3840x2160', 'Landscape 4K'],
            ['1080x1920', 'Vertical 1080'],
            ['1280x720', 'Landscape 720p'],
          ],
          () => '',
          (v) => {
            if (!v) return;
            const [w, h] = v.split('x').map(Number);
            p.width = w;
            p.height = h;
          },
          'Canvas preset',
        ),
      ),
      this.numRow('Frame rate', () => p.fps, (v) => (p.fps = clamp(Math.round(v), 1, 120)), { step: 1, min: 1, max: 120, unit: 'fps' }),
      this.row('Background', this.color(() => p.background, (v) => (p.background = v), 'Background')),
    ];
    // Imported media keeps its native pixel size. Nothing is scaled to fit the
    // canvas — a 1733 x 2011 screenshot stays 1733 x 2011 and the frame crops it.
    this.root.append(this.section('Project', 'settings', body, { key: 'project' }));
    this.root.append(
      el('div', { class: 'insp-empty' }, icon('sliders', 30), el('div', {}, 'Select a clip to edit its properties')),
    );
    hydrateIcons(this.root);
  }

  renderMulti(sel) {
    const body = [
      this.row('Opacity', this.range(() => sel[0].opacity, (v) => sel.forEach((c) => (c.opacity = v)), { label: 'Opacity' })),
      this.pairRow(
        'Fade',
        this.num(() => sel[0].fade.in, (v) => sel.forEach((c) => (c.fade.in = clamp(v, 0, c.duration))), { step: 0.1, min: 0, unit: 's', label: 'Fade in' }),
        this.num(() => sel[0].fade.out, (v) => sel.forEach((c) => (c.fade.out = clamp(v, 0, c.duration))), { step: 0.1, min: 0, unit: 's', label: 'Fade out' }),
      ),
      el('div', { class: 'btn-row' },
        this.btn('Delete', 'trash', () => this.store.removeClips(this.store.selection), 'danger'),
      ),
    ];
    this.root.append(this.section(`${sel.length} clips`, 'layers', body, { key: 'multi' }));
    hydrateIcons(this.root);
  }

  renderClip(clip) {
    const asset = this.media.get(clip.assetId);
    const visual = clip.type !== 'audio';
    const hasAudio = clip.type === 'audio' || (clip.type === 'video' && asset?.audioBuffer);
    this.root.append(this.clipSection(clip, asset));
    if (visual) this.root.append(this.transformSection(clip, asset));
    if (visual) this.root.append(this.motionSection(clip));
    this.root.append(this.fadeSection(clip, visual));
    if (hasAudio) this.root.append(this.audioSection(clip));
    if (clip.type === 'text') this.root.append(this.textSection(clip));
    if (clip.type === 'visualizer') this.root.append(this.vizSection(clip));
    if (clip.type === 'image' || clip.type === 'video') this.root.append(this.cropSection(clip, asset));
  }

  clipSection(clip, asset) {
    const fps = this.store.project.fps;
    const body = [
      this.row('Name', this.text(() => clip.name, (v) => (clip.name = v), { label: 'Rename' })),
      this.pairRow(
        'Start / len',
        this.num(() => clip.start, (v) => (clip.start = Math.max(0, v)), { step: 1 / fps, unit: 's', label: 'Clip start' }),
        this.num(() => clip.duration, (v) => (clip.duration = Math.max(1 / fps, v)), { step: 1 / fps, unit: 's', label: 'Clip length' }),
      ),
      (clip.type === 'video' || clip.type === 'audio') &&
        this.numRow('Speed', () => clip.speed, (v) => (clip.speed = clamp(v, 0.1, 8)), { step: 0.05, min: 0.1, max: 8, unit: 'x' }),
      this.row(null, this.check('Clip enabled', () => clip.enabled, (v) => (clip.enabled = v), 'Toggle clip')),
      el('div', { class: 'btn-row' },
        this.btn('Split here', 'scissors', () => this.store.splitAt(this.store.playhead, [clip.id])),
        this.btn('Delete', 'trash', () => this.store.removeClips([clip.id]), 'danger'),
      ),
      asset && el('div', { class: 'hint' },
        `${asset.name} — ${asset.width ? `${asset.width} x ${asset.height} px` : ''}${asset.duration ? ` · ${fmtTime(asset.duration, fps, false)}` : ''} · ${asset.sizeLabel}`),
    ];
    return this.section('Clip', 'film', body, { key: 'clip', badge: clip.type });
  }

  transformSection(clip, asset) {
    const src = this.renderer.sourceSizeOf(clip);
    const native = src ? `${Math.round(src.w)} x ${Math.round(src.h)}` : '';
    const body = [
      this.pairRow(
        'Position',
        this.num(() => clip.x, (v) => (clip.x = v), { step: 1, unit: 'x', label: 'Position' }),
        this.num(() => clip.y, (v) => (clip.y = v), { step: 1, unit: 'y', label: 'Position' }),
      ),
      this.numRow('Scale', () => clip.scale, (v) => (clip.scale = clamp(v, 0.01, 40)), { step: 0.01, min: 0.01, max: 40, unit: 'x' }),
      this.row('Align', el('div', { class: 'pair' },
        this.actions([
          ['alignLeft', () => this.alignToFrame(clip, 'x', 'start'), 'Left edge of frame'],
          ['alignCenter', () => this.alignToFrame(clip, 'x', 'center'), 'Centre horizontally'],
          ['alignRight', () => this.alignToFrame(clip, 'x', 'end'), 'Right edge of frame'],
        ]),
        this.actions([
          ['alignTop', () => this.alignToFrame(clip, 'y', 'start'), 'Top of frame'],
          ['alignMiddle', () => this.alignToFrame(clip, 'y', 'center'), 'Centre vertically'],
          ['alignBottom', () => this.alignToFrame(clip, 'y', 'end'), 'Bottom of frame'],
        ]),
      )),
      el('div', { class: 'btn-row' },
        this.btn('Centre', 'target', () => {
          this.begin();
          clip.x = 0;
          clip.y = 0;
          this.live();
          this.commit('Centre');
        }),
        this.btn('1:1', 'crosshair', () => {
          this.begin();
          clip.scale = 1;
          this.live();
          this.commit('Reset scale');
        }),
      ),
      this.numRow('Rotation', () => clip.rotation, (v) => (clip.rotation = v), { step: 1, min: -360, max: 360, unit: 'deg' }),
      this.row('Opacity', this.range(() => clip.opacity, (v) => (clip.opacity = v), { label: 'Opacity' })),
      this.row('Flip', el('div', { class: 'pair' },
        this.check('Horizontal', () => clip.flipX, (v) => (clip.flipX = v), 'Flip'),
        this.check('Vertical', () => clip.flipY, (v) => (clip.flipY = v), 'Flip'))),
      this.row('Blend', this.select(BLENDS.map((b) => [b, b === 'source-over' ? 'Normal' : b]), () => clip.blend, (v) => (clip.blend = v), 'Blend mode')),
      this.row(null, this.check('Snap to whole pixels', () => clip.pixelSnap, (v) => (clip.pixelSnap = v), 'Pixel snap')),
      this.row(null, this.check('Smooth when scaled', () => clip.smooth, (v) => (clip.smooth = v), 'Smoothing')),
    ];
    // Smoothing off = nearest neighbour. At scale 1.00 every source pixel lands
    // on exactly one canvas pixel; the section badge carries the native size.
    return this.section('Transform', 'move', body, { key: 'transform', badge: native });
  }

  motionSection(clip) {
    const m = clip.motion || (clip.motion = makeMotion(clip.x, clip.y, clip.scale));
    const setHere = (which) => {
      this.begin();
      const cur = which === 'from' ? m.from : m.to;
      cur.x = clip.x;
      cur.y = clip.y;
      cur.scale = clip.scale;
      this.live();
      this.commit('Set pan point');
      this.refresh();
    };
    const body = [
      this.row(null, this.check('Animate this clip (pan / move)', () => m.enabled, (v) => {
        if (v && m.from.x === m.to.x && m.from.y === m.to.y) {
          m.from = { x: clip.x, y: clip.y, scale: clip.scale };
          m.to = { x: clip.x, y: clip.y, scale: clip.scale };
        }
        m.enabled = v;
      }, 'Motion')),
      // A = where it starts, B = where it ends; dragging the image on the frame
      // with the playhead at either end writes that end's point.
      this.pairRow(
        'A start',
        this.num(() => m.from.x, (v) => (m.from.x = v), { step: 1, unit: 'x', label: 'Pan start' }),
        this.num(() => m.from.y, (v) => (m.from.y = v), { step: 1, unit: 'y', label: 'Pan start' }),
      ),
      this.pairRow(
        'B end',
        this.num(() => m.to.x, (v) => (m.to.x = v), { step: 1, unit: 'x', label: 'Pan end' }),
        this.num(() => m.to.y, (v) => (m.to.y = v), { step: 1, unit: 'y', label: 'Pan end' }),
      ),
      this.pairRow(
        'Scale A / B',
        this.num(() => m.from.scale, (v) => (m.from.scale = clamp(v, 0.01, 40)), { step: 0.01, label: 'Pan scale' }),
        this.num(() => m.to.scale, (v) => (m.to.scale = clamp(v, 0.01, 40)), { step: 0.01, label: 'Pan scale' }),
      ),
      el('div', { class: 'btn-row' },
        this.btn('Set A here', 'target', () => setHere('from')),
        this.btn('Set B here', 'target', () => setHere('to')),
      ),
      el('div', { class: 'btn-row' },
        this.btn('Swap A/B', 'refresh', () => {
          this.begin();
          const t = m.from;
          m.from = m.to;
          m.to = t;
          this.live();
          this.commit('Swap pan');
          this.refresh();
        }),
        this.btn('Clear', 'x', () => {
          this.begin();
          clip.motion = makeMotion(clip.x, clip.y, clip.scale);
          this.live();
          this.commit('Clear pan');
          this.render();
        }),
      ),
      this.pairRow(
        'Move over',
        this.num(() => m.start, (v) => (m.start = clamp(v, 0, clip.duration)), { step: 0.1, min: 0, unit: 'from', label: 'Pan window' }),
        this.num(() => (m.end > 0 ? m.end : clip.duration), (v) => (m.end = clamp(v, 0, clip.duration)), { step: 0.1, min: 0, unit: 'to', label: 'Pan window' }),
      ),
      this.row('Easing', this.select(Object.entries(EASING_LABELS), () => m.easing, (v) => (m.easing = v), 'Easing')),
    ].filter(Boolean);
    const dist = Math.hypot(m.to.x - m.from.x, m.to.y - m.from.y);
    const span = (m.end > 0 ? m.end : clip.duration) - m.start;
    body.push(
      el('div', { class: 'hint' },
        `Travels ${Math.round(dist)} px over ${round(Math.max(0, span), 2)} s (${span > 0 ? round(dist / span, 1) : 0} px/s).`),
    );
    return this.section('Pan / motion', 'move', body, { key: 'motion', badge: m.enabled ? 'on' : '' });
  }

  fadeSection(clip, visual) {
    const maxFade = () => clip.duration;
    const body = [
      this.pairRow(
        'Fade in/out',
        this.num(() => clip.fade.in, (v) => (clip.fade.in = clamp(v, 0, maxFade() - clip.fade.out)), { step: 0.05, min: 0, unit: 's', label: 'Fade in' }),
        this.num(() => clip.fade.out, (v) => (clip.fade.out = clamp(v, 0, maxFade() - clip.fade.in)), { step: 0.05, min: 0, unit: 's', label: 'Fade out' }),
      ),
      visual &&
        this.row('Style', this.seg(
          [['black', 'From colour'], ['opacity', 'Opacity']],
          () => clip.fade.mode,
          (v) => (clip.fade.mode = v),
          'Fade style',
        )),
      visual && clip.fade.mode === 'black' && this.row('Fade colour', this.color(() => clip.fade.color, (v) => (clip.fade.color = v), 'Fade colour')),
      el('div', { class: 'btn-row' },
        this.btn('0.5s', null, () => this.setFade(clip, 0.5)),
        this.btn('1s', null, () => this.setFade(clip, 1)),
        this.btn('2s', null, () => this.setFade(clip, 2)),
        this.btn('None', null, () => this.setFade(clip, 0)),
      ),
    ].filter(Boolean);
    // "From colour" dips the whole frame (fade in/out from black); "Opacity"
    // fades only this clip over the layers below. Audio fades ramp gain.
    return this.section(visual ? 'Fade' : 'Fade', 'fade', body, { key: 'fade' });
  }

  setFade(clip, v) {
    this.begin();
    clip.fade.in = clamp(v, 0, clip.duration / 2);
    clip.fade.out = clamp(v, 0, clip.duration / 2);
    this.live();
    this.commit('Fade');
    this.refresh();
  }

  audioSection(clip) {
    const body = [
      // 1.00 is unity gain; the fades above apply to this clip.
      this.row('Volume', this.range(() => clip.gain, (v) => (clip.gain = v), { min: 0, max: 2, step: 0.01, label: 'Volume' })),
    ];
    return this.section('Audio', 'volume', body, { key: 'audio' });
  }

  textSection(clip) {
    const ts = clip.text;
    const sh = ts.shadow;
    const body = [
      this.row(null, this.text(() => ts.content, (v) => (ts.content = v), { area: true, rows: 3, label: 'Text', placeholder: 'Type your title' })),
      this.row('Font', this.select(FONTS, () => ts.font, (v) => (ts.font = v), 'Font')),
      this.pairRow(
        'Size / weight',
        this.num(() => ts.size, (v) => (ts.size = clamp(v, 4, 800)), { step: 1, unit: 'px', label: 'Font size' }),
        this.select([[300, 'Light'], [400, 'Regular'], [500, 'Medium'], [600, 'Semibold'], [700, 'Bold'], [800, 'Extra'], [900, 'Black']].map(([v, t]) => [String(v), t]), () => String(ts.weight), (v) => (ts.weight = Number(v)), 'Font weight'),
      ),
      this.row('Colour', this.color(() => ts.color, (v) => (ts.color = v), 'Text colour')),
      this.row('Align', this.seg(
        [['left', 'alignLeft', true], ['center', 'alignCenter', true], ['right', 'alignRight', true]],
        () => ts.align, (v) => (ts.align = v), 'Align')),
      this.pairRow(
        'Line / letter',
        this.num(() => ts.lineHeight, (v) => (ts.lineHeight = clamp(v, 0.5, 4)), { step: 0.05, label: 'Line height' }),
        this.num(() => ts.letterSpacing, (v) => (ts.letterSpacing = v), { step: 0.5, unit: 'px', label: 'Letter spacing' }),
      ),
      this.numRow('Wrap width', () => ts.maxWidth, (v) => (ts.maxWidth = Math.max(0, v)), { step: 10, min: 0, unit: 'px' }),
      this.row(null, this.check('Italic', () => ts.italic, (v) => (ts.italic = v), 'Italic')),
      el('div', { class: 'btn-row' },
        this.btn('Column to frame', 'maximize', () => {
          this.begin();
          ts.maxWidth = Math.round(this.store.project.width * 0.8);
          this.live();
          this.commit('Wrap width');
          this.refresh();
        }),
        this.btn('Hug text', 'x', () => {
          this.begin();
          ts.maxWidth = 0;
          this.live();
          this.commit('Wrap width');
          this.refresh();
        }),
      ),
      this.alignHint(ts),
    ];
    // 0 wrap width = the text never wraps on its own; use line breaks.
    const shadowBody = [
      this.row(null, this.check('Drop shadow', () => sh.enabled, (v) => (sh.enabled = v), 'Shadow')),
      this.row('Colour', this.color(() => sh.color, (v) => (sh.color = v), 'Shadow colour')),
      this.row('Opacity', this.range(() => sh.opacity, (v) => (sh.opacity = v), { label: 'Shadow opacity' })),
      this.numRow('Blur', () => sh.blur, (v) => (sh.blur = clamp(v, 0, 200)), { step: 1, min: 0, unit: 'px' }),
      this.pairRow(
        'Offset',
        this.num(() => sh.offsetX, (v) => (sh.offsetX = v), { step: 1, unit: 'x', label: 'Shadow offset' }),
        this.num(() => sh.offsetY, (v) => (sh.offsetY = v), { step: 1, unit: 'y', label: 'Shadow offset' }),
      ),
      this.row(null, this.check('Outline', () => ts.stroke.enabled, (v) => (ts.stroke.enabled = v), 'Outline')),
      this.pairRow(
        'Outline',
        this.num(() => ts.stroke.width, (v) => (ts.stroke.width = clamp(v, 0, 60)), { step: 0.5, min: 0, unit: 'px', label: 'Outline width' }),
        this.color(() => ts.stroke.color, (v) => (ts.stroke.color = v), 'Outline colour'),
      ),
      this.row(null, this.check('Background box', () => ts.box.enabled, (v) => (ts.box.enabled = v), 'Text box')),
      this.pairRow(
        'Box',
        this.color(() => ts.box.color, (v) => (ts.box.color = v), 'Box colour'),
        this.num(() => ts.box.radius, (v) => (ts.box.radius = clamp(v, 0, 200)), { step: 1, min: 0, unit: 'r', label: 'Box radius' }),
      ),
      this.row('Box opacity', this.range(() => ts.box.opacity, (v) => (ts.box.opacity = v), { label: 'Box opacity' })),
      this.pairRow(
        'Box padding',
        this.num(() => ts.box.padX, (v) => (ts.box.padX = clamp(v, 0, 400)), { step: 2, unit: 'x', label: 'Box padding' }),
        this.num(() => ts.box.padY, (v) => (ts.box.padY = clamp(v, 0, 400)), { step: 2, unit: 'y', label: 'Box padding' }),
      ),
    ];
    const frag = document.createDocumentFragment();
    frag.append(this.section('Text', 'type', body, { key: 'text' }));
    frag.append(this.section('Shadow & outline', 'sparkle', shadowBody, { key: 'shadow', badge: sh.enabled ? 'on' : '' }));
    return frag;
  }

  /**
   * Align is a lines-within-the-block control, and with no wrap width the
   * block is exactly as wide as the longest line — so on a one-line title it
   * has nothing to move. Rather than leave that looking broken, say it, and
   * point at the two controls that do what was probably meant.
   */
  alignHint(ts) {
    const h = el('div', { class: 'hint' });
    const paint = () => {
      h.textContent = ts.maxWidth > 0
        ? 'Align ranges the lines inside the wrap width. To move the whole block in the frame, use Align under Transform.'
        : 'The block hugs the text, so Align only ranges the lines against each other — a single line has nowhere to go. Set a wrap width to align inside a fixed column, or use Align under Transform to move the whole block.';
    };
    paint();
    this.updaters.push(paint);
    return h;
  }

  vizSection(clip) {
    const v = clip.visualizer;
    const audioAssets = this.media.list().filter((a) => a.kind === 'audio' || a.audioBuffer);
    const body = [
      this.row('Source', this.select(
        [['master', 'All audio (master mix)'], ...audioAssets.map((a) => [a.id, a.name])],
        () => v.source, (x) => (v.source = x), 'Visualiser source')),
      this.row('Style', this.select(
        [['bars', 'Bars'], ['mirror', 'Mirrored bars'], ['line', 'Line'], ['radial', 'Radial']],
        () => v.style, (x) => (v.style = x), 'Visualiser style')),
      this.numRow('Bars', () => v.bars, (x) => (v.bars = clamp(Math.round(x), 4, 256)), { step: 1, min: 4, max: 256 }),
      this.pairRow(
        'Size',
        this.num(() => v.width, (x) => (v.width = clamp(x, 20, 8192)), { step: 10, unit: 'w', label: 'Visualiser size' }),
        this.num(() => v.height, (x) => (v.height = clamp(x, 10, 8192)), { step: 10, unit: 'h', label: 'Visualiser size' }),
      ),
      this.row('Gap', this.range(() => v.gap, (x) => (v.gap = x), { min: 0, max: 0.9, label: 'Bar gap' })),
      this.numRow('Corner', () => v.radius, (x) => (v.radius = clamp(x, 0, 60)), { step: 1, min: 0, unit: 'px' }),
      this.pairRow(
        'Colours',
        this.color(() => v.color, (x) => (v.color = x), 'Visualiser colour'),
        this.color(() => v.color2, (x) => (v.color2 = x), 'Visualiser colour'),
      ),
      this.numRow('Glow', () => v.glow, (x) => (v.glow = clamp(x, 0, 100)), { step: 1, min: 0, unit: 'px' }),
      this.row('Sensitivity', this.range(() => v.gain, (x) => (v.gain = x), { min: 0.2, max: 6, step: 0.05, label: 'Sensitivity' })),
      this.row('Smoothing', this.range(() => v.smoothing, (x) => (v.smoothing = x), { min: 0, max: 0.95, label: 'Smoothing' })),
      this.pairRow(
        'Freq range',
        this.num(() => v.minFreq, (x) => (v.minFreq = clamp(x, 20, 2000)), { step: 10, unit: 'Hz', label: 'Frequency range' }),
        this.num(() => v.maxFreq, (x) => (v.maxFreq = clamp(x, 500, 22000)), { step: 100, unit: 'Hz', label: 'Frequency range' }),
      ),
      this.numRow('Noise floor', () => v.floorDb, (x) => (v.floorDb = clamp(x, -120, -10)), { step: 1, min: -120, max: -10, unit: 'dB' }),
    ];
    // The spectrum is read straight from the decoded audio, so the preview and
    // the export match frame for frame.
    return this.section('Visualiser', 'waveform', body, { key: 'viz' });
  }

  cropSection(clip, asset) {
    const c = clip.crop;
    const maxW = asset?.width || 8192;
    const maxH = asset?.height || 8192;
    const body = [
      this.pairRow(
        'Top / bottom',
        this.num(() => c.top, (v) => (c.top = clamp(v, 0, maxH - c.bottom - 1)), { step: 1, min: 0, unit: 'px', label: 'Crop' }),
        this.num(() => c.bottom, (v) => (c.bottom = clamp(v, 0, maxH - c.top - 1)), { step: 1, min: 0, unit: 'px', label: 'Crop' }),
      ),
      this.pairRow(
        'Left / right',
        this.num(() => c.left, (v) => (c.left = clamp(v, 0, maxW - c.right - 1)), { step: 1, min: 0, unit: 'px', label: 'Crop' }),
        this.num(() => c.right, (v) => (c.right = clamp(v, 0, maxW - c.left - 1)), { step: 1, min: 0, unit: 'px', label: 'Crop' }),
      ),
      el('div', { class: 'btn-row' }, this.btn('Reset crop', 'x', () => {
        this.begin();
        clip.crop = { top: 0, right: 0, bottom: 0, left: 0 };
        this.live();
        this.commit('Reset crop');
        this.render();
      })),
    ];
    return this.section('Crop', 'grid', body, { key: 'crop' });
  }
}

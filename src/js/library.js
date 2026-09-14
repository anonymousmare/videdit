// Left panel: media pool, text presets, visualiser presets.

import { el, fmtTime } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { makeClip, makeTextStyle, makeVisualizer } from './store.js';
import { scanDataTransfer } from './folders.js';

// A dropped folder tree can be enormous; import a sane slice of it and say so.
const MAX_DROP = 300;

export class Library {
  constructor({ store, media, timeline, playback, relinker = null }) {
    this.store = store;
    this.media = media;
    this.timeline = timeline;
    this.playback = playback;
    this.relinker = relinker;
    this.body = document.getElementById('leftBody');
    this.tabsEl = document.getElementById('leftTabs');
    this.tab = 'media';
    this.tabsEl.addEventListener('click', (e) => {
      const b = e.target.closest('.tab');
      if (!b) return;
      this.tab = b.dataset.tab;
      [...this.tabsEl.children].forEach((c) => c.classList.toggle('active', c === b));
      this.render();
    });
    this.media.on('change', () => this.tab === 'media' && this.render());
    this.store.on('change', () => this.tab === 'audio' && this.render());
    this.store.on('missing', () => this.tab === 'media' && this.render());
    this.render();
    this.wireGlobalDrop();
  }

  render() {
    this.body.textContent = '';
    if (this.tab === 'media') this.renderMedia();
    else if (this.tab === 'text') this.renderText();
    else this.renderViz();
    hydrateIcons(this.body);
  }

  pick() {
    document.getElementById('filePicker').click();
  }

  renderMedia() {
    const missing = this.relinker?.missing() || [];
    if (missing.length) {
      const banner = el('div', { class: 'offline-banner' });
      banner.append(icon('info', 14));
      banner.append(el('div', { class: 'txt' },
        el('b', {}, `${missing.length} file${missing.length > 1 ? 's' : ''} offline`)));
      const b = el('button', { class: 'btn sm', type: 'button' }, 'Relink...');
      b.addEventListener('click', () => this.relinker.open());
      banner.append(b);
      this.body.append(banner);
    }

    const zone = el('div', { class: 'dropzone' });
    zone.append(icon('upload', 22));
    zone.append(el('b', {}, 'Import media'));
    zone.addEventListener('click', () => this.pick());
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('hot');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('hot')));
    // No import here: the window-level handler in wireGlobalDrop() catches the
    // same event as it bubbles, and importing in both places imports twice.
    this.body.append(zone);

    const assets = this.media.list();
    if (!assets.length) return;
    const grid = el('div', { class: 'asset-grid' });
    for (const a of assets) grid.append(this.assetCard(a));
    this.body.append(grid);
  }

  assetCard(a) {
    const card = el('div', { class: 'asset', draggable: 'true', title: a.name });
    const thumb = el('div', { class: 'thumb' });
    if (a.thumb) thumb.style.backgroundImage = `url(${a.thumb})`;
    else thumb.append(icon(a.kind === 'audio' ? 'music' : a.kind === 'video' ? 'video' : 'image', 24));
    const kindTag = el('div', { class: `kind ${a.kind}` });
    kindTag.append(icon(a.kind === 'audio' ? 'music' : a.kind === 'video' ? 'video' : 'image', 12));
    const rm = el('button', { class: 'rm', type: 'button', title: 'Remove from library' });
    rm.append(icon('x', 12));
    rm.addEventListener('click', (e) => {
      e.stopPropagation();
      this.media.remove(a.id);
    });
    const sub =
      a.kind === 'image'
        ? `${a.width} x ${a.height}`
        : `${fmtTime(a.duration || 0, 30, false)}${a.width ? ` · ${a.width}x${a.height}` : ''}`;
    const add = el('div', { class: 'add' });
    const addBtn = el('button', { class: 'btn sm', type: 'button' });
    addBtn.append(icon('plus', 12), el('span', {}, 'Add'));
    addBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      this.timeline.appendAsset(a.id);
    });
    add.append(addBtn);

    card.append(thumb, kindTag, rm, add, el('div', { class: 'meta' },
      el('div', { class: 'nm' }, a.name), el('div', { class: 'sub' }, sub)));
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/videdit-asset', a.id);
      e.dataTransfer.setData('text/plain', a.name); // Firefox wants a standard type too
      e.dataTransfer.effectAllowed = 'copy';
      // The default drag image is the whole card, grabbed wherever the pointer
      // happened to be, so the block always landed somewhere other than where
      // it looked like it would. A small chip pinned by its left edge to the
      // pointer makes the pointer the clip's start, exactly as it reads.
      const chip = el('div', { class: 'drag-chip' }, a.name);
      document.body.append(chip);
      e.dataTransfer.setDragImage(chip, 0, chip.offsetHeight / 2);
      setTimeout(() => chip.remove(), 0);
      this.timeline.beginAssetDrag(a);
    });
    card.addEventListener('dragend', () => this.timeline.endAssetDrag());
    card.addEventListener('dblclick', () => this.timeline.appendAsset(a.id));
    return card;
  }

  // ------------------------------------------------------------------ text
  // Presets land at the playhead on the first free video track.
  renderText() {
    const presets = [
      ['Title', { size: 128, weight: 800, letterSpacing: 2, content: 'TITLE' }],
      ['Subtitle', { size: 54, weight: 500, letterSpacing: 6, content: 'a subtitle', shadow: { enabled: true, color: '#000000', opacity: 0.6, blur: 10, offsetX: 0, offsetY: 3 } }],
      ['Lower third', { size: 44, weight: 600, align: 'left', content: 'Name\\nRole', box: { enabled: true, color: '#000000', opacity: 0.55, padX: 26, padY: 14, radius: 6 } }],
      ['Hard outline', { size: 96, weight: 900, content: 'IMPACT', stroke: { enabled: true, color: '#000000', width: 7 }, shadow: { enabled: true, color: '#000000', opacity: 0.85, blur: 0, offsetX: 6, offsetY: 6 } }],
    ];
    for (const [name, over] of presets) {
      this.body.append(this.presetCard(name, 'type', () => {
        const text = makeTextStyle({ ...over, content: String(over.content).replace(/\\n/g, '\n') });
        const clip = makeClip('text', { name, duration: 3, overrides: { text } });
        clip.y = name === 'Lower third' ? Math.round(this.store.project.height * 0.32) : 0;
        if (name === 'Lower third') clip.x = -Math.round(this.store.project.width * 0.18);
        this.timeline.insert(clip, 'video');
      }));
    }
  }

  // ------------------------------------------------------------- visualiser
  // A visualiser goes on a video track and reads the master audio mix, so it
  // reacts to whatever is playing underneath it.
  renderViz() {
    const presets = [
      ['Bars', 'bars', { bars: 64, height: 260, width: 900 }],
      ['Mirrored bars', 'mirror', { bars: 72, height: 320, width: 1000, gap: 0.4 }],
      ['Line', 'line', { bars: 128, height: 220, width: 1000, glow: 16 }],
      ['Radial', 'radial', { bars: 96, height: 720, width: 720, gap: 0.45 }],
    ];
    for (const [name, style, over] of presets) {
      this.body.append(this.presetCard(name, 'waveform', () => {
        const viz = makeVisualizer({ style, ...over });
        const clip = makeClip('visualizer', { name: `${name} visualiser`, duration: 5, overrides: { visualizer: viz } });
        clip.y = Math.round(this.store.project.height * 0.3);
        this.timeline.insert(clip, 'video');
      }));
    }
  }

  presetCard(name, iconName, onAdd) {
    const card = el('div', {
      class: 'asset',
      style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', cursor: 'pointer', marginBottom: '8px' },
    });
    card.append(icon(iconName, 18));
    card.append(el('div', { style: { flex: '1', minWidth: '0' } }, el('div', { class: 'nm' }, name)));
    const b = el('button', { class: 'btn sm icon', type: 'button', title: `Add ${name}` });
    b.append(icon('plus', 13));
    card.append(b);
    card.addEventListener('click', onAdd);
    return card;
  }

  /** Dropping files — or whole folders — anywhere in the window imports them. */
  wireGlobalDrop() {
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', async (e) => {
      if (!e.dataTransfer?.types?.includes('Files')) return;
      e.preventDefault();
      // Folders arrive as directory entries rather than files, so walk them;
      // dataTransfer.items must be read before the first await, which
      // scanDataTransfer does.
      const entries = await scanDataTransfer(e.dataTransfer);
      const files = entries.map((x) => x.file).filter(Boolean);
      if (!files.length) return;
      const capped = files.length > MAX_DROP;
      const added = await this.media.importFiles(files.slice(0, MAX_DROP));
      if (added.length) {
        this.store.emit('toast', `Imported ${added.length} file${added.length > 1 ? 's' : ''}`
          + (capped ? ` (the first ${MAX_DROP} of ${files.length})` : ''));
      }
    });
  }
}

// Left panel: media pool, text presets, visualiser presets.

import { el, fmtTime } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { makeClip, makeTextStyle, makeVisualizer } from './store.js';

export class Library {
  constructor({ store, media, timeline, playback }) {
    this.store = store;
    this.media = media;
    this.timeline = timeline;
    this.playback = playback;
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
    const zone = el('div', { class: 'dropzone' });
    zone.append(icon('upload', 22));
    zone.append(el('b', {}, 'Import media'));
    zone.append(el('span', {}, 'Drop screenshots, video or audio here, or click to browse. Images keep their exact pixel size.'));
    zone.addEventListener('click', () => this.pick());
    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('hot');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('hot')));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      if (e.dataTransfer.files.length) this.media.importFiles([...e.dataTransfer.files]);
    });
    this.body.append(zone);

    const assets = this.media.list();
    if (!assets.length) {
      this.body.append(el('div', { class: 'hint', style: { marginTop: '12px' } },
        'Nothing imported yet. Drag an asset onto a track, or double-click it to drop it at the playhead.'));
      return;
    }
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
      e.dataTransfer.effectAllowed = 'copy';
    });
    card.addEventListener('dblclick', () => this.timeline.appendAsset(a.id));
    return card;
  }

  // ------------------------------------------------------------------ text
  renderText() {
    this.body.append(el('div', { class: 'hint', style: { marginBottom: '10px' } },
      'Presets land at the playhead on the first free video track. Shadow, outline and a background box live in Properties.'));
    const presets = [
      ['Title', { size: 128, weight: 800, letterSpacing: 2, content: 'TITLE' }, 'A big centred title with a soft drop shadow.'],
      ['Subtitle', { size: 54, weight: 500, letterSpacing: 6, content: 'a subtitle', shadow: { enabled: true, color: '#000000', opacity: 0.6, blur: 10, offsetX: 0, offsetY: 3 } }, 'Smaller, wide-tracked line.'],
      ['Lower third', { size: 44, weight: 600, align: 'left', content: 'Name\\nRole', box: { enabled: true, color: '#000000', opacity: 0.55, padX: 26, padY: 14, radius: 6 } }, 'Left-aligned with a background box.'],
      ['Hard outline', { size: 96, weight: 900, content: 'IMPACT', stroke: { enabled: true, color: '#000000', width: 7 }, shadow: { enabled: true, color: '#000000', opacity: 0.85, blur: 0, offsetX: 6, offsetY: 6 } }, 'Outline plus a hard offset shadow.'],
    ];
    for (const [name, over, note] of presets) {
      this.body.append(this.presetCard(name, 'type', note, () => {
        const text = makeTextStyle({ ...over, content: String(over.content).replace(/\\n/g, '\n') });
        const clip = makeClip('text', { name, duration: 3, overrides: { text } });
        clip.y = name === 'Lower third' ? Math.round(this.store.project.height * 0.32) : 0;
        if (name === 'Lower third') clip.x = -Math.round(this.store.project.width * 0.18);
        this.timeline.insert(clip, 'video');
      }));
    }
  }

  // ------------------------------------------------------------- visualiser
  renderViz() {
    const hasAudio = this.media.list().some((a) => a.audioBuffer);
    this.body.append(el('div', { class: 'hint', style: { marginBottom: '10px' } },
      hasAudio
        ? 'Drop a visualiser on a video track. It reads the master audio mix by default, so it reacts to whatever is playing underneath it.'
        : 'Import an audio file first — the visualiser draws the spectrum of the audio on your timeline.'));
    const presets = [
      ['Bars', 'bars', { bars: 64, height: 260, width: 900 }],
      ['Mirrored bars', 'mirror', { bars: 72, height: 320, width: 1000, gap: 0.4 }],
      ['Line', 'line', { bars: 128, height: 220, width: 1000, glow: 16 }],
      ['Radial', 'radial', { bars: 96, height: 720, width: 720, gap: 0.45 }],
    ];
    for (const [name, style, over] of presets) {
      this.body.append(this.presetCard(name, 'waveform', 'Reacts to the master mix.', () => {
        const viz = makeVisualizer({ style, ...over });
        const clip = makeClip('visualizer', { name: `${name} visualiser`, duration: 5, overrides: { visualizer: viz } });
        clip.y = Math.round(this.store.project.height * 0.3);
        this.timeline.insert(clip, 'video');
      }));
    }
  }

  presetCard(name, iconName, note, onAdd) {
    const card = el('div', {
      class: 'asset',
      style: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px', cursor: 'pointer', marginBottom: '8px' },
    });
    card.append(icon(iconName, 18));
    card.append(el('div', { style: { flex: '1', minWidth: '0' } },
      el('div', { class: 'nm' }, name), el('div', { class: 'sub', style: { fontFamily: 'inherit' } }, note)));
    const b = el('button', { class: 'btn sm icon', type: 'button', title: `Add ${name}` });
    b.append(icon('plus', 13));
    card.append(b);
    card.addEventListener('click', onAdd);
    return card;
  }

  /** Dropping files anywhere in the window imports them. */
  wireGlobalDrop() {
    window.addEventListener('dragover', (e) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    });
    window.addEventListener('drop', (e) => {
      if (!e.dataTransfer?.files?.length) return;
      e.preventDefault();
      this.media.importFiles([...e.dataTransfer.files]);
    });
  }
}

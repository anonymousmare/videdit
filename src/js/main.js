// Bootstrap: wires the panels together, the transport, shortcuts and I/O.

import { store, makeClip } from './store.js';
import { media } from './media.js';
import { Renderer } from './renderer.js';
import { AudioEngine } from './audio.js';
import { Playback } from './playback.js';
import { Timeline } from './timeline.js';
import { Preview } from './preview.js';
import { Inspector } from './inspector.js';
import { Library } from './library.js';
import { Exporter } from './exporter.js';
import { Relinker, describeAsset } from './relink.js';
import { icon, hydrateIcons } from './icons.js';
import { clamp, download, el, fmtTime, drag, deepClone, uid } from './util.js';

hydrateIcons(document);

const audio = new AudioEngine(store, media);
const renderer = new Renderer({
  canvas: document.getElementById('preview'),
  store,
  media,
  spectrum: (t, clip) => audio.spectrumAt(t, clip),
});
const playback = new Playback(store, media, renderer, audio);
const relinker = new Relinker({ store, media, playback });
const timeline = new Timeline({ store, media, playback });
const preview = new Preview({ store, media, renderer, playback });
const inspector = new Inspector({ store, media, renderer, playback, timeline });
const library = new Library({ store, media, timeline, playback, relinker });
const exporter = new Exporter({ store, media, renderer, playback, audio });

const $ = (id) => document.getElementById(id);

// ------------------------------------------------------------------ toasts
function toast(msg, kind = '') {
  const t = el('div', { class: `toast ${kind}` }, msg);
  $('toasts').append(t);
  setTimeout(() => {
    t.style.transition = 'opacity .25s';
    t.style.opacity = '0';
    setTimeout(() => t.remove(), 260);
  }, 2600);
}
store.on('toast', (m) => toast(m));
media.on('error', (m) => toast(m, 'err'));

// ------------------------------------------------------------------ topbar
$('projName').addEventListener('input', (e) => {
  store.project.name = e.target.value;
});
$('btnUndo').addEventListener('click', () => store.undo());
$('btnRedo').addEventListener('click', () => store.redo());
$('btnSplit').addEventListener('click', () => doSplit());
$('tlSplit').addEventListener('click', () => doSplit());
$('btnDelete').addEventListener('click', () => doDelete());
$('tlDelete').addEventListener('click', () => doDelete());
$('btnDupe').addEventListener('click', () => doDuplicate());
$('tlDupe').addEventListener('click', () => doDuplicate());
$('btnExport').addEventListener('click', () => exporter.open());
$('btnCanvas').addEventListener('click', () => {
  store.select([]);
  toast('Canvas size and frame rate are in Properties on the right');
});
$('btnHelp').addEventListener('click', showHelp);
$('btnImport').addEventListener('click', () => library.pick());

// Tell people where to put their files until there are some.
function paintEmptyState() {
  $('stageEmpty').hidden = media.list().length > 0 || store.allClips().length > 1;
}
media.on('change', paintEmptyState);
store.on('change', paintEmptyState);

function doSplit() {
  const ids = store.selection.length ? store.selection : null;
  const n = store.splitAt(store.playhead, ids);
  if (!n) toast('Put the playhead over a clip to split it');
}
function doDelete() {
  if (!store.selection.length) return toast('Nothing selected');
  store.removeClips([...store.selection]);
}
function doDuplicate() {
  const sel = store.selectedClips();
  if (!sel.length) return toast('Nothing selected');
  store.commit('Duplicate', () => {
    const ids = [];
    for (const c of sel) {
      const track = store.trackOf(c.id);
      const copy = deepClone(c);
      copy.id = uid('clip');
      copy.start = c.start + c.duration;
      const dest = store.findSlot(track.kind, copy.start, copy.duration, track.id) || store.addTrackSilently(track.kind);
      dest.clips.push(copy);
      ids.push(copy.id);
    }
    store.selection = ids;
  });
}

// ------------------------------------------------------------------ transport
$('btnPlay').addEventListener('click', () => playback.toggle());
$('btnStart').addEventListener('click', () => playback.seek(0));
$('btnEnd').addEventListener('click', () => playback.seek(store.duration()));
$('btnPrev').addEventListener('click', () => playback.stepFrame(-1));
$('btnNext').addEventListener('click', () => playback.stepFrame(1));
$('btnLoop').addEventListener('click', (e) => {
  playback.loop = !playback.loop;
  e.currentTarget.classList.toggle('on', playback.loop);
});
$('btnMute').addEventListener('click', (e) => {
  audio.setMuted(!audio.muted);
  e.currentTarget.textContent = '';
  e.currentTarget.append(icon(audio.muted ? 'volumeOff' : 'volume', 16));
  e.currentTarget.classList.toggle('on', audio.muted);
});
$('volume').addEventListener('input', (e) => audio.setVolume(Number(e.target.value)));

playback.on('state', (playing) => {
  const b = $('btnPlay');
  b.textContent = '';
  b.append(icon(playing ? 'pause' : 'play', 16));
  b.classList.toggle('on', playing);
});

function paintTime() {
  $('tcNow').textContent = fmtTime(store.playhead, store.project.fps);
  $('tcTot').textContent = `/ ${fmtTime(store.duration(), store.project.fps)}`;
  $('btnCanvas').lastChild.textContent = ` ${store.project.width} × ${store.project.height} · ${store.project.fps}fps`;
}
playback.on('tick', paintTime);
store.on('seek', paintTime);
store.on('change', paintTime);
store.on('live', paintTime);
store.on('history', () => {
  $('btnUndo').disabled = !store.history.length;
  $('btnRedo').disabled = !store.future.length;
});

// ------------------------------------------------------------------ timeline bar
$('tlAddV').addEventListener('click', () => store.addTrack('video'));
$('tlAddA').addEventListener('click', () => store.addTrack('audio'));
$('tlSnap').addEventListener('click', (e) => {
  store.snapping = !store.snapping;
  e.currentTarget.classList.toggle('on', store.snapping);
});
$('tlZoom').addEventListener('input', (e) => timeline.setZoom(Number(e.target.value)));
$('tlZoomIn').addEventListener('click', () => timeline.setZoom(store.zoom * 1.35));
$('tlZoomOut').addEventListener('click', () => timeline.setZoom(store.zoom / 1.35));
$('tlFit').addEventListener('click', () => timeline.fit());

// ------------------------------------------------------------------ splitter
$('vsplit').addEventListener('pointerdown', (e) => {
  const start = $('app').getBoundingClientRect().height;
  const cur = parseFloat(getComputedStyle($('app')).getPropertyValue('--tl-h')) || 320;
  drag(e, {
    cursor: 'row-resize',
    onMove: ({ dy }) => {
      $('app').style.setProperty('--tl-h', `${clamp(cur - dy, 130, start - 260)}px`);
      timeline.layout();
      preview.resize();
    },
  });
});

// ------------------------------------------------------------------ files
$('filePicker').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  e.target.value = '';
  if (!files.length) return;
  const added = await media.importFiles(files);
  if (added.length) toast(`Imported ${added.length} file${added.length > 1 ? 's' : ''}`);
});

// ------------------------------------------------------------------ project I/O
$('btnSave').addEventListener('click', () => {
  // Missing media is saved too: a project half-relinked would otherwise forget
  // the names of the files it is still looking for, and never find them again.
  const assets = media.list().map(describeAsset);
  const known = new Set(assets.map((a) => a.id));
  for (const want of relinker.missing()) if (!known.has(want.id)) assets.push(want);
  const payload = {
    format: 'videdit-project',
    version: 2,
    savedAt: new Date().toISOString(),
    project: store.project,
    assets,
  };
  download(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    `${(store.project.name || 'project').replace(/[^\w\-]+/g, '_')}.videdit.json`);
  store.dirty = false;
  toast('Project saved'); // media is referenced by name, never embedded
});

$('btnOpen').addEventListener('click', () => $('projPicker').click());
$('projPicker').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.format !== 'videdit-project') throw new Error('not a videdit project');
    store.history.length = 0;
    store.future.length = 0;
    store.project = data.project;
    store.selection = [];
    store.playhead = 0;
    $('projName').value = store.project.name || 'Untitled';
    store.changed();
    store.emit('selection');
    store.emit('seek', 0);
    timeline.fit();
    const needed = (data.assets || []).filter((a) => usedAssetIds().has(a.id) && !media.get(a.id));
    if (!needed.length) {
      toast('Project opened');
      return;
    }
    // Remembered folders are searched first; the dialog only appears for what
    // they could not find, and stays open across as many folders as it takes.
    const res = await relinker.begin(needed);
    if (res.auto && !res.linked) toast('Project opened');
  } catch (err) {
    toast(`Could not open: ${err.message}`, 'err');
  }
});

function usedAssetIds() {
  const s = new Set();
  for (const t of store.project.tracks) {
    for (const c of t.clips) {
      if (c.assetId) s.add(c.assetId);
      if (c.visualizer?.source && c.visualizer.source !== 'master') s.add(c.visualizer.source);
    }
  }
  return s;
}

// ------------------------------------------------------------------ shortcuts
const typing = (e) => {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable || t.tagName === 'SELECT');
};

window.addEventListener('keydown', (e) => {
  if (typing(e)) {
    if (e.key === 'Escape') e.target.blur();
    return;
  }
  const meta = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (meta && k === 'z') {
    e.preventDefault();
    e.shiftKey ? store.redo() : store.undo();
    return;
  }
  if (meta && k === 'y') {
    e.preventDefault();
    store.redo();
    return;
  }
  if (meta && k === 'd') {
    e.preventDefault();
    doDuplicate();
    return;
  }
  if (meta && k === 's') {
    e.preventDefault();
    $('btnSave').click();
    return;
  }
  if (meta && k === 'e') {
    e.preventDefault();
    exporter.open();
    return;
  }
  if (meta && k === 'a') {
    e.preventDefault();
    store.select(store.allClips().map((c) => c.id));
    return;
  }
  if (meta && k === 'i') {
    e.preventDefault();
    library.pick();
    return;
  }

  switch (e.key) {
    case ' ':
      e.preventDefault();
      playback.toggle();
      break;
    case 's':
    case 'S':
      doSplit();
      break;
    case 'Delete':
    case 'Backspace':
      e.preventDefault();
      doDelete();
      break;
    case 'Home':
      playback.seek(0);
      break;
    case 'End':
      playback.seek(store.duration());
      break;
    case ',':
      playback.stepFrame(-1);
      break;
    case '.':
      playback.stepFrame(1);
      break;
    case '+':
    case '=':
      timeline.setZoom(store.zoom * 1.35);
      break;
    case '-':
      timeline.setZoom(store.zoom / 1.35);
      break;
    case 'z':
    case 'Z':
      if (e.shiftKey) timeline.fit();
      break;
    case 'Escape':
      store.select([]);
      break;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown': {
      const sel = store.selectedClips().filter((c) => c.type !== 'audio');
      if (!sel.length) {
        playback.stepFrame(e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0);
        return;
      }
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = (e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0);
      const dy = (e.key === 'ArrowDown' ? step : e.key === 'ArrowUp' ? -step : 0);
      store.commit('Nudge', () => {
        for (const c of sel) {
          if (c.motion?.enabled) {
            c.motion.from.x += dx;
            c.motion.from.y += dy;
            c.motion.to.x += dx;
            c.motion.to.y += dy;
          } else {
            c.x += dx;
            c.y += dy;
          }
        }
      });
      break;
    }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (!store.dirty) return;
  e.preventDefault();
  e.returnValue = '';
});

// ------------------------------------------------------------------ help
function showHelp() {
  const pairs = [
    ['Space', 'Play / pause'],
    ['S', 'Split at the playhead'],
    ['Del', 'Delete selection'],
    ['Ctrl D', 'Duplicate'],
    ['Ctrl Z / Ctrl Shift Z', 'Undo / redo'],
    ['Ctrl I', 'Import media'],
    ['Ctrl S / Ctrl E', 'Save project / export'],
    [', .', 'Step one frame'],
    ['Home / End', 'Jump to start / end'],
    ['Arrows', 'Nudge the selected clip 1 px (Shift: 10 px)'],
    ['+ / -', 'Zoom the timeline'],
    ['Shift Z', 'Fit the timeline'],
    ['Wheel', 'Run the timeline forward / back'],
    ['Alt wheel', 'Scroll the tracks up / down'],
    ['Ctrl wheel', 'Zoom the timeline around the pointer'],
    ['Shift drag', 'Constrain a move to one axis'],
    ['Alt drag', 'Move on the frame without snapping to the guides'],
    ['Right-click a track head', 'Delete that track'],
  ];
  const grid = el('div', { class: 'shortcut-grid' });
  for (const [k, v] of pairs) grid.append(el('span', { class: 'kbd' }, k), el('span', {}, v));
  const scrim = el('div', { class: 'scrim' });
  const modal = el('div', { class: 'modal' });
  const head = el('header', {});
  head.append(icon('info', 16), el('span', {}, 'Shortcuts'), el('div', { class: 'spacer' }));
  const x = el('button', { class: 'btn icon ghost', type: 'button' });
  x.append(icon('x', 14));
  head.append(x);
  // Images and video sit at their native pixel size and are never scaled to fit
  // the canvas; at scale 1.00 the readout on the frame turns green.
  modal.append(head, el('div', { class: 'body' }, grid));
  scrim.append(modal);
  document.body.append(scrim);
  const close = () => scrim.remove();
  x.addEventListener('click', close);
  scrim.addEventListener('pointerdown', (e) => e.target === scrim && close());
}

// ------------------------------------------------------------------ go
store.emit('history');
timeline.render();
paintTime();
paintEmptyState();
playback.invalidate();

// A starting point so the app is never a blank grid.
if (!store.allClips().length) {
  const t = store.project.tracks.find((x) => x.kind === 'video' && x.name === 'V1');
  const clip = makeClip('text', { name: 'Title', duration: 3 });
  clip.text.content = 'videdit';
  clip.text.size = 140;
  clip.text.letterSpacing = 4;
  clip.fade.in = 0.6;
  clip.fade.out = 0.6;
  t.clips.push(clip);
  store.history.length = 0;
  store.dirty = false;
  store.changed();
  timeline.fit();
}

window.videdit = { store, media, renderer, playback, timeline, preview, inspector, exporter, audio, relinker };

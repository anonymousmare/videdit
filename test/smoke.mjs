// End-to-end check in a real Chromium. Starts the dev server, drives the app
// and asserts the things that are easy to break — above all that an imported
// image lands on the canvas at native size with no resampling.
//
//   npm i -D playwright && npx playwright install chromium
//   npm test

import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { build, DIR, shotPixel } from './fixtures.mjs';

const require = createRequire(import.meta.url);
// `npm test -- firefox` (or BROWSER=firefox) runs the same checks in Gecko.
const ENGINE = (process.argv[2] || process.env.BROWSER || 'chromium').toLowerCase();
let launcher;
try {
  const pw = await import(pathToFileURL(require.resolve('playwright')).href);
  launcher = (pw.default ?? pw)[ENGINE];
  if (!launcher) throw new Error(`unknown browser ${ENGINE}`);
} catch (err) {
  console.error(`Playwright is needed for the smoke test (${err.message}):\n`
    + `  npm i -D playwright && npx playwright install ${ENGINE}`);
  process.exit(1);
}

const PORT = Number(process.env.PORT || 5199);
const BASE = `http://localhost:${PORT}/`;
let failures = 0;
const ok = (name, pass, detail = '') => {
  console.log(`${pass ? ' PASS' : ' FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
  if (!pass) failures++;
};

build();
const server = spawn(process.execPath, ['server.js'], {
  cwd: new URL('..', import.meta.url).pathname,
  env: { ...process.env, PORT: String(PORT) },
  stdio: 'ignore',
});
const stop = () => server.kill();
process.on('exit', stop);
await new Promise((r) => setTimeout(r, 600));

console.log(`\nvidedit smoke test — ${ENGINE}`);
const browser = await launcher.launch(
  ENGINE === 'chromium' ? { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] } : {},
);
const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
const errors = [];
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
page.on('console', (m) => m.type() === 'error' && errors.push('console: ' + m.text()));

await page.goto(BASE, { waitUntil: 'networkidle' });
await page.setInputFiles('#filePicker', [join(DIR, 'shot.png'), join(DIR, 'tone.wav')]);
await page.waitForFunction(() => window.videdit.media.list().length === 2, null, { timeout: 20000 });
await page.waitForFunction(() => window.videdit.media.list().some((a) => a.peaks), null, { timeout: 20000 });

const assets = await page.evaluate(() =>
  window.videdit.media.list().map((a) => ({ name: a.name, kind: a.kind, w: a.width, h: a.height, peaks: !!a.peaks })));
const shot = assets.find((a) => a.name === 'shot.png');
ok('image probed at native size', shot.w === 1733 && shot.h === 2011, `${shot.w}x${shot.h}`);
ok('audio waveform peaks built', assets.find((a) => a.kind === 'audio').peaks);

const built = await page.evaluate(() => {
  const { store, media, timeline } = window.videdit;
  store.project.tracks.forEach((t) => (t.clips.length = 0));
  timeline.appendAsset(media.list().find((a) => a.kind === 'image').id, 0);
  timeline.appendAsset(media.list().find((a) => a.kind === 'audio').id, 0);
  const img = store.allClips().find((c) => c.type === 'image');
  img.duration = 6;
  img.fade.in = 1; img.fade.out = 1; img.fade.mode = 'black';
  const aud = store.allClips().find((c) => c.type === 'audio');
  aud.fade.in = 1; aud.fade.out = 1.5;
  store.changed();
  const { renderer } = window.videdit;
  renderer.render(3);
  const g = renderer.canvas.getContext('2d');
  return {
    box: renderer.boxFor(img, 3),
    px: [0, 1, 2].map((i) => [...g.getImageData(i, 0, 1, 1).data.slice(0, 3)]),
    fades: [0.01, 0.5, 3, 5.5, 5.99].map((t) => { renderer.render(t); return [...g.getImageData(2, 2, 1, 1).data.slice(0, 3)]; }),
  };
});

// a 1733x2011 image on a 1024x1024 canvas: centred, uncropped, unscaled
ok('image drawn at 1:1, never fitted', built.box.w === 1733 && built.box.h === 2011,
  `box ${built.box.w}x${built.box.h} at ${built.box.left},${built.box.top}`);
const srcX = -built.box.left;
const srcY = -built.box.top;
const want = [0, 1, 2].map((i) => shotPixel(srcX + i, srcY));
ok('every source pixel maps to one canvas pixel',
  JSON.stringify(want) === JSON.stringify(built.px), `want ${JSON.stringify(want)} got ${JSON.stringify(built.px)}`);

const [f0, fHalf, fMid, fOutHalf, fEnd] = built.fades;
ok('fade in starts from black', f0[0] < 12);
ok('fade in is half way at half the fade', Math.abs(fHalf[0] - fMid[0] / 2) < 12, `${fHalf[0]} vs ${fMid[0] / 2}`);
ok('fully opaque between the fades', fMid[0] > 200);
ok('fade out returns to black', fOutHalf[0] < fMid[0] && fEnd[0] < 12);

const feats = await page.evaluate(async () => {
  const { store, timeline, renderer, audio } = window.videdit;
  const out = {};
  const img = store.allClips().find((c) => c.type === 'image');
  out.split = store.splitAt(3, [img.id]);
  out.pieces = store.allClips().filter((c) => c.type === 'image').map((c) => [c.start, c.duration]);
  store.undo();
  out.afterUndo = store.allClips().filter((c) => c.type === 'image').length;

  const clip = store.allClips().find((c) => c.type === 'image');
  Object.assign(clip.motion, { enabled: true, easing: 'linear', from: { x: -300, y: -400, scale: 1 }, to: { x: 300, y: 400, scale: 1 } });
  store.changed();
  out.pan = [0, 0.5, 1].map((k) => {
    const b = renderer.boxFor(clip, clip.start + clip.duration * k - (k === 1 ? 0.001 : 0));
    return [Math.round(b.left), Math.round(b.top)];
  });

  const { makeClip } = await import('/src/js/store.js');
  const txt = makeClip('text', { name: 'Title', duration: 3 });
  txt.text.content = 'PIXEL\nPERFECT';
  txt.text.size = 120;
  txt.y = 300;
  timeline.insert(txt, 'video', 1);
  const viz = makeClip('visualizer', { name: 'Viz', duration: 4 });
  timeline.insert(viz, 'video', 1);
  out.textTrack = store.project.tracks.findIndex((t) => t.clips.some((c) => c.type === 'text'));
  out.imageTrack = store.project.tracks.findIndex((t) => t.clips.some((c) => c.type === 'image'));

  const g = renderer.canvas.getContext('2d');
  const b = renderer.boxFor(txt, 2);
  const countIn = (box) => {
    const d = g.getImageData(Math.round(box.left), Math.round(box.top),
      Math.round(box.w), Math.round(box.h)).data;
    let white = 0, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) white++;
      if (d[i] < 12 && d[i + 1] < 12 && d[i + 2] < 12) dark++;
    }
    return { white, dark };
  };
  // Sixty pixels of background well above the title — clear of the glyphs and
  // of the shadow's blur radius, so this reads the image and nothing else.
  const spread = () => {
    const d = g.getImageData(Math.round(b.left), Math.round(b.top) - 200, 60, 1).data;
    let lo = 255, hi = 0;
    for (let i = 0; i < d.length; i += 4) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); }
    return hi - lo;
  };

  // The image clip carries a pan now, and a moving clip is drawn subpixel and
  // resampled — which averages this fixture's 1-pixel checker into flat grey.
  // Measure the shadow over a still background, and pin the trade separately.
  clip.motion.enabled = false;
  renderer.render(2);
  const still = countIn(b);
  out.textPixels = still.white;
  out.shadowPixels = still.dark;
  out.stillSpread = spread();

  clip.motion.enabled = true;
  renderer.render(2);
  out.movingShadowPixels = countIn(b).dark;
  out.movingSpread = spread();
  clip.motion.enabled = false;
  const bands = audio.spectrumAt(2.5, viz);
  out.bands = { n: bands.length, peak: Math.max(...bands) };
  return out;
});

ok('split cuts a clip in two', feats.split === 1 && feats.pieces.length === 2
  && Math.abs(feats.pieces[0][1] - 3) < 1e-6, JSON.stringify(feats.pieces));
ok('undo restores the clip', feats.afterUndo === 1);
ok('pan interpolates A -> B', feats.pan[0][0] === -654 && feats.pan[1][0] === -354 && feats.pan[2][0] > -60,
  JSON.stringify(feats.pan));
ok('new overlays stack above existing clips', feats.textTrack < feats.imageTrack,
  `text on ${feats.textTrack}, image on ${feats.imageTrack}`);
ok('text renders', feats.textPixels > 1000, `${feats.textPixels} px`);
ok('text drop shadow renders', feats.shadowPixels > 50, `${feats.shadowPixels} px`);
// The cost of a smooth pan, stated out loud: a clip in motion is resampled, so
// the checker under it flattens. A still clip keeps its hard 1-pixel edges.
// Stated as a ratio, not an absolute: how much contrast a resample keeps is the
// browser's filter choice, but it is always well below an untouched 1:1 copy.
ok('motion resamples, stillness stays crisp',
  feats.stillSpread > 150 && feats.movingSpread < feats.stillSpread * 0.6,
  `still spread ${feats.stillSpread}, moving ${feats.movingSpread}, ` +
  `shadow ${feats.shadowPixels} -> ${feats.movingShadowPixels}`);
ok('visualiser reads the audio spectrum', feats.bands.n === 64 && feats.bands.peak > 0.2, JSON.stringify(feats.bands));

const mix = await page.evaluate(async () => {
  const buf = await window.videdit.audio.mixdown(0, 6);
  const d = buf.getChannelData(0);
  let peak = 0;
  for (let i = 0; i < d.length; i++) peak = Math.max(peak, Math.abs(d[i]));
  let early = 0;
  for (let i = 0; i < 480; i++) early = Math.max(early, Math.abs(d[i]));
  return { dur: buf.duration, ch: buf.numberOfChannels, peak, early };
});
ok('offline audio mixdown', Math.abs(mix.dur - 6) < 0.01 && mix.ch === 2 && mix.peak > 0.3, JSON.stringify(mix));
ok('audio fade in ramps from silence', mix.early < 0.02, `${mix.early.toFixed(4)}`);

const dl = page.waitForEvent('download', { timeout: 30000 });
await page.evaluate(() => { window.videdit.store.playhead = 2.5; return window.videdit.exporter.exportStill(() => {}); });
ok('still frame exports', /\.png$/.test((await dl).suggestedFilename()));

// Scrubbing: drag anywhere in empty lane space, and land exactly on clip edges.
const lane = await page.evaluate(() => {
  const { store, media, timeline, playback } = window.videdit;
  store.project.tracks.forEach((t) => (t.clips.length = 0));
  const img = media.list().find((a) => a.kind === 'image').id;
  timeline.appendAsset(img, 0);
  timeline.appendAsset(img, 8); // keeps the project longer than the edge under test
  store.allClips().find((c) => c.start === 0).duration = 6;
  store.changed();
  timeline.setZoom(90);
  timeline.scroll.scrollLeft = 0;
  playback.seek(0);
  // an audio lane has no clips on it, so every x in it is empty space
  const empty = store.project.tracks.find((t) => t.kind === 'audio');
  const r = timeline.laneEls.get(empty.id).getBoundingClientRect();
  return { x: r.left, y: r.top + r.height / 2, zoom: store.zoom, fps: store.project.fps };
});
const at = () => page.evaluate(() => window.videdit.store.playhead);

await page.mouse.move(lane.x + 90, lane.y);
await page.mouse.down();
const s0 = await at();
await page.mouse.move(lane.x + 200, lane.y, { steps: 4 });
const s1 = await at();
await page.mouse.move(lane.x + 315, lane.y, { steps: 4 });
const s2 = await at();
await page.mouse.up();
ok('dragging empty lane space scrubs the playhead', s0 < s1 && s1 < s2 && Math.abs(s2 - 315 / lane.zoom) < 0.02,
  `${s0.toFixed(3)} -> ${s1.toFixed(3)} -> ${s2.toFixed(3)}`);
ok('scrubbing lands on whole frames', Math.abs(s1 * lane.fps - Math.round(s1 * lane.fps)) < 1e-6, `${s1}`);

// 6.06s is inside the snap tolerance of the clip's end at 6s
await page.mouse.move(lane.x + 545, lane.y);
await page.mouse.down();
const snapped = await at();
await page.mouse.up();
ok('the playhead snaps to a clip edge', Math.abs(snapped - 6) < 1e-6, `${snapped}`);

await page.evaluate(() => { window.videdit.store.snapping = false; });
await page.mouse.move(lane.x + 445, lane.y);
await page.mouse.down();
const free = await at();
await page.mouse.up();
await page.evaluate(() => { window.videdit.store.snapping = true; });
ok('snapping off leaves the playhead free', Math.abs(free - 445 / lane.zoom) < 1e-6, `${free}`);

// The wheel runs along the timeline; only Alt and the track heads scroll down it.
const wheeled = await page.evaluate(() => {
  const { store, timeline } = window.videdit;
  // long enough that the timeline actually has somewhere to scroll to
  store.allClips()[0].duration = 120;
  store.changed();
  timeline.setZoom(90);
  timeline.scroll.scrollLeft = 0;
  const laneEl = timeline.laneEls.get(store.project.tracks[0].id);
  const r = laneEl.getBoundingClientRect();
  const fire = (opts) => {
    const target = opts.target || laneEl;
    const ev = new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 8, ...opts });
    target.dispatchEvent(ev);
    return ev.defaultPrevented;
  };
  const out = {};
  out.tookIt = fire({ deltaY: 240 });
  out.forward = timeline.scroll.scrollLeft;
  fire({ deltaY: -90 });
  out.back = timeline.scroll.scrollLeft;
  const held = timeline.scroll.scrollLeft;
  out.alt = fire({ deltaY: 240, altKey: true }) || timeline.scroll.scrollLeft !== held;
  out.head = fire({ deltaY: 240, target: document.querySelector('.tl-heads .thead') })
    || timeline.scroll.scrollLeft !== held;
  const z = store.zoom;
  fire({ deltaY: -100, ctrlKey: true });
  out.zoomed = store.zoom > z;
  return out;
});
ok('the wheel runs the timeline forward and back', wheeled.tookIt && wheeled.forward === 240 && wheeled.back === 150,
  JSON.stringify(wheeled));
ok('alt and the track heads keep the vertical scroll', !wheeled.alt && !wheeled.head);
ok('ctrl+wheel still zooms', wheeled.zoomed);

// A dropped asset must start exactly under the pointer — the drag image is
// pinned by its left edge, so anywhere else reads as the drop being ignored.
const dropped = await page.evaluate(() => {
  const { store, media, timeline } = window.videdit;
  store.project.tracks.forEach((t) => (t.clips.length = 0));
  store.changed();
  timeline.setZoom(90);
  timeline.scroll.scrollLeft = 0;
  const asset = media.list().find((a) => a.kind === 'image');
  const track = store.project.tracks.find((t) => t.kind === 'video');
  const laneEl = timeline.laneEls.get(track.id);
  const y = laneEl.getBoundingClientRect().top + 8;
  const x = timeline.lanes.getBoundingClientRect().left + 437;
  const dt = new DataTransfer();
  dt.setData('text/videdit-asset', asset.id);
  const send = (type) => laneEl.dispatchEvent(
    new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: x, clientY: y }));
  store.snapping = false; // measure the raw landing spot, without the tolerance
  timeline.beginAssetDrag(asset);
  send('dragover');
  const ghost = document.querySelector('.drop-ghost');
  const preview = { left: parseFloat(ghost.style.left), width: parseFloat(ghost.style.width), shown: ghost.style.display };
  send('drop');
  store.snapping = true;
  const clip = store.allClips()[0];
  return { x: timeline.timeToX(clip.start), width: timeline.timeToX(clip.duration), preview,
    cleared: document.querySelector('.drop-ghost').style.display };
});
ok('a dropped asset lands under the pointer', Math.abs(dropped.x - 437) < 0.01, JSON.stringify(dropped));
ok('the ghost previews that same span', dropped.preview.shown !== 'none' && Math.abs(dropped.preview.left - 437) < 0.01
  && Math.abs(dropped.preview.width - dropped.width) < 0.01, JSON.stringify(dropped.preview));
ok('the ghost clears on drop', dropped.cleared === 'none');

// The waveform buffer has to match its box in device pixels, or it is resampled.
const wave = await page.evaluate(() => {
  const { store, media, timeline } = window.videdit;
  store.project.tracks.forEach((t) => (t.clips.length = 0));
  timeline.appendAsset(media.list().find((a) => a.kind === 'audio').id, 0);
  store.changed();
  const cv = document.querySelector('.clip[data-type="audio"] canvas.wave');
  const box = cv.getBoundingClientRect();
  const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
  let ink = 0;
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
  const dpr = Math.min(3, window.devicePixelRatio || 1);
  return { w: cv.width, h: cv.height, wantW: Math.round(Math.round(box.width) * dpr),
    wantH: Math.round(Math.round(box.height) * dpr), ink };
});
ok('the waveform is drawn at device resolution', wave.w === wave.wantW && wave.h === wave.wantH, JSON.stringify(wave));
ok('the waveform draws its peaks', wave.ink > 500, `${wave.ink} px`);

// Pause/resume: the transport must pick up where it stopped, never behind it.
const resume = await page.evaluate(async () => {
  const { store, playback } = window.videdit;
  const frame = () => new Promise((r) => requestAnimationFrame(r));
  playback.seek(2);
  playback.play();
  for (let i = 0; i < 20; i++) await frame();
  playback.pause();
  const paused = store.playhead;
  playback.play();
  let min = Infinity;
  for (let i = 0; i < 12; i++) {
    await frame();
    min = Math.min(min, store.playhead);
  }
  playback.pause();
  return { paused, min };
});
ok('resuming does not rewind the playhead', resume.min >= resume.paused - 1e-3,
  `paused ${resume.paused.toFixed(4)} -> min ${resume.min.toFixed(4)}`);

// Dropping on the import zone must not import through both handlers.
const copies = await page.evaluate(async () => {
  const { media } = window.videdit;
  const cv = document.createElement('canvas');
  cv.width = cv.height = 8;
  const c2d = cv.getContext('2d');
  c2d.fillStyle = '#f0f';
  c2d.fillRect(0, 0, 8, 8);
  const blob = await new Promise((r) => cv.toBlob(r, 'image/png'));
  const dt = new DataTransfer();
  dt.items.add(new File([blob], 'dropped.png', { type: 'image/png' }));
  const zone = document.querySelector('.dropzone');
  zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
  const named = () => media.list().filter((a) => a.name === 'dropped.png').length;
  for (let i = 0; i < 60 && !named(); i++) await new Promise((r) => setTimeout(r, 50));
  await new Promise((r) => setTimeout(r, 500)); // let a second import land if one is coming
  return named();
});
ok('dropping a file imports it once', copies === 1, `${copies} copies`);

// Relinking: a project whose media sits in two different folders. One picker
// can only ever reach one of them, so the session has to survive round after
// round — and it must never bind a file that merely happens to be the right
// kind.
let chooserFiles = [];
page.on('filechooser', async (fc) => {
  try {
    await fc.setFiles(chooserFiles);
  } catch { /* the test moved on */ }
});

const opened = await page.evaluate(async () => {
  const { store, media, timeline, relinker } = window.videdit;
  store.project.tracks.forEach((t) => (t.clips.length = 0));
  const img = media.list().find((a) => a.kind === 'image' && a.name === 'shot.png');
  const aud = media.list().find((a) => a.kind === 'audio');
  timeline.appendAsset(img.id, 0);
  timeline.appendAsset(aud.id, 0);
  const wanted = [img, aud].map((a) => ({ id: a.id, name: a.name, kind: a.kind, size: a.size, path: `old/${a.name}` }));
  // Reopening the project on another machine: the clips stay, the media does not.
  for (const a of media.list()) media.remove(a.id);
  await relinker.begin(wanted);
  return {
    missing: relinker.missing().length,
    dialog: !!document.querySelector('.modal.relink'),
    rows: document.querySelectorAll('.relink-row.missing').length,
    offlineClips: document.querySelectorAll('.clip.offline').length,
    banner: !!document.querySelector('.offline-banner'),
  };
});
ok('reopening without media opens the relink dialog', opened.missing === 2 && opened.dialog && opened.rows === 2,
  JSON.stringify(opened));
ok('offline clips are marked on the timeline', opened.offlineClips === 2 && opened.banner,
  `${opened.offlineClips} clips, banner ${opened.banner}`);

// A file of the right kind but the wrong name must not be guessed at.
chooserFiles = [join(DIR, 'small.png')];
const wrong = await page.evaluate(async () => {
  await window.videdit.relinker.addFiles();
  return window.videdit.relinker.missing().length;
});
ok('an unrelated file of the same kind is not linked', wrong === 2, `${wrong} still missing`);

chooserFiles = [join(DIR, 'folderA', 'Shot.png')];
const first = await page.evaluate(async () => {
  const n = await window.videdit.relinker.addFiles();
  return { n, missing: window.videdit.relinker.missing().length };
});
ok('the first folder relinks its file', first.n === 1 && first.missing === 1, JSON.stringify(first));

chooserFiles = [join(DIR, 'folderB', 'tone.wav')];
const second = await page.evaluate(async () => {
  const n = await window.videdit.relinker.addFiles();
  const { store, media } = window.videdit;
  const clips = store.allClips();
  return {
    n,
    missing: window.videdit.relinker.missing().length,
    resolved: clips.filter((c) => c.assetId && media.get(c.assetId)).length,
    assets: media.list().length,
  };
});
ok('a second folder relinks the rest in the same session', second.n === 1 && second.missing === 0,
  JSON.stringify(second));
ok('every clip points at real media again', second.resolved === 2, `${second.resolved} of 2`);
// Two relinked files and nothing else: the unmatched small.png offered earlier
// was never read, and neither file was imported twice.
ok('only matched files are imported', second.assets === 2, `${second.assets} assets`);

const cleared = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 900));
  return { dialog: !!document.querySelector('.modal.relink'), offline: document.querySelectorAll('.clip.offline').length };
});
ok('the dialog closes once nothing is missing', !cleared.dialog && cleared.offline === 0, JSON.stringify(cleared));

// The folder machinery itself: a picked directory handle and a dropped folder
// both reach the matcher as flat, path-carrying entries. Neither can be driven
// through a native dialog in a headless run, so both walkers get fed mocks.
const walkers = await page.evaluate(async () => {
  const f = await import('/src/js/folders.js');
  const fileHandle = (name) => ({ kind: 'file', name, getFile: async () => new File([name], name) });
  const dir = (name, kids) => ({ kind: 'directory', name, async *entries() { for (const k of kids) yield [k.name, k]; } });
  const tree = dir('media', [
    fileHandle('a.png'),
    fileHandle('notes.txt'),          // not media
    fileHandle('.hidden.png'),        // dotfile
    dir('music', [fileHandle('b.wav')]),
    dir('node_modules', [fileHandle('junk.png')]),
  ]);
  const scanned = await f.scanFolder(tree);

  // Dropped folders come through the older entry API, whose reader pages.
  const fileEntry = (name) => ({ isFile: true, name, file: (cb) => cb(new File([name], name)) });
  const dirEntry = (name, kids) => ({
    isDirectory: true,
    name,
    createReader() {
      let sent = false;
      return { readEntries: (cb) => { cb(sent ? [] : kids); sent = true; } };
    },
  });
  const root = dirEntry('shots', [fileEntry('c.png'), dirEntry('sub', [fileEntry('d.mp4')])]);
  const dropped = await f.scanDataTransfer({ items: [{ kind: 'file', webkitGetAsEntry: () => root }], files: [] });
  return { scanned: scanned.map((e) => e.path).sort(), dropped: dropped.map((e) => e.path).sort() };
});
ok('a picked folder is walked into media entries, junk skipped',
  JSON.stringify(walkers.scanned) === JSON.stringify(['media/a.png', 'media/music/b.wav']),
  JSON.stringify(walkers.scanned));
ok('a dropped folder is walked recursively',
  JSON.stringify(walkers.dropped) === JSON.stringify(['shots/c.png', 'shots/sub/d.mp4']),
  JSON.stringify(walkers.dropped));

const remembered = await page.evaluate(async () => {
  const f = await import('/src/js/folders.js');
  if (!window.showDirectoryPicker) window.showDirectoryPicker = () => {}; // only gates canRemember()
  // A stand-in handle has to be structured-cloneable, just like the real one;
  // with no isSameEntry the store falls back to comparing folder names.
  const handle = { name: 'Footage' };
  const row = await f.rememberFolder(handle);
  const once = (await f.rememberedFolders()).filter((r) => r.name === 'Footage').length;
  await f.rememberFolder(handle); // the same folder again must not store a twin
  const twice = (await f.rememberedFolders()).filter((r) => r.name === 'Footage').length;
  await f.forgetFolder(row.key);
  const after = (await f.rememberedFolders()).filter((r) => r.name === 'Footage').length;
  return { once, twice, after };
});
ok('folders are remembered once and can be forgotten',
  remembered.once === 1 && remembered.twice === 1 && remembered.after === 0, JSON.stringify(remembered));

// Judder guards. Three separate things have to hold for a pan to come out
// smooth, and each one used to fail on its own.
const sampling = await page.evaluate(() => {
  const { playback, store } = window.videdit;
  const fps = store.project.fps;
  const clip = { start: 0, inPoint: 0, speed: 1 };
  // 1. A frame is sampled at its centre, so a seek never lands on a source
  //    frame boundary where float rounding picks the side for you.
  let nearestEdge = 1;
  const frames = [];
  for (let f = 0; f < 240; f++) {
    const src = playback.sourceTimeOf(clip, playback.frameCentre(f / fps)) * fps;
    frames.push(Math.floor(src));
    nearestEdge = Math.min(nearestEdge, Math.abs(src - Math.round(src)));
  }
  const stepsByOne = frames.every((n, i) => i === 0 || n === frames[i - 1] + 1);
  return { stepsByOne, first: frames[0], nearestEdge };
});
ok('each output frame samples its own source frame',
  sampling.stepsByOne && sampling.first === 0 && sampling.nearestEdge > 0.25,
  JSON.stringify(sampling));

const motion = await page.evaluate(() => {
  const { renderer, media, store } = window.videdit;
  const asset = media.list().find((a) => a.kind === 'image');
  const mk = (enabled, toX) => ({
    assetId: asset.id, type: 'image', start: 0, duration: 4, enabled: true,
    x: 0, y: 0, scale: 1, rotation: 0, opacity: 1, pixelSnap: true,
    crop: { top: 0, right: 0, bottom: 0, left: 0 },
    motion: { enabled, from: { x: 0, y: 0, scale: 1 }, to: { x: toX, y: 0, scale: 1 },
              start: 0, end: 0, easing: 'linear' },
  });
  // A pan of 97 px over 4 s: deliberately not a whole number of pixels per
  // frame, which is the case whole-pixel snapping turns into a stepped crawl.
  const at = (clip, f) => renderer.boxFor(clip, f / store.project.fps).left;
  const pan = mk(true, -97);
  const still = mk(false, 0);
  const xs = [];
  for (let f = 0; f < 60; f++) xs.push(at(pan, f));
  return {
    // 2. A moving clip travels at subpixel precision and never stalls.
    stalls: xs.filter((v, i) => i > 0 && v === xs[i - 1]).length,
    fractional: xs.filter((v) => !Number.isInteger(v)).length,
    // 3. A still clip is still snapped — screenshots stay bit-exact.
    stillSnapped: [0, 1, 2, 3, 4].every((f) => Number.isInteger(at(still, f))),
  };
});
ok('a pan travels subpixel and never stalls, stills stay snapped',
  motion.stalls === 0 && motion.fractional > 50 && motion.stillSnapped,
  JSON.stringify(motion));

const shutter = await page.evaluate(() => {
  const { exporter } = window.videdit;
  const fps = 30;
  const open = exporter.shutterSamples(10, fps, 8, 0.5);
  const off = exporter.shutterSamples(10, fps, 1, 0);
  const centre = (10 + 0.5) / fps;
  return {
    n: open.length,
    // The exposure straddles the frame centre and stays inside the frame.
    centred: Math.abs((open[0] + open[open.length - 1]) / 2 - centre) < 1e-9,
    span: (open[open.length - 1] - open[0]) * fps,
    inside: open[0] > 10 / fps && open[open.length - 1] < 11 / fps,
    offIsOneInstant: off.length === 1 && Math.abs(off[0] - centre) < 1e-9,
  };
});
const adaptive = await page.evaluate(() => {
  const { exporter } = window.videdit;
  const fps = 30;
  // Across speeds from a crawl to a whip pan, consecutive samples must stay
  // under a pixel apart — that gap is what separates a smear from a row of
  // ghosts, and it is the thing a fixed sample count gets wrong.
  const gaps = [0.5, 3, 12, 40, 150, 500].map((px) => {
    const n = exporter.samplesFor(px, 0.5);
    const ts = exporter.shutterSamples(10, fps, n, 0.5);
    const spanPx = (ts[ts.length - 1] - ts[0]) * fps * px;
    return +(spanPx / (ts.length - 1)).toFixed(4);
  });
  return {
    gaps,
    worst: Math.max(...gaps),
    // The cap is a cost bound: past it the gap grows, but it takes a whip pan.
    capped: exporter.samplesFor(1e6, 1),
    whipGap: +(1e6 * 0.5 / (exporter.samplesFor(1e6, 0.5) - 1)).toFixed(1),
    offIsOne: exporter.samplesFor(500, 0),
  };
});
ok('blur samples stay under a pixel apart across real pan speeds',
  adaptive.worst <= 1 && adaptive.capped === 256 && adaptive.offIsOne === 1,
  JSON.stringify(adaptive));

ok('the shutter opens across the frame and closes to one instant when off',
  shutter.n === 8 && shutter.centred && shutter.inside && shutter.offIsOneInstant
  && shutter.span > 0.4 && shutter.span < 0.5,
  JSON.stringify(shutter));

ok('no console errors', errors.length === 0, errors.join(' | '));

await browser.close();
stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

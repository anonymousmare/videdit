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
let chromium;
try {
  const pw = await import(pathToFileURL(require.resolve('playwright')).href);
  chromium = pw.chromium ?? pw.default.chromium;
} catch {
  console.error('Playwright is needed for the smoke test:\n  npm i -D playwright && npx playwright install chromium');
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

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] });
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

  renderer.render(2);
  const g = renderer.canvas.getContext('2d');
  const b = renderer.boxFor(txt, 2);
  const d = g.getImageData(Math.round(b.left), Math.round(b.top), Math.round(b.w), Math.round(b.h)).data;
  let white = 0, dark = 0;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i] === 255 && d[i + 1] === 255 && d[i + 2] === 255) white++;
    if (d[i] < 12 && d[i + 1] < 12 && d[i + 2] < 12) dark++;
  }
  out.textPixels = white;
  out.shadowPixels = dark;
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

ok('no console errors', errors.length === 0, errors.join(' | '));

await browser.close();
stop();
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
process.exit(failures ? 1 : 0);

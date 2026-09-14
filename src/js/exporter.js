// Export. Two routes:
//   1. WebM  — realtime capture of the canvas + the live audio mix. Quick.
//   2. PNG frames + WAV — rendered frame by frame, lossless, pixel for pixel
//      identical to the preview. Mux it with ffmpeg for a final master.

import { el, download, fmtTime, clamp } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { encodeWav } from './audio.js';
import { Playback } from './playback.js';
import { clipEnd } from './store.js';
import { ZipWriter } from './zip.js';
import { getCtx } from './media.js';

const CODECS = [
  ['video/webm;codecs=vp9,opus', 'WebM · VP9'],
  ['video/webm;codecs=vp8,opus', 'WebM · VP8'],
  ['video/webm', 'WebM · default'],
  ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'MP4 · H.264'],
];

export class Exporter {
  constructor({ store, media, renderer, playback, audio }) {
    this.store = store;
    this.media = media;
    this.renderer = renderer;
    this.playback = playback;
    this.audio = audio;
    this.cancelled = false;
  }

  supportedCodecs() {
    if (typeof MediaRecorder === 'undefined') return [];
    return CODECS.filter(([m]) => {
      try {
        return MediaRecorder.isTypeSupported(m);
      } catch {
        return false;
      }
    });
  }

  open() {
    this.playback.pause();
    const dur = this.store.duration();
    const p = this.store.project;
    const codecs = this.supportedCodecs();
    const scrim = el('div', { class: 'scrim' });
    const modal = el('div', { class: 'modal' });

    const head = el('header', {});
    head.append(icon('download', 16), el('span', {}, 'Export'), el('div', { class: 'spacer' }));
    const closeBtn = el('button', { class: 'btn icon ghost', type: 'button' });
    closeBtn.append(icon('x', 14));
    head.append(closeBtn);

    const modeSel = el('select', { class: 'inp' },
      el('option', { value: 'frames' }, 'PNG frame sequence + WAV (lossless, pixel perfect)'),
      codecs.length ? el('option', { value: 'video' }, 'Video file (quick, one file)') : null,
      el('option', { value: 'still' }, 'Current frame only (PNG)'),
    );
    const codecSel = el('select', { class: 'inp' }, ...codecs.map(([m, t]) => el('option', { value: m }, t)));
    const qualSel = el('select', { class: 'inp' },
      el('option', { value: '40' }, 'Very high · 40 Mbps'),
      el('option', { value: '24', selected: true }, 'High · 24 Mbps'),
      el('option', { value: '12' }, 'Medium · 12 Mbps'),
      el('option', { value: '6' }, 'Small · 6 Mbps'),
    );
    const destSel = el('select', { class: 'inp' },
      window.showDirectoryPicker ? el('option', { value: 'folder' }, 'Write into a folder I choose') : null,
      el('option', { value: 'zip' }, 'Download one .zip'),
    );

    const rowVideo = row('Codec', codecSel);
    const rowQual = row('Quality', qualSel);
    const rowDest = row('Write to', destSel);
    const info = el('div', { class: 'hint' });
    const bar = el('div', { class: 'progress' }, el('i', {}));
    const log = el('div', { class: 'log' }, 'Ready.');
    const body = el('div', { class: 'body' },
      row('Format', modeSel),
      rowVideo,
      rowQual,
      rowDest,
      el('div', { class: 'native-note' }, icon('info', 13), info),
      bar,
      log,
    );

    const cancel = el('button', { class: 'btn', type: 'button' }, 'Close');
    const go = el('button', { class: 'btn primary', type: 'button' });
    go.append(icon('download', 14), el('span', {}, 'Export'));
    const foot = el('footer', {}, cancel, go);
    modal.append(head, body, foot);
    scrim.append(modal);
    document.body.append(scrim);
    hydrateIcons(modal);

    const frames = Math.max(1, Math.round(dur * p.fps));
    const sync = () => {
      const m = modeSel.value;
      rowVideo.style.display = m === 'video' ? '' : 'none';
      rowQual.style.display = m === 'video' ? '' : 'none';
      rowDest.style.display = m === 'frames' ? '' : 'none';
      if (m === 'still') {
        info.innerHTML = `One PNG at <code>${fmtTime(this.store.playhead, p.fps)}</code>, ${p.width} x ${p.height}.`;
      } else if (m === 'video') {
        info.innerHTML =
          `Captured in real time, so it takes about ${fmtTime(dur, p.fps, false)}. Leave the tab in the foreground. ` +
          `Video codecs are lossy — for a pixel-exact master use the PNG sequence.`;
      } else {
        info.innerHTML =
          `${frames} PNG frames at ${p.width} x ${p.height} (${p.fps} fps) plus <code>audio.wav</code>. ` +
          `Mux them losslessly with:<br><code>ffmpeg -framerate ${p.fps} -i frame_%05d.png -i audio.wav ` +
          `-c:v libx264 -crf 12 -preset slow -pix_fmt yuv420p -c:a aac -b:a 320k out.mp4</code>`;
      }
    };
    modeSel.addEventListener('change', sync);
    sync();

    const close = () => {
      this.cancelled = true;
      scrim.remove();
    };
    closeBtn.addEventListener('click', close);
    cancel.addEventListener('click', close);
    scrim.addEventListener('pointerdown', (e) => e.target === scrim && close());

    const setProgress = (v, msg) => {
      bar.firstChild.style.width = `${clamp(v, 0, 1) * 100}%`;
      if (msg) log.textContent = msg;
    };

    go.addEventListener('click', async () => {
      if (dur <= 0 && modeSel.value !== 'still') {
        setProgress(0, 'Nothing on the timeline yet.');
        return;
      }
      this.cancelled = false;
      go.disabled = true;
      modeSel.disabled = true;
      cancel.textContent = 'Cancel';
      cancel.onclick = () => {
        this.cancelled = true;
        log.textContent = 'Cancelling...';
      };
      try {
        if (modeSel.value === 'still') await this.exportStill(setProgress);
        else if (modeSel.value === 'video') await this.exportVideo({ mime: codecSel.value, mbps: Number(qualSel.value) }, setProgress);
        else await this.exportFrames({ dest: destSel.value }, setProgress);
      } catch (err) {
        console.error(err);
        setProgress(0, `Export failed: ${err.message || err}`);
      }
      go.disabled = false;
      modeSel.disabled = false;
      cancel.textContent = 'Close';
      cancel.onclick = close;
    });
  }

  fileBase() {
    return (this.store.project.name || 'videdit').replace(/[^\w\-]+/g, '_').slice(0, 60) || 'videdit';
  }

  async exportStill(progress) {
    await this.prepareFrame(this.store.playhead);
    this.renderer.render(this.store.playhead);
    const blob = await new Promise((r) => this.renderer.canvas.toBlob(r, 'image/png'));
    download(blob, `${this.fileBase()}_${Math.round(this.store.playhead * this.store.project.fps)}.png`);
    progress(1, 'Frame saved.');
  }

  /** Seek every video element that is on screen at t and wait for the frame. */
  async prepareFrame(t) {
    const jobs = [];
    for (const track of this.store.project.tracks) {
      if (track.kind !== 'video') continue;
      for (const clip of track.clips) {
        if (clip.type !== 'video' || !clip.enabled) continue;
        if (t < clip.start || t >= clipEnd(clip)) continue;
        const v = this.media.videoFor(clip);
        if (!v) continue;
        if (!v.paused) v.pause();
        const want = clip.inPoint + (t - clip.start) * (clip.speed || 1);
        jobs.push(Playback.seekExact(v, want));
      }
    }
    if (jobs.length) await Promise.all(jobs);
  }

  // ---------------------------------------------------------- PNG sequence
  async exportFrames({ dest }, progress) {
    const p = this.store.project;
    const dur = this.store.duration();
    const total = Math.max(1, Math.round(dur * p.fps));
    const base = this.fileBase();
    this.audio.resetSmoothing();

    let dir = null;
    let zip = null;
    if (dest === 'folder' && window.showDirectoryPicker) {
      progress(0, 'Choose a folder...');
      dir = await window.showDirectoryPicker({ mode: 'readwrite', id: 'videdit-export' });
    } else {
      zip = new ZipWriter();
    }

    const writeFile = async (name, blob) => {
      if (dir) {
        const fh = await dir.getFileHandle(name, { create: true });
        const w = await fh.createWritable();
        await w.write(blob);
        await w.close();
      } else {
        await zip.add(name, blob);
      }
    };

    const t0 = performance.now();
    for (let f = 0; f < total; f++) {
      if (this.cancelled) {
        progress(f / total, `Cancelled at frame ${f}.`);
        return;
      }
      const t = f / p.fps;
      await this.prepareFrame(t);
      this.renderer.render(t);
      const blob = await new Promise((r) => this.renderer.canvas.toBlob(r, 'image/png'));
      await writeFile(`frame_${String(f + 1).padStart(5, '0')}.png`, blob);
      if (f % 2 === 0 || f === total - 1) {
        const per = (performance.now() - t0) / (f + 1);
        const left = ((total - f - 1) * per) / 1000;
        progress((f + 1) / (total + 2), `Frame ${f + 1} / ${total} · about ${fmtTime(left, 30, false)} left`);
        await new Promise((r) => setTimeout(r));
      }
    }

    progress(total / (total + 2), 'Mixing audio...');
    const hasAudio = this.store.project.tracks.some((tr) => tr.clips.some((c) => c.type === 'audio' || c.type === 'video'));
    if (hasAudio) {
      const mix = await this.audio.mixdown(0, dur);
      await writeFile('audio.wav', encodeWav(mix));
    }
    const readme =
      `# ${p.name}\n\n${total} frames, ${p.width}x${p.height}, ${p.fps} fps.\n\n` +
      `Mux to a master file:\n\n` +
      `ffmpeg -framerate ${p.fps} -i frame_%05d.png${hasAudio ? ' -i audio.wav' : ''} ` +
      `-c:v libx264 -crf 12 -preset slow -pix_fmt yuv420p${hasAudio ? ' -c:a aac -b:a 320k' : ''} ${base}.mp4\n\n` +
      `Truly lossless (bigger file):\n\n` +
      `ffmpeg -framerate ${p.fps} -i frame_%05d.png${hasAudio ? ' -i audio.wav' : ''} ` +
      `-c:v libx264 -qp 0 -preset veryslow -pix_fmt yuv444p${hasAudio ? ' -c:a flac' : ''} ${base}_lossless.mkv\n`;
    await writeFile('README.txt', new Blob([readme], { type: 'text/plain' }));

    if (zip) {
      progress(0.99, 'Packing the zip...');
      download(zip.finish(), `${base}_frames.zip`);
    }
    progress(1, dir ? `Done. ${total} frames written to the folder.` : `Done. ${total} frames zipped.`);
    this.playback.invalidate();
  }

  // ---------------------------------------------------------- WebM capture
  async exportVideo({ mime, mbps }, progress) {
    const p = this.store.project;
    const dur = this.store.duration();
    const ctx = getCtx();
    if (ctx.state === 'suspended') await ctx.resume();

    const stream = this.renderer.canvas.captureStream(p.fps);
    const dest = ctx.createMediaStreamDestination();
    for (const tr of dest.stream.getAudioTracks()) stream.addTrack(tr);

    const rec = new MediaRecorder(stream, {
      mimeType: mime,
      videoBitsPerSecond: mbps * 1_000_000,
      audioBitsPerSecond: 256_000,
    });
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const stopped = new Promise((r) => (rec.onstop = r));

    this.audio.resetSmoothing();
    this.store.seek(0);
    await this.prepareFrame(0);
    rec.start(250);
    const startCtx = this.audio.start(0, dest);

    // Drive playback off the audio clock so picture and sound stay locked.
    for (const track of this.store.project.tracks) {
      for (const clip of track.clips) {
        if (clip.type !== 'video') continue;
        const v = this.media.videoFor(clip);
        if (v) v.playbackRate = clip.speed || 1;
      }
    }

    await new Promise((resolve) => {
      const tick = () => {
        const t = Math.max(0, ctx.currentTime - startCtx);
        if (this.cancelled || t >= dur) return resolve();
        this.store.playhead = t;
        this.playback.syncVideos(t, false);
        for (const track of this.store.project.tracks) {
          for (const clip of track.clips) {
            if (clip.type !== 'video') continue;
            const v = this.media.videoFor(clip);
            if (v && v.paused && t >= clip.start && t < clipEnd(clip)) v.play().catch(() => {});
          }
        }
        this.renderer.render(t);
        progress(t / dur, `Recording ${fmtTime(t, p.fps)} / ${fmtTime(dur, p.fps)}`);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });

    this.audio.stop();
    this.playback.pauseVideos();
    rec.stop();
    await stopped;
    if (this.cancelled) {
      progress(0, 'Cancelled.');
      return;
    }
    const ext = mime.startsWith('video/mp4') ? 'mp4' : 'webm';
    download(new Blob(chunks, { type: mime }), `${this.fileBase()}.${ext}`);
    progress(1, 'Done.');
    this.store.seek(0);
  }
}

function row(label, control) {
  return el('div', { class: 'row' }, el('label', {}, label), control);
}

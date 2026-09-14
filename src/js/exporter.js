// Export. Two routes:
//   1. WebM  — realtime capture of the canvas + the live audio mix. Quick.
//   2. PNG frames + WAV — rendered frame by frame, lossless. Mux it with ffmpeg
//      for a final master.
//
// The frame route can render above the project rate and expose each frame across
// a shutter interval. Both exist for one reason: the preview redraws at the
// display's refresh rate, so it flatters motion in a way a 30 fps file cannot
// match on its own. See shutterSamples().

import { el, download, fmtTime, clamp } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import { encodeWav } from './audio.js';
import { Playback } from './playback.js';
import { clipEnd, hasMotion } from './store.js';
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
    // The preview looks smoother than any export because it redraws at the
    // display's refresh rate. Rendering more frames closes that gap directly.
    // 60 and 120 are deliberate: a rate that does not divide evenly into the
    // display's refresh gets an uneven cadence at playback time — 48 fps on a
    // 60 Hz screen repeats frames 5:4 and judders no matter how clean the file.
    const fpsChoices = [...new Set([p.fps, 60, 120])].filter((n) => n >= p.fps).sort((a, b) => a - b);
    const fpsSel = el('select', { class: 'inp' }, ...fpsChoices.map((n) =>
      el('option', { value: String(n), selected: n === p.fps }, n === p.fps ? `${n} fps · project rate` : `${n} fps`)));
    const blurSel = el('select', { class: 'inp' },
      el('option', { value: '0' }, 'Off — one instant per frame'),
      el('option', { value: '0.25' }, 'Crisp · 90° shutter'),
      el('option', { value: '0.5', selected: true }, 'Natural · 180° shutter'),
      el('option', { value: '1' }, 'Dreamy · 360° shutter'),
    );

    const rowVideo = row('Codec', codecSel);
    const rowQual = row('Quality', qualSel);
    const rowDest = row('Write to', destSel);
    const rowFps = row('Frame rate', fpsSel);
    const rowBlur = row('Motion blur', blurSel);
    const info = el('div', { class: 'hint' });
    const bar = el('div', { class: 'progress' }, el('i', {}));
    const log = el('div', { class: 'log' }, 'Ready.');
    const body = el('div', { class: 'body' },
      row('Format', modeSel),
      rowVideo,
      rowQual,
      rowFps,
      rowBlur,
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

    const sync = () => {
      const m = modeSel.value;
      const fps = Number(fpsSel.value);
      const shutter = Number(blurSel.value);
      const frames = Math.max(1, Math.round(dur * fps));
      rowVideo.style.display = m === 'video' ? '' : 'none';
      rowQual.style.display = m === 'video' ? '' : 'none';
      rowDest.style.display = m === 'frames' ? '' : 'none';
      rowFps.style.display = m === 'frames' ? '' : 'none';
      rowBlur.style.display = m === 'frames' ? '' : 'none';
      if (m === 'still') {
        info.innerHTML = `One PNG at <code>${fmtTime(this.store.playhead, p.fps)}</code>, ${p.width} x ${p.height}.`;
      } else if (m === 'video') {
        info.innerHTML =
          `Captured in real time, so it takes about ${fmtTime(dur, p.fps, false)}. Leave the tab in the foreground. ` +
          `Video codecs are lossy — for a pixel-exact master use the PNG sequence.`;
      } else {
        const blur = shutter > 0
          ? `Moving frames are exposed across a ${Math.round(shutter * 360)}° shutter, sampled once per pixel of ` +
            `travel so the smear stays continuous however fast the move — the slow part of the export, and the ` +
            `part that buys the smoothness.`
          : `Every frame is a single instant — exactly what the preview draws. At ${fps} fps this matches what ` +
            `you see on screen; blur goes past it.`;
        info.innerHTML =
          `${frames} PNG frames at ${p.width} x ${p.height} (${fps} fps) plus <code>audio.wav</code>. ${blur}` +
          `<br>Mux them losslessly with:<br><code>ffmpeg -framerate ${fps} -i frame_%05d.png -i audio.wav ` +
          `-c:v libx264 -crf 12 -preset slow -pix_fmt yuv420p -c:a aac -b:a 320k -movflags +faststart out.mp4</code>`;
      }
    };
    modeSel.addEventListener('change', sync);
    fpsSel.addEventListener('change', sync);
    blurSel.addEventListener('change', sync);
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
        else await this.exportFrames({
          dest: destSel.value,
          fps: Number(fpsSel.value),
          shutter: Number(blurSel.value),
        }, setProgress);
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
    const at = this.playback.frameCentre(this.store.playhead);
    await this.prepareFrame(at);
    this.renderer.render(at);
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
        jobs.push(Playback.seekExact(v, this.playback.sourceTimeOf(clip, t)));
      }
    }
    if (jobs.length) await Promise.all(jobs);
  }

  /**
   * The instants the shutter is open for output frame `f`.
   *
   * A frame is not an instant, it is an interval. A camera integrates light for
   * the fraction of that interval its shutter stays open — 180 degrees is half
   * the frame — which is exactly why filmed motion smears rather than strobes.
   * Rendering one instant per frame is a zero-length shutter: mathematically
   * perfect, and the reason a rendered pan judders where a filmed one glides.
   * The preview hides this by running at the display's refresh rate; the export
   * cannot, so it has to earn the smoothness the way a camera does.
   */
  shutterSamples(f, fps, samples, shutter) {
    const centre = (f + 0.5) / fps;
    if (samples <= 1 || shutter <= 0) return [centre];
    const span = shutter / fps;
    const out = [];
    for (let k = 0; k < samples; k++) out.push(centre + span * ((k + 0.5) / samples - 0.5));
    return out;
  }

  /**
   * How far, in canvas pixels, the fastest moving clip travels in one frame at t.
   * Zero means nothing is going anywhere and the exposure can collapse to an
   * instant — including at the ends of an eased ramp, where a clip is at rest.
   */
  motionPixelsPerFrame(t, fps) {
    let worst = 0;
    for (const { clip } of this.renderer.visibleClips(t)) {
      if (!hasMotion(clip)) continue;
      const a = this.renderer.boxFor(clip, t);
      const b = this.renderer.boxFor(clip, t + 1 / fps);
      if (!a || !b) continue;
      // Travel of the centre, plus whatever a zoom pushes the edges on top.
      const travel = Math.hypot(b.cx - a.cx, b.cy - a.cy);
      const spread = Math.max(Math.abs(b.w - a.w), Math.abs(b.h - a.h)) / 2;
      worst = Math.max(worst, travel + spread);
    }
    return worst;
  }

  /**
   * How many samples one exposure needs.
   *
   * What matters is the gap between consecutive samples, not how many there are:
   * a fixed count smears a slow pan nicely and breaks a fast one into a row of
   * discrete ghosts. Taking a sample per pixel of travel inside the open shutter
   * keeps that gap under a pixel however fast the move.
   *
   * The ceiling is a cost bound, not a quality target. Every sample is a full
   * render plus a full readback, so it only binds past roughly 250 px of travel
   * per frame — a whip, not a pan — and even then the gap stays near a pixel.
   */
  samplesFor(px, shutter) {
    if (shutter <= 0) return 1;
    return clamp(Math.ceil(px * shutter) + 1, 4, 256);
  }

  /**
   * Draw one output frame, averaging its shutter samples onto the canvas.
   *
   * Accumulation is in float on purpose: compositing N samples at alpha 1/N
   * would round each one to 8 bits before adding it, which bands every gradient
   * it touches.
   */
  async composeFrame(times) {
    const { ctx, canvas } = this.renderer;
    // Video is fetched once, at the centre of the exposure: source footage
    // already carries whatever blur its own camera gave it, and re-seeking per
    // sample would buy a decode each for no visible gain.
    const centre = (times[0] + times[times.length - 1]) / 2;
    await this.prepareFrame(centre);
    if (times.length === 1) {
      this.renderer.render(times[0]);
      return;
    }
    const w = canvas.width;
    const h = canvas.height;
    if (!this._acc || this._acc.length !== w * h * 4) this._acc = new Float32Array(w * h * 4);
    const acc = this._acc;
    acc.fill(0);
    for (const t of times) {
      this.renderer.render(t);
      const px = ctx.getImageData(0, 0, w, h).data;
      for (let i = 0; i < acc.length; i++) acc[i] += px[i];
    }
    const out = ctx.createImageData(w, h);
    for (let i = 0; i < acc.length; i++) out.data[i] = acc[i] / times.length;
    ctx.putImageData(out, 0, 0);
  }

  // ---------------------------------------------------------- PNG sequence
  async exportFrames({ dest, fps, shutter }, progress) {
    const p = this.store.project;
    const dur = this.store.duration();
    const total = Math.max(1, Math.round(dur * fps));
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
      const centre = (f + 0.5) / fps;
      const px = this.motionPixelsPerFrame(centre, fps);
      const times = px > 0
        ? this.shutterSamples(f, fps, this.samplesFor(px, shutter), shutter)
        : [centre];
      await this.composeFrame(times);
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
      // Mix exactly as many seconds as there are frames. The timeline duration
      // is rarely a whole number of frames, and handing ffmpeg a WAV that is a
      // little longer or shorter than the picture leaves it to pad or truncate.
      const mix = await this.audio.mixdown(0, total / fps);
      await writeFile('audio.wav', encodeWav(mix));
    }
    const readme =
      `# ${p.name}\n\n${total} frames, ${p.width}x${p.height}, ${fps} fps.\n\n` +
      `Mux to a master file:\n\n` +
      `ffmpeg -framerate ${fps} -i frame_%05d.png${hasAudio ? ' -i audio.wav' : ''} ` +
      `-c:v libx264 -crf 12 -preset slow -pix_fmt yuv420p${hasAudio ? ' -c:a aac -b:a 320k' : ''} ` +
      `-movflags +faststart ${base}.mp4\n\n` +
      `Truly lossless (bigger file):\n\n` +
      `ffmpeg -framerate ${fps} -i frame_%05d.png${hasAudio ? ' -i audio.wav' : ''} ` +
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
    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
      await new Promise((r) => setTimeout(r, 150));
    }
    const silent = ctx.state !== 'running';

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

    if (silent) progress(0, 'No audio output available — recording video only.');
    const wall0 = performance.now();
    await new Promise((resolve) => {
      const tick = () => {
        const elapsed = (performance.now() - wall0) / 1000;
        // Prefer the audio clock while it runs; otherwise the wall clock, and
        // bail out regardless so a stalled clock can never hang the export.
        const t = ctx.state === 'running' ? Math.max(0, ctx.currentTime - startCtx) : elapsed;
        if (this.cancelled || t >= dur || elapsed > dur * 3 + 15) return resolve();
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
    await Promise.race([stopped, new Promise((r) => setTimeout(r, 5000))]);
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

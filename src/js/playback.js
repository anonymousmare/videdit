// Transport: the master clock, video element sync and the render loop.

import { clipEnd } from './store.js';
import { getCtx, resumeCtx } from './media.js';
import { emitter, clamp } from './util.js';

export class Playback {
  constructor(store, media, renderer, audio) {
    this.store = store;
    this.media = media;
    this.renderer = renderer;
    this.audio = audio;
    this.bus = emitter();
    this.playing = false;
    this.loop = false;
    this.needsRender = true;
    this._raf = null;
    this._t0 = 0;
    this._from = 0;
    this.start();
  }

  on(e, f) {
    return this.bus.on(e, f);
  }
  invalidate() {
    this.needsRender = true;
  }

  start() {
    const loop = () => {
      this._raf = requestAnimationFrame(loop);
      if (this.playing) {
        const t = this.clockTime();
        const dur = this.store.duration();
        if (t >= dur - 1e-4) {
          if (this.loop && dur > 0) {
            this.play(0);
            return;
          }
          this.pause();
          this.store.seek(dur);
          this.syncVideos(dur, true);
          this.renderer.render(dur);
          this.bus.emit('tick', dur);
          return;
        }
        this.store.playhead = t;
        this.syncVideos(t, false);
        this.renderer.render(t);
        this.bus.emit('tick', t);
      } else if (this.needsRender) {
        this.needsRender = false;
        this.renderer.render(this.store.playhead);
      }
    };
    this._raf = requestAnimationFrame(loop);
  }

  /**
   * Master clock. The audio context is the reference while it is actually
   * running, because that is what the scheduled audio rides on. If it never
   * starts — no output device, or a browser that keeps it suspended — fall
   * back to the wall clock so the preview still plays instead of freezing.
   */
  clockTime() {
    const ctx = getCtx();
    if (ctx.state === 'running') this._audioOk = true;
    const elapsed = this._audioOk
      ? ctx.currentTime - this._t0
      : (performance.now() - this._wall0) / 1000;
    // Both baselines sit at the end of the engine's lead-in, so `elapsed` is
    // negative until the scheduled audio actually starts. Hold the playhead
    // where the user pressed play instead of letting it run backwards.
    return this._from + Math.max(0, elapsed);
  }

  play(from = null) {
    const dur = this.store.duration();
    let at = from ?? this.store.playhead;
    if (at >= dur - 1e-3) at = 0;
    resumeCtx();
    this.audio.resetSmoothing();
    this._from = at;
    this._audioOk = false;
    const ctx = getCtx();
    // audio.start() schedules the mix a beat ahead of now; timeline position
    // `at` corresponds to that returned context time, not to this instant.
    this._t0 = this.audio.start(at);
    this._wall0 = performance.now() + Math.max(0, this._t0 - ctx.currentTime) * 1000;
    this.store.playhead = at;
    this.playing = true;
    this.primeVideos(at);
    this.bus.emit('state', true);
  }

  pause() {
    if (!this.playing) return;
    // Settle on the clock time now, not on the last frame the loop drew, so
    // resuming carries on from what was actually heard rather than replaying.
    this.store.playhead = clamp(this.clockTime(), 0, Math.max(0, this.store.duration()));
    this.playing = false;
    this.audio.stop();
    this.pauseVideos();
    this.invalidate();
    this.bus.emit('state', false);
    this.store.emit('seek', this.store.playhead);
  }

  toggle() {
    this.playing ? this.pause() : this.play();
  }

  seek(t) {
    const was = this.playing;
    if (was) this.pause();
    this.store.seek(clamp(t, 0, Math.max(0, this.store.duration())));
    this.audio.resetSmoothing();
    this.syncVideos(this.store.playhead, true);
    this.invalidate();
    if (was) this.play(this.store.playhead);
  }

  stepFrame(dir) {
    const f = 1 / (this.store.project.fps || 30);
    this.seek(Math.round((this.store.playhead + dir * f) / f) * f);
  }

  videoClipsAt(t) {
    const out = [];
    for (const track of this.store.project.tracks) {
      if (track.kind !== 'video') continue;
      for (const c of track.clips) {
        if (c.type !== 'video' || !c.enabled) continue;
        if (t >= c.start - 0.35 && t < clipEnd(c)) out.push(c);
      }
    }
    return out;
  }

  /**
   * Where in the source a timeline instant sits — sampled at the CENTRE of the
   * output frame, never on its edge. `t` is always a multiple of 1/fps, so when
   * the source runs at the project frame rate every seek would land exactly on
   * a source frame boundary, and which side of that boundary you get comes down
   * to float rounding. The result is that some source frames get captured twice
   * and others never: invisible on a locked-off shot, obvious judder on a pan.
   * Half a frame in, the frame under the playhead is the only candidate.
   */
  sourceTimeOf(clip, t) {
    const half = 0.5 / (this.store.project.fps || 30);
    return clip.inPoint + (Math.max(0, t - clip.start) + half) * (clip.speed || 1);
  }

  primeVideos(t) {
    for (const clip of this.videoClipsAt(t)) {
      const v = this.media.videoFor(clip);
      if (!v) continue;
      v.muted = true;
      v.playbackRate = clip.speed || 1;
      const want = this.sourceTimeOf(clip, t);
      if (Math.abs(v.currentTime - want) > 0.06) {
        try {
          v.currentTime = want;
        } catch {}
      }
      v.play().catch(() => {});
    }
  }

  pauseVideos() {
    for (const clip of this.videoClipsAt(this.store.playhead)) {
      this.media.videoFor(clip)?.pause();
    }
  }

  /** Keep every on-screen video element locked to the timeline clock. */
  syncVideos(t, hard) {
    for (const track of this.store.project.tracks) {
      if (track.kind !== 'video') continue;
      for (const clip of track.clips) {
        if (clip.type !== 'video') continue;
        const v = this.media.videoFor(clip);
        if (!v) continue;
        const live = t >= clip.start - 0.3 && t < clipEnd(clip);
        if (!live) {
          if (!v.paused) v.pause();
          continue;
        }
        const want = this.sourceTimeOf(clip, t);
        const drift = Math.abs(v.currentTime - want);
        if (hard || drift > 0.18) {
          try {
            v.currentTime = want;
          } catch {}
        }
        if (this.playing && v.paused && t >= clip.start) {
          v.playbackRate = clip.speed || 1;
          v.play().catch(() => {});
        }
        if (!this.playing && !v.paused) v.pause();
      }
    }
  }

  /**
   * Seek one video element and wait for the frame to actually be ready to draw.
   *
   * `seeked` only promises the playback position moved; the decoded frame may
   * not have been handed to the compositor yet, so drawing on that event can
   * still capture the previous one. Where the browser offers it, wait for
   * requestVideoFrameCallback as well, which fires once a frame really has been
   * presented — that is the frame drawImage() will read.
   */
  static seekExact(video, time) {
    return new Promise((res) => {
      if (Math.abs(video.currentTime - time) < 1e-4 && video.readyState >= 2) return res();
      let done = false;
      let timer = null;
      const ok = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        video.removeEventListener('seeked', onSeeked);
        res();
      };
      const onSeeked = () => {
        if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(ok);
        else ok();
      };
      video.addEventListener('seeked', onSeeked, { once: true });
      timer = setTimeout(ok, 2000);
      try {
        video.currentTime = time;
      } catch {
        ok();
      }
    });
  }
}

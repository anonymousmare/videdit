# videdit

A video editor for people cutting trailers out of screenshots.

Every other editor I tried rescales an imported image to fit the canvas. This
one does not, ever. Drop a 1733 × 2011 screenshot on a 1024 × 1024 canvas and it
stays 1733 × 2011 — the frame just crops it. Scale stays at `1.00` until *you*
change it, nearest-neighbour sampling is the default, and positions snap to
whole pixels, so one source pixel lands on exactly one output pixel.

Runs in the browser, no build step, no dependencies.

## Running it

```bash
npm start      # -> http://localhost:5173
```

**Do not double-click `index.html`.** The app is built from JavaScript modules,
and every browser refuses to load those over `file://` — Firefox says
*"Cross-Origin Request Blocked ... CORS request not http"*. You get the dark
window with no icons and nothing clickable. It has to be served over http, which
is all `npm start` does. (If you do open it the wrong way, the page now tells you
so instead of sitting there looking broken.)

Chrome, Edge and Firefox are all supported, and the test suite runs green on
both engines. Two Firefox differences, neither fatal: it offers VP8 rather than
VP9 for the quick video export, and it has no folder picker, so a PNG sequence
downloads as a `.zip` instead of being written into a folder you choose.

## Importing media

Drag image, video or audio files anywhere into the window, click **Import** in
the toolbar, or press `Ctrl I`. Whole folders can be dropped too — they are
walked recursively and every media file inside is imported. Everything appears
in the media pool on the left; drag one onto a track, or double-click it to drop
it at the playhead.

## What it does

**Pixel-perfect placement** — media is placed at native size and never fitted.
The readout above a selected clip turns green when it is exactly 1:1, so you can
see at a glance whether anything is being resampled. Per-clip toggles for pixel
snapping and smooth-vs-nearest scaling.

**Fade in / out from black** — per clip, in seconds, draggable straight from the
white knobs on the clip in the timeline. "From colour" dips the whole frame to
black (a real fade from black, not an opacity fade on one layer); "Opacity"
fades just that clip over the layers under it. The fade colour is yours to pick.

**Audio fades** — the same in/out controls on audio clips, applied as a linear
gain ramp in both the preview and the export.

**Audio visualiser** — drop one on a video track and it draws the spectrum of
your timeline audio: bars, mirrored bars, a line, or a radial burst, with
frequency range, sensitivity, noise floor, smoothing, glow and two-stop
gradients. It is computed from the decoded samples with a real FFT, not from a
live analyser node, so the exported video matches the preview frame for frame.

**Separate video tracks** — as many as you want, stacked like a normal NLE
(higher track draws on top). Per-track hide, mute and lock. New overlays land on
the first free track *above* whatever is already there.

**Cutting** — split at the playhead (`S`), trim either edge, drag clips between
tracks, snapping to clip edges and the playhead, ripple-free by default. Clips
never overlap on one track: an intruder is pushed to a free lane.

**Scrubbing** — drag the playhead from the ruler or from any empty part of a
track, the way CapCut does; hold the pointer past either edge and the timeline
scrolls along with you. While snapping is on the playhead lands on clip edges
when one is near and on whole frames otherwise, so parking it exactly on the end
of a shot is one drag rather than a fight with sub-frame pixels. Turn snapping
off (the magnet) for a free playhead.

**Text with shadows** — font, size, weight, colour, alignment, line height,
letter spacing, wrap width, plus a drop shadow (colour, opacity, blur, offset),
an outline, and a background box. Four presets to start from.

**Pan** — the thing zoom-and-pan tools do badly. Set point **A**, set point
**B**, choose how long the move takes and which easing it uses, and the image
travels between them. Drag the image on the frame with the playhead at either
end to place that point; the path is drawn on the frame with an A and B marker
and a dot showing where you are along it. Scale can ramp too if you want a push
in, but a pure translate is the point. Splitting a clip mid-pan splits the ramp
so the move continues seamlessly across the cut.

Dark theme, CapCut-style layout (library left, preview centre, properties right,
timeline across the bottom), a line-icon set, and no emoji anywhere.

## Exporting

Two routes, in the Export dialog:

**PNG frame sequence + WAV** — renders frame by frame, completely losslessly,
and writes straight into a folder you pick (or a `.zip` if your browser has no
File System Access API). This is the one to use for a trailer. Then:

```bash
ffmpeg -framerate 30 -i frame_%05d.png -i audio.wav \
  -c:v libx264 -crf 12 -preset slow -pix_fmt yuv420p -c:a aac -b:a 320k out.mp4
```

A `README.txt` with the exact command for your project (right frame rate, right
file names) is written next to the frames.

**Video file** — a real-time capture of the canvas plus the live audio mix to
WebM (VP9/VP8). One file, quick, but lossy and it takes as long as the trailer
runs. Fine for previews and sharing.

There is also **Current frame only** for a single PNG.

## Projects

`Save` writes a `.videdit.json` containing the whole edit. Media is referenced
by name, path and size, not embedded, so the file stays small.

### Relinking

Reopening a project has to find those files again. That is one dialog, and it
stays open until every file is accounted for:

- **Add folder…** searches a whole folder tree, subfolders included. Only the
  files that actually match are read, so pointing it at a large media folder is
  cheap.
- **Add files…**, or dropping files and folders straight onto the dialog, does
  the same thing. Media split across several folders just takes several rounds —
  nothing is lost between them, and the list shows what is still outstanding.
- **Locate…** on a single row binds one file by hand, whatever it is called.

On Chrome and Edge the folders you use are remembered between reloads, so the
usual case — the same media folder as last time — relinks with no clicks at all:
they are searched before the dialog is ever shown, and it only appears for
what they could not find. Remembered folders are listed in the dialog and can be
dropped from it at any time. Firefox and Safari have no such API, so there the
folder has to be picked each time.

Matching is on filename first, then relative path and file size — a file that
was renamed but is the right size, or re-exported to another format, is still
found. A file that merely happens to be the right *kind* is never bound
silently; anything the matcher is not confident about waits for **Locate…**.

Clips whose media is missing stay on the timeline, hatched and badged, and the
media panel keeps a count with a way back into the dialog. Saving in that state
keeps the missing files listed, so a half-relinked project does not forget what
it is still looking for.

## Shortcuts

| | |
|---|---|
| `Space` | play / pause |
| `S` | split at the playhead |
| `Del` | delete selection |
| `Ctrl D` | duplicate |
| `Ctrl Z` / `Ctrl Shift Z` | undo / redo |
| `Ctrl I` | import media |
| `Ctrl S` / `Ctrl E` | save project / export |
| `,` `.` | step one frame |
| `Home` / `End` | jump to start / end |
| arrows | nudge the selected clip 1 px (`Shift` 10 px) |
| `+` `-` / `Shift Z` | zoom timeline / fit |
| `Ctrl` + wheel | zoom the timeline around the pointer |
| `Shift` while dragging | constrain to one axis |
| right-click a track head | delete that track |
| drag the ruler or empty track space | scrub the playhead |

## Tests

```bash
npm i -D playwright && npx playwright install chromium firefox
npm test                      # chromium
npm test -- firefox           # same checks in Gecko
```

Drives a real Chromium: imports a 1733 × 2011 checkerboard whose colour at every
coordinate is known, renders a frame, and reads the canvas back to assert that
each source pixel landed on exactly one canvas pixel — plus fades, splitting,
undo, pan interpolation, track stacking, text and its shadow, the visualiser
spectrum, the offline audio mixdown, a still export, and a real mouse drag
through empty track space to check scrubbing and playhead snapping.

Relinking is covered end to end: a project whose media sits in two different
folders is reopened with nothing loaded, then relinked one folder at a time
through the real dialog — which also checks that a file of the right kind but
the wrong name is left alone, that nothing is imported twice, and that the
folder walkers and the remembered-folder store behave.

## Layout of the code

```
index.html          shell
server.js           zero-dependency static server
src/js/
  store.js          project model, clips, undo, track/slot rules
  renderer.js       the compositor (preview and export share it)
  audio.js          playback scheduling, offline mixdown, spectrum, WAV
  playback.js       transport clock and video element sync
  timeline.js       tracks, clips, trimming, fades, snapping, scrubbing
  preview.js        stage, selection handles, dragging on the frame
  inspector.js      properties panel
  library.js        media pool, text and visualiser presets
  exporter.js       PNG sequence / WebM / still
  relink.js         finding a reopened project's media again
  folders.js        folder scanning, dropped folders, remembered folders
  fft.js  zip.js  icons.js  util.js
```

## Known limits

- Video decoding uses the browser's `<video>`, so frame-accurate export seeks
  one frame at a time and is slower than the image-only path.
- A video whose audio the browser cannot decode into an `AudioBuffer` will be
  silent in the mix; images, WAV, MP3, M4A and OGG are all fine.
- MP4 recording only appears in the format list if your browser reports support
  for it; otherwise use the PNG route and ffmpeg.
- If the browser cannot open an audio output device the preview plays silently
  and keeps time off the wall clock, so editing and export still work.

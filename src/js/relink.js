// Relinking: reconnecting a reopened project to its media files.
//
// A .videdit.json references media by name instead of embedding it, so opening
// one on another machine — or after the footage moved — leaves clips pointing
// at assets that are not loaded. This module finds those files again.
//
// Three things make that painless:
//   * a session stays open until every file is found, so media spread over
//     several folders is relinked in as many rounds as it takes;
//   * a whole folder tree is searched at once (picked, dropped or remembered),
//     and only the files that actually match are read and imported;
//   * folders are remembered between reloads, so the common case — the same
//     media folder as last time — relinks with no clicks at all.

import { el, fmtBytes } from './util.js';
import { icon, hydrateIcons } from './icons.js';
import {
  canRemember, entryFile, folderPermission, forgetFolder, hydrateSizes, pickFolder,
  rememberFolder, rememberedFolders, scanDataTransfer, scanFileList, scanFolder,
} from './folders.js';

// A pair is only linked when the evidence clears this. Deliberately above what
// a fuzzy name alone can score, so a wrong file is never silently bound —
// anything less confident waits for the user to point at it with Locate.
const MIN_SCORE = 46;

const norm = (s) => (s || '').toLowerCase().normalize('NFC');
const baseOf = (s) => (s || '').replace(/\.[^./\\]+$/, '');
const dirOf = (p) => norm(p).split('/').slice(0, -1);
/** Fold the noise a re-export leaves behind: "Shot_01 (1) copy.png" -> "shot01". */
const loose = (s) =>
  baseOf(norm(s))
    .replace(/\s*\(\d+\)\s*$/, '')
    .replace(/[\s_\-.]+/g, '')
    .replace(/(copy|final|edited?|export|proxy|v\d+)$/, '');

export function nameScore(want, entry) {
  if (want.kind && entry.kind && want.kind !== entry.kind) return 0;
  const wn = want.name || '';
  const en = entry.name || '';
  if (!wn || !en) return 0;
  if (wn === en) return 100;
  if (norm(wn) === norm(en)) return 92;
  if (baseOf(norm(wn)) === baseOf(norm(en))) return 62; // same shot, new extension
  const lw = loose(wn);
  const le = loose(en);
  if (lw && lw === le) return 48;
  if (lw && le && Math.min(lw.length, le.length) >= 5 && (lw.includes(le) || le.includes(lw))) return 34;
  return 0;
}

export function pathScore(want, entry) {
  const wp = norm(want.path);
  const ep = norm(entry.path);
  if (!wp || !ep) return 0;
  if (wp === ep || wp.endsWith(`/${ep}`) || ep.endsWith(`/${wp}`)) return 24;
  const wd = dirOf(wp);
  const ed = dirOf(ep);
  if (wd.length && ed.length && wd[wd.length - 1] === ed[ed.length - 1]) return 12;
  return 0;
}

export function sizeScore(want, entry) {
  if (!want.size || !entry.size) return 0;
  if (want.size === entry.size) return 26;
  return Math.abs(want.size - entry.size) / want.size < 0.02 ? 6 : -14;
}

export function scorePair(want, entry) {
  const n = nameScore(want, entry);
  if (!n) return 0;
  return n + pathScore(want, entry) + sizeScore(want, entry);
}

/**
 * Greedy best-first assignment: every wanted asset and every candidate file is
 * used at most once, strongest evidence first.
 */
export function matchEntries(wanted, entries, minScore = MIN_SCORE) {
  const pairs = [];
  for (const want of wanted) {
    for (const entry of entries) {
      const score = scorePair(want, entry);
      if (score >= minScore) pairs.push({ want, entry, score });
    }
  }
  pairs.sort((a, b) => b.score - a.score
    || (a.entry.path || '').split('/').length - (b.entry.path || '').split('/').length
    || (a.entry.path || '').localeCompare(b.entry.path || ''));
  const takenWants = new Set();
  const takenEntries = new Set();
  const out = [];
  for (const p of pairs) {
    if (takenWants.has(p.want.id) || takenEntries.has(p.entry)) continue;
    takenWants.add(p.want.id);
    takenEntries.add(p.entry);
    out.push(p);
  }
  return out;
}

/** What a saved project needs to find a file again. */
export function describeAsset(a) {
  return {
    id: a.id,
    name: a.name,
    path: a.path || '',
    kind: a.kind,
    size: a.size || 0,
    width: a.width,
    height: a.height,
    duration: a.duration,
  };
}

export class Relinker {
  constructor({ store, media, playback = null }) {
    this.store = store;
    this.media = media;
    this.playback = playback;
    this.wanted = new Map(); // assetId -> descriptor, for the whole session
    this.finished = false;
    this.scrim = null;
    this.listEl = null;
    this.statusEl = null;
    this.folderEl = null;
    this.busy = false;
    // Anything imported by any route — toolbar, drop, the library panel — is a
    // relink candidate while a session is open.
    this.media.on('imported', (assets) => {
      if (this.missing().length) this.offerAssets(assets);
    });
  }

  /** Descriptors for media the project still needs but does not have. */
  missing() {
    const used = new Set();
    for (const t of this.store.project.tracks || []) {
      for (const c of t.clips) {
        if (c.assetId) used.add(c.assetId);
        if (c.visualizer?.source && c.visualizer.source !== 'master') used.add(c.visualizer.source);
      }
    }
    const out = [];
    for (const [id, want] of this.wanted) {
      if (used.has(id) && !this.media.get(id)) out.push(want);
    }
    return out;
  }

  /**
   * Start a session for the assets a freshly opened project asked for. Tries
   * every remembered folder first and only bothers the user with the dialog if
   * something is still missing afterwards.
   */
  async begin(descriptors, { silent = false } = {}) {
    this.wanted = new Map();
    this.finished = false;
    for (const d of descriptors) if (d && d.id) this.wanted.set(d.id, { ...d });
    if (!this.missing().length) return { linked: 0, missing: 0, auto: true };

    let linked = 0;
    let from = '';
    for (const folder of await rememberedFolders()) {
      if (!this.missing().length) break;
      if ((await folderPermission(folder.handle)) !== 'granted') continue;
      try {
        const n = await this.offerEntries(await scanFolder(folder.handle));
        if (n) {
          linked += n;
          from = folder.name;
        }
      } catch { /* the folder went away: the dialog will offer to forget it */ }
    }

    const missing = this.missing().length;
    if (!missing) {
      if (linked && !silent) {
        this.store.emit('toast', `Relinked ${linked} file${linked > 1 ? 's' : ''} from ${from}`);
      }
      return { linked, missing: 0, auto: true };
    }
    this.open();
    return { linked, missing, auto: false };
  }

  // ------------------------------------------------------------------ linking
  /** Match a pool of candidate files against what is missing, and link them. */
  async offerEntries(entries) {
    const wanted = this.missing();
    if (!wanted.length || !entries?.length) return 0;

    // Reading a file just to learn its size is only worth it for entries whose
    // name already looks like a match, so shortlist on names first.
    const shortlist = entries.filter((e) => wanted.some((w) => nameScore(w, e) > 0));
    await hydrateSizes(shortlist);

    let linked = 0;
    for (const { want, entry } of matchEntries(wanted, shortlist)) {
      if (await this.link(want, entry)) linked++;
    }
    if (linked) this.commit();
    return linked;
  }

  /** The same, for files that are already in the media library. */
  async offerAssets(assets) {
    return this.offerEntries(
      (assets || []).map((a) => ({ name: a.name, path: a.path || a.name, kind: a.kind, size: a.size, asset: a })),
    );
  }

  /** Bind one missing asset to one file, importing it if it is not loaded yet. */
  async link(want, entry) {
    let asset = entry.asset || null;
    if (!asset) {
      const file = await entryFile(entry);
      if (!file) return false;
      // Do not import a second copy of something already in the library.
      asset = this.media.findSame(file)
        || (await this.media.importFile(file, entry.kind, { path: entry.path }));
    }
    if (!asset) return false;
    this.remap(want.id, asset.id);
    // The descriptor stays in the session so the dialog can show what it found;
    // missing() drops it because no clip points at the old id any more.
    want.linkedTo = asset;
    return true;
  }

  remap(oldId, newId) {
    if (oldId === newId) return;
    for (const t of this.store.project.tracks) {
      for (const c of t.clips) {
        if (c.assetId === oldId) c.assetId = newId;
        if (c.visualizer?.source === oldId) c.visualizer.source = newId;
        if (c.assetId === newId) this.media.releaseVideo(c.id);
      }
    }
  }

  commit() {
    this.store.changed();
    this.playback?.invalidate?.();
    this.paint();
  }

  // ------------------------------------------------------------------- sources
  async addFolder() {
    if (window.showDirectoryPicker) {
      const handle = await pickFolder();
      if (!handle) return 0;
      if ((await folderPermission(handle, true)) !== 'granted') return 0;
      await rememberFolder(handle);
      const n = await this.withBusy(`Searching ${handle.name}...`, async () =>
        this.offerEntries(await scanFolder(handle)));
      await this.paintFolders();
      this.report(n, handle.name);
      return n;
    }
    // Firefox and Safari: a directory <input> still gives the whole tree.
    const files = await pickFiles({ directory: true });
    if (!files.length) return 0;
    const n = await this.withBusy('Searching folder...', async () => this.offerEntries(scanFileList(files)));
    this.report(n, files[0]?.webkitRelativePath?.split('/')[0] || 'folder');
    return n;
  }

  async addFiles() {
    const files = await pickFiles({ multiple: true });
    if (!files.length) return 0;
    const n = await this.withBusy('Matching...', async () => this.offerEntries(scanFileList(files)));
    this.report(n, `${files.length} file${files.length > 1 ? 's' : ''}`);
    return n;
  }

  /** Explicitly point one missing item at one file, whatever it is called. */
  async locate(want) {
    const [file] = await pickFiles({ accept: `${want.kind}/*` });
    if (!file) return false;
    const entry = { name: file.name, path: file.webkitRelativePath || file.name, kind: want.kind, size: file.size, file };
    const ok = await this.link(want, entry);
    if (ok) this.commit();
    else this.store.emit('toast', `Could not read ${file.name}`);
    return ok;
  }

  async acceptDrop(dt) {
    const entries = await scanDataTransfer(dt);
    if (!entries.length) return 0;
    const n = await this.withBusy('Searching dropped folders...', async () => this.offerEntries(entries));
    this.report(n, 'the dropped files');
    return n;
  }

  report(n, where) {
    if (n) this.store.emit('toast', `Relinked ${n} file${n > 1 ? 's' : ''} from ${where}`);
    else if (this.missing().length) this.store.emit('toast', `No match in ${where}`);
  }

  async withBusy(label, fn) {
    this.busy = label;
    this.paint();
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.paint();
    }
  }

  // -------------------------------------------------------------------- dialog
  open() {
    if (this.scrim) return;
    this.playback?.pause?.();
    const scrim = el('div', { class: 'scrim' });
    const modal = el('div', { class: 'modal relink' });

    const head = el('header', {});
    head.append(icon('open', 16), el('span', {}, 'Relink media'), el('div', { class: 'spacer' }));
    const closeBtn = el('button', { class: 'btn icon ghost', type: 'button', title: 'Close' });
    closeBtn.append(icon('x', 14));
    head.append(closeBtn);

    this.statusEl = el('div', { class: 'hint' });
    const folderBtn = el('button', { class: 'btn primary', type: 'button' });
    folderBtn.append(icon('folder', 13), el('span', {}, 'Add folder...'));
    const filesBtn = el('button', { class: 'btn', type: 'button' });
    filesBtn.append(icon('upload', 13), el('span', {}, 'Add files...'));
    const actions = el('div', { class: 'relink-actions' }, folderBtn, filesBtn);

    const zone = el('div', { class: 'dropzone sm' });
    // Whole folders are searched, subfolders included, and the dialog stays
    // open across as many rounds as it takes.
    zone.append(el('b', {}, 'Drop folders or files here'));

    this.listEl = el('div', { class: 'relink-list' });
    this.folderEl = el('div', { class: 'relink-folders' });

    const doneBtn = el('button', { class: 'btn primary', type: 'button' }, 'Done');
    modal.append(head, el('div', { class: 'body' }, this.statusEl, actions, zone, this.listEl, this.folderEl),
      el('footer', {}, doneBtn));
    scrim.append(modal);
    document.body.append(scrim);
    this.scrim = scrim;

    folderBtn.addEventListener('click', () => this.addFolder());
    filesBtn.addEventListener('click', () => this.addFiles());
    const close = () => this.close();
    closeBtn.addEventListener('click', close);
    doneBtn.addEventListener('click', close);
    scrim.addEventListener('pointerdown', (e) => e.target === scrim && close());

    ['dragenter', 'dragover'].forEach((ev) =>
      zone.addEventListener(ev, (e) => {
        e.preventDefault();
        zone.classList.add('hot');
      }));
    ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, () => zone.classList.remove('hot')));
    // Dropping onto the dialog must relink, not import loose copies, so this
    // claims the event before the window-level import handler sees it.
    scrim.addEventListener('drop', (e) => {
      if (!e.dataTransfer) return;
      e.preventDefault();
      e.stopPropagation();
      this.acceptDrop(e.dataTransfer);
    }, true);
    scrim.addEventListener('dragover', (e) => e.preventDefault());

    this.paint();
    this.paintFolders();
  }

  close() {
    this.scrim?.remove();
    this.scrim = null;
    this.listEl = null;
    this.statusEl = null;
    this.folderEl = null;
  }

  paint() {
    this.store.emit('missing');
    if (!this.scrim) return;
    const missing = this.missing();
    const missingIds = new Set(missing.map((w) => w.id));
    const total = this.wanted.size;
    this.statusEl.textContent = this.busy
      || (missing.length
        ? `${missing.length} of ${total} file${total > 1 ? 's' : ''} still missing. Point videdit at the folder they live in.`
        : 'Everything is linked.');

    this.listEl.textContent = '';
    for (const want of this.wanted.values()) this.listEl.append(this.row(want, missingIds.has(want.id)));
    hydrateIcons(this.listEl);

    if (!missing.length && total && !this.finished) {
      this.finished = true;
      this.store.emit('toast', 'All media relinked');
      setTimeout(() => this.close(), 700);
    }
  }

  row(want, isMissing) {
    const asset = want.linkedTo;
    const sub = [
      want.path && want.path !== want.name ? want.path : '',
      want.size ? fmtBytes(want.size) : '',
      asset ? `-> ${asset.path || asset.name}` : '',
    ].filter(Boolean).join(' · ');
    const row = el('div', { class: `relink-row${isMissing ? ' missing' : ' ok'}` });
    row.append(el('span', { class: `dot ${isMissing ? 'bad' : 'good'}` }));
    row.append(el('div', { class: 'txt' },
      el('div', { class: 'nm' }, want.name),
      el('div', { class: 'sub' }, sub || want.kind)));
    if (isMissing) {
      const b = el('button', { class: 'btn sm', type: 'button' }, 'Locate...');
      b.addEventListener('click', () => this.locate(want));
      row.append(b);
    } else {
      row.append(el('span', { class: 'tag ok' }, 'linked'));
    }
    return row;
  }

  /**
   * Reading handles and permissions is async, so two overlapping repaints would
   * otherwise both append into the list. Rows are built off-screen and only the
   * newest run is allowed to swap them in.
   */
  async paintFolders() {
    if (!this.folderEl) return;
    const run = (this.folderRun = (this.folderRun || 0) + 1);
    const frag = document.createDocumentFragment();
    const show = () => {
      if (!this.folderEl || run !== this.folderRun) return;
      this.folderEl.textContent = '';
      this.folderEl.append(frag);
      hydrateIcons(this.folderEl);
    };
    // Only Chrome and Edge can hold on to a folder handle between reloads.
    if (!canRemember()) {
      show();
      return;
    }
    const folders = await rememberedFolders();
    if (!folders.length) {
      show();
      return;
    }
    frag.append(el('div', { class: 'relink-sub' }, 'Remembered folders'));
    for (const f of folders) {
      const state = await folderPermission(f.handle);
      const row = el('div', { class: 'relink-row folder' });
      row.append(icon('folder', 13), el('div', { class: 'txt' },
        el('div', { class: 'nm' }, f.name),
        el('div', { class: 'sub' }, state === 'granted' ? 'searched automatically' : 'needs permission')));
      if (state !== 'granted') {
        const b = el('button', { class: 'btn sm', type: 'button' }, 'Allow');
        b.addEventListener('click', async () => {
          if ((await folderPermission(f.handle, true)) !== 'granted') return;
          const n = await this.withBusy(`Searching ${f.name}...`, async () =>
            this.offerEntries(await scanFolder(f.handle)));
          this.report(n, f.name);
          this.paintFolders();
        });
        row.append(b);
      }
      const x = el('button', { class: 'btn sm icon ghost', type: 'button', title: 'Forget this folder' });
      x.append(icon('x', 11));
      x.addEventListener('click', async () => {
        await forgetFolder(f.key);
        this.paintFolders();
      });
      row.append(x);
      frag.append(row);
    }
    show();
  }
}

/** A throwaway file input, resolved when the user picks (or cancels). */
function pickFiles({ multiple = false, directory = false, accept = 'image/*,video/*,audio/*' } = {}) {
  return new Promise((res) => {
    const input = el('input', { type: 'file', hidden: true });
    if (multiple || directory) input.multiple = true;
    if (directory) {
      input.webkitdirectory = true;
      input.setAttribute('webkitdirectory', '');
    } else {
      input.accept = accept;
    }
    const done = (files) => {
      input.remove();
      res(files);
    };
    input.addEventListener('change', () => done([...input.files]));
    // A cancelled picker fires nothing in older browsers; the focus round-trip
    // is the only reliable way to stop leaking a pending promise.
    input.addEventListener('cancel', () => done([]));
    document.body.append(input);
    input.click();
  });
}

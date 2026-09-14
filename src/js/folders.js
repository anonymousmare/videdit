// Media folders: recursive scanning, dropped-folder walking, and — where the
// File System Access API exists — folders remembered across reloads in
// IndexedDB, so reopening a project can relink itself with no picking at all.
//
// Everything here yields the same lightweight shape, so the matcher in
// relink.js never has to care where a candidate came from:
//
//   { name, path, kind, size?, file?, handle? }
//
// `size` and `file` are filled in lazily: walking a folder of 3000 files must
// not read 3000 files, so handles are only turned into Files for the handful
// of candidates whose names actually look like a match.

import { kindOf } from './media.js';

const DB_NAME = 'videdit';
const STORE = 'folders';
const MAX_REMEMBERED = 8;
const SKIP_DIRS = new Set(['node_modules', '.git', '$recycle.bin', 'system volume information']);
export const MAX_SCAN = 6000;
const MAX_DEPTH = 8;

/** Only Chromium-family browsers can hand back a folder that survives a reload. */
export const canRemember = () =>
  typeof indexedDB !== 'undefined' && typeof window !== 'undefined' && !!window.showDirectoryPicker;

// ------------------------------------------------------------------ IndexedDB
function openDb() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}

function run(mode, fn) {
  return openDb().then(
    (db) =>
      new Promise((res, rej) => {
        const t = db.transaction(STORE, mode);
        const req = fn(t.objectStore(STORE));
        t.oncomplete = () => res(req ? req.result : undefined);
        t.onabort = t.onerror = () => rej(t.error);
      }),
  );
}

/** [{ key, name, handle, addedAt }], newest first. Never throws. */
export async function rememberedFolders() {
  if (!canRemember()) return [];
  try {
    const all = (await run('readonly', (s) => s.getAll())) || [];
    return all.filter((r) => r && r.handle).sort((a, b) => b.addedAt - a.addedAt);
  } catch {
    return [];
  }
}

export async function rememberFolder(handle) {
  if (!canRemember() || !handle) return null;
  try {
    const all = await rememberedFolders();
    for (const r of all) {
      // Same folder picked again: just freshen it rather than storing a twin.
      if (await sameEntry(r.handle, handle)) {
        const row = { ...r, handle, addedAt: Date.now() };
        await run('readwrite', (s) => s.put(row));
        return row;
      }
    }
    const row = { key: `dir_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      name: handle.name || 'folder', handle, addedAt: Date.now() };
    await run('readwrite', (s) => s.put(row));
    for (const stale of all.slice(MAX_REMEMBERED - 1)) await forgetFolder(stale.key);
    return row;
  } catch {
    return null; // a browser that refuses to structured-clone the handle
  }
}

export async function forgetFolder(key) {
  if (!canRemember()) return;
  try {
    await run('readwrite', (s) => s.delete(key));
  } catch { /* nothing to do */ }
}

async function sameEntry(a, b) {
  try {
    return a && b && (a === b || (a.isSameEntry ? await a.isSameEntry(b) : a.name === b.name));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- permissions
/** 'granted' | 'prompt' | 'denied'. `request: true` must run inside a gesture. */
export async function folderPermission(handle, request = false) {
  if (!handle) return 'denied';
  const opts = { mode: 'read' };
  try {
    if (handle.queryPermission) {
      const state = await handle.queryPermission(opts);
      if (state === 'granted' || !request) return state;
    }
    if (request && handle.requestPermission) return await handle.requestPermission(opts);
    return 'granted'; // no permissions API: assume usable and let the scan fail loudly
  } catch {
    return 'denied';
  }
}

export async function pickFolder() {
  if (!window.showDirectoryPicker) return null;
  try {
    return await window.showDirectoryPicker({ mode: 'read', id: 'videdit-media' });
  } catch {
    return null; // the user cancelled
  }
}

// ------------------------------------------------------------------- scanning
/** Walk a directory handle, keeping only importable media. */
export async function scanFolder(handle, { max = MAX_SCAN } = {}) {
  const out = [];
  const walk = async (dir, prefix, depth) => {
    if (out.length >= max || depth > MAX_DEPTH) return;
    const iter = dir.entries ? dir.entries() : null;
    if (!iter) return;
    for await (const [name, child] of iter) {
      if (out.length >= max) return;
      if (name.startsWith('.')) continue;
      if (child.kind === 'directory') {
        if (SKIP_DIRS.has(name.toLowerCase())) continue;
        await walk(child, `${prefix}${name}/`, depth + 1);
      } else {
        const kind = kindOf({ name, type: '' });
        if (kind) out.push({ name, path: `${prefix}${name}`, kind, handle: child });
      }
    }
  };
  await walk(handle, `${handle.name || ''}/`, 0);
  return out;
}

/** Files straight off an <input>, including a webkitdirectory one. */
export function scanFileList(files) {
  const out = [];
  for (const file of files) {
    const kind = kindOf(file);
    if (!kind) continue;
    out.push({ name: file.name, path: file.webkitRelativePath || file.name, kind, size: file.size, file });
  }
  return out;
}

/**
 * Files *and folders* out of a drop. `dataTransfer.items` goes stale after the
 * first await, so every entry is grabbed synchronously before anything else.
 */
export async function scanDataTransfer(dt, { max = MAX_SCAN } = {}) {
  const roots = [];
  for (const item of dt.items || []) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) roots.push(entry);
  }
  if (!roots.length) return scanFileList(dt.files || []);

  const out = [];
  const walk = async (entry, prefix, depth) => {
    if (out.length >= max || depth > MAX_DEPTH) return;
    if (entry.isFile) {
      const kind = kindOf({ name: entry.name, type: '' });
      if (!kind) return;
      const file = await new Promise((res) => entry.file(res, () => res(null)));
      if (file) out.push({ name: file.name, path: `${prefix}${file.name}`, kind, size: file.size, file });
      return;
    }
    if (!entry.isDirectory || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name.toLowerCase())) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res) => reader.readEntries(res, () => res([])));
      if (!batch.length) break; // readEntries pages: an empty batch means done
      for (const child of batch) await walk(child, `${prefix}${entry.name}/`, depth + 1);
      if (out.length >= max) return;
    }
  };
  for (const root of roots) await walk(root, '', 0);
  return out;
}

/** Turn an entry into a real File, reading the handle only when it must. */
export async function entryFile(entry) {
  if (entry.file) return entry.file;
  if (entry.handle?.getFile) {
    entry.file = await entry.handle.getFile();
    if (entry.size == null) entry.size = entry.file.size;
    return entry.file;
  }
  return null;
}

/** Fill in `size` for entries that only carry a handle, for tie-breaking. */
export async function hydrateSizes(entries) {
  for (const e of entries) {
    if (e.size != null || !e.handle?.getFile) continue;
    try {
      await entryFile(e);
    } catch { /* unreadable: it simply loses the size signal */ }
  }
  return entries;
}

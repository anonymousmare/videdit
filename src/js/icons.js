// Minimal line-icon set (24x24 grid, 1.75 stroke) drawn in the same visual
// language as Lucide/Feather. No emoji anywhere in this app.

const P = {
  play: '<path d="M7 4.8v14.4l12-7.2z"/>',
  pause: '<path d="M9 4.5v15M15 4.5v15"/>',
  skipStart: '<path d="M6 5v14M19 5.5v13L9 12z"/>',
  skipEnd: '<path d="M18 5v14M5 5.5v13L15 12z"/>',
  stepBack: '<path d="M13 6.5v11L5.5 12zM19 6.5v11"/>',
  stepFwd: '<path d="M11 6.5v11L18.5 12zM5 6.5v11"/>',
  scissors: '<circle cx="6.5" cy="17.5" r="2.5"/><circle cx="6.5" cy="6.5" r="2.5"/><path d="M20 4 8.6 15.4M14.5 13.5 20 20M8.6 8.6l2.9 2.9"/>',
  trash: '<path d="M4 6.5h16M9.5 6.5V4.8h5v1.7M6.5 6.5 7.4 19a1.4 1.4 0 0 0 1.4 1.3h6.4a1.4 1.4 0 0 0 1.4-1.3l.9-12.5M10 10v6.5M14 10v6.5"/>',
  undo: '<path d="M4 9h9.5a5.5 5.5 0 1 1 0 11H8M4 9l4-4M4 9l4 4"/>',
  redo: '<path d="M20 9h-9.5a5.5 5.5 0 1 0 0 11H16M20 9l-4-4M20 9l-4 4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M5 12h14"/>',
  image: '<rect x="3.2" y="4.2" width="17.6" height="15.6" rx="2.2"/><circle cx="8.6" cy="9.4" r="1.6"/><path d="m3.6 17 4.6-4.4a2 2 0 0 1 2.7 0L20.4 21"/>',
  video: '<rect x="2.6" y="5.5" width="13.5" height="13" rx="2.2"/><path d="m16.1 10.6 5.3-3.2v9.2l-5.3-3.2z"/>',
  music: '<path d="M9 18V6.2l10-2v11.6"/><circle cx="6.4" cy="18" r="2.6"/><circle cx="16.4" cy="15.8" r="2.6"/>',
  type: '<path d="M5 6.2V4.5h14v1.7M12 4.5v15M8.8 19.5h6.4"/>',
  waveform: '<path d="M3 12h2.2M7.4 7.4v9.2M11.7 4v16M16 8.6v6.8M20.3 10.6v2.8"/>',
  download: '<path d="M12 3.8v11M7.8 10.6 12 14.8l4.2-4.2M4.5 16.4v2.3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.3"/>',
  upload: '<path d="M12 15.5v-11M7.8 8.7 12 4.5l4.2 4.2M4.5 16.4v2.3a1.5 1.5 0 0 0 1.5 1.5h12a1.5 1.5 0 0 0 1.5-1.5v-2.3"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 14.4a1.5 1.5 0 0 0 .3 1.7l.1.1a1.9 1.9 0 1 1-2.7 2.7l-.1-.1a1.5 1.5 0 0 0-2.6 1v.3a1.9 1.9 0 0 1-3.8 0V20a1.5 1.5 0 0 0-2.6-1l-.1.1a1.9 1.9 0 1 1-2.7-2.7l.1-.1a1.5 1.5 0 0 0-1-2.6H4a1.9 1.9 0 0 1 0-3.8h.2a1.5 1.5 0 0 0 1-2.6l-.1-.1a1.9 1.9 0 1 1 2.7-2.7l.1.1a1.5 1.5 0 0 0 2.6-1V4a1.9 1.9 0 0 1 3.8 0v.2a1.5 1.5 0 0 0 2.6 1l.1-.1a1.9 1.9 0 1 1 2.7 2.7l-.1.1a1.5 1.5 0 0 0 1 2.6h.2a1.9 1.9 0 0 1 0 3.8H20a1.5 1.5 0 0 0-1.4.9z"/>',
  eye: '<path d="M2.4 12S6 5.6 12 5.6 21.6 12 21.6 12 18 18.4 12 18.4 2.4 12 2.4 12z"/><circle cx="12" cy="12" r="2.9"/>',
  eyeOff: '<path d="M10 5.9a8 8 0 0 1 2-.3c6 0 9.6 6.4 9.6 6.4a16 16 0 0 1-2.8 3.6M6.4 7.7A16 16 0 0 0 2.4 12s3.6 6.4 9.6 6.4a9 9 0 0 0 4-.9M9.9 9.9a3 3 0 0 0 4.2 4.2M3.5 3.5l17 17"/>',
  volume: '<path d="M11 5.2 6.6 8.8H3.4v6.4h3.2L11 18.8z"/><path d="M15.2 9.1a4 4 0 0 1 0 5.8M18 6.4a8 8 0 0 1 0 11.2"/>',
  volumeOff: '<path d="M11 5.2 6.6 8.8H3.4v6.4h3.2L11 18.8z"/><path d="m15.4 9.6 5 4.8M20.4 9.6l-5 4.8"/>',
  lock: '<rect x="4.6" y="10.4" width="14.8" height="9.4" rx="2.1"/><path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.6 0v2.6"/>',
  unlock: '<rect x="4.6" y="10.4" width="14.8" height="9.4" rx="2.1"/><path d="M8.2 10.4V7.8a3.8 3.8 0 0 1 7.3-1.3"/>',
  magnet: '<path d="M6.5 4.5H3.4v7.9a8.6 8.6 0 0 0 17.2 0V4.5h-3.1v7.9a5.5 5.5 0 0 1-11 0zM3.4 10.4h3.1M17.5 10.4h3.1"/>',
  layers: '<path d="m12 3.4 8.6 4.3-8.6 4.3-8.6-4.3zM3.4 12.2 12 16.5l8.6-4.3M3.4 16.5 12 20.8l8.6-4.3"/>',
  chevronDown: '<path d="m6.5 9.5 5.5 5.5 5.5-5.5"/>',
  chevronRight: '<path d="m9.5 6.5 5.5 5.5-5.5 5.5"/>',
  x: '<path d="M5.8 5.8l12.4 12.4M18.2 5.8 5.8 18.2"/>',
  folder: '<path d="M3.4 7.3a2 2 0 0 1 2-2h3.3l2.1 2.5h7.8a2 2 0 0 1 2 2v8.9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z"/>',
  copy: '<rect x="8.4" y="8.4" width="11.2" height="11.2" rx="2"/><path d="M15.6 8.4V6.4a2 2 0 0 0-2-2H6.4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 2 2h2"/>',
  alignLeft: '<path d="M4 6.4h16M4 12h10M4 17.6h13"/>',
  alignCenter: '<path d="M4 6.4h16M7 12h10M5.5 17.6h13"/>',
  alignRight: '<path d="M4 6.4h16M10 12h10M7 17.6h13"/>',
  alignTop: '<path d="M6.4 4v16M12 4v10M17.6 4v13"/>',
  alignMiddle: '<path d="M6.4 4v16M12 7v10M17.6 5.5v13"/>',
  alignBottom: '<path d="M6.4 4v16M12 10v10M17.6 7v13"/>',
  move: '<path d="M12 3.4v17.2M3.4 12h17.2M9.2 6.2 12 3.4l2.8 2.8M9.2 17.8 12 20.6l2.8-2.8M6.2 9.2 3.4 12l2.8 2.8M17.8 9.2 20.6 12l-2.8 2.8"/>',
  target: '<circle cx="12" cy="12" r="8.4"/><circle cx="12" cy="12" r="3.6"/><path d="M12 1.8v3.2M12 19v3.2M1.8 12H5M19 12h3.2"/>',
  film: '<rect x="3" y="4.4" width="18" height="15.2" rx="2.2"/><path d="M7.6 4.4v15.2M16.4 4.4v15.2M3 12h18M3 8.2h4.6M3 15.8h4.6M16.4 8.2H21M16.4 15.8H21"/>',
  sliders: '<path d="M5 20v-6.4M5 9.6V4M12 20v-9.6M12 6.4V4M19 20v-3.2M19 12.8V4"/><circle cx="5" cy="11.6" r="1.9"/><circle cx="12" cy="8.4" r="1.9"/><circle cx="19" cy="14.8" r="1.9"/>',
  sparkle: '<path d="M12 3.2 13.9 9l5.8 1.9-5.8 1.9L12 18.6l-1.9-5.8L4.3 10.9 10.1 9zM18.5 3.4l.8 2.3 2.3.8-2.3.8-.8 2.3-.8-2.3-2.3-.8 2.3-.8zM6 15.6l.7 1.9 1.9.7-1.9.7-.7 1.9-.7-1.9-1.9-.7 1.9-.7z"/>',
  zoomIn: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="m15.6 15.6 4.6 4.6M8.4 10.8h4.8M10.8 8.4v4.8"/>',
  zoomOut: '<circle cx="10.8" cy="10.8" r="6.6"/><path d="m15.6 15.6 4.6 4.6M8.4 10.8h4.8"/>',
  maximize: '<path d="M8.4 3.6H5.6a2 2 0 0 0-2 2v2.8M15.6 3.6h2.8a2 2 0 0 1 2 2v2.8M8.4 20.4H5.6a2 2 0 0 1-2-2v-2.8M15.6 20.4h2.8a2 2 0 0 0 2-2v-2.8"/>',
  grid: '<rect x="3.6" y="3.6" width="7" height="7" rx="1.4"/><rect x="13.4" y="3.6" width="7" height="7" rx="1.4"/><rect x="3.6" y="13.4" width="7" height="7" rx="1.4"/><rect x="13.4" y="13.4" width="7" height="7" rx="1.4"/>',
  save: '<path d="M5.6 4.4h10.2L19.6 8.2v11.4a1.4 1.4 0 0 1-1.4 1.4H5.6a1.4 1.4 0 0 1-1.4-1.4V5.8a1.4 1.4 0 0 1 1.4-1.4z"/><path d="M8 4.4v5h7v-5M8 20.6v-5.8h8v5.8"/>',
  open: '<path d="M3.4 8.2a2 2 0 0 1 2-2h3.2l2.1 2.4h6.9a2 2 0 0 1 2 2v.8M2.8 19.4l2.2-6.6a1.6 1.6 0 0 1 1.5-1.1h14.2a1.2 1.2 0 0 1 1.1 1.6l-2 6a1.6 1.6 0 0 1-1.5 1.1H4.3a1.6 1.6 0 0 1-1.5-2z"/>',
  refresh: '<path d="M20 11.2A8 8 0 0 0 6.3 6.6L3.4 9.3M4 12.8a8 8 0 0 0 13.7 4.6l2.9-2.7M3.4 5.1v4.2h4.2M20.6 18.9v-4.2h-4.2"/>',
  crosshair: '<path d="M12 4.2v3.4M12 16.4v3.4M4.2 12h3.4M16.4 12h3.4"/><circle cx="12" cy="12" r="3.2"/>',
  duplicate: '<rect x="3.4" y="7.6" width="10" height="10" rx="1.8"/><path d="M7.6 7.6V5.8a1.8 1.8 0 0 1 1.8-1.8h9a1.8 1.8 0 0 1 1.8 1.8v9a1.8 1.8 0 0 1-1.8 1.8h-1.8"/>',
  fade: '<rect x="3.4" y="4.6" width="17.2" height="14.8" rx="2"/><path d="M7 19.4V4.6M11 19.4V4.6M15 19.4V4.6" stroke-opacity=".35"/>',
  info: '<circle cx="12" cy="12" r="8.6"/><path d="M12 11v5.4M12 7.8v.6"/>',
};

export const ICON_NAMES = Object.keys(P);

export function iconSvg(name, size = 16) {
  const body = P[name] || P.info;
  return `<svg class="ic" viewBox="0 0 24 24" width="${size}" height="${size}" fill="none"
    stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"
    aria-hidden="true">${body}</svg>`;
}

/** Build an <svg> element node. */
export function icon(name, size = 16) {
  const tpl = document.createElement('template');
  tpl.innerHTML = iconSvg(name, size).trim();
  return tpl.content.firstElementChild;
}

/** Hydrate every [data-icon] element in a subtree. */
export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((el) => {
    if (el.dataset.iconDone === '1') return;
    const size = Number(el.dataset.iconSize || 16);
    el.insertAdjacentHTML('afterbegin', iconSvg(el.dataset.icon, size));
    el.dataset.iconDone = '1';
  });
}

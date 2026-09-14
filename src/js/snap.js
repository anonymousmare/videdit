// Alignment snapping for the preview stage.
//
// Dragging a clip on the frame is how you compose a shot, and by eye you can
// never quite land a title on the centre line. So the drag looks for nearby
// guides — the frame's own edges, halves and thirds, plus the edges and
// centres of the other clips on screen — and pulls the box onto the closest
// one. The tolerance is in SCREEN pixels, so it feels the same at any zoom,
// and holding Alt drops the whole thing for a free-hand nudge.

/** How close (in screen px) a box edge has to be before it snaps. */
export const SNAP_TOLERANCE = 6;

/**
 * Guides belonging to the frame itself: edges, centre lines and thirds.
 * @param {{width:number,height:number}} p
 */
export function frameGuides(p) {
  return [
    { axis: 'x', at: 0, kind: 'edge' },
    { axis: 'x', at: p.width / 2, kind: 'center' },
    { axis: 'x', at: p.width, kind: 'edge' },
    { axis: 'x', at: p.width / 3, kind: 'third' },
    { axis: 'x', at: (p.width * 2) / 3, kind: 'third' },
    { axis: 'y', at: 0, kind: 'edge' },
    { axis: 'y', at: p.height / 2, kind: 'center' },
    { axis: 'y', at: p.height, kind: 'edge' },
    { axis: 'y', at: p.height / 3, kind: 'third' },
    { axis: 'y', at: (p.height * 2) / 3, kind: 'third' },
  ];
}

/** Guides belonging to another clip already on screen: its edges and centre. */
export function boxGuides(box) {
  return [
    { axis: 'x', at: box.left, kind: 'clip' },
    { axis: 'x', at: box.left + box.w / 2, kind: 'clip' },
    { axis: 'x', at: box.left + box.w, kind: 'clip' },
    { axis: 'y', at: box.top, kind: 'clip' },
    { axis: 'y', at: box.top + box.h / 2, kind: 'clip' },
    { axis: 'y', at: box.top + box.h, kind: 'clip' },
  ];
}

// Distance alone picks badly. Drop a title near the middle of the frame with
// another title already sitting there and its edge is a pixel or two nearer
// than the centre line — so the drag glues itself to the neighbour and the
// composition you were actually aiming for loses by a rounding error. These
// weights (in canvas px) say which guide is worth more when two are within a
// hair of each other: the frame's own lines beat the other clips' boxes, and
// landing a box by its centre beats landing it by an edge.
const KIND_WEIGHT = { center: 2, edge: 1.5, third: 0.5, clip: 0 };
const CENTRE_ANCHOR = 1.5;

/** The three places on a box that can land on a guide. */
function anchors(box, axis) {
  const start = axis === 'x' ? box.left : box.top;
  const size = axis === 'x' ? box.w : box.h;
  return [
    { at: start + size / 2, bonus: CENTRE_ANCHOR },
    { at: start, bonus: 0 },
    { at: start + size, bonus: 0 },
  ];
}

/**
 * Nudge `box` onto the nearest guide on each axis independently.
 *
 * @param {{left:number,top:number,w:number,h:number}} box  where the drag has put it
 * @param {Array<{axis:string,at:number,kind:string}>} guides
 * @param {number} tol  tolerance in the same units as the box (canvas px)
 * @returns {{dx:number, dy:number, lines:Array<{axis:string,at:number,kind:string}>}}
 *   dx/dy is the correction to add; `lines` are the guides to draw.
 */
export function snapBox(box, guides, tol) {
  const out = { dx: 0, dy: 0, lines: [] };
  if (!(tol > 0)) return out;
  for (const axis of ['x', 'y']) {
    const pts = anchors(box, axis);
    let best = null;
    let bestScore = Infinity;
    for (const g of guides) {
      if (g.axis !== axis) continue;
      for (const a of pts) {
        const d = g.at - a.at;
        if (Math.abs(d) > tol) continue;
        const score = Math.abs(d) - (KIND_WEIGHT[g.kind] ?? 0) - a.bonus;
        if (score < bestScore - 1e-9) {
          bestScore = score;
          best = d;
        }
      }
    }
    if (best == null) continue;
    if (axis === 'x') out.dx = best;
    else out.dy = best;
    // Several guides can coincide once the box has moved — a clip edge sitting
    // on the centre line, say. Draw every one of them, not just the winner.
    for (const g of guides) {
      if (g.axis !== axis) continue;
      if (pts.some((a) => Math.abs(g.at - (a.at + best)) < 1e-6)) out.lines.push(g);
    }
  }
  return out;
}

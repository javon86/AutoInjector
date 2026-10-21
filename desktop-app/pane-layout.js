// pane-layout.js — where the native AI panes may be drawn (ISS-001).
// The panes are WebContentsViews that float ABOVE the controls page, so they
// must be clipped to the area below the sticky User Panel and hidden while a
// dialog is open.

// Clip each measured pane rect to the area BELOW the sticky User Panel and
// inside the window; hide every pane while a dialog is open. A pane clipped to
// a sliver (< MIN_PANE_VISIBLE px) is treated as hidden. Pure, so it's testable.
const MIN_PANE_VISIBLE = 40;
function clipPaneRects(rects) {
  const out = {};
  if (!rects) return out;
  const top = Number(rects.__top) || 0;
  const bottom = Number(rects.__bottom) > 0 ? Number(rects.__bottom) : Infinity;
  for (const [site, r] of Object.entries(rects)) {
    if (site.startsWith("__")) continue;
    if (!r || rects.__modal) { out[site] = null; continue; }
    const y1 = Math.max(r.y, top);
    const y2 = Math.min(r.y + r.height, bottom);
    out[site] = y2 - y1 < MIN_PANE_VISIBLE ? null : { x: r.x, y: y1, width: r.width, height: y2 - y1 };
  }
  return out;
}

module.exports = { clipPaneRects, MIN_PANE_VISIBLE };

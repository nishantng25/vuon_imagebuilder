// =============================================================================
// Pathway renderer — draws every floor's pathways on:
//   (a) the regular admin Place screen (#sv-canvas-wrap / #sv-plan-img),
//       above pin overlays but below the calibration / outline overlays.
//   (b) the operator monitor canvas (#sv-monitor-canvas), so paths are
//       visible in Live / Incident / Coverage modes too.
//
// Read-only outside the full-screen editor. Click does nothing here —
// path editing lives entirely in the full-screen editor. This module
// is a paint job.
//
// Refresh strategy: a slow poll (every 4 s). Pathways change rarely;
// no need for MutationObservers or SSE for this. The poll also picks
// up changes the operator just made in the editor without needing a
// reload.
// =============================================================================

import { openPathwayLiveGrid } from './path_live_grid.js';

const ADMIN_HOST_ID    = 'sv-canvas-wrap';
const ADMIN_IMG_ID     = 'sv-plan-img';
const MONITOR_HOST_ID  = 'sv-monitor-canvas';
const MONITOR_IMG_ID   = 'sv-mon-plan-img';

const PATH_PALETTE = [
  '#5c8bf2', '#86c26f', '#f59e0b', '#d95a50',
  '#c084fc', '#06b6d4', '#ec4899', '#84cc16',
];
function colorForRoute(r) {
  return (r && typeof r.color === 'string' && r.color) ? r.color : PATH_PALETTE[0];
}

let lastFloorId = null;
let cache = [];            // routes for the current floor
let lastSig = '';
let inFlight = false;

function $(id) { return document.getElementById(id); }
function currentFloorId() {
  const sv = window.SV || {};
  return sv.currentFloorId || null;
}

async function refresh() {
  if (inFlight) return;
  const fid = currentFloorId();
  if (!fid) return;
  if (fid !== lastFloorId) {
    cache = [];
    lastFloorId = fid;
    lastSig = '';
  }
  inFlight = true;
  try {
    const got = await window.siteApi.get(`/api/site/floors/${fid}/routes`);
    cache = Array.isArray(got) ? got : [];
  } catch (e) {
    // No-op — could be 401 mid-logout, 404 on a deleted floor, etc.
    cache = cache || [];
  } finally {
    inFlight = false;
  }
  paintAll();
}

// Signature: floor-id + sorted (id,color,wpsig,name) per route. Drives
// the "skip rerender if unchanged" guard so we don't churn DOM on
// every poll.
function buildSig() {
  return JSON.stringify({
    f: lastFloorId,
    r: cache.map(r => [
      r.id, r.color || '', r.name,
      (r.waypoints || []).length,
      (r.waypoints && r.waypoints[0]) ? r.waypoints[0].x_pct.toFixed(4) : '',
    ]),
  });
}

function paintAll() {
  const sig = buildSig();
  if (sig === lastSig) return;
  lastSig = sig;
  paintInto(ADMIN_HOST_ID,   ADMIN_IMG_ID,   /*overlayId=*/'scada-paths-admin',
            /*z=*/6, { clickable: false });
  // Operator monitor canvas — paths are clickable here so the operator
  // can launch the live grid for a path's cameras directly from Live /
  // Incident / Coverage views.
  paintInto(MONITOR_HOST_ID, MONITOR_IMG_ID, /*overlayId=*/'scada-paths-monitor',
            /*z=*/8, { clickable: true });
}

function paintInto(hostId, imgId, overlayId, zIndex, opts) {
  opts = opts || {};
  const host = $(hostId);
  if (!host) return;
  const img  = $(imgId);
  if (!img || !img.naturalWidth) {
    // Image still loading — remove any stale overlay; retry on next tick.
    const stale = $(overlayId);
    if (stale) stale.remove();
    return;
  }
  // Container must be position:relative so the absolute overlay aligns.
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  let overlay = $(overlayId);
  if (!overlay) {
    overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.id = overlayId;
    Object.assign(overlay.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none',
      width: '100%', height: '100%', zIndex: String(zIndex),
    });
    host.appendChild(overlay);
  }
  overlay.innerHTML = '';
  if (cache.length === 0) return;
  // Position SVG to the image's bounding rect so paths line up with
  // the displayed plan regardless of how it's positioned in the host.
  const rect = img.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const offX = rect.left - hostRect.left;
  const offY = rect.top - hostRect.top;
  Object.assign(overlay.style, {
    left: offX + 'px', top: offY + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    inset: 'auto',
  });
  overlay.setAttribute('viewBox', '0 0 100 100');
  overlay.setAttribute('preserveAspectRatio', 'none');

  const ns = 'http://www.w3.org/2000/svg';
  for (const r of cache) {
    if (!Array.isArray(r.waypoints) || r.waypoints.length < 2) continue;
    const colour = colorForRoute(r);
    // pct → viewBox coords are 1:1 because viewBox is 0..100 and pct is 0..1.
    // We multiply by 100 to get into the viewBox space.
    const pts = r.waypoints.map(p => `${(p.x_pct*100).toFixed(2)},${(p.y_pct*100).toFixed(2)}`).join(' ');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', colour);
    line.setAttribute('stroke-opacity', '0.85');
    line.setAttribute('stroke-width', '0.6');
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    // vector-effect prevents the stroke from scaling weirdly when the
    // viewBox is non-uniform (preserveAspectRatio=none).
    line.setAttribute('vector-effect', 'non-scaling-stroke');
    line.style.strokeWidth = '3px';
    // Wire click → live grid on the operator-canvas variant only. The
    // parent SVG has pointer-events:none so empty space falls through
    // to the underlying canvas; setting pointer-events:stroke on the
    // line makes only the stroke catch clicks (not the bounding-box
    // negative space).
    if (opts.clickable) {
      line.style.pointerEvents = 'stroke';
      line.style.cursor = 'pointer';
      // Visual hint on hover — slightly bolder + brighter stroke.
      line.addEventListener('mouseenter', () => {
        line.style.strokeWidth = '5px';
        line.setAttribute('stroke-opacity', '1');
      });
      line.addEventListener('mouseleave', () => {
        line.style.strokeWidth = '3px';
        line.setAttribute('stroke-opacity', '0.85');
      });
      line.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openPathwayLiveGrid(r);
      });
      // Hover tooltip — operator sees the path name + camera count
      // before clicking.
      const title = document.createElementNS(ns, 'title');
      title.textContent =
        `${r.name} — ${(r.cameras || []).length} camera${(r.cameras || []).length === 1 ? '' : 's'} · click to open live grid`;
      line.appendChild(title);
    }
    overlay.appendChild(line);
    // Endpoint dots.
    for (const p of r.waypoints) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(p.x_pct * 100));
      c.setAttribute('cy', String(p.y_pct * 100));
      c.setAttribute('r', '0.8');
      c.setAttribute('fill', colour);
      c.setAttribute('stroke', '#0c0e13');
      c.setAttribute('stroke-width', '0.2');
      c.setAttribute('vector-effect', 'non-scaling-stroke');
      overlay.appendChild(c);
    }
    // Compact start label — small pill with the path colour as border.
    // Two SVG elements: a background rect sized to the text + the text
    // itself. We can't easily measure SVG text before render, so we use
    // a fixed-width estimate based on char count (works well for short
    // path names; long names truncate visually but the polyline still
    // tells the story).
    const truncated = r.name.length > 18 ? r.name.slice(0, 17) + '…' : r.name;
    const labelW = Math.min(24, truncated.length * 1.3 + 1.5);
    const labelH = 2.8;
    const lx = Math.min(100 - labelW - 0.5, r.waypoints[0].x_pct * 100 + 1.2);
    const ly = Math.max(labelH + 0.5, r.waypoints[0].y_pct * 100 - 0.5);
    const bg = document.createElementNS(ns, 'rect');
    bg.setAttribute('x', String(lx));
    bg.setAttribute('y', String(ly - labelH));
    bg.setAttribute('width', String(labelW));
    bg.setAttribute('height', String(labelH));
    bg.setAttribute('rx', '0.4');
    bg.setAttribute('fill', '#0c0e13');
    bg.setAttribute('fill-opacity', '0.78');
    bg.setAttribute('stroke', colour);
    bg.setAttribute('stroke-width', '0.18');
    // Make the label pill clickable on the operator canvas — wider
    // hit-target than the thin polyline stroke.
    if (opts.clickable) {
      bg.style.pointerEvents = 'all';
      bg.style.cursor = 'pointer';
      bg.addEventListener('click', (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
        openPathwayLiveGrid(r);
      });
      bg.addEventListener('mouseenter', () => {
        bg.setAttribute('fill-opacity', '0.95');
        bg.setAttribute('stroke-width', '0.35');
      });
      bg.addEventListener('mouseleave', () => {
        bg.setAttribute('fill-opacity', '0.78');
        bg.setAttribute('stroke-width', '0.18');
      });
      const t = document.createElementNS(ns, 'title');
      t.textContent =
        `${r.name} — ${(r.cameras || []).length} camera${(r.cameras || []).length === 1 ? '' : 's'} · click to open live grid`;
      bg.appendChild(t);
    }
    overlay.appendChild(bg);
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', String(lx + 0.8));
    txt.setAttribute('y', String(ly - 0.7));
    txt.setAttribute('fill', '#ECE6D6');
    txt.setAttribute('font-family', 'ui-monospace, monospace');
    txt.setAttribute('font-size', '1.7');
    txt.setAttribute('font-weight', '600');
    txt.style.pointerEvents = 'none';   // clicks fall through to the bg rect
    txt.textContent = truncated;
    overlay.appendChild(txt);
  }
}

// Public access to the currently-rendered routes for the live SCADA
// mimic (scada_mimic.js subscribes to motion events and needs to know
// which paths contain the firing camera). Returns a copy so callers
// can't mutate the cache out from under us.
export function currentRoutes() { return cache.slice(); }
export function currentFloorIdForMimic() { return lastFloorId; }

function start() {
  // Initial paint after a short delay so the SPA has time to put
  // SV.currentFloorId in place.
  setTimeout(refresh, 1000);
  // Polling interval: 4 s. Paint is cheap — string-diffed signature
  // skips the DOM churn when nothing changed.
  setInterval(refresh, 4000);
  // Repaint on window resize so the overlay tracks the new image rect.
  window.addEventListener('resize', () => {
    lastSig = '';   // force repaint
    paintAll();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

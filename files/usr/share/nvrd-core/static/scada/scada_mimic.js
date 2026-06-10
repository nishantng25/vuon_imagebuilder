// =============================================================================
// Live SCADA mimic — motion pulses traveling along pathways.
//
// When the device fires a motion event via SSE (publishMotion in
// nvrd-core's recorder.consumeMotion), we look up every pathway that
// contains that camera in its `cameras` list. For each match we spawn
// a "pulse": a bright animated dot anchored at the camera's position
// on the path, traveling along the polyline toward the end of the
// route over 1.5 s while fading out.
//
// Two of these can run simultaneously — one path can have N motion
// events at once (different cameras), and one camera can belong to
// N paths. Each pulse is independent.
//
// requestAnimationFrame loop runs only while pulses are active. When
// the queue drains, the loop stops — zero idle cost.
//
// Pulses render into the same SVG overlays pathway_renderer.js
// manages (#scada-paths-admin + #scada-paths-monitor). We add and
// remove pulse <circle> elements without touching the static path
// elements, so the polylines aren't redrawn 60 times a second.
// =============================================================================

import { on as sseOn } from './sse.js';
import { currentRoutes, currentFloorIdForMimic } from './pathway_renderer.js';

const PULSE_DURATION_MS = 1600;
const PULSE_TRAVEL_FRACTION = 0.55;  // pulse only travels this fraction of remaining path
const NS = 'http://www.w3.org/2000/svg';

let activePulses = [];
let rafId = null;
let pinCache = [];           // [{cam_slot, x_pct, y_pct}] for current floor
let pinCacheFloorId = null;

// ── Pin lookup ─────────────────────────────────────────────────────────
//
// Pin coords from camera_pins are 0-100 (legacy), waypoints are 0-1.
// We normalise to 0-1 here so all the geometry math uses one scale.
async function loadPins() {
  const fid = currentFloorIdForMimic();
  if (!fid) { pinCache = []; pinCacheFloorId = null; return; }
  if (fid === pinCacheFloorId && pinCache.length > 0) return;
  try {
    const got = await window.siteApi.get(`/api/site/pins?floor=${fid}`);
    pinCache = (Array.isArray(got) ? got : []).map(p => ({
      cam_slot: p.cam_slot,
      x_pct: Number(p.x_pct) / 100,
      y_pct: Number(p.y_pct) / 100,
    }));
    pinCacheFloorId = fid;
  } catch (e) {
    pinCache = [];
  }
}

function findPin(camSlot) {
  return pinCache.find(p => p.cam_slot === camSlot) || null;
}

// ── Polyline geometry ──────────────────────────────────────────────────
//
// Polyline parametric position: t in [0,1] maps to a point along the
// polyline by cumulative segment length. closestParameter returns the
// t value at which the polyline is closest to a given (x,y) point —
// used to compute "where on the path is the camera that fired?".

function polylineSegments(wp) {
  let segs = [], total = 0;
  for (let i = 1; i < wp.length; i++) {
    const dx = wp[i].x_pct - wp[i-1].x_pct;
    const dy = wp[i].y_pct - wp[i-1].y_pct;
    const len = Math.hypot(dx, dy);
    segs.push({ from: i-1, to: i, len, cum: total + len });
    total += len;
  }
  return { segs, total };
}

function parametricPoint(wp, t) {
  if (!Array.isArray(wp) || wp.length < 2) return null;
  if (t <= 0) return { x: wp[0].x_pct, y: wp[0].y_pct };
  if (t >= 1) return { x: wp[wp.length-1].x_pct, y: wp[wp.length-1].y_pct };
  const { segs, total } = polylineSegments(wp);
  if (total === 0) return null;
  const target = t * total;
  for (const seg of segs) {
    if (seg.cum >= target) {
      const localT = (seg.len - (seg.cum - target)) / seg.len;
      const a = wp[seg.from], b = wp[seg.to];
      return {
        x: a.x_pct + (b.x_pct - a.x_pct) * localT,
        y: a.y_pct + (b.y_pct - a.y_pct) * localT,
      };
    }
  }
  return null;
}

function closestParameter(wp, x, y) {
  if (!Array.isArray(wp) || wp.length < 2) return 0;
  const { segs, total } = polylineSegments(wp);
  if (total === 0) return 0;
  let best = { t: 0, dist: Infinity };
  for (const seg of segs) {
    const a = wp[seg.from], b = wp[seg.to];
    const dx = b.x_pct - a.x_pct;
    const dy = b.y_pct - a.y_pct;
    const segLenSq = dx*dx + dy*dy;
    if (segLenSq === 0) continue;
    let u = ((x - a.x_pct) * dx + (y - a.y_pct) * dy) / segLenSq;
    u = Math.max(0, Math.min(1, u));
    const projX = a.x_pct + u * dx;
    const projY = a.y_pct + u * dy;
    const dist = Math.hypot(x - projX, y - projY);
    if (dist < best.dist) {
      best.dist = dist;
      const distToHere = (seg.cum - seg.len) + u * seg.len;
      best.t = distToHere / total;
    }
  }
  return best.t;
}

// ── Motion event → pulses ─────────────────────────────────────────────
sseOn('motion', async (ev) => {
  if (!ev || !ev.start) return;            // only start events fire pulses
  if (!ev.camera_id) return;

  // Make sure pins are loaded for the current floor (cheap; cached).
  await loadPins();
  const pin = findPin(ev.camera_id);
  if (!pin) return;                         // camera not on this floor

  const routes = currentRoutes();
  for (const r of routes) {
    if (!Array.isArray(r.cameras) || !r.cameras.includes(ev.camera_id)) continue;
    if (!Array.isArray(r.waypoints) || r.waypoints.length < 2) continue;
    const t0 = closestParameter(r.waypoints, pin.x_pct, pin.y_pct);
    activePulses.push({
      routeId: r.id,
      polyline: r.waypoints,
      color: (typeof r.color === 'string' && r.color) ? r.color : '#5c8bf2',
      startT:  t0,
      endT:    Math.min(1, t0 + (1 - t0) * PULSE_TRAVEL_FRACTION),
      bornAt:  performance.now(),
      duration: PULSE_DURATION_MS,
    });
  }
  startRaf();
});

// Floor changes (or fresh login) invalidate the pin cache.
sseOn('_open', () => { pinCache = []; pinCacheFloorId = null; });

// ── Render loop ───────────────────────────────────────────────────────
function startRaf() {
  if (rafId) return;
  rafId = requestAnimationFrame(tick);
}

function tick(now) {
  rafId = null;
  // Drop expired pulses.
  activePulses = activePulses.filter(p => (now - p.bornAt) < p.duration);
  paintMimic(now);
  if (activePulses.length > 0) {
    rafId = requestAnimationFrame(tick);
  } else {
    // Final clear to remove any lingering elements.
    paintMimic(now);
  }
}

function paintMimic(now) {
  for (const overlayId of ['scada-paths-admin', 'scada-paths-monitor']) {
    const overlay = document.getElementById(overlayId);
    if (!overlay) continue;
    // Remove previous frame's pulses (cheap — small set).
    for (const el of overlay.querySelectorAll('.scada-mimic-pulse')) el.remove();

    for (const p of activePulses) {
      const age = (now - p.bornAt) / p.duration;     // 0..1
      if (age >= 1) continue;
      const t = p.startT + (p.endT - p.startT) * easeOutCubic(age);
      const pos = parametricPoint(p.polyline, t);
      if (!pos) continue;
      const x = (pos.x * 100).toFixed(2);
      const y = (pos.y * 100).toFixed(2);
      const fade = 1 - age;
      const colour = p.color;

      // Halo — soft expanding ring.
      const halo = document.createElementNS(NS, 'circle');
      halo.setAttribute('class', 'scada-mimic-pulse');
      halo.setAttribute('cx', x);
      halo.setAttribute('cy', y);
      halo.setAttribute('r',  String((1.6 + age * 3.2).toFixed(2)));
      halo.setAttribute('fill', 'none');
      halo.setAttribute('stroke', colour);
      halo.setAttribute('stroke-width', '0.6');
      halo.setAttribute('vector-effect', 'non-scaling-stroke');
      halo.setAttribute('opacity', String((fade * 0.6).toFixed(3)));
      halo.style.pointerEvents = 'none';
      overlay.appendChild(halo);

      // Inner bright dot — the "pulse head".
      const dot = document.createElementNS(NS, 'circle');
      dot.setAttribute('class', 'scada-mimic-pulse');
      dot.setAttribute('cx', x);
      dot.setAttribute('cy', y);
      dot.setAttribute('r',  String((1.0 + (1 - age) * 0.6).toFixed(2)));
      dot.setAttribute('fill', colour);
      dot.setAttribute('opacity', String((0.55 + fade * 0.45).toFixed(3)));
      dot.style.pointerEvents = 'none';
      overlay.appendChild(dot);
    }
  }
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

// triggerTestPulse fires a synthetic pulse on a given route without
// waiting for a real motion event. Used by the editor's "⚡ Test pulse"
// button so operators can verify the SCADA mimic + demonstrate it to
// stakeholders even when the site is quiet.
//
// Differs from real motion pulses in two ways:
//   - longer duration (2.4 s vs 1.6 s) — easier to spot
//   - travels the FULL remaining path instead of 55 % — clear flow
//
// The pulse anchors at the first assigned camera's pin (if any),
// falling back to the start of the polyline when the route has no
// cameras yet.
export async function triggerTestPulse(route) {
  if (!route || !Array.isArray(route.waypoints) || route.waypoints.length < 2) return;
  await loadPins();
  let startT = 0;
  if (Array.isArray(route.cameras) && route.cameras.length > 0) {
    const pin = findPin(route.cameras[0]);
    if (pin) startT = closestParameter(route.waypoints, pin.x_pct, pin.y_pct);
  }
  activePulses.push({
    routeId: route.id,
    polyline: route.waypoints,
    color: (typeof route.color === 'string' && route.color) ? route.color : '#5c8bf2',
    startT,
    endT: 1,
    bornAt: performance.now(),
    duration: 2400,
  });
  startRaf();
}

// =============================================================================
// fov_renderer.js — wall-aware FOV cones on admin + operator canvases.
//
// The full-screen editor (fullscreen_editor.js) already renders walls-
// clipped visibility polygons for every pin. The regular admin Place
// screen and operator Live / Coverage views, however, were still
// showing the MONOLITH's flat-triangle cones — which ignore walls and
// extend through partitions. Result: same camera looked different
// between the editor and the rest of the app.
//
// This module fixes that. It:
//   1. CSS-hides every monolith-rendered cone (`<polygon>` inside
//      `.sv-pin-svg`) by toggling `data-scada-walls-fov="1"` on body.
//   2. Mounts a page-level SVG overlay on both #sv-canvas-wrap (admin)
//      and #sv-monitor-canvas (operator).
//   3. For each pin on the current floor, computes the same FOV
//      polygon the editor + server use (visibility polygon when walls
//      are present, geometric trapezoid otherwise, flat cone fallback).
//   4. Repaints on a 3 s poll + on window resize (matches the
//      pathway_renderer cadence).
//
// Pin coords from the monolith come in 0–100 pct (legacy). All other
// polygons (areas, outline) are 0–1. We normalise pin coords on the
// way in. Output polygons are 0–1 then projected to viewBox 0..100
// for the SVG render.
// =============================================================================

const ADMIN_HOST_ID    = 'sv-canvas-wrap';
const ADMIN_IMG_ID     = 'sv-plan-img';
const MONITOR_HOST_ID  = 'sv-monitor-canvas';
const MONITOR_IMG_ID   = 'sv-mon-plan-img';

const VIS_RAYS = 48;

let lastFloorId = null;
let pinsCache   = [];
let roomsCache  = [];
let outlineCache = null;
let widthM = 0, heightM = 0;
let lastSig = '';
let inFlight = false;

function $(id) { return document.getElementById(id); }
function currentFloorId() {
  const sv = window.SV || {};
  return sv.currentFloorId || null;
}
function currentFloor() {
  const sv = window.SV || {};
  const id = sv.currentFloorId;
  if (!id) return null;
  return (sv.floors || []).find(f => f.id === id) || null;
}

// ── Geometry helpers (mirrors fullscreen_editor.js + Go server) ───────

function extractWalls(floor, rooms) {
  const walls = [];
  const add = (poly) => {
    if (!Array.isArray(poly) || poly.length < 2) return;
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      walls.push([[a.x_pct, a.y_pct], [b.x_pct, b.y_pct]]);
    }
  };
  if (floor && Array.isArray(floor.outline)) add(floor.outline);
  for (const r of (rooms || [])) add(r.polygon);
  return walls;
}

function raySegmentIntersect(origin, dx, dy, a, b) {
  const sx = b[0] - a[0];
  const sy = b[1] - a[1];
  const denom = dx * sy - dy * sx;
  if (Math.abs(denom) < 1e-12) return Infinity;
  const t = ((a[0] - origin[0]) * sy - (a[1] - origin[1]) * sx) / denom;
  const u = ((a[0] - origin[0]) * dy - (a[1] - origin[1]) * dx) / denom;
  if (t > 1e-6 && u >= -1e-9 && u <= 1 + 1e-9) return t;
  return Infinity;
}

function computeVisibilityPolygon(
  cameraPct, panDeg, hfovDeg, maxRangeM, walls, fwM, fhM,
) {
  if (!(maxRangeM > 0) || !(fwM > 0) || !(fhM > 0)) return null;
  const panRad = panDeg * Math.PI / 180;
  const halfH = hfovDeg / 2 * Math.PI / 180;
  const poly = [cameraPct];
  for (let i = 0; i <= VIS_RAYS; i++) {
    const localOff = -halfH + (2 * halfH) * (i / VIS_RAYS);
    const theta = panRad + localOff;
    const dx = Math.sin(theta) / fwM;
    const dy = -Math.cos(theta) / fhM;
    let nearestT = maxRangeM;
    for (const w of walls) {
      const t = raySegmentIntersect(cameraPct, dx, dy, w[0], w[1]);
      if (t < nearestT) nearestT = t;
    }
    poly.push([cameraPct[0] + nearestT * dx, cameraPct[1] + nearestT * dy]);
  }
  return poly;
}

function computeFOVFootprintPct(args) {
  const {
    xPct, yPct, rotationDeg, hfovDeg, rangeM,
    mountingHeightM, tiltDeg, vfovDeg, fwM, fhM,
  } = args;
  if (!(hfovDeg > 0) || !(rangeM > 0) || !(fwM > 0) || !(fhM > 0)) return null;
  const rot = rotationDeg * Math.PI / 180;
  const halfH = hfovDeg / 2 * Math.PI / 180;
  const useTrap = (mountingHeightM > 0 && tiltDeg > 0 && tiltDeg < 90 &&
                   vfovDeg > 0 && vfovDeg < 180);
  const fx = Math.sin(rot), fy = -Math.cos(rot);
  const rx = Math.cos(rot), ry = Math.sin(rot);
  const proj = (mx, my) => [xPct + mx / fwM, yPct + my / fhM];
  if (!useTrap) {
    const lDx = -Math.sin(halfH) * Math.cos(rot) - (-Math.cos(halfH)) * Math.sin(rot);
    const lDy = -Math.sin(halfH) * Math.sin(rot) + (-Math.cos(halfH)) * Math.cos(rot);
    const rDx =  Math.sin(halfH) * Math.cos(rot) - (-Math.cos(halfH)) * Math.sin(rot);
    const rDy =  Math.sin(halfH) * Math.sin(rot) + (-Math.cos(halfH)) * Math.cos(rot);
    return [
      [xPct, yPct],
      proj(lDx * rangeM, lDy * rangeM),
      proj(rDx * rangeM, rDy * rangeM),
    ];
  }
  const halfV = vfovDeg / 2 * Math.PI / 180;
  const tiltRad = tiltDeg * Math.PI / 180;
  const farAngle = tiltRad - halfV;
  const nearAngle = tiltRad + halfV;
  let dFar, dNear;
  if (farAngle <= 1e-3)              dFar = rangeM;
  else if (farAngle >= Math.PI / 2)  dFar = 0;
  else                                dFar = Math.min(mountingHeightM / Math.tan(farAngle), rangeM);
  if (nearAngle >= Math.PI / 2 - 1e-3) dNear = 0;
  else if (nearAngle <= 0)             dNear = rangeM;
  else                                  dNear = mountingHeightM / Math.tan(nearAngle);
  const wFar  = dFar  * Math.tan(halfH);
  const wNear = dNear * Math.tan(halfH);
  return [
    proj(dNear * fx - wNear * rx, dNear * fy - wNear * ry),
    proj(dFar  * fx - wFar  * rx, dFar  * fy - wFar  * ry),
    proj(dFar  * fx + wFar  * rx, dFar  * fy + wFar  * ry),
    proj(dNear * fx + wNear * rx, dNear * fy + wNear * ry),
  ];
}

// ── Data fetch ────────────────────────────────────────────────────────

async function refresh() {
  if (inFlight) return;
  const f = currentFloor();
  if (!f) return;
  const fid = f.id;
  if (fid !== lastFloorId) {
    pinsCache = [];
    roomsCache = [];
    outlineCache = null;
    lastFloorId = fid;
    lastSig = '';
  }
  inFlight = true;
  try {
    // Pins: prefer the monolith cache (already loaded), fall back to API.
    const sv = window.SV || {};
    const cached = sv.pinsByFloor && sv.pinsByFloor[fid];
    if (Array.isArray(cached) && cached.length > 0) {
      pinsCache = cached.slice();
    } else {
      pinsCache = await window.siteApi.get(`/api/site/pins?floor=${fid}`)
        .catch(() => []);
      if (!Array.isArray(pinsCache)) pinsCache = [];
    }
    // Areas (rooms) for wall extraction.
    roomsCache = await window.siteApi.get(`/api/site/floors/${fid}/rooms`)
      .catch(() => []);
    if (!Array.isArray(roomsCache)) roomsCache = [];
    outlineCache = (f.outline && Array.isArray(f.outline)) ? f.outline : null;
    widthM  = (typeof f.width_m  === 'number') ? f.width_m  : 0;
    heightM = (typeof f.height_m === 'number') ? f.height_m : 0;
  } catch (_) { /* ignore */ }
  finally { inFlight = false; }
  paintAll();
}

function buildSig() {
  // Signature drives a paint-skip when nothing's changed.
  return JSON.stringify({
    f: lastFloorId,
    w: widthM, h: heightM,
    ol: outlineCache ? outlineCache.length : 0,
    rm: roomsCache.length,
    p: pinsCache.map(p => [
      p.cam_slot,
      p.x_pct, p.y_pct, p.rotation_deg,
      p.fov_angle_deg, p.fov_range_m,
      p.mounting_height_m || 0,
      p.tilt_deg || 0,
      p.vertical_fov_deg || 0,
    ]),
  });
}

function paintAll() {
  const sig = buildSig();
  if (sig === lastSig) return;
  lastSig = sig;
  paintInto(ADMIN_HOST_ID,   ADMIN_IMG_ID,   'scada-fov-admin',   5);
  paintInto(MONITOR_HOST_ID, MONITOR_IMG_ID, 'scada-fov-monitor', 7);
}

function paintInto(hostId, imgId, overlayId, zIndex) {
  const host = $(hostId);
  if (!host) return;
  const img  = $(imgId);
  if (!img || !img.naturalWidth) {
    const stale = $(overlayId);
    if (stale) stale.remove();
    return;
  }
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  let overlay = $(overlayId);
  if (!overlay) {
    overlay = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    overlay.id = overlayId;
    Object.assign(overlay.style, {
      position: 'absolute', inset: '0', pointerEvents: 'none',
      zIndex: String(zIndex),
    });
    host.appendChild(overlay);
  }
  overlay.innerHTML = '';
  if (pinsCache.length === 0) return;

  // Align overlay to the IMG's bounding rect — exactly like
  // pathway_renderer does — so visibility polygons line up with
  // pin positions regardless of how the image is positioned.
  const rect = img.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const offX = rect.left - hostRect.left;
  const offY = rect.top  - hostRect.top;
  Object.assign(overlay.style, {
    left: offX + 'px', top: offY + 'px',
    width: rect.width + 'px', height: rect.height + 'px',
    inset: 'auto',
  });
  overlay.setAttribute('viewBox', '0 0 100 100');
  overlay.setAttribute('preserveAspectRatio', 'none');

  const walls = extractWalls({ outline: outlineCache }, roomsCache);
  const ns = 'http://www.w3.org/2000/svg';

  for (const p of pinsCache) {
    // Pin coords are 0..100 in the legacy schema; normalise to 0..1.
    const xPct = Number(p.x_pct) / 100;
    const yPct = Number(p.y_pct) / 100;
    if (!isFinite(xPct) || !isFinite(yPct) || xPct < 0 || xPct > 1 || yPct < 0 || yPct > 1) continue;

    let polyPct = null;
    let usedVisibility = false;
    const accurate3D = (p.mounting_height_m > 0 && p.tilt_deg > 0 && p.vertical_fov_deg > 0);

    if (walls.length > 0 && widthM > 0 && heightM > 0) {
      let effRange = p.fov_range_m || 12;
      if (accurate3D) {
        const halfV = (p.vertical_fov_deg / 2) * Math.PI / 180;
        const tiltRad = p.tilt_deg * Math.PI / 180;
        const farAngle = tiltRad - halfV;
        if (farAngle > 1e-3 && farAngle < Math.PI / 2) {
          const geomFar = p.mounting_height_m / Math.tan(farAngle);
          if (geomFar < effRange) effRange = geomFar;
        }
      }
      polyPct = computeVisibilityPolygon(
        [xPct, yPct], p.rotation_deg || 0, p.fov_angle_deg || 90,
        effRange, walls, widthM, heightM);
      usedVisibility = true;
    } else {
      polyPct = computeFOVFootprintPct({
        xPct, yPct,
        rotationDeg: p.rotation_deg || 0,
        hfovDeg: p.fov_angle_deg || 90,
        rangeM:  p.fov_range_m || 12,
        mountingHeightM: p.mounting_height_m || 0,
        tiltDeg:         p.tilt_deg || 0,
        vfovDeg:         p.vertical_fov_deg || 0,
        fwM: widthM, fhM: heightM,
      });
    }
    if (!polyPct || polyPct.length < 3) continue;

    // pct 0..1 → viewBox 0..100.
    const points = polyPct.map(pt =>
      `${(pt[0] * 100).toFixed(2)},${(pt[1] * 100).toFixed(2)}`).join(' ');
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', points);
    // Three visual modes, matching the editor's amber palette but
    // dimmer so the canvas underneath stays legible:
    //   visibility (walls-clipped) — brightest
    //   trapezoid (3D mount, no walls) — bright
    //   flat triangle (legacy) — faintest
    let fill, stroke, sw;
    if (usedVisibility) {
      fill = 'rgba(245,158,11,0.16)';
      stroke = 'rgba(245,158,11,0.55)';
      sw = '0.3';
    } else if (accurate3D) {
      fill = 'rgba(245,158,11,0.14)';
      stroke = 'rgba(245,158,11,0.45)';
      sw = '0.25';
    } else {
      fill = 'rgba(245,158,11,0.06)';
      stroke = 'rgba(245,158,11,0.25)';
      sw = '0.2';
    }
    poly.setAttribute('fill',   fill);
    poly.setAttribute('stroke', stroke);
    poly.setAttribute('stroke-width', sw);
    poly.setAttribute('vector-effect', 'non-scaling-stroke');
    overlay.appendChild(poly);
  }
}

// ── Lifecycle ────────────────────────────────────────────────────────

function start() {
  // Toggle the body flag that gates the CSS hiding the monolith's
  // flat-triangle cones. Set before first refresh so the operator
  // doesn't see both versions overlapping for a split second.
  document.body.dataset.scadaWallsFov = '1';

  setTimeout(refresh, 1200);
  setInterval(refresh, 3000);
  window.addEventListener('resize', () => { lastSig = ''; paintAll(); });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

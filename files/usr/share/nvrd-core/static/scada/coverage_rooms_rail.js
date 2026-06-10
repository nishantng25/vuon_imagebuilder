// =============================================================================
// Coverage rail per-room list.
//
// The existing Coverage Audit rail shows global KPIs (Cameras, Coverage %,
// Redundant %, Blind %) and a list of camera rows. Once rooms are defined,
// we add a "Rooms" section under those KPIs showing per-room coverage %,
// area, and a click-to-highlight on the plan.
//
// The data comes from the coverage handler's response.rooms[] block (added
// server-side in v1.2). No extra roundtrips — we piggy-back on the
// existing fetch via a polling read of SV.coverage which the monolith
// already populates.
// =============================================================================

import * as units from './units.js';
import { getCachedRooms } from './room_editor.js';

const RAIL_ANCHOR_ID = 'sv-cov-blind-list';   // we mount before this section
const CANVAS_ID      = 'sv-monitor-canvas';
const PLAN_IMG_ID    = 'sv-mon-plan-img';
const SECTION_ID     = 'scada-room-cov-section';
const HIGHLIGHT_ID   = 'scada-room-highlight';

let lastSignature = '';

function $(id) { return document.getElementById(id); }

function mountSection() {
  if ($(SECTION_ID)) return $(SECTION_ID);
  const anchor = $(RAIL_ANCHOR_ID);
  if (!anchor) return null;
  const section = document.createElement('div');
  section.id = SECTION_ID;
  section.innerHTML = `
    <div class="sv-rail-label" style="margin-top:14px">Areas</div>
    <div id="scada-room-list" style="font-size:12px;color:var(--t2)">
      <div class="sv-empty-line">No areas defined — outline rooms and outdoor spaces in admin mode.</div>
    </div>
    <div class="sv-rail-label" style="margin-top:18px">Pathways</div>
    <div id="scada-route-list" style="font-size:12px;color:var(--t2)">
      <div class="sv-empty-line">No pathways drawn — author in the full-screen editor.</div>
    </div>
  `;
  anchor.parentNode.insertBefore(section, anchor);
  return section;
}

function renderRooms() {
  const data = (window.SV && window.SV.coverage) || null;
  if (!data) return;
  const section = mountSection();
  if (!section) return;
  const list = $('scada-room-list');
  if (!list) return;
  const rooms = Array.isArray(data.rooms) ? data.rooms : [];

  // Cheap signature so we skip the innerHTML churn (and any associated
  // layout cost) when nothing material changed since last tick. Includes
  // cached dim fingerprint so the rail repaints when the operator saves
  // new measurements.
  const cached = getCachedRooms();
  const routesData = Array.isArray(data.routes) ? data.routes : [];
  const sig = JSON.stringify({
    u: units.getUnit(),
    r: rooms.map(r => [r.id, r.name, Math.round(r.covered_pct*10), Math.round(r.area_m2)]),
    d: cached.map(d => [d.id, d.length_m || 0, d.width_m || 0, d.height_m || 0]),
    rt: routesData.map(r => [r.id, r.name, Math.round((r.covered_pct||0)*10), Math.round(r.length_m||0)]),
  });
  if (sig === lastSignature) return;
  lastSignature = sig;

  if (rooms.length === 0) {
    list.innerHTML = '<div class="sv-empty-line">No areas defined — outline rooms and outdoor spaces in admin mode.</div>';
    return;
  }

  // Merge in measured dimensions from the room cache. The coverage
  // response carries stats only; the dim values come from the room
  // CRUD endpoint that room_editor.js already loaded for us.
  const dimById = {};
  for (const r of getCachedRooms()) dimById[r.id] = r;

  // Sort worst-coverage first so blind regions surface immediately.
  const sorted = rooms.slice().sort((a, b) => a.covered_pct - b.covered_pct);
  list.innerHTML = sorted.map(r => {
    const polyArea = units.formatAreaFromMeters2(r.area_m2);
    const covPct = r.covered_pct.toFixed(0);
    const colour = r.covered_pct >= 90 ? '#86c26f'
                  : r.covered_pct >= 60 ? '#f59e0b' : '#d95a50';
    const dim = dimById[r.id] || {};
    // Measured floor area if L and W both present.
    let secondLine = polyArea;
    if (typeof dim.length_m === 'number' && typeof dim.width_m === 'number') {
      const measured = dim.length_m * dim.width_m;
      const dPct = r.area_m2 > 0 ? Math.abs(measured - r.area_m2) / r.area_m2 * 100 : 0;
      const tag = dPct > 15 ? '⚠' : '';
      secondLine = `<span title="Polygon: ${polyArea}">${units.formatAreaFromMeters2(measured)} measured ${tag}</span>`;
    }
    let thirdLine = '';
    if (typeof dim.length_m === 'number' && typeof dim.width_m === 'number' &&
        typeof dim.height_m === 'number') {
      const vol = dim.length_m * dim.width_m * dim.height_m;
      thirdLine = `<div style="font-family:var(--mono);font-size:10px;color:#5c8bf2;margin-top:2px;">${vol.toFixed(1)} m³</div>`;
    }
    return `
      <div class="scada-room-row"
           data-room-id="${r.id}"
           style="display:flex;align-items:center;gap:8px;padding:6px 8px;
                  border:1px solid var(--bdr);background:var(--bg2);
                  border-radius:4px;margin-bottom:6px;cursor:pointer;">
        <div style="flex:1;min-width:0;">
          <div style="color:var(--t1);font-weight:600;font-size:12px;
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(r.name)}</div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--t3);margin-top:2px;">
            ${secondLine}
          </div>
          ${thirdLine}
        </div>
        <div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${colour};">
          ${covPct}<b style="font-size:9px;font-weight:400;">%</b>
        </div>
      </div>`;
  }).join('');

  // Click → highlight room polygon on the operator canvas.
  for (const row of list.querySelectorAll('.scada-room-row')) {
    row.addEventListener('click', () => {
      const id = parseInt(row.dataset.roomId, 10);
      const room = (data.rooms || []).find(r => r.id === id);
      if (room) highlightRoom(room);
    });
  }
  // Per-pathway coverage list — same colour-code rules as areas.
  renderRoutes(data);
}

function renderRoutes(data) {
  const list = $('scada-route-list');
  if (!list) return;
  const routes = Array.isArray(data.routes) ? data.routes : [];
  if (routes.length === 0) {
    list.innerHTML = '<div class="sv-empty-line">No pathways drawn — author in the full-screen editor.</div>';
    return;
  }
  // Worst-coverage first so blind routes surface immediately.
  const sorted = routes.slice().sort((a, b) => a.covered_pct - b.covered_pct);
  list.innerHTML = sorted.map(r => {
    const covPct = (r.covered_pct || 0).toFixed(0);
    const colour = r.covered_pct >= 90 ? '#86c26f'
                  : r.covered_pct >= 60 ? '#f59e0b' : '#d95a50';
    const pathColour = (typeof r.color === 'string' && r.color) ? r.color : '#5c8bf2';
    const lengthLine = (typeof r.length_m === 'number' && r.length_m > 0)
      ? units.formatFromMeters(r.length_m)
      : `${r.samples || 0} samples`;
    return `
      <div class="scada-route-row"
           data-route-id="${r.id}"
           style="display:flex;align-items:center;gap:8px;padding:6px 8px;
                  border:1px solid var(--bdr);background:var(--bg2);
                  border-radius:4px;margin-bottom:6px;cursor:pointer;">
        <div style="width:4px;align-self:stretch;background:${pathColour};border-radius:2px;"></div>
        <div style="flex:1;min-width:0;">
          <div style="color:var(--t1);font-weight:600;font-size:12px;
                      overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(r.name)}</div>
          <div style="font-family:var(--mono);font-size:10px;color:var(--t3);margin-top:2px;">
            ${lengthLine}
          </div>
        </div>
        <div style="font-family:var(--mono);font-size:12px;font-weight:700;color:${colour};">
          ${covPct}<b style="font-size:9px;font-weight:400;">%</b>
        </div>
      </div>`;
  }).join('');
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[m]);
}

// ── Highlight on the operator canvas ───────────────────────────────────
//
// The room geometry isn't carried in coverage.rooms[] (only stats), so we
// fetch the polygon once via /api/site/floors/{id}/rooms and cache it
// per-room id. Cheap — operator clicks happen at human pace.

const polyCache = new Map();   // roomId → [{x_pct, y_pct}]

async function fetchPolygon(roomId) {
  if (polyCache.has(roomId)) return polyCache.get(roomId);
  const sv = window.SV || {};
  if (!sv.currentFloorId) return null;
  try {
    const rooms = await window.siteApi.get(`/api/site/floors/${sv.currentFloorId}/rooms`);
    for (const r of (Array.isArray(rooms) ? rooms : [])) {
      polyCache.set(r.id, r.polygon);
    }
    return polyCache.get(roomId) || null;
  } catch (e) {
    console.warn('[scada-room-cov] poly fetch failed', e);
    return null;
  }
}

async function highlightRoom(room) {
  const canvas = $(CANVAS_ID);
  const img    = $(PLAN_IMG_ID);
  if (!canvas || !img || !img.naturalWidth) return;
  const poly = await fetchPolygon(room.id);
  if (!Array.isArray(poly) || poly.length < 3) return;

  // Remove any prior highlight.
  const prior = $(HIGHLIGHT_ID);
  if (prior) prior.remove();

  const rect = img.getBoundingClientRect();
  const cRect = canvas.getBoundingClientRect();
  const offX = rect.left - cRect.left;
  const offY = rect.top - cRect.top;
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.id = HIGHLIGHT_ID;
  Object.assign(svg.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none',
    width: '100%', height: '100%', zIndex: 23,
  });
  const pts = poly.map(p => {
    const x = offX + p.x_pct * rect.width;
    const y = offY + p.y_pct * rect.height;
    return x.toFixed(1) + ',' + y.toFixed(1);
  }).join(' ');
  const polyEl = document.createElementNS(ns, 'polygon');
  polyEl.setAttribute('points', pts);
  polyEl.setAttribute('fill', 'rgba(245,158,11,0.20)');
  polyEl.setAttribute('stroke', '#f59e0b');
  polyEl.setAttribute('stroke-width', '3');
  // Subtle pulse via SMIL — runs once even if the browser is busy.
  const anim = document.createElementNS(ns, 'animate');
  anim.setAttribute('attributeName', 'opacity');
  anim.setAttribute('values', '1;0.5;1;0.5;1');
  anim.setAttribute('dur', '1.2s');
  anim.setAttribute('repeatCount', '2');
  polyEl.appendChild(anim);
  svg.appendChild(polyEl);
  canvas.appendChild(svg);

  // Auto-clear after a couple of seconds so the heatmap remains the
  // primary visual.
  setTimeout(() => {
    const el = $(HIGHLIGHT_ID);
    if (el) el.remove();
  }, 3500);
}

// ── Tick + unit reactivity ─────────────────────────────────────────────
function tick() { renderRooms(); }
setInterval(tick, 1500);
units.onUnitChange(() => { lastSignature = ''; renderRooms(); });

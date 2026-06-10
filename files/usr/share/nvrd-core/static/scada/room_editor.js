// =============================================================================
// Room editor — let the operator outline each room as a polygon. Once
// drawn, the server computes per-room coverage stats (area, % covered,
// % blind) in the existing coverage handler. Rooms surface in the
// Coverage rail as a clickable list that highlights the matching
// polygon on the plan.
//
// UX:
//   - "🏠 Rooms" toggle button in the calibration bar puts the canvas
//     in edit mode. While editing, every existing room is drawn as a
//     soft amber outline (non-interactive).
//   - In add mode: click adds a vertex; double-click (or Enter) closes
//     the polygon and pops a name prompt. Esc cancels.
//   - Click an existing room → select; selected polygon turns brighter,
//     small toolbar appears (Rename, Delete, Done).
//
// All draw state lives in this module; ZERO modifications to the
// monolith. We attach a capture-phase click listener on #sv-canvas-wrap
// (same host calibration uses) and early-return when not in edit mode
// so existing pin drag/drop is unaffected.
// =============================================================================

import * as units from './units.js';

const ADMIN_HOST_ID = 'sv-canvas-wrap';
const PLAN_IMG_ID   = 'sv-plan-img';

let mode = 'off';        // 'off' | 'idle' | 'drawing' | 'drawing-rect' | 'selected'
let currentPoly = [];    // [{x_pct, y_pct}, ...]
let rectAnchor = null;   // {x_pct, y_pct} — pointerdown corner in drawing-rect
let rectCurrent = null;  // {x_pct, y_pct} — live opposite corner
let rooms = [];          // server cache: [{id, name, polygon}]
let selectedId = null;
let overlay = null;
let bannerEl = null;
let roomsBtnEl = null;
let toolbarEl = null;
let host = null;

function $(id) { return document.getElementById(id); }

function currentFloor() {
  const sv = window.SV || {};
  const id = sv.currentFloorId;
  if (!id) return null;
  return (sv.floors || []).find(f => f.id === id) || null;
}

// ── Server I/O ─────────────────────────────────────────────────────────
async function loadRooms() {
  const f = currentFloor();
  if (!f) { rooms = []; return; }
  try {
    rooms = await window.siteApi.get(`/api/site/floors/${f.id}/rooms`);
    if (!Array.isArray(rooms)) rooms = [];
  } catch (e) {
    console.warn('[scada-rooms] load failed', e);
    rooms = [];
  }
  redraw();
}

async function createRoom(name, polygon) {
  const f = currentFloor();
  if (!f) return null;
  // Auto-derive L × W from the polygon's axis-aligned bbox × the
  // floor's calibrated extent. Works perfectly for rectangular rooms;
  // overestimates by ~10-20% for rotated or L-shaped rooms (the bbox
  // is the smallest rectangle CONTAINING the polygon). The operator
  // can override later via the Dimensions modal — explicit values
  // there always win. Height stays NULL (no way to derive from 2D).
  const body = { name, polygon };
  if (typeof f.width_m === 'number' && typeof f.height_m === 'number') {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of polygon) {
      if (p.x_pct < minX) minX = p.x_pct;
      if (p.x_pct > maxX) maxX = p.x_pct;
      if (p.y_pct < minY) minY = p.y_pct;
      if (p.y_pct > maxY) maxY = p.y_pct;
    }
    const dimL = (maxX - minX) * f.width_m;
    const dimW = (maxY - minY) * f.height_m;
    if (dimL > 0) body.length_m = Math.round(dimL * 100) / 100;
    if (dimW > 0) body.width_m  = Math.round(dimW * 100) / 100;
  }
  try {
    return await window.siteApi.post(
      `/api/site/floors/${f.id}/rooms`, body);
  } catch (e) {
    if (window.toast) window.toast('Area create failed: ' + e.message, 'err');
    return null;
  }
}

async function updateRoom(id, patch) {
  try {
    return await window.siteApi.put(`/api/site/rooms/${id}`, patch);
  } catch (e) {
    if (window.toast) window.toast('Room update failed: ' + e.message, 'err');
    return null;
  }
}

async function deleteRoom(id) {
  try {
    await window.siteApi.del(`/api/site/rooms/${id}`);
    return true;
  } catch (e) {
    if (window.toast) window.toast('Room delete failed: ' + e.message, 'err');
    return false;
  }
}

// ── Overlay drawing ────────────────────────────────────────────────────
function ensureOverlay() {
  if (overlay) return overlay;
  const ns = 'http://www.w3.org/2000/svg';
  overlay = document.createElementNS(ns, 'svg');
  Object.assign(overlay.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none',
    width: '100%', height: '100%', zIndex: 8,
  });
  overlay.setAttribute('class', 'scada-rooms-overlay');
  host.appendChild(overlay);
  return overlay;
}

function projector() {
  const img = $(PLAN_IMG_ID);
  if (!img || !img.naturalWidth) return null;
  const rect = img.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  const offX = rect.left - hostRect.left;
  const offY = rect.top - hostRect.top;
  return (xPct, yPct) => ({
    x: offX + xPct * rect.width,
    y: offY + yPct * rect.height,
  });
}

function redraw() {
  if (!overlay) return;
  overlay.innerHTML = '';
  const p = projector();
  if (!p) return;
  const ns = 'http://www.w3.org/2000/svg';

  // Existing rooms (only render when in editor mode — Coverage mode has
  // its own rendering path through the rail list).
  if (mode !== 'off') {
    for (const r of rooms) {
      if (!Array.isArray(r.polygon) || r.polygon.length < 3) continue;
      const isSel = (r.id === selectedId);
      const poly = document.createElementNS(ns, 'polygon');
      const pts = r.polygon.map(pt => {
        const xy = p(pt.x_pct, pt.y_pct);
        return xy.x.toFixed(1) + ',' + xy.y.toFixed(1);
      }).join(' ');
      poly.setAttribute('points', pts);
      poly.setAttribute('fill', isSel ? 'rgba(245,158,11,0.30)' : 'rgba(245,158,11,0.12)');
      poly.setAttribute('stroke', '#f59e0b');
      poly.setAttribute('stroke-width', isSel ? '2.5' : '1.5');
      poly.style.pointerEvents = 'all';
      poly.style.cursor = 'pointer';
      poly.addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedId = r.id;
        mode = 'selected';
        showBanner(`Selected: ${r.name}`);
        renderToolbar();
        redraw();
      });
      overlay.appendChild(poly);

      // Label at centroid.
      const cx = r.polygon.reduce((a, q) => a + q.x_pct, 0) / r.polygon.length;
      const cy = r.polygon.reduce((a, q) => a + q.y_pct, 0) / r.polygon.length;
      const xy = p(cx, cy);
      const txt = document.createElementNS(ns, 'text');
      txt.setAttribute('x', xy.x); txt.setAttribute('y', xy.y);
      txt.setAttribute('text-anchor', 'middle');
      txt.setAttribute('dominant-baseline', 'middle');
      txt.setAttribute('fill', '#ECE6D6');
      txt.setAttribute('font-family', 'ui-monospace, monospace');
      txt.setAttribute('font-size', '12');
      txt.setAttribute('font-weight', '700');
      txt.style.pointerEvents = 'none';
      txt.style.textShadow = '0 0 4px #0c0e13';
      txt.textContent = r.name;
      overlay.appendChild(txt);
    }
  }

  // Rectangle drag preview.
  if (mode === 'drawing-rect' && rectAnchor && rectCurrent) {
    const a = p(rectAnchor.x_pct,  rectAnchor.y_pct);
    const b = p(rectCurrent.x_pct, rectCurrent.y_pct);
    const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', x); rect.setAttribute('y', y);
    rect.setAttribute('width', w); rect.setAttribute('height', h);
    rect.setAttribute('fill', 'rgba(134,194,111,0.18)');
    rect.setAttribute('stroke', '#86c26f');
    rect.setAttribute('stroke-width', '2.5');
    rect.setAttribute('stroke-dasharray', '6 4');
    overlay.appendChild(rect);
    // Corner markers + live dimensions tag.
    for (const pt of [{x: a.x, y: a.y}, {x: b.x, y: b.y}]) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
      c.setAttribute('r', '5');
      c.setAttribute('fill', '#86c26f');
      c.setAttribute('stroke', '#0c0e13');
      c.setAttribute('stroke-width', '2');
      overlay.appendChild(c);
    }
  }

  // Polygon-in-progress.
  if (mode === 'drawing' && currentPoly.length > 0) {
    const pts = currentPoly.map(pt => {
      const xy = p(pt.x_pct, pt.y_pct);
      return xy.x.toFixed(1) + ',' + xy.y.toFixed(1);
    });
    if (currentPoly.length >= 2) {
      const line = document.createElementNS(ns, 'polyline');
      line.setAttribute('points', pts.join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', '#86c26f');
      line.setAttribute('stroke-width', '2.5');
      line.setAttribute('stroke-dasharray', '6 4');
      overlay.appendChild(line);
    }
    for (const pt of currentPoly) {
      const xy = p(pt.x_pct, pt.y_pct);
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', xy.x); c.setAttribute('cy', xy.y);
      c.setAttribute('r', '5');
      c.setAttribute('fill', '#86c26f');
      c.setAttribute('stroke', '#0c0e13');
      c.setAttribute('stroke-width', '2');
      overlay.appendChild(c);
    }
  }
}

// ── Banner + toolbar ────────────────────────────────────────────────────
function showBanner(text) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    Object.assign(bannerEl.style, {
      position: 'fixed', top: '60px', left: '50%',
      transform: 'translateX(-50%)',
      background: '#86c26f', color: '#0c0e13',
      padding: '8px 16px', borderRadius: '4px',
      fontFamily: 'ui-monospace, monospace', fontSize: '13px',
      fontWeight: '700', zIndex: 9998,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    });
    document.body.appendChild(bannerEl);
  }
  bannerEl.textContent = text;
  bannerEl.style.display = 'block';
}

function hideBanner() {
  if (bannerEl) bannerEl.style.display = 'none';
}

function renderToolbar() {
  if (toolbarEl) toolbarEl.remove();
  toolbarEl = null;
  if (mode === 'off') return;
  const f = currentFloor();
  if (!f) return;
  toolbarEl = document.createElement('div');
  Object.assign(toolbarEl.style, {
    position: 'absolute', top: '40px', left: '12px',
    display: 'flex', gap: '6px', alignItems: 'center',
    fontFamily: 'ui-monospace, monospace', fontSize: '11px',
    background: 'rgba(20,22,26,0.92)', color: '#ECE6D6',
    padding: '5px 8px', borderRadius: '4px',
    border: '1px solid rgba(255,255,255,0.08)',
    zIndex: 11,
  });
  const mkBtn = (label, bg, fg, onClick) => {
    const b = document.createElement('button');
    b.textContent = label;
    Object.assign(b.style, {
      cursor: 'pointer', background: bg, color: fg,
      border: 'none', padding: '3px 8px', borderRadius: '3px',
      fontFamily: 'inherit', fontSize: '11px', fontWeight: '700',
    });
    b.onclick = onClick;
    return b;
  };
  if (mode === 'idle') {
    toolbarEl.appendChild(document.createTextNode('Areas mode · '));
    toolbarEl.appendChild(mkBtn('+ Polygon', '#86c26f', '#0c0e13', () => {
      startDrawing();
    }));
    toolbarEl.appendChild(mkBtn('+ Rectangle', '#86c26f', '#0c0e13', () => {
      startDrawingRect();
    }));
    toolbarEl.appendChild(mkBtn('Done', '#3c3f47', '#ECE6D6', () => {
      exitEditor();
    }));
  } else if (mode === 'drawing') {
    toolbarEl.appendChild(document.createTextNode(
      `Polygon · ${currentPoly.length} pts · double-click or Enter to close · Esc to cancel`));
  } else if (mode === 'drawing-rect') {
    toolbarEl.appendChild(document.createTextNode(
      'Rectangle · press and drag across the room · release to finish · Esc to cancel'));
  } else if (mode === 'selected') {
    const sel = rooms.find(r => r.id === selectedId);
    if (sel) {
      toolbarEl.appendChild(document.createTextNode(`Selected: ${sel.name} · `));
      toolbarEl.appendChild(mkBtn('Rename', '#5c8bf2', '#fff', async () => {
        const next = prompt('Rename room', sel.name);
        if (!next) return;
        const saved = await updateRoom(sel.id, { name: next.trim() });
        if (saved) { Object.assign(sel, saved); renderToolbar(); redraw(); }
      }));
      toolbarEl.appendChild(mkBtn('Dimensions', '#86c26f', '#0c0e13', () => {
        openDimensionsModal(sel);
      }));
      toolbarEl.appendChild(mkBtn('Delete', '#d95a50', '#fff', async () => {
        if (!confirm(`Delete room "${sel.name}"?`)) return;
        if (await deleteRoom(sel.id)) {
          rooms = rooms.filter(r => r.id !== sel.id);
          selectedId = null;
          mode = 'idle';
          renderToolbar();
          redraw();
          showBanner('Room deleted');
        }
      }));
    }
    toolbarEl.appendChild(mkBtn('Done', '#3c3f47', '#ECE6D6', () => {
      selectedId = null; mode = 'idle'; renderToolbar(); redraw();
      showBanner('Click an existing room to edit, or "+ New room" to add one.');
    }));
  }
  host.appendChild(toolbarEl);
}

// ── Dimensions modal ──────────────────────────────────────────────────
//
// Operator types floor length, width, and ceiling height — any subset
// is fine, blank fields stay null. We compute floor-area (L × W) and
// volume (L × W × H) on the fly. Polygon-derived area is shown for
// comparison so the operator can sanity-check their measurements.
//
// Server stores SI; UI is in the user's preferred unit. parseToMeters
// is lenient ("18 ft 6 in", "5.5 m", "18", etc.).

function polygonAreaM2(polygon) {
  // Shoelace formula in pct² space. We then scale by the floor's
  // calibrated extent to get true m². Returns 0 when uncalibrated.
  if (!Array.isArray(polygon) || polygon.length < 3) return 0;
  const f = currentFloor();
  if (!f || typeof f.width_m !== 'number' || typeof f.height_m !== 'number') return 0;
  let s = 0;
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i];
    const b = polygon[(i + 1) % polygon.length];
    s += (a.x_pct * b.y_pct) - (b.x_pct * a.y_pct);
  }
  // |s| / 2 is the pct² area; multiply by floor's true area to get m².
  return Math.abs(s) * 0.5 * f.width_m * f.height_m;
}

let dimsModalEl = null;
function openDimensionsModal(room) {
  if (dimsModalEl) dimsModalEl.remove();
  const u = units.getUnit();
  const valueOf = (m) => (typeof m === 'number' && m > 0) ? units.formatFromMeters(m) : '';

  dimsModalEl = document.createElement('div');
  Object.assign(dimsModalEl.style, {
    position: 'fixed', inset: '0',
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10000,
  });
  dimsModalEl.innerHTML = `
    <div style="background:#1a1d22;border:1px solid #3c3f47;border-radius:6px;
                padding:20px;width:420px;font-family:ui-monospace,monospace;color:#ECE6D6;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:14px;font-weight:700;">${escapeHTML(room.name)} — dimensions</div>
        <div id="scada-dims-unit-host"></div>
      </div>
      <div style="font-size:11px;color:#888a95;margin-bottom:14px;">
        Type the measurements you know — any subset. We compute the
        derived floor area + volume for you. Leave any field blank to
        keep using the polygon-derived area only.
      </div>
      <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;margin-bottom:6px;">
        <label style="font-size:12px;color:#ECE6D6;">Length</label>
        <input id="scada-dims-l" type="text" autocomplete="off"
               value="${valueOf(room.length_m)}"
               placeholder="e.g. ${u === 'm' ? '6' : '20 ft'}"
               style="padding:6px;background:#0c0e13;color:#ECE6D6;
                      border:1px solid #3c3f47;border-radius:3px;
                      font-family:inherit;font-size:12px;">
        <label style="font-size:12px;color:#ECE6D6;">Width</label>
        <input id="scada-dims-w" type="text" autocomplete="off"
               value="${valueOf(room.width_m)}"
               placeholder="e.g. ${u === 'm' ? '4.5' : '15 ft'}"
               style="padding:6px;background:#0c0e13;color:#ECE6D6;
                      border:1px solid #3c3f47;border-radius:3px;
                      font-family:inherit;font-size:12px;">
        <label style="font-size:12px;color:#ECE6D6;">Height</label>
        <input id="scada-dims-h" type="text" autocomplete="off"
               value="${valueOf(room.height_m)}"
               placeholder="ceiling — blank for outdoor / open"
               title="Leave blank for open areas (playground, parking, courtyard). Volume is shown only when all three are set."
               style="padding:6px;background:#0c0e13;color:#ECE6D6;
                      border:1px solid #3c3f47;border-radius:3px;
                      font-family:inherit;font-size:12px;">
      </div>
      <div id="scada-dims-preview" style="font-family:ui-monospace,monospace;font-size:11px;
                                          color:#86c26f;margin-top:12px;margin-bottom:14px;
                                          min-height:38px;background:#0c0e13;border-radius:3px;
                                          padding:6px 8px;border:1px solid #3c3f47;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="scada-dims-clear"
                style="cursor:pointer;background:transparent;color:#d95a50;
                       border:1px solid #d95a50;padding:6px 12px;border-radius:3px;
                       font-family:inherit;">Clear all</button>
        <button id="scada-dims-cancel"
                style="cursor:pointer;background:transparent;color:#888a95;
                       border:1px solid #3c3f47;padding:6px 12px;border-radius:3px;
                       font-family:inherit;">Cancel</button>
        <button id="scada-dims-save"
                style="cursor:pointer;background:#86c26f;color:#0c0e13;
                       border:none;padding:6px 12px;border-radius:3px;
                       font-family:inherit;font-weight:700;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(dimsModalEl);

  units.mountUnitToggle(document.getElementById('scada-dims-unit-host'), {
    onChange: () => {
      // Re-format input values in the new unit so the operator never
      // sees a stale "5.5 m" while the toggle says ft.
      for (const id of ['scada-dims-l', 'scada-dims-w', 'scada-dims-h']) {
        const el = document.getElementById(id);
        if (!el) continue;
        const m = units.parseToMeters(el.value);
        el.value = (m === null) ? '' : units.formatFromMeters(m);
      }
      paintPreview();
    },
  });

  const close = () => { dimsModalEl && dimsModalEl.remove(); dimsModalEl = null; };

  const inputs = ['scada-dims-l', 'scada-dims-w', 'scada-dims-h']
    .map(id => document.getElementById(id));
  for (const el of inputs) el.addEventListener('input', paintPreview);

  function readAllMeters() {
    return inputs.map(el => units.parseToMeters(el.value));
  }
  function paintPreview() {
    const [l, w, h] = readAllMeters();
    const lines = [];
    const polyA = polygonAreaM2(room.polygon);
    if (polyA > 0) {
      lines.push(`Polygon area: <span style="color:#888a95">${units.formatAreaFromMeters2(polyA)}</span>`);
    }
    if (l && w) {
      const a = l * w;
      const diff = polyA > 0 ? Math.abs(a - polyA) / polyA * 100 : 0;
      const colour = (polyA > 0 && diff > 15) ? '#f59e0b' : '#86c26f';
      lines.push(`Measured area: <span style="color:${colour}">${units.formatAreaFromMeters2(a)}</span>${
        polyA > 0 ? `   (differs from polygon by ${diff.toFixed(0)}%)` : ''}`);
      if (h) {
        lines.push(`Volume:        <span style="color:#5c8bf2">${(a * h).toFixed(1)} m³</span>`);
      }
    }
    document.getElementById('scada-dims-preview').innerHTML =
      lines.length ? lines.join('<br>') : '<span style="color:#888a95">Type at least length + width to see the derived area.</span>';
  }
  paintPreview();

  document.getElementById('scada-dims-cancel').onclick = close;
  document.getElementById('scada-dims-clear').onclick = async () => {
    const saved = await updateRoom(room.id,
      { length_m: 0, width_m: 0, height_m: 0 });
    if (saved) { Object.assign(room, saved); renderToolbar(); redraw(); }
    close();
  };
  document.getElementById('scada-dims-save').onclick = async () => {
    const [l, w, h] = readAllMeters();
    const patch = {};
    if (l !== null) patch.length_m = l;
    if (w !== null) patch.width_m  = w;
    if (h !== null) patch.height_m = h;
    if (Object.keys(patch).length === 0) {
      close();
      return;
    }
    const saved = await updateRoom(room.id, patch);
    if (saved) {
      Object.assign(room, saved);
      renderToolbar();
      redraw();
      if (window.toast) window.toast(`Saved dimensions for "${saved.name}"`, 'ok');
    }
    close();
  };
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[m]);
}

// ── State transitions ──────────────────────────────────────────────────
function enterEditor() {
  mode = 'idle';
  loadRooms();
  ensureOverlay();
  renderToolbar();
  showBanner('Click an existing area to edit, or "+ New area" to add one.');
  if (roomsBtnEl) {
    roomsBtnEl.style.background = '#5c8bf2';
    roomsBtnEl.textContent = '🏠 Done';
  }
}

function exitEditor() {
  mode = 'off';
  currentPoly = [];
  selectedId = null;
  if (overlay) overlay.innerHTML = '';
  if (toolbarEl) { toolbarEl.remove(); toolbarEl = null; }
  hideBanner();
  if (roomsBtnEl) {
    roomsBtnEl.style.background = '#86c26f';
    roomsBtnEl.textContent = '🏠 Areas';
  }
}

function startDrawing() {
  mode = 'drawing';
  currentPoly = [];
  selectedId = null;
  renderToolbar();
  showBanner('Click each corner of the area. Double-click or press Enter to close.');
}

function startDrawingRect() {
  mode = 'drawing-rect';
  currentPoly = [];
  rectAnchor = null;
  rectCurrent = null;
  selectedId = null;
  document.body.style.cursor = 'crosshair';
  renderToolbar();
  showBanner('Press and drag from one corner across to the opposite corner.');
}

async function finishDrawing() {
  if (currentPoly.length < 3) {
    showBanner('Need at least 3 points — keep clicking corners.');
    return;
  }
  const name = prompt(
    'Area name (Lab, Classroom 2, Playground, Corridor, Parking, ...):', '');
  if (!name || !name.trim()) {
    currentPoly = [];
    mode = 'idle';
    renderToolbar();
    redraw();
    showBanner('Cancelled.');
    return;
  }
  const created = await createRoom(name.trim(), currentPoly);
  currentPoly = [];
  if (created) {
    rooms.push(created);
    selectedId = created.id;
    mode = 'selected';
    if (window.toast) window.toast(`Room "${created.name}" added`, 'ok');
  } else {
    mode = 'idle';
  }
  renderToolbar();
  redraw();
}

// ── Input handlers ─────────────────────────────────────────────────────
function onCanvasClick(ev) {
  if (mode !== 'drawing') return;
  // Vertices are added on single-click; double-click is handled
  // separately below to close the polygon. We rely on dblclick firing
  // its own event independent of click.
  const img = $(PLAN_IMG_ID);
  if (!img) return;
  const rect = img.getBoundingClientRect();
  if (ev.clientX < rect.left || ev.clientX > rect.right ||
      ev.clientY < rect.top  || ev.clientY > rect.bottom) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  const xPct = (ev.clientX - rect.left) / rect.width;
  const yPct = (ev.clientY - rect.top)  / rect.height;
  currentPoly.push({ x_pct: xPct, y_pct: yPct });
  renderToolbar();
  redraw();
}

function onCanvasDblClick(ev) {
  if (mode !== 'drawing') return;
  ev.preventDefault();
  ev.stopPropagation();
  // The dblclick also emits two clicks before it, both of which added
  // vertices. If the last two vertices are at the same location, drop
  // the duplicate so the polygon doesn't include the closing point twice.
  if (currentPoly.length >= 2) {
    const a = currentPoly[currentPoly.length - 1];
    const b = currentPoly[currentPoly.length - 2];
    if (Math.abs(a.x_pct - b.x_pct) < 0.005 &&
        Math.abs(a.y_pct - b.y_pct) < 0.005) {
      currentPoly.pop();
    }
  }
  finishDrawing();
}

function onKey(ev) {
  if (mode === 'off') return;
  if (ev.key === 'Escape') {
    if (mode === 'drawing' && currentPoly.length > 0) {
      currentPoly = [];
      mode = 'idle';
      renderToolbar();
      redraw();
      showBanner('Drawing cancelled.');
    } else if (mode === 'drawing-rect') {
      rectAnchor = rectCurrent = null;
      mode = 'idle';
      document.body.style.cursor = '';
      renderToolbar();
      redraw();
      showBanner('Rectangle cancelled.');
    } else {
      exitEditor();
    }
  } else if (ev.key === 'Enter' && mode === 'drawing') {
    ev.preventDefault();
    finishDrawing();
  }
}

// Rectangle drag — pointer events on the canvas. Active only when
// mode === 'drawing-rect'. Live preview redraws on every move; final
// 4-point polygon submitted on release (with name prompt).
function onPointerDown(ev) {
  if (mode !== 'drawing-rect') return;
  if (ev.button !== undefined && ev.button !== 0) return;
  const img = $(PLAN_IMG_ID);
  if (!img) return;
  const rect = img.getBoundingClientRect();
  if (ev.clientX < rect.left || ev.clientX > rect.right ||
      ev.clientY < rect.top  || ev.clientY > rect.bottom) {
    return;
  }
  ev.preventDefault();
  ev.stopPropagation();
  rectAnchor = {
    x_pct: (ev.clientX - rect.left) / rect.width,
    y_pct: (ev.clientY - rect.top)  / rect.height,
  };
  rectCurrent = { ...rectAnchor };
  host.setPointerCapture(ev.pointerId);
  redraw();
}

function onPointerMove(ev) {
  if (mode !== 'drawing-rect' || !rectAnchor) return;
  const img = $(PLAN_IMG_ID);
  if (!img) return;
  const rect = img.getBoundingClientRect();
  // Clamp to image rect so the operator can drag past the edge without
  // ending up with a polygon point outside [0,1].
  const cx = Math.max(rect.left, Math.min(ev.clientX, rect.right));
  const cy = Math.max(rect.top,  Math.min(ev.clientY, rect.bottom));
  rectCurrent = {
    x_pct: (cx - rect.left) / rect.width,
    y_pct: (cy - rect.top)  / rect.height,
  };
  redraw();
}

async function onPointerUp(ev) {
  if (mode !== 'drawing-rect' || !rectAnchor || !rectCurrent) return;
  try { host.releasePointerCapture(ev.pointerId); } catch (_) {}
  const minX = Math.min(rectAnchor.x_pct, rectCurrent.x_pct);
  const maxX = Math.max(rectAnchor.x_pct, rectCurrent.x_pct);
  const minY = Math.min(rectAnchor.y_pct, rectCurrent.y_pct);
  const maxY = Math.max(rectAnchor.y_pct, rectCurrent.y_pct);
  // Sanity: reject sub-1% rectangles (likely a stray click).
  if ((maxX - minX) < 0.01 || (maxY - minY) < 0.01) {
    rectAnchor = rectCurrent = null;
    redraw();
    showBanner('Rectangle too small — drag further across the room.', '#d95a50');
    return;
  }
  currentPoly = [
    { x_pct: minX, y_pct: minY },
    { x_pct: maxX, y_pct: minY },
    { x_pct: maxX, y_pct: maxY },
    { x_pct: minX, y_pct: maxY },
  ];
  rectAnchor = rectCurrent = null;
  document.body.style.cursor = '';
  // Re-use the polygon finalise flow (name prompt + server save).
  await finishDrawing();
}

// ── Mount button + wire up ─────────────────────────────────────────────
function mountRoomsButton() {
  // Attach to the existing calibration bar inserted by floor_calibration.js
  // so the two admin actions live together. If it isn't there yet, retry.
  const bar = host && host.querySelector('.scada-cal-bar');
  if (!bar) { setTimeout(mountRoomsButton, 500); return; }
  if (bar.querySelector('.scada-rooms-btn')) return;
  roomsBtnEl = document.createElement('button');
  roomsBtnEl.className = 'scada-rooms-btn';
  // "Areas" not "Rooms" — operators outline EVERY meaningful space:
  // classrooms, corridors, playgrounds, parking, gardens. The schema
  // stays site_rooms (no breaking change), only the label changes.
  roomsBtnEl.textContent = '🏠 Areas';
  Object.assign(roomsBtnEl.style, {
    cursor: 'pointer', background: '#86c26f', color: '#0c0e13',
    border: 'none', padding: '3px 8px', borderRadius: '3px',
    fontFamily: 'inherit', fontSize: '11px', fontWeight: '700',
    marginLeft: '4px',
  });
  roomsBtnEl.onclick = () => {
    if (mode === 'off') enterEditor();
    else                exitEditor();
  };
  bar.appendChild(roomsBtnEl);
}

function startRoomEditor() {
  host = $(ADMIN_HOST_ID);
  if (!host) { setTimeout(startRoomEditor, 500); return; }
  if (host.dataset.scadaRoomsWired === '1') return;
  host.dataset.scadaRoomsWired = '1';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.addEventListener('click', onCanvasClick, true);
  host.addEventListener('dblclick', onCanvasDblClick, true);
  // Pointer events for the rectangle drag path. Captured at the host
  // so we can stop propagation cleanly when mode === 'drawing-rect'
  // without fighting the pin-drag handlers in admin_pin_polish.js
  // (which early-return when not over a pin).
  host.addEventListener('pointerdown', onPointerDown, true);
  host.addEventListener('pointermove', onPointerMove, true);
  host.addEventListener('pointerup',   onPointerUp,   true);
  document.addEventListener('keydown', onKey);
  mountRoomsButton();
  // Light poll to mount the button after the floor list loads.
  setInterval(mountRoomsButton, 1500);
  // Reload rooms when the user switches floors. Cheap to call.
  setInterval(() => {
    if (mode !== 'off') loadRooms();
  }, 3000);
}

// Public for the coverage rail consumer (per-room list lives there).
export function getCachedRooms() { return rooms.slice(); }
export async function refreshRooms() { return loadRooms(); }

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startRoomEditor);
} else {
  startRoomEditor();
}

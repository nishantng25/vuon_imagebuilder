// =============================================================================
// Full-screen floor editor — pan/zoom workspace with every authoring tool.
//
// Single overlay that hosts Calibrate / Outline / Areas / Pathway tools
// against the same pan/zoom canvas. Each tool is exclusive: switching
// tool clears any in-progress drawing. Selected items (a pathway or
// area you clicked) show a context toolbar with Rename / Delete /
// (for pathways) Cameras.
//
// Server data model is untouched — every tool POSTs/PUTs through the
// same APIs the small-canvas tools use, so geometry created here is
// instantly visible in the regular admin view too.
// =============================================================================

import * as units from './units.js';
import { openPathwayLiveGrid } from './path_live_grid.js';
import { triggerTestPulse } from './scada_mimic.js';

const OVERLAY_ID = 'scada-fs-editor';
const ENTRY_HOST_SELECTOR = '.scada-cal-bar';

// ── State ──────────────────────────────────────────────────────────────
let isOpen = false;
let panX = 0, panY = 0, zoom = 1;
let panAnchor = null;
let activeTool = 'pan';        // 'pan'|'path-poly'|'area-poly'|'area-rect'|'outline-poly'|'outline-rect'|'cal-line'
let currentPoly = [];          // active polygon/polyline in pct space
let rectAnchor = null;
let rectCurrent = null;
let calPts = [];               // for cal-line: 0, 1, or 2 points
let selectedKind = null;       // 'route' | 'area' | null
let selectedId   = null;

// Data caches.
let routes = [];
let rooms  = [];
let pins   = [];               // [{cam_slot, x_pct, y_pct, ...}] from /api/site/pins
let cameras = [];              // [{id, name, ...}] from /api/cameras

// SENSOR_OPTIONS — common CCTV image-sensor formats with active-area
// dimensions in mm. Pairs with focal_length_mm to derive HFOV/VFOV
// via FOV = 2·arctan(sensor / (2·focal)). The dimensions come from
// the standard sensor-format table; 1/3" and 1/2.8" cover the bulk
// of fleet today, 1" is the high-end.
const SENSOR_OPTIONS = [
  { label: '— not set —', value: '',       w: 0,     h: 0    },
  { label: '1/4"',        value: '1/4"',   w: 3.6,   h: 2.7  },
  { label: '1/3.6"',      value: '1/3.6"', w: 4.0,   h: 3.0  },
  { label: '1/3"',        value: '1/3"',   w: 4.8,   h: 3.6  },
  { label: '1/2.8"',      value: '1/2.8"', w: 5.21,  h: 3.93 },
  { label: '1/2.7"',      value: '1/2.7"', w: 5.37,  h: 4.04 },
  { label: '1/2.5"',      value: '1/2.5"', w: 5.76,  h: 4.29 },
  { label: '1/2.3"',      value: '1/2.3"', w: 6.16,  h: 4.62 },
  { label: '1/2"',        value: '1/2"',   w: 6.4,   h: 4.8  },
  { label: '1/1.8"',      value: '1/1.8"', w: 7.18,  h: 5.32 },
  { label: '1/1.7"',      value: '1/1.7"', w: 7.6,   h: 5.7  },
  { label: '1"',          value: '1"',     w: 13.2,  h: 8.8  },
];
function sensorByValue(v) {
  return SENSOR_OPTIONS.find(o => o.value === v);
}
// FOV computation: 2·arctan(sensor / (2·focal)). Returns degrees.
function fovFromFocalSensor(focalMM, sensorMM) {
  if (!(focalMM > 0) || !(sensorMM > 0)) return 0;
  return 2 * Math.atan(sensorMM / (2 * focalMM)) * 180 / Math.PI;
}

// Default colour palette cycled when an operator creates a new path
// without picking one explicitly. Eight high-contrast hues that read
// well against the dark canvas. Index = (routes.length) % palette.length.
const PATH_PALETTE = [
  '#5c8bf2', // blue
  '#86c26f', // green
  '#f59e0b', // amber
  '#d95a50', // red
  '#c084fc', // purple
  '#06b6d4', // cyan
  '#ec4899', // pink
  '#84cc16', // lime
];
function defaultPathColor() {
  return PATH_PALETTE[routes.length % PATH_PALETTE.length];
}
function colorForRoute(r) {
  return (r && typeof r.color === 'string' && r.color) ? r.color : PATH_PALETTE[0];
}

// DOM handles.
let overlayEl  = null;
let canvasHost = null;
let canvasEl   = null;
let imgEl      = null;
let svgEl      = null;
let toolbarEl  = null;
let statusEl   = null;
let ctxBarEl   = null;
let escListener = null;

function $(id) { return document.getElementById(id); }

function currentFloor() {
  const sv = window.SV || {};
  const id = sv.currentFloorId;
  if (!id) return null;
  return (sv.floors || []).find(f => f.id === id) || null;
}

// ── Open / close ───────────────────────────────────────────────────────
async function open() {
  if (isOpen) return;
  const f = currentFloor();
  if (!f) {
    if (window.toast) window.toast('Select a floor first', 'warn');
    return;
  }
  buildOverlay(f);
  document.body.style.overflow = 'hidden';
  isOpen = true;

  await loadAll();

  if (imgEl.complete && imgEl.naturalWidth) fitToScreen();
  else imgEl.addEventListener('load', fitToScreen, { once: true });

  escListener = (ev) => {
    if (ev.key === 'Escape') {
      if (activeTool !== 'pan' && (currentPoly.length > 0 || calPts.length > 0 || rectAnchor)) {
        cancelDrawing();
      } else if (activeTool !== 'pan') {
        setTool('pan');
      } else if (selectedId) {
        selectedKind = null; selectedId = null; redraw(); paintCtx();
      } else {
        close();
      }
    } else if (ev.key === 'Enter') {
      if (activeTool === 'path-poly' || activeTool === 'area-poly' || activeTool === 'outline-poly') {
        ev.preventDefault();
        finishPolyDrawing();
      }
    }
  };
  document.addEventListener('keydown', escListener);
  paintStatus();
  paintCtx();
}

function close() {
  if (!isOpen) return;
  document.removeEventListener('keydown', escListener);
  escListener = null;
  if (overlayEl) { overlayEl.remove(); overlayEl = null; }
  overlayEl = canvasHost = canvasEl = imgEl = svgEl = toolbarEl = statusEl = ctxBarEl = null;
  document.body.style.overflow = '';
  activeTool = 'pan';
  currentPoly = [];
  calPts = [];
  rectAnchor = rectCurrent = null;
  selectedKind = null; selectedId = null;
  isOpen = false;
}

async function loadAll() {
  const f = currentFloor();
  if (!f) return;
  try {
    routes = await window.siteApi.get(`/api/site/floors/${f.id}/routes`);
    if (!Array.isArray(routes)) routes = [];
  } catch (_) { routes = []; }
  try {
    rooms = await window.siteApi.get(`/api/site/floors/${f.id}/rooms`);
    if (!Array.isArray(rooms)) rooms = [];
  } catch (_) { rooms = []; }
  // Camera pins. Always fetch fresh from the API — the monolith's
  // cache can be empty if pins hadn't finished loading when the
  // operator opened the editor, and falling into the empty-array
  // branch silently produced "0 cameras" on the canvas.
  try {
    pins = await window.siteApi.get(`/api/site/pins?floor=${f.id}`);
    if (!Array.isArray(pins)) pins = [];
  } catch (e) {
    console.warn('[scada-fs] pin load failed', e);
    // Best-effort fallback to monolith cache.
    const sv = window.SV || {};
    pins = (sv.pinsByFloor && Array.isArray(sv.pinsByFloor[f.id]))
      ? sv.pinsByFloor[f.id].slice() : [];
  }
  console.log('[scada-fs] loaded', pins.length, 'pins,', rooms.length, 'areas,', routes.length, 'paths');
  // Camera list — used by the pathway camera-assignment modal.
  try {
    cameras = (window.S && Array.isArray(window.S.cameras)) ? window.S.cameras.slice() : [];
  } catch (_) { cameras = []; }
  redraw();
  paintStatus();
}

// ── Overlay DOM ────────────────────────────────────────────────────────
function buildOverlay(floor) {
  overlayEl = document.createElement('div');
  overlayEl.id = OVERLAY_ID;
  Object.assign(overlayEl.style, {
    position: 'fixed', inset: '0', zIndex: 10000,
    background: '#0c0e13',
    display: 'flex', flexDirection: 'column',
    fontFamily: 'ui-monospace, monospace',
    color: '#ECE6D6',
  });

  // Toolbar — grouped tools, bigger buttons, very explicit labels.
  toolbarEl = document.createElement('div');
  Object.assign(toolbarEl.style, {
    display: 'flex', gap: '12px', alignItems: 'center',
    padding: '10px 14px',
    background: '#1a1d22', borderBottom: '1px solid #3c3f47',
    fontSize: '12px', flexWrap: 'wrap',
  });
  toolbarEl.innerHTML = renderToolbarHTML(floor);
  overlayEl.appendChild(toolbarEl);

  // Context bar — appears when something is selected.
  ctxBarEl = document.createElement('div');
  Object.assign(ctxBarEl.style, {
    display: 'none', gap: '8px', alignItems: 'center',
    padding: '6px 14px',
    background: '#2a2d34', borderBottom: '1px solid #3c3f47',
    fontSize: '12px',
  });
  overlayEl.appendChild(ctxBarEl);

  // Canvas pan/zoom area.
  canvasHost = document.createElement('div');
  Object.assign(canvasHost.style, {
    flex: '1', position: 'relative', overflow: 'hidden',
    background: '#0a0c10', cursor: 'grab',
  });
  canvasEl = document.createElement('div');
  Object.assign(canvasEl.style, {
    position: 'absolute', top: '0', left: '0',
    transformOrigin: '0 0', willChange: 'transform',
  });
  imgEl = document.createElement('img');
  imgEl.id = 'scada-fs-plan-img';
  imgEl.src = `/api/site/floors/${floor.id}/image?siteview=1&token=${encodeURIComponent((window.S && window.S.token) || '')}`;
  Object.assign(imgEl.style, {
    display: 'block', userSelect: 'none', pointerEvents: 'none',
  });
  imgEl.draggable = false;
  canvasEl.appendChild(imgEl);
  svgEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  Object.assign(svgEl.style, {
    position: 'absolute', top: '0', left: '0', pointerEvents: 'auto',
  });
  canvasEl.appendChild(svgEl);
  canvasHost.appendChild(canvasEl);
  overlayEl.appendChild(canvasHost);

  // Status bar.
  statusEl = document.createElement('div');
  Object.assign(statusEl.style, {
    padding: '6px 14px',
    background: '#1a1d22', borderTop: '1px solid #3c3f47',
    fontSize: '11px', color: '#888a95',
  });
  overlayEl.appendChild(statusEl);

  document.body.appendChild(overlayEl);

  // Wire events.
  canvasHost.addEventListener('pointerdown', onPointerDown);
  canvasHost.addEventListener('pointermove', onPointerMove);
  canvasHost.addEventListener('pointerup',   onPointerUp);
  canvasHost.addEventListener('wheel',       onWheel, { passive: false });
  canvasHost.addEventListener('click',       onCanvasClick, true);
  canvasHost.addEventListener('dblclick',    onCanvasDblClick, true);

  $('scada-fs-done').onclick = close;
  $('scada-fs-zoom-in').onclick  = () => zoomBy(1.25);
  $('scada-fs-zoom-out').onclick = () => zoomBy(1 / 1.25);
  $('scada-fs-zoom-fit').onclick = fitToScreen;
  wireToolButtons();
}

function renderToolbarHTML(floor) {
  // Helper to build a tool button group label.
  const grp = (label, html) => `
    <div style="display:flex;gap:4px;align-items:center;padding:0 10px;
                border-right:1px solid #3c3f47;">
      <span style="color:#888a95;font-size:10px;letter-spacing:.08em;text-transform:uppercase;">${label}</span>
      ${html}
    </div>`;
  const btn = (id, label, accent, title) => `
    <button id="${id}" data-tool-btn="1" title="${escapeAttr(title)}"
            style="cursor:pointer;background:#3c3f47;color:#ECE6D6;border:none;
                   padding:5px 11px;border-radius:3px;font-family:inherit;
                   font-size:12px;font-weight:700;
                   --accent:${accent};">${label}</button>`;
  return `
    <div style="font-weight:700;font-size:14px;padding-right:10px;border-right:1px solid #3c3f47;">📐 ${escapeHTML(floor.name)}</div>
    ${grp('Calibrate',
      btn('scada-fs-tool-cal',          '📏 Line',     '#f59e0b', 'Click two points on a known distance, then type its real length'))}
    ${grp('Outline',
      btn('scada-fs-tool-outline-poly', '🏢 Polygon',  '#f59e0b', 'Click each corner of the building, double-click to close') +
      btn('scada-fs-tool-outline-rect', '🏢 ▭',       '#f59e0b', 'Drag a rectangle around the building'))}
    ${grp('Areas',
      btn('scada-fs-tool-area-poly',    '🏠 Polygon',  '#86c26f', 'Click each corner of a room/area, double-click to close') +
      btn('scada-fs-tool-area-rect',    '🏠 ▭',       '#86c26f', 'Drag a rectangle for a quick rectangular room'))}
    ${grp('Pathway',
      btn('scada-fs-tool-path-poly',    '🛤 Polyline', '#5c8bf2', 'Click each waypoint along the path, double-click or Enter to finish'))}
    <div style="flex:1"></div>
    <div style="display:flex;gap:4px;align-items:center;padding:0 10px;border-left:1px solid #3c3f47;">
      <button id="scada-fs-zoom-out" style="cursor:pointer;background:#3c3f47;color:#ECE6D6;border:none;padding:5px 10px;border-radius:3px;font-family:inherit;font-size:12px;">−</button>
      <button id="scada-fs-zoom-fit" style="cursor:pointer;background:#3c3f47;color:#ECE6D6;border:none;padding:5px 10px;border-radius:3px;font-family:inherit;font-size:12px;">Fit</button>
      <button id="scada-fs-zoom-in"  style="cursor:pointer;background:#3c3f47;color:#ECE6D6;border:none;padding:5px 10px;border-radius:3px;font-family:inherit;font-size:12px;">+</button>
      <span id="scada-fs-zoom-pct" style="font-size:11px;color:#888a95;width:48px;text-align:right;">100%</span>
    </div>
    <button id="scada-fs-done"
            style="cursor:pointer;background:#d95a50;color:#fff;border:none;
                   padding:6px 16px;border-radius:3px;font-family:inherit;
                   font-size:12px;font-weight:700;">✕ Done</button>
  `;
}

function wireToolButtons() {
  const map = {
    'scada-fs-tool-cal':          'cal-line',
    'scada-fs-tool-outline-poly': 'outline-poly',
    'scada-fs-tool-outline-rect': 'outline-rect',
    'scada-fs-tool-area-poly':    'area-poly',
    'scada-fs-tool-area-rect':    'area-rect',
    'scada-fs-tool-path-poly':    'path-poly',
  };
  for (const id of Object.keys(map)) {
    const btn = $(id);
    if (!btn) continue;
    btn.onclick = () => {
      setTool(activeTool === map[id] ? 'pan' : map[id]);
    };
  }
}

function paintToolButtonStates() {
  const map = {
    'cal-line':     ['scada-fs-tool-cal',           '#f59e0b'],
    'outline-poly': ['scada-fs-tool-outline-poly',  '#f59e0b'],
    'outline-rect': ['scada-fs-tool-outline-rect',  '#f59e0b'],
    'area-poly':    ['scada-fs-tool-area-poly',     '#86c26f'],
    'area-rect':    ['scada-fs-tool-area-rect',     '#86c26f'],
    'path-poly':    ['scada-fs-tool-path-poly',     '#5c8bf2'],
  };
  for (const tool of Object.keys(map)) {
    const [id, accent] = map[tool];
    const btn = $(id);
    if (!btn) continue;
    if (activeTool === tool) {
      btn.style.background = accent;
      btn.style.color      = '#0c0e13';
    } else {
      btn.style.background = '#3c3f47';
      btn.style.color      = '#ECE6D6';
    }
  }
}

// ── Tool selection ─────────────────────────────────────────────────────
function setTool(tool) {
  activeTool = tool;
  currentPoly = [];
  rectAnchor = rectCurrent = null;
  calPts = [];
  selectedKind = null; selectedId = null;
  paintToolButtonStates();
  paintStatus();
  paintCtx();
  if (canvasHost) {
    canvasHost.style.cursor = (tool === 'pan') ? 'grab' : 'crosshair';
  }
  redraw();
}

function cancelDrawing() {
  currentPoly = [];
  rectAnchor = rectCurrent = null;
  calPts = [];
  redraw();
  paintStatus();
}

// ── Pan / Zoom ─────────────────────────────────────────────────────────
function applyTransform() {
  canvasEl.style.transform = `translate(${panX}px, ${panY}px) scale(${zoom})`;
  const pct = $('scada-fs-zoom-pct');
  if (pct) pct.textContent = (zoom * 100).toFixed(0) + '%';
  if (svgEl && imgEl && imgEl.naturalWidth) {
    svgEl.setAttribute('width',  imgEl.naturalWidth);
    svgEl.setAttribute('height', imgEl.naturalHeight);
    svgEl.setAttribute('viewBox', `0 0 ${imgEl.naturalWidth} ${imgEl.naturalHeight}`);
  }
}

function fitToScreen() {
  if (!imgEl || !imgEl.naturalWidth) return;
  const host = canvasHost.getBoundingClientRect();
  const padding = 24;
  const fitX = (host.width  - padding * 2) / imgEl.naturalWidth;
  const fitY = (host.height - padding * 2) / imgEl.naturalHeight;
  zoom = Math.max(0.1, Math.min(fitX, fitY));
  panX = (host.width  - imgEl.naturalWidth  * zoom) / 2;
  panY = (host.height - imgEl.naturalHeight * zoom) / 2;
  applyTransform();
  redraw();
}

function zoomBy(factor) {
  const host = canvasHost.getBoundingClientRect();
  const cx = host.width / 2;
  const cy = host.height / 2;
  const ix = (cx - panX) / zoom;
  const iy = (cy - panY) / zoom;
  zoom = Math.max(0.1, Math.min(8, zoom * factor));
  panX = cx - ix * zoom;
  panY = cy - iy * zoom;
  applyTransform();
  redraw();
}

function zoomAt(clientX, clientY, factor) {
  const host = canvasHost.getBoundingClientRect();
  const cx = clientX - host.left;
  const cy = clientY - host.top;
  const ix = (cx - panX) / zoom;
  const iy = (cy - panY) / zoom;
  zoom = Math.max(0.1, Math.min(8, zoom * factor));
  panX = cx - ix * zoom;
  panY = cy - iy * zoom;
  applyTransform();
  redraw();
}

function onWheel(ev) {
  ev.preventDefault();
  zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1.1 : 1 / 1.1);
}

// ── Pointer events: pan (default) + rect-drag (when in rect tool) ─────
function onPointerDown(ev) {
  if (ev.button !== undefined && ev.button !== 0) return;
  // Rectangle tool: start drag.
  if (activeTool === 'area-rect' || activeTool === 'outline-rect') {
    const pct = clientToPct(ev.clientX, ev.clientY);
    if (!pct) return;
    ev.preventDefault();
    ev.stopPropagation();
    rectAnchor = pct;
    rectCurrent = { ...pct };
    canvasHost.setPointerCapture(ev.pointerId);
    redraw();
    return;
  }
  // Pan when no drawing tool.
  if (activeTool === 'pan') {
    panAnchor = {
      clientX: ev.clientX, clientY: ev.clientY,
      startPanX: panX, startPanY: panY,
    };
    canvasHost.style.cursor = 'grabbing';
    ev.preventDefault();
  }
}

function onPointerMove(ev) {
  if (rectAnchor) {
    const pct = clientToPct(ev.clientX, ev.clientY, /*clamp=*/true);
    if (pct) { rectCurrent = pct; redraw(); }
    return;
  }
  if (!panAnchor) return;
  panX = panAnchor.startPanX + (ev.clientX - panAnchor.clientX);
  panY = panAnchor.startPanY + (ev.clientY - panAnchor.clientY);
  applyTransform();
}

async function onPointerUp(ev) {
  if (rectAnchor) {
    try { canvasHost.releasePointerCapture(ev.pointerId); } catch (_) {}
    const aX = rectAnchor.x_pct, aY = rectAnchor.y_pct;
    const bX = rectCurrent.x_pct, bY = rectCurrent.y_pct;
    const minX = Math.min(aX, bX), maxX = Math.max(aX, bX);
    const minY = Math.min(aY, bY), maxY = Math.max(aY, bY);
    if ((maxX - minX) < 0.01 || (maxY - minY) < 0.01) {
      rectAnchor = rectCurrent = null;
      redraw();
      return;
    }
    const poly = [
      { x_pct: minX, y_pct: minY },
      { x_pct: maxX, y_pct: minY },
      { x_pct: maxX, y_pct: maxY },
      { x_pct: minX, y_pct: maxY },
    ];
    const tool = activeTool;
    rectAnchor = rectCurrent = null;
    if (tool === 'area-rect') {
      currentPoly = poly;
      await finishAreaDrawing();
    } else if (tool === 'outline-rect') {
      currentPoly = poly;
      await finishOutlineDrawing();
    }
    return;
  }
  if (panAnchor) {
    panAnchor = null;
    canvasHost.style.cursor = (activeTool === 'pan') ? 'grab' : 'crosshair';
  }
}

// Click — places a waypoint for poly tools; deselects when clicking
// empty canvas in pan mode.
function onCanvasClick(ev) {
  if (activeTool === 'pan') return;
  const pct = clientToPct(ev.clientX, ev.clientY);
  if (!pct) return;
  ev.preventDefault();
  ev.stopPropagation();
  if (activeTool === 'cal-line') {
    calPts.push(pct);
    if (calPts.length === 2) {
      promptCalibrationLength();
    } else {
      redraw();
      paintStatus();
    }
    return;
  }
  // poly path / area / outline — all append a waypoint.
  if (activeTool === 'path-poly' || activeTool === 'area-poly' || activeTool === 'outline-poly') {
    currentPoly.push(pct);
    redraw();
    paintStatus();
  }
}

function onCanvasDblClick(ev) {
  if (activeTool === 'path-poly' || activeTool === 'area-poly' || activeTool === 'outline-poly') {
    ev.preventDefault();
    ev.stopPropagation();
    if (currentPoly.length >= 2) {
      const a = currentPoly[currentPoly.length - 1];
      const b = currentPoly[currentPoly.length - 2];
      if (Math.abs(a.x_pct - b.x_pct) < 0.005 &&
          Math.abs(a.y_pct - b.y_pct) < 0.005) {
        currentPoly.pop();
      }
    }
    finishPolyDrawing();
  }
}

// Convert client coords → pct space using the IMG bbox. clamp=true
// pins to [0,1] so the rectangle-drag preview doesn't escape.
function clientToPct(clientX, clientY, clamp) {
  if (!imgEl || !imgEl.naturalWidth) return null;
  const rect = imgEl.getBoundingClientRect();
  if (!clamp) {
    if (clientX < rect.left || clientX > rect.right ||
        clientY < rect.top  || clientY > rect.bottom) return null;
  }
  let x = (clientX - rect.left) / rect.width;
  let y = (clientY - rect.top)  / rect.height;
  if (clamp) {
    x = Math.max(0, Math.min(1, x));
    y = Math.max(0, Math.min(1, y));
  }
  return { x_pct: x, y_pct: y };
}

// ── Finish handlers ────────────────────────────────────────────────────
async function finishPolyDrawing() {
  if (activeTool === 'path-poly')    return finishPathDrawing();
  if (activeTool === 'area-poly')    return finishAreaDrawing();
  if (activeTool === 'outline-poly') return finishOutlineDrawing();
}

async function finishPathDrawing() {
  if (currentPoly.length < 2) {
    if (window.toast) window.toast('Need at least 2 waypoints', 'warn');
    return;
  }
  const f = currentFloor();
  if (!f) return;
  const name = prompt('Pathway name (e.g. Main Gate → Lab, Fire Egress, Patrol Loop):', '');
  if (!name || !name.trim()) { setTool('pan'); return; }
  try {
    const saved = await window.siteApi.post(
      `/api/site/floors/${f.id}/routes`,
      { name: name.trim(), waypoints: currentPoly, cameras: [],
        color: defaultPathColor() });
    if (saved) {
      routes.push(saved);
      selectedKind = 'route'; selectedId = saved.id;
      if (window.toast) {
        const lenStr = (typeof saved.length_m === 'number')
          ? ` · ${units.formatFromMeters(saved.length_m)}` : '';
        window.toast(`Pathway "${saved.name}" saved${lenStr}`, 'ok');
      }
    }
  } catch (e) {
    if (window.toast) window.toast('Pathway save failed: ' + e.message, 'err');
  }
  setTool('pan');
}

async function finishAreaDrawing() {
  if (currentPoly.length < 3) {
    if (window.toast) window.toast('Need at least 3 corners', 'warn');
    return;
  }
  const f = currentFloor();
  if (!f) return;
  const name = prompt('Area name (Lab, Classroom 2, Playground, Corridor, Parking, ...):', '');
  if (!name || !name.trim()) { setTool('pan'); return; }
  // Auto-derive L × W from bbox × calibrated floor.
  const body = { name: name.trim(), polygon: currentPoly };
  if (typeof f.width_m === 'number' && typeof f.height_m === 'number') {
    let minX = 1, minY = 1, maxX = 0, maxY = 0;
    for (const p of currentPoly) {
      if (p.x_pct < minX) minX = p.x_pct;
      if (p.x_pct > maxX) maxX = p.x_pct;
      if (p.y_pct < minY) minY = p.y_pct;
      if (p.y_pct > maxY) maxY = p.y_pct;
    }
    body.length_m = Math.round((maxX - minX) * f.width_m  * 100) / 100;
    body.width_m  = Math.round((maxY - minY) * f.height_m * 100) / 100;
  }
  try {
    const saved = await window.siteApi.post(
      `/api/site/floors/${f.id}/rooms`, body);
    if (saved) {
      rooms.push(saved);
      selectedKind = 'area'; selectedId = saved.id;
      if (window.toast) window.toast(`Area "${saved.name}" saved`, 'ok');
    }
  } catch (e) {
    if (window.toast) window.toast('Area save failed: ' + e.message, 'err');
  }
  setTool('pan');
}

async function finishOutlineDrawing() {
  if (currentPoly.length < 3) {
    if (window.toast) window.toast('Need at least 3 corners', 'warn');
    return;
  }
  const f = currentFloor();
  if (!f) return;
  try {
    await window.siteApi.put(
      `/api/site/floors/${f.id}/outline`, { polygon: currentPoly });
    f.outline = currentPoly.slice();
    if (window.toast) window.toast(
      `Floor outline saved (${currentPoly.length} corners)`, 'ok');
  } catch (e) {
    if (window.toast) window.toast('Outline save failed: ' + e.message, 'err');
  }
  setTool('pan');
  // Offer auto-calibrate after outline save — same pattern as the
  // small-canvas flow.
  setTimeout(() => offerAutoCalibrate(f, f.outline || []), 80);
}

// ── Calibration: click two points, prompt for real length ─────────────
function promptCalibrationLength() {
  const f = currentFloor();
  if (!f || calPts.length !== 2) { setTool('pan'); return; }
  const modal = document.createElement('div');
  Object.assign(modal.style, {
    position: 'fixed', inset: '0',
    background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10010,
  });
  modal.innerHTML = `
    <div style="background:#1a1d22;border:1px solid #3c3f47;border-radius:6px;
                padding:20px;width:380px;font-family:ui-monospace,monospace;color:#ECE6D6;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:14px;font-weight:700;">Calibration length</div>
        <div id="scada-fs-cal-unit"></div>
      </div>
      <div style="font-size:11px;color:#888a95;margin-bottom:14px;">
        How long is the line you drew?
      </div>
      <input id="scada-fs-cal-input" type="text" autocomplete="off"
             placeholder="${units.getUnit() === 'm' ? '5.5 m' : '18 ft'}"
             style="width:100%;padding:8px;font-size:14px;box-sizing:border-box;
                    background:#0c0e13;color:#ECE6D6;
                    border:1px solid #3c3f47;border-radius:4px;
                    font-family:inherit;margin-bottom:8px;">
      <div id="scada-fs-cal-preview" style="font-size:11px;color:#86c26f;min-height:16px;margin-bottom:12px;font-family:ui-monospace,monospace;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="scada-fs-cal-cancel" style="cursor:pointer;background:transparent;color:#888a95;border:1px solid #3c3f47;padding:6px 12px;border-radius:3px;font-family:inherit;">Cancel</button>
        <button id="scada-fs-cal-save" style="cursor:pointer;background:#86c26f;color:#0c0e13;border:none;padding:6px 12px;border-radius:3px;font-family:inherit;font-weight:700;">Calibrate</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  units.mountUnitToggle($('scada-fs-cal-unit'));
  const inEl = $('scada-fs-cal-input');
  const pv   = $('scada-fs-cal-preview');
  inEl.focus();
  const paint = () => {
    const m = units.parseToMeters(inEl.value);
    pv.textContent = (m === null) ? (inEl.value ? '↳ unrecognised' : '')
                                   : `↳ ${m.toFixed(3)} m`;
    pv.style.color = (m === null && inEl.value) ? '#f59e0b' : '#86c26f';
  };
  inEl.addEventListener('input', paint);
  inEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter')  $('scada-fs-cal-save').click();
    if (ev.key === 'Escape') $('scada-fs-cal-cancel').click();
  });
  const close = () => { modal.remove(); setTool('pan'); };
  $('scada-fs-cal-cancel').onclick = close;
  $('scada-fs-cal-save').onclick = async () => {
    const m = units.parseToMeters(inEl.value);
    if (m === null) { pv.textContent = '↳ unrecognised'; pv.style.color = '#d95a50'; return; }
    const f = currentFloor();
    if (!f || calPts.length !== 2 || !imgEl.naturalWidth) { close(); return; }
    try {
      const saved = await window.siteApi.put(
        `/api/site/floors/${f.id}/calibration`, {
          line_x1_pct: calPts[0].x_pct, line_y1_pct: calPts[0].y_pct,
          line_x2_pct: calPts[1].x_pct, line_y2_pct: calPts[1].y_pct,
          real_length_m: m,
          image_width_px:  imgEl.naturalWidth,
          image_height_px: imgEl.naturalHeight,
        });
      f.width_m  = saved.width_m;
      f.height_m = saved.height_m;
      if (window.toast) window.toast(
        `Calibrated · ${units.formatFromMeters(saved.width_m)} × ${units.formatFromMeters(saved.height_m)} · ${saved.pixels_per_meter.toFixed(1)} px/m`,
        'ok');
    } catch (e) {
      if (window.toast) window.toast('Calibration failed: ' + e.message, 'err');
    }
    close();
  };
}

// Auto-calibrate prompt offered after a fresh outline save. Reuses
// the calibration modal logic but seeded with the outline bbox so
// the operator just types the floor's overall L × W.
function offerAutoCalibrate(floor, polygon) {
  if (!polygon || polygon.length < 3) return;
  if (!imgEl || !imgEl.naturalWidth)  return;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of polygon) {
    if (p.x_pct < minX) minX = p.x_pct;
    if (p.x_pct > maxX) maxX = p.x_pct;
    if (p.y_pct < minY) minY = p.y_pct;
    if (p.y_pct > maxY) maxY = p.y_pct;
  }
  const bboxW = (maxX - minX), bboxH = (maxY - minY);
  if (bboxW <= 0 || bboxH <= 0) return;
  const modal = document.createElement('div');
  Object.assign(modal.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10010,
  });
  modal.innerHTML = `
    <div style="background:#1a1d22;border:1px solid #3c3f47;border-radius:6px;
                padding:20px;width:420px;font-family:ui-monospace,monospace;color:#ECE6D6;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:14px;font-weight:700;">Auto-calibrate from outline</div>
        <div id="scada-fs-autocal-unit"></div>
      </div>
      <div style="font-size:11px;color:#888a95;margin-bottom:14px;">
        Type the building's overall length × width. We derive pixels-
        per-metre from the outline bbox — every area you draw next
        auto-fills its dimensions.
      </div>
      <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;margin-bottom:6px;">
        <label style="font-size:12px;">Length</label>
        <input id="scada-fs-ac-l" type="text" autocomplete="off" placeholder="longer side, e.g. 100 ft" style="padding:6px;background:#0c0e13;color:#ECE6D6;border:1px solid #3c3f47;border-radius:3px;font-family:inherit;font-size:12px;">
        <label style="font-size:12px;">Width</label>
        <input id="scada-fs-ac-w" type="text" autocomplete="off" placeholder="shorter side, e.g. 50 ft" style="padding:6px;background:#0c0e13;color:#ECE6D6;border:1px solid #3c3f47;border-radius:3px;font-family:inherit;font-size:12px;">
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">
        <button id="scada-fs-ac-skip" style="cursor:pointer;background:transparent;color:#888a95;border:1px solid #3c3f47;padding:6px 12px;border-radius:3px;font-family:inherit;">Skip</button>
        <button id="scada-fs-ac-save" style="cursor:pointer;background:#86c26f;color:#0c0e13;border:none;padding:6px 12px;border-radius:3px;font-family:inherit;font-weight:700;">Calibrate</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  units.mountUnitToggle($('scada-fs-autocal-unit'));
  const close = () => modal.remove();
  $('scada-fs-ac-skip').onclick = close;
  $('scada-fs-ac-save').onclick = async () => {
    const lM = units.parseToMeters($('scada-fs-ac-l').value);
    const wM = units.parseToMeters($('scada-fs-ac-w').value);
    if (lM === null || wM === null) return;
    const longerIsHorizontal = bboxW >= bboxH;
    const longerM = Math.max(lM, wM);
    const body = longerIsHorizontal ? {
      line_x1_pct: minX, line_y1_pct: (minY + maxY) / 2,
      line_x2_pct: maxX, line_y2_pct: (minY + maxY) / 2,
      real_length_m: longerM,
      image_width_px:  imgEl.naturalWidth,
      image_height_px: imgEl.naturalHeight,
    } : {
      line_x1_pct: (minX + maxX) / 2, line_y1_pct: minY,
      line_x2_pct: (minX + maxX) / 2, line_y2_pct: maxY,
      real_length_m: longerM,
      image_width_px:  imgEl.naturalWidth,
      image_height_px: imgEl.naturalHeight,
    };
    try {
      const saved = await window.siteApi.put(
        `/api/site/floors/${floor.id}/calibration`, body);
      floor.width_m  = saved.width_m;
      floor.height_m = saved.height_m;
      if (window.toast) window.toast(
        `Auto-calibrated · ${units.formatFromMeters(saved.width_m)} × ${units.formatFromMeters(saved.height_m)}`, 'ok');
    } catch (e) {
      if (window.toast) window.toast('Auto-calibration failed: ' + e.message, 'err');
    }
    close();
    paintStatus();
  };
}

// ── Selection context bar (Rename / Delete / Cameras) ─────────────────
function paintCtx() {
  if (!ctxBarEl) return;
  if (!selectedKind || !selectedId) {
    ctxBarEl.style.display = 'none';
    ctxBarEl.innerHTML = '';
    return;
  }
  let obj, kindLabel;
  if (selectedKind === 'route') {
    obj = routes.find(r => r.id === selectedId);
    kindLabel = 'Pathway';
  } else if (selectedKind === 'area') {
    obj = rooms.find(r => r.id === selectedId);
    kindLabel = 'Area';
  }
  if (!obj) {
    ctxBarEl.style.display = 'none';
    return;
  }
  ctxBarEl.style.display = 'flex';
  const subtitle = (selectedKind === 'route')
    ? `${(obj.cameras || []).length} cameras · ${typeof obj.length_m === 'number' ? units.formatFromMeters(obj.length_m) : '—'}`
    : 'polygon area';
  // Color swatch strip for pathway selections — quick recolour without
  // leaving the canvas. Each swatch is a clickable square; clicking
  // PUTs {color} on the route and redraws.
  let colourStrip = '';
  if (selectedKind === 'route') {
    const cur = obj.color || '';
    colourStrip = '<div style="display:flex;gap:3px;align-items:center;margin-right:8px;">' +
      '<span style="color:#888a95;font-size:10px;letter-spacing:.08em;text-transform:uppercase;margin-right:2px;">Color</span>' +
      PATH_PALETTE.map(c =>
        `<button class="scada-fs-color-swatch" data-color="${c}" title="${c}"
                 style="width:18px;height:18px;border-radius:3px;
                        background:${c};border:2px solid ${cur === c ? '#fff' : 'transparent'};
                        cursor:pointer;padding:0;outline:none;"></button>`
      ).join('') +
      '</div>';
  }
  ctxBarEl.innerHTML = `
    <span style="color:#888a95;text-transform:uppercase;letter-spacing:.08em;font-size:10px;">Selected ${escapeHTML(kindLabel)}</span>
    <span style="font-weight:700;font-size:13px;">${escapeHTML(obj.name)}</span>
    <span style="color:#888a95;font-size:11px;">· ${escapeHTML(subtitle)}</span>
    <div style="flex:1"></div>
    ${colourStrip}
    ${selectedKind === 'route' ? `<button id="scada-fs-test"   style="cursor:pointer;background:#c084fc;color:#0c0e13;border:none;padding:4px 10px;border-radius:3px;font-family:inherit;font-size:11px;font-weight:700;" title="Fire a synthetic motion pulse to verify the SCADA mimic — closes the editor so the pulse is visible on the canvas behind.">⚡ Test pulse</button>` : ''}
    ${selectedKind === 'route' ? `<button id="scada-fs-live"   style="cursor:pointer;background:#86c26f;color:#0c0e13;border:none;padding:4px 10px;border-radius:3px;font-family:inherit;font-size:11px;font-weight:700;">▶ Live</button>` : ''}
    ${selectedKind === 'route' ? `<button id="scada-fs-cams"   style="cursor:pointer;background:#5c8bf2;color:#fff;border:none;padding:4px 10px;border-radius:3px;font-family:inherit;font-size:11px;font-weight:700;">Cameras</button>` : ''}
    <button id="scada-fs-rename" style="cursor:pointer;background:#3c3f47;color:#ECE6D6;border:none;padding:4px 10px;border-radius:3px;font-family:inherit;font-size:11px;font-weight:700;">Rename</button>
    <button id="scada-fs-delete" style="cursor:pointer;background:#d95a50;color:#fff;border:none;padding:4px 10px;border-radius:3px;font-family:inherit;font-size:11px;font-weight:700;">Delete</button>
    <button id="scada-fs-deselect" style="cursor:pointer;background:transparent;color:#888a95;border:1px solid #3c3f47;padding:4px 10px;border-radius:3px;font-family:inherit;font-size:11px;">Deselect</button>
  `;
  $('scada-fs-rename').onclick = () => renameSelected();
  $('scada-fs-delete').onclick = () => deleteSelected();
  $('scada-fs-deselect').onclick = () => {
    selectedKind = null; selectedId = null;
    paintCtx(); redraw();
  };
  const camsBtn = $('scada-fs-cams');
  if (camsBtn) camsBtn.onclick = () => openCameraPicker(obj);
  const liveBtn = $('scada-fs-live');
  if (liveBtn) liveBtn.onclick = () => openPathwayLiveGrid(obj);
  const testBtn = $('scada-fs-test');
  if (testBtn) testBtn.onclick = async () => {
    // Pulses paint into the admin / operator overlays, NOT inside this
    // editor's own SVG. Close the editor so the operator sees the pulse
    // travel along the path on the regular admin canvas behind. Fire
    // the pulse a tick after close() so the overlay has time to mount.
    if (window.toast) window.toast(
      `⚡ Test pulse on "${obj.name}" — watch the canvas`, 'ok');
    const route = obj;
    close();
    setTimeout(() => triggerTestPulse(route), 50);
  };
  // Swatch click handlers — only present when a route is selected.
  for (const sw of ctxBarEl.querySelectorAll('.scada-fs-color-swatch')) {
    sw.onclick = async () => {
      const c = sw.dataset.color;
      try {
        const saved = await window.siteApi.put(
          `/api/site/routes/${obj.id}`, { color: c });
        if (saved) {
          Object.assign(obj, saved);
          paintCtx(); redraw();
        }
      } catch (e) {
        if (window.toast) window.toast('Colour save failed: ' + e.message, 'err');
      }
    };
  }
}

async function renameSelected() {
  const obj = currentSelection();
  if (!obj) return;
  const next = prompt('Rename', obj.name);
  if (!next || !next.trim() || next.trim() === obj.name) return;
  try {
    let saved;
    if (selectedKind === 'route') {
      saved = await window.siteApi.put(`/api/site/routes/${obj.id}`, { name: next.trim() });
    } else {
      saved = await window.siteApi.put(`/api/site/rooms/${obj.id}`,  { name: next.trim() });
    }
    if (saved) Object.assign(obj, saved);
    paintCtx(); redraw();
  } catch (e) {
    if (window.toast) window.toast('Rename failed: ' + e.message, 'err');
  }
}

// ── Pin properties modal (mount metadata) ────────────────────────────
//
// Opens when a pin is clicked in pan mode with no pathway selected.
// Editable fields:
//   - rotation_deg (pan)         — 0..359°
//   - fov_angle_deg (HFOV)       — 10..180°
//   - fov_range_m (range cap)    — 1..50 m
//   - mounting_height_m          — 0.5..25 m  (v1.4, enables 3D footprint)
//   - tilt_deg                   — 0..90°    (v1.4)
//   - vertical_fov_deg           — 5..179°   (v1.4)
//   - focal_length_mm            — 1..200 mm (v1.4, reference)
//
// Server: PUT /api/site/pins/{slot} with the changed fields. Empty/zero
// values clear the corresponding column → pin reverts to the flat
// 2D cone via the FOVFootprint fallback.
// renderElevationSVG — second 2D view of the camera. Top-down view
// is what the rest of the editor shows; this is the SIDE-elevation
// view of the same physical situation. Camera mounted at height h
// above ground, tilted down by tiltDeg with vertical FOV vfovDeg.
// Shows the vertical-plane cone projecting onto the ground line,
// plus operator-readable distance labels:
//
//   Height: h m         — mounting height
//   Blind spot: d_near  — distance from camera base before the FOV
//                         first touches the ground
//   Reaches: d_far      — distance to the far edge of the footprint
//                         (capped at range cap when geometry exceeds it)
//
// Pure SVG, no external deps. Called from the pin-properties slider
// handlers on every input so the elevation updates live alongside
// the top-down trapezoid behind the panel.
function renderElevationSVG(pin) {
  const u = (typeof units !== 'undefined' && units && units.formatFromMeters)
    ? units.formatFromMeters : (m => m.toFixed(1) + ' m');

  const h = pin.mounting_height_m || 0;
  const tilt = pin.tilt_deg || 0;
  const vfov = pin.vertical_fov_deg || 0;
  const range = pin.fov_range_m || 12;

  // viewBox bounded enough to fit everything we'll draw.
  const VBW = 280, VBH = 110;

  // If 3D not set, render an empty placeholder + hint.
  if (!(h > 0 && tilt > 0 && tilt < 90 && vfov > 0 && vfov < 180)) {
    return `<svg viewBox="0 0 ${VBW} ${VBH}" width="100%" height="${VBH}px"
                 xmlns="http://www.w3.org/2000/svg" style="display:block;">
      <line x1="14" y1="${VBH-22}" x2="${VBW-10}" y2="${VBH-22}"
            stroke="#3c3f47" stroke-width="1"/>
      <text x="${VBW/2}" y="${VBH/2}" text-anchor="middle"
            fill="#888a95" font-family="ui-monospace,monospace" font-size="10">
        Set mounting height + tilt + vertical FOV
      </text>
      <text x="${VBW/2}" y="${VBH/2 + 14}" text-anchor="middle"
            fill="#888a95" font-family="ui-monospace,monospace" font-size="9">
        to see the elevation cone
      </text>
    </svg>`;
  }

  // Two ray angles from horizontal (positive = downward, 0 = horizontal,
  // negative = above horizon):
  //   bottom ray = optical axis + half VFOV  (more downward edge)
  //   top    ray = optical axis - half VFOV  (less downward edge)
  // VFOV is the constant angular WIDTH of the cone; tilt rotates the
  // whole wedge around the camera apex. Both rays MUST rotate
  // together as tilt changes — that's what makes the cone visibly
  // tilt instead of just one leg moving.
  const halfVDeg = vfov / 2;
  const bottomDeg = tilt + halfVDeg;
  const topDeg    = tilt - halfVDeg;

  // Scale + camera position. Width must accommodate the furthest
  // ground hit (or be reasonable for nearly-horizontal cones that
  // don't hit ground within view).
  const padL = 22, padR = 14, padT = 14, padB = 26;
  const usableW = VBW - padL - padR;
  const usableH = VBH - padT - padB;
  // Pre-compute ground hits to pick a sensible scale before drawing.
  const groundHitM = (degBelowH) => {
    const a = degBelowH * Math.PI / 180;
    if (a <= 1e-3) return Infinity;   // above horizon or horizontal
    if (a >= Math.PI / 2) return 0;
    return h / Math.tan(a);
  };
  const topHitM    = groundHitM(topDeg);    // far end ground distance (∞ if shallow)
  const bottomHitM = groundHitM(bottomDeg); // near end ground distance
  const maxGroundM = isFinite(topHitM) ? topHitM : Math.max(range * 1.5, h * 4);
  const maxX = Math.max(maxGroundM + 1, range + 1, h * 1.5 + 1, 6);
  const maxY = Math.max(h * 1.4 + 1, 3);
  const scale = Math.min(usableW / maxX, usableH / maxY);

  const camX_vb = padL;
  const groundY_vb = VBH - padB;
  const camY_vb = groundY_vb - h * scale;
  const rightEdge_vb = VBW - padR;
  const topEdge_vb = padT;

  // Project a ray from the camera at angle θ (degrees below horizontal,
  // negative = above) to the first viewport boundary it crosses.
  // Returns {point, hitGround, distanceM}.
  const project = (degBelowH) => {
    const a = degBelowH * Math.PI / 180;
    const dx = Math.cos(a);   // > 0 for any sensible tilt (camera looks right)
    const dy = Math.sin(a);   // > 0 = downward in screen coords
    let tMin = Infinity;
    let hitGround = false;
    if (dx > 1e-6) {
      const tR = (rightEdge_vb - camX_vb) / dx;
      if (tR > 1e-6 && tR < tMin) tMin = tR;
    }
    if (dy > 1e-6) {
      const tG = (groundY_vb - camY_vb) / dy;
      if (tG > 1e-6 && tG < tMin) { tMin = tG; hitGround = true; }
    }
    if (dy < -1e-6) {
      const tT = (topEdge_vb - camY_vb) / dy;
      if (tT > 1e-6 && tT < tMin) { tMin = tT; hitGround = false; }
    }
    if (!isFinite(tMin)) tMin = 1;
    return {
      x: camX_vb + tMin * dx,
      y: camY_vb + tMin * dy,
      hitGround,
      distanceM: hitGround ? (camX_vb + tMin * dx - camX_vb) / scale : Infinity,
    };
  };
  const bottom = project(bottomDeg);
  const top    = project(topDeg);

  // Ground distances (metres from camera base) for the labels.
  const dBlind = bottom.hitGround ? bottom.distanceM : 0;
  const dReach = top.hitGround ? top.distanceM : Infinity;
  const rangeCapsReach = (range < dReach);

  const rangeCapX = camX_vb + range * scale;

  const dBlindStr = u(dBlind);
  const dReachStr = isFinite(dReach) ? u(dReach) : '∞';
  const rangeStr  = u(range);
  const hStr      = u(h);

  // Compute the cone-fill polygon. It's the wedge spanned by the two
  // rays from the camera. We walk the viewport boundary clockwise
  // from `bottom` to `top` so the polygon stays convex/sensible
  // regardless of where each ray exits. Endpoints sit on at most
  // two viewport edges (right + ground, or right + top); inserting
  // the shared corner closes the wedge cleanly when both rays exit
  // through different edges.
  //
  // Identify which edge each endpoint is on:
  //   'ground' (y == groundY_vb)
  //   'right'  (x == rightEdge_vb)
  //   'top'    (y == topEdge_vb)
  const edgeOf = (p) => {
    if (Math.abs(p.y - groundY_vb) < 0.5)  return 'ground';
    if (Math.abs(p.y - topEdge_vb) < 0.5)  return 'top';
    return 'right';
  };
  const bottomEdge = edgeOf(bottom);
  const topEdge    = edgeOf(top);
  const conePts = [`${camX_vb},${camY_vb}`, `${bottom.x.toFixed(1)},${bottom.y.toFixed(1)}`];
  // If bottom is on the GROUND and top is on the RIGHT/TOP edge, walk
  // right along the ground to the right edge, then up to the top
  // endpoint. This fills the entire visible wedge cleanly.
  if (bottomEdge === 'ground' && topEdge === 'right') {
    conePts.push(`${rightEdge_vb},${groundY_vb}`);
  } else if (bottomEdge === 'ground' && topEdge === 'top') {
    conePts.push(`${rightEdge_vb},${groundY_vb}`);
    conePts.push(`${rightEdge_vb},${topEdge_vb}`);
  } else if (bottomEdge === 'right' && topEdge === 'top') {
    conePts.push(`${rightEdge_vb},${topEdge_vb}`);
  }
  conePts.push(`${top.x.toFixed(1)},${top.y.toFixed(1)}`);
  const conePtsStr = conePts.join(' ');

  return `<svg viewBox="0 0 ${VBW} ${VBH}" width="100%" height="${VBH}px"
               xmlns="http://www.w3.org/2000/svg" style="display:block;">
    <!-- Ground level line -->
    <line x1="${padL - 4}" y1="${groundY_vb}" x2="${VBW - padR}" y2="${groundY_vb}"
          stroke="#5c5e66" stroke-width="1"/>
    <text x="${padL - 6}" y="${groundY_vb + 12}"
          fill="#888a95" font-family="ui-monospace,monospace" font-size="8">
      GROUND
    </text>

    <!-- Cone wedge filled by walking the two rays + viewport boundary.
         VFOV is the constant angular width; tilt rotates the wedge
         around the camera apex so BOTH rays move together. -->
    <polygon points="${conePtsStr}"
             fill="rgba(245,158,11,0.16)" stroke="none"/>
    <!-- Bottom ray (steeper, downward-most edge of cone) -->
    <line x1="${camX_vb}" y1="${camY_vb}" x2="${bottom.x.toFixed(1)}" y2="${bottom.y.toFixed(1)}"
          stroke="#f59e0b" stroke-width="1.3"/>
    <!-- Top ray (shallower, upper edge of cone) -->
    <line x1="${camX_vb}" y1="${camY_vb}" x2="${top.x.toFixed(1)}" y2="${top.y.toFixed(1)}"
          stroke="#f59e0b" stroke-width="1.3"/>

    ${rangeCapsReach && top.hitGround ? `
    <!-- Vertical dashed line at the operator's range cap. Only shown
         when the geometric reach exceeds it (otherwise the cone
         self-limits and the cap is irrelevant). -->
    <line x1="${rangeCapX}" y1="${camY_vb - 4}" x2="${rangeCapX}" y2="${groundY_vb}"
          stroke="#d95a50" stroke-width="1" stroke-dasharray="3,2"/>
    <text x="${rangeCapX}" y="${camY_vb - 6}"
          text-anchor="middle"
          fill="#d95a50" font-family="ui-monospace,monospace" font-size="8">
      cap ${escapeHTML(rangeStr)}
    </text>` : ''}

    <!-- Vertical pole from camera straight down (mounting height) -->
    <line x1="${camX_vb}" y1="${camY_vb}" x2="${camX_vb}" y2="${groundY_vb}"
          stroke="#5c5e66" stroke-width="1" stroke-dasharray="3,2"/>
    <text x="${camX_vb - 4}" y="${camY_vb + (groundY_vb - camY_vb) / 2 + 3}"
          text-anchor="end"
          fill="#ECE6D6" font-family="ui-monospace,monospace" font-size="9">
      h ${escapeHTML(hStr)}
    </text>

    <!-- Camera body -->
    <g transform="translate(${camX_vb}, ${camY_vb}) rotate(${tilt})">
      <rect x="-6" y="-4" width="12" height="8"
            fill="#ECE6D6" stroke="#0c0e13" stroke-width="1"/>
      <polygon points="6,-4 12,0 6,4" fill="#5c8bf2"/>
    </g>

    ${bottom.hitGround ? `
    <!-- Blind-spot marker (camera-base → where bottom ray hits ground) -->
    <line x1="${camX_vb}" y1="${groundY_vb - 1}" x2="${bottom.x.toFixed(1)}" y2="${groundY_vb - 1}"
          stroke="#d95a50" stroke-width="2"/>
    <text x="${(camX_vb + bottom.x) / 2}" y="${groundY_vb - 4}"
          text-anchor="middle"
          fill="#d95a50" font-family="ui-monospace,monospace" font-size="9">
      blind ${escapeHTML(dBlindStr)}
    </text>` : ''}

    ${top.hitGround ? `
    <!-- Reach label at the top ray's ground intersection -->
    <text x="${top.x.toFixed(1)}" y="${groundY_vb + 12}"
          text-anchor="${top.x > VBW - 35 ? 'end' : 'middle'}"
          fill="#86c26f" font-family="ui-monospace,monospace" font-size="9">
      reach ${escapeHTML(dReachStr)}
    </text>` : `
    <text x="${VBW - padR - 4}" y="${camY_vb + 4}"
          text-anchor="end"
          fill="#86c26f" font-family="ui-monospace,monospace" font-size="9">
      reach ∞ (above horizon)
    </text>`}

    <!-- Tilt label near the camera body -->
    <text x="${camX_vb + 16}" y="${camY_vb + 16}"
          fill="#5c8bf2" font-family="ui-monospace,monospace" font-size="9">
      tilt ${tilt}°
    </text>
  </svg>`;
}

let pinModalEl = null;
function openPinPropertiesModal(pin) {
  if (pinModalEl) pinModalEl.remove();

  // Snapshot original values so Cancel restores them. Slider drag
  // mutates the in-memory pin directly so redraw shows the new FOV
  // live; on cancel we replay the snapshot.
  const snapshot = {
    rotation_deg:      pin.rotation_deg || 0,
    fov_angle_deg:     pin.fov_angle_deg || 90,
    fov_range_m:       pin.fov_range_m || 12,
    mounting_height_m: pin.mounting_height_m,
    tilt_deg:          pin.tilt_deg,
    vertical_fov_deg:  pin.vertical_fov_deg,
    focal_length_mm:   pin.focal_length_mm,
    sensor_size:       pin.sensor_size || '',
  };
  const initV = (n) => (typeof n === 'number' && n > 0) ? n : 0;

  // Side-docked panel — does NOT cover the canvas. Operator can see
  // their FOV change live behind the panel as they drag sliders.
  pinModalEl = document.createElement('div');
  Object.assign(pinModalEl.style, {
    position: 'fixed', right: '14px', top: '70px',
    width: '320px', maxHeight: 'calc(100vh - 100px)',
    overflowY: 'auto',
    background: '#1a1d22', border: '1px solid #3c3f47', borderRadius: '6px',
    padding: '14px', zIndex: 10010,
    fontFamily: 'ui-monospace, monospace', color: '#ECE6D6',
    boxShadow: '0 8px 24px rgba(0,0,0,0.45)',
  });
  const sliderRow = (id, label, min, max, step, val, suffix, clearable) => `
    <div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;
                  font-size:11px;color:#888a95;margin-bottom:2px;">
        <span>${label}</span>
        <span id="${id}-val" style="color:#ECE6D6;font-family:ui-monospace,monospace;font-size:11px;">
          ${val > 0 ? val + suffix : (clearable ? '—' : (val + suffix))}
        </span>
      </div>
      <input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${val || min}"
             style="width:100%;accent-color:#f59e0b;cursor:pointer;">
    </div>`;
  pinModalEl.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <div style="font-size:13px;font-weight:700;">${escapeHTML(pin.cam_slot)}</div>
      <button id="scada-pp-close" title="Close (Cancel)"
              style="cursor:pointer;background:transparent;color:#888a95;border:none;
                     font-size:18px;line-height:1;padding:0 4px;">×</button>
    </div>
    <div style="font-size:11px;color:#888a95;margin-bottom:10px;">
      ${escapeHTML(cameraNameFor(pin.cam_slot) || pin.cam_slot)}
    </div>

    <!-- Side-elevation preview — vertical-plane view of camera + cone -->
    <div style="font-size:9px;color:#888a95;letter-spacing:.08em;text-transform:uppercase;margin-bottom:4px;display:flex;justify-content:space-between;">
      <span>Side view (elevation)</span>
      <span style="color:#5c8bf2;">vertical plane &amp; tilt</span>
    </div>
    <div id="scada-pp-elev" style="background:#0c0e13;border:1px solid #3c3f47;border-radius:3px;margin-bottom:10px;padding:6px;"></div>
    ${sliderRow('scada-pp-rot',   'Pan (rotation)', 0, 359, 1,
                snapshot.rotation_deg, '°', false)}
    ${sliderRow('scada-pp-hfov',  'Horizontal FOV', 10, 180, 5,
                snapshot.fov_angle_deg, '°', false)}
    ${sliderRow('scada-pp-range', 'Range cap',      1, 50, 1,
                snapshot.fov_range_m, ' m', false)}
    <div style="margin-top:10px;color:#888a95;font-size:9px;letter-spacing:.08em;text-transform:uppercase;border-top:1px solid #3c3f47;padding-top:8px;">Mount geometry (optional)</div>
    ${sliderRow('scada-pp-mh',    'Mounting height', 0, 25, 0.1,
                initV(snapshot.mounting_height_m), ' m', true)}
    ${sliderRow('scada-pp-tilt',  'Tilt down',       0, 90, 1,
                initV(snapshot.tilt_deg), '°', true)}
    ${sliderRow('scada-pp-vfov',  'Vertical FOV',    0, 179, 1,
                initV(snapshot.vertical_fov_deg), '°', true)}
    <div style="margin-bottom:8px;">
      <div style="font-size:11px;color:#888a95;margin-bottom:2px;">Sensor</div>
      <select id="scada-pp-sensor"
              style="width:100%;padding:4px;background:#0c0e13;color:#ECE6D6;
                     border:1px solid #3c3f47;border-radius:3px;font-family:inherit;
                     font-size:11px;box-sizing:border-box;">
        ${SENSOR_OPTIONS.map(o =>
          `<option value="${escapeAttr(o.value)}" ${(snapshot.sensor_size || '') === o.value ? 'selected' : ''}>${escapeHTML(o.label)}</option>`
        ).join('')}
      </select>
    </div>
    <div style="margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;
                  font-size:11px;color:#888a95;margin-bottom:2px;">
        <span>Focal length</span>
        <span id="scada-pp-focal-val" style="color:#ECE6D6;font-family:ui-monospace,monospace;font-size:11px;">
          ${(snapshot.focal_length_mm || 0) > 0 ? snapshot.focal_length_mm + ' mm' : '—'}
        </span>
      </div>
      <input id="scada-pp-focal" type="number" min="0" max="200" step="0.1"
             value="${initV(snapshot.focal_length_mm)}"
             placeholder="mm — e.g. 2.8, 4, 6"
             style="width:100%;padding:4px;background:#0c0e13;color:#ECE6D6;
                    border:1px solid #3c3f47;border-radius:3px;font-family:inherit;
                    font-size:11px;box-sizing:border-box;">
    </div>
    <div id="scada-pp-derived" style="font-size:10px;color:#86c26f;font-family:ui-monospace,monospace;
                                       background:#0c0e13;border:1px dashed #3c3f47;border-radius:3px;
                                       padding:4px 6px;margin-bottom:8px;display:none;">
      <span style="color:#888a95;">auto-derived from focal × sensor:</span>
      <span id="scada-pp-derived-text"></span>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:14px;">
      <button id="scada-pp-cancel" style="cursor:pointer;background:transparent;color:#888a95;border:1px solid #3c3f47;padding:5px 10px;border-radius:3px;font-family:inherit;font-size:11px;">Cancel</button>
      <button id="scada-pp-save"   style="cursor:pointer;background:#86c26f;color:#0c0e13;border:none;padding:5px 14px;border-radius:3px;font-family:inherit;font-weight:700;font-size:11px;">Save</button>
    </div>
  `;
  document.body.appendChild(pinModalEl);

  // Initial render of the side-elevation preview.
  const elevHost = $('scada-pp-elev');
  const repaintElev = () => {
    if (elevHost) elevHost.innerHTML = renderElevationSVG(pin);
  };
  repaintElev();

  // Wire each slider: drag → mutate pin in memory + update value
  // label + redraw canvas. The geometry render reads from `pins`
  // which `pin` is a member of, so mutating fields here flows
  // straight into the next redraw call.
  const wire = (id, key, suffix, clearable, parseFn) => {
    const el = $(id);
    const valEl = $(id + '-val');
    if (!el || !valEl) return;
    const updateLabel = () => {
      const n = parseFn(el.value);
      valEl.textContent = (n > 0) ? (n + suffix) : (clearable ? '—' : (n + suffix));
    };
    el.addEventListener('input', () => {
      const n = parseFn(el.value);
      pin[key] = (clearable && n <= 0) ? 0 : n;
      // Keep the pins cache pointing at the same object — redraw
      // reads from there directly.
      updateLabel();
      redraw();
      // The elevation preview shows mh/tilt/vfov/range; refresh
      // for any slider that might affect any of those values.
      repaintElev();
    });
    updateLabel();
  };
  wire('scada-pp-rot',   'rotation_deg',      '°',  false, v => parseInt(v, 10) || 0);
  wire('scada-pp-hfov',  'fov_angle_deg',     '°',  false, v => parseInt(v, 10) || 90);
  wire('scada-pp-range', 'fov_range_m',       ' m', false, v => parseInt(v, 10) || 12);

  // 3D mount geometry — the trapezoidal/visibility model needs ALL
  // THREE (mh + tilt + vfov) to compute anything. Dragging one in
  // isolation gives the operator no visible feedback because the
  // math falls back to the flat cone. Auto-snap the other two to
  // sensible defaults (wall-mounted security camera typical) so any
  // single slider drag immediately turns the FOV into a calibrated
  // trapezoid. Operator can still set each slider to 0 to clear it.
  const ensure3DDefaults = (touched) => {
    if (touched === 'mounting_height_m' || (pin.mounting_height_m || 0) > 0) {} else {
      pin.mounting_height_m = 3.0;
    }
    if (touched === 'tilt_deg' || (pin.tilt_deg || 0) > 0) {} else {
      pin.tilt_deg = 25;
    }
    if (touched === 'vertical_fov_deg' || (pin.vertical_fov_deg || 0) > 0) {} else {
      pin.vertical_fov_deg = 50;
    }
    // Reflect the new defaults in the sliders + value labels.
    const sync = (id, key, suffix) => {
      const el = $(id);
      const v = pin[key] || 0;
      if (el) el.value = v;
      const vEl = $(id + '-val');
      if (vEl) vEl.textContent = v > 0 ? (v + suffix) : '—';
    };
    sync('scada-pp-mh',   'mounting_height_m', ' m');
    sync('scada-pp-tilt', 'tilt_deg',          '°');
    sync('scada-pp-vfov', 'vertical_fov_deg',  '°');
  };
  const wire3D = (id, key, suffix) => {
    const el = $(id);
    const valEl = $(id + '-val');
    if (!el || !valEl) return;
    el.addEventListener('input', () => {
      const n = parseFloat(el.value) || 0;
      pin[key] = n;
      if (n > 0) ensure3DDefaults(key);
      valEl.textContent = (pin[key] || 0) > 0 ? (pin[key] + suffix) : '—';
      redraw();
      repaintElev();
    });
  };
  wire3D('scada-pp-mh',   'mounting_height_m', ' m');
  wire3D('scada-pp-tilt', 'tilt_deg',          '°');
  wire3D('scada-pp-vfov', 'vertical_fov_deg',  '°');
  // Sensor + focal length auto-derive HFOV + VFOV when both are set.
  // Operator can still slide HFOV/VFOV manually afterwards (manual
  // override sticks until they touch sensor or focal again).
  const recomputeFromSensorFocal = () => {
    const s = sensorByValue(pin.sensor_size || '');
    const f = pin.focal_length_mm || 0;
    const dEl = $('scada-pp-derived');
    const dTxt = $('scada-pp-derived-text');
    if (s && s.w > 0 && f > 0) {
      const hfov = fovFromFocalSensor(f, s.w);
      const vfov = fovFromFocalSensor(f, s.h);
      pin.fov_angle_deg    = Math.round(hfov);
      pin.vertical_fov_deg = Math.round(vfov);
      // Sync sliders.
      const setSlider = (id, val, suffix) => {
        const el = $(id);
        const vEl = $(id + '-val');
        if (el) el.value = val;
        if (vEl) vEl.textContent = (val > 0) ? (val + suffix) : '—';
      };
      setSlider('scada-pp-hfov', Math.round(hfov), '°');
      setSlider('scada-pp-vfov', Math.round(vfov), '°');
      // Show derived hint.
      if (dEl) dEl.style.display = '';
      if (dTxt) dTxt.textContent = ` HFOV ${hfov.toFixed(1)}° · VFOV ${vfov.toFixed(1)}°`;
      ensure3DDefaults('vertical_fov_deg');
      redraw();
      repaintElev();
    } else {
      if (dEl) dEl.style.display = 'none';
    }
  };
  $('scada-pp-sensor').addEventListener('change', () => {
    pin.sensor_size = $('scada-pp-sensor').value;
    recomputeFromSensorFocal();
  });
  $('scada-pp-focal').addEventListener('input', () => {
    const n = parseFloat($('scada-pp-focal').value);
    pin.focal_length_mm = (isFinite(n) && n > 0) ? n : 0;
    $('scada-pp-focal-val').textContent = pin.focal_length_mm > 0
      ? pin.focal_length_mm + ' mm' : '—';
    recomputeFromSensorFocal();
  });
  // Initial pass — show derived hint immediately if both are already set.
  recomputeFromSensorFocal();

  const close = () => { pinModalEl && pinModalEl.remove(); pinModalEl = null; };
  const cancel = () => {
    Object.assign(pin, snapshot);
    redraw();
    close();
  };
  $('scada-pp-close').onclick  = cancel;
  $('scada-pp-cancel').onclick = cancel;
  $('scada-pp-save').onclick = async () => {
    const f = currentFloor();
    if (!f) { close(); return; }
    const body = {
      floor_id: f.id,
      x_pct: pin.x_pct,
      y_pct: pin.y_pct,
      label: pin.label || '',
      rotation_deg: pin.rotation_deg || 0,
      fov_angle_deg: pin.fov_angle_deg || 90,
      fov_range_m:   pin.fov_range_m || 12,
      mounting_height_m: pin.mounting_height_m || 0,
      tilt_deg:          pin.tilt_deg || 0,
      vertical_fov_deg:  pin.vertical_fov_deg || 0,
      focal_length_mm:   pin.focal_length_mm || 0,
      sensor_size:       pin.sensor_size || '',
    };
    try {
      const saved = await window.siteApi.put(`/api/site/pins/${pin.cam_slot}`, body);
      if (saved) {
        Object.assign(pin, saved);
        const i = pins.findIndex(x => x.cam_slot === pin.cam_slot);
        if (i >= 0) pins[i] = saved;
        redraw();
        if (window.toast) window.toast(`Saved ${pin.cam_slot}`, 'ok');
      }
    } catch (e) {
      if (window.toast) window.toast('Save failed: ' + e.message, 'err');
    }
    close();
  };
}

function cameraNameFor(slot) {
  const c = cameras.find(x => x && x.id === slot);
  return c ? (c.name || '') : '';
}

// extractWalls — collects every edge of every area polygon and the
// floor outline as wall segments. Each wall is [[x_pct, y_pct], [x_pct,
// y_pct]] in floor pct space. These segments are the occluders the
// visibility polygon stops at — operator-traced room outlines double
// as opaque walls. Doorways are operator-defined gaps (just leave the
// room polygon open through the doorway).
function extractWalls(floor, roomList) {
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
  for (const r of (roomList || [])) add(r.polygon);
  return walls;
}

// raySegmentIntersect — returns t (in metres) at which ray from
// (origin + t * (dx, dy)) crosses segment [a, b]. Returns Infinity
// when no intersection (parallel or behind ray). dx, dy are in
// pct-per-metre (so t comes out as metres). Origin in pct.
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

// computeVisibilityPolygon — ray-cast from the camera at evenly-spaced
// angles spanning the HFOV. Each ray stops at the nearest wall hit
// (or maxRangeM if no wall). The result is a fan polygon: camera
// position + sequence of ray endpoints in angular order.
//
// Convention matches the rest of the geometry: pan 0° aims -y in
// screen space, clockwise positive. anisotropic pct↔metre mapping
// uses floorWidthM / floorHeightM so distances are physically
// correct regardless of aspect ratio.
//
// N (ray count) = 48 per pin. At 90° HFOV that's a ray every 1.9°.
// Increase for sharper edges; cost is O(N × walls).
const VIS_RAYS = 48;
function computeVisibilityPolygon(
  cameraPct, panDeg, hfovDeg, maxRangeM, walls, floorWM, floorHM,
) {
  if (!(maxRangeM > 0) || !(floorWM > 0) || !(floorHM > 0)) return null;
  const panRad = panDeg * Math.PI / 180;
  const halfH = hfovDeg / 2 * Math.PI / 180;
  const poly = [cameraPct];
  for (let i = 0; i <= VIS_RAYS; i++) {
    // Map ray index to absolute world angle. ray angle 0 = aim -y
    // (matches pan=0). Local angle in [-halfH, +halfH] from optical
    // axis; add pan to get world angle.
    const localOff = -halfH + (2 * halfH) * (i / VIS_RAYS);
    const theta = panRad + localOff;
    // pct-per-metre direction. pan=0 means dx = sin(0)/floorWM = 0,
    // dy = -cos(0)/floorHM = -1/floorHM (i.e., move toward -y).
    const dx = Math.sin(theta) / floorWM;
    const dy = -Math.cos(theta) / floorHM;

    let nearestT = maxRangeM;
    for (const w of walls) {
      const t = raySegmentIntersect(cameraPct, dx, dy, w[0], w[1]);
      if (t < nearestT) nearestT = t;
    }
    poly.push([
      cameraPct[0] + nearestT * dx,
      cameraPct[1] + nearestT * dy,
    ]);
  }
  return poly;
}

// computeFOVFootprintPct — JS mirror of FOVFootprint() in
// nvrd-core/pkg/recorder/site_view_geometry.go. Returns the polygon as
// an array of [x_pct, y_pct] points in [0, 1] floor pct space, ready
// to project to viewBox pixels by multiplying by W and H.
//
// Convention matches the server:
//   - rotation 0° aims toward -y (up in screen coords)
//   - rotation increases clockwise
//   - tilt is the downward angle from horizontal (0 = looking straight
//     out, 90 = looking straight down)
//
// When mount data isn't set OR the floor is uncalibrated, returns the
// legacy 3-vertex flat cone (apex + 2 base corners) — same fallback
// the server uses.
function computeFOVFootprintPct(args) {
  const {
    xPct, yPct, rotationDeg, hfovDeg, rangeM,
    mountingHeightM, tiltDeg, vfovDeg,
    floorWidthM, floorHeightM,
  } = args;

  if (!(hfovDeg > 0) || !(rangeM > 0) ||
      !(floorWidthM > 0) || !(floorHeightM > 0)) {
    return null;   // No floor scale — skip footprint, just show the dot.
  }

  const useTrap = (mountingHeightM > 0 && tiltDeg > 0 && tiltDeg < 90 &&
                   vfovDeg > 0 && vfovDeg < 180);
  const rot = rotationDeg * Math.PI / 180;
  const halfH = hfovDeg / 2 * Math.PI / 180;
  // Forward = unit vector in pan direction (matches server math).
  const fx = Math.sin(rot), fy = -Math.cos(rot);
  // Right = perpendicular, clockwise.
  const rx = Math.cos(rot), ry = Math.sin(rot);
  const projMetric = (mx, my) => [
    xPct + mx / floorWidthM,
    yPct + my / floorHeightM,
  ];

  if (!useTrap) {
    // Flat cone — apex + 2 base corners, same as Go's ConePolygon.
    const apex = [xPct, yPct];
    // Left & right cone edge unit vectors.
    const leftDx  = -Math.sin(halfH) * Math.cos(rot) - (-Math.cos(halfH)) * Math.sin(rot);
    const leftDy  = -Math.sin(halfH) * Math.sin(rot) + (-Math.cos(halfH)) * Math.cos(rot);
    const rightDx =  Math.sin(halfH) * Math.cos(rot) - (-Math.cos(halfH)) * Math.sin(rot);
    const rightDy =  Math.sin(halfH) * Math.sin(rot) + (-Math.cos(halfH)) * Math.cos(rot);
    const left  = projMetric(leftDx  * rangeM, leftDy  * rangeM);
    const right = projMetric(rightDx * rangeM, rightDy * rangeM);
    return [apex, left, right];
  }

  // Trapezoid: top of frame (less downward) → far edge; bottom of
  // frame (more downward) → near edge.
  const halfV = vfovDeg / 2 * Math.PI / 180;
  const tiltRad = tiltDeg * Math.PI / 180;
  const farAngle  = tiltRad - halfV;
  const nearAngle = tiltRad + halfV;

  let dFar, dNear;
  if (farAngle <= 1e-3) {
    dFar = rangeM;                    // above horizon — cap at rangeM
  } else if (farAngle >= Math.PI / 2) {
    dFar = 0;
  } else {
    dFar = mountingHeightM / Math.tan(farAngle);
    if (dFar > rangeM) dFar = rangeM;
  }
  if (nearAngle >= Math.PI / 2 - 1e-3) {
    dNear = 0;
  } else if (nearAngle <= 0) {
    dNear = rangeM;
  } else {
    dNear = mountingHeightM / Math.tan(nearAngle);
  }

  const wFar  = dFar  * Math.tan(halfH);
  const wNear = dNear * Math.tan(halfH);

  // Near-left, far-left, far-right, near-right (clockwise).
  return [
    projMetric(dNear * fx - wNear * rx, dNear * fy - wNear * ry),
    projMetric(dFar  * fx - wFar  * rx, dFar  * fy - wFar  * ry),
    projMetric(dFar  * fx + wFar  * rx, dFar  * fy + wFar  * ry),
    projMetric(dNear * fx + wNear * rx, dNear * fy + wNear * ry),
  ];
}

// Click-to-toggle pin membership in the currently-selected pathway.
// Saves immediately; updates the selected route in-place; refreshes
// the context bar so the camera count chip is current.
async function togglePinOnRoute(route, camSlot) {
  const cams = Array.isArray(route.cameras) ? route.cameras.slice() : [];
  const idx = cams.indexOf(camSlot);
  const adding = (idx < 0);
  if (adding) cams.push(camSlot);
  else        cams.splice(idx, 1);
  try {
    const saved = await window.siteApi.put(
      `/api/site/routes/${route.id}`, { cameras: cams });
    if (saved) {
      Object.assign(route, saved);
      paintCtx();
      redraw();
      if (window.toast) window.toast(
        adding
          ? `Added ${camSlot} to "${route.name}"`
          : `Removed ${camSlot} from "${route.name}"`,
        'ok');
    }
  } catch (e) {
    if (window.toast) window.toast('Update failed: ' + e.message, 'err');
  }
}

async function deleteSelected() {
  const obj = currentSelection();
  if (!obj) return;
  if (!confirm(`Delete ${selectedKind === 'route' ? 'pathway' : 'area'} "${obj.name}"?`)) return;
  try {
    if (selectedKind === 'route') {
      await window.siteApi.del(`/api/site/routes/${obj.id}`);
      routes = routes.filter(r => r.id !== obj.id);
    } else {
      await window.siteApi.del(`/api/site/rooms/${obj.id}`);
      rooms = rooms.filter(r => r.id !== obj.id);
    }
    selectedKind = null; selectedId = null;
    paintCtx(); redraw(); paintStatus();
  } catch (e) {
    if (window.toast) window.toast('Delete failed: ' + e.message, 'err');
  }
}

function currentSelection() {
  if (!selectedKind || !selectedId) return null;
  return (selectedKind === 'route' ? routes : rooms).find(x => x.id === selectedId) || null;
}

// ── Camera picker modal ────────────────────────────────────────────────
function openCameraPicker(route) {
  const modal = document.createElement('div');
  Object.assign(modal.style, {
    position: 'fixed', inset: '0', background: 'rgba(0,0,0,0.7)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10010,
  });
  const assigned = new Set(route.cameras || []);
  const camRows = cameras.map(c => `
    <label style="display:flex;align-items:center;gap:8px;padding:6px;
                  cursor:pointer;border-radius:3px;
                  background:${assigned.has(c.id) ? 'rgba(92,139,242,0.15)' : 'transparent'};">
      <input type="checkbox" data-cam="${escapeAttr(c.id)}" ${assigned.has(c.id) ? 'checked' : ''}
             style="width:14px;height:14px;cursor:pointer;">
      <span style="font-family:ui-monospace,monospace;font-size:11px;color:#888a95;width:48px;">${escapeHTML(c.id)}</span>
      <span style="font-size:12px;">${escapeHTML(c.name || c.id)}</span>
    </label>`).join('') ||
    `<div style="color:#888a95;font-size:11px;padding:8px;">No cameras configured on this device.</div>`;
  modal.innerHTML = `
    <div style="background:#1a1d22;border:1px solid #3c3f47;border-radius:6px;
                padding:20px;width:480px;max-height:80vh;display:flex;flex-direction:column;
                font-family:ui-monospace,monospace;color:#ECE6D6;">
      <div style="font-size:14px;font-weight:700;margin-bottom:6px;">Cameras on "${escapeHTML(route.name)}"</div>
      <div style="font-size:11px;color:#888a95;margin-bottom:12px;">
        Tick the cameras that watch this pathway. Order matches the
        ticked sequence below — drag-reorder coming in a later pass.
      </div>
      <div style="flex:1;overflow-y:auto;border:1px solid #3c3f47;
                  border-radius:4px;padding:6px;margin-bottom:12px;">
        ${camRows}
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="scada-fs-cams-cancel" style="cursor:pointer;background:transparent;color:#888a95;border:1px solid #3c3f47;padding:6px 12px;border-radius:3px;font-family:inherit;">Cancel</button>
        <button id="scada-fs-cams-save"   style="cursor:pointer;background:#86c26f;color:#0c0e13;border:none;padding:6px 12px;border-radius:3px;font-family:inherit;font-weight:700;">Save</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  $('scada-fs-cams-cancel').onclick = () => modal.remove();
  $('scada-fs-cams-save').onclick = async () => {
    const picked = [];
    for (const el of modal.querySelectorAll('input[type=checkbox][data-cam]')) {
      if (el.checked) picked.push(el.dataset.cam);
    }
    try {
      const saved = await window.siteApi.put(
        `/api/site/routes/${route.id}`, { cameras: picked });
      if (saved) {
        Object.assign(route, saved);
        if (window.toast) window.toast(`Saved ${picked.length} cameras on "${route.name}"`, 'ok');
        paintCtx();
      }
    } catch (e) {
      if (window.toast) window.toast('Save failed: ' + e.message, 'err');
    }
    modal.remove();
  };
}

// ── Render layer ──────────────────────────────────────────────────────
function redraw() {
  if (!svgEl || !imgEl || !imgEl.naturalWidth) return;
  svgEl.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const W = imgEl.naturalWidth, H = imgEl.naturalHeight;
  const px = (xPct) => xPct * W;
  const py = (yPct) => yPct * H;
  const z = (n) => n / zoom;       // helper: keep stroke widths visually constant

  const f = currentFloor();

  // 1. Floor outline.
  if (f && Array.isArray(f.outline) && f.outline.length >= 3) {
    const pts = f.outline.map(p => `${px(p.x_pct).toFixed(1)},${py(p.y_pct).toFixed(1)}`).join(' ');
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'rgba(245,158,11,0.05)');
    poly.setAttribute('stroke', '#f59e0b');
    poly.setAttribute('stroke-width', String(z(2.5)));
    poly.setAttribute('stroke-dasharray', `${z(8)} ${z(6)}`);
    poly.style.pointerEvents = 'none';
    svgEl.appendChild(poly);
  }

  // 2. Areas.
  for (const r of rooms) {
    if (!Array.isArray(r.polygon) || r.polygon.length < 3) continue;
    const sel = (selectedKind === 'area' && selectedId === r.id);
    const pts = r.polygon.map(p => `${px(p.x_pct).toFixed(1)},${py(p.y_pct).toFixed(1)}`).join(' ');
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', sel ? 'rgba(134,194,111,0.28)' : 'rgba(134,194,111,0.10)');
    poly.setAttribute('stroke', '#86c26f');
    poly.setAttribute('stroke-width', String(z(sel ? 3 : 1.8)));
    poly.style.cursor = 'pointer';
    poly.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (activeTool !== 'pan') return;
      selectedKind = 'area'; selectedId = r.id;
      paintCtx(); redraw();
    });
    svgEl.appendChild(poly);
    // Label at centroid.
    const cx = r.polygon.reduce((a, p) => a + p.x_pct, 0) / r.polygon.length;
    const cy = r.polygon.reduce((a, p) => a + p.y_pct, 0) / r.polygon.length;
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', String(px(cx)));
    txt.setAttribute('y', String(py(cy)));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('dominant-baseline', 'middle');
    txt.setAttribute('fill', '#ECE6D6');
    txt.setAttribute('font-family', 'ui-monospace, monospace');
    txt.setAttribute('font-size', String(z(13)));
    txt.setAttribute('font-weight', '700');
    txt.style.pointerEvents = 'none';
    txt.style.textShadow = '0 0 4px #0c0e13';
    txt.textContent = r.name;
    svgEl.appendChild(txt);
  }

  // 3. Pathways.
  for (const r of routes) {
    if (!Array.isArray(r.waypoints) || r.waypoints.length < 2) continue;
    const sel = (selectedKind === 'route' && selectedId === r.id);
    const colour = colorForRoute(r);
    const pts = r.waypoints.map(p => `${px(p.x_pct).toFixed(1)},${py(p.y_pct).toFixed(1)}`).join(' ');
    const line = document.createElementNS(ns, 'polyline');
    line.setAttribute('points', pts);
    line.setAttribute('fill', 'none');
    line.setAttribute('stroke', colour);
    line.setAttribute('stroke-opacity', sel ? '1' : '0.75');
    line.setAttribute('stroke-width', String(z(sel ? 5 : 3.5)));
    line.setAttribute('stroke-linecap', 'round');
    line.setAttribute('stroke-linejoin', 'round');
    line.style.cursor = 'pointer';
    line.style.pointerEvents = 'stroke';
    line.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (activeTool !== 'pan') return;
      selectedKind = 'route'; selectedId = r.id;
      paintCtx(); redraw();
    });
    svgEl.appendChild(line);
    for (const p of r.waypoints) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(px(p.x_pct)));
      c.setAttribute('cy', String(py(p.y_pct)));
      c.setAttribute('r', String(z(sel ? 5 : 3.5)));
      c.setAttribute('fill', colour);
      c.setAttribute('stroke', '#0c0e13');
      c.setAttribute('stroke-width', String(z(1.5)));
      c.style.pointerEvents = 'none';
      svgEl.appendChild(c);
    }
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', String(px(r.waypoints[0].x_pct) + z(8)));
    txt.setAttribute('y', String(py(r.waypoints[0].y_pct) - z(8)));
    txt.setAttribute('fill', '#ECE6D6');
    txt.setAttribute('font-family', 'ui-monospace, monospace');
    txt.setAttribute('font-size', String(z(12)));
    txt.setAttribute('font-weight', '700');
    txt.style.pointerEvents = 'none';
    txt.style.textShadow = '0 0 4px #0c0e13';
    txt.textContent = r.name;
    svgEl.appendChild(txt);
  }

  // 4. In-progress polygon/polyline.
  if ((activeTool === 'path-poly' || activeTool === 'area-poly' || activeTool === 'outline-poly')
      && currentPoly.length > 0) {
    const colour = (activeTool === 'path-poly') ? '#5c8bf2'
                  : (activeTool === 'area-poly') ? '#86c26f' : '#f59e0b';
    const pts = currentPoly.map(p => `${px(p.x_pct).toFixed(1)},${py(p.y_pct).toFixed(1)}`).join(' ');
    if (currentPoly.length >= 2) {
      const el = document.createElementNS(ns, 'polyline');
      el.setAttribute('points', pts);
      el.setAttribute('fill', 'none');
      el.setAttribute('stroke', colour);
      el.setAttribute('stroke-width', String(z(4)));
      el.setAttribute('stroke-dasharray', `${z(8)} ${z(4)}`);
      el.style.pointerEvents = 'none';
      svgEl.appendChild(el);
    }
    for (const p of currentPoly) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(px(p.x_pct)));
      c.setAttribute('cy', String(py(p.y_pct)));
      c.setAttribute('r', String(z(6)));
      c.setAttribute('fill', colour);
      c.setAttribute('stroke', '#0c0e13');
      c.setAttribute('stroke-width', String(z(2)));
      c.style.pointerEvents = 'none';
      svgEl.appendChild(c);
    }
  }

  // 5. In-progress rectangle.
  if ((activeTool === 'area-rect' || activeTool === 'outline-rect') && rectAnchor && rectCurrent) {
    const colour = (activeTool === 'area-rect') ? '#86c26f' : '#f59e0b';
    const x = Math.min(rectAnchor.x_pct, rectCurrent.x_pct);
    const y = Math.min(rectAnchor.y_pct, rectCurrent.y_pct);
    const w = Math.abs(rectCurrent.x_pct - rectAnchor.x_pct);
    const h = Math.abs(rectCurrent.y_pct - rectAnchor.y_pct);
    const rect = document.createElementNS(ns, 'rect');
    rect.setAttribute('x', String(px(x))); rect.setAttribute('y', String(py(y)));
    rect.setAttribute('width', String(px(w))); rect.setAttribute('height', String(py(h)));
    rect.setAttribute('fill', `${colour === '#86c26f' ? 'rgba(134,194,111,0.18)' : 'rgba(245,158,11,0.10)'}`);
    rect.setAttribute('stroke', colour);
    rect.setAttribute('stroke-width', String(z(3)));
    rect.setAttribute('stroke-dasharray', `${z(8)} ${z(4)}`);
    rect.style.pointerEvents = 'none';
    svgEl.appendChild(rect);
  }

  // 4b. Camera pins — always visible. When a pathway is selected,
  //    pins assigned to it glow in the path's colour; click any pin
  //    to toggle membership (immediate save). This is the primary
  //    camera-to-path mapping UX — operators rarely need the modal
  //    picker once they've used this.
  const selRoute = (selectedKind === 'route' && selectedId)
    ? routes.find(r => r.id === selectedId) : null;
  const routeColour = selRoute ? colorForRoute(selRoute) : null;
  let pinsRendered = 0, pinsSkipped = 0;
  const floorWM = (f && typeof f.width_m  === 'number') ? f.width_m  : 0;
  const floorHM = (f && typeof f.height_m === 'number') ? f.height_m : 0;
  // Walls drive the wall-aware FOV clipping below — every area polygon
  // edge + the floor outline edges are occluders. Cached per redraw;
  // O(rooms + outline) so cheap even with 50 rooms.
  const walls = extractWalls(f, rooms);
  for (const p of pins) {
    // IMPORTANT: pin coords use the LEGACY 0-100 percentage scale,
    // not the 0-1 fraction the v1.2+ polygons (routes, rooms, outline)
    // use. We divide by 100 to normalise. Without this, every real
    // pin fails the bounds check and silently drops to "0 cameras"
    // on the canvas (the bug shipped in v1.3b — fixed v1.3c).
    const xPct = Number(p.x_pct) / 100;
    const yPct = Number(p.y_pct) / 100;
    if (!isFinite(xPct) || !isFinite(yPct) ||
        xPct < 0 || xPct > 1 || yPct < 0 || yPct > 1) {
      pinsSkipped++;
      continue;
    }
    pinsRendered++;
    const cx = xPct * W, cy = yPct * H;
    const onRoute = !!(selRoute && Array.isArray(selRoute.cameras)
      && selRoute.cameras.includes(p.cam_slot));
    const colour = onRoute ? routeColour : '#f59e0b';

    // FOV footprint — three render paths:
    //   A) walls present AND floor calibrated → wall-aware visibility
    //      polygon (fan of rays clipped by area + outline edges).
    //   B) floor calibrated but no walls         → geometric trapezoid
    //      (or flat cone if mount data is missing).
    //   C) floor uncalibrated                    → no footprint.
    // The wall-aware polygon is what the operator actually wants to
    // see: cameras don't see through walls.
    let fovPolyPct = null;
    let usedVisibility = false;
    const accurate3D = (p.mounting_height_m > 0 && p.tilt_deg > 0 && p.vertical_fov_deg > 0);
    if (walls.length > 0 && floorWM > 0 && floorHM > 0) {
      // Effective max range: trapezoid's far distance when mount data
      // is set, otherwise fov_range_m as-is. For wall-aware visibility
      // we don't need the trapezoid's near distance — walls dominate.
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
      fovPolyPct = computeVisibilityPolygon(
        [xPct, yPct], p.rotation_deg || 0, p.fov_angle_deg || 90,
        effRange, walls, floorWM, floorHM);
      usedVisibility = true;
    } else {
      fovPolyPct = computeFOVFootprintPct({
        xPct, yPct,
        rotationDeg: p.rotation_deg || 0,
        hfovDeg: p.fov_angle_deg || 90,
        rangeM:  p.fov_range_m || 12,
        mountingHeightM: p.mounting_height_m || 0,
        tiltDeg:         p.tilt_deg || 0,
        vfovDeg:         p.vertical_fov_deg || 0,
        floorWidthM:  floorWM,
        floorHeightM: floorHM,
      });
    }
    if (fovPolyPct && fovPolyPct.length >= 3) {
      const ptsStr = fovPolyPct.map(pt =>
        `${(pt[0] * W).toFixed(1)},${(pt[1] * H).toFixed(1)}`).join(' ');
      const fov = document.createElementNS(ns, 'polygon');
      fov.setAttribute('points', ptsStr);
      // Three visual styles map to the three render paths:
      //   visibility (walls aware):     brightest amber, bold stroke
      //   trapezoid (3D mount, no walls): bright amber
      //   flat cone (legacy):           faint amber
      let fill, stroke, sw;
      if (usedVisibility) {
        fill   = 'rgba(245,158,11,0.20)';
        stroke = 'rgba(245,158,11,0.80)';
        sw     = z(1.6);
      } else if (accurate3D) {
        fill   = 'rgba(245,158,11,0.18)';
        stroke = 'rgba(245,158,11,0.70)';
        sw     = z(1.4);
      } else {
        fill   = 'rgba(245,158,11,0.08)';
        stroke = 'rgba(245,158,11,0.35)';
        sw     = z(1);
      }
      fov.setAttribute('fill',   fill);
      fov.setAttribute('stroke', stroke);
      fov.setAttribute('stroke-width', String(sw));
      fov.style.pointerEvents = 'none';
      svgEl.appendChild(fov);
    }

    // Outer glow ring — always present for visibility, brighter when
    // the pin is on the selected pathway.
    const glow = document.createElementNS(ns, 'circle');
    glow.setAttribute('cx', String(cx)); glow.setAttribute('cy', String(cy));
    glow.setAttribute('r', String(z(onRoute ? 26 : 22)));
    glow.setAttribute('fill', 'none');
    glow.setAttribute('stroke', colour);
    glow.setAttribute('stroke-width', String(z(onRoute ? 3 : 1.5)));
    glow.setAttribute('opacity', onRoute ? '0.8' : '0.45');
    glow.style.pointerEvents = 'none';
    svgEl.appendChild(glow);

    // Pin dot — bigger + filled by default so it's unmistakable.
    const dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', String(cx)); dot.setAttribute('cy', String(cy));
    dot.setAttribute('r', String(z(18)));
    dot.setAttribute('fill', onRoute ? colour : '#0c0e13');
    dot.setAttribute('stroke', colour);
    dot.setAttribute('stroke-width', String(z(2.5)));
    dot.style.cursor = 'pointer';
    // Title for hover tooltip.
    const title = document.createElementNS(ns, 'title');
    const camLabel = p.label || cameraNameFor(p.cam_slot) || p.cam_slot;
    title.textContent = selRoute
      ? `${p.cam_slot} — ${camLabel} — click to ${onRoute ? 'remove from' : 'add to'} "${selRoute.name}"`
      : `${p.cam_slot} — ${camLabel} — click to edit camera properties`;
    dot.appendChild(title);
    dot.addEventListener('click', (ev) => {
      ev.stopPropagation();
      if (selRoute) {
        togglePinOnRoute(selRoute, p.cam_slot);
      } else {
        // No route selected → pin click opens the camera-properties
        // modal. Lets the operator set mount height / tilt / VFOV /
        // focal length per pin — feeds the new trapezoidal footprint.
        openPinPropertiesModal(p);
      }
    });
    svgEl.appendChild(dot);

    // Camera number — monospaced, white on filled pin / colour on outline pin.
    const txt = document.createElementNS(ns, 'text');
    txt.setAttribute('x', String(cx));
    txt.setAttribute('y', String(cy + z(5)));
    txt.setAttribute('text-anchor', 'middle');
    txt.setAttribute('fill', onRoute ? '#0c0e13' : '#fff');
    txt.setAttribute('font-family', 'ui-monospace, monospace');
    txt.setAttribute('font-size', String(z(14)));
    txt.setAttribute('font-weight', '800');
    txt.style.pointerEvents = 'none';
    txt.style.userSelect = 'none';
    txt.textContent = String(p.cam_slot).replace(/^cam/, '');
    svgEl.appendChild(txt);
  }
  if (pinsSkipped > 0) {
    console.warn(`[scada-fs] skipped ${pinsSkipped} pin(s) with bad coords`);
  }
  // Sanity probe: log on every redraw is noisy; only on first render
  // after a load.
  if (pinsRendered !== (window.__scadaFsLastPinCount || -1)) {
    window.__scadaFsLastPinCount = pinsRendered;
    console.log(`[scada-fs] rendered ${pinsRendered} pin(s) of ${pins.length} loaded`);
  }

  // 6. Calibration line in progress.
  if (activeTool === 'cal-line' && calPts.length > 0) {
    if (calPts.length === 2) {
      const line = document.createElementNS(ns, 'line');
      line.setAttribute('x1', String(px(calPts[0].x_pct)));
      line.setAttribute('y1', String(py(calPts[0].y_pct)));
      line.setAttribute('x2', String(px(calPts[1].x_pct)));
      line.setAttribute('y2', String(py(calPts[1].y_pct)));
      line.setAttribute('stroke', '#f59e0b');
      line.setAttribute('stroke-width', String(z(3)));
      line.setAttribute('stroke-dasharray', `${z(6)} ${z(4)}`);
      line.style.pointerEvents = 'none';
      svgEl.appendChild(line);
    }
    for (const p of calPts) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', String(px(p.x_pct))); c.setAttribute('cy', String(py(p.y_pct)));
      c.setAttribute('r', String(z(6)));
      c.setAttribute('fill', '#f59e0b'); c.setAttribute('stroke', '#0c0e13');
      c.setAttribute('stroke-width', String(z(2)));
      c.style.pointerEvents = 'none';
      svgEl.appendChild(c);
    }
  }
}

function paintStatus() {
  if (!statusEl) return;
  const f = currentFloor();
  const parts = [];
  if (f) {
    parts.push(`Floor: ${f.name}`);
    if (typeof f.width_m === 'number' && typeof f.height_m === 'number') {
      parts.push(`✓ ${units.formatFromMeters(f.width_m)} × ${units.formatFromMeters(f.height_m)}`);
    } else {
      parts.push('⚠ uncalibrated');
    }
  }
  parts.push(`${rooms.length} area${rooms.length === 1 ? '' : 's'}`);
  parts.push(`${routes.length} path${routes.length === 1 ? '' : 's'}`);
  parts.push(`${pins.length} camera${pins.length === 1 ? '' : 's'}`);
  // When a pathway is selected, hint about pin-click-to-toggle.
  if (selectedKind === 'route' && activeTool === 'pan') {
    parts.push('click a camera pin to add/remove it from this path');
  } else if (activeTool === 'pan' && !selectedKind) {
    parts.push('click a camera pin to edit mount + FOV properties');
  }
  switch (activeTool) {
    case 'cal-line':
      parts.push(`Calibrate · ${calPts.length}/2 clicks`);
      break;
    case 'outline-poly':
      parts.push(`Outline polygon · ${currentPoly.length} pts · dblclick to close`);
      break;
    case 'outline-rect':
      parts.push('Outline rectangle · drag corner-to-corner');
      break;
    case 'area-poly':
      parts.push(`Area polygon · ${currentPoly.length} pts · dblclick to close`);
      break;
    case 'area-rect':
      parts.push('Area rectangle · drag corner-to-corner');
      break;
    case 'path-poly':
      parts.push(`Pathway · ${currentPoly.length} waypoints · dblclick or Enter to finish`);
      break;
    default:
      parts.push('drag to pan · wheel to zoom · click a path or area to select');
  }
  statusEl.textContent = parts.join('  ·  ');
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[m]);
}
function escapeAttr(s) { return escapeHTML(s); }

// ── Entry button ──────────────────────────────────────────────────────
function mountEntryButton() {
  const bar = document.querySelector(ENTRY_HOST_SELECTOR);
  if (!bar) { setTimeout(mountEntryButton, 500); return; }
  if (bar.querySelector('.scada-fs-open-btn')) return;
  const btn = document.createElement('button');
  btn.className = 'scada-fs-open-btn';
  btn.textContent = '📐 Full-Screen Editor';
  btn.title = 'Open full-screen floor editor (pan/zoom + every authoring tool)';
  Object.assign(btn.style, {
    cursor: 'pointer', background: '#5c8bf2', color: '#fff',
    border: 'none', padding: '4px 10px', borderRadius: '3px',
    fontFamily: 'inherit', fontSize: '11px', fontWeight: '700',
    marginLeft: '8px',
  });
  btn.onclick = open;
  bar.appendChild(btn);
}

function start() { mountEntryButton(); }

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

export function isEditorOpen() { return isOpen; }
export { open, close };

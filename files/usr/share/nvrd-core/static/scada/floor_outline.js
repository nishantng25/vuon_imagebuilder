import * as units from './units.js';

// =============================================================================
// Floor outline editor — outline the building's real boundary on the plan.
//
// When set, the coverage rasteriser ignores cells outside the outline,
// so % numbers stop being inflated by parking lots / gardens / L-shape
// cutouts. The outline also feeds total floor area for MIS reporting.
//
// UX
//   - "🏢 Outline" button next to Calibrate + Areas in the admin bar.
//   - Click → exclusive draw mode (pin drag + room editor temporarily
//     suspended via a single global state flag). Cursor crosshair,
//     amber banner "Click corners of the building; double-click to
//     close. Esc to cancel."
//   - Click adds a vertex; double-click (or Enter) closes + saves.
//   - When an outline already exists it shows as a soft amber polygon
//     on entering draw mode; the first click clears it and starts
//     fresh. "Clear outline" button removes it (server: PUT polygon:[]).
//
// The polygon lives in pct space (same as pins + rooms) so it survives
// any future plan-image swap that keeps the same aspect.
// =============================================================================

const ADMIN_HOST_ID = 'sv-canvas-wrap';
const PLAN_IMG_ID   = 'sv-plan-img';

let mode = 'off';       // 'off' | 'drawing' | 'drawing-rect'
let currentPoly = [];
let rectAnchor = null;
let rectCurrent = null;
let overlay = null;
let bannerEl = null;
let btnEl = null;
let rectBtnEl = null;
let host = null;

function $(id) { return document.getElementById(id); }

function currentFloor() {
  const sv = window.SV || {};
  const id = sv.currentFloorId;
  if (!id) return null;
  return (sv.floors || []).find(f => f.id === id) || null;
}

// Expose a tiny flag so room_editor.js + admin pin polish can know
// "the floor outline tool is active; back off." We don't import here
// to keep the modules cross-decoupled.
window.scadaFloorOutlineActive = () => mode !== 'off';

function ensureOverlay() {
  if (overlay) return overlay;
  const ns = 'http://www.w3.org/2000/svg';
  overlay = document.createElementNS(ns, 'svg');
  Object.assign(overlay.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none',
    width: '100%', height: '100%', zIndex: 7,
  });
  overlay.setAttribute('class', 'scada-floor-outline-overlay');
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

// Render: existing-outline (when not drawing OR no points yet) +
// in-progress polyline (when drawing).
function redraw() {
  ensureOverlay();
  overlay.innerHTML = '';
  const p = projector();
  if (!p) return;
  const ns = 'http://www.w3.org/2000/svg';
  const f = currentFloor();
  const existing = (f && Array.isArray(f.outline) && f.outline.length >= 3) ? f.outline : null;

  // Show the existing outline (soft) whenever we're NOT mid-draw with
  // fresh points, so the operator always knows what's saved.
  const showExisting = (mode === 'off') || currentPoly.length === 0;
  if (existing && showExisting) {
    const pts = existing.map(pt => {
      const xy = p(pt.x_pct, pt.y_pct);
      return xy.x.toFixed(1) + ',' + xy.y.toFixed(1);
    }).join(' ');
    const poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points', pts);
    poly.setAttribute('fill', 'rgba(245,158,11,0.06)');
    poly.setAttribute('stroke', '#f59e0b');
    poly.setAttribute('stroke-width', '2');
    poly.setAttribute('stroke-dasharray', '4 6');
    overlay.appendChild(poly);
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
    rect.setAttribute('fill', 'rgba(134,194,111,0.10)');
    rect.setAttribute('stroke', '#86c26f');
    rect.setAttribute('stroke-width', '3');
    rect.setAttribute('stroke-dasharray', '8 4');
    overlay.appendChild(rect);
  }

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
      line.setAttribute('stroke-width', '3');
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

function showBanner(text, colour = '#f59e0b') {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    Object.assign(bannerEl.style, {
      position: 'fixed', top: '60px', left: '50%',
      transform: 'translateX(-50%)',
      padding: '8px 16px', borderRadius: '4px',
      fontFamily: 'ui-monospace, monospace', fontSize: '13px',
      fontWeight: '700', zIndex: 9998,
      boxShadow: '0 4px 16px rgba(0,0,0,0.4)',
    });
    document.body.appendChild(bannerEl);
  }
  bannerEl.style.background = colour;
  bannerEl.style.color = '#0c0e13';
  bannerEl.textContent = text;
  bannerEl.style.display = 'block';
}
function hideBanner() { if (bannerEl) bannerEl.style.display = 'none'; }

function onCanvasClick(ev) {
  if (mode !== 'drawing') return;
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
  redraw();
}

function onCanvasDblClick(ev) {
  if (mode !== 'drawing') return;
  ev.preventDefault();
  ev.stopPropagation();
  // Same dedup as room_editor: dblclick fires two extra clicks first.
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
    cancel();
  } else if (ev.key === 'Enter' && mode === 'drawing') {
    ev.preventDefault();
    finishDrawing();
  }
}

// Pointer-event drag for the rectangle option. Active only when
// mode === 'drawing-rect'. Live preview redraws on every move.
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
  if ((maxX - minX) < 0.02 || (maxY - minY) < 0.02) {
    rectAnchor = rectCurrent = null;
    redraw();
    showBanner('Rectangle too small — drag further across the floor.', '#d95a50');
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
  await finishDrawing();
}

function startDrawingRect() {
  if (!currentFloor()) {
    if (window.toast) window.toast('Select a floor first', 'warn');
    return;
  }
  mode = 'drawing-rect';
  currentPoly = [];
  rectAnchor = null;
  rectCurrent = null;
  document.body.style.cursor = 'crosshair';
  if (btnEl) {
    btnEl.style.background = '#5c8bf2';
    btnEl.textContent = '🏢 Cancel';
  }
  if (rectBtnEl) rectBtnEl.style.background = '#5c8bf2';
  showBanner('Press and drag from one building corner across to the opposite corner. Esc to cancel.');
  redraw();
}

async function finishDrawing() {
  if (currentPoly.length < 3) {
    showBanner('Need at least 3 corners — keep clicking.', '#d95a50');
    return;
  }
  const f = currentFloor();
  if (!f) { cancel(); return; }
  try {
    await window.siteApi.put(`/api/site/floors/${f.id}/outline`,
      { polygon: currentPoly });
    f.outline = currentPoly.slice();
    if (window.toast) window.toast(
      `Floor outline saved (${currentPoly.length} corners)`, 'ok');
  } catch (e) {
    if (window.toast) window.toast('Save failed: ' + e.message, 'err');
    console.warn('[scada-outline] save failed', e);
  }
  exitMode();
  // After saving the outline, prompt for the building's real-world
  // dimensions. If typed, we auto-calibrate the floor: ppm derives
  // from outline-bbox × typed dimensions, no separate calibration
  // line needed. Skipping is fine — leaves any prior calibration
  // intact. We open the modal a tick later so the success toast
  // doesn't fight the modal animation.
  setTimeout(() => offerAutoCalibrate(f, currentPoly.slice()), 80);
  currentPoly = [];
  redraw();
}

// Open a modal asking for the building's overall length × width. If
// the operator submits, auto-calibrate by pretending there's a
// calibration line along the outline bbox's longer axis with the typed
// length. The server's existing PUT /api/site/floors/{id}/calibration
// is reused — no new endpoint needed.
function offerAutoCalibrate(floor, polygon) {
  const img = $(PLAN_IMG_ID);
  if (!img || !img.naturalWidth) return;
  // Compute bbox in pct space.
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const p of polygon) {
    if (p.x_pct < minX) minX = p.x_pct;
    if (p.x_pct > maxX) maxX = p.x_pct;
    if (p.y_pct < minY) minY = p.y_pct;
    if (p.y_pct > maxY) maxY = p.y_pct;
  }
  const bboxW = (maxX - minX);
  const bboxH = (maxY - minY);
  if (bboxW <= 0 || bboxH <= 0) return;

  const modal = document.createElement('div');
  Object.assign(modal.style, {
    position: 'fixed', inset: '0',
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10000,
  });
  modal.innerHTML = `
    <div style="background:#1a1d22;border:1px solid #3c3f47;border-radius:6px;
                padding:20px;width:420px;font-family:ui-monospace,monospace;color:#ECE6D6;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:14px;font-weight:700;">Auto-calibrate from outline</div>
        <div id="scada-autocal-unit-host"></div>
      </div>
      <div style="font-size:11px;color:#888a95;margin-bottom:14px;">
        Type the building's overall <b>length × width</b>. We compute
        pixels-per-metre from the outline you just drew — every room
        polygon you create from here will auto-fill its dimensions
        from the floor scale. Skip to leave existing calibration alone.
      </div>
      <div style="display:grid;grid-template-columns:80px 1fr;gap:8px;align-items:center;margin-bottom:6px;">
        <label style="font-size:12px;color:#ECE6D6;">Length</label>
        <input id="scada-autocal-l" type="text" autocomplete="off"
               placeholder="longer side, e.g. 100 ft"
               style="padding:6px;background:#0c0e13;color:#ECE6D6;
                      border:1px solid #3c3f47;border-radius:3px;
                      font-family:inherit;font-size:12px;">
        <label style="font-size:12px;color:#ECE6D6;">Width</label>
        <input id="scada-autocal-w" type="text" autocomplete="off"
               placeholder="shorter side, e.g. 50 ft"
               style="padding:6px;background:#0c0e13;color:#ECE6D6;
                      border:1px solid #3c3f47;border-radius:3px;
                      font-family:inherit;font-size:12px;">
      </div>
      <div id="scada-autocal-preview"
           style="font-size:11px;color:#86c26f;min-height:28px;
                  margin-top:8px;margin-bottom:14px;background:#0c0e13;
                  border:1px solid #3c3f47;border-radius:3px;padding:6px 8px;
                  font-family:ui-monospace,monospace;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="scada-autocal-skip"
                style="cursor:pointer;background:transparent;color:#888a95;
                       border:1px solid #3c3f47;padding:6px 12px;border-radius:3px;
                       font-family:inherit;">Skip</button>
        <button id="scada-autocal-save"
                style="cursor:pointer;background:#86c26f;color:#0c0e13;
                       border:none;padding:6px 12px;border-radius:3px;
                       font-family:inherit;font-weight:700;">Calibrate</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);
  units.mountUnitToggle(document.getElementById('scada-autocal-unit-host'));

  const lEl = document.getElementById('scada-autocal-l');
  const wEl = document.getElementById('scada-autocal-w');
  const preview = document.getElementById('scada-autocal-preview');
  function paint() {
    const lM = units.parseToMeters(lEl.value);
    const wM = units.parseToMeters(wEl.value);
    if (lM === null || wM === null) {
      preview.textContent = 'Type both dimensions to preview.';
      preview.style.color = '#888a95';
      return;
    }
    // PPM is over-determined when both L and W are given; we use the
    // BBOX-larger axis with the typed-larger value (so the operator's
    // "100 ft × 50 ft" maps to "100 ft along the longer bbox axis").
    const bboxLongerPct = Math.max(bboxW, bboxH);
    const bboxLongerPx  = bboxLongerPct * (bboxW > bboxH ? img.naturalWidth : img.naturalHeight);
    const longerM = Math.max(lM, wM);
    const ppm = bboxLongerPx / longerM;
    const floorWm = img.naturalWidth  / ppm;
    const floorHm = img.naturalHeight / ppm;
    preview.style.color = '#86c26f';
    preview.innerHTML = `↳ ppm ${ppm.toFixed(1)} px/m · floor extent ${units.formatFromMeters(floorWm)} × ${units.formatFromMeters(floorHm)}`;
  }
  for (const el of [lEl, wEl]) el.addEventListener('input', paint);
  lEl.focus();

  const close = () => { modal.remove(); };
  document.getElementById('scada-autocal-skip').onclick = close;
  document.getElementById('scada-autocal-save').onclick = async () => {
    const lM = units.parseToMeters(lEl.value);
    const wM = units.parseToMeters(wEl.value);
    if (lM === null || wM === null) {
      preview.textContent = 'Need both length and width.';
      preview.style.color = '#d95a50';
      return;
    }
    // Pretend there's a calibration line spanning the bbox's longer
    // axis with the typed longer-length. Server's existing calibration
    // handler does the rest.
    const longerIsHorizontal = bboxW >= bboxH;
    const longerM = Math.max(lM, wM);
    const calBody = longerIsHorizontal ? {
      line_x1_pct:   minX, line_y1_pct: (minY + maxY) / 2,
      line_x2_pct:   maxX, line_y2_pct: (minY + maxY) / 2,
      real_length_m: longerM,
      image_width_px:  img.naturalWidth,
      image_height_px: img.naturalHeight,
    } : {
      line_x1_pct:   (minX + maxX) / 2, line_y1_pct: minY,
      line_x2_pct:   (minX + maxX) / 2, line_y2_pct: maxY,
      real_length_m: longerM,
      image_width_px:  img.naturalWidth,
      image_height_px: img.naturalHeight,
    };
    try {
      const saved = await window.siteApi.put(
        `/api/site/floors/${floor.id}/calibration`, calBody);
      floor.width_m  = saved.width_m;
      floor.height_m = saved.height_m;
      if (window.toast) window.toast(
        `Auto-calibrated · ${units.formatFromMeters(saved.width_m)} × ${units.formatFromMeters(saved.height_m)} · ${saved.pixels_per_meter.toFixed(1)} px/m`,
        'ok');
    } catch (e) {
      if (window.toast) window.toast('Auto-calibration failed: ' + e.message, 'err');
      console.warn('[scada-outline] auto-cal failed', e);
    }
    close();
  };
}

function cancel() {
  currentPoly = [];
  exitMode();
  redraw();
  showBanner('Outline cancelled.', '#888a95');
  setTimeout(hideBanner, 1500);
}

function exitMode() {
  mode = 'off';
  if (btnEl) {
    btnEl.style.background = '#f59e0b';
    btnEl.textContent = '🏢 Outline';
  }
  if (rectBtnEl) rectBtnEl.style.background = '#f59e0b';
  document.body.style.cursor = '';
  hideBanner();
}

function startDrawing() {
  if (!currentFloor()) {
    if (window.toast) window.toast('Select a floor first', 'warn');
    return;
  }
  if (window.scadaFloorOutlineActive && window.scadaFloorOutlineActive()) return;
  mode = 'drawing';
  currentPoly = [];
  document.body.style.cursor = 'crosshair';
  if (btnEl) {
    btnEl.style.background = '#5c8bf2';
    btnEl.textContent = '🏢 Cancel';
  }
  showBanner('Click each corner of the building. Double-click or Enter to close. Esc to cancel.');
  redraw();
}

async function clearOutline() {
  const f = currentFloor();
  if (!f) return;
  if (!confirm('Clear floor outline? Coverage % will go back to using the full image rect.')) return;
  try {
    await window.siteApi.put(`/api/site/floors/${f.id}/outline`, { polygon: [] });
    f.outline = undefined;
    if (window.toast) window.toast('Floor outline cleared', 'ok');
  } catch (e) {
    if (window.toast) window.toast('Clear failed: ' + e.message, 'err');
  }
  redraw();
}

function mountButton() {
  const bar = host && host.querySelector('.scada-cal-bar');
  if (!bar) { setTimeout(mountButton, 500); return; }
  if (bar.querySelector('.scada-outline-btn')) return;
  btnEl = document.createElement('button');
  btnEl.className = 'scada-outline-btn';
  btnEl.textContent = '🏢 Outline';
  btnEl.title = 'Click corners to outline the building (polygon)';
  Object.assign(btnEl.style, {
    cursor: 'pointer', background: '#f59e0b', color: '#0c0e13',
    border: 'none', padding: '3px 8px', borderRadius: '3px',
    fontFamily: 'inherit', fontSize: '11px', fontWeight: '700',
    marginLeft: '4px',
  });
  btnEl.onclick = () => mode === 'off' ? startDrawing() : cancel();
  // Sibling rectangle-drag button. Same visual identity, different tool.
  rectBtnEl = document.createElement('button');
  rectBtnEl.className = 'scada-outline-rect-btn';
  rectBtnEl.textContent = '▭';
  rectBtnEl.title = 'Drag a rectangle for a quick rectangular outline';
  Object.assign(rectBtnEl.style, {
    cursor: 'pointer', background: '#f59e0b', color: '#0c0e13',
    border: 'none', padding: '3px 6px', borderRadius: '3px',
    fontFamily: 'inherit', fontSize: '11px', fontWeight: '700',
    marginLeft: '2px',
  });
  rectBtnEl.onclick = () => {
    if (mode === 'drawing-rect') cancel();
    else                          startDrawingRect();
  };
  // Small "clear" affordance — only visible when an outline exists.
  const clearBtn = document.createElement('button');
  clearBtn.className = 'scada-outline-clear-btn';
  clearBtn.textContent = '✕';
  clearBtn.title = 'Clear floor outline';
  Object.assign(clearBtn.style, {
    cursor: 'pointer', background: 'transparent', color: '#d95a50',
    border: '1px solid #d95a50', padding: '1px 5px', borderRadius: '3px',
    fontFamily: 'inherit', fontSize: '10px', marginLeft: '2px',
  });
  clearBtn.onclick = clearOutline;
  bar.appendChild(btnEl);
  bar.appendChild(rectBtnEl);
  bar.appendChild(clearBtn);

  // Refresh clear-button visibility cheap.
  setInterval(() => {
    const f = currentFloor();
    clearBtn.style.display = (f && f.outline && f.outline.length >= 3) ? '' : 'none';
  }, 1500);
}

function startOutlineModule() {
  host = $(ADMIN_HOST_ID);
  if (!host) { setTimeout(startOutlineModule, 500); return; }
  if (host.dataset.scadaOutlineWired === '1') return;
  host.dataset.scadaOutlineWired = '1';
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.addEventListener('click', onCanvasClick, true);
  host.addEventListener('dblclick', onCanvasDblClick, true);
  host.addEventListener('pointerdown', onPointerDown, true);
  host.addEventListener('pointermove', onPointerMove, true);
  host.addEventListener('pointerup',   onPointerUp,   true);
  document.addEventListener('keydown', onKey);
  mountButton();
  // Cheap interval so we redraw the saved outline once the floors
  // arrive from the server (or after a floor switch).
  setInterval(() => { if (mode === 'off') redraw(); }, 2000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startOutlineModule);
} else {
  startOutlineModule();
}

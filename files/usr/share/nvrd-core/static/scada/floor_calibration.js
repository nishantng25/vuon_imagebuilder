// =============================================================================
// Floor calibration — let the operator draw a known line on the plan
// and type its real-world length. Server derives pixels-per-metre and
// stores floor dimensions in metres on site_floors. Until calibrated,
// coverage % is a relative metric only; after calibration it's audit-
// grade.
//
// UX flow:
//   1. A "📏 Calibrate" button mounts in the Site View admin canvas next
//      to the floor name. Badge shows current state: "✓ 18.0 × 12.5 m"
//      when calibrated, "⚠ uncalibrated" otherwise.
//   2. Click the button → cursor turns crosshair, banner instructs to
//      click two points on the plan along a known distance.
//   3. After two clicks, a small modal asks for the real-world length in
//      metres. Submit → PUT to API → toast → exit calibrate mode.
//
// All state lives in this module — does NOT mutate the monolith. The
// only DOM hook is observing the existing #sv-canvas-wrap and the floor
// tab list to mount the button/badge.
// =============================================================================

import * as units from './units.js';

const ADMIN_HOST_ID = 'sv-canvas-wrap';
const PLAN_IMG_ID   = 'sv-plan-img';

let state = 'idle';      // 'idle' | 'await-p1' | 'await-p2' | 'await-length'
let p1 = null;           // {x_pct, y_pct}
let p2 = null;
let overlay = null;      // SVG overlay for the drawn line
let bannerEl = null;
let modalEl = null;
let badgeEl = null;
let calBtnEl = null;

function $(id) { return document.getElementById(id); }

// Pull current floor + its calibration metadata from the monolith's state.
// SV.floors is the array of floor records returned by /api/site/floors.
function currentFloor() {
  const sv = window.SV || {};
  const id = sv.currentFloorId;
  if (!id) return null;
  const list = (sv.floors || sv.floorsList || []);
  return list.find(f => f.id === id) || null;
}

// ── Badge + button mount ───────────────────────────────────────────────
function mountBadgeAndButton() {
  const host = $(ADMIN_HOST_ID);
  if (!host) return;
  const parent = host.parentElement;
  if (!parent || parent.querySelector('.scada-cal-bar')) return;

  // Insert a small bar above the canvas. Position: absolute so it floats
  // over the canvas without changing layout (which would shift pin coords).
  const bar = document.createElement('div');
  bar.className = 'scada-cal-bar';
  Object.assign(bar.style, {
    position: 'absolute', top: '8px', left: '12px',
    display: 'flex', gap: '8px', alignItems: 'center',
    fontFamily: 'ui-monospace, monospace', fontSize: '11px',
    background: 'rgba(20,22,26,0.78)',
    color: '#ECE6D6',
    padding: '5px 8px', borderRadius: '4px',
    border: '1px solid rgba(255,255,255,0.08)',
    zIndex: 10, pointerEvents: 'auto',
  });
  badgeEl = document.createElement('span');
  badgeEl.textContent = '— ';
  calBtnEl = document.createElement('button');
  calBtnEl.textContent = '📏 Calibrate';
  Object.assign(calBtnEl.style, {
    cursor: 'pointer',
    background: '#f59e0b', color: '#0c0e13',
    border: 'none', padding: '3px 8px', borderRadius: '3px',
    fontFamily: 'inherit', fontSize: '11px', fontWeight: '700',
  });
  calBtnEl.onclick = startCalibration;
  bar.appendChild(badgeEl);
  // Inline unit toggle so the operator can flip m/ft/ft+in without
  // opening the calibration modal. Lives between badge and button so
  // it sits next to the calibrated dimensions it controls.
  const unitHost = document.createElement('span');
  unitHost.style.marginLeft = '4px';
  bar.appendChild(unitHost);
  units.mountUnitToggle(unitHost);
  bar.appendChild(calBtnEl);
  // Insert inside the canvas wrapper so it scrolls with the plan layout.
  // The wrapper is position:relative already (it hosts the pin overlay).
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.appendChild(bar);

  refreshBadge();
}

function refreshBadge() {
  if (!badgeEl) return;
  const f = currentFloor();
  if (!f) { badgeEl.textContent = '(no floor)'; return; }
  if (typeof f.width_m === 'number' && typeof f.height_m === 'number') {
    badgeEl.innerHTML = `<span style="color:#86c26f">✓ calibrated</span> · ${f.width_m.toFixed(1)} × ${f.height_m.toFixed(1)} m`;
  } else {
    badgeEl.innerHTML = `<span style="color:#f59e0b">⚠ uncalibrated</span> · coverage % is relative only`;
  }
}

// ── Banner (instructions while picking points) ─────────────────────────
function showBanner(text) {
  if (!bannerEl) {
    bannerEl = document.createElement('div');
    Object.assign(bannerEl.style, {
      position: 'fixed', top: '60px', left: '50%',
      transform: 'translateX(-50%)',
      background: '#f59e0b', color: '#0c0e13',
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

// ── Line overlay (the drawn calibration line) ──────────────────────────
function ensureOverlay() {
  if (overlay) return overlay;
  const host = $(ADMIN_HOST_ID);
  const ns = 'http://www.w3.org/2000/svg';
  overlay = document.createElementNS(ns, 'svg');
  Object.assign(overlay.style, {
    position: 'absolute', inset: '0', pointerEvents: 'none',
    width: '100%', height: '100%', zIndex: 9,
  });
  overlay.setAttribute('class', 'scada-cal-line-overlay');
  host.appendChild(overlay);
  return overlay;
}

function drawLine() {
  ensureOverlay();
  overlay.innerHTML = '';
  if (!p1) return;
  const img = $(PLAN_IMG_ID);
  if (!img || !img.naturalWidth) return;
  const rect = img.getBoundingClientRect();
  const host = $(ADMIN_HOST_ID).getBoundingClientRect();
  const offX = rect.left - host.left;
  const offY = rect.top - host.top;
  const project = (p) => ({
    x: offX + (p.x_pct / 100) * rect.width,
    y: offY + (p.y_pct / 100) * rect.height,
  });
  const a = project(p1);
  const ns = 'http://www.w3.org/2000/svg';
  if (p2) {
    const b = project(p2);
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', a.x); line.setAttribute('y1', a.y);
    line.setAttribute('x2', b.x); line.setAttribute('y2', b.y);
    line.setAttribute('stroke', '#f59e0b');
    line.setAttribute('stroke-width', '3');
    line.setAttribute('stroke-dasharray', '6 4');
    overlay.appendChild(line);
    for (const pt of [a, b]) {
      const c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', pt.x); c.setAttribute('cy', pt.y);
      c.setAttribute('r', '6');
      c.setAttribute('fill', '#f59e0b');
      c.setAttribute('stroke', '#0c0e13');
      c.setAttribute('stroke-width', '2');
      overlay.appendChild(c);
    }
  } else {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', a.x); c.setAttribute('cy', a.y);
    c.setAttribute('r', '6');
    c.setAttribute('fill', '#f59e0b');
    c.setAttribute('stroke', '#0c0e13');
    c.setAttribute('stroke-width', '2');
    overlay.appendChild(c);
  }
}

function clearOverlay() {
  if (overlay) overlay.innerHTML = '';
}

// ── Click handler while in pick mode ───────────────────────────────────
function onCanvasClick(ev) {
  if (state !== 'await-p1' && state !== 'await-p2') return;
  const img = $(PLAN_IMG_ID);
  if (!img) return;
  const rect = img.getBoundingClientRect();
  if (ev.clientX < rect.left || ev.clientX > rect.right ||
      ev.clientY < rect.top  || ev.clientY > rect.bottom) {
    return; // outside the actual plan image — ignore
  }
  ev.preventDefault();
  ev.stopPropagation();
  const xPct = ((ev.clientX - rect.left) / rect.width) * 100;
  const yPct = ((ev.clientY - rect.top)  / rect.height) * 100;
  if (state === 'await-p1') {
    p1 = { x_pct: xPct, y_pct: yPct };
    state = 'await-p2';
    showBanner('Click the SECOND point to finish the line.');
  } else {
    p2 = { x_pct: xPct, y_pct: yPct };
    state = 'await-length';
    hideBanner();
    openLengthModal();
  }
  drawLine();
}

// ── Length entry modal ─────────────────────────────────────────────────
function openLengthModal() {
  if (modalEl) modalEl.remove();
  modalEl = document.createElement('div');
  Object.assign(modalEl.style, {
    position: 'fixed', inset: '0',
    background: 'rgba(0,0,0,0.6)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 10000,
  });
  const placeholder = unitPlaceholder();
  modalEl.innerHTML = `
    <div style="background:#1a1d22;border:1px solid #3c3f47;border-radius:6px;
                padding:20px;width:380px;font-family:ui-monospace,monospace;color:#ECE6D6;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
        <div style="font-size:14px;font-weight:700;">Real-world length</div>
        <div id="scada-cal-unit-host"></div>
      </div>
      <div style="font-size:11px;color:#888a95;margin-bottom:14px;">
        How long is the line you drew? Use the longest known physical
        distance on the plan for best precision — a corridor or room
        wall, not a small object.
      </div>
      <input id="scada-cal-length" type="text" autocomplete="off"
             placeholder="${placeholder}"
             style="width:100%;padding:8px;font-size:14px;box-sizing:border-box;
                    background:#0c0e13;color:#ECE6D6;
                    border:1px solid #3c3f47;border-radius:4px;
                    font-family:inherit;margin-bottom:8px;">
      <div id="scada-cal-preview"
           style="font-size:11px;color:#86c26f;min-height:16px;margin-bottom:12px;
                  font-family:ui-monospace,monospace;"></div>
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button id="scada-cal-cancel"
                style="cursor:pointer;background:transparent;color:#888a95;
                       border:1px solid #3c3f47;padding:6px 12px;border-radius:3px;
                       font-family:inherit;">Cancel</button>
        <button id="scada-cal-submit"
                style="cursor:pointer;background:#86c26f;color:#0c0e13;
                       border:none;padding:6px 12px;border-radius:3px;
                       font-family:inherit;font-weight:700;">Calibrate</button>
      </div>
    </div>
  `;
  document.body.appendChild(modalEl);

  // Mount the m/ft/ft+in toggle inside the modal header.
  units.mountUnitToggle($('scada-cal-unit-host'), {
    onChange: () => {
      const i = $('scada-cal-length');
      i.placeholder = unitPlaceholder();
      updatePreview();
    },
  });

  const input   = $('scada-cal-length');
  const preview = $('scada-cal-preview');
  function updatePreview() {
    const m = units.parseToMeters(input.value);
    if (m === null) {
      preview.textContent = input.value ? '↳ unrecognised — try e.g. "18 ft" or "18 ft 6 in"' : '';
      preview.style.color = input.value ? '#f59e0b' : '#86c26f';
      return;
    }
    preview.textContent = '↳ ' + m.toFixed(3) + ' m  (sent to server)';
    preview.style.color = '#86c26f';
  }
  input.addEventListener('input', updatePreview);
  input.focus();
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') $('scada-cal-submit').click();
    if (ev.key === 'Escape') $('scada-cal-cancel').click();
  });
  $('scada-cal-cancel').onclick = () => closeModalAndExit();
  $('scada-cal-submit').onclick = async () => {
    const m = units.parseToMeters(input.value);
    if (m === null) {
      input.style.borderColor = '#d95a50';
      preview.textContent = '↳ unrecognised input';
      preview.style.color = '#d95a50';
      return;
    }
    await submit(m);
    closeModalAndExit();
  };
}

function unitPlaceholder() {
  const u = units.getUnit();
  if (u === 'm')    return 'e.g. 5.5 m  or  5.5';
  if (u === 'ft')   return 'e.g. 18 ft  or  18';
  if (u === 'ftin') return 'e.g. 18 ft 6 in';
  return '';
}

function closeModalAndExit() {
  if (modalEl) { modalEl.remove(); modalEl = null; }
  clearOverlay();
  hideBanner();
  p1 = p2 = null;
  state = 'idle';
  document.body.style.cursor = '';
}

// ── Submit to API ──────────────────────────────────────────────────────
async function submit(realLengthM) {
  const f = currentFloor();
  if (!f) {
    console.warn('[scada-cal] submit aborted: no current floor');
    if (window.toast) window.toast('Calibration failed: no current floor selected', 'err');
    return;
  }
  const img = $(PLAN_IMG_ID);
  if (!img || !img.naturalWidth) {
    console.warn('[scada-cal] submit aborted: plan image not loaded', {img});
    if (window.toast) window.toast('Calibration failed: plan image not loaded', 'err');
    return;
  }
  const reqBody = {
    line_x1_pct: p1.x_pct / 100,
    line_y1_pct: p1.y_pct / 100,
    line_x2_pct: p2.x_pct / 100,
    line_y2_pct: p2.y_pct / 100,
    real_length_m: realLengthM,
    image_width_px: img.naturalWidth,
    image_height_px: img.naturalHeight,
  };
  console.log('[scada-cal] PUT /api/site/floors/' + f.id + '/calibration', reqBody);
  try {
    const saved = await window.siteApi.put(
      `/api/site/floors/${f.id}/calibration`, reqBody);
    console.log('[scada-cal] success', saved);
    // Merge into the local floor cache so the badge updates immediately
    // without a refetch.
    f.width_m  = saved.width_m;
    f.height_m = saved.height_m;
    refreshBadge();
    if (window.toast) {
      const w = units.formatFromMeters(saved.width_m);
      const h = units.formatFromMeters(saved.height_m);
      window.toast(`Calibrated · ${w} × ${h} · ${saved.pixels_per_meter.toFixed(1)} px/m`, 'ok');
    }
  } catch (err) {
    console.warn('[scada-cal] submit failed', {
      err: err,
      message: err && err.message,
      stack: err && err.stack,
      floorId: f.id,
      body: reqBody,
    });
    if (window.toast) window.toast('Calibration failed: ' + (err.message || err), 'err');
  }
}

// ── Calibration start ──────────────────────────────────────────────────
function startCalibration() {
  if (!currentFloor()) {
    if (window.toast) window.toast('Select a floor first', 'warn');
    return;
  }
  state = 'await-p1';
  p1 = p2 = null;
  clearOverlay();
  document.body.style.cursor = 'crosshair';
  showBanner('Click the FIRST point on a known distance (e.g. corridor end).');
}

// ── Wire up ────────────────────────────────────────────────────────────
//
// Earlier version observed document.body with a MutationObserver to
// re-mount the badge on every DOM change. The callback wrote
// badgeEl.innerHTML, which itself was a DOM mutation, which re-fired
// the observer → infinite loop → the entire SPA appeared "stuck on
// loading" until the user reloaded. Replaced with a one-shot mount
// (with a retry until the host element exists) and a cheap interval
// poll to pick up floor-switch changes. No observers in this module.
//
// Badge writes are diffed against the last-painted text so the interval
// is free when nothing changed (defensive — keeps DevTools paint-count
// clean even if a future change reintroduces an observer somewhere).

let lastBadgeText = '';
function safeRefreshBadge() {
  if (!badgeEl) return;
  const f = currentFloor();
  // Key the diff on (floor id, calibration state, current unit) so we
  // repaint when the operator switches units even without a real value
  // change.
  const u = units.getUnit();
  const k = !f ? 'none'
          : (typeof f.width_m === 'number' ? 'cal:' + f.id + ':' + u + ':' + f.width_m
                                           : 'unc:' + f.id);
  if (k === lastBadgeText) return;
  lastBadgeText = k;
  if (!f) {
    badgeEl.textContent = '(no floor)';
    return;
  }
  if (typeof f.width_m === 'number' && typeof f.height_m === 'number') {
    const w = units.formatFromMeters(f.width_m);
    const h = units.formatFromMeters(f.height_m);
    badgeEl.innerHTML = `<span style="color:#86c26f">✓ calibrated</span> · ${w} × ${h}`;
  } else {
    badgeEl.innerHTML = `<span style="color:#f59e0b">⚠ uncalibrated</span> · coverage % is relative only`;
  }
}

// Repaint badge immediately when the operator switches units anywhere.
units.onUnitChange(() => { lastBadgeText = ''; safeRefreshBadge(); });

function startCalibrationModule() {
  const host = $(ADMIN_HOST_ID);
  if (!host) {
    // Host not in the DOM yet — retry. The admin Site View canvas may
    // mount lazily on first navigation to that route.
    setTimeout(startCalibrationModule, 500);
    return;
  }
  // Idempotent — startCalibrationModule may be called twice if a future
  // change re-invokes it. The "already mounted" guard inside
  // mountBadgeAndButton stops a duplicate bar.
  if (host.dataset.scadaCalWired === '1') return;
  host.dataset.scadaCalWired = '1';

  // Capture-phase so we run BEFORE the monolith's pin drag/drop handler
  // when in pick mode. Early-return when state==='idle' keeps the
  // monolith's behaviour intact outside calibration.
  host.addEventListener('click', onCanvasClick, true);
  mountBadgeAndButton();
  safeRefreshBadge();

  // Refresh on a slow interval to catch floor-switch state changes.
  // 2 s is plenty — the only way the badge text changes is when the
  // operator switches floors or finishes calibrating (which itself
  // calls refreshBadge explicitly). The diff in safeRefreshBadge
  // makes a no-change tick free.
  setInterval(safeRefreshBadge, 2000);
}

// Override refreshBadge so submit()'s explicit call routes through the
// diffing version too (and the original mountBadgeAndButton initial
// paint stays correct).
refreshBadge = safeRefreshBadge;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startCalibrationModule);
} else {
  startCalibrationModule();
}

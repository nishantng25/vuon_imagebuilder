// =============================================================================
// Admin pin editor polish — smooth dragging + smooth slider preview.
//
// Replaces two friction sources in the monolith:
//
//   1) HTML5 native drag (draggable=true / dragstart). Ghost image,
//      no live tracking under the cursor, awkward release. We swap
//      it for Pointer Events (mousedown/move/up + touch via Pointer
//      Events API). Pin tracks the cursor 1:1, drop fires the existing
//      siteOnCanvasDrop equivalent via window.siteApi.put.
//
//   2) Slider oninput → siteRenderPinOverlay() — wipes the entire pin
//      overlay <innerHTML> and rebuilds every SVG on every slider tick
//      (~60 events/s). Heavy + flickery. We attach a single in-place
//      mutator to the selected pin's <polygon>, called per slider input.
//      No DOM rebuild while dragging the slider.
//
// Activation: looks for #sv-pin-overlay (admin canvas). No-op on every
// other page so the module is safe to load on every SPA boot.
// =============================================================================

const HOST_ID = 'sv-pin-overlay';

let overlay = null;
let observer = null;
let dragging = null;       // { el, slot, startX, startY, startLeft, startTop }

function $(id) { return document.getElementById(id); }

// ── In-place slider mutator ─────────────────────────────────────────────
//
// The monolith's siteRenderInspector() wires oninput handlers that mutate
// p.rotation_deg / p.fov_angle_deg / p.fov_range_m then call
// siteRenderPinOverlay() — a full rebuild. We monkey-patch that path by
// re-wiring the THREE slider inputs to also update the selected pin's
// existing <polygon> in place. We DON'T remove the original handler —
// rebuilds still happen on `change` (slider release) via savePin, which
// is fine and necessary for the DOM to reflect a freshly-mutated server
// response. We just suppress the visible jank during the drag.

const FOV_RENDER_SCALE = 2;  // must match the monolith — keep in sync

function applyInPlace(slot, opts) {
  const pin = overlay && overlay.querySelector(
    `.sv-pin-svg[data-cam-slot="${slot}"]`);
  if (!pin) return;
  const cone = pin.querySelector('polygon');
  if (!cone) return;

  if (typeof opts.rotation_deg === 'number') {
    cone.setAttribute('transform', `rotate(${opts.rotation_deg})`);
  }
  if (typeof opts.fov_angle_deg === 'number' ||
      typeof opts.fov_range_m   === 'number') {
    // Re-read both — they may not both be in opts.
    const sv = window.SV || {};
    const pins = (sv.pinsByFloor && sv.pinsByFloor[sv.currentFloorId]) || [];
    const p = pins.find(x => x.cam_slot === slot);
    if (!p) return;
    const angle = (typeof opts.fov_angle_deg === 'number')
                  ? opts.fov_angle_deg
                  : (p.fov_angle_deg || 90);
    const range = (typeof opts.fov_range_m === 'number')
                  ? opts.fov_range_m
                  : (p.fov_range_m || 12);
    const depth = range * FOV_RENDER_SCALE;
    const half  = Math.tan((angle / 2) * Math.PI / 180) * depth;
    cone.setAttribute('points',
      `0,0 ${(-half).toFixed(2)},${(-depth).toFixed(2)} ${half.toFixed(2)},${(-depth).toFixed(2)}`);
  }
}

function attachSliderMutators() {
  const rot  = $('sv-insp-rot');
  const fovA = $('sv-insp-fov-angle');
  const fovR = $('sv-insp-fov-range');
  if (!rot || !fovA || !fovR) return;

  // Only attach once per slider — preserve any existing scada listener
  // (Idempotent via a flag attribute).
  for (const [el, key] of [[rot, 'rotation_deg'],
                           [fovA, 'fov_angle_deg'],
                           [fovR, 'fov_range_m']]) {
    if (el.dataset.scadaWired === '1') continue;
    el.dataset.scadaWired = '1';
    el.addEventListener('input', () => {
      const v = parseInt(el.value, 10);
      if (!isFinite(v)) return;
      const slot = (window.SV && window.SV.selectedCamSlot) || null;
      if (!slot) return;
      applyInPlace(slot, { [key]: v });
    });
  }
}

// ── Pointer-event drag ─────────────────────────────────────────────────
//
// We do NOT remove the existing draggable=true / dragstart listeners —
// those still fire if someone uses the old HTML5 drag. Our pointer-event
// path takes precedence by calling event.preventDefault() in pointerdown,
// which suppresses the subsequent native dragstart.

function clampPct(n) {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(100, n));
}

function onPointerDown(ev) {
  if (ev.button !== undefined && ev.button !== 0) return;  // left-click / touch only
  const pin = ev.target.closest('.sv-pin-svg[data-cam-slot]');
  if (!pin || !overlay.contains(pin)) return;
  // Suppress native drag for this gesture.
  ev.preventDefault();
  const rect = pin.getBoundingClientRect();
  const wrap = overlay.getBoundingClientRect();
  dragging = {
    el: pin,
    slot: pin.dataset.camSlot,
    pointerId: ev.pointerId,
    offX: ev.clientX - rect.left,         // cursor offset inside pin
    offY: ev.clientY - rect.top,
    wrapLeft: wrap.left,
    wrapTop:  wrap.top,
    moved: false,
  };
  pin.classList.add('scada-dragging');
  pin.setPointerCapture(ev.pointerId);
}

function onPointerMove(ev) {
  if (!dragging || ev.pointerId !== dragging.pointerId) return;
  const newLeft = ev.clientX - dragging.wrapLeft - dragging.offX;
  const newTop  = ev.clientY - dragging.wrapTop  - dragging.offY;
  dragging.el.style.left = newLeft + 'px';
  dragging.el.style.top  = newTop  + 'px';
  dragging.moved = true;
}

async function onPointerUp(ev) {
  if (!dragging || ev.pointerId !== dragging.pointerId) return;
  const pin  = dragging.el;
  const slot = dragging.slot;
  pin.classList.remove('scada-dragging');
  try { pin.releasePointerCapture(ev.pointerId); } catch (_) {}

  if (!dragging.moved) {
    // No-move = click; let the monolith's click handler take over.
    dragging = null;
    return;
  }
  // Compute new % position relative to the plan image (the same math the
  // monolith uses on drop). We refer to #sv-plan-img — admin screen B.
  const img = $('sv-plan-img');
  const rect = img ? img.getBoundingClientRect() : overlay.getBoundingClientRect();
  // pin's top-left is at left/top; pin center is +50/+50 (100×100 viewBox).
  const cx = parseFloat(pin.style.left || '0') + 50 + overlay.getBoundingClientRect().left;
  const cy = parseFloat(pin.style.top  || '0') + 50 + overlay.getBoundingClientRect().top;
  const xPct = clampPct(((cx - rect.left) / rect.width)  * 100);
  const yPct = clampPct(((cy - rect.top)  / rect.height) * 100);

  dragging = null;

  // Persist via the existing API surface (siteApi.put). Wrapped in
  // try/catch so a transient network blip doesn't dump a console error.
  try {
    const sv = window.SV || {};
    const pins = (sv.pinsByFloor && sv.pinsByFloor[sv.currentFloorId]) || [];
    const p = pins.find(x => x.cam_slot === slot);
    if (!p) return;
    const saved = await window.siteApi.put('/api/site/pins/' + slot, {
      floor_id: sv.currentFloorId,
      x_pct: xPct,
      y_pct: yPct,
      rotation_deg: p.rotation_deg || 0,
      label: p.label || '',
      fov_angle_deg: p.fov_angle_deg || 90,
      fov_range_m:   p.fov_range_m  || 12,
    });
    // Merge in place — same fix the monolith uses post-savePin to avoid
    // the stale-closure bug.
    const i = pins.findIndex(x => x.cam_slot === slot);
    if (i >= 0 && saved) Object.assign(pins[i], saved);
    // Hand control back to the monolith's render so cone math, labels,
    // and tooltips refresh cleanly. No-op if the function isn't exposed
    // (defensive — we never want a missing global to crash the page).
    if (typeof window.siteRenderPinOverlay === 'function') {
      window.siteRenderPinOverlay();
    }
  } catch (err) {
    console.warn('[scada] pin drop persist failed', err);
  }
}

function onPointerCancel(ev) {
  if (!dragging) return;
  dragging.el.classList.remove('scada-dragging');
  try { dragging.el.releasePointerCapture(ev.pointerId); } catch (_) {}
  dragging = null;
}

// ── Observer: re-attach when monolith rebuilds the overlay ─────────────
function startObserver() {
  overlay = $(HOST_ID);
  if (!overlay) {
    setTimeout(startObserver, 500);
    return;
  }
  overlay.addEventListener('pointerdown', onPointerDown);
  overlay.addEventListener('pointermove', onPointerMove);
  overlay.addEventListener('pointerup',   onPointerUp);
  overlay.addEventListener('pointercancel', onPointerCancel);

  observer = new MutationObserver(() => {
    // Slider rebuilds happen on every selection change — re-attach
    // mutators (idempotent via the data flag).
    attachSliderMutators();
  });
  observer.observe(document.body, { childList: true, subtree: true });
  attachSliderMutators();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserver);
} else {
  startObserver();
}

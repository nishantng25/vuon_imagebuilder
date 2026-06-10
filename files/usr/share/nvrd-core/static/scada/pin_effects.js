// =============================================================================
// Pin effects — driven by SSE events. Toggles data-scada-state on the
// existing operator pin SVGs; the actual animations are CSS (see
// pin_effects.css), which means JS does zero work in the hot path.
//
// State derivation:
//   - "recording" reflects whether the pin's camera currently has fresh
//     segments on disk; pulled from the existing /api/cameras response
//     via the operator state cache (window.SV.operatorState) on each tick.
//   - "motion" is fired by an SSE event, stays for ~1.4 s, auto-clears.
//   - "offline" same idea, fired on alert event of type CAMERA_OFFLINE,
//     cleared on alert_resolved or CAMERA_RECOVERED.
//
// We don't own pin DOM — operator mode renders pins via siteRenderOperator
// PinOverlay() in the monolith. We re-apply data attributes whenever that
// fn runs (it wipes innerHTML), via a MutationObserver on #sv-monitor-canvas
// — keeps the SCADA layer decoupled from the existing render code.
// =============================================================================

import { on } from './sse.js';

const motionTimers = new Map();    // cam_slot → timeout id
const offlineSet   = new Set();    // cam_slots currently offline
const recordingSet = new Set();    // cam_slots currently recording (last poll)

// Apply current state to every pin SVG inside the operator canvas. Called
// after the operator render wipes/rebuilds the overlay (MutationObserver)
// and after any state change. Idempotent.
function reapplyAll() {
  const canvas = document.getElementById('sv-monitor-canvas');
  if (!canvas) return;
  const pins = canvas.querySelectorAll('.sv-pin-svg[data-cam-slot]');
  for (const pin of pins) {
    const slot = pin.dataset.camSlot;
    const states = [];
    if (recordingSet.has(slot)) states.push('recording');
    if (offlineSet.has(slot))   states.push('offline');
    // Motion is transient — only set if the timer is still active.
    if (motionTimers.has(slot)) states.push('motion');
    pin.dataset.scadaState = states.join(' ');
    // Ensure the motion-halo <circle> exists on every pin (the operator
    // render doesn't know about it). Insert once.
    if (!pin.querySelector('.sv-motion-halo')) {
      const ns = 'http://www.w3.org/2000/svg';
      const halo = document.createElementNS(ns, 'circle');
      halo.setAttribute('class', 'sv-motion-halo');
      halo.setAttribute('cx', '0');
      halo.setAttribute('cy', '0');
      halo.setAttribute('r',  '14');
      halo.setAttribute('fill', 'none');
      halo.setAttribute('stroke', '#f59e0b');
      halo.setAttribute('stroke-width', '2');
      // Insert as the first child so the dot + label paint on top.
      pin.insertBefore(halo, pin.firstChild);
    }
  }
}

// Motion event from the server — pulse the halo for ~1.4 s.
on('motion', (ev) => {
  if (!ev.start) return;                  // only start events drive the halo
  const slot = ev.camera_id;
  if (!slot) return;
  clearTimeout(motionTimers.get(slot));
  motionTimers.set(slot, setTimeout(() => {
    motionTimers.delete(slot);
    reapplyAll();
  }, 1400));
  reapplyAll();
});

// Alert events — flip offline state based on type.
on('alert', (ev) => {
  if (!ev.camera_id) return;
  if (ev.type === 'CAMERA_OFFLINE' || ev.type === 'CAMERA_DARK') {
    offlineSet.add(ev.camera_id);
    reapplyAll();
  }
});
on('alert_resolved', (ev) => {
  if (!ev.camera_id) return;
  offlineSet.delete(ev.camera_id);
  reapplyAll();
});

// Recording state — explicit push when the recorder supervisor observes
// the transition. Falls back to the operator-state poll if no SSE push.
on('recording_state', (ev) => {
  if (!ev.camera_id) return;
  if (ev.recording) recordingSet.add(ev.camera_id);
  else              recordingSet.delete(ev.camera_id);
  reapplyAll();
});

// Bootstrap recording state from window.SV.operatorState every time the
// operator canvas re-renders. Belt-and-braces: SSE drives the live
// transitions, the operator-state poll seeds the initial picture.
function seedFromOperatorState() {
  const state = (window.SV && window.SV.operatorState) || [];
  recordingSet.clear();
  for (const p of state) {
    if (p && p.status && p.status.recording && p.cam_slot) {
      recordingSet.add(p.cam_slot);
    }
    if (p && p.status && p.status.offline && p.cam_slot) {
      offlineSet.add(p.cam_slot);
    } else if (p && p.cam_slot && offlineSet.has(p.cam_slot) &&
               p.status && p.status.online) {
      offlineSet.delete(p.cam_slot);
    }
  }
  reapplyAll();
}

// MutationObserver — fires whenever the operator monolith wipes/rebuilds
// the overlay. That's our cue to re-stamp data-scada-state on the new
// pin SVGs. The observer's subtree:true catches the operator render's
// innerHTML='' + rebuild pattern.
function startObserver() {
  const canvas = document.getElementById('sv-monitor-canvas');
  if (!canvas) {
    // Site View canvas not in the DOM yet — try again next tick.
    setTimeout(startObserver, 500);
    return;
  }
  const mo = new MutationObserver(() => {
    seedFromOperatorState();
  });
  mo.observe(canvas, { childList: true, subtree: true });
  // Initial pass on whatever pins are already there.
  seedFromOperatorState();
}

// Defer init until DOM is ready (script is loaded as a module so it's
// implicitly defer'd, but the operator canvas may still be hidden behind
// a route change). 500 ms poll is fine — this is a one-shot setup.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startObserver);
} else {
  startObserver();
}

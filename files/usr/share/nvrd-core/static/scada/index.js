// =============================================================================
// SCADA module entry — loaded once by index.html via
//   <script type="module" src="/static/scada/index.js"></script>
//
// Pulls in:
//   - sse.js                  (one EventSource shared across modules)
//   - pin_effects.js          (recording pulse, motion halo, offline blink)
//   - sparkline.js            (KPI tile mini-charts)
//   - admin_pin_polish.js     (smooth drag + slider in admin pin editor)
//
// Reads from the monolith via window.S (session/auth) and window.SV
// (site view state). Does NOT modify the monolith — additive only.
//
// Bootstrap order: load CSS, connect SSE once a token exists, register
// effect handlers (each module self-registers on import), poll for the
// coverage rail and seed sparklines when it appears.
// =============================================================================

import { connect as sseConnect, on as sseOn } from './sse.js';
import './pin_effects.js';
import './admin_pin_polish.js';
import './floor_calibration.js';
import './floor_outline.js';
import './room_editor.js';
import './coverage_rooms_rail.js';
import './fullscreen_editor.js';
import './pathway_renderer.js';
import './fov_renderer.js';
import './scada_mimic.js';
import './active_users_chip.js';
import { mountCoverageSparklines } from './sparkline.js';

// Inject the effects stylesheet — keeps the CSS scoped to this module's
// concerns and avoids growing the monolith's <head>.
function injectCSS() {
  if (document.getElementById('scada-css')) return;
  const link = document.createElement('link');
  link.id = 'scada-css';
  link.rel = 'stylesheet';
  link.href = '/static/scada/pin_effects.css';
  document.head.appendChild(link);
}

// Wait for a token, then connect. The login flow stores window.S.token
// after success; we poll briefly to catch it.
function connectWhenAuthed(triesLeft = 60) {
  if (window.S && window.S.token) {
    sseConnect();
    return;
  }
  if (triesLeft <= 0) return;
  setTimeout(() => connectWhenAuthed(triesLeft - 1), 500);
}

// Sparklines — poll Coverage KPIs every 5 s. The rail values are
// rendered into elements with stable ids by the monolith. We just
// read the displayed numbers and feed them to the sparkline buffers.
function startSparklineTick() {
  let sl = null;
  const tick = () => {
    // Mount on first sight of the rail; idempotent thereafter.
    if (!sl) sl = mountCoverageSparklines();
    if (!sl) return;
    for (const id of Object.keys(sl)) {
      const span = document.getElementById(id);
      if (!span || !sl[id]) continue;
      const n = parseFloat(span.textContent);
      if (isFinite(n)) sl[id].push(n);
    }
  };
  setInterval(tick, 5000);
  // Also tick once at startup so the line has a single point right away.
  setTimeout(tick, 1500);
}

// Tiny visible badge: SSE connection state. Bottom-right corner.
// Helps operators (and us during debugging) see at a glance whether the
// live channel is up. Click toggles between "auto-hide on connect" and
// "always show". Removed if you don't want it visible.
function mountStatusBadge() {
  const b = document.createElement('div');
  b.id = 'scada-status';
  Object.assign(b.style, {
    position: 'fixed', right: '12px', bottom: '12px',
    fontFamily: 'ui-monospace, monospace', fontSize: '10px',
    padding: '4px 8px', borderRadius: '12px',
    background: 'rgba(20,22,26,0.78)', color: '#888a95',
    border: '1px solid rgba(255,255,255,0.08)',
    pointerEvents: 'none', zIndex: 9999,
    transition: 'transform 200ms ease',
    opacity: '0.9',
  });
  b.textContent = '• live';
  document.body.appendChild(b);
  const set = (text, color) => {
    b.textContent = text;
    b.style.color = color;
  };
  // Permanently visible SCADA-style status light. No auto-dim. A brief
  // scale pulse on every motion event gives a visible "heartbeat"
  // without changing opacity, so the badge keeps reading at a glance.
  sseOn('_open',  () => { set('● live',   '#86c26f'); });
  sseOn('_error', () => { set('◌ reconn', '#f59e0b'); });
  sseOn('motion', () => {
    b.style.transform = 'scale(1.18)';
    setTimeout(() => { b.style.transform = 'scale(1)'; }, 220);
  });
}

injectCSS();
mountStatusBadge();
connectWhenAuthed();
startSparklineTick();

console.log('[scada] module loaded');

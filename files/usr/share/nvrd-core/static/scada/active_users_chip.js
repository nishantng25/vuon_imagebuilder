// =============================================================================
// Active-users chip — small topbar pill showing how many sessions are
// currently online, broken out by client type:
//
//   👤 3  ·  🌐 2  📱 1  🖥 0
//
// Polls /api/system/active_users every 20 s. Sets X-Client-Type: web
// on every fetch so the server doesn't have to UA-sniff the SPA's
// own browser-flavoured requests. Mobile app + future VMS client
// set their own X-Client-Type header so the bucket is unambiguous.
//
// Mounts into the existing topbar via DOM injection. Falls back
// silently if the topbar isn't on the page (rare — only happens
// pre-login).
// =============================================================================

const POLL_INTERVAL_MS = 20000;
const CHIP_ID = 'scada-active-users-chip';

let pollHandle = null;
let lastCounts = null;

// Topbar selector: the monolith's UP/CPU/RAM/TEMP chips live in
// #topbar-health under `.topbar-chip` styling — we mount our chip
// alongside so it picks up the same theme + layout automatically.
const TOPBAR_HOST_SELECTORS = [
  '#topbar-health',
];

function $(id) { return document.getElementById(id); }

function findHost() {
  for (const sel of TOPBAR_HOST_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function ensureChip() {
  let chip = $(CHIP_ID);
  if (chip) return chip;
  const host = findHost();
  if (host) {
    // Use the monolith's .topbar-chip markup so theme + layout
    // match the existing UP/CPU/RAM/TEMP chips exactly.
    chip = document.createElement('span');
    chip.className = 'topbar-chip';
    chip.id = CHIP_ID;
    chip.title = 'Online users (click for breakdown)';
    chip.style.cursor = 'help';
    chip.innerHTML = `
      <span class="topbar-chip-label">ONLINE</span><span id="${CHIP_ID}-v">…</span>
    `;
    host.appendChild(chip);
  } else {
    // Pre-login fallback — floating chip top-right of viewport.
    chip = document.createElement('div');
    chip.id = CHIP_ID;
    chip.title = 'Online users (click for breakdown)';
    Object.assign(chip.style, {
      position: 'fixed', top: '14px', right: '160px',
      padding: '4px 10px', borderRadius: '10px',
      background: 'rgba(20,22,26,0.86)',
      border: '1px solid rgba(255,255,255,0.12)',
      color: '#ECE6D6',
      fontFamily: 'ui-monospace, monospace', fontSize: '11px',
      zIndex: 9998, pointerEvents: 'auto',
    });
    chip.innerHTML = `<span style="opacity:.6">ONLINE</span> <span id="${CHIP_ID}-v">…</span>`;
    document.body.appendChild(chip);
  }
  chip.addEventListener('click', () => {
    if (lastCounts) {
      const c = lastCounts;
      const lines = [
        `Online users: ${c.total || 0}`,
        '',
        `  🌐 Web      : ${c.web || 0}`,
        `  📱 Mobile   : ${c.mobile || 0}`,
        `  🖥 VMS      : ${c.vms || 0}`,
        `  ❓ Other    : ${c.other || 0}`,
      ];
      window.alert(lines.join('\n'));
    }
  });
  return chip;
}

function paint(c) {
  const valEl = $(CHIP_ID + '-v');
  const chip  = $(CHIP_ID);
  if (!valEl || !chip) return;
  const total = c.total || 0;
  const web = c.web || 0;
  const mob = c.mobile || 0;
  const vms = c.vms || 0;
  // Inside the chip we mirror the existing chip style: short value.
  // Total upfront, breakdown chips appended when any non-zero.
  const bits = [];
  if (web > 0) bits.push(`🌐 ${web}`);
  if (mob > 0) bits.push(`📱 ${mob}`);
  if (vms > 0) bits.push(`🖥 ${vms}`);
  valEl.textContent = bits.length ? `${total} · ${bits.join(' ')}`
                                   : String(total);
  chip.title = `Online users · web ${web} · mobile ${mob} · VMS ${vms} · other ${c.other || 0}`;
}

async function tick() {
  // Use fetch directly so we can set the X-Client-Type header —
  // siteApi.put/get don't propagate custom headers. Reuses the
  // bearer token from window.S.
  const tok = (window.S && window.S.token) || '';
  if (!tok) return;   // not logged in yet
  ensureChip();
  try {
    const res = await fetch('/api/system/active_users', {
      headers: {
        'Authorization': 'Bearer ' + tok,
        'X-Client-Type': 'web',
      },
      cache: 'no-store',
    });
    if (!res.ok) return;
    const c = await res.json();
    lastCounts = c;
    paint(c);
  } catch (_) { /* network blip — try again next tick */ }
}

function start() {
  // Initial poll quick (1.5 s after load) so the chip materialises;
  // then steady-state cadence.
  setTimeout(tick, 1500);
  pollHandle = setInterval(tick, POLL_INTERVAL_MS);
  // Mount the chip preemptively (even before first response) so
  // operators see "👤 …" while data is in flight.
  setTimeout(ensureChip, 800);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', start);
} else {
  start();
}

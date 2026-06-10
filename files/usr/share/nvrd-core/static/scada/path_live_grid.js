// =============================================================================
// Pathway live grid — open every camera mapped to a pathway in one tiled
// live view. Uses the monolith's existing WebCodecs live player
// (startLiveWithWatchdog) so tiles are TRUE live video, not periodic
// snapshots. Each tile gets its own canvas + decoder + WebSocket.
//
// Falls back to snapshot refresh when WebCodecs isn't available
// (Safari without flag, or any browser on plain HTTP without
// Secure Context — VideoDecoder requires HTTPS).
//
// Hardware reality: decoding N independent H.264/H.265 streams on
// the Atom Z8350 is genuinely expensive. Each tile uses sub-stream
// (lower bitrate) which helps a lot, but expect the device to warm
// up at 9+ tiles. The grid auto-warns above 9 cameras.
//
// Public API:
//   openPathwayLiveGrid(route) → opens the modal
//   close() → public so the editor can dismiss programmatically
// =============================================================================

let modalEl = null;
let liveHandles = [];      // [{destroy()}] from startLiveWithWatchdog
let snapshotTimers = [];   // setInterval ids for the snapshot fallback path

function close() {
  for (const h of liveHandles) {
    try { h && h.destroy && h.destroy(); } catch (_) {}
  }
  liveHandles = [];
  for (const t of snapshotTimers) clearInterval(t);
  snapshotTimers = [];
  if (modalEl) { modalEl.remove(); modalEl = null; }
  document.body.style.overflow = '';
}

function gridDims(n) {
  if (n <= 1)  return [1, 1];
  if (n <= 2)  return [2, 1];
  if (n <= 4)  return [2, 2];
  if (n <= 6)  return [3, 2];
  if (n <= 9)  return [3, 3];
  if (n <= 12) return [4, 3];
  if (n <= 16) return [4, 4];
  const cols = Math.ceil(Math.sqrt(n));
  const rows = Math.ceil(n / cols);
  return [cols, rows];
}

function camName(slot) {
  const cams = (window.S && Array.isArray(window.S.cameras)) ? window.S.cameras : [];
  const c = cams.find(x => x && x.id === slot);
  return c ? (c.name || c.id) : slot;
}

// canStartLive: WebCodecs + the monolith's player both available?
function canStartLive() {
  return typeof window.startLiveWithWatchdog === 'function'
      && typeof VideoDecoder !== 'undefined';
}

export function openPathwayLiveGrid(route) {
  if (!route || !Array.isArray(route.cameras) || route.cameras.length === 0) {
    if (window.toast) window.toast(
      'No cameras assigned to this pathway. Use "Cameras" to assign first.',
      'warn');
    return;
  }
  close();

  const cams = route.cameras.slice();
  const [cols, rows] = gridDims(cams.length);
  const colour = (typeof route.color === 'string' && route.color) ? route.color : '#5c8bf2';
  const live = canStartLive();

  modalEl = document.createElement('div');
  Object.assign(modalEl.style, {
    position: 'fixed', inset: '0',
    background: '#0c0e13',
    zIndex: 10005,
    display: 'flex', flexDirection: 'column',
    fontFamily: 'ui-monospace, monospace', color: '#ECE6D6',
  });

  const head = document.createElement('div');
  Object.assign(head.style, {
    display: 'flex', alignItems: 'center', gap: '12px',
    padding: '10px 14px',
    background: '#1a1d22', borderBottom: '1px solid #3c3f47',
    fontSize: '12px',
  });
  const modeBadge = live
    ? '<span style="color:#86c26f;font-weight:700;">● LIVE</span>'
    : '<span style="color:#f59e0b;font-weight:700;">◌ snapshot</span>';
  const warn = (cams.length > 9 && live)
    ? `<span style="color:#f59e0b;font-size:11px;">⚠ ${cams.length} tiles may strain the device — close some if it stutters</span>`
    : '';
  head.innerHTML = `
    <div style="width:12px;height:12px;background:${colour};border-radius:2px;"></div>
    <div style="font-size:14px;font-weight:700;">🛤 ${escapeHTML(route.name)}</div>
    <div style="color:#888a95;">·</div>
    <div style="color:#888a95;">${cams.length} camera${cams.length === 1 ? '' : 's'} · ${cols}×${rows} · ${modeBadge}</div>
    ${warn ? `<div style="color:#888a95;">·</div>${warn}` : ''}
    <div style="flex:1"></div>
    <button id="scada-plg-close"
            style="cursor:pointer;background:#d95a50;color:#fff;border:none;
                   padding:6px 16px;border-radius:3px;font-family:inherit;
                   font-size:12px;font-weight:700;">✕ Close</button>
  `;
  modalEl.appendChild(head);

  const grid = document.createElement('div');
  Object.assign(grid.style, {
    flex: '1', display: 'grid',
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows:    `repeat(${rows}, 1fr)`,
    gap: '4px', padding: '6px',
    background: '#0a0c10',
    minHeight: '0',
  });
  modalEl.appendChild(grid);

  const tok = (window.S && window.S.token) || '';

  for (const slot of cams) {
    const tile = document.createElement('div');
    Object.assign(tile.style, {
      position: 'relative', background: '#000',
      border: '1px solid #2c2f37', borderRadius: '3px',
      overflow: 'hidden', minWidth: '0', minHeight: '0',
      cursor: 'pointer',
    });

    if (live) {
      // True live tile via the monolith's WebCodecs player. Each
      // canvas needs a unique id so the watchdog can verify it still
      // exists between attempts; prefix with scada-plg- to avoid
      // colliding with the Live page's `lv-{slot}` canvases.
      const canvas = document.createElement('canvas');
      const cid = `scada-plg-lv-${slot}`;
      canvas.id = cid;
      Object.assign(canvas.style, {
        position: 'absolute', inset: '0',
        width: '100%', height: '100%',
        objectFit: 'contain',
        backgroundColor: '#000',
      });
      tile.appendChild(canvas);
      // Start the live player after the DOM mount.
      setTimeout(() => {
        try {
          const h = window.startLiveWithWatchdog(slot, canvas, 'sub', {
            _allowAnyView: true,
            _canvasId: cid,
          });
          if (h) liveHandles.push(h);
        } catch (e) {
          console.warn('[plg] startLiveWithWatchdog failed for', slot, e);
          // Fallback: replace the canvas with a snapshot img.
          canvas.remove();
          mountSnapshotTile(tile, slot, tok);
        }
      }, 0);
    } else {
      // Fallback path: refreshing snapshot, same as the old version.
      mountSnapshotTile(tile, slot, tok);
    }

    const label = document.createElement('div');
    Object.assign(label.style, {
      position: 'absolute', left: '4px', bottom: '4px',
      background: 'rgba(0,0,0,0.65)',
      color: '#ECE6D6',
      padding: '2px 6px', borderRadius: '2px',
      fontSize: '11px', fontFamily: 'ui-monospace, monospace',
      fontWeight: '600',
      pointerEvents: 'none',
    });
    label.textContent = `${slot} · ${camName(slot)}`;
    tile.appendChild(label);

    // Click any tile → open the full-resolution single-cam player.
    // Use the same machinery; pass _allowAnyView so it works from
    // here regardless of which page is "underneath".
    tile.addEventListener('click', () => {
      // The simplest hand-off: navigate to the regular Live page if
      // exposed. The monolith's full Live page assigns one main-stream
      // tile per camera with controls. Falls back to opening the
      // snapshot URL in a new tab.
      window.open(`/api/cameras/${encodeURIComponent(slot)}/snapshot?token=${encodeURIComponent(tok)}`, '_blank');
    });

    grid.appendChild(tile);
  }

  document.body.appendChild(modalEl);
  document.body.style.overflow = 'hidden';

  document.getElementById('scada-plg-close').onclick = close;

  // Esc closes the grid.
  const onKey = (ev) => {
    if (ev.key === 'Escape') {
      close();
      document.removeEventListener('keydown', onKey);
    }
  };
  document.addEventListener('keydown', onKey);
}

function mountSnapshotTile(tile, slot, tok) {
  const img = document.createElement('img');
  Object.assign(img.style, {
    position: 'absolute', inset: '0',
    width: '100%', height: '100%',
    objectFit: 'contain',
    userSelect: 'none', pointerEvents: 'none',
  });
  img.alt = slot;
  const refresh = () => {
    img.src = `/api/cameras/${encodeURIComponent(slot)}/snapshot?token=${encodeURIComponent(tok)}&t=${Date.now()}`;
  };
  refresh();
  snapshotTimers.push(setInterval(refresh, 1200));
  tile.appendChild(img);
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, m => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  })[m]);
}

export { close };

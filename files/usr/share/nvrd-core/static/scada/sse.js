// =============================================================================
// SSE client — single EventSource shared across the SPA.
//
// Why a module + shared instance: only one TCP connection per browser tab,
// dispatchers register per event type, automatic reconnect rides on the
// EventSource spec (no manual backoff loop needed). Reconnect resumes from
// `lastEventId` if the server ever implements backfill — today the server
// does not, but EventSource sends Last-Event-ID after every reconnect at no
// cost so we get future support for free.
//
// Auth: token comes from window.S.token (the existing SPA login flow puts
// the bearer there). We pass it via ?token= because EventSource cannot set
// headers — matches the HLS manifest's wire trade-off.
// =============================================================================

const handlers = new Map();           // eventType → Set<fn(payload)>
let source = null;
let reconnectTimer = null;

// Internal: dispatch one decoded payload to every registered handler.
function dispatch(type, payload) {
  const subs = handlers.get(type);
  if (!subs || subs.size === 0) return;
  for (const fn of subs) {
    try { fn(payload); }
    catch (e) { console.warn('[sse]', type, 'handler threw:', e); }
  }
}

// Public: register a handler for `type`. Returns an unsubscribe fn so
// callers can clean up on view-tear-down without keeping a separate
// reference. Same fn registered twice is a no-op (Set semantics).
export function on(type, fn) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(fn);
  return () => { handlers.get(type).delete(fn); };
}

// Public: open (or re-open) the stream. Idempotent — calling twice
// without disconnect-in-between is a no-op (the existing EventSource is
// reused). Caller is the SPA's startup sequence after login.
export function connect() {
  if (source && source.readyState !== EventSource.CLOSED) return;
  const tok = (window.S && window.S.token) || '';
  if (!tok) {
    // No token yet — defer; the SPA may call connect() again post-login.
    return;
  }
  const url = '/api/events/stream?token=' + encodeURIComponent(tok);
  source = new EventSource(url);

  // The server emits named events (`event: motion\ndata: {...}`) so we
  // listen per type. Generic onmessage catches anything without a type
  // (heartbeat is sent as a comment line — EventSource silently drops
  // those, so no handler needed for heartbeats).
  for (const type of ['motion', 'alert', 'alert_resolved', 'recording_state']) {
    source.addEventListener(type, (ev) => {
      let payload;
      try { payload = JSON.parse(ev.data); }
      catch (e) { console.warn('[sse]', type, 'bad json:', ev.data); return; }
      dispatch(type, payload);
    });
  }

  source.addEventListener('open', () => {
    // Tells SCADA polish modules they can start animating — before
    // first connect, pins show last-known status only.
    dispatch('_open', { at: Date.now() });
  });

  source.addEventListener('error', () => {
    // EventSource auto-reconnects with its own backoff; we surface the
    // state change so the SPA can show a "reconnecting" badge.
    dispatch('_error', { readyState: source.readyState });
    // If the server CLOSED us (401, etc), EventSource won't retry on
    // its own. Reopen after 5 s in that case.
    if (source.readyState === EventSource.CLOSED) {
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(() => { source = null; connect(); }, 5000);
    }
  });
}

// Public: close the stream (used on logout). Most callers don't need this.
export function disconnect() {
  if (source) {
    source.close();
    source = null;
  }
  clearTimeout(reconnectTimer);
}

// Diagnostics for the console.
export function debugStatus() {
  return {
    readyState: source ? source.readyState : -1,
    handlerCounts: Object.fromEntries(
      Array.from(handlers.entries()).map(([k, v]) => [k, v.size])),
  };
}

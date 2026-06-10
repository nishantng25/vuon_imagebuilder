// =============================================================================
// Units — the server stays SI (metres) at all times, single source of truth.
// The SPA presents and parses values in whichever unit the operator prefers.
//
// India is the immediate driver: most operators think in feet (and sometimes
// feet+inches for shorter spans like room widths). UK/US sites benefit
// equally. The preference lives in localStorage so it survives a refresh.
//
// API:
//   getUnit()            → 'm' | 'ft' | 'ftin'   (current preference)
//   setUnit(unit)        → persists + dispatches a 'scada-unit-changed' event
//   parseToMeters(str)   → number | null   (lenient: '18', '18 ft', '18 ft 6 in', '5.5m')
//   formatFromMeters(m)  → string in the current unit, sensibly precise
//   onUnitChange(fn)     → register handler, returns unsubscribe
// =============================================================================

const STORAGE_KEY = 'scada.unit';
const FT_PER_M    = 3.280839895;
const M_PER_FT    = 0.3048;
const listeners   = new Set();

function readStored() {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === 'm' || v === 'ft' || v === 'ftin') return v;
  } catch (_) {}
  // Default to feet for India / US. Operators that prefer metres flip the
  // toggle once; the choice sticks.
  return 'ft';
}

export function getUnit() { return readStored(); }

export function setUnit(unit) {
  if (unit !== 'm' && unit !== 'ft' && unit !== 'ftin') return;
  try { localStorage.setItem(STORAGE_KEY, unit); } catch (_) {}
  for (const fn of listeners) {
    try { fn(unit); } catch (e) { console.warn('[units] listener threw', e); }
  }
  // Also dispatch a window event so the monolith / other modules can hook
  // without importing this file directly.
  try {
    window.dispatchEvent(new CustomEvent('scada-unit-changed', { detail: { unit } }));
  } catch (_) {}
}

export function onUnitChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// Parse a free-text length into metres. Lenient — accepts:
//   "18"              → assume current unit
//   "18 m"  "18m"     → metres
//   "18 ft" "18ft"    → feet
//   "18'"             → feet (prime symbol)
//   "18 ft 6 in"      → 18.5 ft
//   "18 ft 6"         → 18.5 ft (bare second number = inches)
//   "18'6\""          → feet + inches
//   "5.5 m"           → 5.5 m
// Returns null on invalid input. Negative or zero values return null too.
export function parseToMeters(input) {
  if (typeof input !== 'string') input = String(input || '');
  const s = input.trim().toLowerCase();
  if (s === '') return null;

  // Explicit "m" or "metre" → metres (regardless of preference).
  let m = s.match(/^([0-9]+\.?[0-9]*)\s*(?:m|meter|metre|metres|meters)\s*$/);
  if (m) return finite(parseFloat(m[1]));

  // ft + in, various punctuation.
  m = s.match(/^([0-9]+\.?[0-9]*)\s*(?:'|ft|feet|foot)\s*([0-9]+\.?[0-9]*)\s*(?:"|in|inch|inches)?\s*$/);
  if (m) {
    const ft = parseFloat(m[1]);
    const inches = parseFloat(m[2]);
    if (!isFinite(ft) || !isFinite(inches)) return null;
    return finite((ft + inches / 12) * M_PER_FT);
  }

  // Just feet.
  m = s.match(/^([0-9]+\.?[0-9]*)\s*(?:'|ft|feet|foot)\s*$/);
  if (m) return finite(parseFloat(m[1]) * M_PER_FT);

  // Just inches.
  m = s.match(/^([0-9]+\.?[0-9]*)\s*(?:"|in|inch|inches)\s*$/);
  if (m) return finite(parseFloat(m[1]) * M_PER_FT / 12);

  // Bare number → interpret in the current preference.
  m = s.match(/^([0-9]+\.?[0-9]*)\s*$/);
  if (m) {
    const n = parseFloat(m[1]);
    if (!isFinite(n)) return null;
    const unit = getUnit();
    if (unit === 'm')   return finite(n);
    if (unit === 'ft')  return finite(n * M_PER_FT);
    if (unit === 'ftin') return finite(n * M_PER_FT);  // treated as feet
  }
  return null;
}

function finite(n) {
  if (!isFinite(n) || n <= 0) return null;
  return n;
}

// Format a metres value to a display string in the current unit.
// Precision rules tuned by hand for the typical room/floor magnitudes:
//   ft: one decimal up to 100 ft, integer beyond
//   m:  one decimal always
//   ftin: integer feet + integer inches ("18 ft 6 in")
export function formatFromMeters(m, opts = {}) {
  if (!isFinite(m) || m < 0) return '—';
  const unit = opts.unit || getUnit();
  if (unit === 'm') {
    return m.toFixed(1) + ' m';
  }
  const ft = m * FT_PER_M;
  if (unit === 'ftin') {
    const wholeFt = Math.floor(ft);
    const inches  = Math.round((ft - wholeFt) * 12);
    // Carry: 11.5 in → 12 in → +1 ft, 0 in.
    if (inches === 12) return (wholeFt + 1) + ' ft 0 in';
    return wholeFt + ' ft ' + inches + ' in';
  }
  // ft
  if (ft < 100) return ft.toFixed(1) + ' ft';
  return Math.round(ft) + ' ft';
}

// Area: square metres → user's preferred unit. ft² for ft and ftin; m² for m.
export function formatAreaFromMeters2(m2, opts = {}) {
  if (!isFinite(m2) || m2 < 0) return '—';
  const unit = opts.unit || getUnit();
  if (unit === 'm') {
    return m2.toFixed(1) + ' m²';
  }
  const ft2 = m2 * FT_PER_M * FT_PER_M;
  return Math.round(ft2).toLocaleString() + ' ft²';
}

// Unit-toggle widget: a tiny m / ft / ft+in segmented control. Mount it
// anywhere — it sizes to its host. Calls onChange with the new unit; also
// dispatches the global event.
export function mountUnitToggle(host, opts = {}) {
  const wrap = document.createElement('div');
  Object.assign(wrap.style, {
    display: 'inline-flex',
    border: '1px solid #3c3f47',
    borderRadius: '3px',
    overflow: 'hidden',
    fontFamily: 'ui-monospace, monospace',
    fontSize: '10px',
  });
  const units = [
    { id: 'm',    label: 'm'   },
    { id: 'ft',   label: 'ft'  },
    { id: 'ftin', label: 'ft+in' },
  ];
  const buttons = {};
  for (const u of units) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = u.label;
    Object.assign(b.style, {
      cursor: 'pointer', background: 'transparent', color: '#888a95',
      border: 'none', padding: '3px 8px', fontFamily: 'inherit',
      fontSize: 'inherit',
    });
    b.onclick = () => {
      setUnit(u.id);
      paint();
      if (opts.onChange) opts.onChange(u.id);
    };
    wrap.appendChild(b);
    buttons[u.id] = b;
  }
  function paint() {
    const cur = getUnit();
    for (const u of units) {
      buttons[u.id].style.background = (u.id === cur) ? '#f59e0b' : 'transparent';
      buttons[u.id].style.color      = (u.id === cur) ? '#0c0e13' : '#888a95';
      buttons[u.id].style.fontWeight = (u.id === cur) ? '700' : '400';
    }
  }
  paint();
  host.appendChild(wrap);
  // Repaint when the unit changes elsewhere (e.g. another widget).
  onUnitChange(paint);
  return wrap;
}

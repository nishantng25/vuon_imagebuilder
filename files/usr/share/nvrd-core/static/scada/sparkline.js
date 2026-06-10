// =============================================================================
// Sparkline — tiny SVG line chart, 60-sample circular buffer per tile.
// Pure vanilla, no deps. One <svg> per KPI tile.
//
// Usage:
//   import { Sparkline } from './sparkline.js';
//   const sl = new Sparkline(document.querySelector('#sv-cov-kpi-pct'));
//   sl.push(82.5);   // every poll tick
// =============================================================================

const NS = 'http://www.w3.org/2000/svg';
const CAPACITY = 60;       // ~5 min at 5 s polls; fits in a 120×24 tile
const WIDTH  = 120;
const HEIGHT = 24;

export class Sparkline {
  constructor(host, opts = {}) {
    this.samples = [];
    this.color   = opts.color || '#86c26f';
    this.svg     = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
    this.svg.setAttribute('width',  '100%');
    this.svg.setAttribute('height', '18');
    this.svg.style.display = 'block';
    this.svg.style.marginTop = '4px';
    this.svg.style.opacity = '0.85';

    this.path = document.createElementNS(NS, 'polyline');
    this.path.setAttribute('fill', 'none');
    this.path.setAttribute('stroke', this.color);
    this.path.setAttribute('stroke-width', '1.4');
    this.path.setAttribute('stroke-linecap', 'round');
    this.path.setAttribute('stroke-linejoin', 'round');
    this.svg.appendChild(this.path);

    // Subtle baseline.
    const base = document.createElementNS(NS, 'line');
    base.setAttribute('x1', '0');     base.setAttribute('y1', HEIGHT - 0.5);
    base.setAttribute('x2', WIDTH);   base.setAttribute('y2', HEIGHT - 0.5);
    base.setAttribute('stroke', 'rgba(255,255,255,0.06)');
    base.setAttribute('stroke-width', '1');
    this.svg.insertBefore(base, this.path);

    host.appendChild(this.svg);
  }

  push(value) {
    if (typeof value !== 'number' || !isFinite(value)) return;
    this.samples.push(value);
    if (this.samples.length > CAPACITY) this.samples.shift();
    this._draw();
  }

  _draw() {
    if (this.samples.length < 2) {
      this.path.setAttribute('points', '');
      return;
    }
    // Y-scale: fit the visible range with a small headroom so the line
    // doesn't kiss the top or bottom edge.
    let min = Infinity, max = -Infinity;
    for (const v of this.samples) {
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (min === max) { min -= 1; max += 1; }
    const pad = (max - min) * 0.12;
    const lo = min - pad, hi = max + pad;
    const yScale = (v) => HEIGHT - ((v - lo) / (hi - lo)) * (HEIGHT - 2) - 1;

    // X-scale: samples are uniformly spaced over the right edge of the
    // tile, with empty space on the left until the buffer fills.
    const n = this.samples.length;
    const xStep = WIDTH / (CAPACITY - 1);
    const points = [];
    for (let i = 0; i < n; i++) {
      const x = (CAPACITY - n + i) * xStep;
      const y = yScale(this.samples[i]);
      points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    this.path.setAttribute('points', points.join(' '));
  }
}

// Convenience: mount sparklines under the Coverage rail KPIs. Called from
// pin_effects bootstrap. Idempotent — re-mounting skips if already
// installed (the host carries data-sparkline-mounted="1").
export function mountCoverageSparklines() {
  const tiles = [
    { id: 'sv-cov-kpi-cams',  color: '#86c26f' },
    { id: 'sv-cov-kpi-pct',   color: '#86c26f' },
    { id: 'sv-cov-kpi-red',   color: '#5c8bf2' },
    { id: 'sv-cov-kpi-blind', color: '#d95a50' },
  ];
  const out = {};
  for (const t of tiles) {
    const span = document.getElementById(t.id);
    if (!span) continue;
    const tile = span.closest('.sv-kpi-tile');
    if (!tile || tile.dataset.sparklineMounted === '1') {
      out[t.id] = tile && tile._sparkline;
      continue;
    }
    const sl = new Sparkline(tile, { color: t.color });
    tile.dataset.sparklineMounted = '1';
    tile._sparkline = sl;
    out[t.id] = sl;
  }
  return out;
}

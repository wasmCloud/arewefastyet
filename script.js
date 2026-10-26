// arewefastyet.wasmcloud.com — trends view
//
// Loads data/history.json (one JSON array of bench result rows), groups by
// (bench, group, param), and renders one Chart.js timeline per (bench, group).
//
// Two row shapes coexist in history.json:
//   - Criterion rows carry `metric: "mean_ns"` alongside the original
//     `mean_ns` / `median_ns` / `ci_*` / `throughput` fields. Per-chart
//     unit is derived from `throughput`:
//       throughput.Elements > 1  →  ops/sec  (higher is better)
//       throughput.Bytes    > 0  →  B/s      (higher is better)
//       otherwise                →  time     (lower is better)
//   - gungraun rows (gungraun bench) carry `metric: "Ir"` plus
//     a unit-less `value` (instruction count). No CIs, no throughput.
//     Rendered as instructions, lower is better.
//   - Self-describing rows (scale_density, k6) carry `metric`, `value`,
//     their own `unit` and `better: "higher" | "lower"`. One (group, param)
//     holds several metrics, so these chart per (group, metric) — see
//     chartGroup().
//
// Older rows from before the schema bump have no `.metric` field; they
// are treated as criterion rows (the per-row throughput logic still
// works).

const PALETTE = {
  p2: { line: '#06b6d4', band: 'rgba(6, 182, 212, 0.18)' },
  p3: { line: '#a855f7', band: 'rgba(168, 85, 247, 0.18)' },
};
const FALLBACK = [
  { line: '#10b981', band: 'rgba(16, 185, 129, 0.18)' },
  { line: '#f59e0b', band: 'rgba(245, 158, 11, 0.18)' },
  { line: '#ef4444', band: 'rgba(239, 68, 68, 0.18)' },
  { line: '#3b82f6', band: 'rgba(59, 130, 246, 0.18)' },
];

const REPO_URL = 'https://github.com/wasmCloud/wasmCloud';

let allRows = [];
let allAnnotations = [];
const charts = new Map();

document.addEventListener('DOMContentLoaded', main);

async function main() {
  const root = document.getElementById('charts');
  const refSel = document.getElementById('ref-filter');
  // Compare + releases pages also load this file (for the AWFY helpers
  // exported below). Both have #charts, but only the trends page has the
  // trends-specific #ref-filter — so use that as the trigger.
  if (!root || !refSel) return;
  try {
    allRows = await loadHistory();
    allAnnotations = await loadAnnotations();
  } catch (err) {
    root.innerHTML = `<p class="error">Could not load history: ${escapeHtml(err.message)}</p>`;
    return;
  }

  if (!Array.isArray(allRows) || allRows.length === 0) {
    root.innerHTML = '<p class="empty">No bench runs yet. Trigger one in the GitHub <a href="' + REPO_URL + '/actions/workflows/bench.yml">bench workflow</a>.</p>';
    return;
  }

  const benches = [...new Set(allRows.map(r => r.bench))].sort();
  const benchSel = document.getElementById('bench-filter');
  for (const b of benches) {
    const opt = document.createElement('option');
    opt.value = b; opt.textContent = b;
    benchSel.appendChild(opt);
  }

  // ?ref= and ?bench= preselect the filters, so a shared link can show
  // e.g. a PR's run beside main's (?ref=all). Kept in sync as they change.
  // A missing or unknown value means the default, so the URL wins over any
  // selection the browser restores on reload or back/forward.
  const filters = [['ref', refSel, 'main'], ['bench', benchSel, 'all']];
  const query = new URLSearchParams(location.search);
  for (const [key, sel, dflt] of filters) {
    const v = query.get(key);
    sel.value = v && [...sel.options].some(o => o.value === v) ? v : dflt;
  }
  const onFilterChange = () => {
    const q = new URLSearchParams(location.search);
    for (const [key, sel, dflt] of filters) {
      if (sel.value === dflt) q.delete(key); else q.set(key, sel.value);
    }
    const search = q.toString();
    history.replaceState(null, '', `${location.pathname}${search ? `?${search}` : ''}${location.hash}`);
    render();
  };
  benchSel.addEventListener('change', onFilterChange);
  refSel.addEventListener('change', onFilterChange);

  setLastUpdated(allRows);
  render();
  scrollToHash();
}

function setLastUpdated(rows) {
  const latest = rows
    .map(r => r.timestamp)
    .filter(Boolean)
    .sort()
    .at(-1);
  if (!latest) return;
  const d = new Date(latest);
  document.getElementById('last-updated').textContent =
    `last run: ${d.toISOString().slice(0, 16).replace('T', ' ')}Z (${relTime(d)})`;
}

function render() {
  const refFilter = document.getElementById('ref-filter').value;
  const benchFilter = document.getElementById('bench-filter').value;

  const rows = allRows.filter(r => {
    if (refFilter !== 'all' && r.ref !== refFilter) return false;
    if (benchFilter !== 'all' && r.bench !== benchFilter) return false;
    return true;
  });

  for (const c of charts.values()) c.destroy();
  charts.clear();

  const root = document.getElementById('charts');
  root.innerHTML = '';

  if (rows.length === 0) {
    root.innerHTML = '<p class="empty">No runs match the current filters.</p>';
    return;
  }

  const tree = {};
  for (const r of rows) {
    (((tree[r.bench] ??= {})[chartGroup(r)] ??= {})[r.param] ??= []).push(r);
  }
  for (const groups of Object.values(tree)) {
    for (const params of Object.values(groups)) {
      for (const k in params) {
        params[k].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
      }
    }
  }

  for (const bench of Object.keys(tree).sort()) {
    const sec = document.createElement('section');
    sec.className = 'bench-section';
    sec.id = anchorId(bench);
    sec.innerHTML = `<h2>${anchorLink(sec.id, bench)}</h2>`;
    for (const group of Object.keys(tree[bench]).sort()) {
      sec.appendChild(renderCard(bench, group, tree[bench][group]));
    }
    root.appendChild(sec);
  }
}

function renderCard(bench, group, paramMap) {
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = anchorId(bench, group);

  const params = Object.keys(paramMap).sort();
  // All rows in a chart share the same metric semantics (criterion
  // throughput config, or a self-describing row's unit), so any one row
  // will do.
  const meta = describeMetric(paramMap[params[0]][0]);

  const latestSpans = params.map((p, i) => {
    const rows = paramMap[p];
    const last = rows.at(-1);
    const prev = rows.at(-2);
    const color = colorFor(p, i).line;
    const lastV = last ? toMetric(last, meta) : null;
    const prevV = prev ? toMetric(prev, meta) : null;
    const cur = lastV != null ? meta.format(lastV) : '—';
    let deltaHtml = '';
    if (lastV != null && prevV != null && prevV !== 0) {
      const pct = ((lastV - prevV) / prevV) * 100;
      const cls = significanceClass(pct, meta.higherIsBetter);
      const sign = pct > 0 ? '+' : '';
      deltaHtml = `<span class="delta ${cls}">${sign}${pct.toFixed(1)} %</span>`;
    }
    return `<span><span class="swatch" style="background:${color}"></span>${escapeHtml(p)} ${cur}${deltaHtml}</span>`;
  }).join('');

  const subtitle = meta.higherIsBetter
    ? `<span class="metric-hint">${meta.unit} · higher is better</span>`
    : `<span class="metric-hint">${meta.unit} · lower is better</span>`;

  card.innerHTML = `
    <header>
      <h3>${anchorLink(card.id, group)} ${subtitle}</h3>
      <div class="latest">${latestSpans}</div>
    </header>
    <div class="chart-wrapper"><canvas></canvas></div>
  `;

  const canvas = card.querySelector('canvas');
  const datasets = params.map((p, i) => {
    const color = colorFor(p, i);
    const rows = paramMap[p];
    return {
      label: p,
      data: rows.map(r => {
        const ci = ciToMetric(r, meta);
        return {
          x: r.timestamp,
          y: toMetric(r, meta),
          ci_low: ci.low,
          ci_high: ci.high,
          sha: r.short_sha,
          ref: r.ref,
          run_id: r.run_id,
        };
      }),
      borderColor: color.line,
      backgroundColor: color.band,
      pointBackgroundColor: color.line,
      pointRadius: 3,
      pointHoverRadius: 5,
      borderWidth: 1.5,
      tension: 0.05,
    };
  });

  const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const muted = isDark ? '#888' : '#666';
  const grid = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      onClick: (_, els) => {
        if (!els.length) return;
        const e = els[0];
        const raw = datasets[e.datasetIndex].data[e.index];
        if (raw && raw.run_id) {
          window.open(`${REPO_URL}/actions/runs/${raw.run_id}`, '_blank');
        }
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'yyyy-MM-dd HH:mm' },
          ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 },
          grid: { color: grid },
        },
        y: {
          beginAtZero: false,
          ticks: { color: muted, callback: v => meta.format(v) },
          grid: { color: grid },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => {
              if (!items.length) return '';
              const r = items[0].raw;
              return `${r.sha}  ·  ${r.ref}`;
            },
            label: ctx => {
              const r = ctx.raw;
              const ci = (r.ci_low != null && r.ci_high != null)
                ? ` (95 % CI ${meta.format(r.ci_low)} – ${meta.format(r.ci_high)})`
                : '';
              return `${ctx.dataset.label}: ${meta.format(r.y)}${ci}`;
            },
          },
        },
        annotation: {
          annotations: annotationsForChart(allAnnotations, paramMap),
        },
      },
    },
  });
  charts.set(`${bench}/${group}`, chart);
  return card;
}

// ── metric helpers (also used by compare.js) ──────────────────────────────

// Self-describing rows name their own unit and direction rather than
// relying on criterion's throughput config.
function isSelfDescribing(row) {
  return row != null && row.unit != null && (row.better === 'higher' || row.better === 'lower');
}

// The chart (or compare-table group) a row belongs to. Criterion and
// gungraun rows hold one metric per group; self-describing rows hold
// several, so they split by metric to keep one unit per chart.
function chartGroup(row) {
  return isSelfDescribing(row) ? `${row.group} · ${row.metric}` : row.group;
}

function describeMetric(row) {
  if (isSelfDescribing(row)) {
    return {
      kind: 'value',
      format: formatterForUnit(row.unit),
      unit: row.unit,
      higherIsBetter: row.better === 'higher',
    };
  }
  // gungraun: deterministic instruction count, lower is better.
  // Detected by the explicit `metric` field rather than bench name so the
  // moment we add more gungraun benches the same path picks them up.
  if (row && row.metric === 'Ir') {
    return {
      kind: 'instructions',
      format: formatInstructions,
      unit: 'instructions',
      higherIsBetter: false,
    };
  }
  const t = row && row.throughput;
  if (t && typeof t.Elements === 'number' && t.Elements > 1) {
    return {
      kind: 'rps',
      elements: t.Elements,
      format: formatRps,
      unit: 'ops/s',
      higherIsBetter: true,
    };
  }
  if (t && typeof t.Bytes === 'number' && t.Bytes > 0) {
    return {
      kind: 'bps',
      bytes: t.Bytes,
      format: formatBps,
      unit: 'B/s',
      higherIsBetter: true,
    };
  }
  return {
    kind: 'time',
    format: formatNs,
    unit: 'time',
    higherIsBetter: false,
  };
}

function toMetric(row, meta) {
  if (meta.kind === 'rps')          return (meta.elements * 1e9) / row.mean_ns;
  if (meta.kind === 'bps')          return (meta.bytes    * 1e9) / row.mean_ns;
  if (meta.kind === 'instructions') return row.value;
  if (meta.kind === 'value')        return row.value;
  return row.mean_ns;
}

// CI bounds invert when converting time → rate: low time = high rate, etc.
// gungraun doesn't emit a CI; we return nulls so the renderer hides the
// CI band rather than drawing it from undefined values.
function ciToMetric(row, meta) {
  if (meta.kind === 'rps') {
    return {
      low:  row.ci_high_ns ? (meta.elements * 1e9) / row.ci_high_ns : null,
      high: row.ci_low_ns  ? (meta.elements * 1e9) / row.ci_low_ns  : null,
    };
  }
  if (meta.kind === 'bps') {
    return {
      low:  row.ci_high_ns ? (meta.bytes * 1e9) / row.ci_high_ns : null,
      high: row.ci_low_ns  ? (meta.bytes * 1e9) / row.ci_low_ns  : null,
    };
  }
  if (meta.kind === 'instructions' || meta.kind === 'value') {
    return { low: null, high: null };
  }
  return { low: row.ci_low_ns, high: row.ci_high_ns };
}

function significanceClass(pct, higherIsBetter) {
  if (Math.abs(pct) < 0.5) return '';
  const isImprove = higherIsBetter ? pct > 0 : pct < 0;
  return isImprove ? 'improve' : 'regress';
}

function colorFor(param, fallbackIdx) {
  return PALETTE[param] ?? FALLBACK[fallbackIdx % FALLBACK.length];
}

function formatNs(ns) {
  if (ns == null || isNaN(ns)) return '—';
  const sign = ns < 0 ? '-' : '';
  const abs = Math.abs(ns);
  if (abs < 1_000) return `${sign}${Math.round(abs)} ns`;
  if (abs < 1_000_000) return `${sign}${(abs / 1_000).toFixed(2)} µs`;
  if (abs < 1_000_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)} ms`;
  return `${sign}${(abs / 1_000_000_000).toFixed(2)} s`;
}

function formatRps(rps) {
  if (rps == null || isNaN(rps)) return '—';
  if (rps >= 1e6) return `${(rps / 1e6).toFixed(2)} Mreq/s`;
  if (rps >= 1e3) return `${(rps / 1e3).toFixed(2)} Kreq/s`;
  return `${rps.toFixed(0)} req/s`;
}

function formatBps(bps) {
  if (bps == null || isNaN(bps)) return '—';
  if (bps >= 1e9) return `${(bps / 1e9).toFixed(2)} GB/s`;
  if (bps >= 1e6) return `${(bps / 1e6).toFixed(2)} MB/s`;
  if (bps >= 1e3) return `${(bps / 1e3).toFixed(2)} KB/s`;
  return `${bps.toFixed(0)} B/s`;
}

// SI-prefix instruction counts. K = 1e3, M = 1e6, G = 1e9 — matching how
// cachegrind / gungraun themselves print summary lines. This is the
// view metric: 12_345_678 → "12.35 M".
function formatInstructions(n) {
  if (n == null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${(abs / 1e9).toFixed(2)} G`;
  if (abs >= 1e6) return `${sign}${(abs / 1e6).toFixed(2)} M`;
  if (abs >= 1e3) return `${sign}${(abs / 1e3).toFixed(2)} K`;
  return `${sign}${Math.round(abs)}`;
}

// Formatter for a self-describing row's `unit`. Unknown units fall back
// to an SI-scaled number with the unit appended.
function formatterForUnit(unit) {
  if (unit === 'ms') return ms => (ms == null || isNaN(ms) ? '—' : formatNs(ms * 1e6));
  if (unit === 'ns') return formatNs;
  if (unit === 'B') return formatBytes;
  return n => {
    if (n == null || isNaN(n)) return '—';
    const abs = Math.abs(n);
    const num = abs < 1e3 && !Number.isInteger(n) ? n.toFixed(2) : formatInstructions(n);
    return `${num} ${unit}`;
  };
}

// IEC-scaled byte sizes, matching how scale_density prints its footprint.
function formatBytes(b) {
  if (b == null || isNaN(b)) return '—';
  const sign = b < 0 ? '-' : '';
  const abs = Math.abs(b);
  if (abs >= 2 ** 30) return `${sign}${(abs / 2 ** 30).toFixed(2)} GiB`;
  if (abs >= 2 ** 20) return `${sign}${(abs / 2 ** 20).toFixed(2)} MiB`;
  if (abs >= 2 ** 10) return `${sign}${(abs / 2 ** 10).toFixed(2)} KiB`;
  return `${sign}${Math.round(abs)} B`;
}

function relTime(d) {
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return `${Math.round(sec)} s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
}

// Fragment id for a bench section or chart card, so either can be linked
// to directly: "scale_density", "scale_density-density-served_workloads".
function anchorId(...parts) {
  return parts.join('-').toLowerCase().replace(/[^a-z0-9_]+/g, '-').replace(/^-+|-+$/g, '');
}

function anchorLink(id, label) {
  return `<a class="anchor" href="#${id}">${escapeHtml(label)}</a>`;
}

// Charts are built after history loads, so the browser's own jump to the
// URL fragment has already happened (and found nothing). Redo it once
// they exist. anchorId() output is URL-safe, so the hash needs no decoding.
function scrollToHash() {
  const id = location.hash.slice(1);
  if (id) document.getElementById(id)?.scrollIntoView();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// ── data loaders (also used by compare.js / releases.js) ─────────────────

// Resolve the live data URL via config.json (written by the deploy workflow
// from `vars.DATA_URL`). Falls back to the bundled sample file so the site
// still renders something useful for local dev / first-deploy / outage.
async function loadHistory() {
  let url = 'data/history.sample.json';
  try {
    const cfg = await fetch('config.json', { cache: 'no-cache' });
    if (cfg.ok) {
      const { dataUrl } = await cfg.json();
      if (dataUrl) url = dataUrl;
    }
  } catch (_) { /* no config.json → fall through to sample */ }

  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// Annotations are git-tracked in the site repo. Missing file is a no-op
// (returns []) — annotations are optional.
async function loadAnnotations() {
  try {
    const res = await fetch('data/annotations.json', { cache: 'no-cache' });
    if (!res.ok) return [];
    const arr = await res.json();
    return Array.isArray(arr) ? arr : [];
  } catch (_) { return []; }
}

// Build the chartjs-plugin-annotation `annotations` map for one chart.
// Each annotation has { sha, title, body?, url? }; we look up sha in the
// chart's row set and place a dashed vertical line at that timestamp.
// Multiple matching shas (re-runs) collapse to the earliest timestamp.
function annotationsForChart(annotations, paramMap) {
  if (!annotations || annotations.length === 0) return {};

  const shaTs = new Map();
  for (const rows of Object.values(paramMap)) {
    for (const r of rows) {
      const t = new Date(r.timestamp).getTime();
      const prev = shaTs.get(r.sha);
      if (prev == null || t < prev) shaTs.set(r.sha, r.timestamp);
    }
  }

  const out = {};
  let i = 0;
  for (const a of annotations) {
    const ts = shaTs.get(a.sha);
    if (!ts) continue;
    const id = `ann${i++}`;
    out[id] = {
      type: 'line',
      scaleID: 'x',
      value: ts,
      borderColor: 'rgba(0, 188, 142, 0.6)',
      borderWidth: 1.5,
      borderDash: [4, 4],
      label: {
        display: false,
        drawTime: 'afterDatasetsDraw',
        content: a.title,
        position: 'start',
        backgroundColor: 'rgba(0, 188, 142, 0.92)',
        color: '#fff',
        font: { size: 10, weight: '500' },
        padding: { top: 3, bottom: 3, left: 6, right: 6 },
        borderRadius: 3,
      },
      enter: ctx => {
        ctx.element.options.label.display = true;
        ctx.element.options.borderWidth = 2;
        return true;
      },
      leave: ctx => {
        ctx.element.options.label.display = false;
        ctx.element.options.borderWidth = 1.5;
        return true;
      },
      click: () => { if (a.url) window.open(a.url, '_blank'); },
    };
  }
  return out;
}

// Exported for compare.js / releases.js. They all load script.js first.
window.AWFY = {
  describeMetric, toMetric, ciToMetric, significanceClass, chartGroup,
  formatNs, formatRps, formatBps, formatInstructions, formatBytes,
  escapeHtml, relTime, REPO_URL, anchorId, anchorLink, scrollToHash,
  loadHistory, loadAnnotations, annotationsForChart,
};

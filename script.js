// arewefastyet.wasmcloud.com — trends view
//
// Loads data/history.json (one JSON array of bench result rows), groups by
// (bench, group, param), and renders one Chart.js timeline per (bench, group).
// Per-chart unit is chosen from criterion's throughput config:
//   throughput.Elements > 1  →  ops/sec  (higher is better)
//   otherwise                →  time     (lower is better)

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
  benchSel.addEventListener('change', render);
  document.getElementById('ref-filter').addEventListener('change', render);

  setLastUpdated(allRows);
  render();
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
    (((tree[r.bench] ??= {})[r.group] ??= {})[r.param] ??= []).push(r);
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
    sec.innerHTML = `<h2>${escapeHtml(bench)}</h2>`;
    for (const group of Object.keys(tree[bench]).sort()) {
      sec.appendChild(renderCard(bench, group, tree[bench][group]));
    }
    root.appendChild(sec);
  }
}

function renderCard(bench, group, paramMap) {
  const card = document.createElement('div');
  card.className = 'chart-card';

  const params = Object.keys(paramMap).sort();
  // All rows in a (bench, group) share the same criterion throughput config,
  // so we can pick metric semantics from any one row.
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
    : `<span class="metric-hint">time · lower is better</span>`;

  card.innerHTML = `
    <header>
      <h3>${escapeHtml(group)} ${subtitle}</h3>
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

function describeMetric(row) {
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
  if (meta.kind === 'rps')  return (meta.elements * 1e9) / row.mean_ns;
  if (meta.kind === 'bps')  return (meta.bytes    * 1e9) / row.mean_ns;
  return row.mean_ns;
}

// CI bounds invert when converting time → rate: low time = high rate, etc.
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

function relTime(d) {
  const sec = (Date.now() - d.getTime()) / 1000;
  if (sec < 60) return `${Math.round(sec)} s ago`;
  if (sec < 3600) return `${Math.round(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)} h ago`;
  return `${Math.round(sec / 86400)} d ago`;
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
  describeMetric, toMetric, ciToMetric, significanceClass,
  formatNs, formatRps, formatBps, escapeHtml, relTime, REPO_URL,
  loadHistory, loadAnnotations, annotationsForChart,
};

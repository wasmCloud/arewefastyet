// arewefastyet — releases view
//
// Filters history to ref values that look like release tags (semver),
// orders them by semver (not by time), and renders one Chart.js card per
// (bench, group). Each release is one categorical x-tick; latest run for
// that tag wins if there are duplicates.

(() => {
const {
  describeMetric, toMetric, ciToMetric, significanceClass,
  escapeHtml, REPO_URL, loadHistory,
} = window.AWFY;

// Strict semver-ish: optional leading 'v', three numeric parts.
const TAG_RE = /^v?\d+\.\d+\.\d+$/;

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

let allRows = [];
const charts = new Map();

document.addEventListener('DOMContentLoaded', main);

async function main() {
  const root = document.getElementById('charts');
  if (!root) return;

  try {
    allRows = await loadHistory();
  } catch (err) {
    root.innerHTML = `<p class="error">Could not load history: ${escapeHtml(err.message)}</p>`;
    return;
  }

  const releaseRows = allRows.filter(r => TAG_RE.test(r.ref));

  // bench filter from release rows only (not full history)
  const benches = [...new Set(releaseRows.map(r => r.bench))].sort();
  const benchSel = document.getElementById('bench-filter');
  for (const b of benches) {
    benchSel.appendChild(new Option(b, b));
  }
  benchSel.addEventListener('change', () => render(releaseRows));

  setLastUpdated(releaseRows);
  render(releaseRows);
}

function setLastUpdated(rows) {
  if (!rows.length) {
    document.getElementById('last-updated').textContent = 'no release runs yet';
    return;
  }
  const tags = [...new Set(rows.map(r => r.ref))].sort(semverCompare);
  const latestTag = tags.at(-1);
  document.getElementById('last-updated').textContent =
    `${tags.length} release${tags.length === 1 ? '' : 's'}, latest: ${latestTag}`;
}

function render(rows) {
  const benchFilter = document.getElementById('bench-filter').value;
  const filtered = rows.filter(r => benchFilter === 'all' || r.bench === benchFilter);

  for (const c of charts.values()) c.destroy();
  charts.clear();

  const root = document.getElementById('charts');
  root.innerHTML = '';

  if (filtered.length === 0) {
    root.innerHTML = '<p class="empty">No bench runs against tagged releases yet. Dispatch the <a href="https://github.com/wasmCloud/wasmCloud/actions/workflows/bench.yml">bench workflow</a> with a release tag (e.g. <code>v2.1.0</code>) as the <code>ref</code> input.</p>';
    return;
  }

  // tree[bench][group][param] → Map<ref, row>  (latest run per ref wins)
  const tree = {};
  for (const r of filtered) {
    const groups = (tree[r.bench] ??= {});
    const params = (groups[r.group] ??= {});
    const refMap = (params[r.param] ??= new Map());
    const existing = refMap.get(r.ref);
    if (!existing || new Date(r.timestamp) > new Date(existing.timestamp)) {
      refMap.set(r.ref, r);
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

  // Union of refs across all params; semver-ordered.
  const allRefs = [...new Set(params.flatMap(p => [...paramMap[p].keys()]))].sort(semverCompare);

  // Pick metric meta from any sample row.
  const sampleRow = paramMap[params[0]].values().next().value;
  const meta = describeMetric(sampleRow);

  const latestSpans = params.map((p, i) => {
    const refMap = paramMap[p];
    const lastRef = allRefs.at(-1);
    const last = refMap.get(lastRef);
    const color = colorFor(p, i).line;
    const cur = last ? meta.format(toMetric(last, meta)) : '—';
    return `<span><span class="swatch" style="background:${color}"></span>${escapeHtml(p)} ${cur}</span>`;
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
    const refMap = paramMap[p];
    return {
      label: p,
      data: allRefs.map(ref => {
        const r = refMap.get(ref);
        if (!r) return { x: ref, y: null };
        return {
          x: ref,
          y: toMetric(r, meta),
          sha: r.short_sha,
          run_id: r.run_id,
        };
      }),
      borderColor: color.line,
      backgroundColor: color.band,
      pointBackgroundColor: color.line,
      pointRadius: 4,
      pointHoverRadius: 6,
      borderWidth: 1.5,
      tension: 0.05,
      spanGaps: true,
    };
  });

  const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
  const muted = isDark ? '#888' : '#666';
  const grid = isDark ? 'rgba(255,255,255,0.07)' : 'rgba(0,0,0,0.06)';

  const chart = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { labels: allRefs, datasets },
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
          type: 'category',
          ticks: { color: muted, autoSkipPadding: 12 },
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
            title: items => items[0]?.raw ? `${items[0].label}  ·  ${items[0].raw.sha}` : '',
            label: ctx => {
              const r = ctx.raw;
              return r && r.y != null ? `${ctx.dataset.label}: ${meta.format(r.y)}` : `${ctx.dataset.label}: —`;
            },
          },
        },
      },
    },
  });
  charts.set(`${bench}/${group}`, chart);
  return card;
}

// Semver comparator. Strips leading 'v', parses three integer parts.
function semverCompare(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}
function parseSemver(v) {
  return v.replace(/^v/, '').split('.').slice(0, 3).map(n => parseInt(n, 10) || 0);
}

function colorFor(param, fallbackIdx) {
  return PALETTE[param] ?? FALLBACK[fallbackIdx % FALLBACK.length];
}

})();

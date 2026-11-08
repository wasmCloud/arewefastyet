// arewefastyet — density view
//
// Two sources:
//   - data/density-records.json: a hand-run scale_density campaign on one
//     host. The record ramps (one row of the bench's report per step) and
//     the walls, the ceiling each change moved.
//   - history.json: the latest published scale_density run per host, at
//     CI's defaults, so a regression shows up next to the record.
//
// The trends page still charts scale_density rows over commits.

(() => {
const {
  escapeHtml, relTime, REPO_URL, anchorLink, scrollToHash,
  loadHistory, formatBytes, rowHost, hostLabels,
} = window.AWFY;

const BENCH = 'scale_density';
const FLAVOURS = {
  warm: { label: 'warm', color: '--brand' },
  scale_to_zero: { label: 'scale-to-zero', color: '--p3' },
};
const CI_METRICS = [
  ['served_workloads', 'workloads', v => fmtCount(v)],
  ['marginal_bytes_per_workload', 'per workload', v => formatBytes(v)],
  ['starts_per_sec', 'starts/s', v => fmtCount(v)],
  ['request_p99_ms', 'request p99', v => `${v.toFixed(2)} ms`],
];

let records = null;
let ciRows = [];
const charts = [];

document.addEventListener('DOMContentLoaded', main);

async function main() {
  const root = document.getElementById('density');
  if (!root) return;
  const [rec, hist] = await Promise.allSettled([
    fetch('data/density-records.json', { cache: 'no-cache' }).then(r => {
      if (!r.ok) throw new Error(`density-records.json: HTTP ${r.status}`);
      return r.json();
    }),
    loadHistory(),
  ]);
  if (rec.status === 'fulfilled') records = rec.value;
  if (hist.status === 'fulfilled' && Array.isArray(hist.value)) {
    ciRows = hist.value.filter(r => r.bench === BENCH);
  }
  if (!records && ciRows.length === 0) {
    const why = rec.reason?.message ?? hist.reason?.message ?? 'no data';
    root.innerHTML = `<p class="error">Could not load density data: ${escapeHtml(why)}</p>`;
    return;
  }

  const sel = document.getElementById('host-filter');
  const hosts = hostLabels(ciRows);
  const recordHost = records?.host_label;
  if (recordHost && !hosts.includes(recordHost)) hosts.unshift(recordHost);
  for (const h of hosts) sel.appendChild(new Option(h, h));
  const q = new URLSearchParams(location.search).get('host');
  sel.value = q && hosts.includes(q) ? q : (recordHost ?? hosts[0]);
  sel.addEventListener('change', () => {
    const p = new URLSearchParams(location.search);
    sel.value === (recordHost ?? hosts[0]) ? p.delete('host') : p.set('host', sel.value);
    const s = p.toString();
    history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}${location.hash}`);
    render();
  });
  render();
  scrollToHash();
}

function render() {
  const host = document.getElementById('host-filter').value;
  for (const c of charts) c.destroy();
  charts.length = 0;
  const root = document.getElementById('density');
  root.innerHTML = '';

  const rec = records && records.host_label === host ? records : null;
  const ci = ciRows.filter(r => rowHost(r) === host);
  setLastUpdated(rec, ci);

  if (rec) {
    root.appendChild(hero(rec));
    const ramps = section('ramp', 'the ramp', `
      Each point is one step of the record run: start the next batch of
      workloads, then send requests across all of them. Footprint climbs by
      the same amount per workload all the way up, and request latency stays
      flat, so the box runs out of memory before it runs out of anything else.`);
    for (const [key, f] of Object.entries(FLAVOURS)) {
      if (rec.ramps?.[key]) ramps.appendChild(rampCard(rec, key, f));
    }
    root.appendChild(ramps);
    if (rec.walls?.length) root.appendChild(wallsSection(rec));
  }
  if (ci.length) {
    root.appendChild(ciSection(host, ci));
  } else if (!rec) {
    root.innerHTML = '<p class="empty">No scale_density runs for this host yet.</p>';
  }
}

function setLastUpdated(rec, ci) {
  const el = document.getElementById('last-updated');
  const latest = ci.map(r => r.timestamp).filter(Boolean).sort().at(-1);
  const parts = [];
  if (rec?.date) parts.push(`record run: ${rec.date}`);
  if (latest) {
    const d = new Date(latest);
    parts.push(`last CI run: ${d.toISOString().slice(0, 16).replace('T', ' ')}Z (${relTime(d)})`);
  }
  el.textContent = parts.join(' · ') || 'no runs yet';
}

function hero(rec) {
  const warm = rec.ramps?.warm;
  const stz = rec.ramps?.scale_to_zero;
  const last = ramp => ramp?.steps?.at(-1);
  const warmTop = last(warm);
  const stzTop = last(stz);
  // p99 at the top of the warm ramp: the last step that served requests.
  const warmServed = warm?.steps?.filter(s => s[5] != null).at(-1);
  const peakStarts = stz ? Math.max(...stz.steps.map(s => s[2] ?? 0)) : null;
  const tiles = [
    warmTop && ['warm components', fmtBig(warmTop[0]), 'every one kept running and answering HTTP'],
    stzTop && ['scale-to-zero workloads', fmtBig(stzTop[0]), 'deployed, started on each request'],
    warm && ['per warm component', `${Math.round(warm.marginal_bytes_per_workload / 1024)} KiB`, 'host memory, page tables included'],
    warmServed && ['request p99 at the top', `${warmServed[5].toFixed(1)} ms`, `across ${fmtBig(warmServed[0])} warm components`],
    peakStarts && ['cold starts per second', fmtBig(peakStarts), 'scale-to-zero, peak step'],
  ].filter(Boolean);
  const el = document.createElement('section');
  el.className = 'density-hero';
  el.id = 'record';
  el.innerHTML = `
    <p class="hero-machine">${escapeHtml(rec.machine ?? rec.host_label)} · one <code>wash-runtime</code> process · ${escapeHtml(rec.component ?? '')}</p>
    <div class="hero-tiles">${tiles.map(([label, value, sub]) => `
      <div class="hero-tile">
        <div class="hero-value">${escapeHtml(value)}</div>
        <div class="hero-label">${escapeHtml(label)}</div>
        <div class="hero-sub">${escapeHtml(sub)}</div>
      </div>`).join('')}
    </div>
    ${rec.ci_run ? `<p class="hero-foot">Reproduced from GitHub Actions: <a href="${REPO_URL}/actions/runs/${encodeURIComponent(rec.ci_run.run_id)}" target="_blank" rel="noopener">${escapeHtml(rec.ci_run.label)}</a></p>` : ''}`;
  return el;
}

function section(id, title, intro) {
  const sec = document.createElement('section');
  sec.className = 'bench-section';
  sec.id = id;
  sec.innerHTML = `<h2>${anchorLink(id, title)}</h2><p class="section-intro">${intro}</p>`;
  return sec;
}

function rampCard(rec, key, flavour) {
  const ramp = rec.ramps[key];
  const idx = Object.fromEntries(rec.step_fields.map((f, i) => [f, i]));
  const steps = ramp.steps;
  const top = steps.at(-1);
  // Leading steps whose requests paid a one-off warm-up: kept in the data,
  // left off the p99 line so it does not set the axis.
  const warmup = ramp.warmup_steps ?? 0;
  const skipped = steps.slice(0, warmup).filter(s => s[idx.request_p99_ms] != null);
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = `ramp-${key}`;
  card.innerHTML = `
    <div class="card-head">
      <h3>${anchorLink(card.id, flavour.label)} <span class="metric-hint">${escapeHtml(ramp.label)} · ${escapeHtml(formatBytes(ramp.memory_limit_bytes))} process cap</span></h3>
    </div>
    <div class="legend">
      <span><span class="swatch" style="background:${cssVar(flavour.color)}"></span>host footprint</span>
      <span><span class="swatch line" style="background:${cssVar('--step-webgpu-native')}"></span>request p99</span>
    </div>
    <div class="chart-wrapper ramp"><canvas aria-label="${escapeHtml(`${flavour.label}: host footprint and request p99 against running workloads`)}"></canvas></div>
    <p class="card-foot">Stopped at <b>${fmtCount(top[idx.workloads])}</b> workloads: ${escapeHtml(ramp.stop)}.
      ${fmtCount(ramp.marginal_bytes_per_workload)} B (${escapeHtml(formatBytes(ramp.marginal_bytes_per_workload))}) a workload on top of a
      ${escapeHtml(formatBytes(ramp.baseline_footprint_bytes))} baseline.${skipped.length ? `
      The first step's requests (p99 ${escapeHtml(skipped.map(s => `${s[idx.request_p99_ms].toFixed(1)} ms at ${fmtBig(s[idx.workloads])}`).join(', '))})
      paid a one-off warm-up and are left off the p99 line.` : ''}</p>`;
  const canvas = card.querySelector('canvas');
  const fg = cssVar('--fg');
  const muted = cssVar('--muted');
  const grid = cssVar('--grid');
  const color = cssVar(flavour.color);
  const p99Color = cssVar('--step-webgpu-native');
  const point = (s, i) => (s[i] == null ? null : { x: s[idx.workloads], y: s[i] });
  charts.push(new Chart(canvas, {
    type: 'line',
    data: {
      datasets: [
        {
          label: 'host footprint',
          data: steps.map(s => ({ x: s[idx.workloads], y: s[idx.footprint_bytes] / 2 ** 30 })),
          borderColor: color,
          backgroundColor: withAlpha(color, 0.18),
          fill: 'origin',
          pointRadius: 0,
          borderWidth: 2,
          yAxisID: 'mem',
        },
        {
          label: 'request p99',
          data: steps.slice(warmup).map(s => point(s, idx.request_p99_ms)).filter(Boolean),
          borderColor: p99Color,
          backgroundColor: p99Color,
          pointRadius: 0,
          borderWidth: 1.5,
          yAxisID: 'p99',
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => `${fmtCount(items[0].parsed.x)} workloads`,
            label: c => c.dataset.yAxisID === 'mem'
              ? `footprint ${c.parsed.y.toFixed(1)} GiB`
              : `request p99 ${c.parsed.y.toFixed(2)} ms`,
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: top[idx.workloads],
          title: { display: true, text: 'running workloads', color: muted },
          ticks: { color: muted, callback: v => fmtBig(v) },
          grid: { color: grid },
        },
        mem: {
          position: 'left',
          min: 0,
          title: { display: true, text: 'GiB', color: muted },
          ticks: { color: muted },
          grid: { color: grid },
        },
        p99: {
          position: 'right',
          min: 0,
          title: { display: true, text: 'p99 ms', color: muted },
          ticks: { color: muted },
          grid: { drawOnChartArea: false },
        },
      },
      color: fg,
    },
  }));
  return card;
}

function wallsSection(rec) {
  const sec = section('walls', 'walls removed', `
    Where the warm ramp stopped as each limit came out of the way, from CI's
    defaults on <code>main</code> to the record. Every bar is a real run on this
    box; the label says what changed from the bar above it.`);
  const walls = rec.walls;
  const max = Math.max(...walls.map(w => w.workloads));
  const rows = walls.map((w, i) => {
    const prev = walls[i - 1];
    const gain = prev ? `×${(w.workloads / prev.workloads).toFixed(1)}` : '';
    const link = w.pr
      ? ` <a href="${REPO_URL}/pull/${w.pr}" target="_blank" rel="noopener">#${w.pr}</a>`
      : w.run_id
        ? ` <a href="${REPO_URL}/actions/runs/${encodeURIComponent(w.run_id)}" target="_blank" rel="noopener">run</a>`
        : '';
    const frac = w.workloads / max;
    return `
      <div class="wall-row">
        <div class="wall-text">
          <span class="wall-label">${escapeHtml(w.label)}${link}</span>
          <span class="wall-detail">${escapeHtml(w.detail)}</span>
        </div>
        <span class="bar-track"><span class="bar-fill" style="width:${(frac * 100).toFixed(1)}%;background:${cssVar(i === walls.length - 1 ? '--brand' : '--mem-model')}"></span></span>
        <span class="wall-value">${escapeHtml(fmtBig(w.workloads))}<span class="bar-note">${gain}</span></span>
      </div>`;
  }).join('');
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.innerHTML = `
    <div class="card-head"><h3>${anchorLink('walls-warm', 'warm workloads per run')} <span class="metric-hint">×${(max / walls[0].workloads).toFixed(0)} overall</span></h3></div>
    <div class="walls">${rows}</div>`;
  sec.appendChild(card);
  return sec;
}

function ciSection(host, rows) {
  const sec = section('ci', 'in CI', `
    The latest published <code>scale_density</code> run on <b>${escapeHtml(host)}</b>,
    at CI's defaults. Each mode stops at its first limit, usually the 2 GiB
    process cap, so these numbers move with per-workload cost rather than
    with the box.`);
  const latestRun = rows.reduce((a, r) => (!a || r.timestamp > a.timestamp ? r : a), null);
  const run = rows.filter(r => r.run_id === latestRun.run_id);
  const params = [...new Set(run.map(r => r.param))];
  const cell = (param, metric, fmt) => {
    const r = run.find(x => x.param === param && x.metric === metric);
    return r ? `<td>${escapeHtml(fmt(r.value))}</td>` : '<td class="muted">—</td>';
  };
  const body = params.map(p => `
    <tr><td>${escapeHtml(p)}</td>${CI_METRICS.map(([m, , fmt]) => cell(p, m, fmt)).join('')}</tr>`).join('');
  const d = new Date(latestRun.timestamp);
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.innerHTML = `
    <div class="card-head"><h3>${anchorLink('ci-latest', 'latest run')} <span class="metric-hint">
      <a href="${REPO_URL}/actions/runs/${encodeURIComponent(latestRun.run_id)}" target="_blank" rel="noopener">${escapeHtml(latestRun.short_sha ?? '')}</a>
      · ${escapeHtml(latestRun.ref ?? '')} · <span title="${escapeHtml(latestRun.timestamp)}">${relTime(d)}</span></span></h3></div>
    <div class="table-scroll"><table class="split-table">
      <thead><tr><th>mode</th>${CI_METRICS.map(([, label]) => `<th>${escapeHtml(label)}</th>`).join('')}</tr></thead>
      <tbody>${body}</tbody>
    </table></div>
    <p class="card-foot">Trends over commits: <a href="./?bench=${BENCH}&amp;host=${encodeURIComponent(host)}">trends page</a>.</p>`;
  sec.appendChild(card);
  return sec;
}

function fmtCount(v) {
  return Math.round(v).toLocaleString('en-US');
}

// 1,420,000 → 1.42M; 145,257 → 145k.
function fmtBig(v) {
  if (v >= 1e6) return `${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M`;
  if (v >= 1e4) return `${Math.round(v / 1e3)}k`;
  return fmtCount(v);
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function withAlpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}
})();

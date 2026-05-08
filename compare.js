// arewefastyet.wasmcloud.com — compare-runs view
//
// Pick a bench + two runs (A, B) and render a diff table:
//   - one row per (group, param)
//   - A and B values in the bench's natural metric (time or req/s)
//   - Δ and % colored by significance (regress / improve / flat)
//   - significance flag uses CI overlap as a noise filter
//
// URL is deep-linkable:  compare.html?bench=http_invoke&a=<runId>&b=<runId>

// IIFE so our const/let bindings don't collide with the helpers script.js
// declares at module scope (both are loaded on this page).
(() => {
const {
  describeMetric, toMetric, ciToMetric, significanceClass,
  escapeHtml, REPO_URL, loadHistory,
} = window.AWFY;

let allRows = [];

document.addEventListener('DOMContentLoaded', main);

async function main() {
  const root = document.getElementById('diff');
  try {
    allRows = await loadHistory();
  } catch (err) {
    root.innerHTML = `<p class="error">Could not load history: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (!Array.isArray(allRows) || allRows.length === 0) {
    root.innerHTML = '<p class="empty">No bench runs yet.</p>';
    return;
  }

  setLastUpdated();

  const benches = [...new Set(allRows.map(r => r.bench))].sort();
  const benchSel = document.getElementById('bench-sel');
  for (const b of benches) benchSel.appendChild(new Option(b, b));

  // Hydrate from URL if possible.
  const params = new URLSearchParams(location.search);
  const urlBench = params.get('bench');
  if (urlBench && benches.includes(urlBench)) benchSel.value = urlBench;

  benchSel.addEventListener('change', () => {
    refreshRunOptions();
    syncUrl();
    renderDiff();
  });
  document.getElementById('run-a').addEventListener('change', () => { syncUrl(); renderDiff(); });
  document.getElementById('run-b').addEventListener('change', () => { syncUrl(); renderDiff(); });
  document.getElementById('swap-btn').addEventListener('click', swap);

  refreshRunOptions(params);
  renderDiff();
}

function setLastUpdated() {
  const latest = allRows.map(r => r.timestamp).filter(Boolean).sort().at(-1);
  if (!latest) return;
  const d = new Date(latest);
  document.getElementById('last-updated').textContent =
    `last run: ${d.toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

function refreshRunOptions(urlParams = new URLSearchParams(location.search)) {
  const bench = document.getElementById('bench-sel').value;
  const runs = uniqueRuns(allRows.filter(r => r.bench === bench));
  runs.sort((a, b) => b.timestamp.localeCompare(a.timestamp));   // newest first

  const aSel = document.getElementById('run-a');
  const bSel = document.getElementById('run-b');
  for (const sel of [aSel, bSel]) {
    sel.innerHTML = '';
    for (const r of runs) sel.appendChild(new Option(formatRun(r), r.run_id));
  }

  // Honor URL ids if both refer to runs of the selected bench, else default
  // to (newest, second-newest).
  const urlA = urlParams.get('a');
  const urlB = urlParams.get('b');
  const ids = new Set(runs.map(r => r.run_id));
  if (urlA && ids.has(urlA)) aSel.value = urlA;
  else if (runs.length >= 2) aSel.value = runs[1].run_id;
  else if (runs.length === 1) aSel.value = runs[0].run_id;

  if (urlB && ids.has(urlB)) bSel.value = urlB;
  else if (runs.length >= 1) bSel.value = runs[0].run_id;
}

function uniqueRuns(rows) {
  const seen = new Map();
  for (const r of rows) {
    if (!seen.has(r.run_id)) {
      seen.set(r.run_id, {
        run_id: r.run_id,
        sha: r.sha,
        short_sha: r.short_sha,
        ref: r.ref,
        timestamp: r.timestamp,
      });
    }
  }
  return [...seen.values()];
}

function formatRun(r) {
  const d = new Date(r.timestamp).toISOString().slice(0, 16).replace('T', ' ');
  return `${r.short_sha} · ${r.ref} · ${d}Z`;
}

function syncUrl() {
  const p = new URLSearchParams();
  p.set('bench', document.getElementById('bench-sel').value);
  p.set('a', document.getElementById('run-a').value);
  p.set('b', document.getElementById('run-b').value);
  history.replaceState(null, '', `?${p}`);
}

function swap() {
  const aSel = document.getElementById('run-a');
  const bSel = document.getElementById('run-b');
  const tmp = aSel.value;
  aSel.value = bSel.value;
  bSel.value = tmp;
  syncUrl();
  renderDiff();
}

function renderDiff() {
  const root = document.getElementById('diff');
  const bench = document.getElementById('bench-sel').value;
  const aId = document.getElementById('run-a').value;
  const bId = document.getElementById('run-b').value;

  if (!bench || !aId || !bId) {
    root.innerHTML = '<p class="empty">Pick a bench and two runs.</p>';
    return;
  }

  const aRows = allRows.filter(r => r.bench === bench && r.run_id === aId);
  const bRows = allRows.filter(r => r.bench === bench && r.run_id === bId);

  if (!aRows.length || !bRows.length) {
    root.innerHTML = '<p class="empty">One or both runs have no data for this bench.</p>';
    return;
  }

  if (aId === bId) {
    root.innerHTML = '<p class="empty">A and B are the same run — pick different runs.</p>';
    return;
  }

  const aRun = aRows[0];
  const bRun = bRows[0];

  const aMap = new Map(aRows.map(r => [`${r.group}/${r.param}`, r]));
  const bMap = new Map(bRows.map(r => [`${r.group}/${r.param}`, r]));
  const keys = [...new Set([...aMap.keys(), ...bMap.keys()])].sort();

  const summary = `
    <div class="run-summary">
      <div class="run-card a">
        <h3>baseline (A)</h3>
        <div class="run-id"><a href="${REPO_URL}/actions/runs/${escapeHtml(aRun.run_id)}" target="_blank" rel="noopener">${escapeHtml(aRun.short_sha)}</a></div>
        <div class="run-meta">${escapeHtml(aRun.ref)} · ${formatTs(aRun.timestamp)}</div>
      </div>
      <div class="run-card b">
        <h3>compared (B)</h3>
        <div class="run-id"><a href="${REPO_URL}/actions/runs/${escapeHtml(bRun.run_id)}" target="_blank" rel="noopener">${escapeHtml(bRun.short_sha)}</a></div>
        <div class="run-meta">${escapeHtml(bRun.ref)} · ${formatTs(bRun.timestamp)}</div>
      </div>
    </div>
  `;

  let regressionCount = 0;
  let improvementCount = 0;
  const tbody = keys.map(key => {
    const a = aMap.get(key);
    const b = bMap.get(key);
    const [group, param] = key.split('/');

    if (!a || !b) {
      return `<tr>
        <td class="mono">${escapeHtml(group)}</td>
        <td class="mono">${escapeHtml(param)}</td>
        <td class="num">${a ? formatVal(a) : '<span class="muted">—</span>'}</td>
        <td class="num">${b ? formatVal(b) : '<span class="muted">—</span>'}</td>
        <td class="num muted">—</td>
        <td class="num muted">—</td>
        <td class="num muted">—</td>
      </tr>`;
    }

    const meta = describeMetric(a);
    const aV = toMetric(a, meta);
    const bV = toMetric(b, meta);
    const aCi = ciToMetric(a, meta);
    const bCi = ciToMetric(b, meta);

    const delta = bV - aV;
    const pct = aV !== 0 ? (delta / aV) * 100 : 0;

    // Significance: |%| >= 1 AND CIs don't overlap.
    const ciOverlap = aCi.high != null && bCi.low != null && aCi.low != null && bCi.high != null
      ? !(aCi.high < bCi.low || bCi.high < aCi.low)
      : true;
    const significant = Math.abs(pct) >= 1 && !ciOverlap;
    const sigClass = significant ? significanceClass(pct, meta.higherIsBetter) : '';
    if (sigClass === 'regress') regressionCount++;
    if (sigClass === 'improve') improvementCount++;

    const sign = delta > 0 ? '+' : '';
    const sigBadge = significant
      ? `<span class="sig-badge ${sigClass}" title="significant: |%| ≥ 1 and 95 % CIs don't overlap">●</span>`
      : `<span class="sig-badge flat" title="within criterion's noise floor">·</span>`;

    return `<tr class="row-${sigClass || 'flat'}">
      <td class="mono">${escapeHtml(group)}</td>
      <td class="mono">${escapeHtml(param)}</td>
      <td class="num">${meta.format(aV)}</td>
      <td class="num">${meta.format(bV)}</td>
      <td class="num ${sigClass}">${sign}${meta.format(delta)}</td>
      <td class="num ${sigClass}">${sign}${pct.toFixed(2)} %</td>
      <td class="num">${sigBadge}</td>
    </tr>`;
  }).join('');

  const tally = `
    <div class="tally">
      <span class="tally-item regress">${regressionCount} regression${regressionCount === 1 ? '' : 's'}</span>
      <span class="tally-item improve">${improvementCount} improvement${improvementCount === 1 ? '' : 's'}</span>
      <span class="tally-item flat">${keys.length - regressionCount - improvementCount} flat</span>
    </div>
  `;

  root.innerHTML = `
    ${summary}
    ${tally}
    <table class="diff">
      <thead>
        <tr>
          <th>group</th>
          <th>param</th>
          <th class="num">A</th>
          <th class="num">B</th>
          <th class="num">Δ</th>
          <th class="num">%</th>
          <th class="num">sig</th>
        </tr>
      </thead>
      <tbody>${tbody}</tbody>
    </table>
  `;
}

function formatVal(row) {
  const meta = describeMetric(row);
  return meta.format(toMetric(row, meta));
}

function formatTs(ts) {
  return new Date(ts).toISOString().slice(0, 16).replace('T', ' ') + 'Z';
}

})();

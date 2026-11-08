// arewefastyet — GPU view
//
// Renders the `gpubench` rows that `bench-tools gpu jsonl` emits, per box
// label (`<kind>-<class>`, e.g. cuda-l4; the kind picks the vendor backend):
//   - how far from native: tok/s for the vendor, webgpu-native and wasm
//     steps of the latest run as bars with the gaps between them, a trend
//     per llama test, the wasm overhead per model size, and the model size
//     beside the wasm guest's memory peak
//   - serverless: GPU memory over time from the `peak_gpu_mem` row's
//     `timeline` for wasmCloud and native, stat tiles, and per model where a
//     cold turn's time to first token goes
//
// The trends page leaves these rows out (see OWN_VIEW in script.js).

(() => {
const {
  escapeHtml, relTime, REPO_URL, anchorId, anchorLink, scrollToHash,
  loadHistory, loadAnnotations, annotationsForChart, significanceClass,
  formatBytes, formatterForUnit,
} = window.AWFY;

const BENCH = 'gpubench';
const STEPS = ['vendor', 'webgpu-native', 'wasm'];
const SIDES = ['wasmcloud', 'native'];
const SIDE_LABEL = { wasmcloud: 'wasmCloud', native: 'native' };
const VENDOR_BACKEND = { metal: 'Metal', cuda: 'CUDA' };
// Everything a wasm32 guest can address.
const WASM32_LIMIT = 2 ** 32;
const LANE_H = 12;
const LANE_GAP = 6;

let allRows = [];
let allAnnotations = [];
let modelOrder = [];
const charts = [];

document.addEventListener('DOMContentLoaded', main);

async function main() {
  const root = document.getElementById('gpu');
  if (!root) return;
  try {
    const rows = await loadHistory();
    allRows = Array.isArray(rows) ? rows.filter(r => r.bench === BENCH) : [];
    allAnnotations = await loadAnnotations();
  } catch (err) {
    root.innerHTML = `<p class="error">Could not load history: ${escapeHtml(err.message)}</p>`;
    return;
  }
  if (allRows.length === 0) {
    document.getElementById('last-updated').textContent = 'no GPU runs yet';
    root.innerHTML = '<p class="empty">No GPU bench runs yet. See the <a href="https://github.com/wasmCloud/wasmCloud/blob/main/scripts/gpubench/README.md">gpubench runbook</a>.</p>';
    return;
  }
  modelOrder = modelsInOrder(allRows);

  const refSel = document.getElementById('ref-filter');
  const boxSel = document.getElementById('box-filter');
  const smoke = document.getElementById('smoke-toggle');
  for (const b of boxesOf(allRows)) boxSel.appendChild(new Option(b, b));
  const prs = pullRefs(allRows);
  const allOpt = refSel.querySelector('option[value="all"]');
  for (const ref of prs) refSel.insertBefore(new Option(`PR #${pullNumber(ref)}`, ref), allOpt);
  // main when it has runs; until then, the newest published pull request.
  const refDefault = allRows.some(r => r.ref === 'main') ? 'main' : (prs[0] ?? 'all');

  // ?ref=, ?box= and ?smoke=1 preselect the controls; the URL wins over
  // whatever the browser restores.
  const q = new URLSearchParams(location.search);
  for (const [key, sel, dflt] of [['ref', refSel, refDefault], ['box', boxSel, 'all']]) {
    const v = q.get(key);
    sel.value = v && [...sel.options].some(o => o.value === v) ? v : dflt;
  }
  smoke.checked = q.get('smoke') === '1';
  const onChange = () => {
    const p = new URLSearchParams(location.search);
    refSel.value === refDefault ? p.delete('ref') : p.set('ref', refSel.value);
    boxSel.value === 'all' ? p.delete('box') : p.set('box', boxSel.value);
    smoke.checked ? p.set('smoke', '1') : p.delete('smoke');
    const s = p.toString();
    history.replaceState(null, '', `${location.pathname}${s ? `?${s}` : ''}${location.hash}`);
    render();
  };
  for (const el of [refSel, boxSel, smoke]) el.addEventListener('change', onChange);
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);

  setLastUpdated(allRows);
  render();
  scrollToHash();
}

function setLastUpdated(rows) {
  const latest = rows.map(r => r.timestamp).filter(Boolean).sort().at(-1);
  if (!latest) return;
  const d = new Date(latest);
  document.getElementById('last-updated').textContent =
    `last GPU run: ${d.toISOString().slice(0, 16).replace('T', ' ')}Z (${relTime(d)})`;
}

function render() {
  const ref = document.getElementById('ref-filter').value;
  const box = document.getElementById('box-filter').value;
  const smoke = document.getElementById('smoke-toggle').checked;
  const rows = allRows.filter(r =>
    (ref === 'all' || r.ref === ref) &&
    (box === 'all' || r.box === box) &&
    (smoke || r.smoke !== true));

  for (const c of charts) c.destroy();
  charts.length = 0;
  const root = document.getElementById('gpu');
  root.innerHTML = '';
  if (rows.length === 0) {
    root.innerHTML = '<p class="empty">No GPU runs match the current filters.</p>';
    return;
  }
  if (rows.every(r => String(r.run_id).startsWith('sample'))) {
    root.insertAdjacentHTML('beforeend',
      '<p class="sample-note">Showing the bundled synthetic sample (<code>data/history.sample.json</code>): made-up numbers in the shape of real rows, not measurements.</p>');
  }

  const boxes = boxesOf(rows);
  const gap = section('native-gap', 'how far from native', `
    Each step changes one thing: <b>vendor</b> is llama.cpp's own Metal or CUDA backend;
    <b>webgpu-native</b> is its WebGPU backend as a native binary, on the same wgpu
    crates <code>wash-runtime</code> uses; <b>wasm</b> is that WebGPU build compiled to
    <code>wasm32-wasip3</code>, run inside <code>wash-runtime</code> through
    <code>wasi:webgpu</code>. So vendor → webgpu-native is what WebGPU costs, and
    webgpu-native → wasm is what the component model and the host interface cost.`);
  for (const b of boxes) {
    const boxRows = rows.filter(r => r.box === b);
    if (boxRows.some(r => r.metric === 'tokens_per_s')) gap.appendChild(gapCard(b, boxRows));
  }
  const mem = memoryCard(boxes.map(b => rows.filter(r => r.box === b)));
  if (mem) gap.appendChild(mem);
  if (gap.querySelector('.chart-card')) root.appendChild(gap);

  const sl = section('serverless', 'serverless', `
    Several models take turns on one GPU as wasmCloud workloads: each turn starts
    its model cold, generates one token and stops it, then the GPU sits idle. The
    same plan then runs as native processes on the same WebGPU implementation.
    Both sides scale to zero between turns; what wasmCloud pays is the cold start.`);
  for (const b of boxes) {
    const boxRows = rows.filter(r => r.box === b && r.group === 'serverless');
    if (boxRows.length) sl.appendChild(serverlessCard(b, boxRows));
  }
  if (sl.querySelector('.chart-card')) root.appendChild(sl);
}

function section(id, title, intro) {
  const sec = document.createElement('section');
  sec.className = 'bench-section';
  sec.id = id;
  sec.innerHTML = `<h2>${anchorLink(id, title)}</h2><p class="section-intro">${intro}</p>`;
  return sec;
}


function gapCard(box, rows) {
  // The headline model's rows; the other model sizes carry the model in the
  // param (`<box>/<model>/<step>`) and only feed the overhead table.
  const headline = new Set(STEPS.map(s => `${box}/${s}`));
  const tokRows = rows.filter(r => r.metric === 'tokens_per_s' && headline.has(r.param));
  const run = latestRun(tokRows);
  const latest = rows.filter(r => runKey(r) === run.key);
  const tests = sortTests([...new Set(latest.filter(r => r.metric === 'tokens_per_s').map(r => r.group))]);
  const find = (group, param, metric) =>
    latest.find(r => r.group === group && r.param === param && r.metric === metric);

  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = anchorId('native-gap', box);
  card.innerHTML = `
    <header>
      <h3>${anchorLink(card.id, box)} <span class="metric-hint">${escapeHtml(run.row.gpu || '')} · ${escapeHtml(run.row.model || '')} · tok/s · higher is better</span></h3>
      ${runLabel(run.row)}
    </header>`;

  const panels = document.createElement('div');
  panels.className = 'panel-grid';
  for (const test of tests) {
    const vals = STEPS.map(s => find(test, `${box}/${s}`, 'tokens_per_s'));
    const max = Math.max(...vals.map(r => r?.value ?? 0));
    const gaps = {
      'webgpu-native': [find(test, box, 'webgpu_gap_pct'), 'vendor'],
      wasm: [find(test, box, 'wasm_overhead_pct'), 'webgpu-native'],
    };
    const bars = STEPS.map((s, i) => {
      const r = vals[i];
      if (!r) return barRow(stepLabel(box, s), null, 0, `var(--step-${s})`, 'did not run');
      const [g, from] = gaps[s] ?? [];
      const note = g ? `${fmtGap(g.value)} vs ${from}${g.significant === false ? ' (within noise)' : ''}` : '';
      const title = `${s}: ${fmtTok(r.value)} tok/s${r.stddev != null ? ` ± ${fmtTok(r.stddev)}` : ''}${r.backend ? ` · ${r.backend}` : ''}`;
      return barRow(stepLabel(box, s), `${fmtTok(r.value)} tok/s`,
        r.value / max, `var(--step-${s})`, note, title);
    }).join('');
    const total = find(test, box, 'native_gap_pct');
    panels.insertAdjacentHTML('beforeend', `
      <div class="bar-panel">
        <h4>${escapeHtml(testLabel(test))}</h4>
        <div class="bars">${bars}</div>
        ${total ? `<p class="panel-foot">wasm vs vendor: <b>${fmtGap(total.value)}</b></p>` : ''}
      </div>`);
  }
  card.appendChild(panels);
  card.insertAdjacentHTML('beforeend', `
    <p class="caveat">The vendor → WebGPU gap is under investigation: llama.cpp's WebGPU backend
      may leave work on the CPU or skip fast paths here, so read it as an upper bound on what
      WebGPU costs. webgpu-native → wasm is the host interface's cost.</p>`);
  const sizes = sizeTable(box, latest, tests);
  if (sizes) card.insertAdjacentHTML('beforeend', sizes);

  // Trend over commits: one chart per llama test, one line per step.
  const trend = document.createElement('div');
  trend.className = 'panel-grid trends';
  for (const test of sortTests([...new Set(tokRows.map(r => r.group))])) {
    const paramMap = {};
    for (const r of tokRows.filter(r => r.group === test)) (paramMap[r.param] ??= []).push(r);
    for (const k in paramMap) paramMap[k].sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
    trend.appendChild(trendPanel(box, test, paramMap));
  }
  card.insertAdjacentHTML('beforeend', '<h4 class="sub">trend over commits</h4>');
  card.appendChild(trend);
  return card;
}

// wasm vs webgpu-native for every model in the run, headline first. A small
// model has little GPU work per token, so the host interface shows most there.
function sizeTable(box, latest, tests) {
  const over = latest.filter(r => r.metric === 'wasm_overhead_pct'
    && (r.param === box || r.param.startsWith(`${box}/`)));
  const models = [...new Set(over.map(r => r.model))]
    .sort((a, b) => (parseFloat(modelShort(b)) || 0) - (parseFloat(modelShort(a)) || 0));
  if (models.length < 2) return '';
  const head = tests.map(t => `<th>${escapeHtml(testLabel(t))}</th>`).join('');
  const body = models.map(m => {
    const cells = tests.map(t => {
      const r = over.find(x => x.model === m && x.group === t);
      if (!r) return '<td class="muted">—</td>';
      const noise = r.significant === false ? ' <span class="muted">(noise)</span>' : '';
      return `<td>${escapeHtml(fmtGap(r.value))}${noise}</td>`;
    }).join('');
    return `<tr><td title="${escapeHtml(m)}">${escapeHtml(modelShort(m))}</td>${cells}</tr>`;
  }).join('');
  return `
    <h4 class="sub">wasm vs webgpu-native by model size</h4>
    <div class="table-scroll"><table class="split-table">
      <thead><tr><th>model</th>${head}</tr></thead><tbody>${body}</tbody>
    </table></div>`;
}

function barRow(label, value, frac, color, note, title = '', marker = null) {
  const pct = Math.max(0, Math.min(1, frac)) * 100;
  const tip = title ? ` title="${escapeHtml(title)}"` : '';
  const mark = marker == null ? '' : `<span class="bar-marker" style="left:${marker * 100}%"></span>`;
  return `
    <div class="bar-row">
      <span class="bar-label"${tip}>${label}</span>
      <span class="bar-track"${tip}>${value == null ? '' : `<span class="bar-fill" style="width:${pct}%;background:${color}"></span>`}${mark}</span>
      <span class="bar-value">${value == null ? '<span class="muted">—</span>' : escapeHtml(value)}${note ? `<span class="bar-note">${escapeHtml(note)}</span>` : ''}</span>
    </div>`;
}

function trendPanel(box, test, paramMap) {
  const panel = document.createElement('div');
  panel.className = 'trend-panel';
  const latest = STEPS.map(s => {
    const rows = paramMap[`${box}/${s}`];
    if (!rows) return '';
    const last = rows.at(-1);
    const prev = rows.at(-2);
    let delta = '';
    if (prev && prev.value) {
      const pct = ((last.value - prev.value) / prev.value) * 100;
      delta = `<span class="delta ${significanceClass(pct, true)}">${pct > 0 ? '+' : ''}${pct.toFixed(1)} %</span>`;
    }
    return `<span><span class="swatch" style="background:${cssVar(`--step-${s}`)}"></span>${s} ${fmtTok(last.value)}${delta}</span>`;
  }).join('');
  const smoke = Object.values(paramMap).flat().some(r => r.smoke === true);
  panel.innerHTML = `
    <div class="trend-head">
      <span class="trend-title">${escapeHtml(testLabel(test))}${smoke ? ' <span class="badge smoke">smoke</span>' : ''}</span>
      <div class="latest">${latest}</div>
    </div>
    <div class="chart-wrapper small"><canvas aria-label="${escapeHtml(`${box} ${test} tok/s per step over commits`)}"></canvas></div>`;

  const { muted, grid } = themeInk();
  const datasets = STEPS.filter(s => paramMap[`${box}/${s}`]).map(s => {
    const color = cssVar(`--step-${s}`);
    return {
      label: s,
      data: paramMap[`${box}/${s}`].map(r => ({
        x: r.timestamp, y: r.value, stddev: r.stddev, sha: r.short_sha, ref: r.ref,
        run_id: r.run_id, smoke: r.smoke === true,
      })),
      borderColor: color,
      backgroundColor: color,
      pointBackgroundColor: color,
      pointRadius: 3,
      pointHoverRadius: 5,
      borderWidth: 2,
      tension: 0.05,
    };
  });
  const chart = new Chart(panel.querySelector('canvas').getContext('2d'), {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      interaction: { mode: 'nearest', axis: 'x', intersect: false },
      onClick: (_, els) => {
        const raw = els.length && datasets[els[0].datasetIndex].data[els[0].index];
        if (raw && /^\d+$/.test(String(raw.run_id))) window.open(`${REPO_URL}/actions/runs/${raw.run_id}`, '_blank');
      },
      scales: {
        x: {
          type: 'time',
          time: { tooltipFormat: 'yyyy-MM-dd HH:mm' },
          ticks: { color: muted, maxRotation: 0, autoSkipPadding: 12 },
          grid: { color: grid },
        },
        y: {
          beginAtZero: true,
          ticks: { color: muted, callback: v => fmtTok(v) },
          grid: { color: grid },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => items.length ? `${items[0].raw.sha}  ·  ${items[0].raw.ref}${items[0].raw.smoke ? '  ·  smoke' : ''}` : '',
            label: ctx => {
              const r = ctx.raw;
              const sd = r.stddev != null ? ` ± ${fmtTok(r.stddev)}` : '';
              return `${ctx.dataset.label}: ${fmtTok(r.y)} tok/s${sd}`;
            },
          },
        },
        annotation: { annotations: annotationsForChart(allAnnotations, paramMap) },
      },
    },
  });
  charts.push(chart);
  return panel;
}

function memoryCard(perBox) {
  const blocks = [];
  for (const rows of perBox) {
    const memRows = rows.filter(r => r.group === 'llama-memory');
    if (!memRows.length) continue;
    const run = latestRun(memRows);
    const latest = memRows.filter(r => runKey(r) === run.key);
    const size = latest.find(r => r.metric === 'model_size');
    const peak = latest.find(r => r.metric === 'guest_memory_peak');
    if (!size || !peak) continue;
    const scale = Math.max(size.value, peak.value, WASM32_LIMIT) * 1.04;
    const marker = WASM32_LIMIT / scale;
    blocks.push(`
      <div class="bar-panel">
        <h4>${escapeHtml(run.row.box)} <span class="muted">· ${escapeHtml(run.row.model || '')}</span>${run.row.smoke ? ' <span class="badge smoke">smoke</span>' : ''}</h4>
        <div class="bars">
          ${barRow('model size', formatBytes(size.value), size.value / scale, 'var(--mem-model)', '', '', marker)}
          ${barRow('guest peak', formatBytes(peak.value), peak.value / scale, 'var(--step-wasm)',
            `${pctOf(peak.value, size.value)} of the model`, '', marker)}
        </div>
      </div>`);
  }
  if (!blocks.length) return null;
  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = 'llama-memory';
  card.innerHTML = `
    <header>
      <h3>${anchorLink(card.id, 'llama-memory')} <span class="metric-hint">bytes · latest run per box</span></h3>
    </header>
    <p class="card-intro">
      The wasm step's model is bigger than a <code>wasm32</code> guest can address
      (the dashed line, 4 GiB), yet the guest's memory stays a fraction of it:
      the weights reach the GPU through <code>wasi:webgpu</code> without passing
      through guest memory.
    </p>
    <div class="panel-grid">${blocks.join('')}</div>`;
  return card;
}


function serverlessCard(box, rows) {
  const run = latestRun(rows);
  const latest = rows.filter(r => runKey(r) === run.key);
  const find = (side, metric) => latest.find(r => r.param === `${box}/${side}` && r.metric === metric);
  const sides = SIDES.filter(s => latest.some(r => r.param === `${box}/${s}` || r.param.startsWith(`${box}/${s}/`)));
  const failed = latest.some(r => r.turns_ok === false);

  const card = document.createElement('div');
  card.className = 'chart-card';
  card.id = anchorId('serverless', box);
  card.innerHTML = `
    <header>
      <h3>${anchorLink(card.id, box)} <span class="metric-hint">${escapeHtml(run.row.gpu || '')} · GPU memory over the idle baseline</span></h3>
      ${runLabel(run.row)}
    </header>
    ${failed ? '<p class="caveat warn">Some wasmCloud turns exited non-zero in this run (outlined red below); their numbers are suspect.</p>' : ''}`;

  const timelines = sides.map(s => ({ side: s, tl: find(s, 'peak_gpu_mem')?.timeline })).filter(x => x.tl?.points?.length);
  if (timelines.length) {
    const names = [...new Set(timelines.flatMap(x => (x.tl.turns || []).map(t => t.name)))];
    names.sort((a, b) => modelIndex(a) - modelIndex(b));
    const legend = [
      ...timelines.map(x => `<span><span class="swatch line" style="background:${cssVar(`--side-${x.side}`)}"></span>${SIDE_LABEL[x.side]}</span>`),
      '<span class="legend-sep">turns:</span>',
      ...names.map(n => `<span title="${escapeHtml(n)}"><span class="swatch" style="background:${modelColor(n)}"></span>${escapeHtml(modelShort(n))}</span>`),
      '<span><span class="swatch idle"></span>idle</span>',
    ].join('');
    card.insertAdjacentHTML('beforeend', `
      <div class="legend">${legend}</div>
      <div class="chart-wrapper timeline"><canvas aria-label="${escapeHtml(`${box}: GPU memory over time, ${timelines.map(x => SIDE_LABEL[x.side]).join(' and ')}`)}"></canvas></div>`);
    charts.push(timelineChart(card.querySelector('canvas'), timelines));
  }

  const tile = (label, metric, fmt, extra = () => '') => {
    const lines = sides.map(s => {
      const r = find(s, metric);
      return `<div class="tile-line"><span class="swatch" style="background:${cssVar(`--side-${s}`)}"></span><span class="tile-side">${SIDE_LABEL[s]}</span><span class="tile-value">${r ? escapeHtml(fmt(r.value)) : '—'}</span></div>${extra(s)}`;
    }).join('');
    return `<div class="tile"><div class="tile-label">${label}</div>${lines}</div>`;
  };
  // What a stopped turn gives back: the peak less what is still held while idle.
  const freed = s => {
    const peak = find(s, 'peak_gpu_mem')?.value;
    const idle = find(s, 'idle_gpu_mem')?.value;
    return peak > 0 && idle != null ? { bytes: peak - idle, share: (peak - idle) / peak } : null;
  };
  const freedTile = `<div class="tile"><div class="tile-label">freed when a turn ends</div>${sides.map(s => {
    const f = freed(s);
    return `<div class="tile-line"><span class="swatch" style="background:${cssVar(`--side-${s}`)}"></span><span class="tile-side">${SIDE_LABEL[s]}</span><span class="tile-value">${f ? `${(f.share * 100).toFixed(1)} %` : '—'}</span></div>${f ? `<div class="tile-sub">${escapeHtml(formatBytes(f.bytes))} of the peak</div>` : ''}`;
  }).join('')}</div>`;
  // Between turns only the host process can hold GPU memory: native runs have
  // no process then, so the native line says so instead of showing 0 B.
  const hostTile = `<div class="tile"><div class="tile-label">host process while idle</div>${sides.map(s => {
    const idle = find(s, 'idle_gpu_mem');
    const before = find(s, 'host_idle_gpu_mem');
    const value = s === 'native' ? 'no process' : idle ? formatBytes(idle.value) : '—';
    const sub = s !== 'native' && before ? `<div class="tile-sub">${escapeHtml(formatBytes(before.value))} before the first turn</div>` : '';
    return `<div class="tile-line"><span class="swatch" style="background:${cssVar(`--side-${s}`)}"></span><span class="tile-side">${SIDE_LABEL[s]}</span><span class="tile-value">${escapeHtml(value)}</span></div>${sub}`;
  }).join('')}</div>`;
  card.insertAdjacentHTML('beforeend', `
    <div class="tiles">
      ${tile('peak GPU memory', 'peak_gpu_mem', formatBytes)}
      ${freedTile}
      ${hostTile}
    </div>
    ${ttftTable(box, latest, sides)}
    <p class="card-foot">Memory is over the box's baseline before the run. When a turn ends, wasmCloud
      stops its workload and frees the workload's GPU memory; the host process keeps running, so what
      stays is the host's own GPU context, not a model. Native turns are separate processes, so
      nothing runs between them. Idle memory is the median over the back half of each idle window;
      before the first turn it is what the started host holds before serving anything. Times are
      medians over each model's turns: start is the workload's compile and link, load and first
      token are llama.cpp's own timings.</p>`);
  return card;
}

// Where each model's time to first token goes, per side.
function ttftTable(box, latest, sides) {
  const per = latest.filter(r => sides.some(s => r.param.startsWith(`${box}/${s}/`)));
  const models = [...new Set(per.map(r => r.model))].sort((a, b) => modelIndex(a) - modelIndex(b));
  if (!models.length) return '';
  const ms = formatterForUnit('ms');
  const cell = (side, model, metric) => {
    const r = per.find(x => x.param === `${box}/${side}/${model}` && x.metric === metric);
    return r ? `<td>${escapeHtml(ms(r.value))}</td>` : '<td class="muted">—</td>';
  };
  const rows = models.flatMap(m => sides.map(s => `
    <tr>
      <td><span class="swatch" style="background:${cssVar(`--side-${s}`)}"></span>${escapeHtml(modelShort(m))} · ${SIDE_LABEL[s]}</td>
      ${['ttft_ms', 'start_ms', 'load_ms', 'first_token_ms', 'turn_ms'].map(k => cell(s, m, k)).join('')}
    </tr>`)).join('');
  return `
    <div class="table-scroll"><table class="split-table">
      <thead><tr><th>model</th><th>first token</th><th>start</th><th>load</th><th>prompt + token</th><th>whole turn</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>`;
}

function timelineChart(canvas, timelines) {
  const { muted, grid, ink } = themeInk();
  const datasets = timelines.map(({ side, tl }) => {
    const color = cssVar(`--side-${side}`);
    return {
      label: SIDE_LABEL[side],
      side,
      tl,
      data: tl.points.map(([t, b]) => ({ x: t / 1000, y: b })),
      borderColor: color,
      backgroundColor: withAlpha(color, 0.12),
      fill: 'origin',
      pointRadius: 0,
      pointHoverRadius: 4,
      pointHoverBackgroundColor: color,
      borderWidth: 2,
      tension: 0,
    };
  });
  const maxX = Math.max(...datasets.map(d => d.data.at(-1)?.x ?? 0));
  const maxY = Math.max(...datasets.flatMap(d => d.data.map(p => p.y)));
  const lanes = {
    id: 'turnLanes',
    afterDraw(chart) {
      const { ctx, chartArea: area, scales: { x } } = chart;
      const top0 = chart.height - timelines.length * (LANE_H + LANE_GAP);
      const px = v => Math.max(area.left, Math.min(area.right, x.getPixelForValue(v / 1000)));
      ctx.save();
      ctx.font = '11px ui-sans-serif, system-ui, sans-serif';
      ctx.textBaseline = 'middle';
      timelines.forEach(({ side, tl }, i) => {
        const y = top0 + i * (LANE_H + LANE_GAP);
        ctx.fillStyle = muted;
        ctx.textAlign = 'right';
        ctx.fillText(SIDE_LABEL[side], area.left - 6, y + LANE_H / 2);
        ctx.fillStyle = grid;
        ctx.fillRect(area.left, y, area.right - area.left, LANE_H);
        for (const [a, b] of tl.idle || []) {
          ctx.fillStyle = hatch(ctx, muted);
          ctx.fillRect(px(a), y + 2, Math.max(1, px(b) - px(a)), LANE_H - 4);
        }
        for (const t of tl.turns || []) {
          const x0 = px(t.start);
          const w = Math.max(2, px(t.end) - x0);
          ctx.fillStyle = modelColor(t.name);
          ctx.fillRect(x0, y, w, LANE_H);
          if (!t.ok) {
            ctx.strokeStyle = cssVar('--regress');
            ctx.lineWidth = 2;
            ctx.strokeRect(x0, y, w, LANE_H);
          }
          const label = modelShort(t.name);
          if (ctx.measureText(label).width + 8 < w) {
            ctx.fillStyle = inkOn(modelColor(t.name));
            ctx.textAlign = 'center';
            ctx.fillText(label, x0 + w / 2, y + LANE_H / 2 + 0.5);
          }
        }
      });
      ctx.restore();
    },
  };
  return new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: { datasets },
    plugins: [lanes],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      layout: { padding: { bottom: timelines.length * (LANE_H + LANE_GAP) + 4 } },
      interaction: { mode: 'sameX', intersect: false },
      scales: {
        x: {
          type: 'linear',
          min: 0,
          max: Math.ceil(maxX),
          title: { display: true, text: 'seconds from the start of each run', color: muted, font: { size: 11 } },
          ticks: {
            color: muted,
            maxRotation: 0,
            // Drop the end tick when it crowds the last round one.
            callback: (v, i, ticks) => {
              const step = ticks.length > 1 ? ticks[1].value - ticks[0].value : 0;
              return i > 0 && i === ticks.length - 1 && v - ticks[i - 1].value < step ? '' : `${v} s`;
            },
          },
          grid: { color: grid },
        },
        y: {
          beginAtZero: true,
          ticks: { color: muted, stepSize: byteStep(maxY), callback: v => formatBytes(v) },
          grid: { color: grid },
        },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            title: items => items.length ? `t = ${items[0].raw.x.toFixed(1)} s` : '',
            label: ctx => `${ctx.dataset.label}: ${formatBytes(ctx.raw.y)}`,
            afterLabel: ctx => {
              const t = ctx.raw.x * 1000;
              const tl = ctx.dataset.tl;
              const turn = (tl.turns || []).find(u => u.start <= t && t <= u.end);
              if (turn) return `  turn: ${turn.name}${turn.ok ? '' : ' (failed)'}`;
              if ((tl.idle || []).some(([a, b]) => a <= t && t <= b)) return '  idle';
              return '';
            },
          },
        },
        annotation: { annotations: {} },
      },
      color: ink,
    },
  });
}

// Both sides sample on their own clocks, so hover picks each dataset's
// nearest point to the cursor's time rather than a shared index.
Chart.Interaction.modes.sameX = (chart, e) => {
  const x = chart.scales.x.getValueForPixel(e.x);
  const items = [];
  chart.data.datasets.forEach((ds, di) => {
    const meta = chart.getDatasetMeta(di);
    if (meta.hidden || !ds.data.length) return;
    const last = ds.data.at(-1).x;
    if (x < 0 || x > last) return;
    let lo = 0, hi = ds.data.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ds.data[mid].x < x) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && x - ds.data[lo - 1].x < ds.data[lo].x - x) lo--;
    items.push({ element: meta.data[lo], datasetIndex: di, index: lo });
  });
  return items;
};


// One `bench-tools gpu jsonl` invocation stamps every row with the same
// provenance, so these fields identify a run.
function runKey(r) {
  return `${r.sha}|${r.run_id}|${r.run_attempt}|${r.timestamp}|${r.box}`;
}

function latestRun(rows) {
  const row = rows.reduce((a, b) => (new Date(b.timestamp) > new Date(a.timestamp) ? b : a));
  return { key: runKey(row), row };
}

function runLabel(r) {
  const d = new Date(r.timestamp);
  const sha = /^\d+$/.test(String(r.run_id))
    ? `<a href="${REPO_URL}/actions/runs/${encodeURIComponent(r.run_id)}" target="_blank" rel="noopener">${escapeHtml(r.short_sha)}</a>`
    : escapeHtml(r.short_sha);
  const smoke = r.smoke ? ' <span class="badge smoke" title="run.sh --smoke: 0.5B model, short tests">smoke</span>' : '';
  const pr = pullNumber(r.ref);
  const ref = pr
    ? `<a href="${REPO_URL}/pull/${pr}" target="_blank" rel="noopener">PR #${pr}</a> <span class="badge pr" title="published with gpubench.yml's publish_pr: code that is not on main">unmerged</span>`
    : escapeHtml(r.ref);
  return `<div class="run-label">latest: ${sha} · ${ref} · <span title="${escapeHtml(r.timestamp)}">${relTime(d)}</span>${smoke}</div>`;
}

// gpubench.yml labels a pull request's rows `pull/N`.
function pullNumber(ref) {
  return /^pull\/(\d+)$/.exec(ref ?? '')?.[1] ?? null;
}

// Published pull-request refs, the most recently run first.
function pullRefs(rows) {
  const newest = new Map();
  for (const r of rows) {
    if (!pullNumber(r.ref)) continue;
    if (!newest.has(r.ref) || r.timestamp > newest.get(r.ref)) newest.set(r.ref, r.timestamp);
  }
  return [...newest.keys()].sort((a, b) => newest.get(b).localeCompare(newest.get(a)));
}

function boxesOf(rows) {
  return [...new Set(rows.map(r => r.box).filter(Boolean))].sort();
}

// `llama-pp512` before `llama-tg128`, then by size.
function sortTests(groups) {
  const key = g => {
    const m = /^llama-(pp|tg)(\d+)$/.exec(g);
    return m ? [m[1] === 'pp' ? 0 : 1, -Number(m[2])] : [2, 0];
  };
  return groups.sort((a, b) => {
    const [x, y] = [key(a), key(b)];
    return x[0] - y[0] || x[1] - y[1] || a.localeCompare(b);
  });
}

function testLabel(group) {
  const m = /^llama-(pp|tg)(\d+)$/.exec(group);
  if (!m) return group;
  return m[1] === 'pp' ? `pp${m[2]} · prompt processing` : `tg${m[2]} · generation`;
}

function stepLabel(box, step) {
  const backend = VENDOR_BACKEND[box.split('-')[0]];
  if (step === 'vendor' && backend) return `vendor <span class="muted">(${backend})</span>`;
  return escapeHtml(step);
}

function modelsInOrder(rows) {
  const out = [];
  const sorted = rows.filter(r => r.timeline).sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
  for (const r of sorted) {
    for (const t of r.timeline.turns || []) if (!out.includes(t.name)) out.push(t.name);
  }
  return out;
}

function modelIndex(name) {
  const i = modelOrder.indexOf(name);
  return i < 0 ? modelOrder.length : i;
}

function modelColor(name) {
  return cssVar(`--model-${(modelIndex(name) % 3) + 1}`);
}

// `qwen2.5-7b-q4km` → `7B`.
function modelShort(name) {
  const m = /(\d+(?:\.\d+)?)b\b/i.exec(name || '');
  return m ? `${m[1]}B` : (name || '');
}

function fmtTok(v) {
  if (v == null || isNaN(v)) return '—';
  return v >= 100 ? Math.round(v).toLocaleString('en-US') : v.toFixed(1);
}

// A gap row holds how much slower the later step is, in percent.
function fmtGap(pct) {
  const v = -pct;
  return `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)} %`;
}

// A round tick step (power-of-two MiB or GiB) giving about five ticks.
function byteStep(max) {
  const target = max / 5;
  let step = 2 ** 20;
  while (step < target) step *= 2;
  return step;
}

function pctOf(part, whole) {
  if (!whole) return '—';
  const p = (part / whole) * 100;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)} %`;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function themeInk() {
  return { muted: cssVar('--muted'), grid: cssVar('--grid'), ink: cssVar('--fg') };
}

function withAlpha(hex, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// Dark or white text, whichever reads on the given fill.
function inkOn(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = c => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const l = 0.2126 * lin(n >> 16) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return l > 0.3 ? '#111' : '#fff';
}

function hatch(ctx, color) {
  const c = document.createElement('canvas');
  c.width = c.height = 6;
  const g = c.getContext('2d');
  g.strokeStyle = color;
  g.globalAlpha = 0.6;
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(0, 6); g.lineTo(6, 0);
  g.stroke();
  return ctx.createPattern(c, 'repeat');
}
})();

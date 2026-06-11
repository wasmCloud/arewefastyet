# arewefastyet.wasmcloud.com (https://wasmcloud.github.io/arewefastyet/)

Static trend site for the wasmCloud bench pipeline. Three views:

- **[trends](./index.html)** — one Chart.js timeline per `(bench, group)`,
  overlaid with one line per `param` (e.g. `p2` and `p3`).
- **[compare](./compare.html)** — pick two runs and see a per-row diff
  (Δ, %, significance). Deep-linkable via
  `?bench=<bench>&a=<runId>&b=<runId>`.
- **[releases](./releases.html)** — semver-ordered timeline filtered
  to release tags.

This repo is **just the site**. Bench data is produced by the bench
pipeline in [`wasmCloud/wasmCloud`](https://github.com/wasmCloud/wasmCloud)
(see [`scripts/bench/`](https://github.com/wasmCloud/wasmCloud/tree/main/scripts/bench))
and served live via CloudFront in front of S3.

## Architecture

```
   wasmCloud/wasmCloud (bench pipeline)              wasmCloud/arewefastyet (this repo)
   ─────────────────────────────────                 ─────────────────────────────────
                                                              │
       cargo bench  ──►  push-s3.sh                           │ git push to main
                            │                                 │
                ┌───────────┴────────────┐                    ▼
                ▼                        ▼            GitHub Pages
        per-run files            history.json         (static HTML/CSS/JS)
        (private)                (Cache-Control:              │
        runs/<date>/<sha>/...     max-age=60)                 │
                                       │                      │
                                       ▼                      ▼
                                CloudFront edge ◄─── browser fetches config.json,
                                (1 TB/mo free)               then DATA_URL
                                       │
                                       ▼
                                    S3 (private,
                                    OAC-only read on
                                    history.json)
```

The bench pipeline aggregates `history.json` server-side after each run
and issues a CloudFront invalidation, so the site sees new data within
seconds (without that, `Cache-Control: max-age=60` would be the
worst-case lag).

There's no AWS auth in this repo and no aggregation step — the
deploy workflow just generates `config.json` with the live data URL
and ships static assets to GitHub Pages.

## Branding

The site uses the official [wasmCloud logo](./assets/wasmcloud-logo.svg)
(brand green, `#00bc8e`) for the header mark + favicon. Brand color is
also applied to links and the active tab underline. Chart line colors
stay distinct (cyan for `p2`, purple for `p3`) because they carry
semantic meaning across charts and shouldn't blend with brand chrome.

## Metric semantics (RPS vs latency)

Display unit per chart depends on the row's harness:

**Criterion** rows pick from `criterion::Throughput`:

| criterion config | display | direction |
|---|---|---|
| `Throughput::Elements(N)` with `N > 1` | req/s (auto-scaled to Kreq/s, Mreq/s) | higher is better |
| `Throughput::Bytes(N)` with `N > 0` | B/s (auto-scaled) | higher is better |
| no throughput, or `Elements(1)` | time (auto-scaled ns / µs / ms / s) | lower is better |

So `http_throughput` (declared `Throughput::Elements(256)` in the bench)
displays as Kreq/s and an *increase* is shown green. `cold_invocation`
and `hot_invocation` are time benches and an *increase* is shown red.

**gungraun** rows (`metric: "Ir"`) display as instructions
(`K`/`M`/`G`-suffixed); lower is better, no CI band.

## One-time setup

AWS infra (bucket + OAC + CloudFront + IAM) is bootstrapped from the
wasmCloud repo:

```sh
# in wasmCloud/wasmCloud
./scripts/bench/aws/setup-aws.sh \
  --bucket wasmcloud-benches \
  --region eu-central-1
```

That script prints the values for both repos. For **this repo**, only
one is needed:

| Setting | Type | Value |
|---|---|---|
| `DATA_URL` | repo **var** (Settings → Secrets and variables → Actions → Variables) | the printed `https://dXXXX.cloudfront.net/history.json` |

Then:

1. **Enable Pages** — Settings → Pages → Source = "GitHub Actions".
2. **DNS** — at Cloudflare, add `arewefastyet.wasmcloud.com → wasmcloud.github.io`
   (Proxy disabled so Pages' Let's Encrypt cert can issue).
3. **First deploy** — Actions → deploy → Run workflow.

## Local preview

The site falls back to `data/history.sample.json` when `config.json`
isn't present, so plain `python3 -m http.server` Just Works:

```sh
python3 -m http.server 8000
# → open http://localhost:8000
```

To preview against live data, write a `config.json`:

```sh
echo '{"dataUrl":"https://dXXXX.cloudfront.net/history.json"}' > config.json
python3 -m http.server 8000
```

## Data shape

Three row shapes coexist in `history.json`. All share the same envelope
(`bench`, `group`, `param`, `sha`, `ref`, `timestamp`, …); the metric
fields differ.

**Criterion** (`metric: "mean_ns"`):

```json
{
  "bench": "http_invoke",
  "group": "cold_invocation",
  "param": "p2",
  "sha": "d8f795fe2eb9...",
  "short_sha": "d8f795fe2eb9",
  "ref": "main",
  "run_id": "1234567890",
  "run_attempt": "1",
  "timestamp": "2026-05-07T17:21:20Z",
  "host": "wasmcloud-bench-01",
  "kernel": "6.8.0-100-generic",
  "cpus_online": 6,
  "metric": "mean_ns",
  "value": 78667741.74,
  "throughput": {"Elements": 256},
  "mean_ns": 78667741.74,
  "median_ns": 77841173.62,
  "std_dev_ns": 1770558.62,
  "ci_low_ns": 77764094.17,
  "ci_high_ns": 79841655.92
}
```

**gungraun** (`metric: "Ir"`):

```json
{
  "bench": "gungraun",
  "group": "http",
  "param": "hot_invocation.p2",
  "metric": "Ir",
  "value": 12345678
}
```

The bench-side dedup key is `(sha, bench, group, param, run_attempt,
metric)`. `HISTORY_MAX_AGE_DAYS` (set in the bench-side aggregator)
caps the file at one year by default to keep it bounded as runs
accumulate.

## Significance heuristic (compare view)

**Criterion rows** are flagged as significant only if **both**:

1. `|%| ≥ 1` (the change is more than the noise floor we care about), and
2. The 95 % CIs of A and B do **not** overlap.

Otherwise the change is within criterion's variance and shown as flat
(grey, with a `·` in the sig column). Conservative on purpose — better
to under-flag than to call random noise a "regression".

**gungraun rows** have no CI in our schema. They fall back to a
stricter `|%| ≥ 2` threshold; below that, flat. gungraun is
deterministic, so the threshold is mostly there to guard against
floating-point artifacts at the bottom of the dynamic range — anything
≥ 2 % is real signal.

## Files

| File | Purpose |
|------|---------|
| `index.html` | Trends page shell |
| `compare.html` | Compare-runs page shell |
| `style.css` | Shared styles; light/dark via `prefers-color-scheme`, mobile-friendly |
| `script.js` | Trends logic + `loadHistory()` (fetches `config.json` then `dataUrl`, with sample fallback). Exports helpers on `window.AWFY`. |
| `compare.js` | Compare-runs logic; consumes `window.AWFY` (IIFE-wrapped). |
| `releases.html`, `releases.js` | Releases page: filters history to semver tags, x-axis is the (semver-ordered) tag, not time. |
| `assets/wasmcloud-logo.svg` | Official wasmCloud hex-W mark (#00bc8e), used for header logo + favicon. |
| `CNAME` | Pages reads this for the custom domain. |
| `data/history.sample.json` | Synthetic 8-commit sample (clearly fake SHAs) — local-dev fallback. |
| `.github/workflows/deploy.yml` | On push/dispatch: write `config.json` from `vars.DATA_URL` → deploy-pages. |
| `.gitignore` | Excludes the runtime-generated `config.json`. |

## Out of scope (not built)

- **Cross-repo trigger** from wasmCloud's bench workflow into this one.
  Not needed: the site fetches at page-load time, so new bench runs
  surface within ~1 minute (Cache-Control max-age + CloudFront
  invalidation) without redeploying.
- **Annotations** — overlay markers on commits where a perf-relevant
  change landed. Planned next.
- **Versions view** — semver-ordered x-axis filtered to release tags.
  Planned next.
- **Custom domain on CloudFront** (`data.arewefastyet.wasmcloud.com`).
  Optional polish: requires an ACM cert in `us-east-1` validated via
  Cloudflare DNS, then attached to the distribution.

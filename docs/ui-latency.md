# Measure `/ui` latency

The [`/ui` pages](cloud.md#read-and-act-on-issues-in-a-browser) should feel like data already in hand.
This page sets the latency budget and describes how to measure it.

## Budget

The budget counts from the input that starts a step to the first paint of the new page.

| Step | Budget |
| --- | --- |
| First load of any page | No budget. It needs a network round trip and the Access login. |
| Follow a link to Today, a tab, a project, a filter chip, or an issue after the first load | 100 ms, ideally the next frame (16 ms) |
| Go back or forward | Next frame |
| Submit a search | No budget. A search is a query against the store. |
| Send a form (Approve, Done, a field, a comment, Dispatch, New issue) | No budget. A write is a form submission that answers `303` to the page it came from. GET `/ui` is unchanged. |

A step that waits for the network cannot meet 100 ms on a phone link once the round trip and the Worker's D1 reads add up to more than that.
Such a step meets the budget only when the browser already holds the next page.

## Check the budget in CI

`scripts/ui-latency-budget.ts` is the CI gate.
It renders `/ui` through the Worker handler on local SQLite.
It does not start Chrome, and it does not seed the 1,000-issue store that `scripts/ui-latency.ts` uses.

```sh
npm run check:ui-latency
```

The Check workflow runs that command in its `static` suite on every push except to main, and on every pull request.
A change that touches the Worker `/ui` code fails the workflow when a budgeted step misses.
`npm test` runs the same gate, including the cases that remove prefetch, add a server delay, or drop the back-forward cache.

The tolerance for CI noise is 0 ms.
The gate does not sample paint, so it has no paint sample to smooth.
A step fails when its bound is greater than its budget.

The bound uses the numbers in the budget table and in the measurement below.
It does not add a Chrome timing.

A followed link after the first load has a budget of 100 ms.
When the page prefetches `/ui` and `/ui/*`, the bound is the longest `animation-duration` in the page.
The current crossfade is 80 ms, which is inside 100 ms.
When those URLs are not prefetched, the bound is the 150 ms phone stand-in from the measurement below, and the link misses 100 ms.
A server delay longer than the 300 ms rest is on that same path.
The bound is then 150 ms plus the delay.
A delay of 150 ms stays off the path, because a rested prefetch already hides that stand-in.
First load and search submit have no budget, so the gate does not fail them.

Back and forward have a budget of one frame, 16 ms.
The bound is 16 ms when the page can return from the back-forward cache.
`Cache-Control: private, no-cache` can.
`no-store` cannot.
An `onbeforeunload` attribute cannot, and neither can a script that listens for `beforeunload` or `pagehide`.
Without that cache, the bound is the 150 ms stand-in, and the step misses the frame.

A budget miss fails the change.
A feature that cannot meet the budget needs an owner decision before it lands.
Keep the prefetch rules, the private `no-cache` header, and the 80 ms crossfade unless that decision says otherwise.

`scripts/ui-latency.ts` remains the way to measure paint in Chrome.
The gate does not replace those measurements.

## Measure on local workerd

`scripts/ui-latency.ts` runs the built Worker in local workerd with a synthetic D1 store.
It seeds 10 projects, 1,000 issues, about 2,000 comments, about 240 prerequisites, and about 25 active claims.
The largest project has 320 issues.
The data comes from a fixed seed, so every run measures the same store.

Build the Worker and run the script:

```sh
POLYLINEDB_BUILD_WITHOUT_ACCESS=1 CLOUDFLARE_VITE_FORCE_BUILD_OUTPUT=true npm exec -- vite build
node scripts/ui-latency.ts --out ui-latency.json
node scripts/ui-latency.ts --delay-ms 150 --server-runs 10
```

The script first requests each page 40 times through workerd and reports the median and 95th percentile time, the HTML size, and the gzip size.
Those times include the Access check, the D1 reads, and the rendering.
Local D1 is a SQLite database inside workerd, so the times leave out the round trips from the Worker to D1 on Cloudflare.

The script then starts headless Chrome with a 420 × 900 window.
A local proxy adds the Access assertion to every request, as the Access edge does after its own login check.
`--delay-ms` holds every request in the proxy to stand in for the phone link and the remote D1 reads.
Each run follows the same path: **Today**, **Projects**, the largest project, its `open` chip, an issue, back, **Stuck**, a stuck issue, and **Today** again.
It plays the path once with the pointer resting 300 ms on each link before the click, as a mouse does, and once with an immediate click.
`--dwell-ms` changes the rest time.
Before the pointer moves, the script waits until the page has no running animation, so a view-transition crossfade has finished and the click can reach the link.
Each run uses a fresh browser profile.

For each step, the visible time is the first contentful paint of the new page minus its `activationStart`.
This is how web-vitals reports a prerendered page.
A page restored from the back-forward cache has no new navigation entry.
Its visible time runs from `history.back()` to the frame after `pageshow`.
The `restoredFrom` column says where the page came from: `network`, `revalidated`, `http-cache`, `prefetch`, `prerender`, or `bfcache`.

Set `CHROME` or `--chrome` when Chrome is not on the path as `google-chrome`.
As root, point it at a wrapper that adds `--no-sandbox`; otherwise Chrome exits at start and the script prints its error.
Use `--skip-browser` to measure only the Worker.

## Results

These numbers come from one Linux container on 2026-10-28: local workerd, and the Playwright build of Chromium 141 in headless mode with `--no-sandbox` (the container runs as root), in a 420 × 900 window.
**Lanes** is the current design. **Before** is the main branch just before the lanes design replaced the views, run on the same machine with the same seed and the same fixed script.
The store is the script's fixed synthetic dataset: 10 projects, 1,000 issues, 1,958 comments, 243 prerequisites, and 24 active claims.
The largest project has 320 issues.
Each Worker figure is the median of 10 requests after 3 warm-up requests.
Each visible figure is the median of 3 browser runs.
pd1, a deployed Worker, production Access, and Cloudflare D1 were not measured.
An earlier table on another machine with Chrome 148 measured the earlier pages 1.5 to 2 times faster than **Before** below, so compare rows within one table only.

### Worker

The Worker time includes the Access check, the local D1 reads, and rendering.
It does not include a network round trip.
Every lanes page runs the lane reads for its tab badges.

| Page | Lanes median | Lanes 95th | Lanes HTML | Lanes gzip | Lanes 304 | Before median | Before HTML |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Today (before: Home) | 35.4 ms | 50.3 ms | 69,086 | 12,353 | 24.6 ms | 10.3 ms | 20,957 |
| Agents (before: Working) | 30.4 ms | 46.9 ms | 82,416 | 12,283 | 33.5 ms | 9.4 ms | 33,793 |
| Landing | 26.3 ms | 32.0 ms | 43,045 | 9,808 | 31.8 ms | | |
| Stuck (before: Blocked) | 31.8 ms | 62.3 ms | 117,085 | 15,620 | 32.0 ms | 6.7 ms | 23,551 |
| Projects | 32.6 ms | 42.6 ms | 34,761 | 9,233 | 29.8 ms | | |
| Activity | 31.3 ms | 40.0 ms | 52,365 | 10,814 | 31.4 ms | 5.7 ms | 29,892 |
| Largest project | 42.4 ms | 69.5 ms | 106,817 | 17,365 | 35.9 ms | 13.9 ms | 60,950 |
| That project, open | 34.8 ms | 43.2 ms | 106,405 | 17,374 | 35.4 ms | 16.4 ms | 61,735 |
| That project, ready | 31.1 ms | 35.5 ms | 76,119 | 13,747 | 34.8 ms | 9.2 ms | 37,427 |
| Issue, epic | 37.1 ms | 54.0 ms | 74,002 | 14,421 | 34.8 ms | 11.5 ms | 26,624 |
| Issue, leaf | 37.6 ms | 43.1 ms | 43,287 | 10,664 | 39.2 ms | 10.3 ms | 11,373 |
| Search, words | 29.6 ms | 39.1 ms | 55,114 | 11,850 | 28.6 ms | 6.4 ms | 23,598 |
| Search, id | 38.3 ms | 47.2 ms | 31,242 | 8,882 | 31.1 ms | 10.5 ms | 9,284 |

The lanes pages take about three times the Worker time and two to four times the bytes of the pages they replaced.
On Today and Stuck, an inline stylesheet of 23 KB (7 KB before), 58 and 201 inline icons, and 25 and 49 forms make up most of the bytes.
A 304 still reads D1 and renders before it compares the `ETag`, so it is not faster.
Timing each lane read alone inside workerd put nearly all of the Worker time on the reads: the eight reads took 2 to 8 ms each and ran one after another on local D1, and `Server-Timing`, which counts only the time spent waiting on I/O, was within a few ms of the total.
Pages outside the four lanes now read only the three queries their Today and Stuck badges count. Measured again the same way:

| Page | Before the change | After |
| --- | --- | --- |
| Projects | 32.6 ms | 16.1 ms |
| Activity | 31.3 ms | 15.4 ms |
| Largest project | 42.4 ms | 24.7 ms |
| Issue, epic | 37.1 ms | 23.5 ms |
| Issue, leaf | 37.6 ms | 19.0 ms |
| Search, words | 29.6 ms | 16.9 ms |
| Search, id | 38.3 ms | 23.3 ms |

The lane pages kept their times, about 25 to 30 ms.
On Cloudflare D1 the reads of one page run in parallel, each with its own round trip, so the local sum overstates what a deployed page waits; that was not measured.
In Chrome, with 3 runs and no added delay, the paints of the followed links moved by -40 to +30 ms, which is within the spread of the runs.

### Visible time

The first load has no budget.
Back should be the next frame.
A followed link should be under 100 ms after the first load.
The lanes path is **Today**, **Projects**, the largest project, its `open` chip, an issue, back, **Stuck**, a stuck issue, and **Today**.
The **Before** path was **Home**, the largest project, its `open` chip, an issue, back, **Inbox**, an inbox issue, and **Home**.

With no added delay:

| Step | Lanes, 300 ms rest | Lanes, immediate | Before, 300 ms rest | Before, immediate |
| --- | --- | --- | --- | --- |
| First load | 152 ms, network | 104 ms, network | 52 ms, network | 56 ms, network |
| To Projects | 104 ms, prefetch | 120 ms, prefetch | | |
| To the largest project | 124 ms, prefetch | 176 ms, prefetch | 104 ms, prefetch | 124 ms, prefetch |
| Open filter | 140 ms, prefetch | 192 ms, prefetch | 100 ms, prefetch | 120 ms, prefetch |
| An issue | 116 ms, prefetch | 124 ms, prefetch | 84 ms, prefetch | 100 ms, prefetch |
| Back | 64 ms, back-forward cache | 57 ms, back-forward cache | 43 ms, back-forward cache | 44 ms, back-forward cache |
| Stuck (before: Inbox) | 120 ms, prefetch | 124 ms, prefetch | 72 ms, prefetch | 80 ms, prefetch |
| A listed issue | 108 ms, prefetch | 128 ms, prefetch | 92 ms, prefetch | 96 ms, prefetch |
| Back to Today | 112 ms, prefetch | 140 ms, prefetch | 84 ms, prefetch | 104 ms, prefetch |

With a 150 ms delay on every request:

| Step | Lanes, 300 ms rest | Lanes, immediate | Before, 300 ms rest | Before, immediate |
| --- | --- | --- | --- | --- |
| First load | 280 ms, network | 264 ms, network | 220 ms, network | 212 ms, network |
| To Projects | 176 ms, prefetch | 272 ms, prefetch | | |
| To the largest project | 200 ms, prefetch | 312 ms, prefetch | 180 ms, prefetch | 268 ms, prefetch |
| Open filter | 204 ms, prefetch | 368 ms, prefetch | 176 ms, prefetch | 268 ms, prefetch |
| An issue | 188 ms, prefetch | 292 ms, prefetch | 140 ms, prefetch | 248 ms, prefetch |
| Back | 58 ms, back-forward cache | 63 ms, back-forward cache | 44 ms, back-forward cache | 46 ms, back-forward cache |
| Stuck (before: Inbox) | 208 ms, prefetch | 308 ms, prefetch | 120 ms, prefetch | 232 ms, prefetch |
| A listed issue | 176 ms, prefetch | 300 ms, prefetch | 128 ms, prefetch | 248 ms, prefetch |
| Back to Today | 196 ms, prefetch | 300 ms, prefetch | 132 ms, prefetch | 240 ms, prefetch |

On this machine neither design meets the 100 ms budget for a followed link, and the lanes design adds about 20 to 90 ms to each step.
Back comes from the back-forward cache in both, but takes 44 to 64 ms here, not the next frame; the earlier measurement put that on the 80 ms crossfade.

## Measure on a deployed Worker

Open a `/ui` page in Chrome on a desktop and open the developer tools.
In the **Network** panel, the **Timing** tab of a page request shows the waiting time for the server and the content download.
Follow the same path as the script.
Then run this in the console of each page to read the visible time of the last navigation:

```js
(() => { const n = performance.getEntriesByType('navigation')[0]; const a = n.activationStart ?? 0; const p = performance.getEntriesByName('first-contentful-paint')[0]; return { type: n.type, prerendered: a > 0, responseStart: n.responseStart - a, visible: p && Math.max(p.startTime - a, 0) }; })()
```

Repeat on the phone, because its link sets the round trip.
On an iPhone, run the same line in the Web Inspector of a connected Mac.

To read the Worker time of several pages at once, run this in the console of any `/ui` page.
It fetches each page 7 times and prints the median and the slowest `Server-Timing` value:

```js
(async () => { const rows = []; for (const path of ['/ui', '/ui/agents', '/ui/stuck', '/ui/landing', '/ui/projects', '/ui/activity']) { const d = []; for (let i = 0; i < 7; i++) { const r = await fetch(path, { cache: 'no-store' }); await r.text(); const m = /worker;dur=([\d.]+)/.exec(r.headers.get('server-timing') ?? ''); if (m) d.push(Number(m[1])); } d.sort((a, b) => a - b); rows.push({ path, median_ms: d[d.length >> 1], max_ms: d.at(-1) }); } console.table(rows); })()
```

### Result on 2026-10-29

The deployed Worker with Cloudflare D1, measured from a desktop browser before reads shared a D1 call:

| Page | D1 calls | Median | Slowest |
| --- | --- | --- | --- |
| Today | 11 | 201 ms | 219 ms |
| Agents | 11 | 168 ms | 240 ms |
| Stuck | 11 | 143 ms | 221 ms |
| Landing | 11 | 147 ms | 210 ms |
| Projects | 4 | 74 ms | 155 ms |
| Activity | 4 | 130 ms | 202 ms |

The Worker time follows the number of D1 calls, not the rows read: each statement read under 3 ms on node:sqlite with 1,000 issues.
The pages already started their reads together, so the gap suggests that D1 serves the calls of one request one after another, each with its own round trip; this was inferred from the counts and not traced per call.
The Worker now sends reads that start before the next macrotask as one D1 batch, so Today, Agents, Stuck, and Landing make 2 calls and Projects and Activity make 1.
Activity reads the change log, which is large in a long-lived store, so its time depends on that read too.

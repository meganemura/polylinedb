# Measure `/ui` latency

The [`/ui` pages](cloud.md#read-issues-in-a-browser) should feel like data already in hand.
This page sets the latency budget and describes how to measure it.

## Budget

The budget counts from the input that starts a step to the first paint of the new page.

| Step | Budget |
| --- | --- |
| First load of any page | No budget. It needs a network round trip and the Access login. |
| Follow a link to home, a project, a filter chip, an issue, or a view after the first load | 100 ms, ideally the next frame (16 ms) |
| Go back or forward | Next frame |
| Submit a search | No budget. A search is a query against the store. |

A step that waits for the network cannot meet 100 ms on a phone link once the round trip and the Worker's D1 reads add up to more than that.
Such a step meets the budget only when the browser already holds the next page.

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
Each run follows the same path: home, the largest project, its `open` chip, an issue, back, **Inbox**, an inbox issue, and **Projects**.
It plays the path once with the pointer resting 300 ms on each link before the click, as a mouse does, and once with an immediate click.
`--dwell-ms` changes the rest time.
Each run uses a fresh browser profile.

For each step, the visible time is the first contentful paint of the new page minus its `activationStart`.
This is how web-vitals reports a prerendered page.
A page restored from the back-forward cache has no new navigation entry.
Its visible time runs from `history.back()` to the frame after `pageshow`.
The `restoredFrom` column says where the page came from: `network`, `revalidated`, `http-cache`, `prefetch`, `prerender`, or `bfcache`.

Set `CHROME` or `--chrome` when Chrome is not on the path as `google-chrome`.
Use `--skip-browser` to measure only the Worker.

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

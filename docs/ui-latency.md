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
Before the pointer moves, the script waits until the page has no running animation, so a view-transition crossfade has finished and the click can reach the link.
Each run uses a fresh browser profile.

For each step, the visible time is the first contentful paint of the new page minus its `activationStart`.
This is how web-vitals reports a prerendered page.
A page restored from the back-forward cache has no new navigation entry.
Its visible time runs from `history.back()` to the frame after `pageshow`.
The `restoredFrom` column says where the page came from: `network`, `revalidated`, `http-cache`, `prefetch`, `prerender`, or `bfcache`.

Set `CHROME` or `--chrome` when Chrome is not on the path as `google-chrome`.
Use `--skip-browser` to measure only the Worker.

## Results

These numbers are from local workerd and headless Chrome 148, in a 420 × 900 window.
The store is the script's fixed synthetic dataset: 10 projects, 1,000 issues, 1,958 comments, 243 prerequisites, and 24 active claims.
The largest project has 320 issues.
Each Worker figure is the median of 10 requests after 3 warm-up requests.
Each visible figure is the median of 3 browser runs.
The pointer rested 300 ms, which is the script's default.
pd1 was not measured.
A deployed Worker, production Access, and Cloudflare D1 were not measured.
The 150 ms proxy delay stands in for the phone link and the remote D1 reads.

### Worker

The Worker time below includes the Access check, the local D1 reads, and rendering.
It does not include a network round trip.

| Page | Median | 95th | HTML | gzip | 304 median |
| --- | --- | --- | --- | --- | --- |
| Home | 7.3 ms | 11 ms | 10,176 | 2,910 | 6.4 ms |
| Inbox | 5.8 ms | 7.9 ms | 22,618 | 4,352 | 5.1 ms |
| Working | 6.4 ms | 7.0 ms | 13,844 | 2,965 | 5.2 ms |
| Blocked | 6.9 ms | 7.7 ms | 18,818 | 3,731 | 5.2 ms |
| Recent | 6.3 ms | 7.7 ms | 26,698 | 4,824 | 5.6 ms |
| Largest project | 12.1 ms | 13 ms | 55,571 | 8,344 | 10.5 ms |
| That project, open | 11.4 ms | 13.3 ms | 55,926 | 8,355 | 8.9 ms |
| That project, ready | 7.0 ms | 10.4 ms | 31,522 | 5,820 | 8.7 ms |
| Issue, epic | 13.3 ms | 20.3 ms | 21,690 | 5,236 | 12.2 ms |
| Issue, leaf | 14.7 ms | 31.6 ms | 7,241 | 2,601 | 12.3 ms |
| Search, words | 7.1 ms | 9.3 ms | 19,224 | 3,771 | 6.5 ms |
| Search, id | 15.8 ms | 16.6 ms | 4,848 | 1,960 | 14.2 ms |

`Server-Timing` on these responses was about 3–15 ms.
A 304 still reads D1 before it compares the `ETag`, so it is not much faster than the full response on local D1.
Before the prefetch script and the crossfade, the same pages were about 6–19 ms and a few hundred bytes smaller.

### Visible time

The first load has no budget.
Back should be the next frame.
A followed link should be under 100 ms after the first load.

With no added delay, local workerd already answered fast enough to paint in well under 100 ms.
The prefetch and the crossfade changed where the page came from, and the crossfade made the paint a little later.

| Step | Before | After prefetch and crossfade |
| --- | --- | --- |
| First load of home | 48 ms, network | 36 ms, network |
| Home to the largest project | 40 ms, network | 56 ms, prefetch |
| Open filter | 36 ms, network | 64 ms, prefetch |
| An issue | 36 ms, network | 48 ms, prefetch |
| Back | 3.0 ms, back-forward cache | 35 ms, back-forward cache |
| Inbox | 36 ms, network | 48 ms, prefetch |
| An inbox issue | 36 ms, network | 52 ms, prefetch |
| Projects | 32 ms, revalidated | 52 ms, prefetch |

With a 150 ms delay, a cold navigation paints at about 180–200 ms.
Prefetch brings a rested click under 100 ms.
The 80 ms crossfade adds to that paint, and several steps then land between 100 ms and 116 ms.

| Step | Before | Prefetch only | Prefetch and crossfade |
| --- | --- | --- | --- |
| First load of home | 184 ms, network | 188 ms, network | 200 ms, network |
| Home to the largest project | 192 ms, network | 92 ms, prefetch | 116 ms, prefetch |
| Open filter | 188 ms, network | 92 ms, prefetch | 116 ms, prefetch |
| An issue | 184 ms, network | 84 ms, prefetch | 104 ms, prefetch |
| Back | 2.4 ms, back-forward cache | 2.6 ms, back-forward cache | 38 ms, back-forward cache |
| Inbox | 184 ms, network | 72 ms, prefetch | 108 ms, prefetch |
| An inbox issue | 188 ms, network | 92 ms, prefetch | 96 ms, prefetch |
| Projects | 184 ms, revalidated | 72 ms, prefetch | 100 ms, prefetch |

An immediate click, with the same 150 ms delay, still paints at about 190–220 ms.
Moderate prefetch starts on pointer down for that click, and the response is still in flight.
A 600 ms rest, measured with prefetch and without the crossfade, paints the followed pages in 16–40 ms from the prefetch cache.
Back in that run was 2.3 ms from the back-forward cache.
The first load stayed near 196 ms.

No application JavaScript was added.
Prefetch meets the 100 ms budget for a 300 ms rest on a 150 ms link.
The crossfade is the part that can miss that budget.

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

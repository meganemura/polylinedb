/** Renders the read-only /ui page for phones. It has no form, script, or write path; changes go through the operation endpoints. */
import { issuesAwaitingMain, recentlyClosedIssues, type Issue } from '../records/index.ts';
import type { SqlExecutor } from '../records/persistence.ts';

const listLimit = 50;
const escapes: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => escapes[character] ?? character);
}

function title(body: string): string {
  const line = body.split('\n').map(text => text.trim()).find(text => text.length > 0) ?? '';
  return line.replace(/^#+\s*/, '') || line;
}

// Workers run in UTC and Japan has no daylight saving time, so a fixed offset avoids output that differs with the runtime's ICU data.
function japanTime(iso: string): string {
  const time = Date.parse(iso);
  if (Number.isNaN(time)) return iso;
  return `${new Date(time + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')} JST`;
}

function row(issue: Issue): string {
  return `<li class="quiet-row">
<span class="primary">${escape(title(issue.body))}</span>
<span class="secondary">${escape(issue.id)} · 最終更新 <time datetime="${escape(issue.updated_at)}">${escape(japanTime(issue.updated_at))}</time></span>
<span class="secondary">${escape(issue.updated_by)}</span>
</li>`;
}

function section(heading: string, issues: readonly Issue[], empty: string, note?: string): string {
  const notice = note === undefined ? '' : `<p class="section-note">${note}</p>`;
  const body = issues.length === 0 ? `<p class="quiet-note">${empty}</p>` : `<ul class="quiet-list">${issues.map(row).join('')}</ul>`;
  return `<section class="quiet-section"><h2>${heading}</h2>${notice}${body}</section>`;
}

export function uiPage(lists: { awaitingMain: readonly Issue[]; recentlyClosed: readonly Issue[] }): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#f5f1e8">
<meta name="robots" content="noindex">
<title>Recent work</title>
<link rel="icon" href="data:,">
<style>${styles}</style>
</head>
<body>
<main class="paper">
<h1>Recent work</h1>
${section('main 待ち', lists.awaitingMain, 'Nothing waits for main.', 'Open issues labelled main-wait.')}
${section('Recently closed', lists.recentlyClosed, 'Nothing has closed yet.', 'Ordered by 最終更新. pd does not record when an issue closed.')}
</main>
</body>
</html>`;
}

export async function uiResponse(db: SqlExecutor): Promise<Response> {
  const [awaitingMain, recentlyClosed] = await Promise.all([
    issuesAwaitingMain(db, listLimit), recentlyClosedIssues(db, listLimit),
  ]);
  return new Response(uiPage({ awaitingMain, recentlyClosed }), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    },
  });
}

const styles = `
:root {
  color-scheme: light;
  font-family: -apple-system, BlinkMacSystemFont, "Hiragino Kaku Gothic ProN", "Yu Gothic", sans-serif;
  color: #393730;
  background: #f5f1e8;
  font-synthesis: none;
  -webkit-font-smoothing: antialiased;
  -webkit-text-size-adjust: 100%;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='180' height='180'%3E%3Cfilter id='paper'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.75' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' opacity='.035' filter='url(%23paper)'/%3E%3C/svg%3E");
}
.paper {
  width: min(100%, 560px);
  margin: 0 auto;
  padding: clamp(48px, 8svh, 80px) max(32px, env(safe-area-inset-right)) max(32px, env(safe-area-inset-bottom)) max(32px, env(safe-area-inset-left));
}
h1 {
  margin: 0 0 24px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: clamp(38px, 10vw, 48px);
  line-height: 1.4;
  letter-spacing: -.025em;
  font-weight: 500;
}
.quiet-section + .quiet-section { margin-top: 40px; }
.quiet-section h2 {
  margin: 0 0 4px;
  font-family: Georgia, "Times New Roman", serif;
  font-size: 22px;
  font-weight: 500;
  line-height: 1.4;
}
.section-note, .quiet-note { margin: 0; color: #716b60; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.quiet-note { margin-top: 18px; font-size: 18px; }
.quiet-list { list-style: none; margin: 0; padding: 0; }
.quiet-row { display: block; padding: 18px 0 20px; }
.quiet-row + .quiet-row { border-top: 1px solid #ddd7cb; }
.quiet-row .primary { display: block; font-size: 19px; line-height: 1.45; overflow-wrap: anywhere; }
.quiet-row .secondary { display: block; margin-top: 4px; color: #716b60; font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
@media (max-width: 340px) {
  .paper { padding-right: max(24px, env(safe-area-inset-right)); padding-left: max(24px, env(safe-area-inset-left)); }
}
`;

// Reads one project's state through the installed pd CLI and projects it for the spike screens.
// The CLI uses whatever connection the checkout selects (cloud pd1 or a local store). This module runs read commands only.
// It derives no liveness, no host, and no reason that pd does not record.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';

const commandTimeoutMs = 20_000;
const snapshotLifetimeMs = 45_000;
const parallelReads = 6;
const tipComment = /^tip: ([0-9a-f]{40})$/;

export class PdUnavailable extends Error {}

function runPd(args) {
  return new Promise((resolve, reject) => {
    execFile('pd', args, { timeout: commandTimeoutMs, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        reject(new PdUnavailable(`pd ${args[0]} failed: ${error.message.split('\n')[0]}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new PdUnavailable(`pd ${args[0]} returned no JSON`));
      }
    });
  });
}

async function readAllPages(args, key) {
  const items = [];
  let after = null;
  do {
    const page = await runPd([...args, '--limit', '100', ...(after ? ['--after', after] : [])]);
    items.push(...page[key]);
    after = page.next_cursor ?? null;
  } while (after);
  return items;
}

async function mapWithLimit(items, read) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallelReads, items.length) }, worker));
  return results;
}

export function titleOf(body) {
  const line = body.split('\n').find((text) => text.trim()) ?? '';
  return line.replace(/^#+\s*/, '').trim();
}

function secondsOf(isoTime) {
  return Math.floor(Date.parse(isoTime) / 1000);
}

function newestTip(comments) {
  for (const comment of [...comments].reverse()) {
    const match = tipComment.exec(comment.body.trim());
    if (match) return match[1];
  }
  return null;
}

async function readProjectState(project) {
  const scope = ['--project', project];
  const [blocked, ready, inProgress, claims] = await Promise.all([
    readAllPages(['blocked', ...scope], 'issues'),
    readAllPages(['ready', ...scope], 'issues'),
    readAllPages(['list', ...scope, '--status', 'in_progress'], 'issues'),
    readAllPages(['claim', 'list', ...scope], 'claims'),
  ]);
  const [blockers, tips] = await Promise.all([
    mapWithLimit(blocked, async (issue) => (await runPd(['dependency', 'list', issue.id])).blockers),
    mapWithLimit(inProgress, async (issue) => newestTip((await runPd(['show', issue.id])).comments)),
  ]);
  return {
    project,
    observedAt: Math.floor(Date.now() / 1000),
    blocked: blocked.map((issue, index) => ({ ...issue, blockers: blockers[index] })),
    ready,
    inProgress: inProgress.map((issue, index) => ({ ...issue, tip: tips[index] })),
    activeClaims: claims.filter((claim) => claim.state === 'active').map((claim) => claim.lease),
  };
}

function observationToken(rows) {
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 32);
}

// The row and envelope fields follow the locked attention Sorter contract. Ranking uses its deterministic age fallback.
export function attentionProjection(state) {
  const holders = new Map(state.activeClaims.map((lease) => [lease.issue_id, lease.agent_label]));
  const rows = state.blocked.map((issue) => {
    const waitingOn = issue.blockers.filter((blocker) => blocker.status !== 'closed').map((blocker) => blocker.id);
    const row = {
      id: `dependency_stuck:${issue.id}`,
      issue_id: issue.id,
      reason_code: 'dependency_stuck',
      summary: `${titleOf(issue.body)} is waiting on ${waitingOn.join(', ') || 'a prerequisite'}.`,
      attention_since: secondsOf(issue.updated_at),
    };
    const actor = holders.get(issue.id);
    return actor ? { ...row, actor } : row;
  });
  rows.sort((left, right) => left.attention_since - right.attention_since || left.id.localeCompare(right.id));
  return { project: state.project, set_revision: observationToken(rows), rows };
}

export function projectTasks(state) {
  const holders = new Map(state.activeClaims.map((lease) => [lease.issue_id, lease.agent_label]));
  const pointer = (issue) => ({ issue_id: issue.id, title: titleOf(issue.body) });
  return {
    project: state.project,
    ready: state.ready.map(pointer),
    in_progress: state.inProgress.map((issue) => ({ ...pointer(issue), holder: holders.get(issue.id) ?? null })),
    tips: state.inProgress.filter((issue) => issue.tip).map((issue) => ({ ...pointer(issue), tip: issue.tip })),
  };
}

export function agentClaims(state) {
  const issues = new Map([...state.inProgress, ...state.ready, ...state.blocked].map((issue) => [issue.id, issue]));
  return {
    project: state.project,
    observed_at: state.observedAt,
    claims: state.activeClaims.map((lease) => {
      const issue = issues.get(lease.issue_id);
      return {
        agent_label: lease.agent_label,
        issue_id: lease.issue_id,
        title: issue ? titleOf(issue.body) : null,
        tip: issue?.tip ?? null,
        host: lease.host ?? null,
        acquired_at: lease.acquired_at,
        expires_at: lease.expires_at,
      };
    }),
  };
}

// A stale snapshot is served while one refresh runs, because a cold read spawns dozens of slow CLI calls.
export function createProjectReader(project) {
  let snapshot = null;
  let pending = null;
  const refresh = () => {
    pending ??= readProjectState(project)
      .then((state) => {
        snapshot = { state, readAt: Date.now() };
        return state;
      })
      .finally(() => {
        pending = null;
      });
    return pending;
  };
  return async function readState() {
    if (!snapshot) return refresh();
    if (Date.now() - snapshot.readAt >= snapshotLifetimeMs) refresh().catch(() => {});
    return snapshot.state;
  };
}

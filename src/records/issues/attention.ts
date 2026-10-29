/**
 * The Attention rule and the one read that applies it.
 * An issue needs someone when its status is in `attentionRule.statuses` and it carries a label in `attentionRule.labels` or has an open ask.
 * An open ask waits on the owner the way an owner label does, without a label.
 * /ui home and /ui/inbox read Attention only through `attentionIssues`, and the pd-17 and pd-139.3 views should too.
 *
 *   const attention = await attentionIssues(db);
 *   attention.issues          // every Attention issue, last updated first (the Inbox)
 *   attention.waitingOnOwner  // open owner issues: one group per owner label, priority then longest waiting (home)
 *   attention.waitingForMain  // open main-wait issues, last updated first (home)
 *   attention.more            // true when the read stopped at 100 issues; counts are then lower bounds
 */
import { PolylinedbError } from '../store/errors.ts';
import { issueSortKey } from '../store/issue-id.ts';
import { issueQueries } from '../store/issue-queries.ts';
import { issueRow } from '../store/issue-record.ts';
import type { Issue, Status } from '../store/issue-record.ts';
import type { SqlExecutor } from '../store/sql.ts';
import { ownerWaitLabels, statuses } from '../../transition/index.ts';

/** Label order matters: owner groups follow `ownerWaitLabels`, and an issue with two owner labels belongs to the first. */
const attentionRule = {
  statuses: statuses.filter((status): status is Exclude<Status, 'closed'> => status !== 'closed'),
  labels: [
    ...ownerWaitLabels.map(label => ({ label, waitsOn: 'owner' as const })),
    // `main-wait` keeps an issue open while its merge sits in a local land queue that the remote trunk does not yet contain.
    { label: 'main-wait' as const, waitsOn: 'main' as const },
  ],
} as const;

export type AttentionLabel = typeof attentionRule.labels[number]['label'];
export type OwnerLabel = Extract<typeof attentionRule.labels[number], { waitsOn: 'owner' }>['label'];
/** Home lists these. A deferred or in-progress issue cannot be placed in an owner group without changing this type. */
export type OpenIssue = Issue & { readonly status: 'open' };

export type AttentionIssue = {
  readonly issue: Issue;
  /** Empty only when the issue is here for its open asks alone. */
  readonly labels: readonly AttentionLabel[];
  /** Open asks on the issue. */
  readonly openAsks: number;
  /** Whole seconds since `issue.created_at` by the store clock, never negative. Null when the store cannot parse `created_at`. */
  readonly waitingSeconds: number | null;
};

/** Open issues whose first owner label is `label`: higher priority first, then the longest waiting, then id. */
export type OwnerGroup = { readonly label: OwnerLabel; readonly issues: readonly OpenIssue[] };

export type OwnerQueue = {
  /** One group per owner label, in rule order, empty groups included. Each open owner issue is in exactly one group. */
  readonly groups: readonly OwnerGroup[];
  /** Owner issues whose status is not open (deferred or in_progress). They are Attention issues; home counts them but does not list them. */
  readonly notOpen: number;
};

export type Attention = {
  /** Every Attention issue read, last updated first, at most 100. */
  readonly issues: readonly AttentionIssue[];
  /** True when more Attention issues exist than were read. Counts derived from this value are then lower bounds. */
  readonly more: boolean;
  readonly waitingOnOwner: OwnerQueue;
  /** Open issues that carry a main rule label, last updated first. Plain issues, because the home `section()` renders them unchanged. */
  readonly waitingForMain: readonly Issue[];
};

const attentionLimit = 101;
const shownAttention = 100;
/** Home lists open issues only; deferred and in_progress Attention issues stay on the Inbox. */
const listedStatus: Status = 'open';

export async function attentionIssues(db: SqlExecutor): Promise<Attention> {
  const rows = await db.reads.all(issueQueries.attention, {
    statuses: attentionRule.statuses,
    labels: attentionRule.labels.map(entry => entry.label),
    limit: attentionLimit,
  });
  const issues = rows.slice(0, shownAttention).map(attentionRow);
  return {
    issues,
    more: rows.length > shownAttention,
    waitingOnOwner: ownerQueue(issues),
    waitingForMain: mainQueue(issues),
  };
}

/** The read boundary. Everything after it trusts the types. */
function attentionRow(row: Record<string, unknown>): AttentionIssue {
  const issue = issueRow(row);
  const labels = attentionRule.labels.map(entry => entry.label).filter(label => issue.labels.includes(label));
  const openAsks = row.open_asks;
  if (typeof openAsks !== 'number' || !Number.isSafeInteger(openAsks) || openAsks < 0) throw new PolylinedbError('invalid_store', 'Stored open ask count is invalid', 500);
  if (labels.length === 0 && openAsks === 0) throw new PolylinedbError('invalid_store', 'Stored attention issue has no attention label and no open ask', 500);
  const age = row.age_seconds;
  if (age !== null && (typeof age !== 'number' || !Number.isSafeInteger(age))) {
    throw new PolylinedbError('invalid_store', 'Stored issue age is invalid', 500);
  }
  // A created_at slightly ahead of the store clock is zero, not a negative wait.
  return { issue, labels, openAsks, waitingSeconds: age === null ? null : Math.max(0, age) };
}

function waitsOn(label: AttentionLabel): 'owner' | 'main' {
  const entry = attentionRule.labels.find(candidate => candidate.label === label);
  if (entry === undefined) throw new PolylinedbError('invalid_store', 'Stored attention label is not in the rule', 500);
  return entry.waitsOn;
}

function isOwnerLabel(label: AttentionLabel): label is OwnerLabel {
  return waitsOn(label) === 'owner';
}

function openIssue(issue: Issue): OpenIssue {
  if (issue.status !== 'open') throw new PolylinedbError('invalid_store', 'Stored attention issue is not open', 500);
  return issue as OpenIssue;
}

function ownerQueue(issues: readonly AttentionIssue[]): OwnerQueue {
  const ownerOf = (row: AttentionIssue) => row.labels.find(isOwnerLabel);
  const groups = attentionRule.labels.map(entry => entry.label).filter(isOwnerLabel).map(label => ({
    label,
    issues: issues.filter(row => row.issue.status === listedStatus && ownerOf(row) === label).sort(ownerOrder).map(row => openIssue(row.issue)),
  }));
  const notOpen = issues.filter(row => row.issue.status !== listedStatus && ownerOf(row) !== undefined).length;
  return { groups, notOpen };
}

function mainQueue(issues: readonly AttentionIssue[]): Issue[] {
  return issues.filter(row => row.issue.status === listedStatus && row.labels.some(label => waitsOn(label) === 'main')).map(row => row.issue);
}

/** Higher priority (lower number) first, then the longest waiting with unknown ages last, then id sort key. */
function ownerOrder(a: AttentionIssue, b: AttentionIssue): number {
  const left = issueSortKey(a.issue.id);
  const right = issueSortKey(b.issue.id);
  return a.issue.priority - b.issue.priority
    || (b.waitingSeconds ?? -1) - (a.waitingSeconds ?? -1)
    || (left < right ? -1 : left > right ? 1 : 0);
}

// Formats issue reads for display; it does not select modes or access storage.
import type { Comment, Field, Issue, Item, LandOrder, MemoryFreshness, OperationResult } from './records/index.ts';

type IssueDetails = Extract<OperationResult, { issue: Issue; comments: Comment[] }>;
type IssuePage = Extract<OperationResult, { issues: Issue[]; next_cursor: string | null }>;
type HumanIssueRead =
  | { command: 'show'; result: IssueDetails }
  | { command: 'list' | 'search'; result: IssuePage };
type TerminalContext = {
  stdoutIsTTY: boolean;
  env: Readonly<Record<string, string | undefined>>;
};

const VERSION_FIELDS: readonly Field[] = ['tool', 'project', 'body', 'status', 'type', 'priority', 'labels'];
const BODY_PREVIEW_CODE_POINTS = 40;

function colorAllowed(terminal: TerminalContext): boolean {
  return terminal.stdoutIsTTY
    && !Object.hasOwn(terminal.env, 'NO_COLOR')
    && terminal.env.TERM !== 'dumb';
}

function heading(value: string, color: boolean): string {
  if (!color) return value;
  return '\u001B[1;36m' + value + '\u001B[0m';
}

function visibleText(value: string, preserveLineFeeds: boolean): string {
  let output = '';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (preserveLineFeeds && codePoint === 0x0a) {
      output += '\n';
    } else if (
      codePoint <= 0x1f
      || (codePoint >= 0x7f && codePoint <= 0x9f)
      || codePoint === 0x2028
      || codePoint === 0x2029
    ) {
      output += '\\u' + codePoint.toString(16).toUpperCase().padStart(4, '0');
    } else {
      output += character;
    }
  }
  return output;
}

function indentedLines(value: string, indentation: number): string {
  const prefix = ' '.repeat(indentation);
  return visibleText(value, true)
    .split('\n')
    .map(line => prefix + line)
    .join('\n');
}

function bodyPreview(value: string): string {
  let prefix = '';
  let scanned = 0;
  let truncated = false;
  for (const character of value) {
    if (scanned === BODY_PREVIEW_CODE_POINTS) {
      truncated = true;
      break;
    }
    scanned += 1;
    prefix += character === '\n' ? ' ' : character;
  }
  return visibleText(prefix, false) + (truncated ? '…' : '');
}

function memoryFreshnessLines(freshness: MemoryFreshness | undefined): string[] {
  if (freshness === undefined) return [];
  const project = visibleText(freshness.project, false);
  switch (freshness.status) {
    case 'current':
      return [`Memory freshness: current · project ${project}`];
    case 'stale':
      return [
        `Memory freshness: stale · project ${project} · ${freshness.reason.replaceAll('_', ' ')}`,
        'Retrieve project memory before acting.',
      ];
    case 'unavailable':
      return [
        `Memory freshness: unavailable · project ${project}`,
        'Retrieve project memory before acting.',
      ];
    default: {
      const unreachable: never = freshness;
      return unreachable;
    }
  }
}

function landsAfter(order: LandOrder): string {
  return 'Lands after: ' + (order.after.length === 0 ? '(none)'
    : order.after.map(entry => visibleText(entry.id, false) + ' (' + visibleText(entry.status, false) + ')').join(', '));
}

function issueMemoryFreshness(result: IssueDetails | IssuePage): MemoryFreshness | undefined {
  if ('memory_freshness' in result && result.memory_freshness !== undefined) return result.memory_freshness;
  return undefined;
}

function renderIssuePage(title: string, result: IssuePage, color: boolean): string {
  const lines = [heading(title, color), ...memoryFreshnessLines(issueMemoryFreshness(result))];
  if (result.issues.length === 0) {
    lines.push(title === 'Issues' ? 'No issues found.' : 'No search matches found.');
  }
  let issueCount = 0;
  for (const issue of result.issues) {
    if (issueCount > 0) lines.push('');
    issueCount += 1;
    lines.push(
      visibleText(issue.id, false)
      + '  ' + visibleText(issue.status, false)
      + '  P' + issue.priority
      + '  ' + visibleText(issue.type, false),
    );
    lines.push(
      '  Project: ' + visibleText(issue.project, false)
      + ' · Tool: ' + visibleText(issue.tool, false),
    );
    const preview = bodyPreview(issue.body);
    lines.push('  Body: ' + (preview === '' ? '(empty)' : preview));
    const order = 'land_order' in result && Array.isArray(result.land_order) ? result.land_order[issueCount - 1] : undefined;
    if (order !== undefined && order.after.length > 0) lines.push('  ' + landsAfter(order));
    for (const match of 'matches' in result ? result.matches.filter(match => match.issue_id === issue.id) : []) {
      const place = match.location === 'body' ? 'body' : 'comment ' + visibleText(match.comment_id, false);
      lines.push('  Matched in ' + place + ': ' + visibleText(match.excerpt, false));
    }
  }
  if (result.next_cursor !== null) {
    lines.push('', 'More results. Use this value with --after.', '  ' + visibleText(result.next_cursor, false));
  } else if (result.issues.length > 0) {
    lines.push('', 'End of results.');
  }
  return lines.join('\n');
}

// An issue with no asks or checks prints no section, so the details read as before.
function itemLines(items: readonly Item[], color: boolean): string[] {
  if (items.length === 0) return [];
  return [heading('Asks and checks', color) + ' (' + items.filter(item => item.state === 'open').length + ' open)', ...items.flatMap(item => [
    '  ' + item.kind + ' ' + item.n + ' · ' + item.state + ' · by ' + visibleText(item.created_by, false)
      + (item.resolved_by === null ? '' : ' · ' + item.state + ' by ' + visibleText(item.resolved_by, false)),
    indentedLines(item.text, 4),
    ...(item.options === null ? [] : ['    options: ' + item.options.map(option => visibleText(option, false) + (option === item.recommended ? ' (recommended)' : '')).join(', ')]),
    ...(item.answer === null ? [] : ['    answer: ' + visibleText(item.answer, false)]),
    ...(item.note === null ? [] : [indentedLines('note: ' + item.note, 4)]),
  ])];
}

function renderIssueDetails(result: IssueDetails, color: boolean): string {
  const issue = result.issue;
  const lines = [
    heading('Issue details', color),
    ...memoryFreshnessLines(issueMemoryFreshness(result)),
    'ID ' + visibleText(issue.id, false),
    'Status ' + visibleText(issue.status, false)
      + (issue.status === 'in_progress' && issue.type !== 'epic' && result.claim.state !== 'active' ? ' (no active claim)' : ''),
    'Priority P' + issue.priority,
    'Type ' + visibleText(issue.type, false),
    'Tool ' + visibleText(issue.tool, false),
    'Project ' + visibleText(issue.project, false),
    'Labels ' + (issue.labels.length === 0
      ? '(none)'
      : issue.labels.map(label => visibleText(label, false)).join(', ')),
    'Versions ' + VERSION_FIELDS.map(field => field + '=' + issue.versions[field]).join(' '),
    'Claim ' + result.claim.state + ' · store incarnation ' + result.claim.store_incarnation,
    ...(typeof result.discovered_from === 'string' ? ['Found while working on ' + visibleText(result.discovered_from, false)] : []),
    ...(result.discovered !== undefined && result.discovered.length > 0 ? ['Found here ' + result.discovered.map(id => visibleText(id, false)).join(', ')] : []),
    ...('land_order' in result && result.land_order !== undefined && !Array.isArray(result.land_order) ? [landsAfter(result.land_order)] : []),
    'Created ' + visibleText(issue.created_at, false) + ' by ' + visibleText(issue.created_by, false),
    'Updated ' + visibleText(issue.updated_at, false) + ' by ' + visibleText(issue.updated_by, false),
    ...(typeof issue.closed_at === 'string' && typeof issue.closed_by === 'string'
      ? ['Closed ' + visibleText(issue.closed_at, false) + ' by ' + visibleText(issue.closed_by, false)] : []),
    heading('Body', color),
    indentedLines(issue.body, 2),
    ...itemLines(result.items ?? [], color),
    heading('Comments', color) + ' (' + result.comments.length + ')',
  ];
  for (const comment of result.comments) {
    lines.push(
      '  ' + visibleText(comment.id, false)
      + ' · ' + visibleText(comment.issue_id, false)
      + ' · ' + visibleText(comment.created_at, false)
      + ' · ' + visibleText(comment.created_by, false)
      + (comment.version === undefined ? '' : ' · version ' + comment.version)
      + (typeof comment.updated_at === 'string' && typeof comment.updated_by === 'string'
        ? ' · edited ' + visibleText(comment.updated_at, false) + ' by ' + visibleText(comment.updated_by, false) : '')
      + (typeof comment.handle === 'string' ? ' · as ' + visibleText(comment.handle, false) : '')
      + (typeof comment.via === 'string' ? ' · via ' + visibleText(comment.via, false) : '')
      + (typeof comment.reply_to === 'string' ? ' · reply to ' + visibleText(comment.reply_to, false) : '')
      + (comment.stars === undefined || comment.stars === 0 ? '' : ' · ' + comment.stars + (comment.stars === 1 ? ' star' : ' stars')),
    );
    lines.push(indentedLines(comment.body, 4));
  }
  return lines.join('\n');
}

// The CLI adds the line terminator so this formatter stays independent of output streams.
export function renderHumanIssueRead(input: HumanIssueRead, terminal: TerminalContext): string {
  const color = colorAllowed(terminal);
  switch (input.command) {
    case 'show':
      return renderIssueDetails(input.result, color);
    case 'list':
      return renderIssuePage('Issues', input.result, color);
    case 'search':
      return renderIssuePage('Search matches', input.result, color);
    default: {
      const unreachable: never = input;
      return unreachable;
    }
  }
}

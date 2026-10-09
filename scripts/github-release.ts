// Creates the annotated tag and GitHub Release after registry verification.
// Callers inject the GitHub client so tests never create a tag or a release.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

export class ReleaseRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReleaseRefused';
  }
}

const versionPattern = /^\d+\.\d+\.\d+$/;
const commitPattern = /^[0-9a-f]{40}$/;
function refuse(message: string): never {
  throw new ReleaseRefused(message);
}

export type TagRef = { ref: string; object: { type: string; sha: string } };
export type AnnotatedTag = { tag: string; object: { type: string; sha: string } };
export type ReleaseRecord = {
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
};
export type ReleaseClient = {
  matchingRefs(tag: string): Promise<TagRef[]>;
  annotatedTag(sha: string): Promise<AnnotatedTag>;
  createAnnotatedTag(input: { tag: string; message: string; commit: string }): Promise<{ sha: string }>;
  createRef(input: { ref: string; sha: string }): Promise<void>;
  releaseByTag(tag: string): Promise<ReleaseRecord | null>;
  createRelease(input: { tag: string; title: string; notes: string }): Promise<void>;
};
export type ReleaseOutcome = { tag: 'created' | 'verified'; release: 'created' | 'verified' };

export function tagMessage(version: string): string {
  return `polylinedb ${version}\n`;
}

export function releaseTitle(version: string): string {
  return `polylinedb ${version}`;
}

export function annotatedTagRequest(input: { tag: string; message: string; commit: string }, date: string) {
  return {
    tag: input.tag,
    message: input.message,
    object: input.commit,
    type: 'commit' as const,
    tagger: {
      name: 'github-actions[bot]',
      email: '41898282+github-actions[bot]@users.noreply.github.com',
      date,
    },
  };
}

export function releaseRequest(input: { tag: string; title: string; notes: string }) {
  return {
    tag_name: input.tag,
    name: input.title,
    body: input.notes,
    draft: false,
    prerelease: false,
    make_latest: 'true' as const,
  };
}

function canonicalNotes(value: string): string {
  return value.replaceAll('\r\n', '\n').replace(/\n+$/, '\n');
}

export async function ensureRelease(client: ReleaseClient, input: { version: string; commit: string; notes: string }): Promise<ReleaseOutcome> {
  if (!versionPattern.test(input.version)) refuse(`Invalid version: ${input.version}`);
  if (!commitPattern.test(input.commit)) refuse('The approved commit must be a full lowercase SHA');
  if (input.notes.trim() === '') refuse('Release notes are empty');
  const tag = `v${input.version}`;
  const refName = `refs/tags/${tag}`;
  const matches = (await client.matchingRefs(tag)).filter(ref => ref.ref === refName);
  if (matches.length > 1) refuse(`Tag ${tag} matched more than one ref`);
  let tagOutcome: ReleaseOutcome['tag'];
  const existing = matches[0];
  if (existing === undefined) {
    const created = await client.createAnnotatedTag({ tag, message: tagMessage(input.version), commit: input.commit });
    if (!commitPattern.test(created.sha)) refuse('GitHub returned an unexpected tag object');
    await client.createRef({ ref: refName, sha: created.sha });
    tagOutcome = 'created';
  } else if (existing.object.type !== 'tag') {
    refuse(`Tag ${tag} is ${existing.object.type}, not an annotated tag`);
  } else {
    const annotated = await client.annotatedTag(existing.object.sha);
    if (annotated.tag !== tag) refuse(`Tag object name is ${annotated.tag}, not ${tag}`);
    if (annotated.object.type !== 'commit' || annotated.object.sha !== input.commit) {
      refuse(`Tag ${tag} points at ${annotated.object.sha}, not ${input.commit}`);
    }
    tagOutcome = 'verified';
  }

  const title = releaseTitle(input.version);
  const release = await client.releaseByTag(tag);
  if (release === null) {
    await client.createRelease({ tag, title, notes: input.notes });
    return { tag: tagOutcome, release: 'created' };
  }
  if (release.draft) refuse(`Release ${tag} is a draft`);
  if (release.prerelease) refuse(`Release ${tag} is a prerelease`);
  if (release.tag_name !== tag || release.name !== title || canonicalNotes(release.body ?? '') !== canonicalNotes(input.notes)) {
    refuse(`Release ${tag} does not match the expected title and notes`);
  }
  return { tag: tagOutcome, release: 'verified' };
}

export function interpretGh(method: string, status: number, stdout: string, stderr: string): unknown {
  if (status !== 0) {
    const detail = `${stderr}\n${stdout}`.trim();
    if (method === 'GET' && (/\b404\b/.test(detail) || detail.includes('Not Found'))) return null;
    refuse(detail.split('\n').slice(0, 8).join('\n') || `gh api ${method} failed`);
  }
  if (stdout.trim() === '') return null;
  try {
    return JSON.parse(stdout);
  } catch {
    refuse('gh returned unexpected output');
  }
}

function objectFields(value: unknown, label: string): { name: unknown; type: unknown; sha: unknown } {
  if (value === null || typeof value !== 'object') refuse(`Unexpected ${label}`);
  const record = value as { ref?: unknown; tag?: unknown; object?: unknown };
  const target = record.object;
  if (target === null || typeof target !== 'object') refuse(`Unexpected ${label}`);
  const fields = target as { type?: unknown; sha?: unknown };
  return { name: record.ref ?? record.tag, type: fields.type, sha: fields.sha };
}

export function parseTagRef(value: unknown): TagRef {
  const fields = objectFields(value, 'tag ref');
  if (typeof fields.name !== 'string' || typeof fields.type !== 'string' || typeof fields.sha !== 'string') refuse('Unexpected tag ref');
  return { ref: fields.name, object: { type: fields.type, sha: fields.sha } };
}

export function parseAnnotatedTag(value: unknown): AnnotatedTag {
  const fields = objectFields(value, 'annotated tag');
  if (typeof fields.name !== 'string' || typeof fields.type !== 'string' || typeof fields.sha !== 'string') refuse('Unexpected annotated tag');
  return { tag: fields.name, object: { type: fields.type, sha: fields.sha } };
}

export function parseReleaseRecord(value: unknown): ReleaseRecord {
  if (value === null || typeof value !== 'object') refuse('Unexpected release');
  const release = value as { tag_name?: unknown; name?: unknown; body?: unknown; draft?: unknown; prerelease?: unknown };
  const tagName = release.tag_name;
  const name = release.name;
  const body = release.body;
  const draft = release.draft;
  const prerelease = release.prerelease;
  if (typeof tagName !== 'string' || typeof draft !== 'boolean' || typeof prerelease !== 'boolean') refuse('Unexpected release');
  if (name !== null && typeof name !== 'string') refuse('Unexpected release');
  if (body !== null && typeof body !== 'string') refuse('Unexpected release');
  return {
    tag_name: tagName,
    name: typeof name === 'string' ? name : null,
    body: typeof body === 'string' ? body : null,
    draft,
    prerelease,
  };
}

function ghResult(args: string[], input?: string): { status: number; stdout: string; stderr: string } {
  const result = spawnSync('gh', args, { encoding: 'utf8', input, env: process.env, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) refuse(`gh failed to start: ${result.error.message}`);
  return { status: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
}

function ghApi(method: string, path: string, body?: unknown): unknown {
  const result = ghResult(['api', '--method', method, path], body === undefined ? undefined : JSON.stringify(body));
  return interpretGh(method, result.status, result.stdout, result.stderr);
}

function ghClient(repo: string, date: () => string): ReleaseClient {
  return {
    async matchingRefs(tag) {
      const value = ghApi('GET', `repos/${repo}/git/matching-refs/tags/${tag}`);
      if (!Array.isArray(value)) refuse('Unexpected tag ref list');
      return value.map(parseTagRef);
    },
    async annotatedTag(sha) {
      return parseAnnotatedTag(ghApi('GET', `repos/${repo}/git/tags/${sha}`));
    },
    async createAnnotatedTag(input) {
      const value = ghApi('POST', `repos/${repo}/git/tags`, annotatedTagRequest(input, date()));
      if (value === null || typeof value !== 'object' || !('sha' in value)) refuse('Unexpected tag object');
      const sha = value.sha;
      if (typeof sha !== 'string') refuse('Unexpected tag object');
      return { sha };
    },
    async createRef(input) {
      ghApi('POST', `repos/${repo}/git/refs`, input);
    },
    async releaseByTag(tag) {
      const value = ghApi('GET', `repos/${repo}/releases/tags/${tag}`);
      return value === null ? null : parseReleaseRecord(value);
    },
    async createRelease(input) {
      ghApi('POST', `repos/${repo}/releases`, releaseRequest(input));
    },
  };
}

export async function runRelease(env: NodeJS.ProcessEnv, client: ReleaseClient): Promise<ReleaseOutcome> {
  const version = env.RELEASE_VERSION ?? '';
  const commit = env.APPROVED_COMMIT ?? '';
  const notesPath = env.RELEASE_NOTES_FILE ?? '';
  if (!commitPattern.test(commit)) refuse('APPROVED_COMMIT must be a full lowercase SHA');
  if ((env.GITHUB_SHA ?? '') !== commit) refuse('GITHUB_SHA does not match the approved commit');
  if (notesPath === '') refuse('RELEASE_NOTES_FILE is missing');
  let notes = '';
  try {
    notes = readFileSync(notesPath, 'utf8');
  } catch {
    refuse('Release notes file is unreadable');
  }
  return ensureRelease(client, { version, commit, notes });
}

if (import.meta.main) {
  try {
    const repo = process.env.GITHUB_REPOSITORY ?? '';
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) refuse('GITHUB_REPOSITORY is missing');
    const outcome = await runRelease(process.env, ghClient(repo, () => new Date().toISOString()));
    process.stdout.write(`${JSON.stringify(outcome)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? `${error.name}: ${error.message}` : 'Unknown error'}\n`);
    process.exitCode = 1;
  }
}

// Builds GitHub Release notes from one CHANGELOG.md version section.
// The heading selects the section. The release title already carries the version, so the heading line stays out of the notes.
// A release body has no repository base, so relative link targets become absolute URLs at the release tag.
import { readFileSync, writeFileSync } from 'node:fs';
import { posix } from 'node:path';
import { releaseTag } from './github-release.ts';

const versionPattern = /^\d+\.\d+\.\d+$/;
const repositoryPattern = /^(?:git\+)?(https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/;
const fencePattern = /^[ \t]*(`{3,}|~{3,})(.*)$/;
const blockStartPattern = /^ {0,3}(?:[-*+]|\d{1,9}[.)])(?:[ \t]|$)|^ {0,3}#{1,6}(?:[ \t]|$)|^ {0,3}>/;
const definitionPattern = /^([ \t]*\[(?:[^\]\\]|\\.)+\]:[ \t]*)(<[^<>\n]*>|\S+)(.*)$/;
const schemePattern = /^[A-Za-z][A-Za-z0-9+.-]*:/;

export function repositoryUrl(manifest: unknown): string {
  const repository = manifest !== null && typeof manifest === 'object' && 'repository' in manifest ? manifest.repository : undefined;
  const url = repository !== null && typeof repository === 'object' && 'url' in repository ? repository.url : repository;
  const match = typeof url === 'string' ? repositoryPattern.exec(url) : null;
  if (!match?.[1]) throw new Error('package.json repository.url must name a GitHub repository');
  return match[1];
}

function absoluteTarget(destination: string, image: boolean, repository: string, tag: string): string {
  const bracketed = destination.startsWith('<');
  const value = bracketed ? destination.slice(1, -1) : destination;
  if (value === '' || value.startsWith('#') || value.startsWith('?') || value.startsWith('//') || schemePattern.test(value)) return destination;
  const split = value.search(/[?#]/);
  const path = split === -1 ? value : value.slice(0, split);
  const suffix = split === -1 ? '' : value.slice(split);
  const resolved = posix.normalize(path.replace(/^\/+/, ''));
  if (resolved === '..' || resolved.startsWith('../')) throw new Error(`CHANGELOG.md link leaves the repository: ${value}`);
  const relative = resolved === '.' || resolved === './' ? '' : resolved;
  const kind = relative === '' || relative.endsWith('/') ? 'tree' : image ? 'raw' : 'blob';
  const url = `${repository}/${kind}/${tag}${relative === '' ? '' : `/${relative}`}${suffix}`;
  return bracketed ? `<${url}>` : url;
}

function destinationAt(text: string, start: number): { leading: string; destination: string; end: number } | null {
  let index = start;
  while (text[index] === ' ' || text[index] === '\t' || text[index] === '\n') index += 1;
  const leading = text.slice(start, index);
  if (text[index] === '<') {
    const close = text.slice(index + 1).search(/[<>\n]/);
    if (close === -1 || text[index + 1 + close] !== '>') return null;
    const end = index + close + 2;
    return { leading, destination: text.slice(index, end), end };
  }
  const begin = index;
  let depth = 0;
  while (index < text.length) {
    const char = text[index] ?? '';
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (/\s/.test(char)) break;
    if (char === '(') depth += 1;
    if (char === ')') {
      if (depth === 0) break;
      depth -= 1;
    }
    index += 1;
  }
  return { leading, destination: text.slice(begin, index), end: index };
}

function closingRun(text: string, start: number, length: number): number {
  const runs = /`+/g;
  runs.lastIndex = start;
  for (let run = runs.exec(text); run !== null; run = runs.exec(text)) {
    if (run[0].length === length) return run.index;
  }
  return -1;
}

function inlineLinks(text: string, target: (destination: string, image: boolean) => string): string {
  let result = '';
  const openers: boolean[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      result += text.slice(index, index + 2);
      index += 2;
    } else if (char === '`') {
      const length = /^`+/.exec(text.slice(index))?.[0].length ?? 1;
      const close = closingRun(text, index + length, length);
      const end = close === -1 ? index + length : close + length;
      result += text.slice(index, end);
      index = end;
    } else if (char === '!' && text[index + 1] === '[') {
      openers.push(true);
      result += '![';
      index += 2;
    } else if (char === '[') {
      openers.push(false);
      result += '[';
      index += 1;
    } else if (char === ']' && openers.length > 0 && text[index + 1] === '(') {
      const image = openers.pop() ?? false;
      const parsed = destinationAt(text, index + 2);
      if (parsed === null) {
        result += ']';
        index += 1;
      } else {
        result += `](${parsed.leading}${target(parsed.destination, image)}`;
        index = parsed.end;
      }
    } else {
      if (char === ']') openers.pop();
      result += char;
      index += 1;
    }
  }
  return result;
}

// Fenced code, inline code spans, and backslash escapes keep their text. Indented code blocks and raw HTML are not recognized.
export function absoluteLinks(markdown: string, repository: string, tag: string): string {
  const target = (destination: string, image: boolean) => absoluteTarget(destination, image, repository, tag);
  const output: string[] = [];
  let paragraph: string[] = [];
  const flush = () => {
    if (paragraph.length > 0) output.push(inlineLinks(paragraph.join('\n'), target));
    paragraph = [];
  };
  let fence = '';
  for (const line of markdown.split('\n')) {
    if (fence !== '') {
      output.push(line);
      const closer = fencePattern.exec(line);
      if (closer?.[1]?.[0] === fence[0] && closer[1].length >= fence.length && closer[2]?.trim() === '') fence = '';
      continue;
    }
    const opener = fencePattern.exec(line);
    if (opener?.[1] !== undefined && !(opener[1].startsWith('`') && opener[2]?.includes('`'))) {
      flush();
      output.push(line);
      fence = opener[1];
      continue;
    }
    if (line.trim() === '') {
      flush();
      output.push(line);
      continue;
    }
    const definition = definitionPattern.exec(line);
    if (definition !== null) {
      flush();
      output.push(`${definition[1]}${target(definition[2] ?? '', false)}${definition[3]}`);
      continue;
    }
    if (blockStartPattern.test(line)) flush();
    paragraph.push(line);
  }
  flush();
  return output.join('\n');
}

export function releaseNotes(changelog: string, version: string, repository: string): string {
  if (!versionPattern.test(version)) throw new Error(`Invalid version: ${version}`);
  const lines = changelog.replaceAll('\r\n', '\n').replaceAll('\r', '\n').split('\n');
  const heading = new RegExp(`^## ${version.replaceAll('.', '\\.')}(?: \\(\\d{4}-\\d{2}-\\d{2}\\))?$`);
  const starts = lines.flatMap((line, index) => heading.test(line) ? [index] : []);
  if (starts.length === 0) throw new Error(`CHANGELOG.md has no section for ${version}`);
  if (starts.length > 1) throw new Error(`CHANGELOG.md has more than one section for ${version}`);
  const start = starts[0] ?? 0;
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith('## ')) {
      end = index;
      break;
    }
  }
  const section = lines.slice(start + 1, end).join('\n');
  if (section.trim() === '') throw new Error(`CHANGELOG.md section for ${version} is empty`);
  const notes = absoluteLinks(section, repository, releaseTag(version));
  return `${notes}\n\n## Install\n\n\`\`\`sh\nnpm install -g polylinedb@${version}\npd --help\n\`\`\`\n`;
}

if (import.meta.main) {
  try {
    const version = process.env.RELEASE_VERSION ?? '';
    const path = process.env.CHANGELOG_PATH ?? 'CHANGELOG.md';
    const repository = repositoryUrl(JSON.parse(readFileSync('package.json', 'utf8')));
    const notes = releaseNotes(readFileSync(path, 'utf8'), version, repository);
    const output = process.env.RELEASE_NOTES_OUT;
    if (output) writeFileSync(output, notes);
    process.stdout.write(notes);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  }
}

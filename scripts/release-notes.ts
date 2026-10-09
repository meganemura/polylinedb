// Builds GitHub Release notes from one CHANGELOG.md version section.
// The heading selects the section. The release title already carries the version, so the heading line stays out of the notes.
import { readFileSync, writeFileSync } from 'node:fs';

const versionPattern = /^\d+\.\d+\.\d+$/;

export function releaseNotes(changelog: string, version: string): string {
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
  return `${section}\n\n## Install\n\n\`\`\`sh\nnpm install -g polylinedb@${version}\npd --help\n\`\`\`\n`;
}

if (import.meta.main) {
  try {
    const version = process.env.RELEASE_VERSION ?? '';
    const path = process.env.CHANGELOG_PATH ?? 'CHANGELOG.md';
    const notes = releaseNotes(readFileSync(path, 'utf8'), version);
    const output = process.env.RELEASE_NOTES_OUT;
    if (output) writeFileSync(output, notes);
    process.stdout.write(notes);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Unknown error'}\n`);
    process.exitCode = 1;
  }
}

#!/usr/bin/env node
// Admit the Node runtime before loading operational modules.
// The package manifest owns the version and engine range used by this boundary.
import { readFileSync } from 'node:fs';
import type { InternalError } from './cli-diagnostics.ts';

interface PackageMetadata {
  readonly version: string;
  readonly requiredNode: string;
}

interface NodeVersion {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: boolean;
}

type NodeRangeClause =
  | { readonly kind: 'caret'; readonly floor: NodeVersion }
  | { readonly kind: 'at_least'; readonly floor: NodeVersion };

type BootstrapError =
  | {
    readonly code: 'unsupported_runtime';
    readonly message: string;
    readonly details: {
      readonly actual_node: string;
      readonly required_node: string;
      readonly package_version: string;
    };
  }
  | InternalError;

// The package authors these messages from its own manifest, so they stay readable for release checks.
class PackageManifestError extends Error {}

const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const comparatorVersionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseVersion(value: string): NodeVersion | undefined {
  const match = versionPattern.exec(value);
  if (match === null) return undefined;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (![major, minor, patch].every(Number.isSafeInteger)) return undefined;
  return { major, minor, patch, prerelease: match[4] !== undefined };
}

function readPackageMetadata(): PackageMetadata {
  const parsed: unknown = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  if (!isRecord(parsed) || !Object.hasOwn(parsed, 'version') || !Object.hasOwn(parsed, 'engines')) {
    throw new PackageManifestError('Invalid package manifest: version and engines.node are required.');
  }
  const version = parsed.version;
  const engines = parsed.engines;
  if (typeof version !== 'string' || parseVersion(version) === undefined || !isRecord(engines)
    || !Object.hasOwn(engines, 'node') || typeof engines.node !== 'string') {
    throw new PackageManifestError('Invalid package manifest: version and engines.node must be valid strings.');
  }
  return { version, requiredNode: engines.node };
}

function parseComparatorVersion(value: string): NodeVersion {
  if (!comparatorVersionPattern.test(value)) throw new PackageManifestError(`Unsupported Node engine comparator: ${value}`);
  const version = parseVersion(value);
  if (version === undefined) throw new PackageManifestError(`Invalid Node engine version: ${value}`);
  return version;
}

function parseNodeRange(requiredNode: string): readonly NodeRangeClause[] {
  const clauses = requiredNode.split('||').map(clause => clause.trim());
  if (clauses.length === 0 || clauses.some(clause => clause.length === 0)) {
    throw new PackageManifestError('Invalid package manifest: engines.node has an empty range clause.');
  }
  return clauses.map(clause => {
    const caret = /^\^((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(clause);
    if (caret !== null) {
      const floor = parseComparatorVersion(caret[1]);
      if (floor.major === 0) throw new PackageManifestError('Unsupported Node engine range: caret clauses require a positive major version.');
      return { kind: 'caret', floor };
    }
    const atLeast = /^>=((?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))$/.exec(clause);
    if (atLeast !== null) return { kind: 'at_least', floor: parseComparatorVersion(atLeast[1]) };
    throw new PackageManifestError(`Unsupported Node engine range clause: ${clause}`);
  });
}

function compareVersions(left: NodeVersion, right: NodeVersion): number {
  if (left.major !== right.major) return left.major - right.major;
  if (left.minor !== right.minor) return left.minor - right.minor;
  return left.patch - right.patch;
}

function supportsNode(actualNode: string, clauses: readonly NodeRangeClause[]): boolean {
  const actual = parseVersion(actualNode);
  if (actual === undefined || actual.prerelease) return false;
  return clauses.some(clause => {
    const comparison = compareVersions(actual, clause.floor);
    switch (clause.kind) {
      case 'caret': return comparison >= 0 && actual.major === clause.floor.major;
      case 'at_least': return comparison >= 0;
      default: {
        const exhaustive: never = clause;
        return exhaustive;
      }
    }
  });
}

function isVersionInquiry(args: readonly string[]): boolean {
  if (args.length === 1) return args[0] === '--version';
  return args.length === 2 && args.includes('--version') && args.includes('--json');
}

function reportBootstrapError(error: BootstrapError): void {
  process.stderr.write(JSON.stringify({ error }) + '\n');
  process.exitCode = 1;
}

// The bootstrap must format its own failures even when other package files are missing,
// so it loads the diagnostic module only on this path and keeps a fixed message as a fallback.
async function reportInternalError(error: unknown): Promise<void> {
  if (error instanceof PackageManifestError) {
    reportBootstrapError({ code: 'internal_error', message: error.message });
    return;
  }
  try {
    const { describeUnexpectedError } = await import('./cli-diagnostics.ts');
    reportBootstrapError(describeUnexpectedError(error));
  } catch {
    reportBootstrapError({ code: 'internal_error', message: 'The command failed on an unexpected error.' });
  }
}

async function runBootstrap(): Promise<void> {
  let metadata: PackageMetadata;
  let clauses: readonly NodeRangeClause[];
  try {
    metadata = readPackageMetadata();
    clauses = parseNodeRange(metadata.requiredNode);
  } catch (error: unknown) {
    await reportInternalError(error);
    return;
  }

  const actualNode = process.versions.node;
  if (!supportsNode(actualNode, clauses)) {
    reportBootstrapError({
      code: 'unsupported_runtime',
      message: `Unsupported Node runtime ${actualNode}; required range is ${metadata.requiredNode}.`,
      details: {
        actual_node: actualNode,
        required_node: metadata.requiredNode,
        package_version: metadata.version,
      },
    });
    return;
  }

  const args = process.argv.slice(2);
  if (isVersionInquiry(args)) {
    process.stdout.write(JSON.stringify({ version: metadata.version, node: actualNode }) + '\n');
    return;
  }

  try {
    const { runCli } = await import('./cli-commands.ts');
    await runCli(args);
  } catch (error: unknown) {
    await reportInternalError(error);
  }
}

void runBootstrap();

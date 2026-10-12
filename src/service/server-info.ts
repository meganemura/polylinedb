// Build provenance identifies the artifact; the connected database supplies its own schema version.
import manifest from '../../package.json' with { type: 'json' };
import type { D1DatabaseLike } from './d1.ts';

declare const __POLYLINEDB_GIT_COMMIT__: string | null;

export const packageVersion = manifest.version;
const gitCommit = typeof __POLYLINEDB_GIT_COMMIT__ === 'undefined' ? null : __POLYLINEDB_GIT_COMMIT__;

export type ServerInfo = { package_version: string; git_commit: string | null; schema_version: number };

export const serverInfoTool = {
  name: 'server_info',
  description: 'Read the running server package version, build commit, and connected database schema version. A null commit means the build provenance is unknown.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
};

export async function readServerInfo(database: D1DatabaseLike): Promise<ServerInfo> {
  const result = await database.prepare('SELECT version FROM schema_version').all();
  if (!Array.isArray(result.results) || result.results.length !== 1) throw new Error('Invalid database schema version');
  const row: unknown = result.results[0];
  if (typeof row !== 'object' || row === null || !('version' in row)) throw new Error('Invalid database schema version');
  const version = row.version;
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version <= 0) throw new Error('Invalid database schema version');
  return { package_version: packageVersion, git_commit: gitCommit, schema_version: version };
}

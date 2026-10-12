// Builds the Worker for cf; local SQLite remains a separate Node entry point.
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

export function buildCommit(cwd = fileURLToPath(new URL('.', import.meta.url))): string | null {
  try {
    const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] } satisfies ExecFileSyncOptionsWithStringEncoding;
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], options).trim();
    if (realpathSync(top) !== realpathSync(cwd)) return null;
    if (execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], options).trim() !== '') return null;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], options).trim();
    return /^[a-f0-9]{40}$/.test(head) ? head : null;
  } catch { return null; }
}

export default defineConfig({
  define: { __POLYLINEDB_GIT_COMMIT__: JSON.stringify(buildCommit()) },
  plugins: [cloudflare({
    // Only `vite dev` and `vite preview` read this option; the build output and deploys do not.
    // Without remote bindings the plugin starts no remote proxy session, so the dev server never asks for a login.
    remoteBindings: false,
    experimental: { newConfig: { cfBuildOutput: true } },
  })],
});

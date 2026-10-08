// Builds the Worker for cf; local SQLite remains a separate Node entry point.
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare({
    // Only `vite dev` and `vite preview` read this option; the build output and deploys do not.
    // Without remote bindings the plugin starts no remote proxy session, so the dev server never asks for a login.
    remoteBindings: false,
    experimental: { newConfig: { cfBuildOutput: true } },
  })],
});

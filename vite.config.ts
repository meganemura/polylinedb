// Builds the Worker for cf; local SQLite remains a separate Node entry point.
import { defineConfig } from 'vite';
import { cloudflare } from '@cloudflare/vite-plugin';

export default defineConfig({
  plugins: [cloudflare({ experimental: { newConfig: { cfBuildOutput: true } } })],
});

import type { Config } from "./archstrict.types.js";

// Checks source dependency layers; test fixtures stay outside the architectural module graph.
export default {
  schemaVersion: 1,
  surface: ["index.ts", "index.tsx", "index.mts", "index.cts"],
  exclude: [
    "archstrict.config.ts",
    "archstrict.types.ts",
    ".*/**",
    "**/.*/**",
    "test/**",
  ],
  declaredModules: [
      { name: "access.ts", glob: "src/access.ts", surface: "access.ts" },
      { name: "agent-hooks.ts", glob: "src/agent-hooks.ts", surface: "agent-hooks.ts" },
      { name: "cli.ts", glob: "src/cli.ts", surface: "cli.ts" },
      { name: "cloud-client", glob: "src/cloud-client/**", surface: "index.ts" },
      { name: "d1.ts", glob: "src/d1.ts", surface: "d1.ts" },
      { name: "worker.ts", glob: "src/worker.ts", surface: "worker.ts" },
      { name: "cloudflare.config.ts", glob: "cloudflare.config.ts", surface: "cloudflare.config.ts" },
      { name: "scripts", glob: "scripts/**" },
      { name: "vite.config.ts", glob: "vite.config.ts", surface: "vite.config.ts" },
      { name: "records", glob: "src/records/**", surface: ["index.ts", "persistence.ts"] },
      { name: "local-store", glob: "src/local-store/**", surface: "index.ts" },
      { name: "workspace", glob: "src/workspace/**", surface: "index.ts" },
    ],
  classify: [
      { glob: "src/access.ts", tags: ["layer:adapter", "env:worker"] },
      { glob: "src/agent-hooks.ts", tags: ["layer:adapter", "env:node"] },
      { glob: "src/cli.ts", tags: ["layer:entrypoint", "env:node"] },
      { glob: "src/cloud-client/**", tags: ["layer:adapter", "env:node"] },
      { glob: "cloudflare.config.ts", tags: ["layer:entrypoint"] },
      { glob: "src/d1.ts", tags: ["layer:adapter", "env:worker"] },
      { glob: "scripts/**", tags: ["layer:entrypoint"] },
      { glob: "vite.config.ts", tags: ["layer:entrypoint"] },
      { glob: "src/worker.ts", tags: ["layer:entrypoint", "env:worker"] },
      { glob: "src/records/**", tags: ["layer:domain", "env:portable"] },
      { glob: "src/local-store/**", tags: ["layer:adapter", "env:node"] },
      { glob: "src/workspace/**", tags: ["layer:adapter", "env:node"] },
    ],
  edges: {
    allowDeny: [
      { source: "env:node", targetNamespace: "env", deny: ["worker"], because: "The CLI client must not depend on the Worker service." },
      { source: "env:worker", targetNamespace: "env", deny: ["node"], because: "The Worker must not load local configuration or credentials." },
      { source: "env:portable", targetNamespace: "pkg", deny: ["node"], because: "Record behavior must stay portable across storage runtimes." },
      { source: "env:worker", targetNamespace: "pkg", deny: ["node"], because: "Worker code must not load Node builtins." },
    ],
    order: [
      {
        tagNamespace: "layer",
        sequence: { "": ["domain", "adapter", "entrypoint"] },
        direction: "downward-only",
        because: "Domain behavior stays independent of storage, credentials, and transport; adapters implement domain ports; command and Worker entrypoints consume both.",
      },
    ],
  },
  because: "The dependency order keeps issue and memory behavior independent from storage, credentials, and transport.",
} satisfies Config;

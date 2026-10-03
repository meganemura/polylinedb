# Dependencies

The CLI and Worker use solarsql for generated SQL reads.
The CLI also uses Node built-ins; the Worker uses Web APIs and the D1 binding.
The following packages support execution, development, and verification.
Direct dependencies use exact versions, and `package-lock.json` fixes the resolved dependency tree.

| Package | Version | Purpose | Published |
| --- | --- | --- | --- |
| `solarsql` | `0.7.0` | Analyze existing SQL and execute generated reads on SQLite and D1 | 2026-10-03 |
| `@cloudflare/vite-plugin` | `1.60.2` | Build the Worker with `cf`; provide the local workerd and D1 runtime | 2026-09-25 |
| `vite` | `8.3.1` | Run the Cloudflare build plugin | 2026-09-24 |
| `typescript` | `7.0.2` | Check source and test types; emit JavaScript for the npm CLI | 2026-07-08 |
| `@types/node` | `24.19.0` | Describe Node APIs used by the CLI and tests | 2026-09-25 |
| `undici` override | `7.30.0` | Replace the vulnerable HTTP dependency selected by the development runtime | 2026-09-25 |

The version dates were checked through the npm registry on October 3, 2026.
The development dependency versions had been available for at least seven days.
The owner explicitly requested solarsql 0.7.0 on its release date.
It has no runtime package dependencies and requires Node `^24.20.0 || >=26.7.0`.
The initial dependency tree selected `undici` 7.29.0.
Its advisories include [TLS certificate validation bypass](https://github.com/advisories/GHSA-w293-vg96-wgc3) and [WebSocket denial of service](https://github.com/advisories/GHSA-rfgv-xxqx-mfg5).
The override selects 7.30.0, and the subsequent npm audit reported zero known vulnerabilities.
That report is dated evidence, not a guarantee about future advisories.

Install with `npm ci --ignore-scripts`, then run the checks in the README.
Review registry release dates and current advisories before changing versions.
Run both workerd integration checks after changing the Cloudflare plugin or its HTTP dependency.

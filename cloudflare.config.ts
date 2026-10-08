// Configures the Worker and D1 binding. Access policy and OAuth grants are managed separately.

// A deploy removes Worker vars that the config omits, so a missing Access setting must stop the build here.
// The opt-in values keep the Worker fail-closed (503); they exist only for local builds and tests.
const buildWithoutAccess = process.env.POLYLINEDB_BUILD_WITHOUT_ACCESS === '1';

function required(name: string, unconfigured: string, rejected: readonly string[] = []): string {
  if (buildWithoutAccess) return unconfigured;
  const value = process.env[name];
  // Never put the value in the message: the build log can reach CI output.
  if (value === undefined || value.trim() === '' || rejected.includes(value.replace(/\s/g, ''))) {
    throw new Error(`${name} is missing or empty. Set it before building the Worker. `
      + 'Set POLYLINEDB_BUILD_WITHOUT_ACCESS=1 only for a local build that must refuse every request.');
  }
  return value;
}

export default {
  worker: {
    name: process.env.POLYLINEDB_WORKER_NAME ?? 'polylinedb',
    entrypoint: "./src/service/index.ts",
    compatibilityDate: '2026-09-25',
    previewUrls: false,
    observability: { enabled: true, logs: { enabled: true } },
    env: {
      DB: { type: 'd1', name: process.env.POLYLINEDB_D1_NAME ?? 'polylinedb' },
      ACCESS_TEAM_DOMAIN: { type: 'text', value: required('POLYLINEDB_ACCESS_TEAM_DOMAIN', '') },
      ACCESS_AUD: { type: 'text', value: required('POLYLINEDB_ACCESS_AUD', '') },
      ACCESS_ACTORS: { type: 'text', value: required('POLYLINEDB_ACCESS_ACTORS', '[]', ['[]']) },
      ALLOWED_ORIGINS: { type: 'text', value: required('POLYLINEDB_ALLOWED_ORIGINS', '[]') },
    },
  },
};

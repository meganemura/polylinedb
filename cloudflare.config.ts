// Configures the Worker and D1 binding. Access policy and OAuth grants are managed separately.
export default {
  worker: {
    name: process.env.POLYLINEDB_WORKER_NAME ?? 'polylinedb',
    entrypoint: './src/worker.ts',
    compatibilityDate: '2026-09-25',
    previewUrls: false,
    env: {
      DB: { type: 'd1', name: process.env.POLYLINEDB_D1_NAME ?? 'polylinedb' },
      ACCESS_TEAM_DOMAIN: { type: 'text', value: process.env.POLYLINEDB_ACCESS_TEAM_DOMAIN ?? '' },
      ACCESS_AUD: { type: 'text', value: process.env.POLYLINEDB_ACCESS_AUD ?? '' },
      ACCESS_ACTORS: { type: 'text', value: process.env.POLYLINEDB_ACCESS_ACTORS ?? '[]' },
      ALLOWED_ORIGINS: { type: 'text', value: process.env.POLYLINEDB_ALLOWED_ORIGINS ?? '[]' },
    },
  },
};

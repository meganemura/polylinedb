import { writeFileSync } from 'node:fs';
import { registerHooks } from 'node:module';

const seen = [];
registerHooks({
  load(url, context, nextLoad) {
    if (url === 'node:http' || url.includes('/cloud-client/')) seen.push(url);
    return nextLoad(url, context);
  },
});

process.on('exit', () => {
  const path = process.env.PD_IMPORT_TRACE;
  if (path !== undefined) writeFileSync(path, JSON.stringify(seen));
});

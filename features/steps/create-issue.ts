import { defineStep, z } from 'nukadoko';
import { pd } from './pd.ts';
import initLocalStore from './init-local-store.ts';

export default defineStep({
  description: 'Runs `pd --actor local:agent create` and keeps the id and the body version the create returned.',
  pattern: 'an issue the agent created',
  args: z.object({ workDir: z.string(), dataDir: z.string() }),
  returns: z.object({
    id: z.string().describe('the new issue id'),
    bodyVersion: z.number().describe('the body field version the agent read from the create response'),
  }),
  from: { workDir: [initLocalStore, 'workDir'], dataDir: [initLocalStore, 'dataDir'] },
  mutates: true,
  rationale: 'The create response already carries the field versions, so it is the read the agent decides on.',
  run({}, store) {
    const { exitCode, output } = pd(
      ['--actor', 'local:agent', 'create', '--tool', 'app', '--project', 'demo', '--body', 'Handle empty input'],
      store,
    );
    if (exitCode !== 0) throw new Error(`pd create exited ${exitCode}: ${JSON.stringify(output)}`);
    return { id: output.issue.id, bodyVersion: output.issue.versions.body };
  },
});

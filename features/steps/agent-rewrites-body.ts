import { defineStep, z } from 'nukadoko';
import { rewriteBody, rewriteResult } from './pd.ts';
import createIssue from './create-issue.ts';
import initLocalStore from './init-local-store.ts';

// The command is the same as the other actor's except for the actor and the
// text, so the only reason it can fail is the version it was decided on.
export default defineStep({
  description: 'Runs the same `pd update --body --expect body=<version>` as local:agent, with the version it read before the other write.',
  pattern: "the agent rewrites the body at the same old version",
  args: z.object({ workDir: z.string(), dataDir: z.string(), id: z.string(), bodyVersion: z.number() }),
  returns: z.object({
    exitCode: z.number().describe(rewriteResult.exitCode),
    body: z.string().describe(rewriteResult.body),
    output: z.record(z.string(), z.unknown()).describe(rewriteResult.output),
  }),
  from: {
    workDir: [initLocalStore, 'workDir'],
    dataDir: [initLocalStore, 'dataDir'],
    id: [createIssue, 'id'],
    bodyVersion: [createIssue, 'bodyVersion'],
  },
  mutates: true,
  run({}, read) {
    return rewriteBody('local:agent', read);
  },
});

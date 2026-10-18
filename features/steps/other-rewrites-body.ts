import { defineStep, z } from 'nukadoko';
import { rewriteBody, rewriteResult } from './pd.ts';
import createIssue from './create-issue.ts';
import initLocalStore from './init-local-store.ts';

// The other actor writes first, at the version the agent also read, so its
// write is accepted and moves the body to the next version.
export default defineStep({
  description: 'Runs `pd --actor local:other update <id> --body <text> --expect body=<version>` with the version the agent read.',
  pattern: "another actor rewrites the issue's body at the version the agent read",
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
    return rewriteBody('local:other', read);
  },
});

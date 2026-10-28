import { defineStep, z } from 'nukadoko';
import { rewriteBody, rewriteResult } from './pd.ts';
import createIssue from './create-issue.ts';
import initLocalStore from './init-local-store.ts';

// The other actor writes first, at the version the agent also read, so its
// write is accepted and moves the body to the next version. A refusal here
// means the scenario never reached the race it is about, so the step fails.
export default defineStep({
  description: 'Runs `pd --actor local:other update <id> --body <text> --expect body=<version>` with the version the agent read, and fails unless pd exits 0.',
  pattern: "another actor rewrites the issue's body at the version the agent read",
  args: z.object({ workDir: z.string(), dataDir: z.string(), id: z.string(), bodyVersion: z.number() }),
  returns: z.object({
    actor: z.string().describe('the actor that wrote, local:other'),
    body: z.string().describe(rewriteResult.body),
    bodyVersion: z.number().describe('the body field version after this write'),
  }),
  from: {
    workDir: [initLocalStore, 'workDir'],
    dataDir: [initLocalStore, 'dataDir'],
    id: [createIssue, 'id'],
    bodyVersion: [createIssue, 'bodyVersion'],
  },
  mutates: true,
  async run({}, read) {
    const actor = 'local:other';
    const { exitCode, body, output } = await rewriteBody(actor, read);
    if (exitCode !== 0) throw new Error(`the other actor's update exited ${exitCode}: ${JSON.stringify(output)}`);
    const issue = output.issue as { versions: { body: number } };
    return { actor, body, bodyVersion: issue.versions.body };
  },
});

import { defineStep, z } from 'nukadoko';
import { pd } from './pd.ts';
import createIssue from './create-issue.ts';
import initLocalStore from './init-local-store.ts';
import otherRewritesBody from './other-rewrites-body.ts';

// A refused write must leave no trace, so the step reads the store again
// rather than trusting the refusal's own copy of the issue.
export default defineStep({
  description: "Runs `pd show <id>` and claims the body is the other actor's text, last updated by the other actor.",
  pattern: "the issue keeps the other actor's body",
  args: z.object({
    workDir: z.string(),
    dataDir: z.string(),
    id: z.string(),
    otherBody: otherRewritesBody.returns.shape.body,
    otherActor: otherRewritesBody.returns.shape.actor,
  }),
  from: {
    workDir: [initLocalStore, 'workDir'],
    dataDir: [initLocalStore, 'dataDir'],
    id: [createIssue, 'id'],
    otherBody: [otherRewritesBody, 'body'],
    otherActor: [otherRewritesBody, 'actor'],
  },
  async observe({}, { workDir, dataDir, id }) {
    const { exitCode, output } = await pd(['show', id], { workDir, dataDir });
    if (exitCode !== 0) throw new Error(`pd show exited ${exitCode}: ${JSON.stringify(output)}`);
    return { body: output.issue.body, updatedBy: output.issue.updated_by };
  },
  claims: [
    { actual: 'body', compare: 'equal', expected: { from: 'otherBody' } },
    { actual: 'updatedBy', compare: 'equal', expected: { from: 'otherActor' } },
  ],
});

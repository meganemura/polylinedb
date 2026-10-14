import { defineStep, z } from 'nukadoko';
import { pd } from './pd.ts';
import createIssue from './create-issue.ts';
import initLocalStore from './init-local-store.ts';
import otherRewritesBody from './other-rewrites-body.ts';

export default defineStep({
  description: "Runs `pd show <id>` and asserts the body is the other actor's text, last updated by local:other.",
  pattern: "the issue keeps the other actor's body",
  args: z.object({ workDir: z.string(), dataDir: z.string(), id: z.string(), otherBody: z.string() }),
  returns: z.object({}),
  from: {
    workDir: [initLocalStore, 'workDir'],
    dataDir: [initLocalStore, 'dataDir'],
    id: [createIssue, 'id'],
    otherBody: [otherRewritesBody, 'body'],
  },
  mutates: false,
  rationale: "A refused write must leave no trace, so the step reads the store again rather than trusting the refusal's own copy of the issue.",
  run({}, { workDir, dataDir, id, otherBody }) {
    const { exitCode, output } = pd(['show', id], { workDir, dataDir });
    if (exitCode !== 0) throw new Error(`pd show exited ${exitCode}: ${JSON.stringify(output)}`);
    if (output.issue.body !== otherBody) throw new Error(`expected the other actor's body, got: ${output.issue.body}`);
    if (output.issue.updated_by !== 'local:other') throw new Error(`expected updated_by local:other, got ${output.issue.updated_by}`);
    return {};
  },
});

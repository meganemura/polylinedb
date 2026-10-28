import { defineStep, z } from 'nukadoko';
import agentRewritesBody from './agent-rewrites-body.ts';
import createIssue from './create-issue.ts';
import otherRewritesBody from './other-rewrites-body.ts';

// The conflict names the field and both versions so the agent knows what to
// read again; a bare failure would not tell it.
export default defineStep({
  description: "Claims the agent's update exited with pd's conflict code and a conflict error whose fields are all body, from the version the agent read to the version the other actor wrote.",
  pattern: "the agent's update is refused as a conflict that names the body field",
  args: z.object({
    exit: agentRewritesBody.returns.shape.exit,
    output: agentRewritesBody.returns.shape.output,
    readVersion: createIssue.returns.shape.bodyVersion,
    otherVersion: otherRewritesBody.returns.shape.bodyVersion,
  }),
  from: {
    exit: [agentRewritesBody, 'exit'],
    output: [agentRewritesBody, 'output'],
    readVersion: [createIssue, 'bodyVersion'],
    otherVersion: [otherRewritesBody, 'bodyVersion'],
  },
  claims: [
    { actual: 'exit', compare: 'equal', expected: { literal: 'conflict' } },
    { actual: 'output.error.code', compare: 'equal', expected: { literal: 'conflict' } },
    {
      actual: 'output.error.details.fields',
      each: { claims: [{ actual: 'field', compare: 'equal', expected: { literal: 'body' } }] },
    },
    { actual: 'output.error.details.fields.0.expected', compare: 'equal', expected: { from: 'readVersion' } },
    { actual: 'output.error.details.fields.0.actual', compare: 'equal', expected: { from: 'otherVersion' } },
  ],
});

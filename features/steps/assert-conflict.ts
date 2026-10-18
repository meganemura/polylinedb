import { defineStep, z } from 'nukadoko';
import agentRewritesBody from './agent-rewrites-body.ts';
import createIssue from './create-issue.ts';
import otherRewritesBody from './other-rewrites-body.ts';

// The conflict names the field and both versions so the agent knows what to
// read again; a bare failure would not tell it.
export default defineStep({
  description: "Asserts the other actor's write succeeded and the agent's exited 4 with a conflict on body: expected the read version, actual the next one.",
  pattern: "the agent's update is refused as a conflict that names the body field",
  args: z.object({
    otherExitCode: z.number(),
    exitCode: z.number(),
    output: z.record(z.string(), z.unknown()),
    bodyVersion: z.number(),
  }),
  from: {
    otherExitCode: [otherRewritesBody, 'exitCode'],
    exitCode: [agentRewritesBody, 'exitCode'],
    output: [agentRewritesBody, 'output'],
    bodyVersion: [createIssue, 'bodyVersion'],
  },
  mutates: false,
  run({}, { otherExitCode, exitCode, output, bodyVersion }) {
    if (otherExitCode !== 0) throw new Error(`the other actor's update exited ${otherExitCode}`);
    const error = output.error as { code?: string; details?: { fields?: { field: string; expected: number; actual: number }[] } } | undefined;
    if (exitCode !== 4 || error?.code !== 'conflict') throw new Error(`expected exit 4 with a conflict, got ${exitCode}: ${JSON.stringify(output)}`);
    const fields = error.details?.fields ?? [];
    const named = fields.map(field => `${field.field} ${field.expected}->${field.actual}`).join(', ');
    if (named !== `body ${bodyVersion}->${bodyVersion + 1}`) throw new Error(`expected the conflict to name body ${bodyVersion}->${bodyVersion + 1}, got ${named}`);
  },
});

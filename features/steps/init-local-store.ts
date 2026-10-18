import { defineStep, z } from 'nukadoko';
import { join } from 'node:path';
import { pd } from './pd.ts';

// pd refuses a data directory inside the working directory or its repository,
// so the two are separate scratch directories. scratch.dir creates each one
// with mkdtemp, so with mode 0700, which pd requires of an existing data
// directory.
export default defineStep({
  description: 'Runs `pd init` from a scratch working directory with POLYLINEDB_DATA_DIR in a separate scratch directory.',
  pattern: 'a local issue store outside the working repository',
  args: z.object({}),
  returns: z.object({
    workDir: z.string().describe('the working directory every pd command runs from'),
    dataDir: z.string().describe('the POLYLINEDB_DATA_DIR that holds polylinedb.sqlite'),
  }),
  mutates: true,
  async run({ scratch }) {
    const workDir = scratch.dir('polylinedb-scenario-work');
    const dataDir = join(scratch.dir('polylinedb-scenario-data'), 'data');
    const { exitCode, output } = await pd(['init', '--tool', 'app', '--project', 'demo', '--actor', 'local:agent'], { workDir, dataDir });
    if (exitCode !== 0) throw new Error(`pd init exited ${exitCode}: ${JSON.stringify(output)}`);
    return { workDir, dataDir };
  },
});

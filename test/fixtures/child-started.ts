// Tells runChild that exec finished and this node process runs, so its run limit can start.
import { closeSync, writeSync } from 'node:fs';

writeSync(3, 'started');
closeSync(3);

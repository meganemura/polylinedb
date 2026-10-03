// Emits the shared schema for an explicitly selected D1 database.
import { SCHEMA_SQL } from '../src/schema.ts';

process.stdout.write(SCHEMA_SQL + '\n');

// Emits the shared schema for an explicitly selected D1 database.
import { SCHEMA_SQL, schemaUpgradeStatements } from '../src/records/persistence.ts';

const args = process.argv.slice(2);
if (args.length === 0) process.stdout.write(SCHEMA_SQL + '\n');
else if (args.length === 2 && args[0] === '--upgrade-from' && (args[1] === '2' || args[1] === '3' || args[1] === '4')) process.stdout.write(schemaUpgradeStatements(args[1] === '2' ? 2 : args[1] === '3' ? 3 : 4).join(';\n') + ';\n');
else throw new Error('Usage: node scripts/schema.ts [--upgrade-from 2|3|4]');

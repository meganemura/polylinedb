// Emits the shared schema for an explicitly selected D1 database.
import { SCHEMA_SQL, schemaUpgradeStatements } from '../src/records/persistence.ts';

const args = process.argv.slice(2);
const upgradable = { '2': 2, '3': 3, '4': 4, '5': 5, '6': 6 } as const;
const previous = args.length === 2 && args[0] === '--upgrade-from' && Object.hasOwn(upgradable, args[1] ?? '') ? upgradable[args[1] as keyof typeof upgradable] : undefined;
if (args.length === 0) process.stdout.write(SCHEMA_SQL + '\n');
else if (previous !== undefined) process.stdout.write(schemaUpgradeStatements(previous).join(';\n') + ';\n');
else throw new Error('Usage: node scripts/schema.ts [--upgrade-from 2|3|4|5|6]');

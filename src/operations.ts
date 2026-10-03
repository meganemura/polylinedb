// Selects the domain operation; each domain owns its validation, SQL, and conflicts.
import { executeOperation as executeIssue, parseOperation as parseIssue, operationSchemas as issueSchemas } from './issues.ts';
import type { Operation as IssueOperation, OperationResult as IssueResult, SqlExecutor } from './issues.ts';
import { executeMemoryOperation, parseMemoryOperation, memorySchemas } from './memories.ts';
import type { MemoryOperation, MemoryResult, MemoryStore } from './memories.ts';
export type Operation = IssueOperation | MemoryOperation;
export type OperationResult = IssueResult | MemoryResult;
export const operationSchemas = { ...issueSchemas, ...memorySchemas };
export function parseOperation(value: unknown): Operation {
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('memory_')) return parseMemoryOperation(value);
  return parseIssue(value);
}
export function executeOperation(db: SqlExecutor, operation: Operation, actor: string, store?: MemoryStore): Promise<OperationResult> {
  switch (operation.op) {
    case 'memory_create': case 'memory_show': case 'memory_list': case 'memory_search': case 'memory_update': case 'memory_delete': case 'memory_context':
      return executeMemoryOperation(db, operation, actor, store);
    default: return executeIssue(db, operation, actor);
  }
}

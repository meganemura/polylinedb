// Selects the domain operation; each domain owns its validation, SQL, and conflicts.
import { executeOperation as executeIssue, parseOperation as parseIssue, operationSchemas as issueSchemas } from "./issues.ts";
import type { Operation as IssueOperation, OperationResult as IssueResult, SqlExecutor } from "./issues.ts";
import { executeMemoryOperation, parseMemoryOperation, memorySchemas, parseMemoryRevision, observedMemoryProject, memoryFreshness } from "./memories.ts";
import type { MemoryOperation, MemoryResult, MemoryStore, MemoryRevision, MemoryFreshness } from "./memories.ts";
import { issueQueries } from "./issue-queries.ts";
import { PolylinedbError } from './errors.ts';
import { readyLabel } from '../transition/index.ts';
import type { Actor } from '../transition/index.ts';
import { asActor } from './agent-gate.ts';
import { parseDependencyOperation, executeDependencyOperation, dependencySchemas } from './dependencies.ts';
import type { DependencyOperation, DependencyResult } from './dependencies.ts';
import { claimSchemas, parseClaimOperation, executeClaimOperation } from './claims.ts';
import type { ClaimOperation, ClaimResult } from './claims.ts';
import { changesSchemas, parseChangesOperation, executeChangesOperation } from './changes.ts';
import type { ChangesOperation, ChangesResult } from './changes.ts';
export type Operation = (Exclude<IssueOperation, { op: 'actor' }> & { observed_memory_revision?: MemoryRevision }) | Extract<IssueOperation, { op: 'actor' }> | MemoryOperation | DependencyOperation | ClaimOperation | ChangesOperation;
export type OperationResult = (IssueResult & { memory_freshness?: MemoryFreshness }) | MemoryResult | DependencyResult | ClaimResult | ChangesResult;
const observedSchema = { type: 'string', maxLength: 4100, description: 'Opaque token from memory_context with with_revision. The advisory covers that project, including on unfiltered list/search.' };
export const operationSchemas = { ...issueSchemas, ...memorySchemas, ...dependencySchemas, ...claimSchemas, ...changesSchemas,
  ...Object.fromEntries(Object.entries(issueSchemas).filter(([key]) => key !== 'actor').map(([key, value]) => [key, { ...value, properties: { ...value.properties, observed_memory_revision: observedSchema } }])) };
export function parseOperation(value: unknown): Operation {
  if (value && typeof value === 'object' && 'op' in value && value.op === 'changes') return parseChangesOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('claim_')) return parseClaimOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('dependency_')) return parseDependencyOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('memory_')) return parseMemoryOperation(value);
  if (value && typeof value === 'object' && !Array.isArray(value) && 'observed_memory_revision' in value) {
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return parseIssue(value);
    const { observed_memory_revision, ...input } = value;
    const operation = parseIssue(input);
    if (operation.op === 'actor') return parseIssue(value);
    return { ...operation, observed_memory_revision: parseMemoryRevision(observed_memory_revision) };
  }
  return parseIssue(value);
}
export async function executeOperation(db: SqlExecutor, operation: Operation, caller: string | Actor, store?: MemoryStore): Promise<OperationResult> {
  const actor = asActor(caller);
  if (actor.kind === 'agent' && operation.op === 'dependency_worklist' && operation.state === 'ready') {
    if (operation.label !== undefined && operation.label !== readyLabel) throw new PolylinedbError('invalid_input', `An agent reads the ready worklist through the ${readyLabel} label`, 400);
    return dispatch(db, { ...operation, label: readyLabel }, actor, store);
  }
  return dispatch(db, operation, actor, store);
}

async function dispatch(db: SqlExecutor, operation: Operation, actor: Actor, store?: MemoryStore): Promise<OperationResult> {
  switch (operation.op) {
    case 'claim_show': case 'claim_list': case 'claim_acquire': case 'claim_renew': case 'claim_release':
      return executeClaimOperation(db, operation, actor);
    case 'changes':
      return executeChangesOperation(db, operation);
    case 'dependency_add': case 'dependency_remove': case 'dependency_list': case 'dependency_worklist':
      return executeDependencyOperation(db, operation, actor);
    case 'memory_create': case 'memory_show': case 'memory_list': case 'memory_search': case 'memory_update': case 'memory_delete': case 'memory_context':
      return executeMemoryOperation(db, operation, actor.id, store);
    default: {
      if (operation.op === 'actor') return executeIssue(db, operation, actor);
      const { observed_memory_revision, ...issueOperation } = operation;
      const output = await executeIssue(db, issueOperation, actor);
      if (observed_memory_revision === undefined) return output;
      let project = observedMemoryProject(observed_memory_revision);
      try {
        if ('issue' in output) project = output.issue.project;
        else if (operation.op === 'comment') {
          const rows = await db.reads.all(issueQueries.issueProject, { id: operation.id });
          const row = rows[0];
          if (rows.length !== 1 || !row || typeof row.project !== 'string') throw new Error('Issue project is unavailable');
          project = row.project;
        } else if (operation.op === 'list' || operation.op === 'search') project = operation.project ?? project;
        if (!store) throw new Error('Selected store identity is unavailable');
        return { ...output, memory_freshness: await memoryFreshness(db, observed_memory_revision, project, store) };
      } catch { return { ...output, memory_freshness: { status: 'unavailable', project } }; }
    }
  }
}

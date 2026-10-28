// Selects the domain operation; each domain owns its validation, SQL, and conflicts.
import { executeOperation as executeIssue, parseOperation as parseIssue, operationSchemas as issueSchemas } from "./issues/issues.ts";
import type { Operation as IssueOperation, OperationResult as IssueResult } from "./issues/issues.ts";
import type { SqlExecutor } from "./store/sql.ts";
import { executeMemoryOperation, parseMemoryOperation, memorySchemas, parseMemoryRevision, observedMemoryProject, memoryFreshness } from "./memories/memories.ts";
import type { MemoryOperation, MemoryResult, MemoryStore, MemoryRevision, MemoryFreshness } from "./memories/memories.ts";
import { issueQueries } from "./store/issue-queries.ts";
import { PolylinedbError } from './store/errors.ts';
import { readyLabel } from '../transition/index.ts';
import type { Actor } from '../transition/index.ts';
import { asActor } from './claims/agent-gate.ts';
import { parseDependencyOperation, executeDependencyOperation, dependencySchemas } from './dependencies/dependencies.ts';
import type { DependencyOperation, DependencyResult } from './dependencies/dependencies.ts';
import { claimSchemas, parseClaimOperation, executeClaimOperation } from './claims/claims.ts';
import type { ClaimOperation, ClaimResult } from './claims/claims.ts';
import { changesSchemas, parseChangesOperation, parseWaitOperation, executeChangesOperation, executeWaitOperation } from './changes/changes.ts';
import type { ChangesOperation, ChangesResult, WaitOperation } from './changes/changes.ts';
import { executeLandOrderOperation, landOrderSchemas, landOrderWarnings, parseLandOrderOperation, readLandOrders } from './land-order/land-order.ts';
import type { LandOrder, LandOrderOperation, LandOrderResult, LandOrderWarning } from './land-order/land-order.ts';
import { executeResourceOperation, parseResourceOperation, resourceSchemas } from './resources/resources.ts';
import type { ResourceOperation, ResourceResult } from './resources/resources.ts';
import { executePostOperation, parsePostOperation, postSchemas } from './posts/posts.ts';
import type { PostOperation, PostResult } from './posts/posts.ts';
export type Operation = (Exclude<IssueOperation, { op: 'actor' }> & { observed_memory_revision?: MemoryRevision }) | Extract<IssueOperation, { op: 'actor' }> | MemoryOperation | DependencyOperation | ClaimOperation | ChangesOperation | WaitOperation | LandOrderOperation | ResourceOperation | PostOperation;
/** show and list add land_order only on request; list aligns it with issues. */
export type OperationResult = (IssueResult & { memory_freshness?: MemoryFreshness; land_order?: LandOrder | LandOrder[] }) | MemoryResult | DependencyResult | ClaimResult | (Extract<ClaimResult, { handoff: unknown }> & { land_order_warnings?: LandOrderWarning[] }) | ChangesResult | LandOrderResult | ResourceResult | PostResult;
const observedSchema = { type: 'string', maxLength: 4100, description: 'Opaque token from memory_context with with_revision. The advisory covers that project, including on unfiltered list/search.' };
export const operationSchemas = { ...issueSchemas, ...memorySchemas, ...dependencySchemas, ...claimSchemas, ...changesSchemas, ...landOrderSchemas, ...resourceSchemas, ...postSchemas,
  ...Object.fromEntries(Object.entries(issueSchemas).filter(([key]) => key !== 'actor').map(([key, value]) => [key, { ...value, properties: { ...value.properties, observed_memory_revision: observedSchema } }])) };
export function parseOperation(value: unknown): Operation {
  if (value && typeof value === 'object' && 'op' in value && (value.op === 'changes' || value.op === 'wait')) return value.op === 'wait' ? parseWaitOperation(value) : parseChangesOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('claim_')) return parseClaimOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('dependency_')) return parseDependencyOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('land_order_')) return parseLandOrderOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('resource_')) return parseResourceOperation(value);
  if (value && typeof value === 'object' && 'op' in value && typeof value.op === 'string' && value.op.startsWith('memory_')) return parseMemoryOperation(value);
  if (value && typeof value === 'object' && 'op' in value && (value.op === 'star' || value.op === 'unstar' || value.op === 'posts')) return parsePostOperation(value);
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
    case 'claim_handoff': {
      // The warning is advisory: it reads after the handoff committed, and nothing about the push is undone.
      const output = await executeClaimOperation(db, operation, actor);
      if (!('handoff' in output)) return output;
      return { ...output, land_order_warnings: await landOrderWarnings(db, output.handoff.issue.id) };
    }
    case 'changes':
      return executeChangesOperation(db, operation);
    case 'wait':
      return executeWaitOperation(db, operation);
    case 'dependency_add': case 'dependency_remove': case 'dependency_list': case 'dependency_worklist': case 'dependency_owner_waits':
      return executeDependencyOperation(db, operation, actor);
    case 'land_order_add': case 'land_order_remove': case 'land_order_list':
      return executeLandOrderOperation(db, operation, actor);
    case 'resource_add': case 'resource_update': case 'resource_list': case 'resource_live':
      return executeResourceOperation(db, operation, actor);
    case 'star': case 'unstar': case 'posts':
      return executePostOperation(db, operation, actor);
    case 'memory_create': case 'memory_show': case 'memory_list': case 'memory_search': case 'memory_update': case 'memory_delete': case 'memory_context':
      return executeMemoryOperation(db, operation, actor.id, store);
    default: {
      if (operation.op === 'actor') return executeIssue(db, operation, actor);
      const { observed_memory_revision, ...issueOperation } = operation;
      const output = await withLandOrder(db, issueOperation, await executeIssue(db, issueOperation, actor));
      if (observed_memory_revision === undefined) return output;
      let project = observedMemoryProject(observed_memory_revision);
      try {
        if ('issue' in output) project = output.issue.project;
        else if (operation.op === 'comment' || operation.op === 'comment_edit') {
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

async function withLandOrder(db: SqlExecutor, operation: IssueOperation, output: IssueResult): Promise<IssueResult & { land_order?: LandOrder | LandOrder[] }> {
  if ((operation.op !== 'show' && operation.op !== 'list') || operation.with_land_order !== true) return output;
  if ('issue' in output) {
    const order = (await readLandOrders(db, [output.issue.id])).get(output.issue.id);
    if (!order) throw new PolylinedbError('not_found', 'Issue was not found', 404, { id: output.issue.id });
    return { ...output, land_order: order };
  }
  if (!('issues' in output)) return output;
  const orders = await readLandOrders(db, output.issues.map(issue => issue.id));
  return { ...output, land_order: output.issues.map(issue => orders.get(issue.id) ?? { issue_id: issue.id, revision: 1, after: [], before: [] }) };
}

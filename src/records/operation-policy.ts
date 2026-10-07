import type { Operation } from './operations.ts';

export type OperationAccess = 'read' | 'write';

type McpHints = {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
};

type OperationPolicy = {
  access: OperationAccess;
  mcp: McpHints;
};

const operationPolicy = {
  actor: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  create: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  show: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  list: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  search: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  comment: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: false } },
  update: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  close: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  reopen: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  memory_create: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  memory_show: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  memory_list: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  memory_search: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  memory_update: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  memory_delete: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  memory_context: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  dependency_add: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  dependency_remove: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
  dependency_list: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  dependency_worklist: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  claim_show: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  claim_list: { access: 'read', mcp: { readOnlyHint: true, destructiveHint: false, idempotentHint: true } },
  claim_acquire: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  claim_renew: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: false, idempotentHint: true } },
  claim_release: { access: 'write', mcp: { readOnlyHint: false, destructiveHint: true, idempotentHint: true } },
} satisfies Record<Operation['op'], OperationPolicy>;

function hasOperationPolicy(name: string): name is Operation['op'] {
  return Object.hasOwn(operationPolicy, name);
}

export function requiresExplicitLocalActor(name: string): boolean {
  return hasOperationPolicy(name) && operationPolicy[name].access === 'write';
}

export function operationAccess(name: Operation['op']): OperationAccess {
  return operationPolicy[name].access;
}

export function mcpAnnotationsFor(name: string) {
  if (!hasOperationPolicy(name)) throw new Error(`Missing operation policy for ${name}`);
  return { ...operationPolicy[name].mcp, openWorldHint: false };
}

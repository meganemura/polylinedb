// Judges a port protocol world against its safety invariants, and drives random schedules through Hegel.
// The checks read world state only and call no protocol function, so a protocol mistake cannot hide in a shared helper.
import { AssertionError } from 'node:assert/strict';
import * as hegel from '@hegeldev/hegel';
import * as gs from '@hegeldev/hegel/generators';
import { enabled, initialWorld, sequenceName, step } from './port-protocol.ts';
import type { Action, ActionKind, Authority, EventTag, Fact, Incarnation, IssueId, Issued, Message, ObjectName, RequestKey, Rules, World } from './port-protocol.ts';

export type Reliance = { kind: 'mirror'; seq: number } | { kind: 'child'; child: IssueId };
export type Violation =
  | { invariant: 'A'; port: Incarnation; issue: IssueId; fact: Fact; reliance: Reliance; authority: ObjectName; seq: number }
  | { invariant: 'B'; request: RequestKey; receipts: Issued[] };

// Before its first touch, an issue's authority still lives in an older incarnation.
export function authorityOf(world: World, issue: IssueId): Authority | null {
  for (let incarnation = Number(world.current.slice(1)); incarnation >= 0; incarnation--) {
    const authority = world.objects.get(`s${incarnation}:${issue}`);
    if (authority) return authority;
  }
  return null;
}

// Only the current port answers anybody, so only its view is judged.
export function violations(world: World): Violation[] {
  const port = world.ports.get(world.current)!;
  const found: Violation[] = [];
  for (const [issue, mirror] of port.mirror) {
    const authority = authorityOf(world, issue);
    if (!authority) continue;
    const relied: { fact: Fact; reliance: Reliance }[] = [];
    if (mirror.facts.closed) relied.push({ fact: 'closed', reliance: { kind: 'mirror', seq: mirror.seq } });
    if (mirror.facts.epic) relied.push({ fact: 'epic', reliance: { kind: 'mirror', seq: mirror.seq } });
    for (const [child, parent] of port.parent) if (parent === issue) relied.push({ fact: 'epic', reliance: { kind: 'child', child } });
    for (const { fact, reliance } of relied) {
      if (!authority.durable.facts[fact]) found.push({ invariant: 'A', port: port.incarnation, issue, fact, reliance, authority: authority.name, seq: authority.durable.seq });
    }
  }
  // A pull or a port copy carries a receipt's uid, so two uids for one request ID mean two receipts.
  for (const [request, receipts] of world.issued) {
    if (new Set(receipts.map(({ uid }) => uid)).size > 1) found.push({ invariant: 'B', request, receipts });
  }
  return found;
}

function headline(step: number, violation: Violation): string {
  if (violation.invariant === 'B') {
    const [kind, request] = violation.request.split(' ');
    const receipts = violation.receipts.map(({ by, step: at }) => `${by} (step ${at})`).join(', ');
    return `Safety B violated after step ${step}: ${kind === 'claim' ? 'claim' : 'creation'} request ${request} has ${violation.receipts.length} receipts: ${receipts}`;
  }
  const reliance = violation.reliance.kind === 'mirror' ? `mirror at seq ${violation.reliance.seq}` : `child ${violation.reliance.child}`;
  return `Safety A violated after step ${step}: port ${violation.port} relies on ${violation.issue} ${violation.fact} (${reliance}), but authority ${violation.authority} has ${violation.fact} false at seq ${violation.seq}`;
}

export function report(step: number, found: readonly Violation[], trace: readonly string[]): string {
  return [...found.map(violation => headline(step, violation)), 'trace:', ...trace].join('\n');
}

export type ExploreOptions = { cases: number; seed: number; steps: number };
export type Tally = Map<EventTag, number>;

// Weights pick the action kind; every action of that kind is then equally likely. idle comes first in the
// weighted list, so choice 0 means idle and Hegel shrinks an unneeded step to a line the report does not print.
export const weights: Record<ActionKind, number> = {
  idle: 1, request: 8, deliver: 20, finish: 2, reset: 1, 'age-out': 1, create: 1, 'add-edge': 1,
};

export function schedule(world: World, choice: readonly [number, number]): Action {
  const actions = enabled(world);
  const kinds = [...new Set(actions.map(action => action.kind))].flatMap(kind => Array<ActionKind>(weights[kind]).fill(kind));
  const kind = kinds[choice[0] % kinds.length];
  const ofKind = actions.filter(action => action.kind === kind);
  return ofKind[choice[1] % ofKind.length]!;
}

export function explore(rules: Rules, options: ExploreOptions): Tally {
  const tally: Tally = new Map();
  hegel.test(tc => {
    // Two bytes per step: one byte array shrinks in a tenth of the cases that an array of integer pairs needs.
    // A fixed length keeps detection independent of Hegel's list sizes; idle steps let shrinking cut the trace.
    const bytes = tc.draw(gs.binary({ minSize: 2 * options.steps, maxSize: 2 * options.steps }));
    const world = initialWorld();
    const trace: string[] = [];
    for (let index = 0; index < bytes.length; index += 2) {
      const action = schedule(world, [bytes[index]!, bytes[index + 1]!]);
      const said = describe(action, world);
      const events = step(world, action, rules);
      for (const { tag } of events) tally.set(tag, (tally.get(tag) ?? 0) + 1);
      if (action.kind !== 'idle') trace.push(`step ${world.step}  ${said}: ${events.map(({ detail }) => detail).join('; ')}`);
      const found = violations(world);
      if (found.length > 0) throw new AssertionError({ message: report(world.step, found, trace) });
    }
  }, { testCases: options.cases, seed: options.seed, database: hegel.Database.fromPath('.hegel') });
  return tally;
}

function describeMessage(message: Message): string {
  return message.kind === 'admit'
    ? `admit ${sequenceName(message.change, message.from.split(':')[1] as IssueId, message.seq)} to port ${message.from.split(':')[0]}`
    : `answer ${message.verdict} for seq ${message.seq} to ${message.to}`;
}

// Describes an action before it runs, while the message it delivers is still in flight.
export function describe(action: Action, world: World): string {
  switch (action.kind) {
    case 'idle': return 'idle';
    case 'request': return `request ${action.issue} ${action.ask.kind === 'flip' ? `flip ${action.ask.fact}` : `acquire ${action.ask.request}`} via ${world.current}`;
    case 'deliver': {
      if (action.item.kind === 'row') return `deliver ${action.item.object} row ${action.item.seq}, ack ${action.fate === 'delivered' ? 'received' : 'lost'}`;
      const verb = action.fate === 'lost' ? 'lose' : action.fate === 'duplicated' ? 'deliver a copy of' : 'deliver';
      const id = action.item.id;
      return `${verb} ${describeMessage(world.network.find(message => message.id === id)!)}`;
    }
    case 'finish': return `finish ${action.object}`;
    case 'reset': return `reset ${action.object}`;
    case 'age-out': return `age-out ${action.port} ${action.issue} seq ${action.seq}`;
    case 'create': return `create ${action.request}${action.parent ? ` under ${action.parent}` : ''} as ${action.epic ? 'epic' : 'task'} via ${world.current}, init ${action.init}`;
    case 'add-edge': return `add edge ${action.dependent} -> ${action.blocker} via ${world.current}`;
  }
}

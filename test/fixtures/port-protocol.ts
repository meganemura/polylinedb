// Models a split store: one issue authority per issue and incarnation, one cross-issue port per incarnation,
// and the unreliable network between them. Imports nothing from src/, because the split does not exist yet.

export type Incarnation = `s${number}`;
export type IssueId = `i${number}`;
export type ObjectName = `${Incarnation}:${IssueId}`;
export type Nonce = `n${number}`;
export type ClaimRequest = 'c1' | 'c2';
// k1-k3 build the seed world and are never drawn; n1 and n2 are the creation requests clients send.
export type CreationRequest = 'k1' | 'k2' | 'k3' | 'n1' | 'n2';
export type ReceiptUid = number;

export type Facts = { closed: boolean; epic: boolean };
export type Fact = keyof Facts;
// The port relies on closed === true (a dependent may close) and epic === true (a child may join).
// false is the strict value of both facts, so a change to false is restrictive.
const strictValue = { closed: false, epic: false } as const satisfies Facts;
const facts = ['closed', 'epic'] as const satisfies readonly Fact[];

export type FactChange = { kind: 'fact'; fact: Fact; to: boolean };
export type ClaimChange = { kind: 'claim'; request: ClaimRequest };
export type Change = FactChange | ClaimChange;
export const restrictive = (change: FactChange): boolean => change.to === strictValue[change.fact];
// Close reads the blockers; reopen, make epic, and make task read nothing outside their own issue.
const guarded = (change: Change): boolean => change.kind === 'fact' && change.fact === 'closed' && change.to;

// One row per ended sequence (rule 2). The row carries the full facts, so the port needs no row in between.
export type Row = { issue: IssueId; seq: number; nonce: Nonce; end: 'commit' | 'abort'; facts: Facts; claim: ClaimRequest | null };
export type Marker = { seq: number; nonce: Nonce; change: Change };

// A reset keeps Durable and loses Volatile, so neither can lose or carry the wrong half.
export type Durable = {
  facts: Facts; seq: number; marker: Marker | null; ended: Map<number, Row>; outbox: Row[];
  claims: Map<ClaimRequest, ReceiptUid>;
};
export type Verdict = 'admitted' | 'refused';
export type Handler = { seq: number; nonce: Nonce };
export type Volatile = { handler: Handler | null };
export type Authority = { name: ObjectName; durable: Durable; volatile: Volatile };

export type Mirror = { facts: Facts; seq: number; floor: Record<Fact, number> };
// An open admission is an answer the port gave and has not seen end.
export type Admission = { issue: IssueId; seq: number; nonce: Nonce; guarded: boolean };
export type Reservation =
  | { state: 'open'; issue: IssueId; seq: number; nonce: Nonce }
  | { state: 'bound'; issue: IssueId; seq: number }
  | { state: 'released' };
export type CreationReceipt = {
  request: CreationRequest; issue: IssueId; parent: IssueId | null; facts: Facts;
  incarnation: Incarnation; uid: ReceiptUid;
};
export type Port = {
  incarnation: Incarnation;
  mirror: Map<IssueId, Mirror>;
  admissions: Admission[];
  blockers: Map<IssueId, Set<IssueId>>;
  parent: Map<IssueId, IssueId>;
  counter: number;
  receipts: Map<CreationRequest, CreationReceipt>;
  reservations: Map<ClaimRequest, Reservation>;
};

// The admission request and the port's answer are messages, so either can be lost, repeated, or overtaken by rows.
export type Message =
  | { kind: 'admit'; id: number; from: ObjectName; seq: number; nonce: Nonce; change: Change }
  | { kind: 'answer'; id: number; to: ObjectName; seq: number; nonce: Nonce; verdict: Verdict };

export type RequestKey = `claim ${ClaimRequest}` | `create ${CreationRequest}`;
export type Issued = { uid: ReceiptUid; by: string; step: number };
export type World = {
  step: number;
  current: Incarnation;
  ports: Map<Incarnation, Port>;
  objects: Map<ObjectName, Authority>;
  network: Message[];
  sent: number;
  nonces: number;
  uids: number;
  // Ghost record for Safety B. A commit or a creation appends; a replay appends nothing. The protocol never reads it.
  issued: Map<RequestKey, Issued[]>;
};

export type Ask = { kind: 'flip'; fact: Fact } | { kind: 'acquire'; request: ClaimRequest };
// A row stays in its sender's outbox until an ack arrives, so a delivered row is acked or repeated, never lost.
export type InFlight = { kind: 'message'; id: number } | { kind: 'row'; object: ObjectName; seq: number };
export type Fate = 'delivered' | 'duplicated' | 'lost';
export type Action =
  | { kind: 'idle' }
  | { kind: 'request'; issue: IssueId; ask: Ask }
  | { kind: 'deliver'; item: InFlight; fate: Fate }
  | { kind: 'finish'; object: ObjectName }
  | { kind: 'reset'; object: ObjectName }
  | { kind: 'age-out'; port: Incarnation; issue: IssueId; seq: number }
  | { kind: 'create'; request: CreationRequest; parent: IssueId | null; epic: boolean; init: 'delivered' | 'lost' }
  | { kind: 'add-edge'; dependent: IssueId; blocker: IssueId };
export type ActionKind = Action['kind'];

export const eventTags = [
  'idle', 'requested', 'replayed', 'refused-busy', 'aborted-after-reset',
  'admitted', 'readmitted', 'refused-blocked', 'refused-children', 'refused-reserved', 'refused-unknown',
  'answer-dropped', 'lost',
  'committed', 'aborted-refused', 'aborted-lost-reply', 'dropped', 'reset',
  'row-applied', 'row-stale', 'row-below-floor', 'reservation-bound', 'reservation-released', 'reservation-kept',
  'resolve-abort', 'resolve-reemit', 'resolve-unknown',
  'created', 'creation-replayed', 'creation-refused', 'created-from-receipt', 'edge-added', 'edge-refused',
] as const;
export type EventTag = typeof eventTags[number];
export type Event = { tag: EventTag; detail: string };

// The defect switch. Each member is the one decision a mechanism turns on; a defect replaces exactly one member.
export type Rules = {
  // Mechanism 1, rules 1-4: a restrictive change takes effect in the port before its authority commits it;
  // a permissive change takes effect in the port only from the authority's row.
  order(change: FactChange): 'port-first' | 'authority-first';
  // Mechanism 2, rule 5: what an abort row does to the reservation of its claim request ID.
  afterAbort(reservation: Reservation, abort: Row): Reservation;
};

export const protocolRules: Rules = {
  order: change => restrictive(change) ? 'port-first' : 'authority-first',
  afterAbort: (reservation, abort) => reservation.state === 'open' && reservation.nonce === abort.nonce ? { state: 'released' } : reservation,
};

// i1 is a closed task that holds claim receipt c1. i2 and i3 depend on i1. i3 is an epic.
export const seedScript: readonly Action[] = [
  { kind: 'create', request: 'k1', parent: null, epic: false, init: 'delivered' },
  { kind: 'create', request: 'k2', parent: null, epic: false, init: 'delivered' },
  { kind: 'create', request: 'k3', parent: null, epic: true, init: 'delivered' },
  { kind: 'add-edge', dependent: 'i2', blocker: 'i1' },
  { kind: 'add-edge', dependent: 'i3', blocker: 'i1' },
  { kind: 'request', issue: 'i1', ask: { kind: 'acquire', request: 'c1' } },
  { kind: 'deliver', item: { kind: 'message', id: 1 }, fate: 'delivered' },
  { kind: 'deliver', item: { kind: 'message', id: 2 }, fate: 'delivered' },
  { kind: 'deliver', item: { kind: 'row', object: 's0:i1', seq: 1 }, fate: 'delivered' },
  { kind: 'request', issue: 'i1', ask: { kind: 'flip', fact: 'closed' } },
  { kind: 'deliver', item: { kind: 'message', id: 3 }, fate: 'delivered' },
  { kind: 'deliver', item: { kind: 'message', id: 4 }, fate: 'delivered' },
  { kind: 'deliver', item: { kind: 'row', object: 's0:i1', seq: 2 }, fate: 'delivered' },
];

export function initialWorld(): World {
  const port: Port = {
    incarnation: 's0', mirror: new Map(), admissions: [], blockers: new Map(), parent: new Map(), counter: 0,
    receipts: new Map(), reservations: new Map(),
  };
  const world: World = {
    step: 0, current: 's0', ports: new Map([['s0', port]]), objects: new Map(), network: [], sent: 0, nonces: 0,
    uids: 0, issued: new Map(),
  };
  for (const action of seedScript) step(world, action, protocolRules);
  world.step = 0;
  for (const receipts of world.issued.values()) for (const receipt of receipts) receipt.step = 0;
  return world;
}

const asks: readonly Ask[] = [
  { kind: 'flip', fact: 'closed' }, { kind: 'flip', fact: 'epic' }, { kind: 'acquire', request: 'c1' }, { kind: 'acquire', request: 'c2' },
];
// Repeats weight the fates, so a message arrives once twice as often as it repeats or vanishes.
const messageFates: readonly Fate[] = ['delivered', 'delivered', 'duplicated', 'lost'];
const rowFates: readonly Fate[] = ['delivered', 'duplicated'];

export function enabled(world: World): Action[] {
  const port = currentPort(world);
  const issues = [...port.mirror.keys()];
  const actions: Action[] = [{ kind: 'idle' }];
  for (const issue of issues) for (const ask of asks) actions.push({ kind: 'request', issue, ask });
  for (const message of world.network) for (const fate of messageFates) actions.push({ kind: 'deliver', item: { kind: 'message', id: message.id }, fate });
  for (const authority of world.objects.values()) {
    for (const row of authority.durable.outbox) for (const fate of rowFates) actions.push({ kind: 'deliver', item: { kind: 'row', object: authority.name, seq: row.seq }, fate });
  }
  for (const authority of world.objects.values()) {
    if (authority.volatile.handler) actions.push({ kind: 'finish', object: authority.name }, { kind: 'reset', object: authority.name });
  }
  for (const admission of port.admissions) actions.push({ kind: 'age-out', port: port.incarnation, issue: admission.issue, seq: admission.seq });
  for (const request of ['n1', 'n2'] as const) for (const parent of [null, ...issues]) for (const epic of [false, true]) {
    for (const init of ['delivered', 'lost'] as const) actions.push({ kind: 'create', request, parent, epic, init });
  }
  for (const dependent of issues) for (const blocker of issues) {
    if (dependent !== blocker && !port.blockers.get(dependent)?.has(blocker)) actions.push({ kind: 'add-edge', dependent, blocker });
  }
  return actions;
}

// Mutates world. Returns what happened, for the trace and the coverage tally.
export function step(world: World, action: Action, rules: Rules): Event[] {
  // An idle step changes nothing, so the trace numbers only the steps it prints.
  if (action.kind === 'idle') return [event('idle', '')];
  world.step += 1;
  switch (action.kind) {
    case 'request': return request(world, action);
    case 'deliver': return deliver(world, action, rules);
    case 'finish': return [finish(world, object(world, action.object))];
    case 'reset': object(world, action.object).volatile.handler = null; return [event('reset', 'the handler is lost; the marker stays')];
    case 'age-out': return ageOut(world, action);
    case 'create': return create(world, action);
    case 'add-edge': return addEdge(world, action);
  }
}

type Answer = { verdict: Verdict; tag: EventTag; detail: string };
type Touched = { authority: Authority; events: Event[] } | { refused: Event };

const event = (tag: EventTag, detail: string): Event => ({ tag, detail });
const currentPort = (world: World): Port => world.ports.get(world.current)!;
const object = (world: World, name: ObjectName): Authority => world.objects.get(name)!;
const incarnationOf = (name: ObjectName): Incarnation => name.split(':')[0] as Incarnation;
const issueOf = (name: ObjectName): IssueId => name.split(':')[1] as IssueId;

export function sequenceName(change: Change, issue: IssueId, seq: number): string {
  if (change.kind === 'claim') return `claim ${change.request} by ${issue} seq ${seq}`;
  const name = change.fact === 'closed' ? change.to ? 'close' : 'reopen' : change.to ? 'make epic' : 'make task';
  return `${name} ${issue} seq ${seq}`;
}

type Unsent = { [K in Message['kind']]: Omit<Extract<Message, { kind: K }>, 'id'> }[Message['kind']];
function send(world: World, message: Unsent): void {
  world.network.push({ ...message, id: ++world.sent });
}

function request(world: World, action: Extract<Action, { kind: 'request' }>): Event[] {
  const touched = touch(world, world.current, action.issue);
  if ('refused' in touched) return [touched.refused];
  const { authority, events } = touched;
  const { durable, volatile } = authority;
  if (volatile.handler) return [...events, event('refused-busy', `${authority.name} still waits on seq ${volatile.handler.seq}`)];
  // Rule 2: a marker with no handler was left by a reset, and the next request ends it with an abort row first.
  if (durable.marker) events.push(event('aborted-after-reset', `abort row seq ${endSequence(world, authority, 'abort').seq} for the marker a reset left`));
  const { ask } = action;
  if (ask.kind === 'acquire' && durable.claims.has(ask.request)) return [...events, event('replayed', `${authority.name} already holds the receipt for ${ask.request}`)];
  const change: Change = ask.kind === 'acquire' ? { kind: 'claim', request: ask.request } : { kind: 'fact', fact: ask.fact, to: !durable.facts[ask.fact] };
  // Rule 1: the marker is durable before the admission request leaves.
  const marker: Marker = { seq: durable.seq + 1, nonce: `n${++world.nonces}`, change };
  durable.marker = marker;
  volatile.handler = { seq: marker.seq, nonce: marker.nonce };
  send(world, { kind: 'admit', from: authority.name, seq: marker.seq, nonce: marker.nonce, change });
  return [...events, event('requested', `marker seq ${marker.seq}, admit sent`)];
}

function deliver(world: World, action: Extract<Action, { kind: 'deliver' }>, rules: Rules): Event[] {
  const { item, fate } = action;
  if (item.kind === 'row') {
    const authority = object(world, item.object);
    const row = authority.durable.outbox.find(candidate => candidate.seq === item.seq)!;
    if (fate === 'delivered') authority.durable.outbox = authority.durable.outbox.filter(candidate => candidate !== row);
    return applyRow(world.ports.get(incarnationOf(item.object))!, row, rules);
  }
  const index = world.network.findIndex(message => message.id === item.id);
  const message = world.network[index]!;
  if (fate !== 'duplicated') world.network.splice(index, 1);
  if (fate === 'lost') return [event('lost', 'the message never arrives')];
  if (message.kind === 'answer') return [receiveAnswer(world, message)];
  const answer = admit(world.ports.get(incarnationOf(message.from))!, issueOf(message.from), message, rules);
  send(world, { kind: 'answer', to: message.from, seq: message.seq, nonce: message.nonce, verdict: answer.verdict });
  return [event(answer.tag, answer.detail)];
}

function admit(port: Port, issue: IssueId, marker: Marker, rules: Rules): Answer {
  const { change, seq, nonce } = marker;
  const name = sequenceName(change, issue, seq);
  const mirror = port.mirror.get(issue);
  if (!mirror) return { verdict: 'refused', tag: 'refused-unknown', detail: `${name} refused, port ${port.incarnation} has no ${issue}` };
  if (port.admissions.some(admission => admission.issue === issue && admission.seq === seq && admission.nonce === nonce)) {
    return { verdict: 'admitted', tag: 'readmitted', detail: `${name} admitted again from its open admission` };
  }
  if (change.kind === 'claim') {
    const reservation = port.reservations.get(change.request) ?? { state: 'released' };
    if (reservation.state === 'bound') return { verdict: 'refused', tag: 'refused-reserved', detail: `${name} refused, ${change.request} is bound to ${reservation.issue}` };
    if (reservation.state === 'open') return { verdict: 'refused', tag: 'refused-reserved', detail: `${name} refused, ${change.request} is open for ${reservation.issue} seq ${reservation.seq}` };
    port.reservations.set(change.request, { state: 'open', issue, seq, nonce });
    port.admissions.push({ issue, seq, nonce, guarded: false });
    return { verdict: 'admitted', tag: 'admitted', detail: `${name} admitted` };
  }
  if (guarded(change)) {
    const open = [...port.blockers.get(issue) ?? []].find(blocker => !port.mirror.get(blocker)?.facts.closed);
    if (open) return { verdict: 'refused', tag: 'refused-blocked', detail: `${name} refused, blocker ${open} is not closed` };
  }
  if (change.fact === 'epic' && !change.to) {
    const child = [...port.parent].find(([, parent]) => parent === issue)?.[0];
    if (child) return { verdict: 'refused', tag: 'refused-children', detail: `${name} refused, ${child} is its child` };
  }
  port.admissions.push({ issue, seq, nonce, guarded: guarded(change) });
  const order = rules.order(change);
  // Mechanism 1: a restrictive change makes the mirror strict before the authority can commit it.
  if (order === 'port-first') {
    mirror.facts[change.fact] = change.to;
    mirror.floor[change.fact] = Math.max(mirror.floor[change.fact], seq);
  }
  return { verdict: 'admitted', tag: 'admitted', detail: `${name} admitted (${order === 'port-first' ? 'port first' : 'authority first'})` };
}

// The waiting handler resumes on its answer; a reset lost the handler, and then the answer reaches nobody.
function receiveAnswer(world: World, message: Extract<Message, { kind: 'answer' }>): Event {
  const authority = world.objects.get(message.to)!;
  const handler = authority.volatile.handler;
  if (handler?.nonce !== message.nonce) return event('answer-dropped', `no handler of ${message.to} waits for seq ${message.seq}`);
  authority.volatile.handler = null;
  const marker = currentMarker(authority, message.seq, message.nonce);
  if (!marker) return event('dropped', `seq ${message.seq} already ended`);
  if (message.verdict === 'refused') {
    endSequence(world, authority, 'abort');
    return event('aborted-refused', `aborted seq ${marker.seq}, the port refused`);
  }
  endSequence(world, authority, 'commit');
  return event('committed', `committed ${sequenceName(marker.change, issueOf(authority.name), marker.seq)}`);
}

// The handler stops waiting. The authority cannot tell a lost answer from a refusal, so both end in an abort row.
function finish(world: World, authority: Authority): Event {
  const handler = authority.volatile.handler!;
  authority.volatile.handler = null;
  if (!currentMarker(authority, handler.seq, handler.nonce)) return event('dropped', `seq ${handler.seq} already ended`);
  endSequence(world, authority, 'abort');
  return event('aborted-lost-reply', `no answer arrived, aborted seq ${handler.seq}`);
}

// A sequence ends only while its marker stands, so an age-out or a pull that aborted it wins over a late answer.
function currentMarker(authority: Authority, seq: number, nonce: Nonce): Marker | null {
  const { marker } = authority.durable;
  return marker?.seq === seq && marker.nonce === nonce ? marker : null;
}

// The only writer of rows and of durable.seq, so each admitted sequence ends as exactly one row (rule 2).
function endSequence(world: World, authority: Authority, end: Row['end']): Row {
  const { durable } = authority;
  const marker = durable.marker!;
  const { change } = marker;
  if (end === 'commit' && change.kind === 'fact') durable.facts[change.fact] = change.to;
  if (end === 'commit' && change.kind === 'claim') {
    const uid = ++world.uids;
    durable.claims.set(change.request, uid);
    recordIssued(world, `claim ${change.request}`, { uid, by: authority.name, step: world.step });
  }
  const claim = change.kind === 'claim' ? change.request : null;
  const row: Row = { issue: issueOf(authority.name), seq: marker.seq, nonce: marker.nonce, end, facts: { ...durable.facts }, claim };
  durable.seq = marker.seq;
  durable.marker = null;
  durable.ended.set(row.seq, row);
  durable.outbox.push(row);
  return row;
}

// The only port function that takes data from an authority, so the port cannot read and replace a fact (rule 4).
function applyRow(port: Port, row: Row, rules: Rules): Event[] {
  const mirror = port.mirror.get(row.issue);
  if (!mirror) return [];
  port.admissions = port.admissions.filter(admission => admission.issue !== row.issue || admission.seq > row.seq);
  const events = row.claim ? [applyClaim(port, row, row.claim, rules)] : [];
  if (row.seq < mirror.seq) return [event('row-stale', `${row.end} row seq ${row.seq} is below stored seq ${mirror.seq}`), ...events];
  events.unshift(event('row-applied', `${row.end} row seq ${row.seq} applied`));
  // Rule 3: only an admission raises a floor, and nothing lowers one.
  for (const fact of facts) {
    if (row.seq >= mirror.floor[fact]) mirror.facts[fact] = row.facts[fact];
    else events.push(event('row-below-floor', `${fact} kept below floor ${mirror.floor[fact]}`));
  }
  mirror.seq = row.seq;
  return events;
}

// Rule 5: a commit row binds the reservation, and bound is final.
function applyClaim(port: Port, row: Row, request: ClaimRequest, rules: Rules): Event {
  const before = port.reservations.get(request) ?? { state: 'released' };
  const was = before.state === 'released' ? 'released'
    : before.state === 'bound' ? `bound to ${before.issue}`
    : `opened by ${before.nonce === row.nonce ? 'this' : 'another'} nonce`;
  if (row.end === 'commit') {
    if (before.state !== 'bound') port.reservations.set(request, { state: 'bound', issue: row.issue, seq: row.seq });
    return event('reservation-bound', `reservation ${request} ${was} -> bound to ${row.issue}`);
  }
  const after = rules.afterAbort(before, row);
  port.reservations.set(request, after);
  return after.state === before.state
    ? event('reservation-kept', `reservation ${request} ${was} kept`)
    : event('reservation-released', `reservation ${request} ${was} -> released`);
}

function ageOut(world: World, action: Extract<Action, { kind: 'age-out' }>): Event[] {
  const admission = world.ports.get(action.port)!.admissions.find(open => open.issue === action.issue && open.seq === action.seq)!;
  // Rule 4: the port asks the authority to resolve and never reads and replaces a fact itself.
  const touched = touch(world, action.port, action.issue);
  if ('refused' in touched) return [touched.refused];
  return [...touched.events, resolve(world, touched.authority, admission.seq, admission.nonce)];
}

function resolve(world: World, authority: Authority, seq: number, nonce: Nonce): Event {
  const { durable } = authority;
  if (currentMarker(authority, seq, nonce)) {
    endSequence(world, authority, 'abort');
    return event('resolve-abort', `${authority.name} aborted seq ${seq}`);
  }
  const row = durable.ended.get(seq);
  if (!row) return event('resolve-unknown', `${authority.name} never admitted seq ${seq}`);
  if (!durable.outbox.includes(row)) durable.outbox.push(row);
  return event('resolve-reemit', `${authority.name} re-emitted ${row.end} row seq ${seq}`);
}

function create(world: World, action: Extract<Action, { kind: 'create' }>): Event[] {
  const port = currentPort(world);
  const replayed = port.receipts.get(action.request);
  if (replayed) return [event('creation-replayed', `${action.request} already created ${replayed.issue}`), ...init(world, port, replayed.issue, action.init)];
  if (action.parent !== null && !port.mirror.get(action.parent)?.facts.epic) {
    return [event('creation-refused', `parent ${action.parent} is not an epic`)];
  }
  const issue: IssueId = `i${++port.counter}`;
  const created: Facts = { closed: false, epic: action.epic };
  const uid = ++world.uids;
  port.receipts.set(action.request, { request: action.request, issue, parent: action.parent, facts: created, incarnation: port.incarnation, uid });
  port.mirror.set(issue, { facts: { ...created }, seq: 0, floor: { closed: 0, epic: 0 } });
  if (action.parent !== null) port.parent.set(issue, action.parent);
  recordIssued(world, `create ${action.request}`, { uid, by: `port ${port.incarnation}`, step: world.step });
  return [event('created', `created ${issue}`), ...init(world, port, issue, action.init)];
}

function recordIssued(world: World, key: RequestKey, receipt: Issued): void {
  world.issued.set(key, [...world.issued.get(key) ?? [], receipt]);
}

// A lost init leaves the first later touch to make the authority.
function init(world: World, port: Port, issue: IssueId, delivery: 'delivered' | 'lost'): Event[] {
  if (delivery === 'lost') return [];
  const touched = touch(world, port.incarnation, issue);
  return 'refused' in touched ? [touched.refused] : touched.events;
}

function addEdge(world: World, action: Extract<Action, { kind: 'add-edge' }>): Event[] {
  const port = currentPort(world);
  if (reaches(port, action.blocker, action.dependent)) return [event('edge-refused', `${action.blocker} already depends on ${action.dependent}`)];
  port.blockers.set(action.dependent, new Set([...port.blockers.get(action.dependent) ?? [], action.blocker]));
  return [event('edge-added', `${action.dependent} depends on ${action.blocker}`)];
}

function reaches(port: Port, from: IssueId, to: IssueId): boolean {
  const seen = new Set<IssueId>();
  const pending = [from];
  for (let issue = pending.pop(); issue !== undefined; issue = pending.pop()) {
    if (issue === to) return true;
    if (seen.has(issue)) continue;
    seen.add(issue);
    pending.push(...port.blockers.get(issue) ?? []);
  }
  return false;
}

// Every request to an object goes through touch, so an empty object is filled in exactly one place.
function touch(world: World, incarnation: Incarnation, issue: IssueId): Touched {
  const name: ObjectName = `${incarnation}:${issue}`;
  const existing = world.objects.get(name);
  if (existing) return { authority: existing, events: [] };
  const receipt = [...world.ports.get(incarnation)!.receipts.values()].find(candidate => candidate.issue === issue);
  if (!receipt) return { refused: event('refused-unknown', `${incarnation} has no creation receipt for ${issue}`) };
  const authority: Authority = {
    name,
    durable: { facts: { ...receipt.facts }, seq: 0, marker: null, ended: new Map(), outbox: [], claims: new Map() },
    volatile: { handler: null },
  };
  world.objects.set(name, authority);
  return { authority, events: [event('created-from-receipt', `${name} created from its own receipt`)] };
}

// Owns atomic lease transitions and proof predicates; transports supply validated commands and actors.
import type { SqlStatement } from './issues.ts';

export type ClaimProof = { issue_id: string; incarnation: string; session_id: string; generation: number };
export type ClaimMutation =
  | { op: 'claim_acquire'; issue_id: string; incarnation: string; session_id: string; request_id: string; ttl: number; agent_label: string | null }
  | { op: 'claim_renew'; claim_proof: ClaimProof; expected_revision: number; request_id: string; ttl: number }
  | { op: 'claim_release'; claim_proof: ClaimProof; expected_revision: number; request_id: string };
const counter = "INTEGER NOT NULL CHECK(typeof(%s) = 'integer' AND %s BETWEEN 1 AND 9007199254740991)";
const numeric = (column: string) => counter.replaceAll('%s', column);
export const CLAIM_STATEMENTS = [
  `CREATE TABLE issue_claims (
    issue_id TEXT PRIMARY KEY NOT NULL REFERENCES issues(id),
    incarnation TEXT NOT NULL CHECK(length(incarnation) = 32 AND incarnation NOT GLOB '*[^a-f0-9]*'),
    actor TEXT NOT NULL CHECK(length(actor)>0 AND length(CAST(actor AS BLOB))<=256),
    session_id TEXT NOT NULL CHECK(length(session_id)=36),
    agent_label TEXT CHECK(agent_label IS NULL OR (length(agent_label)>0 AND length(CAST(agent_label AS BLOB))<=64)),
    generation ${numeric('generation')}, revision ${numeric('revision')},
    acquired_at INTEGER NOT NULL CHECK(typeof(acquired_at)='integer' AND acquired_at>=0),
    changed_at INTEGER NOT NULL CHECK(typeof(changed_at)='integer' AND changed_at>=acquired_at),
    expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at>acquired_at),
    released_at INTEGER CHECK(released_at IS NULL OR (typeof(released_at) = 'integer' AND released_at=changed_at))
  )`,
  `CREATE TABLE claim_requests (
    request_id TEXT PRIMARY KEY NOT NULL CHECK(length(request_id)=36),
    actor TEXT NOT NULL CHECK(length(actor)>0 AND length(CAST(actor AS BLOB))<=256), payload TEXT NOT NULL CHECK(json_valid(payload)),
    issue_id TEXT NOT NULL REFERENCES issues(id), incarnation TEXT NOT NULL,
    session_id TEXT NOT NULL CHECK(length(session_id)=36), agent_label TEXT CHECK(agent_label IS NULL OR (length(agent_label)>0 AND length(CAST(agent_label AS BLOB))<=64)),
    generation ${numeric('generation')}, revision ${numeric('revision')},
    acquired_at INTEGER NOT NULL CHECK(typeof(acquired_at)='integer' AND acquired_at>=0),
    changed_at INTEGER NOT NULL CHECK(typeof(changed_at)='integer' AND changed_at>=acquired_at),
    expires_at INTEGER NOT NULL CHECK(typeof(expires_at)='integer' AND expires_at>acquired_at),
    released_at INTEGER CHECK(released_at IS NULL OR (typeof(released_at)='integer' AND released_at=changed_at)),
    created_at INTEGER NOT NULL CHECK(typeof(created_at)='integer' AND created_at=changed_at),
    outcome TEXT NOT NULL CHECK(outcome IN ('acquired','renewed','released')),
    CONSTRAINT claim_receipt_incarnation CHECK(length(incarnation) = 32 AND incarnation NOT GLOB '*[^a-f0-9]*'),
    CHECK((outcome='released' AND released_at IS NOT NULL) OR (outcome<>'released' AND released_at IS NULL))
  )`,
  `CREATE TRIGGER claim_requests_immutable_update BEFORE UPDATE ON claim_requests BEGIN SELECT RAISE(ABORT,'claim_receipt_immutable'); END`,
  `CREATE TRIGGER claim_requests_immutable_delete BEFORE DELETE ON claim_requests BEGIN SELECT RAISE(ABORT,'claim_receipt_immutable'); END`,
];
const columns = 'request_id,actor,payload,issue_id,incarnation,session_id,agent_label,generation,revision,acquired_at,changed_at,expires_at,released_at,created_at,outcome';
export function claimProofPredicate(proof: ClaimProof, actor: string): SqlStatement {
  return { sql: `EXISTS(SELECT 1 FROM issue_claims JOIN memory_store_identity ON singleton = 1
    WHERE issue_claims.issue_id = ? AND issue_claims.incarnation = ? AND memory_store_identity.incarnation = ?
    AND actor = ? AND session_id = ? AND generation = ? AND released_at IS NULL AND expires_at > unixepoch())`,
  params: [proof.issue_id, proof.incarnation, proof.incarnation, actor, proof.session_id, proof.generation] };
}
export function issueClaimGuard(issue_id: string, proof: ClaimProof | undefined, changesStatus: boolean, actor: string): SqlStatement {
  if (proof) {
    const ownership = claimProofPredicate(proof, actor);
    return { sql: `(? = ? AND ${ownership.sql})`, params: [issue_id, proof.issue_id, ...ownership.params] };
  }
  return changesStatus
    ? { sql: 'NOT EXISTS(SELECT 1 FROM issue_claims WHERE issue_id = ?)', params: [issue_id] }
    : { sql: '1', params: [] };
}
export function claimMutationStatements(command: ClaimMutation, actor: string): readonly SqlStatement[] {
  const issue = command.op === 'claim_acquire' ? command.issue_id : command.claim_proof.issue_id;
  const payload = JSON.stringify(command);
  const replay: SqlStatement = { sql: `INSERT INTO claim_requests(${columns}) SELECT ${columns} FROM claim_requests WHERE request_id = ?`, params: [command.request_id] };
  let admission: SqlStatement;
  if (command.op === 'claim_acquire') {
    admission = { sql: `INSERT INTO claim_requests(${columns})
      SELECT ?,?,?,issues.id,identity.incarnation,?,?,COALESCE(claim.generation,0)+1,COALESCE(claim.revision,0)+1,unixepoch(),unixepoch(),unixepoch()+?,NULL,unixepoch(),'acquired'
      FROM issues CROSS JOIN memory_store_identity AS identity LEFT JOIN issue_claims AS claim ON claim.issue_id = issues.id
      WHERE issues.id = ? AND identity.singleton = 1 AND identity.incarnation = ?
      AND (claim.issue_id IS NULL OR claim.incarnation <> identity.incarnation OR claim.released_at IS NOT NULL OR claim.expires_at <= unixepoch())
      AND COALESCE(claim.generation,0) < 9007199254740991 AND COALESCE(claim.revision,0) < 9007199254740991`,
    params: [command.request_id, actor, payload, command.session_id, command.agent_label, command.ttl, issue, command.incarnation] };
  } else {
    const proof = claimProofPredicate(command.claim_proof, actor);
    admission = { sql: `INSERT INTO claim_requests(${columns})
      SELECT ?,?,?,issue_id,incarnation,session_id,agent_label,generation,revision+1,acquired_at,unixepoch(),${command.op === 'claim_renew' ? 'unixepoch()+?' : 'expires_at'},${command.op === 'claim_release' ? 'unixepoch()' : 'NULL'},unixepoch(),?
      FROM issue_claims WHERE issue_id = ? AND revision = ? AND revision < 9007199254740991 AND ${proof.sql}`,
    params: [command.request_id, actor, payload, ...(command.op === 'claim_renew' ? [command.ttl] : []), command.op === 'claim_renew' ? 'renewed' : 'released', issue, command.expected_revision, ...proof.params] };
  }
  return [replay, admission,
    { sql: `INSERT INTO issue_claims(issue_id,incarnation,actor,session_id,agent_label,generation,revision,acquired_at,changed_at,expires_at,released_at)
      SELECT issue_id,incarnation,actor,session_id,agent_label,generation,revision,acquired_at,changed_at,expires_at,released_at FROM claim_requests WHERE request_id = ?
      ON CONFLICT(issue_id) DO UPDATE SET incarnation=excluded.incarnation,actor=excluded.actor,session_id=excluded.session_id,
      agent_label=excluded.agent_label,generation=excluded.generation,revision=excluded.revision,acquired_at=excluded.acquired_at,changed_at=excluded.changed_at,expires_at=excluded.expires_at,released_at=excluded.released_at`, params: [command.request_id] },
    { sql: `INSERT INTO schema_version(version) SELECT 0 FROM claim_requests AS receipt WHERE request_id = ? AND NOT EXISTS(
      SELECT 1 FROM issue_claims AS claim WHERE claim.issue_id = receipt.issue_id AND claim.incarnation = receipt.incarnation
      AND claim.actor = receipt.actor AND claim.session_id = receipt.session_id AND claim.agent_label IS receipt.agent_label
      AND claim.generation = receipt.generation AND claim.revision = receipt.revision AND claim.acquired_at=receipt.acquired_at AND claim.changed_at=receipt.changed_at AND claim.expires_at = receipt.expires_at AND claim.released_at IS receipt.released_at)`, params: [command.request_id] },
    { sql: 'SELECT * FROM claim_requests WHERE request_id = ?', params: [command.request_id] },
  ];
}

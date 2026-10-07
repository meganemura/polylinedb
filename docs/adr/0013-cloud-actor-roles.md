# Give each cloud actor a role in the Worker roster

Status: accepted. Each cloud host connector gets its own Access identity.

## Problem

Local agents name an actor and the kind `agent`, and the store gates their writes.
An agent claims only an issue with the `ready` label, and it writes only under its own active claim.

The Worker allowlist held bare actor IDs, and every cloud caller ran as `human`.
So the gates never applied in the cloud store.
A cloud agent that signs in as the owner also writes as the owner, and its writes cannot be told apart from the owner's writes.

The owner wants three properties for the cloud store:

1. Distinct agent credentials give distinct actor IDs.
2. A person who signs in through Access single sign-on can be kept from writes.
3. An agent write without a valid claim fails, as it does locally.

## Decision

Each entry of `ACCESS_ACTORS` gives an actor a role:

| Role | Actor kind | Writes |
| --- | --- | --- |
| `human` | `human` | Allowed under the cooperative contract. |
| `agent` | `agent` | Allowed through the `ready` label gate and the claim gate. |
| `reader` | `human` | Rejected with `read_only_actor`. |

An entry is an actor ID or an object with exactly `actor` and `role`.
An actor ID alone means `human`, so an owner-only allowlist keeps its meaning.
A duplicate actor ID, an unknown role, or an extra key makes the whole configuration invalid, and every request then gets `invalid_access_configuration`.

The Access verifier returns the actor, its kind, and its access level.
The Worker entry rejects a write operation from a `reader` before dispatch, on both `/mcp` and `/v1/operations`.
The operation policy that names each operation `read` or `write` decides which operations count as writes.
Claim acquisition, renewal, and release are writes, so a reader cannot claim.

The Worker passes the actor and its kind to the same record operations as the local CLI.
An `agent` caller then meets the same SQL conditions that gate a local agent.
The roles live in the Worker configuration and do not depend on the authentication method.
An `access:` actor can be an agent, and a `service:` actor can be a human.

Each Access service token keeps its own `service:<common_name>` actor.
Two tokens therefore claim and write as two actors.
The claim lease and the comment author record that actor; the agent label stays display text.

## Consequences

- An owner can make the single sign-on actor a `reader` and move writes to per-host identities and local service tokens.
  The roster expresses that choice, and the operator applies it at deployment.
- An owner-only roster keeps the behavior of the earlier allowlist.
- The lease rows from `claim_show` and `claim_list` carry the token-derived actor.
  An attention view can show that actor without new storage.
- The `actor` tool returns the actor ID only.
  A gated write shows the kind: an agent gets `not_ready` or `claim_required` where a human succeeds.

## Per-agent identity for cloud host connectors

Cloud hosts such as Cursor, Claude, Codex, and ChatGPT link through OAuth and Access.
Each link signs in as a person, so the host gets that person's `access:` actor.
The [cloud guide](../cloud.md#use-service-tokens-only-from-a-local-client) keeps service tokens out of cloud agent machines.

Each cloud host links as its own Access identity, a separate user of the identity provider.
The roster lists that identity as `{"actor": "access:HOST_SUBJECT", "role": "agent"}`.
The Worker needs no change for this, because the roster already maps any `access:` actor to a role.

The rollout keeps writes available at each step:

1. Deploy the roster code with the owner-only roster. Behavior does not change.
2. Create one identity for each host, and add each one to the roster with the role `agent`.
3. Link each host again as its own identity. Confirm the actor with the `actor` tool and the agent kind with a claim on an issue without the `ready` label, which returns `not_ready`.
4. Change the owner's entry to `reader` only after every host writes as its own actor.

## Alternatives

- Derive the kind from the prefix, `access:` as human and `service:` as agent.
  This ties a policy to a credential type and cannot express a read-only person or a human command-line client that uses a service token.
- Make every `access:` actor read-only by default.
  This removes writes from every cloud host connector at the next deployment, before any host has another identity.
- Give each agent group its own Access application and audience.
  The subject of the assertion is the same person in every application, so the actor ID stays the owner's.
  A distinct actor would need the Worker to derive actors from the audience, which is a second identity scheme.
- Keep a separate list of reader actors.
  Two lists can disagree about one actor; one entry for each actor cannot.

# Give each local agent its own actor

Run every local agent under its own actor, so claims, updates, and comments name the agent that wrote them.
This guide covers local stores.
Cloud stores derive the actor from authentication, and per-agent cloud actors need separate tokens.

## Choose one actor per agent host

Give each host a stable actor ID, for example:

| Host | Actor | Kind |
| --- | --- | --- |
| Codex | `local:codex` | `agent` |
| Claude Code | `local:claude` | `agent` |
| Cursor | `local:cursor` | `agent` |
| A dispatch agent | `local:rocky` | `agent` |
| You at a terminal | `local:<your name>` | `human` |

The actor is attribution, not a credential.
Local filesystem permissions protect the store.
The `--agent-label` value of a claim is display text and does not identify the holder.

## Set the actor in the host environment

Set two variables in the environment that the host gives to its shell commands:

```sh
POLYLINEDB_ACTOR=local:claude
POLYLINEDB_ACTOR_KIND=agent
```

Put them in the host's user-level or untracked settings.
For Claude Code, the `env` block of `~/.claude/settings.json` or of the untracked `.claude/settings.local.json` sets them for every command.
For other hosts, use the environment settings that the host keeps outside the repository.
Do not put them in tracked files, because every clone would then share one agent identity.

Give each session its own `POLYLINEDB_SESSION_ID` as well, as the [ownership guide](claims.md) describes.

## Check the result

Run these commands from the agent:

```sh
pd actor
pd claim list --project PROJECT --limit 50
```

`pd actor` prints the actor of the agent.
After the agent claims an issue, `claim list` shows that actor as the lease holder.

An agent command fails with `invalid_input` when the agent has no actor of its own.
The repository actor from `pd init --actor` is shared by every agent in the checkout, so an agent cannot use it.
A command without `POLYLINEDB_ACTOR_KIND` or `--actor-kind` runs as `human`.

## Know what the agent kind changes

An agent claims only issues with the `ready` label.
An agent changes an issue only while it holds an active claim on it.
See [gate agent work](claims.md#gate-agent-work) for the full rule.

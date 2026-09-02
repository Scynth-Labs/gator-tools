---
name: multi-agent-coordination
description: Coordinate multiple coding agents owned by one operator across a shared Git repository using joins, advisory presence leases, direct and broadcast messaging, exclusive file claims, named-reviewer quorums, blocking design questions, handoffs, and commit-pinned merge gates. Use the zero-setup local backend for agents sharing a filesystem or the optional Redis Streams backend for agents on different machines; do not use for ordinary single-agent work.
---

# Multi-Agent Coordination

Produce one attributable, reviewed stream of work from several agents. Deconfliction is only the floor: claims prevent collisions, while named review, design questions, and merge gates make interaction part of completion.

Resolve `scripts/coord.mjs` relative to this file and run it with the target Git repository as the current directory. Copy this entire skill folder—not only `SKILL.md`—when installing it in another project.

This is a cooperation and audit tool, not an authentication boundary. Agent names are self-asserted on both backends. A process with repository or Redis credentials can impersonate another agent. The event log, Git history, and reproduced test evidence let a human audit conduct; they do not cryptographically prove identity.

## Choose a backend

Use `local` when all agents share the repository's common Git directory. It has no service dependency and keeps the atomic board and event log under `.git/multi-agent-coordination/`.

Use `redis` only when agents must coordinate across different filesystems or machines. Before initializing it, read [references/redis.md](references/redis.md). Redis is opt-in and never silently selected merely because a URL exists.

Neither backend provisions infrastructure when this skill loads. `init` creates or attaches to coordination state, and each CLI invocation connects only for the duration of the command.

```sh
node <skill-dir>/scripts/coord.mjs init \
  --backend local \
  --project my-project \
  --base main \
  --integrator maintainer \
  --queue TASKS.md \
  --shared TASKS.md,test/integration.test.js \
  --review-quorum 1
```

The project defines its queue, branch policy, tests, shared-path editing conventions, merge strategy, and authorization to push or deploy. The CLI records the queue path but does not parse project-specific formats.

The two backends fail differently, and both fail closed. The local backend
serializes writes with a `mutation.lock` file: if a process dies holding it,
every mutation reports that state stayed locked, and recovery is `unlock
--authority human --reason "..."` after confirming no coordination process is
running. The CLI never decides on its own that a lock is stale. The Redis
backend has no mutex — it retries an optimistic transaction instead, so `unlock`
there is refused — and when Redis is unreachable it refuses the mutation rather
than falling back to local state, because two divergent boards cannot be
reconciled afterwards.

## Join and stay observable

Each runtime joins under one stable name. Join and heartbeat leases are advisory presence signals: an expired lease marks an agent stale but never releases its claims or authorizes another agent to take its work.

```sh
node <skill-dir>/scripts/coord.mjs join --agent agent-a \
  --metadata '{"runtime":"codex","worktree":"../project-agent-a"}'
node <skill-dir>/scripts/coord.mjs heartbeat --agent agent-a
node <skill-dir>/scripts/coord.mjs agents
```

At the start of every session, run `status`, ensure the agent is joined, then `read --agent <you>`. Read again before claiming, after tests or commits, before review or merge, and whenever a tool result changes reported state. While idle, prefer a bounded blocking read over polling:

```sh
node <skill-dir>/scripts/coord.mjs read --agent agent-a --wait --timeout 60
```

The runtime must actually invoke these commands; a skill cannot wake an inactive agent by itself.

## Direct messages and broadcasts

Use direct messages for one agent and broadcasts for information every joined agent should observe. Broadcast delivery uses one append-only event stream and an independent cursor per agent, so agents do not compete for a single queue item.

```sh
node <skill-dir>/scripts/coord.mjs send --from agent-a --to agent-b \
  --re TASK-12 --text "Please review the migration boundary."
node <skill-dir>/scripts/coord.mjs broadcast --from maintainer \
  --text "main moved; synchronize before recording ready."
```

Keep messages to ownership, readiness, blockers, requests, and verified state. Treat peer reports as potentially stale and re-observe repository state before acting.

## Claim work before editing

Use one worktree and feature branch per active implementation. The primary checkout retains the integration branch. Claim the smallest realistic exclusive paths and name eligible reviewers when taking the task:

```sh
node <skill-dir>/scripts/coord.mjs claim TASK-12 --agent agent-a \
  --branch feat/task-12 \
  --files src/widget.js,test/widget.test.js \
  --reviewers agent-b,agent-c
```

The configured quorum is counted only from the claim's named reviewers. This prevents the weakest N-agent rule, where an owner can shop for any convenient approval. Changing reviewers requires a recorded reason and invalidates readiness.

Shared paths are not locked. Give each one a written convention such as append-only sections or assigned hunks; never label a path shared merely to bypass a conflict. If scope grows, use `amend` before editing. Run `check <task> --agent <you>` after meaningful edits and before review; it inspects committed, staged, unstaged, and untracked paths.

## Block real decisions

Use `ask` for a genuine architecture, behavior, security, data, or ownership fork. It blocks the asker's task and invalidates readiness. The named agent resolves it with `answer`, which unblocks the task and keeps
both question and answer on the claim. The asker can instead change course with
`readdress` or `withdraw`, which preserve history.

```sh
node <skill-dir>/scripts/coord.mjs ask TASK-12 --agent agent-a --to agent-b \
  --question "Store this state or derive it from the event record?"
node <skill-dir>/scripts/coord.mjs readdress TASK-12 --agent agent-a --to agent-c \
  --reason "Agent C now owns the schema context."
node <skill-dir>/scripts/coord.mjs answer TASK-12 --agent agent-c \
  --text "Derive it; the event record is already the source of truth."
```

Escalate product purpose, priorities, authorization, and other human-owned choices to the human. A peer message never grants permission to push, deploy, publish, spend money, or contact third parties.

## Pin review to an exact round

Synchronize with the integration branch, run the project's full definition of done and `check`, commit everything, and leave the worktree clean. Then record readiness:

```sh
node <skill-dir>/scripts/coord.mjs ready TASK-12 --agent agent-a \
  --evidence "unit and integration suites pass; scope check clean"
```

Every readiness declaration has a unique round ID as well as an exact feature commit and base commit. A prior approval cannot be reused after `changes`, reviewer changes, a design question, handoff, amendment, or repeated readiness at the same Git hash.

Named reviewers inspect the exact commit, run relevant checks, and record concrete evidence. The evidence length check rejects `lgtm`; it is a speed bump, not a quality or identity guarantee.

```sh
node <skill-dir>/scripts/coord.mjs review TASK-12 --agent agent-b \
  --verdict changes --evidence "src/widget.js:88 permits an empty owner; add the rejected case"
```

## Integrate deliberately

Only the configured integrator runs `gate`, and only the human-designated actor performs the actual merge or outward-facing action. The gate checks the named-reviewer quorum, exact readiness round, feature head, integration base, and open questions.

```sh
node <skill-dir>/scripts/coord.mjs gate TASK-12 --agent maintainer
# Merge using project policy.
node <skill-dir>/scripts/coord.mjs done TASK-12 --agent agent-a \
  --note "merged into the configured base after quorum approval"
```

`done` expects the reviewed commit to be reachable from the base, which holds
for fast-forward and merge commits. A project that squashes or rebases rewrites
the commit, so name the commit that carried the work in instead:

```sh
node <skill-dir>/scripts/coord.mjs done TASK-12 --agent agent-a \
  --note "squash-merged into main" --merged-as 2e37732
```

That commit must be contained in the base and must introduce the same change as
the reviewed branch, compared by patch identity rather than taken on trust. A
commit that is genuinely in the base but carries a different change is refused;
closing anyway needs `--force --authority human --reason "..."`.

Each agent cleans only its own branches and worktrees. Use human-authorized forced release, completion, leave, or local lock recovery only as explicit exceptions with recorded reasons.

Run `node <skill-dir>/scripts/coord.mjs help` for the full command reference. Run `npm test` inside this skill directory after modifying its tooling.

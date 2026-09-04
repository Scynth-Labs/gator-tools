---
name: multi-agent-coordination
description: Coordinate multiple coding agents owned by one operator across a shared Git repository so they work different aspects of it at the same time and review each other, using planned parallel lanes with provably disjoint file scope, a prioritized next-action worklist, joins, advisory presence leases, direct and broadcast messaging, exclusive file claims, named-reviewer quorums, blocking design questions, handoffs, and commit-pinned merge gates. Use the zero-setup local backend for agents sharing a filesystem or the optional Redis Streams backend for agents on different machines; do not use for ordinary single-agent work.
---

# Multi-Agent Coordination

Produce one attributable, reviewed stream of work from several agents working different aspects of it at the same time. Deconfliction is only the floor: claims prevent collisions, while planned lanes, named review, design questions, and merge gates make parallel work and interaction part of completion.

Several agents are faster than one only while they are building different things concurrently. An agent that spends a session waiting to review is a serial agent with extra steps, so plan the lanes first and let `next` keep every agent pointed at the most useful thing it could be doing.

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
  --review-quorum 1 \
  --base-advance disjoint \
  --review-debt-limit 900
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

## Plan the parallel lanes

Decide the split before anyone edits. A lane is one aspect of the project, one assignee, one set of exclusive paths, and its named reviewers. Recording it is what stops a second agent from drifting into being a reviewer and nothing else.

```sh
node <skill-dir>/scripts/coord.mjs assign TASK-12 --agent maintainer --to agent-a \
  --aspect "storage layer" --files src/store/,test/store.test.js --reviewers agent-b
node <skill-dir>/scripts/coord.mjs assign TASK-13 --agent maintainer --to agent-b \
  --aspect "http surface" --files src/http/,test/http.test.js --reviewers agent-a \
  --needs TASK-12
```

`assign` refuses a lane whose paths overlap another lane or an active claim. Overlapping scope is not parallel work, and learning that while planning costs nothing; learning it from a merge conflict costs a round. Scope each lane so the disjointness is real. Where two aspects genuinely share a file, either give that file a shared-path convention or sequence the lanes with `--needs`.

`--needs` orders lanes without serializing them. A lane may be claimed once what it depends on has a reviewed commit to build against, and may not be declared ready until that dependency has merged — so a lane's own review never covers work that can still change underneath it.

`status` shows the lanes beside the live claims, with what each is blocked by and how many are startable right now. If that number is zero while agents are idle, the plan is the bottleneck, not the agents.

## Join and stay observable

Each runtime joins under one stable name. Join and heartbeat leases are advisory presence signals: an expired lease marks an agent stale but never releases its claims or authorizes another agent to take its work.

```sh
node <skill-dir>/scripts/coord.mjs join --agent agent-a \
  --metadata '{"runtime":"codex","worktree":"../project-agent-a"}'
node <skill-dir>/scripts/coord.mjs heartbeat --agent agent-a
node <skill-dir>/scripts/coord.mjs agents
```

## Work the list, starting with what a partner is blocked on

At the start of every session, ensure the agent is joined, then ask what to do:

```sh
node <skill-dir>/scripts/coord.mjs next --agent agent-a
```

`next` answers in one place and in priority order: what a partner is currently blocked on waiting for you, what your own claims need, and which of your lanes are free to start. Work it from the top. A partner's blocked round outranks your own implementation, because they cannot proceed and you can — a review that waits an hour costs the whole hour twice.

Run `next` again before claiming, after tests or commits, before review or merge, and whenever a tool result changes reported state. `read` drains the messages addressed to you; `next` says what to do about the state they describe. While idle, prefer a bounded blocking read over polling:

```sh
node <skill-dir>/scripts/coord.mjs read --agent agent-a --wait --timeout 60
```

Every other command ends by naming whoever is blocked on you. That line is not decoration. A long implementation session is exactly where an agent stops noticing that its partner recorded readiness an hour ago and has been idle since. When the project sets `--review-debt-limit`, claiming and readying are refused outright while a partner has been blocked past it; discharge it with `review` or `answer`, neither of which is ever gated, then continue.

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

Use one worktree and feature branch per active implementation, so lanes progress at the same time instead of taking turns with one checkout. The primary checkout retains the integration branch.

Claiming an assigned lane inherits its paths and reviewers; only the assignee may take it:

```sh
node <skill-dir>/scripts/coord.mjs claim TASK-12 --agent agent-a --branch feat/task-12
```

Without a lane, claim the smallest realistic exclusive paths and name eligible reviewers when taking the task:

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

Under the default `--base-advance strict`, any movement of the integration branch also ends the round. With several lanes merging that is most of a round's life, and each peer merge costs every other lane a full ready-and-review cycle, so a project running lanes in parallel should initialize with `--base-advance disjoint`. A round then survives a base advance that git proves touched none of the files that claim declared, and the advance is recorded on the round along with how many files it moved. It proves exactly that and nothing more: whether two lanes are semantically compatible is what the project's merge-time checks are for. An advance that reaches into the claim's own paths, or a base that was rewritten rather than advanced, still ends the round at both `review` and `gate`.

A project already running on an older board keeps the strict default until its integrator changes it on the board, which is one recorded act rather than an edit to a local file the other agents never see:

```sh
node <skill-dir>/scripts/coord.mjs policy --agent maintainer \
  --base-advance disjoint --review-debt-limit 900 \
  --reason "four lanes now land per day and every merge was costing three rounds"
```

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

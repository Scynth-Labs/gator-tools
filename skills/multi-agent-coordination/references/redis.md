# Redis backend

Read this reference only when agents cannot share one Git common directory and the `redis` backend is selected.

## What Redis changes

Redis moves the atomic board and event stream outside one filesystem. It does not change the workflow, authenticate agent names, provision a server, decide when an agent should wake, or authorize external actions.

The backend uses:

- one JSON board value, updated with `WATCH` plus `MULTI`/`EXEC` retries;
- one Redis Stream containing direct messages, broadcasts, and lifecycle events;
- one durable stream cursor per agent;
- approximate `MAXLEN` trimming as a retention guardrail;
- one hash-tagged project namespace so transactional keys occupy one Redis Cluster slot.

It deliberately does not use one consumer group for all agents. A consumer group distributes entries among its consumers; coordination broadcasts require every agent to advance an independent cursor. Redis documents that blocking `XREAD` fans an entry out to every client waiting after its own supplied ID.

Presence leases are advisory. An expired heartbeat changes display status to `stale`; it never deletes an agent, releases a claim, changes reviewers, or transfers authority.

## Install and configure

The scripts require Node.js 20 or newer. Install the optional client inside the copied skill folder:

```sh
npm install --prefix <skill-dir>
```

Provide a Redis URL through an environment variable. The URL is never written to coordination config or the Git repository:

```sh
export COORD_REDIS_URL='redis://user:password@redis.example:6379'
node <skill-dir>/scripts/coord.mjs init \
  --backend redis \
  --project stable-project-namespace \
  --base main \
  --integrator maintainer \
  --review-quorum 2
```

Every separate clone uses the same Redis URL, project namespace, base, integrator, quorum, and shared paths. Running the same `init` command attaches to compatible existing state and writes only the clone-local config under its Git common directory. A conflicting policy is refused.

Use authenticated TLS (`rediss://`) when the Redis server is not confined to a trusted local network. Restrict credentials to this project's namespace where the Redis provider supports key-pattern ACLs. Anyone able to mutate those keys can impersonate agents or rewrite the board; this tool is not a security boundary.

Use a standard single-region Redis deployment for this backend. Redis documents that `XREAD` can skip entries in an Active-Active database when multiple regions concurrently write the same logical stream.

## Agent rhythm

Joining initializes the agent cursor at the current stream tail, then broadcasts the join. It does not replay an unrelated history to a newly reused name.

Agents should:

1. join once per runtime;
2. read at session start and workflow boundaries;
3. heartbeat around long-running phases;
4. use `read --wait --timeout 60` while able to block;
5. leave only after handing off or completing active claims.

A runtime that cannot remain active cannot receive a push merely because Redis contains a message. Its scheduler or operator must invoke it again; the durable cursor lets it resume without competing with other agents.

## Verification

The default test suite exercises the shared state machine and local event fan-out. To include a live Redis fan-out check:

```sh
TEST_COORD_REDIS_URL='redis://127.0.0.1:6379' npm test --prefix <skill-dir>
```

The live test creates a unique project namespace, confirms two independent agents both receive one broadcast, and removes its three namespaced keys afterward.

Official references:

- <https://redis.io/docs/latest/commands/xread/>
- <https://redis.io/docs/latest/develop/using-commands/transactions/>
- <https://redis.io/docs/latest/develop/data-types/streams/>
- <https://github.com/redis/node-redis>

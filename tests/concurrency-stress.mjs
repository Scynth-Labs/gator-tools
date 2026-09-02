#!/usr/bin/env node
// Stress the local backend's mutation lock with genuinely concurrent writers.
//
// The unit suite exercises the coordination state machine in one process, where
// the lock is never actually contended. This runs many real CLI processes at
// once against one repository and asserts the invariant that matters: every
// accepted mutation survives, and no two agents ever hold the same claim.
//
//   node tests/concurrency-stress.mjs [--agents 12] [--rounds 3]
//
// A lost update here means an agent's claim silently vanished, which in a real
// session is two agents editing the same files believing they are alone.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function option(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
}

const agents = option("agents", 12);
const rounds = option("rounds", 3);
const COORD = new URL("../skills/multi-agent-coordination/scripts/coord.mjs", import.meta.url).pathname;

const repository = mkdtempSync(join(tmpdir(), "coord-stress-"));
const git = (...args) => execFileSync("git", args, { cwd: repository, encoding: "utf8" });
const coord = (...args) => execFileSync(process.execPath, [COORD, ...args], { cwd: repository, encoding: "utf8" });

function run(args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [COORD, ...args], { cwd: repository });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stderr }));
  });
}

try {
  git("init", "-q", "-b", "main");
  writeFileSync(join(repository, "TASKS.md"), "# Queue\n"); // init verifies the queue exists
  git("add", "TASKS.md");
  git("-c", "user.email=stress@example.invalid", "-c", "user.name=Stress", "commit", "-q", "-m", "root");
  coord("init", "--backend", "local", "--project", "stress", "--base", "main", "--integrator", "a0", "--queue", "TASKS.md", "--review-quorum", "1");

  const names = Array.from({ length: agents }, (_, i) => `a${i}`);

  // Every agent joins at once. Joining mutates shared state, so this alone
  // contends the lock hard.
  const joins = await Promise.all(names.map((name) => run(["join", "--agent", name])));
  const joined = joins.filter((r) => r.code === 0).length;
  assert.equal(joined, agents, `every join should succeed; ${agents - joined} failed`);

  const listed = coord("agents");
  for (const name of names) {
    assert.ok(listed.includes(name), `${name} joined but is absent from the board — a lost update`);
  }

  // A claim refuses a branch that does not exist locally, so every racer gets a
  // real one first. The race is then purely about the claim, not about setup.
  for (const name of names) {
    for (let round = 0; round < rounds; round += 1) git("branch", `feat/${name}-${round}`, "main");
  }

  // Now the real contention: every agent races for the same claim, every round.
  // Exactly one must win each round, and the board must name that winner.
  for (let round = 0; round < rounds; round += 1) {
    const item = `R${round}`;
    const results = await Promise.all(
      names.map((name, index) => run([
        "claim", item,
        "--agent", name,
        "--branch", `feat/${name}-${round}`,
        "--files", `src/${round}.js`,
        // The board was initialised with a review quorum of 1, so a claim must
        // name a reviewer who is not the claimant.
        "--reviewers", names[(index + 1) % names.length],
      ])),
    );
    const winners = results.filter((r) => r.code === 0).length;
    const reasons = [...new Set(results.filter((r) => r.code !== 0).map((r) => r.stderr.trim().split("\n")[0]))];
    assert.equal(
      winners,
      1,
      `round ${round}: ${winners} agents took the same claim; exclusivity is the whole point.\nrefusals: ${JSON.stringify(reasons, null, 2)}`,
    );

    const status = coord("status");
    assert.ok(status.includes(item), `round ${round}: the winning claim is missing from the board`);
  }

  // Nothing above may have corrupted the log the audit depends on.
  const log = coord("log", "--limit", "500");
  assert.ok(log.length > 0, "the event log is empty after concurrent mutation");

  process.stdout.write(`${agents} concurrent agents, ${rounds} contested rounds: exclusivity held and no update was lost\n`);
} finally {
  rmSync(repository, { recursive: true, force: true });
}

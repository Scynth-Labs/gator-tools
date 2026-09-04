import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { initialState, joinAgent } from "./core.mjs";
import { RedisStore } from "./redis-store.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "coord.mjs");

function git(repository, ...args) {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function coord(repository, args, expectedStatus = 0, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: repository,
    encoding: "utf8",
    env: { ...process.env, COORD_DIR: "", ...extraEnv },
  });
  assert.equal(result.status, expectedStatus, `coord ${args.join(" ")}\nstdout: ${result.stdout}\nstderr: ${result.stderr}`);
  return `${result.stdout}${result.stderr}`;
}

function blockingRead(repository, agent, extraEnv = {}) {
  const child = spawn(process.execPath, [script, "read", "--agent", agent, "--wait", "--timeout", "3"], {
    cwd: repository,
    env: { ...process.env, COORD_DIR: "", ...extraEnv },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stdout, stderr }));
  });
}

function repository() {
  const path = mkdtempSync(join(tmpdir(), "multi-coord-"));
  git(path, "init", "-b", "main");
  git(path, "config", "user.name", "Coord Test");
  git(path, "config", "user.email", "coord@example.invalid");
  mkdirSync(join(path, "src"));
  writeFileSync(join(path, "TASKS.md"), "# Tasks\n");
  writeFileSync(join(path, "src", "shared.js"), "export const shared = true;\n");
  git(path, "add", ".");
  git(path, "commit", "-m", "initial");
  return path;
}

function initialize(repo, { backend = "local", project = "fixture", quorum = 2, env = {}, extra = [] } = {}) {
  const output = coord(repo, [
    "init", "--backend", backend, "--project", project, "--base", "main",
    "--integrator", "integrator", "--queue", "TASKS.md", "--shared", "TASKS.md",
    "--review-quorum", String(quorum), "--lease", "120", ...extra,
  ], 0, env);
  for (const agent of ["alpha", "beta", "gamma", "integrator"]) {
    coord(repo, ["join", "--agent", agent, "--metadata", JSON.stringify({ runtime: agent })], 0, env);
  }
  return output;
}

test("broadcasts to every joined agent while keeping direct messages private", async () => {
  const repo = repository();
  try {
    initialize(repo);
    coord(repo, ["broadcast", "--from", "alpha", "--text", "schema migration starts now"]);
    assert.match(coord(repo, ["read", "--agent", "beta"]), /message\.broadcast broadcast: schema migration starts now/);
    assert.match(coord(repo, ["read", "--agent", "gamma"]), /message\.broadcast broadcast: schema migration starts now/);

    coord(repo, ["send", "--from", "alpha", "--to", "beta", "--text", "please review the migration"]);
    assert.match(coord(repo, ["read", "--agent", "beta"]), /message\.direct to beta: please review the migration/);
    assert.equal(coord(repo, ["read", "--agent", "gamma"]), "");
    assert.match(coord(repo, ["agents"]), /alpha\s+live/);
    assert.match(coord(repo, ["log", "--limit", "2"]), /please review the migration/);

    const waiting = blockingRead(repo, "gamma");
    await new Promise((resolve) => setTimeout(resolve, 100));
    coord(repo, ["broadcast", "--from", "alpha", "--text", "wake the blocking reader"]);
    const awakened = await waiting;
    assert.equal(awakened.status, 0, awakened.stderr);
    assert.match(awakened.stdout, /wake the blocking reader/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("requires named-reviewer quorum for an exact readiness round", () => {
  const repo = repository();
  try {
    initialize(repo);
    git(repo, "switch", "-c", "feat/task-one");
    coord(repo, ["claim", "TASK-1", "--agent", "alpha", "--branch", "feat/task-one", "--files", "src/task.js,TASKS.md", "--reviewers", "beta,gamma"]);
    writeFileSync(join(repo, "src", "task.js"), "export const task = 1;\n");
    assert.match(coord(repo, ["check", "TASK-1", "--agent", "alpha"]), /1 changed file/);
    assert.match(coord(repo, ["ready", "TASK-1", "--agent", "alpha", "--evidence", "scope and tests pass"], 1), /Commit all work/);
    writeFileSync(join(repo, "outside.js"), "export const outside = true;\n");
    assert.match(coord(repo, ["check", "TASK-1", "--agent", "alpha"], 1), /UNDECLARED outside\.js/);
    rmSync(join(repo, "outside.js"));
    git(repo, "add", "src/task.js");
    git(repo, "commit", "-m", "add task");

    coord(repo, ["ready", "TASK-1", "--agent", "alpha", "--evidence", "scope and tests pass"]);
    assert.match(coord(repo, ["review", "TASK-1", "--agent", "integrator", "--verdict", "approve", "--evidence", "reviewed exact change and tests"], 1), /not a named reviewer/);
    coord(repo, ["review", "TASK-1", "--agent", "beta", "--verdict", "approve", "--evidence", "reviewed exact change and tests"]);
    assert.match(coord(repo, ["gate", "TASK-1", "--agent", "integrator"], 1), /1\/2 required approvals/);
    coord(repo, ["review", "TASK-1", "--agent", "gamma", "--verdict", "approve", "--evidence", "reviewed exact change and tests"]);
    assert.match(coord(repo, ["gate", "TASK-1", "--agent", "integrator"]), /GATE PASS/);

    coord(repo, ["review", "TASK-1", "--agent", "beta", "--verdict", "changes", "--evidence", "clarify the test evidence before merge"]);
    coord(repo, ["ready", "TASK-1", "--agent", "alpha", "--evidence", "clarified evidence; tests still pass"]);
    assert.match(coord(repo, ["gate", "TASK-1", "--agent", "integrator"], 1), /0\/2 required approvals/);
    coord(repo, ["review", "TASK-1", "--agent", "beta", "--verdict", "approve", "--evidence", "clarified evidence is now sufficient"]);
    coord(repo, ["review", "TASK-1", "--agent", "gamma", "--verdict", "approve", "--evidence", "rechecked exact readiness round and tests"]);
    coord(repo, ["gate", "TASK-1", "--agent", "integrator"]);

    git(repo, "switch", "main");
    git(repo, "merge", "--ff-only", "feat/task-one");
    coord(repo, ["done", "TASK-1", "--agent", "alpha", "--note", "merged into main after quorum"]);
    assert.match(coord(repo, ["status"]), /TASK-1\s+done/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("supports question readdressing, withdrawal, overlap refusal, and reviewer changes", () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1 });
    git(repo, "switch", "-c", "feat/question");
    coord(repo, ["claim", "Q1", "--agent", "alpha", "--branch", "feat/question", "--files", "src/question.js", "--reviewers", "beta"]);
    coord(repo, ["ask", "Q1", "--agent", "alpha", "--to", "beta", "--question", "Should this result be stored or derived?"]);
    coord(repo, ["readdress", "Q1", "--agent", "alpha", "--to", "gamma", "--reason", "Gamma now owns the relevant schema context"]);
    assert.match(coord(repo, ["answer", "Q1", "--agent", "beta", "--text", "Store it in the existing table"], 1), /waiting on gamma/);
    coord(repo, ["answer", "Q1", "--agent", "gamma", "--text", "Derive it because the source record is authoritative"]);
    coord(repo, ["ask", "Q1", "--agent", "alpha", "--to", "beta", "--question", "Does the documented contract already decide this?"]);
    assert.match(coord(repo, ["withdraw", "Q1", "--agent", "alpha", "--reason", "The published contract already contains the answer"]), /history preserved/);
    coord(repo, ["reviewers", "Q1", "--agent", "alpha", "--set", "gamma", "--reason", "Gamma owns the relevant schema context"]);

    git(repo, "branch", "feat/overlap", "main");
    assert.match(coord(repo, ["claim", "Q2", "--agent", "beta", "--branch", "feat/overlap", "--files", "src/question.js/nested", "--reviewers", "gamma"], 1), /overlaps src\/question\.js/);
    assert.match(coord(repo, ["status"]), /Q1\s+claimed\s+alpha/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

class FakeWatchError extends Error {
  constructor() {
    super("watched key changed");
    this.name = "WatchError";
  }
}

class FakeRedisMulti {
  constructor(client) {
    this.client = client;
    this.commands = [];
  }

  set(...args) {
    this.commands.push(["set", args]);
    return this;
  }

  xAdd(...args) {
    this.commands.push(["xAdd", args]);
    return this;
  }

  async exec() {
    if (this.client.abortNext) {
      this.client.abortNext = false;
      throw new FakeWatchError();
    }
    const replies = [];
    for (const [command, args] of this.commands) replies.push(await this.client[command](...args));
    return replies;
  }
}

class FakeRedisClient {
  constructor() {
    this.values = new Map();
    this.hashes = new Map();
    this.streams = new Map();
    this.sequence = 0;
    this.abortNext = false;
    this.isOpen = false;
  }

  async set(key, value, options = {}) {
    if (options.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return "OK";
  }

  async get(key) { return this.values.get(key) ?? null; }
  async watch() {}
  async unwatch() {}
  multi() { return new FakeRedisMulti(this); }

  async xAdd(key, _id, message) {
    const id = `${++this.sequence}-0`;
    const entries = this.streams.get(key) || [];
    entries.push({ id, message });
    this.streams.set(key, entries);
    return id;
  }

  async xRevRange(key, _start, _end, options = {}) {
    return [...(this.streams.get(key) || [])].reverse().slice(0, options.COUNT);
  }

  async xRead({ key, id }, options = {}) {
    const cursor = Number(String(id).split("-")[0]);
    const messages = (this.streams.get(key) || []).filter((entry) => Number(entry.id.split("-")[0]) > cursor).slice(0, options.COUNT);
    return messages.length ? [{ name: key, messages }] : null;
  }

  hash(key) {
    if (!this.hashes.has(key)) this.hashes.set(key, new Map());
    return this.hashes.get(key);
  }

  async hGet(key, field) { return this.hash(key).get(field) ?? null; }
  async hSetNX(key, field, value) {
    if (this.hash(key).has(field)) return 0;
    this.hash(key).set(field, value);
    return 1;
  }
  async hSet(key, field, value) {
    this.hash(key).set(field, value);
    return 1;
  }
  async close() {}
}

test("Redis store retries optimistic conflicts and keeps independent fan-out cursors", async () => {
  const policy = {
    project: "fake-redis",
    base: "main",
    shared: [],
    reviewQuorum: 1,
    integrator: "integrator",
    streamMaxLength: 1000,
  };
  const client = new FakeRedisClient();
  const store = new RedisStore(client, FakeWatchError, policy);
  await store.initialize(initialState(policy));
  for (const agent of ["alpha", "beta"]) {
    await store.ensureCursor(agent);
    await store.mutate((state) => joinAgent(state, { agent, metadata: {}, leaseSeconds: 120 }));
  }
  client.abortNext = true;
  await store.ensureCursor("gamma");
  await store.mutate((state) => joinAgent(state, { agent: "gamma", metadata: {}, leaseSeconds: 120 }));
  await store.publish({ type: "message.broadcast", from: "alpha", to: "*", text: "fake redis fanout" });
  assert.ok((await store.read("beta")).some((item) => item.text === "fake redis fanout"));
  assert.ok((await store.read("gamma")).some((item) => item.text === "fake redis fanout"));
  assert.ok((await store.readState()).agents.gamma);
});

const redisUrl = process.env.TEST_COORD_REDIS_URL;
test("Redis backend delivers one broadcast to every independent agent cursor", { skip: !redisUrl }, async () => {
  const repo = repository();
  const project = `coord-test-${process.pid}-${Date.now()}`;
  const env = { COORD_REDIS_URL: redisUrl };
  try {
    initialize(repo, { backend: "redis", project, quorum: 1, env });
    coord(repo, ["broadcast", "--from", "alpha", "--text", "redis fanout fixture"], 0, env);
    assert.match(coord(repo, ["read", "--agent", "beta"], 0, env), /redis fanout fixture/);
    assert.match(coord(repo, ["read", "--agent", "gamma"], 0, env), /redis fanout fixture/);
  } finally {
    try {
      const { createClient } = await import("redis");
      const client = await createClient({ url: redisUrl }).connect();
      const tag = `{${project}}`;
      await client.del(`agent-coord:${tag}:state`, `agent-coord:${tag}:events`, `agent-coord:${tag}:cursors`);
      await client.close();
    } catch {}
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a squash-merged claim closes only against an equivalent commit", async () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1 });
    for (const agent of ["worker", "peer", "integrator"]) coord(repo, ["join", "--agent", agent]);

    git(repo, "checkout", "-q", "-b", "feat/squash");
    writeFileSync(join(repo, "src", "widget.js"), "export const widget = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "add widget");
    coord(repo, ["claim", "T1", "--agent", "worker", "--branch", "feat/squash", "--files", "src/widget.js", "--reviewers", "peer"]);
    coord(repo, ["ready", "T1", "--agent", "worker", "--evidence", "suite green; src/widget.js:1 covered"]);
    coord(repo, ["review", "T1", "--agent", "peer", "--verdict", "approve", "--evidence", "read src/widget.js:1 and ran the suite"]);

    // The project squashes, which SKILL.md permits, so the reviewed commit never
    // becomes an ancestor of main.
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "--squash", "feat/squash");
    git(repo, "commit", "-m", "squashed feat/squash");
    const squashed = git(repo, "rev-parse", "HEAD");

    const refusal = coord(repo, ["done", "T1", "--agent", "worker", "--note", "squash-merged into main"], 1);
    assert.match(refusal, /pass --merged-as/);

    // An unrelated commit that is genuinely in main must not satisfy it.
    writeFileSync(join(repo, "src", "other.js"), "export const other = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "unrelated");
    const impostor = coord(repo, ["done", "T1", "--agent", "worker", "--note", "wrong commit", "--merged-as", git(repo, "rev-parse", "HEAD")], 1);
    assert.match(impostor, /does not introduce the same change/);

    coord(repo, ["done", "T1", "--agent", "worker", "--note", "squash-merged into main", "--merged-as", squashed]);
    const status = coord(repo, ["status"]);
    assert.match(status, /T1\s+done/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("plans disjoint lanes, refuses ones that cannot run in parallel, and hands scope to the claim", () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1 });
    coord(repo, ["assign", "LANE-1", "--agent", "integrator", "--to", "alpha", "--aspect", "storage layer", "--files", "src/store.js", "--reviewers", "beta"]);

    // Two lanes over one path are not parallel lanes; that is the whole premise.
    const overlap = coord(repo, ["assign", "LANE-2", "--agent", "integrator", "--to", "beta", "--aspect", "cache", "--files", "src/store.js", "--reviewers", "alpha"], 1);
    assert.match(overlap, /cannot run in parallel/);
    const unknown = coord(repo, ["assign", "LANE-2", "--agent", "integrator", "--to", "beta", "--aspect", "cache", "--files", "src/cache.js", "--reviewers", "alpha", "--needs", "LANE-404"], 1);
    assert.match(unknown, /neither assigned nor claimed/);
    const owned = coord(repo, ["assign", "LANE-2", "--agent", "integrator", "--to", "beta", "--aspect", "cache", "--files", "src/cache.js", "--reviewers", "beta"], 1);
    assert.match(owned, /cannot review its own work/);

    coord(repo, ["assign", "LANE-2", "--agent", "integrator", "--to", "beta", "--aspect", "http surface", "--files", "src/http.js", "--reviewers", "alpha", "--needs", "LANE-1"]);
    assert.match(coord(repo, ["status"]), /LANE-2\s+beta\s+http surface\s+1\s+alpha\s+LANE-1/);

    // The assignee is the only agent who may take the lane, and the claim inherits
    // its scope and reviewers rather than restating them.
    git(repo, "switch", "-c", "feat/lane-1");
    assert.match(coord(repo, ["claim", "LANE-1", "--agent", "beta", "--branch", "feat/lane-1"], 1), /assigned to alpha/);
    assert.match(coord(repo, ["claim", "LANE-1", "--agent", "alpha", "--branch", "feat/lane-1"]), /storage layer.*reviewers beta/s);
    assert.match(coord(repo, ["status"]), /LANE-1\s+claimed\s+alpha\s+storage layer/);

    // A lane other work was planned behind cannot simply evaporate.
    assert.match(coord(repo, ["release", "LANE-1", "--agent", "alpha"], 1), /LANE-2 still depend/);
    assert.match(coord(repo, ["unassign", "LANE-2", "--agent", "integrator", "--reason", "re-planned into the storage lane"]), /withdrawn from beta/);
    coord(repo, ["release", "LANE-1", "--agent", "alpha"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("ranks a partner's blocked work above an agent's own and says so from any command", () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1 });
    coord(repo, ["assign", "LANE-2", "--agent", "integrator", "--to", "beta", "--aspect", "http surface", "--files", "src/http.js", "--reviewers", "alpha"]);

    git(repo, "switch", "-c", "feat/lane-1");
    coord(repo, ["claim", "LANE-1", "--agent", "alpha", "--branch", "feat/lane-1", "--files", "src/store.js", "--reviewers", "beta"]);
    writeFileSync(join(repo, "src", "store.js"), "export const store = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "store");
    coord(repo, ["ready", "LANE-1", "--agent", "alpha", "--evidence", "store suite green at src/store.js:1"]);

    // beta owes alpha a review, and learns it without having to ask.
    const betaNext = coord(repo, ["next", "--agent", "beta"]);
    assert.match(betaNext, /1 blocking a partner/);
    assert.match(betaNext, /BLOCKING {2}review LANE-1 for alpha/);
    assert.match(betaNext, /LANE {6}LANE-2 \(http surface\) 1 path/);
    // The obligation is printed before beta's own lane, not after it.
    assert.ok(betaNext.indexOf("BLOCKING") < betaNext.indexOf("LANE  "), betaNext);
    // Any ordinary command repeats it, which is what a long session forgets.
    assert.match(coord(repo, ["status", "--agent", "beta"]), /BLOCKED ON YOU: review LANE-1 for alpha/);
    assert.doesNotMatch(coord(repo, ["heartbeat", "--agent", "integrator"]), /BLOCKED ON YOU/);

    // An open question invalidates the round, so the review obligation gives way
    // to the answer the asker is now blocked on.
    coord(repo, ["ask", "LANE-1", "--agent", "alpha", "--to", "gamma", "--question", "Should the store key include the tenant?"]);
    assert.doesNotMatch(coord(repo, ["heartbeat", "--agent", "beta"]), /BLOCKED ON YOU/);
    assert.match(coord(repo, ["next", "--agent", "gamma"]), /BLOCKING {2}answer LANE-1 for alpha/);
    assert.match(coord(repo, ["heartbeat", "--agent", "gamma"]), /BLOCKED ON YOU: answer LANE-1 for alpha/);

    // Discharging it clears the reminder.
    coord(repo, ["answer", "LANE-1", "--agent", "gamma", "--text", "Derive it from the tenant already on the event"]);
    assert.doesNotMatch(coord(repo, ["heartbeat", "--agent", "gamma"]), /BLOCKED ON YOU/);
    assert.match(coord(repo, ["next", "--agent", "alpha"]), /YOURS {5}LANE-1 claimed — implement/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a lane starts on a reviewed dependency but cannot be declared ready before it lands", () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1 });
    coord(repo, ["assign", "L1", "--agent", "integrator", "--to", "alpha", "--aspect", "storage layer", "--files", "src/store.js", "--reviewers", "beta"]);
    coord(repo, ["assign", "L2", "--agent", "integrator", "--to", "beta", "--aspect", "http surface", "--files", "src/http.js", "--reviewers", "alpha", "--needs", "L1"]);

    git(repo, "switch", "-c", "feat/l2");
    assert.match(coord(repo, ["claim", "L2", "--agent", "beta", "--branch", "feat/l2"], 1), /depends on L1, which has not reached a reviewed commit/);
    assert.match(coord(repo, ["next", "--agent", "beta"]), /LANE {6}L2 \(http surface\) blocked by L1/);

    git(repo, "switch", "main");
    git(repo, "switch", "-c", "feat/l1");
    coord(repo, ["claim", "L1", "--agent", "alpha", "--branch", "feat/l1"]);
    writeFileSync(join(repo, "src", "store.js"), "export const store = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "store");
    coord(repo, ["ready", "L1", "--agent", "alpha", "--evidence", "store suite green at src/store.js:1"]);

    // A reviewed commit is enough to build against, so the second lane starts now
    // rather than after the merge.
    git(repo, "switch", "feat/l2");
    coord(repo, ["claim", "L2", "--agent", "beta", "--branch", "feat/l2"]);
    writeFileSync(join(repo, "src", "http.js"), "export const http = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "http");
    assert.match(coord(repo, ["ready", "L2", "--agent", "beta", "--evidence", "handler suite green at src/http.js:1"], 1), /depends on L1, which is not merged yet/);

    git(repo, "switch", "feat/l1");
    coord(repo, ["review", "L1", "--agent", "beta", "--verdict", "approve", "--evidence", "read src/store.js:1 and ran the store suite"]);
    coord(repo, ["gate", "L1", "--agent", "integrator"]);
    git(repo, "switch", "main");
    git(repo, "merge", "--ff-only", "feat/l1");
    coord(repo, ["done", "L1", "--agent", "alpha", "--note", "fast-forwarded into main after quorum approval"]);

    git(repo, "switch", "feat/l2");
    coord(repo, ["ready", "L2", "--agent", "beta", "--evidence", "handler suite green at src/http.js:1"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a ready round survives only a base advance git proves missed the claim's own files", () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1, extra: ["--base-advance", "disjoint"] });
    git(repo, "switch", "-c", "feat/one");
    coord(repo, ["claim", "T1", "--agent", "alpha", "--branch", "feat/one", "--files", "src/store.js", "--reviewers", "beta"]);
    writeFileSync(join(repo, "src", "store.js"), "export const store = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "store");
    coord(repo, ["ready", "T1", "--agent", "alpha", "--evidence", "store suite green at src/store.js:1"]);

    // A peer lane merges. It touched nothing this claim declared, so the round
    // stands and the reviewer is told the base moved anyway.
    git(repo, "switch", "main");
    writeFileSync(join(repo, "src", "other.js"), "export const other = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "a peer lane lands");
    git(repo, "switch", "feat/one");
    const review = coord(repo, ["review", "T1", "--agent", "beta", "--verdict", "approve", "--evidence", "read src/store.js:1 and ran the store suite"]);
    assert.match(review, /main advanced [0-9a-f]{12}\.\.[0-9a-f]{12} over 1 file, none in this claim's scope; round kept/);
    assert.match(coord(repo, ["gate", "T1", "--agent", "integrator"]), /GATE PASS/);

    // A base advance into the claim's own scope is a different change under
    // review, and both the reviewer and the gate must refuse it.
    git(repo, "switch", "main");
    writeFileSync(join(repo, "src", "store.js"), "export const store = 99;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "someone else edits the store");
    git(repo, "switch", "feat/one");
    assert.match(coord(repo, ["review", "T1", "--agent", "beta", "--verdict", "approve", "--evidence", "re-read src/store.js:1 after the base moved"], 1), /advanced into this claim's own scope \(src\/store\.js\)/);
    assert.match(coord(repo, ["gate", "T1", "--agent", "integrator"], 1), /advanced into this claim's own scope/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the strict default refuses even a disjoint base advance", () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1 });
    git(repo, "switch", "-c", "feat/strict");
    coord(repo, ["claim", "T1", "--agent", "alpha", "--branch", "feat/strict", "--files", "src/store.js", "--reviewers", "beta"]);
    writeFileSync(join(repo, "src", "store.js"), "export const store = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "store");
    coord(repo, ["ready", "T1", "--agent", "alpha", "--evidence", "store suite green at src/store.js:1"]);

    git(repo, "switch", "main");
    writeFileSync(join(repo, "src", "other.js"), "export const other = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "a peer lane lands");
    git(repo, "switch", "feat/strict");
    assert.match(coord(repo, ["review", "T1", "--agent", "beta", "--verdict", "approve", "--evidence", "read src/store.js:1 and ran the store suite"], 1), /Integration base moved since ready/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("refuses to start or finish work while a partner is blocked past the debt limit", async () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1, extra: ["--review-debt-limit", "1"] });
    git(repo, "switch", "-c", "feat/first");
    coord(repo, ["claim", "T1", "--agent", "alpha", "--branch", "feat/first", "--files", "src/store.js", "--reviewers", "beta"]);
    writeFileSync(join(repo, "src", "store.js"), "export const store = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "store");
    coord(repo, ["ready", "T1", "--agent", "alpha", "--evidence", "store suite green at src/store.js:1"]);

    await new Promise((resolve) => setTimeout(resolve, 1100));
    git(repo, "switch", "main");
    git(repo, "switch", "-c", "feat/second");
    const refusal = coord(repo, ["claim", "T2", "--agent", "beta", "--branch", "feat/second", "--files", "src/http.js", "--reviewers", "alpha"], 1);
    assert.match(refusal, /Cannot claim T2 while a partner has been blocked on you longer than 1s: T1 \(review for alpha/);

    // The debt is always dischargeable: review is never itself gated.
    git(repo, "switch", "feat/first");
    coord(repo, ["review", "T1", "--agent", "beta", "--verdict", "approve", "--evidence", "read src/store.js:1 and ran the store suite"]);
    git(repo, "switch", "feat/second");
    coord(repo, ["claim", "T2", "--agent", "beta", "--branch", "feat/second", "--files", "src/http.js", "--reviewers", "alpha"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a board created before these policies attaches unchanged, and the integrator opts in deliberately", () => {
  const repo = repository();
  try {
    initialize(repo, { quorum: 1 });

    // Simulate a board created by the previous release: the two policy keys did
    // not exist, and six repositories vendor boards in exactly that shape.
    const coordinationDirectory = join(repo, ".git", "multi-agent-coordination");
    for (const file of ["config.json", "state.json"]) {
      const path = join(coordinationDirectory, file);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      const target = file === "config.json" ? parsed : parsed.policy;
      delete target.baseAdvance;
      delete target.reviewDebtLimit;
      writeFileSync(path, JSON.stringify(parsed, null, 2));
    }

    git(repo, "switch", "-c", "feat/legacy");
    coord(repo, ["claim", "T1", "--agent", "alpha", "--branch", "feat/legacy", "--files", "src/store.js", "--reviewers", "beta"]);
    writeFileSync(join(repo, "src", "store.js"), "export const store = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "store");
    coord(repo, ["ready", "T1", "--agent", "alpha", "--evidence", "store suite green at src/store.js:1"]);

    // Attaching again refreshes the local file rather than refusing over keys
    // that were only added later.
    assert.match(initialize(repo, { quorum: 1 }), /Refreshed local config to match the board: baseAdvance, reviewDebtLimit/);

    // Absent keys read as the strict default until someone changes them on the
    // board, which only the integrator can do and which is recorded.
    git(repo, "switch", "main");
    writeFileSync(join(repo, "src", "other.js"), "export const other = 1;\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "a peer lane lands");
    git(repo, "switch", "feat/legacy");
    const approve = ["review", "T1", "--agent", "beta", "--verdict", "approve", "--evidence", "read src/store.js:1 and ran the store suite"];
    assert.match(coord(repo, approve, 1), /Integration base moved since ready/);

    assert.match(coord(repo, ["policy", "--agent", "alpha", "--base-advance", "disjoint", "--reason", "adopting parallel lanes this week"], 1), /Only configured integrator/);
    assert.match(coord(repo, ["policy", "--agent", "integrator", "--base-advance", "disjoint", "--reason", "adopting parallel lanes this week"]), /base advance disjoint/);
    assert.match(coord(repo, approve), /round kept/);
    assert.match(coord(repo, ["log", "--limit", "20"]), /policy\.changed/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

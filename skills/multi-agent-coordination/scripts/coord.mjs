#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  CoordError,
  amendClaim,
  answerQuestion,
  approvalSummary,
  askQuestion,
  assignTask,
  baseAdvanceBlocks,
  claimTask,
  commaList,
  completeClaim,
  fail,
  formatAge,
  handoffClaim,
  heartbeatAgent,
  initialState,
  joinAgent,
  leaveAgent,
  liveAgents,
  markReady,
  obligations,
  pathCovered,
  readdressQuestion,
  releaseClaim,
  requireEvidence,
  reviewClaim,
  setPolicy,
  setReviewers,
  unassignTask,
  unmetDependencies,
  validateAgent,
  validateId,
  validateProject,
  withdrawQuestion,
  worklist,
} from "./core.mjs";
import { LocalStore, readJson, writeJsonAtomically } from "./local-store.mjs";
import { RedisStore } from "./redis-store.mjs";

function patchIdentity(root, from, to) {
  const diff = runGit(root, ["diff", from, to], { optional: true });
  if (diff === null || !diff.trim()) return null;
  try {
    const output = execFileSync("git", ["patch-id", "--stable"], { cwd: root, encoding: "utf8", input: diff });
    return output.trim().split(/\s+/)[0] || null;
  } catch {
    return null;
  }
}

function runGit(cwd, args, { optional = false } = {}) {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    if (optional) return null;
    const detail = error.stderr?.toString().trim();
    fail(detail || `git ${args.join(" ")} failed`);
  }
}

const invocationDirectory = process.cwd();
const root = runGit(invocationDirectory, ["rev-parse", "--show-toplevel"]);
const commonGitDirectory = runGit(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
const coordinationDirectory = process.env.COORD_DIR ? resolve(process.env.COORD_DIR) : join(commonGitDirectory, "multi-agent-coordination");
const configPath = join(coordinationDirectory, "config.json");

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) flags[name] = true;
    else {
      flags[name] = next;
      index += 1;
    }
  }
  return { positional, flags };
}

function normalizeProjectPath(input) {
  if (!input || isAbsolute(input)) fail(`Path must be relative to the repository: ${input || "<empty>"}`);
  const normalized = relative(root, resolve(root, input)).replaceAll("\\", "/");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) fail(`Path must stay inside the repository: ${input}`);
  return normalized;
}

function integerFlag(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) fail(`${name} must be ${minimum}-${maximum}`);
  return number;
}

function jsonObject(value, name) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") fail(`${name} must be a JSON object`);
    return parsed;
  } catch (error) {
    if (error instanceof CoordError) throw error;
    fail(`${name} must be valid JSON`);
  }
}

function currentBranch() {
  return runGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"], { optional: true });
}

function branchHead(branch) {
  return runGit(root, ["rev-parse", `refs/heads/${branch}`], { optional: true });
}

function workingTreeClean() {
  return runGit(root, ["status", "--porcelain"]) === "";
}

function gitLines(args) {
  const output = runGit(root, args);
  return output ? output.split("\n").filter(Boolean) : [];
}

function changedPaths(base) {
  return [...new Set([
    ...gitLines(["diff", "--name-only", `${base}...HEAD`]),
    ...gitLines(["diff", "--name-only"]),
    ...gitLines(["diff", "--cached", "--name-only"]),
    ...gitLines(["ls-files", "--others", "--exclude-standard"]),
  ])].sort();
}

function scopeResult(state, config, agent, id) {
  const claim = state.claims[id];
  if (!claim || !["claimed", "ready"].includes(claim.state)) fail(`${id} is not an active claim`);
  if (claim.agent !== agent) fail(`${id} is held by ${claim.agent}, not ${agent}`);
  const changed = changedPaths(config.base);
  const trespass = [];
  const undeclared = [];
  for (const path of changed) {
    if (pathCovered(path, config.shared || []) || pathCovered(path, claim.files || [])) continue;
    const owner = Object.entries(state.claims).find(([otherId, other]) =>
      otherId !== id && ["claimed", "ready"].includes(other.state) && pathCovered(path, other.files || []),
    );
    if (owner) trespass.push({ path, id: owner[0], agent: owner[1].agent });
    else undeclared.push(path);
  }
  return { changed, trespass, undeclared };
}

function printScope(result) {
  for (const item of result.trespass) console.log(`TRESPASS ${item.path} — ${item.agent} declared it for ${item.id}`);
  for (const path of result.undeclared) console.log(`UNDECLARED ${path} — amend the claim before continuing`);
  if (!result.trespass.length && !result.undeclared.length) {
    console.log(`${result.changed.length} changed file${result.changed.length === 1 ? "" : "s"}, all declared or shared (committed + staged + unstaged + untracked)`);
  }
}

// Whether the integration base merely advanced past a ready round without
// touching any file that round declared. Computed here because core.mjs never
// shells out; it receives the proof and re-checks it.
function baseAdvanceProof(claim, currentBase) {
  const from = claim?.ready?.baseHead;
  if (!from || from === currentBase) return null;
  const fastForward = runGit(root, ["merge-base", "--is-ancestor", from, currentBase], { optional: true }) !== null;
  const changed = fastForward ? gitLines(["diff", "--name-only", `${from}..${currentBase}`]) : [];
  return {
    from,
    to: currentBase,
    fastForward,
    changed: changed.length,
    touched: changed.filter((path) => pathCovered(path, claim.files || [])),
  };
}

function invocation() {
  const path = relative(process.cwd(), process.argv[1]);
  return `node ${!path || path.startsWith("..") ? process.argv[1] : path}`;
}

function configPolicy(config) {
  return {
    project: config.project,
    base: config.base,
    queue: config.queue || null,
    shared: config.shared,
    reviewQuorum: config.reviewQuorum,
    integrator: config.integrator,
    streamMaxLength: config.streamMaxLength,
    baseAdvance: config.baseAdvance || "strict",
    reviewDebtLimit: config.reviewDebtLimit || 0,
  };
}

async function createStore(config) {
  const policy = configPolicy(config);
  if (config.backend === "local") return new LocalStore(coordinationDirectory, policy);
  if (config.backend === "redis") {
    return RedisStore.connect({ url: process.env[config.redisUrlEnv || "COORD_REDIS_URL"], policy });
  }
  fail(`Unsupported backend: ${config.backend}`);
}

function loadConfig() {
  if (!existsSync(configPath)) fail("Coordination is not initialized. Run coord.mjs init --help for setup options");
  const config = readJson(configPath);
  if (config.version !== 2) fail(`Unsupported coordination config at ${configPath}`);
  return config;
}

function formatEvent(item) {
  const address = item.to === "*" ? "broadcast" : `to ${item.to}`;
  const task = item.task ? ` re ${item.task}` : "";
  const detail = item.text || (item.payload ? JSON.stringify(item.payload) : "");
  return `[${item.at}] ${item.from} ${item.type} ${address}${task}${detail ? `: ${detail}` : ""}`;
}

const SILENT_DIGEST = new Set(["next", "init", "help", "--help", "-h", "unlock", "log", "agents"]);

async function printBlockedOnYou() {
  if (!activeStore || SILENT_DIGEST.has(command)) return;
  const agent = String(flags.agent || flags.from || "");
  if (!/^[a-z0-9-]{1,48}$/.test(agent)) return;
  try {
    const state = await activeStore.readState();
    if (!state.agents?.[agent]) return;
    // Not the task this command just acted on: gate leaves its obligation
    // standing until the merge is recorded, and restating it here reads as noise.
    const pending = obligations(state, agent).filter((item) => item.id !== target);
    if (!pending.length) return;
    const verb = { question: "answer", review: "review", gate: "gate" };
    const shown = pending.slice(0, 3).map((item) => `${verb[item.kind]} ${item.id} for ${item.owner} (${formatAge(item.waitingMs)})`);
    const more = pending.length > shown.length ? `; +${pending.length - shown.length} more` : "";
    console.log(`BLOCKED ON YOU: ${shown.join("; ")}${more} — ${invocation()} next --agent ${agent}`);
  } catch {
    // A digest must never mask the command's own result.
  }
}

function usage() {
  console.log(`Multi-agent coordination (run from the target Git repository)

Setup and presence:
  init --backend local|redis --project P --base B --integrator A
       [--queue path --shared path,path --review-quorum N]
       [--lease seconds --stream-max-length N --redis-url-env NAME]
       [--base-advance strict|disjoint --review-debt-limit seconds]
  join --agent A [--metadata '{"runtime":"codex"}' --lease seconds]
  heartbeat --agent A
  leave --agent A [--force --authority human --reason "..."]
  agents

Parallel lanes:
  assign <id> --agent A --to B --aspect "storage layer"
         --files path,path --reviewers C[,D] [--needs id,id]
  unassign <id> --agent A --reason "..."
  next --agent A

Work lifecycle:
  status [--agent A]
  claim <id> --agent A --branch B [--files path,path --reviewers B,C]
  amend <id> --agent A --files path,path
  reviewers <id> --agent A --set B,C --reason "..."
  check <id> --agent A
  ask <id> --agent A --to B --question "..."
  readdress <id> --agent A --to C --reason "..."
  answer <id> --agent B --text "..."
  withdraw <id> --agent A --reason "..."
  ready <id> --agent A --evidence "checks and results"
  review <id> --agent B --verdict approve|changes --evidence "..."
  gate <id> --agent <configured-integrator>
  handoff <id> --agent A --to B --note "commit, state, remaining work, risks"
  release <id> --agent A [--force --authority human --reason "..."]
  done <id> --agent A --note "merged into base"
       [--force --authority human --reason "..."]

Messaging:
  send --from A --to B [--re id] --text "..."
  broadcast --from A [--re id] --text "..."
  read --agent A [--wait --timeout seconds --count N]
  log [--limit N]

Policy and recovery:
  policy --agent <configured-integrator> --reason "..."
         [--base-advance strict|disjoint --review-debt-limit seconds]
  unlock --authority human --reason "verified stale local lock"

next is the one command to run when you do not know what to do: it ranks a
partner's blocked work above your own. claim inherits --files and --reviewers
from an assigned lane. Under --base-advance disjoint a ready round survives a
base advance git proves touched none of its declared files.

Redis is opt-in. Set the configured URL environment variable and run npm install
inside the skill directory. Agent identities remain self-asserted on both backends.`);
}

const { positional, flags } = parseArgs(process.argv.slice(2));
const [command = "help", target] = positional;
let activeStore = null;

async function main() {
  if (["help", "--help", "-h"].includes(command) || (command === "init" && flags.help)) {
    usage();
    return;
  }

  if (command === "init") {
    const backend = String(flags.backend || "local");
    if (!["local", "redis"].includes(backend)) fail("Backend must be local or redis");
    const project = validateProject(String(flags.project || ""));
    const base = String(flags.base || "").trim();
    if (!base || !runGit(root, ["rev-parse", "--verify", `refs/heads/${base}`], { optional: true })) fail(`Base must name an existing local branch: ${base || "<empty>"}`);
    const integrator = validateAgent(String(flags.integrator || ""));
    const shared = [...new Set(commaList(flags.shared, normalizeProjectPath))].sort();
    const queue = flags.queue ? normalizeProjectPath(String(flags.queue)) : null;
    if (queue && !existsSync(join(root, queue))) fail(`Configured queue does not exist: ${queue}`);
    const reviewQuorum = integerFlag(flags["review-quorum"] || 1, "review-quorum", 1, 20);
    const defaultLeaseSeconds = integerFlag(flags.lease || 300, "lease", 30, 86_400);
    const streamMaxLength = integerFlag(flags["stream-max-length"] || 10_000, "stream-max-length", 100, 1_000_000);
    const redisUrlEnv = String(flags["redis-url-env"] || "COORD_REDIS_URL");
    if (!/^[A-Z_][A-Z0-9_]{1,63}$/.test(redisUrlEnv)) fail("redis-url-env must be an uppercase environment variable name");
    const baseAdvance = String(flags["base-advance"] || "strict");
    if (!["strict", "disjoint"].includes(baseAdvance)) fail("base-advance must be strict or disjoint");
    const reviewDebtLimit = flags["review-debt-limit"] === undefined ? 0 : integerFlag(flags["review-debt-limit"], "review-debt-limit", 0, 86_400);
    const config = { version: 2, backend, project, base, integrator, shared, ...(queue ? { queue } : {}), reviewQuorum, defaultLeaseSeconds, streamMaxLength, redisUrlEnv, baseAdvance, reviewDebtLimit };
    mkdirSync(coordinationDirectory, { recursive: true });
    activeStore = await createStore(config);
    const initialized = await activeStore.initialize(initialState(configPolicy(config)));
    if (existsSync(configPath)) {
      // initialize() has already refused any policy that disagrees with the
      // board, so remaining drift in the two adjustable keys means this local
      // file predates them or predates a recorded policy change. Refresh it.
      const existing = readJson(configPath);
      const adjustable = new Set(["baseAdvance", "reviewDebtLimit"]);
      const drift = [...new Set([...Object.keys(existing), ...Object.keys(config)])]
        .filter((key) => JSON.stringify(existing[key]) !== JSON.stringify(config[key]));
      if (drift.some((key) => !adjustable.has(key))) fail(`Local config already exists and differs at ${configPath}`);
      if (drift.length) {
        writeJsonAtomically(configPath, config);
        console.log(`Refreshed local config to match the board: ${drift.join(", ")}`);
      }
    } else writeJsonAtomically(configPath, config);
    console.log(`${initialized.created ? "Initialized" : "Attached to"} ${backend} coordination for ${project}; base ${base}; integrator ${integrator}; review quorum ${reviewQuorum}`);
    console.log(`base advance ${baseAdvance}; peer debt limit ${reviewDebtLimit ? formatAge(reviewDebtLimit * 1000) : "advisory only"}`);
    console.log("Agent identities are self-asserted; the event log is an audit aid, not authentication.");
    return;
  }

  const config = loadConfig();
  activeStore = await createStore(config);

  if (command === "unlock") {
    await activeStore.unlock({ authority: flags.authority, reason: flags.reason });
    console.log("Removed local mutation.lock with a logged human override");
    return;
  }

  if (command === "policy") {
    const agent = validateAgent(String(flags.agent || ""));
    const baseAdvance = flags["base-advance"] === undefined ? null : String(flags["base-advance"]);
    const reviewDebtLimit = flags["review-debt-limit"] === undefined ? null : integerFlag(flags["review-debt-limit"], "review-debt-limit", 0, 86_400);
    if (baseAdvance === null && reviewDebtLimit === null) fail("policy needs --base-advance and/or --review-debt-limit");
    const change = await activeStore.mutate((state) => setPolicy(state, { agent, baseAdvance, reviewDebtLimit, reason: flags.reason }));
    writeJsonAtomically(configPath, { ...config, ...change.after });
    console.log(`policy: base advance ${change.after.baseAdvance}; peer debt limit ${change.after.reviewDebtLimit ? formatAge(change.after.reviewDebtLimit * 1000) : "advisory only"}`);
    return;
  }

  if (command === "join") {
    const agent = validateAgent(String(flags.agent || ""));
    await activeStore.ensureCursor(agent);
    const record = await activeStore.mutate((state) => joinAgent(state, {
      agent,
      metadata: jsonObject(flags.metadata, "metadata"),
      leaseSeconds: flags.lease || config.defaultLeaseSeconds,
    }));
    console.log(`${agent} joined ${config.project}; advisory lease until ${record.leaseUntil}`);
    return;
  }

  if (command === "heartbeat") {
    const agent = validateAgent(String(flags.agent || ""));
    const record = await activeStore.mutate((state) => heartbeatAgent(state, { agent }));
    console.log(`${agent} heartbeat; advisory lease until ${record.leaseUntil}`);
    return;
  }

  if (command === "leave") {
    const agent = validateAgent(String(flags.agent || ""));
    const result = await activeStore.mutate((state) => leaveAgent(state, {
      agent,
      forced: Boolean(flags.force),
      authority: flags.authority,
      reason: flags.reason,
    }));
    console.log(`${agent} left${result.held.length ? ` with active claims retained: ${result.held.join(", ")}` : ""}`);
    return;
  }

  if (command === "agents") {
    const state = await activeStore.readState();
    console.log("agent                                            presence  lease-until                  metadata");
    for (const record of liveAgents(state)) console.log(`${record.agent.padEnd(48)} ${record.presence.padEnd(9)} ${record.leaseUntil.padEnd(28)} ${JSON.stringify(record.metadata)}`);
    return;
  }

  if (command === "status") {
    const state = await activeStore.readState();
    const assignments = state.assignments || {};
    console.log(`project: ${config.project}  backend: ${config.backend}  base: ${config.base}  integrator: ${config.integrator}  quorum: ${config.reviewQuorum}  base-advance: ${config.baseAdvance || "strict"}`);
    console.log("item               state     owner        aspect                 branch                   review");
    for (const [id, claim] of Object.entries(state.claims).sort(([left], [right]) => left.localeCompare(right))) {
      const summary = approvalSummary(claim);
      const note = claim.openQuestion ? `waiting on ${claim.waitingOn}` : claim.ready ? `${summary.approved.length}/${claim.quorum} approved` : "";
      console.log(`${id.padEnd(18)} ${claim.state.padEnd(9)} ${claim.agent.padEnd(12)} ${(claim.aspect || "-").slice(0, 22).padEnd(22)} ${(claim.branch || "-").slice(0, 24).padEnd(24)} ${note}`);
    }
    const lanes = Object.entries(assignments).sort(([left], [right]) => left.localeCompare(right));
    if (lanes.length) {
      console.log("lane               assignee     aspect                 files  reviewers            blocked by");
      for (const [id, lane] of lanes) {
        const blocked = unmetDependencies(state, lane.needs, "claim");
        console.log(`${id.padEnd(18)} ${lane.assignee.padEnd(12)} ${lane.aspect.slice(0, 22).padEnd(22)} ${String(lane.files.length).padEnd(6)} ${lane.reviewers.join(",").slice(0, 20).padEnd(20)} ${blocked.join(", ") || "-"}`);
      }
    }
    const active = Object.values(state.claims).filter((claim) => ["claimed", "ready"].includes(claim.state));
    const startable = lanes.filter(([, lane]) => !unmetDependencies(state, lane.needs, "claim").length).length;
    const owners = new Set(active.map((claim) => claim.agent));
    console.log(`in flight: ${active.length} claim${active.length === 1 ? "" : "s"} across ${owners.size} agent${owners.size === 1 ? "" : "s"}; lanes: ${lanes.length} open, ${startable} startable now`);
    const presence = liveAgents(state);
    console.log(`agents: ${presence.map((item) => `${item.agent}:${item.presence}`).join("  ") || "none"}`);
    return;
  }

  if (command === "assign") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const to = validateAgent(String(flags.to || ""));
    const requested = [...new Set(commaList(flags.files, normalizeProjectPath))].sort();
    if (!requested.length) fail("A lane needs --files: the exclusive paths that make it parallel");
    const tooBroad = requested.find((path) => (config.shared || []).some((sharedPath) => sharedPath.startsWith(`${path}/`)));
    if (tooBroad) fail(`${tooBroad} contains a configured shared path; assign narrower paths`);
    const files = requested.filter((path) => !pathCovered(path, config.shared || []));
    if (!files.length) fail("Every requested path is a configured shared path, which is never exclusive; a lane needs at least one owned path");
    const lane = await activeStore.mutate((state) => assignTask(state, {
      id,
      agent,
      to,
      aspect: flags.aspect,
      files,
      reviewers: commaList(flags.reviewers, validateAgent),
      needs: commaList(flags.needs, validateId),
    }));
    console.log(`${id} assigned to ${to} (${lane.aspect}); ${lane.files.length} exclusive path${lane.files.length === 1 ? "" : "s"}; reviewers ${lane.reviewers.join(", ")}${lane.needs.length ? `; after ${lane.needs.join(", ")}` : ""}`);
    return;
  }

  if (command === "unassign") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const lane = await activeStore.mutate((state) => unassignTask(state, { id, agent, reason: flags.reason }));
    console.log(`${id} withdrawn from ${lane.assignee}; its paths are free to reassign`);
    return;
  }

  if (command === "next") {
    const agent = validateAgent(String(flags.agent || ""));
    const state = await activeStore.readState();
    if (!state.agents[agent]) fail(`${agent} has not joined this project`);
    await activeStore.mutate((draft) => heartbeatAgent(draft, { agent }));
    const list = worklist(state, agent);
    const run = invocation();
    const startable = list.lanes.filter((lane) => !lane.blockedBy.length).length;
    console.log(`${agent}: ${list.obligations.length} blocking a partner, ${list.own.length} own, ${startable} lane${startable === 1 ? "" : "s"} to start`);
    for (const item of list.obligations) {
      if (item.kind === "question") {
        console.log(`BLOCKING  answer ${item.id} for ${item.owner}, waiting ${formatAge(item.waitingMs)}: ${item.question}`);
        console.log(`          ${run} answer ${item.id} --agent ${agent} --text "decision and rationale"`);
      } else if (item.kind === "review") {
        console.log(`BLOCKING  review ${item.id} for ${item.owner} at ${item.head.slice(0, 12)}, waiting ${formatAge(item.waitingMs)}`);
        console.log(`          ${run} review ${item.id} --agent ${agent} --verdict approve|changes --evidence "file:line and what you ran"`);
      } else {
        console.log(`BLOCKING  gate ${item.id} for ${item.owner}, quorum met ${formatAge(item.waitingMs)} ago`);
        console.log(`          ${run} gate ${item.id} --agent ${agent}`);
      }
    }
    for (const item of list.own) {
      console.log(`YOURS     ${item.id}${item.aspect ? ` (${item.aspect})` : ""} ${item.state} — ${item.detail}`);
      if (item.action === "implement") console.log(`          ${run} check ${item.id} --agent ${agent}, then ${run} ready ${item.id} --agent ${agent} --evidence "..."`);
    }
    for (const item of list.lanes) {
      if (item.blockedBy.length) {
        console.log(`LANE      ${item.id} (${item.aspect}) blocked by ${item.blockedBy.join(", ")}`);
        continue;
      }
      console.log(`LANE      ${item.id} (${item.aspect}) ${item.files.length} path${item.files.length === 1 ? "" : "s"}, reviewers ${item.reviewers.join(", ")} — yours to start`);
      console.log(`          ${run} claim ${item.id} --agent ${agent} --branch <feature-branch>`);
    }
    if (!list.obligations.length && !list.own.length && !list.lanes.length) {
      console.log(`IDLE      nothing assigned to you; ask ${config.integrator} for a lane, or wait: ${run} read --agent ${agent} --wait --timeout 60`);
    }
    return;
  }

  if (command === "claim") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const branch = String(flags.branch || "").trim();
    if (!branch || !branchHead(branch)) fail(`Claim branch must already exist locally: ${branch || "<empty>"}`);
    const lane = (await activeStore.readState()).assignments?.[id] || null;
    const requested = flags.files === undefined && lane ? lane.files.join(",") : flags.files;
    const declared = [...new Set(commaList(requested, normalizeProjectPath))].sort();
    if (!declared.length) fail("Declare at least one file or directory with --files");
    const tooBroad = declared.find((path) => (config.shared || []).some((sharedPath) => sharedPath.startsWith(`${path}/`)));
    if (tooBroad) fail(`${tooBroad} contains a configured shared path; claim narrower paths`);
    const shared = declared.filter((path) => pathCovered(path, config.shared || []));
    const files = declared.filter((path) => !shared.includes(path));
    const reviewers = flags.reviewers === undefined && lane ? [...lane.reviewers] : commaList(flags.reviewers, validateAgent);
    const claim = await activeStore.mutate((state) => claimTask(state, { id, agent, branch, files, reviewers }));
    if (shared.length) console.log(`Not locking configured shared path${shared.length === 1 ? "" : "s"}: ${shared.join(", ")}`);
    console.log(`${agent} holds ${id}${claim.aspect ? ` (${claim.aspect})` : ""}; reviewers ${claim.reviewers.join(", ")} (${claim.quorum} required)`);
    return;
  }

  if (command === "amend") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const requested = [...new Set(commaList(flags.files, normalizeProjectPath))].sort();
    if (!requested.length) fail("amend requires --files");
    const tooBroad = requested.find((path) => (config.shared || []).some((sharedPath) => sharedPath.startsWith(`${path}/`)));
    if (tooBroad) fail(`${tooBroad} contains a configured shared path; amend with narrower paths`);
    const files = requested.filter((path) => !pathCovered(path, config.shared || []));
    await activeStore.mutate((state) => amendClaim(state, { id, agent, files }));
    console.log(`${id} scope amended; readiness invalidated`);
    return;
  }

  if (command === "reviewers") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const reviewers = commaList(flags.set, validateAgent);
    await activeStore.mutate((state) => setReviewers(state, { id, agent, reviewers, reason: flags.reason }));
    console.log(`${id} reviewers changed; readiness invalidated`);
    return;
  }

  if (command === "check") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const result = scopeResult(await activeStore.readState(), config, agent, id);
    printScope(result);
    if (result.trespass.length) process.exitCode = 2;
    else if (result.undeclared.length) process.exitCode = 1;
    return;
  }

  if (command === "ask") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const to = validateAgent(String(flags.to || ""));
    await activeStore.mutate((state) => askQuestion(state, { id, agent, to, question: flags.question }));
    console.log(`${id} is waiting on ${to}; readiness invalidated`);
    return;
  }

  if (command === "readdress") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const to = validateAgent(String(flags.to || ""));
    await activeStore.mutate((state) => readdressQuestion(state, { id, agent, to, reason: flags.reason }));
    console.log(`${id} question readdressed to ${to}`);
    return;
  }

  if (command === "answer") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    await activeStore.mutate((state) => answerQuestion(state, { id, agent, text: flags.text }));
    console.log(`${id} answered and unblocked`);
    return;
  }

  if (command === "withdraw") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    await activeStore.mutate((state) => withdrawQuestion(state, { id, agent, reason: flags.reason }));
    console.log(`${id} question withdrawn with history preserved`);
    return;
  }

  if (command === "ready") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const state = await activeStore.readState();
    const claim = state.claims[id];
    if (!claim) fail(`${id} has no claim`);
    if (claim.agent !== agent) fail(`${id} is held by ${claim.agent}`);
    if (currentBranch() !== claim.branch) fail(`Run ready from ${claim.branch}; current branch is ${currentBranch() || "detached HEAD"}`);
    if (!workingTreeClean()) fail("Commit all work and leave the worktree clean before ready");
    const scope = scopeResult(state, config, agent, id);
    if (scope.trespass.length || scope.undeclared.length) {
      printScope(scope);
      fail("Scope check failed; resolve it before ready");
    }
    if (!scope.changed.length) fail("Refusing readiness with zero changed files; verify the branch and commit");
    const head = runGit(root, ["rev-parse", "HEAD"]);
    const baseHead = runGit(root, ["rev-parse", config.base]);
    const updated = await activeStore.mutate((draft) => markReady(draft, { id, agent, head, baseHead, evidence: flags.evidence }));
    console.log(`${id} ready at ${head.slice(0, 12)}; round ${updated.ready.id}; reviewers ${updated.reviewers.join(", ")}`);
    return;
  }

  if (command === "review") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    if (!workingTreeClean()) fail("Review from a clean worktree");
    const head = runGit(root, ["rev-parse", "HEAD"]);
    const baseHead = runGit(root, ["rev-parse", config.base]);
    const advance = baseAdvanceProof((await activeStore.readState()).claims[id], baseHead);
    const result = await activeStore.mutate((state) => reviewClaim(state, { id, agent, verdict: String(flags.verdict || ""), evidence: flags.evidence, head, baseHead, baseAdvance: advance }));
    if (advance) console.log(`${config.base} advanced ${advance.from.slice(0, 12)}..${baseHead.slice(0, 12)} over ${advance.changed} file${advance.changed === 1 ? "" : "s"}, none in this claim's scope; round kept`);
    console.log(`${flags.verdict} recorded for ${id}; approvals ${result.summary.approved.length}/${result.claim.quorum}`);
    return;
  }

  if (command === "gate") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    if (agent !== config.integrator) fail(`Only configured integrator ${config.integrator} may run the merge gate`);
    const state = await activeStore.readState();
    if (!state.agents[agent]) fail(`${agent} has not joined this project`);
    const claim = state.claims[id];
    if (!claim?.ready) fail(`${id} has no current ready round`);
    if (claim.openQuestion) fail(`${id} still has an open question for ${claim.waitingOn}`);
    const summary = approvalSummary(claim);
    if (!summary.satisfied) fail(`${id} has ${summary.approved.length}/${claim.quorum} required approvals`);
    if (branchHead(claim.branch) !== claim.ready.head) fail(`${claim.branch} changed after review; repeat ready and review`);
    const currentBase = runGit(root, ["rev-parse", config.base]);
    const advance = baseAdvanceProof(claim, currentBase);
    const blocked = baseAdvanceBlocks(state, claim, currentBase, advance);
    if (blocked) fail(blocked);
    if (advance) console.log(`${config.base} advanced ${advance.from.slice(0, 12)}..${currentBase.slice(0, 12)} over ${advance.changed} file${advance.changed === 1 ? "" : "s"}, none in this claim's scope`);
    console.log(`GATE PASS ${id}: integrator ${agent} may merge ${claim.ready.head} into ${config.base}`);
    return;
  }

  if (command === "handoff") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const to = validateAgent(String(flags.to || ""));
    await activeStore.mutate((state) => handoffClaim(state, { id, agent, to, note: flags.note }));
    console.log(`${id} handed from ${agent} to ${to}; readiness invalidated`);
    return;
  }

  if (command === "release") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    await activeStore.mutate((state) => releaseClaim(state, { id, agent, forced: Boolean(flags.force), authority: flags.authority, reason: flags.reason }));
    console.log(`${id} released${flags.force ? " with logged human override" : ""}`);
    return;
  }

  if (command === "done") {
    const id = validateId(target);
    const agent = validateAgent(String(flags.agent || ""));
    const state = await activeStore.readState();
    const claim = state.claims[id];
    if (!claim) fail(`${id} has no claim`);
    const integratedHead = branchHead(claim.branch);
    if (!integratedHead) fail(`Cannot resolve branch head for ${claim.branch}`);
    // Fast-forward and merge commits leave the reviewed commit reachable from the
    // base. Squash and rebase do not, and the project is entitled to either, so a
    // rewritten integration is accepted when it provably introduces the same
    // change — never on the operator's say-so.
    let integration = null;
    const contained = runGit(root, ["merge-base", "--is-ancestor", integratedHead, config.base], { optional: true });
    if (contained === null) {
      const declared = typeof flags["merged-as"] === "string" ? flags["merged-as"] : null;
      if (!declared) {
        fail(`${integratedHead} is not contained in ${config.base}; merge it, or if the project squashes or rebases, pass --merged-as <commit in ${config.base}>`);
      }
      const merged = runGit(root, ["rev-parse", "--verify", `${declared}^{commit}`], { optional: true });
      if (!merged) fail(`--merged-as ${declared} does not name a commit`);
      if (runGit(root, ["merge-base", "--is-ancestor", merged, config.base], { optional: true }) === null) {
        fail(`--merged-as ${merged} is not contained in ${config.base}`);
      }
      const forkPoint = runGit(root, ["merge-base", config.base, integratedHead], { optional: true });
      const parent = runGit(root, ["rev-parse", "--verify", `${merged}^`], { optional: true });
      const reviewedChange = forkPoint && patchIdentity(root, forkPoint, integratedHead);
      const mergedChange = parent && patchIdentity(root, parent, merged);
      if (!reviewedChange || !mergedChange || reviewedChange !== mergedChange) {
        fail(`--merged-as ${merged} does not introduce the same change as ${claim.branch}; compare the two diffs, and if the difference is intended close with --force --authority human --reason "..."`);
      }
      integration = { mode: "equivalent", commit: merged, patchId: mergedChange };
    }
    await activeStore.mutate((draft) => completeClaim(draft, {
      id,
      agent,
      integratedHead,
      integration,
      note: flags.note,
      forced: Boolean(flags.force),
      authority: flags.authority,
      reason: flags.reason,
    }));
    console.log(`${id} marked done${flags.force ? " with logged human override" : ""}`);
    return;
  }

  if (command === "send" || command === "broadcast") {
    const from = validateAgent(String(flags.from || flags.agent || ""));
    const to = command === "broadcast" ? "*" : validateAgent(String(flags.to || ""));
    const text = String(flags.text || positional.slice(1).join(" ")).trim();
    if (!text) fail(`${command} requires --text`);
    const state = await activeStore.readState();
    if (!state.agents[from]) fail(`${from} has not joined this project`);
    if (to !== "*" && !state.agents[to]) fail(`${to} has not joined this project`);
    const task = flags.re ? validateId(String(flags.re)) : null;
    await activeStore.publish({ type: command === "broadcast" ? "message.broadcast" : "message.direct", from, to, ...(task ? { task } : {}), text });
    console.log(command === "broadcast" ? `broadcast from ${from}` : `sent from ${from} to ${to}`);
    return;
  }

  if (command === "read") {
    const agent = validateAgent(String(flags.agent || ""));
    const state = await activeStore.readState();
    if (!state.agents[agent]) fail(`${agent} has not joined this project`);
    await activeStore.mutate((draft) => heartbeatAgent(draft, { agent }));
    const timeoutSeconds = flags.wait ? Number(flags.timeout || 60) : 0;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0 || timeoutSeconds > 3600) fail("timeout must be 0-3600 seconds");
    const count = integerFlag(flags.count || 100, "count", 1, 1000);
    const messages = await activeStore.read(agent, { count, waitMilliseconds: timeoutSeconds * 1000 });
    for (const item of messages) console.log(formatEvent(item));
    if (!messages.length && flags.wait) console.log(`no message within ${timeoutSeconds}s`);
    return;
  }

  if (command === "log") {
    const limit = integerFlag(flags.limit || 25, "limit", 1, 10_000);
    for (const item of await activeStore.log(limit)) console.log(formatEvent(item));
    return;
  }

  fail(`Unknown command: ${command}. Run coord.mjs help`);
}

try {
  await main();
  await printBlockedOnYou();
} catch (error) {
  if (error instanceof CoordError) {
    console.error(error.message);
    process.exitCode = 1;
  } else throw error;
} finally {
  if (activeStore) await activeStore.close();
}

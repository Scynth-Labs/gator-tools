import { randomUUID } from "node:crypto";

export class CoordError extends Error {}

export function fail(message) {
  throw new CoordError(message);
}

export function now() {
  return new Date().toISOString();
}

export function validateId(id) {
  if (!id || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) fail("Task id must be 1-64 letters, digits, dots, underscores, or dashes");
  return id;
}

export function validateAgent(agent) {
  if (!agent || !/^[a-z0-9-]{1,48}$/.test(agent)) fail("Agent name must be 1-48 lowercase letters, digits, or dashes");
  return agent;
}

export function validateProject(project) {
  if (!project || !/^[A-Za-z0-9._-]{1,80}$/.test(project)) fail("Project namespace must be 1-80 letters, digits, dots, underscores, or dashes");
  return project;
}

export function requireEvidence(value, minimum = 15) {
  const evidence = String(value || "").trim();
  if (evidence.length < minimum) fail("Provide concrete evidence naming a file, line, invariant, test, or command result");
  return evidence;
}

export function commaList(value, mapper = (item) => item) {
  if (!value) return [];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean).map(mapper);
}

export function pathsOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function pathCovered(path, declarations) {
  return declarations.some((declaration) => path === declaration || path.startsWith(`${declaration}/`));
}

export function initialState(policy) {
  return {
    version: 2,
    policy: structuredClone(policy),
    agents: {},
    claims: {},
    assignments: {},
    createdAt: now(),
  };
}

export function assertCompatibleState(state, policy) {
  if (state?.version !== 2 || !state.policy || !state.agents || !state.claims) fail("Coordination state has an unsupported format");
  for (const key of ["project", "base", "queue", "reviewQuorum", "integrator", "streamMaxLength"]) {
    if (state.policy[key] !== policy[key]) fail(`Existing project policy disagrees on ${key}`);
  }
  for (const [key, fallback] of Object.entries(POLICY_DEFAULTS)) {
    if ((state.policy[key] ?? fallback) !== (policy[key] ?? fallback)) fail(`Existing project policy disagrees on ${key}`);
  }
  const existingShared = JSON.stringify([...(state.policy.shared || [])].sort());
  const requestedShared = JSON.stringify([...(policy.shared || [])].sort());
  if (existingShared !== requestedShared) fail("Existing project policy disagrees on shared paths");
}

function event(type, from, { to = "*", task = null, text = null, payload = null } = {}) {
  return { type, from, to, ...(task ? { task } : {}), ...(text ? { text } : {}), ...(payload ? { payload } : {}) };
}

function requireJoined(state, agent) {
  validateAgent(agent);
  if (!state.agents[agent]) fail(`${agent} has not joined this project`);
  return state.agents[agent];
}

function requireClaim(state, id) {
  validateId(id);
  const claim = state.claims[id];
  if (!claim) fail(`${id} has no claim`);
  return claim;
}

function requireActive(claim, id) {
  if (!["claimed", "ready"].includes(claim.state)) fail(`${id} is ${claim.state}, not active`);
}

function requireOwner(claim, agent, id) {
  if (claim.agent !== agent) fail(`${id} is held by ${claim.agent}, not ${agent}`);
}

function invalidateReady(claim) {
  claim.ready = null;
  claim.state = "claimed";
}

export function approvalSummary(claim) {
  if (!claim.ready) return { approved: [], missing: claim.reviewers || [], satisfied: false };
  const approved = new Set();
  for (const review of claim.reviews || []) {
    if (review.verdict === "approve" && review.readyId === claim.ready.id && claim.reviewers.includes(review.agent)) approved.add(review.agent);
  }
  const missing = claim.reviewers.filter((reviewer) => !approved.has(reviewer));
  return { approved: [...approved], missing, satisfied: approved.size >= claim.quorum };
}

export function joinAgent(state, { agent, metadata = {}, leaseSeconds }) {
  validateAgent(agent);
  const seconds = Number(leaseSeconds);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 86_400) fail("Lease must be 30-86400 seconds");
  const at = now();
  const existing = state.agents[agent];
  state.agents[agent] = {
    joinedAt: existing?.joinedAt || at,
    lastSeen: at,
    leaseSeconds: seconds,
    leaseUntil: new Date(Date.now() + seconds * 1000).toISOString(),
    metadata,
  };
  return {
    result: state.agents[agent],
    events: [event(existing ? "agent.rejoin" : "agent.join", agent, { payload: { metadata, leaseSeconds: seconds } })],
  };
}

export function heartbeatAgent(state, { agent }) {
  const record = requireJoined(state, agent);
  const at = now();
  record.lastSeen = at;
  record.leaseUntil = new Date(Date.now() + record.leaseSeconds * 1000).toISOString();
  return { result: record, events: [] };
}

export function leaveAgent(state, { agent, forced = false, authority = null, reason = null }) {
  requireJoined(state, agent);
  const held = Object.entries(state.claims).filter(([, claim]) => ["claimed", "ready"].includes(claim.state) && claim.agent === agent).map(([id]) => id);
  if (held.length && !forced) fail(`${agent} still holds active claims: ${held.join(", ")}`);
  if (forced) {
    if (authority !== "human") fail("Forced leave requires --authority human and explicit human authorization");
    requireEvidence(reason, 25);
  }
  delete state.agents[agent];
  return {
    result: { held },
    events: [event(forced ? "agent.forced-leave" : "agent.leave", agent, { payload: { held, ...(forced ? { authority, reason } : {}) } })],
  };
}

export function claimTask(state, { id, agent, branch, files, reviewers }) {
  validateId(id);
  requireJoined(state, agent);
  if (state.claims[id]) fail(`${id} is already ${state.claims[id].state} by ${state.claims[id].agent}`);
  if (!branch) fail("A claim requires an existing feature branch");
  const lane = (state.assignments || {})[id] || null;
  if (lane && lane.assignee !== agent) fail(`${id} is assigned to ${lane.assignee}; take one of your own lanes or have it reassigned`);
  const unmet = unmetDependencies(state, lane?.needs || [], "claim");
  if (unmet.length) fail(`${id} depends on ${unmet.join(", ")}, which ${unmet.length === 1 ? "has" : "have"} not reached a reviewed commit yet`);
  assertPeerDebt(state, agent, `claim ${id}`);
  const uniqueReviewers = [...new Set(reviewers.map(validateAgent))];
  if (uniqueReviewers.includes(agent)) fail("The claim owner cannot review its own work");
  if (uniqueReviewers.length < state.policy.reviewQuorum) fail(`Claim needs at least ${state.policy.reviewQuorum} named reviewer(s)`);
  for (const reviewer of uniqueReviewers) requireJoined(state, reviewer);
  for (const [otherId, claim] of Object.entries(state.claims)) {
    if (!["claimed", "ready"].includes(claim.state)) continue;
    for (const file of files) {
      for (const declared of claim.files || []) {
        if (pathsOverlap(file, declared)) fail(`${file} overlaps ${declared}, held by ${claim.agent} for ${otherId}`);
      }
    }
  }
  for (const [otherId, other] of Object.entries(state.assignments || {})) {
    if (otherId === id) continue;
    for (const file of files) {
      for (const declared of other.files || []) {
        if (pathsOverlap(file, declared)) fail(`${file} overlaps ${declared}, assigned to ${other.assignee} for ${otherId}`);
      }
    }
  }
  const at = now();
  state.claims[id] = {
    agent,
    branch,
    files: [...new Set(files)].sort(),
    reviewers: uniqueReviewers,
    quorum: state.policy.reviewQuorum,
    state: "claimed",
    claimedAt: at,
    reviews: [],
    readiness: [],
    ...(lane ? { aspect: lane.aspect, needs: lane.needs, assignedBy: lane.assigner } : {}),
  };
  // A lane becomes the claim it planned; the assignment record stops existing so
  // scope is declared in exactly one place.
  if (lane) delete state.assignments[id];
  return { result: state.claims[id], events: [event("claim.created", agent, { task: id, payload: { branch, files, reviewers: uniqueReviewers, quorum: state.policy.reviewQuorum, ...(lane ? { aspect: lane.aspect, needs: lane.needs } : {}) } })] };
}

export function amendClaim(state, { id, agent, files }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  const combined = [...new Set([...(claim.files || []), ...files])].sort();
  for (const [otherId, other] of Object.entries(state.claims)) {
    if (otherId === id || !["claimed", "ready"].includes(other.state)) continue;
    for (const file of combined) for (const declared of other.files || []) {
      if (pathsOverlap(file, declared)) fail(`${file} overlaps ${declared}, held by ${other.agent} for ${otherId}`);
    }
  }
  claim.files = combined;
  claim.amendments = [...(claim.amendments || []), { agent, files, at: now() }];
  invalidateReady(claim);
  return { result: claim, events: [event("claim.amended", agent, { task: id, payload: { files } })] };
}

export function setReviewers(state, { id, agent, reviewers, reason }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  const unique = [...new Set(reviewers.map(validateAgent))];
  if (unique.includes(agent)) fail("The claim owner cannot review its own work");
  if (unique.length < claim.quorum) fail(`Claim needs at least ${claim.quorum} named reviewer(s)`);
  for (const reviewer of unique) requireJoined(state, reviewer);
  const evidence = requireEvidence(reason, 20);
  claim.reviewerChanges = [...(claim.reviewerChanges || []), { from: claim.reviewers, to: unique, reason: evidence, at: now() }];
  claim.reviewers = unique;
  invalidateReady(claim);
  return { result: claim, events: [event("claim.reviewers-changed", agent, { task: id, payload: { reviewers: unique, reason: evidence } })] };
}

export function askQuestion(state, { id, agent, to, question }) {
  requireJoined(state, agent);
  requireJoined(state, to);
  if (agent === to) fail("Ask another joined agent, not yourself");
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  if (claim.openQuestion) fail(`${id} already has an open question for ${claim.waitingOn}`);
  if (String(question || "").trim().length < 10) fail("A blocking question needs concrete text");
  claim.openQuestion = { from: agent, to, question: String(question).trim(), at: now() };
  claim.waitingOn = to;
  invalidateReady(claim);
  return { result: claim, events: [event("question.asked", agent, { to, task: id, text: claim.openQuestion.question })] };
}

export function readdressQuestion(state, { id, agent, to, reason }) {
  requireJoined(state, agent);
  requireJoined(state, to);
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  if (!claim.openQuestion) fail(`${id} has no open question`);
  if (claim.openQuestion.from !== agent) fail(`Only ${claim.openQuestion.from} may readdress this question`);
  if (to === agent) fail("Readdress the question to another joined agent");
  const evidence = requireEvidence(reason, 20);
  claim.readdressedQuestions = [...(claim.readdressedQuestions || []), { ...claim.openQuestion, newTo: to, reason: evidence, at: now() }];
  claim.openQuestion.to = to;
  claim.waitingOn = to;
  return { result: claim, events: [event("question.readdressed", agent, { to, task: id, text: claim.openQuestion.question, payload: { reason: evidence } })] };
}

export function answerQuestion(state, { id, agent, text }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  if (!claim.openQuestion) fail(`${id} has no open question`);
  if (claim.waitingOn !== agent) fail(`${id} is waiting on ${claim.waitingOn}, not ${agent}`);
  if (String(text || "").trim().length < 10) fail("An answer needs a concrete decision and rationale");
  const answer = { from: agent, text: String(text).trim(), question: claim.openQuestion.question, at: now() };
  claim.answers = [...(claim.answers || []), answer];
  delete claim.openQuestion;
  delete claim.waitingOn;
  return { result: claim, events: [event("question.answered", agent, { to: claim.agent, task: id, text: answer.text })] };
}

export function withdrawQuestion(state, { id, agent, reason }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  if (!claim.openQuestion) fail(`${id} has no open question`);
  if (claim.openQuestion.from !== agent) fail(`Only ${claim.openQuestion.from} may withdraw this question`);
  const evidence = requireEvidence(reason, 20);
  const to = claim.openQuestion.to;
  claim.withdrawnQuestions = [...(claim.withdrawnQuestions || []), { ...claim.openQuestion, reason: evidence, withdrawnAt: now() }];
  delete claim.openQuestion;
  delete claim.waitingOn;
  return { result: claim, events: [event("question.withdrawn", agent, { to, task: id, payload: { reason: evidence } })] };
}

export function markReady(state, { id, agent, head, baseHead, evidence }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  if (claim.openQuestion) fail(`${id} still has an open question for ${claim.waitingOn}`);
  const unmet = unmetDependencies(state, claim.needs || [], "ready");
  if (unmet.length) fail(`${id} depends on ${unmet.join(", ")}, which ${unmet.length === 1 ? "is" : "are"} not merged yet; readiness would review against work that can still change`);
  assertPeerDebt(state, agent, `mark ${id} ready`);
  const ready = { id: randomUUID(), head, baseHead, evidence: requireEvidence(evidence), at: now() };
  claim.ready = ready;
  claim.readiness = [...(claim.readiness || []), ready];
  claim.state = "ready";
  return { result: claim, events: [event("claim.ready", agent, { task: id, payload: { head, baseHead, readyId: ready.id, reviewers: claim.reviewers, quorum: claim.quorum } })] };
}

export function reviewClaim(state, { id, agent, verdict, evidence, head, baseHead, baseAdvance = null }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  if (claim.agent === agent) fail("Review another agent's work, not your own");
  if (!claim.reviewers.includes(agent)) fail(`${agent} is not a named reviewer for ${id}`);
  if (!claim.ready || claim.state !== "ready") fail(`${id} has no current ready round`);
  if (claim.ready.head !== head) fail(`Review exact ready commit ${claim.ready.head}; current HEAD is ${head}`);
  acceptBaseAdvance(state, claim, baseHead, baseAdvance);
  if (!["approve", "changes"].includes(verdict)) fail("Review verdict must be approve or changes");
  const review = { agent, verdict, evidence: requireEvidence(evidence, 20), head, readyId: claim.ready.id, at: now() };
  claim.reviews = [...(claim.reviews || []), review];
  if (verdict === "changes") invalidateReady(claim);
  const summary = approvalSummary(claim);
  return { result: { claim, summary }, events: [event(`review.${verdict}`, agent, { to: claim.agent, task: id, payload: { evidence: review.evidence, head, readyId: review.readyId, summary } })] };
}

export function handoffClaim(state, { id, agent, to, note }) {
  requireJoined(state, agent);
  requireJoined(state, to);
  if (agent === to) fail("Handoff target must be another joined agent");
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  const evidence = requireEvidence(note, 30);
  claim.agent = to;
  claim.handoffs = [...(claim.handoffs || []), { from: agent, to, note: evidence, at: now() }];
  if (claim.reviewers.includes(to)) claim.reviewers = claim.reviewers.filter((reviewer) => reviewer !== to);
  if (claim.reviewers.length < claim.quorum) fail(`Handoff would leave fewer than ${claim.quorum} eligible named reviewer(s); change reviewers first`);
  invalidateReady(claim);
  return { result: claim, events: [event("claim.handoff", agent, { to, task: id, payload: { note: evidence } })] };
}

export function releaseClaim(state, { id, agent, forced = false, authority = null, reason = null }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  if (forced) {
    if (authority !== "human") fail("Forced release requires explicit human authority");
    requireEvidence(reason, 25);
  }
  if (claim.agent !== agent) {
    if (!forced) fail(`${id} is held by ${claim.agent}; forced release requires explicit human authority`);
  }
  // Releasing a claim other lanes were planned behind would strand them: their
  // dependency stops existing, so nothing could satisfy it again.
  if (!forced) {
    const dependants = Object.entries({ ...(state.assignments || {}), ...state.claims })
      .filter(([otherId, other]) => otherId !== id && (other.needs || []).includes(id) && other.state !== "done")
      .map(([otherId]) => otherId);
    if (dependants.length) fail(`${dependants.join(", ")} still depend on ${id}; re-plan them before releasing it`);
  }
  delete state.claims[id];
  return { result: claim, events: [event(forced ? "claim.forced-release" : "claim.release", agent, { task: id, payload: forced ? { authority, reason, previousAgent: claim.agent } : null })] };
}

export function completeClaim(state, { id, agent, integratedHead, integration = null, note, forced = false, authority = null, reason = null }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  requireActive(claim, id);
  requireOwner(claim, agent, id);
  if (forced) {
    if (authority !== "human") fail("Forced completion requires explicit human authority");
    requireEvidence(reason, 30);
  } else {
    if (claim.openQuestion) fail(`${id} still has an open question for ${claim.waitingOn}`);
    if (!claim.ready || !approvalSummary(claim).satisfied) fail(`${id} lacks its named-reviewer quorum for the current ready round`);
    if (claim.ready.head !== integratedHead) fail(`${claim.branch} changed after review`);
  }
  claim.state = "done";
  claim.doneAt = now();
  claim.note = requireEvidence(note);
  // How the reviewed commit reached the base: contained in it, or merged under a
  // strategy that rewrites commits, in which case the equivalent commit and the
  // patch identity that proved it are recorded rather than asserted.
  if (integration) claim.integration = integration;
  if (forced) claim.override = { authority, reason, agent, at: now() };
  return { result: claim, events: [event(forced ? "claim.forced-done" : "claim.done", agent, { task: id, payload: { integratedHead, ...(integration ? { integration } : {}), note: claim.note, ...(forced ? { authority, reason } : {}) } })] };
}

export function liveAgents(state, at = Date.now()) {
  return Object.entries(state.agents).map(([agent, record]) => ({
    agent,
    ...record,
    presence: Date.parse(record.leaseUntil) >= at ? "live" : "stale",
  })).sort((left, right) => left.agent.localeCompare(right.agent));
}

export function matchingEvents(events, agent) {
  return events.filter((item) => item.to === "*" || item.to === agent);
}

// Policy keys added after a project was initialized. assertCompatibleState reads
// an absent key as its default, so an existing board attaches to a newer CLI
// without a migration and disagrees only when a consumer really changed one.
export const POLICY_DEFAULTS = { baseAdvance: "strict", reviewDebtLimit: 0 };

export function requireAspect(value) {
  const aspect = String(value || "").trim();
  if (aspect.length < 3 || aspect.length > 80) fail("Name the aspect this lane owns in 3-80 characters, such as \"storage layer\"");
  return aspect;
}

export function formatAge(milliseconds) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

function dependencyState(state, id) {
  const claim = state.claims[id];
  if (claim) return claim.state;
  if ((state.assignments || {})[id]) return "assigned";
  return "unknown";
}

// A lane may start once what it depends on exists at a reviewed commit, but it
// may not declare itself ready until that dependency has actually landed —
// otherwise its own review covers work that can still change underneath it.
export function unmetDependencies(state, needs, stage) {
  const satisfying = stage === "ready" ? ["done"] : ["ready", "done"];
  return (needs || []).filter((id) => !satisfying.includes(dependencyState(state, id)));
}

function dependencyEdges(state, id, needs) {
  const edges = new Map();
  for (const [key, claim] of Object.entries(state.claims)) if (claim.needs?.length) edges.set(key, claim.needs);
  for (const [key, lane] of Object.entries(state.assignments || {})) if (lane.needs?.length) edges.set(key, lane.needs);
  edges.set(id, needs);
  return edges;
}

function dependencyCycle(state, id, needs) {
  const edges = dependencyEdges(state, id, needs);
  const walk = (node, trail) => {
    for (const next of edges.get(node) || []) {
      if (next === id) return [...trail, next];
      if (trail.includes(next)) continue;
      const found = walk(next, [...trail, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(id, [id]);
}

export function assignTask(state, { id, agent, to, aspect, files, reviewers, needs }) {
  validateId(id);
  requireJoined(state, agent);
  const assignee = validateAgent(to);
  requireJoined(state, assignee);
  if (state.claims[id]) fail(`${id} is already ${state.claims[id].state} by ${state.claims[id].agent}`);
  if (!state.assignments) state.assignments = {};
  if (state.assignments[id]) fail(`${id} is already assigned to ${state.assignments[id].assignee}; unassign it first`);
  const lane = requireAspect(aspect);
  const declared = [...new Set(files)].sort();
  if (!declared.length) fail("A lane needs at least one exclusive path; disjoint scope is what lets lanes run at the same time");
  const uniqueReviewers = [...new Set(reviewers.map(validateAgent))];
  if (uniqueReviewers.includes(assignee)) fail("A lane's owner cannot review its own work");
  if (uniqueReviewers.length < state.policy.reviewQuorum) fail(`Lane needs at least ${state.policy.reviewQuorum} named reviewer(s)`);
  for (const reviewer of uniqueReviewers) requireJoined(state, reviewer);
  for (const [otherId, claim] of Object.entries(state.claims)) {
    if (!["claimed", "ready"].includes(claim.state)) continue;
    for (const file of declared) for (const held of claim.files || []) {
      if (pathsOverlap(file, held)) fail(`${file} overlaps ${held}, held by ${claim.agent} for ${otherId}; these cannot run in parallel`);
    }
  }
  for (const [otherId, other] of Object.entries(state.assignments)) {
    for (const file of declared) for (const held of other.files || []) {
      if (pathsOverlap(file, held)) fail(`${file} overlaps ${held}, assigned to ${other.assignee} for ${otherId}; these cannot run in parallel`);
    }
  }
  const dependencies = [...new Set((needs || []).map(validateId))];
  for (const need of dependencies) {
    if (need === id) fail(`${id} cannot depend on itself`);
    if (dependencyState(state, need) === "unknown") fail(`${id} cannot depend on ${need}, which is neither assigned nor claimed`);
  }
  const cycle = dependencyCycle(state, id, dependencies);
  if (cycle) fail(`That dependency closes a cycle and nothing in it could ever start: ${cycle.join(" -> ")}`);
  state.assignments[id] = {
    aspect: lane,
    assignee,
    assigner: agent,
    files: declared,
    reviewers: uniqueReviewers,
    needs: dependencies,
    assignedAt: now(),
  };
  return {
    result: state.assignments[id],
    events: [event("lane.assigned", agent, { to: assignee, task: id, payload: { aspect: lane, files: declared, reviewers: uniqueReviewers, needs: dependencies } })],
  };
}

export function unassignTask(state, { id, agent, reason }) {
  requireJoined(state, agent);
  validateId(id);
  const lane = (state.assignments || {})[id];
  if (!lane) fail(`${id} is not an open assignment`);
  if (![lane.assignee, lane.assigner, state.policy.integrator].includes(agent)) {
    fail(`${id} belongs to ${lane.assignee}; only its assignee, ${lane.assigner}, or integrator ${state.policy.integrator} may withdraw it`);
  }
  const evidence = requireEvidence(reason, 20);
  const dependants = Object.entries({ ...state.assignments, ...state.claims })
    .filter(([otherId, other]) => otherId !== id && (other.needs || []).includes(id) && other.state !== "done")
    .map(([otherId]) => otherId);
  if (dependants.length) fail(`${dependants.join(", ")} still depend on ${id}; withdraw or re-plan those first`);
  delete state.assignments[id];
  return { result: lane, events: [event("lane.unassigned", agent, { to: lane.assignee, task: id, payload: { reason: evidence } })] };
}

// What other agents are currently stalled on this one. This is the whole point:
// every command can report it, so an agent cannot work for an hour without being
// told a partner is waiting.
export function pendingReviews(state, agent, atMs = Date.now()) {
  const pending = [];
  for (const [id, claim] of Object.entries(state.claims)) {
    if (claim.state !== "ready" || !claim.ready) continue;
    if (claim.agent === agent || !(claim.reviewers || []).includes(agent)) continue;
    if ((claim.reviews || []).some((review) => review.agent === agent && review.readyId === claim.ready.id)) continue;
    pending.push({ id, kind: "review", owner: claim.agent, head: claim.ready.head, readyId: claim.ready.id, since: claim.ready.at, waitingMs: atMs - Date.parse(claim.ready.at) });
  }
  return pending.sort((left, right) => right.waitingMs - left.waitingMs);
}

export function pendingQuestions(state, agent, atMs = Date.now()) {
  const pending = [];
  for (const [id, claim] of Object.entries(state.claims)) {
    if (!["claimed", "ready"].includes(claim.state) || claim.waitingOn !== agent || !claim.openQuestion) continue;
    pending.push({ id, kind: "question", owner: claim.openQuestion.from, question: claim.openQuestion.question, since: claim.openQuestion.at, waitingMs: atMs - Date.parse(claim.openQuestion.at) });
  }
  return pending.sort((left, right) => right.waitingMs - left.waitingMs);
}

export function pendingGates(state, agent, atMs = Date.now()) {
  if (agent !== state.policy.integrator) return [];
  const pending = [];
  for (const [id, claim] of Object.entries(state.claims)) {
    if (claim.state !== "ready" || !claim.ready || claim.openQuestion) continue;
    if (!approvalSummary(claim).satisfied) continue;
    pending.push({ id, kind: "gate", owner: claim.agent, head: claim.ready.head, since: claim.ready.at, waitingMs: atMs - Date.parse(claim.ready.at) });
  }
  return pending.sort((left, right) => right.waitingMs - left.waitingMs);
}

export function obligations(state, agent, atMs = Date.now()) {
  return [...pendingQuestions(state, agent, atMs), ...pendingReviews(state, agent, atMs), ...pendingGates(state, agent, atMs)]
    .sort((left, right) => right.waitingMs - left.waitingMs);
}

// Refusing to start or finish work while a partner has been blocked past the
// configured limit. It cannot deadlock: the debt is always dischargeable, since
// review and answer are never themselves gated.
export function assertPeerDebt(state, agent, action, atMs = Date.now()) {
  const limit = Number(state.policy?.reviewDebtLimit ?? POLICY_DEFAULTS.reviewDebtLimit);
  if (!limit) return [];
  const overdue = [...pendingQuestions(state, agent, atMs), ...pendingReviews(state, agent, atMs)]
    .filter((item) => item.waitingMs >= limit * 1000)
    .sort((left, right) => right.waitingMs - left.waitingMs);
  if (!overdue.length) return [];
  const detail = overdue.map((item) => `${item.id} (${item.kind} for ${item.owner}, waiting ${formatAge(item.waitingMs)})`).join(", ");
  fail(`Cannot ${action} while a partner has been blocked on you longer than ${formatAge(limit * 1000)}: ${detail}. Clear it with review or answer first.`);
}

function claimNeed(state, id, claim, atMs) {
  if (claim.openQuestion) return { action: "blocked", detail: `waiting on ${claim.waitingOn} for ${formatAge(atMs - Date.parse(claim.openQuestion.at))}` };
  if (claim.state === "ready") {
    const summary = approvalSummary(claim);
    if (summary.satisfied) return { action: "gate", detail: `quorum met; integrator ${state.policy.integrator} can gate ${id}` };
    return { action: "await-review", detail: `${summary.approved.length}/${claim.quorum} approved; waiting on ${summary.missing.join(", ")}` };
  }
  const unmet = unmetDependencies(state, claim.needs || [], "ready");
  if (unmet.length) return { action: "implement", detail: `implement now, but ${unmet.join(", ")} must merge before ready` };
  return { action: "implement", detail: "implement, then record ready" };
}

// One prioritized answer to "what do I do next", with a partner's blocked work
// ranked above this agent's own.
export function worklist(state, agent, atMs = Date.now()) {
  const own = Object.entries(state.claims)
    .filter(([, claim]) => ["claimed", "ready"].includes(claim.state) && claim.agent === agent)
    .map(([id, claim]) => ({ id, aspect: claim.aspect || null, state: claim.state, ...claimNeed(state, id, claim, atMs) }))
    .sort((left, right) => left.id.localeCompare(right.id));
  const lanes = Object.entries(state.assignments || {})
    .filter(([, lane]) => lane.assignee === agent)
    .map(([id, lane]) => ({ id, aspect: lane.aspect, files: lane.files, reviewers: lane.reviewers, blockedBy: unmetDependencies(state, lane.needs, "claim") }))
    .sort((left, right) => left.blockedBy.length - right.blockedBy.length || left.id.localeCompare(right.id));
  return { obligations: obligations(state, agent, atMs), own, lanes };
}

function baseAdvanceRefusal(state, claim, baseHead, proof) {
  const stale = "Integration base moved since ready; the owner must synchronize and create a new ready round";
  if ((state.policy?.baseAdvance ?? POLICY_DEFAULTS.baseAdvance) !== "disjoint") return stale;
  if (!proof || proof.from !== claim.ready.baseHead || proof.to !== baseHead) return stale;
  if (!proof.fastForward) return `${stale}: the base was rewritten rather than advanced`;
  if (proof.touched?.length) return `Integration base advanced into this claim's own scope (${proof.touched.join(", ")}); synchronize and create a new ready round`;
  return null;
}

// Under the disjoint policy a base advance that git proves touched none of the
// claim's declared files leaves the round standing, so parallel lanes do not
// re-review each other's merges. It proves only that: cross-lane semantic
// conflicts remain the project's merge-time checks to catch.
export function acceptBaseAdvance(state, claim, baseHead, proof) {
  if (!claim.ready || claim.ready.baseHead === baseHead) return null;
  const refusal = baseAdvanceRefusal(state, claim, baseHead, proof);
  if (refusal) fail(refusal);
  const record = { from: proof.from, to: baseHead, changed: proof.changed, at: now() };
  claim.ready.baseHead = baseHead;
  claim.ready.baseAdvances = [...(claim.ready.baseAdvances || []), record];
  return record;
}

export function baseAdvanceBlocks(state, claim, baseHead, proof) {
  if (!claim?.ready || claim.ready.baseHead === baseHead) return null;
  return baseAdvanceRefusal(state, claim, baseHead, proof);
}

// The board is the source of truth for policy, so changing it is one recorded
// act by the integrator rather than an edit to a local config file that other
// machines would never see.
export function setPolicy(state, { agent, baseAdvance, reviewDebtLimit, reason }) {
  requireJoined(state, agent);
  if (agent !== state.policy.integrator) fail(`Only configured integrator ${state.policy.integrator} may change coordination policy`);
  const evidence = requireEvidence(reason, 20);
  const before = {
    baseAdvance: state.policy.baseAdvance ?? POLICY_DEFAULTS.baseAdvance,
    reviewDebtLimit: state.policy.reviewDebtLimit ?? POLICY_DEFAULTS.reviewDebtLimit,
  };
  const after = {
    baseAdvance: baseAdvance ?? before.baseAdvance,
    reviewDebtLimit: reviewDebtLimit ?? before.reviewDebtLimit,
  };
  if (!["strict", "disjoint"].includes(after.baseAdvance)) fail("base-advance must be strict or disjoint");
  if (after.baseAdvance === before.baseAdvance && after.reviewDebtLimit === before.reviewDebtLimit) fail("Coordination policy already has those values");
  Object.assign(state.policy, after);
  return { result: { before, after }, events: [event("policy.changed", agent, { payload: { before, after, reason: evidence } })] };
}

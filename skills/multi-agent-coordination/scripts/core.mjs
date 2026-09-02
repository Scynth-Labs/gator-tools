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
    createdAt: now(),
  };
}

export function assertCompatibleState(state, policy) {
  if (state?.version !== 2 || !state.policy || !state.agents || !state.claims) fail("Coordination state has an unsupported format");
  for (const key of ["project", "base", "queue", "reviewQuorum", "integrator", "streamMaxLength"]) {
    if (state.policy[key] !== policy[key]) fail(`Existing project policy disagrees on ${key}`);
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
  };
  return { result: state.claims[id], events: [event("claim.created", agent, { task: id, payload: { branch, files, reviewers: uniqueReviewers, quorum: state.policy.reviewQuorum } })] };
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
  const ready = { id: randomUUID(), head, baseHead, evidence: requireEvidence(evidence), at: now() };
  claim.ready = ready;
  claim.readiness = [...(claim.readiness || []), ready];
  claim.state = "ready";
  return { result: claim, events: [event("claim.ready", agent, { task: id, payload: { head, baseHead, readyId: ready.id, reviewers: claim.reviewers, quorum: claim.quorum } })] };
}

export function reviewClaim(state, { id, agent, verdict, evidence, head, baseHead }) {
  requireJoined(state, agent);
  const claim = requireClaim(state, id);
  if (claim.agent === agent) fail("Review another agent's work, not your own");
  if (!claim.reviewers.includes(agent)) fail(`${agent} is not a named reviewer for ${id}`);
  if (!claim.ready || claim.state !== "ready") fail(`${id} has no current ready round`);
  if (claim.ready.head !== head) fail(`Review exact ready commit ${claim.ready.head}; current HEAD is ${head}`);
  if (claim.ready.baseHead !== baseHead) fail(`Integration base moved since ready; the owner must synchronize and create a new ready round`);
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

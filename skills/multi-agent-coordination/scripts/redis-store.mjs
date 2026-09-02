import { assertCompatibleState, fail, matchingEvents, now } from "./core.mjs";

function streamEvent(item) {
  return { at: now(), ...item };
}

export class RedisStore {
  static async connect({ url, policy }) {
    if (!url) fail("Redis backend requires COORD_REDIS_URL (or the configured redisUrlEnv variable)");
    let redis;
    try {
      redis = await import("redis");
    } catch {
      fail("Redis backend requires the optional package: run npm install in the skill directory");
    }
    const client = redis.createClient({ url });
    let connectionError = null;
    client.on("error", (error) => { connectionError = error; });
    try {
      await client.connect();
      await client.ping();
    } catch (error) {
      await client.close().catch(() => {});
      fail(`Could not connect to Redis: ${(connectionError || error).message}`);
    }
    return new RedisStore(client, redis.WatchError, policy);
  }

  constructor(client, WatchError, policy) {
    this.client = client;
    this.WatchError = WatchError;
    this.policy = policy;
    const tag = `{${policy.project}}`;
    this.stateKey = `agent-coord:${tag}:state`;
    this.streamKey = `agent-coord:${tag}:events`;
    this.cursorsKey = `agent-coord:${tag}:cursors`;
  }

  async initialize(initial) {
    const serialized = JSON.stringify(initial);
    const created = await this.client.set(this.stateKey, serialized, { NX: true });
    if (created) return { created: true, state: initial };
    const state = await this.readState();
    assertCompatibleState(state, this.policy);
    return { created: false, state };
  }

  async readState() {
    const raw = await this.client.get(this.stateKey);
    if (!raw) fail("Redis coordination state is not initialized for this project namespace");
    return JSON.parse(raw);
  }

  addEvent(transaction, item) {
    return transaction.xAdd(this.streamKey, "*", { json: JSON.stringify(streamEvent(item)) }, {
      TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: Number(this.policy.streamMaxLength || 10_000) },
    });
  }

  async mutate(mutator) {
    for (let attempt = 0; attempt < 25; attempt += 1) {
      await this.client.watch(this.stateKey);
      let draft;
      let outcome;
      try {
        draft = structuredClone(await this.readState());
        outcome = mutator(draft);
      } catch (error) {
        await this.client.unwatch();
        throw error;
      }
      let transaction = this.client.multi().set(this.stateKey, JSON.stringify(draft));
      for (const item of outcome.events || []) transaction = this.addEvent(transaction, item);
      try {
        const replies = await transaction.exec();
        if (replies === null) continue;
        return outcome.result;
      } catch (error) {
        if ((this.WatchError && error instanceof this.WatchError) || error?.name === "WatchError") continue;
        throw error;
      }
    }
    fail("Redis coordination state changed too often; retry after current writers settle");
  }

  async publish(item) {
    const id = await this.client.xAdd(this.streamKey, "*", { json: JSON.stringify(streamEvent(item)) }, {
      TRIM: { strategy: "MAXLEN", strategyModifier: "~", threshold: Number(this.policy.streamMaxLength || 10_000) },
    });
    return { id, ...item };
  }

  async ensureCursor(agent) {
    const existing = await this.client.hGet(this.cursorsKey, agent);
    if (existing !== null) return existing;
    const tail = await this.client.xRevRange(this.streamKey, "+", "-", { COUNT: 1 });
    const initial = tail[0]?.id || "0-0";
    await this.client.hSetNX(this.cursorsKey, agent, initial);
    return await this.client.hGet(this.cursorsKey, agent) || initial;
  }

  async read(agent, { count = 100, waitMilliseconds = 0 } = {}) {
    let cursor = await this.ensureCursor(agent);
    const deadline = Date.now() + waitMilliseconds;
    while (true) {
      const remaining = waitMilliseconds > 0 ? Math.max(1, deadline - Date.now()) : 0;
      if (waitMilliseconds > 0 && remaining <= 1 && Date.now() >= deadline) return [];
      const options = { COUNT: count, ...(waitMilliseconds > 0 ? { BLOCK: remaining } : {}) };
      const reply = await this.client.xRead({ key: this.streamKey, id: cursor }, options);
      const entries = reply?.flatMap((stream) => stream.messages || []) || [];
      if (!entries.length) return [];
      cursor = entries.at(-1).id;
      const decoded = entries.map((entry) => ({ id: entry.id, ...JSON.parse(entry.message.json) }));
      await this.client.hSet(this.cursorsKey, agent, cursor);
      const matching = matchingEvents(decoded, agent);
      if (matching.length) return matching;
      if (waitMilliseconds <= 0) continue;
    }
  }

  async log(limit = 25) {
    const entries = await this.client.xRevRange(this.streamKey, "+", "-", { COUNT: limit });
    return entries.reverse().map((entry) => ({ id: entry.id, ...JSON.parse(entry.message.json) }));
  }

  unlock() {
    fail("Redis uses optimistic transactions and has no coordination mutex to unlock");
  }

  async close() {
    if (this.client.isOpen) await this.client.close();
  }
}

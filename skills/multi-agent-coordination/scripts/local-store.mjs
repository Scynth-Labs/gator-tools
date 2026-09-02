import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  watch,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { assertCompatibleState, fail, matchingEvents, now } from "./core.mjs";

function sleep(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function writeJsonAtomically(path, value) {
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
    renameSync(temporary, path);
  } finally {
    if (existsSync(temporary)) rmSync(temporary);
  }
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export class LocalStore {
  constructor(directory, policy) {
    this.directory = directory;
    this.policy = policy;
    this.statePath = join(directory, "state.json");
    this.lockPath = join(directory, "mutation.lock");
    mkdirSync(directory, { recursive: true });
  }

  withLock(operation) {
    let handle;
    let lockInode;
    let staleLooking = false;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      try {
        handle = openSync(this.lockPath, "wx");
        writeFileSync(handle, JSON.stringify({ pid: process.pid, at: now() }));
        lockInode = fstatSync(handle).ino;
        break;
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > 60_000) staleLooking = true;
        } catch (staleError) {
          if (staleError.code !== "ENOENT") throw staleError;
        }
        sleep(25);
      }
    }
    if (handle === undefined) {
      const recovery = staleLooking ? " It is older than 60 seconds; verify no process is active, then use the human-authorized unlock command." : "";
      fail(`Coordination state stayed locked for 5 seconds.${recovery}`);
    }
    try {
      return operation();
    } finally {
      closeSync(handle);
      try {
        if (statSync(this.lockPath).ino === lockInode) unlinkSync(this.lockPath);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }

  initialize(initial) {
    return this.withLock(() => {
      if (existsSync(this.statePath)) {
        const state = readJson(this.statePath);
        assertCompatibleState(state, this.policy);
        return { created: false, state };
      }
      const state = { ...initial, events: [], cursors: {}, nextEventId: 0 };
      writeJsonAtomically(this.statePath, state);
      return { created: true, state };
    });
  }

  readState() {
    if (!existsSync(this.statePath)) fail("Local coordination state is not initialized");
    return readJson(this.statePath);
  }

  addEvents(state, events) {
    for (const item of events || []) {
      state.nextEventId += 1;
      state.events.push({ id: String(state.nextEventId), at: now(), ...item });
    }
    const maximum = Number(this.policy.streamMaxLength || 10_000);
    if (state.events.length > maximum) state.events = state.events.slice(-maximum);
  }

  mutate(mutator) {
    return this.withLock(() => {
      const state = this.readState();
      const draft = structuredClone(state);
      const outcome = mutator(draft);
      this.addEvents(draft, outcome.events);
      writeJsonAtomically(this.statePath, draft);
      return outcome.result;
    });
  }

  publish(item) {
    return this.withLock(() => {
      const state = this.readState();
      this.addEvents(state, [item]);
      writeJsonAtomically(this.statePath, state);
      return state.events.at(-1);
    });
  }

  ensureCursor(agent) {
    return this.withLock(() => {
      const state = this.readState();
      if (state.cursors[agent] === undefined) {
        state.cursors[agent] = String(state.nextEventId || 0);
        writeJsonAtomically(this.statePath, state);
      }
      return state.cursors[agent];
    });
  }

  readAvailable(agent, count) {
    return this.withLock(() => {
      const state = this.readState();
      const cursor = Number(state.cursors[agent] || 0);
      const available = state.events.filter((item) => Number(item.id) > cursor).slice(0, count);
      if (available.length) {
        state.cursors[agent] = available.at(-1).id;
        writeJsonAtomically(this.statePath, state);
      }
      return { matching: matchingEvents(available, agent), scanned: available.length };
    });
  }

  async read(agent, { count = 100, waitMilliseconds = 0 } = {}) {
    this.ensureCursor(agent);
    const drain = () => {
      while (true) {
        const result = this.readAvailable(agent, count);
        if (result.matching.length || result.scanned < count) return result.matching;
      }
    };
    const first = drain();
    if (first.length || waitMilliseconds <= 0) return first;
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        watcher.close();
        clearTimeout(timer);
        resolve(value);
      };
      const check = () => {
        try {
          const messages = drain();
          if (messages.length) finish(messages);
        } catch (error) {
          watcher.close();
          clearTimeout(timer);
          reject(error);
        }
      };
      const watcher = watch(this.directory, (_event, filename) => {
        if (!filename || String(filename) === "state.json") check();
      });
      const timer = setTimeout(() => finish([]), waitMilliseconds);
      check();
    });
  }

  log(limit = 25) {
    return this.readState().events.slice(-limit);
  }

  unlock({ authority, reason }) {
    if (authority !== "human") fail("Lock recovery requires --authority human and explicit human authorization");
    if (String(reason || "").trim().length < 30) fail("Lock recovery needs a concrete reason");
    if (!existsSync(this.lockPath)) fail("No mutation.lock exists");
    const previous = readFileSync(this.lockPath, "utf8");
    unlinkSync(this.lockPath);
    this.publish({ type: "system.forced-unlock", from: "human", to: "*", payload: { reason, previous } });
  }

  async close() {}
}

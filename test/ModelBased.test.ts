/**
 * Model-based tests: random (and, for short lengths, exhaustive) sequences of
 * edits, additions, removals, undo, redo, saves, failed saves, edits during a
 * save and discards, against a fake server that stores what it receives. After
 * every step:
 *   - if `isDirty` is false, the server has exactly what the model shows;
 *   - after a completed save, the server has exactly what the model shows;
 *   - undo followed by redo gives back exactly the previous state.
 * A failure reports the seed and the steps, so it can be replayed.
 */
import { describe, it, expect } from "vitest";
import { UnitOfWork, Entity, EntityContainer, TrackedCollection, Tracked, AutoId, type CommitBatch as UowBatch } from "@katn30/chronicle-unit-of-work";
import {
  EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, Id, AutoId as EAutoId,
  type CommitBatch as EventBatch, type CommitMode,
} from "@katn30/chronicle-event-log";

// ---------------------------------------------------------------------------- deterministic randomness

function prng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    pick: <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)],
  };
}
type Rng = ReturnType<typeof prng>;

const VALUES = ["", "a", "b", "c"];

/** The steps a batch is made of. */
const BATCHED = ["title", "add", "remove", "readd", "edit", "replace", "sort", "reset"];

function shuffled<T>(items: T[], r: Rng): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = r.int(i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A batch whose action throws after writing: nothing of it may remain. */
function failingBatch<W extends { tracker: { batch(action: () => void): void }; view(): string }>(
  w: W, r: Rng, steps: Record<string, (w: W, r: Rng) => void>,
): void {
  const before = w.view();
  try {
    w.tracker.batch(() => {
      for (let i = 0; i < 2; i++) steps[r.pick(BATCHED)](w, r);
      throw new Error("cancelled");
    });
  } catch {
    // expected
  }
  if (w.view() !== before) throw new Error(`a failed batch left changes: ${before} → ${w.view()}`);
}
const NUMBERS = [0, 1, 2, 3];

// ============================================================================ UnitOfWork

// Validators that read other objects and the collection: validity must stay current through every step.
class UItem extends Entity {
  @AutoId id: number | null = null;
  @Tracked((_s, v: number) => (v === 3 ? "three" : undefined)) accessor v: number = 0;
  constructor(t: UnitOfWork, v = 0) { super(t); this.v = v; }
}

class UDoc extends EntityContainer {
  @AutoId id: number | null = null;
  @Tracked((self: UDoc, t: string) => (t === "a" && self.items !== undefined && self.items.length > 2 ? "a: at most 2" : undefined))
  accessor title: string = "";
  readonly items = new TrackedCollection<UItem>(this.tracker, [], (items) =>
    (this.title === "c" && items.some((i) => i.v === 2) ? "c: no 2" : undefined));
  constructor(t: UnitOfWork) { super(t); this.trackChild(this.items); }
}

/** What the server stores for a UnitOfWork. */
class UServer {
  title = "t0";
  items = new Map<number, number>([[10, 1], [11, 2]]);
  private nextId = 100;
  errors: string[] = [];

  save(batch: UowBatch) {
    const keys: { chronicleId: number; value: number }[] = [];
    for (const obj of batch.inserted) {
      if (!(obj instanceof UItem)) { this.errors.push("inserted a non-item"); continue; }
      const id = this.nextId++;
      this.items.set(id, obj.v);
      keys.push({ chronicleId: obj.chronicleId, value: id });
    }
    for (const obj of batch.changed) {
      if (obj instanceof UDoc) this.title = obj.title;
      else if (obj instanceof UItem) {
        if (obj.id === null || !this.items.has(obj.id)) this.errors.push(`update of unknown item ${obj.id}`);
        else this.items.set(obj.id, obj.v);
      }
    }
    for (const obj of batch.deleted) {
      if (!(obj instanceof UItem) || obj.id === null || !this.items.has(obj.id)) this.errors.push(`delete of unknown ${obj instanceof UItem ? obj.id : "object"}`);
      else this.items.delete(obj.id);
    }
    return keys;
  }

  view(): string {
    return JSON.stringify({ title: this.title, items: [...this.items].sort((x, y) => x[0] - y[0]) });
  }
}

function uowWorld() {
  const tracker = new UnitOfWork();
  const doc = tracker.construct(() => {
    const d = new UDoc(tracker);
    d.id = 1;
    d.title = "t0";
    const a = new UItem(tracker, 1); a.id = 10;
    const b = new UItem(tracker, 2); b.id = 11;
    d.items.push(a, b);
    return d;
  });
  const pool: UItem[] = [...doc.items.collection];
  const server = new UServer();
  const view = () => JSON.stringify({
    title: doc.title,
    items: doc.items.collection.map((i) => [i.id, i.v]).sort((x, y) => (x[0] ?? -1) - (y[0] ?? -1)),
  });
  return { tracker, doc, pool, server, view };
}
type UWorld = ReturnType<typeof uowWorld>;

const uowSteps: Record<string, (w: UWorld, r: Rng) => void> = {
  title: (w, r) => { w.doc.title = r.pick(VALUES); },
  add: (w, r) => { const it = w.tracker.new(() => new UItem(w.tracker, r.pick(NUMBERS))); w.pool.push(it); w.doc.items.push(it); },
  remove: (w, r) => { if (w.doc.items.length) w.doc.items.remove(r.pick(w.doc.items.collection)); },
  readd: (w, r) => { const out = w.pool.filter((i) => !w.doc.items.includes(i)); if (out.length) w.doc.items.push(r.pick(out)); },
  edit: (w, r) => { if (w.doc.items.length) r.pick(w.doc.items.collection).v = r.pick(NUMBERS); },
  editRemoved: (w, r) => { const out = w.pool.filter((i) => !w.doc.items.includes(i)); if (out.length) r.pick(out).v = r.pick(NUMBERS); },
  replace: (w, r) => { if (w.doc.items.length) w.doc.items[r.int(w.doc.items.length)] = w.tracker.new(() => new UItem(w.tracker, r.pick(NUMBERS))); },
  sort: (w) => { w.doc.items.sort((x, y) => x.v - y.v); },
  reset: (w, r) => { w.doc.items.reset(shuffled(w.pool.filter(() => r.int(2) === 0), r)); },
  batch: (w, r) => { w.tracker.batch(() => { for (let i = 0; i < 2; i++) uowSteps[r.pick(BATCHED)](w, r); }); },
  batchFail: (w, r) => failingBatch(w, r, uowSteps),
  undo: (w) => { w.tracker.undo(); },
  redo: (w) => { w.tracker.redo(); },
  undoRedo: (w) => {
    if (!w.tracker.canUndo) return;
    const before = w.view();
    w.tracker.undo();
    w.tracker.redo();
    if (w.view() !== before) throw new Error(`undo+redo changed the state: ${before} → ${w.view()}`);
  },
  discard: (w) => { w.tracker.discardPendingChanges(); },
};

async function uowCommit(w: UWorld, r: Rng, log: string[]): Promise<void> {
  const kind = r.int(4);
  if (kind === 0) {
    // a save that fails: nothing is committed
    await w.tracker.commit(() => { throw new Error("offline"); }).catch(() => undefined);
    log.push("commit:fail");
    return;
  }
  if (kind === 1) {
    // a save that runs while other steps happen
    let release!: () => void;
    const running = w.tracker.commit((b) => { const keys = w.server.save(b); return new Promise<typeof keys>((res) => { release = () => res(keys); }); });
    await Promise.resolve();
    const during = r.int(3);
    for (let i = 0; i < during; i++) {
      const name = r.pick(Object.keys(uowSteps).filter((s) => s !== "discard"));
      uowSteps[name](w, r);
      log.push(`  during:${name}`);
    }
    release?.();
    await running;
    log.push("commit:async");
    return;
  }
  await w.tracker.commit((b) => w.server.save(b));
  log.push("commit");
  expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "after a save");
}

/** Validity as chronicle reports it: the tracker's, each object's own, each collection's error. */
function validity(tracker: UnitOfWork | EventLog): string {
  return JSON.stringify([
    tracker.isValid,
    tracker._trackedObjects.map((o) => o._isOwnValid),
    tracker._trackedCollections.map((c) => c.error ?? null),
  ]);
}

/** What chronicle reports must be what running every validator again gives. */
function expectValidityCurrent(tracker: UnitOfWork | EventLog, log: string[]): void {
  const reported = validity(tracker);
  tracker._revalidate();
  const full = validity(tracker);
  if (reported !== full) throw new Error(`stale validity: ${reported}\n  expected ${full}\n  steps:\n    ${log.join("\n    ")}`);
}

function expectSame(server: string, local: string, dirty: boolean, log: string[], when: string) {
  if (server !== local || dirty) {
    throw new Error(`${when}: server ${server}\n  model  ${local}\n  isDirty ${dirty}\n  steps:\n    ${log.join("\n    ")}`);
  }
}

async function runUow(seed: number, length: number): Promise<void> {
  const r = prng(seed);
  const w = uowWorld();
  const log: string[] = [`seed ${seed}`];
  const names = [...Object.keys(uowSteps), "commit", "commit"];
  for (let step = 0; step < length; step++) {
    const name = r.pick(names);
    if (name === "commit") await uowCommit(w, r, log);
    else { uowSteps[name](w, r); log.push(name); }
    if (w.server.errors.length) throw new Error(`server rejected: ${w.server.errors.join(", ")}\n  steps:\n    ${log.join("\n    ")}`);
    if (!w.tracker.isDirty && !w.tracker.isSaving) expectSame(w.server.view(), w.view(), false, log, "not dirty");
    expectValidityCurrent(w.tracker, log);
  }
  await w.tracker.commit((b) => w.server.save(b));
  log.push("final commit");
  expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "at the end");
}

async function runUowSequence(names: string[]): Promise<void> {
  const r = prng(names.length);
  const w = uowWorld();
  const log: string[] = [...names];
  for (const name of names) {
    if (name === "commit") { await w.tracker.commit((b) => w.server.save(b)); expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "after a save"); }
    else uowSteps[name](w, r);
    if (!w.tracker.isDirty) expectSame(w.server.view(), w.view(), false, log, "not dirty");
    expectValidityCurrent(w.tracker, log);
  }
  await w.tracker.commit((b) => w.server.save(b));
  expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "at the end");
}

// ============================================================================ EventLog

class ECard extends TrackedObject {
  @EAutoId id: number | null = null;
  @EventTracked((_s, t: string) => (t === "c" ? "no c" : undefined)) accessor text: string = "";
  constructor(t: EventLog, text = "") { super(t); this.text = text; }
}

class EMeta extends TrackedObject {
  @EventTracked() accessor note: string = "";
  constructor(t: EventLog) { super(t); }
}

class EBoard extends TrackedContainer {
  @Id id = "b";
  @EventTracked((self: EBoard, t: string) => (t === "a" && self.cards !== undefined && self.cards.length > 2 ? "a: at most 2" : undefined))
  accessor title: string = "";
  @EventTracked(undefined, undefined, { history: true }) accessor log: string = "";
  readonly meta: EMeta;
  readonly cards = new EventTrackedCollection<ECard>(this.tracker, "cards", [], (cards) =>
    (cards.some((c) => c.text === "a") && this.meta?.note === "a" ? "a with a" : cards.length === 0 && this.title === "b" ? "b: empty" : undefined));
  constructor(t: EventLog) {
    super(t);
    this.meta = t.construct(() => new EMeta(t));
    this.trackChild(this.meta, "meta");
    this.trackChild(this.cards);
  }
}

type Ref = number | { chronicleId: number };

/** What the server stores for an EventLog: it applies the events it receives. */
class EServer {
  title = "t0";
  logValue = "";
  note = "";
  cards = new Map<number, string>([[10, "x"], [11, "y"]]);
  private nextId = 100;
  private byChronicleId = new Map<number, number>();
  errors: string[] = [];

  private resolve(ref: Ref | Record<string, unknown>): number | undefined {
    if (typeof ref === "number") return ref;
    const rec = ref as Record<string, unknown>;
    if (typeof rec.id === "number") return rec.id;
    if (typeof rec.chronicleId === "number") return this.byChronicleId.get(rec.chronicleId);
    return undefined;
  }

  save(batch: EventBatch) {
    const keys: { chronicleId: number; value: number }[] = [];
    for (const event of batch.events) {
      if (event.targetId !== "b") { this.errors.push(`event for an unexpected root: ${JSON.stringify(event)}`); continue; }
      const p = event.payload as Record<string, unknown>;
      if ("title" in p) this.title = p.title as string;
      if ("log" in p) {
        const entries = p.log as { value: string }[];
        if (entries.length) this.logValue = entries[entries.length - 1].value;
      }
      if ("meta" in p) {
        const meta = p.meta as Record<string, unknown>;
        if ("note" in meta) this.note = meta.note as string;
      }
      if ("cards" in p) {
        const slot = p.cards as { added: Record<string, unknown>[]; removed: Ref[]; changed: Record<string, unknown>[] };
        for (const added of slot.added) {
          const id = this.nextId++;
          this.cards.set(id, added.text as string);
          if (typeof added.chronicleId === "number") {
            this.byChronicleId.set(added.chronicleId, id);
            keys.push({ chronicleId: added.chronicleId, value: id });
          }
        }
        for (const ref of slot.removed) {
          const id = this.resolve(ref);
          if (id === undefined || !this.cards.has(id)) this.errors.push(`remove of unknown card ${JSON.stringify(ref)}`);
          else this.cards.delete(id);
        }
        for (const changed of slot.changed) {
          const id = this.resolve(changed);
          if (id === undefined || !this.cards.has(id)) this.errors.push(`change of unknown card ${JSON.stringify(changed)}`);
          else if ("text" in changed) this.cards.set(id, changed.text as string);
        }
      }
    }
    return keys;
  }

  view(): string {
    return JSON.stringify({ title: this.title, log: this.logValue, note: this.note, cards: [...this.cards].sort((x, y) => x[0] - y[0]) });
  }
}

function eventWorld() {
  const tracker = new EventLog();
  const board = tracker.construct(() => {
    const b = new EBoard(tracker);
    b.title = "t0";
    const x = new ECard(tracker, "x"); x.id = 10;
    const y = new ECard(tracker, "y"); y.id = 11;
    b.cards.push(x, y);
    return b;
  });
  const pool: ECard[] = [...board.cards.collection];
  const server = new EServer();
  const view = () => JSON.stringify({
    title: board.title, log: board.log, note: board.meta.note,
    cards: board.cards.collection.map((c) => [c.id, c.text]).sort((x, y) => (x[0] as number ?? -1) - (y[0] as number ?? -1)),
  });
  return { tracker, board, pool, server, view };
}
type EWorld = ReturnType<typeof eventWorld>;

const eventSteps: Record<string, (w: EWorld, r: Rng) => void> = {
  title: (w, r) => { w.board.title = r.pick(VALUES); },
  log: (w, r) => { w.board.log = r.pick(VALUES); },
  note: (w, r) => { w.board.meta.note = r.pick(VALUES); },
  add: (w, r) => { const c = w.tracker.new(() => new ECard(w.tracker, r.pick(VALUES))); w.pool.push(c); w.board.cards.push(c); },
  remove: (w, r) => { if (w.board.cards.length) w.board.cards.remove(r.pick(w.board.cards.collection)); },
  readd: (w, r) => { const out = w.pool.filter((c) => !w.board.cards.includes(c)); if (out.length) w.board.cards.push(r.pick(out)); },
  edit: (w, r) => { if (w.board.cards.length) r.pick(w.board.cards.collection).text = r.pick(VALUES); },
  editRemoved: (w, r) => { const out = w.pool.filter((c) => !w.board.cards.includes(c)); if (out.length) r.pick(out).text = r.pick(VALUES); },
  replace: (w, r) => { if (w.board.cards.length) w.board.cards[r.int(w.board.cards.length)] = w.tracker.new(() => new ECard(w.tracker, r.pick(VALUES))); },
  sort: (w) => { w.board.cards.sort((x, y) => x.text.localeCompare(y.text)); },
  reset: (w, r) => { w.board.cards.reset(shuffled(w.pool.filter(() => r.int(2) === 0), r)); },
  batch: (w, r) => { w.tracker.batch(() => { for (let i = 0; i < 2; i++) eventSteps[r.pick(BATCHED)](w, r); }); },
  batchFail: (w, r) => failingBatch(w, r, eventSteps),
  undo: (w) => { w.tracker.undo(); },
  redo: (w) => { w.tracker.redo(); },
  undoRedo: (w) => {
    if (!w.tracker.canUndo) return;
    const before = w.view();
    w.tracker.undo();
    w.tracker.redo();
    if (w.view() !== before) throw new Error(`undo+redo changed the state: ${before} → ${w.view()}`);
  },
  discard: (w) => { w.tracker.discardPendingChanges(); },
};

async function eventCommit(w: EWorld, r: Rng, log: string[]): Promise<void> {
  const mode: CommitMode = r.pick(["collapsed", "operations"] as const);
  const kind = r.int(4);
  if (kind === 0) {
    await w.tracker.commit(() => { throw new Error("offline"); }, { mode }).catch(() => undefined);
    log.push(`commit:fail ${mode}`);
    return;
  }
  if (kind === 1) {
    let release!: () => void;
    const running = w.tracker.commit((b) => { const keys = w.server.save(b); return new Promise<typeof keys>((res) => { release = () => res(keys); }); }, { mode });
    await Promise.resolve();
    const during = r.int(3);
    for (let i = 0; i < during; i++) {
      const name = r.pick(Object.keys(eventSteps).filter((s) => s !== "discard"));
      eventSteps[name](w, r);
      log.push(`  during:${name}`);
    }
    release?.();
    await running;
    log.push(`commit:async ${mode}`);
    return;
  }
  await w.tracker.commit((b) => w.server.save(b), { mode });
  log.push(`commit ${mode}`);
  expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "after a save");
}

async function runEvents(seed: number, length: number): Promise<void> {
  const r = prng(seed);
  const w = eventWorld();
  const log: string[] = [`seed ${seed}`];
  const names = [...Object.keys(eventSteps), "commit", "commit"];
  for (let step = 0; step < length; step++) {
    const name = r.pick(names);
    if (name === "commit") await eventCommit(w, r, log);
    else { eventSteps[name](w, r); log.push(name); }
    if (w.server.errors.length) throw new Error(`server rejected: ${w.server.errors.join(", ")}\n  steps:\n    ${log.join("\n    ")}`);
    if (!w.tracker.isDirty && !w.tracker.isSaving) expectSame(w.server.view(), w.view(), false, log, "not dirty");
    expectValidityCurrent(w.tracker, log);
  }
  await w.tracker.commit((b) => w.server.save(b));
  log.push("final commit");
  expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "at the end");
}

async function runEventSequence(names: string[], mode: CommitMode): Promise<void> {
  const r = prng(names.length);
  const w = eventWorld();
  const log: string[] = [...names, `(${mode})`];
  for (const name of names) {
    if (name === "commit") { await w.tracker.commit((b) => w.server.save(b), { mode }); expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "after a save"); }
    else eventSteps[name](w, r);
    if (w.server.errors.length) throw new Error(`server rejected: ${w.server.errors.join(", ")}\n  steps:\n    ${log.join("\n    ")}`);
    if (!w.tracker.isDirty) expectSame(w.server.view(), w.view(), false, log, "not dirty");
    expectValidityCurrent(w.tracker, log);
  }
  await w.tracker.commit((b) => w.server.save(b), { mode });
  expectSame(w.server.view(), w.view(), w.tracker.isDirty, log, "at the end");
}

// ============================================================================ the runs

/** Every sequence of `length` steps drawn from `alphabet`. */
function* sequences(alphabet: string[], length: number): Generator<string[]> {
  if (length === 0) { yield []; return; }
  for (const head of alphabet) for (const tail of sequences(alphabet, length - 1)) yield [head, ...tail];
}

// For a deeper run: CHRONICLE_SEEDS=20000 CHRONICLE_STEPS=100 npx vitest run test/ModelBased.test.ts
const SEEDS = Number(process.env.CHRONICLE_SEEDS ?? 2000);
const STEPS = Number(process.env.CHRONICLE_STEPS ?? 30);

const SHORT = ["title", "add", "remove", "readd", "edit", "undo", "redo", "commit"];
// Moving items in and out: edits while out, replacing, reordering, discarding.
// Batches (one of which throws) and resets.
const BATCHES = ["reset", "batch", "batchFail", "edit", "undo", "redo", "commit"];
const MOVES = ["remove", "readd", "editRemoved", "edit", "replace", "sort", "undo", "redo", "discard", "commit"];

describe("model-based: UnitOfWork", () => {
  it("every sequence of up to 5 steps (edit, add, remove, re-add, undo, redo, save)", async () => {
    for (let length = 1; length <= 5; length++) {
      for (const names of sequences(SHORT, length)) await runUowSequence(names);
    }
  }, 120_000);

  it("every sequence of up to 5 steps (remove, re-add, edit while removed, replace, sort, undo, redo, discard, save)", async () => {
    for (let length = 1; length <= 5; length++) {
      for (const names of sequences(MOVES, length)) await runUowSequence(names);
    }
  }, 240_000);

  it("every sequence of up to 5 steps (reset, batch, failing batch, edit, undo, redo, save)", async () => {
    for (let length = 1; length <= 5; length++) {
      for (const names of sequences(BATCHES, length)) await runUowSequence(names);
    }
  }, 240_000);

  it(`${SEEDS} random sequences of ${STEPS} steps, with failed saves, edits during a save, and discards`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) await runUow(seed, STEPS);
  }, 2 * STEPS * SEEDS);
});

describe("model-based: EventLog", () => {
  it("every sequence of up to 5 steps, in both commit modes", async () => {
    for (const mode of ["collapsed", "operations"] as const) {
      for (let length = 1; length <= 5; length++) {
        for (const names of sequences(SHORT, length)) await runEventSequence(names, mode);
      }
    }
  }, 240_000);

  it("every sequence of up to 5 steps (remove, re-add, edit while removed, replace, sort, undo, redo, discard, save), in both commit modes", async () => {
    for (const mode of ["collapsed", "operations"] as const) {
      for (let length = 1; length <= 5; length++) {
        for (const names of sequences(MOVES, length)) await runEventSequence(names, mode);
      }
    }
  }, 480_000);

  it("every sequence of up to 5 steps (reset, batch, failing batch, edit, undo, redo, save), in both commit modes", async () => {
    for (const mode of ["collapsed", "operations"] as const) {
      for (let length = 1; length <= 5; length++) {
        for (const names of sequences(BATCHES, length)) await runEventSequence(names, mode);
      }
    }
  }, 480_000);

  it(`${SEEDS} random sequences of ${STEPS} steps, with parts, history, failed saves, edits during a save, and discards`, async () => {
    for (let seed = 1; seed <= SEEDS; seed++) await runEvents(seed, STEPS);
  }, 2 * STEPS * SEEDS);
});

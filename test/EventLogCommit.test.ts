import { describe, it, expect, vi } from "vitest";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";
import { CommitBatch, EventState } from "../packages/event-log/src/GeneratedEvent";
import { events, pendingEvents } from "./eventHelpers";

class Check extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked() accessor done: boolean = false;
  constructor(t: EventLog, id: number | null = null) { super(t); this.id = id; }
}

class Sub extends TrackedContainer {
  @AutoId id: number | null = null;
  @EventTracked() accessor text: string = "";
  readonly checks: EventTrackedCollection<Check>;
  constructor(t: EventLog, id: number | null = null) {
    super(t);
    this.id = id;
    this.checks = new EventTrackedCollection<Check>(t, "checks");
    this.trackChild(this.checks);
  }
}

class Task extends TrackedContainer {
  @AutoId id: number | null = null;
  @EventTracked() accessor title: string = "";
  readonly subs: EventTrackedCollection<Sub>;
  constructor(t: EventLog, id: number | null = null) {
    super(t);
    this.id = id;
    this.subs = new EventTrackedCollection<Sub>(t, "subs");
    this.trackChild(this.subs);
  }
}

class Board extends TrackedContainer {
  @Id id: string = "b1";
  @EventTracked() accessor stage: string = "draft";
  @EventTracked(undefined, undefined, { history: true }) accessor log: string = "";
  readonly tasks: EventTrackedCollection<Task>;
  constructor(t: EventLog) {
    super(t);
    this.tasks = new EventTrackedCollection<Task>(t, "tasks");
    this.trackChild(this.tasks);
  }
}

class Note extends TrackedObject {
  @Id id: string = "n1";
  @EventTracked() accessor text: string = "";
  constructor(t: EventLog) { super(t); }
}

function loaded() {
  const tracker = new EventLog();
  const board = tracker.construct(() => new Board(tracker));
  const task = tracker.construct(() => new Task(tracker, 42));
  const sub = tracker.construct(() => new Sub(tracker, 7));
  const check = tracker.construct(() => new Check(tracker, 3));
  tracker.withTrackingSuppressed(() => {
    board.tasks.push(task);
    task.subs.push(sub);
    sub.checks.push(check);
  });
  return { tracker, board, task, sub, check };
}

const empty = { added: [], removed: [], changed: [] };

/** A save function that records the batches it receives and answers with fixed keys. */
function recorder(keys: (batch: CommitBatch) => Array<{ chronicleId: number; value: number }> = () => []) {
  const batches: CommitBatch[] = [];
  const save = vi.fn(async (batch: CommitBatch) => {
    batches.push(JSON.parse(JSON.stringify(batch)));
    return keys(batch);
  });
  return { save, batches };
}

describe("EventLog.commit(save) — one collapsed batch per save", () => {
  it("the Save-button case: many operations, one JSON, ids assigned, everything committed", async () => {
    const { tracker, board, check } = loaded();
    const x = tracker.new(() => new Task(tracker));
    board.tasks.push(x);                                   // #1 add X
    const y = tracker.new(() => new Sub(tracker));
    x.subs.push(y);                                        // #2 add Y to X
    x.title = "X renamed";                                 // #3
    const z = tracker.new(() => new Task(tracker));
    board.tasks.push(z);                                   // #4 add Z
    board.tasks.remove(z);                                 // #5 remove Z
    check.done = true;                                     // #6

    const { save, batches } = recorder(() => [{ chronicleId: x.chronicleId, value: 50 }, { chronicleId: y.chronicleId, value: 60 }]);
    expect(await tracker.commit(save)).toBe(true);

    expect(save).toHaveBeenCalledTimes(1);
    expect(batches).toEqual([{
      events: [{
        chronicleId: board.chronicleId, targetId: "b1",
        payload: { tasks: {
          added: [{ chronicleId: x.chronicleId, id: null, title: "X renamed", subs: [{ chronicleId: y.chronicleId, id: null, text: "", checks: [] }] }],
          removed: [],
          changed: [{ id: 42, subs: { ...empty, changed: [{ id: 7, checks: { ...empty, changed: [{ id: 3, done: true }] } }] } }],
        } },
      }],
    }]);
    expect([x.id, y.id]).toEqual([50, 60]);
    expect(pendingEvents(tracker)).toEqual([]);
    expect(events(tracker).every((e) => e.state === EventState.Committed)).toBe(true);
    expect(tracker.isDirty).toBe(false);
  });

  it("plain fields: the last value wins; history fields keep every entry, in order", async () => {
    const { tracker, board } = loaded();
    board.stage = "submitted";
    board.stage = "assessment";
    board.log = "first";
    board.log = "second";
    const { save, batches } = recorder();
    await tracker.commit(save);
    expect(batches[0].events.map((e) => e.payload)).toEqual([{
      stage: "assessment",
      log: [{ property: "log", value: "first" }, { property: "log", value: "second" }],
    }]);
  });

  it("several roots: one event per root, in one batch", async () => {
    const { tracker, board } = loaded();
    const note = tracker.construct(() => new Note(tracker));
    board.stage = "submitted";
    note.text = "hello";
    const { save, batches } = recorder();
    await tracker.commit(save);
    expect(batches[0].events.map((e) => [e.chronicleId, e.payload])).toEqual([
      [board.chronicleId, { stage: "submitted" }],
      [note.chronicleId, { text: "hello" }],
    ]);
  });

  it("changes that cancel out are committed without calling save", async () => {
    const { tracker, board } = loaded();
    const z = tracker.new(() => new Task(tracker));
    board.tasks.push(z);
    board.tasks.remove(z);
    const { save } = recorder();
    expect(await tracker.commit(save)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    expect(pendingEvents(tracker)).toEqual([]);
  });

  it("nothing pending: resolves to false without calling save", async () => {
    const { tracker } = loaded();
    const { save } = recorder();
    expect(await tracker.commit(save)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it("undone events are left out; a compensation is included", async () => {
    const { tracker, board } = loaded();
    board.stage = "a";
    board.stage = "b";
    tracker.undo();                          // "b" → Undone
    const first = recorder();
    await tracker.commit(first.save);
    expect(first.batches[0].events.map((e) => e.payload)).toEqual([{ stage: "a" }]);

    tracker.undo();                          // "a" was committed → compensation
    const second = recorder();
    await tracker.commit(second.save);
    expect(second.batches[0].events.map((e) => e.payload)).toEqual([{ stage: "draft" }]);
  });

  it("the event list is untouched: one event per operation, states updated", async () => {
    const { tracker, board } = loaded();
    board.stage = "a";
    board.stage = "b";
    await tracker.commit(recorder().save);
    expect(events(tracker).map((e) => [e.payload, e.state])).toEqual([
      [{ stage: "a" }, EventState.Committed],
      [{ stage: "b" }, EventState.Committed],
    ]);
    board.stage = "c";                       // later operations are recorded normally
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([{ stage: "c" }]);
  });

  it("a synchronous save function works too", async () => {
    const { tracker, board } = loaded();
    const x = tracker.new(() => new Task(tracker));
    board.tasks.push(x);
    await tracker.commit(() => [{ chronicleId: x.chronicleId, value: 9 }]);
    expect(x.id).toBe(9);
  });
});

describe("EventLog.commit — concurrency and failures", () => {
  it("changes made while save runs stay pending for the next commit", async () => {
    const { tracker, board } = loaded();
    board.stage = "a";
    let release!: () => void;
    const first = tracker.commit(() => new Promise<void>((resolve) => { release = resolve; }));
    await Promise.resolve();
    board.stage = "b";                       // during the save
    release();
    await first;
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([{ stage: "b" }]);
  });

  it("commits run one after another: the second batch already has the id the first one assigned", async () => {
    const { tracker, board } = loaded();
    const x = tracker.new(() => new Task(tracker));
    board.tasks.push(x);
    let release!: (keys: Array<{ chronicleId: number; value: number }>) => void;
    const first = tracker.commit(() => new Promise<Array<{ chronicleId: number; value: number }>>((resolve) => { release = resolve; }));
    await Promise.resolve();
    x.subs.push(tracker.new(() => new Sub(tracker)));   // Y into X, while X's save is in flight
    const second = recorder();
    const done = tracker.commit(second.save);           // called right away, runs after the first
    await Promise.resolve();
    expect(second.save).not.toHaveBeenCalled();
    release([{ chronicleId: x.chronicleId, value: 50 }]);
    await first;
    await done;
    const changed = (second.batches[0].events[0].payload as any).tasks.changed[0];
    expect(changed.id).toBe(50);                        // not a placeholder
    expect(changed.chronicleId).toBeUndefined();
  });

  it("if save throws, nothing is committed and the error propagates; the next commit still works", async () => {
    const { tracker, board } = loaded();
    board.stage = "a";
    await expect(tracker.commit(async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(pendingEvents(tracker)).toHaveLength(1);
    const { save, batches } = recorder();
    expect(await tracker.commit(save)).toBe(true);
    expect(batches[0].events.map((e) => e.payload)).toEqual([{ stage: "a" }]);
  });
});

describe("EventLog.commit — mode", () => {
  it('mode "operations": every pending event, one per operation, in order', async () => {
    const { tracker, board } = loaded();
    board.stage = "submitted";
    board.stage = "assessment";
    const x = tracker.new(() => new Task(tracker));
    board.tasks.push(x);
    x.title = "X renamed";
    const { save, batches } = recorder(() => [{ chronicleId: x.chronicleId, value: 50 }]);
    await tracker.commit(save, { mode: "operations" });
    expect(batches[0].events.map((e) => e.payload)).toEqual([
      { stage: "submitted" },
      { stage: "assessment" },
      { tasks: { ...empty, added: [{ chronicleId: x.chronicleId, id: null, title: "", subs: [] }] } },
      { tasks: { ...empty, changed: [{ chronicleId: x.chronicleId, title: "X renamed" }] } }, // refers to the item created just before
    ]);
    expect(batches[0].events.every((e) => e.chronicleId === board.chronicleId)).toBe(true);
    expect(x.id).toBe(50);
    expect(pendingEvents(tracker)).toEqual([]);
  });

  it('mode "operations": changes that cancel out are still sent, step by step; undone ones are not', async () => {
    const { tracker, board } = loaded();
    const z = tracker.new(() => new Task(tracker));
    board.tasks.push(z);
    board.tasks.remove(z);
    board.stage = "undone";
    tracker.undo();
    const { save, batches } = recorder();
    await tracker.commit(save, { mode: "operations" });
    expect(batches[0].events.map((e) => e.payload)).toEqual([
      { tasks: { ...empty, added: [{ chronicleId: z.chronicleId, id: null, title: "", subs: [] }] } },
      { tasks: { ...empty, removed: [{ chronicleId: z.chronicleId }] } },
    ]);
  });

  it('mode "collapsed" is the default, and can be given explicitly', async () => {
    const { tracker, board } = loaded();
    board.stage = "a";
    board.stage = "b";
    const { save, batches } = recorder();
    await tracker.commit(save, { mode: "collapsed" });
    expect(batches[0].events.map((e) => e.payload)).toEqual([{ stage: "b" }]);
  });
});

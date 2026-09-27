import { describe, it, expect } from "vitest";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";
import { EventState } from "../packages/event-log/src/GeneratedEvent";
import { events, pendingEvents } from "./eventHelpers";

const { NotCommitted, Committed, Undone } = EventState;

// ---------------------------------------------------------------------------- Models

class Task extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked() accessor title: string = "t";
  constructor(t: EventLog, title = "t") { super(t); this.title = title; }
}

class Tag extends TrackedObject {
  @Id code: string = "";
  @EventTracked() accessor label: string = "";
  constructor(t: EventLog, code = "x") { super(t); this.code = code; }
}

type Mode = "bucketed" | "history";

class Board extends TrackedContainer {
  @Id id: string = "b1";
  @EventTracked() accessor stage: "a" | "b" = "a";
  readonly tasks: EventTrackedCollection<Task>;
  constructor(t: EventLog, mode: Mode = "bucketed") {
    super(t);
    this.tasks = new EventTrackedCollection<Task>(t, "tasks", [], undefined, { history: mode === "history" });
    this.trackChild(this.tasks);
  }
}

function setup(mode: Mode = "bucketed") {
  const tracker = new EventLog();
  const board = tracker.construct(() => new Board(tracker, mode));
  return { tracker, board };
}

const ids = (tracker: EventLog) => pendingEvents(tracker).map((e) => e.eventId);
const payloads = (tracker: EventLog) => pendingEvents(tracker).map((e) => e.payload);

// ---------------------------------------------------------------------------- Q1

describe("hooks and events during undo/redo", () => {
  it("neither the decorator hooks nor the beforeChange/afterChange events run on undo or redo; changed does", () => {
    const hookCalls: string[] = [];
    const eventCalls: string[] = [];
    class M extends TrackedObject {
      @EventTracked(undefined, { beforeChange: (_s, v) => hookCalls.push(`before:${v}`), afterChange: (_s, v) => hookCalls.push(`after:${v}`) })
      accessor stage: string = "a";
      constructor(t: EventLog) {
        super(t);
        this.beforeChange.subscribe(({ newValue }) => eventCalls.push(`before:${newValue}`));
        this.afterChange.subscribe(({ newValue }) => eventCalls.push(`after:${newValue}`));
        this.changed.subscribe(({ newValue }) => eventCalls.push(`changed:${newValue}`));
      }
    }
    const tracker = new EventLog();
    const m = tracker.construct(() => new M(tracker));
    m.stage = "b";
    tracker.undo();
    tracker.redo();
    expect(hookCalls).toEqual(["before:b", "after:b"]);
    expect(eventCalls).toEqual(["before:b", "changed:b", "after:b", "changed:a", "changed:b"]);
  });

  it("undo and redo create no operations and no events of their own, even if a subscriber writes", () => {
    class M extends TrackedObject {
      @EventTracked() accessor stage: string = "a";
      @EventTracked() accessor note: string = "";
      readonly tasks: EventTrackedCollection<Task>;
      constructor(t: EventLog) {
        super(t);
        this.tasks = new EventTrackedCollection<Task>(t, "tasks");
        this.afterChange.subscribe(({ property, newValue }) => {
          if (property !== "stage") return;
          this.note = `stage ${newValue}`;
          [...this.tasks.collection].forEach((task) => this.tasks.remove(task));
        });
      }
    }
    const tracker = new EventLog();
    const m = tracker.construct(() => new M(tracker));
    m.stage = "b";                       // one operation (the subscriber's writes are composed into it)
    const steps = tracker.undoable.length;
    const count = events(tracker).length;
    tracker.undo();
    tracker.redo();
    expect(tracker.undoable).toHaveLength(steps);
    expect(events(tracker)).toHaveLength(count);
    expect(tracker.canUndo).toBe(true);
    tracker.undo();
    expect(tracker.canUndo).toBe(false); // still exactly one operation
  });

  it("reporter's scenario: undo of a backward-transition hook reverts the stage only", () => {
    class Guarded extends Board {
      @EventTracked(undefined, { beforeChange: (self: Guarded, v: string, prev: string) => self.react(v, prev) })
      override accessor stage: "a" | "b" = "a";
      react(v: string, prev: string) {
        if (v === "a" && prev === "b") [...this.tasks.collection].forEach((t) => this.tasks.remove(t));
      }
    }
    const tracker = new EventLog();
    const board = tracker.construct(() => new Guarded(tracker));
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    board.stage = "b";
    tracker._onCommit(ids(tracker), [{ chronicleId: task.chronicleId, value: 42 }]);
    tracker.undo();
    expect(board.tasks.collection).toEqual([task]);
    expect(payloads(tracker)).toEqual([{ stage: "a" }]);
  });
});

// ---------------------------------------------------------------------------- Q2: placeholders

describe("items whose @AutoId is not assigned yet are referenced by { chronicleId }", () => {
  it("added snapshots of @AutoId items carry chronicleId", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker, "write"));
    board.tasks.push(task);
    expect(payloads(tracker)).toEqual([
      { tasks: { added: [{ chronicleId: task.chronicleId, id: null, title: "write" }], removed: [], changed: [] } },
    ]);
  });

  it("items identified by @Id alone need no placeholder", () => {
    const tracker = new EventLog();
    const tags = tracker.construct(() => new EventTrackedCollection<Tag>(tracker, "tags"));
    const tag = tracker.construct(() => new Tag(tracker, "red"));
    tags.push(tag);
    tags.remove(tag);
    expect(payloads(tracker)).toEqual([
      { tags: { added: [{ code: "red", label: "" }], removed: [], changed: [] } },
      { tags: { added: [], removed: ["red"], changed: [] } },
    ]);
    tracker._onCommit(ids(tracker)); // no keys needed
    expect(pendingEvents(tracker)).toEqual([]);
  });

  it("unsent add, then remove: both are kept; the remove carries the placeholder", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    board.tasks.remove(task);
    expect(payloads(tracker)[1]).toEqual({ tasks: { added: [], removed: [{ chronicleId: task.chronicleId }], changed: [] } });
  });

  it("…undo/redo of the remove keep it resolvable; the key fills in the id", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    board.tasks.remove(task);
    tracker.undo();                                 // remove → Undone
    const [add, remove] = events(tracker);
    tracker._onCommit([add.eventId], [{ chronicleId: task.chronicleId, value: 42 }]);
    expect(remove.state).toBe(Undone);
    expect(remove.payload).toEqual({ tasks: { added: [], removed: [42], changed: [] } }); // patched while Undone
    tracker.redo();
    expect(remove.state).toBe(NotCommitted);
    expect(payloads(tracker)).toEqual([{ tasks: { added: [], removed: [42], changed: [] } }]);
  });

  it("the in-flight race: remove recorded before the ack, patched when the key arrives", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    const inFlight = ids(tracker);                  // add sent
    board.tasks.remove(task);                       // removed before the ack
    const early = JSON.parse(JSON.stringify(pendingEvents(tracker)[1].payload));
    expect(early).toEqual({ tasks: { added: [], removed: [{ chronicleId: task.chronicleId }], changed: [] } });

    tracker._onCommit(inFlight, [{ chronicleId: task.chronicleId, value: 42 }]);
    expect(payloads(tracker)).toEqual([{ tasks: { added: [], removed: [42], changed: [] } }]);
  });

  it("committed events are history: their placeholders are not rewritten", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    const addId = ids(tracker)[0];
    board.tasks.remove(task);
    tracker._onCommit(ids(tracker), [{ chronicleId: task.chronicleId, value: 42 }]); // add + remove sent together
    expect(events(tracker).map((e) => [e.payload, e.state])).toEqual([
      [{ tasks: { added: [{ chronicleId: task.chronicleId, id: null, title: "t" }], removed: [], changed: [] } }, Committed],
      [{ tasks: { added: [], removed: [{ chronicleId: task.chronicleId }], changed: [] } }, Committed],
    ]);
    expect(events(tracker)[0].eventId).toBe(addId);
  });

  it("changed entries of a provisional item use the placeholder too", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    const addIds = ids(tracker);
    task.title = "edited";
    expect(payloads(tracker)[1]).toEqual({ tasks: { added: [], removed: [], changed: [{ chronicleId: task.chronicleId, title: "edited" }] } });
    tracker._onCommit(addIds, [{ chronicleId: task.chronicleId, value: 7 }]);
    expect(payloads(tracker)).toEqual([{ tasks: { added: [], removed: [], changed: [{ id: 7, title: "edited" }] } }]);
  });

  it("history mode: remove and change ops use the placeholder, patched on ack", () => {
    const { tracker, board } = setup("history");
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    const addIds = ids(tracker);
    expect(payloads(tracker)[0]).toEqual({ tasks: { ops: [{ op: "add", item: { chronicleId: task.chronicleId, id: null, title: "t" } }] } });
    task.title = "edited";
    board.tasks.remove(task);
    expect(payloads(tracker).slice(1)).toEqual([
      { tasks: { ops: [{ op: "change", chronicleId: task.chronicleId, title: "edited" }] } },
      { tasks: { ops: [{ op: "remove", chronicleId: task.chronicleId }] } },
    ]);
    tracker._onCommit(addIds, [{ chronicleId: task.chronicleId, value: 9 }]);
    expect(payloads(tracker)).toEqual([
      { tasks: { ops: [{ op: "change", id: 9, title: "edited" }] } },
      { tasks: { ops: [{ op: "remove", id: 9 }] } },
    ]);
  });

  it("objects created with tracker.new(): later events get their targetId on ack", () => {
    class Doc extends TrackedObject {
      @AutoId id: number | null = null;
      @EventTracked() accessor title: string = "";
      constructor(t: EventLog) { super(t); this.title = "draft"; }
    }
    const tracker = new EventLog();
    const doc = tracker.new(() => new Doc(tracker));
    doc.title = "final";
    const creation = pendingEvents(tracker)[0];
    expect(creation).toMatchObject({ chronicleId: doc.chronicleId, payload: { chronicleId: doc.chronicleId, id: null, title: "final" } });
    expect(creation.targetId).toBeUndefined();
    doc.title = "later";
    const edit = pendingEvents(tracker)[1];
    expect(edit.payload).toEqual({ title: "later" });
    expect(edit.targetId).toBeUndefined();
    tracker._onCommit([creation.eventId], [{ chronicleId: doc.chronicleId, value: 100 }]);
    expect(creation.targetId).toBeUndefined(); // committed: left as sent
    expect(edit.targetId).toBe(100);
  });

  it("an item re-added after a committed removal is a new creation: its new key is assigned", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    tracker._onCommit(ids(tracker), [{ chronicleId: task.chronicleId, value: 42 }]);
    board.tasks.remove(task);
    expect(payloads(tracker)).toEqual([{ tasks: { added: [], removed: [42], changed: [] } }]);
    tracker._onCommit(ids(tracker));
    tracker.undo(); // compensation: add it back
    tracker._onCommit(ids(tracker), [{ chronicleId: task.chronicleId, value: 43 }]);
    expect(task.id).toBe(43);
  });
});

describe("onCommit without keys", () => {
  it("never throws: the item stays provisional and later references keep the placeholder", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    expect(() => tracker._onCommit(ids(tracker))).not.toThrow();
    expect(task.id).toBeNull();
    board.tasks.remove(task);
    expect(payloads(tracker)).toEqual([{ tasks: { added: [], removed: [{ chronicleId: task.chronicleId }], changed: [] } }]);
  });

  it("a key supplied by a later onCommit still resolves the placeholders", () => {
    const { tracker, board } = setup();
    const task = tracker.new(() => new Task(tracker));
    board.tasks.push(task);
    tracker._onCommit(ids(tracker));
    board.tasks.remove(task);
    tracker._onCommit([], [{ chronicleId: task.chronicleId, value: 8 }]);
    expect(payloads(tracker)).toEqual([{ tasks: { added: [], removed: [8], changed: [] } }]);
  });
});

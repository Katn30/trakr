import { describe, it, expect } from "vitest";
import {
  EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, Id, AutoId,
  type CommitBatch,
} from "@katn30/chronicle-event-log";
import { emitted, pendingIds } from "./eventHelpers";

/** A clock the tests control, so "when" is predictable. */
let now = 0;
const tick = () => ++now;

// ---------------------------------------------------------------------------- properties

class Issue extends TrackedObject {
  @Id id = "i1";
  @EventTracked(undefined, undefined, {
    toPayload: (self: Issue, newValue: string) => ({ state: newValue, by: self.user, at: tick() }),
  })
  accessor state: string = "draft";
  @EventTracked(undefined, undefined, {
    history: true,
    toPayload: (self: Issue, newValue: string, oldValue: string) => ({ from: oldValue, to: newValue, by: self.user }),
  })
  accessor stage: string = "a";
  @EventTracked() accessor title: string = "";
  user = "u1";
  constructor(t: EventLog) { super(t); }
}

describe("toPayload on a property", () => {
  it("a property never changed still goes through toPayload in a snapshot (the creation of a new object)", () => {
    now = 0;
    const tracker = new EventLog();
    const issue = tracker.new(() => new Issue(tracker));
    issue.title = "T";
    expect(emitted(tracker)[0].payload).toMatchObject({ state: { state: "draft", by: "u1", at: 1 }, title: "T" });
  });

  it("the event carries what toPayload built, not the raw value", () => {
    now = 0;
    const tracker = new EventLog();
    const issue = tracker.construct(() => new Issue(tracker));
    issue.state = "open";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ state: { state: "open", by: "u1", at: 1 } }]);
  });

  it("runs when the value changes: a collapsed commit sends the last write's result", async () => {
    now = 0;
    const tracker = new EventLog();
    const issue = tracker.construct(() => new Issue(tracker));
    issue.state = "open";                        // at 1
    issue.user = "u2";
    issue.state = "fixing";                      // at 2
    const batches: CommitBatch[] = [];
    await tracker.commit((b) => { batches.push(b); });
    expect(batches[0].events.map((e) => e.payload)).toEqual([{ state: { state: "fixing", by: "u2", at: 2 } }]);
  });

  it("with history, each entry is toPayload's result", () => {
    const tracker = new EventLog();
    const issue = tracker.construct(() => new Issue(tracker));
    tracker._startSession();
    issue.stage = "b";
    issue.stage = "c";
    tracker._startSession().end();
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { stage: [{ from: "a", to: "b", by: "u1" }, { from: "b", to: "c", by: "u1" }] },
    ]);
  });

  it("undo is a change too: the compensation carries toPayload for the restored value", () => {
    now = 0;
    const tracker = new EventLog();
    const issue = tracker.construct(() => new Issue(tracker));
    issue.state = "open";                        // at 1
    tracker._onCommit(pendingIds(tracker));
    issue.user = "u9";
    tracker.undo();                              // at 2, by u9
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ state: { state: "draft", by: "u9", at: 2 } }]);
  });

  it("a property with toPayload always goes through it, even after a silent write", () => {
    const tracker = new EventLog();
    const issue = tracker.construct(() => new Issue(tracker));
    issue.state = "open";
    tracker._onCommit(pendingIds(tracker));
    tracker.withTrackingSuppressed(() => { issue.state = "loaded"; });
    issue.title = "T";
    // The issue's snapshot (e.g. inside a collection or another object) builds it for the loaded value.
    const holder = tracker.construct(() => new Holder(tracker));
    holder.issue = issue;
    expect(emitted(tracker).at(-1)!.payload).toMatchObject({ issue: { state: { state: "loaded", by: "u1" }, title: "T" } });
  });

  it("snapshots of an object use its properties' toPayload", () => {
    now = 0;
    const tracker = new EventLog();
    const issue = tracker.construct(() => new Issue(tracker));
    issue.state = "open";                        // at 1
    tracker._onCommit(pendingIds(tracker));
    const holder = tracker.construct(() => new Holder(tracker));
    holder.issue = issue;
    expect(emitted(tracker)[0].payload).toEqual({
      // stage was never changed: its toPayload is built for its current value
      issue: { id: "i1", state: { state: "open", by: "u1", at: 1 }, stage: { from: "a", to: "a", by: "u1" }, title: "" },
    });
  });
});

class Holder extends TrackedObject {
  @Id id = "h1";
  @EventTracked() accessor issue: Issue | null = null;
  constructor(t: EventLog) { super(t); }
}

// ---------------------------------------------------------------------------- collections

class Task extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked() accessor title: string = "";
  constructor(t: EventLog, title = "", id: number | null = null) { super(t); this.title = title; this.id = id; }
}

let user = "u1";

class Board extends TrackedContainer {
  @Id id = "b1";
  readonly tasks = new EventTrackedCollection<Task>(this.tracker, "tasks", [], undefined, {
    toPayload: (_task, op) => ({ by: user, at: tick(), op }),
  });
  readonly labels = new EventTrackedCollection<string>(this.tracker, "labels", [], undefined, {
    toPayload: (_label, op) => ({ by: user, op }),
  });
  constructor(t: EventLog) {
    super(t);
    this.trackChild(this.tasks);
    this.trackChild(this.labels);
  }
}

function loadedBoard() {
  now = 0;
  user = "u1";
  const tracker = new EventLog();
  const board = tracker.construct(() => new Board(tracker));
  const existing = tracker.construct(() => new Task(tracker, "existing", 1));
  tracker.withTrackingSuppressed(() => { board.tasks.push(existing); board.labels.push("old"); });
  return { tracker, board, existing };
}

const slot = (tracker: EventLog) => (emitted(tracker).at(-1)!.payload as { tasks: unknown }).tasks;

describe("toPayload on a collection", () => {
  it("an added item: its snapshot plus the fields of its addition", () => {
    const { tracker, board } = loadedBoard();
    const task = tracker.new(() => new Task(tracker, "new"));
    board.tasks.push(task);
    expect(slot(tracker)).toEqual({
      added: [{ chronicleId: task.chronicleId, id: null, title: "new", by: "u1", at: 1, op: "add" }],
      removed: [],
      changed: [],
    });
  });

  it("an item added then edited before the save keeps the fields of its addition, with its latest snapshot", async () => {
    const { tracker, board } = loadedBoard();
    const task = tracker.new(() => new Task(tracker, "new"));
    board.tasks.push(task);                      // at 1, by u1
    user = "u2";
    task.title = "renamed";                      // a change: at 2, by u2
    const batches: CommitBatch[] = [];
    await tracker.commit((b) => { batches.push(b); return [{ chronicleId: task.chronicleId, value: 7 }]; });
    expect(batches[0].events.map((e) => e.payload)).toEqual([{
      tasks: {
        added: [{ chronicleId: task.chronicleId, id: null, title: "renamed", by: "u1", at: 1, op: "add" }],
        removed: [],
        changed: [],
      },
    }]);
  });

  it("an edited item: its changes plus the fields of its last change", () => {
    const { tracker, existing } = loadedBoard();
    existing.title = "edited";
    expect(slot(tracker)).toEqual({ added: [], removed: [], changed: [{ id: 1, title: "edited", by: "u1", at: 1, op: "change" }] });
  });

  it("a removed item: its identity as an object, plus the fields of its removal", () => {
    const { tracker, board, existing } = loadedBoard();
    board.tasks.remove(existing);
    expect(slot(tracker)).toEqual({ added: [], removed: [{ id: 1, by: "u1", at: 1, op: "remove" }], changed: [] });
  });

  it("primitive items become { value, ...fields }", () => {
    const { tracker, board } = loadedBoard();
    tracker._startSession();
    board.labels.push("new");
    board.labels.remove("old");
    tracker._startSession().end();
    expect((emitted(tracker)[0].payload as { labels: unknown }).labels).toEqual({
      added: [{ value: "new", by: "u1", op: "add" }],
      removed: [{ value: "old", by: "u1", op: "remove" }],
    });
  });

  it("items inside an added container carry the fields of their own addition", () => {
    class Column extends TrackedContainer {
      @AutoId id: number | null = null;
      readonly tasks = new EventTrackedCollection<Task>(this.tracker, "tasks", [], undefined, {
        toPayload: (_t, op) => ({ op, by: user }),
      });
      constructor(t: EventLog) { super(t); this.trackChild(this.tasks); }
    }
    class Kanban extends TrackedContainer {
      @Id id = "k1";
      readonly columns = new EventTrackedCollection<Column>(this.tracker, "columns");
      constructor(t: EventLog) { super(t); this.trackChild(this.columns); }
    }
    user = "u1";
    const tracker = new EventLog();
    const kanban = tracker.construct(() => new Kanban(tracker));
    const column = tracker.new(() => new Column(tracker));
    const task = tracker.new(() => new Task(tracker, "t"));
    tracker._startSession();
    column.tasks.push(task);
    kanban.columns.push(column);
    tracker._startSession().end();
    expect(emitted(tracker).at(-1)!.payload).toEqual({
      columns: {
        added: [{
          chronicleId: column.chronicleId, id: null,
          tasks: [{ chronicleId: task.chronicleId, id: null, title: "t", op: "add", by: "u1" }],
        }],
        removed: [],
        changed: [],
      },
    });
  });
});

import { describe, it, expect } from "vitest";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection, EventTrackedCollectionOptions } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";
import { EventState } from "../packages/event-log/src/GeneratedEvent";
import { events as allEvents, oneOperation, pendingEvents } from "./eventHelpers";

// Board "b1" → tasks → Task → subs → Sub → checks → Check

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
  readonly labels: EventTrackedCollection<string>;
  constructor(t: EventLog, id: number | null = null, subsOptions: Partial<EventTrackedCollectionOptions> = {}) {
    super(t);
    this.id = id;
    this.subs = new EventTrackedCollection<Sub>(t, "subs", [], undefined, { ...subsOptions });
    this.labels = new EventTrackedCollection<string>(t, "labels");
    this.trackChild(this.subs);
    this.trackChild(this.labels);
  }
}

class Board extends TrackedContainer {
  @Id id: string = "b1";
  readonly tasks: EventTrackedCollection<Task>;
  constructor(t: EventLog, tasksOptions: Partial<EventTrackedCollectionOptions> = {}) {
    super(t);
    this.tasks = new EventTrackedCollection<Task>(t, "tasks", [], undefined, { ...tasksOptions });
    this.trackChild(this.tasks);
  }
}

/** A loaded board: task 42 → sub 7 → check 3. */
function loaded(tasksOptions: Partial<EventTrackedCollectionOptions> = {}) {
  const tracker = new EventLog();
  const board = tracker.construct(() => new Board(tracker, tasksOptions));
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

const events = (tracker: EventLog) => pendingEvents(tracker).map((e) => ({ chronicleId: e.chronicleId, targetId: e.targetId, payload: e.payload }));
const empty = { added: [], removed: [], changed: [] };

describe("collections owned by an item nest into the item's entry (option B)", () => {
  it("adding a sub to task 42 → inside task 42's changed entry", () => {
    const { tracker, board, task } = loaded();
    task.subs.push(tracker.construct(() => new Sub(tracker, 8)));
    expect(events(tracker)).toEqual([{
      chronicleId: board.chronicleId, targetId: "b1",
      payload: { tasks: { ...empty, changed: [{ id: 42, subs: { ...empty, added: [{ chronicleId: expect.any(Number), id: null, text: "", checks: [] }] } }] } },
    }]);
  });

  it("ticking check 3 of sub 7 of task 42 → nested through the whole path", () => {
    const { tracker, check } = loaded();
    check.done = true;
    expect(events(tracker)[0].payload).toEqual({
      tasks: { ...empty, changed: [{ id: 42, subs: { ...empty, changed: [{ id: 7, checks: { ...empty, changed: [{ id: 3, done: true }] } }] } }] },
    });
  });

  it("renaming task 42 and ticking check 3 in one operation → one event", () => {
    const { tracker, task, check } = loaded();
    oneOperation(tracker, () => {
      task.title = "renamed";
      check.done = true;
    });
    expect(events(tracker).map((e) => e.payload)).toEqual([{
      tasks: { ...empty, changed: [{ id: 42, title: "renamed", subs: { ...empty, changed: [{ id: 7, checks: { ...empty, changed: [{ id: 3, done: true }] } }] } }] },
    }]);
  });

  it("a new task created with subs already inside → one nested snapshot", () => {
    const { tracker, board } = loaded();
    const x = tracker.construct(() => new Task(tracker));
    const y = tracker.construct(() => new Sub(tracker));
    tracker.withTrackingSuppressed(() => { x.title = "X"; x.subs.push(y); x.labels.push("urgent"); });
    board.tasks.push(x);
    expect(events(tracker).map((e) => e.payload)).toEqual([{
      tasks: { ...empty, added: [{ chronicleId: x.chronicleId, id: null, title: "X", subs: [{ chronicleId: y.chronicleId, id: null, text: "", checks: [] }], labels: ["urgent"] }] },
    }]);
    tracker._onCommit(pendingEvents(tracker).map((e) => e.eventId), [{ chronicleId: x.chronicleId, value: 50 }, { chronicleId: y.chronicleId, value: 60 }]);
    expect([x.id, y.id]).toEqual([50, 60]);
    expect(pendingEvents(tracker)).toEqual([]);
  });

  it("X added, then Y added to X before the ack: X is referenced by its placeholder, patched on ack", () => {
    const { tracker, board } = loaded();
    const x = tracker.new(() => new Task(tracker));
    board.tasks.push(x);
    const sent = pendingEvents(tracker).map((e) => e.eventId);
    const y = tracker.new(() => new Sub(tracker));
    x.subs.push(y);
    expect(events(tracker)[1].payload).toEqual({
      tasks: { ...empty, changed: [{ chronicleId: x.chronicleId, subs: { ...empty, added: [{ chronicleId: y.chronicleId, id: null, text: "", checks: [] }] } }] },
    });
    tracker._onCommit(sent, [{ chronicleId: x.chronicleId, value: 50 }]);
    expect(events(tracker)[0].payload).toEqual({
      tasks: { ...empty, changed: [{ id: 50, subs: { ...empty, added: [{ chronicleId: y.chronicleId, id: null, text: "", checks: [] }] } }] },
    });
  });

  it("undo of a committed nested change compensates inside the same path", () => {
    const { tracker, check } = loaded();
    check.done = true;
    tracker._onCommit(pendingEvents(tracker).map((e) => e.eventId));
    tracker.undo();
    const [compensation] = pendingEvents(tracker);
    expect(compensation.compensates).toBe(allEvents(tracker)[0].eventId);
    expect(compensation.payload).toEqual({
      tasks: { ...empty, changed: [{ id: 42, subs: { ...empty, changed: [{ id: 7, checks: { ...empty, changed: [{ id: 3, done: false }] } }] } }] },
    });
  });

  it("an unsent nested change undone becomes Undone, redone becomes pending again", () => {
    const { tracker, check } = loaded();
    check.done = true;
    tracker.undo();
    expect(allEvents(tracker).map((e) => e.state)).toEqual([EventState.Undone]);
    tracker.redo();
    expect(allEvents(tracker).map((e) => e.state)).toEqual([EventState.NotCommitted]);
  });

  it("removing a task in the same operation as a nested change reports only the removal", () => {
    const { tracker, board, task, check } = loaded();
    oneOperation(tracker, () => {
      check.done = true;
      board.tasks.remove(task);
    });
    expect(events(tracker).map((e) => e.payload)).toEqual([{ tasks: { ...empty, removed: [42] } }]);
  });

  it("history-mode parent: nested changes become a change op; add ops carry owned content", () => {
    const { tracker, board, check } = loaded({ history: true });
    check.done = true;
    expect(events(tracker)[0].payload).toEqual({
      tasks: { ops: [{ op: "change", id: 42, subs: { ...empty, changed: [{ id: 7, checks: { ...empty, changed: [{ id: 3, done: true }] } }] } }] },
    });
    tracker._onCommit(pendingEvents(tracker).map((e) => e.eventId));
    const x = tracker.construct(() => new Task(tracker));
    tracker.withTrackingSuppressed(() => x.labels.push("new"));
    board.tasks.push(x);
    expect(events(tracker)[0].payload).toEqual({
      tasks: { ops: [{ op: "add", item: { chronicleId: x.chronicleId, id: null, title: "", subs: [], labels: ["new"] } }] },
    });
  });

  it("an owned collection in history mode nests as { ops }", () => {
    const tracker = new EventLog();
    const board = tracker.construct(() => new Board(tracker));
    const task = tracker.construct(() => new Task(tracker, 42, { history: true }));
    tracker.withTrackingSuppressed(() => board.tasks.push(task));
    const sub = tracker.construct(() => new Sub(tracker, 8));
    task.subs.push(sub);
    expect(events(tracker)[0].payload).toEqual({
      tasks: { ...empty, changed: [{ id: 42, subs: { ops: [{ op: "add", item: { chronicleId: sub.chronicleId, id: null, text: "", checks: [] } }] } }] },
    });
  });
});

describe("a container outside any collection is a root: its own event", () => {
  it("a history parent with toPayload: a nested change is a change op, without the fields", () => {
    const { tracker, sub } = loaded({ history: true, toPayload: () => ({ by: "u1" }) });
    sub.text = "edited";
    expect(events(tracker)[0].payload).toEqual({
      tasks: { ops: [{ op: "change", id: 42, subs: { ...empty, changed: [{ id: 7, text: "edited" }] } }] },
    });
  });

  it("a new container with no parent: its first change sends its whole content; placeholder targetId while provisional", () => {
    const tracker = new EventLog();
    const task = tracker.new(() => new Task(tracker));
    task.labels.push("solo");
    const [event] = events(tracker);
    expect(event).toEqual({
      chronicleId: task.chronicleId, targetId: undefined,
      payload: { chronicleId: task.chronicleId, id: null, title: "", subs: [], labels: ["solo"] },
    });
  });
});

describe("an item held by two parents", () => {
  function twoBoards() {
    const tracker = new EventLog();
    const first = tracker.construct(() => new Board(tracker));
    const second = tracker.construct(() => new Board(tracker));
    const task = tracker.construct(() => new Task(tracker, 42));
    const sub = tracker.construct(() => new Sub(tracker, 7));
    tracker.withTrackingSuppressed(() => {
      first.tasks.push(task);
      second.tasks.push(task);
      task.subs.push(sub);
      task.labels.push("kept");
    });
    return { tracker, first, second, task, sub };
  }

  it("reports a nested change once, in the first parent", () => {
    const { tracker, first, sub } = twoBoards();
    sub.text = "edited";
    expect(events(tracker)).toEqual([{
      chronicleId: first.chronicleId, targetId: "b1",
      payload: { tasks: { ...empty, changed: [{ id: 42, subs: { ...empty, changed: [{ id: 7, text: "edited" }] } }] } },
    }]);
  });

  it("removed from both in one operation: each parent reports the removal, nothing nested leaks", () => {
    const { tracker, first, second, task, sub } = twoBoards();
    oneOperation(tracker, () => {
      sub.text = "edited";
      first.tasks.remove(task);
      second.tasks.remove(task);
    });
    expect(events(tracker).map((e) => e.payload)).toEqual([
      { tasks: { ...empty, removed: [42] } },
      { tasks: { ...empty, removed: [42] } },
    ]);
  });

  it("a new item added to both in one operation carries its full content in both snapshots", () => {
    const { tracker, first, second } = twoBoards();
    const x = tracker.construct(() => new Task(tracker));
    tracker.withTrackingSuppressed(() => x.labels.push("new"));
    oneOperation(tracker, () => {
      first.tasks.push(x);
      second.tasks.push(x);
    });
    const snapshot = { chronicleId: x.chronicleId, id: null, title: "", subs: [], labels: ["new"] };
    expect(events(tracker).map((e) => e.payload)).toEqual([
      { tasks: { ...empty, added: [snapshot] } },
      { tasks: { ...empty, added: [snapshot] } },
    ]);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { Tracker } from "../packages/core/src/Tracker";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";
import { State } from "../packages/unit-of-work/src/State";
import { EventState, TrackedEvent } from "../packages/event-log/src/GeneratedEvent";

import { events, pendingEvents, pendingIds } from "./eventHelpers";
// ---------------------------------------------------------------------------- Models

class Doc extends TrackedObject {
  @Id id: string = "d1";
  @EventTracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor title: string = "";
  @EventTracked() accessor tag: string = "";
  @EventTracked(undefined, undefined, { history: true }) accessor note: string = "";
  constructor(t: EventLog) { super(t); }
}

class Line extends TrackedObject {
  @AutoId id: number = 0;
  @EventTracked((_self, v: string) => (v === "" ? "required" : undefined)) accessor text: string = "x";
  constructor(t: EventLog, text = "x") {
    super(t);
    this.text = text;
  }
}

class Order extends TrackedContainer {
  @Id id: string = "o1";
  readonly lines: EventTrackedCollection<Line>;
  constructor(t: EventLog, initial: Line[] = [], history = false) {
    super(t);
    this.lines = new EventTrackedCollection<Line>(t, "lines", initial, undefined, { history });
    this.trackChild(this.lines);
  }
}

class Board extends TrackedContainer {
  readonly cards: EventTrackedCollection<Line>;
  constructor(t: EventLog) {
    super(t);
    this.cards = new EventTrackedCollection<Line>(t, "cards");
    this.trackChild(this.cards);
  }
}

function setupDoc() {
  const tracker = new EventLog();
  const doc = tracker.construct(() => new Doc(tracker));
  return { tracker, doc };
}

function setupOrder(history = false) {
  const tracker = new EventLog();
  const existing = tracker.construct(() => new Line(tracker, "existing"));
  tracker.withTrackingSuppressed(() => { existing.id = 1; });
  const order = tracker.construct(() => new Order(tracker, [existing], history));
  return { tracker, order, existing };
}

/** Compact view of the log: [payload, state, compensates?]. */
function log(tracker: EventLog) {
  return events(tracker).map((e) => {
    const row: unknown[] = [e.payload, e.state];
    if (e.compensates !== undefined) row.push(e.compensates);
    return row;
  });
}

const { NotCommitted, Committed, Undone } = EventState;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------- Basics

describe("EventLog.events — one entry per operation", () => {
  it("each operation records its own event; writes are not collapsed", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "a";
    doc.tag = "b";
    expect(log(tracker)).toEqual([
      [{ tag: "a" }, NotCommitted],
      [{ tag: "b" }, NotCommitted],
    ]);
    const [first, second] = events(tracker);
    expect(first.eventId).not.toBe(second.eventId);
    expect(first).toMatchObject({ chronicleId: doc.chronicleId, targetId: "d1" });
  });

  it("an operation touching several fields of one object records one event", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.title = "T";
    doc.tag = "x";
    session.end();
    expect(log(tracker)).toEqual([[{ title: "T", tag: "x" }, NotCommitted]]);
  });

  it("coalesced writes update the still-pending event in place", () => {
    const { tracker, doc } = setupDoc();
    doc.title = "a";
    const id = events(tracker)[0].eventId;
    doc.title = "ab";
    expect(log(tracker)).toEqual([[{ title: "ab" }, NotCommitted]]);
    expect(events(tracker)[0].eventId).toBe(id);
  });

  it("a coalesced write that cancels the pending event out removes it", () => {
    const { tracker, doc } = setupDoc();
    doc.title = "a";
    doc.title = "";
    expect(events(tracker)).toEqual([]);
  });

  it("a coalesced write after the event was committed records a new event", () => {
    const { tracker, doc } = setupDoc();
    doc.title = "a";
    tracker._onCommit(pendingIds(tracker));
    doc.title = "ab";
    expect(log(tracker)).toEqual([
      [{ title: "a" }, Committed],
      [{ title: "ab" }, NotCommitted],
    ]);
  });

  it("pendingEvents lists only NotCommitted events; isDirty follows it", () => {
    const { tracker, doc } = setupDoc();
    expect(tracker.isDirty).toBe(false);
    doc.tag = "a";
    doc.tag = "b";
    tracker.undo();
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([{ tag: "a" }]);
    expect(tracker.isDirty).toBe(true);
    tracker._onCommit(pendingIds(tracker));
    expect(tracker.isDirty).toBe(false);
  });

  it("tracker.new() records nothing and adds no undo step", () => {
    class Issue extends TrackedObject {
      @Id id: string = "i1";
      @EventTracked() accessor status: string = "";
      constructor(t: EventLog) { super(t); this.status = "open"; }
    }
    const tracker = new EventLog();
    tracker.new(() => new Issue(tracker));
    expect(log(tracker)).toEqual([]);
    expect(tracker.canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------- onCommit

describe("EventLog.onCommit — marks exactly the persisted events Committed", () => {
  it("events recorded while a save is in flight stay NotCommitted", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "v1";
    const inFlight = pendingIds(tracker);
    doc.tag = "v2";
    tracker._onCommit(inFlight);
    expect(log(tracker)).toEqual([
      [{ tag: "v1" }, Committed],
      [{ tag: "v2" }, NotCommitted],
    ]);
  });

  it("client workflow: fetch pending events, send them, commit their eventIds", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "a";
    doc.tag = "b";
    const sent = JSON.parse(JSON.stringify(pendingEvents(tracker))) as TrackedEvent[]; // e.g. over the wire
    tracker._onCommit(sent.map((e) => e.eventId));
    expect(events(tracker).map((e) => e.state)).toEqual([Committed, Committed]);
    expect(pendingEvents(tracker)).toEqual([]);
  });

  it("a subset can be committed; committing twice or committing an Undone event is a no-op", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "a";
    doc.tag = "b";
    tracker.undo();
    const [a, b] = events(tracker);
    tracker._onCommit([a.eventId, a.eventId, b.eventId]);
    expect(events(tracker).map((e) => e.state)).toEqual([Committed, Undone]);
  });

  it("assigns @AutoId values from keys; later events carry the real id", () => {
    const { tracker, order } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    tracker._onCommit(pendingIds(tracker), [
      { chronicleId: a.chronicleId, value: 42 },
      { chronicleId: 9999, value: 1 },
      { chronicleId: order.chronicleId, value: 7 }, // no @AutoId: ignored
    ]);
    expect(a.id).toBe(42);
    order.lines.remove(a);
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([
      { lines: { added: [], removed: [42], changed: [] } },
    ]);
  });
});

// ---------------------------------------------------------------------------- Undo / redo

describe("EventLog undo/redo — Undone if unsent, compensated if committed", () => {
  it("A → B → undo: B becomes Undone; redo makes the same event pending again", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    doc.tag = "B";
    const b = events(tracker)[1];
    tracker.undo();
    expect(log(tracker)).toEqual([
      [{ tag: "A" }, NotCommitted],
      [{ tag: "B" }, Undone],
    ]);
    tracker.redo();
    expect(events(tracker)[1]).toBe(b);
    expect(b.state).toBe(NotCommitted);
  });

  it("A → save → undo: A stays Committed and a compensating event is added", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    tracker._onCommit(pendingIds(tracker));
    const a = events(tracker)[0];
    tracker.undo();
    expect(log(tracker)).toEqual([
      [{ tag: "A" }, Committed],
      [{ tag: "" }, NotCommitted, a.eventId],
    ]);
  });

  it("… → redo before sending the compensation: the compensation becomes Undone", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    tracker._onCommit(pendingIds(tracker));
    tracker.undo();
    tracker.redo();
    expect(log(tracker).map((row) => row[1])).toEqual([Committed, Undone]);
    expect(tracker.isDirty).toBe(false);
    tracker.undo(); // and back again
    expect(log(tracker).map((row) => row[1])).toEqual([Committed, NotCommitted]);
  });

  it("… → save → redo: a new event re-applies the change, compensating the compensation", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    tracker._onCommit(pendingIds(tracker));
    tracker.undo();
    const compensation = events(tracker)[1];
    tracker._onCommit(pendingIds(tracker));
    tracker.redo();
    expect(log(tracker)).toEqual([
      [{ tag: "A" }, Committed],
      [{ tag: "" }, Committed, events(tracker)[0].eventId],
      [{ tag: "A" }, NotCommitted, compensation.eventId],
    ]);
  });

  it("a new operation drops Undone events along with the redo stack", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    doc.tag = "B";
    tracker.undo();
    doc.tag = "C";
    expect(log(tracker)).toEqual([
      [{ tag: "A" }, NotCommitted],
      [{ tag: "C" }, NotCommitted],
    ]);
  });

  it("history properties: one entry per operation, compensated with a reversal entry", () => {
    const { tracker, doc } = setupDoc();
    doc.note = "A";
    tracker._onCommit(pendingIds(tracker));
    doc.note = "B";
    tracker.undo();
    tracker.undo();
    expect(log(tracker)).toEqual([
      [{ note: [{ property: "note", value: "A" }] }, Committed],
      [{ note: [{ property: "note", value: "B" }] }, Undone],
      [{ note: [{ property: "note", value: "" }] }, NotCommitted, events(tracker)[0].eventId],
    ]);
  });

  it("bucketed collection: committed add → undo compensates with a removal", () => {
    const { tracker, order } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: a.chronicleId, value: 9 }]);
    tracker.undo();
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([
      { lines: { added: [], removed: [9], changed: [] } },
    ]);
  });

  it("history-mode collection: committed add → undo compensates with a remove op", () => {
    const { tracker, order } = setupOrder(true);
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: a.chronicleId, value: 9 }]);
    tracker.undo();
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([{ lines: { ops: [{ op: "remove", id: 9 }] } }]);
  });

  it("a container's collection: unsent add → undo marks it Undone; committed add → undo compensates", () => {
    const tracker = new EventLog();
    const board = tracker.construct(() => new Board(tracker));
    const card = tracker.construct(() => new Line(tracker, "c"));
    board.cards.push(card);
    tracker.undo();
    expect(log(tracker).map((r) => r[1])).toEqual([Undone]);
    tracker.redo();
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: card.chronicleId, value: 5 }]);
    tracker.undo();
    expect(log(tracker).map((r) => r[1])).toEqual([Committed, NotCommitted]);
    expect(pendingEvents(tracker)[0].payload).toEqual({ cards: { added: [], removed: [5], changed: [] } });
  });

  it("undo of an unrelated operation after a save leaves committed items alone (no phantom removal)", () => {
    const { tracker, order, existing } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    existing.text = "edited";
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: a.chronicleId, value: 9 }]);
    tracker.undo();
    expect(order.lines.collection).toContain(a);
    expect("chronicleState" in a).toBe(false);
    expect(pendingEvents(tracker).map((e) => e.payload)).toEqual([
      { lines: { added: [], removed: [], changed: [{ id: 1, text: "existing" }] } },
    ]);
  });
});

// ---------------------------------------------------------------------------- Sessions

describe("EventLog sessions", () => {
  it("ending a session merges its unsent events like its single undo step", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.tag = "a";
    doc.tag = "b";
    session.end();
    expect(log(tracker)).toEqual([[{ tag: "b" }, NotCommitted]]);
    tracker.undo();
    expect(log(tracker)).toEqual([[{ tag: "b" }, Undone]]);
  });

  it("events committed during the session are kept as recorded", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.tag = "a";
    tracker._onCommit(pendingIds(tracker));
    doc.tag = "b";
    session.end();
    expect(log(tracker).map((r) => r[1])).toEqual([Committed, NotCommitted]);
    tracker.undo();
    expect(log(tracker).map((r) => [r[0], r[1]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "b" }, Undone],
      [{ tag: "" }, NotCommitted],
    ]);
  });

  it("undoing inside a session drops the undone events when the session ends", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.tag = "a";
    doc.tag = "b";
    tracker.undo();
    session.end();
    expect(log(tracker)).toEqual([[{ tag: "a" }, NotCommitted]]);
  });

  it("rollback removes unsent events and compensates committed ones", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.tag = "a";
    tracker._onCommit(pendingIds(tracker));
    doc.title = "T";
    session.rollback();
    expect(log(tracker)).toEqual([
      [{ tag: "a" }, Committed],
      // One event per object: the compensation also resets title, which the server never had.
      [{ tag: "", title: "" }, NotCommitted, events(tracker)[0].eventId],
    ]);
    expect(doc.title).toBe("");
  });
});

// ---------------------------------------------------------------------------- discardPendingChanges

describe("EventLog.discardPendingChanges", () => {
  it("undoes unsent operations and forgets their events", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "saved";
    tracker._onCommit(pendingIds(tracker));
    doc.tag = "draft1";
    doc.tag = "draft2";
    tracker.discardPendingChanges();
    expect(doc.tag).toBe("saved");
    expect(log(tracker)).toEqual([[{ tag: "saved" }, Committed]]);
    expect(tracker.canRedo).toBe(false);
  });

  it("withdraws a pending compensation by redoing the committed operation", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "saved";
    tracker._onCommit(pendingIds(tracker));
    tracker.undo();
    tracker.discardPendingChanges();
    expect(doc.tag).toBe("saved");
    expect(log(tracker)).toEqual([
      [{ tag: "saved" }, Committed],
      [{ tag: "" }, Undone, events(tracker)[0].eventId],
    ]);
    expect(tracker.isDirty).toBe(false);
  });

  it("withdraws the creation of a new object with the change that carried it", () => {
    const tracker = new EventLog();
    class Issue extends TrackedObject {
      @Id id: string = "i1";
      @EventTracked() accessor status: string = "";
      constructor(t: EventLog) { super(t); this.status = "open"; }
    }
    const issue = tracker.new(() => new Issue(tracker));
    issue.status = "fixing";
    tracker.discardPendingChanges();
    expect(issue.status).toBe("open");
    expect(tracker.isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------- Remaining rules

describe("EventLog — remaining rules", () => {
  it("a partly committed session: undo, then a new write drops the undone event but keeps the rest", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.tag = "a";
    tracker._onCommit(pendingIds(tracker));
    doc.tag = "b";
    session.end();
    tracker.undo();
    doc.title = "T";
    expect(log(tracker).map((r) => [r[0], r[1]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "" }, NotCommitted],
      [{ title: "T" }, NotCommitted],
    ]);
  });

  it("undoing a partly committed session withdraws the unsent event and compensates the object", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.tag = "a";
    tracker._onCommit(pendingIds(tracker));
    doc.title = "T";
    session.end();
    tracker.undo();
    expect(log(tracker).map((r) => [r[0], r[1]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ title: "T" }, Undone],
      [{ tag: "", title: "" }, NotCommitted],
    ]);
  });

  it("a step spanning two objects, one sent: undo compensates the sent one, withdraws the other", () => {
    const { tracker, doc } = setupDoc();
    const other = tracker.construct(() => new Doc(tracker));
    const session = tracker._startSession();
    doc.tag = "a";
    tracker._onCommit(pendingIds(tracker));
    other.tag = "b";
    session.end();
    tracker.undo();
    expect(log(tracker).map((r) => [r[0], r[1]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "b" }, Undone],
      [{ tag: "" }, NotCommitted],
    ]);
  });

  it("rolling back a session spanning two objects compensates only the one that was sent", () => {
    const { tracker, doc } = setupDoc();
    const other = tracker.construct(() => new Doc(tracker));
    const session = tracker._startSession();
    doc.tag = "a";
    tracker._onCommit(pendingIds(tracker));
    other.tag = "b";
    session.rollback();
    expect(log(tracker)).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "" }, NotCommitted, events(tracker)[0].eventId],
    ]);
  });

  it("discard cannot split a partly committed step: its unsent part stays pending", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker._startSession();
    doc.tag = "a";
    tracker._onCommit(pendingIds(tracker));
    doc.tag = "b";
    session.end();
    tracker.undo();
    tracker.discardPendingChanges();
    // The pending compensation is withdrawn by redoing the step; "b" is still in the object, so it stays
    // pending: back in the log after everything recorded meanwhile.
    expect(log(tracker).map((r) => [r[0], r[1]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "" }, Undone],
      [{ tag: "b" }, NotCommitted],
    ]);
    expect(doc.tag).toBe("b");
    expect(tracker.canRedo).toBe(false);
  });

  it("what a constructor run by tracker.new() does to a collection is its starting content", () => {
    const tracker = new EventLog();
    const tags = tracker.new(() => {
      const t = new EventTrackedCollection<string>(tracker, "tags");
      t.push("x");
      return t;
    });
    expect(log(tracker)).toEqual([]);
    tags.push("y");
    expect(log(tracker)).toEqual([[{ tags: { added: ["y"], removed: [] } }, NotCommitted]]);
  });

  it("a new object created on its own, then added to a collection: the addition carries its snapshot", () => {
    const tracker = new EventLog();
    const board = tracker.construct(() => new Board(tracker));
    const card = tracker.new(() => new Line(tracker, "c"));
    card.text = "edited";                       // its creation, as a root
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: card.chronicleId, value: 3 }]);
    board.cards.push(card);
    expect(log(tracker).map((r) => r[1])).toEqual([Committed, NotCommitted]);
    expect(pendingEvents(tracker)[0].payload).toMatchObject({ cards: { added: [{ text: "edited" }] } });
  });

  it("a new object added to a collection is reported by the addition only", () => {
    const tracker = new EventLog();
    const board = tracker.construct(() => new Board(tracker));
    const card = tracker.new(() => new Line(tracker, "c"));
    board.cards.push(card);
    expect(log(tracker).map((r) => Object.keys(r[0] as object))).toEqual([["cards"]]);
  });
});

// ---------------------------------------------------------------------------- Validity

describe("EventLog — removed items do not count towards validity", () => {
  it("removing an invalid item makes the tracker valid; undo restores invalidity", () => {
    const { tracker, order } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    a.text = "";
    expect(tracker.isValid).toBe(false);
    order.lines.remove(a);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    expect(tracker.isValid).toBe(false);
  });

  it("re-adding a removed invalid item counts it again", () => {
    const { tracker, order } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    a.text = "";
    order.lines.remove(a);
    order.lines.push(a);
    expect(tracker.isValid).toBe(false);
  });

  it("canCommit = isDirty && isValid", () => {
    const { tracker, order } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    expect(tracker.canCommit).toBe(true);
    a.text = "";
    expect(tracker.canCommit).toBe(false);
  });
});

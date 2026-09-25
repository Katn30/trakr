import { describe, it, expect, vi, afterEach } from "vitest";
import { EventTracker } from "../src/EventTracker";
import { EventTracked } from "../src/EventTracked";
import { EventTrackedCollection } from "../src/EventTrackedCollection";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedContainer } from "../src/TrackedContainer";
import { Tracker } from "../src/Tracker";
import { AutoId, Id } from "../src/ExternallyAssigned";
import { State } from "../src/State";
import { EventState, TrackedEvent } from "../src/GeneratedEvent";

import { pendingIds } from "./eventHelpers";
// ---------------------------------------------------------------------------- Models

class Doc extends TrackedObject {
  @Id id: string = "d1";
  @EventTracked(undefined, undefined, { eventType: "Renamed", coalesceWithin: 60_000 }) accessor title: string = "";
  @EventTracked(undefined, undefined, { eventType: "Retagged" }) accessor tag: string = "";
  @EventTracked(undefined, undefined, { eventType: "Noted", history: true }) accessor note: string = "";
  constructor(t: Tracker) { super(t); }
}

class Line extends TrackedObject {
  @AutoId id: number = 0;
  @EventTracked((_self, v: string) => (v === "" ? "required" : undefined)) accessor text: string = "x";
  constructor(t: Tracker, text = "x") {
    super(t);
    this.text = text;
  }
}

class Order extends TrackedContainer {
  @Id id: string = "o1";
  readonly lines: EventTrackedCollection<Line>;
  constructor(t: EventTracker, initial: Line[] = [], history = false) {
    super(t);
    this.lines = new EventTrackedCollection<Line>(t, initial, undefined, {
      owner: { object: this, property: "lines" },
      eventType: "LinesChanged",
      ...(history ? { history: true } : {}),
    });
    this.trackChild(this.lines);
  }
}

class Board extends TrackedContainer {
  readonly cards: EventTrackedCollection<Line>;
  constructor(t: EventTracker) {
    super(t);
    this.cards = new EventTrackedCollection<Line>(t, [], undefined, { itemAdded: "CardAdded", itemRemoved: "CardRemoved" });
    this.trackChild(this.cards);
  }
}

function setupDoc() {
  const tracker = new EventTracker();
  const doc = tracker.construct(() => new Doc(tracker));
  return { tracker, doc };
}

function setupOrder(history = false) {
  const tracker = new EventTracker();
  const existing = tracker.construct(() => new Line(tracker, "existing"));
  tracker.withTrackingSuppressed(() => { existing.id = 1; });
  const order = tracker.construct(() => new Order(tracker, [existing], history));
  return { tracker, order, existing };
}

/** Compact view of the log: [eventType, payload, state, compensates?]. */
function log(tracker: EventTracker) {
  return tracker.events.map((e) => {
    const row: unknown[] = [e.eventType, e.payload, e.state];
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

describe("Tracker is abstract", () => {
  it("cannot be instantiated directly", () => {
    expect(() => new (Tracker as any)()).toThrow(/abstract/);
  });
});

describe("EventTracker.events — one entry per operation", () => {
  it("each operation records its own event; writes are not collapsed", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "a";
    doc.tag = "b";
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "a" }, NotCommitted],
      ["Retagged", { tag: "b" }, NotCommitted],
    ]);
    const [first, second] = tracker.events;
    expect(first.eventId).not.toBe(second.eventId);
    expect(first).toMatchObject({ trackingId: doc.trakrId, targetId: "d1" });
  });

  it("an operation touching several event types records one event per type", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.title = "T";
    doc.tag = "x";
    session.end();
    expect(log(tracker)).toEqual([
      ["Renamed", { title: "T" }, NotCommitted],
      ["Retagged", { tag: "x" }, NotCommitted],
    ]);
  });

  it("coalesced writes update the still-pending event in place", () => {
    const { tracker, doc } = setupDoc();
    doc.title = "a";
    const id = tracker.events[0].eventId;
    doc.title = "ab";
    expect(log(tracker)).toEqual([["Renamed", { title: "ab" }, NotCommitted]]);
    expect(tracker.events[0].eventId).toBe(id);
  });

  it("a coalesced write that cancels the pending event out removes it", () => {
    const { tracker, doc } = setupDoc();
    doc.title = "a";
    doc.title = "";
    expect(tracker.events).toEqual([]);
  });

  it("a coalesced write after the event was committed records a new event", () => {
    const { tracker, doc } = setupDoc();
    doc.title = "a";
    tracker.onCommit(pendingIds(tracker));
    doc.title = "ab";
    expect(log(tracker)).toEqual([
      ["Renamed", { title: "a" }, Committed],
      ["Renamed", { title: "ab" }, NotCommitted],
    ]);
  });

  it("pendingEvents lists only NotCommitted events; isDirty follows it", () => {
    const { tracker, doc } = setupDoc();
    expect(tracker.isDirty).toBe(false);
    doc.tag = "a";
    doc.tag = "b";
    tracker.undo();
    expect(tracker.pendingEvents.map((e) => e.payload)).toEqual([{ tag: "a" }]);
    expect(tracker.isDirty).toBe(true);
    tracker.onCommit(pendingIds(tracker));
    expect(tracker.isDirty).toBe(false);
  });

  it("eventsChanged fires once per operation with the full log", () => {
    const { tracker, doc } = setupDoc();
    const seen: number[] = [];
    tracker.eventsChanged.subscribe((events) => seen.push(events.length));
    doc.tag = "a";
    doc.tag = "b";
    tracker.onCommit(pendingIds(tracker));
    tracker.onCommit([]);   // nothing changed: no notification
    expect(seen).toEqual([1, 2, 2]);
  });

  it("tracker.new() records the constructor defaults as one event, outside the undo stack", () => {
    class Issue extends TrackedObject {
      @Id id: string = "i1";
      @EventTracked(undefined, undefined, { eventType: "Opened" }) accessor status: string = "";
      constructor(t: Tracker) { super(t); this.status = "open"; }
    }
    const tracker = new EventTracker();
    tracker.new(() => new Issue(tracker));
    expect(log(tracker)).toEqual([["Opened", { status: "open" }, NotCommitted]]);
    expect(tracker.canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------- onCommit

describe("EventTracker.onCommit — marks exactly the persisted events Committed", () => {
  it("events recorded while a save is in flight stay NotCommitted", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "v1";
    const inFlight = pendingIds(tracker);
    doc.tag = "v2";
    tracker.onCommit(inFlight);
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "v1" }, Committed],
      ["Retagged", { tag: "v2" }, NotCommitted],
    ]);
  });

  it("client workflow: fetch pending events, send them, commit their eventIds", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "a";
    doc.tag = "b";
    const sent = JSON.parse(JSON.stringify(tracker.pendingEvents)) as TrackedEvent[]; // e.g. over the wire
    tracker.onCommit(sent.map((e) => e.eventId));
    expect(tracker.events.map((e) => e.state)).toEqual([Committed, Committed]);
    expect(tracker.pendingEvents).toEqual([]);
  });

  it("a subset can be committed; committing twice or committing an Undone event is a no-op", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "a";
    doc.tag = "b";
    tracker.undo();
    const [a, b] = tracker.events;
    tracker.onCommit([a.eventId, a.eventId, b.eventId]);
    expect(tracker.events.map((e) => e.state)).toEqual([Committed, Undone]);
  });

  it("warns about unknown eventIds in development, silently ignores them in production", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { tracker } = setupDoc();
    tracker.onCommit([999]);
    expect(warn).toHaveBeenCalledTimes(1);
    vi.stubEnv("NODE_ENV", "production");
    tracker.onCommit([999]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("accepts eventIds only", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "a";
    expect(() => (tracker as any).onCommit()).toThrow(TypeError);
    expect(() => (tracker as any).onCommit([{ trackingId: doc.trakrId, value: 1 }])).toThrow(/eventIds/);
    expect(() => (tracker as any).onCommit(tracker.pendingEvents)).toThrow(/eventIds/);
    expect(tracker.pendingEvents).toHaveLength(1);
  });

  it("assigns @AutoId values from keys; later events carry the real id", () => {
    const { tracker, order } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    tracker.onCommit(pendingIds(tracker), [
      { trackingId: a.trakrId, value: 42 },
      { trackingId: 9999, value: 1 },
      { trackingId: order.trakrId, value: 7 }, // no @AutoId: ignored
    ]);
    expect(a.id).toBe(42);
    order.lines.remove(a);
    expect(tracker.pendingEvents.map((e) => e.payload)).toEqual([
      { lines: { added: [], removed: [42], changed: [] } },
    ]);
  });
});

// ---------------------------------------------------------------------------- Undo / redo

describe("EventTracker undo/redo — Undone if unsent, compensated if committed", () => {
  it("A → B → undo: B becomes Undone; redo makes the same event pending again", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    doc.tag = "B";
    const b = tracker.events[1];
    tracker.undo();
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "A" }, NotCommitted],
      ["Retagged", { tag: "B" }, Undone],
    ]);
    tracker.redo();
    expect(tracker.events[1]).toBe(b);
    expect(b.state).toBe(NotCommitted);
  });

  it("A → save → undo: A stays Committed and a compensating event is added", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    tracker.onCommit(pendingIds(tracker));
    const a = tracker.events[0];
    tracker.undo();
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "A" }, Committed],
      ["Retagged", { tag: "" }, NotCommitted, a.eventId],
    ]);
  });

  it("… → redo before sending the compensation: the compensation becomes Undone", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    tracker.onCommit(pendingIds(tracker));
    tracker.undo();
    tracker.redo();
    expect(log(tracker).map((row) => row[2])).toEqual([Committed, Undone]);
    expect(tracker.isDirty).toBe(false);
    tracker.undo(); // and back again
    expect(log(tracker).map((row) => row[2])).toEqual([Committed, NotCommitted]);
  });

  it("… → save → redo: a new event re-applies the change, compensating the compensation", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    tracker.onCommit(pendingIds(tracker));
    tracker.undo();
    const compensation = tracker.events[1];
    tracker.onCommit(pendingIds(tracker));
    tracker.redo();
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "A" }, Committed],
      ["Retagged", { tag: "" }, Committed, tracker.events[0].eventId],
      ["Retagged", { tag: "A" }, NotCommitted, compensation.eventId],
    ]);
  });

  it("a new operation drops Undone events along with the redo stack", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "A";
    doc.tag = "B";
    tracker.undo();
    doc.tag = "C";
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "A" }, NotCommitted],
      ["Retagged", { tag: "C" }, NotCommitted],
    ]);
  });

  it("history properties: one entry per operation, compensated with a reversal entry", () => {
    const { tracker, doc } = setupDoc();
    doc.note = "A";
    tracker.onCommit(pendingIds(tracker));
    doc.note = "B";
    tracker.undo();
    tracker.undo();
    expect(log(tracker)).toEqual([
      ["Noted", { note: [{ property: "note", value: "A" }] }, Committed],
      ["Noted", { note: [{ property: "note", value: "B" }] }, Undone],
      ["Noted", { note: [{ property: "note", value: "" }] }, NotCommitted, tracker.events[0].eventId],
    ]);
  });

  it("bucketed collection: committed add → undo compensates with a removal", () => {
    const { tracker, order } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    tracker.onCommit(pendingIds(tracker), [{ trackingId: a.trakrId, value: 9 }]);
    tracker.undo();
    expect(tracker.pendingEvents.map((e) => e.payload)).toEqual([
      { lines: { added: [], removed: [9], changed: [] } },
    ]);
  });

  it("history-mode collection: committed add → undo compensates with a remove op", () => {
    const { tracker, order } = setupOrder(true);
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    tracker.onCommit(pendingIds(tracker), [{ trackingId: a.trakrId, value: 9 }]);
    tracker.undo();
    expect(tracker.pendingEvents.map((e) => e.payload)).toEqual([{ lines: { ops: [{ op: "remove", id: 9 }] } }]);
  });

  it("itemAdded/itemRemoved: unsent add → undo marks it Undone; committed add → undo emits itemRemoved", () => {
    const tracker = new EventTracker();
    const board = tracker.construct(() => new Board(tracker));
    const card = tracker.construct(() => new Line(tracker, "c"));
    board.cards.push(card);
    tracker.undo();
    expect(log(tracker).map((r) => [r[0], r[2]])).toEqual([["CardAdded", Undone]]);
    tracker.redo();
    tracker.onCommit(pendingIds(tracker));
    tracker.undo();
    expect(log(tracker).map((r) => [r[0], r[2]])).toEqual([["CardAdded", Committed], ["CardRemoved", NotCommitted]]);
  });

  it("undo of an unrelated operation after a save leaves committed items alone (no phantom removal)", () => {
    const { tracker, order, existing } = setupOrder();
    const a = tracker.new(() => new Line(tracker, "a"));
    order.lines.push(a);
    existing.text = "edited";
    tracker.onCommit(pendingIds(tracker), [{ trackingId: a.trakrId, value: 9 }]);
    tracker.undo();
    expect(order.lines.collection).toContain(a);
    expect(a.trakrState).toBe(State.Unchanged);
    expect(tracker.pendingEvents.map((e) => e.payload)).toEqual([
      { lines: { added: [], removed: [], changed: [{ id: 1, text: "existing" }] } },
    ]);
  });
});

// ---------------------------------------------------------------------------- Sessions

describe("EventTracker sessions", () => {
  it("ending a session merges its unsent events like its single undo step", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.tag = "a";
    doc.tag = "b";
    session.end();
    expect(log(tracker)).toEqual([["Retagged", { tag: "b" }, NotCommitted]]);
    tracker.undo();
    expect(log(tracker)).toEqual([["Retagged", { tag: "b" }, Undone]]);
  });

  it("events committed during the session are kept as recorded", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.tag = "a";
    tracker.onCommit(pendingIds(tracker));
    doc.tag = "b";
    session.end();
    expect(log(tracker).map((r) => r[2])).toEqual([Committed, NotCommitted]);
    tracker.undo();
    expect(log(tracker).map((r) => [r[1], r[2]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "b" }, Undone],
      [{ tag: "" }, NotCommitted],
    ]);
  });

  it("undoing inside a session drops the undone events when the session ends", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.tag = "a";
    doc.tag = "b";
    tracker.undo();
    session.end();
    expect(log(tracker)).toEqual([["Retagged", { tag: "a" }, NotCommitted]]);
  });

  it("rollback removes unsent events and compensates committed ones", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.tag = "a";
    tracker.onCommit(pendingIds(tracker));
    doc.title = "T";
    session.rollback();
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "a" }, Committed],
      ["Retagged", { tag: "" }, NotCommitted, tracker.events[0].eventId],
    ]);
    expect(doc.title).toBe("");
  });
});

// ---------------------------------------------------------------------------- discardPendingChanges

describe("EventTracker.discardPendingChanges", () => {
  it("undoes unsent operations and forgets their events", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "saved";
    tracker.onCommit(pendingIds(tracker));
    doc.tag = "draft1";
    doc.tag = "draft2";
    tracker.discardPendingChanges();
    expect(doc.tag).toBe("saved");
    expect(log(tracker)).toEqual([["Retagged", { tag: "saved" }, Committed]]);
    expect(tracker.canRedo).toBe(false);
  });

  it("withdraws a pending compensation by redoing the committed operation", () => {
    const { tracker, doc } = setupDoc();
    doc.tag = "saved";
    tracker.onCommit(pendingIds(tracker));
    tracker.undo();
    tracker.discardPendingChanges();
    expect(doc.tag).toBe("saved");
    expect(log(tracker)).toEqual([
      ["Retagged", { tag: "saved" }, Committed],
      ["Retagged", { tag: "" }, Undone, tracker.events[0].eventId],
    ]);
    expect(tracker.isDirty).toBe(false);
  });

  it("keeps pending events it cannot revert (e.g. from tracker.new())", () => {
    const tracker = new EventTracker();
    class Issue extends TrackedObject {
      @Id id: string = "i1";
      @EventTracked() accessor status: string = "";
      constructor(t: Tracker) { super(t); this.status = "open"; }
    }
    tracker.new(() => new Issue(tracker));
    tracker.discardPendingChanges();
    expect(log(tracker)).toEqual([["", { status: "open" }, NotCommitted]]);
  });
});

// ---------------------------------------------------------------------------- Remaining rules

describe("EventTracker — remaining rules", () => {
  it("undoing an operation that recorded nothing for a key records nothing for it either", () => {
    const tracker = new EventTracker();
    const col = tracker.construct(
      () => new EventTrackedCollection<Line>(tracker, [], undefined, { itemRemoved: "CardRemoved" }),
    );
    col.push(tracker.construct(() => new Line(tracker, "c"))); // additions are silent
    tracker.undo();                                             // so is taking it back
    expect(tracker.events).toEqual([]);
  });

  it("a partly committed session: undo, then a new write drops the undone event but keeps the rest", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.tag = "a";
    tracker.onCommit(pendingIds(tracker));
    doc.tag = "b";
    session.end();
    tracker.undo();
    doc.title = "T";
    expect(log(tracker).map((r) => [r[1], r[2]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "" }, NotCommitted],
      [{ title: "T" }, NotCommitted],
    ]);
  });

  it("undoing a partly committed session only withdraws the keys that were never sent", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.tag = "a";
    tracker.onCommit(pendingIds(tracker));
    doc.title = "T";
    session.end();
    tracker.undo();
    expect(log(tracker).map((r) => [r[1], r[2]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ title: "T" }, Undone],
      [{ tag: "" }, NotCommitted],
    ]);
  });

  it("discard cannot split a partly committed step: its unsent part stays pending", () => {
    const { tracker, doc } = setupDoc();
    const session = tracker.startSession();
    doc.tag = "a";
    tracker.onCommit(pendingIds(tracker));
    doc.tag = "b";
    session.end();
    tracker.undo();
    tracker.discardPendingChanges();
    // The pending compensation is withdrawn by redoing the step; "b" is still in the object, so it stays pending.
    expect(log(tracker).map((r) => [r[1], r[2]])).toEqual([
      [{ tag: "a" }, Committed],
      [{ tag: "b" }, NotCommitted],
      [{ tag: "" }, Undone],
    ]);
    expect(doc.tag).toBe("b");
    expect(tracker.canRedo).toBe(false);
  });

  it("tracker.new() can record events that belong to no object", () => {
    const tracker = new EventTracker();
    tracker.new(() => {
      const tags = new EventTrackedCollection<string>(tracker, [], undefined, { eventType: "Tags" });
      tags.push("x");
      return tags;
    });
    expect(log(tracker)).toEqual([["Tags", { added: ["x"], removed: [] }, NotCommitted]]);
  });

  it("a committed creation event is kept when the object is later added to a collection", () => {
    const tracker = new EventTracker();
    const board = tracker.construct(() => new Board(tracker));
    const card = tracker.new(() => new Line(tracker, "c"));
    expect(log(tracker).map((r) => r[0])).toEqual([""]);
    tracker.onCommit(pendingIds(tracker));
    board.cards.push(card);
    expect(log(tracker).map((r) => [r[0], r[2]])).toEqual([["", Committed], ["CardAdded", NotCommitted]]);
  });

  it("an unsent creation event is superseded when the object is added to a collection", () => {
    const tracker = new EventTracker();
    const board = tracker.construct(() => new Board(tracker));
    const card = tracker.new(() => new Line(tracker, "c"));
    board.cards.push(card);
    expect(log(tracker).map((r) => r[0])).toEqual(["CardAdded"]);
  });
});

// ---------------------------------------------------------------------------- Validity

describe("EventTracker — removed items do not count towards validity", () => {
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

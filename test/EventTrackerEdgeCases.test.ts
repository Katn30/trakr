import { describe, it, expect, vi, afterEach } from "vitest";
import { EventTracker } from "../src/EventTracker";
import { EventTracked } from "../src/EventTracked";
import { EventTrackedCollection } from "../src/EventTrackedCollection";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { Tracker } from "../src/Tracker";
import { AutoId, Id } from "../src/ExternallyAssigned";

import { emitted, oneOperation, pendingIds } from "./eventHelpers";
// ---------------------------------------------------------------------------- Models

class Doc extends TrackedObject {
  @Id id: string = "d1";
  @EventTracked(undefined, undefined, { eventType: "Renamed" }) accessor title: string = "";
  @EventTracked(undefined, undefined, { eventType: "Noted", history: true }) accessor note: string = "";
  constructor(t: Tracker) { super(t); }
}

class Line extends TrackedObject {
  @AutoId id: number = 0;
  @EventTracked((_self, v: string) => (v === "" ? "required" : undefined)) accessor text: string = "x";
  constructor(t: Tracker, text = "x") { super(t); this.text = text; }
}

class Card extends TrackedObject {
  @AutoId id: number = 0;
  @EventTracked(undefined, undefined, { eventType: "CardEdited" }) accessor title: string = "";
  @EventTracked() accessor body: string = "";
  constructor(t: Tracker) { super(t); }
}

class Sticker extends TrackedObject {
  @Id code: string = "";
  @EventTracked(undefined, undefined, { eventType: "StickerEdited" }) accessor label: string = "";
  constructor(t: Tracker, code = "") { super(t); this.code = code; }
}

class Step extends TrackedObject {
  @Id id: string = "";
  @EventTracked(undefined, undefined, { history: true }) accessor log: string = "";
  @EventTracked() accessor hint: string | undefined = undefined;
  constructor(t: Tracker, id = "") { super(t); this.id = id; }
}

class Seat extends TrackedObject {
  @Id row: string = "";
  @Id num: number = 0;
  @EventTracked() accessor taken: boolean = false;
  constructor(t: Tracker, row = "", num = 0) { super(t); this.row = row; this.num = num; }
}

class Holder extends TrackedObject {
  @Id id: string = "h1";
  constructor(t: Tracker) { super(t); }
}

// ---------------------------------------------------------------------------- helpers

function loaded<T>(tracker: EventTracker, make: () => T): T {
  return tracker.construct(make);
}

function collection<T>(tracker: EventTracker, items: T[], options?: Record<string, unknown>) {
  return tracker.construct(() => new EventTrackedCollection<T>(tracker, items, undefined, options));
}

function payloads(tracker: EventTracker) {
  return emitted(tracker).map((e) => ({ eventType: e.eventType, payload: e.payload }));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------- tests

describe("EventTrackedCollection — suppressed mutations become the baseline", () => {
  it("push/remove inside withTrackingSuppressed produce no events", () => {
    const tracker = new EventTracker();
    const existing = loaded(tracker, () => new Sticker(tracker, "old"));
    const col = collection(tracker, [existing], { eventType: "Stickers" });
    const added = loaded(tracker, () => new Sticker(tracker, "new"));
    tracker.withTrackingSuppressed(() => {
      col.push(added);
      col.remove(existing);
    });
    expect(emitted(tracker)).toEqual([]);

    col.remove(added);
    expect(payloads(tracker)).toEqual([
      { eventType: "Stickers", payload: { added: [], removed: ["new"], changed: [] } },
    ]);
  });
});

describe("EventTrackedCollection — without event options", () => {
  it("items of a plain EventTrackedCollection never emit", () => {
    const tracker = new EventTracker();
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    collection(tracker, [s]);
    s.label = "edited";
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("itemAdded / itemRemoved collections — per-item events", () => {
  it("edits on a persisted item emit one event per tagged cluster, with numeric @AutoId targetId", () => {
    const tracker = new EventTracker();
    const card = loaded(tracker, () => new Card(tracker));
    tracker.withTrackingSuppressed(() => { card.id = 3; });
    const other = loaded(tracker, () => new Card(tracker));
    collection(tracker, [card, other], { itemAdded: "CardAdded" });

    card.title = "T";
    card.body = "untagged"; // no eventType → not emitted in per-item mode
    expect(emitted(tracker)).toEqual([
      { eventType: "CardEdited", payload: { title: "T" }, trackingId: card.trakrId, targetId: 3 },
    ]);
  });

  it("items without @AutoId carry no targetId on field events", () => {
    const tracker = new EventTracker();
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    collection(tracker, [s], { itemRemoved: "StickerRemoved" });
    s.label = "L";
    expect(emitted(tracker)).toEqual([
      { eventType: "StickerEdited", payload: { label: "L" }, trackingId: s.trakrId },
    ]);
  });

  it("only itemRemoved configured: additions are silent, removals emit", () => {
    const tracker = new EventTracker();
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    const col = collection(tracker, [s], { itemRemoved: "StickerRemoved" });
    col.push(loaded(tracker, () => new Sticker(tracker, "s2")));
    expect(emitted(tracker)).toEqual([]);
    col.remove(s);
    expect(emitted(tracker).map((e) => e.eventType)).toEqual(["StickerRemoved"]);
  });

  it("only itemAdded configured: removals are silent", () => {
    const tracker = new EventTracker();
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    const col = collection(tracker, [s], { itemAdded: "StickerAdded" });
    col.remove(s);
    expect(emitted(tracker)).toEqual([]);
  });

  it("an item added and removed in one operation emits nothing", () => {
    const tracker = new EventTracker();
    const col = collection<Sticker>(tracker, [], { itemAdded: "A", itemRemoved: "R" });
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    oneOperation(tracker, () => {
      col.push(s);
      col.remove(s);
    });
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("aggregate collections — slot shapes", () => {
  it("two collections owned by the same object fold into one event", () => {
    const tracker = new EventTracker();
    const holder = loaded(tracker, () => new Holder(tracker));
    const a = collection<Sticker>(tracker, [], { owner: { object: holder, property: "a" }, eventType: "Held" });
    const b = collection<Sticker>(tracker, [], { owner: { object: holder, property: "b" }, eventType: "Held" });
    const x = loaded(tracker, () => new Sticker(tracker, "x"));
    const y = loaded(tracker, () => new Sticker(tracker, "y"));
    oneOperation(tracker, () => {
      a.push(x);
      b.push(y);
    });
    expect(payloads(tracker)).toEqual([{
      eventType: "Held",
      payload: {
        a: { added: [{ code: "x", label: "" }], removed: [], changed: [] },
        b: { added: [{ code: "y", label: "" }], removed: [], changed: [] },
      },
    }]);
  });

  it("a standalone history collection without eventType uses the default group", () => {
    const tracker = new EventTracker();
    const col = collection<Sticker>(tracker, [], { history: true });
    col.push(loaded(tracker, () => new Sticker(tracker, "x")));
    expect(payloads(tracker)).toEqual([
      { eventType: "", payload: { ops: [{ op: "add", item: { code: "x", label: "" } }] } },
    ]);
  });

  it("primitive collections: added and removed, no `changed` key; ack clears them", () => {
    const tracker = new EventTracker();
    const tags = collection(tracker, ["keep", "drop"], { eventType: "Tags" });
    oneOperation(tracker, () => {
      tags.remove("drop");
      tags.push("new");
    });
    expect(payloads(tracker)).toEqual([{ eventType: "Tags", payload: { added: ["new"], removed: ["drop"] } }]);
    tracker.onCommit(pendingIds(tracker));
    expect(emitted(tracker)).toEqual([]);
  });

  it("an emptied object collection is still treated as an object collection", () => {
    const tracker = new EventTracker();
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    const col = collection(tracker, [s], { eventType: "Stickers" });
    col.remove(s);
    expect(payloads(tracker)).toEqual([
      { eventType: "Stickers", payload: { added: [], removed: ["s1"], changed: [] } },
    ]);
  });

  it("history properties on items appear in added snapshots and changed entries, and are acked", () => {
    const tracker = new EventTracker();
    const kept = loaded(tracker, () => new Step(tracker, "k"));
    const col = collection(tracker, [kept], { eventType: "Steps" });
    const fresh = tracker.new(() => new Step(tracker, "f"));
    oneOperation(tracker, () => {
      fresh.log = "created";
      col.push(fresh);
      kept.log = "touched";
    });

    expect(payloads(tracker)).toEqual([{
      eventType: "Steps",
      payload: {
        added: [{ id: "f", log: "created", hint: null }],
        removed: [],
        changed: [{ id: "k", log: [{ property: "log", value: "touched" }] }],
      },
    }]);
    tracker.onCommit(pendingIds(tracker));
    expect(emitted(tracker)).toEqual([]);
  });

  it("an added item without history entries is acked cleanly", () => {
    const tracker = new EventTracker();
    const col = collection<Step>(tracker, [], { eventType: "Steps" });
    col.push(loaded(tracker, () => new Step(tracker, "f")));
    tracker.onCommit(pendingIds(tracker));
    expect(emitted(tracker)).toEqual([]);
  });

  it("undefined field values are normalised to null", () => {
    const tracker = new EventTracker();
    const step = loaded(tracker, () => new Step(tracker, "s"));
    tracker.withTrackingSuppressed(() => { step.hint = "base"; });
    step.hint = undefined;
    expect(payloads(tracker)).toEqual([{ eventType: "", payload: { hint: null } }]);
  });
});

describe("history-mode collections — ops, undo, redo, ack", () => {
  function setup(options: Record<string, unknown> = { history: true, eventType: "Seats" }) {
    const tracker = new EventTracker();
    const seat = loaded(tracker, () => new Seat(tracker, "A", 1));
    const col = collection(tracker, [seat], options);
    return { tracker, seat, col };
  }

  it("item edits become change ops; undo of an unsent change withdraws it", () => {
    const { tracker, seat } = setup();
    seat.taken = true;
    expect(payloads(tracker)).toEqual([
      { eventType: "Seats", payload: { ops: [{ op: "change", row: "A", num: 1, taken: true }] } },
    ]);
    tracker.undo();
    expect(emitted(tracker)).toEqual([]);
  });

  it("undo of a persisted change emits a compensating change op", () => {
    const { tracker, seat } = setup();
    seat.taken = true;
    tracker.onCommit(pendingIds(tracker));
    tracker.undo();
    expect(payloads(tracker)).toEqual([
      { eventType: "Seats", payload: { ops: [{ op: "change", row: "A", num: 1, taken: false }] } },
    ]);
  });

  it("removes carry composite identity; undo of a persisted remove emits an add", () => {
    const { tracker, seat, col } = setup();
    col.remove(seat);
    expect(payloads(tracker)).toEqual([
      { eventType: "Seats", payload: { ops: [{ op: "remove", row: "A", num: 1 }] } },
    ]);
    tracker.onCommit(pendingIds(tracker));
    tracker.undo();
    expect(payloads(tracker)).toEqual([
      { eventType: "Seats", payload: { ops: [{ op: "add", item: { row: "A", num: 1, taken: false } }] } },
    ]);
  });

  it("redo after withdrawing an unsent add puts the same op back", () => {
    const { tracker, col } = setup();
    col.push(loaded(tracker, () => new Seat(tracker, "B", 2)));
    const before = payloads(tracker);
    tracker.undo();
    expect(emitted(tracker)).toEqual([]);
    tracker.redo();
    expect(payloads(tracker)).toEqual(before);
  });

  it("acknowledging an op that was withdrawn in the meantime is a no-op", () => {
    const { tracker, col } = setup();
    col.push(loaded(tracker, () => new Seat(tracker, "B", 2)));
    const sent = pendingIds(tracker);
    tracker.undo();
    tracker.onCommit(sent);
    expect(emitted(tracker)).toEqual([]);
  });

  it("entryFactory receives the op kind, including the inverse kind for compensations", () => {
    const entryFactory = (self: Seat, _change: unknown, ctx: unknown, op: string) => ({ op, row: self.row, ctx });
    const { tracker, seat, col } = setup({ history: { entryFactory }, eventType: "Seats" });
    tracker.withContext("ui", () => col.remove(seat));
    expect(payloads(tracker)).toEqual([
      { eventType: "Seats", payload: { ops: [{ op: "remove", row: "A", ctx: "ui" }] } },
    ]);
    tracker.onCommit(pendingIds(tracker));
    tracker.undo();
    expect(payloads(tracker)).toEqual([
      { eventType: "Seats", payload: { ops: [{ op: "add", row: "A", ctx: undefined }] } },
    ]);
  });

  it("undefined item values are normalised to null in snapshots and diffs", () => {
    const tracker = new EventTracker();
    const col = collection<Step>(tracker, [], { history: true, eventType: "Steps" });
    const step = loaded(tracker, () => new Step(tracker, "s"));
    col.push(step);
    step.hint = "h";
    step.hint = undefined;
    expect(payloads(tracker)).toEqual([
      { eventType: "Steps", payload: { ops: [{ op: "add", item: { id: "s", log: "", hint: null } }] } },
      { eventType: "Steps", payload: { ops: [{ op: "change", id: "s", log: "", hint: "h" }] } },
      { eventType: "Steps", payload: { ops: [{ op: "change", id: "s", log: "", hint: null }] } },
    ]);
  });

  it("primitive items are not recorded as ops", () => {
    const tracker = new EventTracker();
    const col = collection(tracker, ["x"], { history: true, eventType: "Tags" });
    col.push("y");
    col.remove("x");
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("history properties — replay effects", () => {
  it("redo after withdrawing an unsent entry restores it", () => {
    const tracker = new EventTracker();
    const doc = loaded(tracker, () => new Doc(tracker));
    doc.note = "A";
    tracker.undo();
    tracker.redo();
    expect(payloads(tracker)).toEqual([
      { eventType: "Noted", payload: { note: [{ property: "note", value: "A" }] } },
    ]);
  });

  it("acknowledging a chain that was withdrawn in the meantime is a no-op", () => {
    const tracker = new EventTracker();
    const doc = loaded(tracker, () => new Doc(tracker));
    doc.note = "A";
    const sent = pendingIds(tracker);
    tracker.undo();
    tracker.onCommit(sent);
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("EventTracker.onCommit — keys and warnings", () => {
  it("ignores keys for unknown tracking ids and for objects without @AutoId", () => {
    const tracker = new EventTracker();
    const doc = loaded(tracker, () => new Doc(tracker));
    doc.title = "T";
    tracker.onCommit(pendingIds(tracker), [
      { trackingId: 9999, value: 1 },
      { trackingId: doc.trakrId, value: 2 },
    ]);
    expect(doc.id).toBe("d1");
    expect(tracker.isDirty).toBe(false);
  });

});

describe("EventTracker.discardPendingChanges — mixed collections", () => {
  it("rebaselines event collections and leaves plain ones alone", () => {
    const tracker = new EventTracker();
    const plain = tracker.construct(() => new TrackedCollection<string>(tracker, []));
    const tags = collection(tracker, ["a"], { eventType: "Tags" });
    plain.push("p");
    tags.push("b");
    tracker.discardPendingChanges();
    expect(plain.collection).toEqual([]);
    expect(tags.collection).toEqual(["a"]);
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("EventTracker — validity of removed items", () => {
  it("removing an item from a second collection does not release it twice", () => {
    const tracker = new EventTracker();
    const line = loaded(tracker, () => new Line(tracker, "a"));
    const one = collection(tracker, [line], { eventType: "One" });
    const two = collection(tracker, [line], { eventType: "Two" });
    line.text = "";
    one.remove(line);
    two.remove(line);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    tracker.undo();
    expect(tracker.isValid).toBe(false);
  });

  it("re-adding a valid item and undoing that keeps the tracker valid", () => {
    const tracker = new EventTracker();
    const line = loaded(tracker, () => new Line(tracker, "a"));
    const col = collection(tracker, [line], { eventType: "Lines" });
    col.remove(line);
    col.push(line);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    expect(tracker.isValid).toBe(true);
    line.text = ""; // invalid while outside the collection: not counted
    expect(tracker.isValid).toBe(true);
  });
});

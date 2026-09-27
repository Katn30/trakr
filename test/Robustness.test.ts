import { describe, it, expect, vi } from "vitest";
import {
  UnitOfWork, Entity, EntityContainer, TrackedCollection, Tracked, AutoId, Id, State,
} from "@katn30/chronicle-unit-of-work";
import {
  EventLog, TrackedObject, EventTracked, EventTrackedCollection, type CommitBatch,
} from "@katn30/chronicle-event-log";
import { TypedEvent } from "@katn30/chronicle-core";
import { pendingEvents } from "./eventHelpers";

// ---------------------------------------------------------------------------- models

class Note extends Entity {
  @Tracked((_s, text: string) => (text === "" ? "required" : undefined)) accessor text: string = "ok";
  @Tracked(undefined, { beforeChange: (self: Note, v: string) => { if (v === "boom") throw new Error("hook failed"); self.log = `set ${v}`; } })
  accessor guarded: string = "";
  @Tracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor typed: string = "";
  @Tracked() accessor log: string = "";
  constructor(t: UnitOfWork) { super(t); }
}

class Folder extends EntityContainer {
  readonly notes = new TrackedCollection<Note>(this.tracker, []);
  constructor(t: UnitOfWork) { super(t); this.trackChild(this.notes); }
}

function uow() {
  const tracker = new UnitOfWork();
  const folder = tracker.construct(() => new Folder(tracker));
  const note = tracker.construct(() => new Note(tracker));
  tracker.withTrackingSuppressed(() => folder.notes.push(note));
  return { tracker, folder, note };
}

// ---------------------------------------------------------------------------- a write that throws

describe("a write that throws is rolled back, and the tracker keeps working", () => {
  it("a hook that throws: the value, the undo stack and isDirty are as before", () => {
    const { tracker, note } = uow();
    expect(() => { note.guarded = "boom"; }).toThrow("hook failed");
    expect(note.guarded).toBe("");
    expect(note.log).toBe("");
    expect(note.dirtyCounter).toBe(0);
    expect(note.chronicleState).toBe(State.Unchanged);
    expect(tracker.canUndo).toBe(false);
    expect(tracker.isDirty).toBe(false);
    note.guarded = "fine";                      // the next write is a normal step
    expect(note.log).toBe("set fine");
    tracker.undo();
    expect([note.guarded, note.log]).toEqual(["", ""]);
  });

  it("a setter body that throws", () => {
    class Strict extends Entity {
      private _v = 0;
      get value(): number { return this._v; }
      @Tracked() set value(v: number) {
        if (v < 0) throw new RangeError("negative");
        this._v = v;
      }
      constructor(t: UnitOfWork) { super(t); }
    }
    const tracker = new UnitOfWork();
    const s = tracker.construct(() => new Strict(tracker));
    expect(() => { s.value = -1; }).toThrow(RangeError);
    expect(s.value).toBe(0);
    expect(s.dirtyCounter).toBe(0);
    expect(tracker.canUndo).toBe(false);
    s.value = 2;
    expect(s.dirtyCounter).toBe(1);
  });

  it("a validator that throws", () => {
    class Fragile extends Entity {
      @Tracked((_s, v: string) => { if (v === "x") throw new Error("validator failed"); return undefined; })
      accessor code: string = "";
      constructor(t: UnitOfWork) { super(t); }
    }
    const tracker = new UnitOfWork();
    const f = tracker.construct(() => new Fragile(tracker));
    expect(() => { f.code = "x"; }).toThrow("validator failed");
    expect(f.code).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("a collection subscriber that throws: the mutation is reverted", () => {
    const { tracker, folder } = uow();
    const other = tracker.construct(() => new Note(tracker));
    const unsubscribe = folder.notes.afterChange.subscribe(() => { throw new Error("subscriber failed"); });
    expect(() => folder.notes.push(other)).toThrow("subscriber failed");
    expect(folder.notes.length).toBe(1);
    expect(other.chronicleState).toBe(State.Unchanged);
    expect(tracker.canUndo).toBe(false);
    unsubscribe();
    folder.notes.push(other);
    expect(other.chronicleState).toBe(State.Insert);
  });

  it("a write coalescing into the last step: only the failing write is reverted", () => {
    const { tracker, note } = uow();
    note.typed = "a";
    const failing = note.changed.subscribe(({ newValue }) => { if (newValue === "ab!") throw new Error("no"); });
    expect(() => { note.typed = "ab!"; }).toThrow("no");
    failing();
    expect(note.typed).toBe("a");
    expect(tracker.undoable).toHaveLength(1);
    note.typed = "ab";                          // still coalesces into the same step
    expect(tracker.undoable).toHaveLength(1);
    tracker.undo();
    expect(note.typed).toBe("");
  });

  it("isValid is recomputed after a rollback", () => {
    const { tracker, note } = uow();
    const failing = note.changed.subscribe(() => { throw new Error("no"); });
    expect(() => { note.text = ""; }).toThrow("no");
    failing();
    expect(tracker.isValid).toBe(true);
    expect(note.validationMessages.size).toBe(0);
  });

  it("construct() whose callback throws leaves tracking on", () => {
    const { tracker, note } = uow();
    expect(() => tracker.construct(() => { throw new Error("bad row"); })).toThrow("bad row");
    note.text = "edited";
    expect(tracker.canUndo).toBe(true);
    expect(tracker.isDirty).toBe(true);
  });

  it("new() whose callback throws leaves the history as it was", () => {
    const { tracker, note } = uow();
    note.text = "first";
    expect(() => tracker.new(() => { const n = new Note(tracker); n.text = "x"; throw new Error("bad default"); })).toThrow("bad default");
    expect(tracker.undoable).toHaveLength(1);
    note.text = "second";
    expect(tracker.undoable).toHaveLength(2);
  });

  it("an EventLog write that throws records no event, and a pending event it coalesced into is unchanged", () => {
    class Doc extends TrackedObject {
      @Id id = "d";
      @EventTracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor text: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const log = new EventLog();
    const doc = log.construct(() => new Doc(log));
    doc.text = "a";
    const failing = doc.changed.subscribe(({ newValue }) => { if (newValue === "ab!") throw new Error("no"); });
    expect(() => { doc.text = "ab!"; }).toThrow("no");
    failing();
    expect(pendingEvents(log).map((e) => e.payload)).toEqual([{ text: "a" }]);
    doc.text = "ab";
    expect(pendingEvents(log).map((e) => e.payload)).toEqual([{ text: "ab" }]);
  });

  it("an EventLog write whose toPayload throws is rolled back", () => {
    class Doc extends TrackedObject {
      @Id id = "d";
      @EventTracked(undefined, undefined, { toPayload: (_s: Doc, v: string) => { if (v === "?") throw new Error("cannot build"); return v; } })
      accessor text: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const log = new EventLog();
    const doc = log.construct(() => new Doc(log));
    expect(() => { doc.text = "?"; }).toThrow("cannot build");
    expect(doc.text).toBe("");
    expect(log.isDirty).toBe(false);
    doc.text = "ok";
    expect(pendingEvents(log).map((e) => e.payload)).toEqual([{ text: "ok" }]);
  });
});

// ---------------------------------------------------------------------------- index access

describe("collection[i] works like an array's", () => {
  it("reads items; out of range is undefined; `in` works", () => {
    const tracker = new UnitOfWork();
    const c = tracker.construct(() => new TrackedCollection<string>(tracker, ["a", "b"]));
    expect(c[0]).toBe("a");
    expect(c[1]).toBe("b");
    expect(c[2]).toBeUndefined();
    expect(0 in c).toBe(true);
    expect(2 in c).toBe(false);
    expect("length" in c).toBe(true);
  });

  it("assigning replaces the item (one step), at the end appends, past the end throws", () => {
    const tracker = new UnitOfWork();
    const c = tracker.construct(() => new TrackedCollection<string>(tracker, ["a", "b"]));
    c[0] = "A";
    expect(c.collection).toEqual(["A", "b"]);
    c[2] = "c";
    expect(c.collection).toEqual(["A", "b", "c"]);
    expect(() => { c[5] = "x"; }).toThrow(RangeError);
    tracker.undo();
    tracker.undo();
    expect(c.collection).toEqual(["a", "b"]);
  });

  it("assigning a model marks the old one removed and the new one added", () => {
    const { tracker, folder, note } = uow();
    const other = tracker.new(() => new Note(tracker));
    folder.notes[0] = other;
    expect(note.chronicleState).toBe(State.Deleted);
    expect(other.chronicleState).toBe(State.Insert);
  });

  it("a validator reading an item by index re-runs when the collection changes", () => {
    class Playlist extends Entity {
      readonly songs = new TrackedCollection<string>(this.tracker, []);
      @Tracked((self: Playlist) => (self.songs[0] === "intro" ? undefined : "must start with the intro"))
      get opening(): string { return this.songs[0] ?? ""; }
      constructor(t: UnitOfWork) { super(t); }
    }
    const tracker = new UnitOfWork();
    const p = tracker.construct(() => new Playlist(tracker));
    expect(p.chronicleIsValid).toBe(false);
    p.songs.push("intro");
    expect(p.chronicleIsValid).toBe(true);
    p.songs[0] = "outro";
    expect(p.chronicleIsValid).toBe(false);
  });

  it("an EventTrackedCollection is indexable too, and is the object its tracker knows", () => {
    class Tag extends TrackedObject {
      @Id code = "";
      constructor(t: EventLog, code: string) { super(t); this.code = code; }
    }
    const log = new EventLog();
    const a = log.construct(() => new Tag(log, "a"));
    const tags = log.construct(() => new EventTrackedCollection<Tag>(log, "tags", [a]));
    expect(tags[0]).toBe(a);
    expect(log._trackedCollections).toContain(tags);
    tags[0] = log.construct(() => new Tag(log, "b"));
    expect(pendingEvents(log).map((e) => e.payload)).toEqual([
      { tags: { added: [{ code: "b" }], removed: ["a"], changed: [] } },
    ]);
  });
});

// ---------------------------------------------------------------------------- reordering

describe("sort() and reverse() are undoable steps that save nothing", () => {
  it("UnitOfWork: items keep their state; the commit calls no save", async () => {
    const tracker = new UnitOfWork();
    const folder = tracker.construct(() => new Folder(tracker));
    const [x, y] = [tracker.construct(() => new Note(tracker)), tracker.construct(() => new Note(tracker))];
    tracker.withTrackingSuppressed(() => { x.text = "x"; y.text = "y"; folder.notes.push(y, x); });
    folder.notes.sort((a, b) => a.text.localeCompare(b.text));
    expect(folder.notes.collection).toEqual([x, y]);
    expect([x.chronicleState, y.chronicleState]).toEqual([State.Unchanged, State.Unchanged]);
    const save = vi.fn();
    expect(await tracker.commit(save)).toBe(true);
    expect(save).not.toHaveBeenCalled();
  });

  it("EventLog: no event", () => {
    const log = new EventLog();
    const labels = log.construct(() => new EventTrackedCollection<string>(log, "labels", ["b", "a"]));
    labels.sort();
    expect(labels.collection).toEqual(["a", "b"]);
    expect(pendingEvents(log)).toEqual([]);
    expect(log.undoable.map((e) => [e.isCommitted, e.events])).toEqual([[true, []]]);
  });
});

// ---------------------------------------------------------------------------- validity counting

describe("UnitOfWork: an object out of the model does not count towards isValid", () => {
  it("removed, then broken, fixed and broken again: still out; back in: counts as it is", () => {
    const { tracker, folder, note } = uow();
    folder.notes.remove(note);
    note.text = "";
    expect(tracker.isValid).toBe(true);
    note.text = "fixed";
    note.text = "";
    expect(tracker.isValid).toBe(true);
    folder.notes.push(note);
    expect(tracker.isValid).toBe(false);
    note.text = "ok";
    expect(tracker.isValid).toBe(true);
  });

  it("an invalid new object: added, removed (forgotten), added again, removed: counted once each time", () => {
    const tracker = new UnitOfWork();
    const folder = tracker.construct(() => new Folder(tracker));
    const draft = tracker.new(() => new Note(tracker));
    draft.text = "";
    expect(tracker.isValid).toBe(false);       // a new object counts as soon as it exists (a draft form blocks saving)
    folder.notes.push(draft);
    expect(tracker.isValid).toBe(false);
    folder.notes.remove(draft);
    expect(tracker.isValid).toBe(true);
    folder.notes.push(draft);
    expect(tracker.isValid).toBe(false);
    folder.notes.remove(draft);
    expect(tracker.isValid).toBe(true);
    draft.text = "fine";
    folder.notes.push(draft);
    expect(tracker.isValid).toBe(true);
  });

  it("undo and redo through removal and re-adding keep the count", () => {
    const { tracker, folder, note } = uow();
    note.text = "";
    folder.notes.remove(note);
    folder.notes.push(note);
    const seen: boolean[] = [];
    for (let i = 0; i < 3; i++) { tracker.undo(); seen.push(tracker.isValid); }
    for (let i = 0; i < 3; i++) { tracker.redo(); seen.push(tracker.isValid); }
    expect(seen).toEqual([true, false, true, false, true, false]);
  });

  it("a destroyed object no longer counts, whatever is written to it", () => {
    const tracker = new UnitOfWork();
    const n = tracker.construct(() => new Note(tracker));
    n.text = "";
    expect(tracker.isValid).toBe(false);
    n.destroy();
    expect(tracker.isValid).toBe(true);
    n.text = "x";
    n.text = "";
    expect(tracker.isValid).toBe(true);
  });

  it("a removed container's children: edited while out, counted again when it is back", () => {
    const tracker = new UnitOfWork();
    const folders = tracker.construct(() => new TrackedCollection<Folder>(tracker, []));
    const folder = tracker.construct(() => new Folder(tracker));
    const note = tracker.construct(() => new Note(tracker));
    tracker.withTrackingSuppressed(() => { folders.push(folder); folder.notes.push(note); });
    folders.remove(folder);
    note.text = "";
    expect(tracker.isValid).toBe(true);
    folders.push(folder);
    expect(tracker.isValid).toBe(false);
  });
});

// ---------------------------------------------------------------------------- models held by properties

describe("a model held by a tracked property", () => {
  class Customer extends Entity {
    @AutoId id: number | null = null;
    @Tracked() accessor name: string = "";
    constructor(t: UnitOfWork) { super(t); }
  }
  class Order extends Entity {
    @Tracked() accessor customer: Customer | null = null;
    constructor(t: UnitOfWork) { super(t); }
  }

  it("assigning a new one makes it Insert; clearing it forgets it; undo brings both back", async () => {
    const tracker = new UnitOfWork();
    const order = tracker.construct(() => new Order(tracker));
    const customer = tracker.new(() => new Customer(tracker));
    order.customer = customer;
    expect(customer.chronicleState).toBe(State.Insert);
    order.customer = null;
    expect(customer.chronicleState).toBe(State.Unchanged);
    tracker.undo();
    expect(customer.chronicleState).toBe(State.Insert);
    let inserted: unknown[] = [];
    await tracker.commit(({ inserted: i }) => { inserted = i; return [{ chronicleId: customer.chronicleId, value: 9 }]; });
    expect(inserted).toEqual([customer]);
    expect(customer.id).toBe(9);
  });
});

// ---------------------------------------------------------------------------- events

describe("TypedEvent", () => {
  it("a handler that unsubscribes itself while the event fires does not make the next one miss it", () => {
    const tracker = new UnitOfWork();
    const n = tracker.construct(() => new Note(tracker));
    const calls: string[] = [];
    const once = n.changed.subscribe(() => { calls.push("once"); once(); });
    n.changed.subscribe(() => calls.push("always"));
    n.log = "a";
    n.log = "b";
    expect(calls).toEqual(["once", "always", "always"]);
  });

  it("a handler subscribed while the event fires runs from the next event", () => {
    const tracker = new UnitOfWork();
    const n = tracker.construct(() => new Note(tracker));
    const calls: string[] = [];
    n.changed.subscribe(() => { calls.push("first"); if (calls.length === 1) n.changed.subscribe(() => calls.push("late")); });
    n.log = "a";
    n.log = "b";
    expect(calls).toEqual(["first", "first", "late"]);
  });

  it("is only a type for applications: subscribe and unsubscribe", () => {
    const e: TypedEvent<number> | undefined = undefined;
    expect(e).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------- saving batches

describe("commit batches (EventLog)", () => {
  it("a batch never contains a withdrawn change", async () => {
    class Doc extends TrackedObject {
      @Id id = "d";
      @EventTracked() accessor text: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const log = new EventLog();
    const doc = log.construct(() => new Doc(log));
    doc.text = "a";
    doc.text = "b";
    log.undo();
    const batches: CommitBatch[] = [];
    await log.commit((b) => { batches.push(b); });
    expect(batches.map((b) => b.events.map((e) => e.payload))).toEqual([[{ text: "a" }]]);
  });
});

// ---------------------------------------------------------------------------- decorated getters

describe("a decorated getter", () => {
  it("can carry a validator (UnitOfWork), re-run when what it reads changes", () => {
    class Line extends Entity {
      @Tracked() accessor qty: number = 1;
      @Tracked() accessor price: number = 10;
      @Tracked((_self, total: number) => (total > 100 ? "Over budget" : undefined))
      get total(): number { return this.qty * this.price; }
      constructor(t: UnitOfWork) { super(t); }
    }
    const tracker = new UnitOfWork();
    const line = tracker.construct(() => new Line(tracker));
    expect(line.chronicleIsValid).toBe(true);
    line.qty = 20;
    expect(line.validationMessages.get("total")).toBe("Over budget");
    tracker.undo();
    expect(line.chronicleIsValid).toBe(true);
  });

  it("with @EventTracked: validated, but not part of the events (it is derived)", () => {
    class Line extends TrackedObject {
      @Id id = "l1";
      @EventTracked() accessor qty: number = 1;
      @EventTracked((_self, total: number) => (total > 5 ? "too many" : undefined)) get total(): number { return this.qty * 2; }
      constructor(t: EventLog) { super(t); }
    }
    const log = new EventLog();
    const line = log.construct(() => new Line(log));
    const lines = log.construct(() => new EventTrackedCollection<Line>(log, "lines"));
    lines.push(line);
    line.qty = 3;
    expect(pendingEvents(log).map((e) => e.payload)).toEqual([
      { lines: { added: [{ id: "l1", qty: 1 }], removed: [], changed: [] } },
      { lines: { added: [], removed: [], changed: [{ id: "l1", qty: 3 }] } },
    ]);
    expect(line.validationMessages.get("total")).toBe("too many");
  });
});

describe("UnitOfWork: an object in two collections", () => {
  it("removed from one of them is Deleted (the README says: one collection at a time)", () => {
    class Tag extends Entity { constructor(t: UnitOfWork) { super(t); } }
    const tracker = new UnitOfWork();
    const tag = tracker.construct(() => new Tag(tracker));
    const a = tracker.construct(() => new TrackedCollection<Tag>(tracker, [tag]));
    const b = tracker.construct(() => new TrackedCollection<Tag>(tracker, [tag]));
    a.remove(tag);
    expect(tag.chronicleState).toBe(State.Deleted);
    expect(b.collection).toContain(tag);
  });
});

// ---------------------------------------------------------------------------- construction and validation

describe("validators see what a construction built", () => {
  class Basket extends EntityContainer {
    readonly items = new TrackedCollection<string>(this.tracker, [], (items) => (items.length === 0 ? "empty" : undefined));
    constructor(t: UnitOfWork) { super(t); this.trackChild(this.items); }
  }

  it("a collection filled inside construct() is valid once the construction ends", () => {
    const tracker = new UnitOfWork();
    const basket = tracker.construct(() => {
      const b = new Basket(tracker);
      b.items.push("apple");
      return b;
    });
    expect(basket.items.error).toBeUndefined();
    expect(tracker.isValid).toBe(true);
  });

  it("several writes to the same collection during a construction: validated once, at the end", () => {
    const tracker = new UnitOfWork();
    const basket = tracker.construct(() => {
      const b = new Basket(tracker);
      b.items.push("a");
      b.items.push("b");
      b.items.remove("a");
      return b;
    });
    expect(basket.items.collection).toEqual(["b"]);
    expect(basket.items.error).toBeUndefined();
  });

  it("nested constructions revalidate once, when the outermost one ends", () => {
    const tracker = new UnitOfWork();
    const basket = tracker.construct(() => {
      const b = tracker.construct(() => new Basket(tracker));
      expect(b.items.error).toBe("empty");       // still being built
      b.items.push("pear");
      return b;
    });
    expect(basket.items.error).toBeUndefined();
  });

  it("new() inside construct(), and construct() inside new()", () => {
    const tracker = new UnitOfWork();
    const outer = tracker.construct(() => {
      const b = tracker.new(() => new Basket(tracker));
      tracker.withTrackingSuppressed(() => b.items.push("fig"));
      return b;
    });
    expect(outer.items.error).toBeUndefined();
    const inner = tracker.new(() => {
      const b = tracker.construct(() => new Basket(tracker));
      tracker.withTrackingSuppressed(() => b.items.push("kiwi"));
      return b;
    });
    expect(inner.items.error).toBeUndefined();
    expect(tracker.isValid).toBe(true);
    expect(tracker.canUndo).toBe(false);
  });
});

// ---------------------------------------------------------------------------- saved objects: undo after the save

describe("UnitOfWork: undoing steps of an object that was saved", () => {
  class Item extends Entity {
    @AutoId id: number | null = null;
    @Tracked() accessor a: number = 0;
    @Tracked() accessor b: number = 0;
    constructor(t: UnitOfWork) { super(t); }
  }

  function saved() {
    const tracker = new UnitOfWork();
    const list = tracker.construct(() => new TrackedCollection<Item>(tracker, []));
    const item = tracker.new(() => new Item(tracker));
    list.push(item);                            // step 1: added
    item.a = 1;                                 // step 2
    item.b = 2;                                 // step 3
    tracker._onCommit([{ chronicleId: item.chronicleId, value: 5 }]);
    return { tracker, list, item };
  }

  it("undoing edits makes it Changed; undoing the addition makes it Deleted; redoing all is back to saved", () => {
    const { tracker, item } = saved();
    const states: State[] = [];
    for (let i = 0; i < 3; i++) { tracker.undo(); states.push(item.chronicleState); }
    for (let i = 0; i < 3; i++) { tracker.redo(); states.push(item.chronicleState); }
    expect(states).toEqual([
      State.Changed, State.Changed, State.Deleted,          // undo b, undo a, undo the addition
      State.Changed, State.Changed, State.Unchanged,        // redo the addition (edits still undone), a, b
    ]);
    expect(item.id).toBe(5);
  });

  it("a saved removal undone is an Insert; redone, nothing to do", () => {
    const { tracker, list, item } = saved();
    list.remove(item);
    tracker._onCommit();
    tracker.undo();
    expect(item.chronicleState).toBe(State.Insert);
    tracker.redo();
    expect(item.chronicleState).toBe(State.Unchanged);
  });

  it("a moved object (removed and added back) is one change; undoing the move restores it", () => {
    const { tracker, list, item } = saved();
    list.remove(item);
    list.push(item);
    expect(item.chronicleState).toBe(State.Changed);
    tracker.undo();
    expect(item.chronicleState).toBe(State.Deleted);
    tracker.undo();
    expect(item.chronicleState).toBe(State.Unchanged);
  });
});

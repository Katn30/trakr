/**
 * Commit lifecycle and save-layer correctness tests.
 *
 * Covers every reachable combination of user actions (add, remove, edit,
 * undo, redo, commit) and verifies both the resulting State and that
 * the save layer can determine the correct server operation and ID:
 *
 *   obj.state        → which operation (Insert/Changed/Deleted/Unchanged)
 *   obj.trackingId   → client-assigned stable ID, used in the save payload for
 *                      Insert and Changed items so the backend can echo back
 *                      the new server-assigned PK
 *   obj.id           → real server ID (for Changed/Deleted items)
 *
 * Key invariants:
 *   Insert    → POST   sending trackingId  (obj.id may hold a stale real server id)
 *   Changed   → PATCH  sending trackingId + obj.id  (backend returns new PK for temporal tables)
 *   Deleted   → DELETE using obj.id        (always a real server id > 0)
 *   Unchanged → skip
 */

import { describe, it, expect } from "vitest";
import { TrackedObject } from "../src/TrackedObject";
import { State } from "../src/State";
import { Tracker } from "../src/Tracker";
import { DirtyTracker } from "../src/DirtyTracker";
import { Tracked } from "../src/Tracked";
import { TrackedCollection } from "../src/TrackedCollection";
import { AutoId } from "../src/ExternallyAssigned";

class ItemModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor name: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

/** Creates an already-persisted item (state=Unchanged, id=realId). */
function loadedItem(tracker: Tracker, realId: number): ItemModel {
  const item = tracker.construct(() => new ItemModel(tracker));
  tracker.withTrackingSuppressed(() => { item.id = realId; });
  return item;
}

// ---- Insert ----

describe("TrackedObject state transitions — Insert", () => {
  it("new item added to collection: state=Insert, trackingId assigned at construction", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    expect(item.trakrState).toBe(State.Insert);
    expect(item.trakrId).toBeGreaterThan(0);
  });

  it("Insert: save layer should use trackingId for payload, @AutoId is untouched", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    expect(item.trakrState).toBe(State.Insert);
    expect(item.id).toBe(0); // untouched by the library
    expect(item.trakrId).toBeGreaterThan(0);
  });

  it("undo push → state=Unchanged, trackingId unchanged → skip", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    const tid = item.trakrId;
    items.push(item);
    tracker.undo();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.trakrId).toBe(tid); // trackingId is stable
  });

  it("undo push removes constructed item from trackedObjects — no ghost", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker.undo();

    expect(tracker.trackedObjects).not.toContain(item);
  });

  it("undo push → redo push → state=Insert, same trackingId → POST", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    const tid = item.trakrId;
    items.push(item);

    tracker.undo();
    tracker.redo();

    expect(item.trakrState).toBe(State.Insert);
    expect(item.trakrId).toBe(tid); // stable across undo/redo
    expect(tracker.trackedObjects).toContain(item); // re-tracked on redo
  });

  it("trackingId usable after undo+redo cycle for onCommit", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    tracker.undo();
    tracker.redo();

    tracker.onCommit([{ trackingId: item.trakrId, value: 1 }]);
    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(1);
  });

  it("multiple undo/redo cycles remain coherent", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    tracker.onCommit([{ trackingId: item.trakrId, value: 1 }]);

    tracker.undo();
    expect(item.trakrState).toBe(State.Deleted);
    tracker.redo();
    expect(item.trakrState).toBe(State.Unchanged);
    tracker.undo();
    expect(item.trakrState).toBe(State.Deleted);
    tracker.redo();
    expect(item.trakrState).toBe(State.Unchanged);
  });

  it("push + name → commit → undo → undo exhausts the undo stack", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "Widget";

    tracker.onCommit([{ trackingId: item.trakrId, value: 1 }]);

    tracker.undo();
    expect(item.trakrState).toBe(State.Deleted);

    tracker.undo();
    expect(item.trakrState).toBe(State.Unchanged);
    expect(tracker.canUndo).toBe(false);
  });

  it("onCommit does not add a spurious extra undo step", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    tracker.onCommit([{ trackingId: item.trakrId, value: 1 }]);

    tracker.undo();
    expect(tracker.canUndo).toBe(false);
    expect(item.trakrState).toBe(State.Deleted);
  });
});

// ---- Committed Insert undone ----

describe("TrackedObject state transitions — committed Insert undone", () => {
  it("push → commit(id=1) → state=Unchanged", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker.onCommit([{ trackingId: item.trakrId, value: 1 }]);

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(1);
  });

  it("push → commit(id=1) → undo: state=Deleted, id=1 → DELETE with id=1", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker.onCommit([{ trackingId: item.trakrId, value: 1 }]);
    tracker.undo();

    expect(item.trakrState).toBe(State.Deleted);
    expect(item.id).toBe(1);
  });

  it("push → commit(id=1) → undo → redo: state=Unchanged", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker.onCommit([{ trackingId: item.trakrId, value: 1 }]);
    tracker.undo();
    tracker.redo();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(1);
  });
});

// ---- Changed ----

describe("TrackedObject state transitions — Changed", () => {
  it("loaded item edited: state=Changed, id=real → PATCH with id", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";

    expect(item.trakrState).toBe(State.Changed);
    expect(item.id).toBe(10);
  });

  it("edit → undo → state=Unchanged → skip", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker.undo();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("edit → undo → redo → state=Changed, id=10 → PATCH with id", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker.undo();
    tracker.redo();

    expect(item.trakrState).toBe(State.Changed);
    expect(item.id).toBe(10);
  });

  it("undo before commit discards change; redo restores it and commit succeeds", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";

    tracker.undo();
    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.name).toBe("");

    tracker.redo();
    expect(item.trakrState).toBe(State.Changed);
    expect(item.name).toBe("Widget");

    tracker.onCommit();
    expect(item.trakrState).toBe(State.Unchanged);
  });

  it("edit → commit (non-temporal, no keys) → state=Unchanged, id unchanged", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker.onCommit();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("edit → commit (temporal: returns new PK) → @AutoId updated to new PK", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const tid = item.trakrId;
    item.name = "Widget";

    tracker.onCommit([{ trackingId: tid, value: 99 }]);

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(99); // new server PK after soft-delete + insert
  });

  it("edit → commit → undo → state=Changed, id=10, pre-edit values restored", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker.onCommit();
    tracker.undo();

    expect(item.trakrState).toBe(State.Changed);
    expect(item.name).toBe("");
    expect(item.id).toBe(10);
  });

  it("edit → commit → undo → redo → state=Unchanged", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker.onCommit();
    tracker.undo();
    tracker.redo();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.name).toBe("Widget");
    expect(item.id).toBe(10);
  });
});

// ---- Deleted ----

describe("TrackedObject state transitions — Deleted", () => {
  it("loaded item removed: state=Deleted, id=real → DELETE with id", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    expect(item.trakrState).toBe(State.Deleted);
    expect(item.id).toBe(10);
  });

  it("remove → undo → state=Unchanged → skip", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("remove → undo → redo → state=Deleted, id=10 → DELETE with id", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();
    tracker.redo();

    expect(item.trakrState).toBe(State.Deleted);
    expect(item.id).toBe(10);
  });

  it("undo before commit clears Deleted; redo restores it and commit succeeds", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    tracker.undo();
    expect(item.trakrState).toBe(State.Unchanged);

    tracker.redo();
    expect(item.trakrState).toBe(State.Deleted);

    tracker.onCommit();
    expect(item.trakrState).toBe(State.Unchanged);
  });

  it("remove → commit → state=Unchanged", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.onCommit();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("remove → commit → undo: state=Insert, id=10 stale — save layer must POST using trackingId, NOT the stale id", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.onCommit();
    tracker.undo();

    expect(item.trakrState).toBe(State.Insert);
    expect(item.trakrId).toBeGreaterThan(0);
    expect(item.id).toBe(10); // stale — do NOT use for INSERT
  });

  it("committed delete → undo (Insert) → commit again re-inserts the item", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.onCommit();
    expect(item.trakrState).toBe(State.Unchanged);

    tracker.undo();
    expect(item.trakrState).toBe(State.Insert);

    tracker.onCommit([{ trackingId: item.trakrId, value: 99 }]);
    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(99);
  });

  it("remove → commit → undo → redo → state=Unchanged", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.onCommit();
    tracker.undo();
    tracker.redo();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });
});

// ---- Insert collapsed by remove ----

describe("TrackedObject state transitions — Insert collapsed by remove", () => {
  it("push → remove → state=Unchanged → skip (item was never persisted)", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    items.remove(item);

    expect(item.trakrState).toBe(State.Unchanged);
    expect(tracker.trackedObjects).not.toContain(item);
  });

  it("push → remove → undo → item is re-tracked and back in the collection as Insert", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    items.remove(item);
    tracker.undo();

    expect(item.trakrState).toBe(State.Insert);
    expect(tracker.trackedObjects).toContain(item);
    expect(items.collection).toContain(item);
  });

  it("push → remove → undo → redo → item is untracked again", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    items.remove(item);
    tracker.undo();
    tracker.redo();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(tracker.trackedObjects).not.toContain(item);
    expect(items.collection).not.toContain(item);
  });
});

// ---- @AutoId / trackingId ----

describe("TrackedObject state transitions — @AutoId / trackingId", () => {
  it("every object gets a unique trackingId at construction", () => {
    const tracker = new DirtyTracker();
    const i1 = tracker.construct(() => new ItemModel(tracker));
    const i2 = tracker.construct(() => new ItemModel(tracker));

    expect(i1.trakrId).not.toBe(i2.trakrId);
  });

  it("trackingId is positive and assigned regardless of state", () => {
    const tracker = new DirtyTracker();
    const item = tracker.construct(() => new ItemModel(tracker));

    expect(item.trakrId).toBeGreaterThan(0);
    expect(item.trakrState).toBe(State.Unchanged); // not yet pushed
  });

  it("onCommit marks tracker as not dirty", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "Widget";
    tracker.onCommit([]);

    expect(tracker.isDirty).toBe(false);
  });

  it("leaves @AutoId unchanged when trackingId not found in keys", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker.onCommit([{ trackingId: 9999, value: 101 }]);

    expect(item.id).toBe(0); // not matched → unchanged
    expect(item.trakrState).toBe(State.Unchanged); // still committed
  });

  it("trackingId is globally unique across save cycles", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const i1 = tracker.construct(() => new ItemModel(tracker));
    items.push(i1);
    const tid1 = i1.trakrId;
    tracker.onCommit([{ trackingId: tid1, value: 1 }]);

    const i2 = tracker.construct(() => new ItemModel(tracker));
    items.push(i2);

    expect(i2.trakrId).toBeGreaterThan(0);
    expect(i2.trakrId).not.toBe(tid1);
  });

  it("@AutoId field is never written with a non-server value by the library", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));

    items.push(item);
    expect(item.id).toBe(0);

    tracker.undo();
    expect(item.id).toBe(0);

    tracker.redo();
    expect(item.id).toBe(0);

    tracker.onCommit([{ trackingId: item.trakrId, value: 42 }]);
    expect(item.id).toBe(42); // only now does the library write to @AutoId

    tracker.undo();
    expect(item.id).toBe(42); // real id kept — never zeroed out
  });
});

// ---- Save operation routing ----

describe("TrackedObject state transitions — save operation routing", () => {
  /**
   * Mirrors the save loop a frontend would run over tracker.trackedObjects.
   * For temporal tables, Changed items also produce a new server PK.
   */
  function whatToSave(item: ItemModel): { op: string; idToUse: number } {
    switch (item.trakrState) {
      case State.Insert:   return { op: "POST",   idToUse: item.trakrId };
      case State.Changed:  return { op: "PATCH",  idToUse: item.id };
      case State.Deleted:  return { op: "DELETE", idToUse: item.id };
      default:             return { op: "skip",   idToUse: 0 };
    }
  }

  it("new item → POST using trackingId", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("POST");
    expect(idToUse).toBe(item.trakrId);
  });

  it("loaded + edited → PATCH using real id", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 5);
    item.name = "Updated";

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("PATCH");
    expect(idToUse).toBe(5);
  });

  it("loaded + removed → DELETE using real id", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 5);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("DELETE");
    expect(idToUse).toBe(5);
  });

  it("committed delete → undo → POST using trackingId (NOT stale real id)", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 99);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.onCommit();
    tracker.undo();

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("POST");
    expect(idToUse).toBe(item.trakrId);
    expect(idToUse).not.toBe(99); // never the stale real id
  });

  it("loaded item → skip (no operation needed)", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 5);

    const { op } = whatToSave(item);
    expect(op).toBe("skip");
  });
});

// ---- Reactivity gate on onCommit write-back ----

describe("TrackedObject – onCommit @AutoId write-back reactivity gate", () => {
  it("onCommit writing @AutoId does not emit changed events on the object", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "widget";

    const seen: string[] = [];
    item.changed.subscribe((e) => seen.push(e.property));

    tracker.onCommit([{ trackingId: item.trakrId, value: 42 }]);

    expect(item.id).toBe(42);
    expect(seen).not.toContain("id");
  });

  it("onCommit writing @AutoId does not flicker isDirty back to true", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "widget";

    const dirtyLog: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => dirtyLog.push(v));

    tracker.onCommit([{ trackingId: item.trakrId, value: 42 }]);

    expect(tracker.isDirty).toBe(false);
    // last observed value must be false — never a spurious true after commit
    expect(dirtyLog[dirtyLog.length - 1]).toBe(false);
  });
});

// ---- getByTrackingId ----

describe("Tracker – getByTrackingId", () => {
  it("returns the tracked object matching the given trackingId", () => {
    const tracker = new DirtyTracker();
    const a = tracker.construct(() => new ItemModel(tracker));
    const b = tracker.construct(() => new ItemModel(tracker));

    expect(tracker.getByTrackingId(a.trakrId)).toBe(a);
    expect(tracker.getByTrackingId(b.trakrId)).toBe(b);
  });

  it("returns undefined for an unknown trackingId", () => {
    const tracker = new DirtyTracker();
    tracker.construct(() => new ItemModel(tracker));

    expect(tracker.getByTrackingId(999)).toBeUndefined();
  });

  it("still finds Deleted items", () => {
    const tracker = new DirtyTracker();
    const item = loadedItem(tracker, 7);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    expect(tracker.getByTrackingId(item.trakrId)).toBe(item);
    expect(item.trakrState).toBe(State.Deleted);
  });
});

// ---- IdAssignment<V> — non-number PK types ----

class StringPkModel extends TrackedObject {
  @AutoId
  id: string = "";

  @Tracked()
  accessor name: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

describe("IdAssignment<V> – string-typed @AutoId", () => {
  it("onCommit writes a string value to a string-typed @AutoId", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<StringPkModel>(tracker);
    const item = tracker.construct(() => new StringPkModel(tracker));
    items.push(item);
    item.name = "widget";

    tracker.onCommit<string>([
      { trackingId: item.trakrId, value: "01HXYZ-ULID" },
    ]);

    expect(item.id).toBe("01HXYZ-ULID");
    expect(item.trakrState).toBe(State.Unchanged);
    expect(tracker.isDirty).toBe(false);
  });
});

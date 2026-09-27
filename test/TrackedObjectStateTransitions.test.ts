/**
 * Commit lifecycle and save-layer correctness tests.
 *
 * Covers every reachable combination of user actions (add, remove, edit,
 * undo, redo, commit) and verifies both the resulting State and that
 * the save layer can determine the correct server operation and ID:
 *
 *   obj.state        → which operation (Insert/Changed/Deleted/Unchanged)
 *   obj.chronicleId   → client-assigned stable ID, used in the save payload for
 *                      Insert and Changed items so the backend can echo back
 *                      the new server-assigned PK
 *   obj.id           → real server ID (for Changed/Deleted items)
 *
 * Key invariants:
 *   Insert    → POST   sending chronicleId  (obj.id may hold a stale real server id)
 *   Changed   → PATCH  sending chronicleId + obj.id  (backend returns new PK for temporal tables)
 *   Deleted   → DELETE using obj.id        (always a real server id > 0)
 *   Unchanged → skip
 */

import { describe, it, expect } from "vitest";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { State } from "../packages/unit-of-work/src/State";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Tracked } from "../packages/core/src/Tracked";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { AutoId } from "../packages/core/src/ExternallyAssigned";

class ItemModel extends Entity {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor name: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

/** Creates an already-persisted item (state=Unchanged, id=realId). */
function loadedItem(tracker: UnitOfWork, realId: number): ItemModel {
  const item = tracker.construct(() => new ItemModel(tracker));
  tracker.withTrackingSuppressed(() => { item.id = realId; });
  return item;
}

// ---- Insert ----

describe("Entity state transitions — Insert", () => {
  it("new item added to collection: state=Insert, chronicleId assigned at construction", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    expect(item.chronicleState).toBe(State.Insert);
    expect(item.chronicleId).toBeGreaterThan(0);
  });

  it("Insert: save layer should use chronicleId for payload, @AutoId is untouched", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    expect(item.chronicleState).toBe(State.Insert);
    expect(item.id).toBe(0); // untouched by the library
    expect(item.chronicleId).toBeGreaterThan(0);
  });

  it("undo push → state=Unchanged, chronicleId unchanged → skip", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    const tid = item.chronicleId;
    items.push(item);
    tracker.undo();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.chronicleId).toBe(tid); // chronicleId is stable
  });

  it("undo push removes constructed item from _trackedObjects — no ghost", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker.undo();

    expect(tracker._trackedObjects).not.toContain(item);
  });

  it("undo push → redo push → state=Insert, same chronicleId → POST", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    const tid = item.chronicleId;
    items.push(item);

    tracker.undo();
    tracker.redo();

    expect(item.chronicleState).toBe(State.Insert);
    expect(item.chronicleId).toBe(tid); // stable across undo/redo
    expect(tracker._trackedObjects).toContain(item); // re-tracked on redo
  });

  it("chronicleId usable after undo+redo cycle for onCommit", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    tracker.undo();
    tracker.redo();

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 1 }]);
    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(1);
  });

  it("multiple undo/redo cycles remain coherent", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 1 }]);

    tracker.undo();
    expect(item.chronicleState).toBe(State.Deleted);
    tracker.redo();
    expect(item.chronicleState).toBe(State.Unchanged);
    tracker.undo();
    expect(item.chronicleState).toBe(State.Deleted);
    tracker.redo();
    expect(item.chronicleState).toBe(State.Unchanged);
  });

  it("push + name → commit → undo → undo exhausts the undo stack", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "Widget";

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 1 }]);

    tracker.undo();                              // the name: saved, now reverted → an update
    expect(item.chronicleState).toBe(State.Changed);

    tracker.undo();                              // the push: saved, now out of the model → a delete
    expect(item.chronicleState).toBe(State.Deleted);
    expect(tracker.canUndo).toBe(false);
  });

  it("onCommit does not add a spurious extra undo step", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 1 }]);

    tracker.undo();
    expect(tracker.canUndo).toBe(false);
    expect(item.chronicleState).toBe(State.Deleted);
  });
});

// ---- Committed Insert undone ----

describe("Entity state transitions — committed Insert undone", () => {
  it("push → commit(id=1) → state=Unchanged", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker._onCommit([{ chronicleId: item.chronicleId, value: 1 }]);

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(1);
  });

  it("push → commit(id=1) → undo: state=Deleted, id=1 → DELETE with id=1", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker._onCommit([{ chronicleId: item.chronicleId, value: 1 }]);
    tracker.undo();

    expect(item.chronicleState).toBe(State.Deleted);
    expect(item.id).toBe(1);
  });

  it("push → commit(id=1) → undo → redo: state=Unchanged", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker._onCommit([{ chronicleId: item.chronicleId, value: 1 }]);
    tracker.undo();
    tracker.redo();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(1);
  });
});

// ---- Changed ----

describe("Entity state transitions — Changed", () => {
  it("loaded item edited: state=Changed, id=real → PATCH with id", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";

    expect(item.chronicleState).toBe(State.Changed);
    expect(item.id).toBe(10);
  });

  it("edit → undo → state=Unchanged → skip", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker.undo();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("edit → undo → redo → state=Changed, id=10 → PATCH with id", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker.undo();
    tracker.redo();

    expect(item.chronicleState).toBe(State.Changed);
    expect(item.id).toBe(10);
  });

  it("undo before commit discards change; redo restores it and commit succeeds", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";

    tracker.undo();
    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.name).toBe("");

    tracker.redo();
    expect(item.chronicleState).toBe(State.Changed);
    expect(item.name).toBe("Widget");

    tracker._onCommit();
    expect(item.chronicleState).toBe(State.Unchanged);
  });

  it("edit → commit (non-temporal, no keys) → state=Unchanged, id unchanged", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker._onCommit();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("edit → commit (temporal: returns new PK) → @AutoId updated to new PK", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const tid = item.chronicleId;
    item.name = "Widget";

    tracker._onCommit([{ chronicleId: tid, value: 99 }]);

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(99); // new server PK after soft-delete + insert
  });

  it("edit → commit → undo → state=Changed, id=10, pre-edit values restored", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker._onCommit();
    tracker.undo();

    expect(item.chronicleState).toBe(State.Changed);
    expect(item.name).toBe("");
    expect(item.id).toBe(10);
  });

  it("edit → commit → undo → redo → state=Unchanged", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    item.name = "Widget";
    tracker._onCommit();
    tracker.undo();
    tracker.redo();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.name).toBe("Widget");
    expect(item.id).toBe(10);
  });
});

// ---- Deleted ----

describe("Entity state transitions — Deleted", () => {
  it("loaded item removed: state=Deleted, id=real → DELETE with id", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    expect(item.chronicleState).toBe(State.Deleted);
    expect(item.id).toBe(10);
  });

  it("remove → undo → state=Unchanged → skip", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("remove → undo → redo → state=Deleted, id=10 → DELETE with id", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();
    tracker.redo();

    expect(item.chronicleState).toBe(State.Deleted);
    expect(item.id).toBe(10);
  });

  it("undo before commit clears Deleted; redo restores it and commit succeeds", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    tracker.undo();
    expect(item.chronicleState).toBe(State.Unchanged);

    tracker.redo();
    expect(item.chronicleState).toBe(State.Deleted);

    tracker._onCommit();
    expect(item.chronicleState).toBe(State.Unchanged);
  });

  it("remove → commit → state=Unchanged", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker._onCommit();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });

  it("remove → commit → undo: state=Insert, id=10 stale — save layer must POST using chronicleId, NOT the stale id", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker._onCommit();
    tracker.undo();

    expect(item.chronicleState).toBe(State.Insert);
    expect(item.chronicleId).toBeGreaterThan(0);
    expect(item.id).toBe(10); // stale — do NOT use for INSERT
  });

  it("committed delete → undo (Insert) → commit again re-inserts the item", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker._onCommit();
    expect(item.chronicleState).toBe(State.Unchanged);

    tracker.undo();
    expect(item.chronicleState).toBe(State.Insert);

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 99 }]);
    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(99);
  });

  it("remove → commit → undo → redo → state=Unchanged", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 10);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker._onCommit();
    tracker.undo();
    tracker.redo();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(item.id).toBe(10);
  });
});

// ---- Insert collapsed by remove ----

describe("Entity state transitions — Insert collapsed by remove", () => {
  it("push → remove → state=Unchanged → skip (item was never persisted)", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    items.remove(item);

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(tracker._trackedObjects).not.toContain(item);
  });

  it("push → remove → undo → item is re-tracked and back in the collection as Insert", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    items.remove(item);
    tracker.undo();

    expect(item.chronicleState).toBe(State.Insert);
    expect(tracker._trackedObjects).toContain(item);
    expect(items.collection).toContain(item);
  });

  it("push → remove → undo → redo → item is untracked again", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    items.remove(item);
    tracker.undo();
    tracker.redo();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(tracker._trackedObjects).not.toContain(item);
    expect(items.collection).not.toContain(item);
  });
});

// ---- @AutoId / chronicleId ----

describe("Entity state transitions — @AutoId / chronicleId", () => {
  it("every object gets a unique chronicleId at construction", () => {
    const tracker = new UnitOfWork();
    const i1 = tracker.construct(() => new ItemModel(tracker));
    const i2 = tracker.construct(() => new ItemModel(tracker));

    expect(i1.chronicleId).not.toBe(i2.chronicleId);
  });

  it("chronicleId is positive and assigned regardless of state", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));

    expect(item.chronicleId).toBeGreaterThan(0);
    expect(item.chronicleState).toBe(State.Unchanged); // not yet pushed
  });

  it("onCommit marks tracker as not dirty", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "Widget";
    tracker._onCommit([]);

    expect(tracker.isDirty).toBe(false);
  });

  it("leaves @AutoId unchanged when chronicleId not found in keys", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    tracker._onCommit([{ chronicleId: 9999, value: 101 }]);

    expect(item.id).toBe(0); // not matched → unchanged
    expect(item.chronicleState).toBe(State.Unchanged); // still committed
  });

  it("chronicleId is globally unique across save cycles", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const i1 = tracker.construct(() => new ItemModel(tracker));
    items.push(i1);
    const tid1 = i1.chronicleId;
    tracker._onCommit([{ chronicleId: tid1, value: 1 }]);

    const i2 = tracker.construct(() => new ItemModel(tracker));
    items.push(i2);

    expect(i2.chronicleId).toBeGreaterThan(0);
    expect(i2.chronicleId).not.toBe(tid1);
  });

  it("@AutoId field is never written with a non-server value by the library", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));

    items.push(item);
    expect(item.id).toBe(0);

    tracker.undo();
    expect(item.id).toBe(0);

    tracker.redo();
    expect(item.id).toBe(0);

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 42 }]);
    expect(item.id).toBe(42); // only now does the library write to @AutoId

    tracker.undo();
    expect(item.id).toBe(42); // real id kept — never zeroed out
  });
});

// ---- Save operation routing ----

describe("Entity state transitions — save operation routing", () => {
  /**
   * Mirrors the save loop a frontend would run over tracker._trackedObjects.
   * For temporal tables, Changed items also produce a new server PK.
   */
  function whatToSave(item: ItemModel): { op: string; idToUse: number } {
    switch (item.chronicleState) {
      case State.Insert:   return { op: "POST",   idToUse: item.chronicleId };
      case State.Changed:  return { op: "PATCH",  idToUse: item.id };
      case State.Deleted:  return { op: "DELETE", idToUse: item.id };
      default:             return { op: "skip",   idToUse: 0 };
    }
  }

  it("new item → POST using chronicleId", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("POST");
    expect(idToUse).toBe(item.chronicleId);
  });

  it("loaded + edited → PATCH using real id", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 5);
    item.name = "Updated";

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("PATCH");
    expect(idToUse).toBe(5);
  });

  it("loaded + removed → DELETE using real id", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 5);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("DELETE");
    expect(idToUse).toBe(5);
  });

  it("committed delete → undo → POST using chronicleId (NOT stale real id)", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 99);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);
    tracker._onCommit();
    tracker.undo();

    const { op, idToUse } = whatToSave(item);
    expect(op).toBe("POST");
    expect(idToUse).toBe(item.chronicleId);
    expect(idToUse).not.toBe(99); // never the stale real id
  });

  it("loaded item → skip (no operation needed)", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 5);

    const { op } = whatToSave(item);
    expect(op).toBe("skip");
  });
});

// ---- Reactivity gate on onCommit write-back ----

describe("Entity – onCommit @AutoId write-back reactivity gate", () => {
  it("onCommit writing @AutoId does not emit changed events on the object", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "widget";

    const seen: string[] = [];
    item.changed.subscribe((e) => seen.push(e.property));

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 42 }]);

    expect(item.id).toBe(42);
    expect(seen).not.toContain("id");
  });

  it("onCommit writing @AutoId does not flicker isDirty back to true", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.construct(() => new ItemModel(tracker));
    items.push(item);
    item.name = "widget";

    const dirtyLog: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => dirtyLog.push(v));

    tracker._onCommit([{ chronicleId: item.chronicleId, value: 42 }]);

    expect(tracker.isDirty).toBe(false);
    // last observed value must be false — never a spurious true after commit
    expect(dirtyLog[dirtyLog.length - 1]).toBe(false);
  });
});

// ---- _getByChronicleId ----

describe("Tracker – _getByChronicleId", () => {
  it("returns the tracked object matching the given chronicleId", () => {
    const tracker = new UnitOfWork();
    const a = tracker.construct(() => new ItemModel(tracker));
    const b = tracker.construct(() => new ItemModel(tracker));

    expect(tracker._getByChronicleId(a.chronicleId)).toBe(a);
    expect(tracker._getByChronicleId(b.chronicleId)).toBe(b);
  });

  it("returns undefined for an unknown chronicleId", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => new ItemModel(tracker));

    expect(tracker._getByChronicleId(999)).toBeUndefined();
  });

  it("still finds Deleted items", () => {
    const tracker = new UnitOfWork();
    const item = loadedItem(tracker, 7);
    const coll = new TrackedCollection<ItemModel>(tracker, [item]);
    coll.remove(item);

    expect(tracker._getByChronicleId(item.chronicleId)).toBe(item);
    expect(item.chronicleState).toBe(State.Deleted);
  });
});

// ---- IdAssignment<V> — non-number PK types ----

class StringPkModel extends Entity {
  @AutoId
  id: string = "";

  @Tracked()
  accessor name: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

describe("IdAssignment<V> – string-typed @AutoId", () => {
  it("onCommit writes a string value to a string-typed @AutoId", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<StringPkModel>(tracker);
    const item = tracker.construct(() => new StringPkModel(tracker));
    items.push(item);
    item.name = "widget";

    tracker._onCommit<string>([
      { chronicleId: item.chronicleId, value: "01HXYZ-ULID" },
    ]);

    expect(item.id).toBe("01HXYZ-ULID");
    expect(item.chronicleState).toBe(State.Unchanged);
    expect(tracker.isDirty).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { EventLog } from "../packages/event-log/src/EventLog";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { Tracked } from "../packages/core/src/Tracked";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { State } from "../packages/unit-of-work/src/State";
import { AutoId } from "../packages/core/src/ExternallyAssigned";

import { emitted, pendingIds } from "./eventHelpers";
import { Entity } from "../packages/unit-of-work/src/Entity";
// ---- Models ----

class ItemModel extends Entity {
  @Tracked()
  accessor name: string = "";

  @Tracked()
  accessor value: number = 0;

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

class EventItemModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked()
  accessor name: string = "";

  @EventTracked()
  accessor value: number = 0;

  constructor(tracker: EventLog) {
    super(tracker);
  }
}

// ---- Changed-state revert ----

describe("discardPendingChanges — Changed-state objects revert to last commit", () => {
  it("reverts a single property to its committed value", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));
    item.name = "committed";
    tracker._onCommit();

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(item.name).toBe("committed");
  });

  it("reverts multiple properties on multiple objects", () => {
    const tracker = new UnitOfWork();
    const a = tracker.construct(() => new ItemModel(tracker));
    const b = tracker.construct(() => new ItemModel(tracker));
    a.name = "A-committed";
    b.name = "B-committed";
    tracker._onCommit();

    a.name = "A-pending";
    b.name = "B-pending";
    tracker.discardPendingChanges();

    expect(a.name).toBe("A-committed");
    expect(b.name).toBe("B-committed");
  });

  it("leaves all objects in Unchanged state", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));
    item.name = "committed";
    tracker._onCommit();

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(item.chronicleState).toBe(State.Unchanged);
  });

  it("reverts changes made without a prior commit (falls back to construction defaults)", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "pending";
    item.value = 42;
    tracker.discardPendingChanges();

    expect(item.name).toBe("");
    expect(item.value).toBe(0);
    expect(item.chronicleState).toBe(State.Unchanged);
  });

  it("reverts a committed Deleted object back to Unchanged", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));
    const col = new TrackedCollection<ItemModel>(tracker, [item]);
    tracker._onCommit();

    col.remove(item);
    expect(item.chronicleState).toBe(State.Deleted);

    tracker.discardPendingChanges();

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(tracker._trackedObjects).toContain(item);
  });
});

// ---- Insert-state removal ----

describe("discardPendingChanges — Insert-state objects are removed from _trackedObjects", () => {
  it("removes an object that was pushed to a collection after the last commit", () => {
    const tracker = new UnitOfWork();
    const col = new TrackedCollection<ItemModel>(tracker);
    tracker._onCommit();

    const newItem = tracker.new(() => new ItemModel(tracker));
    col.push(newItem);
    expect(newItem.chronicleState).toBe(State.Insert);

    tracker.discardPendingChanges();

    expect(tracker._trackedObjects).not.toContain(newItem);
  });

  it("removes multiple Insert-state objects", () => {
    const tracker = new UnitOfWork();
    const col = new TrackedCollection<ItemModel>(tracker);
    tracker._onCommit();

    const a = tracker.new(() => new ItemModel(tracker));
    const b = tracker.new(() => new ItemModel(tracker));
    col.push(a);
    col.push(b);

    tracker.discardPendingChanges();

    expect(tracker._trackedObjects).not.toContain(a);
    expect(tracker._trackedObjects).not.toContain(b);
  });

  it("removes an Insert-state object when no commit has happened yet", () => {
    const tracker = new UnitOfWork();
    const col = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.new(() => new ItemModel(tracker));
    col.push(item);
    expect(item.chronicleState).toBe(State.Insert);

    tracker.discardPendingChanges();

    expect(tracker._trackedObjects).not.toContain(item);
  });

  it("keeps committed (Unchanged) objects in _trackedObjects", () => {
    const tracker = new UnitOfWork();
    const committed = tracker.construct(() => new ItemModel(tracker));
    const col = new TrackedCollection<ItemModel>(tracker, [committed]);
    tracker._onCommit();

    const newItem = tracker.new(() => new ItemModel(tracker));
    col.push(newItem);

    tracker.discardPendingChanges();

    expect(tracker._trackedObjects).toContain(committed);
  });
});

// ---- isDirty ----

describe("discardPendingChanges — isDirty is false after the call", () => {
  it("isDirty becomes false after discarding pending property changes", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker._onCommit();

    item.name = "dirty";
    expect(tracker.isDirty).toBe(true);

    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
  });

  it("isDirty is false after discarding without a prior commit", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
  });

  it("isDirty is false when called on an already-clean tracker", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => new ItemModel(tracker));
    tracker._onCommit();

    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
  });
});

// ---- isDirtyChanged event ----

describe("discardPendingChanges — isDirtyChanged fires with false", () => {
  it("fires isDirtyChanged with false when the tracker was dirty", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker._onCommit();
    item.name = "pending";

    const fired: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => fired.push(v));

    tracker.discardPendingChanges();

    expect(fired).toEqual([false]);
  });

  it("does not fire isDirtyChanged when tracker was already clean", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => new ItemModel(tracker));
    tracker._onCommit();

    const fired: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => fired.push(v));

    tracker.discardPendingChanges();

    expect(fired).toEqual([]);
  });

  it("a beforeunload-style subscriber sees isDirty as false synchronously after the call", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker._onCommit();
    item.name = "pending";

    let seenDirty: boolean | undefined;
    tracker.isDirtyChanged.subscribe(() => {
      seenDirty = tracker.isDirty;
    });

    tracker.discardPendingChanges();

    expect(seenDirty).toBe(false);
  });
});

// ---- Undo/redo history ----

describe("discardPendingChanges — undo/redo history is cleared", () => {
  it("canUndo is false after discarding", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker._onCommit();

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(tracker.canUndo).toBe(false);
  });

  it("canRedo is false after discarding", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "a";
    tracker.undo();
    expect(tracker.canRedo).toBe(true);

    tracker.discardPendingChanges();

    expect(tracker.canRedo).toBe(false);
  });

  it("pre-commit undo history is also cleared", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "v1";
    item.name = "v2";
    tracker._onCommit();
    expect(tracker.canUndo).toBe(true);

    tracker.discardPendingChanges();

    expect(tracker.canUndo).toBe(false);
  });
});

// ---- No interaction with onCommit semantics ----

describe("discardPendingChanges — does not assign server IDs", () => {
  it("does not modify the @AutoId field on any object", () => {
    const tracker = new EventLog();
    const item = tracker.new(() => new EventItemModel(tracker));
    const col = new EventTrackedCollection<EventItemModel>(tracker, "items");
    col.push(item);

    tracker.discardPendingChanges();

    // id must remain 0 — no server ID was assigned
    expect(item.id).toBe(0);
  });
});

// ---- EventLog specifics ----

describe("EventLog.discardPendingChanges — event state is cleared", () => {
  it("generateEvents() returns [] after discarding pending changes", () => {
    const tracker = new EventLog();
    const item = tracker.construct(() => new EventItemModel(tracker));
    item.name = "committed";
    tracker._onCommit(pendingIds(tracker));

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(emitted(tracker)).toEqual([]);
  });

  it("generateEvents() returns [] after discarding an Insert-state object", () => {
    const tracker = new EventLog();
    const col = new EventTrackedCollection<EventItemModel>(tracker, "items");
    tracker._onCommit(pendingIds(tracker));

    const newItem = tracker.new(() => new EventItemModel(tracker));
    col.push(newItem);

    tracker.discardPendingChanges();

    expect(emitted(tracker)).toEqual([]);
  });

  it("isDirty is false and isDirtyChanged fires on EventLog too", () => {
    const tracker = new EventLog();
    const item = tracker.construct(() => new EventItemModel(tracker));
    tracker._onCommit(pendingIds(tracker));
    item.name = "pending";

    const fired: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => fired.push(v));

    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
    expect(fired).toEqual([false]);
  });
});

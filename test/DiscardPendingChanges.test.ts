import { describe, it, expect } from "vitest";
import { Tracker } from "../src/Tracker";
import { EventTracker } from "../src/EventTracker";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { EventTrackedCollection } from "../src/EventTrackedCollection";
import { Tracked } from "../src/Tracked";
import { EventTracked } from "../src/EventTracked";
import { State } from "../src/State";
import { AutoId } from "../src/ExternallyAssigned";

// ---- Models ----

class ItemModel extends TrackedObject {
  @Tracked()
  accessor name: string = "";

  @Tracked()
  accessor value: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class EventItemModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked(undefined, undefined, { eventType: "ItemChanged" })
  accessor name: string = "";

  @EventTracked(undefined, undefined, { eventType: "ItemChanged" })
  accessor value: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// ---- Changed-state revert ----

describe("discardPendingChanges — Changed-state objects revert to last commit", () => {
  it("reverts a single property to its committed value", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));
    item.name = "committed";
    tracker.onCommit();

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(item.name).toBe("committed");
  });

  it("reverts multiple properties on multiple objects", () => {
    const tracker = new Tracker();
    const a = tracker.construct(() => new ItemModel(tracker));
    const b = tracker.construct(() => new ItemModel(tracker));
    a.name = "A-committed";
    b.name = "B-committed";
    tracker.onCommit();

    a.name = "A-pending";
    b.name = "B-pending";
    tracker.discardPendingChanges();

    expect(a.name).toBe("A-committed");
    expect(b.name).toBe("B-committed");
  });

  it("leaves all objects in Unchanged state", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));
    item.name = "committed";
    tracker.onCommit();

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(item.trakrState).toBe(State.Unchanged);
  });

  it("reverts changes made without a prior commit (falls back to construction defaults)", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "pending";
    item.value = 42;
    tracker.discardPendingChanges();

    expect(item.name).toBe("");
    expect(item.value).toBe(0);
    expect(item.trakrState).toBe(State.Unchanged);
  });

  it("reverts a committed Deleted object back to Unchanged", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));
    const col = new TrackedCollection<ItemModel>(tracker, [item]);
    tracker.onCommit();

    col.remove(item);
    expect(item.trakrState).toBe(State.Deleted);

    tracker.discardPendingChanges();

    expect(item.trakrState).toBe(State.Unchanged);
    expect(tracker.trackedObjects).toContain(item);
  });
});

// ---- Insert-state removal ----

describe("discardPendingChanges — Insert-state objects are removed from trackedObjects", () => {
  it("removes an object that was pushed to a collection after the last commit", () => {
    const tracker = new Tracker();
    const col = new TrackedCollection<ItemModel>(tracker);
    tracker.onCommit();

    const newItem = tracker.new(() => new ItemModel(tracker));
    col.push(newItem);
    expect(newItem.trakrState).toBe(State.Insert);

    tracker.discardPendingChanges();

    expect(tracker.trackedObjects).not.toContain(newItem);
  });

  it("removes multiple Insert-state objects", () => {
    const tracker = new Tracker();
    const col = new TrackedCollection<ItemModel>(tracker);
    tracker.onCommit();

    const a = tracker.new(() => new ItemModel(tracker));
    const b = tracker.new(() => new ItemModel(tracker));
    col.push(a);
    col.push(b);

    tracker.discardPendingChanges();

    expect(tracker.trackedObjects).not.toContain(a);
    expect(tracker.trackedObjects).not.toContain(b);
  });

  it("removes an Insert-state object when no commit has happened yet", () => {
    const tracker = new Tracker();
    const col = new TrackedCollection<ItemModel>(tracker);
    const item = tracker.new(() => new ItemModel(tracker));
    col.push(item);
    expect(item.trakrState).toBe(State.Insert);

    tracker.discardPendingChanges();

    expect(tracker.trackedObjects).not.toContain(item);
  });

  it("keeps committed (Unchanged) objects in trackedObjects", () => {
    const tracker = new Tracker();
    const committed = tracker.construct(() => new ItemModel(tracker));
    const col = new TrackedCollection<ItemModel>(tracker, [committed]);
    tracker.onCommit();

    const newItem = tracker.new(() => new ItemModel(tracker));
    col.push(newItem);

    tracker.discardPendingChanges();

    expect(tracker.trackedObjects).toContain(committed);
  });
});

// ---- isDirty ----

describe("discardPendingChanges — isDirty is false after the call", () => {
  it("isDirty becomes false after discarding pending property changes", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker.onCommit();

    item.name = "dirty";
    expect(tracker.isDirty).toBe(true);

    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
  });

  it("isDirty is false after discarding without a prior commit", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
  });

  it("isDirty is false when called on an already-clean tracker", () => {
    const tracker = new Tracker();
    tracker.construct(() => new ItemModel(tracker));
    tracker.onCommit();

    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
  });
});

// ---- isDirtyChanged event ----

describe("discardPendingChanges — isDirtyChanged fires with false", () => {
  it("fires isDirtyChanged with false when the tracker was dirty", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker.onCommit();
    item.name = "pending";

    const fired: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => fired.push(v));

    tracker.discardPendingChanges();

    expect(fired).toEqual([false]);
  });

  it("does not fire isDirtyChanged when tracker was already clean", () => {
    const tracker = new Tracker();
    tracker.construct(() => new ItemModel(tracker));
    tracker.onCommit();

    const fired: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => fired.push(v));

    tracker.discardPendingChanges();

    expect(fired).toEqual([]);
  });

  it("a beforeunload-style subscriber sees isDirty as false synchronously after the call", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker.onCommit();
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
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));
    tracker.onCommit();

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(tracker.canUndo).toBe(false);
  });

  it("canRedo is false after discarding", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "a";
    tracker.undo();
    expect(tracker.canRedo).toBe(true);

    tracker.discardPendingChanges();

    expect(tracker.canRedo).toBe(false);
  });

  it("pre-commit undo history is also cleared", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ItemModel(tracker));

    item.name = "v1";
    item.name = "v2";
    tracker.onCommit();
    expect(tracker.canUndo).toBe(true);

    tracker.discardPendingChanges();

    expect(tracker.canUndo).toBe(false);
  });
});

// ---- No interaction with onCommit semantics ----

describe("discardPendingChanges — does not assign server IDs", () => {
  it("does not modify the @AutoId field on any object", () => {
    const tracker = new EventTracker();
    const item = tracker.new(() => new EventItemModel(tracker));
    const col = new EventTrackedCollection<EventItemModel>(tracker);
    col.push(item);

    tracker.discardPendingChanges();

    // id must remain 0 — no server ID was assigned
    expect(item.id).toBe(0);
  });
});

// ---- EventTracker specifics ----

describe("EventTracker.discardPendingChanges — event state is cleared", () => {
  it("generateEvents() returns [] after discarding pending changes", () => {
    const tracker = new EventTracker();
    const item = tracker.construct(() => new EventItemModel(tracker));
    item.name = "committed";
    tracker.onCommit();

    item.name = "pending";
    tracker.discardPendingChanges();

    expect(tracker.generateEvents()).toEqual([]);
  });

  it("generateEvents() returns [] after discarding an Insert-state object", () => {
    const tracker = new EventTracker();
    const col = new EventTrackedCollection<EventItemModel>(tracker);
    tracker.onCommit();

    const newItem = tracker.new(() => new EventItemModel(tracker));
    col.push(newItem);

    tracker.discardPendingChanges();

    expect(tracker.generateEvents()).toEqual([]);
  });

  it("isDirty is false and isDirtyChanged fires on EventTracker too", () => {
    const tracker = new EventTracker();
    const item = tracker.construct(() => new EventItemModel(tracker));
    tracker.onCommit();
    item.name = "pending";

    const fired: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => fired.push(v));

    tracker.discardPendingChanges();

    expect(tracker.isDirty).toBe(false);
    expect(fired).toEqual([false]);
  });
});

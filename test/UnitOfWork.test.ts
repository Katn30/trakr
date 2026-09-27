import { describe, it, expect } from "vitest";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Tracker } from "../packages/core/src/Tracker";
import { Tracked } from "../packages/core/src/Tracked";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { EntityContainer } from "../packages/unit-of-work/src/EntityContainer";
import { AutoId } from "../packages/core/src/ExternallyAssigned";
import { State } from "../packages/unit-of-work/src/State";
import { deletedObjects } from "./uowHelpers";

class Child extends Entity {
  @AutoId id: number = 0;
  @Tracked() accessor name: string = "";
  constructor(t: UnitOfWork) { super(t); }
}

class Parent extends EntityContainer {
  @Tracked() accessor phase: string = "a";
  readonly children: TrackedCollection<Child>;
  constructor(t: UnitOfWork) {
    super(t);
    this.children = new TrackedCollection<Child>(t, []);
    this.trackChild(this.children);
  }
}

function setup() {
  const tracker = new UnitOfWork();
  const parent = tracker.construct(() => new Parent(tracker));
  return { tracker, parent };
}

describe("UnitOfWork", () => {
  it("is a Tracker", () => {
    expect(new UnitOfWork()).toBeInstanceOf(Tracker);
  });

  it("commit_is_atomic: every Insert/Changed object becomes Unchanged in one call", () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    parent.children.push(child);
    parent.phase = "b";
    expect(child.chronicleState).toBe(State.Insert);
    expect(parent.chronicleState).toBe(State.Changed);
    expect(tracker.canCommit).toBe(true);

    tracker._onCommit([{ chronicleId: child.chronicleId, value: 5 }]);

    expect(child.chronicleState).toBe(State.Unchanged);
    expect(parent.chronicleState).toBe(State.Unchanged);
    expect(child.id).toBe(5);
    expect(tracker.isDirty).toBe(false);
    expect(tracker.canCommit).toBe(false);
  });

  it("undo_across_commit is preserved: the object is dirty again", () => {
    const { tracker, parent } = setup();
    parent.phase = "b";
    tracker._onCommit();

    expect(tracker.canUndo).toBe(true);
    tracker.undo();

    expect(parent.phase).toBe("a");
    expect(parent.chronicleState).toBe(State.Changed);
    expect(tracker.isDirty).toBe(true);
  });

  it("undoing a committed insert marks it Deleted so the next save removes it", () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    parent.children.push(child);
    tracker._onCommit();

    tracker.undo();

    expect(child.chronicleState).toBe(State.Deleted);
    expect(deletedObjects(tracker)).toContain(child);
  });

  it("undo after commit of an unrelated op leaves committed inserts alone", () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    parent.children.push(child);   // op A
    parent.phase = "b";            // op B — unrelated to child
    tracker._onCommit();

    tracker.undo();                // reverses B only

    expect(parent.phase).toBe("a");
    expect(parent.children.collection).toContain(child);
    expect(child.chronicleState).toBe(State.Unchanged);
    expect(deletedObjects(tracker)).not.toContain(child);
  });

  it("redo after undo across commit returns to the committed state", () => {
    const { tracker, parent } = setup();
    parent.phase = "b";
    tracker._onCommit();
    tracker.undo();
    tracker.redo();

    expect(parent.phase).toBe("b");
    expect(parent.chronicleState).toBe(State.Unchanged);
    expect(tracker.isDirty).toBe(false);
  });
});

describe("UnitOfWork — adding and removing with tracking suppressed (loading)", () => {
  it("an object placed silently is what the server has: removing it later deletes it", () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    tracker.withTrackingSuppressed(() => parent.children.push(child));
    expect(child.chronicleState).toBe(State.Unchanged);
    parent.children.remove(child);
    expect(child.chronicleState).toBe(State.Deleted);
  });

  it("an object removed silently is not on the server either: forgotten, and its validity no longer counts", () => {
    const { tracker, parent } = setup();
    const child = tracker.new(() => new Child(tracker));
    parent.children.push(child);
    expect(child.chronicleState).toBe(State.Insert);
    tracker.withTrackingSuppressed(() => parent.children.remove(child));
    expect(tracker._trackedObjects).not.toContain(child);
    expect(deletedObjects(tracker)).not.toContain(child);
    // Put back by the user: a new object again.
    parent.children.push(child);
    expect(child.chronicleState).toBe(State.Insert);
  });
});

describe("UnitOfWork — the saved state, reached by undo and redo", () => {
  it("adding and removing count as writes: undoing a saved addition and redoing it is back to saved", async () => {
    const { tracker, parent } = setup();
    const child = tracker.new(() => new Child(tracker));
    parent.children.push(child);
    await tracker.commit(() => [{ chronicleId: child.chronicleId, value: 7 }]);
    tracker.undo();
    expect([child.chronicleState, child.dirtyCounter]).toEqual([State.Deleted, -1]);
    tracker.redo();
    expect([child.chronicleState, child.dirtyCounter]).toEqual([State.Unchanged, 0]);
    expect(tracker.isDirty).toBe(false);
  });

  it("a deleted object that was saved is forgotten; undo brings it back as an Insert", async () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    tracker.withTrackingSuppressed(() => parent.children.push(child));
    parent.children.remove(child);
    await tracker.commit(() => undefined);
    expect(tracker._trackedObjects).not.toContain(child);
    tracker.undo();
    expect(tracker._trackedObjects).toContain(child);
    expect(child.chronicleState).toBe(State.Insert);
  });

  it("discard after undoing past the save redoes back to the saved state", async () => {
    const { tracker, parent } = setup();
    parent.phase = "b";
    parent.phase = "c";
    await tracker.commit(() => undefined);
    tracker.undo();
    tracker.undo();
    expect(parent.phase).toBe("a");
    tracker.discardPendingChanges();
    expect(parent.phase).toBe("c");
    expect(parent.chronicleState).toBe(State.Unchanged);
    expect([tracker.isDirty, tracker.canUndo, tracker.canRedo]).toEqual([false, false, false]);
  });

  it("discard when the saved state is out of reach: reverts what it can, and stays dirty", async () => {
    const { tracker, parent } = setup();
    parent.phase = "b";
    await tracker.commit(() => undefined);
    tracker.undo();
    const child = tracker.new(() => new Child(tracker));
    // A new step drops the saved one from the redo history: the saved state is out of reach.
    parent.children.push(child);
    expect(parent.chronicleState).toBe(State.Changed);
    tracker.discardPendingChanges();
    expect(parent.children.length).toBe(0);
    expect(parent.phase).toBe("a");
    // Still dirty: the server has "b", the next commit saves "a".
    expect(tracker.isDirty).toBe(true);
    expect(parent.chronicleState).toBe(State.Changed);
    const saved: string[] = [];
    await tracker.commit((batch) => { saved.push(...batch.changed.map((o) => (o as Parent).phase)); });
    expect(saved).toEqual(["a"]);
    expect(tracker.isDirty).toBe(false);
  });
});

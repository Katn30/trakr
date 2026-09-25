import { describe, it, expect } from "vitest";
import { DirtyTracker } from "../src/DirtyTracker";
import { Tracker } from "../src/Tracker";
import { Tracked } from "../src/Tracked";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { TrackedContainer } from "../src/TrackedContainer";
import { AutoId } from "../src/ExternallyAssigned";
import { State } from "../src/State";

class Child extends TrackedObject {
  @AutoId id: number = 0;
  @Tracked() accessor name: string = "";
  constructor(t: Tracker) { super(t); }
}

class Parent extends TrackedContainer {
  @Tracked() accessor phase: string = "a";
  readonly children: TrackedCollection<Child>;
  constructor(t: Tracker) {
    super(t);
    this.children = new TrackedCollection<Child>(t, []);
    this.trackChild(this.children);
  }
}

function setup() {
  const tracker = new DirtyTracker();
  const parent = tracker.construct(() => new Parent(tracker));
  return { tracker, parent };
}

describe("DirtyTracker", () => {
  it("is a Tracker", () => {
    expect(new DirtyTracker()).toBeInstanceOf(Tracker);
  });

  it("commit_is_atomic: every Insert/Changed object becomes Unchanged in one call", () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    parent.children.push(child);
    parent.phase = "b";
    expect(child.trakrState).toBe(State.Insert);
    expect(parent.trakrState).toBe(State.Changed);
    expect(tracker.canCommit).toBe(true);

    tracker.onCommit([{ trackingId: child.trakrId, value: 5 }]);

    expect(child.trakrState).toBe(State.Unchanged);
    expect(parent.trakrState).toBe(State.Unchanged);
    expect(child.id).toBe(5);
    expect(tracker.isDirty).toBe(false);
    expect(tracker.canCommit).toBe(false);
  });

  it("undo_across_commit is preserved: the object is dirty again", () => {
    const { tracker, parent } = setup();
    parent.phase = "b";
    tracker.onCommit();

    expect(tracker.canUndo).toBe(true);
    tracker.undo();

    expect(parent.phase).toBe("a");
    expect(parent.trakrState).toBe(State.Changed);
    expect(tracker.isDirty).toBe(true);
  });

  it("undoing a committed insert marks it Deleted so the next save removes it", () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    parent.children.push(child);
    tracker.onCommit();

    tracker.undo();

    expect(child.trakrState).toBe(State.Deleted);
    expect(tracker.deletedObjects).toContain(child);
  });

  it("undo after commit of an unrelated op leaves committed inserts alone", () => {
    const { tracker, parent } = setup();
    const child = tracker.construct(() => new Child(tracker));
    parent.children.push(child);   // op A
    parent.phase = "b";            // op B — unrelated to child
    tracker.onCommit();

    tracker.undo();                // reverses B only

    expect(parent.phase).toBe("a");
    expect(parent.children.collection).toContain(child);
    expect(child.trakrState).toBe(State.Unchanged);
    expect(tracker.deletedObjects).not.toContain(child);
  });

  it("redo after undo across commit returns to the committed state", () => {
    const { tracker, parent } = setup();
    parent.phase = "b";
    tracker.onCommit();
    tracker.undo();
    tracker.redo();

    expect(parent.phase).toBe("b");
    expect(parent.trakrState).toBe(State.Unchanged);
    expect(tracker.isDirty).toBe(false);
  });
});

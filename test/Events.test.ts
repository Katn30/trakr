import { describe, it, expect } from "vitest";
import { TrackedObject } from "../src/TrackedObject";
import { Tracker } from "../src/Tracker";
import { DirtyTracker } from "../src/DirtyTracker";
import { Tracked } from "../src/Tracked";
import { TrackedCollection } from "../src/TrackedCollection";

// ---- Models ----

class SimpleModel extends TrackedObject {
  @Tracked() accessor value: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class SetterModel extends TrackedObject {
  private _value: string = "";

  get value(): string { return this._value; }
  @Tracked() set value(v: string) { this._value = v; }

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// ---- TrackedObject events ----

describe("TrackedObject.changed", () => {
  it("fires on initial write", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.changed.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "a";

    expect(events).toEqual(["a"]);
  });

  it("fires during undo with swapped old/new values", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const newValues: string[] = [];

    model.value = "a";
    model.changed.subscribe(({ newValue }) => newValues.push(newValue as string));
    tracker.undo();

    expect(newValues).toEqual([""]);
  });

  it("fires during redo", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const newValues: string[] = [];

    model.value = "a";
    tracker.undo();
    model.changed.subscribe(({ newValue }) => newValues.push(newValue as string));
    tracker.redo();

    expect(newValues).toEqual(["a"]);
  });

  it("includes property name, oldValue, and newValue", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: { property: string; oldValue: unknown; newValue: unknown }[] = [];

    model.changed.subscribe((e) => events.push(e));
    model.value = "hello";

    expect(events[0]).toEqual({ property: "value", oldValue: "", newValue: "hello" });
  });

  it("works on setter-decorated properties too", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SetterModel(tracker));
    const events: string[] = [];

    model.changed.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "x";

    expect(events).toEqual(["x"]);
  });
});

describe("TrackedObject.trackedChanged", () => {
  it("fires on initial write", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.trackedChanged.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "a";

    expect(events).toEqual(["a"]);
  });

  it("does NOT fire during undo", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.value = "a";
    model.trackedChanged.subscribe(({ newValue }) => events.push(newValue as string));
    tracker.undo();

    expect(events).toEqual([]);
  });

  it("does NOT fire during redo", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.value = "a";
    tracker.undo();
    model.trackedChanged.subscribe(({ newValue }) => events.push(newValue as string));
    tracker.redo();

    expect(events).toEqual([]);
  });

  it("works on setter-decorated properties too", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new SetterModel(tracker));
    const events: string[] = [];

    model.trackedChanged.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "x";
    tracker.undo();
    tracker.redo();

    expect(events).toEqual(["x"]); // only the initial write
  });
});

// ---- TrackedCollection events ----

describe("TrackedCollection.changed", () => {
  it("fires on initial push", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<string>(tracker);
    const added: string[][] = [];

    items.changed.subscribe((e) => added.push(e.added));
    items.push("a");

    expect(added).toEqual([["a"]]);
  });

  it("fires during undo with swapped added/removed", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<string>(tracker);
    const removedLog: string[][] = [];

    items.push("a");
    items.changed.subscribe((e) => removedLog.push(e.removed));
    tracker.undo();

    expect(removedLog).toEqual([["a"]]);
  });

  it("fires during redo", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<string>(tracker);
    const addedLog: string[][] = [];

    items.push("a");
    tracker.undo();
    items.changed.subscribe((e) => addedLog.push(e.added));
    tracker.redo();

    expect(addedLog).toEqual([["a"]]);
  });
});

describe("TrackedCollection.trackedChanged", () => {
  it("fires on initial push", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<string>(tracker);
    const added: string[][] = [];

    items.trackedChanged.subscribe((e) => added.push(e.added));
    items.push("a");

    expect(added).toEqual([["a"]]);
  });

  it("does NOT fire during undo", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<string>(tracker);
    const events: unknown[] = [];

    items.push("a");
    items.trackedChanged.subscribe((e) => events.push(e));
    tracker.undo();

    expect(events).toEqual([]);
  });

  it("does NOT fire during redo", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<string>(tracker);
    const events: unknown[] = [];

    items.push("a");
    tracker.undo();
    items.trackedChanged.subscribe((e) => events.push(e));
    tracker.redo();

    expect(events).toEqual([]);
  });

  it("fires once per mutation, not once per item", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<string>(tracker);
    let fireCount = 0;

    items.trackedChanged.subscribe(() => fireCount++);
    items.push("a", "b", "c");

    expect(fireCount).toBe(1);
  });
});

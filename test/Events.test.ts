import { describe, it, expect } from "vitest";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Tracked } from "../packages/core/src/Tracked";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";

// ---- Models ----

class SimpleModel extends Entity {
  @Tracked() accessor value: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

class SetterModel extends Entity {
  private _value: string = "";

  get value(): string { return this._value; }
  @Tracked() set value(v: string) { this._value = v; }

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

// ---- Entity events ----

describe("Entity.changed", () => {
  it("fires on initial write", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.changed.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "a";

    expect(events).toEqual(["a"]);
  });

  it("fires during undo with swapped old/new values", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const newValues: string[] = [];

    model.value = "a";
    model.changed.subscribe(({ newValue }) => newValues.push(newValue as string));
    tracker.undo();

    expect(newValues).toEqual([""]);
  });

  it("fires during redo", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const newValues: string[] = [];

    model.value = "a";
    tracker.undo();
    model.changed.subscribe(({ newValue }) => newValues.push(newValue as string));
    tracker.redo();

    expect(newValues).toEqual(["a"]);
  });

  it("includes property name, oldValue, and newValue", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: { property: string; oldValue: unknown; newValue: unknown }[] = [];

    model.changed.subscribe((e) => events.push(e));
    model.value = "hello";

    expect(events[0]).toEqual({ property: "value", oldValue: "", newValue: "hello" });
  });

  it("works on setter-decorated properties too", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SetterModel(tracker));
    const events: string[] = [];

    model.changed.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "x";

    expect(events).toEqual(["x"]);
  });
});

describe("Entity.afterChange", () => {
  it("fires on initial write", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.afterChange.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "a";

    expect(events).toEqual(["a"]);
  });

  it("does NOT fire during undo", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.value = "a";
    model.afterChange.subscribe(({ newValue }) => events.push(newValue as string));
    tracker.undo();

    expect(events).toEqual([]);
  });

  it("does NOT fire during redo", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const events: string[] = [];

    model.value = "a";
    tracker.undo();
    model.afterChange.subscribe(({ newValue }) => events.push(newValue as string));
    tracker.redo();

    expect(events).toEqual([]);
  });

  it("works on setter-decorated properties too", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SetterModel(tracker));
    const events: string[] = [];

    model.afterChange.subscribe(({ newValue }) => events.push(newValue as string));
    model.value = "x";
    tracker.undo();
    tracker.redo();

    expect(events).toEqual(["x"]); // only the initial write
  });
});

// ---- TrackedCollection events ----

describe("TrackedCollection.changed", () => {
  it("fires on initial push", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<string>(tracker);
    const added: string[][] = [];

    items.changed.subscribe((e) => added.push(e.added));
    items.push("a");

    expect(added).toEqual([["a"]]);
  });

  it("fires during undo with swapped added/removed", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<string>(tracker);
    const removedLog: string[][] = [];

    items.push("a");
    items.changed.subscribe((e) => removedLog.push(e.removed));
    tracker.undo();

    expect(removedLog).toEqual([["a"]]);
  });

  it("fires during redo", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<string>(tracker);
    const addedLog: string[][] = [];

    items.push("a");
    tracker.undo();
    items.changed.subscribe((e) => addedLog.push(e.added));
    tracker.redo();

    expect(addedLog).toEqual([["a"]]);
  });
});

describe("TrackedCollection.afterChange", () => {
  it("fires on initial push", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<string>(tracker);
    const added: string[][] = [];

    items.afterChange.subscribe((e) => added.push(e.added));
    items.push("a");

    expect(added).toEqual([["a"]]);
  });

  it("does NOT fire during undo", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<string>(tracker);
    const events: unknown[] = [];

    items.push("a");
    items.afterChange.subscribe((e) => events.push(e));
    tracker.undo();

    expect(events).toEqual([]);
  });

  it("does NOT fire during redo", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<string>(tracker);
    const events: unknown[] = [];

    items.push("a");
    tracker.undo();
    items.afterChange.subscribe((e) => events.push(e));
    tracker.redo();

    expect(events).toEqual([]);
  });

  it("fires once per mutation, not once per item", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<string>(tracker);
    let fireCount = 0;

    items.afterChange.subscribe(() => fireCount++);
    items.push("a", "b", "c");

    expect(fireCount).toBe(1);
  });
});

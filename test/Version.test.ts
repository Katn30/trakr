import { describe, it, expect, beforeEach, vi } from "vitest";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { Tracked } from "../packages/core/src/Tracked";

class PersonModel extends Entity {
  @Tracked()
  accessor name: string = "";

  @Tracked()
  accessor age: number = 0;

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

class CoalescePersonModel extends Entity {
  @Tracked(undefined, undefined, { coalesceWithin: 10_000 })
  accessor name: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

describe("Tracker.version", () => {
  let tracker: UnitOfWork;
  let person: PersonModel;

  beforeEach(() => {
    tracker = new UnitOfWork();
    person = tracker.construct(() => new PersonModel(tracker));
  });

  it("starts at 0", () => {
    expect(tracker.version).toBe(0);
  });

  it("increments by 1 when a new operation is pushed", () => {
    person.name = "Alice";
    expect(tracker.version).toBe(1);
  });

  it("increments for each independent operation", () => {
    person.name = "Alice";
    person.age = 30;
    expect(tracker.version).toBe(2);
  });

  it("increments on every write even when auto-coalescing into the same undo operation", () => {
    const t = new UnitOfWork();
    const p = t.construct(() => new CoalescePersonModel(t));
    p.name = "Al";
    p.name = "Alice";
    expect(t.version).toBe(2);
  });

  it("decrements by 1 on undo()", () => {
    person.name = "Alice";
    tracker.undo();
    expect(tracker.version).toBe(0);
  });

  it("increments by 1 on redo()", () => {
    person.name = "Alice";
    tracker.undo();
    tracker.redo();
    expect(tracker.version).toBe(1);
  });

  it("tracks multiple undo/redo cycles correctly", () => {
    person.name = "Alice";
    person.age = 30;
    expect(tracker.version).toBe(2);

    tracker.undo();
    expect(tracker.version).toBe(1);

    tracker.undo();
    expect(tracker.version).toBe(0);

    tracker.redo();
    expect(tracker.version).toBe(1);

    tracker.redo();
    expect(tracker.version).toBe(2);
  });

  it("does not change when undo() is called with nothing to undo", () => {
    expect(tracker.version).toBe(0);
    tracker.undo();
    expect(tracker.version).toBe(0);
  });

  it("does not change when redo() is called with nothing to redo", () => {
    person.name = "Alice";
    expect(tracker.version).toBe(1);
    tracker.redo();
    expect(tracker.version).toBe(1);
  });

  it("version can go negative after more undos than the initial count", () => {
    person.name = "Alice";
    tracker.undo();
    expect(tracker.version).toBe(0);
    // canUndo is now false — further undo is a no-op
    tracker.undo();
    expect(tracker.version).toBe(0);
  });
});

describe("Tracker.changed", () => {
  let tracker: UnitOfWork;
  let person: PersonModel;

  beforeEach(() => {
    tracker = new UnitOfWork();
    person = tracker.construct(() => new PersonModel(tracker));
  });

  it("fires with the new version when a new operation is pushed", () => {
    const handler = vi.fn();
    tracker.changed.subscribe(handler);

    person.name = "Alice";

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ version: 1 });
  });

  it("fires with the new version on undo()", () => {
    person.name = "Alice";

    const handler = vi.fn();
    tracker.changed.subscribe(handler);

    tracker.undo();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ version: 0 });
  });

  it("fires with the new version on redo()", () => {
    person.name = "Alice";
    tracker.undo();

    const handler = vi.fn();
    tracker.changed.subscribe(handler);

    tracker.redo();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ version: 1 });
  });

  it("fires once the operation is recorded: isDirty and canCommit are already up to date", () => {
    const seen: boolean[] = [];
    tracker.changed.subscribe(() => seen.push(tracker.isDirty, tracker.canCommit));
    person.name = "Alice";
    expect(seen).toEqual([true, true]);
  });

  it("does not fire for the writes of a constructor run by tracker.new()", () => {
    const handler = vi.fn();
    tracker.changed.subscribe(handler);
    tracker.new(() => { const p = new PersonModel(tracker); p.name = "draft"; return p; });
    expect(handler).not.toHaveBeenCalled();
    expect(tracker.version).toBe(0);
  });

  it("does not fire when undo() is a no-op", () => {
    const handler = vi.fn();
    tracker.changed.subscribe(handler);

    tracker.undo();

    expect(handler).not.toHaveBeenCalled();
  });

  it("does not fire when redo() is a no-op", () => {
    person.name = "Alice";

    const handler = vi.fn();
    tracker.changed.subscribe(handler);

    tracker.redo();

    expect(handler).not.toHaveBeenCalled();
  });

  it("fires for every write including auto-coalesced ones — version increments each time", () => {
    const t = new UnitOfWork();
    const p = t.construct(() => new CoalescePersonModel(t));
    const received: number[] = [];
    t.changed.subscribe(({ version }) => received.push(version));

    p.name = "Al";    // new operation → version becomes 1
    p.name = "Alice"; // coalesced into same undo op → version becomes 2

    expect(received).toEqual([1, 2]);
  });

  it("fires on every write even when auto-coalesced — model value changed", () => {
    const t = new UnitOfWork();
    const p = t.construct(() => new CoalescePersonModel(t));
    const handler = vi.fn();
    t.changed.subscribe(handler);

    p.name = "Al";    // first write — new operation, changed fires
    p.name = "Alice"; // coalesced — model updated, changed must still fire

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("passes the correct value for each sequential operation", () => {
    const received: number[] = [];
    tracker.changed.subscribe(({ version }) => received.push(version));

    person.name = "Alice";
    person.age = 30;
    tracker.undo();
    tracker.redo();

    expect(received).toEqual([1, 2, 1, 2]);
  });
});

describe("Tracker.version with session.rollback()", () => {
  let tracker: UnitOfWork;
  let person: PersonModel;

  beforeEach(() => {
    tracker = new UnitOfWork();
    person = tracker.construct(() => new PersonModel(tracker));
  });

  it("decrements by the number of operations rolled back", () => {
    const session = tracker._startSession();
    person.name = "Alice";
    person.age = 30;
    session.rollback();

    expect(tracker.version).toBe(0);
  });

  it("fires changed once after rollback when operations were rolled back", () => {
    const session = tracker._startSession();
    person.name = "Alice";
    person.age = 30;

    const handler = vi.fn();
    tracker.changed.subscribe(handler);

    session.rollback();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ version: 0 });
  });

  it("does not fire changed when rollback has nothing to revert", () => {
    const session = tracker._startSession();

    const handler = vi.fn();
    tracker.changed.subscribe(handler);

    session.rollback();

    expect(handler).not.toHaveBeenCalled();
  });

  it("version is unaffected by session.end() — increments already happened per operation", () => {
    const session = tracker._startSession();
    person.name = "Alice";
    person.age = 30;
    session.end();

    // Two operations were pushed (+2), merging them into one doesn't adjust version
    expect(tracker.version).toBe(2);

    // But now only one undo step exists, so undo decrements by 1
    tracker.undo();
    expect(tracker.version).toBe(1);
  });
});

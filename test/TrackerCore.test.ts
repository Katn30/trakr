import { describe, it, expect, vi, afterEach } from "vitest";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { Tracker } from "../packages/core/src/Tracker";
import { Tracked } from "../packages/core/src/Tracked";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { ITracked } from "../packages/core/src/ITracked";
import { Id, getIdentityProperties } from "../packages/core/src/ExternallyAssigned";
import { State } from "../packages/unit-of-work/src/State";

import { emitted, oneOperation, pendingIds } from "./eventHelpers";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { EntityContainer } from "../packages/unit-of-work/src/EntityContainer";
afterEach(() => vi.restoreAllMocks());

// ---------------------------------------------------------------------------- Models

class Flags extends Entity {
  @Tracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor on: boolean = false;
  @Tracked() accessor anything: unknown = "";
  constructor(t: UnitOfWork) { super(t); }
}

class Defaults extends Entity {
  @Tracked() accessor status: string = "";
  constructor(t: UnitOfWork) {
    super(t);
    this.status = "draft";
  }
}

class Part extends Entity {
  @Tracked() accessor name: string = "";
  constructor(t: UnitOfWork) { super(t); }
}

const setterCalls: string[] = [];

class SetterModel extends Entity {
  private _code = "ok";
  private _part: Part | null = null;

  get code(): string { return this._code; }
  @Tracked(
    (_self, v: string) => (v === "" ? "code required" : undefined),
    {
      beforeChange: (_self, v) => setterCalls.push(`before:${v}`),
      afterChange: (_self, v) => setterCalls.push(`after:${v}`),
    },
  )
  set code(value: string) { this._code = value; }

  get part(): Part | null { return this._part; }
  @Tracked() set part(value: Part | null) { this._part = value; }

  constructor(t: UnitOfWork) { super(t); }
}

class Box extends EntityContainer {
  readonly tags: TrackedCollection<string>;
  readonly parts: TrackedCollection<Part>;
  constructor(t: UnitOfWork, parts: Part[] = []) {
    super(t);
    this.tags = new TrackedCollection<string>(t, ["a"]);
    this.parts = new TrackedCollection<Part>(t, parts);
    this.trackChild(this.tags);
    this.trackChild(this.parts);
  }
  release(): void {
    this.untrackChild(this.tags);
    this.untrackChild(this.parts);
  }
}

// ---------------------------------------------------------------------------- Tracker

describe("Tracker core", () => {
  it("session end() / rollback() after the session ended are no-ops", () => {
    const tracker = new UnitOfWork();
    const part = tracker.construct(() => new Part(tracker));
    const session = tracker._startSession();
    part.name = "x";
    session.end();
    session.end();
    session.rollback();
    expect(part.name).toBe("x");
    expect(tracker.canUndo).toBe(true);
  });

  it("new() keeps the redo stack available", () => {
    const tracker = new UnitOfWork();
    const part = tracker.construct(() => new Part(tracker));
    part.name = "x";
    tracker.undo();
    tracker.new(() => new Part(tracker));
    expect(tracker.canRedo).toBe(true);
    tracker.redo();
    expect(part.name).toBe("x");
  });

  it("new() on a UnitOfWork resets constructor writes to Unchanged", () => {
    const tracker = new UnitOfWork();
    const d = tracker.new(() => new Defaults(tracker));
    expect(d.status).toBe("draft");
    expect(d.chronicleState).toBe(State.Unchanged);
    expect(tracker.isDirty).toBe(false);
  });

  it("coalesceWithin is ignored for non-string/number properties", () => {
    const tracker = new UnitOfWork();
    const f = tracker.construct(() => new Flags(tracker));
    f.on = true;
    f.on = false;
    tracker.undo();
    expect(f.on).toBe(true);
  });

  it("collection writes inside construct() are applied silently", () => {
    const tracker = new UnitOfWork();
    const col = tracker.construct(() => {
      const c = new TrackedCollection<string>(tracker);
      c.push("a");
      return c;
    });
    expect(col.collection).toEqual(["a"]);
    expect(tracker.canUndo).toBe(false);
  });

  it("destroying an invalid collection releases its validity contribution", () => {
    const tracker = new UnitOfWork();
    const col = tracker.construct(
      () => new TrackedCollection<string>(tracker, [], (items) => (items.length === 0 ? "empty" : undefined)),
    );
    expect(tracker.isValid).toBe(false);
    col.destroy();
    expect(tracker.isValid).toBe(true);
  });

  it("rejects values of unsupported types", () => {
    const tracker = new UnitOfWork();
    const f = tracker.construct(() => new Flags(tracker));
    expect(() => { f.anything = () => 1; }).toThrow("Property type 'function' not supported");
  });
});

// ---------------------------------------------------------------------------- @Tracked on setters

describe("@Tracked on a setter", () => {
  it("validates, runs hooks, and undoes", () => {
    setterCalls.length = 0;
    const tracker = new UnitOfWork();
    const m = tracker.construct(() => new SetterModel(tracker));
    m.code = "";
    // Setter validators read through the user's getter, which is not dependency-
    // tracked, so they run on _revalidate()/undo/redo rather than on every write.
    tracker._revalidate();
    expect(m.validationMessages.get("code")).toBe("code required");
    expect(setterCalls).toEqual(["before:", "after:"]);
    tracker.undo();
    expect(m.code).toBe("ok");
    expect(m.chronicleIsValid).toBe(true);
    expect(setterCalls).toEqual(["before:", "after:"]); // hooks do not fire on replay
  });

  it("marks object values added and removed", () => {
    const tracker = new UnitOfWork();
    const m = tracker.construct(() => new SetterModel(tracker));
    const p1 = tracker.construct(() => new Part(tracker));
    const p2 = tracker.construct(() => new Part(tracker));
    m.part = p1;
    expect(p1.chronicleState).toBe(State.Insert);
    m.part = p2;
    expect(p1.chronicleState).toBe(State.Unchanged); // collapsed: never persisted
    expect(p2.chronicleState).toBe(State.Insert);
  });
});

// ---------------------------------------------------------------------------- TrackedCollection

describe("TrackedCollection — interface members", () => {
  it("carries no object state and ignores registry validation", () => {
    const tracker = new UnitOfWork();
    const col = tracker.construct(() => new TrackedCollection<number>(tracker, [1, 2]));
    (col as unknown as ITracked)._applyValidation(new Map([["x", "err"]]));
    expect(col.chronicleIsValid).toBe(true);
    for (const member of ["chronicleState", "isDirty", "dirtyCounter", "_setState"]) {
      expect(member in col).toBe(false);
    }
  });

  it("toString / toLocaleString / lastIndexOf mirror Array", () => {
    const tracker = new UnitOfWork();
    const col = tracker.construct(() => new TrackedCollection<number>(tracker, [1, 2, 1]));
    expect(col.toString()).toBe("1,2,1");
    expect(col.toLocaleString()).toBe([1, 2, 1].toLocaleString());
    expect(col.lastIndexOf(1)).toBe(2);
    expect(col.lastIndexOf(1, 1)).toBe(0);
    expect(col[Symbol.unscopables]).toBe([][Symbol.unscopables]);
  });

  it("fill and copyWithin handle negative, clamped and empty ranges like Array", () => {
    const tracker = new UnitOfWork();
    const make = () => tracker.construct(() => new TrackedCollection<number>(tracker, [1, 2, 3, 4]));
    const cases: Array<[(c: TrackedCollection<number>) => unknown, (a: number[]) => unknown]> = [
      [(c) => c.fill(0, -2), (a) => a.fill(0, -2)],
      [(c) => c.fill(0, -9, -1), (a) => a.fill(0, -9, -1)],
      [(c) => c.fill(0, 1, 99), (a) => a.fill(0, 1, 99)],
      [(c) => c.fill(0, 3, 1), (a) => a.fill(0, 3, 1)],
      [(c) => c.copyWithin(-1, 0), (a) => a.copyWithin(-1, 0)],
      [(c) => c.copyWithin(0, -2, -1), (a) => a.copyWithin(0, -2, -1)],
      [(c) => c.copyWithin(0, 1, 99), (a) => a.copyWithin(0, 1, 99)],
      [(c) => c.copyWithin(9, 0), (a) => a.copyWithin(9, 0)],
    ];
    for (const [onCollection, onArray] of cases) {
      const col = make();
      const arr = [1, 2, 3, 4];
      onCollection(col);
      onArray(arr);
      expect(col.collection).toEqual(arr);
    }
  });
});

// ---------------------------------------------------------------------------- TrackedContainer

describe("TrackedContainer — children bookkeeping", () => {
  it("tracks object items only, and untracking twice is harmless", () => {
    const tracker = new UnitOfWork();
    const p = tracker.construct(() => new Part(tracker));
    const box = tracker.construct(() => new Box(tracker, [p]));
    box.tags.push("b");
    box.tags.remove("a");
    p.name = "dirty";
    expect(box.isDirty).toBe(true);
    box.release();
    box.release();
    expect(box.isDirty).toBe(false);
  });

  it("destroy() unsubscribes from child collections", () => {
    const tracker = new UnitOfWork();
    const box = tracker.construct(() => new Box(tracker));
    box.destroy();
    expect(tracker._trackedObjects).not.toContain(box);
    const late = tracker.construct(() => new Part(tracker));
    box.parts.push(late);
    late.name = "x";
    expect(box.isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------- Event metadata edge cases

class BaseDoc extends TrackedObject {
  @Id id: string = "b";
  @EventTracked(undefined, undefined, { history: true }) accessor title: string = "";
  constructor(t: EventLog) { super(t); }
}

class DerivedDoc extends BaseDoc {
  @EventTracked() override accessor title: string = "";
  constructor(t: EventLog) { super(t); }
}

class Pair extends TrackedObject {
  @Id id: string = "p";
  @EventTracked() accessor left: string = "";
  @EventTracked() accessor right: string = "";
  constructor(t: EventLog) { super(t); }
}

describe("event metadata and collections — remaining paths", () => {
  it("a redeclared @EventTracked property keeps the base class options", () => {
    const tracker = new EventLog();
    const d = tracker.construct(() => new DerivedDoc(tracker));
    d.title = "T";
    // The base declares history: the payload is the list of changes.
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ title: [{ property: "title", value: "T" }] }]);
  });

  it("metadata registered on both base and derived prototypes is merged without duplicates", () => {
    const tracker = new EventLog();
    tracker.construct(() => new BaseDoc(tracker));
    const d = tracker.construct(() => new DerivedDoc(tracker));
    d.title = "T";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ title: [{ property: "title", value: "T" }] }]);
    expect(getIdentityProperties(DerivedDoc.prototype)).toEqual(["id"]);
  });

  it("history collections ignore edits to items no longer in them", () => {
    const tracker = new EventLog();
    const pair = tracker.construct(() => new Pair(tracker));
    const col = tracker.construct(
      () => new EventTrackedCollection<Pair>(tracker, "pairs", [pair], undefined, { history: true }),
    );
    col.remove(pair);
    tracker._onCommit(pendingIds(tracker));
    pair.left = "edited after removal";
    expect(emitted(tracker)).toEqual([]);
  });

  it("history collections: redo after a persisted compensation re-emits the original op", () => {
    const tracker = new EventLog();
    const col = tracker.construct(
      () => new EventTrackedCollection<Pair>(tracker, "pairs", [], undefined, { history: true }),
    );
    col.push(tracker.construct(() => new Pair(tracker)));
    tracker._onCommit(pendingIds(tracker));
    tracker.undo();
    tracker._onCommit(pendingIds(tracker));
    tracker.redo();
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { pairs: { ops: [{ op: "add", item: { id: "p", left: "", right: "" } }] } },
    ]);
  });
});

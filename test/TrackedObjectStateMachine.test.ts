import { describe, it, expect } from "vitest";
import { State } from "../src/State";
import {
  applyStateTransition,
  StateTarget,
} from "../src/TrackedObjectStateMachine";

// ---- Mock StateTarget ----

class MockTarget implements StateTarget {
  trakrId: number = 1;
  id: number = 0; // simulates an @AutoId field

  trakrState: State = State.Unchanged;
  private _dirtyCounter: number = 0;

  _setState(s: State): void { this.trakrState = s; }
  _getDirtyCounter(): number { return this._dirtyCounter; }
  _setDirtyCounter(v: number): void { this._dirtyCounter = v; }
}

function makeTarget(
  state: State,
  opts: { dirtyCounter?: number; trackingId?: number; id?: number } = {},
): MockTarget {
  const t = new MockTarget();
  t._setState(state);
  t._setDirtyCounter(opts.dirtyCounter ?? 0);
  t.trakrId = opts.trackingId ?? 1;
  t.id = opts.id ?? 0;
  return t;
}

// ---- added ----

describe("applyStateTransition — added / do", () => {
  it("transitions Unchanged → Insert", () => {
    const obj = makeTarget(State.Unchanged);
    applyStateTransition(obj, 'added', 'do');
    expect(obj.trakrState).toBe(State.Insert);
  });

  it("trackingId is stable across undo/redo cycles", () => {
    const obj = makeTarget(State.Unchanged, { trackingId: 7 });
    applyStateTransition(obj, 'added', 'do');
    expect(obj.trakrId).toBe(7);

    applyStateTransition(obj, 'added', 'undo');
    expect(obj.trakrId).toBe(7);

    applyStateTransition(obj, 'added', 'do'); // redo
    expect(obj.trakrId).toBe(7);
  });
});

describe("applyStateTransition — added / undo", () => {
  it("transitions Insert → Unchanged", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1 });
    applyStateTransition(obj, 'added', 'undo');
    expect(obj.trakrState).toBe(State.Unchanged);
  });
});

// ---- removed ----

describe("applyStateTransition — removed / do — from Insert", () => {
  it("collapses Insert → Unchanged", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1 });
    applyStateTransition(obj, 'removed', 'do');
    expect(obj.trakrState).toBe(State.Unchanged);
  });

  it("resets dirtyCounter to 0", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1, dirtyCounter: 2 });
    applyStateTransition(obj, 'removed', 'do');
    expect(obj._getDirtyCounter()).toBe(0);
  });
});

describe("applyStateTransition — removed / do — from Unchanged", () => {
  it("transitions Unchanged → Deleted", () => {
    const obj = makeTarget(State.Unchanged);
    applyStateTransition(obj, 'removed', 'do');
    expect(obj.trakrState).toBe(State.Deleted);
  });

  it("does not touch dirtyCounter", () => {
    const obj = makeTarget(State.Unchanged, { dirtyCounter: 3 });
    applyStateTransition(obj, 'removed', 'do');
    expect(obj._getDirtyCounter()).toBe(3);
  });
});

describe("applyStateTransition — removed / undo — prevState Insert", () => {
  it("transitions to Insert", () => {
    const obj = makeTarget(State.Unchanged);
    applyStateTransition(obj, 'removed', 'undo', { prevState: State.Insert });
    expect(obj.trakrState).toBe(State.Insert);
  });

  it("restores dirtyCounter from context", () => {
    const obj = makeTarget(State.Unchanged, { dirtyCounter: 0 });
    applyStateTransition(obj, 'removed', 'undo', { prevState: State.Insert, prevDirtyCounter: 2 });
    expect(obj._getDirtyCounter()).toBe(2);
  });
});

describe("applyStateTransition — removed / undo — prevState Unchanged", () => {
  it("transitions Deleted → Unchanged", () => {
    const obj = makeTarget(State.Deleted);
    applyStateTransition(obj, 'removed', 'undo', { prevState: State.Unchanged });
    expect(obj.trakrState).toBe(State.Unchanged);
  });
});

// ---- committed ----

describe("applyStateTransition — committed / do — Insert with realId", () => {
  it("transitions Insert → Unchanged", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Insert, autoIdProp: 'id', realId: 42 });
    expect(obj.trakrState).toBe(State.Unchanged);
  });

  it("writes realId to the @AutoId field", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Insert, autoIdProp: 'id', realId: 42 });
    expect(obj.id).toBe(42);
  });

  it("resets dirtyCounter", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1, dirtyCounter: 3 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Insert, autoIdProp: 'id', realId: 42 });
    expect(obj._getDirtyCounter()).toBe(0);
  });
});

describe("applyStateTransition — committed / do — Insert without realId", () => {
  it("transitions Insert → Unchanged", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Insert });
    expect(obj.trakrState).toBe(State.Unchanged);
  });

  it("does not touch @AutoId field when no realId is provided", () => {
    const obj = makeTarget(State.Insert, { trackingId: 1, id: 0 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Insert });
    expect(obj.id).toBe(0);
  });
});

describe("applyStateTransition — committed / do — Changed with realId", () => {
  it("transitions Changed → Unchanged", () => {
    const obj = makeTarget(State.Changed, { trackingId: 3, id: 10 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Changed, autoIdProp: 'id', realId: 99 });
    expect(obj.trakrState).toBe(State.Unchanged);
  });

  it("writes new realId to the @AutoId field (temporal update: old row closed, new row inserted)", () => {
    const obj = makeTarget(State.Changed, { trackingId: 3, id: 10 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Changed, autoIdProp: 'id', realId: 99 });
    expect(obj.id).toBe(99);
  });

  it("resets dirtyCounter", () => {
    const obj = makeTarget(State.Changed, { trackingId: 3, dirtyCounter: 2 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Changed, autoIdProp: 'id', realId: 99 });
    expect(obj._getDirtyCounter()).toBe(0);
  });

  it("does not touch @AutoId when no realId provided (non-temporal update)", () => {
    const obj = makeTarget(State.Changed, { trackingId: 3, id: 10 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Changed });
    expect(obj.id).toBe(10);
  });
});

describe("applyStateTransition — committed / do — Deleted", () => {
  it("transitions Deleted → Unchanged", () => {
    const obj = makeTarget(State.Deleted);
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Deleted });
    expect(obj.trakrState).toBe(State.Unchanged);
  });

  it("resets dirtyCounter", () => {
    const obj = makeTarget(State.Deleted, { dirtyCounter: 1 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Deleted });
    expect(obj._getDirtyCounter()).toBe(0);
  });

  it("does not touch @AutoId field", () => {
    const obj = makeTarget(State.Deleted, { id: 10 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Deleted });
    expect(obj.id).toBe(10);
  });
});

describe("applyStateTransition — committed / do — Unchanged", () => {
  it("state remains Unchanged", () => {
    const obj = makeTarget(State.Unchanged, { dirtyCounter: 2 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Unchanged });
    expect(obj.trakrState).toBe(State.Unchanged);
  });

  it("resets dirtyCounter", () => {
    const obj = makeTarget(State.Unchanged, { dirtyCounter: 2 });
    applyStateTransition(obj, 'committed', 'do', { prevState: State.Unchanged });
    expect(obj._getDirtyCounter()).toBe(0);
  });
});

describe("applyStateTransition — committed / undo — prevState Insert", () => {
  it("transitions Unchanged → Deleted", () => {
    const obj = makeTarget(State.Unchanged, { id: 42 });
    applyStateTransition(obj, 'committed', 'undo', { prevState: State.Insert });
    expect(obj.trakrState).toBe(State.Deleted);
  });

  it("preserves @AutoId (real id kept for DELETE request)", () => {
    const obj = makeTarget(State.Unchanged, { id: 42 });
    applyStateTransition(obj, 'committed', 'undo', { prevState: State.Insert });
    expect(obj.id).toBe(42);
  });
});

describe("applyStateTransition — committed / undo — prevState Deleted", () => {
  it("transitions Unchanged → Insert", () => {
    const obj = makeTarget(State.Unchanged);
    applyStateTransition(obj, 'committed', 'undo', { prevState: State.Deleted });
    expect(obj.trakrState).toBe(State.Insert);
  });

  it("trackingId remains stable", () => {
    const obj = makeTarget(State.Unchanged, { trackingId: 5 });
    applyStateTransition(obj, 'committed', 'undo', { prevState: State.Deleted });
    expect(obj.trakrId).toBe(5);
  });
});

describe("applyStateTransition — committed / undo — prevState Unchanged", () => {
  it("state remains Unchanged", () => {
    const obj = makeTarget(State.Unchanged, { dirtyCounter: 0 });
    applyStateTransition(obj, 'committed', 'undo', { prevState: State.Unchanged });
    expect(obj.trakrState).toBe(State.Unchanged);
  });
});

describe("applyStateTransition — committed / undo — prevState Changed", () => {
  it("transitions Unchanged → Changed", () => {
    const obj = makeTarget(State.Unchanged);
    applyStateTransition(obj, 'committed', 'undo', { prevState: State.Changed });
    expect(obj.trakrState).toBe(State.Changed);
  });
});

// ---- undo without context: the previous state defaults to Unchanged ----

describe("applyStateTransition — undo without context", () => {
  it("removed / undo restores Unchanged", () => {
    const obj = makeTarget(State.Deleted);
    applyStateTransition(obj, 'removed', 'undo');
    expect(obj.trakrState).toBe(State.Unchanged);
  });

  it("committed / undo leaves the state as it is", () => {
    const obj = makeTarget(State.Unchanged);
    applyStateTransition(obj, 'committed', 'undo');
    expect(obj.trakrState).toBe(State.Unchanged);
  });
});

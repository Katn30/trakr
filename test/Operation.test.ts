import { describe, it, expect, vi } from "vitest";
import { Operation } from "../packages/core/src/Operation";
import { OperationProperties } from "../packages/core/src/OperationProperties";
import { PropertyType } from "../packages/core/src/PropertyType";
import { CollectionUtilities } from "../packages/core/src/CollectionUtilities";
import { TypedEvent } from "../packages/core/src/TypedEvent";

const stubModel = {} as any;

function props(): OperationProperties {
  return new OperationProperties(stubModel, "prop", PropertyType.String);
}

describe("Operation", () => {
  describe("initial state", () => {
    it("hasActions is false", () => {
      expect(new Operation().hasActions).toBe(false);
    });

    it("actions array is empty", () => {
      expect(new Operation().actions).toHaveLength(0);
    });

    it("records the creation time", () => {
      const before = Date.now();
      const op = new Operation();
      expect(op.time.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  describe("add()", () => {
    it("stores the action", () => {
      const op = new Operation();
      op.add(vi.fn(), vi.fn(), props());
      expect(op.actions).toHaveLength(1);
    });

    it("sets hasActions to true", () => {
      const op = new Operation();
      op.add(vi.fn(), vi.fn(), props());
      expect(op.hasActions).toBe(true);
    });

    it("assigns sequential action numbers starting from 0", () => {
      const op = new Operation();
      op.add(vi.fn(), vi.fn(), props());
      op.add(vi.fn(), vi.fn(), props());
      op.add(vi.fn(), vi.fn(), props());
      expect(op.actions.map((a) => a.number)).toEqual([0, 1, 2]);
    });

    it("stores the supplied properties on the action", () => {
      const op = new Operation();
      const p = props();
      op.add(vi.fn(), vi.fn(), p);
      expect(op.actions[0].properties).toBe(p);
    });

    it("records a timestamp on each action", () => {
      const before = Date.now();
      const op = new Operation();
      op.add(vi.fn(), vi.fn(), props());
      expect(op.actions[0].time.getTime()).toBeGreaterThanOrEqual(before);
    });
  });

  describe("undo()", () => {
    it("calls every undoAction", () => {
      const op = new Operation();
      const u1 = vi.fn();
      const u2 = vi.fn();
      op.add(vi.fn(), u1, props());
      op.add(vi.fn(), u2, props());
      op.undo();
      expect(u1).toHaveBeenCalledOnce();
      expect(u2).toHaveBeenCalledOnce();
    });

    it("calls undoActions in reverse order of addition", () => {
      const op = new Operation();
      const order: number[] = [];
      op.add(vi.fn(), () => order.push(1), props());
      op.add(vi.fn(), () => order.push(2), props());
      op.add(vi.fn(), () => order.push(3), props());
      op.undo();
      expect(order).toEqual([3, 2, 1]);
    });

    it("does not call redoActions", () => {
      const op = new Operation();
      const r = vi.fn();
      op.add(r, vi.fn(), props());
      op.undo();
      expect(r).not.toHaveBeenCalled();
    });
  });

  describe("redo()  —  always called after undo()", () => {
    it("calls every redoAction", () => {
      const op = new Operation();
      const r1 = vi.fn();
      const r2 = vi.fn();
      op.add(r1, vi.fn(), props());
      op.add(r2, vi.fn(), props());
      op.undo();
      op.redo();
      expect(r1).toHaveBeenCalledOnce();
      expect(r2).toHaveBeenCalledOnce();
    });

    it("calls redoActions in the original order of addition", () => {
      const op = new Operation();
      const order: number[] = [];
      op.add(() => order.push(1), vi.fn(), props());
      op.add(() => order.push(2), vi.fn(), props());
      op.add(() => order.push(3), vi.fn(), props());
      op.undo();
      order.length = 0;
      op.redo();
      expect(order).toEqual([1, 2, 3]);
    });

    it("does not call undoActions", () => {
      const op = new Operation();
      const u = vi.fn();
      op.add(vi.fn(), u, props());
      op.undo();
      u.mockReset();
      op.redo();
      expect(u).not.toHaveBeenCalled();
    });
  });

  describe("undo → redo cycle", () => {
    it("correct actions are called across multiple alternations", () => {
      const op = new Operation();
      const order: string[] = [];
      op.add(
        () => order.push("redo-A"),
        () => order.push("undo-A"),
        props(),
      );
      op.add(
        () => order.push("redo-B"),
        () => order.push("undo-B"),
        props(),
      );

      op.undo();
      expect(order).toEqual(["undo-B", "undo-A"]);
      order.length = 0;

      op.redo();
      expect(order).toEqual(["redo-A", "redo-B"]);
      order.length = 0;

      op.undo();
      expect(order).toEqual(["undo-B", "undo-A"]);
    });
  });
});

// ---- updateOrAdd() ----

describe("Operation — updateOrAdd()", () => {
  const stubModel = {} as any;
  const propA = () => new OperationProperties(stubModel, "propA", PropertyType.String);
  const propB = () => new OperationProperties(stubModel, "propB", PropertyType.String);

  it("adds a new change when no matching entry exists", () => {
    const op = new Operation();
    op.updateOrAdd(vi.fn(), vi.fn(), propA());
    expect(op.actions).toHaveLength(1);
    expect(op.hasActions).toBe(true);
  });

  it("replaces the last matching change rather than appending a duplicate", () => {
    const op = new Operation();
    op.updateOrAdd(vi.fn(), vi.fn(), propA());
    op.updateOrAdd(vi.fn(), vi.fn(), propA());
    expect(op.actions).toHaveLength(1); // still one entry for propA
  });

  it("preserves the original action number when replacing", () => {
    const op = new Operation();
    op.add(vi.fn(), vi.fn(), propB()); // number 0
    op.updateOrAdd(vi.fn(), vi.fn(), propA()); // number 1
    op.updateOrAdd(vi.fn(), vi.fn(), propA()); // replaces number 1
    expect(op.actions[1].number).toBe(1);
  });

  it("uses the new redo/undo functions after replacement", () => {
    const op = new Operation();
    const originalRedo = vi.fn();
    const newRedo = vi.fn();
    op.updateOrAdd(originalRedo, vi.fn(), propA());
    op.updateOrAdd(newRedo, vi.fn(), propA());
    op.undo();
    op.redo();
    expect(originalRedo).not.toHaveBeenCalled();
    expect(newRedo).toHaveBeenCalledOnce();
  });

  it("matches on both trackedObject and property — different property adds a new entry", () => {
    const op = new Operation();
    op.updateOrAdd(vi.fn(), vi.fn(), propA());
    op.updateOrAdd(vi.fn(), vi.fn(), propB()); // different property
    expect(op.actions).toHaveLength(2);
  });

  it("matches on both trackedObject and property — different object adds a new entry", () => {
    const op = new Operation();
    const otherModel = {} as any;
    op.updateOrAdd(vi.fn(), vi.fn(), new OperationProperties(stubModel, "p", PropertyType.String));
    op.updateOrAdd(vi.fn(), vi.fn(), new OperationProperties(otherModel, "p", PropertyType.String));
    expect(op.actions).toHaveLength(2);
  });

  it("replaces the LAST matching entry (not the first) when multiple exist", () => {
    const op = new Operation();
    const redo1 = vi.fn();
    const redo2 = vi.fn();
    const redo3 = vi.fn();
    op.add(redo1, vi.fn(), propA()); // index 0
    op.add(redo2, vi.fn(), propA()); // index 1 — same prop, but added via add()
    op.updateOrAdd(redo3, vi.fn(), propA()); // should replace index 1 (last match)
    expect(op.actions).toHaveLength(2);
    op.undo();
    op.redo();
    expect(redo1).toHaveBeenCalledOnce(); // unchanged
    expect(redo2).not.toHaveBeenCalled(); // replaced
    expect(redo3).toHaveBeenCalledOnce(); // new redo at index 1
  });
});

// ---- CollectionUtilities ----

describe("CollectionUtilities.getLast()", () => {
  it("returns undefined for an empty array", () => {
    expect(CollectionUtilities.getLast([])).toBeUndefined();
  });

  it("returns the only element in a single-element array", () => {
    expect(CollectionUtilities.getLast([42])).toBe(42);
  });

  it("returns the last element of a multi-element array", () => {
    expect(CollectionUtilities.getLast([1, 2, 3])).toBe(3);
  });

  it("does not mutate the array", () => {
    const arr = [1, 2, 3];
    CollectionUtilities.getLast(arr);
    expect(arr).toEqual([1, 2, 3]);
  });
});

// ---- TypedEvent ----

describe("TypedEvent", () => {
  it("emit with no subscribers does not throw", () => {
    const event = new TypedEvent<number>();
    expect(() => event._emit(42)).not.toThrow();
  });

  it("unsubscribe of a handler that was never subscribed does not throw", () => {
    const event = new TypedEvent<number>();
    const handler = vi.fn();
    expect(() => event.unsubscribe(handler)).not.toThrow();
  });

  it("subscribing the same handler twice calls it twice per emit", () => {
    const event = new TypedEvent<number>();
    const handler = vi.fn();
    event.subscribe(handler);
    event.subscribe(handler);
    event._emit(1);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it("unsubscribing one of two identical handlers leaves the other active", () => {
    const event = new TypedEvent<number>();
    const handler = vi.fn();
    event.subscribe(handler);
    event.subscribe(handler);
    event.unsubscribe(handler); // removes only the first occurrence
    event._emit(1);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("unsubscribing via the returned function removes that handler", () => {
    const event = new TypedEvent<number>();
    const handler = vi.fn();
    const unsub = event.subscribe(handler);
    unsub();
    event._emit(1);
    expect(handler).not.toHaveBeenCalled();
  });
});

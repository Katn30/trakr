import { describe, it, expect, beforeEach, vi } from "vitest";
import { Tracker } from "../src/Tracker";
import {
  TrackedCollection,
  TrackedCollectionChanged,
} from "../src/TrackedCollection";
import { TrackedObject } from "../src/TrackedObject";
import { State } from "../src/State";
import { Tracked } from "../src/Tracked";

// Simple concrete TrackedObject for splice-state tests
class SimpleItem extends TrackedObject {
  @Tracked()
  accessor label: string = "";
  constructor(tracker: Tracker) {
    super(tracker);
  }
}

describe("TrackedCollection", () => {
  let tracker: Tracker;
  let collection: TrackedCollection<number>;

  beforeEach(() => {
    tracker = new Tracker();
    collection = new TrackedCollection<number>(tracker, [1, 2, 3]);
  });

  // ------------------------------------------------------------------ setup

  describe("construction", () => {
    it("initialises with provided items", () => {
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("initialises empty when no items given", () => {
      const empty = new TrackedCollection<number>(tracker);
      expect(empty.length).toBe(0);
    });

    it("registers itself with the tracker", () => {
      expect(tracker.trackedCollections).toContain(collection);
    });

    it("removes itself from the tracker on destroy", () => {
      collection.destroy();
      expect(tracker.trackedCollections).not.toContain(collection);
    });

    it("is not dirty initially", () => {
      expect(collection.isDirty).toBe(false);
      expect(tracker.isDirty).toBe(false);
    });
  });

  // ------------------------------------------------------------------ splice

  describe("splice", () => {
    it("removes items and returns them", () => {
      const removed = collection.splice(1, 2);
      expect(removed).toEqual([2, 3]);
      expect(collection.collection).toEqual([1]);
    });

    it("inserts items without removing", () => {
      collection.splice(1, 0, 10, 11);
      expect(collection.collection).toEqual([1, 10, 11, 2, 3]);
    });

    it("replaces items", () => {
      collection.splice(1, 1, 99);
      expect(collection.collection).toEqual([1, 99, 3]);
    });

    it("marks tracker dirty", () => {
      collection.splice(0, 1);
      expect(tracker.isDirty).toBe(true);
    });

    it("undo restores previous state", () => {
      collection.splice(1, 2);
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("redo re-applies splice", () => {
      collection.splice(1, 2);
      tracker.undo();
      tracker.redo();
      expect(collection.collection).toEqual([1]);
    });
  });

  // ------------------------------------------------------------------ push / pop

  describe("push / pop", () => {
    it("push adds items at the end", () => {
      collection.push(4, 5);
      expect(collection.collection).toEqual([1, 2, 3, 4, 5]);
    });

    it("push returns new length", () => {
      expect(collection.push(4)).toBe(4);
    });

    it("push with no items is a no-op", () => {
      collection.push();
      expect(collection.length).toBe(3);
      expect(tracker.isDirty).toBe(false);
    });

    it("pop removes and returns the last item", () => {
      expect(collection.pop()).toBe(3);
      expect(collection.collection).toEqual([1, 2]);
    });

    it("pop on empty collection returns undefined", () => {
      const empty = new TrackedCollection<number>(tracker);
      expect(empty.pop()).toBeUndefined();
    });

    it("undo reverts push", () => {
      collection.push(4);
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });
  });

  // ------------------------------------------------------------------ shift / unshift

  describe("shift / unshift", () => {
    it("shift removes and returns the first item", () => {
      expect(collection.shift()).toBe(1);
      expect(collection.collection).toEqual([2, 3]);
    });

    it("shift on empty collection returns undefined", () => {
      const empty = new TrackedCollection<number>(tracker);
      expect(empty.shift()).toBeUndefined();
    });

    it("unshift inserts items at the front", () => {
      collection.unshift(0);
      expect(collection.collection).toEqual([0, 1, 2, 3]);
    });

    it("unshift returns new length", () => {
      expect(collection.unshift(0)).toBe(4);
    });

    it("undo reverts shift", () => {
      collection.shift();
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });
  });

  // ------------------------------------------------------------------ remove / replace

  describe("remove / replace / replaceAt", () => {
    it("remove deletes the item by value", () => {
      expect(collection.remove(2)).toBe(true);
      expect(collection.collection).toEqual([1, 3]);
    });

    it("remove returns false when item is not found", () => {
      expect(collection.remove(99)).toBe(false);
      expect(collection.length).toBe(3);
    });

    it("replace substitutes the matched item", () => {
      expect(collection.replace(2, 99)).toBe(true);
      expect(collection.collection).toEqual([1, 99, 3]);
    });

    it("replace returns false when item is not found", () => {
      expect(collection.replace(99, 0)).toBe(false);
    });

    it("replaceAt replaces at the given index", () => {
      collection.replaceAt(1, 99);
      expect(collection.collection).toEqual([1, 99, 3]);
    });

    it("undo reverts remove", () => {
      collection.remove(2);
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });
  });

  // ------------------------------------------------------------------ reset / clear

  describe("reset / clear", () => {
    it("reset replaces all items", () => {
      collection.reset([10, 20]);
      expect(collection.collection).toEqual([10, 20]);
    });

    it("reset is tracked and undoable", () => {
      collection.reset([10, 20]);
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("clear removes all items", () => {
      collection.clear();
      expect(collection.length).toBe(0);
    });

    it("clear on empty collection is a no-op", () => {
      collection.clear();
      collection.clear();
      expect(tracker.canUndo).toBe(true);
      tracker.undo();
      expect(tracker.canUndo).toBe(false); // only one operation recorded
    });

    it("undo reverts clear", () => {
      collection.clear();
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });
  });

  // ------------------------------------------------------------------ fill / copyWithin

  describe("fill", () => {
    it("fills the entire collection", () => {
      collection.fill(0);
      expect(collection.collection).toEqual([0, 0, 0]);
    });

    it("fills a range", () => {
      collection.fill(0, 1, 3);
      expect(collection.collection).toEqual([1, 0, 0]);
    });

    it("handles negative indices", () => {
      collection.fill(0, -2);
      expect(collection.collection).toEqual([1, 0, 0]);
    });

    it("is tracked and undoable", () => {
      collection.fill(0);
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("no-op when range is empty", () => {
      collection.fill(0, 2, 2);
      expect(tracker.isDirty).toBe(false);
    });
  });

  describe("copyWithin", () => {
    it("copies a slice to a target position", () => {
      collection.copyWithin(0, 1);
      expect(collection.collection).toEqual([2, 3, 3]);
    });

    it("is tracked and undoable", () => {
      collection.copyWithin(0, 1);
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("no-op when count is zero", () => {
      collection.copyWithin(3, 0);
      expect(tracker.isDirty).toBe(false);
    });
  });

  // ------------------------------------------------------------------ sort / reverse (not tracked)

  describe("sort / reverse (not tracked)", () => {
    it("sort reorders items in place", () => {
      const c = new TrackedCollection<number>(tracker, [3, 1, 2]);
      c.sort((a, b) => a - b);
      expect(c.collection).toEqual([1, 2, 3]);
      expect(tracker.isDirty).toBe(false);
    });

    it("sort is a no-op on empty collection", () => {
      const empty = new TrackedCollection<number>(tracker);
      expect(empty.sort()).toBe(empty);
    });

    it("reverse reverses items in place", () => {
      collection.reverse();
      expect(collection.collection).toEqual([3, 2, 1]);
      expect(tracker.isDirty).toBe(false);
    });
  });

  // ------------------------------------------------------------------ read-only methods

  describe("read-only methods", () => {
    it("indexOf returns correct index", () => {
      expect(collection.indexOf(2)).toBe(1);
      expect(collection.indexOf(99)).toBe(-1);
    });

    it("lastIndexOf returns last occurrence", () => {
      const c = new TrackedCollection<number>(tracker, [1, 2, 1]);
      expect(c.lastIndexOf(1)).toBe(2);
    });

    it("includes returns true for present items", () => {
      expect(collection.includes(2)).toBe(true);
      expect(collection.includes(99)).toBe(false);
    });

    it("find returns matching item", () => {
      expect(collection.find((x) => x > 1)).toBe(2);
    });

    it("findIndex returns matching index", () => {
      expect(collection.findIndex((x) => x > 1)).toBe(1);
    });

    it("findLast returns last matching item", () => {
      expect(collection.findLast((x) => x < 3)).toBe(2);
    });

    it("findLastIndex returns last matching index", () => {
      expect(collection.findLastIndex((x) => x < 3)).toBe(1);
    });

    it("first returns the first item", () => {
      expect(collection.first()).toBe(1);
    });

    it("first returns undefined on empty collection", () => {
      expect(new TrackedCollection<number>(tracker).first()).toBeUndefined();
    });

    it("at supports negative indexing", () => {
      expect(collection.at(-1)).toBe(3);
    });

    it("slice returns a sub-array", () => {
      expect(collection.slice(1, 3)).toEqual([2, 3]);
    });

    it("concat joins items without modifying the collection", () => {
      const result = collection.concat([4, 5]);
      expect(result).toEqual([1, 2, 3, 4, 5]);
      expect(collection.length).toBe(3);
      expect(tracker.isDirty).toBe(false);
    });

    it("join concatenates with separator", () => {
      expect(collection.join("-")).toBe("1-2-3");
    });

    it("every returns true when all match", () => {
      expect(collection.every((x) => x > 0)).toBe(true);
      expect(collection.every((x) => x > 1)).toBe(false);
    });

    it("some returns true when any matches", () => {
      expect(collection.some((x) => x === 2)).toBe(true);
      expect(collection.some((x) => x > 10)).toBe(false);
    });

    it("forEach iterates all items", () => {
      const seen: number[] = [];
      collection.forEach((x) => seen.push(x));
      expect(seen).toEqual([1, 2, 3]);
    });

    it("map transforms items", () => {
      expect(collection.map((x) => x * 2)).toEqual([2, 4, 6]);
    });

    it("filter returns matching items", () => {
      expect(collection.filter((x) => x > 1)).toEqual([2, 3]);
    });

    it("reduce accumulates value", () => {
      expect(collection.reduce((acc, x) => acc + x, 0)).toBe(6);
    });

    it("reduceRight accumulates from the right", () => {
      expect(collection.reduceRight((acc, x) => acc + x, 0)).toBe(6);
    });

    it("flat flattens nested arrays", () => {
      const nested = new TrackedCollection<number[]>(tracker, [[1, 2], [3]]);
      expect(nested.flat()).toEqual([1, 2, 3]);
    });

    it("flatMap maps and flattens", () => {
      expect(collection.flatMap((x) => [x, x * 10])).toEqual([
        1, 10, 2, 20, 3, 30,
      ]);
    });

    it("entries returns index/value pairs", () => {
      expect([...collection.entries()]).toEqual([
        [0, 1],
        [1, 2],
        [2, 3],
      ]);
    });

    it("keys returns indices", () => {
      expect([...collection.keys()]).toEqual([0, 1, 2]);
    });

    it("values returns items", () => {
      expect([...collection.values()]).toEqual([1, 2, 3]);
    });

    it("toReversed returns a new reversed array without mutating", () => {
      expect(collection.toReversed()).toEqual([3, 2, 1]);
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("toSorted returns a new sorted array without mutating", () => {
      const c = new TrackedCollection<number>(tracker, [3, 1, 2]);
      expect(c.toSorted((a, b) => a - b)).toEqual([1, 2, 3]);
      expect(c.collection).toEqual([3, 1, 2]);
    });

    it("toSpliced returns a new array without mutating", () => {
      expect(collection.toSpliced(1, 1, 99)).toEqual([1, 99, 3]);
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("with returns a new array with one element replaced", () => {
      expect(collection.with(1, 99)).toEqual([1, 99, 3]);
      expect(collection.collection).toEqual([1, 2, 3]);
    });
  });

  // ------------------------------------------------------------------ for...of iterator

  describe("for...of iterator", () => {
    it("iterates all items in order", () => {
      const seen: number[] = [];
      for (const item of collection) {
        seen.push(item);
      }
      expect(seen).toEqual([1, 2, 3]);
    });
  });

  // ------------------------------------------------------------------ lastItemIndex

  describe("lastItemIndex", () => {
    it("returns the last index", () => {
      expect(collection.lastItemIndex).toBe(2);
    });

    it("returns undefined for empty collection", () => {
      expect(
        new TrackedCollection<number>(tracker).lastItemIndex,
      ).toBeUndefined();
    });
  });

  // ------------------------------------------------------------------ changed event

  describe("changed event", () => {
    it("emits on push with correct payload", () => {
      let event: TrackedCollectionChanged<number> | undefined;
      collection.changed.subscribe((e) => {
        event = e;
      });
      collection.push(4);
      expect(event?.added).toEqual([4]);
      expect(event?.removed).toEqual([]);
      expect(event?.newCollection).toEqual([1, 2, 3, 4]);
    });

    it("emits on remove with correct payload", () => {
      let event: TrackedCollectionChanged<number> | undefined;
      collection.changed.subscribe((e) => {
        event = e;
      });
      collection.remove(2);
      expect(event?.added).toEqual([]);
      expect(event?.removed).toEqual([2]);
    });

    it("emits on undo with reversed added/removed", () => {
      collection.push(4);
      let event: TrackedCollectionChanged<number> | undefined;
      collection.changed.subscribe((e) => {
        event = e;
      });
      tracker.undo();
      expect(event?.added).toEqual([]);
      expect(event?.removed).toEqual([4]);
    });

    it("unsubscribe stops receiving events", () => {
      const handler = vi.fn();
      const unsub = collection.changed.subscribe(handler);
      unsub();
      collection.push(4);
      expect(handler).not.toHaveBeenCalled();
    });
  });

  // ------------------------------------------------------------------ validation

  describe("validation", () => {
    it("is valid without a validator", () => {
      expect(collection.isValid).toBe(true);
      expect(collection.error).toBeUndefined();
    });

    it("is invalid when validator returns an error message", () => {
      const c = new TrackedCollection<number>(tracker, [], (v) =>
        v.length === 0 ? "Required" : undefined,
      );
      expect(c.isValid).toBe(false);
      expect(c.error).toBe("Required");
    });

    it("becomes valid after the condition is resolved", () => {
      const c = new TrackedCollection<number>(tracker, [], (v) =>
        v.length === 0 ? "Required" : undefined,
      );
      c.push(1);
      expect(c.isValid).toBe(true);
      expect(c.error).toBeUndefined();
    });

    it("tracker reflects collection validity", () => {
      const c = new TrackedCollection<number>(tracker, [], (v) =>
        v.length === 0 ? "Required" : undefined,
      );
      expect(tracker.isValid).toBe(false);
      c.push(1);
      expect(tracker.isValid).toBe(true);
    });
  });

  // ------------------------------------------------------------------ dirty state

  describe("dirty state", () => {
    it("becomes clean after afterCommit", () => {
      collection.push(4);
      tracker.onCommit();
      expect(tracker.isDirty).toBe(false);
    });

    it("is dirty again after further changes post-save", () => {
      collection.push(4);
      tracker.onCommit();
      collection.push(5);
      expect(tracker.isDirty).toBe(true);
    });

    it("isDirtyChanged event fires on state change", () => {
      const states: boolean[] = [];
      tracker.isDirtyChanged.subscribe((v) => states.push(v));
      collection.push(4);
      tracker.onCommit();
      expect(states).toEqual([true, false]);
    });
  });

  // ------------------------------------------------------------------ undo / redo

  describe("undo / redo", () => {
    it("canUndo is false initially", () => {
      expect(tracker.canUndo).toBe(false);
    });

    it("canRedo is false initially", () => {
      expect(tracker.canRedo).toBe(false);
    });

    it("canUndo becomes true after a change", () => {
      collection.push(4);
      expect(tracker.canUndo).toBe(true);
    });

    it("canRedo becomes true after undo", () => {
      collection.push(4);
      tracker.undo();
      expect(tracker.canRedo).toBe(true);
    });

    it("undo is a no-op when nothing to undo", () => {
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("redo is a no-op when nothing to redo", () => {
      tracker.redo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("multiple undos work correctly", () => {
      collection.push(4);
      collection.push(5);
      tracker.undo();
      tracker.undo();
      expect(collection.collection).toEqual([1, 2, 3]);
    });

    it("new change clears redo stack", () => {
      collection.push(4);
      tracker.undo();
      collection.push(99);
      expect(tracker.canRedo).toBe(false);
    });
  });
});

// ---- reduce / reduceRight without initialValue ----

describe("TrackedCollection — reduce/reduceRight without initialValue", () => {
  let tracker: Tracker;

  beforeEach(() => {
    tracker = new Tracker();
  });

  it("reduce(fn) without initialValue uses the first element as accumulator", () => {
    const col = new TrackedCollection<number>(tracker, [1, 2, 3, 4]);
    expect(col.reduce((acc, x) => acc + x)).toBe(10);
  });

  it("reduce(fn) without initialValue on a single-element collection returns that element", () => {
    const col = new TrackedCollection<number>(tracker, [7]);
    expect(col.reduce((acc, x) => acc + x)).toBe(7);
  });

  it("reduceRight(fn) without initialValue uses the last element as accumulator", () => {
    const col = new TrackedCollection<string>(tracker, ["a", "b", "c"]);
    expect(col.reduceRight((acc, x) => acc + x)).toBe("cba");
  });

  it("reduceRight(fn) without initialValue on a single-element collection returns that element", () => {
    const col = new TrackedCollection<number>(tracker, [5]);
    expect(col.reduceRight((acc, x) => acc + x)).toBe(5);
  });
});

// ---- TrackedObject items in splice ----

describe("TrackedCollection — TrackedObject items get correct state on splice", () => {
  let tracker: Tracker;

  beforeEach(() => {
    tracker = new Tracker();
  });

  it("item pushed to a collection is marked New", () => {
    const col = new TrackedCollection<SimpleItem>(tracker);
    const item = tracker.construct(() => new SimpleItem(tracker));
    expect(item.state).toBe(State.Unchanged);

    col.push(item);

    expect(item.state).toBe(State.Insert);
  });

  it("New item removed from a collection is marked Unchanged (treated as never existed)", () => {
    const col = new TrackedCollection<SimpleItem>(tracker);
    const item = tracker.construct(() => new SimpleItem(tracker));
    col.push(item); // → New
    expect(item.state).toBe(State.Insert);

    col.remove(item);

    expect(item.state).toBe(State.Unchanged);
    expect(tracker.trackedObjects).not.toContain(item);
  });

  it("committed (Unchanged) item spliced out of a collection is marked Deleted", () => {
    const item = tracker.construct(() => new SimpleItem(tracker));
    const col = new TrackedCollection<SimpleItem>(tracker, [item]);
    tracker.onCommit(); // item remains Unchanged, collection is clean
    expect(item.state).toBe(State.Unchanged);

    col.splice(0, 1); // remove the item

    expect(item.state).toBe(State.Deleted);
  });

  it("undo of a push restores item state to Unchanged", () => {
    const col = new TrackedCollection<SimpleItem>(tracker);
    const item = tracker.construct(() => new SimpleItem(tracker));
    col.push(item);
    expect(item.state).toBe(State.Insert);

    tracker.undo();

    expect(item.state).toBe(State.Unchanged);
  });

  it("undo of a removal restores committed item state to Deleted", () => {
    const item = tracker.construct(() => new SimpleItem(tracker));
    const col = new TrackedCollection<SimpleItem>(tracker, [item]);
    tracker.onCommit();
    col.splice(0, 1); // → Deleted
    expect(item.state).toBe(State.Deleted);

    tracker.undo();

    expect(item.state).toBe(State.Unchanged);
  });
});

// ---- Insert collapse — untracking and validity accounting ----

class RequiredNameItem extends TrackedObject {
  @Tracked((_, v: string) => v.length > 0 ? undefined : "name required")
  accessor name: string = "";
  constructor(tracker: Tracker) { super(tracker); }
}

describe("TrackedCollection — Insert-remove untracks the item", () => {
  let tracker: Tracker;

  beforeEach(() => {
    tracker = new Tracker();
  });

  it("invalid Insert item removed from collection restores tracker.isValid", () => {
    const col = new TrackedCollection<RequiredNameItem>(tracker);
    const item = tracker.construct(() => new RequiredNameItem(tracker));
    col.push(item);

    expect(item.isValid).toBe(false);
    expect(tracker.isValid).toBe(false);

    col.remove(item);

    expect(tracker.trackedObjects).not.toContain(item);
    expect(tracker.isValid).toBe(true);
  });

  it("undo of an invalid Insert-remove re-tracks and re-invalidates", () => {
    const col = new TrackedCollection<RequiredNameItem>(tracker);
    const item = tracker.construct(() => new RequiredNameItem(tracker));
    col.push(item);
    col.remove(item);
    expect(tracker.isValid).toBe(true);

    tracker.undo();

    expect(tracker.trackedObjects).toContain(item);
    expect(item.state).toBe(State.Insert);
    expect(tracker.isValid).toBe(false);
  });

  it("consumer does not need to call destroy() after remove for Insert items", () => {
    const col = new TrackedCollection<RequiredNameItem>(tracker);
    const item = tracker.construct(() => new RequiredNameItem(tracker));
    col.push(item);
    col.remove(item);
    // No destroy() call — the library handles it.
    const another = tracker.construct(() => new RequiredNameItem(tracker));
    another.name = "ok";
    col.push(another);

    expect(tracker.isValid).toBe(true);
    expect(tracker.trackedObjects).toEqual([another]);
  });
});

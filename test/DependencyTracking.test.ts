import { describe, it, expect, beforeEach } from "vitest";
import { Tracker } from "../src/Tracker";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { Tracked } from "../src/Tracked";

// ---- Call counters ----
// Defined at module level so they are captured by validator closures.
// Reset in beforeEach AFTER construction to ignore initial validate() calls.

let sameObjCalls = 0;
let crossObjCalls = 0;
let conditionalCalls = 0;
let collectionCalls = 0;
let selfOnlyCalls = 0;
let field1Calls = 0;
let field2Calls = 0;
let flatValidatorCalls = 0;

// ---- Models ----

class OrderModel extends TrackedObject {
  @Tracked()
  accessor maxQuantity: number = 10;

  @Tracked((self: OrderModel, v: number) => {
    sameObjCalls++;
    return v > self.maxQuantity ? "Exceeds max" : undefined;
  })
  accessor quantity: number = 0;

  @Tracked()
  accessor notes: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class BudgetModel extends TrackedObject {
  @Tracked()
  accessor limit: number = 100;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class ExpenseModel extends TrackedObject {
  @Tracked()
  accessor budget: BudgetModel | undefined = undefined;

  @Tracked((self: ExpenseModel, v: number) => {
    crossObjCalls++;
    if (!self.budget) return undefined;
    return v > self.budget.limit ? "Over budget" : undefined;
  })
  accessor amount: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// useA=true  → active dep is valueA
// useA=false → active dep is valueB
class ConditionalModel extends TrackedObject {
  @Tracked()
  accessor useA: boolean = true;

  @Tracked()
  accessor valueA: number = 5;

  @Tracked()
  accessor valueB: number = 5;

  @Tracked((self: ConditionalModel, _v: string) => {
    conditionalCalls++;
    return (self.useA ? self.valueA : self.valueB) < 0 ? "Negative" : undefined;
  })
  accessor label: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class CartModel extends TrackedObject {
  readonly items: TrackedCollection<number>;

  @Tracked((self: CartModel, _v: string) => {
    collectionCalls++;
    return self.items.some((x) => x < 0) ? "Has negative item" : undefined;
  })
  accessor name: string = "cart";

  constructor(tracker: Tracker, items: TrackedCollection<number>) {
    super(tracker);
    this.items = items;
  }
}

// Validator only uses the passed value — no cross-property reads via self.xxx.
class SelfOnlyModel extends TrackedObject {
  @Tracked()
  accessor unrelated: number = 0;

  @Tracked((_self: SelfOnlyModel, v: string) => {
    selfOnlyCalls++;
    return !v ? "Required" : undefined;
  })
  accessor label: string = "hello";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// Bug 1: two validators that both read the same property (sharedDep).
class SharedDepModel extends TrackedObject {
  @Tracked()
  accessor sharedDep: number = 10;

  @Tracked((self: SharedDepModel, v: number) => {
    field1Calls++;
    return v > self.sharedDep ? "field1 exceeds limit" : undefined;
  })
  accessor field1: number = 0;

  @Tracked((self: SharedDepModel, v: number) => {
    field2Calls++;
    return v > self.sharedDep ? "field2 exceeds limit" : undefined;
  })
  accessor field2: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// Bug 2: dependent object reads a property from a source object.
class BugSourceModel extends TrackedObject {
  @Tracked()
  accessor value: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class BugDependentModel extends TrackedObject {
  @Tracked()
  accessor source: BugSourceModel | undefined = undefined;

  @Tracked((self: BugDependentModel, _v: number) => {
    return self.source && self.source.value < 0 ? "Negative source" : undefined;
  })
  accessor amount: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// Bug 3: validator that calls flat() on the collection.
class FlatModel extends TrackedObject {
  readonly matrix: TrackedCollection<number[]>;

  @Tracked((self: FlatModel, _v: string) => {
    flatValidatorCalls++;
    return self.matrix.flat().some((x) => (x as number) < 0) ? "Has negative" : undefined;
  })
  accessor name: string = "";

  constructor(tracker: Tracker, matrix: TrackedCollection<number[]>) {
    super(tracker);
    this.matrix = matrix;
  }
}

// ---- Tests ----

describe("Dependency tracking", () => {
  describe("same-object property dependencies", () => {
    let tracker: Tracker;
    let order: OrderModel;

    beforeEach(() => {
      tracker = new Tracker();
      order = tracker.construct(() => new OrderModel(tracker));
      sameObjCalls = 0;
    });

    it("does not re-run validator when an unrelated property changes", () => {
      order.notes = "some note";
      expect(sameObjCalls).toBe(0);
    });

    it("re-runs validator when the decorated property itself changes", () => {
      order.quantity = 5;
      expect(sameObjCalls).toBe(1);
    });

    it("re-runs validator when a dep property read in the validator changes", () => {
      order.maxQuantity = 3;
      expect(sameObjCalls).toBe(1);
    });

    it("produces correct validation result after dep change", () => {
      order.quantity = 8; // under the default maxQuantity of 10
      sameObjCalls = 0;
      expect(order.isValid).toBe(true);
      order.maxQuantity = 5; // now quantity (8) exceeds maxQuantity (5)
      expect(order.isValid).toBe(false);
      expect(order.validationMessages.get("quantity")).toBe("Exceeds max");
    });

    it("clears error when dep change makes validation pass again", () => {
      order.quantity = 15; // exceeds default maxQuantity of 10
      expect(order.isValid).toBe(false);
      order.maxQuantity = 20; // now quantity (15) is within limit
      expect(order.isValid).toBe(true);
      expect(order.validationMessages.has("quantity")).toBe(false);
    });
  });

  describe("cross-object dependencies", () => {
    let tracker: Tracker;
    let budget: BudgetModel;
    let expense: ExpenseModel;

    beforeEach(() => {
      tracker = new Tracker();
      tracker.construct(() => {
        budget = new BudgetModel(tracker);
        expense = new ExpenseModel(tracker);
        expense.budget = budget;
      });
      crossObjCalls = 0;
    });

    it("re-runs validator when the referenced object's dep property changes", () => {
      expense.amount = 50;
      crossObjCalls = 0;
      budget.limit = 30; // amount (50) now exceeds limit (30)
      expect(crossObjCalls).toBe(1);
    });

    it("produces correct result after cross-object dep change", () => {
      expense.amount = 50;
      expect(expense.isValid).toBe(true);
      budget.limit = 30;
      expect(expense.isValid).toBe(false);
      expect(expense.validationMessages.get("amount")).toBe("Over budget");
    });

    it("does not re-run validator when an unrelated tracked object changes", () => {
      const other = tracker.construct(() => new BudgetModel(tracker));
      expense.amount = 50;
      crossObjCalls = 0;
      other.limit = 10; // unrelated — expense does not depend on this
      expect(crossObjCalls).toBe(0);
    });

    it("re-runs validator when the budget reference itself changes", () => {
      const newBudget = tracker.construct(() => new BudgetModel(tracker));
      newBudget.limit = 5;
      crossObjCalls = 0;
      expense.budget = newBudget; // reading self.budget in validator → dep on this property
      expect(crossObjCalls).toBe(1);
    });
  });

  describe("conditional dependencies", () => {
    let tracker: Tracker;
    let model: ConditionalModel;

    beforeEach(() => {
      tracker = new Tracker();
      model = tracker.construct(() => new ConditionalModel(tracker));
      conditionalCalls = 0;
    });

    it("re-runs validator when the condition property changes", () => {
      model.useA = false;
      expect(conditionalCalls).toBe(1);
    });

    it("re-runs validator when the active branch dep changes", () => {
      // useA starts as true → valueA is the active dep
      model.valueA = -1;
      expect(conditionalCalls).toBe(1);
    });

    it("does not re-run validator when the inactive branch dep changes", () => {
      // useA is true → valueB is NOT in the dep map
      model.valueB = -1;
      expect(conditionalCalls).toBe(0);
    });

    it("after branch flip, old dep no longer triggers validator", () => {
      model.useA = false; // flip: now valueB is active, valueA is not
      conditionalCalls = 0;
      model.valueA = -1; // was a dep before flip — should not trigger now
      expect(conditionalCalls).toBe(0);
    });

    it("after branch flip, new dep triggers validator", () => {
      model.useA = false; // flip: now valueB is active dep
      conditionalCalls = 0;
      model.valueB = -1;
      expect(conditionalCalls).toBe(1);
    });

    it("produces correct result across a branch flip", () => {
      // useA=true, valueA=5 → valid
      expect(model.isValid).toBe(true);
      model.useA = false; // switch to valueB branch (valueB=5) → still valid
      expect(model.isValid).toBe(true);
      model.valueB = -1; // valueB now negative → invalid
      expect(model.isValid).toBe(false);
    });
  });

  describe("TrackedCollection dependencies", () => {
    let tracker: Tracker;
    let cart: CartModel;
    let items: TrackedCollection<number>;

    beforeEach(() => {
      tracker = new Tracker();
      items = new TrackedCollection<number>(tracker, [1, 2, 3]);
      cart = tracker.construct(() => new CartModel(tracker, items));
      collectionCalls = 0;
    });

    it("re-runs validator when an item is pushed to the collection", () => {
      items.push(4);
      expect(collectionCalls).toBe(1);
    });

    it("re-runs validator when an item is removed from the collection", () => {
      items.remove(1);
      expect(collectionCalls).toBe(1);
    });

    it("re-runs validator when the collection is cleared", () => {
      items.clear();
      expect(collectionCalls).toBe(1);
    });

    it("produces correct result when a negative item is pushed", () => {
      items.push(-1);
      expect(cart.isValid).toBe(false);
      expect(cart.validationMessages.get("name")).toBe("Has negative item");
    });

    it("clears error when the negative item is removed", () => {
      items.push(-1);
      expect(cart.isValid).toBe(false);
      items.remove(-1);
      expect(cart.isValid).toBe(true);
    });

    it("does not re-run validator when an unrelated collection changes", () => {
      const unrelated = new TrackedCollection<number>(tracker, [10, 20]);
      collectionCalls = 0;
      unrelated.push(30);
      expect(collectionCalls).toBe(0);
    });
  });

  describe("self-only dependency (no cross-property reads)", () => {
    let tracker: Tracker;
    let model: SelfOnlyModel;

    beforeEach(() => {
      tracker = new Tracker();
      model = tracker.construct(() => new SelfOnlyModel(tracker));
      selfOnlyCalls = 0;
    });

    it("re-runs validator when the decorated property changes", () => {
      model.label = "world";
      expect(selfOnlyCalls).toBe(1);
    });

    it("does not re-run validator when an unrelated property changes", () => {
      model.unrelated = 99;
      expect(selfOnlyCalls).toBe(0);
    });
  });

  // ------------------------------------------------------------------ Bug 1

  describe("Bug 1: mutation during iteration (multiple validators on same dep)", () => {
    let tracker: Tracker;
    let model: SharedDepModel;

    beforeEach(() => {
      tracker = new Tracker();
      model = tracker.construct(() => new SharedDepModel(tracker));
      field1Calls = 0;
      field2Calls = 0;
    });

    it("runs each dependent validator exactly once when the shared dep changes", () => {
      model.sharedDep = 5;
      expect(field1Calls).toBe(1);
      expect(field2Calls).toBe(1);
    });

    it("produces correct validation state for all dependent validators", () => {
      model.field1 = 8;
      model.field2 = 8;
      field1Calls = 0;
      field2Calls = 0;

      model.sharedDep = 5; // 8 > 5 → both fields should now be invalid
      expect(model.validationMessages.get("field1")).toBe("field1 exceeds limit");
      expect(model.validationMessages.get("field2")).toBe("field2 exceeds limit");
      expect(model.isValid).toBe(false);
    });

    it("clears errors for all dependent validators when dep change makes them valid", () => {
      model.sharedDep = 5;
      model.field1 = 8; // 8 > 5 → invalid
      model.field2 = 8; // 8 > 5 → invalid
      expect(model.isValid).toBe(false);
      field1Calls = 0;
      field2Calls = 0;

      model.sharedDep = 20; // both fields now within limit
      expect(model.validationMessages.has("field1")).toBe(false);
      expect(model.validationMessages.has("field2")).toBe(false);
      expect(model.isValid).toBe(true);
    });
  });

  // ------------------------------------------------------------------ Bug 2

  describe("Bug 2: stale dep entries after object destruction", () => {
    let tracker: Tracker;
    let src: BugSourceModel;
    let dep: BugDependentModel;

    beforeEach(() => {
      tracker = new Tracker();
      tracker.construct(() => {
        src = new BugSourceModel(tracker);
        dep = new BugDependentModel(tracker);
        dep.source = src;
      });
    });

    it("does not corrupt tracker.isValid after a dependent object is destroyed", () => {
      src.value = -1;
      expect(tracker.isValid).toBe(false);

      dep.destroy();
      expect(tracker.isValid).toBe(true);

      src.value = 1;
      expect(tracker.isValid).toBe(true);
    });

    it("does not make tracker invalid when source changes after dependent is destroyed", () => {
      dep.destroy();
      expect(tracker.isValid).toBe(true);

      src.value = -1;
      expect(tracker.isValid).toBe(true);
    });
  });

  // ------------------------------------------------------------------ Bug 3

  describe("Bug 3: TrackedCollection.flat() bypasses readAccess()", () => {
    let tracker: Tracker;
    let model: FlatModel;
    let matrix: TrackedCollection<number[]>;

    beforeEach(() => {
      tracker = new Tracker();
      matrix = new TrackedCollection<number[]>(tracker, [[1, 2], [3, 4]]);
      model = tracker.construct(() => new FlatModel(tracker, matrix));
      flatValidatorCalls = 0;
    });

    it("re-runs validator when a row is pushed to the matrix", () => {
      matrix.push([5, 6]);
      expect(flatValidatorCalls).toBe(1);
    });

    it("detects a negative value pushed via flat()", () => {
      matrix.push([-1, -2]);
      expect(model.isValid).toBe(false);
      expect(model.validationMessages.get("name")).toBe("Has negative");
    });

    it("clears error when the negative row is removed", () => {
      const negativeRow = [-1, -2];
      matrix.push(negativeRow);
      expect(model.isValid).toBe(false);
      matrix.remove(negativeRow);
      expect(model.isValid).toBe(true);
    });
  });
});

// ---- Models for integration tests ----

let validatorACalls = 0;
let validatorBCalls = 0;
let sharedColCallsA = 0;
let sharedColCallsB = 0;

class SourceModel extends TrackedObject {
  @Tracked()
  accessor value: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class DependentA extends TrackedObject {
  @Tracked()
  accessor source: SourceModel | undefined = undefined;

  @Tracked((self: DependentA, v: number) => {
    validatorACalls++;
    return self.source && v > self.source.value ? "A exceeds" : undefined;
  })
  accessor amount: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class DependentB extends TrackedObject {
  @Tracked()
  accessor source: SourceModel | undefined = undefined;

  @Tracked((self: DependentB, v: number) => {
    validatorBCalls++;
    return self.source && v > self.source.value ? "B exceeds" : undefined;
  })
  accessor amount: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class UndoModel extends TrackedObject {
  @Tracked()
  accessor limit: number = 10;

  @Tracked((self: UndoModel, v: number) => {
    return v > self.limit ? "Over limit" : undefined;
  })
  accessor value: number = 0;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class TwoValidatorsModel extends TrackedObject {
  readonly col: TrackedCollection<number>;

  @Tracked((self: TwoValidatorsModel, _v: string) => {
    sharedColCallsA++;
    return self.col.some((x) => x < 0) ? "neg" : undefined;
  })
  accessor nameA: string = "";

  @Tracked((self: TwoValidatorsModel, _v: string) => {
    sharedColCallsB++;
    return self.col.length > 5 ? "too many" : undefined;
  })
  accessor nameB: string = "";

  constructor(tracker: Tracker, col: TrackedCollection<number>) {
    super(tracker);
    this.col = col;
  }
}

let collectionCrossDepCalls = 0;

class ThresholdModel extends TrackedObject {
  @Tracked()
  accessor threshold: number = 3;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

describe("Dependency tracking — integration", () => {
  let tracker: Tracker;

  beforeEach(() => {
    tracker = new Tracker();
    validatorACalls = 0;
    validatorBCalls = 0;
    sharedColCallsA = 0;
    sharedColCallsB = 0;
  });

  describe("undo/redo preserves correct validation state", () => {
    let model: UndoModel;

    beforeEach(() => {
      model = tracker.construct(() => new UndoModel(tracker));
    });

    it("restores valid state after undoing an invalid change", () => {
      model.value = 15;
      expect(model.isValid).toBe(false);
      tracker.undo();
      expect(model.value).toBe(0);
      expect(model.isValid).toBe(true);
    });

    it("restores invalid state after redoing the change", () => {
      model.value = 15;
      tracker.undo();
      expect(model.isValid).toBe(true);
      tracker.redo();
      expect(model.value).toBe(15);
      expect(model.isValid).toBe(false);
    });

    it("restores valid state after undoing a dep change that caused invalidity", () => {
      model.value = 8;
      model.limit = 5;
      expect(model.isValid).toBe(false);
      tracker.undo();
      expect(model.limit).toBe(10);
      expect(model.isValid).toBe(true);
    });

    it("preserves correct state through multiple undo/redo cycles", () => {
      model.value = 15;
      model.limit = 20;
      expect(model.isValid).toBe(true);
      tracker.undo();
      expect(model.isValid).toBe(false);
      tracker.undo();
      expect(model.isValid).toBe(true);
      tracker.redo();
      expect(model.isValid).toBe(false);
      tracker.redo();
      expect(model.isValid).toBe(true);
    });

    it("tracker.isValid reflects model validity through undo/redo", () => {
      model.value = 15;
      expect(tracker.isValid).toBe(false);
      tracker.undo();
      expect(tracker.isValid).toBe(true);
      tracker.redo();
      expect(tracker.isValid).toBe(false);
    });
  });

  describe("two dependents on same source; one destroyed", () => {
    let src: SourceModel;
    let depA: DependentA;
    let depB: DependentB;

    beforeEach(() => {
      tracker.construct(() => {
        src = new SourceModel(tracker);
        depA = new DependentA(tracker);
        depB = new DependentB(tracker);
        depA.source = src;
        depB.source = src;
      });
      depA.amount = 1;
      depB.amount = 1;
      validatorACalls = 0;
      validatorBCalls = 0;
    });

    it("B's validator still fires when A is destroyed and source changes", () => {
      depA.destroy();
      src.value = 5;
      expect(validatorBCalls).toBe(1);
    });

    it("A's validator does not fire after A is destroyed", () => {
      depA.destroy();
      src.value = 5;
      expect(validatorACalls).toBe(0);
    });

    it("tracker.isValid remains correct after A is destroyed and source changes", () => {
      depA.amount = 10;
      depB.amount = 10;
      expect(tracker.isValid).toBe(false);

      depA.destroy();
      expect(tracker.isValid).toBe(false);

      src.value = 20;
      expect(tracker.isValid).toBe(true);
    });

    it("B produces correct validation state after A is destroyed", () => {
      depA.destroy();
      depB.amount = 3;
      expect(depB.isValid).toBe(false);
      src.value = 5;
      expect(depB.isValid).toBe(true);
    });
  });

  describe("sequential dep changes trigger validator each time", () => {
    it("changing the same dep multiple times gives correct state each time", () => {
      const model = tracker.construct(() => new UndoModel(tracker));
      model.value = 5;

      model.limit = 3;
      expect(model.isValid).toBe(false);

      model.limit = 10;
      expect(model.isValid).toBe(true);

      model.limit = 4;
      expect(model.isValid).toBe(false);
    });

    it("changing the validated property multiple times gives correct state each time", () => {
      const model = tracker.construct(() => new UndoModel(tracker));

      model.value = 5;
      expect(model.isValid).toBe(true);

      model.value = 15;
      expect(model.isValid).toBe(false);

      model.value = 8;
      expect(model.isValid).toBe(true);

      model.value = 20;
      expect(model.isValid).toBe(false);
    });
  });

  describe("TrackedCollection own validator", () => {
    it("collection's own validator runs when items are pushed", () => {
      const col = new TrackedCollection<number>(tracker, [], (items) =>
        items.some((x) => x < 0) ? "Has negative" : undefined,
      );

      expect(col.isValid).toBe(true);
      col.push(-1);
      expect(col.isValid).toBe(false);
      expect(col.error).toBe("Has negative");
    });

    it("collection's own validator clears error when item removed", () => {
      const col = new TrackedCollection<number>(tracker, [], (items) =>
        items.some((x) => x < 0) ? "Has negative" : undefined,
      );

      col.push(-1);
      col.remove(-1);
      expect(col.isValid).toBe(true);
      expect(col.error).toBeUndefined();
    });

    it("tracker.isValid reflects collection's own validator result", () => {
      const col = new TrackedCollection<number>(tracker, [], (items) =>
        items.some((x) => x < 0) ? "Has negative" : undefined,
      );

      expect(tracker.isValid).toBe(true);
      col.push(-1);
      expect(tracker.isValid).toBe(false);
      col.remove(-1);
      expect(tracker.isValid).toBe(true);
    });

    it("collection's own validator runs on reset", () => {
      const col = new TrackedCollection<number>(tracker, [1, 2], (items) =>
        items.length === 0 ? "Empty" : undefined,
      );

      expect(col.isValid).toBe(true);
      col.reset([]);
      expect(col.isValid).toBe(false);
      expect(col.error).toBe("Empty");
    });
  });

  describe("shared collection triggers both dependent validators on push", () => {
    it("pushes trigger both nameA and nameB validators", () => {
      const sharedItems = new TrackedCollection<number>(tracker, [1, 2]);
      tracker.construct(() => new TwoValidatorsModel(tracker, sharedItems));
      sharedColCallsA = 0;
      sharedColCallsB = 0;

      sharedItems.push(3);
      expect(sharedColCallsA).toBe(1);
      expect(sharedColCallsB).toBe(1);
    });

    it("pushing a negative value makes only nameA invalid", () => {
      const sharedItems = new TrackedCollection<number>(tracker, [1, 2]);
      const m = tracker.construct(() => new TwoValidatorsModel(tracker, sharedItems));

      sharedItems.push(-1);
      expect(m.validationMessages.get("nameA")).toBe("neg");
      expect(m.validationMessages.has("nameB")).toBe(false);
      expect(m.isValid).toBe(false);
    });

    it("pushing 4 more items makes only nameB invalid", () => {
      const sharedItems = new TrackedCollection<number>(tracker, [1, 2]);
      const m = tracker.construct(() => new TwoValidatorsModel(tracker, sharedItems));

      sharedItems.push(3, 4, 5, 6);
      expect(m.validationMessages.has("nameA")).toBe(false);
      expect(m.validationMessages.get("nameB")).toBe("too many");
      expect(m.isValid).toBe(false);
    });
  });

  describe("TrackedCollection own validator re-runs on cross-object dep change", () => {
    let thresholdModel: ThresholdModel;
    let col: TrackedCollection<number>;

    beforeEach(() => {
      collectionCrossDepCalls = 0;
      thresholdModel = tracker.construct(() => new ThresholdModel(tracker));
      // validator reads thresholdModel.threshold — a cross-object @Tracked dep
      col = new TrackedCollection<number>(tracker, [1, 2], (items) => {
        collectionCrossDepCalls++;
        return items.length > thresholdModel.threshold ? "Too many" : undefined;
      });
      collectionCrossDepCalls = 0; // ignore the construction-time call
    });

    it("is valid initially when items.length <= threshold", () => {
      expect(col.isValid).toBe(true);
      expect(col.error).toBeUndefined();
    });

    it("re-validates when threshold drops below items.length", () => {
      thresholdModel.threshold = 1; // items.length=2 > 1 → invalid
      expect(col.isValid).toBe(false);
      expect(col.error).toBe("Too many");
    });

    it("validator is re-run exactly once per threshold change", () => {
      thresholdModel.threshold = 1;
      expect(collectionCrossDepCalls).toBe(1);
    });

    it("re-validates when threshold rises above items.length again", () => {
      thresholdModel.threshold = 1; // invalid
      thresholdModel.threshold = 5; // valid again
      expect(col.isValid).toBe(true);
      expect(col.error).toBeUndefined();
    });

    it("tracker.isValid reflects collection validity after cross-object dep change", () => {
      expect(tracker.isValid).toBe(true);
      thresholdModel.threshold = 1;
      expect(tracker.isValid).toBe(false);
      thresholdModel.threshold = 5;
      expect(tracker.isValid).toBe(true);
    });

    it("validator is not re-run after collection is destroyed", () => {
      col.destroy();
      collectionCrossDepCalls = 0;
      thresholdModel.threshold = 1;
      expect(collectionCrossDepCalls).toBe(0);
    });
  });

  describe("getDependents safe path", () => {
    it("changing a property with no registered dependents does not throw", () => {
      const model = tracker.construct(() => new SourceModel(tracker));
      expect(() => { model.value = 99; }).not.toThrow();
    });
  });

  describe("clearDeps idempotency", () => {
    it("destroying an object with no recorded deps does not throw", () => {
      const model = tracker.construct(() => new SourceModel(tracker));
      expect(() => { model.destroy(); }).not.toThrow();
    });

    it("destroying an object twice does not throw", () => {
      const src = tracker.construct(() => new SourceModel(tracker));
      src.destroy();
      expect(() => { src.destroy(); }).not.toThrow();
    });
  });
});

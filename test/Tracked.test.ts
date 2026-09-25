import { describe, it, expect, beforeEach, vi } from "vitest";
import { TrackedObject } from "../src/TrackedObject";
import { Tracker } from "../src/Tracker";
import { DirtyTracker } from "../src/DirtyTracker";
import { Tracked } from "../src/Tracked";

// ---- Concrete test models ----

class PersonModel extends TrackedObject {
  @Tracked(
    (self: PersonModel, v: string) => !v ? "Name is required" : undefined,
    undefined,
    { coalesceWithin: 3000 },
  )
  accessor name: string = "";

  @Tracked((self: PersonModel, v: number) =>
    v < 0 ? "Age must be positive" : undefined,
  )
  accessor age: number = 0;

  @Tracked()
  accessor notes: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class EmptyModel extends TrackedObject {
  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class ModelWithConstructorInit extends TrackedObject {
  @Tracked()
  accessor value: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
    this.value = "initial"; // set during construction — should be suppressed
  }
}

class StrictModel extends TrackedObject {
  @Tracked((_self: StrictModel, v: string) =>
    !v ? "Required" : undefined,
  )
  accessor field: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class EventModel extends TrackedObject {
  @Tracked()
  accessor startDate: Date = new Date(0);

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class ConfigModel extends TrackedObject {
  @Tracked()
  accessor config: Record<string, unknown> = {};

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class NullableModel extends TrackedObject {
  @Tracked()
  accessor label: string | null = null;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// ---- Tests ----

describe("Tracked", () => {
  let tracker: Tracker;
  let person: PersonModel;

  beforeEach(() => {
    tracker = new DirtyTracker();
    person = tracker.construct(() => new PersonModel(tracker));
  });

  describe("constructor name", () => {
    it("preserves the class name", () => {
      expect(person.constructor.name).toBe("PersonModel");
    });
  });

  describe("registration", () => {
    it("registers itself with the tracker on construction", () => {
      expect(tracker.trackedObjects).toContain(person);
    });

    it("removes itself from the tracker on destroy", () => {
      person.destroy();
      expect(tracker.trackedObjects).not.toContain(person);
    });
  });

  describe("undo / redo", () => {
    it("undo reverts a property change", () => {
      person.name = "Alice";
      tracker.undo();
      expect(person.name).toBe("");
      expect(person.isDirty).toBe(false);
    });

    it("redo re-applies the change", () => {
      person.name = "Alice";
      tracker.undo();
      tracker.redo();
      expect(person.name).toBe("Alice");
      expect(person.isDirty).toBe(true);
    });

  });

  describe("validation", () => {
    it("is valid initially (default values satisfy validators)", () => {
      expect(person.trakrIsValid).toBe(false);
      expect(person.validationMessages.get("name")).toBe("Name is required");
    });

    it("becomes valid when the required property is set", () => {
      person.name = "Alice";
      expect(person.trakrIsValid).toBe(true);
      expect(person.validationMessages.has("name")).toBe(false);
    });

    it("becomes invalid when a property fails its validator", () => {
      person.name = "Alice";
      person.age = -1;
      expect(person.trakrIsValid).toBe(false);
      expect(person.validationMessages.get("age")).toBe("Age must be positive");
    });

    it("clears validation message when property becomes valid again", () => {
      person.age = -1;
      person.age = 5;
      expect(person.validationMessages.has("age")).toBe(false);
    });

    it("tracker reflects validity of all models", () => {
      expect(tracker.isValid).toBe(false); // person.name is ''
      person.name = "Alice";
      expect(tracker.isValid).toBe(true);
    });

    it("model without validators is always valid", () => {
      const empty = tracker.construct(() => new EmptyModel(tracker));
      expect(empty.trakrIsValid).toBe(true);
    });
  });

  describe("no-op on same value", () => {
    it("does not create an undo entry when setting the same value", () => {
      person.name = "Alice";
      person.name = "Alice";
      tracker.undo();
      expect(person.name).toBe("");
    });

    it("treats null as a distinct value from empty string", () => {
      person.name = null as any;
      expect(person.isDirty).toBe(true);
    });
  });

  describe("dirty state with tracker", () => {
    it("tracker isDirty reflects model changes", () => {
      expect(tracker.isDirty).toBe(false);
      person.name = "Alice";
      expect(tracker.isDirty).toBe(true);
    });

    it("tracker is clean after afterCommit", () => {
      person.name = "Alice";
      tracker.onCommit();
      expect(tracker.isDirty).toBe(false);
      expect(person.isDirty).toBe(false);
    });

    it("isDirtyChanged event fires when tracker becomes dirty", () => {
      const states: boolean[] = [];
      tracker.isDirtyChanged.subscribe((v) => states.push(v));
      person.name = "Alice";
      tracker.onCommit();
      expect(states).toEqual([true, false]);
    });
  });

  describe("suppress logic during construction", () => {
    it("does not add undo entries for property assignments in the constructor body", () => {
      const t = new DirtyTracker();
      t.construct(() => new ModelWithConstructorInit(t));
      expect(t.canUndo).toBe(false);
    });

    it("tracker is not dirty after construction even when constructor sets properties", () => {
      const t = new DirtyTracker();
      t.construct(() => new ModelWithConstructorInit(t));
      expect(t.isDirty).toBe(false);
    });

    it("model value set in constructor body is preserved", () => {
      const t = new DirtyTracker();
      const m = t.construct(() => new ModelWithConstructorInit(t));
      expect(m.value).toBe("initial");
    });

    it("property changes after construction are tracked normally", () => {
      const t = new DirtyTracker();
      const m = t.construct(() => new ModelWithConstructorInit(t));
      m.value = "changed";
      expect(t.canUndo).toBe(true);
      t.undo();
      expect(m.value).toBe("initial");
    });
  });

  describe("string property aggregation", () => {
    it("multiple rapid changes to the same property aggregate into one undo step", () => {
      person.name = "A";
      person.name = "Al";
      person.name = "Ali";
      tracker.undo();
      expect(person.name).toBe("");
    });

    it("changes separated by more than 3 seconds create separate undo steps", () => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      person.name = "A";
      vi.setSystemTime(4000);
      person.name = "B";
      tracker.undo();
      expect(person.name).toBe("A");
      vi.useRealTimers();
    });
  });

  describe("multiple models on one tracker", () => {
    it("tracker isValid is false if any model is invalid", () => {
      const t = new DirtyTracker();
      const m1 = t.construct(() => new StrictModel(t));
      t.construct(() => new StrictModel(t));
      m1.field = "ok";
      expect(t.isValid).toBe(false); // second model's field still ''
    });

    it("tracker isValid is true only when all models are valid", () => {
      const t = new DirtyTracker();
      const m1 = t.construct(() => new StrictModel(t));
      const m2 = t.construct(() => new StrictModel(t));
      m1.field = "ok";
      m2.field = "ok";
      expect(t.isValid).toBe(true);
    });

    it("destroying one model removes it from tracker validity check", () => {
      const t = new DirtyTracker();
      const m1 = t.construct(() => new StrictModel(t));
      const m2 = t.construct(() => new StrictModel(t));
      m1.field = "ok";
      // m2 is invalid but we destroy it
      m2.destroy();
      expect(t.isValid).toBe(true);
    });
  });

  describe("Date property type", () => {
    it("tracks a Date property change and marks dirty", () => {
      const t = new DirtyTracker();
      const event = t.construct(() => new EventModel(t));
      t.onCommit();

      event.startDate = new Date("2024-01-01");

      expect(event.isDirty).toBe(true);
    });

    it("undoes a Date property change", () => {
      const t = new DirtyTracker();
      const event = t.construct(() => new EventModel(t));
      const original = event.startDate;
      t.onCommit();

      event.startDate = new Date("2024-01-01");
      t.undo();

      expect(event.startDate).toBe(original);
      expect(event.isDirty).toBe(false);
    });
  });

  describe("Object property type", () => {
    it("tracks an object property change and marks dirty", () => {
      const t = new DirtyTracker();
      const cfg = t.construct(() => new ConfigModel(t));
      t.onCommit();

      cfg.config = { theme: "dark" };

      expect(cfg.isDirty).toBe(true);
    });

    it("undoes an object property change", () => {
      const t = new DirtyTracker();
      const cfg = t.construct(() => new ConfigModel(t));
      const original = cfg.config;
      t.onCommit();

      cfg.config = { theme: "dark" };
      t.undo();

      expect(cfg.config).toBe(original);
      expect(cfg.isDirty).toBe(false);
    });
  });

  describe("strict equality — null/undefined are distinct from empty string", () => {
    it("setting null property to empty string creates an operation", () => {
      const t = new DirtyTracker();
      const m = t.construct(() => new NullableModel(t));
      m.label = "";

      expect(t.canUndo).toBe(true);
    });

    it("setting null property to empty string marks dirty", () => {
      const t = new DirtyTracker();
      const m = t.construct(() => new NullableModel(t));
      t.onCommit();

      m.label = "";

      expect(t.isDirty).toBe(true);
    });
  });
});

// ---- Models for getter tests ----

// Getter + setter pair with cascade side effects in the setter
class RuleModel extends TrackedObject {
  private _isEnabled: boolean = false;

  @Tracked()
  get isEnabled(): boolean { return this._isEnabled; }

  @Tracked()
  set isEnabled(value: boolean) {
    this._isEnabled = value;
    if (value) {
      this.scheduleDays = 'mon';
    } else {
      this.scheduleDays = '';
      this.scheduleInterval = null;
    }
  }

  @Tracked((self: RuleModel, v) =>
    self.isEnabled && !v ? 'Day is required' : undefined
  )
  accessor scheduleDays: string = '';

  @Tracked((self: RuleModel, v) =>
    self.isEnabled && !v ? 'Interval is required' : undefined
  )
  accessor scheduleInterval: string | null = null;

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// Purely computed getter (no setter) — registers as a dependency source
class BudgetModel extends TrackedObject {
  @Tracked()
  accessor price: number = 0;

  @Tracked()
  accessor quantity: number = 0;

  @Tracked()
  get total(): number { return this.price * this.quantity; }

  @Tracked((self: BudgetModel, v) =>
    self.total > 1000 ? 'Total exceeds budget' : undefined
  )
  accessor label: string = '';

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

describe("@Tracked on getter — dependency tracking", () => {
  describe("getter + setter pair with cascade side effects", () => {
    it("validators for dependent properties run after construction", () => {
      const tracker = new DirtyTracker();
      const rule = tracker.construct(() => new RuleModel(tracker));
      expect(rule.trakrIsValid).toBe(true);
    });

    it("setting isEnabled=true triggers revalidation of scheduleDays", () => {
      const tracker = new DirtyTracker();
      const rule = tracker.construct(() => new RuleModel(tracker));

      rule.isEnabled = true;
      expect(rule.validationMessages.has('scheduleDays')).toBe(false);
      expect(rule.validationMessages.get('scheduleInterval')).toBe('Interval is required');
    });

    it("setting isEnabled=false clears validation errors on dependent properties", () => {
      const tracker = new DirtyTracker();
      const rule = tracker.construct(() => new RuleModel(tracker));

      rule.isEnabled = true;
      expect(rule.trakrIsValid).toBe(false);

      rule.isEnabled = false;
      expect(rule.trakrIsValid).toBe(true);
    });

    it("dependent validators re-run without manual revalidate()", () => {
      const tracker = new DirtyTracker();
      const rule = tracker.construct(() => new RuleModel(tracker));

      rule.isEnabled = true;
      rule.scheduleDays = '';
      expect(rule.validationMessages.get('scheduleDays')).toBe('Day is required');

      rule.isEnabled = false;
      expect(rule.validationMessages.has('scheduleDays')).toBe(false);
    });

    it("undo of isEnabled restores dependent validation state", () => {
      const tracker = new DirtyTracker();
      const rule = tracker.construct(() => new RuleModel(tracker));

      rule.isEnabled = true;
      expect(rule.trakrIsValid).toBe(false);

      tracker.undo();
      expect(rule.isEnabled).toBe(false);
      expect(rule.trakrIsValid).toBe(true);
    });

    it("getter-decorated property does not create an undo step on read", () => {
      const tracker = new DirtyTracker();
      const rule = tracker.construct(() => new RuleModel(tracker));

      const _ = rule.isEnabled;
      expect(tracker.canUndo).toBe(false);
    });
  });

  describe("purely computed getter", () => {
    it("validator that reads a computed getter reruns when a source property changes", () => {
      const tracker = new DirtyTracker();
      const budget = tracker.construct(() => new BudgetModel(tracker));

      budget.price = 200;
      budget.quantity = 6;
      budget.label = 'test';

      expect(budget.validationMessages.get('label')).toBe('Total exceeds budget');
    });

    it("validator clears when total drops below threshold", () => {
      const tracker = new DirtyTracker();
      const budget = tracker.construct(() => new BudgetModel(tracker));

      budget.price = 200;
      budget.quantity = 6;
      budget.label = 'test';
      expect(budget.validationMessages.has('label')).toBe(true);

      budget.quantity = 4;
      expect(budget.validationMessages.has('label')).toBe(false);
    });
  });
});

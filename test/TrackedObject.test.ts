import { describe, it, expect } from "vitest";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Tracked } from "../packages/core/src/Tracked";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { State } from "../packages/unit-of-work/src/State";
import { Operation } from "../packages/core/src/Operation";
import { deletedObjects } from "./uowHelpers";

// ---- Models ----

class InvoiceModel extends Entity {
  @Tracked()
  accessor status: string = "";

  @Tracked()
  accessor note: string = "";

  readonly lines: TrackedCollection<string>;

  constructor(
    tracker: UnitOfWork,
    initialStatus = "",
    initialLines: string[] = [],
    initialNote = "",
  ) {
    super(tracker);
    this.status = initialStatus;
    this.note = initialNote;
    this.lines = new TrackedCollection<string>(tracker, initialLines);
  }
}

class PersonModel extends Entity {
  private _name: string = "";

  get name(): string {
    return this._name;
  }

  @Tracked()
  set name(value: string) {
    this._name = value;
  }

  constructor(tracker: UnitOfWork, initialName = "") {
    super(tracker);
    this.name = initialName;
  }
}

class ValidatedModel extends Entity {
  @Tracked((_, v: string) => (!v ? "Required" : undefined))
  accessor status: string = "initial";

  @Tracked()
  accessor note: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

class RequiredNameModel extends Entity {
  @Tracked((_, v: string) => (!v ? "Name is required" : undefined))
  accessor name: string = ""; // empty default → always invalid on construction

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

// ---- Sequential changes ----

describe("Entity – sequential changes create separate undo steps", () => {
  it("two sequential property changes create two undo steps", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    invoice.status = "active";
    invoice.note = "hello";

    tracker.undo(); // reverts note only
    expect(invoice.note).toBe("");
    expect(invoice.status).toBe("active");

    tracker.undo(); // reverts status
    expect(invoice.status).toBe("");
  });

  it("a property change and a collection mutation create two undo steps", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker, "active", ["line-1"]));
    tracker._onCommit();

    invoice.status = "void";
    invoice.lines.clear();

    tracker.undo(); // reverts clear only
    expect(invoice.lines.length).toBe(1);
    expect(invoice.status).toBe("void");

    tracker.undo(); // reverts status
    expect(invoice.status).toBe("active");
    expect(tracker.isDirty).toBe(false);
  });

  it("two sequential collection mutations create two undo steps", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker, "", ["a", "b"]));
    tracker._onCommit();

    invoice.lines.push("c");
    invoice.lines.push("d");

    tracker.undo();
    expect(invoice.lines.length).toBe(3);

    tracker.undo();
    expect(invoice.lines.length).toBe(2);
    expect(tracker.isDirty).toBe(false);
  });
});

// ---- Tracking suppression ----

describe("Entity – tracking suppression", () => {
  it("changes inside trackingSuppressed do not create undo entries", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
      invoice.lines.push("line-1");
    });

    expect(tracker.canUndo).toBe(false);
  });

  it("changes inside trackingSuppressed do not mark the tracker dirty", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
    });

    expect(tracker.isDirty).toBe(false);
  });

  it("values are still applied inside trackingSuppressed", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
      invoice.lines.push("line-1", "line-2");
    });

    expect(invoice.status).toBe("draft");
    expect(invoice.lines.length).toBe(2);
  });

  it("changes after trackingSuppressed are tracked normally", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
    });
    invoice.status = "active";

    expect(tracker.canUndo).toBe(true);
    tracker.undo();
    expect(invoice.status).toBe("draft");
  });
});

// ---- @Tracked on get/set accessor ----

describe("Entity – @Tracked on get/set accessor", () => {
  it("change is tracked and undoable", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker, "Alice"));
    tracker._onCommit();

    person.name = "Bob";

    tracker.undo();
    expect(person.name).toBe("Alice");
    expect(tracker.isDirty).toBe(false);
  });

  it("undo then redo restores the change", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    person.name = "Bob";
    tracker.undo();
    tracker.redo();

    expect(person.name).toBe("Bob");
  });

  it("setting the same value does not create an undo step", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker, "Alice"));
    tracker._onCommit();

    person.name = "Alice";

    expect(tracker.canUndo).toBe(false);
    expect(tracker.isDirty).toBe(false);
  });

  it("changes inside trackingSuppressed are not tracked", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    tracker.withTrackingSuppressed(() => {
      person.name = "Bob";
    });

    expect(person.name).toBe("Bob");
    expect(tracker.canUndo).toBe(false);
  });
});

// ---- coalesceWithin on explicit setter ----

class CoalesceSetterModel extends Entity {
  private _note: string = "";

  get note(): string { return this._note; }

  @Tracked(undefined, undefined, { coalesceWithin: 5000 })
  set note(value: string) { this._note = value; }

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

describe("Entity – coalesceWithin on explicit get/set pair", () => {
  it("rapid writes to the same setter merge into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new CoalesceSetterModel(tracker));

    model.note = "a";
    model.note = "b";

    tracker.undo();
    expect(model.note).toBe(""); // both changes undone together
    expect(tracker.canUndo).toBe(false);
  });
});

// ---- Events ----

describe("Entity – isDirtyChanged", () => {
  it("fires with true when the tracker becomes dirty", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    invoice.status = "draft";

    expect(calls).toEqual([true]);
  });

  it("fires with false when the tracker becomes clean", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    tracker.undo();

    expect(calls).toEqual([false]);
  });

  it("does not fire when isDirty is already true", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    invoice.status = "active";

    expect(calls).toEqual([]);
  });

  it("does not fire when isDirty is already false", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => new InvoiceModel(tracker));
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    tracker.undo();

    expect(calls).toEqual([]);
  });
});

describe("Entity – isValidChanged", () => {
  it("fires with false when the tracker becomes invalid", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    tracker._onCommit();
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.status = "";

    expect(calls).toEqual([false]);
  });

  it("fires with true when the tracker becomes valid again", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    model.status = "";
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.status = "active";

    expect(calls).toEqual([true]);
  });

  it("does not fire when isValid is already false", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    model.status = "";
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.note = "x";

    expect(calls).toEqual([]);
  });

  it("does not fire when isValid is already true", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.note = "x";

    expect(calls).toEqual([]);
  });
});

describe("Entity – canCommitChanged", () => {
  it("fires with true when isDirty becomes true and isValid is already true", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    invoice.status = "draft";

    expect(calls).toEqual([true]);
  });

  it("fires with false when isDirty becomes false", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    tracker.undo();

    expect(calls).toEqual([false]);
  });

  it("fires with false when isValid becomes false while isDirty is true", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    model.status = "active";
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    model.status = "";

    expect(calls).toEqual([false]);
  });

  it("does not fire when isDirty becomes true but isValid is false", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    tracker.withTrackingSuppressed(() => { model.status = ""; });
    tracker._revalidate();
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    model.note = "x";

    expect(calls).toEqual([]);
  });

  it("does not fire when a second change is made while already dirty and valid", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    invoice.status = "active";

    expect(calls).toEqual([]);
  });
});

// ---- Entity – construct() ----

describe("Entity – construct()", () => {
  it("validates all objects and updates tracker.isValid after the lambda", () => {
    const tracker = new UnitOfWork();
    expect(tracker.isValid).toBe(true);

    tracker.construct(() => new RequiredNameModel(tracker));

    expect(tracker.isValid).toBe(false);
  });

  it("suppresses tracking during construction (canUndo is false)", () => {
    const tracker = new UnitOfWork();

    tracker.construct(() => new RequiredNameModel(tracker));

    expect(tracker.canUndo).toBe(false);
  });

  it("returns the constructed object", () => {
    const tracker = new UnitOfWork();

    const model = tracker.construct(() => new RequiredNameModel(tracker));

    expect(model).toBeInstanceOf(RequiredNameModel);
    expect(tracker._trackedObjects).toContain(model);
  });

  it("throws when constructing outside construct()", () => {
    const tracker = new UnitOfWork();

    expect(() => new RequiredNameModel(tracker)).toThrow();
  });

  it("handles multiple objects (only one revalidation at the end)", () => {
    const tracker = new UnitOfWork();

    const models = tracker.construct(() => {
      const a = new RequiredNameModel(tracker);
      const b = new RequiredNameModel(tracker);
      const c = new RequiredNameModel(tracker);
      return [a, b, c];
    });

    expect(tracker._trackedObjects.length).toBe(3);
    expect(tracker.isValid).toBe(false);
    expect(tracker.canUndo).toBe(false);
  });

  it("isValid correctly reflects validity after construct() with invalid objects", () => {
    const tracker = new UnitOfWork();

    tracker.construct(() => new RequiredNameModel(tracker));
    tracker.construct(() => new RequiredNameModel(tracker));

    expect(tracker.isValid).toBe(false);
    expect(tracker._trackedObjects.length).toBe(2);
  });

  it("model.isValid, model.validationMessages, and tracker.isValid are all set after construct() with invalid initial data", () => {
    const tracker = new UnitOfWork();

    const model = tracker.construct(() => new RequiredNameModel(tracker));

    expect(model.chronicleIsValid).toBe(false);
    expect(model.validationMessages.get("name")).toBe("Name is required");
    expect(tracker.isValid).toBe(false);
  });

  it("undo push of invalid constructed item removes ghost and restores tracker.isValid", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<RequiredNameModel>(tracker);
    const item = tracker.construct(() => new RequiredNameModel(tracker));
    expect(tracker.isValid).toBe(false); // invalid before push (name is empty)

    items.push(item);
    tracker.undo();

    expect(tracker._trackedObjects).not.toContain(item);
    expect(tracker.isValid).toBe(true);
  });

  it("redo push of invalid item re-tracks and restores tracker.isValid to false", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<RequiredNameModel>(tracker);
    const item = tracker.construct(() => new RequiredNameModel(tracker));
    items.push(item);
    tracker.undo(); // untracked, tracker.isValid = true

    tracker.redo();

    expect(tracker._trackedObjects).toContain(item);
    expect(tracker.isValid).toBe(false); // invalid contribution restored
  });
});

// ---- Models for the sections below ----

class CoalesceModel extends Entity {
  @Tracked(undefined, undefined, { coalesceWithin: 5000 })
  accessor note: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}


// ---- coalesceWithin option ----

describe("Entity — coalesceWithin option", () => {
  it("two rapid changes to the same property merge into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new CoalesceModel(tracker));

    model.note = "a";
    model.note = "b";

    tracker.undo();
    expect(model.note).toBe(""); // both changes undone together (coalesced)
    expect(tracker.canUndo).toBe(false);
  });

  it("a property without coalesceWithin never merges — each write is its own undo step", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    // InvoiceModel.status has no coalesceWithin — writes never merge
    invoice.status = "a";
    invoice.status = "b";

    tracker.undo();
    expect(invoice.status).toBe("a"); // second change undone separately

    tracker.undo();
    expect(invoice.status).toBe(""); // first change undone
  });
});

// ---- no coalesceWithin: writes never merge ----

class NumModel extends Entity {
  @Tracked() accessor qty: number = 0;
  constructor(t: UnitOfWork) { super(t); }
}

describe("Entity — without coalesceWithin, writes never merge", () => {
  it("rapid changes to the same string property are separate undo steps", () => {
    const tracker = new UnitOfWork();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    invoice.status = "a";
    invoice.status = "b";

    tracker.undo();
    expect(invoice.status).toBe("a"); // second change undone on its own

    tracker.undo();
    expect(invoice.status).toBe(""); // first change undone
  });

  it("rapid changes to the same number property are separate undo steps", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new NumModel(tracker));

    model.qty = 1;
    model.qty = 2;

    tracker.undo();
    expect(model.qty).toBe(1);
    tracker.undo();
    expect(model.qty).toBe(0);
  });
});

// ---- deletedObjects(Tracker) ----

class DeletableModel extends Entity {
  @Tracked()
  accessor detail: DeletableModel | null = null;

  constructor(tracker: UnitOfWork) { super(tracker); }
}

// ---- Single-property composition lifecycle ----

class LeafModel extends Entity {
  @Tracked((_, v: string) => (!v ? "Required" : undefined))
  accessor name: string = "";

  constructor(tracker: UnitOfWork) { super(tracker); }
}

class NodeModel extends Entity {
  @Tracked()
  accessor leaf: LeafModel | null = null;

  constructor(tracker: UnitOfWork) { super(tracker); }
}

describe("deletedObjects(Tracker)", () => {
  it("is empty when no objects are deleted", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => new DeletableModel(tracker));
    expect(deletedObjects(tracker)).toHaveLength(0);
  });

  it("contains an object removed from a TrackedCollection", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new DeletableModel(tracker));
    tracker.withTrackingSuppressed(() => {});
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);

    expect(deletedObjects(tracker)).toContain(item);
  });

  it("does not contain an item that collapsed Insert → Unchanged on remove", () => {
    const tracker = new UnitOfWork();
    const items = new TrackedCollection<DeletableModel>(tracker);
    const item = tracker.construct(() => new DeletableModel(tracker));
    items.push(item);
    items.remove(item);

    expect(item.chronicleState).toBe(State.Unchanged);
    expect(deletedObjects(tracker)).not.toContain(item);
  });

  it("disappears from deletedObjects after undo of remove", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();

    expect(deletedObjects(tracker)).not.toContain(item);
  });

  it("reappears in deletedObjects after redo of remove", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();
    tracker.redo();

    expect(deletedObjects(tracker)).toContain(item);
  });

  it("is empty after commit of a delete (state → Unchanged)", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker._onCommit();

    expect(deletedObjects(tracker)).not.toContain(item);
  });

  it("reappears after undoing a committed delete (state → Insert)", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker._onCommit();
    tracker.undo();

    // state is Insert after committed delete undo — not Deleted
    expect(item.chronicleState).toBe(State.Insert);
    expect(deletedObjects(tracker)).not.toContain(item);
  });

  it("contains an object deleted via a @Tracked composed property set to null", () => {
    const tracker = new UnitOfWork();
    const parent = tracker.construct(() => new DeletableModel(tracker));
    const child = tracker.construct(() => new DeletableModel(tracker));
    tracker.withTrackingSuppressed(() => { parent.detail = child; });

    parent.detail = null; // child → Deleted

    expect(child.chronicleState).toBe(State.Deleted);
    expect(deletedObjects(tracker)).toContain(child);
  });

  it("does not contain an object after destroy()", () => {
    const tracker = new UnitOfWork();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    item.destroy();

    expect(deletedObjects(tracker)).not.toContain(item);
  });
});

// ---- Single-property composition lifecycle ----

describe("Entity — @Tracked single-property composition lifecycle", () => {
  it("1. Assigned: child is tracked as Insert", () => {
    const tracker = new UnitOfWork();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf = tracker.construct(() => new LeafModel(tracker));

    node.leaf = leaf;

    expect(leaf.chronicleState).toBe(State.Insert);
    expect(tracker._trackedObjects).toContain(leaf);
  });

  it("2. Replaced: old child is untracked (collapseInsert), new child is Insert", () => {
    const tracker = new UnitOfWork();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf1 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf1;
    const leaf2 = tracker.construct(() => new LeafModel(tracker));

    node.leaf = leaf2;

    expect(tracker._trackedObjects).not.toContain(leaf1);
    expect(tracker._trackedObjects).toContain(leaf2);
    expect(leaf2.chronicleState).toBe(State.Insert);
  });

  it("3. Replaced undone: old child is re-tracked as Insert, new child is untracked", () => {
    const tracker = new UnitOfWork();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf1 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf1;
    const leaf2 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf2;

    tracker.undo();

    expect(tracker._trackedObjects).toContain(leaf1);
    expect(leaf1.chronicleState).toBe(State.Insert);
    expect(tracker._trackedObjects).not.toContain(leaf2);
  });

  it("4. Replaced undone then redone: old child is untracked again, new child is re-tracked as Insert", () => {
    const tracker = new UnitOfWork();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf1 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf1;
    const leaf2 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf2;
    tracker.undo();

    tracker.redo();

    expect(tracker._trackedObjects).not.toContain(leaf1);
    expect(tracker._trackedObjects).toContain(leaf2);
    expect(leaf2.chronicleState).toBe(State.Insert);
  });

  it("validity flows correctly through replace → undo → redo", () => {
    const tracker = new UnitOfWork();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf1 = tracker.construct(() => new LeafModel(tracker)); // name="" → invalid
    node.leaf = leaf1;
    // leaf1 is invalid → tracker.isValid = false

    // leaf2 is constructed with a valid name (set during construct, suppressed)
    const leaf2 = tracker.construct(() => {
      const l = new LeafModel(tracker);
      l.name = "valid";
      return l;
    });
    node.leaf = leaf2; // leaf1 collapseInsert-untracked, leaf2 valid Insert
    expect(tracker.isValid).toBe(true);

    tracker.undo(); // leaf2 untracked, leaf1 re-tracked (invalid)
    expect(tracker.isValid).toBe(false);

    tracker.redo(); // leaf1 untracked, leaf2 re-tracked (valid)
    expect(tracker.isValid).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { DirtyTrackedObject } from "../src/DirtyTrackedObject";
import { Tracker } from "../src/Tracker";
import { DirtyTracker } from "../src/DirtyTracker";
import { Tracked } from "../src/Tracked";
import { TrackedCollection } from "../src/TrackedCollection";
import { State } from "../src/State";
import { Operation } from "../src/Operation";

// ---- Models ----

class InvoiceModel extends DirtyTrackedObject {
  @Tracked()
  accessor status: string = "";

  @Tracked()
  accessor note: string = "";

  readonly lines: TrackedCollection<string>;

  constructor(
    tracker: DirtyTracker,
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

class PersonModel extends DirtyTrackedObject {
  private _name: string = "";

  get name(): string {
    return this._name;
  }

  @Tracked()
  set name(value: string) {
    this._name = value;
  }

  constructor(tracker: DirtyTracker, initialName = "") {
    super(tracker);
    this.name = initialName;
  }
}

class ValidatedModel extends DirtyTrackedObject {
  @Tracked((_, v: string) => (!v ? "Required" : undefined))
  accessor status: string = "initial";

  @Tracked()
  accessor note: string = "";

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}

class RequiredNameModel extends DirtyTrackedObject {
  @Tracked((_, v: string) => (!v ? "Name is required" : undefined))
  accessor name: string = ""; // empty default → always invalid on construction

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}

// ---- Sequential changes ----

describe("DirtyTrackedObject – sequential changes create separate undo steps", () => {
  it("two sequential property changes create two undo steps", () => {
    const tracker = new DirtyTracker();
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
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker, "active", ["line-1"]));
    tracker.onCommit();

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
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker, "", ["a", "b"]));
    tracker.onCommit();

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

describe("DirtyTrackedObject – tracking suppression", () => {
  it("changes inside trackingSuppressed do not create undo entries", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
      invoice.lines.push("line-1");
    });

    expect(tracker.canUndo).toBe(false);
  });

  it("changes inside trackingSuppressed do not mark the tracker dirty", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
    });

    expect(tracker.isDirty).toBe(false);
  });

  it("values are still applied inside trackingSuppressed", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
      invoice.lines.push("line-1", "line-2");
    });

    expect(invoice.status).toBe("draft");
    expect(invoice.lines.length).toBe(2);
  });

  it("changes after trackingSuppressed are tracked normally", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.withTrackingSuppressed(() => {
      invoice.status = "draft";
    });
    invoice.status = "active";

    expect(tracker.canUndo).toBe(true);
    tracker.undo();
    expect(invoice.status).toBe("draft");
  });

  it("beginSuppressTracking / endSuppressTracking behave identically", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    tracker.beginSuppressTracking();
    invoice.status = "draft";
    invoice.lines.push("line-1");
    tracker.endSuppressTracking();

    expect(tracker.canUndo).toBe(false);
    expect(invoice.status).toBe("draft");
    expect(invoice.lines.length).toBe(1);
  });
});

// ---- @Tracked on get/set accessor ----

describe("DirtyTrackedObject – @Tracked on get/set accessor", () => {
  it("change is tracked and undoable", () => {
    const tracker = new DirtyTracker();
    const person = tracker.construct(() => new PersonModel(tracker, "Alice"));
    tracker.onCommit();

    person.name = "Bob";

    tracker.undo();
    expect(person.name).toBe("Alice");
    expect(tracker.isDirty).toBe(false);
  });

  it("undo then redo restores the change", () => {
    const tracker = new DirtyTracker();
    const person = tracker.construct(() => new PersonModel(tracker));

    person.name = "Bob";
    tracker.undo();
    tracker.redo();

    expect(person.name).toBe("Bob");
  });

  it("setting the same value does not create an undo step", () => {
    const tracker = new DirtyTracker();
    const person = tracker.construct(() => new PersonModel(tracker, "Alice"));
    tracker.onCommit();

    person.name = "Alice";

    expect(tracker.canUndo).toBe(false);
    expect(tracker.isDirty).toBe(false);
  });

  it("changes inside trackingSuppressed are not tracked", () => {
    const tracker = new DirtyTracker();
    const person = tracker.construct(() => new PersonModel(tracker));

    tracker.withTrackingSuppressed(() => {
      person.name = "Bob";
    });

    expect(person.name).toBe("Bob");
    expect(tracker.canUndo).toBe(false);
  });
});

// ---- coalesceWithin on explicit setter ----

class CoalesceSetterModel extends DirtyTrackedObject {
  private _note: string = "";

  get note(): string { return this._note; }

  @Tracked(undefined, undefined, { coalesceWithin: 5000 })
  set note(value: string) { this._note = value; }

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}

describe("DirtyTrackedObject – coalesceWithin on explicit get/set pair", () => {
  it("rapid writes to the same setter merge into one undo step", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new CoalesceSetterModel(tracker));

    model.note = "a";
    model.note = "b";

    tracker.undo();
    expect(model.note).toBe(""); // both changes undone together
    expect(tracker.canUndo).toBe(false);
  });
});

// ---- Events ----

describe("DirtyTrackedObject – isDirtyChanged", () => {
  it("fires with true when the tracker becomes dirty", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    invoice.status = "draft";

    expect(calls).toEqual([true]);
  });

  it("fires with false when the tracker becomes clean", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    tracker.undo();

    expect(calls).toEqual([false]);
  });

  it("does not fire when isDirty is already true", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    invoice.status = "active";

    expect(calls).toEqual([]);
  });

  it("does not fire when isDirty is already false", () => {
    const tracker = new DirtyTracker();
    tracker.construct(() => new InvoiceModel(tracker));
    const calls: boolean[] = [];
    tracker.isDirtyChanged.subscribe((v) => calls.push(v));

    tracker.undo();

    expect(calls).toEqual([]);
  });
});

describe("DirtyTrackedObject – isValidChanged", () => {
  it("fires with false when the tracker becomes invalid", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    tracker.onCommit();
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.status = "";

    expect(calls).toEqual([false]);
  });

  it("fires with true when the tracker becomes valid again", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    model.status = "";
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.status = "active";

    expect(calls).toEqual([true]);
  });

  it("does not fire when isValid is already false", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    model.status = "";
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.note = "x";

    expect(calls).toEqual([]);
  });

  it("does not fire when isValid is already true", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    const calls: boolean[] = [];
    tracker.isValidChanged.subscribe((v) => calls.push(v));

    model.note = "x";

    expect(calls).toEqual([]);
  });
});

describe("DirtyTrackedObject – canCommitChanged", () => {
  it("fires with true when isDirty becomes true and isValid is already true", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    invoice.status = "draft";

    expect(calls).toEqual([true]);
  });

  it("fires with false when isDirty becomes false", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    tracker.undo();

    expect(calls).toEqual([false]);
  });

  it("fires with false when isValid becomes false while isDirty is true", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    model.status = "active";
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    model.status = "";

    expect(calls).toEqual([false]);
  });

  it("does not fire when isDirty becomes true but isValid is false", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new ValidatedModel(tracker));
    tracker.withTrackingSuppressed(() => { model.status = ""; });
    tracker.revalidate();
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    model.note = "x";

    expect(calls).toEqual([]);
  });

  it("does not fire when a second change is made while already dirty and valid", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));
    invoice.status = "draft";
    const calls: boolean[] = [];
    tracker.canCommitChanged.subscribe((v) => calls.push(v));

    invoice.status = "active";

    expect(calls).toEqual([]);
  });
});

// ---- DirtyTrackedObject – construct() ----

describe("DirtyTrackedObject – construct()", () => {
  it("validates all objects and updates tracker.isValid after the lambda", () => {
    const tracker = new DirtyTracker();
    expect(tracker.isValid).toBe(true);

    tracker.construct(() => new RequiredNameModel(tracker));

    expect(tracker.isValid).toBe(false);
  });

  it("suppresses tracking during construction (canUndo is false)", () => {
    const tracker = new DirtyTracker();

    tracker.construct(() => new RequiredNameModel(tracker));

    expect(tracker.canUndo).toBe(false);
  });

  it("returns the constructed object", () => {
    const tracker = new DirtyTracker();

    const model = tracker.construct(() => new RequiredNameModel(tracker));

    expect(model).toBeInstanceOf(RequiredNameModel);
    expect(tracker.trackedObjects).toContain(model);
  });

  it("throws when constructing outside construct()", () => {
    const tracker = new DirtyTracker();

    expect(() => new RequiredNameModel(tracker)).toThrow();
  });

  it("handles multiple objects (only one revalidation at the end)", () => {
    const tracker = new DirtyTracker();

    const models = tracker.construct(() => {
      const a = new RequiredNameModel(tracker);
      const b = new RequiredNameModel(tracker);
      const c = new RequiredNameModel(tracker);
      return [a, b, c];
    });

    expect(tracker.trackedObjects.length).toBe(3);
    expect(tracker.isValid).toBe(false);
    expect(tracker.canUndo).toBe(false);
  });

  it("isValid correctly reflects validity after construct() with invalid objects", () => {
    const tracker = new DirtyTracker();

    tracker.construct(() => new RequiredNameModel(tracker));
    tracker.construct(() => new RequiredNameModel(tracker));

    expect(tracker.isValid).toBe(false);
    expect(tracker.trackedObjects.length).toBe(2);
  });

  it("model.isValid, model.validationMessages, and tracker.isValid are all set after construct() with invalid initial data", () => {
    const tracker = new DirtyTracker();

    const model = tracker.construct(() => new RequiredNameModel(tracker));

    expect(model.trakrIsValid).toBe(false);
    expect(model.validationMessages.get("name")).toBe("Name is required");
    expect(tracker.isValid).toBe(false);
  });

  it("undo push of invalid constructed item removes ghost and restores tracker.isValid", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<RequiredNameModel>(tracker);
    const item = tracker.construct(() => new RequiredNameModel(tracker));
    expect(tracker.isValid).toBe(false); // invalid before push (name is empty)

    items.push(item);
    tracker.undo();

    expect(tracker.trackedObjects).not.toContain(item);
    expect(tracker.isValid).toBe(true);
  });

  it("redo push of invalid item re-tracks and restores tracker.isValid to false", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<RequiredNameModel>(tracker);
    const item = tracker.construct(() => new RequiredNameModel(tracker));
    items.push(item);
    tracker.undo(); // untracked, tracker.isValid = true

    tracker.redo();

    expect(tracker.trackedObjects).toContain(item);
    expect(tracker.isValid).toBe(false); // invalid contribution restored
  });
});

// ---- Models for the sections below ----

class CoalesceModel extends DirtyTrackedObject {
  @Tracked(undefined, undefined, { coalesceWithin: 5000 })
  accessor note: string = "";

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}

class CapturingModel extends DirtyTrackedObject {
  capturedOp: Operation | undefined;

  @Tracked()
  accessor value: number = 0;

  override _onCommitted(lastOp?: Operation): void {
    super._onCommitted(lastOp);
    this.capturedOp = lastOp;
  }

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}

// ---- coalesceWithin option ----

describe("DirtyTrackedObject — coalesceWithin option", () => {
  it("two rapid changes to the same property merge into one undo step", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new CoalesceModel(tracker));

    model.note = "a";
    model.note = "b";

    tracker.undo();
    expect(model.note).toBe(""); // both changes undone together (coalesced)
    expect(tracker.canUndo).toBe(false);
  });

  it("a property without coalesceWithin never merges — each write is its own undo step", () => {
    const tracker = new DirtyTracker();
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

class NumModel extends DirtyTrackedObject {
  @Tracked() accessor qty: number = 0;
  constructor(t: DirtyTracker) { super(t); }
}

describe("DirtyTrackedObject — without coalesceWithin, writes never merge", () => {
  it("rapid changes to the same string property are separate undo steps", () => {
    const tracker = new DirtyTracker();
    const invoice = tracker.construct(() => new InvoiceModel(tracker));

    invoice.status = "a";
    invoice.status = "b";

    tracker.undo();
    expect(invoice.status).toBe("a"); // second change undone on its own

    tracker.undo();
    expect(invoice.status).toBe(""); // first change undone
  });

  it("rapid changes to the same number property are separate undo steps", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new NumModel(tracker));

    model.qty = 1;
    model.qty = 2;

    tracker.undo();
    expect(model.qty).toBe(1);
    tracker.undo();
    expect(model.qty).toBe(0);
  });
});

// ---- _isInUndoStack ----

describe("DirtyTrackedObject — Tracker._isInUndoStack()", () => {
  it("returns true for an operation that is in the undo stack", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new CapturingModel(tracker));

    model.value = 5;
    tracker.onCommit();

    expect(model.capturedOp).toBeDefined();
    expect(tracker._isInUndoStack(model.capturedOp!)).toBe(true);
  });

  it("returns false for an operation that has been moved to the redo stack via undo", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new CapturingModel(tracker));

    model.value = 5;
    tracker.onCommit();
    const op = model.capturedOp!;

    tracker.undo(); // moves op to redo stack

    expect(tracker._isInUndoStack(op)).toBe(false);
  });

  it("returns true again after redo puts the operation back in the undo stack", () => {
    const tracker = new DirtyTracker();
    const model = tracker.construct(() => new CapturingModel(tracker));

    model.value = 5;
    tracker.onCommit();
    const op = model.capturedOp!;

    tracker.undo();
    tracker.redo(); // moves op back to undo stack

    expect(tracker._isInUndoStack(op)).toBe(true);
  });

  it("returns false for an operation that was never added to the undo stack", () => {
    const tracker = new DirtyTracker();
    const foreign = new Operation();
    expect(tracker._isInUndoStack(foreign)).toBe(false);
  });
});

// ---- Tracker.deletedObjects ----

class DeletableModel extends DirtyTrackedObject {
  @Tracked()
  accessor detail: DeletableModel | null = null;

  constructor(tracker: DirtyTracker) { super(tracker); }
}

// ---- Single-property composition lifecycle ----

class LeafModel extends DirtyTrackedObject {
  @Tracked((_, v: string) => (!v ? "Required" : undefined))
  accessor name: string = "";

  constructor(tracker: DirtyTracker) { super(tracker); }
}

class NodeModel extends DirtyTrackedObject {
  @Tracked()
  accessor leaf: LeafModel | null = null;

  constructor(tracker: DirtyTracker) { super(tracker); }
}

describe("Tracker.deletedObjects", () => {
  it("is empty when no objects are deleted", () => {
    const tracker = new DirtyTracker();
    tracker.construct(() => new DeletableModel(tracker));
    expect(tracker.deletedObjects).toHaveLength(0);
  });

  it("contains an object removed from a TrackedCollection", () => {
    const tracker = new DirtyTracker();
    const item = tracker.construct(() => new DeletableModel(tracker));
    tracker.withTrackingSuppressed(() => {});
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);

    expect(tracker.deletedObjects).toContain(item);
  });

  it("does not contain an item that collapsed Insert → Unchanged on remove", () => {
    const tracker = new DirtyTracker();
    const items = new TrackedCollection<DeletableModel>(tracker);
    const item = tracker.construct(() => new DeletableModel(tracker));
    items.push(item);
    items.remove(item);

    expect(item.trakrState).toBe(State.Unchanged);
    expect(tracker.deletedObjects).not.toContain(item);
  });

  it("disappears from deletedObjects after undo of remove", () => {
    const tracker = new DirtyTracker();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();

    expect(tracker.deletedObjects).not.toContain(item);
  });

  it("reappears in deletedObjects after redo of remove", () => {
    const tracker = new DirtyTracker();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker.undo();
    tracker.redo();

    expect(tracker.deletedObjects).toContain(item);
  });

  it("is empty after commit of a delete (state → Unchanged)", () => {
    const tracker = new DirtyTracker();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker.onCommit();

    expect(tracker.deletedObjects).not.toContain(item);
  });

  it("reappears after undoing a committed delete (state → Insert)", () => {
    const tracker = new DirtyTracker();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    tracker.onCommit();
    tracker.undo();

    // state is Insert after committed delete undo — not Deleted
    expect(item.trakrState).toBe(State.Insert);
    expect(tracker.deletedObjects).not.toContain(item);
  });

  it("contains an object deleted via a @Tracked composed property set to null", () => {
    const tracker = new DirtyTracker();
    const parent = tracker.construct(() => new DeletableModel(tracker));
    const child = tracker.construct(() => new DeletableModel(tracker));
    tracker.withTrackingSuppressed(() => { parent.detail = child; });

    parent.detail = null; // child → Deleted

    expect(child.trakrState).toBe(State.Deleted);
    expect(tracker.deletedObjects).toContain(child);
  });

  it("does not contain an object after destroy()", () => {
    const tracker = new DirtyTracker();
    const item = tracker.construct(() => new DeletableModel(tracker));
    const coll = new TrackedCollection<DeletableModel>(tracker, [item]);
    coll.remove(item);
    item.destroy();

    expect(tracker.deletedObjects).not.toContain(item);
  });
});

// ---- Single-property composition lifecycle ----

describe("DirtyTrackedObject — @Tracked single-property composition lifecycle", () => {
  it("1. Assigned: child is tracked as Insert", () => {
    const tracker = new DirtyTracker();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf = tracker.construct(() => new LeafModel(tracker));

    node.leaf = leaf;

    expect(leaf.trakrState).toBe(State.Insert);
    expect(tracker.trackedObjects).toContain(leaf);
  });

  it("2. Replaced: old child is untracked (collapseInsert), new child is Insert", () => {
    const tracker = new DirtyTracker();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf1 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf1;
    const leaf2 = tracker.construct(() => new LeafModel(tracker));

    node.leaf = leaf2;

    expect(tracker.trackedObjects).not.toContain(leaf1);
    expect(tracker.trackedObjects).toContain(leaf2);
    expect(leaf2.trakrState).toBe(State.Insert);
  });

  it("3. Replaced undone: old child is re-tracked as Insert, new child is untracked", () => {
    const tracker = new DirtyTracker();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf1 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf1;
    const leaf2 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf2;

    tracker.undo();

    expect(tracker.trackedObjects).toContain(leaf1);
    expect(leaf1.trakrState).toBe(State.Insert);
    expect(tracker.trackedObjects).not.toContain(leaf2);
  });

  it("4. Replaced undone then redone: old child is untracked again, new child is re-tracked as Insert", () => {
    const tracker = new DirtyTracker();
    const node = tracker.construct(() => new NodeModel(tracker));
    const leaf1 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf1;
    const leaf2 = tracker.construct(() => new LeafModel(tracker));
    node.leaf = leaf2;
    tracker.undo();

    tracker.redo();

    expect(tracker.trackedObjects).not.toContain(leaf1);
    expect(tracker.trackedObjects).toContain(leaf2);
    expect(leaf2.trakrState).toBe(State.Insert);
  });

  it("validity flows correctly through replace → undo → redo", () => {
    const tracker = new DirtyTracker();
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

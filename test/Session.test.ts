import { describe, it, expect, vi } from "vitest";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Tracked } from "../packages/core/src/Tracked";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { State } from "../packages/unit-of-work/src/State";

// ---- Models ----

class PersonModel extends Entity {
  @Tracked()
  accessor firstName: string = "";

  @Tracked()
  accessor lastName: string = "";

  @Tracked((_, v: string) => (!v ? "Email is required" : undefined))
  accessor email: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

class OrderModel extends Entity {
  @Tracked()
  accessor status: string = "";

  readonly lines: TrackedCollection<string>;

  constructor(tracker: UnitOfWork) {
    super(tracker);
    this.lines = new TrackedCollection<string>(tracker);
  }
}

// ---- session.end() ----

describe("Tracker – session.end()", () => {
  it("merges multiple property changes into one undo step", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    person.lastName = "Smith";
    person.email = "alice@example.com";
    session.end();

    expect(tracker.canUndo).toBe(true);

    tracker.undo();

    expect(person.firstName).toBe("");
    expect(person.lastName).toBe("");
    expect(person.email).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("produces exactly one undo step regardless of how many changes were made", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "A";
    person.lastName = "B";
    person.email = "c@d.com";
    session.end();

    tracker.undo();
    expect(tracker.canUndo).toBe(false);
  });

  it("redo after undo restores all coalesced changes", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    person.lastName = "Smith";
    session.end();

    tracker.undo();
    tracker.redo();

    expect(person.firstName).toBe("Alice");
    expect(person.lastName).toBe("Smith");
  });

  it("changes before startComposing remain as separate undo steps", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    person.email = "before@example.com";

    const session = tracker._startSession();
    person.firstName = "Alice";
    person.lastName = "Smith";
    session.end();

    tracker.undo(); // reverts firstName + lastName together
    expect(person.firstName).toBe("");
    expect(person.lastName).toBe("");
    expect(person.email).toBe("before@example.com");
    expect(tracker.canUndo).toBe(true);

    tracker.undo(); // reverts the earlier email change
    expect(person.email).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("handles a single change inside the session window (no merge needed)", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    session.end();

    tracker.undo();
    expect(person.firstName).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("with no changes inside the window, undo stack is unaffected", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    session.end();

    expect(tracker.canUndo).toBe(false);
  });

  it("works across multiple objects", () => {
    const tracker = new UnitOfWork();
    const { person, order } = tracker.construct(() => ({
      person: new PersonModel(tracker),
      order: new OrderModel(tracker),
    }));

    const session = tracker._startSession();
    person.firstName = "Alice";
    order.status = "draft";
    session.end();

    tracker.undo();

    expect(person.firstName).toBe("");
    expect(order.status).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("works with collection mutations", () => {
    const tracker = new UnitOfWork();
    const order = tracker.construct(() => new OrderModel(tracker));

    const session = tracker._startSession();
    order.status = "draft";
    order.lines.push("line-1");
    order.lines.push("line-2");
    session.end();

    tracker.undo();

    expect(order.status).toBe("");
    expect(order.lines.length).toBe(0);
    expect(tracker.canUndo).toBe(false);
  });

  it("second call to _startSession while a session is active returns the same session", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    const session2 = tracker._startSession(); // no-op — returns same session
    expect(session2).toBe(session);
    person.lastName = "Smith";
    session.end();

    tracker.undo();

    expect(person.firstName).toBe("");
    expect(person.lastName).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("tracker is dirty after session.end() when changes were made", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => new PersonModel(tracker));
    const person = tracker._trackedObjects[0] as PersonModel;

    const session = tracker._startSession();
    person.firstName = "Alice";
    session.end();

    expect(tracker.isDirty).toBe(true);
  });

  it("isDirty is preserved after session.end() with no changes when tracker was already dirty", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    person.firstName = "Alice"; // tracker is dirty

    const session = tracker._startSession();
    session.end(); // no changes inside

    expect(tracker.isDirty).toBe(true);
    expect(tracker.canUndo).toBe(true);
  });

  it("single-change session: canRedo is false after session.end() when session undo cleared redo", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    tracker.undo(); // firstName undone → in redo; composed will have 0 ops, but this tests the single-op branch via a prior state
    person.lastName = "Smith"; // one op remains after undo clears redo
    session.end(); // composed=[lastName op] — single op, redo should be empty

    expect(tracker.canRedo).toBe(false);
  });
});

// ---- undo/redo while composing is active ----

describe("Tracker – undo/redo during an active composing session", () => {
  it("undo works inside the session — undone change is excluded from the merged step", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    person.lastName = "Smith";
    tracker.undo(); // undo lastName — only firstName remains applied
    session.end();

    expect(person.firstName).toBe("Alice");
    expect(person.lastName).toBe("");

    tracker.undo(); // reverts the merged step (only firstName)
    expect(person.firstName).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("session.end() discards redo entries generated inside the session", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    tracker.undo(); // firstName undone → sits in redo
    session.end(); // session closed with no net changes

    // The redo entry from inside the session must not be accessible
    expect(tracker.canRedo).toBe(false);
  });

  it("session.rollback() discards redo entries generated inside the session", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    tracker.undo(); // firstName undone → sits in redo
    session.rollback();

    // The redo entry from inside the session must not be accessible
    expect(tracker.canRedo).toBe(false);
    expect(person.firstName).toBe("");
  });

  it("pre-existing redo entries are preserved when the session makes no new writes", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    person.firstName = "Alice";
    tracker.undo(); // firstName in redo

    const session = tracker._startSession();
    // no writes inside
    session.end();

    // pre-existing redo entry should still be there
    expect(tracker.canRedo).toBe(true);
    tracker.redo();
    expect(person.firstName).toBe("Alice");
  });
});

// ---- session.rollback() ----

describe("Tracker – session.rollback()", () => {
  it("reverts all changes made since startComposing", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    person.lastName = "Smith";
    person.email = "alice@example.com";
    session.rollback();

    expect(person.firstName).toBe("");
    expect(person.lastName).toBe("");
    expect(person.email).toBe("");
  });

  it("does not add any entry to the undo stack", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    session.rollback();

    expect(tracker.canUndo).toBe(false);
  });

  it("tracker is not dirty after session.rollback() when it was clean before", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    const session = tracker._startSession();
    person.firstName = "Alice";
    session.rollback();

    expect(tracker.isDirty).toBe(false);
  });

  it("pre-existing undo steps are preserved after session.rollback()", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    person.email = "before@example.com";

    const session = tracker._startSession();
    person.firstName = "Alice";
    person.lastName = "Smith";
    session.rollback();

    expect(person.firstName).toBe("");
    expect(person.lastName).toBe("");
    expect(person.email).toBe("before@example.com");
    expect(tracker.canUndo).toBe(true);

    tracker.undo();
    expect(person.email).toBe("");
  });

  it("with no changes inside the window, rollback is a no-op", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));

    person.firstName = "Alice";

    const session = tracker._startSession();
    session.rollback();

    expect(person.firstName).toBe("Alice");
    expect(tracker.canUndo).toBe(true);
  });

  it("reverts collection mutations", () => {
    const tracker = new UnitOfWork();
    const order = tracker.construct(() => new OrderModel(tracker));

    const session = tracker._startSession();
    order.status = "draft";
    order.lines.push("line-1");
    order.lines.push("line-2");
    session.rollback();

    expect(order.status).toBe("");
    expect(order.lines.length).toBe(0);
    expect(tracker.canUndo).toBe(false);
  });

  it("restores validation state after rollback", () => {
    const tracker = new UnitOfWork();
    // Set the initial email during construction (suppressed) so the tracker starts clean.
    const person = tracker.construct(() => {
      const p = new PersonModel(tracker);
      p.email = "valid@example.com";
      return p;
    });
    expect(tracker.isValid).toBe(true);
    expect(tracker.canUndo).toBe(false);

    const session = tracker._startSession();
    person.email = ""; // makes invalid — first tracked write to this property
    expect(tracker.isValid).toBe(false);
    session.rollback();

    expect(person.email).toBe("valid@example.com");
    expect(tracker.isValid).toBe(true);
  });
});

// ---- ITrackerContext on TrackerSession ----

describe("TrackerSession – ITrackerContext: scoped isDirty / isValid / canCommit", () => {
  it("isDirty is false initially with a scope", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession([[person, ["firstName"]]]);
    expect(session.isDirty).toBe(false);
  });

  it("isDirty becomes true when a scoped property is written", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession([[person, ["firstName"]]]);
    person.firstName = "Alice";
    expect(session.isDirty).toBe(true);
  });

  it("isDirty stays false when an out-of-scope property is written", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession([[person, ["firstName"]]]);
    person.lastName = "Smith";
    expect(session.isDirty).toBe(false);
  });

  it("isDirty defaults to false when no scope is provided", () => {
    const tracker = new UnitOfWork();
    const session = tracker._startSession();
    expect(session.isDirty).toBe(false);
  });

  it("isValid is false when a scoped property has a validation error", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession([[person, ["email"]]]);
    // email starts empty — validator fires during construct
    expect(session.isValid).toBe(false);
  });

  it("isValid is true when all scoped properties pass validation", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => {
      const p = new PersonModel(tracker);
      p.email = "valid@example.com";
      return p;
    });
    const session = tracker._startSession([[person, ["email"]]]);
    expect(session.isValid).toBe(true);
  });

  it("isValid ignores validation errors on out-of-scope properties", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    // email is invalid but not in scope
    const session = tracker._startSession([[person, ["firstName"]]]);
    expect(session.isValid).toBe(true);
  });

  it("isValid defaults to true when no scope is provided", () => {
    const tracker = new UnitOfWork();
    const session = tracker._startSession();
    expect(session.isValid).toBe(true);
  });

  it("canCommit is true when isDirty and isValid", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => {
      const p = new PersonModel(tracker);
      p.email = "valid@example.com";
      return p;
    });
    const session = tracker._startSession([[person, ["firstName", "email"]]]);
    person.firstName = "Alice";
    expect(session.canCommit).toBe(true);
  });

  it("canCommit is false when not dirty", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => {
      const p = new PersonModel(tracker);
      p.email = "valid@example.com";
      return p;
    });
    const session = tracker._startSession([[person, ["firstName"]]]);
    expect(session.canCommit).toBe(false);
  });

  it("canCommit is false when dirty but invalid", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession([[person, ["email"]]]);
    person.email = "x";
    person.email = "";  // back to invalid
    expect(session.isDirty).toBe(true);
    expect(session.isValid).toBe(false);
    expect(session.canCommit).toBe(false);
  });
});

describe("TrackerSession – ITrackerContext: _trackedObjects / deletedObjects", () => {
  it("_trackedObjects returns the scoped objects", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession([[person, ["firstName"]]]);
    expect(session.trackedObjects).toEqual([person]);
  });

  it("_trackedObjects returns empty array when no scope", () => {
    const tracker = new UnitOfWork();
    const session = tracker._startSession();
    expect(session.trackedObjects).toEqual([]);
  });

  it("deletedObjects returns scoped objects in Deleted state", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const people = new TrackedCollection<PersonModel>(tracker, [person]);
    tracker._onCommit(); // person → Unchanged so removal marks it Deleted
    const session = tracker._startSession([[person, ["firstName"]]]);
    people.remove(person);
    expect(person.chronicleState).toBe(State.Deleted);
    expect(session.deletedObjects).toEqual([person]);
  });

  it("deletedObjects is empty when no scoped object is deleted", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession([[person, ["firstName"]]]);
    expect(session.deletedObjects).toEqual([]);
  });
});

describe("TrackerSession – ITrackerContext: canUndo / canRedo / undo() / redo()", () => {
  it("canUndo delegates to tracker", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession();
    expect(session.canUndo).toBe(false);
    person.firstName = "Alice";
    session.end();
    expect(session.canUndo).toBe(true);
  });

  it("canRedo delegates to tracker", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    person.firstName = "Alice";
    expect(tracker.canRedo).toBe(false);
    tracker.undo();
    const session = tracker._startSession();
    expect(session.canRedo).toBe(true);
  });

  it("undo() delegates to tracker", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    person.firstName = "Alice";
    const session = tracker._startSession();
    session.undo();
    expect(person.firstName).toBe("");
    session.end();
  });

  it("redo() delegates to tracker", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    person.firstName = "Alice";
    tracker.undo();
    const session = tracker._startSession();
    session.redo();
    expect(person.firstName).toBe("Alice");
    session.end();
  });
});

describe("TrackerSession – ITrackerContext: events delegate to tracker", () => {
  it("isDirtyChanged fires when tracker dirty state changes", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession();
    const handler = vi.fn();
    session.isDirtyChanged.subscribe(handler);
    person.firstName = "Alice";
    session.end();
    expect(handler).toHaveBeenCalledWith(true);
  });

  it("canCommitChanged fires when tracker canCommit changes", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => {
      const p = new PersonModel(tracker);
      p.email = "valid@example.com";
      return p;
    });
    const session = tracker._startSession();
    const handler = vi.fn();
    session.canCommitChanged.subscribe(handler);
    person.firstName = "Alice";
    session.end();
    expect(handler).toHaveBeenCalledWith(true);
  });

  it("changed fires on every tracked write", () => {
    const tracker = new UnitOfWork();
    const person = tracker.construct(() => new PersonModel(tracker));
    const session = tracker._startSession();
    const handler = vi.fn();
    session.changed.subscribe(handler);
    person.firstName = "Alice";
    expect(handler).toHaveBeenCalledWith({ version: 1 });
    session.end();
  });

});

/**
 * Undo, redo, discard and rollback revalidate what depends on what they
 * changed: validators that read another object, a collection, or that a
 * collection validator reads. Also for objects out of the model meanwhile.
 */
import { describe, it, expect } from "vitest";
import { UnitOfWork, Entity, EntityContainer, TrackedCollection, Tracked } from "@katn30/chronicle-unit-of-work";
import { EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, Id, AutoId } from "@katn30/chronicle-event-log";

// ---------------------------------------------------------------------------- UnitOfWork models

class Budget extends Entity {
  @Tracked() accessor limit: number = 10;
  constructor(t: UnitOfWork) { super(t); }
}

/** `amount` depends on another object's property. */
class Expense extends Entity {
  @Tracked((self: Expense, v: number) => (v > self.budget.limit ? "over budget" : undefined)) accessor amount: number = 0;
  constructor(t: UnitOfWork, readonly budget: Budget) { super(t); }
}

class Item extends Entity {
  @Tracked((_s, v: number) => (v < 0 ? "negative" : undefined)) accessor v: number = 0;
  constructor(t: UnitOfWork, v = 0) { super(t); this.v = v; }
}

/** `note` depends on the collection; the collection's validator depends on `max`. */
class Cart extends EntityContainer {
  @Tracked() accessor max: number = 2;
  @Tracked((self: Cart, v: string) => (v === "" && self.items.length > 0 ? "note required" : undefined)) accessor note: string = "";
  readonly items: TrackedCollection<Item>;
  constructor(t: UnitOfWork) {
    super(t);
    this.items = new TrackedCollection<Item>(t, [], (items) => (items.length > this.max ? "too many" : undefined));
    this.trackChild(this.items);
  }
}

function uow() {
  const tracker = new UnitOfWork();
  const budget = tracker.construct(() => new Budget(tracker));
  const expense = tracker.construct(() => new Expense(tracker, budget));
  const cart = tracker.construct(() => new Cart(tracker));
  return { tracker, budget, expense, cart };
}

describe("UnitOfWork — undo and redo revalidate what depends on what they change", () => {
  it("a property validator reading another object", () => {
    const { tracker, budget, expense } = uow();
    expense.amount = 8;
    budget.limit = 5;
    expect([expense.chronicleIsValid, tracker.isValid]).toEqual([false, false]);
    tracker.undo();                                 // limit back to 10
    expect([expense.chronicleIsValid, tracker.isValid]).toEqual([true, true]);
    tracker.redo();
    expect([expense.chronicleIsValid, tracker.isValid]).toEqual([false, false]);
  });

  it("a property validator reading a collection", () => {
    const { tracker, cart } = uow();
    cart.items.push(tracker.new(() => new Item(tracker)));
    expect(cart.chronicleIsValid).toBe(false);      // a note is required once there are items
    tracker.undo();
    expect([cart.chronicleIsValid, tracker.isValid]).toEqual([true, true]);
    tracker.redo();
    expect([cart.chronicleIsValid, tracker.isValid]).toEqual([false, false]);
  });

  it("a collection validator reading another property", () => {
    const { tracker, cart } = uow();
    cart.note = "n";
    cart.items.push(tracker.new(() => new Item(tracker)), tracker.new(() => new Item(tracker)));
    cart.max = 1;
    expect([cart.items.error, tracker.isValid]).toEqual(["too many", false]);
    tracker.undo();                                 // max back to 2
    expect([cart.items.error, tracker.isValid]).toEqual([undefined, true]);
    tracker.redo();
    expect([cart.items.error, tracker.isValid]).toEqual(["too many", false]);
  });

  it("discard revalidates what it reverts", () => {
    const { tracker, budget, expense } = uow();
    expense.amount = 8;
    budget.limit = 5;
    tracker.discardPendingChanges();
    expect([expense.amount, budget.limit, expense.chronicleIsValid, tracker.isValid]).toEqual([0, 10, true, true]);
  });

  it("a failed batch revalidates what it reverts", () => {
    const { tracker, budget, expense } = uow();
    expense.amount = 8;
    expect(() => tracker.batch(() => { budget.limit = 5; throw new Error("cancelled"); })).toThrow();
    expect([budget.limit, expense.chronicleIsValid, tracker.isValid]).toEqual([10, true, true]);
  });

  it("an object out of the model keeps a current validity: put back, it counts as it is", () => {
    const { tracker, cart } = uow();
    cart.note = "n";
    const item = tracker.new(() => new Item(tracker, -1));
    cart.items.push(item);
    item.v = 1;                                     // valid now
    tracker.undo();                                 // invalid again
    tracker.undo();                                 // out of the model: it does not count
    expect([item.chronicleIsValid, tracker.isValid]).toEqual([false, true]);
    cart.items.push(item);
    expect([item.chronicleIsValid, tracker.isValid]).toEqual([false, false]);
  });

  it("the same, when discard reverts the edit and the addition together", () => {
    const { tracker, cart } = uow();
    cart.note = "n";
    const item = tracker.new(() => new Item(tracker, -1));
    cart.items.push(item);
    item.v = 1;
    tracker.discardPendingChanges();
    cart.items.push(item);
    expect([item.v, item.chronicleIsValid, tracker.isValid]).toEqual([-1, false, false]);
  });
});

// ---------------------------------------------------------------------------- EventLog models

class Card extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked() accessor points: number = 0;
  constructor(t: EventLog, points = 0) { super(t); this.points = points; }
}

class Sprint extends TrackedContainer {
  @Id id = "s";
  @EventTracked() accessor capacity: number = 5;
  @EventTracked((self: Sprint, v: string) => (v === "" && self.cards.length > 0 ? "goal required" : undefined)) accessor goal: string = "";
  readonly cards: EventTrackedCollection<Card>;
  constructor(t: EventLog) {
    super(t);
    this.cards = new EventTrackedCollection<Card>(t, "cards", [], (cards) =>
      (cards.reduce((sum, c) => sum + c.points, 0) > this.capacity ? "over capacity" : undefined));
    this.trackChild(this.cards);
  }
}

describe("EventLog — undo and redo revalidate what depends on what they change", () => {
  it("a collection validator reading its items and another property", () => {
    const tracker = new EventLog();
    const sprint = tracker.construct(() => new Sprint(tracker));
    sprint.goal = "g";
    const card = tracker.new(() => new Card(tracker, 3));
    sprint.cards.push(card);
    card.points = 8;
    expect([sprint.cards.error, tracker.isValid]).toEqual(["over capacity", false]);
    tracker.undo();                                 // points back to 3
    expect([sprint.cards.error, tracker.isValid]).toEqual([undefined, true]);
    sprint.capacity = 2;
    expect(sprint.cards.error).toBe("over capacity");
    tracker.undo();                                 // capacity back to 5
    expect([sprint.cards.error, tracker.isValid]).toEqual([undefined, true]);
    tracker.redo();
    expect([sprint.cards.error, tracker.isValid]).toEqual(["over capacity", false]);
  });

  it("a property validator reading a collection", () => {
    const tracker = new EventLog();
    const sprint = tracker.construct(() => new Sprint(tracker));
    sprint.cards.push(tracker.new(() => new Card(tracker)));
    expect(sprint.chronicleIsValid).toBe(false);
    tracker.undo();
    expect([sprint.chronicleIsValid, tracker.isValid]).toEqual([true, true]);
    tracker.redo();
    expect([sprint.chronicleIsValid, tracker.isValid]).toEqual([false, false]);
  });
});

/**
 * Validators never run on a half-built model: what construct() / new() create
 * is validated once the outermost construction ends, so a validator can read
 * anything the constructor builds, and records it as a dependency.
 */
import { describe, it, expect } from "vitest";
import { EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, Id } from "@katn30/chronicle-event-log";
import { UnitOfWork, Entity, EntityContainer, TrackedCollection, Tracked } from "@katn30/chronicle-unit-of-work";

// ---------------------------------------------------------------------------- two collections that read each other

interface ProductRef { id: string }
interface AssetRef { id: string; type: "affected" | "other" }

/** The application's case: each collection's validator reads the other one. No guards. */
class Issue extends TrackedContainer {
  @Id id = "i";
  readonly dataProducts: EventTrackedCollection<ProductRef>;
  readonly linkedAssets: EventTrackedCollection<AssetRef>;

  constructor(t: EventLog, products: ProductRef[] = [], assets: AssetRef[] = []) {
    super(t);
    this.dataProducts = new EventTrackedCollection<ProductRef>(t, "dataProducts", products, (items) => this.requireOne(items.length));
    this.linkedAssets = new EventTrackedCollection<AssetRef>(t, "assets", assets, (items) =>
      (items.some((a) => a.type === "affected") ? undefined : this.requireOne(this.dataProducts.length)));
    this.trackChild(this.dataProducts);
    this.trackChild(this.linkedAssets);
  }

  private requireOne(products: number): string | undefined {
    const affected = [...this.linkedAssets].some((a) => a.type === "affected");
    return products > 0 || affected ? undefined : "a data product or an affected asset is required";
  }
}

const errors = (issue: Issue) => [issue.dataProducts.error, issue.linkedAssets.error];
const REQUIRED = "a data product or an affected asset is required";

describe.each([
  ["construct()", (t: EventLog) => t.construct(() => new Issue(t))],
  ["new()", (t: EventLog) => t.new(() => new Issue(t))],
])("two collections whose validators read each other, built by %s", (_name, build) => {
  it("are validated once both exist", () => {
    const tracker = new EventLog();
    const issue = build(tracker);
    expect(errors(issue)).toEqual([REQUIRED, REQUIRED]);
    expect(tracker.isValid).toBe(false);
  });

  it("a change to either one revalidates the other", () => {
    const tracker = new EventLog();
    const issue = build(tracker);
    issue.linkedAssets.push({ id: "a", type: "affected" });
    expect(errors(issue)).toEqual([undefined, undefined]);
    issue.linkedAssets.clear();
    expect(errors(issue)).toEqual([REQUIRED, REQUIRED]);
    issue.dataProducts.push({ id: "p" });
    expect(errors(issue)).toEqual([undefined, undefined]);
    expect(tracker.isValid).toBe(true);
  });

  it("and so do undo and redo", () => {
    const tracker = new EventLog();
    const issue = build(tracker);
    issue.linkedAssets.push({ id: "a", type: "affected" });
    tracker.undo();
    expect([...errors(issue), tracker.isValid]).toEqual([REQUIRED, REQUIRED, false]);
    tracker.redo();
    expect([...errors(issue), tracker.isValid]).toEqual([undefined, undefined, true]);
  });
});

it("initial items count: an issue loaded with an affected asset is valid", () => {
  const tracker = new EventLog();
  const issue = tracker.construct(() => new Issue(tracker, [], [{ id: "a", type: "affected" }]));
  expect([...errors(issue), tracker.isValid]).toEqual([undefined, undefined, true]);
  issue.linkedAssets.clear();
  expect([...errors(issue), tracker.isValid]).toEqual([REQUIRED, REQUIRED, false]);
});

// ---------------------------------------------------------------------------- reading what the constructor builds later

class Meta extends TrackedObject {
  @EventTracked() accessor limit: number = 2;
  constructor(t: EventLog) { super(t); }
}

class Board extends TrackedContainer {
  @Id id = "b";
  // Reads `meta`, which the constructor creates after this collection.
  readonly cards = new EventTrackedCollection<string>(this.tracker, "cards", [], (cards) =>
    (cards.length > this.meta.limit ? "too many" : undefined));
  readonly meta: Meta;
  constructor(t: EventLog) {
    super(t);
    this.meta = t.new(() => new Meta(t));          // a nested construction
    this.trackChild(this.meta, "meta");
    this.trackChild(this.cards);
  }
}

describe("validators reading what the constructor creates later", () => {
  it("see it, and depend on it", () => {
    const tracker = new EventLog();
    const board = tracker.construct(() => new Board(tracker));
    board.cards.push("a", "b", "c");
    expect(board.cards.error).toBe("too many");
    board.meta.limit = 3;
    expect([board.cards.error, tracker.isValid]).toEqual([undefined, true]);
  });

  it("a nested construction is validated with the outer one, not before", () => {
    const tracker = new EventLog();
    const seen: string[] = [];
    tracker.construct(() => {
      const board = tracker.construct(() => new Board(tracker));
      seen.push(`inner done: ${board.cards.error ?? "not validated"}`);
      return board;
    });
    expect(seen).toEqual(["inner done: not validated"]);
  });
});

// ---------------------------------------------------------------------------- UnitOfWork

class Line extends Entity {
  @Tracked() accessor qty: number = 1;
  constructor(t: UnitOfWork) { super(t); }
}

class Order extends EntityContainer {
  readonly lines: TrackedCollection<Line>;
  readonly gifts: TrackedCollection<Line>;
  constructor(t: UnitOfWork) {
    super(t);
    this.lines = new TrackedCollection<Line>(t, [], (lines) => (lines.length + this.gifts.length === 0 ? "empty order" : undefined));
    this.gifts = new TrackedCollection<Line>(t, [], (gifts) => (gifts.length > this.lines.length ? "more gifts than lines" : undefined));
    this.trackChild(this.lines);
    this.trackChild(this.gifts);
  }
}

describe("UnitOfWork — two collections whose validators read each other", () => {
  it("are validated once both exist, and each change revalidates the other", () => {
    const tracker = new UnitOfWork();
    const order = tracker.construct(() => new Order(tracker));
    expect([order.lines.error, order.gifts.error]).toEqual(["empty order", undefined]);
    order.gifts.push(tracker.new(() => new Line(tracker)));
    expect([order.lines.error, order.gifts.error]).toEqual([undefined, "more gifts than lines"]);
    order.lines.push(tracker.new(() => new Line(tracker)));
    expect([order.lines.error, order.gifts.error, tracker.isValid]).toEqual([undefined, undefined, true]);
    tracker.undo();
    expect([order.lines.error, order.gifts.error, tracker.isValid]).toEqual([undefined, "more gifts than lines", false]);
  });
});

// ---------------------------------------------------------------------------- outside a construction, and failures

describe("validation outside a construction, and constructions that throw", () => {
  it("a collection created outside construct() / new() validates at once", () => {
    const tracker = new UnitOfWork();
    const col = new TrackedCollection<number>(tracker, [], (items) => (items.length === 0 ? "empty" : undefined));
    expect([col.error, tracker.isValid]).toEqual(["empty", false]);
  });

  it("what a construction creates and destroys again is not validated", () => {
    const tracker = new UnitOfWork();
    tracker.construct(() => {
      const draft = new Line(tracker);
      draft.destroy();
      new TrackedCollection<number>(tracker, [], (items) => (items.length === 0 ? "empty" : undefined)).destroy();
    });
    expect(tracker.isValid).toBe(true);
  });

  it("a construction that throws leaves nothing behind: the next one validates normally", () => {
    const tracker = new EventLog();
    expect(() => tracker.construct(() => { new Issue(tracker); throw new Error("bad data"); })).toThrow("bad data");
    expect(() => tracker.new(() => { new Issue(tracker); throw new Error("bad data"); })).toThrow("bad data");
    const issue = tracker.construct(() => new Issue(tracker, [{ id: "p" }]));
    expect(errors(issue)).toEqual([undefined, undefined]);
  });
});

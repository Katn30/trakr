import { describe, it, expect } from "vitest";
import {
  UnitOfWork, Entity, EntityContainer, TrackedCollection, Tracked, AutoId, State,
  type CommitBatch as UowBatch,
} from "@katn30/chronicle-unit-of-work";
import {
  EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, Id, AutoId as EAutoId,
} from "@katn30/chronicle-event-log";
import { emitted, pendingIds } from "./eventHelpers";

// ---------------------------------------------------------------------------- UnitOfWork models

class Task extends Entity {
  @AutoId id: number | null = null;
  @Tracked() accessor title: string = "";
  @Tracked() accessor owner: string = "";
  @Tracked() accessor due: string = "";
  @Tracked() accessor priority: number = 0;
  // A cascade: setting the status stamps `closedBy`.
  @Tracked(undefined, { afterChange: (self: Task, v: string) => { self.closedBy = v === "done" ? self.owner : ""; } })
  accessor status: string = "open";
  @Tracked() accessor closedBy: string = "";
  @Tracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor notes: string = "";
  constructor(t: UnitOfWork, title = "") { super(t); this.title = title; }
}

class Board extends EntityContainer {
  @Tracked() accessor name: string = "";
  @Tracked() accessor count: number = 0;
  readonly tasks = new TrackedCollection<Task>(this.tracker, []);
  constructor(t: UnitOfWork) {
    super(t);
    this.trackChild(this.tasks);
    // A cascade on the collection: `count` follows the items.
    this.tasks.afterChange.subscribe(() => { this.count = this.tasks.length; });
  }
}

function uow() {
  const tracker = new UnitOfWork();
  let a!: Task, b!: Task, c!: Task;
  const board = tracker.construct(() => {
    const bd = new Board(tracker);
    a = new Task(tracker, "a"); a.id = 1;
    b = new Task(tracker, "b"); b.id = 2;
    c = new Task(tracker, "c"); c.id = 3;
    tracker.withTrackingSuppressed(() => bd.tasks.push(a, b, c));
    return bd;
  });
  let changed = 0;
  tracker.changed.subscribe(() => changed++);
  let collectionChanged = 0;
  board.tasks.changed.subscribe(() => collectionChanged++);
  const batches: { inserted: string[]; changed: string[]; deleted: string[] }[] = [];
  const titles = (list: Entity[]) => list.map((o) => (o instanceof Task ? o.title : "board"));
  const save = (batch: UowBatch) => {
    batches.push({ inserted: titles(batch.inserted), changed: titles(batch.changed), deleted: titles(batch.deleted) });
    return batch.inserted.map((o, i) => ({ chronicleId: o.chronicleId, value: 100 + i }));
  };
  return { tracker, board, a, b, c, changes: () => changed, collectionChanges: () => collectionChanged, save, batches };
}

// ---------------------------------------------------------------------------- reset

describe("TrackedCollection.reset", () => {
  it("replaces the content in one undo step, with one changed on the tracker and on the collection", () => {
    const { tracker, board, a, b, c, changes, collectionChanges } = uow();
    const d = tracker.new(() => new Task(tracker, "d"));
    board.tasks.reset([c, d, a]);
    expect(board.tasks.collection).toEqual([c, d, a]);
    expect([changes(), collectionChanges()]).toEqual([1, 1]);
    expect(tracker.undoable.length).toBe(1);
    tracker.undo();
    expect(board.tasks.collection).toEqual([a, b, c]);
    tracker.redo();
    expect(board.tasks.collection).toEqual([c, d, a]);
  });

  it("items in both keep their state: only what left is Deleted and what arrived is Insert", async () => {
    const { tracker, board, a, b, c, save, batches } = uow();
    const d = tracker.new(() => new Task(tracker, "d"));
    board.tasks.reset([c, d, a]);
    expect([a.chronicleState, b.chronicleState, c.chronicleState, d.chronicleState])
      .toEqual([State.Unchanged, State.Deleted, State.Unchanged, State.Insert]);
    await tracker.commit(save);
    expect(batches).toEqual([{ inserted: ["d"], changed: [], deleted: ["b"] }]);
  });

  it("the collection's afterChange subscribers compose into the same step", () => {
    const { tracker, board, a } = uow();
    board.tasks.reset([a]);
    expect(board.count).toBe(1);
    expect(tracker.undoable.length).toBe(1);
    tracker.undo();
    expect(board.count).toBe(3);                    // the cascade is undone with it
    expect(board.tasks.length).toBe(3);
  });

  it("the same content records nothing", () => {
    const { tracker, board, a, b, c, changes, collectionChanges } = uow();
    board.tasks.reset([a, b, c]);
    expect([changes(), collectionChanges(), tracker.canUndo, tracker.isDirty]).toEqual([0, 0, false, false]);
  });

  it("the same items in another order is a reordering: nothing to save", () => {
    const { tracker, board, a, b, c } = uow();
    board.tasks.reset([c, b, a]);
    expect(board.tasks.collection).toEqual([c, b, a]);
    expect([a.chronicleState, b.chronicleState, c.chronicleState]).toEqual([State.Unchanged, State.Unchanged, State.Unchanged]);
    tracker.undo();
    expect(board.tasks.collection).toEqual([a, b, c]);
  });

  it("an empty list removes everything; plain values count repeats", () => {
    const { tracker, board } = uow();
    board.tasks.reset([]);
    expect(board.tasks.length).toBe(0);
    const tags = tracker.construct(() => new TrackedCollection<number>(tracker, [1, 2, 2]));
    const seen: { added: number[]; removed: number[] }[] = [];
    tags.changed.subscribe((e) => seen.push({ added: [...e.added], removed: [...e.removed] }));
    tags.reset([1, 1, 2]);
    expect(seen).toEqual([{ added: [1], removed: [2] }]);
    tracker.undo();
    expect(tags.collection).toEqual([1, 2, 2]);
  });

  it("takes a readonly array, and does not keep it", () => {
    const { board, a } = uow();
    const items: readonly Task[] = [a];
    board.tasks.reset(items);
    expect(board.tasks.collection).not.toBe(items);
  });
});

// ---------------------------------------------------------------------------- batch (UnitOfWork)

describe("Tracker.batch — UnitOfWork", () => {
  it("a modal's Save writing five fields is one undo step, one changed, and one update", async () => {
    const { tracker, a, changes, save, batches } = uow();
    tracker.batch(() => {
      a.title = "A";
      a.owner = "ann";
      a.due = "monday";
      a.priority = 2;
      a.status = "done";                            // cascades into closedBy
    });
    expect(changes()).toBe(1);
    expect(tracker.undoable.length).toBe(1);
    expect(a.closedBy).toBe("ann");
    await tracker.commit(save);
    expect(batches).toEqual([{ inserted: [], changed: ["A"], deleted: [] }]);
    tracker.undo();
    expect([a.title, a.owner, a.due, a.priority, a.status, a.closedBy]).toEqual(["a", "", "", 0, "open", ""]);
  });

  it("version moves by one step, and changed carries it", () => {
    const { tracker, a } = uow();
    const versions: number[] = [];
    tracker.changed.subscribe((e) => versions.push(e.version));
    const before = tracker.version;
    tracker.batch(() => { a.title = "x"; a.owner = "y"; });
    expect(tracker.version).toBe(before + 1);
    expect(versions).toEqual([before + 1]);
    tracker.undo();
    expect(tracker.version).toBe(before);
  });

  it("nested batches join the outermost", () => {
    const { tracker, a, b, changes } = uow();
    tracker.batch(() => {
      a.title = "x";
      tracker.batch(() => { b.title = "y"; });
      expect(changes()).toBe(0);                    // not until the outermost ends
    });
    expect([changes(), tracker.undoable.length]).toEqual([1, 1]);
  });

  it("if the action throws, everything it wrote is reverted and the error propagates", () => {
    const { tracker, board, a, b, changes } = uow();
    a.title = "before";
    const version = tracker.version;
    expect(() => tracker.batch(() => {
      a.title = "x";
      board.tasks.remove(b);
      tracker.batch(() => { throw new Error("nope"); });
    })).toThrow("nope");
    expect([a.title, board.tasks.length, b.chronicleState]).toEqual(["before", 3, State.Unchanged]);
    expect([changes(), tracker.version, tracker.undoable.length, tracker.canUndo]).toEqual([1, version, 1, true]);
    // Still usable.
    tracker.batch(() => { a.title = "after"; });
    expect(tracker.undoable.length).toBe(2);
  });

  it("an empty batch records nothing and fires nothing", () => {
    const { tracker, changes } = uow();
    tracker.batch(() => undefined);
    expect([changes(), tracker.canUndo, tracker.isDirty]).toEqual([0, false, false]);
  });

  it("undo and redo are off while it runs", () => {
    const { tracker, a } = uow();
    a.title = "x";
    tracker.batch(() => {
      expect(tracker.canUndo).toBe(false);
      tracker.undo();                               // ignored
      expect(a.title).toBe("x");
      a.owner = "y";
      expect(tracker.canUndo).toBe(false);
    });
    expect(tracker.canUndo).toBe(true);
    tracker.undo();
    expect([a.title, a.owner]).toEqual(["x", ""]);
  });

  it("a first write does not coalesce into the step before the batch", () => {
    const { tracker, a } = uow();
    a.notes = "ab";
    tracker.batch(() => { a.notes = "abc"; a.title = "t"; });
    expect(tracker.undoable.length).toBe(2);
    tracker.undo();
    expect([a.notes, a.title]).toEqual(["ab", "a"]);
  });

  it("reset and field writes together are one step", () => {
    const { tracker, board, a, changes } = uow();
    tracker.batch(() => {
      board.tasks.reset([a]);
      board.name = "only a";
    });
    expect([changes(), tracker.undoable.length, board.count]).toEqual([1, 1, 1]);
    tracker.undo();
    expect([board.tasks.length, board.name, board.count]).toEqual([3, "", 3]);
  });

  it("while a save runs, a batch is pending for the next commit", async () => {
    const { tracker, a, save, batches } = uow();
    a.title = "x";
    let release!: () => void;
    const running = tracker.commit((b) => new Promise<ReturnType<typeof save>>((res) => { release = () => res(save(b)); }));
    await Promise.resolve();
    tracker.batch(() => { a.owner = "o"; a.due = "d"; });
    release();
    await running;
    expect(tracker.isDirty).toBe(true);
    await tracker.commit(save);
    expect(batches.map((x) => x.changed)).toEqual([["x"], ["x"]]);
    expect(tracker.isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------- EventLog

class Card extends TrackedObject {
  @EAutoId id: number | null = null;
  @EventTracked() accessor text: string = "";
  constructor(t: EventLog, text = "") { super(t); this.text = text; }
}

class Issue extends TrackedContainer {
  @Id id = "i";
  @EventTracked() accessor title: string = "";
  @EventTracked() accessor owner: string = "";
  readonly cards = new EventTrackedCollection<Card>(this.tracker, "cards");
  readonly steps = new EventTrackedCollection<Card>(this.tracker, "steps", [], undefined, { history: true });
  constructor(t: EventLog) { super(t); this.trackChild(this.cards); this.trackChild(this.steps); }
}

function eventLog() {
  const tracker = new EventLog();
  let x!: Card, y!: Card, s!: Card;
  const issue = tracker.construct(() => {
    const i = new Issue(tracker);
    x = new Card(tracker, "x"); x.id = 10;
    y = new Card(tracker, "y"); y.id = 11;
    s = new Card(tracker, "s"); s.id = 20;
    i.cards.push(x, y);
    i.steps.push(s);
    return i;
  });
  let changed = 0;
  tracker.changed.subscribe(() => changed++);
  return { tracker, issue, x, y, s, changes: () => changed };
}

describe("TrackedCollection.reset — EventLog", () => {
  it("the event carries the net diff: items in both are not reported", () => {
    const { tracker, issue, y } = eventLog();
    const z = tracker.new(() => new Card(tracker, "z"));
    issue.cards.reset([y, z]);
    expect(emitted(tracker)).toEqual([{
      payload: { cards: { added: [{ chronicleId: z.chronicleId, id: null, text: "z" }], removed: [10], changed: [] } },
      chronicleId: issue.chronicleId,
      targetId: "i",
    }]);
  });

  it("history collections record one op per item that left or arrived", () => {
    const { tracker, issue, s } = eventLog();
    const t = tracker.new(() => new Card(tracker, "t"));
    issue.steps.reset([s, t]);
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { steps: { ops: [{ op: "add", item: { chronicleId: t.chronicleId, id: null, text: "t" } }] } },
    ]);
  });

  it("undone before it is sent, nothing is pending", () => {
    const { tracker, issue, y } = eventLog();
    issue.cards.reset([y]);
    tracker.undo();
    expect(pendingIds(tracker)).toEqual([]);
  });
});

describe("Tracker.batch — EventLog", () => {
  it("one batch is one event, one changed, and one undo step", () => {
    const { tracker, issue, y, changes } = eventLog();
    tracker.batch(() => {
      issue.title = "T";
      issue.owner = "ann";
      issue.cards.remove(y);
    });
    expect(changes()).toBe(1);
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { title: "T", owner: "ann", cards: { added: [], removed: [11], changed: [] } },
    ]);
    tracker.undo();
    expect(pendingIds(tracker)).toEqual([]);
  });

  it("undone after it is saved: one compensation", async () => {
    const { tracker, issue } = eventLog();
    tracker.batch(() => { issue.title = "T"; issue.owner = "ann"; });
    await tracker.commit(() => undefined);
    tracker.undo();
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ title: "", owner: "" }]);
  });

  it("if the action throws, nothing is pending", () => {
    const { tracker, issue, changes } = eventLog();
    expect(() => tracker.batch(() => { issue.title = "T"; throw new Error("nope"); })).toThrow("nope");
    expect([issue.title, pendingIds(tracker), changes()]).toEqual(["", [], 0]);
  });
});

describe("EventLog — found by the model-based runs with batches", () => {
  it("a failed batch that put a card back keeps the edits made to it while it was out", async () => {
    const { tracker, issue, x, y } = eventLog();
    issue.cards.reset([x]);
    y.text = "c";                                   // edited while out
    expect(() => tracker.batch(() => { issue.cards.reset([y, x]); throw new Error("cancelled"); })).toThrow();
    issue.cards.reset([y, x]);
    const sent: unknown[] = [];
    await tracker.commit((b) => { sent.push(...b.events.map((e) => e.payload)); });
    expect(sent).toEqual([{ cards: { added: [], removed: [], changed: [{ id: 11, text: "c" }] } }]);
  });

  it("a card created twice in one batch (added, removed, added again) gets the id of its last creation", async () => {
    const { tracker, issue, y } = eventLog();
    const card = tracker.new(() => new Card(tracker, "n"));
    issue.cards.push(card);
    issue.cards.remove(card);
    issue.cards.push(card);
    let release!: () => void;
    const running = tracker.commit(
      () => new Promise<{ chronicleId: number; value: number }[]>((res) => {
        release = () => res([{ chronicleId: card.chronicleId, value: 1 }, { chronicleId: card.chronicleId, value: 2 }]);
      }),
      { mode: "operations" },
    );
    await Promise.resolve();
    issue.cards.reset([y]);                         // refers to the card before its id is known
    release();
    await running;
    expect(card.id).toBe(2);
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ cards: { added: [], removed: [10, 2], changed: [] } }]);
  });

  it("a card created by the save in flight and created again meanwhile: later references wait for the new id", async () => {
    const { tracker, issue } = eventLog();
    const card = tracker.new(() => new Card(tracker, "n"));
    issue.cards.push(card);
    let release!: () => void;
    const running = tracker.commit(
      () => new Promise<{ chronicleId: number; value: number }[]>((res) => { release = () => res([{ chronicleId: card.chronicleId, value: 1 }]); }),
      { mode: "operations" },
    );
    await Promise.resolve();
    issue.cards.remove(card);                       // refers to the creation being saved
    issue.cards.push(card);                         // created again
    card.text = "m";                                // refers to the new creation
    release();
    await running;
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { cards: { added: [], removed: [1], changed: [] } },
      { cards: { added: [{ chronicleId: card.chronicleId, id: null, text: "n" }], removed: [], changed: [] } },
      { cards: { added: [], removed: [], changed: [{ chronicleId: card.chronicleId, text: "m" }] } },
    ]);
  });
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";

import { emitted, oneOperation, pendingIds } from "./eventHelpers";
// ---------------------------------------------------------------------------- Models

class Doc extends TrackedObject {
  @Id id: string = "d1";
  @EventTracked() accessor title: string = "";
  @EventTracked(undefined, undefined, { history: true }) accessor note: string = "";
  constructor(t: EventLog) { super(t); }
}

class Line extends TrackedObject {
  @AutoId id: number = 0;
  @EventTracked((_self, v: string) => (v === "" ? "required" : undefined)) accessor text: string = "x";
  constructor(t: EventLog, text = "x") { super(t); this.text = text; }
}

class Sticker extends TrackedObject {
  @Id code: string = "";
  @EventTracked() accessor label: string = "";
  constructor(t: EventLog, code = "") { super(t); this.code = code; }
}

class Step extends TrackedObject {
  @Id id: string = "";
  @EventTracked(undefined, undefined, { history: true }) accessor log: string = "";
  @EventTracked() accessor hint: string | undefined = undefined;
  constructor(t: EventLog, id = "") { super(t); this.id = id; }
}

class Seat extends TrackedObject {
  @Id row: string = "";
  @Id num: number = 0;
  @EventTracked() accessor taken: boolean = false;
  constructor(t: EventLog, row = "", num = 0) { super(t); this.row = row; this.num = num; }
}

class Holder extends TrackedContainer {
  @Id id: string = "h1";
  readonly a: EventTrackedCollection<Sticker>;
  readonly b: EventTrackedCollection<Sticker>;
  constructor(t: EventLog) {
    super(t);
    this.a = new EventTrackedCollection<Sticker>(t, "a");
    this.b = new EventTrackedCollection<Sticker>(t, "b");
    this.trackChild(this.a);
    this.trackChild(this.b);
  }
}

// ---------------------------------------------------------------------------- helpers

function loaded<T>(tracker: EventLog, make: () => T): T {
  return tracker.construct(make);
}

function collection<T>(tracker: EventLog, name: string, items: T[], options?: Record<string, unknown>) {
  return tracker.construct(() => new EventTrackedCollection<T>(tracker, name, items, undefined, options));
}

function payloads(tracker: EventLog) {
  return emitted(tracker).map((e) => e.payload);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------- tests

describe("EventTrackedCollection — suppressed mutations become the baseline", () => {
  it("push/remove inside withTrackingSuppressed produce no events", () => {
    const tracker = new EventLog();
    const existing = loaded(tracker, () => new Sticker(tracker, "old"));
    const col = collection(tracker, "stickers", [existing]);
    const added = loaded(tracker, () => new Sticker(tracker, "new"));
    tracker.withTrackingSuppressed(() => {
      col.push(added);
      col.remove(existing);
    });
    expect(emitted(tracker)).toEqual([]);

    col.remove(added);
    expect(payloads(tracker)).toEqual([
      { stickers: { added: [], removed: ["new"], changed: [] } },
    ]);
  });
});

describe("EventTrackedCollection — without event options", () => {
  it("reports its items' edits in its event", () => {
    const tracker = new EventLog();
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    collection(tracker, "stickers", [s]);
    s.label = "edited";
    expect(payloads(tracker)).toEqual([
      { stickers: { added: [], removed: [], changed: [{ code: "s1", label: "edited" }] } },
    ]);
  });
});

describe("collection events — slot shapes", () => {
  it("two collections of the same container fold into its event", () => {
    const tracker = new EventLog();
    const holder = loaded(tracker, () => new Holder(tracker));
    const x = loaded(tracker, () => new Sticker(tracker, "x"));
    const y = loaded(tracker, () => new Sticker(tracker, "y"));
    oneOperation(tracker, () => {
      holder.a.push(x);
      holder.b.push(y);
    });
    expect(emitted(tracker)).toEqual([{
      chronicleId: holder.chronicleId,
      targetId: "h1",
      payload: {
        a: { added: [{ code: "x", label: "" }], removed: [], changed: [] },
        b: { added: [{ code: "y", label: "" }], removed: [], changed: [] },
      },
    }]);
  });

  it("a collection belongs to one container", () => {
    const tracker = new EventLog();
    const holder = loaded(tracker, () => new Holder(tracker));
    class Thief extends TrackedContainer {
      constructor(t: EventLog) { super(t); this.trackChild(holder.a); }
    }
    expect(() => loaded(tracker, () => new Thief(tracker))).toThrow(/"a" already belongs to a Holder/);
  });

  it("untrackChild releases it: the collection becomes a root", () => {
    class Keeper extends TrackedContainer {
      @Id id = "k";
      readonly items = new EventTrackedCollection<string>(this.tracker, "items");
      constructor(t: EventLog) { super(t); this.trackChild(this.items); }
      release() { this.untrackChild(this.items); }
    }
    const tracker = new EventLog();
    const keeper = loaded(tracker, () => new Keeper(tracker));
    keeper.items.push("x");
    keeper.release();
    keeper.items.push("y");
    expect(emitted(tracker)).toEqual([
      { chronicleId: keeper.chronicleId, targetId: "k", payload: { items: { added: ["x"], removed: [] } } },
      { payload: { items: { added: ["y"], removed: [] } } },
    ]);
  });

  it("untrackChild by a container that does not own the collection changes nothing", () => {
    const tracker = new EventLog();
    const holder = loaded(tracker, () => new Holder(tracker));
    class Bystander extends TrackedContainer {
      constructor(t: EventLog) { super(t); }
      drop() { this.untrackChild(holder.a); }
    }
    loaded(tracker, () => new Bystander(tracker)).drop();
    holder.a.push(loaded(tracker, () => new Sticker(tracker, "x")));
    expect(emitted(tracker)[0].chronicleId).toBe(holder.chronicleId);
  });

  it("a root history collection", () => {
    const tracker = new EventLog();
    const col = collection<Sticker>(tracker, "stickers", [], { history: true });
    col.push(loaded(tracker, () => new Sticker(tracker, "x")));
    expect(payloads(tracker)).toEqual([
      { stickers: { ops: [{ op: "add", item: { code: "x", label: "" } }] } },
    ]);
  });

  it("primitive collections: added and removed, no `changed` key; ack clears them", () => {
    const tracker = new EventLog();
    const tags = collection(tracker, "tags", ["keep", "drop"]);
    oneOperation(tracker, () => {
      tags.remove("drop");
      tags.push("new");
    });
    expect(payloads(tracker)).toEqual([{ tags: { added: ["new"], removed: ["drop"] } }]);
    tracker._onCommit(pendingIds(tracker));
    expect(emitted(tracker)).toEqual([]);
  });

  it("an emptied object collection is still treated as an object collection", () => {
    const tracker = new EventLog();
    const s = loaded(tracker, () => new Sticker(tracker, "s1"));
    const col = collection(tracker, "stickers", [s]);
    col.remove(s);
    expect(payloads(tracker)).toEqual([
      { stickers: { added: [], removed: ["s1"], changed: [] } },
    ]);
  });

  it("history properties on items appear in added snapshots and changed entries, and are acked", () => {
    const tracker = new EventLog();
    const kept = loaded(tracker, () => new Step(tracker, "k"));
    const col = collection(tracker, "steps", [kept]);
    const fresh = tracker.new(() => new Step(tracker, "f"));
    oneOperation(tracker, () => {
      fresh.log = "created";
      col.push(fresh);
      kept.log = "touched";
    });

    expect(payloads(tracker)).toEqual([{
      steps: {
        added: [{ id: "f", log: "created", hint: null }],
        removed: [],
        changed: [{ id: "k", log: [{ property: "log", value: "touched" }] }],
      },
    }]);
    tracker._onCommit(pendingIds(tracker));
    expect(emitted(tracker)).toEqual([]);
  });

  it("an added item without history entries is acked cleanly", () => {
    const tracker = new EventLog();
    const col = collection<Step>(tracker, "steps", []);
    col.push(loaded(tracker, () => new Step(tracker, "f")));
    tracker._onCommit(pendingIds(tracker));
    expect(emitted(tracker)).toEqual([]);
  });

  it("undefined field values are normalised to null", () => {
    const tracker = new EventLog();
    const step = loaded(tracker, () => new Step(tracker, "s"));
    tracker.withTrackingSuppressed(() => { step.hint = "base"; });
    step.hint = undefined;
    expect(payloads(tracker)).toEqual([{ hint: null }]);
  });
});

describe("history-mode collections — ops, undo, redo, ack", () => {
  function setup(options: Record<string, unknown> = { history: true }) {
    const tracker = new EventLog();
    const seat = loaded(tracker, () => new Seat(tracker, "A", 1));
    const col = collection(tracker, "seats", [seat], options);
    return { tracker, seat, col };
  }

  it("item edits become change ops; undo of an unsent change withdraws it", () => {
    const { tracker, seat } = setup();
    seat.taken = true;
    expect(payloads(tracker)).toEqual([
      { seats: { ops: [{ op: "change", row: "A", num: 1, taken: true }] } },
    ]);
    tracker.undo();
    expect(emitted(tracker)).toEqual([]);
  });

  it("undo of a persisted change emits a compensating change op", () => {
    const { tracker, seat } = setup();
    seat.taken = true;
    tracker._onCommit(pendingIds(tracker));
    tracker.undo();
    expect(payloads(tracker)).toEqual([
      { seats: { ops: [{ op: "change", row: "A", num: 1, taken: false }] } },
    ]);
  });

  it("removes carry composite identity; undo of a persisted remove emits an add", () => {
    const { tracker, seat, col } = setup();
    col.remove(seat);
    expect(payloads(tracker)).toEqual([
      { seats: { ops: [{ op: "remove", row: "A", num: 1 }] } },
    ]);
    tracker._onCommit(pendingIds(tracker));
    tracker.undo();
    expect(payloads(tracker)).toEqual([
      { seats: { ops: [{ op: "add", item: { row: "A", num: 1, taken: false } }] } },
    ]);
  });

  it("redo after withdrawing an unsent add puts the same op back", () => {
    const { tracker, col } = setup();
    col.push(loaded(tracker, () => new Seat(tracker, "B", 2)));
    const before = payloads(tracker);
    tracker.undo();
    expect(emitted(tracker)).toEqual([]);
    tracker.redo();
    expect(payloads(tracker)).toEqual(before);
  });

  it("acknowledging an op that was withdrawn in the meantime is a no-op", () => {
    const { tracker, col } = setup();
    col.push(loaded(tracker, () => new Seat(tracker, "B", 2)));
    const sent = pendingIds(tracker);
    tracker.undo();
    tracker._onCommit(sent);
    expect(emitted(tracker)).toEqual([]);
  });

  it("toPayload adds fields to each op; compensations run it with the inverse kind", () => {
    const toPayload = (_seat: Seat, op: string) => ({ by: "u1", as: op });
    const { tracker, seat, col } = setup({ history: true, toPayload });
    col.remove(seat);
    expect(payloads(tracker)).toEqual([
      { seats: { ops: [{ op: "remove", row: "A", num: 1, by: "u1", as: "remove" }] } },
    ]);
    tracker._onCommit(pendingIds(tracker));
    tracker.undo();
    expect(payloads(tracker)).toEqual([
      { seats: { ops: [{ op: "add", item: { row: "A", num: 1, taken: false }, by: "u1", as: "add" }] } },
    ]);
  });

  it("undefined item values are normalised to null in snapshots and diffs", () => {
    const tracker = new EventLog();
    const col = collection<Step>(tracker, "steps", [], { history: true });
    const step = loaded(tracker, () => new Step(tracker, "s"));
    col.push(step);
    step.hint = "h";
    step.hint = undefined;
    expect(payloads(tracker)).toEqual([
      { steps: { ops: [{ op: "add", item: { id: "s", log: "", hint: null } }] } },
      { steps: { ops: [{ op: "change", id: "s", log: "", hint: "h" }] } },
      { steps: { ops: [{ op: "change", id: "s", log: "", hint: null }] } },
    ]);
  });

  it("primitive items are not recorded as ops", () => {
    const tracker = new EventLog();
    const col = collection(tracker, "tags", ["x"], { history: true });
    col.push("y");
    col.remove("x");
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("history properties — replay effects", () => {
  it("redo after withdrawing an unsent entry restores it", () => {
    const tracker = new EventLog();
    const doc = loaded(tracker, () => new Doc(tracker));
    doc.note = "A";
    tracker.undo();
    tracker.redo();
    expect(payloads(tracker)).toEqual([
      { note: [{ property: "note", value: "A" }] },
    ]);
  });

  it("acknowledging a chain that was withdrawn in the meantime is a no-op", () => {
    const tracker = new EventLog();
    const doc = loaded(tracker, () => new Doc(tracker));
    doc.note = "A";
    const sent = pendingIds(tracker);
    tracker.undo();
    tracker._onCommit(sent);
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("EventLog.onCommit — keys and warnings", () => {
  it("ignores keys for unknown tracking ids and for objects without @AutoId", () => {
    const tracker = new EventLog();
    const doc = loaded(tracker, () => new Doc(tracker));
    doc.title = "T";
    tracker._onCommit(pendingIds(tracker), [
      { chronicleId: 9999, value: 1 },
      { chronicleId: doc.chronicleId, value: 2 },
    ]);
    expect(doc.id).toBe("d1");
    expect(tracker.isDirty).toBe(false);
  });

});

describe("EventLog.discardPendingChanges — several collections", () => {
  it("rebaselines every event collection", () => {
    const tracker = new EventLog();
    const plain = tracker.construct(() => new EventTrackedCollection<string>(tracker, "plain"));
    const tags = collection(tracker, "tags", ["a"]);
    plain.push("p");
    tags.push("b");
    tracker.discardPendingChanges();
    expect(plain.collection).toEqual([]);
    expect(tags.collection).toEqual(["a"]);
    expect(emitted(tracker)).toEqual([]);
  });
});

describe("EventLog — validity of removed items", () => {
  it("removing an item from a second collection does not release it twice", () => {
    const tracker = new EventLog();
    const line = loaded(tracker, () => new Line(tracker, "a"));
    const one = collection(tracker, "one", [line]);
    const two = collection(tracker, "two", [line]);
    line.text = "";
    one.remove(line);
    two.remove(line);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    tracker.undo();
    expect(tracker.isValid).toBe(false);
  });

  it("re-adding a valid item and undoing that keeps the tracker valid", () => {
    const tracker = new EventLog();
    const line = loaded(tracker, () => new Line(tracker, "a"));
    const col = collection(tracker, "lines", [line]);
    col.remove(line);
    col.push(line);
    expect(tracker.isValid).toBe(true);
    tracker.undo();
    expect(tracker.isValid).toBe(true);
    line.text = ""; // invalid while outside the collection: not counted
    expect(tracker.isValid).toBe(true);
  });
});

// ---------------------------------------------------------------------------- saved items taken out and put back

class Card extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked() accessor text: string = "";
  constructor(t: EventLog, text = "") { super(t); this.text = text; }
}

class Board extends TrackedContainer {
  @Id id = "b";
  readonly cards = new EventTrackedCollection<Card>(this.tracker, "cards");
  constructor(t: EventLog) { super(t); this.trackChild(this.cards); }
}

function boardWithSavedCard() {
  const tracker = new EventLog();
  let saved!: Card;
  const b = tracker.construct(() => {
    const board = new Board(tracker);
    saved = new Card(tracker, "y");
    saved.id = 11;
    board.cards.push(saved);
    return board;
  });
  const sent: unknown[] = [];
  const save = (batch: { events: { payload: unknown }[] }) => {
    sent.push(...batch.events.map((e) => e.payload));
  };
  return { tracker, board: b, saved, sent, save };
}

const slot = (added: unknown[], removed: unknown[], changed: unknown[]) => ({ cards: { added, removed, changed } });

describe("EventLog — a saved item removed and put back", () => {
  it("removed, put back, and the put-back undone: the removal is sent by its id", async () => {
    const { tracker, board, saved, sent, save } = boardWithSavedCard();
    board.cards.remove(saved);
    board.cards.push(saved);
    tracker.undo();
    await tracker.commit(save);
    expect(sent).toEqual([slot([], [11], [])]);
  });

  it("edited while out, then put back: collapsed, the edit is sent as a change", async () => {
    const { tracker, board, saved, sent, save } = boardWithSavedCard();
    board.cards.remove(saved);
    saved.text = "a";
    board.cards.push(saved);
    await tracker.commit(save);
    expect(sent).toEqual([slot([], [], [{ id: 11, text: "a" }])]);
  });

  it("edited while out, put back, put-back undone and redone: the edit is still sent", async () => {
    const { tracker, board, saved, sent, save } = boardWithSavedCard();
    board.cards.remove(saved);
    saved.text = "a";
    board.cards.push(saved);
    tracker.undo();
    board.cards.push(saved);
    await tracker.commit(save);
    expect(sent).toEqual([slot([], [], [{ id: 11, text: "a" }])]);
  });

  it("a collapsed save that turns out not to create it: edits made meanwhile refer to its id", async () => {
    const { tracker, board, saved, sent, save } = boardWithSavedCard();
    board.cards.remove(saved);
    board.cards.push(saved);          // as an operation: a new card
    board.cards.push(tracker.new(() => new Card(tracker, "c")));
    let release!: () => void;
    const running = tracker.commit(() => new Promise<void>((res) => { release = res; }));
    await Promise.resolve();
    saved.text = "b";                 // while the save runs: the card's creation is in flight
    release();
    await running;                    // collapsed: the card was there all along, it keeps id 11
    await tracker.commit(save);
    expect(sent).toEqual([slot([], [], [{ id: 11, text: "b" }])]);
  });
});

// ---------------------------------------------------------------------------- undo/redo across saves: order and references

class Journal extends TrackedObject {
  @Id id = "j";
  @EventTracked(undefined, undefined, { history: true }) accessor log: string = "";
  constructor(t: EventLog) { super(t); }
}

describe("EventLog — undo and redo across saves", () => {
  it("an event brought back by undo comes after what was recorded meanwhile (the server ends with the last value)", async () => {
    const tracker = new EventLog();
    const journal = tracker.construct(() => new Journal(tracker));
    const values = (batch: { events: { payload: unknown }[] }) =>
      batch.events.flatMap((e) => (e.payload as { log: { value: string }[] }).log.map((x) => x.value));
    const sent: string[] = [];
    journal.log = "a";
    await tracker.commit((b) => { sent.push(...values(b)); });
    tracker.undo();                   // compensation "" (pending)
    tracker.redo();                   // withdrawn
    journal.log = "";
    await tracker.commit((b) => { sent.push(...values(b)); });
    tracker.undo();                   // log = "a": compensates the second save
    tracker.undo();                   // log = "": brings back the compensation of the first save
    expect(journal.log).toBe("");
    await tracker.commit((b) => { sent.push(...values(b)); }, { mode: "operations" });
    expect(sent[sent.length - 1]).toBe("");
  });

  it("an event brought back by undo is derived again if a save changed how it refers to an item", async () => {
    const { tracker, board, sent, save } = boardWithSavedCard();
    let nextId = 100;
    const assign = (batch: { events: { payload: unknown }[] }) => {
      save(batch);
      return batch.events.flatMap((e) => (e.payload as ReturnType<typeof slot>).cards.added)
        .map((a) => ({ chronicleId: (a as { chronicleId: number }).chronicleId, value: nextId++ }));
    };
    const card = tracker.new(() => new Card(tracker, "a"));
    board.cards.push(card);
    await tracker.commit(assign);     // created as 100
    tracker.undo();
    tracker.redo();                   // the compensation "remove 100" is withdrawn
    board.cards.remove(card);
    await tracker.commit(assign);     // 100 deleted
    tracker.undo();                   // put back: created again
    tracker.undo();                   // undo the first addition: removes the card created again (not 100)
    sent.length = 0;
    await tracker.commit(assign, { mode: "operations" });
    expect(sent).toEqual([
      slot([{ chronicleId: card.chronicleId, id: null, text: "a" }], [], []),
      slot([], [{ chronicleId: card.chronicleId }], []), // the same batch creates it: referred to by chronicleId
    ]);
    expect(board.cards.length).toBe(1);
  });
});

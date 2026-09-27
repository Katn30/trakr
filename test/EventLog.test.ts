import { describe, it, expect, beforeEach } from "vitest";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { AutoId, Id } from "../packages/core/src/ExternallyAssigned";

import { emitted, oneOperation, pendingEvents, pendingIds } from "./eventHelpers";
// ---------------------------------------------------------------------------- helpers
function newEventTracker(): EventLog {
  return new EventLog();
}

// ---------------------------------------------------------------------------- Models

class IssueModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked()
  accessor name: string = "";

  @EventTracked()
  accessor description: string = "";

  @EventTracked()
  accessor analysisSummary: string | null = null;

  @EventTracked()
  accessor rootCause: string | null = null;

  @EventTracked()
  accessor internalNote: string = "";

  @EventTracked()
  accessor stage: string = "Submitted";

  constructor(tracker: EventLog) {
    super(tracker);
  }
}

// ---------------------------------------------------------------------------- BC / parity

describe("EventLog — behavioural parity with Tracker", () => {
  it("used as plain Tracker behaves like Tracker", () => {
    const tracker = newEventTracker();
    const issue = tracker.construct(() => new IssueModel(tracker));

    issue.name = "Alice";
    expect(tracker.isDirty).toBe(true);
    tracker.undo();
    expect(issue.name).toBe("");
    tracker.redo();
    expect(issue.name).toBe("Alice");
  });
});

// ---------------------------------------------------------------------------- field-cluster grouping

describe("EventLog — one event per object", () => {
  let tracker: EventLog;
  let issue: IssueModel;

  beforeEach(() => {
    tracker = newEventTracker();
    issue = tracker.construct(() => new IssueModel(tracker));
    tracker._onCommit(pendingIds(tracker));
  });

  it("returns [] when tracker is clean", () => {
    expect(emitted(tracker)).toEqual([]);
  });

  it("the fields changed by one operation go into one event", () => {
    oneOperation(tracker, () => {
      issue.name = "N";
      issue.description = "D";
      issue.analysisSummary = "AS";
    });

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ name: "N", description: "D", analysisSummary: "AS" });
    expect(events[0].chronicleId).toBe(issue.chronicleId);
  });

  it("each operation is its own event", () => {
    issue.name = "N";
    issue.analysisSummary = "AS";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ name: "N" }, { analysisSummary: "AS" }]);
  });

  it("net-zero scalar diff (A → B → A) within one operation: no entry for that property", () => {
    oneOperation(tracker, () => {
      issue.name = "N";
      issue.name = "";
    });
    expect(emitted(tracker)).toEqual([]);
  });

  it("undo of a write yields no event", () => {
    issue.name = "N";
    tracker.undo();
    expect(emitted(tracker)).toEqual([]);
  });

  it("events carry targetId from @AutoId", () => {
    tracker.withTrackingSuppressed(() => { issue.id = 42; });
    issue.name = "N";
    const events = emitted(tracker);
    expect(events[0].targetId).toBe(42);
  });
});

// ---------------------------------------------------------------------------- ungrouped default emission

describe("EventLog — one payload per object (test 1)", () => {
  it("one event per tracked object, all changes in one payload", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked() accessor a: string = "";
      @EventTracked() accessor b: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker._onCommit(pendingIds(tracker));

    oneOperation(tracker, () => {
      m.a = "A";
      m.b = "B";
    });

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ a: "A", b: "B" });
    expect(events[0].targetId).toBe("m1");
  });

});

// ---------------------------------------------------------------------------- history mode (scalar)

describe("EventLog — history mode on scalar properties (tests 4, 5, 6, 7, 8)", () => {
  it("history:true without factory — chain is [{property,value},...] in operation order", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { history: true }) accessor s: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker._onCommit(pendingIds(tracker));

    oneOperation(tracker, () => {
      m.s = "a";
      m.s = "b";
      m.s = "c";
    });

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      s: [
        { property: "s", value: "a" },
        { property: "s", value: "b" },
        { property: "s", value: "c" },
      ],
    });
  });

  it("history with toPayload — entries are toPayload results, in order", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, {
        history: true,
        toPayload: (_self, newValue: string, oldValue: string) => ({ newValue, oldValue, timed: true }),
      })
      accessor s: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker._onCommit(pendingIds(tracker));

    oneOperation(tracker, () => {
      m.s = "a";
      m.s = "b";
    });

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      s: [
        { newValue: "a", oldValue: "", timed: true },
        { newValue: "b", oldValue: "a", timed: true },
      ],
    });
  });

  it("history + coalesceWithin: two writes within window produce one chain entry", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { history: true, coalesceWithin: 3000 })
      accessor s: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker._onCommit(pendingIds(tracker));

    m.s = "a";
    m.s = "ab";

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      s: [{ property: "s", value: "ab" }],
    });
  });

  it("post-commit undo of a history-mode property: new chain entry appended", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { history: true }) accessor s: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker._onCommit(pendingIds(tracker));

    m.s = "committed";
    tracker._onCommit(pendingIds(tracker));

    // Post-commit undo — new chain entry is appended (not popped from historic session).
    tracker.undo();
    expect(m.s).toBe("");

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    // Chain has one entry representing the reversion.
    const chain = (events[0].payload as { s: Array<{ property: string; value: string }> }).s;
    expect(chain).toHaveLength(1);
    expect(chain[0]).toEqual({ property: "s", value: "" });
  });

  it("non-history property with post-commit undo: baseline diff reflects the undo (test 9)", () => {
    const tracker = newEventTracker();
    const issue = tracker.construct(() => new IssueModel(tracker));
    tracker.withTrackingSuppressed(() => { issue.id = 10; });
    tracker._onCommit(pendingIds(tracker));

    issue.name = "Alice";
    tracker._onCommit(pendingIds(tracker));

    tracker.undo();
    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ name: "" });
    expect(events[0].targetId).toBe(10);
  });
});

// ---------------------------------------------------------------------------- Aggregate collection semantics

class Author extends TrackedObject {
  @Id name: string = "";
  @EventTracked() accessor bio: string = "";
  constructor(t: EventLog) { super(t); }
}

class Post extends TrackedContainer {
  @Id postId: string = "";
  @EventTracked() accessor title: string = "";
  authors: EventTrackedCollection<Author>;
  constructor(t: EventLog, opts?: { history?: boolean }) {
    super(t);
    this.authors = new EventTrackedCollection<Author>(t, "authors", [], undefined, { history: opts?.history });
    this.trackChild(this.authors);
  }
}

describe("EventTrackedCollection — owned by a container (tests 10-12, 17)", () => {
  it("test 10: collection edit-only case — changed entry has identity + dirty prop only", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });

    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; author.bio = "old bio"; });
    post.authors.push(author);
    tracker._onCommit(pendingIds(tracker));

    author.bio = "new bio";

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      authors: {
        added: [],
        changed: [{ name: "alice", bio: "new bio" }],
        removed: [],
      },
    });
    expect(events[0].targetId).toBe("p1");
    expect(events[0].chronicleId).toBe(post.chronicleId);
  });

  it("test 11: add + remove of a new item — one event each; within one operation, none", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    tracker._onCommit(pendingIds(tracker));

    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; });
    post.authors.push(author);
    post.authors.remove(author);
    expect(emitted(tracker).map((e) => (e.payload as any).authors)).toEqual([
      { added: [{ name: "alice", bio: "" }], removed: [], changed: [] },
      { added: [], removed: ["alice"], changed: [] },
    ]);

    tracker._onCommit(pendingIds(tracker));
    oneOperation(tracker, () => {
      post.authors.push(author);
      post.authors.remove(author);
    });
    expect(emitted(tracker)).toEqual([]);
  });

  it("test 12: edit then remove of existing item — item in removed only, not changed", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; author.bio = "b"; });
    post.authors.push(author);
    tracker._onCommit(pendingIds(tracker));

    oneOperation(tracker, () => {
      author.bio = "edited";
      post.authors.remove(author);
    });

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    const slot = (events[0].payload as any).authors;
    expect(slot.changed).toEqual([]);
    expect(slot.removed).toEqual(["alice"]);
  });

  it("test 17: history mode ordered ops; non-history: bucketed", () => {
    // History mode
    const tracker1 = newEventTracker();
    const post1 = tracker1.construct(() => new Post(tracker1, { history: true }));
    tracker1.withTrackingSuppressed(() => { post1.postId = "p1"; });
    tracker1._onCommit(pendingIds(tracker1));

    const author1 = tracker1.construct(() => new Author(tracker1));
    tracker1.withTrackingSuppressed(() => { author1.name = "a1"; });
    const author2 = tracker1.construct(() => new Author(tracker1));
    tracker1.withTrackingSuppressed(() => { author2.name = "a2"; });
    oneOperation(tracker1, () => {
      post1.authors.push(author1);
      author1.bio = "b1";
      post1.authors.push(author2);
      post1.authors.remove(author1);
    });

    const events1 = emitted(tracker1);
    const slot1 = (events1[0].payload as any).authors;
    expect(slot1.ops).toBeDefined();
    // ops sequence: add author1, change author1, add author2, remove author1
    expect(slot1.ops[0]).toEqual({ op: "add", item: { name: "a1", bio: "" } });
    expect(slot1.ops[slot1.ops.length - 1]).toEqual({ op: "remove", name: "a1" });

    // Non-history — bucketed
    const tracker2 = newEventTracker();
    const post2 = tracker2.construct(() => new Post(tracker2));
    tracker2.withTrackingSuppressed(() => { post2.postId = "p2"; });
    tracker2._onCommit(pendingIds(tracker2));

    const a = tracker2.construct(() => new Author(tracker2));
    tracker2.withTrackingSuppressed(() => { a.name = "a"; });
    post2.authors.push(a);
    const events2 = emitted(tracker2);
    const slot2 = (events2[0].payload as any).authors;
    expect(slot2.added).toBeDefined();
    expect(slot2.changed).toBeDefined();
    expect(slot2.removed).toBeDefined();
  });

});

// ---------------------------------------------------------------------------- Identity (Id / AutoId)

describe("Identity extraction (tests 13, 14, 15, 16)", () => {
  it("test 13: item type with no @Id and no @AutoId used in EventTrackedCollection — constructor throws", () => {
    class NoId extends TrackedObject {
      @EventTracked() accessor label: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    tracker.construct(() => new NoId(tracker));
    expect(() => new EventTrackedCollection<NoId>(tracker, "x")).not.toThrow(); // Empty collection at construction doesn't validate items
    // But pushing NoId item should throw
    const c2 = new EventTrackedCollection<NoId>(tracker, "y");
    const item = tracker.construct(() => new NoId(tracker));
    expect(() => c2.push(item)).toThrow(/must declare an @Id or @AutoId/);
  });

  it("test 14: single @Id string — changed carries {id, ...}, removed carries scalar", () => {
    class NamedItem extends TrackedObject {
      @Id id: string = "";
      @EventTracked() accessor v: string = "";
      constructor(t: EventLog) { super(t); }
    }
    class Owner extends TrackedContainer {
      @Id ownerId: string = "";
      items: EventTrackedCollection<NamedItem>;
      constructor(t: EventLog) {
        super(t);
        this.items = new EventTrackedCollection<NamedItem>(t, "items");
        this.trackChild(this.items);
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });

    const item = tracker.construct(() => new NamedItem(tracker));
    tracker.withTrackingSuppressed(() => { item.id = "abc"; item.v = "old"; });
    o.items.push(item);
    tracker._onCommit(pendingIds(tracker));

    item.v = "new";
    let events = emitted(tracker);
    const changed = (events[0].payload as any).items.changed;
    expect(changed).toEqual([{ id: "abc", v: "new" }]);

    o.items.remove(item);
    events = emitted(tracker);
    const slot = (events[events.length - 1].payload as any).items;
    expect(slot.removed).toEqual(["abc"]);
  });

  it("test 15: two @Id properties — composite identity inlined in changed, object in removed", () => {
    class CompositeItem extends TrackedObject {
      @Id key1: string = "";
      @Id key2: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: EventLog) { super(t); }
    }
    class Owner extends TrackedContainer {
      @Id ownerId: string = "";
      items: EventTrackedCollection<CompositeItem>;
      constructor(t: EventLog) {
        super(t);
        this.items = new EventTrackedCollection<CompositeItem>(t, "items");
        this.trackChild(this.items);
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });

    const item = tracker.construct(() => new CompositeItem(tracker));
    tracker.withTrackingSuppressed(() => { item.key1 = "k"; item.key2 = 5; item.v = "old"; });
    o.items.push(item);
    tracker._onCommit(pendingIds(tracker));

    item.v = "new";
    const events = emitted(tracker);
    const changed = (events[0].payload as any).items.changed;
    expect(changed).toEqual([{ key1: "k", key2: 5, v: "new" }]);

    o.items.remove(item);
    const events2 = emitted(tracker);
    const slot = (events2[events2.length - 1].payload as any).items;
    expect(slot.removed).toEqual([{ key1: "k", key2: 5 }]);
  });

  it("test 15b (from spec): single @AutoId — pre-commit inserts carry null id; post-commit patches", () => {
    class AutoItem extends TrackedObject {
      @AutoId id: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: EventLog) { super(t); }
    }
    class Owner extends TrackedContainer {
      @Id ownerId: string = "";
      items: EventTrackedCollection<AutoItem>;
      constructor(t: EventLog) {
        super(t);
        this.items = new EventTrackedCollection<AutoItem>(t, "items");
        this.trackChild(this.items);
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });
    tracker._onCommit(pendingIds(tracker));

    const item = tracker.construct(() => new AutoItem(tracker));
    tracker.withTrackingSuppressed(() => { item.v = "hello"; });
    o.items.push(item);

    const events = emitted(tracker);
    const slot = (events[0].payload as any).items;
    expect(slot.added).toEqual([{ chronicleId: item.chronicleId, id: null, v: "hello" }]);

    // Commit and verify @AutoId is patched
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: item.chronicleId, value: 999 }]);
    expect(item.id).toBe(999);
  });

  it("test 16: @Id + @AutoId mix — getIdentity returns object with both", () => {
    class MixedItem extends TrackedObject {
      @Id key: string = "";
      @AutoId id: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: EventLog) { super(t); }
    }
    class Owner extends TrackedContainer {
      @Id ownerId: string = "";
      items: EventTrackedCollection<MixedItem>;
      constructor(t: EventLog) {
        super(t);
        this.items = new EventTrackedCollection<MixedItem>(t, "items");
        this.trackChild(this.items);
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });

    const item = tracker.construct(() => new MixedItem(tracker));
    tracker.withTrackingSuppressed(() => { item.key = "k"; item.v = "old"; });
    o.items.push(item);
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: item.chronicleId, value: 42 }]);
    expect(item.id).toBe(42);

    item.v = "new";
    const events = emitted(tracker);
    const changed = (events[0].payload as any).items.changed;
    expect(changed).toEqual([{ key: "k", id: 42, v: "new" }]);
  });
});

// ---------------------------------------------------------------------------- @EventTracked semantic parity with @Tracked

describe("@EventTracked semantic parity", () => {
  it("validator runs for @EventTracked accessors", () => {
    class M extends TrackedObject {
      @Id id: string = "id";
      @EventTracked((_self, v: string) => (!v ? "Name is required" : undefined))
      accessor name: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    expect(m.chronicleIsValid).toBe(false);
    m.name = "Alice";
    expect(m.chronicleIsValid).toBe(true);
  });

  it("coalesceWithin merges rapid writes into one undo step", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { coalesceWithin: 3000 })
      accessor name: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    m.name = "A";
    m.name = "Al";
    m.name = "Alice";
    tracker.undo();
    expect(m.name).toBe("");
  });
});

// ---------------------------------------------------------------------------- targetId widened

describe("GeneratedEvent.targetId widened to unknown", () => {
  it("targetId is a scalar for single-@Id string", () => {
    class M extends TrackedObject {
      @Id key: string = "";
      @EventTracked() accessor v: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.key = "K"; });
    tracker._onCommit(pendingIds(tracker));

    m.v = "hello";
    const events = emitted(tracker);
    expect(events[0].targetId).toBe("K");
  });

  it("targetId is an object for composite @Id", () => {
    class M extends TrackedObject {
      @Id k1: string = "";
      @Id k2: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.k1 = "K"; m.k2 = 7; });
    tracker._onCommit(pendingIds(tracker));

    m.v = "hello";
    const events = emitted(tracker);
    expect(events[0].targetId).toEqual({ k1: "K", k2: 7 });
  });
});

// ---------------------------------------------------------------------------- Read-only guarantee

describe("EventLog.generateEvents — pure read", () => {
  it("does not modify tracker dirty state or object state", () => {
    const tracker = newEventTracker();
    const issue = tracker.construct(() => new IssueModel(tracker));
    tracker._onCommit(pendingIds(tracker));
    issue.name = "N";
    const before = { isDirty: tracker.isDirty, undoable: tracker.undoable.length };
    emitted(tracker);
    emitted(tracker);
    expect(tracker.isDirty).toBe(before.isDirty);
    expect(tracker.undoable.length).toBe(before.undoable);
  });
});

// ---------------------------------------------------------------------------- Construction hardening

describe("@EventTracked construction respects tracker.construct()", () => {
  it("writes made inside tracker.construct() produce no events", () => {
    class M extends TrackedObject {
      @Id id: string = "id";
      @EventTracked()
      accessor name: string = "";
      constructor(t: EventLog, data?: { name: string }) {
        super(t);
        if (data) this.name = data.name;
      }
    }
    const tracker = newEventTracker();
    tracker.construct(() => new M(tracker, { name: "initial" }));
    expect(emitted(tracker)).toEqual([]);
    expect(tracker.isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------- tracker.new()

describe("tracker.new()", () => {
  class Issue extends TrackedObject {
    @Id id: string = "id";
    @EventTracked() accessor status: string = "";
    @EventTracked() accessor priority: number = 0;
    constructor(t: EventLog, data?: { status: string; priority: number }) {
      super(t);
      if (data) {
        this.status = data.status;
        this.priority = data.priority;
      } else {
        this.status = "open";
        this.priority = 1;
      }
    }
  }

  it("nothing is pending after tracker.new(): an untouched new object is nothing to save", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    expect(emitted(tracker)).toEqual([]);
    expect(tracker.isDirty).toBe(false);
  });

  it("its first change sends its creation: the whole state, constructor defaults included", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.priority = 2;
    expect(emitted(tracker)).toEqual([
      { chronicleId: issue.chronicleId, targetId: "id", payload: { id: "id", status: "open", priority: 2 } },
    ]);
    expect(tracker.isDirty).toBe(true);
  });

  it("undoing that first change leaves nothing to save again; redo brings the creation back", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.priority = 2;
    tracker.undo();
    expect(emitted(tracker)).toEqual([]);
    expect(tracker.isDirty).toBe(false);
    tracker.redo();
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ id: "id", status: "open", priority: 2 }]);
  });

  it("once its creation is committed, later changes are ordinary change events", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.priority = 2;
    tracker._onCommit(pendingIds(tracker));
    issue.status = "closed";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ status: "closed" }]);
  });

  it("only the first change carries the creation; the next ones are ordinary changes", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.priority = 2;
    issue.status = "closed";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { id: "id", status: "open", priority: 2 },
      { status: "closed" },
    ]);
  });

  it("a collapsed commit sends one creation with the latest state; operations mode sends them in order", async () => {
    const collapsed: unknown[] = [];
    const t1 = newEventTracker();
    const a = t1.new(() => new Issue(t1));
    a.priority = 2;
    a.status = "closed";
    await t1.commit((b) => { collapsed.push(...b.events.map((e) => e.payload)); });
    expect(collapsed).toEqual([{ id: "id", status: "closed", priority: 2 }]);

    const steps: unknown[] = [];
    const t2 = newEventTracker();
    const b = t2.new(() => new Issue(t2));
    b.priority = 2;
    b.status = "closed";
    await t2.commit((batch) => { steps.push(...batch.events.map((e) => e.payload)); }, { mode: "operations" });
    expect(steps).toEqual([{ id: "id", status: "open", priority: 2 }, { status: "closed" }]);
  });

  it("a coalesced write into the creating step keeps it the creation", () => {
    class Typed extends TrackedObject {
      @Id id = "t";
      @EventTracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor text: string = "";
      @EventTracked() accessor kind: string = "note";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = newEventTracker();
    const typed = tracker.new(() => new Typed(tracker));
    typed.text = "a";
    typed.text = "ab";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([{ id: "t", text: "ab", kind: "note" }]);
  });

  it("object is not dirty after tracker.new()", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    expect("isDirty" in issue).toBe(false); // no per-object state on an EventLog
  });

  it("canUndo is false after tracker.new()", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    expect(tracker.canUndo).toBe(false);
  });


  it("same constructor: tracker.construct() with data produces no events", () => {
    const tracker = newEventTracker();
    tracker.construct(() => new Issue(tracker, { status: "closed", priority: 3 }));
    expect(emitted(tracker)).toEqual([]);
    expect(tracker.isDirty).toBe(false);
  });

  it("a commit right after tracker.new() sends nothing", async () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    let called = false;
    expect(await tracker.commit(() => { called = true; })).toBe(false);
    expect(called).toBe(false);
  });
});

// ---------------------------------------------------------------------------- tracker.new() + EventTrackedCollection

describe("tracker.new() — object pushed to an EventTrackedCollection", () => {
  class Task extends TrackedObject {
    @AutoId id: number = 0;
    @EventTracked()
    accessor type: string = "default";
    constructor(t: EventLog, type: string) {
      super(t);
      this.type = type;
    }
  }

  it("object created with non-default constructor value is Unchanged after tracker.new()", () => {
    const tracker = newEventTracker();
    const task = tracker.new(() => new Task(tracker, "custom"));
    expect("chronicleState" in task).toBe(false);
  });

  it("pushing a tracker.new() object reports its addition with its snapshot", () => {
    const tracker = newEventTracker();
    const collection = new EventTrackedCollection<Task>(tracker, "tasks");
    const task = tracker.new(() => new Task(tracker, "custom"));
    collection.push(task);

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      tasks: { added: [{ chronicleId: task.chronicleId, id: null, type: "custom" }], removed: [], changed: [] },
    });
  });

  it("once the addition is committed, the object is no longer new", () => {
    const tracker = newEventTracker();
    const collection = new EventTrackedCollection<Task>(tracker, "tasks");
    const task = tracker.new(() => new Task(tracker, "custom"));
    collection.push(task);
    tracker._onCommit(pendingIds(tracker), [{ chronicleId: task.chronicleId, value: 4 }]);
    task.type = "edited";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { tasks: { added: [], removed: [], changed: [{ id: 4, type: "edited" }] } },
    ]);
  });
});

// ---------------------------------------------------------------------------- redo after compensating commit

describe("EventLog — redo after compensating commit produces a fresh event", () => {
  class Item extends TrackedObject {
    @Id id: number = 0;
    constructor(tracker: EventLog, id: number) {
      super(tracker);
      this.id = id;
    }
  }

  class Container extends TrackedContainer {
    readonly items: EventTrackedCollection<Item>;
    constructor(tracker: EventLog, initial: Item[]) {
      super(tracker);
      this.items = new EventTrackedCollection(tracker, "items", initial);
      this.trackChild(this.items);
    }
  }

  it("mutate → commit → undo → commit → redo re-materializes the original event", () => {
    const tracker = newEventTracker();
    const initial = [tracker.construct(() => new Item(tracker, 1))];
    tracker.construct(() => new Container(tracker, initial));
    const container = tracker._trackedObjects.find(o => o instanceof Container) as Container;

    // (1) Add id=2, save
    const two = tracker.new(() => new Item(tracker, 2));
    container.items.push(two);
    expect(emitted(tracker)).toEqual([
      { chronicleId: container.chronicleId, payload: { items: { added: [{ id: 2 }], removed: [], changed: [] } } },
    ]);
    tracker._onCommit(pendingIds(tracker));

    // (2) Undo, save — the compensating event shifts the baseline
    tracker.undo();
    expect(emitted(tracker)).toEqual([
      { chronicleId: container.chronicleId, payload: { items: { added: [], removed: [2], changed: [] } } },
    ]);
    tracker._onCommit(pendingIds(tracker));

    // (3) Redo — should re-mutate from the new baseline
    tracker.redo();
    expect(emitted(tracker)).toEqual([
      { chronicleId: container.chronicleId, payload: { items: { added: [{ id: 2 }], removed: [], changed: [] } } },
    ]);
  });

  it("full cycle: redo → commit → undo yields the compensating event again", () => {
    const tracker = newEventTracker();
    const initial = [tracker.construct(() => new Item(tracker, 1))];
    tracker.construct(() => new Container(tracker, initial));
    const container = tracker._trackedObjects.find(o => o instanceof Container) as Container;

    const two = tracker.new(() => new Item(tracker, 2));
    container.items.push(two);
    tracker._onCommit(pendingIds(tracker));

    tracker.undo();
    tracker._onCommit(pendingIds(tracker));

    tracker.redo();
    tracker._onCommit(pendingIds(tracker));

    tracker.undo();
    expect(emitted(tracker)).toEqual([
      { chronicleId: container.chronicleId, payload: { items: { added: [], removed: [2], changed: [] } } },
    ]);
  });

  it("mutate → commit → undo → redo (no compensating commit) still leaves items Unchanged", () => {
    const tracker = newEventTracker();
    const initial = [tracker.construct(() => new Item(tracker, 1))];
    tracker.construct(() => new Container(tracker, initial));
    const container = tracker._trackedObjects.find(o => o instanceof Container) as Container;

    const two = tracker.new(() => new Item(tracker, 2));
    container.items.push(two);
    tracker._onCommit(pendingIds(tracker));

    tracker.undo();
    tracker.redo();

    expect("chronicleState" in two).toBe(false);
    expect(emitted(tracker)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------- undo after commit of an UNRELATED later op

describe("EventLog — undo after commit only reverses the undone op, leaves committed inserts alone", () => {
  class Item extends TrackedObject {
    @Id readonly id: number;
    constructor(tracker: EventLog, id: number) {
      super(tracker);
      this.id = id;
    }
  }

  class Container extends TrackedContainer {
    @EventTracked() accessor phase: "a" | "b" = "a";
    readonly items: EventTrackedCollection<Item>;
    constructor(tracker: EventLog) {
      super(tracker);
      this.items = new EventTrackedCollection<Item>(tracker, "items");
      this.trackChild(this.items);
    }
  }

  function setup() {
    const tracker = newEventTracker();
    const c = tracker.new(() => new Container(tracker));
    const item = tracker.new(() => new Item(tracker, 42));
    c.items.push(item);           // op A — insert into collection
    c.phase = "b";                 // op B — LAST op on undo stack, unrelated to item
    tracker._onCommit(pendingIds(tracker));            // both persisted
    return { tracker, c, item };
  }

  it("commit_then_undo_preserves_committed_inserts", () => {
    const { tracker, c, item } = setup();

    expect(c.items.collection).toContain(item);
    expect("chronicleState" in c).toBe(false);
    expect(c.phase).toBe("b");

    tracker.undo();

    expect(c.phase).toBe("a");
    // item's committed Insert must not have been rolled back — it stays Unchanged
    // even though an unrelated later operation was undone.
    expect("chronicleState" in item).toBe(false);
    expect(c.items.collection).toContain(item);
    // EventLog objects carry no Insert/Changed/Deleted state — the undo shows up
    // only as a compensating `phase` event.
  });

  it("commit_then_undo_no_spurious_removed", () => {
    const { tracker, c, item } = setup();

    tracker.undo();

    const events = emitted(tracker);
    // The only real change is phase going b → a. There must be no "items" event
    // targeting `item`, because the user never removed it and it is still in c.items.
    for (const e of events) {
      const removed = (e.payload as { items?: { removed: unknown[] } }).items?.removed ?? [];
      expect(removed).not.toContain(item.id);
      expect(removed).not.toContainEqual({ id: item.id });
    }
    expect(events.map((e) => e.payload)).toEqual([{ phase: "a" }]);
  });

  it("commit_then_undo_only_reverses_last_op", () => {
    const { tracker, c, item } = setup();

    tracker.undo();

    // No tracked object is ever marked Deleted on an EventLog:
    // item is in the collection → its state must not be Deleted.
    for (const listed of c.items.collection) {
      expect("chronicleState" in listed).toBe(false);
    }
    expect(c.items.collection).toContain(item);
  });

  it("commit_then_undo_then_redo", () => {
    const { tracker, c, item } = setup();

    tracker.undo();
    tracker.redo();

    expect(c.phase).toBe("b");
    expect("chronicleState" in item).toBe(false);
    expect(c.phase).toBe("b");
    expect(c.items.collection).toContain(item);
    expect(emitted(tracker)).toEqual([]);
  });
});

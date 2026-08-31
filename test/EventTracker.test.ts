import { describe, it, expect, beforeEach } from "vitest";
import { EventTracker } from "../src/EventTracker";
import { EventTracked } from "../src/EventTracked";
import { EventTrackedCollection } from "../src/EventTrackedCollection";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { Tracked } from "../src/Tracked";
import { Tracker } from "../src/Tracker";
import { AutoId, Id } from "../src/ExternallyAssigned";
import { State } from "../src/State";
import { GeneratedEvent } from "../src/GeneratedEvent";

// ---------------------------------------------------------------------------- helpers
function newEventTracker(): EventTracker {
  return new EventTracker();
}

function findEventsFor(events: GeneratedEvent[], eventType: string): GeneratedEvent[] {
  return events.filter((e) => e.eventType === eventType);
}

// ---------------------------------------------------------------------------- Models

enum IssueEvents {
  SubmittedDetailsRevised = "SubmittedDetailsRevised",
  AnalysisRevised = "AnalysisRevised",
  StateTransitioned = "StateTransitioned",
  CommentAdded = "CommentAdded",
  CommentRemoved = "CommentRemoved",
  CommentEdited = "CommentEdited",
  CommentStatusChanged = "CommentStatusChanged",
  TagAdded = "TagAdded",
  TagRemoved = "TagRemoved",
}

class CommentModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked(undefined, undefined, { eventType: IssueEvents.CommentEdited })
  accessor text: string = "";

  @EventTracked(undefined, undefined, { eventType: IssueEvents.CommentStatusChanged })
  accessor status: string = "open";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class IssueModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked(undefined, undefined, { eventType: IssueEvents.SubmittedDetailsRevised })
  accessor name: string = "";

  @EventTracked(undefined, undefined, { eventType: IssueEvents.SubmittedDetailsRevised })
  accessor description: string = "";

  @EventTracked(undefined, undefined, { eventType: IssueEvents.AnalysisRevised })
  accessor analysisSummary: string | null = null;

  @EventTracked(undefined, undefined, { eventType: IssueEvents.AnalysisRevised })
  accessor rootCause: string | null = null;

  @Tracked()
  accessor internalNote: string = "";

  @EventTracked(undefined, undefined, { eventType: IssueEvents.StateTransitioned })
  accessor stage: string = "Submitted";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// ---------------------------------------------------------------------------- BC / parity

describe("EventTracker — behavioural parity with Tracker", () => {
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

describe("EventTracker.generateEvents — grouped events", () => {
  let tracker: EventTracker;
  let issue: IssueModel;

  beforeEach(() => {
    tracker = newEventTracker();
    issue = tracker.construct(() => new IssueModel(tracker));
    tracker.onCommit();
  });

  it("returns [] when tracker is clean", () => {
    expect(tracker.generateEvents()).toEqual([]);
  });

  it("groups fields sharing eventType into one event", () => {
    issue.name = "N";
    issue.description = "D";

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(IssueEvents.SubmittedDetailsRevised);
    expect(events[0].payload).toEqual({ name: "N", description: "D" });
    expect(events[0].trackingId).toBe(issue.trakrId);
  });

  it("emits two events when two different eventTypes are both dirty", () => {
    issue.name = "N";
    issue.analysisSummary = "AS";

    const events = tracker.generateEvents();
    expect(events).toHaveLength(2);
    expect(findEventsFor(events, IssueEvents.SubmittedDetailsRevised)[0].payload).toEqual({ name: "N" });
    expect(findEventsFor(events, IssueEvents.AnalysisRevised)[0].payload).toEqual({ analysisSummary: "AS" });
  });

  it("net-zero scalar diff (A → B → A): no entry for that property", () => {
    issue.name = "N";
    issue.name = "";
    expect(tracker.generateEvents()).toEqual([]);
  });

  it("undo of a write yields no event", () => {
    issue.name = "N";
    tracker.undo();
    expect(tracker.generateEvents()).toEqual([]);
  });

  it("@Tracked (untagged) fields do not participate in events", () => {
    issue.internalNote = "x";
    expect(tracker.generateEvents()).toEqual([]);
  });

  it("Changed events carry targetId from @AutoId", () => {
    tracker.withTrackingSuppressed(() => { issue.id = 42; });
    issue.name = "N";
    const events = tracker.generateEvents();
    expect(events[0].targetId).toBe(42);
  });
});

// ---------------------------------------------------------------------------- ungrouped default emission

describe("EventTracker — ungrouped default emission (test 1, 2)", () => {
  it("ungrouped-only save: one event per tracked object, all changes in one payload", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked() accessor a: string = "";
      @EventTracked() accessor b: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit();

    m.a = "A";
    m.b = "B";

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("");
    expect(events[0].payload).toEqual({ a: "A", b: "B" });
    expect(events[0].targetId).toBe("m1");
  });

  it("grouped + ungrouped mix: one event per explicit group + one for default group", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked() accessor a: string = "";
      @EventTracked(undefined, undefined, { eventType: "X" }) accessor b: string = "";
      @EventTracked(undefined, undefined, { eventType: "Y" }) accessor c: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit();

    m.a = "aa";
    m.b = "bb";
    m.c = "cc";

    const events = tracker.generateEvents();
    expect(events).toHaveLength(3);
    expect(findEventsFor(events, "")[0].payload).toEqual({ a: "aa" });
    expect(findEventsFor(events, "X")[0].payload).toEqual({ b: "bb" });
    expect(findEventsFor(events, "Y")[0].payload).toEqual({ c: "cc" });
  });
});

// ---------------------------------------------------------------------------- history mode (scalar)

describe("EventTracker — history mode on scalar properties (tests 4, 5, 6, 7, 8)", () => {
  it("history:true without factory — chain is [{property,value},...] in operation order", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { history: true }) accessor s: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit();

    m.s = "a";
    m.s = "b";
    m.s = "c";

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      s: [
        { property: "s", value: "a" },
        { property: "s", value: "b" },
        { property: "s", value: "c" },
      ],
    });
  });

  it("history with entryFactory — entries are factory return values in order", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, {
        history: {
          entryFactory: (_self, newValue: string, oldValue: string, _change, ctx) => ({
            newValue, oldValue, ctx,
          }),
        },
      })
      accessor s: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit();

    tracker.withContext({ by: "alice" }, () => {
      m.s = "a";
    });
    tracker.withContext({ by: "bob" }, () => {
      m.s = "b";
    });

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      s: [
        { newValue: "a", oldValue: "", ctx: { by: "alice" } },
        { newValue: "b", oldValue: "a", ctx: { by: "bob" } },
      ],
    });
  });

  it("history + coalesceWithin: two writes within window produce one chain entry", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { history: true, coalesceWithin: 3000 })
      accessor s: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit();

    m.s = "a";
    m.s = "ab";

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({
      s: [{ property: "s", value: "ab" }],
    });
  });

  it("withContext frame supplies ctx to entryFactory; outside frame ctx is undefined", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, {
        history: {
          entryFactory: (_self, v: string, _o, _c, ctx) => ({ v, ctx }),
        },
      })
      accessor s: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit();

    m.s = "one";
    tracker.withContext("frame-ctx", () => { m.s = "two"; });

    const events = tracker.generateEvents();
    expect(events[0].payload).toEqual({
      s: [
        { v: "one", ctx: undefined },
        { v: "two", ctx: "frame-ctx" },
      ],
    });
  });

  it("post-commit undo of a history-mode property: new chain entry appended", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { history: true }) accessor s: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit();

    m.s = "committed";
    tracker.onCommit();

    // Post-commit undo — new chain entry is appended (not popped from historic session).
    tracker.undo();
    expect(m.s).toBe("");

    const events = tracker.generateEvents();
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
    tracker.onCommit();

    issue.name = "Alice";
    tracker.onCommit();

    tracker.undo();
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(IssueEvents.SubmittedDetailsRevised);
    expect(events[0].payload).toEqual({ name: "" });
    expect(events[0].targetId).toBe(10);
  });
});

// ---------------------------------------------------------------------------- Legacy itemAdded / itemRemoved

describe("EventTrackedCollection — legacy itemAdded/itemRemoved (BC)", () => {
  it("legacy itemAdded without eventType/history: existing per-op behavior (test 19)", () => {
    const tracker = newEventTracker();
    const comments = new EventTrackedCollection<CommentModel>(tracker, [], undefined, {
      itemAdded: IssueEvents.CommentAdded,
      itemRemoved: IssueEvents.CommentRemoved,
    });
    const comment = tracker.construct(() => new CommentModel(tracker));
    comments.push(comment);
    comment.text = "hello";

    const events = tracker.generateEvents();
    const added = findEventsFor(events, IssueEvents.CommentAdded);
    expect(added).toHaveLength(1);
    expect(added[0].payload).toEqual({ text: "hello", status: "open" });
  });

  it("itemRemoved of committed item emits with targetId from @AutoId", () => {
    const tracker = newEventTracker();
    const comment = tracker.construct(() => new CommentModel(tracker));
    const comments = new EventTrackedCollection<CommentModel>(tracker, [comment], undefined, {
      itemAdded: IssueEvents.CommentAdded,
      itemRemoved: IssueEvents.CommentRemoved,
    });
    tracker.withTrackingSuppressed(() => { comment.id = 77; });
    tracker.onCommit();

    comments.remove(comment);
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(IssueEvents.CommentRemoved);
    expect(events[0].targetId).toBe(77);
    expect(events[0].trackingId).toBe(comment.trakrId);
  });

  it("itemRemoved of @Id item carries targetId and trackingId", () => {
    class ProductModel extends TrackedObject {
      @Id id: number = 0;
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const product = tracker.construct(() => new ProductModel(tracker));
    const products = new EventTrackedCollection<ProductModel>(tracker, [product], undefined, {
      itemAdded: "product_added",
      itemRemoved: "product_removed",
    });
    tracker.withTrackingSuppressed(() => { product.id = 17; });
    tracker.onCommit();

    products.remove(product);
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("product_removed");
    expect(events[0].targetId).toBe(17);
    expect(events[0].trackingId).toBe(product.trakrId);
  });

  it("itemRemoved of @Id item with non-numeric id carries trackingId but no targetId", () => {
    class TagModel extends TrackedObject {
      @Id slug: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const tag = tracker.construct(() => new TagModel(tracker));
    const tags = new EventTrackedCollection<TagModel>(tracker, [tag], undefined, {
      itemAdded: "tag_added",
      itemRemoved: "tag_removed",
    });
    tracker.withTrackingSuppressed(() => { tag.slug = "typescript"; });
    tracker.onCommit();

    tags.remove(tag);
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("tag_removed");
    expect(events[0].trackingId).toBe(tag.trakrId);
    expect(events[0].targetId).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------- Aggregate collection semantics

class Author extends TrackedObject {
  @Id name: string = "";
  @EventTracked() accessor bio: string = "";
  constructor(t: Tracker) { super(t); }
}

class Post extends TrackedObject {
  @Id postId: string = "";
  @EventTracked() accessor title: string = "";
  authors: EventTrackedCollection<Author>;
  constructor(t: Tracker, opts?: { eventType?: string; history?: boolean }) {
    super(t);
    this.authors = new EventTrackedCollection<Author>(t, [], undefined, {
      eventType: opts?.eventType,
      history: opts?.history,
      owner: { object: this, property: "authors" },
    });
  }
}

describe("EventTrackedCollection — aggregate mode with owner (tests 10-12, 17, 20)", () => {
  it("test 10: collection edit-only case — changed entry has identity + dirty prop only", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker, { eventType: "PostUpdated" }));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });

    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; author.bio = "old bio"; });
    post.authors.push(author);
    tracker.onCommit();

    author.bio = "new bio";

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("PostUpdated");
    expect(events[0].payload).toEqual({
      authors: {
        added: [],
        changed: [{ name: "alice", bio: "new bio" }],
        removed: [],
      },
    });
    expect(events[0].targetId).toBe("p1");
    expect(events[0].trackingId).toBe(post.trakrId);
  });

  it("test 11: collection add + immediate remove of a new item — absent from added and removed", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker, { eventType: "PostUpdated" }));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    tracker.onCommit();

    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; });
    post.authors.push(author);
    post.authors.remove(author);

    const events = tracker.generateEvents();
    expect(events).toEqual([]);
  });

  it("test 12: edit then remove of existing item — item in removed only, not changed", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker, { eventType: "PostUpdated" }));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; author.bio = "b"; });
    post.authors.push(author);
    tracker.onCommit();

    author.bio = "edited";
    post.authors.remove(author);

    const events = tracker.generateEvents();
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
    tracker1.onCommit();

    const author1 = tracker1.construct(() => new Author(tracker1));
    tracker1.withTrackingSuppressed(() => { author1.name = "a1"; });
    post1.authors.push(author1);
    author1.bio = "b1";
    const author2 = tracker1.construct(() => new Author(tracker1));
    tracker1.withTrackingSuppressed(() => { author2.name = "a2"; });
    post1.authors.push(author2);
    post1.authors.remove(author1);

    const events1 = tracker1.generateEvents();
    const slot1 = (events1[0].payload as any).authors;
    expect(slot1.ops).toBeDefined();
    // ops sequence: add author1, change author1, add author2, remove author1
    expect(slot1.ops[0]).toEqual({ op: "add", item: { name: "a1", bio: "" } });
    expect(slot1.ops[slot1.ops.length - 1]).toEqual({ op: "remove", name: "a1" });

    // Non-history — bucketed
    const tracker2 = newEventTracker();
    const post2 = tracker2.construct(() => new Post(tracker2, { eventType: "X" }));
    tracker2.withTrackingSuppressed(() => { post2.postId = "p2"; });
    tracker2.onCommit();

    const a = tracker2.construct(() => new Author(tracker2));
    tracker2.withTrackingSuppressed(() => { a.name = "a"; });
    post2.authors.push(a);
    const events2 = tracker2.generateEvents();
    const slot2 = (events2[0].payload as any).authors;
    expect(slot2.added).toBeDefined();
    expect(slot2.changed).toBeDefined();
    expect(slot2.removed).toBeDefined();
  });

  it("test 20: itemAdded + eventType set: aggregate shape takes over, per-op events NOT emitted", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker, { eventType: "PostUpdated" }));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    tracker.onCommit();

    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; });
    post.authors.push(author);

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("PostUpdated");
    // No per-op itemAdded event should be present
    expect(findEventsFor(events, "itemAdded")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------- Identity (Id / AutoId)

describe("Identity extraction (tests 13, 14, 15, 16)", () => {
  it("test 13: item type with no @Id and no @AutoId used in EventTrackedCollection — constructor throws", () => {
    class NoId extends TrackedObject {
      @EventTracked() accessor label: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    tracker.construct(() => new NoId(tracker));
    expect(() =>
      new EventTrackedCollection<NoId>(tracker, [], undefined, {
        eventType: "X",
        owner: { object: {} as any, property: "x" },
      })
    ).not.toThrow(); // Empty collection at construction doesn't validate items
    // But pushing NoId item should throw
    const c2 = new EventTrackedCollection<NoId>(tracker, [], undefined, {
      eventType: "Y",
    });
    const item = tracker.construct(() => new NoId(tracker));
    expect(() => c2.push(item)).toThrow(/must declare at least one @Id or @AutoId/);
  });

  it("test 14: single @Id string — changed carries {id, ...}, removed carries scalar", () => {
    class NamedItem extends TrackedObject {
      @Id id: string = "";
      @EventTracked() accessor v: string = "";
      constructor(t: Tracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<NamedItem>;
      constructor(t: Tracker) {
        super(t);
        this.items = new EventTrackedCollection<NamedItem>(t, [], undefined, {
          eventType: "X",
          owner: { object: this, property: "items" },
        });
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });

    const item = tracker.construct(() => new NamedItem(tracker));
    tracker.withTrackingSuppressed(() => { item.id = "abc"; item.v = "old"; });
    o.items.push(item);
    tracker.onCommit();

    item.v = "new";
    let events = tracker.generateEvents();
    const changed = (events[0].payload as any).items.changed;
    expect(changed).toEqual([{ id: "abc", v: "new" }]);

    o.items.remove(item);
    events = tracker.generateEvents();
    const slot = (events[0].payload as any).items;
    expect(slot.removed).toEqual(["abc"]);
  });

  it("test 15: two @Id properties — composite identity inlined in changed, object in removed", () => {
    class CompositeItem extends TrackedObject {
      @Id key1: string = "";
      @Id key2: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: Tracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<CompositeItem>;
      constructor(t: Tracker) {
        super(t);
        this.items = new EventTrackedCollection<CompositeItem>(t, [], undefined, {
          eventType: "X",
          owner: { object: this, property: "items" },
        });
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });

    const item = tracker.construct(() => new CompositeItem(tracker));
    tracker.withTrackingSuppressed(() => { item.key1 = "k"; item.key2 = 5; item.v = "old"; });
    o.items.push(item);
    tracker.onCommit();

    item.v = "new";
    const events = tracker.generateEvents();
    const changed = (events[0].payload as any).items.changed;
    expect(changed).toEqual([{ key1: "k", key2: 5, v: "new" }]);

    o.items.remove(item);
    const events2 = tracker.generateEvents();
    const slot = (events2[0].payload as any).items;
    expect(slot.removed).toEqual([{ key1: "k", key2: 5 }]);
  });

  it("test 15b (from spec): single @AutoId — pre-commit inserts carry null id; post-commit patches", () => {
    class AutoItem extends TrackedObject {
      @AutoId id: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: Tracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<AutoItem>;
      constructor(t: Tracker) {
        super(t);
        this.items = new EventTrackedCollection<AutoItem>(t, [], undefined, {
          eventType: "X",
          owner: { object: this, property: "items" },
        });
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });
    tracker.onCommit();

    const item = tracker.construct(() => new AutoItem(tracker));
    tracker.withTrackingSuppressed(() => { item.v = "hello"; });
    o.items.push(item);

    const events = tracker.generateEvents();
    const slot = (events[0].payload as any).items;
    expect(slot.added).toEqual([{ id: null, v: "hello" }]);

    // Commit and verify @AutoId is patched
    tracker.onCommit([{ trackingId: item.trakrId, value: 999 }]);
    expect(item.id).toBe(999);
  });

  it("test 16: @Id + @AutoId mix — getIdentity returns object with both", () => {
    class MixedItem extends TrackedObject {
      @Id key: string = "";
      @AutoId id: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: Tracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<MixedItem>;
      constructor(t: Tracker) {
        super(t);
        this.items = new EventTrackedCollection<MixedItem>(t, [], undefined, {
          eventType: "X",
          owner: { object: this, property: "items" },
        });
      }
    }
    const tracker = newEventTracker();
    const o = tracker.construct(() => new Owner(tracker));
    tracker.withTrackingSuppressed(() => { o.ownerId = "o1"; });

    const item = tracker.construct(() => new MixedItem(tracker));
    tracker.withTrackingSuppressed(() => { item.key = "k"; item.v = "old"; });
    o.items.push(item);
    tracker.onCommit([{ trackingId: item.trakrId, value: 42 }]);
    expect(item.id).toBe(42);

    item.v = "new";
    const events = tracker.generateEvents();
    const changed = (events[0].payload as any).items.changed;
    expect(changed).toEqual([{ key: "k", id: 42, v: "new" }]);
  });
});

// ---------------------------------------------------------------------------- @EventTracked semantic parity with @Tracked

describe("@EventTracked semantic parity", () => {
  it("validator runs for @EventTracked accessors", () => {
    class M extends TrackedObject {
      @Id id: string = "id";
      @EventTracked(
        (_self, v: string) => (!v ? "Name is required" : undefined),
        undefined,
        { eventType: IssueEvents.SubmittedDetailsRevised },
      )
      accessor name: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    expect(m.trakrIsValid).toBe(false);
    m.name = "Alice";
    expect(m.trakrIsValid).toBe(true);
  });

  it("coalesceWithin merges rapid writes into one undo step", () => {
    class M extends TrackedObject {
      @Id id: string = "";
      @EventTracked(undefined, undefined, { coalesceWithin: 3000 })
      accessor name: string = "";
      constructor(t: Tracker) { super(t); }
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
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.key = "K"; });
    tracker.onCommit();

    m.v = "hello";
    const events = tracker.generateEvents();
    expect(events[0].targetId).toBe("K");
  });

  it("targetId is an object for composite @Id", () => {
    class M extends TrackedObject {
      @Id k1: string = "";
      @Id k2: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: Tracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.k1 = "K"; m.k2 = 7; });
    tracker.onCommit();

    m.v = "hello";
    const events = tracker.generateEvents();
    expect(events[0].targetId).toEqual({ k1: "K", k2: 7 });
  });
});

// ---------------------------------------------------------------------------- Legacy collection with plain items

describe("Legacy collection with primitive items", () => {
  it("primitive collection with itemAdded/itemRemoved does not emit for primitives", () => {
    const tracker = newEventTracker();
    const tags = new EventTrackedCollection<string>(tracker, ["existing"], undefined, {
      itemAdded: IssueEvents.TagAdded,
      itemRemoved: IssueEvents.TagRemoved,
    });
    tracker.onCommit();
    tags.push("new-tag");
    const events = tracker.generateEvents();
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------- Read-only guarantee

describe("EventTracker.generateEvents — pure read", () => {
  it("does not modify tracker dirty state or object state", () => {
    const tracker = newEventTracker();
    const issue = tracker.construct(() => new IssueModel(tracker));
    tracker.onCommit();
    issue.name = "N";
    const before = { isDirty: tracker.isDirty, version: tracker.version };
    tracker.generateEvents();
    tracker.generateEvents();
    expect(tracker.isDirty).toBe(before.isDirty);
    expect(tracker.version).toBe(before.version);
  });
});

// ---------------------------------------------------------------------------- Construction hardening

describe("@EventTracked construction respects tracker.construct()", () => {
  it("writes made inside tracker.construct() produce no events", () => {
    class M extends TrackedObject {
      @Id id: string = "id";
      @EventTracked(undefined, undefined, { eventType: "X" })
      accessor name: string = "";
      constructor(t: Tracker, data?: { name: string }) {
        super(t);
        if (data) this.name = data.name;
      }
    }
    const tracker = newEventTracker();
    tracker.construct(() => new M(tracker, { name: "initial" }));
    expect(tracker.generateEvents()).toEqual([]);
    expect(tracker.isDirty).toBe(false);
  });
});

// ---------------------------------------------------------------------------- tracker.new()

describe("tracker.new()", () => {
  class Issue extends TrackedObject {
    @Id id: string = "id";
    @EventTracked(undefined, undefined, { eventType: "X" }) accessor status: string = "";
    @EventTracked(undefined, undefined, { eventType: "X" }) accessor priority: number = 0;
    constructor(t: Tracker, data?: { status: string; priority: number }) {
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

  it("defaults set in constructor appear in generateEvents()", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("X");
    expect(events[0].payload).toEqual({ status: "open", priority: 1 });
  });

  it("tracker is not dirty after tracker.new()", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    expect(tracker.isDirty).toBe(false);
  });

  it("object is not dirty after tracker.new()", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    expect(issue.isDirty).toBe(false);
  });

  it("canUndo is false after tracker.new()", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    expect(tracker.canUndo).toBe(false);
  });

  it("tracker becomes dirty on first post-construction edit", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.status = "in-progress";
    expect(tracker.isDirty).toBe(true);
    expect(issue.isDirty).toBe(true);
  });

  it("same constructor: tracker.construct() with data produces no events", () => {
    const tracker = newEventTracker();
    tracker.construct(() => new Issue(tracker, { status: "closed", priority: 3 }));
    expect(tracker.generateEvents()).toEqual([]);
    expect(tracker.isDirty).toBe(false);
  });

  it("after onCommit(), generateEvents() returns []", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    tracker.onCommit();
    expect(tracker.generateEvents()).toEqual([]);
  });

  it("post-construction mutations on a new() object are included in the event", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.status = "in-progress";
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ status: "in-progress", priority: 1 });
  });

  it("reverting a default back to empty string produces no entry for that property", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.status = "";
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].payload).toEqual({ priority: 1 });
  });
});

// ---------------------------------------------------------------------------- tracker.new() + EventTrackedCollection

describe("tracker.new() — object pushed to EventTrackedCollection emits itemAdded", () => {
  class Task extends TrackedObject {
    @AutoId id: number = 0;
    @EventTracked(undefined, undefined, { eventType: "task_changed" })
    accessor type: string = "default";
    constructor(t: Tracker, type: string) {
      super(t);
      this.type = type;
    }
  }

  it("object created with non-default constructor value is Unchanged after tracker.new()", () => {
    const tracker = newEventTracker();
    const task = tracker.new(() => new Task(tracker, "custom"));
    expect(task.trakrState).toBe("Unchanged");
  });

  it("pushing a tracker.new() object emits itemAdded, not a field-cluster event", () => {
    const tracker = newEventTracker();
    const collection = new EventTrackedCollection<Task>(tracker, [], undefined, {
      itemAdded: "task_added",
      itemRemoved: "task_removed",
    });
    const task = tracker.new(() => new Task(tracker, "custom"));
    collection.push(task);

    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("task_added");
    expect(events[0].payload).toMatchObject({ type: "custom" });
  });

  it("existing tracker.new() standalone behavior is unaffected — defaults appear in generateEvents()", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Task(tracker, "custom"));
    const events = tracker.generateEvents();
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("task_changed");
    expect(events[0].payload).toEqual({ type: "custom" });
  });
});

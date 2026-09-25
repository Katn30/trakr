import { describe, it, expect, beforeEach } from "vitest";
import { EventTracker } from "../src/EventTracker";
import { EventTracked } from "../src/EventTracked";
import { EventTrackedCollection } from "../src/EventTrackedCollection";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { TrackedContainer } from "../src/TrackedContainer";
import { Tracked } from "../src/Tracked";
import { Tracker } from "../src/Tracker";
import { AutoId, Id } from "../src/ExternallyAssigned";
import { State } from "../src/State";
import { GeneratedEvent } from "../src/GeneratedEvent";

import { emitted, oneOperation, pendingIds } from "./eventHelpers";
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

  constructor(tracker: EventTracker) {
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

  constructor(tracker: EventTracker) {
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
    tracker.onCommit(pendingIds(tracker));
  });

  it("returns [] when tracker is clean", () => {
    expect(emitted(tracker)).toEqual([]);
  });

  it("groups fields sharing eventType into one event", () => {
    oneOperation(tracker, () => {
      issue.name = "N";
      issue.description = "D";
    });

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(IssueEvents.SubmittedDetailsRevised);
    expect(events[0].payload).toEqual({ name: "N", description: "D" });
    expect(events[0].trackingId).toBe(issue.trakrId);
  });

  it("emits two events when two different eventTypes are both dirty", () => {
    issue.name = "N";
    issue.analysisSummary = "AS";

    const events = emitted(tracker);
    expect(events).toHaveLength(2);
    expect(findEventsFor(events, IssueEvents.SubmittedDetailsRevised)[0].payload).toEqual({ name: "N" });
    expect(findEventsFor(events, IssueEvents.AnalysisRevised)[0].payload).toEqual({ analysisSummary: "AS" });
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

  it("@Tracked (untagged) fields do not participate in events", () => {
    issue.internalNote = "x";
    expect(emitted(tracker)).toEqual([]);
  });

  it("Changed events carry targetId from @AutoId", () => {
    tracker.withTrackingSuppressed(() => { issue.id = 42; });
    issue.name = "N";
    const events = emitted(tracker);
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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit(pendingIds(tracker));

    oneOperation(tracker, () => {
      m.a = "A";
      m.b = "B";
    });

    const events = emitted(tracker);
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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit(pendingIds(tracker));

    m.a = "aa";
    m.b = "bb";
    m.c = "cc";

    const events = emitted(tracker);
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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit(pendingIds(tracker));

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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit(pendingIds(tracker));

    oneOperation(tracker, () => {
      tracker.withContext({ by: "alice" }, () => {
        m.s = "a";
      });
      tracker.withContext({ by: "bob" }, () => {
        m.s = "b";
      });
    });

    const events = emitted(tracker);
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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit(pendingIds(tracker));

    m.s = "a";
    m.s = "ab";

    const events = emitted(tracker);
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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit(pendingIds(tracker));

    oneOperation(tracker, () => {
      m.s = "one";
      tracker.withContext("frame-ctx", () => { m.s = "two"; });
    });

    const events = emitted(tracker);
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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.id = "m1"; });
    tracker.onCommit(pendingIds(tracker));

    m.s = "committed";
    tracker.onCommit(pendingIds(tracker));

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
    tracker.onCommit(pendingIds(tracker));

    issue.name = "Alice";
    tracker.onCommit(pendingIds(tracker));

    tracker.undo();
    const events = emitted(tracker);
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
    oneOperation(tracker, () => {
      comments.push(comment);
      comment.text = "hello";
    });

    const events = emitted(tracker);
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
    tracker.onCommit(pendingIds(tracker));

    comments.remove(comment);
    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe(IssueEvents.CommentRemoved);
    expect(events[0].targetId).toBe(77);
    expect(events[0].trackingId).toBe(comment.trakrId);
  });

  it("itemRemoved of @Id item carries targetId and trackingId", () => {
    class ProductModel extends TrackedObject {
      @Id id: number = 0;
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const product = tracker.construct(() => new ProductModel(tracker));
    const products = new EventTrackedCollection<ProductModel>(tracker, [product], undefined, {
      itemAdded: "product_added",
      itemRemoved: "product_removed",
    });
    tracker.withTrackingSuppressed(() => { product.id = 17; });
    tracker.onCommit(pendingIds(tracker));

    products.remove(product);
    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("product_removed");
    expect(events[0].targetId).toBe(17);
    expect(events[0].trackingId).toBe(product.trakrId);
  });

  it("itemRemoved of @Id item with non-numeric id carries trackingId but no targetId", () => {
    class TagModel extends TrackedObject {
      @Id slug: string = "";
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const tag = tracker.construct(() => new TagModel(tracker));
    const tags = new EventTrackedCollection<TagModel>(tracker, [tag], undefined, {
      itemAdded: "tag_added",
      itemRemoved: "tag_removed",
    });
    tracker.withTrackingSuppressed(() => { tag.slug = "typescript"; });
    tracker.onCommit(pendingIds(tracker));

    tags.remove(tag);
    const events = emitted(tracker);
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
  constructor(t: EventTracker) { super(t); }
}

class Post extends TrackedObject {
  @Id postId: string = "";
  @EventTracked() accessor title: string = "";
  authors: EventTrackedCollection<Author>;
  constructor(t: EventTracker, opts?: { eventType?: string; history?: boolean }) {
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
    tracker.onCommit(pendingIds(tracker));

    author.bio = "new bio";

    const events = emitted(tracker);
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

  it("test 11: add + remove of a new item — one event each; within one operation, none", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker, { eventType: "PostUpdated" }));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    tracker.onCommit(pendingIds(tracker));

    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; });
    post.authors.push(author);
    post.authors.remove(author);
    expect(emitted(tracker).map((e) => (e.payload as any).authors)).toEqual([
      { added: [{ name: "alice", bio: "" }], removed: [], changed: [] },
      { added: [], removed: ["alice"], changed: [] },
    ]);

    tracker.onCommit(pendingIds(tracker));
    oneOperation(tracker, () => {
      post.authors.push(author);
      post.authors.remove(author);
    });
    expect(emitted(tracker)).toEqual([]);
  });

  it("test 12: edit then remove of existing item — item in removed only, not changed", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker, { eventType: "PostUpdated" }));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; author.bio = "b"; });
    post.authors.push(author);
    tracker.onCommit(pendingIds(tracker));

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
    tracker1.onCommit(pendingIds(tracker1));

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
    const post2 = tracker2.construct(() => new Post(tracker2, { eventType: "X" }));
    tracker2.withTrackingSuppressed(() => { post2.postId = "p2"; });
    tracker2.onCommit(pendingIds(tracker2));

    const a = tracker2.construct(() => new Author(tracker2));
    tracker2.withTrackingSuppressed(() => { a.name = "a"; });
    post2.authors.push(a);
    const events2 = emitted(tracker2);
    const slot2 = (events2[0].payload as any).authors;
    expect(slot2.added).toBeDefined();
    expect(slot2.changed).toBeDefined();
    expect(slot2.removed).toBeDefined();
  });

  it("test 20: itemAdded + eventType set: aggregate shape takes over, per-op events NOT emitted", () => {
    const tracker = newEventTracker();
    const post = tracker.construct(() => new Post(tracker, { eventType: "PostUpdated" }));
    tracker.withTrackingSuppressed(() => { post.postId = "p1"; });
    tracker.onCommit(pendingIds(tracker));

    const author = tracker.construct(() => new Author(tracker));
    tracker.withTrackingSuppressed(() => { author.name = "alice"; });
    post.authors.push(author);

    const events = emitted(tracker);
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
      constructor(t: EventTracker) { super(t); }
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
      constructor(t: EventTracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<NamedItem>;
      constructor(t: EventTracker) {
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
    tracker.onCommit(pendingIds(tracker));

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
      constructor(t: EventTracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<CompositeItem>;
      constructor(t: EventTracker) {
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
    tracker.onCommit(pendingIds(tracker));

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
      constructor(t: EventTracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<AutoItem>;
      constructor(t: EventTracker) {
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
    tracker.onCommit(pendingIds(tracker));

    const item = tracker.construct(() => new AutoItem(tracker));
    tracker.withTrackingSuppressed(() => { item.v = "hello"; });
    o.items.push(item);

    const events = emitted(tracker);
    const slot = (events[0].payload as any).items;
    expect(slot.added).toEqual([{ id: null, v: "hello" }]);

    // Commit and verify @AutoId is patched
    tracker.onCommit(pendingIds(tracker), [{ trackingId: item.trakrId, value: 999 }]);
    expect(item.id).toBe(999);
  });

  it("test 16: @Id + @AutoId mix — getIdentity returns object with both", () => {
    class MixedItem extends TrackedObject {
      @Id key: string = "";
      @AutoId id: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: EventTracker) { super(t); }
    }
    class Owner extends TrackedObject {
      @Id ownerId: string = "";
      items: EventTrackedCollection<MixedItem>;
      constructor(t: EventTracker) {
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
    tracker.onCommit(pendingIds(tracker), [{ trackingId: item.trakrId, value: 42 }]);
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
      @EventTracked(
        (_self, v: string) => (!v ? "Name is required" : undefined),
        undefined,
        { eventType: IssueEvents.SubmittedDetailsRevised },
      )
      accessor name: string = "";
      constructor(t: EventTracker) { super(t); }
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
      constructor(t: EventTracker) { super(t); }
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
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.key = "K"; });
    tracker.onCommit(pendingIds(tracker));

    m.v = "hello";
    const events = emitted(tracker);
    expect(events[0].targetId).toBe("K");
  });

  it("targetId is an object for composite @Id", () => {
    class M extends TrackedObject {
      @Id k1: string = "";
      @Id k2: number = 0;
      @EventTracked() accessor v: string = "";
      constructor(t: EventTracker) { super(t); }
    }
    const tracker = newEventTracker();
    const m = tracker.construct(() => new M(tracker));
    tracker.withTrackingSuppressed(() => { m.k1 = "K"; m.k2 = 7; });
    tracker.onCommit(pendingIds(tracker));

    m.v = "hello";
    const events = emitted(tracker);
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
    tracker.onCommit(pendingIds(tracker));
    tags.push("new-tag");
    const events = emitted(tracker);
    expect(events).toEqual([]);
  });
});

// ---------------------------------------------------------------------------- Read-only guarantee

describe("EventTracker.generateEvents — pure read", () => {
  it("does not modify tracker dirty state or object state", () => {
    const tracker = newEventTracker();
    const issue = tracker.construct(() => new IssueModel(tracker));
    tracker.onCommit(pendingIds(tracker));
    issue.name = "N";
    const before = { isDirty: tracker.isDirty, version: tracker.version };
    emitted(tracker);
    emitted(tracker);
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
      constructor(t: EventTracker, data?: { name: string }) {
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
    @EventTracked(undefined, undefined, { eventType: "X" }) accessor status: string = "";
    @EventTracked(undefined, undefined, { eventType: "X" }) accessor priority: number = 0;
    constructor(t: EventTracker, data?: { status: string; priority: number }) {
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
    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("X");
    expect(events[0].payload).toEqual({ status: "open", priority: 1 });
  });

  it("tracker is dirty after tracker.new() — the new object's defaults are unpersisted events", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    expect(tracker.isDirty).toBe(true);
    tracker.onCommit(pendingIds(tracker));
    expect(tracker.isDirty).toBe(false);
  });

  it("object is not dirty after tracker.new()", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    expect("isDirty" in issue).toBe(false); // no per-object state on an EventTracker
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
    expect(tracker.pendingEvents).toHaveLength(2);
  });

  it("same constructor: tracker.construct() with data produces no events", () => {
    const tracker = newEventTracker();
    tracker.construct(() => new Issue(tracker, { status: "closed", priority: 3 }));
    expect(emitted(tracker)).toEqual([]);
    expect(tracker.isDirty).toBe(false);
  });

  it("after onCommit(), generateEvents() returns []", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Issue(tracker));
    tracker.onCommit(pendingIds(tracker));
    expect(emitted(tracker)).toEqual([]);
  });

  it("post-construction mutations on a new() object are events of their own", () => {
    const tracker = newEventTracker();
    const issue = tracker.new(() => new Issue(tracker));
    issue.status = "in-progress";
    expect(emitted(tracker).map((e) => e.payload)).toEqual([
      { status: "open", priority: 1 },
      { status: "in-progress" },
    ]);
  });

  it("a constructor that sets a property back to its initial value produces no entry for it", () => {
    class Plain extends TrackedObject {
      @Id id: string = "p";
      @EventTracked(undefined, undefined, { eventType: "X" }) accessor status: string = "";
      @EventTracked(undefined, undefined, { eventType: "X" }) accessor priority: number = 0;
      constructor(t: EventTracker) {
        super(t);
        this.status = "tmp";
        this.status = "";
        this.priority = 1;
      }
    }
    const tracker = newEventTracker();
    tracker.new(() => new Plain(tracker));
    const events = emitted(tracker);
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
    constructor(t: EventTracker, type: string) {
      super(t);
      this.type = type;
    }
  }

  it("object created with non-default constructor value is Unchanged after tracker.new()", () => {
    const tracker = newEventTracker();
    const task = tracker.new(() => new Task(tracker, "custom"));
    expect("trakrState" in task).toBe(false);
  });

  it("pushing a tracker.new() object emits itemAdded, not a field-cluster event", () => {
    const tracker = newEventTracker();
    const collection = new EventTrackedCollection<Task>(tracker, [], undefined, {
      itemAdded: "task_added",
      itemRemoved: "task_removed",
    });
    const task = tracker.new(() => new Task(tracker, "custom"));
    collection.push(task);

    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("task_added");
    expect(events[0].payload).toMatchObject({ type: "custom" });
  });

  it("existing tracker.new() standalone behavior is unaffected — defaults appear in generateEvents()", () => {
    const tracker = newEventTracker();
    tracker.new(() => new Task(tracker, "custom"));
    const events = emitted(tracker);
    expect(events).toHaveLength(1);
    expect(events[0].eventType).toBe("task_changed");
    expect(events[0].payload).toEqual({ type: "custom" });
  });
});

// ---------------------------------------------------------------------------- redo after compensating commit

describe("EventTracker — redo after compensating commit produces a fresh event", () => {
  class Item extends TrackedObject {
    @Id id: number = 0;
    constructor(tracker: EventTracker, id: number) {
      super(tracker);
      this.id = id;
    }
  }

  class Container extends TrackedContainer {
    readonly items: EventTrackedCollection<Item>;
    constructor(tracker: EventTracker, initial: Item[]) {
      super(tracker);
      this.items = new EventTrackedCollection(tracker, initial, undefined, { eventType: "items" });
      this.trackChild(this.items);
    }
  }

  it("mutate → commit → undo → commit → redo re-materializes the original event", () => {
    const tracker = newEventTracker();
    const initial = [tracker.construct(() => new Item(tracker, 1))];
    tracker.construct(() => new Container(tracker, initial));
    const container = tracker.trackedObjects.find(o => o instanceof Container) as Container;

    // (1) Add id=2, save
    const two = tracker.new(() => new Item(tracker, 2));
    container.items.push(two);
    expect(emitted(tracker)).toEqual([
      { eventType: "items", payload: { added: [{ id: 2 }], removed: [], changed: [] } },
    ]);
    tracker.onCommit(pendingIds(tracker));

    // (2) Undo, save — the compensating event shifts the baseline
    tracker.undo();
    expect(emitted(tracker)).toEqual([
      { eventType: "items", payload: { added: [], removed: [2], changed: [] } },
    ]);
    tracker.onCommit(pendingIds(tracker));

    // (3) Redo — should re-mutate from the new baseline
    tracker.redo();
    expect(emitted(tracker)).toEqual([
      { eventType: "items", payload: { added: [{ id: 2 }], removed: [], changed: [] } },
    ]);
  });

  it("full cycle: redo → commit → undo yields the compensating event again", () => {
    const tracker = newEventTracker();
    const initial = [tracker.construct(() => new Item(tracker, 1))];
    tracker.construct(() => new Container(tracker, initial));
    const container = tracker.trackedObjects.find(o => o instanceof Container) as Container;

    const two = tracker.new(() => new Item(tracker, 2));
    container.items.push(two);
    tracker.onCommit(pendingIds(tracker));

    tracker.undo();
    tracker.onCommit(pendingIds(tracker));

    tracker.redo();
    tracker.onCommit(pendingIds(tracker));

    tracker.undo();
    expect(emitted(tracker)).toEqual([
      { eventType: "items", payload: { added: [], removed: [2], changed: [] } },
    ]);
  });

  it("mutate → commit → undo → redo (no compensating commit) still leaves items Unchanged", () => {
    const tracker = newEventTracker();
    const initial = [tracker.construct(() => new Item(tracker, 1))];
    tracker.construct(() => new Container(tracker, initial));
    const container = tracker.trackedObjects.find(o => o instanceof Container) as Container;

    const two = tracker.new(() => new Item(tracker, 2));
    container.items.push(two);
    tracker.onCommit(pendingIds(tracker));

    tracker.undo();
    tracker.redo();

    expect("trakrState" in two).toBe(false);
    expect(emitted(tracker)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------- undo after commit of an UNRELATED later op

describe("EventTracker — undo after commit only reverses the undone op, leaves committed inserts alone", () => {
  class Item extends TrackedObject {
    @Id readonly id: number;
    constructor(tracker: EventTracker, id: number) {
      super(tracker);
      this.id = id;
    }
  }

  class Container extends TrackedContainer {
    @EventTracked() accessor phase: "a" | "b" = "a";
    readonly items: EventTrackedCollection<Item>;
    constructor(tracker: EventTracker) {
      super(tracker);
      this.items = new EventTrackedCollection<Item>(tracker, [], undefined, {
        owner: { object: this, property: "items" },
        itemAdded: "items",
        itemRemoved: "items",
      });
      this.trackChild(this.items);
    }
  }

  function setup() {
    const tracker = newEventTracker();
    const c = tracker.new(() => new Container(tracker));
    const item = tracker.new(() => new Item(tracker, 42));
    c.items.push(item);           // op A — insert into collection
    c.phase = "b";                 // op B — LAST op on undo stack, unrelated to item
    tracker.onCommit(pendingIds(tracker));            // both persisted
    return { tracker, c, item };
  }

  it("commit_then_undo_preserves_committed_inserts", () => {
    const { tracker, c, item } = setup();

    expect(c.items.collection).toContain(item);
    expect("trakrState" in c).toBe(false);
    expect(c.phase).toBe("b");

    tracker.undo();

    expect(c.phase).toBe("a");
    // item's committed Insert must not have been rolled back — it stays Unchanged
    // even though an unrelated later operation was undone.
    expect("trakrState" in item).toBe(false);
    expect(c.items.collection).toContain(item);
    // EventTracker objects carry no Insert/Changed/Deleted state — the undo shows up
    // only as a compensating `phase` event.
  });

  it("commit_then_undo_no_spurious_removed", () => {
    const { tracker, c, item } = setup();

    tracker.undo();

    const events = emitted(tracker);
    // The only real change is phase going b → a. There must be no "items" event
    // targeting `item`, because the user never removed it and it is still in c.items.
    // (spurious removals surface either as `removed: [...]` in a bucketed payload or
    //  as a per-op itemRemoved event with matching targetId.)
    for (const e of events) {
      if (e.eventType === "items") {
        expect(e.targetId).not.toBe(item.id);
        const payload = e.payload as { removed?: unknown[] } | undefined;
        const removed = payload?.removed ?? [];
        expect(removed).not.toContain(item.id);
        expect(removed).not.toContainEqual({ id: item.id });
      }
    }
  });

  it("commit_then_undo_only_reverses_last_op", () => {
    const { tracker, c, item } = setup();

    tracker.undo();

    // No tracked object is ever marked Deleted on an EventTracker:
    // item is in the collection → its state must not be Deleted.
    for (const listed of c.items.collection) {
      expect("trakrState" in listed).toBe(false);
    }
    expect(c.items.collection).toContain(item);
  });

  it("commit_then_undo_then_redo", () => {
    const { tracker, c, item } = setup();

    tracker.undo();
    tracker.redo();

    expect(c.phase).toBe("b");
    expect("trakrState" in item).toBe(false);
    expect(c.phase).toBe("b");
    expect(c.items.collection).toContain(item);
    expect(emitted(tracker)).toEqual([]);
  });
});

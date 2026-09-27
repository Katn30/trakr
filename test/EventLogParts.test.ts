import { describe, it, expect } from "vitest";
import {
  EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, Id, AutoId,
  type CommitBatch,
} from "@katn30/chronicle-event-log";
import { pendingEvents, pendingIds, events } from "./eventHelpers";

// An aggregate split into parts: Issue → main, analysis (→ subs), comments.

class Comment extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked() accessor text: string = "";
  constructor(t: EventLog, text = "") { super(t); this.text = text; }
}

class Main extends TrackedContainer {
  @EventTracked((_s, title: string) => (title.length > 10 ? "too long" : undefined)) accessor title: string = "";
  @EventTracked(undefined, undefined, { history: true }) accessor notes: string = "";
  constructor(t: EventLog) { super(t); }
}

class Sub extends TrackedObject {
  @Id code: string = "";
  @EventTracked() accessor done: boolean = false;
  constructor(t: EventLog, code = "") { super(t); this.code = code; }
}

class Analysis extends TrackedContainer {
  @EventTracked() accessor summary: string = "";
  readonly subs = new EventTrackedCollection<Sub>(this.tracker, "subs");
  constructor(t: EventLog) { super(t); this.trackChild(this.subs); }
}

class Issue extends TrackedContainer {
  @Id id: string = "i1";
  @EventTracked() accessor state: string = "draft";
  readonly main: Main;
  readonly analysis: Analysis;
  readonly comments: EventTrackedCollection<Comment>;
  constructor(t: EventLog) {
    super(t);
    this.main = t.construct(() => new Main(t));
    this.analysis = t.construct(() => new Analysis(t));
    this.comments = new EventTrackedCollection<Comment>(t, "comments");
    this.trackChild(this.main, "main");
    this.trackChild(this.analysis, "analysis");
    this.trackChild(this.comments);
  }
}

function loaded() {
  const log = new EventLog();
  const issue = log.construct(() => new Issue(log));
  return { log, issue };
}

const payloads = (log: EventLog) => pendingEvents(log).map((e) => e.payload);

describe("objects that are parts of a container (trackChild(object, name))", () => {
  it("nest under the parent: one event for the aggregate", async () => {
    const { log, issue } = loaded();
    issue.main.title = "hello";
    issue.analysis.summary = "ok";
    const comment = log.new(() => new Comment(log, "first"));
    issue.comments.push(comment);
    const batches: CommitBatch[] = [];
    await log.commit((b) => { batches.push(b); });
    expect(batches[0].events).toEqual([{
      chronicleId: issue.chronicleId,
      targetId: "i1",
      payload: {
        main: { title: "hello" },
        analysis: { summary: "ok" },
        comments: { added: [{ chronicleId: comment.chronicleId, id: null, text: "first" }], removed: [], changed: [] },
      },
    }]);
  });

  it("an untouched part contributes nothing; a change to one part sends only it", () => {
    const { log, issue } = loaded();
    issue.analysis.summary = "ok";
    expect(pendingEvents(log)).toEqual([
      expect.objectContaining({ chronicleId: issue.chronicleId, payload: { analysis: { summary: "ok" } } }),
    ]);
  });

  it("an object a container does not track stays a root of its own", () => {
    class Loose extends TrackedContainer {
      @Id id = "l";
      readonly main: Main;
      constructor(t: EventLog) { super(t); this.main = t.construct(() => new Main(t)); }
    }
    const log = new EventLog();
    const loose = log.construct(() => new Loose(log));
    loose.main.title = "alone";
    expect(pendingEvents(log)).toEqual([expect.objectContaining({ chronicleId: loose.main.chronicleId, payload: { title: "alone" } })]);
  });

  it("history properties of a part are lists inside its slot", () => {
    const { log, issue } = loaded();
    log._startSession();
    issue.main.notes = "a";
    issue.main.notes = "b";
    log._startSession().end();
    expect(payloads(log)).toEqual([{ main: { notes: [{ property: "notes", value: "a" }, { property: "notes", value: "b" }] } }]);
  });

  it("a part owning a collection nests two levels deep", () => {
    const { log, issue } = loaded();
    issue.analysis.subs.push(log.construct(() => new Sub(log, "s1")));
    expect(payloads(log)).toEqual([{ analysis: { subs: { added: [{ code: "s1", done: false }], removed: [], changed: [] } } }]);
  });

  it("parts of parts nest too", () => {
    class Inner extends TrackedObject {
      @EventTracked() accessor x: number = 0;
      constructor(t: EventLog) { super(t); }
    }
    class Middle extends TrackedContainer {
      readonly inner: Inner;
      constructor(t: EventLog) { super(t); this.inner = t.construct(() => new Inner(t)); this.trackChild(this.inner, "inner"); }
    }
    class Top extends TrackedContainer {
      @Id id = "t";
      readonly middle: Middle;
      constructor(t: EventLog) { super(t); this.middle = t.construct(() => new Middle(t)); this.trackChild(this.middle, "middle"); }
    }
    const log = new EventLog();
    const top = log.construct(() => new Top(log));
    top.middle.inner.x = 7;
    expect(pendingEvents(log)).toEqual([expect.objectContaining({ chronicleId: top.chronicleId, payload: { middle: { inner: { x: 7 } } } })]);
  });

  it("undo after the save: one compensating event on the parent", async () => {
    const { log, issue } = loaded();
    issue.main.title = "hello";
    await log.commit(() => {});
    log.undo();
    expect(pendingEvents(log)).toEqual([
      expect.objectContaining({ chronicleId: issue.chronicleId, targetId: "i1", payload: { main: { title: "" } } }),
    ]);
    expect(events(log)).toHaveLength(2);
  });

  it("several steps on the parent and its parts: one collapsed event; operations mode: one event per step", async () => {
    const collapsed: CommitBatch[] = [];
    const a = loaded();
    a.issue.state = "open";
    a.issue.main.title = "T";
    a.issue.analysis.summary = "S";
    await a.log.commit((b) => { collapsed.push(b); });
    expect(collapsed[0].events.map((e) => e.payload)).toEqual([{ state: "open", main: { title: "T" }, analysis: { summary: "S" } }]);

    const steps: CommitBatch[] = [];
    const b = loaded();
    b.issue.main.title = "T";
    b.issue.analysis.summary = "S";
    await b.log.commit((batch) => { steps.push(batch); }, { mode: "operations" });
    expect(steps[0].events.map((e) => [e.chronicleId, e.payload])).toEqual([
      [b.issue.chronicleId, { main: { title: "T" } }],
      [b.issue.chronicleId, { analysis: { summary: "S" } }],
    ]);
  });

  it("the parts' validity counts towards the container's", () => {
    const { log, issue } = loaded();
    issue.main.title = "far too long a title";
    expect(issue.chronicleIsValid).toBe(false);
    expect(log.isValid).toBe(false);
    issue.main.title = "ok";
    expect(issue.chronicleIsValid).toBe(true);
  });

  it("untrackChild ends the ownership: the object is a root again", () => {
    class Detachable extends TrackedContainer {
      @Id id = "d";
      readonly main: Main;
      constructor(t: EventLog) { super(t); this.main = t.construct(() => new Main(t)); this.trackChild(this.main, "main"); }
      detach() { this.untrackChild(this.main); }
    }
    const log = new EventLog();
    const d = log.construct(() => new Detachable(log));
    d.main.title = "in";
    d.detach();
    d.main.title = "out";
    expect(pendingEvents(log).map((e) => [e.chronicleId, e.payload])).toEqual([
      [d.chronicleId, { main: { title: "in" } }],
      [d.main.chronicleId, { title: "out" }],
    ]);
  });

  it("an object is part of one container", () => {
    const log = new EventLog();
    const issue = log.construct(() => new Issue(log));
    class Other extends TrackedContainer {
      constructor(t: EventLog) { super(t); this.trackChild(issue.main, "stolen"); }
    }
    expect(() => log.construct(() => new Other(log))).toThrow(/Main already belongs to a Issue/);
  });

  it("a part's toPayload shapes its slot", () => {
    class Stamped extends TrackedObject {
      @EventTracked(undefined, undefined, { toPayload: (_s: Stamped, v: string) => ({ v, by: "u1" }) }) accessor status: string = "";
      constructor(t: EventLog) { super(t); }
    }
    class Holder extends TrackedContainer {
      @Id id = "h";
      readonly stamped: Stamped;
      constructor(t: EventLog) { super(t); this.stamped = t.construct(() => new Stamped(t)); this.trackChild(this.stamped, "stamped"); }
    }
    const log = new EventLog();
    const h = log.construct(() => new Holder(log));
    h.stamped.status = "done";
    expect(payloads(log)).toEqual([{ stamped: { status: { v: "done", by: "u1" } } }]);
  });

  it("a destroyed part takes no further part in events", () => {
    const { log, issue } = loaded();
    issue.main.destroy();
    issue.main.title = "gone";
    issue.state = "open";
    expect(payloads(log)).toEqual([{ state: "open" }]);
  });
});

describe("a new aggregate (tracker.new) with parts", () => {
  it("nothing until used; its first change sends the whole aggregate, parts included", async () => {
    const log = new EventLog();
    const issue = log.new(() => new Issue(log));
    expect(log.isDirty).toBe(false);
    issue.main.title = "first";
    const batches: CommitBatch[] = [];
    await log.commit((b) => { batches.push(b); });
    expect(batches[0].events).toEqual([{
      chronicleId: issue.chronicleId,
      targetId: "i1",
      payload: {
        id: "i1", state: "draft",
        main: { title: "first", notes: "" },
        analysis: { summary: "", subs: [] },
        comments: [],
      },
    }]);
    issue.analysis.summary = "later";
    expect(payloads(log)).toEqual([{ analysis: { summary: "later" } }]);
  });
});

describe("parts of an item inside a collection", () => {
  class Card extends TrackedContainer {
    @Id code: string = "";
    readonly body: Main;
    constructor(t: EventLog, code: string) {
      super(t);
      this.code = code;
      this.body = t.construct(() => new Main(t));
      this.trackChild(this.body, "body");
    }
  }
  class Board extends TrackedContainer {
    @Id id = "b";
    readonly cards = new EventTrackedCollection<Card>(this.tracker, "cards");
    constructor(t: EventLog) { super(t); this.trackChild(this.cards); }
  }

  function board(history = false) {
    const log = new EventLog();
    const b = log.construct(() => {
      const bd = new Board(log);
      if (history) return bd;
      bd.cards.push(new Card(log, "c1"));
      return bd;
    });
    return { log, b };
  }

  it("nest into the item's changed entry", () => {
    const { log, b } = board();
    b.cards.collection[0].body.title = "edited";
    expect(payloads(log)).toEqual([{ cards: { added: [], removed: [], changed: [{ code: "c1", body: { title: "edited" } }] } }]);
  });

  it("are part of an added item's snapshot", () => {
    const { log, b } = board();
    b.cards.push(log.construct(() => new Card(log, "c2")));
    expect(payloads(log)).toEqual([{ cards: { added: [{ code: "c2", body: { title: "", notes: "" } }], removed: [], changed: [] } }]);
  });

  it("leave with a removed item: nothing of them is reported", () => {
    const { log, b } = board();
    const card = b.cards.collection[0];
    log._startSession();
    card.body.title = "edited";
    b.cards.remove(card);
    log._startSession().end();
    expect(payloads(log)).toEqual([{ cards: { added: [], removed: ["c1"], changed: [] } }]);
  });

  it("in a history collection, a part's change is a change op of its item", () => {
    class HistoryBoard extends TrackedContainer {
      @Id id = "hb";
      readonly cards = new EventTrackedCollection<Card>(this.tracker, "cards", [], undefined, { history: true });
      constructor(t: EventLog) { super(t); this.trackChild(this.cards); }
    }
    const log = new EventLog();
    const hb = log.construct(() => { const x = new HistoryBoard(log); x.cards.push(new Card(log, "c1")); return x; });
    hb.cards.collection[0].body.title = "edited";
    expect(payloads(log)).toEqual([{ cards: { ops: [{ op: "change", code: "c1", body: { title: "edited" } }] } }]);
  });

  it("an item added and removed again: its parts' changes are the item's own event", () => {
    const { log, b } = board();
    const card = log.construct(() => new Card(log, "c9"));
    b.cards.push(card);
    b.cards.remove(card);
    log._onCommit(pendingIds(log));
    card.body.title = "after";
    expect(pendingEvents(log)).toEqual([expect.objectContaining({ chronicleId: card.chronicleId, payload: { body: { title: "after" } } })]);
  });
});

describe("parts: repeated and shared paths", () => {
  class Card extends TrackedContainer {
    @Id code: string = "c1";
    readonly body: Main;
    constructor(t: EventLog) { super(t); this.body = t.construct(() => new Main(t)); this.trackChild(this.body, "body"); }
    trackAgain() { this.trackChild(this.body, "body"); }
  }

  it("a container may track its own part again", () => {
    const log = new EventLog();
    const card = log.construct(() => new Card(log));
    expect(() => card.trackAgain()).not.toThrow();
    card.body.title = "x";
    expect(pendingEvents(log)).toEqual([expect.objectContaining({ chronicleId: card.chronicleId, payload: { body: { title: "x" } } })]);
  });

  function inTwo() {
    const log = new EventLog();
    const card = log.construct(() => new Card(log));
    const a = log.construct(() => new EventTrackedCollection<Card>(log, "a", [card]));
    const b = log.construct(() => new EventTrackedCollection<Card>(log, "b", [card]));
    return { log, card, a, b };
  }

  it("an item in two collections: its part's change is reported once, in the first", () => {
    const { log, card } = inTwo();
    card.body.title = "x";
    expect(payloads(log)).toEqual([{ a: { added: [], removed: [], changed: [{ code: "c1", body: { title: "x" } }] } }]);
  });

  it("removed from both in one step: the part's change does not leak", () => {
    const { log, card, a, b } = inTwo();
    log._startSession();
    card.body.title = "x";
    a.remove(card);
    b.remove(card);
    log._startSession().end();
    expect(payloads(log)).toEqual([
      { a: { added: [], removed: ["c1"], changed: [] } },
      { b: { added: [], removed: ["c1"], changed: [] } },
    ]);
  });
});

describe("without a name (only possible without type checking)", () => {
  it("the object counts towards the container's validity but keeps its own events", () => {
    class Loose extends TrackedContainer {
      @Id id = "l";
      readonly main: Main;
      constructor(t: EventLog) {
        super(t);
        this.main = t.construct(() => new Main(t));
        // @ts-expect-error — the name is required
        this.trackChild(this.main);
      }
    }
    const log = new EventLog();
    const loose = log.construct(() => new Loose(log));
    loose.main.title = "far too long a title";
    expect(loose.chronicleIsValid).toBe(false);
    expect(pendingEvents(log)).toEqual([expect.objectContaining({ chronicleId: loose.main.chronicleId })]);
  });
});

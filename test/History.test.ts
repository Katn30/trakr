import { describe, it, expect, vi } from "vitest";
import {
  UnitOfWork, Entity, TrackedCollection, Tracked,
} from "@katn30/chronicle-unit-of-work";
import {
  EventLog, TrackedObject, EventTracked, EventTrackedCollection, Id, AutoId,
  type CommitBatch,
} from "@katn30/chronicle-event-log";
import { Tracked as CoreTracked, TrackedCollection as CoreCollection } from "@katn30/chronicle-core";

// ---------------------------------------------------------------------------- models

class Item extends Entity {
  @Tracked() accessor name: string = "";
  @Tracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor note: string = "";
  constructor(t: UnitOfWork) { super(t); }
}

class Doc extends TrackedObject {
  @Id id = "d1";
  @EventTracked() accessor title: string = "";
  @EventTracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor note: string = "";
  constructor(t: EventLog) { super(t); }
}

function uow() {
  const tracker = new UnitOfWork();
  const item = tracker.construct(() => new Item(tracker));
  return { tracker, item };
}

function log() {
  const tracker = new EventLog();
  const doc = tracker.construct(() => new Doc(tracker));
  return { tracker, doc };
}

/** A save that stays in flight until released. */
function deferred<B>() {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const batches: B[] = [];
  const save = (batch: B) => {
    batches.push(batch);
    return new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  };
  return { save, batches, resolve: () => resolve(), reject: (e: Error) => reject(e) };
}

const flags = (entries: readonly { isCommitted: boolean; isSaving: boolean }[]) =>
  entries.map((e) => [e.isCommitted, e.isSaving]);

// ---------------------------------------------------------------------------- lists

describe("undoable / redoable", () => {
  it("list the undo steps oldest first and the redo steps next first", () => {
    const { tracker, item } = uow();
    item.name = "a";
    item.name = "b";
    item.name = "c";
    const [a, b, c] = tracker.undoable;
    tracker.undo();
    tracker.undo();
    expect(tracker.undoable).toEqual([a]);
    expect(tracker.redoable[0]).toBe(b);    // redo() re-applies b first
    expect(tracker.redoable[1]).toBe(c);
    expect([...tracker.undoable, ...tracker.redoable]).toEqual([a, b, c]);
  });

  it("entries are read-only views, the same object for the same step", () => {
    const { tracker, item } = uow();
    item.name = "a";
    const entry = tracker.undoable[0];
    expect(tracker.undoable[0]).toBe(entry);
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.keys(entry).sort()).toEqual(["isCommitted", "isSaving"]);
  });

  it("are empty for writes that are not recorded", () => {
    const { tracker, item } = uow();
    tracker.withTrackingSuppressed(() => { item.name = "loaded"; });
    expect(tracker.undoable).toEqual([]);
    expect(tracker.redoable).toEqual([]);
  });
});

// ---------------------------------------------------------------------------- UnitOfWork

describe("UnitOfWork entries — isCommitted", () => {
  it("is false until committed, then true", async () => {
    const { tracker, item } = uow();
    item.name = "a";
    expect(flags(tracker.undoable)).toEqual([[false, false]]);
    await tracker.commit(() => {});
    expect(flags(tracker.undoable)).toEqual([[true, false]]);
  });

  it("an unsaved step undone is committed (the server never had it)", () => {
    const { tracker, item } = uow();
    item.name = "a";
    tracker.undo();
    expect(flags(tracker.redoable)).toEqual([[true, false]]);
    expect(tracker.isDirty).toBe(false);
  });

  it("a saved step undone is not, until the next commit saves the reversal", async () => {
    const { tracker, item } = uow();
    item.name = "a";
    await tracker.commit(() => {});
    tracker.undo();
    expect(flags(tracker.redoable)).toEqual([[false, false]]);
    expect(tracker.isDirty).toBe(true);
    await tracker.commit(() => {});
    expect(flags(tracker.redoable)).toEqual([[true, false]]);
    tracker.redo();
    expect(flags(tracker.undoable)).toEqual([[false, false]]);
  });

  it("discardPendingChanges clears the history", async () => {
    const { tracker, item } = uow();
    item.name = "a";
    await tracker.commit(() => {});
    item.name = "b";
    tracker.discardPendingChanges();
    expect(tracker.undoable).toEqual([]);
    expect(item.name).toBe("a");
  });
});

describe("UnitOfWork — a save in progress", () => {
  it("isSaving and the entries it covers, while save runs", async () => {
    const { tracker, item } = uow();
    const seen: boolean[] = [];
    tracker.isSavingChanged.subscribe((v) => seen.push(v));
    item.name = "a";
    const d = deferred<unknown>();
    const run = tracker.commit(d.save);
    await Promise.resolve();
    expect(tracker.isSaving).toBe(true);
    expect(flags(tracker.undoable)).toEqual([[false, true]]);
    item.name = "b";                       // made meanwhile: not part of this save
    expect(flags(tracker.undoable)).toEqual([[false, true], [false, false]]);
    d.resolve();
    await run;
    expect(tracker.isSaving).toBe(false);
    expect(flags(tracker.undoable)).toEqual([[true, false], [false, false]]);
    expect(seen).toEqual([true, false]);
  });

  it("a saved step undone before the save is covered by it (its reversal is being saved)", async () => {
    const { tracker, item } = uow();
    item.name = "a";
    await tracker.commit(() => {});
    tracker.undo();
    const d = deferred<unknown>();
    const run = tracker.commit(d.save);
    await Promise.resolve();
    expect(flags(tracker.redoable)).toEqual([[false, true]]);
    d.resolve();
    await run;
    expect(flags(tracker.redoable)).toEqual([[true, false]]);
  });

  it("a failed save leaves the entries as they were", async () => {
    const { tracker, item } = uow();
    item.name = "a";
    const d = deferred<unknown>();
    const run = tracker.commit(d.save);
    await Promise.resolve();
    d.reject(new Error("offline"));
    await expect(run).rejects.toThrow("offline");
    expect(tracker.isSaving).toBe(false);
    expect(flags(tracker.undoable)).toEqual([[false, false]]);
  });

  it("isSaving is false for every entry when no save runs", () => {
    const { tracker, item } = uow();
    item.name = "a";
    tracker.undo();
    expect(tracker.redoable[0].isSaving).toBe(false);
  });
});

// ---------------------------------------------------------------------------- EventLog

describe("EventLog entries", () => {
  it("carry the events their operation produced", () => {
    const { tracker, doc } = log();
    doc.title = "T";
    const titled = { payload: { title: "T" }, chronicleId: doc.chronicleId, targetId: "d1" };
    expect(tracker.undoable[0].events).toEqual([titled]);
    tracker.undo();
    expect(tracker.redoable[0].events).toEqual([titled]);
  });

  it("list one event per root the operation changed, oldest first", () => {
    class Journal extends TrackedObject {
      @Id id = "j1";
      @EventTracked() accessor last: string = "";
      constructor(t: EventLog) { super(t); }
    }
    class Staged extends TrackedObject {
      @Id id = "s1";
      @EventTracked(undefined, { afterChange: (self: Staged) => { self.journal.last = `moved to ${self.stage}`; } })
      accessor stage: string = "a";
      constructor(t: EventLog, readonly journal: Journal) { super(t); }
    }
    const tracker = new EventLog();
    const journal = tracker.construct(() => new Journal(tracker));
    const s = tracker.construct(() => new Staged(tracker, journal));
    s.stage = "b";                               // the hook's write joins the same step
    expect(tracker.undoable).toHaveLength(1);
    expect(tracker.undoable[0].events.map((e) => e.payload)).toEqual([{ last: "moved to b" }, { stage: "b" }]);
  });

  it("do not list the compensations sent to undo them", async () => {
    const { tracker, doc } = log();
    doc.title = "T";
    await tracker.commit(() => {});
    tracker.undo();
    expect(tracker.redoable[0].events.map((e) => e.payload)).toEqual([{ title: "T" }]);
  });

  it("isCommitted follows what the server has, through undo and redo", async () => {
    const { tracker, doc } = log();
    doc.title = "T";
    const [entry] = tracker.undoable;
    expect(entry.isCommitted).toBe(false);
    tracker.undo();
    expect(entry.isCommitted).toBe(true);        // withdrawn before it was sent
    tracker.redo();
    expect(entry.isCommitted).toBe(false);
    await tracker.commit(() => {});
    expect(entry.isCommitted).toBe(true);
    tracker.undo();
    expect(entry.isCommitted).toBe(false);       // the compensation is not sent yet
    await tracker.commit(() => {});
    expect(entry.isCommitted).toBe(true);
    tracker.redo();
    expect(entry.isCommitted).toBe(false);       // re-applying it is a new event
    await tracker.commit(() => {});
    expect(entry.isCommitted).toBe(true);
    expect(tracker.isDirty).toBe(false);
  });

  it("an entry whose step left the history (redo stack dropped) has no events", () => {
    const { tracker, doc } = log();
    doc.title = "T";
    tracker.undo();
    const [dropped] = tracker.redoable;
    doc.title = "U";                             // a new step drops the redo stack
    expect(tracker.redoable).toEqual([]);
    expect(dropped.events).toEqual([]);
    expect(dropped.isCommitted).toBe(true);
  });

  it("an entry with no events is committed", () => {
    const tracker = new EventLog();
    const tags = tracker.construct(() => new EventTrackedCollection<string>(tracker, "tags", []));
    tracker._startSession();
    tags.push("x");
    tags.remove("x");
    tracker._startSession().end();
    expect(tracker.undoable.map((e) => [e.isCommitted, e.events])).toEqual([[true, []]]);
  });
});

describe("EventLog — a save in progress", () => {
  it("isSaving, and what it covers cannot be undone or extended until it completes", async () => {
    const { tracker, doc } = log();
    doc.note = "a";
    const d = deferred<CommitBatch>();
    const run = tracker.commit(d.save);
    await Promise.resolve();
    expect(tracker.isSaving).toBe(true);
    expect(flags(tracker.undoable)).toEqual([[false, true]]);
    expect(tracker.canUndo).toBe(false);
    tracker.undo();
    expect(doc.note).toBe("a");

    doc.note = "ab";                             // within coalesceWithin, but a new step
    expect(tracker.undoable).toHaveLength(2);
    expect(tracker.canUndo).toBe(true);
    d.resolve();
    await run;
    expect(d.batches[0].events.map((e) => e.payload)).toEqual([{ note: "a" }]);
    expect(flags(tracker.undoable)).toEqual([[true, false], [false, false]]);
    tracker.undo();
    tracker.undo();
    expect(doc.note).toBe("");
  });

  it("a compensation on its way cannot be redone away", async () => {
    const { tracker, doc } = log();
    doc.title = "T";
    await tracker.commit(() => {});
    tracker.undo();
    const d = deferred<CommitBatch>();
    const run = tracker.commit(d.save);
    await Promise.resolve();
    expect(flags(tracker.redoable)).toEqual([[false, true]]);
    expect(tracker.canRedo).toBe(false);
    d.resolve();
    await run;
    expect(tracker.canRedo).toBe(true);
    expect(flags(tracker.redoable)).toEqual([[true, false]]);
  });

  it("a failed save releases the lock", async () => {
    const { tracker, doc } = log();
    doc.title = "T";
    const d = deferred<CommitBatch>();
    const run = tracker.commit(d.save);
    await Promise.resolve();
    d.reject(new Error("500"));
    await expect(run).rejects.toThrow("500");
    expect(tracker.isSaving).toBe(false);
    expect(tracker.canUndo).toBe(true);
    expect(flags(tracker.undoable)).toEqual([[false, false]]);
  });
});

// ---------------------------------------------------------------------------- autosave

describe("tracker.changed is the autosave trigger", () => {
  it("an EventLog saves on change; edits made while a save runs go with the next one", async () => {
    const { tracker, doc } = log();
    const sent: unknown[][] = [];
    let release!: () => void;
    tracker.changed.subscribe(() => {
      if (!tracker.canCommit) return;
      void tracker.commit((b) => {
        sent.push(b.events.map((e) => e.payload));
        if (sent.length === 1) return new Promise<void>((res) => { release = res; });
      });
    });
    doc.title = "T";
    await vi.waitFor(() => expect(tracker.isSaving).toBe(true));
    doc.note = "N";                              // while the first save runs
    release();
    await vi.waitFor(() => expect(tracker.isDirty).toBe(false));
    expect(sent).toEqual([[{ title: "T" }], [{ note: "N" }]]);
  });

  it("completing a save does not fire it", async () => {
    const { tracker, item } = uow();
    item.name = "a";
    const fired = vi.fn();
    tracker.changed.subscribe(fired);
    await tracker.commit(() => {});
    expect(fired).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------- every change is an event

describe("EventLog models produce events for every tracked change", () => {
  it("one event per root object, with every changed field", () => {
    class Plain extends TrackedObject {
      @EventTracked() accessor text: string = "";
      @EventTracked() accessor note: string = "";
      constructor(t: EventLog) { super(t); }
    }
    const tracker = new EventLog();
    const p = tracker.construct(() => new Plain(tracker));
    tracker._startSession();
    p.text = "x";
    p.note = "y";
    tracker._startSession().end();
    expect(tracker.undoable[0].events).toEqual([{ payload: { text: "x", note: "y" }, chronicleId: p.chronicleId }]);
  });

  it("a collection no container owns is a root: its event carries it under its name", () => {
    class Tag extends TrackedObject {
      @AutoId id: number | null = null;
      @EventTracked() accessor label: string = "";
      constructor(t: EventLog, id: number) { super(t); this.id = id; }
    }
    const tracker = new EventLog();
    const tag = tracker.construct(() => new Tag(tracker, 1));
    const tags = tracker.construct(() => new EventTrackedCollection<Tag>(tracker, "tags", [tag]));
    tag.label = "edited";
    tags.remove(tag);
    expect(tracker.undoable.map((e) => e.events)).toEqual([
      [{ payload: { tags: { added: [], removed: [], changed: [{ id: 1, label: "edited" }] } } }],
      [{ payload: { tags: { added: [], removed: [1], changed: [] } } }],
    ]);
  });

  it("a @Tracked getter is fine: it only records dependencies", () => {
    class Derived extends TrackedObject {
      @EventTracked() accessor first: string = "a";
      @CoreTracked() get upper(): string { return this.first.toUpperCase(); }
      constructor(t: EventLog) { super(t); }
    }
    const tracker = new EventLog();
    expect(tracker.construct(() => new Derived(tracker)).upper).toBe("A");
  });

  it("plain @Tracked and TrackedCollection keep working on a UnitOfWork", () => {
    const tracker = new UnitOfWork();
    const names = tracker.construct(() => new TrackedCollection<string>(tracker, []));
    names.push("x");
    expect(tracker.undoable).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------- isDirty agrees with the entries

describe("isDirty (the save button) agrees with the entries", () => {
  type AnyTracker = UnitOfWork | EventLog;
  const derived = (t: AnyTracker) =>
    [...t.undoable, ...t.redoable].some((e) => !e.isCommitted);

  async function walk(t: AnyTracker, write: (v: string) => void) {
    const checks: boolean[] = [];
    const check = () => checks.push(t.isDirty === derived(t) && t.canCommit === (derived(t) && t.isValid));
    check();
    write("a"); check();
    write("b"); check();
    t.undo(); check();
    t.undo(); check();                    // back to the start: clean
    t.redo(); check();
    await t.commit(() => {}); check();
    t.undo(); check();                    // undoing a saved step: dirty
    t.redo(); check();                    // and redoing it: clean again
    t.undo(); check();
    await t.commit(() => {}); check();
    write("c"); check();
    t.undo(); check();
    return checks;
  }

  it("on a UnitOfWork", async () => {
    const { tracker, item } = uow();
    const checks = await walk(tracker, (v) => { item.name = v; });
    expect(checks.every(Boolean)).toBe(true);
    expect(tracker.isDirty).toBe(false);
  });

  it("on an EventLog", async () => {
    const { tracker, doc } = log();
    const checks = await walk(tracker, (v) => { doc.title = v; });
    expect(checks.every(Boolean)).toBe(true);
    expect(tracker.isDirty).toBe(false);
  });

  it("tracker.new() leaves nothing pending; a new object's creation belongs to the step that changed it", () => {
    const tracker = new EventLog();
    const doc = tracker.new(() => { const d = new Doc(tracker); d.title = "draft"; return d; });
    expect(tracker.isDirty).toBe(false);
    doc.note = "n";
    expect(tracker.undoable.map((e) => [e.isCommitted, e.events.map((ev) => ev.payload)])).toEqual([
      [false, [{ id: "d1", title: "draft", note: "n" }]],
    ]);
    expect(tracker.isDirty).toBe(true);
  });
});

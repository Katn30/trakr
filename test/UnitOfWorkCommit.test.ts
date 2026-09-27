import { describe, it, expect } from "vitest";
import {
  UnitOfWork, Entity, TrackedCollection, Tracked, AutoId, State,
  type CommitBatch, type SaveFunction,
} from "@katn30/chronicle-unit-of-work";

class Line extends Entity {
  @AutoId id: number | null = null;
  @Tracked() accessor text: string = "";
  @Tracked(undefined, undefined, { coalesceWithin: 60_000 }) accessor note: string = "";
  constructor(t: UnitOfWork, text = "") { super(t); this.text = text; }
}

function setup() {
  const uow = new UnitOfWork();
  const lines = uow.construct(() => new TrackedCollection<Line>(uow, []));
  const saved = uow.construct(() => new Line(uow, "saved"));
  uow.withTrackingSuppressed(() => { saved.id = 1; lines.push(saved); });
  return { uow, lines, saved };
}

const names = (batch: CommitBatch) => ({
  inserted: batch.inserted.map((o) => (o as Line).text),
  changed: batch.changed.map((o) => (o as Line).text),
  deleted: batch.deleted.map((o) => (o as Line).text),
});

/** A save that stays in flight until `resolve` is called. */
function deferredSave() {
  const calls: CommitBatch[] = [];
  let resolve!: (keys: { chronicleId: number; value: number }[]) => void;
  let reject!: (error: Error) => void;
  const save: SaveFunction = (batch) => {
    calls.push(batch);
    return new Promise((res, rej) => { resolve = res; reject = rej; });
  };
  return { save, calls, resolve: (k: { chronicleId: number; value: number }[] = []) => resolve(k), reject: (e: Error) => reject(e) };
}

describe("UnitOfWork.commit(save)", () => {
  it("hands save the objects to insert, update and delete, then marks them saved", async () => {
    const { uow, lines, saved } = setup();
    const other = uow.construct(() => new Line(uow, "other"));
    uow.withTrackingSuppressed(() => lines.push(other));
    const added = uow.new(() => new Line(uow, "added"));
    lines.push(added);
    saved.text = "edited";
    lines.remove(other);

    let seen: ReturnType<typeof names> | undefined;
    const result = await uow.commit((batch) => {
      seen = names(batch);
      return [{ chronicleId: added.chronicleId, value: 42 }];
    });

    expect(result).toBe(true);
    expect(seen).toEqual({ inserted: ["added"], changed: ["edited"], deleted: ["other"] });
    expect(added.id).toBe(42);
    expect([added, saved, other].map((o) => o.chronicleState)).toEqual([State.Unchanged, State.Unchanged, State.Unchanged]);
    expect(uow.isDirty).toBe(false);
    expect(uow.canCommit).toBe(false);
  });

  it("resolves to false without calling save when nothing changed", async () => {
    const { uow } = setup();
    let called = false;
    expect(await uow.commit(() => { called = true; })).toBe(false);
    expect(called).toBe(false);
  });

  it("changes that cancel out are committed without calling save", async () => {
    const { uow, lines } = setup();
    const draft = uow.new(() => new Line(uow, "draft"));
    lines.push(draft);
    lines.remove(draft);
    expect(uow.isDirty).toBe(true);
    let called = false;
    expect(await uow.commit(() => { called = true; })).toBe(true);
    expect(called).toBe(false);
    expect(uow.isDirty).toBe(false);
  });

  it("if save throws, nothing is committed and the error propagates", async () => {
    const { uow, saved } = setup();
    saved.text = "edited";
    await expect(uow.commit(() => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(saved.chronicleState).toBe(State.Changed);
    expect(uow.isDirty).toBe(true);
    expect(uow.canUndo).toBe(true);
    // and the next commit works
    expect(await uow.commit(() => {})).toBe(true);
    expect(saved.chronicleState).toBe(State.Unchanged);
  });

  it("a rejected async save leaves undo available again", async () => {
    const { uow, saved } = setup();
    saved.text = "edited";
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    expect(uow.canUndo).toBe(false);
    d.reject(new Error("500"));
    await expect(run).rejects.toThrow("500");
    expect(uow.canUndo).toBe(true);
    uow.undo();
    expect(saved.text).toBe("saved");
  });

  it("undo crosses the commit: undoing a saved edit makes it dirty again", async () => {
    const { uow, saved } = setup();
    saved.text = "edited";
    await uow.commit(() => {});
    uow.undo();
    expect(saved.text).toBe("saved");
    expect(saved.chronicleState).toBe(State.Changed);
    expect(uow.isDirty).toBe(true);
  });
});

describe("UnitOfWork.commit — edits made while save runs", () => {
  it("stay pending for the next commit", async () => {
    const { uow, saved } = setup();
    saved.text = "first";
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    saved.text = "second";                   // while saving
    d.resolve();
    await run;
    expect(saved.text).toBe("second");
    expect(saved.chronicleState).toBe(State.Changed);
    expect(saved.dirtyCounter).toBe(1);
    expect(uow.isDirty).toBe(true);

    uow.undo();                               // back to what was saved
    expect(saved.text).toBe("first");
    expect(saved.chronicleState).toBe(State.Unchanged);
    expect(uow.isDirty).toBe(false);
  });

  it("the changes being saved cannot be undone until the save completes", async () => {
    const { uow, saved } = setup();
    saved.text = "first";
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    expect(uow.canUndo).toBe(false);
    uow.undo();
    expect(saved.text).toBe("first");

    saved.text = "second";
    expect(uow.canUndo).toBe(true);           // edits made meanwhile can be undone
    uow.undo();
    expect(saved.text).toBe("first");
    expect(uow.canUndo).toBe(false);
    uow.redo();
    expect(saved.text).toBe("second");

    d.resolve();
    await run;
    expect(uow.canUndo).toBe(true);
  });

  it("a write does not coalesce into the operation being saved", async () => {
    const { uow, saved } = setup();
    saved.note = "a";
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    saved.note = "ab";                        // within coalesceWithin
    d.resolve();
    await run;
    expect(saved.chronicleState).toBe(State.Changed);
    uow.undo();
    expect(saved.note).toBe("a");
    expect(uow.isDirty).toBe(false);
  });

  it("a write does not coalesce into a committed operation either", async () => {
    const { uow, saved } = setup();
    saved.note = "a";
    await uow.commit(() => {});
    saved.note = "ab";
    expect(uow.isDirty).toBe(true);
    expect(saved.chronicleState).toBe(State.Changed);
  });

  it("an object inserted while saving is inserted by the next commit", async () => {
    const { uow, lines } = setup();
    const first = uow.new(() => new Line(uow, "first"));
    lines.push(first);
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    const second = uow.new(() => new Line(uow, "second"));
    lines.push(second);
    d.resolve([{ chronicleId: first.chronicleId, value: 10 }]);
    await run;
    expect(first.id).toBe(10);
    expect(first.chronicleState).toBe(State.Unchanged);
    expect(second.chronicleState).toBe(State.Insert);

    let seen: ReturnType<typeof names> | undefined;
    await uow.commit((batch) => { seen = names(batch); return [{ chronicleId: second.chronicleId, value: 11 }]; });
    expect(seen).toEqual({ inserted: ["second"], changed: [], deleted: [] });
    expect(second.id).toBe(11);
  });

  it("an object being inserted and removed meanwhile is deleted by the next commit", async () => {
    const { uow, lines } = setup();
    const added = uow.new(() => new Line(uow, "added"));
    lines.push(added);
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    lines.remove(added);                      // it was Insert: forgotten, locally
    d.resolve([{ chronicleId: added.chronicleId, value: 7 }]);
    await run;
    // ...but the server has it now
    expect(added.id).toBe(7);
    expect(added.chronicleState).toBe(State.Deleted);

    let seen: ReturnType<typeof names> | undefined;
    await uow.commit((batch) => { seen = names(batch); });
    expect(seen).toEqual({ inserted: [], changed: [], deleted: ["added"] });
  });

  it("an object being deleted and put back meanwhile is inserted again by the next commit", async () => {
    const { uow, lines, saved } = setup();
    lines.remove(saved);
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    lines.push(saved);
    d.resolve();
    await run;
    expect(saved.chronicleState).toBe(State.Insert);
    expect(lines.collection).toContain(saved);
  });

  it("discardPendingChanges keeps what is being saved", async () => {
    const { uow, saved } = setup();
    saved.text = "first";
    const d = deferredSave();
    const run = uow.commit(d.save);
    await Promise.resolve();
    saved.text = "second";
    uow.discardPendingChanges();
    expect(saved.text).toBe("first");
    saved.text = "third";
    d.resolve();
    await run;
    expect(saved.text).toBe("third");
    expect(saved.chronicleState).toBe(State.Changed);
    expect(uow.isDirty).toBe(true);
  });

  it("commit calls run one after another", async () => {
    const { uow, lines, saved } = setup();
    const added = uow.new(() => new Line(uow, "added"));
    lines.push(added);
    const d = deferredSave();
    const first = uow.commit(d.save);
    await Promise.resolve();
    saved.text = "edited";
    const batches: ReturnType<typeof names>[] = [];
    const second = uow.commit((batch) => { batches.push(names(batch)); });
    await Promise.resolve();
    expect(batches).toEqual([]);              // waits for the first save
    d.resolve([{ chronicleId: added.chronicleId, value: 5 }]);
    expect(await first).toBe(true);
    expect(await second).toBe(true);
    expect(batches).toEqual([{ inserted: [], changed: ["edited"], deleted: [] }]);
    expect(uow.isDirty).toBe(false);
  });

  it("a failed commit does not block the queue", async () => {
    const { uow, saved } = setup();
    saved.text = "edited";
    const failed = uow.commit(() => Promise.reject(new Error("x")));
    const next = uow.commit(() => {});
    await expect(failed).rejects.toThrow("x");
    expect(await next).toBe(true);
    expect(uow.isDirty).toBe(false);
  });
});

describe("UnitOfWork — putting a deleted object back", () => {
  it("makes it Changed (the server still has it); undo deletes it again", () => {
    const { uow, lines, saved } = setup();
    lines.remove(saved);
    expect(saved.chronicleState).toBe(State.Deleted);
    lines.push(saved);
    expect(saved.chronicleState).toBe(State.Changed);
    uow.undo();
    expect(saved.chronicleState).toBe(State.Deleted);
    uow.redo();
    expect(saved.chronicleState).toBe(State.Changed);
  });

  it("moving an object to another collection updates it rather than deleting it", async () => {
    const { uow, lines, saved } = setup();
    const archive = uow.construct(() => new TrackedCollection<Line>(uow, []));
    lines.remove(saved);
    archive.push(saved);
    let seen: ReturnType<typeof names> | undefined;
    await uow.commit((batch) => { seen = names(batch); });
    expect(seen).toEqual({ inserted: [], changed: ["saved"], deleted: [] });
  });

  it("an invalid object counts towards isValid again once put back", () => {
    class Checked extends Entity {
      @Tracked((_s, v: string) => (v === "" ? "required" : undefined)) accessor text: string = "ok";
      constructor(t: UnitOfWork) { super(t); }
    }
    const uow = new UnitOfWork();
    const items = uow.construct(() => new TrackedCollection<Checked>(uow, []));
    const item = uow.construct(() => new Checked(uow));
    uow.withTrackingSuppressed(() => items.push(item));
    item.text = "";
    items.remove(item);
    expect(uow.isValid).toBe(true);
    items.push(item);
    expect(uow.isValid).toBe(false);
    uow.undo();
    expect(uow.isValid).toBe(true);
  });
});

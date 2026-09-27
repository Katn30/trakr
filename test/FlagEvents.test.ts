import { describe, it, expect } from "vitest";
import { UnitOfWork, Entity, Tracked } from "@chronicle/unit-of-work";
import { EventLog, TrackedObject, EventTracked, Id } from "@chronicle/event-log";

class Note extends Entity {
  @Tracked() accessor title: string = "";
  constructor(t: UnitOfWork) { super(t); }
}

class Issue extends TrackedObject {
  @Id id = "i";
  @EventTracked() accessor title: string = "";
  constructor(t: EventLog) { super(t); }
}

type AnyTracker = UnitOfWork | EventLog;

/** A tracker with one model, for both flavours. */
const flavours: Array<[string, () => { tracker: AnyTracker; write: (v: string) => void }]> = [
  ["UnitOfWork", () => {
    const tracker = new UnitOfWork();
    const note = tracker.construct(() => new Note(tracker));
    return { tracker, write: (v) => { note.title = v; } };
  }],
  ["EventLog", () => {
    const tracker = new EventLog();
    const issue = tracker.construct(() => new Issue(tracker));
    return { tracker, write: (v) => { issue.title = v; } };
  }],
];

/** Records every flag event as "name=value", with a snapshot of the state when it fired. */
function recordFlags(tracker: AnyTracker) {
  const log: string[] = [];
  const snapshots: string[] = [];
  const state = () => `dirty=${tracker.isDirty} undo=${tracker.canUndo} redo=${tracker.canRedo} saving=${tracker.isSaving}`;
  const on = (name: string, event: { subscribe(h: (v: boolean) => void): unknown }) =>
    event.subscribe((v) => { log.push(`${name}=${v}`); snapshots.push(state()); });
  on("canUndo", tracker.canUndoChanged);
  on("canRedo", tracker.canRedoChanged);
  on("isSaving", tracker.isSavingChanged);
  on("isDirty", tracker.isDirtyChanged);
  return { log, snapshots, state };
}

/** A save that completes (or fails) when told to. */
function pendingSave() {
  let finish!: (ok: boolean) => void;
  const save = () => new Promise<void>((resolve, reject) => { finish = (ok) => (ok ? resolve() : reject(new Error("offline"))); });
  return { save, finish: (ok = true) => finish(ok) };
}

describe.each(flavours)("%s — canUndoChanged / canRedoChanged", (_name, setup) => {
  it("fire when undo and redo become available or not, and only then", () => {
    const { tracker, write } = setup();
    const { log } = recordFlags(tracker);
    write("a");
    write("b");                                     // canUndo stays true: no event
    tracker.undo();
    tracker.undo();
    tracker.redo();
    tracker.redo();
    expect(log.filter((e) => e.startsWith("can"))).toEqual([
      "canUndo=true",
      "canRedo=true",
      "canUndo=false",
      "canUndo=true",
      "canRedo=false",
    ]);
  });

  it("a save locks undo while it runs and releases it when it completes, reporting both", async () => {
    const { tracker, write } = setup();
    write("a");
    const { log, snapshots } = recordFlags(tracker);
    const { save, finish } = pendingSave();
    const done = tracker.commit(save);
    await Promise.resolve();
    expect(tracker.canUndo).toBe(false);
    finish();
    await done;
    expect(tracker.canUndo).toBe(true);
    expect(log).toEqual(["canUndo=false", "isSaving=true", "isDirty=false", "canUndo=true", "isSaving=false"]);
    // Every flag is up to date before the first event fires.
    expect(snapshots.slice(0, 2)).toEqual(Array(2).fill("dirty=true undo=false redo=false saving=true"));
    expect(snapshots.slice(2)).toEqual(Array(3).fill("dirty=false undo=true redo=false saving=false"));
  });

  it("a failed save releases undo too, and the change is still pending", async () => {
    const { tracker, write } = setup();
    write("a");
    const { log } = recordFlags(tracker);
    const { save, finish } = pendingSave();
    const done = tracker.commit(save).catch(() => undefined);
    await Promise.resolve();
    finish(false);
    await done;
    expect([tracker.canUndo, tracker.isDirty]).toEqual([true, true]);
    expect(log).toEqual(["canUndo=false", "isSaving=true", "canUndo=true", "isSaving=false"]);
  });

  it("autosave: undo comes back after each save, and a save's start and end fire no changed", async () => {
    const { tracker, write } = setup();
    const saves: Array<Promise<boolean>> = [];
    let changed = 0;
    tracker.changed.subscribe(() => {
      changed++;
      if (tracker.canCommit) saves.push(tracker.commit(() => undefined));
    });
    const undo: boolean[] = [];
    tracker.canUndoChanged.subscribe((v) => undo.push(v));
    write("a");
    await Promise.all(saves);
    expect([tracker.canUndo, tracker.isDirty, changed, saves.length]).toEqual([true, false, 1, 1]);
    expect(undo).toEqual([true, false, true]);
  });

  it("a batch reports the state it leaves, once", () => {
    const { tracker, write } = setup();
    const { log } = recordFlags(tracker);
    tracker.batch(() => {
      write("a");
      write("b");
      expect(log).toEqual([]);                      // nothing while it runs
    });
    expect(log).toEqual(["isDirty=true", "canUndo=true"]);
  });

  it("a failed batch that leaves nothing reports nothing", () => {
    const { tracker, write } = setup();
    const { log } = recordFlags(tracker);
    expect(() => tracker.batch(() => { write("a"); throw new Error("cancelled"); })).toThrow();
    expect(log).toEqual([]);
  });

  it("a subscriber that changes the state gets events that match it", () => {
    const { tracker, write } = setup();
    const undo: boolean[] = [];
    let once = true;
    tracker.canUndoChanged.subscribe((v) => {
      undo.push(v);
      if (v && once) { once = false; tracker.undo(); }  // takes the new step back at once
    });
    write("a");
    expect(undo).toEqual([true, false]);
    expect(undo[undo.length - 1]).toBe(tracker.canUndo);
  });
});

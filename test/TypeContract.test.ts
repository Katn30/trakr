import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import ts from "typescript";
import { DirtyTracker } from "../src/DirtyTracker";
import { EventTracker } from "../src/EventTracker";
import { TrackedObject } from "../src/TrackedObject";
import { DirtyTrackedObject } from "../src/DirtyTrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { TrackedContainer } from "../src/TrackedContainer";
import { Tracked } from "../src/Tracked";
import { Tracker } from "../src/Tracker";

const root = path.resolve(__dirname, "..");

function compile(file: string): string[] {
  const configPath = path.join(root, "tsconfig.json");
  const { config } = ts.readConfigFile(configPath, ts.sys.readFile);
  const { options } = ts.parseJsonConfigFileContent(config, ts.sys, root);
  const program = ts.createProgram([file], { ...options, noEmit: true, rootDir: root });
  return ts.getPreEmitDiagnostics(program).map((d) => {
    const where = d.file && d.start !== undefined
      ? `${path.basename(d.file.fileName)}:${d.file.getLineAndCharacterOfPosition(d.start).line + 1} `
      : "";
    return where + ts.flattenDiagnosticMessageText(d.messageText, "\n");
  });
}

describe("tracker / model pairing — compile time", () => {
  it("every mismatch in test/types/pairing.ts is a type error, and nothing else is", () => {
    expect(compile(path.join(root, "test", "types", "pairing.ts"))).toEqual([]);
  }, 60_000);
});

describe("tracker / model pairing — run time", () => {
  class EventModel extends TrackedObject {
    constructor(t: EventTracker) { super(t); }
  }
  class DirtyModel extends DirtyTrackedObject {
    constructor(t: DirtyTracker) { super(t); }
  }

  it("a DirtyTracker rejects a TrackedObject model", () => {
    const tracker = new DirtyTracker();
    expect(() => tracker.construct(() => new EventModel(tracker as any))).toThrow(
      /EventModel cannot be tracked by a DirtyTracker/,
    );
    expect(tracker.trackedObjects).toEqual([]);
  });

  it("an EventTracker rejects a DirtyTrackedObject model", () => {
    const tracker = new EventTracker();
    expect(() => tracker.construct(() => new DirtyModel(tracker as any))).toThrow(
      /DirtyModel cannot be tracked by an EventTracker/,
    );
  });

  it("event_tracker_tracked_object_has_no_state_api", () => {
    const tracker = new EventTracker();
    const model = tracker.new(() => new EventModel(tracker)) as unknown as Record<string, unknown>;
    for (const member of ["trakrState", "isDirty", "dirtyCounter", "_setState", "_onCommitted"]) {
      expect(member in model).toBe(false);
    }
  });

  it("no_track_object_state_guards_remain", () => {
    const src = path.join(root, "src");
    const offenders = fs.readdirSync(src).filter((f) => fs.readFileSync(path.join(src, f), "utf8").includes("_tracksObjectState"));
    expect(offenders).toEqual([]);
  });

  it("sessions: only a DirtyTracker's session reports deleted objects", () => {
    const dirty = new DirtyTracker();
    const model = dirty.construct(() => new DirtyModel(dirty));
    const items = dirty.construct(() => new TrackedCollection<DirtyModel>(dirty, [model]));
    const session = dirty.startSession([[model, []]]);
    items.remove(model);
    expect(session.deletedObjects).toEqual([model]);
    session.end();

    const events = new EventTracker();
    expect("deletedObjects" in events.startSession()).toBe(false);
  });

  it("DirtyTrackedObject counts uncommitted writes", () => {
    class Counted extends DirtyTrackedObject {
      @Tracked() accessor n: number = 0;
      constructor(t: DirtyTracker) { super(t); }
    }
    const tracker = new DirtyTracker();
    const m = tracker.construct(() => new Counted(tracker));
    m.n = 1;
    m.n = 2;
    expect(m.dirtyCounter).toBe(2);
    tracker.undo();
    expect(m.dirtyCounter).toBe(1);
    tracker.onCommit();
    expect(m.dirtyCounter).toBe(0);
  });

  it("TrackedContainer (EventTracker side) aggregates children's validity; untrack and destroy detach them", () => {
    class Part extends TrackedObject {
      @Tracked((_s, v: string) => (v === "" ? "required" : undefined)) accessor name: string = "ok";
      constructor(t: EventTracker) { super(t); }
    }
    class Box extends TrackedContainer {
      constructor(t: EventTracker, readonly part: Part, readonly parts: TrackedCollection<Part>) {
        super(t);
        this.trackChild(part);
        this.trackChild(parts);
      }
      release(): void {
        this.untrackChild(this.part);
        this.untrackChild(this.parts);
      }
    }
    const tracker = new EventTracker();
    const part = tracker.construct(() => new Part(tracker));
    const listed = tracker.construct(() => new Part(tracker));
    const parts = tracker.construct(() => new TrackedCollection<Part>(tracker, [listed]));
    const box = tracker.construct(() => new Box(tracker, part, parts));

    listed.name = "";
    expect(box.trakrIsValid).toBe(false);
    box.release();
    expect(box.trakrIsValid).toBe(true);

    const other = tracker.construct(() => new Box(tracker, part, parts));
    other.destroy();
    expect(tracker.trackedObjects).not.toContain(other);
  });

  it("a container tolerates an item it no longer tracks leaving a tracked collection", () => {
    class Part extends TrackedObject {
      constructor(t: EventTracker) { super(t); }
    }
    class Box extends TrackedContainer {
      constructor(t: EventTracker, readonly parts: TrackedCollection<Part>) {
        super(t);
        this.trackChild(parts);
      }
      forget(part: Part): void {
        this.untrackChild(part);
      }
    }
    const tracker = new EventTracker();
    const part = tracker.construct(() => new Part(tracker));
    const parts = tracker.construct(() => new TrackedCollection<Part>(tracker, [part]));
    const box = tracker.construct(() => new Box(tracker, parts));
    box.forget(part);            // no longer a child of the box…
    parts.remove(part);          // …so its removal from the collection has nothing to detach
    expect(parts.collection).toEqual([]);
    expect(box.trakrIsValid).toBe(true);
  });

  it("both model kinds share the Tracker-agnostic base API", () => {
    const events = new EventTracker();
    const dirty = new DirtyTracker();
    const models = [
      events.construct(() => new EventModel(events)),
      dirty.construct(() => new DirtyModel(dirty)),
    ];
    for (const m of models) {
      expect(m.trakrId).toBeGreaterThan(0);
      expect(m.trakrIsValid).toBe(true);
      expect(m.tracker).toBeInstanceOf(Tracker);
    }
  });
});

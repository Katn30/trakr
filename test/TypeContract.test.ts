import { describe, it, expect } from "vitest";
import * as path from "node:path";
import * as fs from "node:fs";
import ts from "typescript";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { EventLog } from "../packages/event-log/src/EventLog";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";
import { TrackedContainer } from "../packages/event-log/src/TrackedContainer";
import { Tracked } from "../packages/core/src/Tracked";
import { Tracker } from "../packages/core/src/Tracker";
import { EventTracked } from "../packages/event-log/src/EventTracked";
import { Id } from "../packages/core/src/ExternallyAssigned";
import { EventTrackedCollection } from "../packages/event-log/src/EventTrackedCollection";

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
    constructor(t: EventLog) { super(t); }
  }
  class DirtyModel extends Entity {
    constructor(t: UnitOfWork) { super(t); }
  }

  it("event_tracker_tracked_object_has_no_state_api", () => {
    const tracker = new EventLog();
    const model = tracker.new(() => new EventModel(tracker)) as unknown as Record<string, unknown>;
    for (const member of ["chronicleState", "isDirty", "dirtyCounter", "_setState", "_onCommitted"]) {
      expect(member in model).toBe(false);
    }
  });

  it("no_track_object_state_guards_remain", () => {
    const packages = path.join(root, "packages");
    const files = fs.readdirSync(packages, { recursive: true, encoding: "utf8" })
      .filter((f) => f.endsWith(".ts") && f.includes(`${path.sep}src${path.sep}`));
    expect(files.length).toBeGreaterThan(0);
    const offenders = files.filter((f) => fs.readFileSync(path.join(packages, f), "utf8").includes("_tracksObjectState"));
    expect(offenders).toEqual([]);
  });

  it("sessions: only a UnitOfWork's session reports deleted objects", () => {
    const dirty = new UnitOfWork();
    const model = dirty.construct(() => new DirtyModel(dirty));
    const items = dirty.construct(() => new TrackedCollection<DirtyModel>(dirty, [model]));
    const session = dirty._startSession([[model, []]]);
    items.remove(model);
    expect(session.deletedObjects).toEqual([model]);
    session.end();

    const events = new EventLog();
    expect("deletedObjects" in events._startSession()).toBe(false);
  });

  it("Entity counts uncommitted writes", () => {
    class Counted extends Entity {
      @Tracked() accessor n: number = 0;
      constructor(t: UnitOfWork) { super(t); }
    }
    const tracker = new UnitOfWork();
    const m = tracker.construct(() => new Counted(tracker));
    m.n = 1;
    m.n = 2;
    expect(m.dirtyCounter).toBe(2);
    tracker.undo();
    expect(m.dirtyCounter).toBe(1);
    tracker._onCommit();
    expect(m.dirtyCounter).toBe(0);
  });

  it("TrackedContainer (EventLog side) aggregates children's validity; untrack and destroy detach them", () => {
    class Part extends TrackedObject {
      @Id code = "p";
      @EventTracked((_s, v: string) => (v === "" ? "required" : undefined)) accessor name: string = "ok";
      constructor(t: EventLog) { super(t); }
    }
    class Box extends TrackedContainer {
      constructor(t: EventLog, readonly part: Part, readonly parts: EventTrackedCollection<Part>) {
        super(t);
        this.trackChild(part, "part");
        this.trackChild(parts);
      }
      release(): void {
        this.untrackChild(this.part);
        this.untrackChild(this.parts);
      }
    }
    const tracker = new EventLog();
    const part = tracker.construct(() => new Part(tracker));
    const listed = tracker.construct(() => new Part(tracker));
    const parts = tracker.construct(() => new EventTrackedCollection<Part>(tracker, "parts", [listed]));
    const box = tracker.construct(() => new Box(tracker, part, parts));

    listed.name = "";
    expect(box.chronicleIsValid).toBe(false);
    box.release();
    expect(box.chronicleIsValid).toBe(true);

    const other = tracker.construct(() => new Box(tracker, part, parts));
    other.destroy();
    expect(tracker._trackedObjects).not.toContain(other);
  });

  it("a container tolerates an item it no longer tracks leaving a tracked collection", () => {
    class Part extends TrackedObject {
      @Id code = "p";
      constructor(t: EventLog) { super(t); }
    }
    class Box extends TrackedContainer {
      constructor(t: EventLog, readonly parts: EventTrackedCollection<Part>) {
        super(t);
        this.trackChild(parts);
      }
      forget(part: Part): void {
        this.untrackChild(part);
      }
    }
    const tracker = new EventLog();
    const part = tracker.construct(() => new Part(tracker));
    const parts = tracker.construct(() => new EventTrackedCollection<Part>(tracker, "parts", [part]));
    const box = tracker.construct(() => new Box(tracker, parts));
    box.forget(part);            // no longer a child of the box…
    parts.remove(part);          // …so its removal from the collection has nothing to detach
    expect(parts.collection).toEqual([]);
    expect(box.chronicleIsValid).toBe(true);
  });

  it("both model kinds share the Tracker-agnostic base API", () => {
    const events = new EventLog();
    const dirty = new UnitOfWork();
    const models = [
      events.construct(() => new EventModel(events)),
      dirty.construct(() => new DirtyModel(dirty)),
    ];
    for (const m of models) {
      expect(m.chronicleId).toBeGreaterThan(0);
      expect(m.chronicleIsValid).toBe(true);
      expect(m.tracker).toBeInstanceOf(Tracker);
    }
  });
});

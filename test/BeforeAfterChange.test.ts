import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TrackedObject } from "../packages/event-log/src/TrackedObject";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Tracked } from "../packages/core/src/Tracked";
import { EventLog } from "../packages/event-log/src/EventLog";
import { EventTracked } from "../packages/event-log/src/EventTracked";

import { emitted, pendingEvents } from "./eventHelpers";
import { Entity } from "../packages/unit-of-work/src/Entity";
// ---- Models ----

class SimpleModel extends Entity {
  @Tracked() accessor value: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

class EventModel extends TrackedObject {
  @EventTracked()
  accessor name: string = "";

  constructor(tracker: EventLog) {
    super(tracker);
  }
}

// ---- Event ordering ----

describe("TrackedObject.beforeChange / afterChange", () => {
  it("beforeChange fires before afterChange on the same setter call", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const order: string[] = [];

    model.beforeChange.subscribe(() => order.push("before"));
    model.afterChange.subscribe(() => order.push("after"));

    model.value = "a";

    expect(order).toEqual(["before", "after"]);
  });

  it("beforeChange and afterChange both fire once per setter call", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));

    let beforeCount = 0;
    let afterCount = 0;
    model.beforeChange.subscribe(() => beforeCount++);
    model.afterChange.subscribe(() => afterCount++);

    model.value = "a";
    model.value = "b";

    expect(beforeCount).toBe(2);
    expect(afterCount).toBe(2);
  });

  it("carries the same event payload as changed", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const beforeEvents: unknown[] = [];
    const afterEvents: unknown[] = [];

    model.beforeChange.subscribe((e) => beforeEvents.push(e));
    model.afterChange.subscribe((e) => afterEvents.push(e));

    model.value = "hello";

    const expected = { property: "value", oldValue: "", newValue: "hello" };
    expect(beforeEvents).toEqual([expected]);
    expect(afterEvents).toEqual([expected]);
  });

  it("neither fires during undo and redo; changed does", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));

    model.value = "a";
    const before: string[] = [];
    const after: string[] = [];
    model.beforeChange.subscribe(({ newValue }) => before.push(newValue as string));
    model.afterChange.subscribe(({ newValue }) => after.push(newValue as string));

    const changed: string[] = [];
    model.changed.subscribe(({ newValue }) => changed.push(newValue as string));

    tracker.undo();
    tracker.redo();

    expect(before).toEqual([]);
    expect(after).toEqual([]);
    expect(changed).toEqual(["", "a"]);
  });

  it("order on a user write: beforeChange, changed, afterChange", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const order: string[] = [];
    model.afterChange.subscribe(() => order.push("after"));
    model.changed.subscribe(() => order.push("changed"));
    model.beforeChange.subscribe(() => order.push("before"));
    model.value = "a";
    expect(order).toEqual(["before", "changed", "after"]);
  });
});

// ---- changed: every change, user writes and replays ----

describe("TrackedObject.changed", () => {
  it("is its own event, separate from afterChange", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    expect(model.changed).not.toBe(model.afterChange);
  });

  it("subscribers still fire on writes (post-commit position)", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const values: string[] = [];

    model.changed.subscribe(({ newValue }) => values.push(newValue as string));
    model.value = "a";

    expect(values).toEqual(["a"]);
  });
});

// ---- Event-state commit ordering ----

describe("event state visibility relative to hooks", () => {
  it("beforeChange subscriber does not see the change in pendingEvents", () => {
    const tracker = new EventLog();
    const model = tracker.construct(() => new EventModel(tracker));

    let observed: unknown[] | undefined;
    model.beforeChange.subscribe(() => {
      observed = emitted(tracker);
    });

    model.name = "alice";

    // At the point beforeChange fires, event state hasn't been committed yet:
    // no NameChanged event should be present.
    expect(observed).toBeDefined();
    expect(observed!.some((e: any) => "name" in e.payload)).toBe(false);
  });

  it("afterChange fires before the operation's event is recorded", () => {
    const tracker = new EventLog();
    const model = tracker.construct(() => new EventModel(tracker));

    let observed: unknown[] | undefined;
    model.afterChange.subscribe(() => {
      observed = emitted(tracker);
    });

    model.name = "alice";

    expect(observed).toEqual([]);
  });

  it("a changed subscriber also sees the change before it is recorded as an event", () => {
    const tracker = new EventLog();
    const model = tracker.construct(() => new EventModel(tracker));
    const seen: number[] = [];
    model.changed.subscribe(() => seen.push(pendingEvents(tracker).length));
    model.name = "x";
    expect(seen).toEqual([0]);
    expect(pendingEvents(tracker)).toHaveLength(1);
  });
});

// ---- Decorator hooks API ----

describe("@Tracked hooks object form", () => {
  it("calls hooks.beforeChange at the pre-commit point", () => {
    const tracker = new EventLog();
    const observed: unknown[][] = [];

    class M extends TrackedObject {
      @EventTracked(
        undefined,
        {
          beforeChange: () => {
            observed.push(emitted(tracker));
          },
        },
      )
      accessor name: string = "";
      constructor(t: EventLog) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.name = "alice";

    expect(observed.length).toBe(1);
    expect(observed[0].some((e: any) => "name" in e.payload)).toBe(false);
  });

  it("calls hooks.afterChange during the write, before the operation's events are recorded", () => {
    const tracker = new EventLog();
    const observed: unknown[][] = [];

    class M extends TrackedObject {
      @EventTracked(
        undefined,
        {
          afterChange: () => {
            observed.push(emitted(tracker));
          },
        },
      )
      accessor name: string = "";
      constructor(t: EventLog) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.name = "alice";

    expect(observed.length).toBe(1);
    expect(observed[0].some((e: any) => "name" in e.payload)).toBe(false);
    expect(emitted(tracker).some((e) => "name" in e.payload)).toBe(true);
  });

  it("both hooks fire in the correct order", () => {
    const tracker = new UnitOfWork();
    const order: string[] = [];

    class M extends Entity {
      @Tracked(undefined, {
        beforeChange: () => order.push("hook-before"),
        afterChange: () => order.push("hook-after"),
      })
      accessor value: string = "";
      constructor(t: UnitOfWork) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.value = "x";

    expect(order).toEqual(["hook-before", "hook-after"]);
  });

  it("hooks do NOT fire during undo/redo", () => {
    const tracker = new UnitOfWork();
    let beforeCalls = 0;
    let afterCalls = 0;

    class M extends Entity {
      @Tracked(undefined, {
        beforeChange: () => beforeCalls++,
        afterChange: () => afterCalls++,
      })
      accessor value: string = "";
      constructor(t: UnitOfWork) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.value = "x";
    tracker.undo();
    tracker.redo();

    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
  });
});

// ---- No hooks path ----

describe("accessors without hooks", () => {
  it("still fire beforeChange and afterChange events", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const before: string[] = [];
    const after: string[] = [];

    model.beforeChange.subscribe(({ newValue }) => before.push(newValue as string));
    model.afterChange.subscribe(({ newValue }) => after.push(newValue as string));

    model.value = "a";

    expect(before).toEqual(["a"]);
    expect(after).toEqual(["a"]);
  });
});

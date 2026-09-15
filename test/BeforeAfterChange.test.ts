import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TrackedObject } from "../src/TrackedObject";
import { Tracker } from "../src/Tracker";
import { Tracked } from "../src/Tracked";
import { EventTracker } from "../src/EventTracker";
import { EventTracked } from "../src/EventTracked";

// ---- Models ----

class SimpleModel extends TrackedObject {
  @Tracked() accessor value: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class EventModel extends TrackedObject {
  @EventTracked(undefined, undefined, { eventType: "NameChanged" })
  accessor name: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

// ---- Event ordering ----

describe("TrackedObject.beforeChange / afterChange", () => {
  it("beforeChange fires before afterChange on the same setter call", () => {
    const tracker = new Tracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const order: string[] = [];

    model.beforeChange.subscribe(() => order.push("before"));
    model.afterChange.subscribe(() => order.push("after"));

    model.value = "a";

    expect(order).toEqual(["before", "after"]);
  });

  it("beforeChange and afterChange both fire once per setter call", () => {
    const tracker = new Tracker();
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
    const tracker = new Tracker();
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

  it("both fire during undo and redo", () => {
    const tracker = new Tracker();
    const model = tracker.construct(() => new SimpleModel(tracker));

    model.value = "a";
    const before: string[] = [];
    const after: string[] = [];
    model.beforeChange.subscribe(({ newValue }) => before.push(newValue as string));
    model.afterChange.subscribe(({ newValue }) => after.push(newValue as string));

    tracker.undo();
    tracker.redo();

    expect(before).toEqual(["", "a"]);
    expect(after).toEqual(["", "a"]);
  });
});

// ---- Alias: target.changed === target.afterChange ----

describe("TrackedObject.changed alias", () => {
  it("is the same TypedEvent instance as afterChange", () => {
    const tracker = new Tracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    expect(model.changed).toBe(model.afterChange);
  });

  it("subscribers still fire on writes (post-commit position)", () => {
    const tracker = new Tracker();
    const model = tracker.construct(() => new SimpleModel(tracker));
    const values: string[] = [];

    model.changed.subscribe(({ newValue }) => values.push(newValue as string));
    model.value = "a";

    expect(values).toEqual(["a"]);
  });
});

// ---- Event-state commit ordering ----

describe("event state visibility relative to hooks", () => {
  it("beforeChange subscriber does NOT see the change in generateEvents()", () => {
    const tracker = new EventTracker();
    const model = tracker.construct(() => new EventModel(tracker));

    let observed: unknown[] | undefined;
    model.beforeChange.subscribe(() => {
      observed = tracker.generateEvents();
    });

    model.name = "alice";

    // At the point beforeChange fires, event state hasn't been committed yet:
    // no NameChanged event should be present.
    expect(observed).toBeDefined();
    expect(observed!.some((e: any) => e.eventType === "NameChanged")).toBe(false);
  });

  it("afterChange subscriber DOES see the change in generateEvents()", () => {
    const tracker = new EventTracker();
    const model = tracker.construct(() => new EventModel(tracker));

    let observed: unknown[] | undefined;
    model.afterChange.subscribe(() => {
      observed = tracker.generateEvents();
    });

    model.name = "alice";

    expect(observed).toBeDefined();
    expect(observed!.some((e: any) => e.eventType === "NameChanged")).toBe(true);
  });

  it("target.changed subscriber DOES see the change in generateEvents() (alias for afterChange)", () => {
    const tracker = new EventTracker();
    const model = tracker.construct(() => new EventModel(tracker));

    let observed: unknown[] | undefined;
    model.changed.subscribe(() => {
      observed = tracker.generateEvents();
    });

    model.name = "alice";

    expect(observed).toBeDefined();
    expect(observed!.some((e: any) => e.eventType === "NameChanged")).toBe(true);
  });
});

// ---- Decorator hooks API ----

describe("@Tracked hooks object form", () => {
  it("calls hooks.beforeChange at the pre-commit point", () => {
    const tracker = new EventTracker();
    const observed: unknown[][] = [];

    class M extends TrackedObject {
      @EventTracked(
        undefined,
        {
          beforeChange: () => {
            observed.push(tracker.generateEvents());
          },
        },
        { eventType: "NameChanged" },
      )
      accessor name: string = "";
      constructor(t: Tracker) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.name = "alice";

    expect(observed.length).toBe(1);
    expect(observed[0].some((e: any) => e.eventType === "NameChanged")).toBe(false);
  });

  it("calls hooks.afterChange at the post-commit point", () => {
    const tracker = new EventTracker();
    const observed: unknown[][] = [];

    class M extends TrackedObject {
      @EventTracked(
        undefined,
        {
          afterChange: () => {
            observed.push(tracker.generateEvents());
          },
        },
        { eventType: "NameChanged" },
      )
      accessor name: string = "";
      constructor(t: Tracker) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.name = "alice";

    expect(observed.length).toBe(1);
    expect(observed[0].some((e: any) => e.eventType === "NameChanged")).toBe(true);
  });

  it("both hooks fire in the correct order", () => {
    const tracker = new Tracker();
    const order: string[] = [];

    class M extends TrackedObject {
      @Tracked(undefined, {
        beforeChange: () => order.push("hook-before"),
        afterChange: () => order.push("hook-after"),
      })
      accessor value: string = "";
      constructor(t: Tracker) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.value = "x";

    expect(order).toEqual(["hook-before", "hook-after"]);
  });

  it("hooks do NOT fire during undo/redo", () => {
    const tracker = new Tracker();
    let beforeCalls = 0;
    let afterCalls = 0;

    class M extends TrackedObject {
      @Tracked(undefined, {
        beforeChange: () => beforeCalls++,
        afterChange: () => afterCalls++,
      })
      accessor value: string = "";
      constructor(t: Tracker) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.value = "x";
    tracker.undo();
    tracker.redo();

    expect(beforeCalls).toBe(1);
    expect(afterCalls).toBe(1);
  });
});

// ---- Legacy function form ----

describe("@Tracked legacy onChange function form", () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it("still fires the legacy onChange at the pre-commit point", () => {
    const tracker = new EventTracker();
    const observed: unknown[][] = [];

    class M extends TrackedObject {
      @EventTracked(
        undefined,
        // Bare function — legacy form, mapped to beforeChange.
        () => {
          observed.push(tracker.generateEvents());
        },
        { eventType: "NameChanged" },
      )
      accessor name: string = "";
      constructor(t: Tracker) { super(t); }
    }

    const m = tracker.construct(() => new M(tracker));
    m.name = "alice";

    expect(observed.length).toBe(1);
    // Legacy = pre-commit → change not yet in generateEvents()
    expect(observed[0].some((e: any) => e.eventType === "NameChanged")).toBe(false);
  });
});

// ---- No hooks path ----

describe("accessors without hooks", () => {
  it("still fire beforeChange and afterChange events", () => {
    const tracker = new Tracker();
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

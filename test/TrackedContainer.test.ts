import { describe, it, expect } from "vitest";
import { TrackedContainer } from "../src/TrackedContainer";
import { TrackedObject } from "../src/TrackedObject";
import { TrackedCollection } from "../src/TrackedCollection";
import { Tracker } from "../src/Tracker";
import { Tracked } from "../src/Tracked";

// ---- Models ----

class ChildModel extends TrackedObject {
  @Tracked((_, v: string) => (!v ? "Child name required" : undefined))
  accessor name: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class SingleChildContainer extends TrackedContainer {
  @Tracked((_, v: string) => (!v ? "Title required" : undefined))
  accessor title: string = "";

  constructor(
    tracker: Tracker,
    child: TrackedObject | TrackedCollection<unknown>,
  ) {
    super(tracker);
    this.trackChild(child);
  }
}

class MultiChildContainer extends TrackedContainer {
  @Tracked()
  accessor note: string = "";

  constructor(
    tracker: Tracker,
    children: Array<TrackedObject | TrackedCollection<unknown>>,
  ) {
    super(tracker);
    for (const c of children) this.trackChild(c);
  }
}

// ---- isValid — own field ----

describe("TrackedContainer – own @Tracked validators work normally", () => {
  it("own validator fires and populates validationMessages", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(() => new SingleChildContainer(tracker, items));

    expect(container.validationMessages.get("title")).toBe("Title required");
    expect(container.isValid).toBe(false);
  });

  it("own validator clears when field is set to a valid value", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(() => new SingleChildContainer(tracker, items));

    container.title = "Something";

    expect(container.validationMessages.get("title")).toBeUndefined();
    expect(container.isValid).toBe(true);
  });

  it("undoing a field change restores the validation error", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(() => new SingleChildContainer(tracker, items));
    container.title = "Something";

    tracker.undo();

    expect(container.title).toBe("");
    expect(container.validationMessages.get("title")).toBe("Title required");
    expect(container.isValid).toBe(false);
  });
});

// ---- isValid — child object validity ----

describe("TrackedContainer – isValid reflects TrackedObject child validity", () => {
  it("is false when a registered child object is invalid", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker)); // name="" → invalid
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );
    tracker.withTrackingSuppressed(() => {
      container.title = "T";
    });

    expect(child.isValid).toBe(false);
    expect(container.isValid).toBe(false);
  });

  it("is true when the container's own fields and all children are valid", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    // MultiChildContainer has no own-field validators — starts valid
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [child]),
    );

    child.name = "Alice";

    expect(child.isValid).toBe(true);
    expect(container.isValid).toBe(true);
  });

  it("is false when own field is invalid even if child is valid", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    child.name = "Alice";

    expect(child.isValid).toBe(true);
    // title is still "" → container invalid despite valid child
    expect(container.isValid).toBe(false);
  });

  it("becomes valid once both own field and child are valid", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    container.title = "T";
    child.name = "Alice";

    expect(container.isValid).toBe(true);
  });
});

// ---- isValid — collection child validity ----

describe("TrackedContainer – isValid reflects TrackedCollection child validity", () => {
  it("is false when a registered collection is invalid (fails its validator)", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<string>(
      tracker,
      [],
      (list) => (list.length === 0 ? "At least one item required" : undefined),
    );
    // items is empty → invalid
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, items),
    );
    tracker.withTrackingSuppressed(() => {
      container.title = "T";
    });

    expect(items.isValid).toBe(false);
    expect(container.isValid).toBe(false);
  });

  it("becomes valid when the collection passes its validator", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<string>(
      tracker,
      [],
      (list) => (list.length === 0 ? "At least one item required" : undefined),
    );
    // MultiChildContainer has no own-field validators — starts valid
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );

    items.push("first");

    expect(items.isValid).toBe(true);
    expect(container.isValid).toBe(true);
  });
});

// ---- isValid — multiple children ----

describe("TrackedContainer – multiple children: one invalid makes container invalid", () => {
  it("is false when the first child (TrackedObject) is invalid", () => {
    const tracker = new Tracker();
    const childA = tracker.construct(() => new ChildModel(tracker)); // invalid
    const childB = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [childA, childB]),
    );
    childB.name = "B";

    expect(childA.isValid).toBe(false);
    expect(container.isValid).toBe(false);
  });

  it("is false when the second child (TrackedObject) is invalid", () => {
    const tracker = new Tracker();
    const childA = tracker.construct(() => new ChildModel(tracker));
    const childB = tracker.construct(() => new ChildModel(tracker)); // invalid
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [childA, childB]),
    );
    childA.name = "A";

    expect(childB.isValid).toBe(false);
    expect(container.isValid).toBe(false);
  });

  it("is true when all children and own fields are valid", () => {
    const tracker = new Tracker();
    const childA = tracker.construct(() => new ChildModel(tracker));
    const childB = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [childA, childB]),
    );

    childA.name = "A";
    childB.name = "B";

    // note="" has no validator → container.isValid depends only on children
    expect(container.isValid).toBe(true);
  });

  it("is false when a TrackedCollection child is invalid and TrackedObject child is valid", () => {
    const tracker = new Tracker();
    const childA = tracker.construct(() => new ChildModel(tracker));
    const childB = new TrackedCollection<string>(
      tracker,
      [],
      (list) => (list.length === 0 ? "Required" : undefined),
    );
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [childA, childB]),
    );

    childA.name = "A";

    expect(childA.isValid).toBe(true);
    expect(childB.isValid).toBe(false);
    expect(container.isValid).toBe(false);
  });
});

// ---- isDirty ----

describe("TrackedContainer – isDirty", () => {
  it("is false when nothing has changed", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    expect(container.isDirty).toBe(false);
  });

  it("is true when an own @Tracked field changes", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    container.title = "new title";

    expect(container.isDirty).toBe(true);
  });

  it("is true when a registered child TrackedObject has a dirty field", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    child.name = "Alice";

    expect(child.isDirty).toBe(true);
    expect(container.isDirty).toBe(true);
  });

  it("is false after undoing a child mutation", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );
    child.name = "Alice";

    tracker.undo();

    expect(child.isDirty).toBe(false);
    expect(container.isDirty).toBe(false);
  });

  it("is true from own field even when child is clean", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    container.title = "T";
    // child is clean

    expect(child.isDirty).toBe(false);
    expect(container.isDirty).toBe(true);
  });
});

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
    expect(container.trakrIsValid).toBe(false);
  });

  it("own validator clears when field is set to a valid value", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(() => new SingleChildContainer(tracker, items));

    container.title = "Something";

    expect(container.validationMessages.get("title")).toBeUndefined();
    expect(container.trakrIsValid).toBe(true);
  });

  it("undoing a field change restores the validation error", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(() => new SingleChildContainer(tracker, items));
    container.title = "Something";

    tracker.undo();

    expect(container.title).toBe("");
    expect(container.validationMessages.get("title")).toBe("Title required");
    expect(container.trakrIsValid).toBe(false);
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

    expect(child.trakrIsValid).toBe(false);
    expect(container.trakrIsValid).toBe(false);
  });

  it("is true when the container's own fields and all children are valid", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    // MultiChildContainer has no own-field validators — starts valid
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [child]),
    );

    child.name = "Alice";

    expect(child.trakrIsValid).toBe(true);
    expect(container.trakrIsValid).toBe(true);
  });

  it("is false when own field is invalid even if child is valid", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    child.name = "Alice";

    expect(child.trakrIsValid).toBe(true);
    // title is still "" → container invalid despite valid child
    expect(container.trakrIsValid).toBe(false);
  });

  it("becomes valid once both own field and child are valid", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker));
    const container = tracker.construct(
      () => new SingleChildContainer(tracker, child),
    );

    container.title = "T";
    child.name = "Alice";

    expect(container.trakrIsValid).toBe(true);
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

    expect(items.trakrIsValid).toBe(false);
    expect(container.trakrIsValid).toBe(false);
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

    expect(items.trakrIsValid).toBe(true);
    expect(container.trakrIsValid).toBe(true);
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

    expect(childA.trakrIsValid).toBe(false);
    expect(container.trakrIsValid).toBe(false);
  });

  it("is false when the second child (TrackedObject) is invalid", () => {
    const tracker = new Tracker();
    const childA = tracker.construct(() => new ChildModel(tracker));
    const childB = tracker.construct(() => new ChildModel(tracker)); // invalid
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [childA, childB]),
    );
    childA.name = "A";

    expect(childB.trakrIsValid).toBe(false);
    expect(container.trakrIsValid).toBe(false);
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
    expect(container.trakrIsValid).toBe(true);
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

    expect(childA.trakrIsValid).toBe(true);
    expect(childB.trakrIsValid).toBe(false);
    expect(container.trakrIsValid).toBe(false);
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

// ---- collection item tracking ----

describe("TrackedContainer – collection items are tracked automatically", () => {
  it("item already in the collection at trackChild time makes container invalid", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ChildModel(tracker)); // name="" → invalid
    const items = new TrackedCollection<ChildModel>(tracker, [item]);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );

    expect(item.trakrIsValid).toBe(false);
    expect(container.trakrIsValid).toBe(false);
  });

  it("item pre-existing in collection: container becomes valid when item becomes valid", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ChildModel(tracker));
    const items = new TrackedCollection<ChildModel>(tracker, [item]);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );

    item.name = "Alice";

    expect(item.trakrIsValid).toBe(true);
    expect(container.trakrIsValid).toBe(true);
  });

  it("pushing an invalid item makes the container invalid", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );
    expect(container.trakrIsValid).toBe(true);

    const item = tracker.construct(() => new ChildModel(tracker)); // name="" → invalid
    items.push(item);

    expect(container.trakrIsValid).toBe(false);
  });

  it("pushed item becoming valid makes the container valid again", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );
    const item = tracker.construct(() => new ChildModel(tracker));
    items.push(item);
    expect(container.trakrIsValid).toBe(false);

    item.name = "Alice";

    expect(container.trakrIsValid).toBe(true);
  });

  it("removing an invalid item restores container validity", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );
    const item = tracker.construct(() => new ChildModel(tracker));
    items.push(item);
    expect(container.trakrIsValid).toBe(false);

    items.remove(item);

    expect(container.trakrIsValid).toBe(true);
  });

  it("undoing a push removes the item from tracking", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );
    const item = tracker.construct(() => new ChildModel(tracker));
    items.push(item);
    expect(container.trakrIsValid).toBe(false);

    tracker.undo();

    expect(container.trakrIsValid).toBe(true);
  });

  it("redoing a push re-adds the item to tracking", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );
    const item = tracker.construct(() => new ChildModel(tracker));
    items.push(item);
    tracker.undo();
    expect(container.trakrIsValid).toBe(true);

    tracker.redo();

    expect(container.trakrIsValid).toBe(false);
  });

  it("isDirty is true when a collection item has dirty fields", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ChildModel(tracker));
    const items = new TrackedCollection<ChildModel>(tracker, [item]);
    const container = tracker.construct(
      () => new MultiChildContainer(tracker, [items]),
    );

    item.name = "Alice";

    expect(item.isDirty).toBe(true);
    expect(container.isDirty).toBe(true);
  });
});

// ---- untrackChild ----

describe("TrackedContainer – untrackChild", () => {
  it("untracking a TrackedObject child stops its validity from affecting the container", () => {
    const tracker = new Tracker();
    const child = tracker.construct(() => new ChildModel(tracker)); // name="" → invalid

    class DynamicContainer extends TrackedContainer {
      constructor(t: Tracker) {
        super(t);
        this.trackChild(child);
      }
      remove() { this.untrackChild(child); }
    }

    const container = tracker.construct(() => new DynamicContainer(tracker));
    expect(container.trakrIsValid).toBe(false);

    container.remove();

    expect(container.trakrIsValid).toBe(true);
  });

  it("untracking a TrackedCollection stops its items from affecting the container", () => {
    const tracker = new Tracker();
    const item = tracker.construct(() => new ChildModel(tracker)); // invalid
    const items = new TrackedCollection<ChildModel>(tracker, [item]);

    class DynamicContainer extends TrackedContainer {
      constructor(t: Tracker) {
        super(t);
        this.trackChild(items);
      }
      remove() { this.untrackChild(items); }
    }

    const container = tracker.construct(() => new DynamicContainer(tracker));
    expect(container.trakrIsValid).toBe(false);

    container.remove();

    expect(container.trakrIsValid).toBe(true);
  });

  it("after untracking a collection, newly pushed items no longer affect the container", () => {
    const tracker = new Tracker();
    const items = new TrackedCollection<ChildModel>(tracker);

    class DynamicContainer extends TrackedContainer {
      constructor(t: Tracker) {
        super(t);
        this.trackChild(items);
      }
      remove() { this.untrackChild(items); }
    }

    const container = tracker.construct(() => new DynamicContainer(tracker));
    container.remove();

    const item = tracker.construct(() => new ChildModel(tracker)); // invalid
    items.push(item);

    expect(container.trakrIsValid).toBe(true);
  });

  it("untracking a child that was never tracked is a no-op", () => {
    const tracker = new Tracker();
    const foreign = tracker.construct(() => new ChildModel(tracker));

    class DynamicContainer extends TrackedContainer {
      constructor(t: Tracker) { super(t); }
      remove() { this.untrackChild(foreign); }
    }

    const container = tracker.construct(() => new DynamicContainer(tracker));

    expect(() => container.remove()).not.toThrow();
    expect(container.trakrIsValid).toBe(true);
  });
});

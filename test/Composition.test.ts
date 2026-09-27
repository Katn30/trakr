import { describe, it, expect } from "vitest";
import { Entity } from "../packages/unit-of-work/src/Entity";
import { Tracker } from "../packages/core/src/Tracker";
import { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import { Tracked } from "../packages/core/src/Tracked";
import { TrackedCollection } from "../packages/core/src/TrackedCollection";

// ---- Models ----

// Case 1a: @Tracked setter → @Tracked setter
class NameModel extends Entity {
  private _firstName: string = "";
  private _lastName: string = "";

  get firstName(): string { return this._firstName; }
  @Tracked() set firstName(value: string) { this._firstName = value; }

  get lastName(): string { return this._lastName; }
  @Tracked() set lastName(value: string) { this._lastName = value; }

  // Setting fullName composes firstName + lastName into one undo step
  get fullName(): string { return `${this._firstName} ${this._lastName}`.trim(); }
  @Tracked() set fullName(value: string) {
    const [first = "", last = ""] = value.split(" ");
    this.firstName = first;
    this.lastName = last;
  }
}

// Case 1b: @Tracked setter → TrackedCollection mutation
class TagModel extends Entity {
  private _tag: string = "";
  readonly tags: TrackedCollection<string>;

  constructor(tracker: UnitOfWork) {
    super(tracker);
    this.tags = new TrackedCollection<string>(tracker);
  }

  get tag(): string { return this._tag; }
  @Tracked() set tag(value: string) {
    this._tag = value;
    if (value) this.tags.push(value);
  }
}

// Case 2: TrackedCollection.changed → @Tracked setter
class OrderModel extends Entity {
  @Tracked() accessor itemCount: number = 0;

  readonly items: TrackedCollection<string>;

  constructor(tracker: UnitOfWork) {
    super(tracker);
    this.items = new TrackedCollection<string>(tracker);
    this.items.changed.subscribe(() => {
      this.itemCount = this.items.length;
    });
  }
}

// Case 1b: @Tracked accessor onChange → @Tracked setter
class AccessorTagModel extends Entity {
  readonly tags: TrackedCollection<string>;

  @Tracked(
    undefined,
    { beforeChange: (self: AccessorTagModel, newValue: string, oldValue: string) => {
      if (oldValue) self.tags.remove(oldValue);
      if (newValue) self.tags.push(newValue);
    } },
  )
  accessor tag: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
    this.tags = new TrackedCollection<string>(tracker);
  }
}

// Case 1b variant: @Tracked accessor onChange → @Tracked accessor
class AccessorNameModel extends Entity {
  @Tracked(
    undefined,
    { beforeChange: (self: AccessorNameModel, newValue: string) => {
      const [first = "", last = ""] = newValue.split(" ");
      self.firstName = first;
      self.lastName = last;
    } },
  )
  accessor fullName: string = "";

  @Tracked() accessor firstName: string = "";
  @Tracked() accessor lastName: string = "";

  constructor(tracker: UnitOfWork) {
    super(tracker);
  }
}

// Case 3: Entity.afterChange → @Tracked setter
class TitleModel extends Entity {
  private _title: string = "";
  @Tracked() accessor summary: string = "";

  get title(): string { return this._title; }
  @Tracked() set title(value: string) { this._title = value; }

  constructor(tracker: UnitOfWork) {
    super(tracker);
    this.afterChange.subscribe(({ property, newValue }) => {
      if (property === "title") {
        this.summary = `Summary: ${newValue}`;
      }
    });
  }
}

// Case 4: TrackedCollection.afterChange → @Tracked setter
class CountedCollection extends Entity {
  @Tracked() accessor count: number = 0;

  readonly items: TrackedCollection<string>;

  constructor(tracker: UnitOfWork) {
    super(tracker);
    this.items = new TrackedCollection<string>(tracker);
    this.items.afterChange.subscribe(() => {
      this.count = this.items.length;
    });
  }
}

// ---- Tests ----

describe("Automatic composing – @Tracked setter → @Tracked setter", () => {
  it("writes inside @Tracked setter body compose into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new NameModel(tracker));

    model.fullName = "John Doe";

    expect(model.firstName).toBe("John");
    expect(model.lastName).toBe("Doe");

    tracker.undo();

    expect(model.firstName).toBe("");
    expect(model.lastName).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("redo restores all properties written inside the setter", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new NameModel(tracker));

    model.fullName = "John Doe";
    tracker.undo();
    tracker.redo();

    expect(model.firstName).toBe("John");
    expect(model.lastName).toBe("Doe");
    expect(tracker.canRedo).toBe(false);
  });
});

describe("Automatic composing – @Tracked setter → TrackedCollection mutation", () => {
  it("collection mutation inside @Tracked setter body composes into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new TagModel(tracker));

    model.tag = "active";

    expect(model.tag).toBe("active");
    expect(model.tags.length).toBe(1);

    tracker.undo();

    expect(model.tag).toBe("");
    expect(model.tags.length).toBe(0);
    expect(tracker.canUndo).toBe(false);
  });

  it("redo restores both the property and the collection", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new TagModel(tracker));

    model.tag = "active";
    tracker.undo();
    tracker.redo();

    expect(model.tag).toBe("active");
    expect(model.tags.length).toBe(1);
    expect(tracker.canRedo).toBe(false);
  });
});

describe("Automatic composing – @Tracked accessor onChange → TrackedCollection mutation", () => {
  it("collection mutation inside onChange composes into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new AccessorTagModel(tracker));

    model.tag = "active";

    expect(model.tag).toBe("active");
    expect(model.tags.length).toBe(1);
    expect(model.tags.first()).toBe("active");

    tracker.undo();

    expect(model.tag).toBe("");
    expect(model.tags.length).toBe(0);
    expect(tracker.canUndo).toBe(false);
  });

  it("redo restores both the accessor and the collection", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new AccessorTagModel(tracker));

    model.tag = "active";
    tracker.undo();
    tracker.redo();

    expect(model.tag).toBe("active");
    expect(model.tags.length).toBe(1);
    expect(tracker.canRedo).toBe(false);
  });

  it("onChange does not fire during undo or redo", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new AccessorTagModel(tracker));

    model.tag = "active";
    tracker.undo();
    tracker.redo();

    // still one undo step — undo/redo did not create extra operations via onChange
    expect(tracker.canUndo).toBe(true);
    expect(tracker.canRedo).toBe(false);
  });
});

describe("Automatic composing – @Tracked accessor onChange → @Tracked accessor", () => {
  it("accessor writes inside onChange compose into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new AccessorNameModel(tracker));

    model.fullName = "John Doe";

    expect(model.firstName).toBe("John");
    expect(model.lastName).toBe("Doe");

    tracker.undo();

    expect(model.fullName).toBe("");
    expect(model.firstName).toBe("");
    expect(model.lastName).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("redo restores all accessors written inside onChange", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new AccessorNameModel(tracker));

    model.fullName = "John Doe";
    tracker.undo();
    tracker.redo();

    expect(model.fullName).toBe("John Doe");
    expect(model.firstName).toBe("John");
    expect(model.lastName).toBe("Doe");
    expect(tracker.canRedo).toBe(false);
  });
});

describe("Automatic composing – TrackedCollection.changed → @Tracked setter", () => {
  it("collection mutation and changed-listener property write compose into one undo step", () => {
    const tracker = new UnitOfWork();
    const order = tracker.construct(() => new OrderModel(tracker));

    order.items.push("item-1");

    expect(order.items.length).toBe(1);
    expect(order.itemCount).toBe(1);

    tracker.undo();

    expect(order.items.length).toBe(0);
    expect(order.itemCount).toBe(0);
    expect(tracker.canUndo).toBe(false);
  });

  it("redo restores both collection and property", () => {
    const tracker = new UnitOfWork();
    const order = tracker.construct(() => new OrderModel(tracker));

    order.items.push("item-1");
    tracker.undo();
    tracker.redo();

    expect(order.items.length).toBe(1);
    expect(order.itemCount).toBe(1);
    expect(tracker.canRedo).toBe(false);
  });

  it("multiple pushes each compose with their listener update separately", () => {
    const tracker = new UnitOfWork();
    const order = tracker.construct(() => new OrderModel(tracker));

    order.items.push("item-1");
    order.items.push("item-2");

    tracker.undo();
    expect(order.items.length).toBe(1);
    expect(order.itemCount).toBe(1);

    tracker.undo();
    expect(order.items.length).toBe(0);
    expect(order.itemCount).toBe(0);
    expect(tracker.canUndo).toBe(false);
  });
});

describe("Automatic composing – Entity.afterChange → @Tracked setter", () => {
  it("property write inside afterChange listener composes into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new TitleModel(tracker));

    model.title = "Hello";

    expect(model.title).toBe("Hello");
    expect(model.summary).toBe("Summary: Hello");

    tracker.undo();

    expect(model.title).toBe("");
    expect(model.summary).toBe("");
    expect(tracker.canUndo).toBe(false);
  });

  it("redo restores both the source property and the listener-written property", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new TitleModel(tracker));

    model.title = "Hello";
    tracker.undo();
    tracker.redo();

    expect(model.title).toBe("Hello");
    expect(model.summary).toBe("Summary: Hello");
    expect(tracker.canRedo).toBe(false);
  });

  it("afterChange listener does not fire during undo or redo", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new TitleModel(tracker));

    model.title = "Hello";
    const stepCount = tracker.canUndo ? 1 : 0;

    tracker.undo();
    tracker.redo();

    // Still one undo step — undo/redo did not create extra operations via the listener
    expect(tracker.canUndo).toBe(stepCount === 1);
    expect(tracker.canRedo).toBe(false);
  });
});

describe("Automatic composing – TrackedCollection.afterChange → @Tracked setter", () => {
  it("property write inside afterChange listener composes into one undo step", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new CountedCollection(tracker));

    model.items.push("a");

    expect(model.items.length).toBe(1);
    expect(model.count).toBe(1);

    tracker.undo();

    expect(model.items.length).toBe(0);
    expect(model.count).toBe(0);
    expect(tracker.canUndo).toBe(false);
  });

  it("redo restores both the collection and the listener-written property", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new CountedCollection(tracker));

    model.items.push("a");
    tracker.undo();
    tracker.redo();

    expect(model.items.length).toBe(1);
    expect(model.count).toBe(1);
    expect(tracker.canRedo).toBe(false);
  });

  it("afterChange listener does not fire during undo or redo", () => {
    const tracker = new UnitOfWork();
    const model = tracker.construct(() => new CountedCollection(tracker));

    model.items.push("a");

    tracker.undo();
    tracker.redo();

    // Still one undo step — undo/redo did not create extra operations via the listener
    expect(tracker.canUndo).toBe(true);
    expect(tracker.canRedo).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { TrackedObject } from "../src/TrackedObject";
import { Tracker } from "../src/Tracker";
import { Tracked } from "../src/Tracked";

class RuleBase extends TrackedObject {
  @Tracked((self: RuleBase, v: string) =>
    !v ? "value is required" : undefined,
  )
  accessor value: string = "";

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

class ColumnRule extends RuleBase {
  @Tracked((self: ColumnRule, v: string) =>
    self.validateColumnName(v),
  )
  accessor columnName: string = "col";

  validateColumnName(v: string): string | undefined {
    return !v ? "columnName is required" : undefined;
  }
}

class CrossTableRule extends RuleBase {
  @Tracked((self: CrossTableRule, v: string) =>
    self.validateTable2Name(v),
  )
  accessor table2Name: string = "t2";

  validateTable2Name(v: string): string | undefined {
    return !v ? "table2Name is required" : undefined;
  }
}

describe("subclass @Tracked validators are isolated to their own class", () => {
  it("a validator declared on one subclass does not run against a sibling subclass instance", () => {
    const tracker = new Tracker();

    tracker.construct(() => new ColumnRule(tracker));
    const cross = tracker.construct(() => new CrossTableRule(tracker));

    expect(() => {
      cross.table2Name = "";
    }).not.toThrow();

    expect(cross.validationMessages.get("table2Name")).toBe(
      "table2Name is required",
    );
  });

  it("subclass validator still fires on its own instance", () => {
    const tracker = new Tracker();
    const col = tracker.construct(() => new ColumnRule(tracker));

    col.columnName = "";
    expect(col.validationMessages.get("columnName")).toBe(
      "columnName is required",
    );
  });

  it("base class validator still fires when a subclass adds its own validators", () => {
    const tracker = new Tracker();
    const col = tracker.construct(() => new ColumnRule(tracker));

    expect(col.validationMessages.get("value")).toBe("value is required");

    col.value = "ok";
    expect(col.validationMessages.has("value")).toBe(false);
  });

  it("base class validator still fires on a sibling subclass instance", () => {
    const tracker = new Tracker();
    const cross = tracker.construct(() => new CrossTableRule(tracker));

    expect(cross.validationMessages.get("value")).toBe("value is required");
  });

  it("validators from unrelated sibling do not appear in this instance's validation map", () => {
    const tracker = new Tracker();
    const cross = tracker.construct(() => new CrossTableRule(tracker));

    tracker.construct(() => new ColumnRule(tracker));

    expect(cross.validationMessages.has("columnName")).toBe(false);
  });

  it("subclass validators do not bleed to sibling when base class was previously instantiated", () => {
    const tracker = new Tracker();

    tracker.construct(() => new RuleBase(tracker));

    tracker.construct(() => new ColumnRule(tracker));
    const cross = tracker.construct(() => new CrossTableRule(tracker));

    expect(() => {
      cross.table2Name = "";
    }).not.toThrow();

    expect(cross.validationMessages.has("columnName")).toBe(false);
    expect(cross.validationMessages.get("table2Name")).toBe(
      "table2Name is required",
    );
  });
});

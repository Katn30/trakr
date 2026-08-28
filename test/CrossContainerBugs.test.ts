import { describe, it, expect, beforeEach } from "vitest";
import { TrackedContainer } from "../src/TrackedContainer";
import { TrackedCollection } from "../src/TrackedCollection";
import { Tracker } from "../src/Tracker";
import { EventTracker } from "../src/EventTracker";
import { Tracked } from "../src/Tracked";
import { EventTracked } from "../src/EventTracked";

// ===========================================================================
// Bug 1 — VARIANT A: @Tracked on both sides (control, already confirmed)
// ===========================================================================

const LIFECYCLE_ORDER = ["root_cause_analysis", "fix_in_progress", "done"];

class ChildTracked extends TrackedContainer {
  readonly getStage: () => string;

  @Tracked((self: ChildTracked, v: string | null) => {
    if (LIFECYCLE_ORDER.indexOf(self.getStage()) < LIFECYCLE_ORDER.indexOf("fix_in_progress"))
      return undefined;
    return (v ?? "").trim() ? undefined : "fixNotesRequired";
  })
  accessor fixNotes: string | null = null;

  constructor(tracker: Tracker, getStage: () => string) {
    super(tracker);
    this.getStage = getStage;
  }
}

class ParentTracked extends TrackedContainer {
  @Tracked()
  accessor state: string = "root_cause_analysis";

  readonly child: ChildTracked;

  constructor(tracker: Tracker) {
    super(tracker);
    this.child = new ChildTracked(tracker, () => this.state);
    this.trackChild(this.child);
  }
}

// ===========================================================================
// Bug 1 — VARIANT B: @EventTracked on both sides (the actual code)
// ===========================================================================

class ChildEventTracked extends TrackedContainer {
  readonly getStage: () => string;

  @EventTracked((self: ChildEventTracked, v: string | null) => {
    if (LIFECYCLE_ORDER.indexOf(self.getStage()) < LIFECYCLE_ORDER.indexOf("fix_in_progress"))
      return undefined;
    return (v ?? "").trim() ? undefined : "fixNotesRequired";
  })
  accessor fixNotes: string | null = null;

  constructor(tracker: EventTracker, getStage: () => string) {
    super(tracker);
    this.getStage = getStage;
  }
}

class ParentEventTracked extends TrackedContainer {
  @EventTracked()
  accessor state: string = "root_cause_analysis";

  readonly child: ChildEventTracked;

  constructor(tracker: EventTracker) {
    super(tracker);
    this.child = new ChildEventTracked(tracker, () => this.state);
    this.trackChild(this.child);
  }
}

// ===========================================================================
// Bug 2 — addSubtask with startSession() + withContext() (the actual code)
// ===========================================================================

class IssueActions extends TrackedContainer {
  readonly subtasks: TrackedCollection<string>;

  constructor(tracker: EventTracker) {
    super(tracker);
    this.subtasks = new TrackedCollection<string>(tracker);
    this.trackChild(this.subtasks);
  }
}

class Issue extends TrackedContainer {
  // Replicates the real field: has an onChange callback (represents _updateSessionPath).
  // Starts at root_cause_analysis so addSubtask("fixing_task") triggers the transition.
  @EventTracked(undefined, (_self: Issue, _v: string) => { /* _updateSessionPath */ })
  accessor state: string = "root_cause_analysis";

  // Field cleared during backward transition
  @EventTracked()
  accessor backwardField: string | null = "initial";

  // Field set during forward transition
  @EventTracked()
  accessor forwardField: string | null = null;

  readonly actions: IssueActions;

  constructor(tracker: EventTracker) {
    super(tracker);
    this.actions = new IssueActions(tracker);
    this.trackChild(this.actions);
  }

  addSubtask(subtask: string, userOid: string | null = null): void {
    const session = (this.tracker as EventTracker).startSession();
    try {
      this.actions.subtasks.push(subtask);
      if (subtask === "fixing_task" && this.state === "root_cause_analysis") {
        this._doTransition("fix_in_progress", userOid);
      }
      session.end();
    } catch (e) {
      session.rollback();
      throw e;
    }
  }

  protected _doTransition(target: string, userOid: string | null = null): void {
    // backward-transition field clearing (outside withContext, like the real code)
    this.backwardField = null;

    // state change inside withContext (exactly the real pattern)
    (this.tracker as EventTracker).withContext(
      { userOid },
      () => { this.state = target; },
    );

    // forward-transition field defaults (outside withContext, like the real code)
    this.forwardField = "post-transition";
  }
}

// ===========================================================================
// Bug 1 — VARIANT C: state written as an inner write (via onChange callback)
// ===========================================================================

class ParentInnerWrite extends TrackedContainer {
  // Writing `trigger = "advance"` fires onChange which writes `state` as an
  // inner write (the owner is `trigger`, not `state`).
  @Tracked(
    undefined,
    (self: ParentInnerWrite, v: string) => {
      if (v === "advance") self.state = "fix_in_progress";
    },
  )
  accessor trigger: string = "";

  @Tracked() accessor state: string = "root_cause_analysis";

  readonly child: ChildTracked;

  constructor(tracker: Tracker) {
    super(tracker);
    this.child = new ChildTracked(tracker, () => this.state);
    this.trackChild(this.child);
  }
}

// ===========================================================================
// Tests — Bug 1 Variant A (@Tracked control)
// ===========================================================================

describe("Bug 1A — @Tracked cross-container validator re-run via closure (control)", () => {
  let tracker: Tracker;
  let parent: ParentTracked;

  beforeEach(() => {
    tracker = new Tracker();
    parent = tracker.construct(() => new ParentTracked(tracker));
  });

  it("child is valid before state advances", () => {
    expect(parent.child.isValid).toBe(true);
  });

  it("child becomes invalid when state advances and fixNotes is null", () => {
    parent.state = "fix_in_progress";

    expect(parent.child.isValid).toBe(false);
    expect(parent.child.validationMessages.get("fixNotes")).toBe("fixNotesRequired");
  });

  it("tracker.isValid becomes false when child becomes invalid", () => {
    parent.state = "fix_in_progress";

    expect(tracker.isValid).toBe(false);
  });
});

// ===========================================================================
// Tests — Bug 1 Variant C (state is inner write via onChange callback)
// ===========================================================================

describe("Bug 1C — inner-write revalidation: state written via onChange, child validator must re-run", () => {
  let tracker: Tracker;
  let parent: ParentInnerWrite;

  beforeEach(() => {
    tracker = new Tracker();
    parent = tracker.construct(() => new ParentInnerWrite(tracker));
  });

  it("child is valid before trigger fires", () => {
    expect(parent.child.isValid).toBe(true);
  });

  it("child becomes invalid when trigger advances state as inner write", () => {
    parent.trigger = "advance";   // onChange writes state="fix_in_progress" as inner write

    expect(parent.state).toBe("fix_in_progress");
    expect(parent.child.isValid).toBe(false);
    expect(parent.child.validationMessages.get("fixNotes")).toBe("fixNotesRequired");
  });

  it("tracker.isValid becomes false when child becomes invalid via inner write", () => {
    parent.trigger = "advance";

    expect(tracker.isValid).toBe(false);
  });
});

// ===========================================================================
// Tests — Bug 1 Variant B (@EventTracked — the actual code)
// ===========================================================================

describe("Bug 1B — @EventTracked cross-container validator re-run via closure (actual code)", () => {
  let tracker: EventTracker;
  let parent: ParentEventTracked;

  beforeEach(() => {
    tracker = new EventTracker();
    parent = tracker.construct(() => new ParentEventTracked(tracker));
  });

  it("child is valid before state advances", () => {
    expect(parent.child.isValid).toBe(true);
  });

  it("child becomes invalid when state advances and fixNotes is null", () => {
    parent.state = "fix_in_progress";

    expect(parent.child.isValid).toBe(false);
    expect(parent.child.validationMessages.get("fixNotes")).toBe("fixNotesRequired");
  });

  it("parent.isValid reflects child invalidity", () => {
    parent.state = "fix_in_progress";

    expect(parent.isValid).toBe(false);
  });

  it("tracker.isValid becomes false when child becomes invalid", () => {
    parent.state = "fix_in_progress";

    expect(tracker.isValid).toBe(false);
  });

  it("child becomes valid once fixNotes is filled", () => {
    parent.state = "fix_in_progress";
    parent.child.fixNotes = "fixed";

    expect(parent.child.isValid).toBe(true);
  });

  it("child returns to valid when state drops back below fix_in_progress", () => {
    parent.state = "fix_in_progress";
    parent.state = "root_cause_analysis";

    expect(parent.child.isValid).toBe(true);
  });
});

// ===========================================================================
// Tests — Bug 2 (startSession + withContext)
// ===========================================================================

describe("Bug 2 — startSession() + withContext() undo batching (actual code)", () => {
  let tracker: EventTracker;
  let issue: Issue;

  beforeEach(() => {
    tracker = new EventTracker();
    issue = tracker.construct(() => new Issue(tracker));
  });

  it("pushing a fixing_task advances state to fix_in_progress (baseline)", () => {
    issue.addSubtask("fixing_task", "user1");

    expect(issue.actions.subtasks).toHaveLength(1);
    expect(issue.state).toBe("fix_in_progress");
    expect(issue.backwardField).toBeNull();
    expect(issue.forwardField).toBe("post-transition");
  });

  it("the entire addSubtask forms a single undo step", () => {
    issue.addSubtask("fixing_task", "user1");

    tracker.undo();

    expect(tracker.canUndo).toBe(false);
  });

  it("undoing addSubtask reverts the subtask push", () => {
    issue.addSubtask("fixing_task", "user1");

    tracker.undo();

    expect(issue.actions.subtasks).toHaveLength(0);
  });

  it("undoing addSubtask reverts state to root_cause_analysis", () => {
    issue.addSubtask("fixing_task", "user1");

    tracker.undo();

    expect(issue.state).toBe("root_cause_analysis");
  });

  it("undoing addSubtask reverts backward and forward transition fields", () => {
    issue.addSubtask("fixing_task", "user1");

    tracker.undo();

    expect(issue.backwardField).toBe("initial");
    expect(issue.forwardField).toBeNull();
  });

  it("redoing addSubtask restores all changes", () => {
    issue.addSubtask("fixing_task", "user1");
    tracker.undo();
    tracker.redo();

    expect(issue.actions.subtasks).toHaveLength(1);
    expect(issue.state).toBe("fix_in_progress");
    expect(tracker.canRedo).toBe(false);
  });
});

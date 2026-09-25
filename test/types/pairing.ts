// Compile-time contract between trackers and model classes.
// Checked by test/TypeContract.test.ts: every `@ts-expect-error` below must
// match a real type error, and nothing else may fail to compile.
import { DirtyTracker } from "../../src/DirtyTracker";
import { EventTracker } from "../../src/EventTracker";
import { TrackedObject } from "../../src/TrackedObject";
import { DirtyTrackedObject } from "../../src/DirtyTrackedObject";
import { TrackedContainer } from "../../src/TrackedContainer";
import { DirtyTrackedContainer } from "../../src/DirtyTrackedContainer";
import { EventTrackedCollection } from "../../src/EventTrackedCollection";
import { TrackedCollection } from "../../src/TrackedCollection";
import { EventTracked } from "../../src/EventTracked";
import { Tracked } from "../../src/Tracked";
import { State } from "../../src/State";

declare const events: EventTracker;
declare const dirty: DirtyTracker;

class EventModel extends TrackedObject {
  @EventTracked() accessor title: string = "";
  constructor(t: EventTracker) { super(t); }
}

class DirtyModel extends DirtyTrackedObject {
  @Tracked() accessor title: string = "";
  constructor(t: DirtyTracker) { super(t); }
}

// ---- event_tracker_rejects_dirty_object_type / dirty_tracker_accepts_only_dirty_objects

// @ts-expect-error — an EventTracker model cannot be given a DirtyTracker
new EventModel(dirty);
// @ts-expect-error — a DirtyTracker model cannot be given an EventTracker
new DirtyModel(events);

export class WrongBaseForDirty extends TrackedObject {
  constructor(t: DirtyTracker) {
    // @ts-expect-error — TrackedObject only accepts an EventTracker
    super(t);
  }
}

export class WrongBaseForEvents extends DirtyTrackedObject {
  constructor(t: EventTracker) {
    // @ts-expect-error — DirtyTrackedObject only accepts a DirtyTracker
    super(t);
  }
}

export class WrongContainer extends DirtyTrackedContainer {
  constructor(t: DirtyTracker, other: EventModel) {
    super(t);
    // @ts-expect-error — a dirty container only tracks dirty children
    this.trackChild(other);
    this.trackChild(new TrackedCollection<string>(t));
  }
}

export class EventContainer extends TrackedContainer {
  constructor(t: EventTracker) {
    super(t);
    this.trackChild(new EventTrackedCollection<EventModel>(t));
  }
}

// @ts-expect-error — EventTrackedCollection belongs to an EventTracker
new EventTrackedCollection<DirtyModel>(dirty);

export class EventDecoratorOnDirtyModel extends DirtyTrackedObject {
  // @ts-expect-error — @EventTracked is for EventTracker models
  @EventTracked()
  accessor title: string = "";
  constructor(t: DirtyTracker) { super(t); }
}

// ---- event_tracker_tracked_object_has_no_state_api

const eventModel = events.trackedObjects[0];
// @ts-expect-error — no object state on an EventTracker model
eventModel.trakrState;
// @ts-expect-error
eventModel.isDirty;
// @ts-expect-error
eventModel.dirtyCounter;
// @ts-expect-error — EventTracker has no deletedObjects
events.deletedObjects;
// @ts-expect-error — nor do its sessions
events.startSession().deletedObjects;

// ---- the DirtyTracker side keeps the full state API, with precise types

const dirtyModel: DirtyTrackedObject = dirty.trackedObjects[0];
const state: State = dirtyModel.trakrState;
const counter: number = dirtyModel.dirtyCounter;
const deleted: DirtyTrackedObject[] = dirty.deletedObjects;
const scopedDeleted: DirtyTrackedObject[] = dirty.startSession().deletedObjects;
const found: DirtyTrackedObject | undefined = dirty.getByTrackingId(1);
const foundEvent: TrackedObject | undefined = events.getByTrackingId(1);

export { state, counter, deleted, scopedDeleted, found, foundEvent };

// Compile-time contract between trackers and model classes.
// Checked by test/TypeContract.test.ts: every `@ts-expect-error` below must
// match a real type error, and nothing else may fail to compile.
import { UnitOfWork } from "../../packages/unit-of-work/src/UnitOfWork";
import { EventLog } from "../../packages/event-log/src/EventLog";
import { TrackedObject } from "../../packages/event-log/src/TrackedObject";
import { Entity } from "../../packages/unit-of-work/src/Entity";
import { TrackedContainer } from "../../packages/event-log/src/TrackedContainer";
import { EntityContainer } from "../../packages/unit-of-work/src/EntityContainer";
import { EventTrackedCollection } from "../../packages/event-log/src/EventTrackedCollection";
import { TrackedCollection } from "../../packages/core/src/TrackedCollection";
import { EventTracked } from "../../packages/event-log/src/EventTracked";
import { Tracked } from "../../packages/core/src/Tracked";
import { State } from "../../packages/unit-of-work/src/State";
import { Tracker } from "../../packages/core/src/Tracker";

declare const events: EventLog;
declare const dirty: UnitOfWork;

class EventModel extends TrackedObject {
  @EventTracked() accessor title: string = "";
  constructor(t: EventLog) { super(t); }
}

class DirtyModel extends Entity {
  @Tracked() accessor title: string = "";
  constructor(t: UnitOfWork) { super(t); }
}

// ---- event_tracker_rejects_dirty_object_type / dirty_tracker_accepts_only_dirty_objects

// @ts-expect-error — an EventLog model cannot be given a UnitOfWork
new EventModel(dirty);
// @ts-expect-error — a UnitOfWork model cannot be given an EventLog
new DirtyModel(events);

export class WrongBaseForDirty extends TrackedObject {
  constructor(t: UnitOfWork) {
    // @ts-expect-error — TrackedObject only accepts an EventLog
    super(t);
  }
}

export class WrongBaseForEvents extends Entity {
  constructor(t: EventLog) {
    // @ts-expect-error — Entity only accepts a UnitOfWork
    super(t);
  }
}

export class WrongContainer extends EntityContainer {
  constructor(t: UnitOfWork, other: EventModel) {
    super(t);
    // @ts-expect-error — a dirty container only tracks dirty children
    this.trackChild(other);
    this.trackChild(new TrackedCollection<string>(t));
  }
}

export class EventContainer extends TrackedContainer {
  constructor(t: EventLog) {
    super(t);
    this.trackChild(new EventTrackedCollection<EventModel>(t, "models"));
  }
}

// @ts-expect-error — EventTrackedCollection belongs to an EventLog
new EventTrackedCollection<DirtyModel>(dirty);

export class EventDecoratorOnDirtyModel extends Entity {
  // @ts-expect-error — @EventTracked is for EventLog models
  @EventTracked()
  accessor title: string = "";
  constructor(t: UnitOfWork) { super(t); }
}

// ---- plain @Tracked and TrackedCollection produce no events: not on an EventLog

export class PlainTrackedOnEventModel extends TrackedObject {
  // @ts-expect-error — EventLog models use @EventTracked
  @Tracked() accessor title: string = "";
  constructor(t: EventLog) { super(t); }
}
// @ts-expect-error — an EventLog's collections are EventTrackedCollections
new TrackedCollection<string>(events);

// ---- an object a TrackedContainer tracks is a part of it: it needs its name in the payload
export class UnnamedPart extends TrackedContainer {
  constructor(t: EventLog, part: EventModel) {
    super(t);
    // @ts-expect-error — trackChild(object, name)
    this.trackChild(part);
  }
}

// ---- Tracker is abstract: instantiate UnitOfWork or EventLog
// @ts-expect-error — cannot create an instance of an abstract class
new Tracker();

// ---- event_tracker_tracked_object_has_no_state_api

const eventModel = events._trackedObjects[0];
// @ts-expect-error — no object state on an EventLog model
eventModel.chronicleState;
// @ts-expect-error
eventModel.isDirty;
// @ts-expect-error
eventModel.dirtyCounter;
// @ts-expect-error — EventLog has no deletedObjects
events.deletedObjects;
// @ts-expect-error — nor do its sessions
events._startSession().deletedObjects;

// ---- the UnitOfWork side keeps the full state API, with precise types

const dirtyModel: Entity = dirty._trackedObjects[0];
const state: State = dirtyModel.chronicleState;
const counter: number = dirtyModel.dirtyCounter;
const scopedDeleted: Entity[] = dirty._startSession().deletedObjects;
const committed: Promise<boolean> = dirty.commit(async ({ inserted, changed, deleted }) => {
  const all: Entity[] = [...inserted, ...changed, ...deleted];
  return all.map((o) => ({ chronicleId: o.chronicleId, value: 1 }));
});
// @ts-expect-error — the save function returns ids, not arbitrary values
dirty.commit(() => [{ id: 1 }]);

export { state, counter, scopedDeleted, committed };

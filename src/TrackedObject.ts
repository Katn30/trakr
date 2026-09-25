import type { EventTracker } from "./EventTracker";
import { TrackedObjectBase } from "./TrackedObjectBase";

export type { TrackedPropertyChanged } from "./TrackedObjectBase";

/**
 * Base class for models tracked by an {@link EventTracker}. It carries no
 * object state (`trakrState`, `dirtyCounter`): what is pending is the
 * tracker's event list. Models for a `DirtyTracker` extend `DirtyTrackedObject`.
 */
export abstract class TrackedObject extends TrackedObjectBase {
  declare public readonly tracker: EventTracker;

  public constructor(tracker: EventTracker) {
    super(tracker);
  }
}

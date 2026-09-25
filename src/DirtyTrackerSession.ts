import { TrackerSession } from "./TrackerSession";
import { DirtyTrackedObject } from "./DirtyTrackedObject";
import { State } from "./State";

/** A {@link TrackerSession} of a `DirtyTracker`, which also reports scoped deletions. */
export class DirtyTrackerSession extends TrackerSession {
  /** Scoped objects in `Deleted` state. */
  get deletedObjects(): DirtyTrackedObject[] {
    return (this.trackedObjects as DirtyTrackedObject[]).filter((obj) => obj.trakrState === State.Deleted);
  }
}

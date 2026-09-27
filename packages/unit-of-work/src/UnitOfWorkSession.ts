import { TrackerSession } from "@katn30/chronicle-core";
import { Entity } from "./Entity";
import { State } from "./State";

/** A {@link TrackerSession} of a `UnitOfWork`, which also reports scoped deletions. */
export class UnitOfWorkSession extends TrackerSession<Entity> {
  /** Scoped objects in `Deleted` state. */
  get deletedObjects(): Entity[] {
    return this.trackedObjects.filter((obj) => obj.chronicleState === State.Deleted);
  }
}

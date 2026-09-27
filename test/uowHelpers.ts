import type { UnitOfWork } from "../packages/unit-of-work/src/UnitOfWork";
import type { Entity } from "../packages/unit-of-work/src/Entity";
import { State } from "../packages/unit-of-work/src/State";

/** The objects the next commit would delete. */
export function deletedObjects(tracker: UnitOfWork): Entity[] {
  return tracker._trackedObjects.filter((o) => o.chronicleState === State.Deleted);
}

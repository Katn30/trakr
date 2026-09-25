import type { TrackedObjectBase } from "./TrackedObjectBase";
import { TypedEvent } from "./TypedEvent";

export interface ITrackerContext {
  isDirty: boolean;
  isValid: boolean;
  canCommit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  trackedObjects: TrackedObjectBase[];
  undo(): void;
  redo(): void;
  isDirtyChanged: TypedEvent<boolean>;
  canCommitChanged: TypedEvent<boolean>;
  versionChanged: TypedEvent<number>;
}

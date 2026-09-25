import { TrackedObject } from "./TrackedObject";
import { TypedEvent } from "./TypedEvent";

export interface ITrackerContext {
  isDirty: boolean;
  isValid: boolean;
  canCommit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  trackedObjects: TrackedObject[];
  undo(): void;
  redo(): void;
  isDirtyChanged: TypedEvent<boolean>;
  canCommitChanged: TypedEvent<boolean>;
  versionChanged: TypedEvent<number>;
}

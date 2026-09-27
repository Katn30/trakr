import { TypedEvent } from "./TypedEvent";

export interface ITrackerContext {
  isDirty: boolean;
  isValid: boolean;
  canCommit: boolean;
  canUndo: boolean;
  canRedo: boolean;
  undo(): void;
  redo(): void;
  isDirtyChanged: TypedEvent<boolean>;
  canCommitChanged: TypedEvent<boolean>;
  changed: TypedEvent<{ version: number }>;
}

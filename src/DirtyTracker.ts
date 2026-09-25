import { Tracker } from "./Tracker";
import { Operation } from "./Operation";
import { CollectionUtilities } from "./CollectionUtilities";
import { IdAssignment } from "./ExternallyAssigned";
import { State } from "./State";
import { ITracked } from "./ITracked";
import { TrackedObject } from "./TrackedObject";

/**
 * Batch-state tracker for Save-button workflows. Object state is the truth:
 * mutations mark objects Insert/Changed/Deleted, `isDirty`/`canCommit` gate the
 * save, and `onCommit()` atomically transitions everything to Unchanged.
 * Undo can cross a commit boundary — undoing a committed change marks the
 * object dirty again so the next save persists the reversal.
 */
export class DirtyTracker extends Tracker {
  /** @internal */
  public readonly _tracksObjectState = true;

  public get deletedObjects(): TrackedObject[] {
    return this.trackedObjects.filter(obj => obj.trakrState === State.Deleted);
  }

  protected _computeIsDirty(): boolean {
    return CollectionUtilities.getLast(this._undoOperations) !== this._commitStateOperation;
  }

  public onCommit<V = number>(keys?: IdAssignment<V>[]): void {
    const globalLastOp = CollectionUtilities.getLast(this._undoOperations);
    this.trackedObjects.forEach((obj) => {
      const op = this.findLastOpTouching(obj);
      obj._onCommitted(op, keys as IdAssignment<unknown>[] | undefined);
    });
    this._commitStateOperation = globalLastOp;
    this.reset();
  }

  private findLastOpTouching(obj: ITracked): Operation | undefined {
    for (let i = this._undoOperations.length - 1; i >= 0; i--) {
      const op = this._undoOperations[i];
      for (const action of op.actions) {
        if (action.properties.trackedObject === obj) return op;
      }
    }
    return undefined;
  }
}

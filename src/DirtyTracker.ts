import { Tracker } from "./Tracker";
import { Operation } from "./Operation";
import { CollectionUtilities } from "./CollectionUtilities";
import { IdAssignment } from "./ExternallyAssigned";
import { State } from "./State";
import { ITracked } from "./ITracked";
import { TrackedObjectBase } from "./TrackedObjectBase";
import { DirtyTrackedObject } from "./DirtyTrackedObject";
import { DirtyTrackerSession } from "./DirtyTrackerSession";
import { PropertyScope } from "./TrackerSession";

/**
 * Batch-state tracker for Save-button workflows. Object state is the truth:
 * mutations mark objects Insert/Changed/Deleted, `isDirty`/`canCommit` gate the
 * save, and `onCommit()` atomically transitions everything to Unchanged.
 * Undo can cross a commit boundary — undoing a committed change marks the
 * object dirty again so the next save persists the reversal.
 */
export class DirtyTracker extends Tracker {
  declare public readonly trackedObjects: DirtyTrackedObject[];

  public get deletedObjects(): DirtyTrackedObject[] {
    return this.trackedObjects.filter(obj => obj.trakrState === State.Deleted);
  }

  /** @internal */
  public _assertAccepts(obj: TrackedObjectBase): void {
    if (!(obj instanceof DirtyTrackedObject)) {
      throw new TypeError(
        `${obj.constructor.name} cannot be tracked by a DirtyTracker: its models extend ` +
        "DirtyTrackedObject (or DirtyTrackedContainer). TrackedObject models belong to an EventTracker.",
      );
    }
  }

  public override getByTrackingId(trackingId: number): DirtyTrackedObject | undefined {
    return super.getByTrackingId(trackingId) as DirtyTrackedObject | undefined;
  }

  public override startSession(scope?: PropertyScope[]): DirtyTrackerSession {
    return super.startSession(scope) as DirtyTrackerSession;
  }

  protected override _createSession(scope: PropertyScope[] | undefined, end: () => void, rollback: () => void): DirtyTrackerSession {
    return new DirtyTrackerSession(scope, this, end, rollback);
  }

  /** Objects built by `tracker.new()` start clean: their constructor writes are not edits. */
  protected override _onNewCompleted(created: readonly TrackedObjectBase[]): void {
    for (const obj of created as readonly DirtyTrackedObject[]) {
      obj._setDirtyCounter(0);
      if (obj.trakrState === State.Changed) obj._setState(State.Unchanged);
    }
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

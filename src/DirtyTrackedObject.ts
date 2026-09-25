import type { DirtyTracker } from "./DirtyTracker";
import { TrackedObjectBase } from "./TrackedObjectBase";
import { State } from "./State";
import { Operation } from "./Operation";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { IdAssignment, getAutoIdProperty } from "./ExternallyAssigned";
import { DependencyTracker } from "./DependencyTracker";
import { StateTarget, applyStateTransition, buildCommittedContext } from "./TrackedObjectStateMachine";

/**
 * Base class for models tracked by a {@link DirtyTracker}. Adds batch-save
 * state: `trakrState` (`Insert` / `Changed` / `Deleted` / `Unchanged`),
 * `dirtyCounter` and `isDirty`, maintained by the state machine.
 */
export abstract class DirtyTrackedObject extends TrackedObjectBase implements StateTarget {
  declare public readonly tracker: DirtyTracker;

  private _dirtyCounter: number = 0;
  private _state: State = State.Unchanged;

  public constructor(tracker: DirtyTracker) {
    super(tracker);
  }

  /** What the save layer has to do with this object. */
  public get trakrState(): State {
    return this._state;
  }

  /** Net count of uncommitted writes: +1 per write, −1 per undo, reset by `onCommit()`. */
  public get dirtyCounter(): number {
    return this._dirtyCounter;
  }

  public get isDirty(): boolean {
    return this._dirtyCounter !== 0;
  }

  /** @internal */
  _setState(value: State): void {
    this._state = value;
  }

  /** @internal */
  _setDirtyCounter(value: number): void {
    this._dirtyCounter = value;
  }

  /** @internal */
  override _onTrackedWrite(): void {
    this._dirtyCounter++;
    if (this._state === State.Unchanged) this._state = State.Changed;
  }

  /** @internal */
  override _onTrackedWriteUndone(): void {
    this._dirtyCounter--;
    if (this._dirtyCounter === 0 && this._state === State.Changed) this._state = State.Unchanged;
  }

  /** @internal */
  public _onCommitted(lastOp?: Operation, keys?: IdAssignment<unknown>[]): void {
    const autoIdProp = getAutoIdProperty(Object.getPrototypeOf(this));
    const context = buildCommittedContext(this, autoIdProp, keys);

    const redoFn = () => applyStateTransition(this, "committed", "do", context);
    const undoFn = () => applyStateTransition(this, "committed", "undo", context);

    if (lastOp) {
      lastOp.updateOrAdd(redoFn, undoFn, new OperationProperties(this, "__state__", PropertyType.Object));
    }
    redoFn();
  }

  /** @internal */
  override _markRemoved(): void {
    const prevState = this._state;
    const prevDirtyCounter = this._dirtyCounter;
    const wasValid = this.trakrIsValid;
    const collapseInsert = prevState === State.Insert;

    this.tracker._doAndTrack(
      () => {
        applyStateTransition(this, "removed", "do");
        if (collapseInsert) {
          DependencyTracker.clearDeps(this);
          this.tracker._untrackObject(this);
        } else if (!wasValid) {
          this.tracker._onValidityChanged(false);
        }
      },
      () => {
        if (collapseInsert) {
          this.tracker._trackObject(this);
          if (!wasValid) this.tracker._onValidityChanged(true);
        } else if (!wasValid) {
          this.tracker._onValidityChanged(true);
        }
        applyStateTransition(this, "removed", "undo", { prevState, prevDirtyCounter });
      },
      new OperationProperties(this, "__state__", PropertyType.Object)
    );
  }

  /** @internal */
  override _markAdded(): void {
    if (this._state !== State.Unchanged) return;
    if (this.tracker._isTrackingSuppressed) return;
    const wasValid = this.trakrIsValid;
    this.tracker._doAndTrack(
      () => {
        if (this.tracker.trackedObjects.indexOf(this) === -1) {
          this.tracker._trackObject(this);
          if (!wasValid) this.tracker._onValidityChanged(true);
        }
        applyStateTransition(this, "added", "do");
      },
      () => {
        this.tracker._untrackObject(this);
        applyStateTransition(this, "added", "undo");
      },
      new OperationProperties(this, "__state__", PropertyType.Object)
    );
  }
}

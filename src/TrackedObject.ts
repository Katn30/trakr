import { Tracker } from "./Tracker";
import { State } from "./State";
import { TypedEvent } from "./TypedEvent";
import { Operation } from "./Operation";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { IdAssignment, getAutoIdProperty } from "./ExternallyAssigned";
import { DependencyTracker } from "./DependencyTracker";
import { ITracked } from "./ITracked";
import { StateTarget, applyStateTransition, buildCommittedContext } from "./TrackedObjectStateMachine";

export interface TrackedPropertyChanged {
  property: string;
  oldValue: unknown;
  newValue: unknown;
}

export abstract class TrackedObject implements ITracked, StateTarget {
  private _dirtyCounter: number = 0;
  private _validationMessages: Map<string, string | undefined> | undefined;
  private _isValid: boolean = true;
  private _state: State = State.Unchanged;

  public readonly trakrId: number;

  public readonly changed: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();
  public readonly trackedChanged: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();

  // ---- StateTarget interface (internal) ----

  /** @internal */
  get trakrState(): State {
    return this._state;
  }

  /** @internal */
  _setState(value: State): void {
    this._state = value;
  }

  /** @internal */
  _getDirtyCounter(): number {
    return this._dirtyCounter;
  }

  /** @internal */
  _setDirtyCounter(value: number): void {
    this._dirtyCounter = value;
  }

  // ---- Public API ----

  public get validationMessages(): Map<string, string | undefined> {
    return this._validationMessages ?? new Map<string, string>();
  }
  private set validationMessages(value: Map<string, string | undefined>) {
    this._validationMessages = value;
  }

  public get trakrIsValid(): boolean {
    return this._isValid;
  }
  protected _setIsValid(value: boolean): void {
    const wasValid = this._isValid;
    this._isValid = value;
    if (wasValid !== value) {
      this.tracker._onValidityChanged(wasValid, value);
    }
  }
  protected set trakrIsValid(value: boolean) {
    this._setIsValid(value);
  }

  public get isDirty(): boolean {
    return this._dirtyCounter !== 0;
  }

  public get dirtyCounter(): number {
    return this._dirtyCounter;
  }
  protected set dirtyCounter(value: number) {
    this._dirtyCounter = value;
  }

  public constructor(public readonly tracker: Tracker) {
    if (process.env.NODE_ENV !== 'production' && !tracker._isConstructing) {
      throw new Error(`${this.constructor.name} must be created inside tracker.construct()`);
    }
    this.trakrId = tracker._nextTrackingId();
    this.validationMessages = new Map<string, string>();
    tracker._trackObject(this);
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
  public _markRemoved(): void {
    const prevState = this._state;
    const prevDirtyCounter = this._dirtyCounter;
    const wasValid = this._isValid;
    const collapseInsert = prevState === State.Insert;

    this.tracker._doAndTrack(
      () => {
        applyStateTransition(this, "removed", "do");
        if (collapseInsert) {
          DependencyTracker.clearDeps(this);
          this.tracker._untrackObject(this);
        }
      },
      () => {
        if (collapseInsert) {
          this.tracker._trackObject(this);
          if (!wasValid) this.tracker._onValidityChanged(true, false);
        }
        applyStateTransition(this, "removed", "undo", { prevState, prevDirtyCounter });
      },
      new OperationProperties(this, "__state__", PropertyType.Object)
    );
  }

  /** @internal */
  public _markAdded(): void {
    if (this._state !== State.Unchanged) return;
    if (this.tracker._isTrackingSuppressed) return;
    const wasValid = this._isValid;
    this.tracker._doAndTrack(
      () => {
        if (this.tracker.trackedObjects.indexOf(this) === -1) {
          this.tracker._trackObject(this);
          if (!wasValid) this.tracker._onValidityChanged(true, false);
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

  /** @internal */
  _validate(property: string, errorMessage: string | undefined): void {
    if (errorMessage) {
      this.validationMessages.set(property, errorMessage);
    } else {
      this.validationMessages.delete(property);
    }
    this.validationMessages = new Map(this.validationMessages);
    this.trakrIsValid = this.validationMessages.size === 0;
  }

  /** @internal */
  public _applyValidation(messages: Map<string, string>): void {
    this.validationMessages = messages;
    this.trakrIsValid = messages.size === 0;
  }

  public destroy(): void {
    DependencyTracker.clearDeps(this);
    this.tracker._untrackObject(this);
  }
}

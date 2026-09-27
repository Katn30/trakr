import type { Tracker } from "./Tracker";
import { TypedEvent } from "./TypedEvent";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { DependencyTracker } from "./DependencyTracker";
import { ITracked } from "./ITracked";

export interface TrackedPropertyChanged {
  property: string;
  oldValue: unknown;
  newValue: unknown;
}

/**
 * What every tracked model has, whichever tracker it belongs to: change
 * events, validation and a stable `chronicleId`. Models extend one of its two
 * subclasses — {@link TrackedObject} for an `EventLog`, or
 * `Entity` for a `UnitOfWork`.
 */
export abstract class TrackedObjectBase implements ITracked {
  private _validationMessages: Map<string, string | undefined> = new Map();
  private _isValid: boolean = true;
  private _validityReleased: boolean = false;

  public readonly chronicleId: number;

  /**
   * A user write, right after the value is set: the place for cascading writes,
   * which compose into the same undo step. Never fires during undo or redo.
   */
  public readonly beforeChange: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();

  /**
   * Every change of a tracked property — user writes, undo and redo — once the
   * value is in place: the event to refresh views from. Don't write from it:
   * during undo and redo those writes would not be recorded.
   */
  public readonly changed: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();

  /**
   * A user write, after `changed`. Like `beforeChange`, never fires during undo
   * or redo, and its writes compose into the same undo step.
   */
  public readonly afterChange: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();

  public get validationMessages(): Map<string, string | undefined> {
    return this._validationMessages;
  }
  private set validationMessages(value: Map<string, string | undefined>) {
    this._validationMessages = value;
  }

  public get chronicleIsValid(): boolean {
    return this._isValid;
  }
  protected set chronicleIsValid(value: boolean) {
    this._setIsValid(value);
  }

  /**
   * @internal True while this object sits outside its collection on an
   * EventLog: its validity no longer counts towards `tracker.isValid`.
   */
  get _isValidityReleased(): boolean {
    return this._validityReleased;
  }

  protected _setIsValid(value: boolean): void {
    const wasValid = this._isValid;
    this._isValid = value;
    if (wasValid !== value && !this._validityReleased) {
      this.tracker._onValidityChanged(!value);
    }
  }

  protected constructor(public readonly tracker: Tracker) {
    if (process.env.NODE_ENV !== 'production' && !tracker._isConstructing) {
      throw new Error(`${this.constructor.name} must be created inside tracker.construct() or tracker.new()`);
    }
    this.chronicleId = tracker._nextChronicleId();
    tracker._trackObject(this);
  }

  // ---- Lifecycle hooks, overridden by Entity with its state machine ----

  /** @internal A tracked property of this object was written. */
  _onTrackedWrite(): void {}

  /** @internal That write was undone. */
  _onTrackedWriteUndone(): void {}

  /**
   * @internal Whether this object's validity counts towards `tracker.isValid`.
   * An object out of the model — removed, or inside a removed container —
   * stays registered (undo may bring it back) but does not count until it returns.
   * Recorded as part of the current operation, so undo/redo restore it.
   */
  _setValidityReleased(released: boolean): void {
    if (this._validityReleased === released) return;
    const apply = (r: boolean) => {
      if (!this._isValid) this.tracker._onValidityChanged(!r);
      this._validityReleased = r;
    };
    this.tracker._doAndTrack(
      () => apply(released),
      () => apply(!released),
      new OperationProperties(this, "__validity__", PropertyType.Object),
    );
  }

  /** @internal Whether this object's own validators pass — without any children. */
  get _isOwnValid(): boolean {
    return this._isValid;
  }

  /** @internal This object left a collection (or a tracked property). */
  abstract _markRemoved(): void;

  /** @internal This object was added to a collection (or a tracked property). */
  abstract _markAdded(): void;

  /** @internal */
  _validate(property: string, errorMessage: string | undefined): void {
    if (errorMessage) {
      this.validationMessages.set(property, errorMessage);
    } else {
      this.validationMessages.delete(property);
    }
    this.validationMessages = new Map(this.validationMessages);
    this.chronicleIsValid = this.validationMessages.size === 0;
  }

  /** @internal A model's validators run per property (see the Registry): nothing to do as a whole. */
  _revalidateSelf(_property: string | undefined): void {}

  /** @internal */
  public _applyValidation(messages: Map<string, string>): void {
    this.validationMessages = messages;
    this.chronicleIsValid = messages.size === 0;
  }

  /**
   * Forgets this object for good: it leaves the tracker and no longer counts
   * towards validity. Not undoable — for objects that never became part of the
   * model (e.g. a draft discarded before it was added anywhere). To delete an
   * item, remove it from its collection or clear the property instead.
   */
  public destroy(): void {
    DependencyTracker.clearDeps(this);
    this.tracker._untrackObject(this);
    // Gone for good: later changes to it do not count towards isValid.
    this._validityReleased = true;
    this.tracker._onObjectDestroyed(this);
  }
}

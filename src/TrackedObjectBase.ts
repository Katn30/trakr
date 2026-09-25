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
 * events, validation and a stable `trakrId`. Models extend one of its two
 * subclasses — {@link TrackedObject} for an `EventTracker`, or
 * `DirtyTrackedObject` for a `DirtyTracker`.
 */
export abstract class TrackedObjectBase implements ITracked {
  private _validationMessages: Map<string, string | undefined> = new Map();
  private _isValid: boolean = true;
  private _validityReleased: boolean = false;

  public readonly trakrId: number;

  public readonly beforeChange: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();
  public readonly afterChange: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();
  public readonly trackedChanged: TypedEvent<TrackedPropertyChanged> = new TypedEvent<TrackedPropertyChanged>();

  /** Alias for {@link afterChange}. Retained for backwards compatibility. */
  public get changed(): TypedEvent<TrackedPropertyChanged> {
    return this.afterChange;
  }

  public get validationMessages(): Map<string, string | undefined> {
    return this._validationMessages;
  }
  private set validationMessages(value: Map<string, string | undefined>) {
    this._validationMessages = value;
  }

  public get trakrIsValid(): boolean {
    return this._isValid;
  }
  protected set trakrIsValid(value: boolean) {
    this._setIsValid(value);
  }

  /**
   * @internal True while this object sits outside its collection on an
   * EventTracker: its validity no longer counts towards `tracker.isValid`.
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
      throw new Error(`${this.constructor.name} must be created inside tracker.construct()`);
    }
    tracker._assertAccepts(this);
    this.trakrId = tracker._nextTrackingId();
    tracker._trackObject(this);
  }

  // ---- Lifecycle hooks, overridden by DirtyTrackedObject with its state machine ----

  /** @internal A tracked property of this object was written. */
  _onTrackedWrite(): void {}

  /** @internal That write was undone. */
  _onTrackedWriteUndone(): void {}

  /**
   * @internal This object left a collection (or a tracked property). It stays
   * registered — undo or a re-add may bring it back — but stops counting
   * towards `tracker.isValid` until it does.
   */
  _markRemoved(): void {
    if (this._validityReleased) return;
    const setReleased = (released: boolean) => {
      if (!this._isValid) this.tracker._onValidityChanged(!released);
      this._validityReleased = released;
    };
    this.tracker._doAndTrack(
      () => setReleased(true),
      () => setReleased(false),
      new OperationProperties(this, "__state__", PropertyType.Object),
    );
  }

  /** @internal This object was added to a collection (or a tracked property). */
  _markAdded(): void {
    if (!this._validityReleased) return;
    const setReleased = (released: boolean) => {
      this._validityReleased = released;
      if (!this._isValid) this.tracker._onValidityChanged(!released);
    };
    this.tracker._doAndTrack(
      () => setReleased(false),
      () => setReleased(true),
      new OperationProperties(this, "__state__", PropertyType.Object),
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

import { TypedEvent } from "./TypedEvent";
import { Operation } from "./Operation";
import { TrackedCollection } from "./TrackedCollection";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { CollectionUtilities } from "./CollectionUtilities";
import { State } from "./State";
import { validate, validateSingleProperty } from "./Registry";
import { DependencyTracker, COLLECTION_VERSION_KEY } from "./DependencyTracker";
import { ITracked } from "./ITracked";
import { TrackedObject } from "./TrackedObject";
import { TrackerSession, PropertyScope } from "./TrackerSession";
import { ITrackerContext } from "./ITrackerContext";

/**
 * Shared core of every tracker: reactive change events, validation, sessions and
 * the undo/redo operation stack. Persistence semantics live in the subclasses:
 * {@link DirtyTracker} (batch commit of object state) and {@link EventTracker}
 * (stream of events acknowledged by the server). Cannot be instantiated directly.
 */
export abstract class Tracker implements ITrackerContext {
  private _currentOperation: Operation | undefined;
  protected readonly _redoOperations: Operation[];
  protected readonly _undoOperations: Operation[];
  protected _commitStateOperation: Operation | undefined;
  private _isDirty: boolean;
  private _canUndo: boolean;
  private _canRedo: boolean;
  private _suppressTrackingCounter = 0;
  private _currentOperationOwner: ITracked | undefined;
  private _currentOperationPropertyName: string | undefined;
  private _isValid: boolean;
  private _canCommit: boolean;
  private _trackingIdCounter = 1;
  private _invalidCount = 0;
  private _constructionDepth = 0;
  private _composingBaseIndex: number | undefined;
  private _composingRedoLength: number | undefined;
  private _currentSession: TrackerSession | undefined;
  protected _version: number = 0;
  public _isReplaying: boolean = false;
  private _pendingRevalidations: Array<{ obj: ITracked; prop: string | undefined }> = [];

  public readonly trackedObjects: TrackedObject[] = [];

  public readonly trackedCollections: TrackedCollection<any>[] = [];

  public get isDirty(): boolean {
    return this._isDirty;
  }
  public set isDirty(value: boolean) {
    if (this._isDirty !== value) {
      this._isDirty = value;
      this.isDirtyChanged.emit(value);
      this.updateCanCommit();
    }
  }

  public readonly isDirtyChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  public get version(): number {
    return this._version;
  }

  public readonly versionChanged: TypedEvent<number> = new TypedEvent<number>();

  public get isValid(): boolean {
    return this._isValid;
  }
  private set isValid(value: boolean) {
    if (this._isValid !== value) {
      this._isValid = value;
      this.isValidChanged.emit(value);
      this.updateCanCommit();
    }
  }

  public readonly isValidChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  public get canCommit(): boolean {
    return this._canCommit;
  }
  private set canCommit(value: boolean) {
    if (this._canCommit !== value) {
      this._canCommit = value;
      this.canCommitChanged.emit(value);
    }
  }

  public readonly canCommitChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  private updateCanCommit(): void {
    this.canCommit = this._isDirty && this._isValid;
  }

  public get canUndo(): boolean {
    return this._canUndo;
  }
  private set canUndo(value: boolean) {
    this._canUndo = value;
  }

  public get canRedo(): boolean {
    return this._canRedo;
  }
  private set canRedo(value: boolean) {
    this._canRedo = value;
  }

  /** @internal */
  public get _isTrackingSuppressed(): boolean {
    return this._suppressTrackingCounter > 0;
  }

  /** @internal */
  public get _isConstructing(): boolean {
    return this._constructionDepth > 0;
  }

  /**
   * @internal Whether tracked objects carry Insert/Changed/Deleted state.
   * True for DirtyTracker, false for EventTracker (whose pending changes are a
   * diff against the persisted baseline, not a per-object state).
   */
  public abstract readonly _tracksObjectState: boolean;

  /** Subclass-specific definition of "has unsaved work". */
  protected abstract _computeIsDirty(): boolean;

  // ---- Operation lifecycle hooks. No-ops here; EventTracker keeps its event list through them.

  /** A write is about to start (`extended` = it coalesces into the existing `op`). */
  protected _onOperationStart(_op: Operation, _extended: boolean): void {}
  /** A top-level write finished recording into `op`. */
  protected _onOperationEnd(_op: Operation): void {}
  /** `op` was just undone or redone. */
  protected _onReplayed(_op: Operation): void {}
  /** Undone operations were dropped from the redo stack and can never be redone. */
  protected _onOperationsDropped(_ops: readonly Operation[]): void {}
  /** `tracker.new()` finished constructing its objects. */
  protected _onNewCompleted(): void {}
  /** A session ended: `composed` became the single undo step `result`. */
  protected _onSessionEnded(_composed: readonly Operation[], _result: Operation): void {}
  /** A session was rolled back: `reverted` were undone and removed. */
  protected _onSessionRolledBack(_reverted: readonly Operation[]): void {}

  public constructor() {
    if (new.target === Tracker) {
      throw new Error("Tracker is abstract — instantiate DirtyTracker or EventTracker");
    }
    this._currentOperation = undefined;
    this._redoOperations = [];
    this._undoOperations = [];
    this._commitStateOperation = undefined;
    this._isDirty = false;
    this._canUndo = false;
    this._canRedo = false;
    this._suppressTrackingCounter = 0;
    this._currentOperationOwner = undefined;
    this._currentOperationPropertyName = undefined;
    this._isValid = true;
    this._canCommit = false;
  }

  /** @internal */
  public _trackObject(trackedObject: TrackedObject) {
    this.trackedObjects.push(trackedObject);
  }

  /** @internal */
  public _untrackObject(trackedObject: TrackedObject) {
    this.trackedObjects.splice(this.trackedObjects.indexOf(trackedObject), 1);
    if (!trackedObject.trakrIsValid && !trackedObject._isValidityReleased) this._invalidCount--;
    this.isValid = this._invalidCount === 0;
  }

  /** @internal */
  public _trackCollection(trackedCollection: TrackedCollection<any>): void {
    this.trackedCollections.push(trackedCollection);
  }

  /** @internal */
  public _untrackCollection(trackedCollection: TrackedCollection<any>) {
    this.trackedCollections.splice(
      this.trackedCollections.indexOf(trackedCollection),
      1,
    );
    if (!trackedCollection.trakrIsValid) this._invalidCount--;
    this.isValid = this._invalidCount === 0;
  }

  /** @internal */
  public _onValidityChanged(wasValid: boolean, isNowValid: boolean): void {
    if (wasValid && !isNowValid) this._invalidCount++;
    else if (!wasValid && isNowValid) this._invalidCount--;
    if (!this._isTrackingSuppressed) {
      this.isValid = this._invalidCount === 0;
    }
  }

  public construct<T>(action: () => T): T {
    const objectsBefore = this.trackedObjects.length;
    this._constructionDepth++;
    this._suppressTrackingCounter++;
    const result = action();
    for (let i = objectsBefore; i < this.trackedObjects.length; i++) {
      validate(this.trackedObjects[i]);
    }
    this._suppressTrackingCounter--;
    this._constructionDepth--;
    this.isValid = this._invalidCount === 0;
    return result;
  }

  public new<T>(action: () => T): T {
    const objectsBefore = this.trackedObjects.length;
    const undoLengthBefore = this._undoOperations.length;
    const savedRedo = [...this._redoOperations];
    this._constructionDepth++;
    const result = action();
    // changed events fire normally during construction so @EventTracked state is
    // populated for generateEvents(). Discard the undo entries and restore the
    // pre-new() redo stack so the tracker is clean on return.
    this._undoOperations.length = undoLengthBefore;
    this._redoOperations.length = 0;
    for (const op of savedRedo) this._redoOperations.push(op);
    for (let i = objectsBefore; i < this.trackedObjects.length; i++) {
      validate(this.trackedObjects[i]);
      this.trackedObjects[i]._setDirtyCounter(0);
      if (this.trackedObjects[i].trakrState === State.Changed) {
        this.trackedObjects[i]._setState(State.Unchanged);
      }
    }
    this._constructionDepth--;
    this.isValid = this._invalidCount === 0;
    this._onNewCompleted();
    this.reset();
    return result;
  }

  public withTrackingSuppressed(action: () => void): void {
    this._suppressTrackingCounter++;
    action();
    this._suppressTrackingCounter--;
  }

  public beginSuppressTracking(): void {
    this._suppressTrackingCounter++;
  }

  public endSuppressTracking(): void {
    this._suppressTrackingCounter--;
  }

  /** @internal */
  public _doAndTrack(
    redoAction: () => void,
    undoAction: () => void,
    properties: OperationProperties,
  ): void {
    if (this._isReplaying) return;

    if (this._isTrackingSuppressed) {
      redoAction();
      if (!this._isConstructing) {
        this.revalidateTargeted(properties.trackedObject, properties.property);
      }
      return;
    }

    const isInnerWrite = !this.isStartingNewOperation();

    if (!isInnerWrite) {
      this._currentOperationOwner = properties.trackedObject;
      this._currentOperationPropertyName = properties.property;

      if (this.shouldCoalesceChanges(properties)) {
        this._currentOperation = CollectionUtilities.getLast(this._undoOperations)!;
        this._onOperationStart(this._currentOperation, true);
        this._version++;
        this.versionChanged.emit(this._version);
      } else {
        this._currentOperation = new Operation();
        this._onOperationStart(this._currentOperation, false);
        this._undoOperations.push(this._currentOperation);
        this._onOperationsDropped(this._redoOperations.splice(0));
        this.reset();
        this._version++;
        this.versionChanged.emit(this._version);
      }
    }

    this._currentOperation?.add(
      () => redoAction(),
      () => undoAction(),
      properties,
    );
    redoAction();

    if (this._currentSession !== undefined &&
        properties.property !== undefined &&
        properties.trackedObject instanceof TrackedObject) {
      this._currentSession._onWrite(properties.trackedObject, properties.property);
    }

    if (this.isEndingCurrentOperation(properties)) {
      const finished = this._currentOperation!;
      this._currentOperation = undefined;
      this._currentOperationOwner = undefined;
      this._currentOperationPropertyName = undefined;
      const pending = this._pendingRevalidations;
      this._pendingRevalidations = [];
      for (const { obj, prop } of pending) {
        this.revalidateTargeted(obj, prop);
      }
      this.revalidateTargeted(properties.trackedObject, properties.property);
      this._onOperationEnd(finished);
      this.reset();
    } else {
      // Not the write that opened the operation, so necessarily an inner one.
      this._pendingRevalidations.push({ obj: properties.trackedObject, prop: properties.property });
    }
  }

  private revalidateTargeted(changedObj: ITracked, changedProp: string | undefined): void {
    const depKey = changedProp ?? COLLECTION_VERSION_KEY;
    const dependents = [...DependencyTracker.getDependents(changedObj, depKey)];
    for (const { obj, prop } of dependents) {
      const error = validateSingleProperty(obj, prop);
      obj._validate(prop, error);
    }
    if (changedProp === undefined) {
      (changedObj as unknown as TrackedCollection<any>)._validate();
    }
    this.isValid = this._invalidCount === 0;
  }

  private isEndingCurrentOperation(properties: OperationProperties) {
    return this._currentOperationOwner === properties.trackedObject &&
      this._currentOperationPropertyName === properties.property;
  }

  private isStartingNewOperation() {
    return this._currentOperationOwner === undefined &&
      this._currentOperationPropertyName === undefined;
  }

  private shouldCoalesceChanges(properties: OperationProperties): boolean {
    const lastOperation = CollectionUtilities.getLast(this._undoOperations);
    return (
      this.isCoalescibleType(properties) &&
      this.hasLastOperation(lastOperation) &&
      this.lastOperationTargetsSameProperty(lastOperation!, properties) &&
      this.lastActionIsRecent(lastOperation!, properties.coalesceWithin!)
    );
  }

  private isCoalescibleType(properties: OperationProperties): boolean {
    return (
      properties.coalesceWithin !== undefined &&
      (properties.type === PropertyType.String ||
        properties.type === PropertyType.Number)
    );
  }

  private hasLastOperation(lastOperation: Operation | undefined): boolean {
    return !!lastOperation;
  }

  private lastOperationTargetsSameProperty(lastOperation: Operation, properties: OperationProperties): boolean {
    return lastOperation.actions.every(
      (x) =>
        x.properties.trackedObject === properties.trackedObject &&
        x.properties.property === properties.property,
    );
  }

  private lastActionIsRecent(lastOperation: Operation, coalesceWithin: number): boolean {
    return (
      new Date().getTime() -
        CollectionUtilities.getLast(lastOperation.actions)!.time.getTime() <
        coalesceWithin
    );
  }

  /** @internal */
  public _nextTrackingId(): number {
    return this._trackingIdCounter++;
  }

  public discardPendingChanges(): void {
    const commitIdx = this._commitStateOperation !== undefined
      ? this._undoOperations.indexOf(this._commitStateOperation)
      : -1;
    const toRevert = this._undoOperations.splice(commitIdx + 1);

    this._undoOperations.length = 0;
    this._redoOperations.length = 0;
    this._commitStateOperation = undefined;

    if (toRevert.length > 0) {
      this.replay(() => {
        for (let i = toRevert.length - 1; i >= 0; i--) {
          toRevert[i].undo();
        }
      });
      this._version -= toRevert.length;
      this.versionChanged.emit(this._version);
    }

    this.reset();
    this.revalidate();
  }

  public getByTrackingId(trackingId: number): TrackedObject | undefined {
    return this.trackedObjects.find((o) => o.trakrId === trackingId);
  }

  /** @internal */
  public _isInUndoStack(op: Operation): boolean {
    return this._undoOperations.includes(op);
  }

  /** Runs `action` as a replay (undo/redo/rollback): tracking suppressed, no new ops recorded. */
  protected replay(action: () => void): void {
    this._isReplaying = true;
    try {
      this.withTrackingSuppressed(action);
    } finally {
      this._isReplaying = false;
    }
  }

  /**
   * @internal Chains a side-effect onto the action of the write identified by
   * `properties` in the operation currently being recorded, so it is undone and
   * redone right after that write.
   */
  public _recordSideEffect(
    redoAction: () => void,
    undoAction: () => void,
    properties: OperationProperties,
  ): void {
    // Only called from forward (non-replay, non-suppressed) writes, which always run inside an operation.
    this._currentOperation!.attachAfter(properties, redoAction, undoAction);
  }

  protected reset(): void {
    this.canUndo = this._undoOperations.length > 0;
    this.canRedo = this._redoOperations.length > 0;
    this.isDirty = this._computeIsDirty();
  }

  public startSession(scope?: PropertyScope[]): TrackerSession {
    if (this._currentSession !== undefined) return this._currentSession;
    this._composingBaseIndex = this._undoOperations.length;
    this._composingRedoLength = this._redoOperations.length;
    this._currentSession = new TrackerSession(
      scope,
      this,
      () => this.endComposing(),
      () => this.rollbackComposing(),
    );
    return this._currentSession;
  }

  private endComposing(): void {
    if (this._composingBaseIndex === undefined) return;
    this._currentSession = undefined;

    const composed = this._undoOperations.splice(this._composingBaseIndex);
    this._onOperationsDropped(this._redoOperations.splice(this._composingRedoLength!));
    this._composingBaseIndex = undefined;
    this._composingRedoLength = undefined;

    if (composed.length === 0) {
      this.reset();
      return;
    }

    let result = composed[0];
    if (composed.length > 1) {
      result = new Operation();
      for (const op of composed) {
        for (const action of op.actions) {
          result.add(action.redoAction, action.undoAction, action.properties);
        }
      }
    }
    this._undoOperations.push(result);
    this._onSessionEnded(composed, result);
    this.reset();
  }

  private rollbackComposing(): void {
    if (this._composingBaseIndex === undefined) return;
    this._currentSession = undefined;

    const toRevert = this._undoOperations.splice(this._composingBaseIndex);
    this._onOperationsDropped(this._redoOperations.splice(this._composingRedoLength!));
    this._composingBaseIndex = undefined;
    this._composingRedoLength = undefined;

    this.replay(() => {
      for (let i = toRevert.length - 1; i >= 0; i--) {
        toRevert[i].undo();
      }
    });
    this._onSessionRolledBack(toRevert);

    this.reset();
    this.revalidate();
    if (toRevert.length > 0) {
      this._version -= toRevert.length;
      this.versionChanged.emit(this._version);
    }
  }

  public undo(): void {
    if (!this.canUndo) {
      return;
    }

    const undoOperation = this._undoOperations.pop()!;
    this.replay(() => undoOperation.undo());
    this._redoOperations.push(undoOperation);
    this._onReplayed(undoOperation);

    this.reset();
    this.revalidate();
    this._version--;
    this.versionChanged.emit(this._version);
  }

  public redo(): void {
    if (!this.canRedo) {
      return;
    }

    const redoOperation = this._redoOperations.pop()!;
    this.replay(() => redoOperation.redo());
    this._undoOperations.push(redoOperation);
    this._onReplayed(redoOperation);

    this.reset();
    this.revalidate();
    this._version++;
    this.versionChanged.emit(this._version);
  }

  public revalidate(): void {
    this.trackedObjects.forEach((x) => validate(x));
    this.trackedCollections.forEach((x) => x._validate());
    this.isValid = this._invalidCount === 0;
  }
}

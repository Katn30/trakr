import { TypedEvent } from "./TypedEvent";
import { Operation } from "./Operation";
import type { Change } from "./Change";
import type { TrackedCollectionBase } from "./TrackedCollection";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { CollectionUtilities } from "./CollectionUtilities";
import { validate, validateSingleProperty } from "./Registry";
import { DependencyTracker, COLLECTION_VERSION_KEY } from "./DependencyTracker";
import { ITracked } from "./ITracked";
import type { TrackedObjectBase } from "./TrackedObjectBase";
import type { TrackerSession, PropertyScope } from "./TrackerSession";
import { ITrackerContext } from "./ITrackerContext";
import type { HistoryEntry } from "./HistoryEntry";

/** The state flags, each with a `…Changed` event; reported in this order. */
const FLAGS = ["isDirty", "isValid", "canCommit", "canUndo", "canRedo", "isSaving"] as const;
type Flag = (typeof FLAGS)[number];

/**
 * Shared core of every tracker: reactive change events, validation, sessions and
 * the undo/redo operation stack. Persistence semantics live in the subclasses:
 * {@link UnitOfWork} (batch commit of object state) and {@link EventLog}
 * (stream of events acknowledged by the server). Cannot be instantiated directly.
 */
export abstract class Tracker<
  TModel extends TrackedObjectBase = TrackedObjectBase,
  TCollection extends TrackedCollectionBase<unknown> = TrackedCollectionBase<unknown>,
  TEntry extends HistoryEntry = HistoryEntry,
  TSession extends TrackerSession<TModel> = TrackerSession<TModel>,
> implements ITrackerContext {
  private _currentOperation: Operation | undefined;
  protected readonly _redoOperations: Operation[];
  protected readonly _undoOperations: Operation[];
  private _isDirty: boolean;
  private _canUndo: boolean;
  private _canRedo: boolean;
  private _suppressTrackingCounter = 0;
  private _currentOperationOwner: ITracked | undefined;
  private _currentOperationPropertyName: string | undefined;
  private _isValid: boolean;
  private _canCommit: boolean;
  private _chronicleIdCounter = 1;
  private _invalidCount = 0;
  private _constructionDepth = 0;
  private _composingBaseIndex: number | undefined;
  private _composingRedoLength: number | undefined;
  private _currentSession: TSession | undefined;
  // Inside batch(): `changed` waits until it ends, and undo/redo are off.
  private _holdingChanged = false;
  private _heldChange = false;
  /** @internal True while undo/redo replays recorded actions. */
  public _isReplaying: boolean = false;
  protected _version: number = 0;
  private _saveInProgress = false;
  // What the flag events last reported: an event fires when a flag differs from it.
  private readonly _announced: Record<Flag, boolean> = {
    isDirty: false, isValid: true, canCommit: false, canUndo: false, canRedo: false, isSaving: false,
  };
  // Inside _atomically: flag events wait until the state is final.
  private _announceDepth = 0;
  private readonly _entries = new WeakMap<Operation, TEntry>();
  private _pendingRevalidations: Array<{ obj: ITracked; prop: string | undefined }> = [];
  // What construct()/new() wrote while suppressed: revalidated once the outermost construction ends.
  private readonly _constructionWrites = new Map<ITracked, Set<string | undefined>>();

  /** @internal Every model object this tracker knows, in creation order. */
  public readonly _trackedObjects: TModel[] = [];

  /** @internal */
  public readonly _trackedCollections: TCollection[] = [];

  /** Whether there is unsaved work; what "saved" means is up to each tracker. */
  public get isDirty(): boolean {
    return this._isDirty;
  }

  /** Fires with the new value when `isDirty` flips. */
  public readonly isDirtyChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  /**
   * +1 per operation (or write merged into the last one), −1 per undo, +1 per
   * redo: a cheap "the model changed" signal, e.g. to re-render views. It does
   * not change when a save completes.
   */
  public get version(): number {
    return this._version;
  }

  /**
   * Fires once the model changed: an operation was recorded (or merged into the
   * last one), undone or redone, or pending changes were discarded. The trigger
   * for re-rendering and for autosave.
   */
  public readonly changed: TypedEvent<{ version: number }> = new TypedEvent<{ version: number }>();

  /** Moves `version` by `delta` and reports it. */
  protected _bumpVersion(delta: number): void {
    this._version += delta;
    if (this._holdingChanged) {
      this._heldChange = true;
      return;
    }
    this.changed._emit({ version: this._version });
  }

  /** Whether a `commit` is in progress (its `save` has not completed yet). */
  public get isSaving(): boolean {
    return this._saveInProgress;
  }

  /** Fires with the new value when `isSaving` flips. */
  public readonly isSavingChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  /** Undo steps, oldest first: `undo()` reverts the last one. */
  public get undoable(): readonly TEntry[] {
    return this._undoOperations.map((op) => this._entry(op));
  }

  /**
   * Redo steps, next first: `redo()` re-applies the first one.
   * `[...undoable, ...redoable]` is the whole history, in order.
   */
  public get redoable(): readonly TEntry[] {
    return [...this._redoOperations].reverse().map((op) => this._entry(op));
  }

  /** Whether every object and collection in the model passes its validators. */
  public get isValid(): boolean {
    return this._isValid;
  }
  private set isValid(value: boolean) {
    this._isValid = value;
    this._announce();
  }

  /** Fires with the new value when `isValid` flips. */
  public readonly isValidChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  /** `isDirty && isValid`: whether a save button should be enabled. */
  public get canCommit(): boolean {
    return this._canCommit;
  }

  /** Fires with the new value when `canCommit` flips. */
  public readonly canCommitChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  /**
   * Whether `undo()` has something to undo. False while the step on top is
   * being saved, and while a `batch` runs.
   */
  public get canUndo(): boolean {
    return this._canUndo;
  }

  /** Fires with the new value when `canUndo` flips (a step recorded or undone, a save starting or ending). */
  public readonly canUndoChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  /** Whether `redo()` has something to redo. False while the next step is being saved, and while a `batch` runs. */
  public get canRedo(): boolean {
    return this._canRedo;
  }

  /** Fires with the new value when `canRedo` flips. */
  public readonly canRedoChanged: TypedEvent<boolean> = new TypedEvent<boolean>();

  /**
   * Fires the events of the flags that changed since they were last reported.
   * Every flag is up to date before the first event fires, so a subscriber reads
   * a consistent state; one that changes the state again gets its own events.
   */
  private _announce(): void {
    this._canCommit = this._isDirty && this._isValid;
    if (this._announceDepth > 0) return;
    for (const name of FLAGS) {
      // Read now: a subscriber of an earlier flag may have changed (and reported) this one.
      const value = this._flag(name);
      if (this._announced[name] === value) continue;
      this._announced[name] = value;
      this._flagEvent(name)._emit(value);
    }
  }

  private _flag(name: Flag): boolean {
    switch (name) {
      case "isDirty": return this._isDirty;
      case "isValid": return this._isValid;
      case "canCommit": return this._canCommit;
      case "canUndo": return this._canUndo;
      case "canRedo": return this._canRedo;
      case "isSaving": return this._saveInProgress;
    }
  }

  private _flagEvent(name: Flag): TypedEvent<boolean> {
    switch (name) {
      case "isDirty": return this.isDirtyChanged;
      case "isValid": return this.isValidChanged;
      case "canCommit": return this.canCommitChanged;
      case "canUndo": return this.canUndoChanged;
      case "canRedo": return this.canRedoChanged;
      case "isSaving": return this.isSavingChanged;
    }
  }

  /** Runs `action` with the flag events held: they fire once, from the state it leaves (even if it throws). */
  protected _atomically(action: () => void): void {
    this._announceDepth++;
    try {
      action();
    } finally {
      this._announceDepth--;
      this._announce();
    }
  }

  /** @internal */
  public get _isTrackingSuppressed(): boolean {
    return this._suppressTrackingCounter > 0;
  }

  /** @internal */
  public get _isConstructing(): boolean {
    return this._constructionDepth > 0;
  }

  /** Whether the server matches `op` as it stands (applied if in the undo stack, reverted if in the redo stack). */
  protected abstract _isCommitted(op: Operation): boolean;
  /** Whether the save in progress will change `_isCommitted(op)`. */
  protected abstract _isSaving(op: Operation): boolean;

  /** The read-only view of `op`, the same object for as long as `op` lives. */
  protected _entry(op: Operation): TEntry {
    let entry = this._entries.get(op);
    if (!entry) {
      entry = this._createEntry(op);
      this._entries.set(op, entry);
    }
    return entry;
  }

  /** Builds the entry of `op`; {@link _historyEntry} provides what every entry has. */
  protected abstract _createEntry(op: Operation): TEntry;

  /** The members every history entry has, live. */
  protected _historyEntry(op: Operation): HistoryEntry {
    const tracker = this;
    return {
      get isCommitted() { return tracker._isCommitted(op); },
      get isSaving() { return tracker._isSaving(op); },
    };
  }

  /** Whether `op` is in the undo stack (applied). */
  protected _isApplied(op: Operation): boolean {
    return this._undoOperations.includes(op);
  }

  /** A save starts or ends: what it locks changes with it. */
  protected _setSaving(value: boolean): void {
    this._saveInProgress = value;
    this.reset();
  }

  /** Subclass-specific definition of "has unsaved work". */
  protected abstract _computeIsDirty(): boolean;

  // ---- Operation lifecycle hooks. No-ops here; EventLog keeps its event list through them.

  /** A write is about to start (`extended` = it coalesces into the existing `op`). */
  protected _onOperationStart(_op: Operation, _extended: boolean): void {}
  /** A top-level write finished recording into `op`. */
  protected _onOperationEnd(_op: Operation): void {}
  /** A write into `op` threw and was reverted (see `_abortOperation`). */
  protected _onOperationAborted(_op: Operation): void {}
  /** `op` was just undone or redone. */
  protected _onReplayed(_op: Operation): void {}
  /** Undone operations were dropped from the redo stack and can never be redone. */
  protected abstract _onOperationsDropped(ops: readonly Operation[]): void;
  /** Whether a new write may coalesce into `op`, the last operation. */
  protected _canExtend(_op: Operation): boolean { return true; }
  /** Whether `op` must not be undone, redone or extended now (it is part of a save in progress). */
  protected abstract _isLocked(op: Operation): boolean;
  /** @internal `obj.destroy()` was called. */
  public _onObjectDestroyed(_obj: TModel): void {}

  /** `tracker.new()` finished constructing `created`. */
  protected abstract _onNewCompleted(created: readonly TModel[]): void;
  /** A session ended: `composed` became the single undo step `result`. */
  protected _onSessionEnded(_composed: readonly Operation[], _result: Operation): void {}
  /** A session was rolled back: `reverted` were undone and removed. */
  protected _onSessionRolledBack(_reverted: readonly Operation[]): void {}

  public constructor() {
    this._currentOperation = undefined;
    this._redoOperations = [];
    this._undoOperations = [];
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
  public _trackObject(trackedObject: TModel): void {
    this._trackedObjects.push(trackedObject);
    // It counts towards isValid while tracked, unless it is out of the model (released).
    if (!trackedObject._isOwnValid && !trackedObject._isValidityReleased) this._onValidityChanged(true);
  }

  /** @internal */
  public _untrackObject(trackedObject: TModel): void {
    this._trackedObjects.splice(this._trackedObjects.indexOf(trackedObject), 1);
    // Its own contribution only: a container's children are counted (and untracked) separately.
    if (!trackedObject._isOwnValid && !trackedObject._isValidityReleased) this._invalidCount--;
    this.isValid = this._invalidCount === 0;
  }

  /** @internal */
  public _trackCollection(trackedCollection: TCollection): void {
    this._trackedCollections.push(trackedCollection);
  }

  /** @internal */
  public _untrackCollection(trackedCollection: TCollection): void {
    this._trackedCollections.splice(
      this._trackedCollections.indexOf(trackedCollection),
      1,
    );
    if (!trackedCollection.chronicleIsValid && !trackedCollection._isValidityReleased) this._invalidCount--;
    this.isValid = this._invalidCount === 0;
  }

  /** @internal An object or collection's validity flipped. */
  public _onValidityChanged(becameInvalid: boolean): void {
    this._invalidCount += becameInvalid ? 1 : -1;
    if (!this._isTrackingSuppressed) {
      this.isValid = this._invalidCount === 0;
    }
  }

  /**
   * Builds objects that already exist (e.g. loaded from the server): nothing
   * inside `action` is recorded, and the objects start clean and validated.
   */
  public construct<T>(action: () => T): T {
    const objectsBefore = this._trackedObjects.length;
    this._constructionDepth++;
    this._suppressTrackingCounter++;
    try {
      const result = action();
      for (let i = objectsBefore; i < this._trackedObjects.length; i++) {
        validate(this._trackedObjects[i]);
      }
      if (this._constructionDepth === 1) this._revalidateConstructionWrites();
      return result;
    } finally {
      this._suppressTrackingCounter--;
      this._constructionDepth--;
      if (this._constructionDepth === 0) this._constructionWrites.clear();
      this.isValid = this._invalidCount === 0;
    }
  }

  private _noteConstructionWrite(target: ITracked, property: string | undefined): void {
    let properties = this._constructionWrites.get(target);
    if (!properties) {
      properties = new Set();
      this._constructionWrites.set(target, properties);
    }
    properties.add(property);
  }

  /** Validators that depend on what the construction wrote (e.g. a collection's items) see the final state. */
  private _revalidateConstructionWrites(): void {
    for (const [target, properties] of this._constructionWrites) {
      for (const property of properties) this.revalidateTargeted(target, property);
    }
    this._constructionWrites.clear();
  }

  /**
   * Builds a new object (the server does not have it): its constructor's writes
   * are its initial state, not undoable edits. It becomes a change to save once
   * it is used: added to the model, or (on an `EventLog`) first changed.
   */
  public new<T>(action: () => T): T {
    const objectsBefore = this._trackedObjects.length;
    const undoLengthBefore = this._undoOperations.length;
    const savedRedo = [...this._redoOperations];
    this._constructionDepth++;
    let result: T;
    try {
      result = action();
    } finally {
      // The constructor's writes ran as operations (so hooks cascade): they are
      // construction, not edits. Drop them and restore the redo stack.
      this._undoOperations.length = undoLengthBefore;
      this._redoOperations.length = 0;
      for (const op of savedRedo) this._redoOperations.push(op);
      this._constructionDepth--;
      // Nested in another construction: that one revalidates when it ends.
      if (this._constructionDepth === 0) this._revalidateConstructionWrites();
    }
    const created = this._trackedObjects.slice(objectsBefore);
    for (const obj of created) validate(obj);
    this.isValid = this._invalidCount === 0;
    this._onNewCompleted(created);
    this.reset();
    return result;
  }

  /**
   * Runs `action` without recording it: its writes are neither undoable nor
   * changes to save — e.g. loading data the server already has.
   */
  public withTrackingSuppressed(action: () => void): void {
    this._suppressTrackingCounter++;
    try {
      action();
    } finally {
      this._suppressTrackingCounter--;
    }
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
      if (this._isConstructing) this._noteConstructionWrite(properties.trackedObject, properties.property);
      else this.revalidateTargeted(properties.trackedObject, properties.property);
      return;
    }

    if (!this.isStartingNewOperation()) {
      this._recordWrite(redoAction, undoAction, properties);
      return;
    }

    this._currentOperationOwner = properties.trackedObject;
    this._currentOperationPropertyName = properties.property;
    const extended = this.shouldCoalesceChanges(properties);
    let op: Operation;
    if (extended) {
      op = CollectionUtilities.getLast(this._undoOperations)!;
      this._currentOperation = op;
      this._onOperationStart(op, true);
    } else {
      op = new Operation();
      this._currentOperation = op;
      this._onOperationStart(op, false);
      this._undoOperations.push(op);
      this._onOperationsDropped(this._redoOperations.splice(0));
      this.reset();
    }
    const actionsBefore = op.actions.length;
    try {
      this._recordWrite(redoAction, undoAction, properties);
    } catch (error) {
      this._abortOperation(op, actionsBefore, !extended);
      throw error;
    }
  }

  /** Records one write into the current operation, runs it, and ends the operation if it opened it. */
  private _recordWrite(redoAction: () => void, undoAction: () => void, properties: OperationProperties): void {
    this._currentOperation?.add(
      () => redoAction(),
      () => undoAction(),
      properties,
    );
    redoAction();

    if (this._currentSession !== undefined && properties.property !== undefined) {
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
      // Inside tracker.new() the operation is discarded: it is construction, not a change.
      if (!this._isConstructing) this._bumpVersion(1);
    } else {
      // Not the write that opened the operation, so necessarily an inner one.
      this._pendingRevalidations.push({ obj: properties.trackedObject, prop: properties.property });
    }
  }

  /**
   * A write threw (a hook, a subscriber, a validator, a setter): revert what it
   * recorded, drop the operation if the write opened it, and leave the tracker
   * ready for the next write.
   */
  private _abortOperation(op: Operation, actionsBefore: number, created: boolean): void {
    const recorded = op.actions.splice(actionsBefore);
    this.replay(() => {
      for (let i = recorded.length - 1; i >= 0; i--) recorded[i].undoAction();
    });
    if (created) this._undoOperations.splice(this._undoOperations.indexOf(op), 1);
    this._currentOperation = undefined;
    this._currentOperationOwner = undefined;
    this._currentOperationPropertyName = undefined;
    this._pendingRevalidations = [];
    this._onOperationAborted(op);
    this.reset();
    this._revalidateReplayed(recorded);
  }

  private revalidateTargeted(changedObj: ITracked, changedProp: string | undefined): void {
    const depKey = changedProp ?? COLLECTION_VERSION_KEY;
    const dependents = [...DependencyTracker.getDependents(changedObj, depKey)];
    for (const { obj, prop } of dependents) {
      const error = validateSingleProperty(obj, prop);
      obj._validate(prop, error);
    }
    changedObj._revalidateSelf(changedProp);
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
      this._canExtend(lastOperation!) &&
      !this.isBeforeComposing() &&
      !this._isLocked(lastOperation!) &&
      this.lastOperationTargetsSameProperty(lastOperation!, properties) &&
      this.lastActionIsRecent(lastOperation!, properties.coalesceWithin!)
    );
  }

  // The last operation predates the session: a write inside must not merge into it.
  private isBeforeComposing(): boolean {
    return this._composingBaseIndex !== undefined && this._undoOperations.length <= this._composingBaseIndex;
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
  public _nextChronicleId(): number {
    return this._chronicleIdCounter++;
  }

  /** Reverts what has not been saved; what "saved" means is up to each tracker. */
  public abstract discardPendingChanges(): void;

  /** @internal */
  public _getByChronicleId(chronicleId: number): TModel | undefined {
    return this._trackedObjects.find((o) => o.chronicleId === chronicleId);
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
    const nextUndo = CollectionUtilities.getLast(this._undoOperations);
    const nextRedo = CollectionUtilities.getLast(this._redoOperations);
    // Not while a batch composes its step.
    this._canUndo = !this._holdingChanged && nextUndo !== undefined && !this._isLocked(nextUndo);
    this._canRedo = !this._holdingChanged && nextRedo !== undefined && !this._isLocked(nextRedo);
    this._isDirty = this._computeIsDirty();
    this._announce();
  }

  /**
   * Runs `action` as one user action: every tracked write inside it, and what
   * those writes cascade into, is one undo step, and `changed` fires once, when
   * it ends. A `batch` inside another joins the outer one. If `action` throws,
   * everything it wrote is reverted and the error propagates. Undo and redo are
   * not available while it runs.
   */
  public batch(action: () => void): void {
    if (this._currentSession !== undefined) {
      action();
      return;
    }
    const session = this._startSession();
    const versionBefore = this._version;
    // The flags (canUndo, isDirty, …) report the state the batch leaves, once.
    this._atomically(() => {
      this._holdingChanged = true;
      this._heldChange = false;
      this.reset();
      try {
        action();
      } catch (error) {
        session.rollback();
        this._holdingChanged = false;
        this._version = versionBefore;
        this.reset();
        throw error;
      }
      session.end();
      this._holdingChanged = false;
      this.reset();
    });
    if (this._heldChange) {
      // One step: one version.
      this._version = versionBefore;
      this._bumpVersion(1);
    }
  }

  /**
   * @internal Groups the following operations into one undo step until the
   * session ends (or rolls them back); `batch` is its public form.
   */
  public _startSession(scope?: PropertyScope<TModel>[]): TSession {
    if (this._currentSession !== undefined) return this._currentSession;
    this._composingBaseIndex = this._undoOperations.length;
    this._composingRedoLength = this._redoOperations.length;
    this._currentSession = this._createSession(
      scope,
      () => this.endComposing(),
      () => this.rollbackComposing(),
    );
    return this._currentSession;
  }

  /** Creates the session object returned by `_startSession`; UnitOfWork adds `deletedObjects`. */
  protected abstract _createSession(scope: PropertyScope<TModel>[] | undefined, end: () => void, rollback: () => void): TSession;

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
    this._revalidateReplayed(toRevert.flatMap((op) => op.actions));
    if (toRevert.length > 0) {
      this._bumpVersion(-toRevert.length);
    }
  }

  /** Reverts the last operation. */
  public undo(): void {
    if (!this.canUndo) {
      return;
    }

    const undoOperation = this._undoOperations.pop()!;
    this.replay(() => undoOperation.undo());
    this._redoOperations.push(undoOperation);
    this._onReplayed(undoOperation);

    this.reset();
    this._revalidateReplayed(undoOperation.actions);
    this._bumpVersion(-1);
  }

  /** Re-applies the last undone operation. */
  public redo(): void {
    if (!this.canRedo) {
      return;
    }

    const redoOperation = this._redoOperations.pop()!;
    this.replay(() => redoOperation.redo());
    this._undoOperations.push(redoOperation);
    this._onReplayed(redoOperation);

    this.reset();
    this._revalidateReplayed(redoOperation.actions);
    this._bumpVersion(1);
  }

  /**
   * After a replay (undo, redo, discard, rollback): the validators that depend
   * on what the replayed actions changed run again, as the writes themselves
   * would have made them — for objects in the model or not.
   */
  protected _revalidateReplayed(actions: readonly Change[]): void {
    const done = new Map<ITracked, Set<string | undefined>>();
    for (const { properties } of actions) {
      let props = done.get(properties.trackedObject);
      if (!props) {
        props = new Set();
        done.set(properties.trackedObject, props);
      }
      if (props.has(properties.property)) continue;
      props.add(properties.property);
      this.revalidateTargeted(properties.trackedObject, properties.property);
    }
    this.isValid = this._invalidCount === 0;
  }

  /** @internal Re-runs every validator. */
  public _revalidate(): void {
    this._trackedObjects.forEach((x) => validate(x));
    this._trackedCollections.forEach((x) => x._validate());
    this.isValid = this._invalidCount === 0;
  }
}

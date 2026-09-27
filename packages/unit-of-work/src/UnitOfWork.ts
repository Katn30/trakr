import { Tracker } from "@katn30/chronicle-core";
import { Operation } from "@katn30/chronicle-core";
import { CollectionUtilities } from "@katn30/chronicle-core";
import { IdAssignment } from "@katn30/chronicle-core";
import { State } from "./State";
import type { TrackedCollectionBase, HistoryEntry, PropertyScope, ITracked } from "@katn30/chronicle-core";
import { Entity } from "./Entity";
import { UnitOfWorkSession } from "./UnitOfWorkSession";

/** What {@link UnitOfWork.commit} hands to the save function. */
export interface CommitBatch {
  /** New objects (`Insert`): the save returns their server-assigned `@AutoId`s. */
  inserted: Entity[];
  /** Existing objects with unsaved edits (`Changed`). */
  changed: Entity[];
  /** Objects removed from the model (`Deleted`). */
  deleted: Entity[];
}

/** Persists a batch; returns the server-assigned `@AutoId` values (`{ chronicleId, value }`), if any. */
export type SaveFunction<V = number> = (
  batch: CommitBatch,
) => Promise<ReadonlyArray<IdAssignment<V>> | void> | ReadonlyArray<IdAssignment<V>> | void;

/**
 * Tracks what changed since the last save — new, edited and removed objects —
 * and saves it all at once with {@link commit}. Undo can cross a commit:
 * undoing a saved change makes the object dirty again, so the next commit
 * saves the reversal.
 */
export class UnitOfWork extends Tracker<Entity, TrackedCollectionBase<unknown>, HistoryEntry, UnitOfWorkSession> {
  // The last operation included in a commit: the undo stack above it is "dirty".
  private _commitStateOperation: Operation | undefined;
  // commit() calls run one after another.
  private _commitQueue: Promise<unknown> = Promise.resolve();
  // While a save is in flight: how many operations, from the bottom of the undo stack, it covers.
  private _saving: number | undefined;
  // The operations whose effect the server has: those applied at the last commit.
  private _serverHas = new WeakSet<Operation>();

  protected _createSession(scope: PropertyScope<Entity>[] | undefined, end: () => void, rollback: () => void): UnitOfWorkSession {
    return new UnitOfWorkSession(scope, this, end, rollback);
  }

  protected _createEntry(op: Operation): HistoryEntry {
    return Object.freeze(this._historyEntry(op));
  }

  /** Objects built by `tracker.new()` start clean: their constructor writes are not edits. */
  protected override _onNewCompleted(created: readonly Entity[]): void {
    for (const obj of created) obj._onCreated();
  }

  protected _computeIsDirty(): boolean {
    return CollectionUtilities.getLast(this._undoOperations) !== this._commitStateOperation;
  }

  protected _isCommitted(op: Operation): boolean {
    return this._serverHas.has(op) === this._isApplied(op);
  }

  protected _isSaving(op: Operation): boolean {
    if (this._saving === undefined) return false;
    const index = this._undoOperations.indexOf(op);
    const willHave = index >= 0 && index < this._saving;
    return this._serverHas.has(op) !== willHave;
  }

  // A saved step that was undone and is now dropped: what it changed differs from what was saved.
  // (A collection's changes are saved as its items': only the objects matter.)
  protected override _onOperationsDropped(ops: readonly Operation[]): void {
    const entities = new Map<ITracked, Entity>(this._trackedObjects.map((obj) => [obj, obj]));
    for (const op of ops) {
      if (!this._serverHas.has(op)) continue;
      for (const action of op.actions) entities.get(action.properties.trackedObject)?._onSavedChangeLost();
    }
  }

  // Edits made after a commit are a new operation.
  protected override _canExtend(op: Operation): boolean {
    return op !== this._commitStateOperation;
  }

  // What is being saved cannot be undone until the save completes.
  protected override _isLocked(op: Operation): boolean {
    if (this._saving === undefined) return false;
    const index = this._undoOperations.indexOf(op);
    return index >= 0 && index < this._saving;
  }

  /**
   * Saves every change since the last commit in one go: `save` receives the
   * objects to insert, update and delete, and returns the ids the server
   * assigned to the inserted ones. Once it resolves, those objects are
   * `Unchanged` and the ids are in their `@AutoId` fields.
   *
   * Edits made while `save` runs stay pending for the next commit; the changes
   * being saved cannot be undone until it completes. Calls run one after
   * another. Resolves to `false` if there was nothing to commit. If `save`
   * throws, nothing is committed and the error propagates. Changes that cancel
   * out (e.g. add then remove a new object) are committed without calling `save`.
   */
  public commit<V = number>(save: SaveFunction<V>): Promise<boolean> {
    const run = this._commitQueue.then(() => this._commitPending(save));
    this._commitQueue = run.catch(() => undefined);
    return run;
  }

  private async _commitPending<V>(save: SaveFunction<V>): Promise<boolean> {
    if (!this.isDirty) return false;
    const batch: CommitBatch = { inserted: [], changed: [], deleted: [] };
    for (const obj of this._trackedObjects) {
      if (obj.chronicleState === State.Insert) batch.inserted.push(obj);
      else if (obj.chronicleState === State.Changed) batch.changed.push(obj);
      else if (obj.chronicleState === State.Deleted) batch.deleted.push(obj);
    }
    const hasChanges = batch.inserted.length + batch.changed.length + batch.deleted.length > 0;

    this._saving = this._undoOperations.length;
    this._atomically(() => this._setSaving(true));
    let keys: ReadonlyArray<IdAssignment<V>>;
    try {
      keys = hasChanges ? (await save(batch)) ?? [] : [];
    } catch (error) {
      this._atomically(() => {
        this._saving = undefined;
        this._setSaving(false);
      });
      throw error;
    }
    const covered = this._saving;
    this._atomically(() => {
      this._saving = undefined;
      this._setSaving(false);
      this._commitCovered(covered, keys);
    });
    return true;
  }

  /**
   * Commits the first `covered` operations. Operations recorded after them
   * (while the save ran) are rewound, and replayed on top of the committed
   * state, so they stay pending.
   */
  private _commitCovered<V>(covered: number, keys: ReadonlyArray<IdAssignment<V>>): void {
    const later = this._undoOperations.splice(covered);
    if (later.length === 0) {
      this._applyCommit([...keys]);
      return;
    }
    this.replay(() => {
      for (let i = later.length - 1; i >= 0; i--) later[i].undo();
    });
    this._applyCommit([...keys]);
    this.replay(() => {
      for (const op of later) op.redo();
    });
    this._undoOperations.push(...later);
    this.reset();
    this._revalidate();
  }

  /**
   * Goes back to the saved state and clears the undo/redo history: undoes the
   * operations the server does not have, and redoes those it has that were
   * undone. While a save is in flight, what it is saving is kept.
   */
  public discardPendingChanges(): void {
    let toUndo: Operation[];
    let toRedo: Operation[] = [];
    if (this._saving !== undefined) {
      toUndo = this._undoOperations.slice(this._saving);
    } else {
      let unsaved = this._undoOperations.length;
      while (unsaved > 0 && !this._serverHas.has(this._undoOperations[unsaved - 1])) unsaved--;
      toUndo = this._undoOperations.slice(unsaved);
      // The redo stack's next operation is its last element.
      let saved = this._redoOperations.length;
      while (saved > 0 && this._serverHas.has(this._redoOperations[saved - 1])) saved--;
      toRedo = this._redoOperations.slice(saved).reverse();
    }
    // A saved step was dropped from the redo history: the saved state is out of reach, it stays dirty.
    const reachable = this._commitStateOperation === undefined
      || this._undoOperations.includes(this._commitStateOperation)
      || this._redoOperations.includes(this._commitStateOperation);

    this._undoOperations.length = 0;
    this._redoOperations.length = 0;
    if (reachable) this._commitStateOperation = undefined;
    this._serverHas = new WeakSet();
    if (this._saving !== undefined) this._saving = 0;

    if (toUndo.length + toRedo.length > 0) {
      this.replay(() => {
        for (let i = toUndo.length - 1; i >= 0; i--) toUndo[i].undo();
        for (const op of toRedo) op.redo();
      });
      this._bumpVersion(toRedo.length - toUndo.length);
    }

    this.reset();
    this._revalidate();
  }

  /**
   * @internal Marks the current state as saved: every object becomes
   * `Unchanged` and the `@AutoId`s in `keys` are assigned. Undoing past this
   * point makes the affected objects dirty again.
   */
  public _onCommit<V = number>(keys?: IdAssignment<V>[]): void {
    this._applyCommit(keys);
  }

  private _applyCommit<V>(keys?: IdAssignment<V>[]): void {
    const globalLastOp = CollectionUtilities.getLast(this._undoOperations);
    for (const obj of [...this._trackedObjects]) obj._onCommitted(keys);
    this._commitStateOperation = globalLastOp;
    this._serverHas = new WeakSet(this._undoOperations);
    this.reset();
  }
}

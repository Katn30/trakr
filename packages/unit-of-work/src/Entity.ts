import type { UnitOfWork } from "./UnitOfWork";
import { TrackedObjectBase } from "@chronicle/core";
import { State } from "./State";
import { OperationProperties } from "@chronicle/core";
import { PropertyType } from "@chronicle/core";
import { IdAssignment, getAutoIdProperty, writeProperty } from "@chronicle/core";
import type { ContainerChildren } from "@chronicle/core";

/** Where an object stands in the model. */
type Membership =
  | "root"   // never added nor removed: a root of the model, or loaded in place
  | "in"     // in a collection (or a tracked property)
  | "out";   // taken out of it

/**
 * Base class for models tracked by a {@link UnitOfWork}. Its `chronicleState`
 * (`Insert` / `Changed` / `Deleted` / `Unchanged`) follows from two facts: where
 * it stands in the model, and whether the server has it.
 *
 * | in the model | the server has it | state |
 * |---|---|---|
 * | in | no | `Insert` |
 * | in | yes | `Changed` if it has unsaved writes, else `Unchanged` |
 * | out | yes | `Deleted` |
 * | out | no | `Unchanged` (nothing to save: it is forgotten) |
 * | root | – | `Changed` if it has unsaved writes, else `Unchanged` |
 *
 * Adding and removing change the first fact, and count as writes (undo and
 * redo reverse exactly what they did); a save sets the second to "what is in
 * the model".
 */
export abstract class Entity extends TrackedObjectBase {
  declare public readonly tracker: UnitOfWork;

  private _membership: Membership = "root";
  // Whether the server has it; unknown for an object never placed nor saved (see `_markAdded` / `_markRemoved`).
  private _onServer: boolean | undefined;
  private _dirtyCounter: number = 0;
  // A saved change was undone and dropped from the redo history: dirty until the next save.
  private _diverged = false;

  public constructor(tracker: UnitOfWork) {
    super(tracker);
  }

  /** What the save layer has to do with this object. */
  public get chronicleState(): State {
    if (this._membership === "in") return this._onServer === true ? this._changedOrUnchanged() : State.Insert;
    if (this._membership === "out") return this._onServer ? State.Deleted : State.Unchanged;
    return this._changedOrUnchanged();
  }

  /** Net count of unsaved writes (adding and removing included): +1 per write, −1 per undo, reset by a commit. */
  public get dirtyCounter(): number {
    return this._dirtyCounter;
  }

  /** Whether it has writes that are not saved. */
  public get isDirty(): boolean {
    return this._dirtyCounter !== 0 || this._diverged;
  }

  // Its own writes only: a container's `isDirty` also covers its children, which are saved on their own.
  private _changedOrUnchanged(): State {
    return this._dirtyCounter !== 0 || this._diverged ? State.Changed : State.Unchanged;
  }

  /** @internal A container tracks this object (`trackChild`). */
  _attachToContainer(children: ContainerChildren<Entity>, _owner: TrackedObjectBase): void {
    children.trackObject(this);
  }

  /** @internal */
  _detachFromContainer(children: ContainerChildren<Entity>, _owner: TrackedObjectBase): void {
    children.untrackObject(this);
  }

  /** @internal */
  override _onTrackedWrite(): void {
    this._dirtyCounter++;
  }

  /** @internal */
  override _onTrackedWriteUndone(): void {
    this._dirtyCounter--;
  }

  /**
   * @internal A saved change to it was undone, and can no longer be redone (a
   * new change dropped the redo history): it differs from what was saved.
   */
  _onSavedChangeLost(): void {
    this._diverged = true;
  }

  /** @internal Built by `tracker.new()`: its constructor's writes are not edits. */
  _onCreated(): void {
    this._dirtyCounter = 0;
    this._onServer = false;
  }

  /**
   * @internal Saved as it is now: the server has it exactly if it is in the
   * model, and the `@AutoId` the server assigned (if any, in `keys`) is written.
   */
  _onCommitted<V>(keys?: readonly IdAssignment<V>[]): void {
    const state = this.chronicleState;
    const autoIdProp = getAutoIdProperty(Object.getPrototypeOf(this));
    if (autoIdProp && keys && (state === State.Insert || state === State.Changed)) {
      const key = keys.find((k) => k.chronicleId === this.chronicleId);
      if (key) writeProperty(this, autoIdProp, key.value);
    }
    this._onServer = this._membership !== "out";
    this._dirtyCounter = 0;
    this._diverged = false;
    // Deleted on the server: forgotten until undo brings it back.
    this._moveTo(this._membership);
  }

  /** @internal Put in a collection or a tracked property. */
  _markAdded(): void {
    // Undo and redo replay the recorded change itself.
    if (this._membership === "in" || this.tracker._isReplaying) return;
    if (this.tracker._isTrackingSuppressed) {
      // Loading: what is placed silently is what the server has.
      this._onServer = true;
      this._moveTo("in");
      this._setValidityReleased(false);
      return;
    }
    this.tracker._doAndTrack(
      () => {
        // Placed for the first time: a new object.
        if (this._membership === "root" && this._onServer === undefined) this._onServer = false;
        this._dirtyCounter++;
        this._moveTo("in");
      },
      () => {
        this._dirtyCounter--;
        this._moveTo("out");
      },
      new OperationProperties(this, "__state__", PropertyType.Object),
    );
    // Back in the model: its validity counts again.
    this._setValidityReleased(false);
  }

  /** @internal Taken out of its collection (or its property cleared). */
  _markRemoved(): void {
    if (this.tracker._isReplaying) return;
    if (this.tracker._isTrackingSuppressed) {
      // Loading: what is removed silently is not on the server either: it is forgotten.
      this._onServer = false;
      this._setValidityReleased(true);
      this._moveTo("out");
      return;
    }
    // Out of the model: its validity no longer counts, whatever happens to it next.
    this._setValidityReleased(true);
    this.tracker._doAndTrack(
      () => {
        // Removed from where it was loaded (a collection's initial items, a root property): the server has it.
        if (this._membership === "root" && this._onServer === undefined) this._onServer = true;
        this._dirtyCounter++;
        this._moveTo("out");
      },
      () => {
        this._dirtyCounter--;
        this._moveTo("in");
      },
      new OperationProperties(this, "__state__", PropertyType.Object),
    );
  }

  /**
   * Sets where it stands. Out of the model and not on the server, there is
   * nothing to save about it: it is forgotten (untracked) until it comes back.
   */
  private _moveTo(membership: Membership): void {
    this._membership = membership;
    const tracked = this.tracker._trackedObjects.indexOf(this) !== -1;
    const keep = membership === "in" || this._onServer === true;
    // Its validators keep running meanwhile: when it comes back, its validity is current.
    if (keep && !tracked) this.tracker._trackObject(this);
    else if (!keep && tracked) this.tracker._untrackObject(this);
  }
}

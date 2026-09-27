import type { EventLog } from "./EventLog";
import { TrackedObjectBase } from "@katn30/chronicle-core";
import type { ContainerChildren } from "@katn30/chronicle-core";

export type { TrackedPropertyChanged } from "@katn30/chronicle-core";

/**
 * Base class for models tracked by an {@link EventLog}. It carries no
 * object state (`chronicleState`, `dirtyCounter`): what is pending is the
 * tracker's event list. Models for a `UnitOfWork` extend `Entity`.
 */
export abstract class TrackedObject extends TrackedObjectBase {
  declare public readonly tracker: EventLog;
  /** @internal Brand: plain `@Tracked` does not compile on EventLog models. */
  declare readonly _eventLogModel: true;

  public constructor(tracker: EventLog) {
    super(tracker);
  }

  /**
   * @internal An EventLog model has no state to change: leaving the model
   * only takes it out of `tracker.isValid` (undo or a re-add brings it back).
   */
  _markRemoved(): void {
    this._setValidityReleased(true);
  }

  /** @internal */
  _markAdded(): void {
    this._setValidityReleased(false);
  }

  private _partOf: { owner: TrackedObject; name: string } | undefined;

  /** @internal The container this object is a part of, and its key in the container's payload. */
  get _part(): { readonly owner: TrackedObject; readonly name: string } | undefined {
    return this._partOf;
  }

  /**
   * @internal A container tracks this object (`trackChild(this, name)`): it is a
   * part of the container, and its changes go into the container's event under `name`.
   */
  _attachToContainer(children: ContainerChildren<TrackedObject>, owner: TrackedObject, name?: string): void {
    if (name !== undefined) {
      if (this._partOf !== undefined && this._partOf.owner !== owner) {
        throw new Error(
          `${this.constructor.name} already belongs to a ${this._partOf.owner.constructor.name}; an object has one owner.`,
        );
      }
      this._partOf = { owner, name };
    }
    children.trackObject(this);
  }

  /** @internal */
  _detachFromContainer(children: ContainerChildren<TrackedObject>, owner: TrackedObject): void {
    if (this._partOf?.owner === owner) this._partOf = undefined;
    children.untrackObject(this);
  }
}

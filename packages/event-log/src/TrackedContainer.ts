import { TrackedObject } from "./TrackedObject";
import type { EventTrackedCollection } from "./EventTrackedCollection";
import { ContainerChildren } from "@chronicle/core";

// An EventLog collection holds TrackedObjects or plain values: this tells them apart.
const isModel = (item: unknown): item is TrackedObject => item instanceof TrackedObject;

/**
 * A {@link TrackedObject} (EventLog model) that owns other objects and
 * collections (`trackChild`): their validity counts towards the container's, and
 * their changes go into the container's event, each under its name. For a
 * UnitOfWork, use `EntityContainer`.
 */
export abstract class TrackedContainer extends TrackedObject {
  private readonly _kids = new ContainerChildren<TrackedObject>(isModel);

  /**
   * Makes `child` a part of this container: its validity counts towards the
   * container's, and its changes go into the container's event, under the
   * collection's name, or under `name` for an object.
   */
  protected trackChild(child: EventTrackedCollection<unknown>): void;
  protected trackChild(child: TrackedObject, name: string): void;
  protected trackChild(child: TrackedObject | EventTrackedCollection<unknown>, name?: string): void {
    child._attachToContainer(this._kids, this, name);
  }

  protected untrackChild(child: TrackedObject | EventTrackedCollection<unknown>): void {
    child._detachFromContainer(this._kids, this);
  }

  override get chronicleIsValid(): boolean {
    return super.chronicleIsValid && this._kids.allValid;
  }

  protected override set chronicleIsValid(value: boolean) {
    this._setIsValid(value);
  }

  /** @internal Leaving (or re-entering) the model takes the whole subtree with it. */
  override _setValidityReleased(released: boolean): void {
    super._setValidityReleased(released);
    this._kids.setReleased(released);
  }

  override destroy(): void {
    this._kids.dispose();
    super.destroy();
  }
}

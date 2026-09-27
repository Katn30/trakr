import { Entity } from "./Entity";
import { TrackedCollection } from "@katn30/chronicle-core";
import { ContainerChildren } from "@katn30/chronicle-core";

// A UnitOfWork collection holds Entities or plain values: this tells them apart.
const isEntity = (item: unknown): item is Entity => item instanceof Entity;

/**
 * A {@link Entity} that aggregates the validity and dirtiness of
 * its children: other tracked objects, collections, and their object items.
 * For an EventLog, use `TrackedContainer`.
 */
export abstract class EntityContainer extends Entity {
  private readonly _kids = new ContainerChildren<Entity>(isEntity);

  protected trackChild(child: Entity | TrackedCollection<unknown>): void {
    child._attachToContainer(this._kids, this);
  }

  protected untrackChild(child: Entity | TrackedCollection<unknown>): void {
    child._detachFromContainer(this._kids, this);
  }

  override get chronicleIsValid(): boolean {
    return super.chronicleIsValid && this._kids.allValid;
  }

  protected override set chronicleIsValid(value: boolean) {
    this._setIsValid(value);
  }

  override get isDirty(): boolean {
    return super.isDirty || this._kids.models.some((m) => m.isDirty);
  }

  /** @internal As a child of a released container, the whole subtree goes with it. */
  override _setValidityReleased(released: boolean): void {
    super._setValidityReleased(released);
    this._kids.setReleased(released);
  }

  override destroy(): void {
    this._kids.dispose();
    super.destroy();
  }
}

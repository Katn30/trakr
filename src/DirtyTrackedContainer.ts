import { DirtyTrackedObject } from "./DirtyTrackedObject";
import { TrackedCollection } from "./TrackedCollection";
import { ContainerChildren } from "./ContainerChildren";

/**
 * A {@link DirtyTrackedObject} that aggregates the validity and dirtiness of
 * its children: other tracked objects, collections, and their object items.
 * For an EventTracker, use `TrackedContainer`.
 */
export abstract class DirtyTrackedContainer extends DirtyTrackedObject {
  private readonly _kids = new ContainerChildren();

  protected trackChild(child: DirtyTrackedObject | TrackedCollection<any>): void {
    this._kids.track(child);
  }

  protected untrackChild(child: DirtyTrackedObject | TrackedCollection<any>): void {
    this._kids.untrack(child);
  }

  override get trakrIsValid(): boolean {
    return super.trakrIsValid && this._kids.allValid;
  }

  override set trakrIsValid(value: boolean) {
    this._setIsValid(value);
  }

  override get isDirty(): boolean {
    return super.isDirty || this._kids.children.some((c) => c instanceof DirtyTrackedObject && c.isDirty);
  }

  override destroy(): void {
    this._kids.dispose();
    super.destroy();
  }
}

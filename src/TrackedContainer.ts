import { TrackedObject } from "./TrackedObject";
import { TrackedCollection, TrackedCollectionChanged } from "./TrackedCollection";

export abstract class TrackedContainer extends TrackedObject {
  private _children: Array<TrackedObject | TrackedCollection<unknown>> = [];
  private _collectionUnsubscribers: Map<TrackedCollection<unknown>, () => void> = new Map();

  protected trackChild(child: TrackedObject | TrackedCollection<unknown>): void {
    this._children.push(child);

    if (child instanceof TrackedCollection) {
      for (const item of child.collection) {
        if (item instanceof TrackedObject) {
          this._children.push(item);
        }
      }

      const unsub = child.changed.subscribe((e: TrackedCollectionChanged<unknown>) => {
        for (const added of e.added) {
          if (added instanceof TrackedObject) {
            this._children.push(added);
          }
        }
        for (const removed of e.removed) {
          if (removed instanceof TrackedObject) {
            const idx = this._children.indexOf(removed);
            if (idx >= 0) this._children.splice(idx, 1);
          }
        }
      });

      this._collectionUnsubscribers.set(child, unsub);
    }
  }

  protected untrackChild(child: TrackedObject | TrackedCollection<unknown>): void {
    if (child instanceof TrackedCollection) {
      const unsub = this._collectionUnsubscribers.get(child);
      if (unsub) {
        unsub();
        this._collectionUnsubscribers.delete(child);
      }

      for (const item of child.collection) {
        if (item instanceof TrackedObject) {
          const idx = this._children.indexOf(item);
          if (idx >= 0) this._children.splice(idx, 1);
        }
      }
    }

    const idx = this._children.indexOf(child);
    if (idx >= 0) this._children.splice(idx, 1);
  }

  override get trakrIsValid(): boolean {
    return super.trakrIsValid && this._children.every(c => c.trakrIsValid);
  }

  override set trakrIsValid(value: boolean) {
    this._setIsValid(value);
  }

  override get isDirty(): boolean {
    return super.isDirty || this._children.some(c => c.isDirty);
  }

  override destroy(): void {
    for (const unsub of this._collectionUnsubscribers.values()) unsub();
    super.destroy();
  }
}

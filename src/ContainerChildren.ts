import { TrackedObjectBase } from "./TrackedObjectBase";
import { TrackedCollection, TrackedCollectionChanged } from "./TrackedCollection";

// `any`: TrackedCollection is invariant in its item type, so `TrackedCollection<unknown>` would reject `TrackedCollection<Item>`.
type Child = TrackedObjectBase | TrackedCollection<any>;

/**
 * The child bookkeeping shared by {@link TrackedContainer} and
 * `DirtyTrackedContainer`: tracked children, plus the object items of tracked
 * collections, followed as the collections change.
 * @internal
 */
export class ContainerChildren {
  readonly children: Child[] = [];
  private readonly _unsubscribers = new Map<TrackedCollection<any>, () => void>();

  track(child: Child): void {
    this.children.push(child);

    if (child instanceof TrackedCollection) {
      for (const item of child.collection) {
        if (item instanceof TrackedObjectBase) {
          this.children.push(item);
        }
      }

      const unsub = child.changed.subscribe((e: TrackedCollectionChanged<unknown>) => {
        for (const added of e.added) {
          if (added instanceof TrackedObjectBase) {
            this.children.push(added);
          }
        }
        for (const removed of e.removed) {
          if (removed instanceof TrackedObjectBase) {
            const idx = this.children.indexOf(removed);
            if (idx >= 0) this.children.splice(idx, 1);
          }
        }
      });

      this._unsubscribers.set(child, unsub);
    }
  }

  untrack(child: Child): void {
    if (child instanceof TrackedCollection) {
      const unsub = this._unsubscribers.get(child);
      if (unsub) {
        unsub();
        this._unsubscribers.delete(child);
      }

      for (const item of child.collection) {
        if (item instanceof TrackedObjectBase) {
          const idx = this.children.indexOf(item);
          if (idx >= 0) this.children.splice(idx, 1);
        }
      }
    }

    const idx = this.children.indexOf(child);
    if (idx >= 0) this.children.splice(idx, 1);
  }

  get allValid(): boolean {
    return this.children.every((c) => c.trakrIsValid);
  }

  dispose(): void {
    for (const unsub of this._unsubscribers.values()) unsub();
  }
}

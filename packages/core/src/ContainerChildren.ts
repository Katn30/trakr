import type { TrackedObjectBase } from "./TrackedObjectBase";
import type { TrackedCollectionBase, TrackedCollectionChanged } from "./TrackedCollection";

/**
 * The children of a container (`TrackedContainer`, `EntityContainer`): the model
 * objects it tracks, the collections it tracks, and those collections' model
 * items, followed as they change. `M` is the container's model type.
 *
 * A child registers itself (`_attachToContainer`): an object as an object, a
 * collection as a collection.
 * @internal
 */
export class ContainerChildren<M extends TrackedObjectBase> {
  private readonly _models: M[] = [];
  private readonly _collections: TrackedCollectionBase<unknown>[] = [];
  private readonly _unsubscribers = new Map<TrackedCollectionBase<unknown>, () => void>();

  /** `isModel` tells a collection's model items from its plain values. */
  constructor(private readonly _isModel: (item: unknown) => item is M) {}

  /** The model objects among the children: tracked objects and collection items. */
  get models(): readonly M[] {
    return this._models;
  }

  trackObject(child: M): void {
    this._models.push(child);
  }

  untrackObject(child: M): void {
    this._remove(child);
  }

  trackCollection(child: TrackedCollectionBase<unknown>): void {
    this._collections.push(child);
    for (const item of child.collection) {
      if (this._isModel(item)) this._models.push(item);
    }
    const unsub = child.changed.subscribe((e: TrackedCollectionChanged<unknown>) => {
      for (const added of e.added) {
        if (this._isModel(added)) this._models.push(added);
      }
      for (const removed of e.removed) {
        if (this._isModel(removed)) this._remove(removed);
      }
    });
    this._unsubscribers.set(child, unsub);
  }

  untrackCollection(child: TrackedCollectionBase<unknown>): void {
    this._unsubscribers.get(child)?.();
    this._unsubscribers.delete(child);
    for (const item of child.collection) {
      if (this._isModel(item)) this._remove(item);
    }
    const idx = this._collections.indexOf(child);
    if (idx >= 0) this._collections.splice(idx, 1);
  }

  /** Releases (or reclaims) the validity of every child: the container left (or re-entered) the model. */
  setReleased(released: boolean): void {
    for (const child of [...this._models, ...this._collections]) child._setValidityReleased(released);
  }

  get allValid(): boolean {
    return this._models.every((c) => c.chronicleIsValid) && this._collections.every((c) => c.chronicleIsValid);
  }

  dispose(): void {
    for (const unsub of this._unsubscribers.values()) unsub();
  }

  private _remove(model: M): void {
    const idx = this._models.indexOf(model);
    if (idx >= 0) this._models.splice(idx, 1);
  }
}

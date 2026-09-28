import { ITracked } from "./ITracked";
import type { Tracker } from "./Tracker";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { TypedEvent } from "./TypedEvent";
import { TrackedObjectBase } from "./TrackedObjectBase";
import { DependencyTracker, COLLECTION_VERSION_KEY } from "./DependencyTracker";
import type { ContainerChildren } from "./ContainerChildren";

/** A collection validator, declared with method syntax so collections stay assignable to `TrackedCollectionBase<unknown>`. */
interface Validates<T> {
  check(value: T[]): string | undefined;
}
export type CollectionValidator<T> = Validates<T>["check"];

/**
 * @internal What every collection shares, whichever tracker it belongs to.
 * Applications use {@link TrackedCollection} (UnitOfWork) or
 * `EventTrackedCollection` (EventLog).
 */
export class TrackedCollectionBase<T> implements Array<T>, ITracked {
  private _collection: T[];
  private _isValid: boolean;
  private _validityReleased = false;
  private _error: string | undefined;
  private readAccess(): void {
    DependencyTracker.record(this, COLLECTION_VERSION_KEY);
  }

  public get chronicleIsValid(): boolean {
    return this._isValid;
  }
  private set chronicleIsValid(value: boolean) {
    const wasValid = this._isValid;
    this._isValid = value;
    if (wasValid !== value && !this._validityReleased) {
      this.tracker._onValidityChanged(!value);
    }
  }

  /** @internal True while the container owning this collection is out of the model. */
  get _isValidityReleased(): boolean {
    return this._validityReleased;
  }

  /**
   * @internal The owning container left (or re-entered) the model: while out,
   * this collection's validity does not count towards `tracker.isValid`.
   */
  _setValidityReleased(released: boolean): void {
    if (this._validityReleased === released) return;
    const apply = (r: boolean) => {
      if (!this._isValid) this.tracker._onValidityChanged(!r);
      this._validityReleased = r;
    };
    this.tracker._doAndTrack(
      () => apply(released),
      () => apply(!released),
      new OperationProperties(this, "__validity__", PropertyType.Object),
    );
  }

  public get length(): number {
    this.readAccess();
    return this._collection.length;
  }

  public get lastItemIndex(): number | undefined {
    this.readAccess();
    return this._collection.length > 0 ? this._collection.length - 1 : undefined;
  }

  /**
   * The items as a plain array, replaced by a new array on every change. Bind
   * to it wherever change detection compares by reference (Angular `OnPush`
   * inputs, signals, a table's data source). Read-only: mutate the collection.
   */
  public get collection(): T[] {
    return this._collection;
  }
  private set collection(value: T[]) {
    this._collection = value;
  }

  public get [Symbol.iterator]() {
    this.readAccess();
    return this.collection[Symbol.iterator].bind(this.collection);
  }

  public get [Symbol.unscopables]() {
    return this.collection[Symbol.unscopables];
  }

  /**
   * Every change of the items — user mutations, undo and redo: the event to
   * refresh views from. Don't write from it: during undo and redo those writes
   * would not be recorded.
   */
  public readonly changed: TypedEvent<TrackedCollectionChanged<T>> =
    new TypedEvent<TrackedCollectionChanged<T>>();

  /**
   * A user mutation, after `changed`: the place for cascading writes, which
   * compose into the same undo step. Never fires during undo or redo.
   */
  public readonly afterChange: TypedEvent<TrackedCollectionChanged<T>> =
    new TypedEvent<TrackedCollectionChanged<T>>();

  [n: number]: T;

  public get error(): string | undefined {
    return this._error;
  }
  private set error(value: string | undefined) {
    this._error = value;
  }

  public constructor(
    public readonly tracker: Tracker,
    items?: T[],
    private readonly _validator?: CollectionValidator<T>,
  ) {
    this._isValid = true;
    this._collection = items ? [...items] : [];
    // `collection[i]` works like an array's: the proxy is the collection from here on.
    const self = new Proxy(this, TrackedCollectionBase._indexAccess<T>());
    self.tracker._trackCollection(self);
    // Part of a model being built: validated once the model is (see construct() / new()).
    if (!self.tracker._isConstructing) self._validate();
    return self;
  }

  /** Array-style index access: `collection[i]` reads an item; assigning replaces it (or appends at the end). */
  private static _indexAccess<T>(): ProxyHandler<TrackedCollectionBase<T>> {
    return {
    // The collection is known by its proxy (`receiver`): its code runs with the proxy as `this`.
    get(target, key, receiver) {
      if (typeof key === "string" && isIndex(key)) {
        target.readAccess.call(receiver);
        return target._collection[Number(key)];
      }
      return Reflect.get(target, key, receiver);
    },
    set(target, key, value, receiver) {
      if (typeof key !== "string" || !isIndex(key)) return Reflect.set(target, key, value, receiver);
      const index = Number(key);
      if (index < target._collection.length) target.replaceAt.call(receiver, index, value);
      else if (index === target._collection.length) target.push.call(receiver, value);
      else throw new RangeError(`Index ${index} is past the end of the collection (length ${target._collection.length})`);
      return true;
    },
    has(target, key) {
      if (typeof key === "string" && isIndex(key)) return Number(key) < target._collection.length;
      return Reflect.has(target, key);
    },
    };
  }

  /** @internal */
  _validate(): void {
    const deps = DependencyTracker.collect(() => {
      this.error = this._validator ? this._validator(this.collection) : undefined;
    });
    DependencyTracker.updateDeps(this, COLLECTION_VERSION_KEY, deps);
    this.chronicleIsValid = this.error === undefined;
  }

  /** @internal A container tracks this collection (`trackChild`): its model items become children too. */
  _attachToContainer(children: ContainerChildren<TrackedObjectBase>, _owner: TrackedObjectBase, _name?: string): void {
    children.trackCollection(this);
  }

  /** @internal */
  _detachFromContainer(children: ContainerChildren<TrackedObjectBase>, _owner: TrackedObjectBase): void {
    children.untrackCollection(this);
  }

  /** @internal */
  _revalidateSelf(property: string | undefined): void {
    // Its validator is about its items; its own bookkeeping writes do not change them.
    if (property === undefined) this._validate();
  }

  /** @internal */
  public _applyValidation(_messages: Map<string, string>): void {
    // Collections validate via validate() using their own validator, not the Registry.
  }

  public splice(start: number, deleteCount: number, ...items: T[]): T[] {
    // Set by the first run, before anything can throw: undo (and a rollback) puts these back.
    let removed: T[] = [];

    this.tracker._doAndTrack(
      () => {
        const taken = this._collection.splice(start, deleteCount, ...items);
        if (!this.tracker._isReplaying) removed = taken;
        this._collection = [...this._collection];
        this.changed._emit(new TrackedCollectionChanged<T>(items, removed, this._collection));
        this.trackRemovedObjectDeletions(removed);
        this.trackAddedObjectInsertions(items);
        if (!this.tracker._isReplaying) {
          this.afterChange._emit(new TrackedCollectionChanged(items, removed, this._collection));
        }
      },
      () => this.undoSplice(start, items, removed),
      new OperationProperties(this, undefined, PropertyType.Collection),
    );

    return removed;
  }

  private trackRemovedObjectDeletions(removed: T[]): void {
    for (const item of removed) {
      if (item instanceof TrackedObjectBase) {
        item._markRemoved();
      }
    }
  }

  private trackAddedObjectInsertions(added: T[]): void {
    for (const item of added) {
      if (item instanceof TrackedObjectBase) {
        item._markAdded();
      }
    }
  }

  private undoSplice(start: number, items: T[], removed: T[]): void {
    this.tracker.withTrackingSuppressed(() => {
      this.collection.splice(start, items.length, ...removed);
      this.collection = [...this.collection];
      const event = new TrackedCollectionChanged<T>(
        removed,
        items,
        this.collection,
      );
      this.changed._emit(event);
    });
  }

  /**
   * Makes `items` the content: one undoable step. Items in both keep their
   * state (at most their order changes); only those that left are removed and
   * those that arrived added. Nothing is recorded if the content is already `items`.
   */
  public reset(items: readonly T[]): void {
    const previous = this._collection;
    const next = [...items];
    const { added, removed } = contentDiff(previous, next);
    if (added.length === 0 && removed.length === 0) {
      this._reorder(next);
      return;
    }
    this.tracker._doAndTrack(
      () => {
        this._collection = [...next];
        this.changed._emit(new TrackedCollectionChanged<T>(added, removed, this._collection));
        this.trackRemovedObjectDeletions(removed);
        this.trackAddedObjectInsertions(added);
        if (!this.tracker._isReplaying) {
          this.afterChange._emit(new TrackedCollectionChanged(added, removed, this._collection));
        }
      },
      () => this.tracker.withTrackingSuppressed(() => {
        this._collection = [...previous];
        this.changed._emit(new TrackedCollectionChanged<T>(removed, added, this._collection));
      }),
      new OperationProperties(this, undefined, PropertyType.Collection),
    );
  }

  /** Reverses the order: one undoable step. Items keep their state (a reordering is not a change to save). */
  public reverse(): T[] {
    this._reorder([...this._collection].reverse());
    return this._collection;
  }

  /** Sorts the items: one undoable step. Items keep their state (a reordering is not a change to save). */
  public sort(compareFn?: (a: T, b: T) => number): this {
    this._reorder([...this._collection].sort(compareFn));
    return this;
  }

  private _reorder(next: T[]): void {
    const previous = this._collection;
    if (next.every((item, i) => item === previous[i])) return;
    const apply = (order: T[]) => {
      this._collection = [...order];
      this.changed._emit(new TrackedCollectionChanged<T>([], [], this._collection));
    };
    this.tracker._doAndTrack(
      () => {
        apply(next);
        if (!this.tracker._isReplaying) this.afterChange._emit(new TrackedCollectionChanged<T>([], [], this._collection));
      },
      () => apply(previous),
      new OperationProperties(this, undefined, PropertyType.Collection),
    );
  }

  public clear(): void {
    if (this.length === 0) {
      return;
    }
    this.splice(0, this.length);
  }

  public remove(item: T): boolean {
    const itemIndex = this.collection.indexOf(item);
    if (itemIndex < 0) {
      return false;
    }

    this.splice(itemIndex, 1);

    return true;
  }

  public replace(item: T, replace: T): boolean {
    const itemIndex = this.collection.indexOf(item);
    if (itemIndex < 0) {
      return false;
    }

    this.splice(itemIndex, 1, replace);

    return true;
  }

  public replaceAt(index: number, replace: T): void {
    this.splice(index, 1, replace);
  }

  public pop(): T | undefined {
    return this.length === 0
      ? undefined
      : this.splice(this.collection.length - 1, 1)[0];
  }

  public push(...items: T[]): number {
    if (!items || items.length === 0) {
      return this.length;
    }
    this.splice((this.lastItemIndex ?? -1) + 1, 0, ...items);

    return this.length;
  }

  public concat(...items: (T | ConcatArray<T>)[]): T[] {
    this.readAccess();
    return this.collection.concat(...items);
  }

  public join(separator?: string): string {
    this.readAccess();
    return this.collection.join(separator);
  }

  public shift(): T | undefined {
    return this.length === 0 ? undefined : this.splice(0, 1)[0];
  }

  public slice(start?: number, end?: number): T[] {
    this.readAccess();
    return this.collection.slice(start, end);
  }

  public unshift(...items: T[]): number {
    this.splice(0, 0, ...items);
    return this.length;
  }

  public indexOf(searchElement: T, fromIndex?: number): number {
    this.readAccess();
    return this.collection.indexOf(searchElement, fromIndex);
  }

  public lastIndexOf(searchElement: T, fromIndex?: number): number {
    this.readAccess();
    return fromIndex !== undefined
      ? this.collection.lastIndexOf(searchElement, fromIndex)
      : this.collection.lastIndexOf(searchElement);
  }

  public every<S extends T>(
    predicate: (value: T, index: number, array: T[]) => value is S,
    thisArg?: unknown,
  ): this is S[];
  public every(
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): boolean;
  public every(
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): boolean {
    this.readAccess();
    const items = this.collection;
    for (let i = 0; i < items.length; i++) {
      if (!predicate.call(thisArg, items[i], i, items)) return false;
    }
    return true;
  }

  public some(
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): boolean {
    this.readAccess();
    return this.collection.some(predicate, thisArg);
  }

  public forEach(
    callbackfn: (value: T, index: number, array: T[]) => void,
    thisArg?: unknown,
  ): void {
    this.readAccess();
    this.collection.forEach(callbackfn, thisArg);
  }

  public map<U>(
    callbackfn: (value: T, index: number, array: T[]) => U,
    thisArg?: unknown,
  ): U[] {
    this.readAccess();
    return this.collection.map(callbackfn, thisArg);
  }

  public filter(
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): T[] {
    this.readAccess();
    return this.collection.filter(predicate, thisArg);
  }

  public find(
    predicate: (value: T, index: number, obj: T[]) => unknown,
    thisArg?: unknown,
  ): T | undefined {
    this.readAccess();
    return this.collection.find(predicate, thisArg);
  }

  public findIndex(
    predicate: (value: T, index: number, obj: T[]) => unknown,
    thisArg?: unknown,
  ): number {
    this.readAccess();
    return this.collection.findIndex(predicate, thisArg);
  }

  public flatMap<U, This = undefined>(
    callback: (
      this: This,
      value: T,
      index: number,
      array: T[],
    ) => U | ReadonlyArray<U>,
    thisArg?: This,
  ): U[] {
    this.readAccess();
    return this.collection.flatMap(callback, thisArg);
  }

  public includes(searchElement: T, fromIndex?: number): boolean {
    this.readAccess();
    return this.collection.includes(searchElement, fromIndex);
  }

  public toString(): string {
    this.readAccess();
    return this.collection.toString();
  }

  public toLocaleString(): string {
    this.readAccess();
    return this.collection.toLocaleString();
  }

  public entries(): ArrayIterator<[number, T]> {
    this.readAccess();
    return this.collection.entries();
  }

  public keys(): ArrayIterator<number> {
    this.readAccess();
    return this.collection.keys();
  }

  public values(): ArrayIterator<T> {
    this.readAccess();
    return this.collection.values();
  }

  public at(index: number): T | undefined {
    this.readAccess();
    return this.collection.at(index);
  }

  public fill(value: T, start?: number, end?: number): this {
    const len = this.length;
    const s =
      start === undefined
        ? 0
        : start < 0
          ? Math.max(len + start, 0)
          : Math.min(start, len);
    const e =
      end === undefined
        ? len
        : end < 0
          ? Math.max(len + end, 0)
          : Math.min(end, len);
    if (s >= e) return this;
    this.splice(s, e - s, ...new Array<T>(e - s).fill(value));
    return this;
  }

  public copyWithin(target: number, start: number, end?: number): this {
    const len = this.length;
    const t = target < 0 ? Math.max(len + target, 0) : Math.min(target, len);
    const s = start < 0 ? Math.max(len + start, 0) : Math.min(start, len);
    const e =
      end === undefined
        ? len
        : end < 0
          ? Math.max(len + end, 0)
          : Math.min(end, len);
    const itemsToCopy = this.collection.slice(s, e);
    const count = Math.min(itemsToCopy.length, len - t);
    if (count > 0) {
      this.splice(t, count, ...itemsToCopy.slice(0, count));
    }
    return this;
  }

  public reduce(
    callbackfn: (
      previousValue: T,
      currentValue: T,
      currentIndex: number,
      array: T[],
    ) => T,
    initialValue?: T,
  ): T {
    this.readAccess();
    return initialValue !== undefined
      ? this.collection.reduce(callbackfn, initialValue)
      : this.collection.reduce(callbackfn);
  }

  public reduceRight(
    callbackfn: (
      previousValue: T,
      currentValue: T,
      currentIndex: number,
      array: T[],
    ) => T,
    initialValue?: T,
  ): T {
    this.readAccess();
    return initialValue !== undefined
      ? this.collection.reduceRight(callbackfn, initialValue)
      : this.collection.reduceRight(callbackfn);
  }

  // The lib types Array.flat with `this: A` (the array itself), so a conforming
  // method cannot name its own items' type: here `A` is this collection.
  public flat<A, D extends number = 1>(this: A, depth?: D): FlatArray<A, D>[] {
    const self = this as unknown as TrackedCollectionBase<unknown>;
    self.readAccess();
    return self.collection.flat(depth) as FlatArray<A, D>[];
  }

  public findLast(
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): T | undefined {
    this.readAccess();
    return this.collection.findLast(predicate, thisArg);
  }

  public findLastIndex(
    predicate: (value: T, index: number, array: T[]) => unknown,
    thisArg?: unknown,
  ): number {
    this.readAccess();
    return this.collection.findLastIndex(predicate, thisArg);
  }

  public toReversed(): T[] {
    this.readAccess();
    return this.collection.toReversed();
  }

  public toSorted(compareFn?: (a: T, b: T) => number): T[] {
    this.readAccess();
    return this.collection.toSorted(compareFn);
  }

  public toSpliced(start: number, deleteCount: number, ...items: T[]): T[] {
    this.readAccess();
    return this.collection.toSpliced(start, deleteCount, ...items);
  }

  public with(index: number, value: T): T[] {
    this.readAccess();
    return this.collection.with(index, value);
  }

  public first(): T | undefined {
    this.readAccess();
    return this._collection.length > 0 ? this._collection[0] : undefined;
  }

  public destroy(): void {
    DependencyTracker.clearDeps(this);
    this.tracker._untrackCollection(this);
    // Gone for good: later changes to it do not count towards isValid.
    this._validityReleased = true;
  }
}

/** Whether `key` is an array index ("0", "1", …). */
/** What `next` has that `previous` has not (`added`), and the reverse (`removed`), counting repeats. */
function contentDiff<T>(previous: readonly T[], next: readonly T[]): { added: T[]; removed: T[] } {
  const counts = new Map<T, number>();
  for (const item of previous) counts.set(item, (counts.get(item) ?? 0) + 1);
  const added: T[] = [];
  for (const item of next) {
    const left = counts.get(item) ?? 0;
    if (left > 0) counts.set(item, left - 1);
    else added.push(item);
  }
  const removed: T[] = [];
  for (const [item, left] of counts) for (let i = 0; i < left; i++) removed.push(item);
  return { added, removed };
}

function isIndex(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key);
}

/** A tracked collection of a UnitOfWork model. An EventLog uses `EventTrackedCollection`. */
export class TrackedCollection<T> extends TrackedCollectionBase<T> {
  public constructor(
    // An EventLog's collections produce events: they are EventTrackedCollections (see `EventLog._eventLog`).
    tracker: Tracker & { readonly _eventLog?: never },
    items?: T[],
    validator?: CollectionValidator<T>,
  ) {
    super(tracker, items, validator);
  }
}

export class TrackedCollectionChanged<T> {
  constructor(
    public readonly added: T[],
    public readonly removed: T[],
    public readonly newCollection: T[],
  ) {}
}

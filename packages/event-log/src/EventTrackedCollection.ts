import type { EventLog } from "./EventLog";
import { TrackedCollectionBase } from "@katn30/chronicle-core";
import type { CollectionValidator, ContainerChildren, TrackedObjectBase } from "@katn30/chronicle-core";
import { TrackedObject } from "./TrackedObject";
import {
  recordItemOrigin,
  clearEventState,
  recordReplayEffect,
  propertyPayload,
} from "./EventRegistry";
import { OperationProperties } from "@katn30/chronicle-core";
import { PropertyType } from "@katn30/chronicle-core";
import {
  getIdentityProperties,
  getIdentityObject,
  getAutoIdProperty,
  readProperty,
} from "@katn30/chronicle-core";
import { getEventMetadata } from "./EventRegistry";

export type CollectionOpKind = "add" | "remove" | "change";

/**
 * Extra fields for an item's entry in the event — e.g. who added it and when.
 * Runs when the item is added, removed or changed (undo and redo included); an
 * entry keeps the fields of what it reports: an item added and then edited
 * before the save keeps those of its addition.
 */
export type CollectionToPayload<T = unknown> = ToPayloadOf<T>["toPayload"];
// Method syntax keeps an `EventTrackedCollection<Task>` usable as an `EventTrackedCollection<unknown>`.
interface ToPayloadOf<T> {
  toPayload(item: T, op: CollectionOpKind): Record<string, unknown>;
}

export interface EventTrackedCollectionOptions<T = unknown> {
  /** Send every change (a list of `{ op, ... }`), not only the net `added` / `removed` / `changed`. */
  history?: boolean;
  toPayload?: CollectionToPayload<T>;
}

/**
 * @internal One recorded change of a history collection. `identity` is the
 * item's `{ idProp: value }`, captured when the op was recorded; `extra` holds
 * the collection's toPayload fields.
 */
export type CollectionOp =
  | { op: "add"; item: TrackedObject; snapshot: Record<string, unknown>; extra?: Record<string, unknown> }
  | { op: "remove"; item: TrackedObject; identity: Record<string, unknown>; extra?: Record<string, unknown> }
  | { op: "change"; item: TrackedObject; identity: Record<string, unknown>; diff: Record<string, unknown>; extra?: Record<string, unknown> };

/**
 * A collection whose changes are events. `name` is its key in the payload: of
 * the container that tracks it (`trackChild`), or of its own event if no
 * container does — then it is a root of the model.
 */
export class EventTrackedCollection<T> extends TrackedCollectionBase<T> {
  private readonly _eventOptions: EventTrackedCollectionOptions<T>;
  private readonly _historyOps: CollectionOp[] = [];
  // Items as last persisted (acknowledged). Pending added/removed = diff against it.
  private readonly _baselineItems: Set<unknown> = new Set();
  private _ownerObject: TrackedObject | undefined;
  // Per item: the toPayload fields of its last addition, removal and change.
  private readonly _extras = new Map<unknown, Partial<Record<CollectionOpKind, Record<string, unknown>>>>();

  public constructor(
    tracker: EventLog,
    public readonly name: string,
    items?: T[],
    validator?: CollectionValidator<T>,
    options?: EventTrackedCollectionOptions<T>,
  ) {
    super(tracker, items, validator);
    this._eventOptions = options ?? {};

    for (const item of this.collection) {
      this._baselineItems.add(item);
      if (item instanceof TrackedObject) {
        recordItemOrigin(item, this);
        this._validateItemHasIdentity(item);
        // Initial items are the persisted baseline — nothing about them is pending.
        clearEventState(item);
      }
    }

    this.changed.subscribe((evt) => {
      for (const item of evt.added) {
        if (item instanceof TrackedObject) {
          recordItemOrigin(item, this);
          this._validateItemHasIdentity(item);
        }
      }
      if (this.tracker._isTrackingSuppressed && !this.tracker._isReplaying) {
        // Silent writes (construct(), withTrackingSuppressed) are not events:
        // like suppressed field writes, they simply become the baseline.
        for (const item of evt.added) this._baselineItems.add(item);
        for (const item of evt.removed) this._baselineItems.delete(item);
        return;
      }
      if (!this._isHistoryMode()) {
        for (const item of evt.added) this._setExtra(item, "add");
        for (const item of evt.removed) this._setExtra(item, "remove");
        return;
      }
      // Replays are handled by the effects recorded on the operation itself.
      if (this.tracker._isReplaying) return;
      const properties = new OperationProperties(this, undefined, PropertyType.Collection);
      for (const item of evt.added) {
        if (item instanceof TrackedObject) this._recordOp("add", item, properties);
      }
      for (const item of evt.removed) {
        if (item instanceof TrackedObject) this._recordOp("remove", item, properties);
      }
    });

    if (this._isHistoryMode() || this._eventOptions.toPayload) {
      this._attachItemChangeWatchers();
    }
  }

  /** @internal The container this collection belongs to, if any (else it is a root). */
  public get _owner(): TrackedObject | undefined {
    return this._ownerObject;
  }

  /** @internal The container that tracks it owns it: its changes go into the container's event. */
  override _attachToContainer(children: ContainerChildren<TrackedObjectBase>, owner: TrackedObject, _name?: string): void {
    if (this._ownerObject !== undefined && this._ownerObject !== owner) {
      throw new Error(
        `EventTrackedCollection "${this.name}" already belongs to a ${this._ownerObject.constructor.name}; ` +
        "a collection has one owner.",
      );
    }
    this._ownerObject = owner;
    super._attachToContainer(children, owner);
  }

  /** @internal */
  override _detachFromContainer(children: ContainerChildren<TrackedObjectBase>, owner: TrackedObject): void {
    if (this._ownerObject === owner) this._ownerObject = undefined;
    super._detachFromContainer(children, owner);
  }

  /** @internal */
  public get _isHistory(): boolean {
    return this._isHistoryMode();
  }

  /** @internal The toPayload fields for `item`'s entry of this `kind`, if any. */
  public _extraFor(item: unknown, kind: CollectionOpKind): Record<string, unknown> | undefined {
    return this._extras.get(item)?.[kind];
  }

  /** @internal Whether a toPayload shapes this collection's entries. */
  public get _hasToPayload(): boolean {
    return this._eventOptions.toPayload !== undefined;
  }

  /** @internal */
  public get _historyOpsList(): CollectionOp[] {
    return this._historyOps;
  }

  /** @internal Forgets pending ops: current items become the baseline. */
  public _clearHistoryOps(): void {
    this._historyOps.length = 0;
    this._rebaseline();
  }

  /** @internal Puts recorded ops back (coalescing reopens them) and undoes their effect on the baseline. */
  public _restoreOps(ops: readonly CollectionOp[]): void {
    // Newest first, so an add followed by a remove of the same item nets out.
    for (const op of [...ops].reverse()) {
      if (op.op === "add") this._baselineItems.delete(op.item);
      else if (op.op === "remove") this._baselineItems.add(op.item);
    }
    this._historyOps.unshift(...ops);
  }

  /** @internal Sets whether `item` counts as already recorded in this collection. */
  public _setInBaseline(item: unknown, present: boolean): void {
    if (present) this._baselineItems.add(item);
    else this._baselineItems.delete(item);
  }

  /** @internal */
  public _isInBaseline(item: unknown): boolean {
    return this._baselineItems.has(item);
  }

  /** @internal */
  public _baselineListSnapshot(): unknown[] {
    return [...this._baselineItems];
  }

  /** @internal */
  public _rebaseline(): void {
    this._baselineItems.clear();
    for (const item of this.collection) this._baselineItems.add(item);
  }

  private _isHistoryMode(): boolean {
    return this._eventOptions.history === true;
  }

  private _setExtra(item: T, kind: CollectionOpKind): void {
    const toPayload = this._eventOptions.toPayload;
    if (!toPayload) return;
    let extras = this._extras.get(item);
    if (!extras) {
      extras = {};
      this._extras.set(item, extras);
    }
    extras[kind] = toPayload(item, kind);
  }

  private _validateItemHasIdentity(item: TrackedObject): void {
    const props = getIdentityProperties(Object.getPrototypeOf(item));
    if (props.length === 0) {
      throw new Error(
        `EventTrackedCollection item type ${item.constructor.name} must declare an @Id or @AutoId property: its events identify it by it`,
      );
    }
  }

  private _attachItemChangeWatchers(): void {
    const watchItem = (item: T & TrackedObject) => {
      item.changed.subscribe((evt) => {
        if (!this.collection.includes(item)) return;
        if (!this._isHistoryMode()) {
          this._setExtra(item, "change");
          return;
        }
        if (this.tracker._isReplaying) return;
        this._recordOp("change", item, new OperationProperties(item, evt.property, PropertyType.Object));
      });
    };
    for (const item of this.collection) {
      if (item instanceof TrackedObject) watchItem(item);
    }
    this.changed.subscribe((evt) => {
      for (const item of evt.added) {
        if (item instanceof TrackedObject) watchItem(item);
      }
    });
  }

  // Undo/redo of the operation appends the op that reverts (or re-applies) this one.
  private _recordOp(kind: CollectionOpKind, item: T & TrackedObject, properties: OperationProperties): void {
    this._historyOps.push(this._buildOp(kind, item));
    recordReplayEffect(this.tracker, properties, (direction) => {
      this._historyOps.push(this._buildOp(direction === "undo" ? invertOpKind(kind) : kind, item));
    });
  }

  private _buildOp(kind: CollectionOpKind, item: T & TrackedObject): CollectionOp {
    const toPayload = this._eventOptions.toPayload;
    const extra = toPayload ? toPayload(item, kind) : undefined;
    if (kind === "add") return { op: kind, item, snapshot: snapshotItemAtRecordTime(item), extra };
    if (kind === "remove") return { op: kind, item, identity: getIdentityObject(item), extra };
    return { op: kind, item, identity: getIdentityObject(item), diff: recordChangeOpDiff(item), extra };
  }
}

function invertOpKind(kind: CollectionOpKind): CollectionOpKind {
  if (kind === "add") return "remove";
  if (kind === "remove") return "add";
  return "change";
}

function recordChangeOpDiff(item: TrackedObject): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const [propName] of getEventMetadata(Object.getPrototypeOf(item))) {
    diff[propName] = propertyPayload(item, propName);
  }
  return diff;
}

function snapshotItemAtRecordTime(item: TrackedObject): Record<string, unknown> {
  const proto = Object.getPrototypeOf(item);
  const meta = getEventMetadata(proto);
  const idProps = getIdentityProperties(proto);
  const autoIdProp = getAutoIdProperty(proto);
  const snap: Record<string, unknown> = {};
  // The server assigns the @AutoId: chronicleId is how the save function reports it back.
  if (autoIdProp) snap.chronicleId = item.chronicleId;
  for (const idProp of idProps) {
    if (idProp === autoIdProp) snap[idProp] = null;
    else snap[idProp] = readProperty(item, idProp);
  }
  for (const [propName] of meta) {
    snap[propName] = propertyPayload(item, propName);
  }
  return snap;
}

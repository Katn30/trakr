import { Tracker } from "./Tracker";
import { TrackedCollection } from "./TrackedCollection";
import { TrackedObject } from "./TrackedObject";
import { EventLifecycleOptions } from "./GeneratedEvent";
import {
  recordItemOrigin,
  peekContext,
  clearEventState,
  recordReplayEffect,
} from "./EventRegistry";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import {
  getIdentityProperties,
  getIdentity,
  getAutoIdProperty,
} from "./ExternallyAssigned";
import { getEventMetadata } from "./EventRegistry";
import { Change } from "./Change";

export type CollectionOpKind = "add" | "remove" | "change";

export interface CollectionHistoryOptions<T = any> {
  /**
   * Builds one history entry. `op` says what happened to `self`; compensating
   * entries emitted by undo-after-commit carry the inverse kind.
   */
  entryFactory: (self: T, change: Change, ctx: unknown, op: CollectionOpKind) => unknown;
}

export type CollectionHistoryConfig = boolean | CollectionHistoryOptions;

export interface EventTrackedCollectionOptions<T = any, TEventType extends string = string>
  extends EventLifecycleOptions<TEventType> {
  eventType?: TEventType;
  history?: CollectionHistoryConfig;
  owner?: { object: TrackedObject; property: string };
}

/** @internal */
export interface CollectionOp {
  op: CollectionOpKind;
  item: TrackedObject;
  identity?: unknown;
  diff?: Record<string, unknown>;
  raw?: unknown;
  snapshot?: Record<string, unknown>;
}

export class EventTrackedCollection<
  T,
  TEventType extends string = string,
> extends TrackedCollection<T> {
  private readonly _eventOptions: EventTrackedCollectionOptions<T, TEventType> | undefined;
  private readonly _historyOps: CollectionOp[] = [];
  // Items as last persisted (acknowledged). Pending added/removed = diff against it.
  private readonly _baselineItems: Set<T> = new Set();

  public constructor(
    tracker: Tracker,
    items?: T[],
    validator?: (value: T[]) => string | undefined,
    options?: EventTrackedCollectionOptions<T, TEventType>,
  ) {
    super(tracker, items, validator);
    this._eventOptions = options;

    for (const item of this.collection) {
      this._baselineItems.add(item);
      if (item instanceof TrackedObject) {
        recordItemOrigin(item, this);
        this._validateItemHasIdentity(item);
        // Initial items are the persisted baseline — nothing about them is pending.
        if (this._eventOptions) clearEventState(item);
      }
    }

    this.changed.subscribe((evt) => {
      for (const item of evt.added) {
        if (item instanceof TrackedObject) {
          recordItemOrigin(item, this);
          this._validateItemHasIdentity(item);
        }
      }
      // Replays are handled by the effects recorded on the operation itself.
      if (this.tracker._isReplaying) return;
      if (this.tracker._isTrackingSuppressed) {
        // Silent writes (construct(), withTrackingSuppressed) are not events:
        // like suppressed field writes, they simply become the baseline.
        for (const item of evt.added) this._baselineItems.add(item);
        for (const item of evt.removed) this._baselineItems.delete(item);
        return;
      }
      if (!this._isHistoryMode()) return;
      const properties = new OperationProperties(this, undefined, PropertyType.Collection);
      for (const item of evt.added) {
        if (item instanceof TrackedObject) this._recordOp("add", item, properties);
      }
      for (const item of evt.removed) {
        if (item instanceof TrackedObject) this._recordOp("remove", item, properties);
      }
    });

    // For history mode, watch item property changes to record change ops.
    if (this._isHistoryMode()) {
      this._attachItemChangeWatchers();
    }
  }

  /** @internal */
  public get _lifecycleOptions(): EventLifecycleOptions<TEventType> | undefined {
    if (!this._eventOptions) return undefined;
    if (this._isAggregateMode()) return undefined;
    return {
      itemAdded: this._eventOptions.itemAdded,
      itemRemoved: this._eventOptions.itemRemoved,
    };
  }

  /** @internal */
  public get _aggregateOptions(): EventTrackedCollectionOptions<T, TEventType> | undefined {
    return this._isAggregateMode() ? this._eventOptions : undefined;
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
      if (op.op === "add") this._baselineItems.delete(op.item as unknown as T);
      else if (op.op === "remove") this._baselineItems.add(op.item as unknown as T);
    }
    this._historyOps.unshift(...ops);
  }

  /** @internal Sets whether `item` counts as already recorded in this collection. */
  public _setInBaseline(item: T, present: boolean): void {
    if (present) this._baselineItems.add(item);
    else this._baselineItems.delete(item);
  }

  /** @internal */
  public _isInBaseline(item: T): boolean {
    return this._baselineItems.has(item);
  }

  /** @internal */
  public _baselineListSnapshot(): T[] {
    return [...this._baselineItems];
  }

  /** @internal */
  public _rebaseline(): void {
    this._baselineItems.clear();
    for (const item of this.collection) this._baselineItems.add(item);
  }

  private _isAggregateMode(): boolean {
    if (!this._eventOptions) return false;
    return (
      this._eventOptions.eventType !== undefined ||
      this._eventOptions.history !== undefined
    );
  }

  private _isHistoryMode(): boolean {
    return !!this._eventOptions?.history;
  }

  private _validateItemHasIdentity(item: TrackedObject): void {
    const props = getIdentityProperties(Object.getPrototypeOf(item));
    if (props.length === 0) {
      throw new Error(
        `EventTrackedCollection item type ${item.constructor.name} must declare at least one @Id or @AutoId property when used with eventType or history mode`,
      );
    }
  }

  private _attachItemChangeWatchers(): void {
    const watchItem = (item: TrackedObject) => {
      item.changed.subscribe((evt) => {
        if (this.tracker._isReplaying) return;
        if (!this.collection.includes(item as unknown as T)) return;
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
  private _recordOp(kind: CollectionOpKind, item: TrackedObject, properties: OperationProperties): void {
    this._historyOps.push(this._buildOp(kind, item));
    recordReplayEffect(this.tracker, properties, (direction) => {
      this._historyOps.push(this._buildOp(direction === "undo" ? invertOpKind(kind) : kind, item));
    });
  }

  private _buildOp(kind: CollectionOpKind, item: TrackedObject): CollectionOp {
    const opts = this._eventOptions;
    if (typeof opts?.history === "object" && opts.history.entryFactory) {
      const ctx = peekContext(this.tracker);
      const change = { time: new Date() } as unknown as Change;
      return { op: kind, item, raw: opts.history.entryFactory(item as any, change, ctx, kind) };
    }
    if (kind === "add") return { op: kind, item, snapshot: snapshotItemAtRecordTime(item) };
    if (kind === "remove") return { op: kind, item, identity: getIdentity(item) };
    return { op: kind, item, identity: getIdentity(item), diff: this._recordChangeOpDiff(item) };
  }

  private _recordChangeOpDiff(item: TrackedObject): Record<string, unknown> {
    const proto = Object.getPrototypeOf(item);
    const meta = getEventMetadata(proto);
    const rec = item as unknown as Record<string, unknown>;
    const diff: Record<string, unknown> = {};
    for (const [propName] of meta) {
      const v = rec[propName];
      diff[propName] = v === undefined ? null : v;
    }
    return diff;
  }
}

function invertOpKind(kind: CollectionOpKind): CollectionOpKind {
  if (kind === "add") return "remove";
  if (kind === "remove") return "add";
  return "change";
}

function snapshotItemAtRecordTime(item: TrackedObject): Record<string, unknown> {
  const proto = Object.getPrototypeOf(item);
  const meta = getEventMetadata(proto);
  const idProps = getIdentityProperties(proto);
  const autoIdProp = getAutoIdProperty(proto);
  const rec = item as unknown as Record<string, unknown>;
  const snap: Record<string, unknown> = {};
  for (const idProp of idProps) {
    if (idProp === autoIdProp) snap[idProp] = null;
    else snap[idProp] = rec[idProp];
  }
  for (const [propName] of meta) {
    const v = rec[propName];
    snap[propName] = v === undefined ? null : v;
  }
  return snap;
}

import { Tracker } from "./Tracker";
import { TrackedCollection } from "./TrackedCollection";
import { TrackedObject } from "./TrackedObject";
import { EventLifecycleOptions } from "./GeneratedEvent";
import {
  recordItemOrigin,
  HistoryConfig,
  HistoryOptions,
  peekContext,
} from "./EventRegistry";
import {
  getIdentityProperties,
  getIdentity,
  getAutoIdProperty,
} from "./ExternallyAssigned";
import { getEventMetadata } from "./EventRegistry";
import { Change } from "./Change";

export interface CollectionHistoryOptions<T = any> {
  entryFactory: (self: T, change: Change, ctx?: unknown) => unknown;
}

export type CollectionHistoryConfig = boolean | CollectionHistoryOptions;

export interface EventTrackedCollectionOptions<T = any, TEventType extends string = string>
  extends EventLifecycleOptions<TEventType> {
  eventType?: TEventType;
  history?: CollectionHistoryConfig;
  owner?: { object: TrackedObject; property: string };
}

interface CollectionOp {
  op: "add" | "remove" | "change";
  item?: TrackedObject;
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
      }
    }

    this.changed.subscribe((evt) => {
      for (const item of evt.added) {
        if (item instanceof TrackedObject) {
          recordItemOrigin(item, this);
          this._validateItemHasIdentity(item);
        }
      }
      if (this._isAggregateMode() && !this.tracker._isReplaying) {
        for (const item of evt.added) {
          if (item instanceof TrackedObject) {
            this._recordAddOp(item);
          }
        }
        for (const item of evt.removed) {
          if (item instanceof TrackedObject) {
            this._recordRemoveOp(item);
          }
        }
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

  /** @internal */
  public _clearHistoryOps(): void {
    this._historyOps.length = 0;
    // Rebaseline: current collection items become baseline.
    this._baselineItems.clear();
    for (const item of this.collection) this._baselineItems.add(item);
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
      item.changed.subscribe((_evt) => {
        // Only record if item is currently in the collection AND we're not replaying.
        if (this.tracker._isReplaying) return;
        if (!this.collection.includes(item as unknown as T)) return;
        this._recordChangeOp(item);
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

  private _recordAddOp(item: TrackedObject): void {
    const opts = this._eventOptions;
    if (typeof opts?.history === "object" && opts.history.entryFactory) {
      const ctx = peekContext(this.tracker);
      const change = { time: new Date() } as unknown as Change;
      this._historyOps.push({
        op: "add",
        raw: opts.history.entryFactory(item as any, change, ctx),
      });
    } else if (opts?.history === true) {
      this._historyOps.push({ op: "add", item, snapshot: snapshotItemAtRecordTime(item) });
    }
  }

  private _recordRemoveOp(item: TrackedObject): void {
    const opts = this._eventOptions;
    const identity = getIdentity(item);
    if (typeof opts?.history === "object" && opts.history.entryFactory) {
      const ctx = peekContext(this.tracker);
      const change = { time: new Date() } as unknown as Change;
      this._historyOps.push({
        op: "remove",
        raw: opts.history.entryFactory(item as any, change, ctx),
      });
    } else if (opts?.history === true) {
      this._historyOps.push({ op: "remove", identity });
    }
  }

  private _recordChangeOpDiff(item: TrackedObject): Record<string, unknown> {
    const proto = Object.getPrototypeOf(item);
    const idProps = getIdentityProperties(proto);
    const meta = getEventMetadata(proto);
    const rec = item as unknown as Record<string, unknown>;
    const diff: Record<string, unknown> = {};
    for (const [propName] of meta) {
      if (idProps.includes(propName)) continue;
      const v = rec[propName];
      diff[propName] = v === undefined ? null : v;
    }
    return diff;
  }

  private _recordChangeOp(item: TrackedObject): void {
    const opts = this._eventOptions;
    if (typeof opts?.history === "object" && opts.history.entryFactory) {
      const ctx = peekContext(this.tracker);
      const change = { time: new Date() } as unknown as Change;
      this._historyOps.push({
        op: "change",
        raw: opts.history.entryFactory(item as any, change, ctx),
      });
    } else if (opts?.history === true) {
      const identity = getIdentity(item);
      const diff = this._recordChangeOpDiff(item);
      this._historyOps.push({ op: "change", identity, item, diff });
    }
  }
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
    if (idProps.includes(propName)) continue;
    const v = rec[propName];
    snap[propName] = v === undefined ? null : v;
  }
  return snap;
}

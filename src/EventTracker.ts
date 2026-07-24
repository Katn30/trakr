import { Tracker } from "./Tracker";
import { TrackedObject } from "./TrackedObject";
import { State } from "./State";
import {
  IdAssignment,
  getAutoIdProperty,
  getIdentity,
  getIdentityObject,
  getIdentityProperties,
} from "./ExternallyAssigned";
import { GeneratedEvent } from "./GeneratedEvent";
import {
  EventTrackedCollection,
  EventTrackedCollectionOptions,
} from "./EventTrackedCollection";
import {
  getEventMetadata,
  getEventState,
  getHistoryState,
  clearEventState,
  getItemOrigin,
  pushContext,
  popContext,
  DEFAULT_GROUP,
} from "./EventRegistry";

export class EventTracker extends Tracker {
  public withContext<T>(ctx: unknown, action: () => T): T {
    pushContext(this, ctx);
    try {
      return action();
    } finally {
      popContext(this);
    }
  }

  public override onCommit<V = number>(keys?: IdAssignment<V>[]): void {
    super.onCommit(keys);
    for (const obj of this.trackedObjects) {
      clearEventState(obj);
    }
    for (const col of this.trackedCollections) {
      if (col instanceof EventTrackedCollection) {
        (col as EventTrackedCollection<unknown>)._clearHistoryOps();
      }
    }
  }

  public generateEvents<TEventType extends string = string>(): GeneratedEvent<TEventType>[] {
    const events: GeneratedEvent<TEventType>[] = [];

    // Legacy per-op events for collections in itemAdded/itemRemoved-only mode.
    for (const obj of this.trackedObjects) {
      const origin = getItemOrigin(obj) as EventTrackedCollection<unknown> | undefined;
      if (!origin) continue;
      const legacy = origin._lifecycleOptions;
      if (!legacy) continue;

      const meta = getEventMetadata(Object.getPrototypeOf(obj));
      switch (obj.state) {
        case State.Insert:
          if (legacy.itemAdded) {
            events.push(buildItemAddedEvent<TEventType>(obj, meta, legacy.itemAdded));
          }
          break;
        case State.Deleted:
          if (legacy.itemRemoved) {
            events.push(buildItemRemovedEvent<TEventType>(obj, legacy.itemRemoved));
          }
          break;
        case State.Changed:
          pushFieldClusterEvents<TEventType>(obj, meta, events);
          break;
      }
    }

    // Aggregate: index owned collections by owner
    const ownedCollections = new Map<TrackedObject, EventTrackedCollection<unknown>[]>();
    for (const col of this.trackedCollections) {
      if (!(col instanceof EventTrackedCollection)) continue;
      const agg = (col as EventTrackedCollection<unknown>)._aggregateOptions;
      if (!agg?.owner) continue;
      const owner = agg.owner.object;
      let list = ownedCollections.get(owner);
      if (!list) {
        list = [];
        ownedCollections.set(owner, list);
      }
      list.push(col as EventTrackedCollection<unknown>);
    }

    // Top-level events for objects not inside a collection
    for (const obj of this.trackedObjects) {
      const origin = getItemOrigin(obj);
      if (origin) continue;

      const groups = new Map<string, Record<string, unknown>>();
      const meta = getEventMetadata(Object.getPrototypeOf(obj));

      const stateMap = getEventState(obj);
      const historyMap = getHistoryState(obj);
      for (const [propName, propMeta] of meta) {
        const group = propMeta.eventType ?? DEFAULT_GROUP;
        if (propMeta.history) {
          const chain = historyMap.get(propName);
          if (chain && chain.length > 0) {
            addToGroup(groups, group, propName, [...chain]);
          }
        } else {
          const entry = stateMap.get(propName);
          if (entry) {
            addToGroup(groups, group, propName, normalizeValue(entry.currentValue));
          }
        }
      }

      const owned = ownedCollections.get(obj) ?? [];
      for (const col of owned) {
        const slot = computeCollectionSlot(col, this);
        if (slot === undefined) continue;
        const agg = col._aggregateOptions!;
        const group = agg.eventType ?? DEFAULT_GROUP;
        const propertyName = agg.owner!.property;
        addToGroup(groups, group, propertyName, slot);
      }

      if (groups.size === 0) continue;

      const identity = getIdentity(obj);
      for (const [group, payload] of groups) {
        const event: GeneratedEvent<TEventType> = {
          eventType: group as TEventType,
          payload,
          trackingId: obj.trackingId,
        };
        if (identity !== undefined) {
          event.targetId = identity;
        }
        events.push(event);
      }
    }

    // Standalone aggregate collections (no owner) — emit their own event
    for (const col of this.trackedCollections) {
      if (!(col instanceof EventTrackedCollection)) continue;
      const agg = (col as EventTrackedCollection<unknown>)._aggregateOptions;
      if (!agg || agg.owner) continue;
      const slot = computeCollectionSlot(col as EventTrackedCollection<unknown>, this);
      if (slot === undefined) continue;
      const eventType = (agg.eventType ?? DEFAULT_GROUP) as TEventType;
      events.push({
        eventType,
        payload: slot as Record<string, unknown>,
      });
    }

    return events;
  }
}

function addToGroup(
  groups: Map<string, Record<string, unknown>>,
  group: string,
  key: string,
  value: unknown,
): void {
  let payload = groups.get(group);
  if (!payload) {
    payload = {};
    groups.set(group, payload);
  }
  payload[key] = value;
}

function buildItemAddedEvent<TEventType extends string>(
  obj: TrackedObject,
  meta: Map<string, { eventType?: string }>,
  eventType: string,
): GeneratedEvent<TEventType> {
  const payload: Record<string, unknown> = {};
  for (const [propertyName] of meta) {
    const value = (obj as unknown as Record<string, unknown>)[propertyName];
    payload[propertyName] = normalizeValue(value);
  }
  return {
    eventType: eventType as TEventType,
    payload,
    trackingId: obj.trackingId,
  };
}

function buildItemRemovedEvent<TEventType extends string>(
  obj: TrackedObject,
  eventType: string,
): GeneratedEvent<TEventType> {
  const autoIdProp = getAutoIdProperty(Object.getPrototypeOf(obj));
  const targetId = autoIdProp
    ? (obj as unknown as Record<string, unknown>)[autoIdProp]
    : undefined;
  const event: GeneratedEvent<TEventType> = {
    eventType: eventType as TEventType,
    payload: {},
  };
  if (typeof targetId === "number") {
    event.targetId = targetId;
  }
  return event;
}

function pushFieldClusterEvents<TEventType extends string>(
  obj: TrackedObject,
  meta: Map<string, { eventType?: string }>,
  events: GeneratedEvent<TEventType>[],
): void {
  const state = getEventState(obj);
  if (state.size === 0) return;

  const grouped = new Map<string, string[]>();
  for (const [propertyName, propMeta] of meta) {
    if (!state.has(propertyName)) continue;
    if (!propMeta.eventType) continue;
    let bucket = grouped.get(propMeta.eventType);
    if (!bucket) {
      bucket = [];
      grouped.set(propMeta.eventType, bucket);
    }
    bucket.push(propertyName);
  }

  const autoIdProp = getAutoIdProperty(Object.getPrototypeOf(obj));
  const targetIdRaw = autoIdProp
    ? (obj as unknown as Record<string, unknown>)[autoIdProp]
    : undefined;

  for (const [eventType, propertyNames] of grouped) {
    const payload: Record<string, unknown> = {};
    for (const propertyName of propertyNames) {
      payload[propertyName] = normalizeValue(state.get(propertyName)!.currentValue);
    }
    const event: GeneratedEvent<TEventType> = {
      eventType: eventType as TEventType,
      payload,
      trackingId: obj.trackingId,
    };
    if (typeof targetIdRaw === "number") {
      event.targetId = targetIdRaw;
    }
    events.push(event);
  }
}

function computeCollectionSlot(
  col: EventTrackedCollection<unknown>,
  tracker: EventTracker,
): unknown | undefined {
  const agg = col._aggregateOptions!;
  const isHistory = agg.history !== undefined && agg.history !== false;
  if (isHistory) return computeHistoryOps(col, agg);
  return computeBucketedSlot(col, tracker);
}

function computeHistoryOps(
  col: EventTrackedCollection<unknown>,
  agg: EventTrackedCollectionOptions,
): unknown {
  const opsList = col._historyOpsList;
  const hasFactory =
    typeof agg.history === "object" && (agg.history as any).entryFactory;

  const ops: unknown[] = [];
  for (const op of opsList) {
    if (hasFactory) {
      ops.push(op.raw);
      continue;
    }
    if (op.op === "add") {
      ops.push({ op: "add", item: op.snapshot ?? (op.item ? snapshotItemForAdded(op.item) : {}) });
    } else if (op.op === "remove") {
      const idObj = op.identity && typeof op.identity === "object"
        ? (op.identity as Record<string, unknown>)
        : identityToSingleKeyObject(op.identity, col);
      ops.push({ op: "remove", ...idObj });
    } else if (op.op === "change" && op.item) {
      const idObj = getIdentityObject(op.item);
      const diff = op.diff ?? computeItemDiff(op.item);
      ops.push({ op: "change", ...idObj, ...diff });
    }
  }

  if (ops.length === 0) return undefined;
  return { ops };
}

function identityToSingleKeyObject(
  identity: unknown,
  col: EventTrackedCollection<unknown>,
): Record<string, unknown> {
  const baseline = col._baselineListSnapshot();
  const sample = baseline.find((i) => i instanceof TrackedObject) as
    | TrackedObject
    | undefined;
  const currentSample = col.collection.find(
    (i) => i instanceof TrackedObject,
  ) as TrackedObject | undefined;
  const proto = sample
    ? Object.getPrototypeOf(sample)
    : currentSample
      ? Object.getPrototypeOf(currentSample)
      : undefined;
  if (!proto) return {};
  const props = getIdentityProperties(proto);
  if (props.length === 1) return { [props[0]]: identity };
  return identity && typeof identity === "object"
    ? (identity as Record<string, unknown>)
    : {};
}

function computeBucketedSlot(
  col: EventTrackedCollection<unknown>,
  tracker: EventTracker,
): unknown | undefined {
  const added: unknown[] = [];
  const changed: unknown[] = [];
  const removed: unknown[] = [];

  const isPrimitive = !hasTrackedObjectItems(col);

  for (const item of col.collection) {
    if (item instanceof TrackedObject) {
      if (item.state === State.Insert) {
        added.push(snapshotItemForAdded(item));
      } else if (item.state === State.Changed) {
        const entry = buildChangedEntry(item);
        if (entry) changed.push(entry);
      }
    }
  }

  if (isPrimitive) {
    for (const item of col.collection) {
      if (!col._isInBaseline(item)) added.push(item);
    }
    for (const baselineItem of col._baselineListSnapshot()) {
      if (!col.collection.includes(baselineItem)) removed.push(baselineItem);
    }
  } else {
    for (const obj of tracker.trackedObjects) {
      if (obj.state !== State.Deleted) continue;
      if (getItemOrigin(obj) !== col) continue;
      const identity = getIdentity(obj);
      removed.push(identity);
    }
  }

  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    return undefined;
  }

  const slot: Record<string, unknown> = { added, removed };
  if (!isPrimitive) slot.changed = changed;
  return slot;
}

function hasTrackedObjectItems(col: EventTrackedCollection<unknown>): boolean {
  for (const item of col.collection) {
    if (item instanceof TrackedObject) return true;
  }
  for (const item of col._baselineListSnapshot()) {
    if (item instanceof TrackedObject) return true;
  }
  return false;
}

function snapshotItemForAdded(item: TrackedObject): Record<string, unknown> {
  const proto = Object.getPrototypeOf(item);
  const meta = getEventMetadata(proto);
  const idProps = getIdentityProperties(proto);
  const autoIdProp = getAutoIdProperty(proto);
  const snapshot: Record<string, unknown> = {};

  const rec = item as unknown as Record<string, unknown>;
  for (const idProp of idProps) {
    if (idProp === autoIdProp) {
      snapshot[idProp] = null;
    } else {
      snapshot[idProp] = rec[idProp];
    }
  }
  for (const [propName] of meta) {
    if (idProps.includes(propName)) continue;
    snapshot[propName] = normalizeValue(rec[propName]);
  }
  return snapshot;
}

function buildChangedEntry(item: TrackedObject): Record<string, unknown> | undefined {
  const state = getEventState(item);
  const history = getHistoryState(item);
  if (state.size === 0 && history.size === 0) return undefined;

  const proto = Object.getPrototypeOf(item);
  const idProps = getIdentityProperties(proto);
  const rec = item as unknown as Record<string, unknown>;

  const entry: Record<string, unknown> = {};
  for (const idProp of idProps) {
    entry[idProp] = rec[idProp];
  }
  for (const [propName, e] of state) {
    if (idProps.includes(propName)) continue;
    entry[propName] = normalizeValue(e.currentValue);
  }
  for (const [propName, chain] of history) {
    if (idProps.includes(propName)) continue;
    entry[propName] = [...chain];
  }
  return entry;
}

function computeItemDiff(item: TrackedObject): Record<string, unknown> {
  const state = getEventState(item);
  const proto = Object.getPrototypeOf(item);
  const idProps = getIdentityProperties(proto);
  const diff: Record<string, unknown> = {};
  for (const [propName, e] of state) {
    if (idProps.includes(propName)) continue;
    diff[propName] = normalizeValue(e.currentValue);
  }
  return diff;
}

function normalizeValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

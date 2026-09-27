import { TrackedObject } from "./TrackedObject";
import type { EventTrackedCollection } from "./EventTrackedCollection";
import type { Tracker } from "@katn30/chronicle-core";
import { OperationProperties } from "@katn30/chronicle-core";
import { PropertyType } from "@katn30/chronicle-core";
import { getAutoIdProperty, getIdentityProperties, ClassMetadata, readProperty } from "@katn30/chronicle-core";


/**
 * Builds what a property puts in the event — e.g. the value along with who
 * changed it and when. Runs whenever the value changes (undo and redo included):
 * the event carries the result of the latest change.
 */
export type PropertyToPayload<TSelf = TrackedObject, TValue = unknown> = ToPayloadOf<TSelf, TValue>["toPayload"];
interface ToPayloadOf<TSelf, TValue> {
  toPayload(self: TSelf, newValue: TValue, oldValue: TValue): unknown;
}

export interface EventPropertyOptions {
  /** Send every change of the property (a list), not only its latest value. */
  history?: boolean;
  coalesceWithin?: number;
  toPayload?: PropertyToPayload;
}

type EventMetadataMap = Map<string, EventPropertyOptions>;

interface EventFieldEntry {
  originalValue: unknown;
  currentValue: unknown;
}

const instanceState = new WeakMap<TrackedObject, Map<string, EventFieldEntry>>();
const instanceHistory = new WeakMap<TrackedObject, Map<string, unknown[]>>();
const instanceHistoryTimes = new WeakMap<TrackedObject, Map<string, number>>();
// Per object and property: the value toPayload last ran for, and its result.
const instancePayloads = new WeakMap<TrackedObject, Map<string, { value: unknown; payload: unknown }>>();
const subscribedInstances = new WeakSet<TrackedObject>();
// Every event collection an item has belonged to (an item can move between collections).
const itemOrigins = new WeakMap<TrackedObject, Set<EventTrackedCollection<unknown>>>();

// ------------------------------------------------------------------ replay effects

/**
 * History entries and collection ops are pending-entry lists, not diffs, so an
 * undo/redo cannot be derived by comparing values. Each write therefore chains
 * an effect onto its own action in the operation: undoing/redoing exactly that
 * operation appends the entry that reverts (or re-applies) the write. Whether
 * the resulting event is withdrawn or kept as a compensation is decided by the
 * EventLog, which settles these lists after every operation.
 */
export function recordReplayEffect(
  tracker: Tracker,
  properties: OperationProperties,
  append: (direction: "undo" | "redo") => void,
): void {
  tracker._recordSideEffect(() => append("redo"), () => append("undo"), properties);
}

const eventMetadata = new ClassMetadata<EventMetadataMap>(() => new Map());

export function registerEventProperty(
  proto: object,
  property: string,
  options: EventPropertyOptions,
): void {
  const own = eventMetadata.own(proto);
  if (!own.has(property)) own.set(property, options);
}

/** The @EventTracked properties of `proto`'s class and its bases; a base class's options win. */
export function getEventMetadata(proto: object): EventMetadataMap {
  const merged: EventMetadataMap = new Map();
  for (const own of eventMetadata.chain(proto).reverse()) {
    own.forEach((options, property) => {
      if (!merged.has(property)) merged.set(property, options);
    });
  }
  return merged;
}

// ------------------------------------------------------------------ instance subscription

export function ensureEventStateSubscription(target: TrackedObject): void {
  if (subscribedInstances.has(target)) return;
  subscribedInstances.add(target);
  target.changed.subscribe((evt) => {
    const meta = getEventMetadata(Object.getPrototypeOf(target));
    // Every tracked property of an EventLog model is an @EventTracked one.
    const propMeta = meta.get(evt.property)!;

    if (propMeta.toPayload) {
      let payloads = instancePayloads.get(target);
      if (!payloads) {
        payloads = new Map();
        instancePayloads.set(target, payloads);
      }
      payloads.set(evt.property, { value: evt.newValue, payload: propMeta.toPayload(target, evt.newValue, evt.oldValue) });
    }

    if (propMeta.history) {
      // Replays are handled by the effect recorded on the operation itself.
      if (target.tracker._isReplaying) return;
      appendHistoryEntry(
        target,
        evt.property,
        evt.newValue,
        evt.oldValue,
        propMeta,
      );
    } else {
      updateFinalValue(target, evt.property, evt.newValue, evt.oldValue);
    }
  });
}

function updateFinalValue(
  target: TrackedObject,
  property: string,
  newValue: unknown,
  oldValue: unknown,
): void {
  const state = getOrCreateEventState(target);
  let entry = state.get(property);
  if (!entry) {
    entry = { originalValue: oldValue, currentValue: newValue };
    state.set(property, entry);
  } else {
    entry.currentValue = newValue;
  }
  if (entry.currentValue === entry.originalValue) {
    state.delete(property);
  }
}

function appendHistoryEntry(
  target: TrackedObject,
  property: string,
  newValue: unknown,
  oldValue: unknown,
  propMeta: EventPropertyOptions,
): void {
  const { coalesceWithin } = propMeta;
  const chains = getOrCreateHistoryState(target);
  let chain = chains.get(property);
  if (!chain) {
    chain = [];
    chains.set(property, chain);
  }

  const times = getOrCreateHistoryTimes(target);
  const now = Date.now();
  const lastTime = times.get(property);
  const shouldReplace =
    coalesceWithin !== undefined &&
    lastTime !== undefined &&
    now - lastTime < coalesceWithin &&
    chain.length > 0;

  const entry = createHistoryEntry(target, property, newValue, oldValue, propMeta);
  if (shouldReplace) chain[chain.length - 1] = entry;
  else chain.push(entry);
  times.set(property, now);

  recordReplayEffect(
    target.tracker,
    new OperationProperties(target, property, PropertyType.Object),
    (direction) => {
      const [value, previous] = direction === "undo" ? [oldValue, newValue] : [newValue, oldValue];
      // Looked up on every replay: settling after each operation replaces the chains map.
      const chains = getOrCreateHistoryState(target);
      chains.set(property, [...(chains.get(property) ?? []), createHistoryEntry(target, property, value, previous, propMeta)]);
      // A replay breaks any coalescing window: the next write starts a new entry.
      instanceHistoryTimes.get(target)?.delete(property);
    },
  );
}

function createHistoryEntry(
  target: TrackedObject,
  property: string,
  newValue: unknown,
  oldValue: unknown,
  propMeta: EventPropertyOptions,
): unknown {
  if (propMeta.toPayload) return propMeta.toPayload(target, newValue, oldValue);
  return { property, value: payloadValue(newValue) };
}

function getOrCreateHistoryTimes(target: TrackedObject): Map<string, number> {
  let times = instanceHistoryTimes.get(target);
  if (!times) {
    times = new Map<string, number>();
    instanceHistoryTimes.set(target, times);
  }
  return times;
}

function getOrCreateEventState(target: TrackedObject): Map<string, EventFieldEntry> {
  let state = instanceState.get(target);
  if (!state) {
    state = new Map<string, EventFieldEntry>();
    instanceState.set(target, state);
  }
  return state;
}

function getOrCreateHistoryState(target: TrackedObject): Map<string, unknown[]> {
  let state = instanceHistory.get(target);
  if (!state) {
    state = new Map<string, unknown[]>();
    instanceHistory.set(target, state);
  }
  return state;
}

export function getEventState(target: TrackedObject): Map<string, EventFieldEntry> {
  return instanceState.get(target) ?? new Map<string, EventFieldEntry>();
}

export function getHistoryState(target: TrackedObject): Map<string, unknown[]> {
  return instanceHistory.get(target) ?? new Map<string, unknown[]>();
}

export function clearEventState(target: TrackedObject): void {
  instanceState.delete(target);
  instanceHistory.delete(target);
  instanceHistoryTimes.delete(target);
}

/**
 * Moves the persisted baseline of a non-history field to `persistedValue`.
 * The field stays pending only if its current value differs from it — which is
 * how writes landing while the save was in flight survive the ack.
 */
export function ackFieldValue(target: TrackedObject, property: string, persistedValue: unknown): void {
  const state = getOrCreateEventState(target);
  const current = readProperty(target, property);
  if (current === persistedValue) {
    state.delete(property);
    return;
  }
  const entry = state.get(property);
  if (entry) {
    entry.originalValue = persistedValue;
  } else {
    state.set(property, { originalValue: persistedValue, currentValue: current });
  }
}

/**
 * Forgets what an operation changed once its events are recorded: field diffs
 * and history chains start empty for the next operation. Coalescing timestamps
 * are kept so a following write can still merge into the same operation.
 */
export function settleEventState(target: TrackedObject): void {
  instanceState.delete(target);
  instanceHistory.delete(target);
}

/** Puts recorded history entries back at the front of the chain (coalescing reopens them). */
export function restoreHistoryEntries(target: TrackedObject, property: string, entries: readonly unknown[]): void {
  const chains = getOrCreateHistoryState(target);
  chains.set(property, [...entries, ...(chains.get(property) ?? [])]);
}

export function recordItemOrigin(item: TrackedObject, collection: EventTrackedCollection<unknown>): void {
  let origins = itemOrigins.get(item);
  if (!origins) {
    origins = new Set();
    itemOrigins.set(item, origins);
  }
  origins.add(collection);
}

/** The event collections `item` has belonged to, oldest first (empty for top-level objects). */
export function getItemOrigins(item: TrackedObject): ReadonlySet<EventTrackedCollection<unknown>> {
  return itemOrigins.get(item) ?? new Set();
}

// ------------------------------------------------------------------ payload values

/**
 * How a property value is written into an event payload: `undefined` becomes
 * `null`, and a tracked object becomes a snapshot of it — its identity
 * (`chronicleId` too for `@AutoId` objects, whose id the server assigns) and its
 * `@EventTracked` fields, recursively. A cycle is cut to the identity alone.
 */
export function payloadValue(value: unknown, seen: Set<object> = new Set()): unknown {
  if (value === undefined) return null;
  if (!(value instanceof TrackedObject)) return value;
  const proto = Object.getPrototypeOf(value);
  const autoIdProp = getAutoIdProperty(proto);
  const snapshot: Record<string, unknown> = {};
  if (autoIdProp) snapshot.chronicleId = value.chronicleId;
  for (const idProp of getIdentityProperties(proto)) snapshot[idProp] = readProperty(value, idProp) ?? null;
  if (seen.has(value)) return snapshot;
  seen.add(value);
  for (const [propName] of getEventMetadata(proto)) snapshot[propName] = propertyPayload(value, propName, seen);
  return snapshot;
}

/**
 * What `obj.property` puts in an event: the result of its `toPayload` for the
 * current value, or the value itself (see {@link payloadValue}).
 */
export function propertyPayload(obj: TrackedObject, property: string, seen?: Set<object>): unknown {
  const value = readProperty(obj, property);
  const toPayload = getEventMetadata(Object.getPrototypeOf(obj)).get(property)?.toPayload;
  if (!toPayload) return payloadValue(value, seen);
  const built = instancePayloads.get(obj)?.get(property);
  if (built && built.value === value) return built.payload;
  // Never changed since it was set up (a default, or a loaded value): build it now, once,
  // so every event shows the property the same way.
  const payload = toPayload(obj, value, value);
  let payloads = instancePayloads.get(obj);
  if (!payloads) {
    payloads = new Map();
    instancePayloads.set(obj, payloads);
  }
  payloads.set(property, { value, payload });
  return payload;
}

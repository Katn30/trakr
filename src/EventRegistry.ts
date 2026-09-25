import { TrackedObject } from "./TrackedObject";
import type { Tracker } from "./Tracker";
import { Change } from "./Change";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";

const EVENT_METADATA = Symbol("eventMetadata");

export interface HistoryOptions<TSelf = any, TValue = any> {
  entryFactory: (
    self: TSelf,
    newValue: TValue,
    oldValue: TValue,
    change: Change,
    ctx?: unknown,
  ) => unknown;
}

export type HistoryConfig = boolean | HistoryOptions;

export interface EventPropertyOptions {
  eventType?: string;
  history?: HistoryConfig;
  coalesceWithin?: number;
}

type EventMetadataMap = Map<string, EventPropertyOptions>;

interface EventFieldEntry {
  originalValue: unknown;
  currentValue: unknown;
}

const instanceState = new WeakMap<TrackedObject, Map<string, EventFieldEntry>>();
const instanceHistory = new WeakMap<TrackedObject, Map<string, unknown[]>>();
const instanceHistoryTimes = new WeakMap<TrackedObject, Map<string, number>>();
const subscribedInstances = new WeakSet<TrackedObject>();
const itemOriginCollection = new WeakMap<TrackedObject, object>();

// ------------------------------------------------------------------ replay effects

/**
 * History entries and collection ops are pending-entry lists, not diffs, so an
 * undo/redo cannot be derived by comparing values. Each write therefore chains
 * an effect onto its own action in the operation: undoing/redoing exactly that
 * operation appends the entry that reverts (or re-applies) the write. Whether
 * the resulting event is withdrawn or kept as a compensation is decided by the
 * EventTracker, which settles these lists after every operation.
 */
export function recordReplayEffect(
  tracker: Tracker,
  properties: OperationProperties,
  append: (direction: "undo" | "redo") => void,
): void {
  tracker._recordSideEffect(() => append("redo"), () => append("undo"), properties);
}

// Symbol used to sentinel the "default" (ungrouped) bucket in event emission.
export const DEFAULT_GROUP = "";

function hasOwnEventMetadata(proto: object): boolean {
  return Object.prototype.hasOwnProperty.call(proto, EVENT_METADATA);
}

function ownEventMetadata(proto: object): EventMetadataMap | undefined {
  return hasOwnEventMetadata(proto)
    ? ((proto as unknown as Record<symbol, EventMetadataMap>)[EVENT_METADATA])
    : undefined;
}

export function registerEventProperty(
  proto: object,
  property: string,
  options: EventPropertyOptions,
): void {
  if (!hasOwnEventMetadata(proto)) {
    Object.defineProperty(proto, EVENT_METADATA, {
      value: new Map<string, EventPropertyOptions>(),
      configurable: true,
    });
  }
  const map = (proto as unknown as Record<symbol, EventMetadataMap>)[EVENT_METADATA];
  if (!map.has(property)) {
    map.set(property, options);
  }
}

export function getEventMetadata(proto: object): EventMetadataMap {
  const chain: object[] = [];
  let current: object | null = proto;
  while (current) {
    chain.push(current);
    current = Object.getPrototypeOf(current);
  }
  const merged: EventMetadataMap = new Map();
  for (let i = chain.length - 1; i >= 0; i--) {
    const own = ownEventMetadata(chain[i]);
    if (!own) continue;
    own.forEach((options, property) => {
      if (!merged.has(property)) merged.set(property, options);
    });
  }
  return merged;
}

// ------------------------------------------------------------------ tracker context stack

const contextStacks = new WeakMap<object, unknown[]>();

export function pushContext(tracker: object, ctx: unknown): void {
  let stack = contextStacks.get(tracker);
  if (!stack) {
    stack = [];
    contextStacks.set(tracker, stack);
  }
  stack.push(ctx);
}

export function popContext(tracker: object): void {
  // Always paired with a preceding pushContext (see EventTracker.withContext).
  contextStacks.get(tracker)!.pop();
}

export function peekContext(tracker: object): unknown {
  const stack = contextStacks.get(tracker);
  return stack && stack.length > 0 ? stack[stack.length - 1] : undefined;
}

// ------------------------------------------------------------------ instance subscription

export function ensureEventStateSubscription(target: TrackedObject): void {
  if (subscribedInstances.has(target)) return;
  subscribedInstances.add(target);
  target.changed.subscribe((evt) => {
    const meta = getEventMetadata(Object.getPrototypeOf(target));
    const propMeta = meta.get(evt.property);
    if (!propMeta) return;

    if (propMeta.history) {
      // Replays are handled by the effect recorded on the operation itself.
      if (target.tracker._isReplaying) return;
      appendHistoryEntry(
        target,
        evt.property,
        evt.newValue,
        evt.oldValue,
        propMeta.history,
        propMeta.coalesceWithin,
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
  historyConfig: HistoryConfig,
  coalesceWithin: number | undefined,
): void {
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

  const entry = createHistoryEntry(target, property, newValue, oldValue, historyConfig);
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
      chains.set(property, [...(chains.get(property) ?? []), createHistoryEntry(target, property, value, previous, historyConfig)]);
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
  historyConfig: HistoryConfig,
): unknown {
  if (typeof historyConfig === "object" && historyConfig.entryFactory) {
    const ctx = peekContext(target.tracker);
    const change = { time: new Date() } as unknown as Change;
    return historyConfig.entryFactory(target, newValue, oldValue, change, ctx);
  }
  return { property, value: newValue };
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
  const current = (target as unknown as Record<string, unknown>)[property];
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

export function recordItemOrigin(item: TrackedObject, collection: object): void {
  itemOriginCollection.set(item, collection);
}

export function getItemOrigin(item: TrackedObject): object | undefined {
  return itemOriginCollection.get(item);
}

import { TrackedObject } from "./TrackedObject";
import { Change } from "./Change";

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

export function hasAnyEventMetadata(proto: object): boolean {
  let current: object | null = proto;
  while (current) {
    if (hasOwnEventMetadata(current)) {
      const own = ownEventMetadata(current);
      if (own && own.size > 0) return true;
    }
    current = Object.getPrototypeOf(current);
  }
  return false;
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
  const stack = contextStacks.get(tracker);
  if (stack && stack.length > 0) stack.pop();
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

  let entry: unknown;
  if (typeof historyConfig === "object" && historyConfig.entryFactory) {
    const ctx = peekContext(target.tracker);
    const change = { time: new Date() } as unknown as Change;
    entry = historyConfig.entryFactory(target, newValue, oldValue, change, ctx);
  } else {
    entry = { property, value: newValue };
  }

  if (shouldReplace) {
    chain[chain.length - 1] = entry;
  } else {
    chain.push(entry);
  }
  times.set(property, now);
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

export function popHistoryEntry(target: TrackedObject, property: string): void {
  const chains = instanceHistory.get(target);
  if (!chains) return;
  const chain = chains.get(property);
  if (!chain) return;
  chain.pop();
  if (chain.length === 0) chains.delete(property);
}

export function recordItemOrigin(item: TrackedObject, collection: object): void {
  itemOriginCollection.set(item, collection);
}

export function getItemOrigin(item: TrackedObject): object | undefined {
  return itemOriginCollection.get(item);
}

import { Tracker } from "./Tracker";
import { TrackedObject } from "./TrackedObject";
import { TrackedObjectBase } from "./TrackedObjectBase";
import { Operation } from "./Operation";
import { TypedEvent } from "./TypedEvent";
import {
  IdAssignment,
  getAutoIdProperty,
  getIdProperty,
  getIdentity,
  getIdentityObject,
  getIdentityProperties,
} from "./ExternallyAssigned";
import { EventState, GeneratedEvent, TrackedEvent } from "./GeneratedEvent";
import {
  CollectionOp,
  EventTrackedCollection,
  EventTrackedCollectionOptions,
} from "./EventTrackedCollection";
import {
  getEventMetadata,
  getEventState,
  getHistoryState,
  getItemOrigin,
  pushContext,
  popContext,
  ackFieldValue,
  settleEventState,
  restoreHistoryEntries,
  DEFAULT_GROUP,
  EventPropertyOptions,
} from "./EventRegistry";

type AnyCollection = EventTrackedCollection<unknown>;

/** What an event was derived from — enough to reopen it when a later write coalesces into it. */
interface Coverage {
  fields: Array<[TrackedObject, string, unknown]>;
  history: Array<[TrackedObject, string, unknown[]]>;
  members: Array<[AnyCollection, unknown]>;
  ops: Array<[AnyCollection, CollectionOp[]]>;
}

interface PendingEvent<TEventType extends string> {
  event: GeneratedEvent<TEventType>;
  coverage: Coverage;
  /** Identifies "the same event" across an operation's undo/redo: object (or collection) + event type. */
  key: string;
}

function newCoverage(): Coverage {
  return { fields: [], history: [], members: [], ops: [] };
}

function mergeCoverage(into: Coverage, from: Coverage): void {
  into.fields.push(...from.fields);
  into.history.push(...from.history);
  into.members.push(...from.members);
  into.ops.push(...from.ops);
}

type MutableEvent = { -readonly [K in keyof TrackedEvent]: TrackedEvent[K] };

interface Recorded {
  event: MutableEvent;
  /** Restores the state the event was derived from, as it was before the event was recorded. */
  reopen: () => void;
}

/**
 * What one operation's events look like for one key (object + event type):
 * the events that currently stand for it, and the set before its last
 * undo/redo — so the next undo/redo can simply reverse that move.
 */
interface KeyState {
  current: Set<Recorded>;
  previous: Set<Recorded>;
  /** False when `previous` is not a real earlier state (steps merged by a session). */
  reversible: boolean;
}

type OpRecord = Map<string, KeyState>;

const collectionKeys = new WeakMap<object, number>();
let nextCollectionKey = 1;
function collectionKey(col: object): number {
  let key = collectionKeys.get(col);
  if (key === undefined) {
    key = nextCollectionKey++;
    collectionKeys.set(col, key);
  }
  return key;
}

/** A new key starts from "no events", so its first undo can simply reverse the operation. */
function keyState(record: OpRecord, key: string): KeyState {
  let state = record.get(key);
  if (!state) {
    state = { current: new Set(), previous: new Set(), reversible: true };
    record.set(key, state);
  }
  return state;
}

/** Every recorded event of an operation, whether it currently stands for it or not. */
function recordsOf(record: OpRecord): Set<Recorded> {
  const recs = new Set<Recorded>();
  for (const { current, previous } of record.values()) {
    for (const r of [...current, ...previous]) recs.add(r);
  }
  return recs;
}

/** The states of the events an operation currently stands for. */
function currentStates(record: OpRecord): EventState[] {
  return [...record.values()].flatMap(({ current }) => [...current].map((r) => r.event.state));
}

function difference<T>(a: Set<T>, b: Set<T>): T[] {
  return [...a].filter((x) => !b.has(x));
}

/**
 * Event-stream tracker for autosave workflows over an event-sourced backend.
 *
 * Every operation records the events it produced in {@link events}, each with
 * an `eventId` and a {@link EventState}. Send the `NotCommitted` ones and
 * acknowledge them with `onCommit`. Undoing an unsent event marks it `Undone`
 * (redo brings it back); undoing a committed event keeps it `Committed` and
 * appends a compensating event.
 */
export class EventTracker extends Tracker {
  declare public readonly trackedObjects: TrackedObject[];

  /** @internal */
  public _assertAccepts(obj: TrackedObjectBase): void {
    if (!(obj instanceof TrackedObject)) {
      throw new TypeError(
        `${obj.constructor.name} cannot be tracked by an EventTracker: its models extend ` +
        "TrackedObject (or TrackedContainer). DirtyTrackedObject models belong to a DirtyTracker.",
      );
    }
  }

  public override getByTrackingId(trackingId: number): TrackedObject | undefined {
    return super.getByTrackingId(trackingId) as TrackedObject | undefined;
  }

  private readonly _log: MutableEvent[] = [];
  private readonly _byId = new Map<number, MutableEvent>();
  private readonly _ops = new Map<Operation, OpRecord>();
  private _reopened: Map<string, Recorded[]> = new Map();
  // Creation events from tracker.new(), superseded if the object is then added to a collection.
  private readonly _creations = new Map<object, Recorded>();
  private _nextEventId = 1;
  private _logChanged = false;

  /** Fires with {@link events} whenever an event is added, removed, or changes state. */
  public readonly eventsChanged: TypedEvent<readonly TrackedEvent[]> = new TypedEvent<readonly TrackedEvent[]>();

  /** Every recorded event, oldest first, in all states. */
  public get events(): readonly TrackedEvent[] {
    return this._log;
  }

  /** The events still to be sent: `NotCommitted`, oldest first. */
  public get pendingEvents(): TrackedEvent[] {
    return this._log.filter((e) => e.state === EventState.NotCommitted);
  }

  public withContext<T>(ctx: unknown, action: () => T): T {
    pushContext(this, ctx);
    try {
      return action();
    } finally {
      popContext(this);
    }
  }

  protected _computeIsDirty(): boolean {
    return this._log.some((e) => e.state === EventState.NotCommitted);
  }

  /**
   * Marks events as persisted by the server: only the events whose `eventId`
   * is listed become `Committed`. Events recorded meanwhile stay `NotCommitted`.
   *
   * @param eventIds `eventId`s of the events the server persisted.
   * @param keys server-assigned `@AutoId` values, keyed by `trackingId`.
   */
  public onCommit<V = number>(eventIds: readonly number[], keys?: IdAssignment<V>[]): void {
    if (!Array.isArray(eventIds) || eventIds.some((id) => typeof id !== "number")) throw commitTypeError();
    for (const eventId of eventIds) {
      const event = this._byId.get(eventId);
      if (!event) {
        if (process.env.NODE_ENV !== "production") {
          console.warn(`EventTracker.onCommit: no event with eventId ${eventId}; ignored.`);
        }
        continue;
      }
      if (event.state === EventState.NotCommitted) this._setState(event, EventState.Committed);
    }
    if (keys) this.assignKeys(keys);
    this.reset();
    this._notify();
  }

  private assignKeys<V>(keys: IdAssignment<V>[]): void {
    this.withTrackingSuppressed(() => {
      for (const key of keys) {
        const obj = this.getByTrackingId(key.trackingId);
        if (!obj) continue;
        const autoIdProp = getAutoIdProperty(Object.getPrototypeOf(obj));
        if (autoIdProp) (obj as unknown as Record<string, unknown>)[autoIdProp] = key.value;
      }
    });
  }

  /**
   * Reverts what has not been sent, as far as it can be reverted cleanly:
   * pending compensations are withdrawn (by redoing), operations whose events
   * are all unsent are undone, and the redo stack is dropped. It never forgets
   * an unsent event whose change is still in the objects — e.g. from an
   * operation that is partly committed, or from `tracker.new()` — so those
   * stay pending.
   */
  public override discardPendingChanges(): void {
    const top = (stack: Operation[]) => this._ops.get(stack[stack.length - 1])!;
    while (this.canRedo && currentStates(top(this._redoOperations)).includes(EventState.NotCommitted)) {
      this.redo();
    }
    while (this.canUndo && currentStates(top(this._undoOperations)).every((st) => st === EventState.NotCommitted)) {
      this.undo();
    }
    this._onOperationsDropped(this._redoOperations.splice(0));
    this.reset();
  }

  // ---- Operation lifecycle -------------------------------------------------

  protected override _onOperationStart(op: Operation, extended: boolean): void {
    if (!extended || this._isConstructing) return;
    // The write coalesces into `op`: reopen its unsent events so they absorb it.
    for (const [key, state] of this._ops.get(op)!) {
      const unsent = [...state.current].filter((r) => r.event.state === EventState.NotCommitted);
      if (unsent.length === 0) continue;
      for (const r of unsent) r.reopen();
      this._reopened.set(key, unsent);
    }
  }

  protected override _onOperationEnd(op: Operation): void {
    if (this._isConstructing) return;
    const record = recordFor(this._ops, op);
    const reopened = this._reopened;
    this._reopened = new Map();
    const reopens: Array<[Recorded, () => void]> = [];
    const pending = this.collectPending<string>();
    for (const p of pending) {
      const [again] = reopened.get(p.key) ?? [];
      if (again) {
        reopened.get(p.key)!.shift();
        again.event.payload = p.event.payload;
        again.event.targetId = p.event.targetId;
        reopens.push([again, captureReopen(p.coverage)]);
        this._logChanged = true;
      } else {
        keyState(record, p.key).current.add(this._append(p));
      }
    }
    for (const [rec, reopen] of reopens) rec.reopen = reopen;
    this._dropSupersededCreations(pending);
    // Reopened events the coalesced write cancelled out entirely.
    for (const [key, recs] of reopened) {
      for (const rec of recs) {
        this._remove(rec.event);
        record.get(key)!.current.delete(rec);
      }
    }
    this._settle();
    this._notify();
  }

  protected override _onReplayed(op: Operation): void {
    const record = this._ops.get(op)!;
    for (const p of this.collectPending<string>()) {
      const state = keyState(record, p.key);
      const retract = difference(state.current, state.previous);
      if (state.reversible && retract.every((r) => r.event.state === EventState.NotCommitted)) {
        // Nothing of the last move was sent: simply reverse it.
        for (const r of retract) this._setState(r.event, EventState.Undone);
        for (const r of difference(state.previous, state.current)) this._setState(r.event, EventState.NotCommitted);
        [state.current, state.previous] = [state.previous, state.current];
        continue;
      }
      // Withdraw what was not sent; compensate what was committed.
      const next = new Set<Recorded>();
      let lastCommitted: number | undefined;
      for (const r of state.current) {
        if (r.event.state === EventState.Committed) {
          next.add(r);
          lastCommitted = Math.max(lastCommitted ?? 0, r.event.eventId);
        } else {
          this._setState(r.event, EventState.Undone);
        }
      }
      if (lastCommitted !== undefined) next.add(this._append(p, lastCommitted));
      state.previous = state.current;
      state.current = next;
      state.reversible = true;
    }
    this._settle();
    this._notify();
  }

  protected override _onOperationsDropped(ops: readonly Operation[]): void {
    if (this._isConstructing) return;
    for (const op of ops) {
      for (const rec of recordsOf(this._ops.get(op)!)) {
        if (rec.event.state === EventState.Undone) this._remove(rec.event);
      }
      this._ops.delete(op);
    }
    this._notify();
  }

  protected override _onNewCompleted(): void {
    for (const p of this.collectPending<string>()) {
      const rec = this._append(p);
      if (p.event.trackingId !== undefined) this._creations.set(this.getByTrackingId(p.event.trackingId)!, rec);
    }
    this._settle();
    this._notify();
  }

  /**
   * An unsent creation event is redundant once the object is reported as added
   * to a collection: the addition carries the object's full snapshot.
   */
  private _dropSupersededCreations(pending: PendingEvent<string>[]): void {
    for (const [obj, rec] of this._creations) {
      if (rec.event.state !== EventState.NotCommitted) {
        this._creations.delete(obj);
      } else if (pending.some((p) => p.coverage.members.some(([col, item]) => item === obj && col.collection.includes(obj)))) {
        this._remove(rec.event);
        this._creations.delete(obj);
      }
    }
  }

  protected override _onSessionEnded(composed: readonly Operation[], result: Operation): void {
    if (composed.length === 1) return; // the operation is its own undo step: nothing to merge
    const records = composed.map((op) => this._ops.get(op)!);
    for (const op of composed) this._ops.delete(op);
    const recs = records.flatMap((r) => [...recordsOf(r)]);
    const mergeable = recs.every((r) => r.event.state === EventState.NotCommitted);

    if (!mergeable) {
      // Something was already sent or undone: keep each event as recorded.
      const merged: OpRecord = new Map();
      for (const r of records) {
        for (const [key, { current }] of r) for (const rec of current) keyState(merged, key).current.add(rec);
      }
      // Merged moves cannot be replayed as one: the next undo/redo re-derives from the current events.
      for (const state of merged.values()) state.reversible = false;
      this._ops.set(result, merged);
      return;
    }
    // Nothing sent yet: the single undo step becomes one set of events.
    for (const rec of [...recs].reverse()) {
      rec.reopen();
      this._remove(rec.event);
    }
    const record = recordFor(this._ops, result);
    for (const p of this.collectPending<string>()) keyState(record, p.key).current.add(this._append(p));
    this._settle();
    this._notify();
  }

  protected override _onSessionRolledBack(reverted: readonly Operation[]): void {
    const committed = new Map<string, number>();
    for (const op of reverted) {
      for (const [key, state] of this._ops.get(op)!) {
        for (const rec of state.current) {
          if (rec.event.state === EventState.Committed) {
            committed.set(key, Math.max(committed.get(key) ?? 0, rec.event.eventId));
          }
        }
      }
      for (const rec of recordsOf(this._ops.get(op)!)) {
        if (rec.event.state !== EventState.Committed) this._remove(rec.event);
      }
      this._ops.delete(op);
    }
    for (const p of this.collectPending<string>()) {
      const compensates = committed.get(p.key);
      if (compensates !== undefined) this._append(p, compensates);
    }
    this._settle();
    this._notify();
  }

  // ---- Event log -----------------------------------------------------------

  private _append(p: PendingEvent<string>, compensates?: number): Recorded {
    const event: MutableEvent = { eventId: this._nextEventId++, ...p.event, state: EventState.NotCommitted };
    if (compensates !== undefined) event.compensates = compensates;
    this._log.push(event);
    this._byId.set(event.eventId, event);
    this._logChanged = true;
    return { event, reopen: captureReopen(p.coverage) };
  }

  private _remove(event: TrackedEvent): void {
    this._log.splice(this._log.indexOf(event as MutableEvent), 1);
    this._byId.delete(event.eventId);
    this._logChanged = true;
  }

  private _setState(event: MutableEvent, state: EventState): void {
    event.state = state;
    this._logChanged = true;
  }

  private _notify(): void {
    if (!this._logChanged) return;
    this._logChanged = false;
    this.eventsChanged.emit(this._log);
  }

  /** Once an operation's events are recorded, the next operation starts from a clean diff. */
  private _settle(): void {
    for (const obj of this.trackedObjects) settleEventState(obj);
    for (const col of this.trackedCollections) {
      if (col instanceof EventTrackedCollection) (col as AnyCollection)._clearHistoryOps();
    }
  }

  // ---- Deriving the events of one operation --------------------------------

  private collectPending<TEventType extends string>(): PendingEvent<TEventType>[] {
    const events: PendingEvent<TEventType>[] = [];
    const membership = new Map<AnyCollection, Set<unknown>>();
    const membersOf = (col: AnyCollection): Set<unknown> => {
      let set = membership.get(col);
      if (!set) {
        set = new Set(col.collection);
        membership.set(col, set);
      }
      return set;
    };

    // Per-item events for collections in itemAdded/itemRemoved mode.
    for (const obj of this.trackedObjects) {
      const origin = getItemOrigin(obj) as AnyCollection | undefined;
      if (!origin) continue;
      const legacy = origin._lifecycleOptions;
      if (!legacy) continue;

      const meta = getEventMetadata(Object.getPrototypeOf(obj));
      const inCollection = membersOf(origin).has(obj);
      const inBaseline = origin._isInBaseline(obj);
      const lifecycleKey = `lifecycle:${obj.trakrId}`;
      if (inCollection && !inBaseline) {
        if (legacy.itemAdded) {
          const coverage = coverWholeItem(obj, meta);
          coverage.members.push([origin, obj]);
          events.push({ event: buildItemAddedEvent<TEventType>(obj, meta, legacy.itemAdded), coverage, key: lifecycleKey });
        }
      } else if (!inCollection && inBaseline) {
        if (legacy.itemRemoved) {
          const coverage = newCoverage();
          coverage.members.push([origin, obj]);
          events.push({ event: buildItemRemovedEvent<TEventType>(obj, legacy.itemRemoved), coverage, key: lifecycleKey });
        }
      } else if (inCollection) {
        pushFieldClusterEvents<TEventType>(obj, meta, events);
      }
    }

    // Aggregate: index owned collections by owner
    const ownedCollections = new Map<TrackedObject, AnyCollection[]>();
    for (const col of this.trackedCollections) {
      if (!(col instanceof EventTrackedCollection)) continue;
      const agg = (col as AnyCollection)._aggregateOptions;
      if (!agg?.owner) continue;
      const owner = agg.owner.object;
      let list = ownedCollections.get(owner);
      if (!list) {
        list = [];
        ownedCollections.set(owner, list);
      }
      list.push(col as AnyCollection);
    }

    // Top-level events for objects not inside a collection
    for (const obj of this.trackedObjects) {
      const origin = getItemOrigin(obj);
      if (origin) continue;

      const groups = new Map<string, { payload: Record<string, unknown>; coverage: Coverage }>();
      const groupFor = (group: string) => {
        let g = groups.get(group);
        if (!g) {
          g = { payload: {}, coverage: newCoverage() };
          groups.set(group, g);
        }
        return g;
      };
      const meta = getEventMetadata(Object.getPrototypeOf(obj));

      const stateMap = getEventState(obj);
      const historyMap = getHistoryState(obj);
      for (const [propName, propMeta] of meta) {
        const group = propMeta.eventType ?? DEFAULT_GROUP;
        if (propMeta.history) {
          const chain = historyMap.get(propName);
          if (chain && chain.length > 0) {
            const g = groupFor(group);
            g.payload[propName] = [...chain];
            g.coverage.history.push([obj, propName, [...chain]]);
          }
        } else {
          const entry = stateMap.get(propName);
          if (entry) {
            const g = groupFor(group);
            g.payload[propName] = normalizeValue(entry.currentValue);
            g.coverage.fields.push([obj, propName, entry.currentValue]);
          }
        }
      }

      const owned = ownedCollections.get(obj) ?? [];
      for (const col of owned) {
        const slot = computeCollectionSlot(col, membersOf(col));
        if (slot === undefined) continue;
        const agg = col._aggregateOptions!;
        const g = groupFor(agg.eventType ?? DEFAULT_GROUP);
        g.payload[agg.owner!.property] = slot.value;
        mergeCoverage(g.coverage, slot.coverage);
      }

      if (groups.size === 0) continue;

      const identity = getIdentity(obj);
      for (const [group, { payload, coverage }] of groups) {
        const event: GeneratedEvent<TEventType> = {
          eventType: group as TEventType,
          payload,
          trackingId: obj.trakrId,
        };
        if (identity !== undefined) {
          event.targetId = identity;
        }
        events.push({ event, coverage, key: `${group}:${obj.trakrId}` });
      }
    }

    // Standalone aggregate collections (no owner) — emit their own event
    for (const col of this.trackedCollections) {
      if (!(col instanceof EventTrackedCollection)) continue;
      const agg = (col as AnyCollection)._aggregateOptions;
      if (!agg || agg.owner) continue;
      const slot = computeCollectionSlot(col as AnyCollection, membersOf(col as AnyCollection));
      if (slot === undefined) continue;
      const eventType = (agg.eventType ?? DEFAULT_GROUP) as TEventType;
      events.push({
        event: { eventType, payload: slot.value as Record<string, unknown> },
        coverage: slot.coverage,
        key: `${eventType}:collection:${collectionKey(col)}`,
      });
    }

    return events;
  }
}

function recordFor(ops: Map<Operation, OpRecord>, op: Operation): OpRecord {
  let record = ops.get(op);
  if (!record) {
    record = new Map();
    ops.set(op, record);
  }
  return record;
}

function commitTypeError(): TypeError {
  return new TypeError(
    "EventTracker.onCommit(eventIds, keys?) expects the eventIds of the events the server " +
    "persisted, e.g. onCommit(sent.map((e) => e.eventId)).",
  );
}

/**
 * Captures, before the operation's changes are settled, how to put them back:
 * each field's previous recorded value, the history entries, collection
 * membership and ops. Used when a coalesced write reopens the operation.
 */
function captureReopen(coverage: Coverage): () => void {
  const fields = coverage.fields.map(([obj, prop, value]) => {
    const entry = getEventState(obj).get(prop);
    return [obj, prop, entry ? entry.originalValue : value] as const;
  });
  const members = coverage.members.map(([col, item]) => [col, item, col._isInBaseline(item)] as const);
  return () => {
    for (const [obj, prop, previous] of fields) ackFieldValue(obj, prop, previous);
    for (const [obj, prop, entries] of coverage.history) restoreHistoryEntries(obj, prop, entries);
    for (const [col, item, wasIn] of members) col._setInBaseline(item, wasIn);
    for (const [col, ops] of coverage.ops) col._restoreOps(ops);
  };
}

/** Coverage of a full-item snapshot: every event property as it is right now. */
function coverWholeItem(item: TrackedObject, meta: Map<string, EventPropertyOptions>): Coverage {
  const coverage = newCoverage();
  const rec = item as unknown as Record<string, unknown>;
  const history = getHistoryState(item);
  for (const [propName, propMeta] of meta) {
    if (propMeta.history) {
      const chain = history.get(propName);
      if (chain && chain.length > 0) coverage.history.push([item, propName, [...chain]]);
    } else {
      coverage.fields.push([item, propName, rec[propName]]);
    }
  }
  return coverage;
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
    trackingId: obj.trakrId,
  };
}

function buildItemRemovedEvent<TEventType extends string>(
  obj: TrackedObject,
  eventType: string,
): GeneratedEvent<TEventType> {
  // Items of an EventTrackedCollection always declare an @Id or @AutoId.
  const proto = Object.getPrototypeOf(obj);
  const idProp = (getAutoIdProperty(proto) ?? getIdProperty(proto))!;
  const targetId = (obj as unknown as Record<string, unknown>)[idProp];
  const event: GeneratedEvent<TEventType> = {
    eventType: eventType as TEventType,
    payload: {},
    trackingId: obj.trakrId,
  };
  if (typeof targetId === "number") {
    event.targetId = targetId;
  }
  return event;
}

function pushFieldClusterEvents<TEventType extends string>(
  obj: TrackedObject,
  meta: Map<string, { eventType?: string }>,
  events: PendingEvent<TEventType>[],
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
    const coverage = newCoverage();
    for (const propertyName of propertyNames) {
      const value = state.get(propertyName)!.currentValue;
      payload[propertyName] = normalizeValue(value);
      coverage.fields.push([obj, propertyName, value]);
    }
    const event: GeneratedEvent<TEventType> = {
      eventType: eventType as TEventType,
      payload,
      trackingId: obj.trakrId,
    };
    if (typeof targetIdRaw === "number") {
      event.targetId = targetIdRaw;
    }
    events.push({ event, coverage, key: `${eventType}:${obj.trakrId}` });
  }
}

interface Slot {
  value: unknown;
  coverage: Coverage;
}

function computeCollectionSlot(col: AnyCollection, members: Set<unknown>): Slot | undefined {
  const agg = col._aggregateOptions!;
  const isHistory = agg.history !== undefined && agg.history !== false;
  if (isHistory) return computeHistoryOps(col, agg);
  return computeBucketedSlot(col, members);
}

function computeHistoryOps(
  col: AnyCollection,
  agg: EventTrackedCollectionOptions,
): Slot | undefined {
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
      ops.push({ op: "add", item: op.snapshot });
    } else if (op.op === "remove") {
      ops.push({ op: "remove", ...removedIdentityObject(op) });
    } else {
      ops.push({ op: "change", ...getIdentityObject(op.item), ...op.diff });
    }
  }

  if (ops.length === 0) return undefined;
  const coverage = newCoverage();
  coverage.ops.push([col, [...opsList]]);
  return { value: { ops }, coverage };
}

/** A remove op's identity (captured at removal time) as an `{ idProp: value }` object. */
function removedIdentityObject(op: CollectionOp): Record<string, unknown> {
  const props = getIdentityProperties(Object.getPrototypeOf(op.item));
  return props.length === 1 ? { [props[0]]: op.identity } : (op.identity as Record<string, unknown>);
}

function computeBucketedSlot(col: AnyCollection, members: Set<unknown>): Slot | undefined {
  const added: unknown[] = [];
  const changed: unknown[] = [];
  const removed: unknown[] = [];
  const coverage = newCoverage();

  const isPrimitive = !hasTrackedObjectItems(col);

  for (const item of col.collection) {
    if (!col._isInBaseline(item)) {
      if (item instanceof TrackedObject) {
        added.push(snapshotItemForAdded(item));
        mergeCoverage(coverage, coverWholeItem(item, getEventMetadata(Object.getPrototypeOf(item))));
      } else {
        added.push(item);
      }
      coverage.members.push([col, item]);
    } else if (item instanceof TrackedObject) {
      const entry = buildChangedEntry(item, coverage);
      if (entry) changed.push(entry);
    }
  }

  for (const baselineItem of col._baselineListSnapshot()) {
    if (members.has(baselineItem)) continue;
    removed.push(baselineItem instanceof TrackedObject ? getIdentity(baselineItem) : baselineItem);
    coverage.members.push([col, baselineItem]);
  }

  if (added.length === 0 && changed.length === 0 && removed.length === 0) {
    return undefined;
  }

  const slot: Record<string, unknown> = { added, removed };
  if (!isPrimitive) slot.changed = changed;
  return { value: slot, coverage };
}

function hasTrackedObjectItems(col: AnyCollection): boolean {
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
    snapshot[propName] = normalizeValue(rec[propName]);
  }
  return snapshot;
}

function buildChangedEntry(item: TrackedObject, coverage: Coverage): Record<string, unknown> | undefined {
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
    entry[propName] = normalizeValue(e.currentValue);
    coverage.fields.push([item, propName, e.currentValue]);
  }
  for (const [propName, chain] of history) {
    entry[propName] = [...chain];
    coverage.history.push([item, propName, [...chain]]);
  }
  return entry;
}

function normalizeValue(value: unknown): unknown {
  return value === undefined ? null : value;
}

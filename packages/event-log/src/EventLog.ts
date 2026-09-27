import { Tracker, TrackerSession } from "@katn30/chronicle-core";
import type { PropertyScope } from "@katn30/chronicle-core";
import { TrackedObject } from "./TrackedObject";
import { Operation } from "@katn30/chronicle-core";
import {
  IdAssignment,
  getAutoIdProperty,
  getIdentity,
  getIdentityObject,
  getIdentityProperties,
  readProperty,
  writeProperty,
} from "@katn30/chronicle-core";
import { CommitBatch, CommitOptions, EventEntry, EventState, GeneratedEvent, SaveFunction, TrackedEvent } from "./GeneratedEvent";
import { CollectionOp, EventTrackedCollection } from "./EventTrackedCollection";
import {
  getEventMetadata,
  getEventState,
  getHistoryState,
  getItemOrigins,
  ackFieldValue,
  propertyPayload,
  settleEventState,
  restoreHistoryEntries,
  EventPropertyOptions,
} from "./EventRegistry";

type AnyCollection = EventTrackedCollection<unknown>;

/** What an event was derived from — enough to reopen it when a later write coalesces into it. */
interface Coverage {
  fields: Array<[TrackedObject, string, unknown]>;
  history: Array<[TrackedObject, string, unknown[]]>;
  members: Array<[AnyCollection, unknown]>;
  ops: Array<[AnyCollection, CollectionOp[]]>;
  /** Placeholders written for items whose id is not known yet, with how to fill in the real id. */
  placeholders: Array<[TrackedObject, (event: MutableEvent) => void]>;
  /** Objects whose creation (full snapshot) the event carries. */
  created: TrackedObject[];
}

/**
 * How payload builders refer to items. An `@AutoId` item added through an
 * event is *provisional* until a commit returns its id: references to it are
 * written as `{ chronicleId }` placeholders, patched once the id is known.
 */
interface Refs {
  isProvisional(item: TrackedObject): boolean;
  /** Built with `tracker.new()` and not created on the server yet: its first change sends its creation. */
  isNew(item: TrackedObject): boolean;
  /** Destroyed objects take no further part in events. */
  isDestroyed(item: unknown): boolean;
  /** An added snapshot of `item` was produced: its id is (re)assigned by the server. */
  created(item: TrackedObject): void;
}

function hasAutoId(item: TrackedObject): boolean {
  return getAutoIdProperty(Object.getPrototypeOf(item)) !== undefined;
}

/** Appends `item`'s identity to `list`, or a `{ chronicleId }` placeholder while it is provisional. */
function pushRef(list: unknown[], item: TrackedObject, refs: Refs, coverage: Coverage): void {
  if (!refs.isProvisional(item)) {
    list.push(getIdentity(item));
    return;
  }
  const index = list.push({ chronicleId: item.chronicleId }) - 1;
  coverage.placeholders.push([item, () => { list[index] = getIdentity(item); }]);
}

/** Writes `item`'s identity properties into `target`, or `chronicleId` while it is provisional. */
function assignRef(target: Record<string, unknown>, item: TrackedObject, refs: Refs, coverage: Coverage, identity?: Record<string, unknown>): void {
  if (!refs.isProvisional(item)) {
    Object.assign(target, identity ?? getIdentityObject(item));
    return;
  }
  target.chronicleId = item.chronicleId;
  coverage.placeholders.push([item, () => {
    delete target.chronicleId;
    Object.assign(target, getIdentityObject(item));
  }]);
}

interface PendingEvent {
  event: GeneratedEvent;
  coverage: Coverage;
  /** Identifies "the same event" across an operation's undo/redo: the root object or collection. */
  key: string;
}

function newCoverage(): Coverage {
  return { fields: [], history: [], members: [], ops: [], placeholders: [], created: [] };
}

function mergeCoverage(into: Coverage, from: Coverage): void {
  into.fields.push(...from.fields);
  into.history.push(...from.history);
  into.members.push(...from.members);
  into.ops.push(...from.ops);
  into.placeholders.push(...from.placeholders);
  into.created.push(...from.created);
}

type MutableEvent = { -readonly [K in keyof TrackedEvent]: TrackedEvent[K] };

interface Recorded {
  event: MutableEvent;
  /** Restores the state the event was derived from, as it was before the event was recorded. */
  reopen: () => void;
  /** Objects the event creates on the server: no longer new once it is committed. */
  created: readonly TrackedObject[];
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

/** The same event as sent: same payload, same target. */
function sameEvent(a: TrackedEvent, b: GeneratedEvent): boolean {
  return JSON.stringify(toGenerated(a)) === JSON.stringify(b);
}

/**
 * Records every change as events, for an event-sourced backend. Each undo step
 * ({@link undoable}, {@link redoable}) carries the events its operation
 * produced; {@link commit} sends what the server does not have yet. Undoing a
 * step that was already sent sends a compensating event with the next commit.
 */
export class EventLog extends Tracker<TrackedObject, AnyCollection, EventEntry, TrackerSession<TrackedObject>> {
  /** @internal Brand: a plain `TrackedCollection` does not compile with an EventLog. */
  declare readonly _eventLog: true;

  private readonly _log: MutableEvent[] = [];
  private readonly _byId = new Map<number, MutableEvent>();
  private readonly _recorded = new WeakMap<MutableEvent, Recorded>();
  // commit() calls run one after another: each batch is built once the previous one's ids are in.
  private _commitQueue: Promise<unknown> = Promise.resolve();
  private readonly _ops = new Map<Operation, OpRecord>();
  private _reopened: Map<string, Recorded[]> = new Map();
  // Objects built with tracker.new() that the server does not have yet.
  private readonly _new = new Set<TrackedObject>();
  // Unsent events being derived again (coalescing, collapsing): they do not count as sent-to-be.
  private readonly _rederiving = new Set<MutableEvent>();
  // Items given an added snapshot by the derivation under way (see Refs.created).
  private readonly _snapshotted = new Set<TrackedObject>();
  // Created on the server by a committed event, whose id the save has not reported yet.
  private readonly _awaitingKey = new Set<TrackedObject>();
  // Per provisional item: placeholders in recorded events, and how to patch each.
  private readonly _placeholders = new Map<TrackedObject, Array<[MutableEvent, (event: MutableEvent) => void]>>();
  private readonly _destroyed = new WeakSet<object>();
  private readonly _refs: Refs = {
    // Its server id is not known: never created on the server, or its creation is not sent yet.
    isProvisional: (item) => hasAutoId(item) && (this._new.has(item) || this._snapshotted.has(item) || this._awaitingKey.has(item)
      || this._log.some((e) => e.state === EventState.NotCommitted && !this._rederiving.has(e) && this._recorded.get(e)!.created.includes(item))),
    // New, and no unsent event already carries its creation (only the first one does).
    isNew: (item) => this._new.has(item) && !this._log.some((e) =>
      e.state === EventState.NotCommitted && !this._rederiving.has(e) && this._recorded.get(e)!.created.includes(item)),
    isDestroyed: (item) => item instanceof TrackedObject && this._destroyed.has(item),
    created: (item) => {
      this._snapshotted.add(item);
    },
  };
  private _nextEventId = 1;
  // The eventIds of the save in progress.
  private readonly _inFlight = new Set<number>();

  /** Each undo step also carries the events its operation produced. */
  protected _createEntry(op: Operation): EventEntry {
    const log = this;
    const entry = this._historyEntry(op);
    return Object.freeze({
      get isCommitted() { return entry.isCommitted; },
      get isSaving() { return entry.isSaving; },
      get events() { return log._eventsOf(op); },
    });
  }

  protected _createSession(
    scope: PropertyScope<TrackedObject>[] | undefined,
    end: () => void,
    rollback: () => void,
  ): TrackerSession<TrackedObject> {
    return new TrackerSession(scope, this, end, rollback);
  }

  // The events an operation stands for now: forward events and compensations.
  private _current(op: Operation): MutableEvent[] {
    const record = this._ops.get(op);
    if (!record) return [];
    return [...record.values()].flatMap(({ current }) => [...current].map((r) => r.event));
  }

  /** Every event the operation currently stands for has been sent. */
  protected _isCommitted(op: Operation): boolean {
    return this._current(op).every((e) => e.state === EventState.Committed);
  }

  protected _isSaving(op: Operation): boolean {
    return this._current(op).some((e) => e.state === EventState.NotCommitted && this._inFlight.has(e.eventId));
  }

  // Undo, redo or a coalescing write would change events already on their way.
  protected override _isLocked(op: Operation): boolean {
    return this._isSaving(op);
  }

  /** What the operation did: its own events (not compensations), oldest first. */
  private _eventsOf(op: Operation): GeneratedEvent[] {
    const record = this._ops.get(op);
    if (!record) return [];
    return [...recordsOf(record)]
      .map((r) => r.event)
      .filter((e) => e.compensates === undefined && this._byId.has(e.eventId))
      .sort((a, b) => a.eventId - b.eventId)
      .map(toGenerated);
  }

  protected _computeIsDirty(): boolean {
    return this._log.some((e) => e.state === EventState.NotCommitted);
  }

  /**
   * Saves everything pending in one go. The unsent events become one
   * {@link CommitBatch} — by default collapsed into the net effect of all their
   * operations (`mode: "operations"` sends every event as recorded instead) —
   * `save` is called with it, and once it resolves exactly those events become
   * `Committed` and the `@AutoId` values it returns are assigned. Changes made
   * while `save` runs stay pending for the next commit.
   *
   * Calls run one after another, so a batch never refers to an item whose id is
   * still being assigned by a save in flight. Resolves to `false` if nothing
   * was pending. If `save` throws, nothing is committed and the error propagates.
   * Operations that cancel out (e.g. add then remove) are committed without
   * calling `save`.
   */
  public commit<V = number>(save: SaveFunction<V>, options: CommitOptions = {}): Promise<boolean> {
    const run = this._commitQueue.then(() => this._commitPending(save, options));
    this._commitQueue = run.catch(() => undefined);
    return run;
  }

  private async _commitPending<V>(save: SaveFunction<V>, options: CommitOptions): Promise<boolean> {
    const pending = this._log.filter((e) => e.state === EventState.NotCommitted);
    if (pending.length === 0) return false;
    // What the batch creates on the server: collapsed, only what the net effect creates.
    const { events, created } = options.mode === "operations"
      ? { events: pending.map(toGenerated), created: pending.flatMap((e) => this._recorded.get(e)!.created) }
      : this._collapse(pending);
    const batch: CommitBatch = { events };
    this._atomically(() => {
      for (const e of pending) this._inFlight.add(e.eventId);
      this._setSaving(true);
    });
    let keys: ReadonlyArray<IdAssignment<V>>;
    try {
      keys = batch.events.length > 0 ? (await save(batch)) ?? [] : [];
    } catch (error) {
      this._atomically(() => {
        this._inFlight.clear();
        this._setSaving(false);
      });
      throw error;
    }
    this._atomically(() => {
      this._inFlight.clear();
      this._setSaving(false);
      this._markCommitted(pending.map((e) => e.eventId), created, [...keys]);
    });
    return true;
  }

  /**
   * The net effect of `pending`: their changes are reopened (newest first),
   * derived once as a whole, and settled again — the same way a session merges
   * its operations. The event list itself is untouched.
   */
  private _collapse(pending: MutableEvent[]): { events: GeneratedEvent[]; created: TrackedObject[] } {
    for (const event of [...pending].reverse()) this._recorded.get(event)!.reopen();
    for (const event of pending) this._rederiving.add(event);
    const collapsed = this.collectPending();
    this._rederiving.clear();
    this._settle();
    return { events: collapsed.map((p) => p.event), created: collapsed.flatMap((p) => p.coverage.created) };
  }

  /**
   * @internal Marks the events with these `eventId`s `Committed` (unknown ids
   * are ignored) and assigns the server-assigned `@AutoId` values.
   */
  public _onCommit<V = number>(eventIds: readonly number[], keys?: IdAssignment<V>[]): void {
    const created = eventIds.flatMap((id) => {
      const event = this._byId.get(id);
      return event?.state === EventState.NotCommitted ? this._recorded.get(event)!.created : [];
    });
    this._markCommitted(eventIds, created, keys);
  }

  /** The events are sent; `created` are the objects the server created with them. */
  private _markCommitted<V>(eventIds: readonly number[], created: readonly TrackedObject[], keys?: IdAssignment<V>[]): void {
    const carried = new Set<TrackedObject>();
    for (const eventId of eventIds) {
      const event = this._byId.get(eventId);
      if (event?.state !== EventState.NotCommitted) continue;
      event.state = EventState.Committed;
      for (const obj of this._recorded.get(event)!.created) carried.add(obj);
    }
    for (const obj of created) {
      this._new.delete(obj);
      if (hasAutoId(obj)) this._awaitingKey.add(obj);
    }
    if (keys) this.assignKeys(keys);
    // Creations the collapsed batch did not need (the item was there all along): it keeps its id.
    for (const obj of carried) if (!this._refs.isProvisional(obj)) this._resolve(obj);
    this.reset();
  }

  private assignKeys<V>(keys: IdAssignment<V>[]): void {
    // An item created more than once in the batch (added, removed, added again) has the id of its last creation.
    const last = new Map<number, IdAssignment<V>>();
    for (const key of keys) last.set(key.chronicleId, key);
    this.withTrackingSuppressed(() => {
      for (const key of last.values()) {
        const obj = this._getByChronicleId(key.chronicleId);
        if (!obj) continue;
        const autoIdProp = getAutoIdProperty(Object.getPrototypeOf(obj));
        if (!autoIdProp) continue;
        writeProperty(obj, autoIdProp, key.value);
        this._awaitingKey.delete(obj);
        this._resolve(obj);
      }
    });
  }

  /** `item`'s id is now known: fill it into every placeholder not yet sent. */
  private _resolve(item: TrackedObject): void {
    // A pending event that creates it again: references made after it are to that creation, and wait for its id.
    const again = this._log.findIndex((e) => e.state === EventState.NotCommitted && this._recorded.get(e)!.created.includes(item));
    const waiting: Array<[MutableEvent, (event: MutableEvent) => void]> = [];
    for (const [event, fill] of this._placeholders.get(item) ?? []) {
      if (event.state === EventState.Committed) continue;
      if (again !== -1 && this._log.indexOf(event) > again) waiting.push([event, fill]);
      else fill(event);
    }
    if (waiting.length > 0) this._placeholders.set(item, waiting);
    else this._placeholders.delete(item);
  }

  /**
   * Reverts what has not been sent, as far as it can be reverted cleanly:
   * pending compensations are withdrawn (by redoing), operations whose events
   * are all unsent are undone, and the redo stack is dropped. It never forgets
   * an unsent event whose change is still in the objects — e.g. from an
   * operation that is partly committed, or from `tracker.new()` — so those
   * stay pending.
   */
  public discardPendingChanges(): void {
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

  /**
   * @internal A destroyed object's unsent events are withdrawn, and it takes no
   * further part in events.
   */
  public override _onObjectDestroyed(model: TrackedObject): void {
    this._destroyed.add(model);
    for (const event of [...this._log]) {
      if (event.chronicleId === model.chronicleId && event.state !== EventState.Committed) this._remove(event);
    }
    this._placeholders.delete(model);
    this._awaitingKey.delete(model);
    this._new.delete(model);
    const stillListed = [...getItemOrigins(model)].some((col) => col.collection.includes(model));
    if (stillListed && process.env.NODE_ENV !== "production") {
      console.warn(
        `EventLog: ${model.constructor.name} (chronicleId ${model.chronicleId}) was destroyed while still in a collection; ` +
        "it is ignored from now on. To delete it, remove it from the collection instead.",
      );
    }
    this.reset();
  }

  // ---- Operation lifecycle -------------------------------------------------

  protected override _onOperationStart(op: Operation, extended: boolean): void {
    if (!extended || this._isConstructing) return;
    // The write coalesces into `op`: reopen its unsent events so they absorb it.
    for (const [key, state] of this._ops.get(op)!) {
      const unsent = [...state.current].filter((r) => r.event.state === EventState.NotCommitted);
      if (unsent.length === 0) continue;
      for (const r of unsent) {
        r.reopen();
        this._rederiving.add(r.event);
      }
      this._reopened.set(key, unsent);
    }
  }

  /** The reverted write left its derived state behind: the recorded events still stand as they are. */
  protected override _onOperationAborted(_op: Operation): void {
    this._reopened = new Map();
    this._rederiving.clear();
    this._settle();
  }

  protected override _onOperationEnd(op: Operation): void {
    if (this._isConstructing) return;
    const record = recordFor(this._ops, op);
    const reopened = this._reopened;
    this._reopened = new Map();
    const reopens: Array<[Recorded, () => void]> = [];
    const pending = this.collectPending();
    this._rederiving.clear();
    for (const p of pending) {
      const [again] = reopened.get(p.key) ?? [];
      if (again) {
        reopened.get(p.key)!.shift();
        again.event.payload = p.event.payload;
        again.event.targetId = p.event.targetId;
        this._registerRefs(again.event, p.coverage);
        again.created = p.coverage.created;
        reopens.push([again, captureReopen(p.coverage)]);
      } else {
        keyState(record, p.key).current.add(this._append(p));
      }
    }
    for (const [rec, reopen] of reopens) rec.reopen = reopen;
    // Reopened events the coalesced write cancelled out entirely.
    for (const [key, recs] of reopened) {
      for (const rec of recs) {
        this._remove(rec.event);
        record.get(key)!.current.delete(rec);
      }
    }
    this._settle();
  }

  protected override _onReplayed(op: Operation): void {
    const record = this._ops.get(op)!;
    const withdrawn: Recorded[] = [];
    for (const p of this.collectPending()) {
      const state = keyState(record, p.key);
      const retract = difference(state.current, state.previous);
      if (state.reversible && retract.every((r) => r.event.state === EventState.NotCommitted)) {
        // Nothing of the last move was sent: simply reverse it.
        for (const r of retract) this._setState(r.event, EventState.Undone);
        withdrawn.push(...retract);
        const back = difference(state.previous, state.current);
        [state.current, state.previous] = [state.previous, state.current];
        if (back.length === 0) continue;
        // What it stood for before is pending again: the same event if it still says the same
        // (saves in between can change how items are referred to), else as derived now.
        if (back.length === 1 && sameEvent(back[0].event, p.event)) {
          this._reinstate(back[0], p);
          continue;
        }
        for (const r of back) {
          state.current.delete(r);
          this._remove(r.event); // superseded, never sent
        }
        const lastCommitted = Math.max(0, ...[...state.current].map((r) => r.event.eventId));
        state.current.add(this._append(p, lastCommitted || undefined));
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
          withdrawn.push(r);
        }
      }
      if (lastCommitted !== undefined) next.add(this._append(p, lastCommitted));
      state.previous = state.current;
      state.current = next;
      state.reversible = true;
    }
    // What the withdrawn events had settled is pending again (it matters for what is out of the model).
    for (const r of withdrawn.sort((a, b) => b.event.eventId - a.event.eventId)) r.reopen();
    this._settle();
  }

  protected override _onOperationsDropped(ops: readonly Operation[]): void {
    if (this._isConstructing) return;
    for (const op of ops) {
      for (const rec of recordsOf(this._ops.get(op)!)) {
        if (rec.event.state === EventState.Undone) this._remove(rec.event);
      }
      this._ops.delete(op);
    }
  }

  /**
   * Objects built by `tracker.new()` are not pending: nothing is sent until
   * they change (or are added to a collection), and then their creation is sent
   * with their whole state, the constructor's values included.
   */
  protected override _onNewCompleted(created: readonly TrackedObject[]): void {
    for (const obj of created) {
      this._new.add(obj);
    }
    this._settle();
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
    for (const p of this.collectPending()) keyState(record, p.key).current.add(this._append(p));
    this._settle();
  }

  protected override _onSessionRolledBack(reverted: readonly Operation[]): void {
    const committed = new Map<string, number>();
    const withdrawn: Recorded[] = [];
    for (const op of reverted) {
      for (const [key, state] of this._ops.get(op)!) {
        for (const rec of state.current) {
          if (rec.event.state === EventState.Committed) {
            committed.set(key, Math.max(committed.get(key) ?? 0, rec.event.eventId));
          }
        }
      }
      for (const rec of recordsOf(this._ops.get(op)!)) {
        if (rec.event.state === EventState.NotCommitted) withdrawn.push(rec);
        if (rec.event.state !== EventState.Committed) this._remove(rec.event);
      }
      this._ops.delete(op);
    }
    for (const p of this.collectPending()) {
      const compensates = committed.get(p.key);
      if (compensates !== undefined) this._append(p, compensates);
    }
    // What the withdrawn events had settled is pending again (it matters for what is out of the model).
    for (const r of withdrawn.sort((a, b) => b.event.eventId - a.event.eventId)) r.reopen();
    this._settle();
  }

  // ---- Event log -----------------------------------------------------------

  private _append(p: PendingEvent, compensates?: number): Recorded {
    const event: MutableEvent = { eventId: this._nextEventId++, ...p.event, state: EventState.NotCommitted };
    if (compensates !== undefined) event.compensates = compensates;
    this._log.push(event);
    this._byId.set(event.eventId, event);
    this._registerRefs(event, p.coverage);
    const recorded: Recorded = { event, reopen: captureReopen(p.coverage), created: p.coverage.created };
    this._recorded.set(event, recorded);
    return recorded;
  }

  private _registerRefs(event: MutableEvent, coverage: Coverage): void {
    for (const [item, fill] of coverage.placeholders) {
      let list = this._placeholders.get(item);
      if (!list) {
        list = [];
        this._placeholders.set(item, list);
      }
      list.push([event, fill]);
    }
  }

  private _remove(event: MutableEvent): void {
    this._log.splice(this._log.indexOf(event), 1);
    this._byId.delete(event.eventId);
  }

  private _setState(event: MutableEvent, state: EventState): void {
    event.state = state;
  }

  /** A withdrawn event is pending again, as derived now, after everything already in the log. */
  private _reinstate(rec: Recorded, p: PendingEvent): void {
    this._log.splice(this._log.indexOf(rec.event), 1);
    this._log.push(rec.event);
    rec.event.state = EventState.NotCommitted;
    rec.event.payload = p.event.payload;
    this._registerRefs(rec.event, p.coverage);
    rec.reopen = captureReopen(p.coverage);
    rec.created = p.coverage.created;
  }


  /**
   * Once an operation's events are recorded, the next operation starts from a
   * clean diff. What is out of the model keeps its changes: they reach no event
   * now, but count if it comes back and its removal is collapsed away.
   */
  private _settle(): void {
    for (const obj of this._trackedObjects) if (!isDetached(obj)) settleEventState(obj);
    for (const col of this._trackedCollections) if (!col._owner || !isDetached(col._owner)) col._clearHistoryOps();
  }

  // ---- Deriving the events of one operation --------------------------------

  /**
   * The events of what changed since the last settle: one per root — an object
   * outside any collection, or a collection no container owns. Collections a
   * container owns nest into their owner's payload, at any depth.
   */
  private collectPending(): PendingEvent[] {
    const refs = this._refs;
    this._snapshotted.clear();
    const events: PendingEvent[] = [];

    // Collections owned by a container, by owner.
    const ownedCollections = new Map<TrackedObject, AnyCollection[]>();
    for (const col of this._trackedCollections) {
      const owner = col._owner;
      if (!owner) continue;
      let list = ownedCollections.get(owner);
      if (!list) {
        list = [];
        ownedCollections.set(owner, list);
      }
      list.push(col);
    }
    // Objects that are parts of a container, by owner.
    const parts = new Map<TrackedObject, Part[]>();
    for (const obj of this._trackedObjects) {
      const part = obj._part;
      if (!part) continue;
      let list = parts.get(part.owner);
      if (!list) {
        list = [];
        parts.set(part.owner, list);
      }
      list.push({ object: obj, name: part.name });
    }
    const nest: Nest = { refs, owned: ownedCollections, parts, handled: new Set(), handledParts: new Set() };

    // Root objects: those not inside a collection, nor part of a container.
    for (const obj of this._trackedObjects) {
      if (getItemOrigins(obj).size > 0 || obj._part) continue;
      const coverage = newCoverage();
      const payload = changedFields(obj, refs, coverage);
      foldOwned(obj, payload, nest, coverage);
      const creation = refs.isNew(obj) && Object.keys(payload).length > 0;
      pushObjectEvent(obj, creation ? addedSnapshot(obj, nest, coverage) : payload, coverage, events, refs);
    }

    // Root collections: those no container owns.
    for (const col of this._trackedCollections) {
      if (col._owner) continue;
      const slot = computeCollectionSlot(col, nest);
      if (slot === undefined) continue;
      events.push({
        event: { payload: { [col.name]: slot.value } },
        coverage: slot.coverage,
        key: `collection:${collectionKey(col)}`,
      });
    }

    // What an item that no longer sits in any collection owns (it was added and
    // removed again, or moved out): its changes are an event of the item.
    for (const owner of new Set([...ownedCollections.keys(), ...parts.keys()])) {
      const done = (ownedCollections.get(owner) ?? []).every((col) => nest.handled.has(col))
        && (parts.get(owner) ?? []).every(({ object }) => nest.handledParts.has(object));
      if (done) continue;
      const payload: Record<string, unknown> = {};
      const coverage = newCoverage();
      foldOwned(owner, payload, nest, coverage);
      pushObjectEvent(owner, payload, coverage, events, refs);
    }

    this._snapshotted.clear();
    return events;
  }
}

/** Out of the model: removed from the collections it was in, or inside something that is. */
function isDetached(obj: TrackedObject): boolean {
  const part = obj._part;
  if (part) return isDetached(part.owner);
  const origins = [...getItemOrigins(obj)];
  if (origins.length === 0) return false;
  const holders = origins.filter((col) => col.collection.includes(obj));
  return holders.every((col) => col._owner !== undefined && isDetached(col._owner));
}

/** The event of a root object, identified by its chronicleId and (once known) its identity. */
function pushObjectEvent(
  obj: TrackedObject,
  payload: Record<string, unknown>,
  coverage: Coverage,
  events: PendingEvent[],
  refs: Refs,
): void {
  if (Object.keys(payload).length === 0) return;
  const event: GeneratedEvent = { payload, chronicleId: obj.chronicleId };
  if (refs.isProvisional(obj)) {
    // No id yet: chronicleId identifies it; targetId is filled in when the key arrives.
    coverage.placeholders.push([obj, (e) => { e.targetId = getIdentity(obj); }]);
  } else {
    const identity = getIdentity(obj);
    if (identity !== undefined) event.targetId = identity;
  }
  events.push({ event, coverage, key: `object:${obj.chronicleId}` });
}

function recordFor(ops: Map<Operation, OpRecord>, op: Operation): OpRecord {
  let record = ops.get(op);
  if (!record) {
    record = new Map();
    ops.set(op, record);
  }
  return record;
}

/** An event as sent: without the log's own bookkeeping (eventId, state, compensates). */
function toGenerated(event: TrackedEvent): GeneratedEvent {
  const out: GeneratedEvent = { payload: event.payload };
  if (event.chronicleId !== undefined) out.chronicleId = event.chronicleId;
  if (event.targetId !== undefined) out.targetId = event.targetId;
  return out;
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
  const history = getHistoryState(item);
  for (const [propName, propMeta] of meta) {
    if (propMeta.history) {
      const chain = history.get(propName);
      if (chain && chain.length > 0) coverage.history.push([item, propName, [...chain]]);
    } else {
      coverage.fields.push([item, propName, readProperty(item, propName)]);
    }
  }
  return coverage;
}

interface Slot {
  value: unknown;
  coverage: Coverage;
}

/**
 * Context for building collection slots. A collection owned by an item nests
 * into that item's entry in its parent's slot (at any depth); `handled` records
 * which owned collections have been folded somewhere already.
 */
/** An object that is part of a container, and its key in the container's payload. */
interface Part {
  object: TrackedObject;
  name: string;
}

interface Nest {
  refs: Refs;
  owned: Map<TrackedObject, AnyCollection[]>;
  parts: Map<TrackedObject, Part[]>;
  handled: Set<AnyCollection>;
  handledParts: Set<TrackedObject>;
}

/** The changed fields of `obj`: plain fields as their payload value, history fields as their entries. */
function changedFields(obj: TrackedObject, refs: Refs, coverage: Coverage): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const stateMap = getEventState(obj);
  const historyMap = getHistoryState(obj);
  for (const [propName, propMeta] of getEventMetadata(Object.getPrototypeOf(obj))) {
    if (propMeta.history) {
      const chain = historyMap.get(propName);
      if (chain && chain.length > 0) {
        fields[propName] = [...chain];
        coverage.history.push([obj, propName, [...chain]]);
      }
    } else {
      const entry = stateMap.get(propName);
      if (entry) {
        fields[propName] = propertyPayload(obj, propName);
        coverage.fields.push([obj, propName, entry.currentValue]);
        noteCreated(entry.currentValue, refs, coverage);
      }
    }
  }
  return fields;
}

function computeCollectionSlot(col: AnyCollection, nest: Nest): Slot | undefined {
  return col._isHistory ? computeHistoryOps(col, nest) : computeBucketedSlot(col, nest);
}

/** Folds the pending changes of the collections `item` owns into `target`; true if any. */
function foldOwned(item: TrackedObject, target: Record<string, unknown>, nest: Nest, coverage: Coverage): boolean {
  let folded = false;
  for (const col of nest.owned.get(item) ?? []) {
    if (nest.handled.has(col)) continue;
    nest.handled.add(col);
    const slot = computeCollectionSlot(col, nest);
    if (!slot) continue;
    target[col.name] = slot.value;
    mergeCoverage(coverage, slot.coverage);
    folded = true;
  }
  // Its parts: their changed fields, and what they own in turn, under their names.
  for (const { object, name } of nest.parts.get(item) ?? []) {
    if (nest.handledParts.has(object) || nest.refs.isDestroyed(object)) continue;
    nest.handledParts.add(object);
    const delta = changedFields(object, nest.refs, coverage);
    foldOwned(object, delta, nest, coverage);
    if (Object.keys(delta).length === 0) continue;
    target[name] = delta;
    folded = true;
  }
  return folded;
}

/** A newly added item's snapshot, with the full content of the collections it owns. */
function addedSnapshot(item: TrackedObject, nest: Nest, coverage: Coverage, base = snapshotItemForAdded(item)): Record<string, unknown> {
  mergeCoverage(coverage, coverWholeItem(item, getEventMetadata(Object.getPrototypeOf(item))));
  nest.refs.created(item);
  coverage.created.push(item);
  for (const col of nest.owned.get(item) ?? []) {
    // Always complete (an item added to two parents gets its full content in both);
    // the collection's own pending changes are part of the snapshot.
    nest.handled.add(col);
    base[col.name] = col.collection.map((child) => {
      coverage.members.push([col, child]);
      return withExtra(col, child, "add", child instanceof TrackedObject ? addedSnapshot(child, nest, coverage) : undefined);
    });
    coverage.ops.push([col, [...col._historyOpsList]]);
  }
  for (const { object, name } of nest.parts.get(item) ?? []) {
    nest.handledParts.add(object);
    base[name] = addedSnapshot(object, nest, coverage);
  }
  return base;
}

/** An item that left takes its whole subtree along: nothing inside it is reported separately. */
function dropOwned(item: TrackedObject, nest: Nest): void {
  for (const col of nest.owned.get(item) ?? []) {
    if (nest.handled.has(col)) continue;
    nest.handled.add(col);
    for (const child of new Set([...col.collection, ...col._baselineListSnapshot()])) {
      if (child instanceof TrackedObject) dropOwned(child, nest);
    }
  }
  for (const { object } of nest.parts.get(item) ?? []) {
    if (nest.handledParts.has(object)) continue;
    nest.handledParts.add(object);
    dropOwned(object, nest);
  }
}

function computeHistoryOps(col: AnyCollection, nest: Nest): Slot | undefined {
  const { refs } = nest;
  const opsList = col._historyOpsList;
  const coverage = newCoverage();

  const ops: unknown[] = [];
  for (const op of opsList) {
    if (refs.isDestroyed(op.item)) continue;
    if (op.op === "add") {
      refs.created(op.item);
      ops.push({ op: "add", item: addedSnapshot(op.item, nest, coverage, { ...op.snapshot }), ...op.extra });
    } else if (op.op === "remove") {
      const entry: Record<string, unknown> = { op: "remove" };
      assignRef(entry, op.item, refs, coverage, op.identity);
      ops.push(Object.assign(entry, op.extra));
      dropOwned(op.item, nest);
    } else {
      const entry: Record<string, unknown> = { op: "change" };
      assignRef(entry, op.item, refs, coverage);
      ops.push(Object.assign(entry, op.diff, op.extra));
    }
  }

  // Changes inside collections owned by items still in this one, as `change` ops.
  for (const item of col.collection) {
    if (!(item instanceof TrackedObject) || refs.isDestroyed(item)) continue;
    const entry: Record<string, unknown> = { op: "change" };
    assignRef(entry, item, refs, coverage);
    if (foldOwned(item, entry, nest, coverage)) ops.push(entry);
  }

  if (ops.length === 0) return undefined;
  coverage.ops.push([col, [...opsList]]);
  return { value: { ops }, coverage };
}

function computeBucketedSlot(col: AnyCollection, nest: Nest): Slot | undefined {
  const { refs } = nest;
  const members = new Set<unknown>(col.collection);
  const added: unknown[] = [];
  const changed: unknown[] = [];
  const removed: unknown[] = [];
  const coverage = newCoverage();

  const isPrimitive = !hasTrackedObjectItems(col);

  for (const item of col.collection) {
    if (refs.isDestroyed(item)) continue;
    if (!col._isInBaseline(item)) {
      added.push(withExtra(col, item, "add", item instanceof TrackedObject ? addedSnapshot(item, nest, coverage) : undefined));
      coverage.members.push([col, item]);
    } else if (item instanceof TrackedObject) {
      const entry = buildChangedEntry(item, coverage, nest);
      if (entry) changed.push(Object.assign(entry, col._extraFor(item, "change")));
    }
  }

  for (const baselineItem of col._baselineListSnapshot()) {
    if (members.has(baselineItem) || refs.isDestroyed(baselineItem)) continue;
    const extra = col._extraFor(baselineItem, "remove");
    if (baselineItem instanceof TrackedObject) {
      if (col._hasToPayload) {
        // With toPayload every entry is an object: the identity plus its fields.
        const entry: Record<string, unknown> = {};
        assignRef(entry, baselineItem, refs, coverage);
        removed.push(Object.assign(entry, extra));
      } else {
        pushRef(removed, baselineItem, refs, coverage);
      }
      dropOwned(baselineItem, nest);
    } else {
      removed.push(withExtra(col, baselineItem, "remove", undefined));
    }
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

  // The server assigns the @AutoId: chronicleId is how the save function reports it back.
  if (autoIdProp) snapshot.chronicleId = item.chronicleId;
  for (const idProp of idProps) {
    if (idProp === autoIdProp) {
      snapshot[idProp] = null;
    } else {
      snapshot[idProp] = readProperty(item, idProp);
    }
  }
  for (const [propName] of meta) {
    snapshot[propName] = propertyPayload(item, propName);
  }
  return snapshot;
}

/**
 * An added or removed entry with the collection's toPayload fields for `kind`
 * merged in: a model item's entry is `entry`, a plain value becomes `{ value }`.
 * Without toPayload, a plain value is written as is.
 */
function withExtra(col: AnyCollection, item: unknown, kind: "add" | "remove", entry: Record<string, unknown> | undefined): unknown {
  if (entry !== undefined) return Object.assign(entry, col._extraFor(item, kind));
  return col._hasToPayload ? { value: item, ...col._extraFor(item, kind) } : item;
}

/** An existing item's `changed` entry: its own edits, and changes inside collections it owns. */
function buildChangedEntry(item: TrackedObject, coverage: Coverage, nest: Nest): Record<string, unknown> | undefined {
  const entry: Record<string, unknown> = {};
  assignRef(entry, item, nest.refs, coverage);
  const fields = changedFields(item, nest.refs, coverage);
  Object.assign(entry, fields);
  const nested = foldOwned(item, entry, nest, coverage);
  return Object.keys(fields).length > 0 || nested ? entry : undefined;
}

/** A field holding a new object carries its snapshot, which creates it on the server. */
function noteCreated(value: unknown, refs: Refs, coverage: Coverage): void {
  if (value instanceof TrackedObject && refs.isNew(value)) coverage.created.push(value);
}

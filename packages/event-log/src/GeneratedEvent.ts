import type { HistoryEntry } from "@chronicle/core";

/**
 * The pending changes of one root of the model:
 * - a root object: its changed fields, and the changes of the collections it
 *   owns nested under their names; `targetId` is its identity, `chronicleId`
 *   identifies it until the server has assigned its `@AutoId`;
 * - a root collection: `{ [name]: { added, removed, changed } }`.
 */
export interface GeneratedEvent<TPayload = Record<string, unknown>> {
  payload: TPayload;
  chronicleId?: number;
  targetId?: unknown;
}

/** One undo step of an `EventLog`, with the events its operation produced. */
export interface EventEntry extends HistoryEntry {
  /** What the operation did, as events (compensations for undo are not listed). */
  readonly events: readonly GeneratedEvent[];
}

/** @internal Where an event stands with respect to the server. */
export enum EventState {
  /** Recorded, not yet acknowledged — send it. */
  NotCommitted = 'NotCommitted',
  /** Acknowledged by the server. Permanent: undoing it adds a compensating event. */
  Committed = 'Committed',
  /** Undone before it was sent. Never send it; redo returns it to `NotCommitted`. */
  Undone = 'Undone',
}

/** @internal An event of the log, with its bookkeeping. */
export interface TrackedEvent<TPayload = Record<string, unknown>> extends GeneratedEvent<TPayload> {
  /** Unique within the tracker. */
  readonly eventId: number;
  readonly state: EventState;
  /** Set on compensating events: the `eventId` of the committed event this one reverts. */
  readonly compensates?: number;
}

/**
 * What `EventLog.commit` hands to the save function: everything pending,
 * collapsed into one JSON — one event per root, holding the net effect of all
 * its unsent operations.
 */
export interface CommitBatch {
  events: GeneratedEvent[];
}

/**
 * How `EventLog.commit` builds its batch:
 * - `"collapsed"` (default): the net state per root — each field or collection
 *   sends its last state, or its list of changes if it is configured with `history`.
 * - `"operations"`: every pending event, one per operation, in the order they happened.
 */
export type CommitMode = "collapsed" | "operations";

export interface CommitOptions {
  mode?: CommitMode;
}

/** Persists a batch; resolves to the server-assigned `@AutoId` values (`{ chronicleId, value }`), if any. */
export type SaveFunction<V = number> = (
  batch: CommitBatch,
) => Promise<ReadonlyArray<{ chronicleId: number; value: V }> | void> | ReadonlyArray<{ chronicleId: number; value: V }> | void;

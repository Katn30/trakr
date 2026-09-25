export interface GeneratedEvent<
  TEventType extends string = string,
  TPayload = Record<string, unknown>,
> {
  eventType: TEventType;
  payload: TPayload;
  trackingId?: number;
  targetId?: unknown;
}

/** Where an event stands with respect to the server. */
export enum EventState {
  /** Recorded, not yet acknowledged — send it. */
  NotCommitted = 'NotCommitted',
  /** Acknowledged by the server. Permanent: undoing it adds a compensating event. */
  Committed = 'Committed',
  /** Undone before it was sent. Never send it; redo returns it to `NotCommitted`. */
  Undone = 'Undone',
}

/** One entry of `EventTracker.events`: an event produced by one operation. */
export interface TrackedEvent<
  TEventType extends string = string,
  TPayload = Record<string, unknown>,
> extends GeneratedEvent<TEventType, TPayload> {
  /** Unique within the tracker; pass it (or the event) to `onCommit`. */
  readonly eventId: number;
  readonly state: EventState;
  /** Set on compensating events: the `eventId` of the committed event this one reverts. */
  readonly compensates?: number;
}

export interface EventLifecycleOptions<TEventType extends string = string> {
  itemAdded?: TEventType;
  itemRemoved?: TEventType;
}

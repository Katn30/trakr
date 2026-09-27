import { EventLog } from "../packages/event-log/src/EventLog";
import { EventState, GeneratedEvent, TrackedEvent } from "../packages/event-log/src/GeneratedEvent";

/** Every event of the log, oldest first, in all states (internal: tests only). */
export function events(tracker: EventLog): readonly TrackedEvent[] {
  return (tracker as unknown as { _log: TrackedEvent[] })._log;
}

/** The events not sent yet, oldest first (internal: tests only). */
export function pendingEvents(tracker: EventLog): TrackedEvent[] {
  return events(tracker).filter((e) => e.state === EventState.NotCommitted);
}

/** The pending events as plain GeneratedEvents (without eventId / state), oldest first. */
export function emitted(tracker: EventLog): GeneratedEvent[] {
  return pendingEvents(tracker).map(({ eventId: _id, state: _state, compensates: _c, ...event }) => event as GeneratedEvent);
}

/** Runs `writes` as a single operation (one undo step, one set of events). */
export function oneOperation(tracker: EventLog, writes: () => void): void {
  const session = tracker._startSession();
  writes();
  session.end();
}

/** The eventIds of the pending events. */
export function pendingIds(tracker: EventLog): number[] {
  return pendingEvents(tracker).map((e) => e.eventId);
}

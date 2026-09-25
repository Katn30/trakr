import { EventTracker } from "../src/EventTracker";
import { GeneratedEvent } from "../src/GeneratedEvent";

/** The pending events as plain GeneratedEvents (without eventId / state), oldest first. */
export function emitted<T extends string = string>(tracker: EventTracker): GeneratedEvent<T>[] {
  return tracker.pendingEvents.map(({ eventId: _id, state: _state, compensates: _c, ...event }) => event as GeneratedEvent<T>);
}

/** Runs `writes` as a single operation (one undo step, one set of events). */
export function oneOperation(tracker: EventTracker, writes: () => void): void {
  const session = tracker.startSession();
  writes();
  session.end();
}

/** The eventIds of the pending events — what a client sends back to onCommit. */
export function pendingIds(tracker: EventTracker): number[] {
  return tracker.pendingEvents.map((e) => e.eventId);
}

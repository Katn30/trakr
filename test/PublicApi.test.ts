import { describe, it, expect } from "vitest";
import * as trakr from "../src/index";

describe("public entry point", () => {
  it("exports every runtime member of the API", () => {
    const expected = [
      // trackers and sessions
      "Tracker", "DirtyTracker", "EventTracker", "TrackerSession", "DirtyTrackerSession",
      // models and containers
      "TrackedObjectBase", "TrackedObject", "DirtyTrackedObject", "TrackedContainer", "DirtyTrackedContainer",
      // collections and decorators
      "TrackedCollection", "TrackedCollectionChanged", "EventTrackedCollection", "Tracked", "EventTracked",
      // identity
      "AutoId", "Id", "getIdentity", "getIdentityObject", "getIdentityProperties",
      // enums and events
      "State", "EventState", "TypedEvent",
    ];
    for (const name of expected) {
      expect(trakr, name).toHaveProperty(name);
    }
    expect(Object.keys(trakr).sort()).toEqual([...expected].sort());
  });

  it("the model hierarchy is wired as documented", () => {
    expect(Object.getPrototypeOf(trakr.TrackedObject)).toBe(trakr.TrackedObjectBase);
    expect(Object.getPrototypeOf(trakr.DirtyTrackedObject)).toBe(trakr.TrackedObjectBase);
    expect(Object.getPrototypeOf(trakr.TrackedContainer)).toBe(trakr.TrackedObject);
    expect(Object.getPrototypeOf(trakr.DirtyTrackedContainer)).toBe(trakr.DirtyTrackedObject);
    expect(Object.getPrototypeOf(trakr.DirtyTracker)).toBe(trakr.Tracker);
    expect(Object.getPrototypeOf(trakr.EventTracker)).toBe(trakr.Tracker);
    expect(Object.getPrototypeOf(trakr.DirtyTrackerSession)).toBe(trakr.TrackerSession);
    expect(Object.getPrototypeOf(trakr.EventTrackedCollection)).toBe(trakr.TrackedCollection);
  });
});

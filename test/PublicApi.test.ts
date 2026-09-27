import { describe, it, expect } from "vitest";
import * as core from "@chronicle/core";
import * as unitOfWork from "@chronicle/unit-of-work";
import * as eventLog from "@chronicle/event-log";

/** Core's public API: what both flavours re-export. */
const corePublic = [
  "Tracker", "TrackedObjectBase", "Tracked", "TrackedCollection", "TrackedCollectionChanged",
  "AutoId", "Id", "getIdentity", "getIdentityObject", "getIdentityProperties",
];

/** Core internals shared with the flavours, never re-exported by them (TypedEvent only as a type). */
const coreInternal = [
  "TypedEvent",
  "Operation", "OperationProperties", "PropertyType", "Change", "CollectionUtilities",
  "DependencyTracker", "ContainerChildren", "getAutoIdProperty", "TrackerSession", "trackedImplementation",
  "TrackedCollectionBase", "ClassMetadata", "readProperty", "writeProperty",
];

const sorted = (names: string[]) => [...names].sort();

describe("package entry points", () => {
  it("@chronicle/core: the public API plus the internals the flavours use", () => {
    expect(Object.keys(core).sort()).toEqual(sorted([...corePublic, ...coreInternal]));
  });

  it("@chronicle/unit-of-work: core's public API plus the unit of work", () => {
    expect(Object.keys(unitOfWork).sort()).toEqual(sorted([
      ...corePublic, "UnitOfWork", "Entity", "EntityContainer", "State",
    ]));
  });

  it("@chronicle/event-log: core's public API plus the event log", () => {
    expect(Object.keys(eventLog).sort()).toEqual(sorted([
      ...corePublic, "EventLog", "TrackedObject", "TrackedContainer", "EventTracked", "EventTrackedCollection",
    ]));
  });

  it("the flavours re-export core's own classes (a single copy of core)", () => {
    for (const name of corePublic) {
      expect(unitOfWork[name as keyof typeof unitOfWork], name).toBe(core[name as keyof typeof core]);
      expect(eventLog[name as keyof typeof eventLog], name).toBe(core[name as keyof typeof core]);
    }
  });

  it("the model hierarchy is wired as documented", () => {
    expect(Object.getPrototypeOf(eventLog.TrackedObject)).toBe(core.TrackedObjectBase);
    expect(Object.getPrototypeOf(unitOfWork.Entity)).toBe(core.TrackedObjectBase);
    expect(Object.getPrototypeOf(eventLog.TrackedContainer)).toBe(eventLog.TrackedObject);
    expect(Object.getPrototypeOf(unitOfWork.EntityContainer)).toBe(unitOfWork.Entity);
    expect(Object.getPrototypeOf(unitOfWork.UnitOfWork)).toBe(core.Tracker);
    expect(Object.getPrototypeOf(eventLog.EventLog)).toBe(core.Tracker);
    expect(Object.getPrototypeOf(eventLog.EventTrackedCollection)).toBe(core.TrackedCollectionBase);
    expect(Object.getPrototypeOf(core.TrackedCollection)).toBe(core.TrackedCollectionBase);
  });
});

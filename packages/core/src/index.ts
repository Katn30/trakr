// @katn30/chronicle-core — the shared core of @katn30/chronicle-unit-of-work and @katn30/chronicle-event-log.
export { Tracker } from './Tracker.js'
export { TrackedObjectBase } from './TrackedObjectBase.js'
export type { TrackedPropertyChanged } from './TrackedObjectBase.js'
export { Tracked } from './Tracked.js'
export type { ChangeHook, ChangeHooks, PropertyValidator, TrackedOptions } from './Tracked.js'
export { TrackedCollection, TrackedCollectionChanged } from './TrackedCollection.js'
export type { ITracked } from './ITracked.js'
export type { HistoryEntry } from './HistoryEntry.js'
export { AutoId, Id, getIdentity, getIdentityObject, getIdentityProperties } from './ExternallyAssigned.js'
export type { IdAssignment } from './ExternallyAssigned.js'

// ---- Internals shared with @katn30/chronicle-unit-of-work and @katn30/chronicle-event-log.
// Not part of the public API: they may change in any release. Applications
// import from one of those two packages, which re-export only the public API.
// TypedEvent is public as a type (subscribe/unsubscribe); constructing and emitting is internal.
export { TypedEvent } from './TypedEvent.js'
/** @internal */ export { Operation } from './Operation.js'
/** @internal */ export { OperationProperties } from './OperationProperties.js'
/** @internal */ export { PropertyType } from './PropertyType.js'
/** @internal */ export { Change } from './Change.js'
/** @internal */ export { CollectionUtilities } from './CollectionUtilities.js'
/** @internal */ export { DependencyTracker } from './DependencyTracker.js'
/** @internal */ export { ContainerChildren } from './ContainerChildren.js'
/** @internal */ export { getAutoIdProperty } from './ExternallyAssigned.js'
/** @internal */ export { trackedImplementation } from './Tracked.js'
/** @internal */ export { readProperty, writeProperty, ClassMetadata } from './Properties.js'
/** @internal */ export { TrackerSession } from './TrackerSession.js'
/** @internal */ export { TrackedCollectionBase } from './TrackedCollection.js'
/** @internal */ export type { CollectionValidator } from './TrackedCollection.js'
/** @internal */ export type { PropertyScope } from './TrackerSession.js'

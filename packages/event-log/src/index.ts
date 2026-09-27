// The public API of @katn30/chronicle-core, so applications import everything from this package.
export {
  Tracker, TrackedObjectBase, Tracked, TrackedCollection, TrackedCollectionChanged,
  AutoId, Id, getIdentity, getIdentityObject, getIdentityProperties,
} from '@katn30/chronicle-core'
export type {
  TrackedPropertyChanged, ChangeHook, ChangeHooks, PropertyValidator, TrackedOptions, ITracked, IdAssignment, TypedEvent, HistoryEntry,
} from '@katn30/chronicle-core'

export { EventLog } from './EventLog.js'
export { TrackedObject } from './TrackedObject.js'
export { TrackedContainer } from './TrackedContainer.js'
export { EventTracked } from './EventTracked.js'
export type { EventTrackedOptions } from './EventTracked.js'
export { EventTrackedCollection } from './EventTrackedCollection.js'
export type { EventTrackedCollectionOptions, CollectionToPayload, CollectionOpKind } from './EventTrackedCollection.js'
export type { GeneratedEvent, EventEntry, CommitBatch, CommitMode, CommitOptions, SaveFunction } from './GeneratedEvent.js'
export type { PropertyToPayload } from './EventRegistry.js'

// The public API of @chronicle/core, so applications import everything from this package.
export {
  Tracker, TrackedObjectBase, Tracked, TrackedCollection, TrackedCollectionChanged,
  AutoId, Id, getIdentity, getIdentityObject, getIdentityProperties,
} from '@chronicle/core'
export type {
  TrackedPropertyChanged, ChangeHook, ChangeHooks, PropertyValidator, TrackedOptions, ITracked, IdAssignment, TypedEvent, HistoryEntry,
} from '@chronicle/core'

export { UnitOfWork } from './UnitOfWork.js'
export type { CommitBatch, SaveFunction } from './UnitOfWork.js'
export { Entity } from './Entity.js'
export { EntityContainer } from './EntityContainer.js'
export { State } from './State.js'

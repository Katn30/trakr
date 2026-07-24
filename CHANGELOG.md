# Changelog

## [4.0.0] — 2026-07-24

### Breaking changes and new features in the event layer

v4 restructures the event-generation surface introduced in v3 around two ideas:

1. **A save produces one event per group by default.** With no configuration, all changes on a tracked object collapse into a single event, with owned collections contributing nested payload slots.
2. **History mode preserves every intermediate operation** for properties or collections that opt in, with a caller-supplied factory when the entry shape is richer than the raw value.

Identity is now decoupled from auto-assignment: `@Id` marks caller-provided identity (any type, composite allowed), while `@AutoId` continues to represent server-assigned numeric ids resolved at commit time. Collections have become aggregate roots over their items — items in an `EventTrackedCollection` no longer emit their own top-level events; they contribute to a set-diff or ordered-ops slot on the owner's payload.

**Breaking:**

- `@EventTracked(eventType, validator?, onChange?, options?)` → `@EventTracked(validator?, onChange?, options?)`. `eventType` has moved into `options.eventType` (optional). Properties with no `eventType` share the implicit default group.
- `GeneratedEvent.targetId` widened from `number` to `unknown`. Composite/string identities now flow through unchanged; consumers reading `targetId` as `number` must narrow.
- `EventTrackedCollection` constructor's fourth argument is now `EventTrackedCollectionOptions` (still accepts `itemAdded` / `itemRemoved` for backward compatibility; adds `eventType`, `history`, `owner`). Setting `eventType` or `history` switches the collection into aggregate mode.
- Item classes used in `EventTrackedCollection` in aggregate mode must declare at least one `@Id` or `@AutoId` — the constructor throws when an item without identity is added.

**New exports:**

| Symbol | Kind | Purpose |
|---|---|---|
| `@Id` | decorator | Marks a caller-provided identity property. Any type. Composite keys formed by declaring `@Id` more than once on a class. Trakr never mutates it. |
| `getIdentity(obj)` | function | Returns the item's identity: scalar for a single identity property, object for composite, `undefined` when none. |
| `getIdentityObject(obj)` | function | Always returns identity as an object keyed by property names. |
| `getIdentityProperties(proto)` | function | Returns the ordered list of identity property names for a prototype. |
| `EventTracker.withContext(ctx, action)` | method | Runs `action` inside a context frame. Any history-mode write inside the frame captures the frame's `ctx` for the `entryFactory`. Frames nest; innermost wins. |
| `history` (property option) | option | `true` or `{ entryFactory }`. Every operation appends to a per-property chain. On save, serialised as `payload[prop] = [entry, ...]`. Cleared on commit. |
| `EventTrackedCollectionOptions.eventType` / `.history` / `.owner` | options | Aggregate-mode configuration for `EventTrackedCollection`. |

**Emission model:**

- For each dirty top-level `TrackedObject`, one event per distinct `eventType` present across its dirty scalar properties and owned aggregate collections. Ungrouped items share the empty-string default group.
- Collections in aggregate mode contribute one slot in the owner's payload keyed by the collection's property name.
  - Non-history: `{ added, changed, removed }` with sparse per-item diffs and identity inlined in `changed` entries.
  - History: `{ ops: [...] }` preserving operation order, with either the predefined `{op, item|identity|diff}` shape or `entryFactory` return values.
- Net-zero cancellation: `A → B → A` on a scalar, or add-then-remove of a new item, emit nothing.
- Legacy `itemAdded` / `itemRemoved` without `eventType` and without `history`: continue to emit one top-level event per operation, exactly as v3.

**Commit / undo / redo:**

- `onCommit` re-baselines non-history properties and clears history chains and collection ops. `@AutoId` values are patched from `IdAssignment[]` as before.
- Undo across a commit boundary is treated as a new operation: a new chain entry is appended for history-mode properties, and non-history diffs reflect the reversion.

**Migration:**

```typescript
// v3
@EventTracked(IssueEvents.Renamed, undefined, undefined, { coalesceWithin: 300 })
accessor name: string = '';

// v4
@EventTracked(undefined, undefined, {
  eventType: IssueEvents.Renamed,
  coalesceWithin: 300,
})
accessor name: string = '';
```

Consumers that only used `@EventTracked` for grouped emission and legacy `itemAdded`/`itemRemoved` collections need only the positional-to-options migration above; the emitted event shape is unchanged. Consumers moving to the aggregate model add `owner` on the collection and (optionally) `@Id` on item classes.

---

## [3.0.0] — 2026-07-16

### New: opt-in event generation for event-sourced backends

v3 introduces a fully opt-in layer for consumers moving to event-sourced DDD backends. On Save, instead of shipping a state-diff payload, trakr can produce a **list of typed events** derived declaratively from the tracker's dirty state. No callbacks, no resolvers — the mapping is 100% declarative.

**Why v3 (not v2.3):** the release adds new top-level exports and reserves the right to refine the new API surface. **It is fully backwards compatible.** Consumers using `Tracker`, `TrackedObject`, `TrackedCollection`, `@Tracked`, and `@AutoId` see **zero behavioural change** and need no code changes.

**New exports:**

| Symbol | Kind | Purpose |
|---|---|---|
| `EventTracker` | class extending `Tracker` | Adds `generateEvents<TEventType>(): GeneratedEvent<TEventType>[]` |
| `@EventTracked(eventType, validator?, onChange?, options?)` | decorator | Same semantics as `@Tracked`, plus an event-type tag that groups fields into events |
| `EventTrackedCollection<T>` | class extending `TrackedCollection<T>` | Adds an optional lifecycle option bag: `{ itemAdded?, itemRemoved? }` |
| `GeneratedEvent<TEventType, TPayload>` | interface | `{ eventType, payload, trackingId?, targetId? }` |
| `EventLifecycleOptions<TEventType>` | interface | `{ itemAdded?, itemRemoved? }` |

**Core mechanics:**

- **Field-cluster grouping.** Fields sharing a tag collapse into one event. The payload contains only the dirty fields with that tag.
- **Only actual differences generate events.** A write followed by a revert (or `undo`) produces no event. Values that never changed since the last commit never appear in a payload.
- **Insert lifecycle.** An `Insert` item in an `EventTrackedCollection` configured with `itemAdded` emits **one** event with all `@EventTracked` fields on the item. Insert-then-remove collapses to zero events (per v2 state-machine semantics).
- **Delete lifecycle.** A `Deleted` item in an `EventTrackedCollection` configured with `itemRemoved` emits **one** event with `payload = {}` and `targetId` set from the item's `@AutoId`.
- **Changed lifecycle.** Field-cluster events with only the dirty fields for each tag, `trackingId` and `targetId` set.
- **Deterministic ordering.** Objects appear in tracker registration order; within an object, field-cluster events appear in field declaration order. Consumers control semantic ordering (e.g. "field revisions before state transitions") by declaring the transition field last.
- **`onCommit` clears the event diff.** After a successful commit, `generateEvents()` returns `[]` until the next edit. Undo past a commit repopulates the diff naturally.
- **Pure read.** `generateEvents()` performs no mutation; calling it twice with no intervening writes returns the same list.

**No v2 behaviour was changed.** The base classes gained no new required knowledge of events. Existing tests are 100% green — v3 adds 48 new tests covering the event-generation surface.

---

## [2.2.1] — 2026-07-13

### Bug fix: `@Tracked` validators no longer bleed across sibling subclasses

`registerPropertyValidator` used `VALIDATORS in proto`, which walks the prototype chain. When a base `TrackedObject` subclass was instantiated first, the `[VALIDATORS]` map was defined as an OWN property of that base's prototype. Any later subclass that registered its own validators then reused the base's map via the chain — and so did its siblings. The end result was that a subclass-only validator (e.g. `SubA.validateFoo`) ended up in the shared map and was invoked on every sibling instance during revalidation, throwing `X is not a function` when the sibling didn't declare that method.

**Fix:** `registerPropertyValidator` now uses `Object.prototype.hasOwnProperty.call(proto, VALIDATORS)` so each subclass prototype gets its OWN map. `validate` and `validateSingleProperty` walk the prototype chain and merge validators from every ancestor's own map (leaf wins for duplicate property names), so base-class validators still fire on subclass instances.

**Impact on consumers:** subclass validator lambdas that were guarded with `typeof self.methodName === 'function'` workarounds can now drop the guard.

---

## [2.2.0] — 2026-04-07

### `ITrackerContext` extended — toolbar-ready interface

`ITrackerContext` now covers the full set of members needed to drive an undo/redo toolbar, a save button, and a debug panel without knowing whether the backing context is a `Tracker` or a `TrackerSession`.

**New members:**

| Member | Type | Notes |
|---|---|---|
| `canUndo` | `boolean` | Delegates to `tracker.canUndo` on `TrackerSession` |
| `canRedo` | `boolean` | Delegates to `tracker.canRedo` on `TrackerSession` |
| `undo()` | `void` | Delegates to `tracker.undo()` on `TrackerSession` |
| `redo()` | `void` | Delegates to `tracker.redo()` on `TrackerSession` |
| `isDirtyChanged` | `TypedEvent<boolean>` | Re-exposes `tracker.isDirtyChanged` on `TrackerSession` |
| `canCommitChanged` | `TypedEvent<boolean>` | Re-exposes `tracker.canCommitChanged` on `TrackerSession` |
| `versionChanged` | `TypedEvent<number>` | Re-exposes `tracker.versionChanged` on `TrackerSession` |

A toolbar component can now be written against `ITrackerContext` and accept either object interchangeably:

```typescript
function bindToolbar(ctx: ITrackerContext) {
  undoButton.disabled  = !ctx.canUndo;
  redoButton.disabled  = !ctx.canRedo;
  saveButton.disabled  = !ctx.canCommit;
  ctx.versionChanged.subscribe(() => refresh(ctx));
}

bindToolbar(tracker);  // global
bindToolbar(session);  // scoped to an edit form
```

---

## [2.1.0] — 2026-04-07

### New: `ITrackerContext` — shared interface for `Tracker` and `TrackerSession`

Both `Tracker` and `TrackerSession` now implement `ITrackerContext`, making it possible to bind a single toolbar or UI component to either one without knowing the concrete type.

```typescript
import { ITrackerContext } from 'trakr';

function bindToolbar(ctx: ITrackerContext) {
  // undo/redo buttons, save button, debug panel — all driven by ITrackerContext
}

bindToolbar(tracker);         // global scope
bindToolbar(session);         // modal / edit-form scope
```

**Interface members:**

| Member | Type | Description |
|---|---|---|
| `isDirty` | `boolean` | `true` when there are uncommitted changes in scope |
| `isValid` | `boolean` | `true` when all scoped properties pass validation |
| `canCommit` | `boolean` | `true` when `isDirty && isValid` |
| `trackedObjects` | `TrackedObject[]` | Objects in scope |
| `deletedObjects` | `TrackedObject[]` | Scoped objects in `Deleted` state |

**`TrackerSession` changes:**

- `isDirty` now returns `boolean` instead of `boolean | undefined`. Defaults to `false` when no scope is provided (previously `undefined`).
- `isValid` now returns `boolean` instead of `boolean | undefined`. Defaults to `true` when no scope is provided (previously `undefined`).
- `canCommit`, `trackedObjects`, and `deletedObjects` added.

---

## [2.0.0] — 2026-04-07

### Breaking changes

**`startComposing()` renamed to `startSession()`**, and it now returns a `TrackerSession` instead of `void`.

**`endComposing()` and `rollbackComposing()` removed from the public API.** Use `session.end()` and `session.rollback()` on the `TrackerSession` returned by `startSession()`.

```typescript
// 1.x
tracker.startComposing();
// ...
tracker.endComposing();
tracker.rollbackComposing();

// 2.0
const session = tracker.startSession();
// ...
session.end();
session.rollback();
```

### New: `TrackerSession` with scoped `isDirty` and `isValid`

`startSession()` accepts an optional **property scope** — a list of `[object, propertyNames]` tuples — and returns a `TrackerSession` whose `isDirty` and `isValid` are bounded to those properties.

This is designed for edit modals where a save button must reflect only the state of the fields being edited, independently of the rest of the tracked graph:

```typescript
import { PropertyScope } from 'trakr';

const session = tracker.startSession([
  [model, ['firstName', 'lastName', 'email']],
]);

showModal({
  onConfirm: () => session.end(),
  onCancel:  () => session.rollback(),
  canSave:   () => session.isDirty === true && session.isValid === true,
});
```

- **`isDirty`** — `false` when the session starts; becomes `true` once the user writes to any declared property. Returns `undefined` when no scope is passed.
- **`isValid`** — `false` if any declared property has a validation error, including pre-existing ones. Returns `undefined` when no scope is passed.

The scope has no effect on what gets committed or rolled back: `session.end()` always merges all writes into one undo step, and `session.rollback()` always reverts them all.

---

## [1.1.1] — 2026-04-07

### Bug fix: coalesced writes now always emit a version bump

When a `@Tracked` property with `coalesceWithin` received a second change within the coalesce window, the model value was updated but `version` was not incremented. Subscribers using `useSyncExternalStore` (or any version-based observer) would therefore skip the re-render, leaving the UI out of sync with the model.

**Root cause:** the coalesce branch in `Tracker._doAndTrack` called `versionChanged.emit(this._version)` without first incrementing `_version`.

**Fix:** `_version` is now incremented unconditionally on every tracked write. Coalescing only affects the undo stack (rapid changes are merged into a single undo step); it is orthogonal to version / change-notification and no longer suppresses it.

---

## [1.1.0] — 2026-04-07

### Breaking changes

**`idPlaceholder` removed.** `TrackedObject` no longer exposes an `idPlaceholder` property. It is replaced by `trackingId` (see below).

**`IdAssignment.placeholder` renamed to `IdAssignment.trackingId`:**

```typescript
// 1.0.0
tracker.onCommit([{ placeholder: -1, value: 42 }]);

// 1.1.0
tracker.onCommit([{ trackingId: obj.trackingId, value: 42 }]);
```

### New: `trackingId`

Every `TrackedObject` now receives a `readonly trackingId: number` assigned at construction time. It is:

- **Positive** — no longer a negative counter tied to collection push
- **Stable** — never changes across undo, redo, or state transitions
- **Unique** — globally unique across the lifetime of the tracker, never reused

`trackingId` replaces `idPlaceholder` as the correlation key between the frontend save payload and the backend response.

### `onCommit` now applies to `Changed` items

Previously, `onCommit(keys)` only wrote the real server PK to the `@AutoId` field for `Insert` items, matched via the old `idPlaceholder`. In 1.1.0 it matches by `trackingId` and writes the PK for **any** item found in `keys` — including `Changed` items.

This is necessary for **temporally versioned tables**, where an update does not modify a row in place but instead closes the current row (`dt_end_validity = now()`) and inserts a new one with a fresh auto-increment PK. Without this, the `@AutoId` field on a `Changed` object would become stale after a successful save, pointing to the closed row. The next save would then try to close the wrong row.

With 1.1.0, the backend returns `{ trackingId, value }` for every item that produced a new database row — both inserts and temporal updates — and `onCommit` updates the `@AutoId` field of all matched objects in one pass.

### Migration guide

**Insert items** — replace `idPlaceholder` with `trackingId`:

```typescript
// Before
case State.Insert:
  payload.inserts.push({ placeholder: obj.idPlaceholder!, status: obj.status });

// After
case State.Insert:
  payload.inserts.push({ trackingId: obj.trackingId, status: obj.status });
```

**Changed items on temporal tables** — add `trackingId` to the payload:

```typescript
// Before — no way to receive and apply a new PK after a temporal update
case State.Changed:
  payload.changes.push({ id: obj.id, status: obj.status });

// After — backend echoes trackingId back alongside the new PK
case State.Changed:
  payload.changes.push({ trackingId: obj.trackingId, id: obj.id, status: obj.status });
```

**`onCommit`** — update the response shape passed to it:

```typescript
// Before: response.ids was { placeholder: number; value: number }[]
// After:  response.ids is  { trackingId: number; value: number }[]
tracker.onCommit(response.ids);
```

The backend should return one entry per item that produced a new row. For non-temporal tables, only inserts produce new rows. For temporal tables, both inserts and updates do.

---

## [1.0.0] — initial release

- `Tracker` with undo/redo, dirty tracking, validation, and commit lifecycle
- `TrackedObject` abstract base class with `@Tracked()`, `@AutoId`, and state machine (`Unchanged`, `Insert`, `Changed`, `Deleted`)
- `TrackedCollection<T>` with full array API, change events, and collection validators
- TC39 Stage 3 decorator support — no `experimentalDecorators` needed
- Automatic cross-property dependency tracking for validators
- `startComposing` / `endComposing` / `rollbackComposing` for grouping edits into one undo step
- Separate dev and prod builds — construction guard compiled away in prod
- React integration via `useSyncExternalStore` using `version` / `versionChanged`

# Changelog

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

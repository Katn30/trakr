# Changelog

## [7.0.1] — 2026-09-25

> 7.0.0 was not published; this is the first 7.x release. Changes are listed against 6.0.0.

### Breaking: `EventTracker` keeps an event list — each event has an id and a state

In 6.0, `EventTracker` computed pending events on demand as the difference between the current state and what the server had acknowledged. 7.0 replaces that with an **event list**, the event-side counterpart of the undo stack:
- Every operation records its events.
- Each event has an `eventId` and a `state`.
- Undo/redo change event states rather than recomputing a diff.

The list is readable, so it can also be shown to the user. `DirtyTracker` is unchanged.

**The model.**

- **`tracker.events`** holds every recorded event, oldest first. Each has an `eventId` and a `state`: `EventState.NotCommitted`, `Committed` or `Undone`. Compensating events also carry `compensates`, the `eventId` of the event they revert. New exports: `EventState` and `TrackedEvent`.
- **`tracker.pendingEvents`** holds the `NotCommitted` events: what to send.
- **`tracker.eventsChanged`** fires whenever an event is added, removed or changes state. Use it as the autosave trigger.
- **One operation, one set of events.** Each payload describes only what that operation changed, in the configured shape: field clusters, `itemAdded` / `itemRemoved`, `{ added, removed, changed }` buckets, or history `{ ops }`.

**Undo / redo.**

| Action | Effect |
|---|---|
| New operation | Its events are added as `NotCommitted` |
| `onCommit(eventIds)` | Those events become `Committed` |
| Undo, events not sent | They become `Undone`; redo makes the same events `NotCommitted` again |
| Undo, events committed | They stay `Committed`; a compensating `NotCommitted` event is added |
| Redo, compensation not sent | The compensation becomes `Undone` |
| Redo, compensation committed | A new event re-applies the change |
| New operation while redo is available | `Undone` events are dropped with the redo stack |

A committed event is never deleted or rewritten; it can only be reverted by a compensating event.

**Other rules.**

- **Coalesced writes** (`coalesceWithin`) update their still-pending event in place (same `eventId`). After it is committed, the next write starts a new event.
- **Sessions:** `end()` merges the session's unsent events like its single undo step; `rollback()` removes them and compensates any the session had already committed.
- **`tracker.new()`** records the constructor defaults as one creation event outside the undo stack. That event is dropped if the object is then added to an event collection before it was sent, because the addition already carries the full snapshot.
- **`discardPendingChanges()`**:
  - withdraws pending compensations (by redoing);
  - undoes operations whose events are all unsent;
  - drops the redo stack.

  It never drops an unsent event whose change is still in the objects, e.g. from a partly committed operation or from `tracker.new()`.

**Breaking changes from 6.0.**

- **`generateEvents()` is removed.** Read `pendingEvents` instead.
- **`onCommit(eventIds, keys?)`** takes the **`eventId`s** of the events the server persisted, instead of the event objects. Only those events change state. `keys` (placeholder `trackingId` → real `@AutoId`) is unchanged. Because only ids are passed, events can be serialised freely; in 6.0, copies of events were ignored with a warning.
- **Several writes are no longer collapsed** into one event per object and type. Each operation is its own event; group writes with `coalesceWithin` or a session.
- **`beforeChange` / `afterChange` no longer see the triggering event.** An operation's events are recorded when it ends, after both hooks. Subscribe to `eventsChanged` instead.
- **`isDirty`** means "at least one `NotCommitted` event".

#### Migration (6.x → 7.0)

| 6.x | 7.0 |
|---|---|
| `eventTracker.generateEvents()` | `eventTracker.pendingEvents` |
| `eventTracker.onCommit(sentEvents, keys?)` | `eventTracker.onCommit(sentEvents.map((e) => e.eventId), keys?)` |
| Several edits before a save → one collapsed event per object and type | One event per operation; group with `coalesceWithin` or a session |
| Autosave triggered from `afterChange` | Subscribe to `eventTracker.eventsChanged` |
| Undo past a save → a compensating diff | A compensating event with `compensates`; the original stays `Committed` |

---

## [6.0.0] — 2026-09-25

### Breaking: `Tracker` split into `DirtyTracker` (batch saves) and `EventTracker` (event stream)

`Tracker` used to serve two different persistence patterns: Save-button forms, where object state is the truth and one atomic commit persists it, and autosave over event-sourced backends, where every change is an event the server acknowledges. The two need different commit and undo semantics, and serving both from one class caused the recurring `EventTracker` bugs: lost mid-flight edits, phantom `removed` entries after undo, and redo returning no event.

`Tracker` is now an **abstract base** holding what both patterns share: change events, validation, sessions, the undo/redo stack, `construct()` / `new()`, coalescing and `version`. `new Tracker()` throws.

#### `DirtyTracker` — today's `Tracker`, renamed

Behaviour is unchanged from 5.x: object states (`Insert` / `Changed` / `Deleted` / `Unchanged`), `isDirty` / `canCommit`, `deletedObjects`, atomic `onCommit(keys?)`, and undo across a commit (a committed insert becomes `Deleted` on undo, and so on).

It keeps the 5.2.2 fix: `onCommit()` attaches each object's commit-state undo hook to the most recent operation that actually touched that object. Before, it used whichever operation was on top of the undo stack. `push child → edit parent → onCommit → undo` used to flip the still-present child to `Deleted`; now it only reverts the parent edit.

#### `EventTracker` — pending events are a diff against the persisted baseline

- **`onCommit(persistedEvents, keys?)`** acknowledges exactly the events passed in, matched by identity against what `generateEvents()` returned. Edits made while a save was in flight stay pending instead of being wiped. A subset of events can be acknowledged; acknowledging twice is a no-op; foreign events (e.g. copies) are ignored with a development warning.
- **`isDirty`** means "at least one unpersisted event exists"; `canCommit` is `isDirty && isValid`.
- **Undo**: withdraws the change if it is still pending (`A → B → undo` leaves only A); otherwise emits a compensating event (`A → save → undo` produces the reversal). Redo is symmetric. This now also holds for history-mode properties and history-mode collections: an unsent entry is removed rather than a reversal being appended.
- **No object state.** Objects stay `Unchanged`, there is no `deletedObjects`, and undo can no longer invent `removed` entries for items that are still in their collection. Collection add/remove is computed against each collection's baseline. A removed item stays registered but stops counting towards `isValid` until it is re-added.
- **`discardPendingChanges()`** reverts to the last acknowledged save (redoing it if it had been undone), then forgets anything still pending.
- Collection mutations made with tracking suppressed (`construct()`, `withTrackingSuppressed()`) are not events. Like suppressed field writes, they update the baseline silently. Previously a suppressed push into a primitive aggregate collection was reported as `added`.
- Collection history `entryFactory` receives a 4th argument, `op: 'add' | 'remove' | 'change'`, exported as `CollectionOpKind`.

The event payload shapes (field clusters, `itemAdded` / `itemRemoved`, `{ added, removed, changed }`, `{ ops }`) are unchanged.

#### Migration

| 5.x | 6.0 |
|---|---|
| `new Tracker()` | `new DirtyTracker()` (keep `Tracker` as the type in model constructors) |
| `eventTracker.onCommit()` | `eventTracker.onCommit(events)` — the array returned by `generateEvents()` that was sent |
| `eventTracker.onCommit(keys)` | `eventTracker.onCommit(events, keys)` |
| `eventTracker.deletedObjects` / `trakrState` | Removed / always `Unchanged` |
| `EventTracker.isDirty` right after `tracker.new()` was `false` | `true` — the defaults are pending events |
| Collection history `entryFactory(item, change, ctx)` | Receives a 4th argument, `op: 'add' \| 'remove' \| 'change'` |

The old `EventTracker.onCommit()` / `onCommit(keys)` forms throw a `TypeError` that names the new signature.

For `EventTracker`, this supersedes the 5.2.1 mechanism, which rewrote redo-stack commit actions so that `mutate → commit → undo → commit → redo` produced an event. With the baseline model that behaviour needs no special handling.

---

## [5.2.2] — 2026-09-25

### Fix: `undo` after `onCommit` no longer fabricates deletions for committed inserts

Fixes a bug where calling `tracker.undo()` after `onCommit()` could mark previously-committed `Insert` objects as `Deleted` — even when the operation being undone was unrelated to those objects. On `EventTracker`, this surfaced as a spurious `removed` entry in `generateEvents()`, causing consumers wired to auto-save to send a `DELETE` for rows the user never removed.

**The problem.** `onCommit()` attached each committed object's state-transition undo/redo hook to whichever operation happened to be at the top of the undo stack, regardless of whether that operation had actually touched the object. When the user later did `push child; edit parent field; onCommit(); undo()`, the child's Insert→Unchanged commit transition got wired to the parent's field edit — so undoing the field edit *also* reversed the child's commit transition, flipping the still-in-collection child to `Deleted`.

**What changed.** `Tracker.onCommit()` now attaches each committed object's state-transition hook to the most recent operation in the undo stack whose actions actually target that object (falling back to no hook if none exists). Undoing an operation that did not touch a committed object leaves that object's committed state alone.

**Backwards compatibility.**

- Existing behavior when the undone operation IS the one that inserted/deleted/changed the committed object is preserved — the "compensating remove event after commit+undo of the same insert" case still works.
- `_commitStateOperation` (used by `isDirty` and `discardPendingChanges`) still reflects the global last operation at commit time.
- No public API changes.

## [5.2.1] — 2026-09-24

### Fix: `EventTracker` `redo` after a compensating `onCommit` now produces a fresh event

Fixes a bug where the sequence `mutate → onCommit → undo → onCommit → redo` on an `EventTracker` left tracked items in `Unchanged` state, causing `generateEvents()` to return `[]` instead of the event equivalent to the original mutation.

**The problem.** When a caller commits the compensating change produced by `undo` — the pattern used by event-sourced backends that persist every user action as its own event — the pending operation sits in the redo stack. That operation still carries a commit-state action wired for the pre-compensation baseline (its `redo` closure resets state to `Unchanged`). A subsequent `redo()` replayed only that stale closure, leaving items `Unchanged` and dropping the event that should have been re-materialized.

**What changed.** `EventTracker.onCommit(keys)` now walks `_redoOperations` after the base commit and rewrites each commit-state action to be aware of the new baseline: its `redo` restores the original transient state (`Insert`/`Deleted`/`Changed`) and its `undo` cleanly resets to `Unchanged`. After `redo()`, `generateEvents()` returns an event equivalent to the original mutation, ready to be persisted as a separate downstream event.

**Backwards compatibility.**

- Only affects `EventTracker`. Base `Tracker` semantics are unchanged.
- The single-commit sequence `mutate → onCommit → undo → redo` (no `onCommit` between `undo` and `redo`) still leaves items in `Unchanged` state.
- Full `mutate → commit → undo → commit → redo → commit → undo` cycles now produce the same event alternation indefinitely.

## [5.2.0] — 2026-09-15

### New: `beforeChange` / `afterChange` events and change hooks

Splits the single `onChange` decorator hook (and the single `.changed` event on `TrackedObject`) into an ordered pair — one that fires *before* internal event state is committed, and one that fires *after*.

**The problem.** `@Tracked` and `@EventTracked` accepted a single `onChange` callback that fired *mid-setter* — before `.changed.emit(...)`, which is what `EventTracker` internally subscribes to in order to update event state. As a result, a callback that read `tracker.generateEvents()` did not see the change that triggered it. Consumers wiring auto-save patterns to `onChange` silently dropped the triggering edit from the persisted payload.

Subscribers to `target.changed` never had that problem because the internal subscriber was registered first and ran before user subscribers — but the two subscription points *looked* symmetric, which is a footgun.

**What's new.**

1. Two events on every `TrackedObject`:
   - `beforeChange` — fires before event state is committed. Reads to `tracker.generateEvents()` from this hook do not see the triggering change. Use for cascading mutations that should belong to the same logical operation as the trigger.
   - `afterChange` — fires after event state is committed. Reads to `tracker.generateEvents()` from this hook include the triggering change. Use for auto-save, telemetry, network sync, and downstream re-render triggers.
2. Both events fire on every write, including during undo and redo replays, and emit the same `{ property, oldValue, newValue }` payload.
3. Decorator second argument is now a `{ beforeChange?, afterChange? }` object:
   ```typescript
   @Tracked(validator?, hooks?: { beforeChange?, afterChange? }, options?)
   @EventTracked(validator?, hooks?: { beforeChange?, afterChange? }, options?)
   ```
4. Ordering per setter tick: underlying setter → `beforeChange` → internal event state update → `afterChange`.

**Backwards compatibility.**

- `target.changed` remains an alias for `target.afterChange` (same `TypedEvent` instance). Existing subscribers continue to see the safer post-commit event.
- Passing a bare `onChange` function as the decorator's second argument is still accepted — it is mapped to `beforeChange` (preserving today's timing) and emits a one-time runtime deprecation warning nudging toward the object form.
- No behavior change for accessors that pass no hooks, for `@Id` / `@AutoId`, collections, sessions, or the `generateEvents` shape.

---

## [5.1.0] — 2026-09-07

### New: `tracker.discardPendingChanges()` — programmatically throw away all pending edits

Adds `Tracker.discardPendingChanges()` (and a matching override on `EventTracker`) that resets the tracker to its last-committed state without treating the revert as a successful save.

**The problem.** `onCommit()` is the only way to clear `isDirty`, but it signals "these changes were successfully persisted." When a caller needs to throw away unsaved edits — concurrency conflict resolution, user-confirmed cancel, page-reload after a dirty guard fires — calling `onCommit()` is semantically wrong: it implies persistence that never happened and could mislead any code inspecting what occurred.

**What the method does:**

- Reverts every tracked object to its last-committed state — equivalent to undoing all edits since the last `onCommit()` (or since `tracker.construct()` / `tracker.new()` if no commit has happened yet).
- Removes `Insert`-state objects that were never committed from `tracker.trackedObjects`.
- Sets `isDirty` to `false` synchronously and fires `isDirtyChanged(false)`, so subscribers (e.g. a `beforeunload` guard) react before the caller proceeds.
- Clears both the undo and redo history stacks — nothing meaningful remains to undo after an explicit discard.
- Does **not** assign server IDs. That is `onCommit()`'s job.

**`EventTracker` override** additionally clears all event state and collection history ops, so `generateEvents()` returns `[]` after the call — consistent with the post-`onCommit` invariant.

**Designed for the beforeunload pattern:**

```typescript
tracker.isDirtyChanged.subscribe((dirty) => {
  if (dirty) window.addEventListener('beforeunload', guard);
  else        window.removeEventListener('beforeunload', guard);
});

// On confirmed discard (e.g. concurrency conflict modal):
tracker.discardPendingChanges(); // isDirtyChanged(false) fires → guard removes itself
window.location.reload();        // safe: guard is already gone
```

No breaking changes.

---

## [5.0.3] — 2026-08-31

### Fix: `tracker.new()` leaves object in `Unchanged` state when constructor writes `@EventTracked` fields

When an object created with `tracker.new()` was subsequently pushed into an `EventTrackedCollection`, `_markAdded()` returned early because the object's state was `Changed` instead of `Unchanged`. The object stayed in `Changed` state, and `generateEvents()` emitted a field-cluster event instead of the expected `itemAdded` lifecycle event.

**Root cause.** `tracker.new()` does not suppress tracking, so `changed` events fire during construction (this is intentional — it populates event state so standalone `generateEvents()` calls return the constructor defaults). Any write to an `@EventTracked` or `@Tracked` accessor during construction transitions the object from `Unchanged` to `Changed`. The cleanup loop at the end of `new()` resets `dirtyCounter` to 0 and discards undo ops, but did not reset the state field. The `_markAdded()` guard `if (this._state !== "Unchanged") return` then silently skipped the object.

**Fix.** The cleanup loop in `tracker.new()` now resets objects that ended up in `Changed` state back to `Unchanged`. `clearEventState` is deliberately NOT called — the event state populated during construction must be preserved so that standalone `generateEvents()` calls (without a collection push) continue to surface constructor defaults.

**Behaviour after the fix:**

- `tracker.new()` always returns an object in `Unchanged` state, regardless of what the constructor writes.
- Pushing the object into an `EventTrackedCollection` correctly transitions it to `Insert` and emits `itemAdded` at `generateEvents()` time.
- Standalone `generateEvents()` (without a collection push) is unaffected — constructor defaults still appear in the event payload.

No breaking changes.

---

## [5.0.2] — 2026-08-31

### Fix: removing a non-Insert invalid item from a collection now releases its validity contribution

When a committed (`Unchanged` or `Changed`) item that was invalid was removed from a `TrackedCollection` or `EventTrackedCollection`, `tracker.isValid` stayed `false` even though the item was being deleted and its field values no longer matter.

**Root cause.** `_markRemoved` on `TrackedObject` handles two cases. For `Insert` items (`collapseInsert = true`) it calls `_untrackObject`, which decrements `_invalidCount` as a side effect. For non-Insert items it only called `applyStateTransition` — transitioning state to `Deleted` — but never adjusted `_invalidCount`. The invalid contribution was therefore never released.

This also caused a double-count on undo: undoing the remove restored the item to `Changed`/`Unchanged` and re-exposed it in the UI, but since `_invalidCount` was never decremented on removal, the undo's restoration increment pushed the count above its true value.

**Fix.** In the "do" closure, when `collapseInsert` is `false` and the item was invalid, `_onValidityChanged(false, true)` is called to release the contribution without untracking the object (the item must stay in `trackedObjects` so it can be persisted as a delete and be undoable). In the "undo" closure the mirror call `_onValidityChanged(true, false)` restores it.

**Behaviour after the fix:**

- Removing an invalid `Changed` item makes `tracker.isValid` update immediately.
- The item remains in `trackedObjects` as `Deleted` — it will still be included in the save payload.
- Undoing the remove correctly restores the invalid contribution; `tracker.isValid` goes back to `false`.
- `Insert` items are unaffected — their path was already correct.

No breaking changes.

---

## [5.0.1] — 2026-08-31

### Fix: `buildItemRemovedEvent` now surfaces `@Id` identity and `trackingId`

Removed events generated by `EventTrackedCollection` for items that use `@Id` (caller-provided identity) were missing both `targetId` and `trackingId`.

**Root cause.** `buildItemRemovedEvent` only checked for `@AutoId` when resolving `targetId`, so `@Id`-decorated items always produced `targetId: undefined`. Additionally, unlike `buildItemAddedEvent`, the removed event never set `trackingId`, making it impossible for consumers to recover the removed object via `tracker.getByTrackingId()`.

**Fix.**

- `trackingId: obj.trakrId` is now set unconditionally on every removed event, symmetric with added events.
- A new `getIdProperty` helper (in `ExternallyAssigned.ts`) finds the first `@Id`-only property on a prototype chain. `buildItemRemovedEvent` now tries `@AutoId` first and falls back to `@Id` when `@AutoId` is absent.

**Behaviour after the fix:**

- Removed events for `@AutoId` items are unchanged except that `trackingId` is now also present.
- Removed events for `@Id` items with a numeric identity now include both `targetId` and `trackingId`.
- Removed events for `@Id` items with a non-numeric identity include `trackingId` but still omit `targetId` (consistent with the existing `typeof targetId === "number"` guard).

No breaking changes.

---

## [5.0.0] — 2026-08-28

### Breaking: three properties on `TrackedObject` and `TrackedCollection` renamed with `trakr` prefix

To avoid collisions with user-defined domain properties, three commonly shadowed properties have been renamed:

| Old name | New name | Affected types |
|---|---|---|
| `state` | `trakrState` | `TrackedObject`, `TrackedCollection` (via `ITracked`) |
| `trackingId` | `trakrId` | `TrackedObject` |
| `isValid` | `trakrIsValid` | `TrackedObject`, `TrackedCollection`, `TrackedContainer` |

**Migration:**

- Replace every `obj.state` (where `obj` is a `TrackedObject` or `TrackedCollection`) with `obj.trakrState`.
- Replace every `obj.trackingId` with `obj.trakrId`.
- Replace every `obj.isValid` (on tracked objects/collections/containers) with `obj.trakrIsValid`.
- `Tracker.isValid`, `TrackerSession.isValid`, and the `trackingId` field in `IdAssignment` objects are **not changed**.

---

## [4.5.2] — 2026-08-21

### Fix: `tracker.new()` no longer sets `isDirty=true` immediately after construction

`tracker.new()` was not suppressing write tracking during the factory callback. Every `@Tracked` / `@EventTracked` write inside the constructor was pushed onto the undo stack and incremented `dirtyCounter`, making both `tracker.isDirty` and `trackedObject.isDirty` true before the user had touched anything.

**Root cause.** `tracker.construct()` brackets the factory with `_suppressTrackingCounter++` / `--`, so writes are applied silently. `tracker.new()` had no equivalent suppression, so writes went through the full `_doAndTrack` path and created undo entries.

**Why suppression alone is not sufficient for `new()`.** Unlike `construct()`, `tracker.new()` must surface constructor defaults in `EventTracker.generateEvents()`. The event system for scalar `@EventTracked` properties is driven by `changed` events — if writes are suppressed, `changed` never fires and the event state is never populated. The fix therefore cannot simply mirror `construct()`'s suppression approach.

**Fix.** `tracker.new()` now saves the undo/redo stack depths before the factory, runs the factory without suppression (so `changed` fires and event state is populated), then truncates the undo stack back to its pre-construction depth, restores the redo stack, and resets `dirtyCounter` to 0 on all newly registered objects. `reset()` is called at the end to recompute `isDirty`, `canUndo`, and `canRedo`.

**Behaviour after the fix:**

- `tracker.isDirty` is `false` immediately after `tracker.new()` returns.
- `trackedObject.isDirty` is `false` immediately after `tracker.new()` returns.
- `tracker.canUndo` is `false` — constructor writes are not in the undo stack.
- Constructor defaults still appear in `generateEvents()` — `changed` events fired during construction populated the event state.
- The tracker becomes dirty only on the **first post-construction edit** by the user.
- `tracker.construct()` behaviour is unchanged.

No breaking changes.

---

## [4.5.1] — 2026-07-31

### Fix: collection validators now re-run when cross-object tracked dependencies change

`TrackedCollection` validator functions were not executed inside the reactive collector context. Reads of `@Tracked` / `@EventTracked` accessors on other objects inside a collection validator were silently discarded — no dependency was registered, so the validator had no way to know it needed to re-run when those values changed.

**Consequence.** A collection validator whose result depends on external state (e.g. `issue.stage`, `model.analysisSummary`) only re-ran when the collection structure changed (items added or removed). If the collection stayed structurally unchanged while an external dep changed, the validator was never re-run, leaving `collection.isValid`, `tracker.isValid`, and `tracker.canCommit` stale.

**Fix.** `TrackedCollection._validate()` now wraps the validator call in `DependencyTracker.collect()` and registers the captured deps via `DependencyTracker.updateDeps()` — the same mechanism already used by scalar `@Tracked` / `@EventTracked` field validators in `validateSingleProperty()`. When any captured dep is subsequently written, the collection validator is automatically scheduled for re-evaluation.

`TrackedCollection.destroy()` now calls `DependencyTracker.clearDeps()` to remove stale reverse-dependency entries when a collection is discarded.

Scalar `@Tracked` and `@EventTracked` field validators were unaffected by this bug — they were already executed inside `collect()`.

No breaking changes.

---

## [4.5.0] — 2026-07-30

### New: `TrackedContainer` — compose child validity and dirty state into a single model

Adds `TrackedContainer`, an abstract base class extending `TrackedObject` that lets a model register child objects and collections so that its own `isValid` and `isDirty` roll up across the whole subtree.

**The problem.** When a form section owns both `@Tracked` fields and a `TrackedCollection` of sub-items, there is no first-class way to ask "is this section complete?" — the section model's `isValid` only reflects its own field validators, not the validity of items in the collection. Consumer code had to write ad-hoc getters like:

```typescript
get isActionsSectionValid(): boolean {
  return this.subtasks.collection.every(s => s.validationMessages.size === 0);
}
```

This works reactively (via `trackerVersion` re-renders) but is not composable or symmetric with how other sections expose `isValid`.

**The solution.** `TrackedContainer` adds a `protected trackChild()` method. Subclasses call it from their constructor to register any `TrackedObject` or `TrackedCollection`. The two overridden getters then compose:

- `isValid` — `true` when the container's own validators all pass AND every registered child is valid
- `isDirty` — `true` when the container itself has uncommitted changes OR any registered TrackedObject child is dirty

```typescript
import {
  TrackedContainer,
  TrackedCollection,
  TrackedObject,
  Tracked,
  Tracker,
} from '@katn30/trakr';

class SubtaskDraft extends TrackedObject {
  @Tracked((_, v: string) => (!v ? 'Name required' : undefined))
  accessor name: string = '';

  constructor(tracker: Tracker) { super(tracker); }
}

class ActionsSection extends TrackedContainer {
  @Tracked((_, v: string) => (!v ? 'Owner required' : undefined))
  accessor owner: string = '';

  readonly subtasks: TrackedCollection<SubtaskDraft>;

  constructor(tracker: Tracker, subtasks: TrackedCollection<SubtaskDraft>) {
    super(tracker);
    this.subtasks = subtasks;
    this.trackChild(subtasks);
  }
}

const tracker = new Tracker();
const subtasks = new TrackedCollection<SubtaskDraft>(tracker);
const section  = tracker.construct(() => new ActionsSection(tracker, subtasks));
const sub      = tracker.construct(() => new SubtaskDraft(tracker));
subtasks.push(sub);

section.isValid;  // false — sub.name is '' (invalid)
sub.name = 'Fix the bug';
section.isValid;  // true  — own validator passes + subtask is now valid
```

**Collection item tracking.** When `trackChild` receives a `TrackedCollection`, it does not just check the collection's own validator — it also registers every `TrackedObject` currently in the collection as a child, then subscribes to `collection.changed` to add and remove items dynamically as they are pushed or removed (including across undo and redo). This means item-level validity and dirty state propagate to the container automatically without any extra wiring.

**`untrackChild`.** The symmetric counterpart to `trackChild`. For a `TrackedObject` child it removes it from the child list; for a `TrackedCollection` child it additionally unsubscribes from `changed` and removes all current items from the child list. No-op if the child was never registered.

**Internal refactor — `_setIsValid` on `TrackedObject`.** The `isValid` setter on `TrackedObject` was `private`. To allow `TrackedContainer` to correctly redeclare the setter (required because overriding a getter in a subclass silently drops the inherited setter in JS), the setter is now `protected` and delegates to a new `protected _setIsValid(value)` method. The external API is unchanged; the refactor is internal to the class hierarchy.

**`tracker.isValid` is unaffected.** Each child already calls `tracker._onValidityChanged()` directly when its own validity changes, so global validity accounting is correct without any extra work. `TrackedContainer.isValid` is purely a per-object composed getter for consumer code that needs section-level validity.

No breaking changes. Existing code using `TrackedObject`, `@Tracked`, `TrackedCollection`, and `Tracker` is unaffected.

---

## [4.3.2] — 2026-07-28

### Fix: undo of collection push no longer leaves Insert-state items as ghosts in `trackedObjects[]`

When a `TrackedObject` created via `tracker.construct()` was pushed into a `TrackedCollection` and that push was then undone, the object remained in `tracker.trackedObjects[]` with its validators still firing — leaving `tracker.isValid` permanently false even though the item was no longer logically present.

**Root cause.** `_markAdded` registered its undo action as a bare `applyStateTransition(obj, "added", "undo")`, which only set state back to `Unchanged`. It did not call `_untrackObject`. The symmetric case in `_markRemoved` (explicit remove of an `Insert` item — the `collapseInsert` path) correctly untracks the object; `_markAdded` lacked the equivalent cleanup on its undo path.

**Fix.** `_markAdded` now mirrors the `collapseInsert` pattern:

- **Undo path:** calls `_untrackObject` before applying the state transition, removing the ghost and correcting `_invalidCount`.
- **Redo path:** if the object has been untracked (not in `trackedObjects[]`), calls `_trackObject` and restores its validity contribution before setting `Insert` state — exactly the symmetry `_markRemoved` uses in its own undo path.

After this fix, undoing a push of a newly-constructed object removes it from `trackedObjects[]`, clears its validation contribution, and restores `tracker.isValid` to its pre-push state.

---

## [4.3.1] — 2026-07-27

### New: `tracker.new()` — construction with tracked defaults

Adds `Tracker.new<T>(action: () => T): T`, a companion to `tracker.construct()` for creating brand-new objects whose constructor-set defaults should appear in `generateEvents()`.

**The problem.** Object constructors typically handle two cases: loading saved data from the server, and creating a new object with sensible defaults. Both cases write to properties inside the constructor. `tracker.construct()` suppresses all of those writes, which is correct for the loaded case but wrong for the new-object case — the defaults silently become the baseline and never appear in events.

**The solution.** `tracker.new()` is identical to `tracker.construct()` except it does not suppress tracking. Writes made inside the constructor callback are recorded as real changes. The tracker is dirty immediately after `tracker.new()` returns, and the defaults appear in `generateEvents()` on the next save.

```typescript
class InvoiceModel extends TrackedObject {
  @EventTracked(undefined, undefined, { eventType: 'InvoiceCreated' })
  accessor status: string = '';

  constructor(tracker: Tracker, data?: { status: string }) {
    super(tracker);
    if (data) {
      this.status = data.status; // suppressed when called via tracker.construct()
    } else {
      this.status = 'draft';     // tracked when called via tracker.new()
    }
  }
}

// Loading from DB — no event, tracker stays clean
const saved = tracker.construct(() => new InvoiceModel(tracker, { status: 'sent' }));

// User creates new — 'draft' appears in generateEvents()
const fresh = tracker.new(() => new InvoiceModel(tracker));
tracker.generateEvents();
// [{ eventType: 'InvoiceCreated', payload: { status: 'draft' }, trackingId: 2 }]
```

Both methods:
- Require `_isConstructing` to be true (the dev-mode construction guard still protects against bare `new MyModel(tracker)`)
- Validate every newly constructed object once after the callback completes
- Call `tracker.revalidate()` exactly once at the end

No breaking changes. Existing `tracker.construct()` calls are unaffected.

---

## [4.2.0] — 2026-07-25

### Fix: `TrackedCollection.remove` on `Insert` items now auto-untracks

Previously, removing a `TrackedObject` whose state was `Insert` transitioned it to `Unchanged` but left it in `tracker.trackedObjects` with its validation state intact. The object was logically removed from any collection but still contributed to `tracker.isValid` — an invalid Insert item removed from a collection kept `tracker.isValid === false` indefinitely, and `trackedObjects[]` grew unbounded across insert-remove churn.

`removed/do` from `Insert` now additionally calls `_untrackObject` on the item and clears its `DependencyTracker` entries, in the same undo step as the state transition. Consumers no longer need to pair `collection.remove(item)` with a manual `item.destroy()` when the item was newly inserted:

```typescript
// Before — consumers had to know Insert state was special
const handleDelete = (c: CommentDraft) => {
  const wasNew = c.id === null;
  comments.remove(c);
  if (wasNew) c.destroy();
};

// After — the collection handles it
const handleDelete = (c: CommentDraft) => {
  comments.remove(c);
};
```

Undo of the remove re-tracks the item and restores its previous validity accounting; redo untracks again. `Deleted` state semantics for previously-committed items are unchanged.

### Known sharp edge

Calling `destroy()` on a `TrackedObject` that is already untracked corrupts `tracker.trackedObjects`. `_untrackObject` does `trackedObjects.splice(indexOf(obj), 1)`; when `indexOf` returns `-1`, `splice(-1, 1)` deletes the **last** element of the array — an unrelated object. This has always been true, but the auto-untrack above makes it easier to hit: any consumer still following the old pattern `collection.remove(item); if (wasNew) item.destroy();` will now double-untrack Insert items and silently drop a bystander from the tracker. Migrate to the pattern shown above.

### Documentation

- **`TrackedCollection<T>` positional access at runtime.** New subsection in the API reference. `TrackedCollection<T>` implements `Array<T>` for type-level interop, but numeric-index access is not wired up at runtime — `col[0]` returns `undefined` even when `col.length > 0`, and `col[0] = x` silently sets a phantom property that shadows the (unimplemented) indexer without mutating the collection or triggering tracking. Documents why the runtime backing is deliberately not provided (neither `Proxy` nor per-index `defineProperty` is worth its trade-offs) and lists the tracked alternatives: `col.at(n)`, `col.collection[n]`, `col.replaceAt(n, x)`, `col.splice(n, 1, x)`, and standard iteration.
- **Insert/Delete lifecycle updated.** The lifecycle example and the "Full transition table" key notes now spell out that `removed/do` from `Insert` untracks the object.

No breaking changes to any documented API.

---

## [4.1.0] — 2026-07-24

### Additions

- **`IdAssignment<V>` is now generic** in the PK value type, defaulting to `number` (fully backward compatible). `Tracker.onCommit<V>(keys?)` is likewise generic, so UUID/ULID/string-keyed schemas can pass `IdAssignment<string>[]` without casts.
- **`Tracker.getByTrackingId(trackingId)`** — public accessor that returns the tracked object matching a given `trackingId`, or `undefined`. Deleted objects remain findable.

### Documentation

- **`@Id` reference section added.** Clarifies that `@Id` marks caller-provided identity properties (any type, composable) and that `@AutoId` is a specialisation of `@Id` — it participates in identity *and* is the one property patched by `onCommit(keys)`.
- **Reactivity gate on `@AutoId` write-back made explicit.** The `@AutoId` write performed by `onCommit(keys)` is a baseline update, not a user edit: it does not emit `TrackedObject.changed`, does not bump `dirtyCounter`, does not re-run `@Tracked` validators, and does not flicker `tracker.isDirty`.
- **`IdAssignment<V>` example** with a string-typed PK.

No breaking changes.

---

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

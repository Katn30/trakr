# trakr

TypeScript state-management library implementing the Unit of Work pattern, with object tracking and undo/redo.

Built on the **TC39 decorator standard** (Stage 3). Requires TypeScript 5+ with `experimentalDecorators` **not** set.

## Installation

```bash
npm install @katn30/trakr
```

```json
// tsconfig.json — no experimentalDecorators needed
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"]
  }
}
```

---

## Quick Start

```typescript
import {
  DirtyTracker,
  DirtyTrackedObject,
  TrackedCollection,
  Tracked,
  AutoId,
} from '@katn30/trakr';

const tracker = new DirtyTracker();

class InvoiceModel extends DirtyTrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor status: string = '';

  @Tracked((self, value) => value < 0 ? 'Total must be positive' : undefined)
  accessor total: number = 0;

  readonly lines: TrackedCollection<string>;

  constructor(tracker: DirtyTracker) {
    super(tracker);
    this.lines = new TrackedCollection(tracker);
  }
}

const invoices = new TrackedCollection<InvoiceModel>(tracker);
const invoice = tracker.construct(() => new InvoiceModel(tracker));
invoices.push(invoice);        // trakrState: Insert, trakrId: 1

invoice.status = 'draft';     // recorded
invoice.total = 100;          // recorded
invoice.lines.push('item-1'); // recorded

tracker.isDirty;   // true
tracker.canUndo;   // true

tracker.undo();    // reverts lines.push
tracker.undo();    // reverts total
tracker.undo();    // reverts status
tracker.undo();    // reverts push — state back to Unchanged

tracker.isDirty;   // false
```

---

## Choosing a tracker

`Tracker` is an abstract base: it owns change events, validation, sessions and the undo/redo stack. You instantiate one of its two subclasses, which differ in what "saving" means:

| | `DirtyTracker` | `EventTracker` |
|---|---|---|
| Workflow | Explicit **Save** button, one atomic request | **Autosave**, every change streamed to an event-sourced backend |
| Source of truth | Object state: `Insert` / `Changed` / `Deleted` / `Unchanged` | The event list: every operation's events, each `NotCommitted`, `Committed` or `Undone` |
| Save payload | Walk `trackedObjects` / `deletedObjects` by `trakrState` | `pendingEvents`: one event per operation, from the event list |
| Acknowledge | `onCommit(keys?)` — everything becomes `Unchanged` at once | `onCommit(events, keys?)` — only those events become `Committed` |
| `isDirty` | Undo stack differs from the last commit | At least one `NotCommitted` event exists |
| Undo after a save | Object becomes dirty again (e.g. committed insert → `Deleted`) | The event stays `Committed`; a compensating event is added |
| Models extend | `DirtyTrackedObject` / `DirtyTrackedContainer` | `TrackedObject` / `TrackedContainer` |
| Object state (`trakrState`, `isDirty`, `dirtyCounter`) | On every model | Does not exist — what is pending is the event list |

Both share everything else: `@Tracked`, `TrackedCollection`, validation, sessions, `construct()` / `new()`, coalescing, and `version`.

Each model is written for one tracker, and the compiler enforces the pairing: a `DirtyTrackedObject` constructor takes a `DirtyTracker`, a `TrackedObject` constructor takes an `EventTracker`, and mixing them up is a type error (and a `TypeError` at run time). Both extend `TrackedObjectBase`, which carries what they share: `trakrId`, validation and the change events.

---

## Concepts

### Undo/redo strategy

The two common patterns for implementing undo/redo are:

- **Command** — every change stores a `redoAction` and an `undoAction` closure pair. Undoing calls the inverse function; redoing calls the original. No state is copied.
- **Memento** — the entire state (or a relevant slice) is snapshotted before each change and restored on undo. Simpler to implement because no inverse logic is required, but carries memory and copying overhead on every change.

trakr uses the **Command pattern** because, once correctly implemented, it is strictly more efficient: no memory overhead, no copying, and undo granularity is exactly as fine or coarse as designed.

### How undo steps are created

Every tracked write — a `@Tracked()` property assignment or a `TrackedCollection` mutation — becomes its own undo step unless it is automatically composed into an existing one (see [Automatic composing](#automatic-composing) below).

```
invoice.status = 'void'          → undo step A
invoice.lines.clear()            → undo step B   (independent)
```

### Automatic composing

Multiple tracked writes can automatically land in the same undo step in three cases. No extra API is needed.

**Case 1a — `@Tracked` setter body**

When a property's setter is decorated with `@Tracked`, the setter body runs as part of the tracked write. Any `@Tracked` property writes or `TrackedCollection` mutations made synchronously inside that setter body are automatically composed into the same undo step.

```typescript
class NameModel extends DirtyTrackedObject {
  private _firstName: string = '';
  private _lastName: string = '';

  get firstName(): string { return this._firstName; }
  @Tracked() set firstName(value: string) { this._firstName = value; }

  get lastName(): string { return this._lastName; }
  @Tracked() set lastName(value: string) { this._lastName = value; }

  get fullName(): string { return `${this._firstName} ${this._lastName}`.trim(); }
  @Tracked() set fullName(value: string) {
    const [first = '', last = ''] = value.split(' ');
    this.firstName = first;  // composed — same undo step as fullName
    this.lastName  = last;   // composed — same undo step as fullName
  }
}

model.fullName = 'John Doe';

tracker.undo(); // reverts firstName AND lastName together — one step
```

The same applies when the setter mutates a `TrackedCollection`:

```typescript
class TagModel extends DirtyTrackedObject {
  private _tag: string = '';
  readonly tags: TrackedCollection<string>;

  constructor(tracker: DirtyTracker) {
    super(tracker);
    this.tags = new TrackedCollection(tracker);
  }

  get tag(): string { return this._tag; }
  @Tracked() set tag(value: string) {
    this._tag = value;
    if (value) this.tags.push(value); // composed — same undo step as tag
  }
}

model.tag = 'active';

tracker.undo(); // reverts tag AND removes 'active' from tags — one step
```

**Case 1b — `@Tracked` with change hooks**

When side-effect logic needs to be kept separate from the setter body — or when using `accessor` fields where there is no setter body — pass a `{ beforeChange, afterChange }` hooks object as the second argument to `@Tracked()`. Each hook receives `(self, newValue, oldValue)` and runs inside the tracked operation, so any `@Tracked` property writes or `TrackedCollection` mutations made inside them are automatically composed into the same undo step. Hooks do not fire during undo or redo — the stored actions handle replay.

- **`beforeChange`**: fires *before* the new value is recorded in internal event state. Use this only for cascading mutations that must be recorded as part of the same operation as the trigger.
- **`afterChange`**: fires *after* it. Use this for observers of the value itself: telemetry, derived state, re-render triggers. On an `EventTracker`, the operation's events are recorded when the operation ends, after both hooks; for autosave, subscribe to `tracker.eventsChanged`.

```typescript
class TagModel extends DirtyTrackedObject {
  readonly tags: TrackedCollection<string>;

  @Tracked(
    undefined,
    {
      beforeChange: (self: TagModel, newValue, oldValue) => {
        if (oldValue) self.tags.remove(oldValue);
        if (newValue) self.tags.push(newValue);  // composed — same undo step as tag
      },
    },
  )
  accessor tag: string = '';

  constructor(tracker: DirtyTracker) {
    super(tracker);
    this.tags = new TrackedCollection(tracker);
  }
}

model.tag = 'active';

tracker.undo(); // reverts tag AND removes 'active' from tags — one step
```

> **Legacy form.** Passing a bare `onChange` function as the second argument still works — it is mapped to `beforeChange` and emits a one-time runtime deprecation warning. Migrate to the object form.

**Case 2 — `TrackedCollection` event callbacks**

When a `TrackedCollection` is mutated, both its `changed` and `trackedChanged` events fire synchronously inside the tracked operation. Any `@Tracked` property write made inside either subscriber is automatically composed into the same undo step as the collection mutation.

Use `changed` when you also want the callback to run during undo and redo. Use `trackedChanged` when you only want the callback to run on direct user mutations — it will not fire during undo or redo, and writes inside it are still composed on the initial write.

```typescript
// Using changed — fires on initial write, undo, and redo
class OrderModel extends DirtyTrackedObject {
  @Tracked() accessor itemCount: number = 0;

  readonly items: TrackedCollection<string>;

  constructor(tracker: DirtyTracker) {
    super(tracker);
    this.items = new TrackedCollection(tracker);
    this.items.changed.subscribe(() => {
      this.itemCount = this.items.length; // composed into the same undo step
    });
  }
}

order.items.push('x');  // itemCount becomes 1
tracker.undo();         // items back to [], itemCount back to 0

// Using trackedChanged — fires only on initial write, writes still composed
class LoggedCollection extends DirtyTrackedObject {
  @Tracked() accessor lastAdded: string = '';

  readonly items: TrackedCollection<string>;

  constructor(tracker: DirtyTracker) {
    super(tracker);
    this.items = new TrackedCollection(tracker);
    this.items.trackedChanged.subscribe((e) => {
      if (e.added.length > 0) this.lastAdded = e.added[e.added.length - 1]; // composed
    });
  }
}
```

The same applies to `trackedChanged`. A subscriber that writes to another `@Tracked` property is composed into the same undo step:

```typescript
class TitleModel extends DirtyTrackedObject {
  @Tracked() accessor summary: string = '';

  private _title: string = '';
  get title(): string { return this._title; }
  @Tracked() set title(value: string) { this._title = value; }

  constructor(tracker: DirtyTracker) {
    super(tracker);
    this.trackedChanged.subscribe(({ property, newValue }) => {
      if (property === 'title') {
        this.summary = `Summary: ${newValue}`; // composed into the same undo step
      }
    });
  }
}

model.title = 'Hello';
tracker.undo(); // reverts title AND summary together
```

### Coalescing consecutive writes

Rapid consecutive writes to the same `string` or `number` property on the same model can be merged into a single undo step. Coalescing is **opt-in per property** via the `coalesceWithin` option on `@Tracked()`. Pass the maximum gap in milliseconds between two writes that should still be considered part of the same edit:

```typescript
@Tracked(undefined, undefined, { coalesceWithin: 3000 })
accessor status: string = '';
```

```typescript
invoice.status = 'd';
invoice.status = 'dr';
invoice.status = 'dra';
invoice.status = 'draft';

tracker.undo(); // reverts all four at once → status = ''
```

Properties without `coalesceWithin` — and all `Date`, `boolean`, and `object` properties — are never coalesced; every write produces its own undo step.

### Sessions

`startSession()` returns a `TrackerSession` that groups all writes made during the session into a single undo step. Call `session.end()` to commit or `session.rollback()` to revert:

```typescript
const session = tracker.startSession();

model.firstName = 'Alice';
model.lastName  = 'Smith';
model.email     = 'alice@example.com';

session.end(); // all three writes become one undo step

tracker.undo(); // reverts firstName, lastName, and email together
```

```typescript
const session = tracker.startSession();

model.firstName = 'Alice';
model.lastName  = 'Smith';

session.rollback(); // all writes since startSession are reverted
```

A second call to `startSession()` while a session is already active is a no-op — nesting is not supported.

**Edit modal with save button**

The canonical use case is a modal that edits a slice of the model. Pass a **property scope** — a list of `[object, propertyNames]` tuples — and the session exposes `isDirty` and `isValid` bounded to those properties, so a save button can be driven correctly regardless of the state of the rest of the application.

```typescript
import { PropertyScope } from 'trakr';

function openEditModal(model: PersonModel) {
  const session = tracker.startSession([
    [model, ['firstName', 'lastName', 'email']],
  ]);

  showModal({
    model,
    onConfirm: () => session.end(),
    onCancel:  () => session.rollback(),
    canSave:   () => session.canCommit,
  });
}
```

**`isDirty`** is `false` when the session starts (even if other objects are already dirty elsewhere), and becomes `true` the moment the user writes to any property listed in the scope. Defaults to `false` when no scope is provided.

**`isValid`** checks `validationMessages` for every declared property. If any has a validation error — including one that existed *before* the session started — `isValid` is `false`, keeping the save button disabled until the user resolves it. Defaults to `true` when no scope is provided.

**`canCommit`** is `true` when `isDirty && isValid` — ready to enable a save button.

**Multiple objects in scope**

Pass one tuple per object:

```typescript
const session = tracker.startSession([
  [person,  ['firstName', 'email']],
  [address, ['street', 'city']],
]);
```

Properties not listed — and all other tracked objects — are ignored by `isDirty` and `isValid`. The scope has no effect on what gets committed or rolled back: `session.end()` always merges everything written since `startSession()` into one undo step, and `session.rollback()` always reverts it all.

### Dependency tracking

Validators can read other properties of the same model — for example, a `scheduleDays` field might be required only when `isEnabled` is `true`. trakr automatically tracks which properties each validator reads, and re-runs only the affected validators when those properties change.

This works via a lightweight dependency tracking mechanism built into the `@Tracked` getter. Every time a validator runs, trakr collects every `@Tracked` property that is read during the call. These are recorded as dependencies. When any of those properties is written next, only the validators that declared a dependency on it are re-evaluated — not the entire model.

**Consequence for `get`/`set` pairs:** The dependency is registered through the getter, not the setter. If a property is written via a plain setter and its getter is not decorated with `@Tracked`, any validator that reads it will not discover the dependency — and will not re-run when the property changes.

```typescript
// WRONG — isEnabled getter is plain; validators that read self.isEnabled
// will not re-run when isEnabled changes
get isEnabled(): boolean { return this._isEnabled; }

@Tracked()
set isEnabled(value: boolean) { this._isEnabled = value; }
```

```typescript
// CORRECT — both getter and setter are decorated
@Tracked()
get isEnabled(): boolean { return this._isEnabled; }

@Tracked()
set isEnabled(value: boolean) { this._isEnabled = value; }
```

When using `accessor` fields this is never an issue — the getter and setter share the same decoration.

### Validation

Validators are inline functions passed as the first argument to `@Tracked()`. They receive the model instance and the incoming value and return an error string on failure or `undefined` on success.

trakr runs validators automatically — you never call them directly. They run:

- After every tracked write to the decorated property
- After every undo and redo
- Once for every property on every model after `tracker.construct()` or `tracker.new()` completes
- When any `@Tracked` property read during the previous validator call is written on any object (cross-object dependency re-evaluation)

Results are stored per-property in `model.validationMessages: Map<string, string>` and aggregated into:

- `model.trakrIsValid: boolean` — `true` when all validators on this model pass
- `tracker.isValid: boolean` — `true` when every model and collection passes
- `tracker.canCommit: boolean` — `true` when `isDirty && isValid`

`tracker.isValidChanged` and `tracker.canCommitChanged` fire whenever these values change, so UI can bind directly to them without polling.

**Collection validators** are a separate function passed as the third argument to the `TrackedCollection` constructor. They receive the full array and return an error string or `undefined`. The result is exposed on `collection.error` and `collection.trakrIsValid`, and rolls up into `tracker.isValid`. Collection validators participate in the same cross-object dependency tracking as scalar validators — if the validator reads a `@Tracked` property on another object, the validator re-runs automatically when that property changes.

```typescript
const items = new TrackedCollection<string>(
  tracker,
  [],
  (list) => list.length === 0 ? 'At least one item is required' : undefined,
);

items.trakrIsValid; // false — empty
items.push('a');
items.trakrIsValid; // true
```

### Object construction

Tracked objects must always be created with one of two construction methods. Using bare `new MyModel(tracker)` outside either method throws in development mode.

**`tracker.construct()` — loading existing objects**

Suppresses tracking for the entire constructor body — property writes during construction are silently applied without creating undo entries. The tracker is clean (`canUndo === false`) immediately after it returns.

```typescript
// Single object — returns the constructed instance
const invoice = tracker.construct(() => new InvoiceModel(tracker));

// Multiple objects — pass them all in one callback
tracker.construct(() => {
  for (const row of serverRows) {
    const item = new ItemModel(tracker, row);
  }
});
// tracker.revalidate() is called once here — not once per object
```

**`tracker.new()` — creating new objects**

Defaults set in the constructor fire `changed` events. On an `EventTracker` they are recorded as one event, outside the undo stack. Constructor writes are not added to the undo stack (`canUndo === false` afterwards). On a `DirtyTracker` the tracker is clean immediately after `new()` returns. On an `EventTracker` the defaults are an unsent event, so `isDirty` is `true` until it is committed.

```typescript
const invoice = tracker.new(() => new InvoiceModel(tracker));
// DirtyTracker: isDirty === false
// EventTracker: isDirty === true — the defaults are a pending event
```

Both methods validate every constructed object once and run `tracker.revalidate()` exactly once at the end. The same constructor can serve both roles by branching on whether saved data was provided:

```typescript
class InvoiceModel extends TrackedObject {
  @EventTracked(undefined, undefined, { eventType: 'InvoiceCreated' })
  accessor status: string = '';

  constructor(tracker: EventTracker, data?: { status: string }) {
    super(tracker);
    if (data) {
      this.status = data.status; // suppressed when called via tracker.construct()
    } else {
      this.status = 'draft';     // fires changed; recorded as the creation event
    }
  }
}

// Loading from DB — defaults suppressed, tracker stays clean
const saved = tracker.construct(() => new InvoiceModel(tracker, { status: 'sent' }));

// User creates new — defaults tracked, recorded as an event
const fresh = tracker.new(() => new InvoiceModel(tracker));
```

### Development vs production builds

trakr ships two builds: a development build (`dist/dev/`) and a production build (`dist/prod/`).

**Development build** — creating a tracked object outside `tracker.construct()` throws immediately with a descriptive error:

```
MyModel must be created inside tracker.construct()
```

This catches accidental bare `new MyModel(tracker)` calls at the earliest possible moment during development.

**Production build** — the construction guard is compiled away entirely. There is zero runtime overhead for the check.

**Build selection is automatic.** Bundlers that support the `exports` field in `package.json` — Vite, webpack 5+, and others — pick the development build when building in development mode and the production build when building for production. Nothing extra is required from consumers; the correct build is selected via the `development` export condition in trakr's `package.json`.

### Default state: Unchanged

> This section and the next three — object state, the Insert/Delete lifecycle, and the save pattern — describe `DirtyTracker` and its `DirtyTrackedObject` models. `EventTracker` models (`TrackedObject`) have no object state; pending work is expressed as events instead (see [Event generation](#event-generation-opt-in)).

A `DirtyTrackedObject` starts as `Unchanged`. This matches the most common scenario — objects are loaded from the database and are already persisted.

```typescript
const item = tracker.construct(() => new ItemModel(tracker)); // state: Unchanged (DB-loaded default)
```

To create a **new** item that needs to be inserted, add it to a `TrackedCollection` via `push`. The collection is responsible for transitioning the object to `Insert`:

```typescript
const item = tracker.construct(() => new ItemModel(tracker));
items.push(item);          // state: Insert — tracked, undoable
tracker.undo();            // state: Unchanged, removed from collection
```

Items passed to the `TrackedCollection` **constructor** are treated as already-persisted rows and are **not** marked as `Insert`:

```typescript
const items = new TrackedCollection<ItemModel>(tracker, [dbItem]); // dbItem stays Unchanged
```

### Insert/Delete lifecycle

State transitions to `Insert` and `Deleted` are triggered by two mechanisms: collection mutations and `@Tracked` property assignments.

**Via TrackedCollection**

Adding or removing a `DirtyTrackedObject` from a `TrackedCollection` transitions its state automatically:

```typescript
const item = tracker.construct(() => new ItemModel(tracker)); // Unchanged
items.push(item);   // → Insert
items.remove(item); // → Unchanged, and untracked (was never saved)

const loaded = tracker.construct(() => new ItemModel(tracker, { id: 1 })); // Unchanged
items.push(loaded);   // → Insert
items.remove(loaded); // → Deleted
```

Removing an item whose state is `Insert` collapses it as if it had never existed: the state resets to `Unchanged` and the object is removed from `tracker.trackedObjects` in the same undo step. You do not need to call `destroy()` yourself — the collection handles it. Undo of the remove re-tracks the item and puts it back in the collection at state `Insert`.

**Via @Tracked property**

When a `@Tracked` property holds a `DirtyTrackedObject` value, assigning to it has the same effect: the outgoing value transitions to `Deleted` (or `Unchanged` if it was `Insert`), and the incoming value transitions to `Insert`:

```typescript
class OrderModel extends DirtyTrackedObject {
  @Tracked()
  accessor detail: DetailModel | null = null;

  constructor(tracker: DirtyTracker) { super(tracker); }
}

const order = tracker.construct(() => new OrderModel(tracker));
const detail = tracker.construct(() => new DetailModel(tracker)); // Unchanged

order.detail = detail; // detail → Insert
order.detail = null;   // detail → Deleted
```

Setting a new value while one is already assigned marks the old one removed and the new one added in the same undo step:

```typescript
const detail2 = tracker.construct(() => new DetailModel(tracker));
order.detail = detail2; // detail → Deleted, detail2 → Insert (one undo step)
tracker.undo();         // detail2 → Unchanged, detail → Insert
```

**Suppression**

State transitions respect tracking suppression. Inside `tracker.construct()` and `tracker.withTrackingSuppressed()`, collection mutations and property assignments are applied silently without state transitions. This means loading data inside `tracker.construct()` never accidentally marks objects as `Insert` or `Deleted`.

### Object state machine

Every `DirtyTrackedObject` has a `trakrState: State` property — the single source of truth for what the save layer needs to do with that object. State transitions are driven by three types of events:

- **edit** — a `@Tracked` property is written
- **collection mutation** — the object is pushed to or removed from a `TrackedCollection`
- **commit** — `tracker.onCommit()` is called after a successful server save

#### Redo is always the same as do

There is no separate redo transition. Redo simply re-runs the original `do` action. `trackingId` is assigned at construction and never changes, so it is always available regardless of undo/redo cycles.

#### Full transition table

| Event | Direction | From | To | `@AutoId` field |
|---|---|---|---|---|
| edit | do / redo | Unchanged | **Changed** | untouched |
| edit | do / redo | Changed | Changed | untouched |
| edit | undo (last edit) | Changed | **Unchanged** | untouched |
| edit | undo (not last) | Changed | Changed | untouched |
| added | do / redo | Unchanged | **Insert** | untouched |
| added | undo | Insert | **Unchanged** | untouched |
| removed | do / redo | Insert | **Unchanged** | untouched, dirtyCounter reset |
| removed | do / redo | Unchanged | **Deleted** | untouched |
| removed | undo | Unchanged (was Insert) | **Insert** | untouched |
| removed | undo | Deleted | **Unchanged** | untouched |
| committed | do / redo | Insert | **Unchanged** | written with real id (if key supplied) |
| committed | do / redo | Changed | **Unchanged** | written with real id (if key supplied) |
| committed | do / redo | Deleted | **Unchanged** | untouched |
| committed | undo | was Insert | **Deleted** | kept (real id for DELETE) |
| committed | undo | was Changed | **Changed** | untouched |
| committed | undo | was Deleted | **Insert** | kept (stale — use `trackingId` for POST) |

#### Key notes

**`removed/do` from `Insert` collapses to `Unchanged` and untracks the object** — if an object was added and then removed before ever being committed, it was never persisted. The transition resets `dirtyCounter` to zero, removes the object from `tracker.trackedObjects`, and clears its dependency-tracking entries — as if the add never happened. Nothing needs to be sent to the server, and the object no longer contributes to `tracker.isValid`. Undo of the remove re-tracks the object and restores its previous validity accounting.

**`removed/do` from `Unchanged` or `Changed` moves the object to `Deleted` but keeps it tracked** — committed objects must stay in `tracker.trackedObjects` so the save layer can send a `DELETE` request. Their validity contribution is released immediately on removal: if the object was invalid, `tracker.isValid` updates as soon as the remove is applied. Undo of the remove restores the object to its prior state and, if it was invalid, reinstates its validity contribution.

**`committed/undo` reverses the server operation** — undoing past a commit puts the object into the state that requires the inverse server operation. Undoing a committed INSERT requires a DELETE; undoing a committed DELETE requires a new INSERT; undoing a committed UPDATE requires another UPDATE with the pre-edit values.

**`@AutoId` is never zeroed out** — when `committed/undo` runs after a committed INSERT, the real server id stays on the `@AutoId` field so the save layer can send `DELETE /resource/{id}`. Similarly, after `committed/undo` of a DELETE, the `@AutoId` field still holds the old real id — but since `trakrState` is now `Insert`, the save layer must use `trakrId` to identify the item in the POST payload, not `@AutoId`.

**`trakrId` for `Insert` and `Changed` items** — `trakrId` is assigned at construction and never changes. Include it in the save payload for `Insert` and `Changed` items so the backend can echo back the new server-assigned PK for each. See [Recommended save pattern](#recommended-save-pattern) and [Temporally versioned tables](#temporally-versioned-tables) for usage.

### Recommended save pattern

trakr does not mandate a specific save strategy — you can send changes per-object, batch selectively, or structure your API however your application requires.

That said, a pattern that works well with trakr's design is **all-or-nothing saves**: when the user clicks Save, the frontend collects every dirty object across the tracker, serialises them into a single request, and the backend saves everything inside one transaction — either succeeding fully or returning an error without applying partial changes. The frontend then calls `tracker.onCommit()` only on success.

Every model has a `trakrId` — a positive integer assigned at construction time, stable for the lifetime of the object, unique across the tracker. Include `trakrId` in the save payload for `Insert` and `Changed` items. The backend echoes it back alongside the server-assigned PK for any item that produced a new row. `onCommit(keys)` then iterates every entry in `keys`, matches by `trakrId`, and writes the real PK to the `@AutoId` field of any match — regardless of whether the item was `Insert` or `Changed`.

New objects can reference each other via their `trakrId` in the payload (e.g. a new parent and its new children share consistent temp IDs before the server assigns real ones). After a successful save, `tracker.onCommit(keys)` updates all matched objects in place — no page reload is needed. This is the intended experience for form-heavy back-office pages, though reloading or restructuring state on save is equally valid.

**On failure, do not call `onCommit()`.**

If the server returns an error, simply surface the error to the user and leave the tracker as-is. The tracker stays dirty, `canUndo` remains `true`, and the user can fix the problem and try again — or undo their changes. Nothing needs to be reset manually.

---

## API Reference

### `Tracker` / `DirtyTracker`

`Tracker` is the abstract base class shared by `DirtyTracker` and `EventTracker`; it cannot be instantiated (`new Tracker()` throws). Everything in this section is available on both, except `deletedObjects` and the commit lifecycle, which are `DirtyTracker`'s. For `EventTracker` see [`EventTracker`](#eventtracker).

Create one tracker per page or form context and pass it to every model and collection.

```typescript
const tracker = new DirtyTracker();
```

**State properties**

| Property | Type | Description |
|---|---|---|
| `isDirty` | `boolean` | `true` when uncommitted changes exist |
| `canUndo` | `boolean` | `true` when there is at least one undo step |
| `canRedo` | `boolean` | `true` when there are undone steps to redo |
| `isValid` | `boolean` | `true` when every registered model and collection passes validation |
| `canCommit` | `boolean` | `true` when `isDirty && isValid` — ready to submit to the server |
| `isDirtyChanged` | `TypedEvent<boolean>` | Fires whenever `isDirty` changes |
| `isValidChanged` | `TypedEvent<boolean>` | Fires whenever `isValid` changes |
| `canCommitChanged` | `TypedEvent<boolean>` | Fires whenever `canCommit` changes |
| `version` | `number` | Monotonically changing counter — starts at `0`, increments on every new operation, decrements on undo, increments on redo. Auto-coalesced writes do not increment `version` (no new undo step is created) but still emit `versionChanged` |
| `versionChanged` | `TypedEvent<number>` | Fires on every tracked write, undo, and redo — including auto-coalesced writes where `version` does not change. Use this as the notification signal for external subscribers such as React's `useSyncExternalStore` |
| `trackedObjects` | `DirtyTrackedObject[]` (`TrackedObject[]` on an `EventTracker`) | All registered models. Read-only — iterate for save payloads; do not mutate directly |
| `deletedObjects` | `DirtyTrackedObject[]` | **`DirtyTracker` only.** Subset of `trackedObjects` where `state === Deleted`. Use this to build delete requests — deleted objects are removed from collections and composed properties, making them unreachable from the model tree |
| `trackedCollections` | `TrackedCollection<any>[]` | All registered collections. Read-only — do not mutate directly |

**Undo / redo**

```typescript
tracker.undo();  // reverts the last undo step
tracker.redo();  // re-applies the last undone step
```

Calling `undo()` or `redo()` when the respective flag is `false` is a no-op.

**Commit lifecycle (`DirtyTracker`)**

```typescript
tracker.onCommit();           // mark current state as committed — isDirty → false
tracker.onCommit(keys);       // same, plus write real server IDs to @AutoId fields
```

`onCommit(keys?)` does three things:

1. Iterates every entry in `keys`. For each entry it finds a tracked object whose `trakrId` matches `entry.trackingId` and writes `entry.value` to its `@AutoId` field. This applies to both `Insert` items (new rows) and `Changed` items (e.g. temporal tables where an update produces a new row with a new PK).
2. Transitions every tracked object's `trakrState` to `Unchanged` and resets `dirtyCounter`.
3. For each object whose state was `Insert`, `Changed`, or `Deleted` at commit time, appends the state transition to the most recent undo operation that actually touched that object — so undoing *that specific* operation atomically reverses both the user's edit and the committed state together (no spurious extra undo steps), while undoing an unrelated later operation leaves committed objects alone.

**Lookup by trakrId**

```typescript
const obj = tracker.getByTrackingId(42);   // TrackedObject | undefined
```

Returns the tracked object whose `trakrId` matches the given value, or `undefined` if none. Deleted objects are still findable this way (they remain in `trackedObjects` until `destroy()`). Useful for debugging, correlating server responses against known objects, or hydrating a UI selection from a persisted `trakrId`.

**Sessions**

```typescript
const session = tracker.startSession();    // begin a session
const session = tracker.startSession([…]); // same, with a property scope
session.end();                             // commit — all changes become one undo step
session.rollback();                        // revert — all changes since startSession

session.isDirty;        // false until a scoped property is written
session.isValid;        // false if any scoped property has a validation error
session.canCommit;      // isDirty && isValid
session.canUndo;        // delegates to tracker
session.canRedo;        // delegates to tracker
session.undo();         // delegates to tracker
session.redo();         // delegates to tracker
session.trackedObjects; // objects in scope ([] when no scope)
session.deletedObjects; // DirtyTracker sessions only: scoped objects in Deleted state
session.isDirtyChanged;    // same event as tracker.isDirtyChanged
session.canCommitChanged;  // same event as tracker.canCommitChanged
session.versionChanged;    // same event as tracker.versionChanged
```

**Object construction**

```typescript
// Load existing data — tracking suppressed, tracker stays clean
const model = tracker.construct(() => new MyModel(tracker, savedData));

// Multiple objects at once
tracker.construct(() => {
  new ModelA(tracker, rowA);
  new ModelB(tracker, rowB);
});

// Create a new object — tracking active; on an EventTracker the defaults become an event
const fresh = tracker.new(() => new MyModel(tracker));
```

`tracker.construct()` suppresses tracking entirely. `tracker.new()` lets `changed` events fire during construction (on an `EventTracker` the defaults are recorded as one event), but discards the undo entries and resets the object to `Unchanged`. A `DirtyTracker` is left clean; an `EventTracker` is dirty with the defaults as pending events. The `Unchanged` guarantee means you can immediately push the returned object into a collection: on a `DirtyTracker` it transitions to `Insert`; on an `EventTracker` it is reported as added. Both run validators once after all objects are created and call `tracker.revalidate()` exactly once at the end.

**Tracking suppression**

```typescript
// Callback form — preferred
tracker.withTrackingSuppressed(() => {
  model.field = 'silent';   // applied but not recorded, not dirty
});

// Explicit begin/end — useful when the suppressed block spans async boundaries
tracker.beginSuppressTracking();
model.field = 'silent';
tracker.endSuppressTracking();
```

Suppression is **nestable** via a counter, so calling `beginSuppressTracking()` twice requires two `endSuppressTracking()` calls to resume tracking.

**React integration — `useSyncExternalStore`**

`version` and `versionChanged` are designed to plug directly into React's `useSyncExternalStore`. Subscribe to `versionChanged` as the store and snapshot `tracker.version` — any component that calls the hook will automatically re-render on every tracked mutation, undo, or redo with no bridging code required:

```typescript
import { useSyncExternalStore } from 'react';
import { Tracker } from '@katn30/trakr';

function useTrackerVersion(tracker: Tracker): number {
  return useSyncExternalStore(
    (onStoreChange) => tracker.versionChanged.subscribe(onStoreChange),
    () => tracker.version,
  );
}
```

Any component that calls `useTrackerVersion(tracker)` will re-render whenever the tracker's state changes.

```tsx
function InvoiceForm({ tracker, invoice }: { tracker: Tracker; invoice: InvoiceModel }) {
  useTrackerVersion(tracker); // re-renders on every mutation, undo, or redo

  return (
    <form>
      <input value={invoice.status} onChange={(e) => { invoice.status = e.target.value; }} />
      <button disabled={!tracker.canUndo} onClick={() => tracker.undo()}>Undo</button>
      <button disabled={!tracker.canCommit} onClick={save}>Save</button>
    </form>
  );
}
```

---

### `TrackedObject` / `DirtyTrackedObject`

Models extend one of two abstract classes, depending on their tracker. Both extend `TrackedObjectBase` and must be created via `tracker.construct()` or `tracker.new()`.

```typescript
class InvoiceModel extends DirtyTrackedObject {     // for a DirtyTracker
  constructor(tracker: DirtyTracker) {
    super(tracker); // registers the model with the tracker
  }
}

class IssueModel extends TrackedObject {            // for an EventTracker
  constructor(tracker: EventTracker) {
    super(tracker);
  }
}

const invoice = tracker.construct(() => new InvoiceModel(tracker));
```

**Members of every model (`TrackedObjectBase`)**

| Member | Type | Description |
|---|---|---|
| `tracker` | `DirtyTracker` / `EventTracker` | The tracker this model belongs to (set via `super(tracker)`) |
| `trakrId` | `number` | Positive client-assigned identifier, unique across the tracker, set at construction and never changed. Include it in the save payload so the backend can return the new server PK |
| `trakrIsValid` | `boolean` | `true` when all `@Tracked()` validators pass |
| `validationMessages` | `Map<string, string>` | Maps property name → error message for each failing validator |
| `beforeChange` | `TypedEvent<TrackedPropertyChanged>` | Fires on every property change, *before* the new value is recorded in internal event state. Also fires during undo and redo |
| `afterChange` | `TypedEvent<TrackedPropertyChanged>` | Fires on every property change, *after* it. Also fires during undo and redo. On an `EventTracker`, the resulting event is recorded when the operation ends; use `tracker.eventsChanged` to observe it |
| `changed` | `TypedEvent<TrackedPropertyChanged>` | Alias for `afterChange` (same `TypedEvent` instance). Retained for backwards compatibility |
| `trackedChanged` | `TypedEvent<TrackedPropertyChanged>` | Fires only on direct user-initiated writes — never during undo or redo |
| `destroy()` | `void` | Removes this model from the tracker |

**Additional members of a `DirtyTrackedObject`**

| Member | Type | Description |
|---|---|---|
| `trakrState` | `State` | The current persistence state — `Unchanged`, `Insert`, `Changed`, or `Deleted` |
| `isDirty` | `boolean` | `true` when this model has uncommitted property changes |
| `dirtyCounter` | `number` | Net count of uncommitted property writes. Increments on each write, decrements on undo. Reset to `0` by `onCommit()`. Can be negative after undoing past a committed save |

A `TrackedObject` has none of these: on an `EventTracker`, what is pending is the event list (`tracker.pendingEvents`). To find what a model has added, removed or changed, read the events for its `trackingId`.

**Property change events**

`beforeChange`, `afterChange`, `changed`, and `trackedChanged` all carry a `TrackedPropertyChanged` payload:

```typescript
import type { TrackedPropertyChanged } from '@katn30/trakr';
// { property: string; oldValue: unknown; newValue: unknown }
```

| Field | Description |
|---|---|
| `property` | The decorated property name |
| `oldValue` | The value before the write |
| `newValue` | The value after the write |

All events fire synchronously **inside** the tracked operation, so any `@Tracked` property write made inside a listener is automatically composed into the same undo step as the triggering write (see [Automatic composing](#automatic-composing)).

The differences:
- `beforeChange` fires *before* internal event state is updated. Use this only when you need to cascade mutations that should belong to the same logical operation as the trigger.
- `afterChange` (alias: `changed`) fires *after* it: the right hook for telemetry and re-render triggers. For auto-save on an `EventTracker`, use `tracker.eventsChanged`, which fires once the operation's events are recorded.
- Both `beforeChange` and `afterChange` fire on every write, including during undo and redo replays.
- `trackedChanged` fires only on direct user-initiated writes — never during undo or redo.

```typescript
// afterChange — fires on initial write, undo, and redo; writes in callback are composed
this.afterChange.subscribe(({ property }) => {
  if (property === 'price' || property === 'quantity') {
    this.total = this.price * this.quantity; // composed into the same undo step
  }
});

// trackedChanged — fires only on initial write; writes in callback are still composed
this.trackedChanged.subscribe(({ property, newValue }) => {
  if (property === 'title') {
    this.summary = `Summary: ${newValue}`; // composed on initial write only
  }
});
```

---

### `State`

Read via `obj.trakrState`.

```typescript
import { State } from '@katn30/trakr';
```

| Value | Meaning | Required DB operation |
|---|---|---|
| `Unchanged` | Loaded from DB or just saved — no pending action | — |
| `Insert` | Added to a collection, never committed | INSERT |
| `Changed` | Loaded or committed, then edited | UPDATE |
| `Deleted` | Removed from a collection | DELETE |

For the full set of transitions between these states — driven by edits, collection mutations, undo, redo, and commit — see [Object state machine](#object-state-machine) in Concepts.

**Loading from DB:**

Objects default to `Unchanged`. Property values set inside the constructor are suppressed by `tracker.construct()`:

```typescript
class InvoiceModel extends DirtyTrackedObject {
  @Tracked() accessor status: string = '';
  constructor(tracker: DirtyTracker, data?: { status: string }) {
    super(tracker);
    if (data) this.status = data.status; // suppressed — not tracked
  }
}

const invoice = tracker.construct(() => new InvoiceModel(tracker, { status: 'active' })); // trakrState: Unchanged
```

**Saving:**

Iterate `tracker.trackedObjects`, read `trakrState` and the appropriate ID on each model, and call `tracker.onCommit()` after the server responds successfully.

> **Why `tracker.trackedObjects` and not your own model tree?**
> Deleted objects are no longer reachable through your model graph — a `TrackedCollection` removes them from its array, and a `@Tracked` property set to `null` (or replaced with another object) removes the reference. The tracker holds every registered object regardless of its state, so iterating `trackedObjects` is the only way to reach objects that need a DELETE request. `tracker.deletedObjects` is a convenience getter for the deleted subset only, but both approaches work.

```typescript
import { DirtyTracker, Tracker, DirtyTrackedObject, State, Tracked, AutoId, TrackedCollection } from '@katn30/trakr';

class InvoiceModel extends DirtyTrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor status: string = '';

  constructor(tracker: DirtyTracker, data?: { id: number; status: string }) {
    super(tracker);
    if (data) {
      this.id = data.id;
      this.status = data.status;
    }
  }
}

const tracker = new DirtyTracker();

// Load existing rows from the server
tracker.construct(() => {
  new InvoiceModel(tracker, { id: 1, status: 'draft' });
  new InvoiceModel(tracker, { id: 2, status: 'sent' });
});

// Create a new invoice and add it to a collection (state → Insert)
const invoices = new TrackedCollection<InvoiceModel>(tracker);
const newInvoice = tracker.construct(() => new InvoiceModel(tracker));
invoices.push(newInvoice);
newInvoice.status = 'pending';
// newInvoice.trakrId === 3  (assigned at construction, never changes)
// newInvoice.id      === 0  (untouched by the library until onCommit)

// --- Save ---

// Build the payload by reading each object's trakrState
const payload: {
  inserts: { trackingId: number; status: string }[];
  updates: { trackingId: number; id: number; status: string }[];
  deletes: { id: number }[];
} = { inserts: [], updates: [], deletes: [] };

for (const obj of tracker.trackedObjects) {
  if (!(obj instanceof InvoiceModel)) continue;
  switch (obj.trakrState) {
    case State.Insert:
      // Send trakrId so the backend can echo back the new server PK
      payload.inserts.push({ trackingId: obj.trakrId, status: obj.status });
      break;
    case State.Changed:
      payload.updates.push({ trackingId: obj.trakrId, id: obj.id, status: obj.status });
      break;
    case State.Deleted:
      payload.deletes.push({ id: obj.id });
      break;
    case State.Unchanged:
      break;
  }
}

// Send to server — backend runs everything in one transaction
const response = await api.save(payload);
// response.ids: [{ trackingId: 3, value: 42 }]

// Apply real IDs and mark everything clean — no page reload needed
tracker.onCommit(response.ids);
// newInvoice.id === 42, trakrState === Unchanged
// tracker.isDirty === false

// When no new PKs were assigned, keys can be omitted:
// tracker.onCommit();
```

---

### `@AutoId`

Marks a property as the server-assigned autoincrement primary key for this model. Only one `@AutoId` field is allowed per class. Enables the `onCommit` lifecycle for real-ID assignment.

`@AutoId` is a **specialisation of `@Id`**: it also registers the property as part of the model's identity (so `getIdentity(obj)` includes it), but it additionally singles the property out as the one trakr will overwrite from `onCommit(keys)`. Use `@Id` for identity properties you assign yourself; use `@AutoId` for the single property trakr should patch on commit. See [`@Id`](#id) for identity-only properties (composite keys, caller-assigned UUIDs, natural keys).

```typescript
class InvoiceModel extends DirtyTrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor status: string = '';

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}
```

The `@AutoId` field is left at its initial value until `onCommit(keys)` writes the real server ID. The save layer identifies items that need a new PK via `trakrId` — a stable, positive integer assigned at construction and never changed. Include `trakrId` in the save payload for `Insert` (and `Changed`, for temporal tables) items; the backend returns it alongside the new PK.

**Typical save flow:**

```typescript
const invoice = tracker.construct(() => new InvoiceModel(tracker));
invoices.push(invoice);
// invoice.trakrId === 1  (assigned at construction, never changes)
// invoice.id      === 0  (untouched by the library)

invoice.status = 'draft';

// 1. Build payload — send trakrId for Insert items:
const serverIds = [{ trackingId: invoice.trakrId, value: 42 }];

// 2. Send to server, receive real IDs back.

// 3. Apply real IDs and mark clean:
tracker.onCommit(serverIds);
// invoice.id        === 42  (written by onCommit)
// tracker.isDirty   === false
```

`onCommit()` with no arguments (or an empty array) still marks the tracker as clean — it just skips the ID replacement step.

`trakrId` values are globally unique across the lifetime of the tracker and never reused, so they can safely serve as correlation keys across multiple save cycles.

**Reactivity gate.** The `@AutoId` write performed by `onCommit(keys)` is a **library-internal write, not a user edit**. It does **not** fire `changed` for the `@AutoId` property, does **not** bump `dirtyCounter`, does **not** re-run `@Tracked` validators, and does **not** flicker `tracker.isDirty` back to `true` during commit. After `onCommit` returns, `trakrState === Unchanged` and `isDirty === false` — as if the object were freshly loaded with the real PK. Treat the write as *authoritative baseline update*, not as a change event.

---

### `@Id`

Marks a property as part of the model's **caller-provided identity**. Any type is allowed (string, number, UUID, ULID, tuple-like composite via multiple decorators). Trakr never mutates the value — you set it (typically from the server, or client-generated for UUID schemas), and trakr uses it purely to compute `getIdentity(obj)`, `getIdentityObject(obj)`, and `getIdentityProperties(proto)`.

```typescript
class TenantModel extends DirtyTrackedObject {
  @Id
  code: string = '';        // caller-assigned string PK

  @Tracked()
  accessor name: string = '';
}

class LineItemModel extends DirtyTrackedObject {
  @Id
  orderId: number = 0;      // composite key part 1
  @Id
  lineNo: number = 0;       // composite key part 2

  @Tracked()
  accessor qty: number = 0;
}
```

**Relationship to `@AutoId`.**

|                                  | `@Id`                             | `@AutoId`                                       |
|----------------------------------|-----------------------------------|-------------------------------------------------|
| Registers property as identity   | yes                               | yes (implicitly)                                |
| Value type                       | any                               | any (via `IdAssignment<V>`; historically `number`) |
| Written by `onCommit(keys)`      | never                             | yes, from the matching `IdAssignment.value`     |
| Multiple per class               | yes (composite key)               | no (at most one)                                |

Use `@Id` for identity you own (client-generated UUIDs, natural keys, composite keys). Use `@AutoId` for the single property whose value only the server can produce and that must be patched back into the model after `onCommit`. A class may combine them: several `@Id` properties for a composite key plus one `@AutoId` for a surrogate PK, if that matches your schema.

---

### `ITracked`

The common interface implemented by every model and by `TrackedCollection`. Useful for utility functions that accept either:

```typescript
import { ITracked } from '@katn30/trakr';

function detach(item: ITracked): void {
  item.destroy();
}
```

| Member | Type | Description |
|---|---|---|
| `tracker` | `Tracker` | The tracker this object belongs to |
| `destroy()` | `void` | Removes this object from the tracker |

Object state (`trakrState`, `isDirty`, `dirtyCounter`) is not part of `ITracked`: it exists only on `DirtyTrackedObject`. Collections carry no state of their own.

---

### `IdAssignment<V>`

The shape of each entry in the `keys` array passed to `tracker.onCommit(keys)`. Generic in the PK value type, defaulting to `number`:

```typescript
import type { IdAssignment } from '@katn30/trakr';
// IdAssignment<V = number> = { trackingId: number; value: V }

const numericKeys: IdAssignment[]           = [{ trackingId: 1, value: 42 }];
const uuidKeys:    IdAssignment<string>[]   = [{ trackingId: 1, value: '01HXYZ-ULID' }];
```

| Field | Type | Description |
|---|---|---|
| `trackingId` | `number` | The `trakrId` of the object that received a new server-assigned PK |
| `value` | `V` (default `number`) | The real server-assigned ID to write to the `@AutoId` field |

`tracker.onCommit<V>(keys)` is generic in `V`: pass `IdAssignment<string>[]` for UUID/ULID schemas, `IdAssignment[]` for the numeric default. Trakr writes `entry.value` straight into the `@AutoId` field — the field's declared type is what enforces the match at the call site (e.g. `@AutoId id: string = ''` with `onCommit<string>(...)`).

The server returns one `IdAssignment` per item that produced a new database row — both inserted objects and, in temporal tables, updated objects (see [Temporally versioned tables](#temporally-versioned-tables)). `onCommit()` iterates every entry, matches by `trakrId` against every tracked object, and writes `value` to the `@AutoId` field of any match.

---

### `@Tracked()`

The property decorator. Intercepts every write, records an undo/redo pair, and optionally validates the new value. Works with `accessor` fields, explicit `get`/`set` pairs, and plain getters. Place it on the **accessor**, the **setter**, or the **getter**.

**With `accessor` (recommended):**

```typescript
class ProductModel extends DirtyTrackedObject {
  @Tracked()
  accessor name: string = '';

  @Tracked()
  accessor price: number = 0;

  @Tracked()
  accessor active: boolean = true;

  @Tracked()
  accessor config: Record<string, unknown> = {};

  @Tracked()
  accessor createdAt: Date = new Date();

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}
```

**With `get`/`set`** — decorate the setter:

```typescript
class ProductModel extends DirtyTrackedObject {
  private _name: string = '';

  get name(): string { return this._name; }

  @Tracked()
  set name(value: string) { this._name = value; }

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}
```

**With `get`/`set` and side effects** — decorate both getter and setter:

When the setter contains side-effect logic that must stay intact (e.g. cascading writes to other properties), decorate both the getter and the setter. The getter decoration registers `isEnabled` as a dependency source — any validator that reads it will automatically re-run when the setter fires. The setter decoration handles undo/redo as usual.

```typescript
class RuleModel extends DirtyTrackedObject {
  private _isEnabled: boolean = false;

  @Tracked()
  get isEnabled(): boolean { return this._isEnabled; }

  @Tracked()
  set isEnabled(value: boolean) {
    this._isEnabled = value;
    if (value) {
      this.scheduleDays = 'mon';
    } else {
      this.scheduleDays = '';
    }
  }

  @Tracked((self: RuleModel, v) =>
    self.isEnabled && !v ? 'Day is required' : undefined
  )
  accessor scheduleDays: string = '';

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}
```

When `isEnabled` is set to `true`, `scheduleDays`'s validator automatically re-runs because the getter declared the dependency. No manual `revalidate()` call is needed.

> Note: decorating just the getter (without the setter) is valid when the getter is purely computed — it registers the property as a dependency source without attaching any undo/redo logic.

**With a validator:**

The validator receives the model instance and the incoming value. Return an error string to fail, `undefined` to pass.

```typescript
class OrderModel extends DirtyTrackedObject {
  @Tracked((self, value) => !value ? 'Status is required' : undefined)
  accessor status: string = '';

  @Tracked((self, value) => value < 0 ? 'Price must be positive' : undefined)
  accessor price: number = 0;

  // Validator can inspect other properties of the model
  @Tracked((self: OrderModel, value) =>
    value > self.price ? 'Discount exceeds price' : undefined
  )
  accessor discount: number = 0;

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}
```

Validators are re-evaluated after every tracked write and after every undo/redo. Results are stored in `model.validationMessages` and rolled up into `tracker.isValid`.

Validators that read other properties automatically re-run when those properties change — this is handled by the dependency tracking mechanism (see [Dependency tracking](#dependency-tracking) in Concepts). For this to work, every property read inside a validator must be exposed through a `@Tracked`-decorated getter. `accessor` fields satisfy this automatically. For `get`/`set` pairs, both the getter and setter must be decorated with `@Tracked` — see the "getter + setter with side effects" example above.

**No-op detection**

Assigning the same value twice does not create an undo step and does not mark the model dirty. Equality is checked with strict `===` — `null`, `undefined`, and `''` are all distinct values.

```typescript
invoice.status = '';      // no-op (already '')
invoice.status = null;    // recorded (null !== '')
invoice.status = 'draft'; // recorded
invoice.status = 'draft'; // no-op
```

**Signature**

```typescript
@Tracked(validator?, hooks?, options?)
```

| Parameter | Type | Applies to | Description |
|---|---|---|---|
| `validator` | `(self, newValue) => string \| undefined` | accessor, setter | Returns an error string on failure, `undefined` on success |
| `hooks` | `{ beforeChange?, afterChange? }` | accessor, setter | Side-effect callbacks. Both receive `(self, newValue, oldValue)` and run inside the tracked operation — writes to other `@Tracked` properties or `TrackedCollection`s are composed into the same undo step. Neither fires during undo or redo. Passing a bare function is accepted for backwards compatibility — it maps to `beforeChange` and emits a runtime deprecation warning |
| `options.coalesceWithin` | `number` | accessor, setter | Maximum gap in ms between two consecutive writes to merge into one undo step. Omit to never coalesce |

Choose `beforeChange` when you need cascading mutations recorded as part of the same operation. Choose `afterChange` for side-effects that observe the new value (telemetry, re-render triggers). For auto-save on an `EventTracker`, subscribe to `tracker.eventsChanged` instead.

```typescript
// validator only:
@Tracked((_, v) => v < 0 ? 'Must be positive' : undefined)
accessor price: number = 0;

// beforeChange only — cascade composed into the same undo step:
@Tracked(
  undefined,
  {
    beforeChange: (self: TagModel, newValue, oldValue) => {
      if (oldValue) self.tags.remove(oldValue);
      if (newValue) self.tags.push(newValue);
    },
  },
)
accessor tag: string = '';

// afterChange — auto-save observing committed event state:
@Tracked(
  undefined,
  {
    afterChange: (self: MyModel) => { self.tracker.autoSave(); },
  },
)
accessor status: string = '';

// validator + both hooks + coalesceWithin:
@Tracked(
  (_, v) => !v ? 'Required' : undefined,
  {
    beforeChange: (self: MyModel, newValue) => { self.log.push(newValue); },
    afterChange:  (self: MyModel) => { self.tracker.autoSave(); },
  },
  { coalesceWithin: 3000 },
)
accessor name: string = '';

// coalesceWithin only:
@Tracked(undefined, undefined, { coalesceWithin: 3000 })
accessor status: string = '';
```

**Supported property types:** `string`, `number`, `boolean`, `Date`, `object`. Unsupported types throw at runtime.

---

### `TrackedCollection<T>`

A tracked collection with a full array-shaped API. All mutation methods are recorded and undoable. Implements `Array<T>` for type-level interop with array-consuming APIs — with one runtime gap, described in **Positional access at runtime** below.

```typescript
const items = new TrackedCollection<string>(tracker);

// With initial items:
const items = new TrackedCollection<string>(tracker, ['a', 'b']);

// With a validator:
const items = new TrackedCollection<string>(
  tracker,
  [],
  (list) => list.length === 0 ? 'At least one item is required' : undefined,
);
```

**Positional access at runtime**

`TrackedCollection<T>` declares the `[n: number]: T` index signature (inherited from `implements Array<T>`), but numeric-index access is **not** wired up at runtime. TypeScript accepts `col[n]` and `col[n] = x` without complaint, but neither behaves like a real array:

- `col[0]` returns `undefined` at runtime, even when `col.length > 0`.
- `col[0] = x` does not mutate the collection and does not trigger tracking. It silently sets a data property on the class instance that shadows the (unimplemented) indexer — subsequent `col[0]` reads will return `x` while `col.length`, iteration, and `col.collection` still reflect the real state. This divergence will not surface as an error; it will surface as inconsistent UI or a save payload missing the write.

The interface is kept for interop (passing a `TrackedCollection` to code typed against `Array<T>`), but the runtime backing is deliberately not provided: wiring it up requires either a `Proxy` (breaks instance identity across the tracker API and adds an indirection layer on every property access) or per-index `defineProperty` accessors (allocates one closure per element, and numeric properties become enumerable and appear in `Object.keys` and `for...in`). Neither trade-off is worth it for a pattern the class already has first-class alternatives for.

Use these instead:

| Instead of | Use |
|---|---|
| `col[n]` (read) | `col.at(n)` — participates in dependency tracking |
| — | `col.collection[n]` — direct read of the underlying array, no dependency tracking |
| `col[n] = x` (write) | `col.replaceAt(n, x)` — tracked, undoable |
| — | `col.splice(n, 1, x)` — tracked, undoable |
| `for (let i = 0; i < col.length; i++) col[i]` | `for (const item of col) ...` |
| — | `col.forEach(...)`, `col.map(...)`, etc. |

When passing a `TrackedCollection` to a third-party function typed against `Array<T>` that reads by index internally, pass `col.collection` instead. It exposes the underlying `T[]` with zero copying. Treat it as read-only: any mutation applied to that reference bypasses the tracker entirely.

**Tracked mutation methods**

All of these create undo steps:

| Method | Description |
|---|---|
| `push(...items)` | Appends one or more items |
| `pop()` | Removes and returns the last item |
| `shift()` | Removes and returns the first item |
| `unshift(...items)` | Prepends one or more items |
| `splice(start, deleteCount, ...items)` | Low-level insert/remove at a position |
| `remove(item)` | Removes a specific item by reference. Returns `false` if not found |
| `replace(item, replacement)` | Replaces a specific item by reference. Returns `false` if not found |
| `replaceAt(index, replacement)` | Replaces the item at a given index |
| `clear()` | Removes all items |
| `reset(newItems)` | Replaces the entire collection with a new array |
| `fill(value, start?, end?)` | Fills a range with a value |
| `copyWithin(target, start, end?)` | Copies a slice to another position |

**Read-only / non-mutating methods**

`indexOf`, `lastIndexOf`, `includes`, `find`, `findIndex`, `findLast`, `findLastIndex`, `every`, `some`, `forEach`, `map`, `filter`, `flatMap`, `reduce`, `reduceRight`, `concat`, `join`, `slice`, `at`, `entries`, `keys`, `values`, `flat`, `reverse`, `sort`, `toReversed`, `toSorted`, `toSpliced`, `with`, `toString`, `toLocaleString`

**Additional properties**

| Member | Description |
|---|---|
| `length` | Number of items |
| `isDirty` | `true` when the collection has unsaved mutations |
| `isValid` | `true` when the validator passes (or no validator was provided) |
| `error` | The current validation error message, or `undefined` |
| `changed` | `TypedEvent<TrackedCollectionChanged<T>>` — fires on every mutation, including during undo and redo |
| `trackedChanged` | `TypedEvent<TrackedCollectionChanged<T>>` — fires only on direct user-initiated mutations, never during undo or redo |
| `first()` | Returns the first item, or `undefined` if empty |
| `destroy()` | Removes the collection from the tracker |

**Collection change events**

Both events carry a `TrackedCollectionChanged<T>` payload:

| Property | Description |
|---|---|
| `added` | Items that were inserted |
| `removed` | Items that were removed |
| `newCollection` | The full collection after the mutation |

Both events fire synchronously **inside** the tracked operation, so any `@Tracked` property write made inside either listener is automatically composed into the same undo step as the collection mutation (see [Automatic composing](#automatic-composing)).

The difference is when they fire:
- `changed` fires on every mutation, including during undo and redo replays
- `trackedChanged` fires only on direct user-initiated mutations — never during undo or redo

```typescript
// changed — fires on initial write, undo, and redo; writes in callback are composed
items.changed.subscribe(() => {
  this.itemCount = items.length;
});

// trackedChanged — fires only on initial write; writes in callback are still composed
items.trackedChanged.subscribe((e) => {
  this.lastAdded = e.added[e.added.length - 1] ?? ''; // composed on initial write only
});
```

---

### `DirtyTrackedContainer` / `TrackedContainer`

Abstract base classes that let a model **compose child objects and collections into a single validity check** — and, for `DirtyTrackedContainer`, a single dirty check. `DirtyTrackedContainer` extends `DirtyTrackedObject` (for a `DirtyTracker`); `TrackedContainer` extends `TrackedObject` (for an `EventTracker`) and aggregates validity only. The examples below use `DirtyTrackedContainer`; `TrackedContainer` works the same way.

Extend one when a model owns children whose validity (and dirtiness) should roll up to the parent — for example, a form section that has its own validated fields and owns a collection of sub-items.

**Simple example: one section, one owned child object**

```typescript
import {
  DirtyTrackedContainer,
  DirtyTrackedObject,
  Tracked,
  DirtyTracker,
  Tracker,
} from '@katn30/trakr';

class SubtaskDraft extends DirtyTrackedObject {
  @Tracked((_, v: string) => (!v ? 'Name required' : undefined))
  accessor name: string = '';

  constructor(tracker: DirtyTracker) { super(tracker); }
}

class ActionsSection extends DirtyTrackedContainer {
  @Tracked((_, v: string) => (!v ? 'Owner required' : undefined))
  accessor owner: string = '';

  constructor(tracker: DirtyTracker, subtask: SubtaskDraft) {
    super(tracker);
    this.trackChild(subtask);  // register the child object
  }
}

const tracker = new DirtyTracker();
const sub = tracker.construct(() => new SubtaskDraft(tracker));      // name='' → invalid
const section = tracker.construct(() => new ActionsSection(tracker, sub));

section.trakrIsValid;    // false — sub.name is '' (invalid)
sub.name = 'Fix the bug';
section.trakrIsValid;    // false — own owner field is still ''
section.owner = 'Alice';
section.trakrIsValid;    // true  — both own field and child are now valid
```

**Example: section owns a collection of sub-items**

When `trackChild` receives a `TrackedCollection`, every item already in the collection is tracked immediately, and items pushed or removed later are tracked/untracked automatically — including across undo and redo.

```typescript
class SubtaskDraft extends DirtyTrackedObject {
  @Tracked((_, v: string) => (!v ? 'Name required' : undefined))
  accessor name: string = '';

  constructor(tracker: DirtyTracker) { super(tracker); }
}

class ActionsSection extends DirtyTrackedContainer {
  @Tracked((_, v: string) => (!v ? 'Owner required' : undefined))
  accessor owner: string = '';

  readonly subtasks: TrackedCollection<SubtaskDraft>;

  constructor(tracker: DirtyTracker, subtasks: TrackedCollection<SubtaskDraft>) {
    super(tracker);
    this.subtasks = subtasks;
    this.trackChild(subtasks);  // registers the collection AND its items
  }
}

const tracker  = new DirtyTracker();
const subtasks = new TrackedCollection<SubtaskDraft>(tracker);
const section  = tracker.construct(() => new ActionsSection(tracker, subtasks));

section.owner = 'Alice';
section.trakrIsValid;    // true  — own field valid, no items yet

const sub = tracker.construct(() => new SubtaskDraft(tracker)); // name='' → invalid
subtasks.push(sub);
section.trakrIsValid;    // false — sub.name is '' (item is tracked automatically on push)

sub.name = 'Fix the bug';
section.trakrIsValid;    // true  — all own fields and all items are now valid

subtasks.remove(sub);
section.trakrIsValid;    // true  — invalid item removed, nothing left to fail
```

**`protected trackChild(child)`**

Registers a model or `TrackedCollection` as a child. Call it from the subclass constructor. A container can have any number of children.

When `child` is a **`TrackedCollection`**, `trackChild` does three things automatically:

1. Registers the collection itself (so its own validator, if any, contributes to `trakrIsValid`).
2. Registers every model already inside the collection as a child.
3. Subscribes to `collection.changed` so that items pushed in later are added to tracking and items removed are dropped from tracking — including across undo and redo.

This means item-level validity and dirty state propagate to the container without any extra wiring: an invalid item anywhere in a registered collection makes `container.trakrIsValid` false, and fixing that item makes it true again.

**`protected untrackChild(child)`**

Removes a previously registered child. The symmetric counterpart to `trackChild`.

- For a model child: removes it from the container's child list.
- For a `TrackedCollection` child: removes the collection, unsubscribes from its `changed` event, and removes all items currently in the collection from the child list. Items pushed to the collection after this call are ignored.

Calling `untrackChild` on a child that was never registered is a no-op.

**`trakrIsValid`**

Returns `true` when all of the following hold:

- Every `@Tracked` validator on the container's own fields passes
- Every registered child's `trakrIsValid` is `true`

This is a per-object read — it does not affect `tracker.isValid`, which is already correct because each child calls `tracker._onValidityChanged` independently.

**`isDirty`** (`DirtyTrackedContainer` only)

Returns `true` when:

- The container has its own uncommitted field changes (`_dirtyCounter !== 0`), OR
- Any registered `DirtyTrackedObject` child has uncommitted field changes

**Multi-level trees: a container must be used at every intermediate node**

`container.trakrIsValid` checks each registered child by calling `child.trakrIsValid`. What that call returns depends on what `child` is:

- If `child` is a **container**, `child.trakrIsValid` also walks *its* registered children — and so on down the tree. Invalidity at any leaf propagates upward automatically.
- If `child` is a plain model, `child.trakrIsValid` reflects only that object's own `@Tracked` validators — its children (if any) are invisible to the parent container.

This means every intermediate node in the tree must extend a container class and register its own children, or validity will not propagate past that node.

```
✓ Correct — every intermediate node is a TrackedContainer

  IssueForm (TrackedContainer)
    ├── trackChild(mainSection)
    └── trackChild(actionsSection)

  MainSection (TrackedContainer)          ← intermediate node
    └── trackChild(analysisBlock)

  AnalysisBlock (TrackedContainer)        ← intermediate node
    └── @Tracked accessor summary

  ActionsSection (TrackedContainer)       ← intermediate node
    ├── @Tracked accessor owner
    └── trackChild(subtask1)

  Subtask1 (TrackedObject with @Tracked validators)   ← leaf
```

```
✗ Broken — MainSection is a plain TrackedObject

  IssueForm (TrackedContainer)
    └── trackChild(mainSection)

  MainSection (TrackedObject)             ← plain — does NOT compose children
    └── (owns analysisBlock but never calls trackChild)

  AnalysisBlock (TrackedContainer)        ← never reached by IssueForm.trakrIsValid
    └── @Tracked accessor summary = ''   ← this invalidity is invisible
```

In the broken example, `issueForm.trakrIsValid` calls `mainSection.trakrIsValid`, which returns `mainSection._isValid` (own fields only). `AnalysisBlock` is never consulted. A required `summary` field staying empty will not prevent a save.

The fix is to make `MainSection` a container and add `this.trackChild(analysisBlock)` in its constructor.

**When to use a container vs reading `tracker.isValid`**

`tracker.isValid` aggregates validity across the entire tracker — all models, all collections. A container's `trakrIsValid` gives a per-section validity that you can bind directly to a UI element (an error badge, a "section incomplete" indicator) without scanning the whole tracker.

```typescript
// Drive a section error badge in React
useTrackerVersion(tracker);
return <SectionHeader hasError={!section.trakrIsValid} />;
```

---

### `TypedEvent<T>`

A lightweight, strongly-typed event emitter. Used internally for `tracker.isDirtyChanged`, `tracker.isValidChanged`, `model.changed`, `model.trackedChanged`, `TrackedCollection.changed`, and `TrackedCollection.trackedChanged`, and available for your own use.

```typescript
const event = new TypedEvent<string>();

// subscribe returns an unsubscribe function
const unsubscribe = event.subscribe((value) => {
  console.log('received:', value);
});

event.emit('hello');  // → "received: hello"

unsubscribe();        // stop listening

event.emit('world');  // → (nothing)
```

| Method | Returns | Description |
|---|---|---|
| `subscribe(handler)` | `() => void` | Registers a listener. Returns an unsubscriber |
| `unsubscribe(handler)` | `void` | Removes a specific listener |
| `emit(value)` | `void` | Calls all registered listeners with the given value |

---

## Temporally versioned tables

Some databases never modify or delete rows in place. Instead, each row carries a validity period — typically `dt_start_validity` and `dt_end_validity` columns. An "update" means closing the current row (`dt_end_validity = now()`) and inserting a new row with `dt_end_validity = null`. A "delete" means closing the current row the same way. This is called **Method 2 temporal versioning**.

Because every update produces a new database row with a new auto-increment PK, the `@AutoId` field on a `Changed` object becomes stale after a successful save: the old row it pointed to has been closed, and the new row carries a different PK. The model must be updated with the new PK before the next save, otherwise the save layer would try to close the wrong row.

trakr handles this through `trakrId` and `onCommit`. The save flow for temporal tables is the same as the standard flow — the only difference is that the backend also returns `{ trackingId, value }` entries for `Changed` items (not just `Insert` items), and `onCommit(keys)` writes the new PK to those objects too.

### The problem

In a standard (non-temporal) database, an UPDATE modifies a row in place. The PK stays the same. After commit, `obj.id` is still correct.

In a temporal database, an UPDATE closes the current row and inserts a new one. The new row has a fresh PK. After commit, `obj.id` points to the closed row — it is now stale.

```
Before save:   obj.id = 10   (current, open row)
Backend:       closes row 10, inserts row 99
After save:    obj.id = 10   (stale — row 10 is closed)
Next save:     tries to close row 10 → wrong row
```

### The solution

Include `trakrId` in the payload for `Changed` items. The backend returns `{ trackingId, value }` for every item that produced a new row — inserts and temporal updates alike. `onCommit(keys)` writes the new PK to the `@AutoId` field of every matched object.

```
Before save:   obj.trakrId = 3, obj.id = 10
Payload:       { trackingId: 3, id: 10, ...fields }
Backend:       closes row 10, inserts row 99, echoes { trackingId: 3, value: 99 }
onCommit:      writes 99 to obj.id
After save:    obj.id = 99   (correct, open row), trakrState = Unchanged
```

### Full example

```typescript
import { DirtyTracker, Tracker, DirtyTrackedObject, TrackedCollection, State, Tracked, AutoId } from '@katn30/trakr';

class RuleModel extends DirtyTrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor value: string = '';

  constructor(tracker: DirtyTracker) {
    super(tracker);
  }
}

const tracker = new DirtyTracker();

// Load existing rows from the server
const rule = tracker.construct(() => new RuleModel(tracker));
tracker.withTrackingSuppressed(() => { rule.id = 10; });
// rule.trakrState === Unchanged
// rule.trakrId    === 1   (assigned at construction)
// rule.id         === 10  (real server PK)

// User edits a value
rule.value = '24h';
// rule.trakrState === Changed

// --- Save ---

const payload = {
  inserts: [] as { trackingId: number; value: string }[],
  changes: [] as { trackingId: number; id: number; value: string }[],
  deletes: [] as { id: number }[],
};

for (const obj of tracker.trackedObjects) {
  if (!(obj instanceof RuleModel)) continue;
  switch (obj.trakrState) {
    case State.Insert:
      payload.inserts.push({ trackingId: obj.trakrId, value: obj.value });
      break;
    case State.Changed:
      // Send both trakrId (to correlate the response) and id (to close the right row)
      payload.changes.push({ trackingId: obj.trakrId, id: obj.id, value: obj.value });
      break;
    case State.Deleted:
      payload.deletes.push({ id: obj.id });
      break;
  }
}

// Backend closes row 10, inserts row 99, returns the mapping
const response = await api.save(payload);
// response.ids: [{ trackingId: 1, value: 99 }]  ← returned for both inserts and temporal changes

// onCommit writes 99 to rule.id, transitions trakrState to Unchanged
tracker.onCommit(response.ids);
// rule.id          === 99   (new open row)
// rule.trakrState  === Unchanged
// tracker.isDirty === false
```

### Undo after a temporal commit

If the user undoes past a committed temporal update, the object transitions back to `Changed` with the old field values restored by the property undo closures. On the next save, `obj.id` now holds `99` (the last committed PK), which is correct — the backend can use it to close row 99 and open a new one.

```
onCommit:      rule.id = 99, trakrState = Unchanged
tracker.undo() rule.value restored to previous value, trakrState = Changed
Next save:     payload.changes includes { trackingId: 1, id: 99, value: '...' }
Backend:       closes row 99, inserts row 100, returns { trackingId: 1, value: 100 }
onCommit:      rule.id = 100
```

### Deleted items

For `Deleted` items the PK never changes — the backend just closes the existing row. No `trakrId` is needed in the delete payload; `obj.id` is always the correct row to close.

---

## Event generation (opt-in)

`DirtyTracker` is a **state diff**: after edits, iterate `tracker.trackedObjects`, group by `state`, and ship one bulk payload. Consumers on **event-sourced** backends need something different: a **list of typed events**, one per thing the user did, that the backend appends to its stream. Often they send them as they happen (autosave) rather than on an explicit Save.

`EventTracker`, `@EventTracked` and `EventTrackedCollection` provide that. `EventTracker` keeps an **event list**, the event-side counterpart of the undo stack:

- **Every operation** (one undo step) records the events it produced in `tracker.events`.
- **Each event has an `eventId` and a `state`:** `NotCommitted`, `Committed` or `Undone`.
- **You send the `NotCommitted` ones** (`tracker.pendingEvents`) and pass their `eventId`s to `onCommit`.
- **Undo and redo change event states.** They never rewrite committed history.

### API at a glance

```typescript
import {
  EventTracker,
  EventTracked,
  EventTrackedCollection,
  EventState,
  TrackedObject,
  AutoId,
  Tracker,
  TrackedEvent,
} from '@katn30/trakr';

enum IssueEvents {
  SubmittedDetailsRevised = 'SubmittedDetailsRevised',
  StageTransitioned = 'StageTransitioned',
  CommentAdded = 'CommentAdded',
  CommentRemoved = 'CommentRemoved',
  CommentEdited = 'CommentEdited',
}

class CommentModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked(undefined, undefined, { eventType: IssueEvents.CommentEdited })
  accessor text: string = '';

  constructor(t: EventTracker) { super(t); }
}

class IssueModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked(undefined, undefined, { eventType: IssueEvents.SubmittedDetailsRevised, coalesceWithin: 1000 })
  accessor name: string = '';

  @EventTracked(undefined, undefined, { eventType: IssueEvents.StageTransitioned })
  accessor stage: string = 'Submitted';

  readonly comments: EventTrackedCollection<CommentModel>;

  constructor(t: EventTracker) {
    super(t);
    this.comments = new EventTrackedCollection<CommentModel>(t, [], undefined, {
      itemAdded: IssueEvents.CommentAdded,
      itemRemoved: IssueEvents.CommentRemoved,
    });
  }
}

const tracker = new EventTracker();
const issue = tracker.construct(() => new IssueModel(tracker)); // loaded — no events

issue.name = 'Faulty widget';   // one operation → one event
issue.stage = 'InAnalysis';     // another operation → another event

tracker.events;
// [
//   { eventId: 1, eventType: 'SubmittedDetailsRevised', payload: { name: 'Faulty widget' }, trackingId: 1, targetId: 0, state: 'NotCommitted' },
//   { eventId: 2, eventType: 'StageTransitioned',       payload: { stage: 'InAnalysis' },    trackingId: 1, targetId: 0, state: 'NotCommitted' },
// ]

// Autosave: send whatever is pending whenever the list changes.
tracker.eventsChanged.subscribe(async () => {
  const batch = tracker.pendingEvents;                // 1. get the pending events
  if (batch.length === 0) return;
  const response = await api.publishEvents(batch);    // 2. send them
  tracker.onCommit(batch.map((e) => e.eventId), response.ids); // 3. only these become Committed
});
```

### `EventTracker`

Extends `Tracker`, so it has undo/redo, validation, sessions, `construct()`/`new()` and `version` (see [`Tracker`](#tracker--dirtytracker)). It adds:

```typescript
readonly events: readonly TrackedEvent[]     // every recorded event, oldest first, in all states
readonly pendingEvents: TrackedEvent[]       // the NotCommitted ones, oldest first
readonly eventsChanged: TypedEvent<readonly TrackedEvent[]>   // an event was added, removed, or changed state
onCommit<V = number>(eventIds: readonly number[], keys?: IdAssignment<V>[]): void
withContext<T>(ctx: unknown, action: () => T): T   // ctx is passed to history entryFactory
discardPendingChanges(): void
isDirty / isDirtyChanged / canCommit / canCommitChanged
```

- **`isDirty`** is `true` while at least one event is `NotCommitted`. `canCommit` is `isDirty && isValid`.
- **`onCommit(eventIds, keys?)`** marks exactly the events with those `eventId`s `Committed`. Nothing else changes state: events recorded while the request was in flight stay `NotCommitted`. Only ids are passed, so the events can travel through JSON, a store or a worker:

```typescript
issue.stage = 'InAnalysis';
const inFlight = tracker.pendingEvents;   // [#1 InAnalysis] — sent
issue.stage = 'InFixing';                 // #2, recorded while the request is in flight
tracker.onCommit(inFlight.map((e) => e.eventId));   // #1 Committed, #2 still NotCommitted
```

You may acknowledge a subset. Committing an event twice, or committing an `Undone` one, is a no-op. Unknown ids are ignored, with a warning in development builds. `keys` writes server-assigned `@AutoId` values by `trackingId`, as on `DirtyTracker`; events recorded afterwards carry the real id.

### Event states and undo/redo

| Action | Effect on the event list |
|---|---|
| A new operation | Its events are added as `NotCommitted` |
| `onCommit(eventIds)` | Those events become `Committed` |
| Undo of an operation whose events were not sent | They become `Undone`: kept, never to be sent |
| Redo of it | The same events become `NotCommitted` again |
| Undo of an operation whose events were committed | They stay `Committed`. A **compensating** event is added (`NotCommitted`, with `compensates` = the reverted event's `eventId`) |
| Redo before that compensation was sent | The compensation becomes `Undone` |
| Redo after it was committed | A new event re-applies the change, compensating the compensation |
| A new operation while redo is available | `Undone` events are dropped, just as the redo stack is |

A committed event is never deleted or rewritten: it is what the server has. The only way to take it back is a compensating event.

```typescript
issue.stage = 'InAnalysis';               // #1 NotCommitted
tracker.onCommit([1]);                    // #1 Committed
tracker.undo();                           // #1 Committed, #2 { stage: 'Submitted' } NotCommitted, compensates: 1
tracker.redo();                           // #2 Undone — never sent, nothing to compensate
```

**Coalescing.** Writes merged into one undo step by `coalesceWithin` update the still-pending event in place (same `eventId`). Typing "Faulty widget" sends one event, not thirteen. Once that event is committed, the next write starts a new one.

**Sessions.** `session.end()` turns the session into one undo step. If none of its events was sent yet, they merge into one set of events for that step. `session.rollback()` removes the session's unsent events and compensates any it had already committed.

**`tracker.new()`.** Constructor defaults are recorded as one event outside the undo stack. If the object is then added to an event collection while that event is still unsent, the event is dropped: the `itemAdded` / `added` entry already carries the full snapshot.

**`discardPendingChanges()`** reverts what has not been sent, as far as it can be reverted cleanly:
- Pending compensations are withdrawn by redoing.
- Operations whose events are all unsent are undone.
- The redo stack is dropped.

It never forgets an unsent event whose change is still in the objects, such as one from an operation that was partly committed, or from `tracker.new()`. Those stay pending.

**Autosave hook.** An event is recorded when its operation ends, so a `beforeChange` / `afterChange` subscriber (which runs during the write) does not see it yet. Use `tracker.eventsChanged`.

### `@EventTracked`

Drop-in replacement for `@Tracked` that also tags the field with an **event type**. Everything else is identical: validator, change hooks, `coalesceWithin`, undo/redo, dependency tracking, no-op detection.

```typescript
@EventTracked(validator?, hooks?, options?)
```

| Parameter | Type | Description |
|---|---|---|
| `validator` | `(self, newValue) => string \| undefined` | Same as `@Tracked` |
| `hooks` | `{ beforeChange?, afterChange? }` | Same as `@Tracked`. A bare function is accepted for backwards compatibility and maps to `beforeChange` |
| `options.eventType` | `string` (typically an enum value) | The event type this field contributes to |
| `options.coalesceWithin` | `number` | Same as `@Tracked`; coalesced writes also share one event |
| `options.history` | `HistoryConfig` | The payload carries a list of entries instead of the final value (see below) |

**Field-cluster grouping.** Fields of one object that share a tag and change in the same operation form **one event**. Its payload holds only the fields that operation changed. Fields changed in different operations are separate events. `@Tracked` (untagged) fields take part in undo/redo/validation but never in events.

**History fields.** With `history: true` the payload is `{ field: [{ property, value }, …] }`, one entry per write in the operation. With `history: { entryFactory }` each entry is `entryFactory(self, newValue, oldValue, change, ctx)`, where `ctx` comes from `tracker.withContext(ctx, fn)`. A compensating event carries the reverting entry.

### `EventTrackedCollection<T>`

Extends `TrackedCollection<T>`. The options choose the shape of the events a collection change produces. Every shape describes **what one operation did**.

**Per-item events: `itemAdded` / `itemRemoved`.**

```typescript
new EventTrackedCollection<CommentModel>(tracker, initialItems, validator, {
  itemAdded: IssueEvents.CommentAdded,
  itemRemoved: IssueEvents.CommentRemoved,
});
```

| The operation… | With the option set | Without it |
|---|---|---|
| adds an item | One `itemAdded` event, payload = **all** `@EventTracked` fields of the item | No event |
| removes an item | One `itemRemoved` event, payload = `{}`, `trackingId` set, `targetId` = numeric `@AutoId` or `@Id` (if any) | No event |
| edits an item in the collection | Per-field-cluster events, as for a standalone object | Same |

The two options are independent. Undoing an operation that produced no event for an item produces none either.

**Aggregate events: `eventType`.** One event per operation for the whole collection. With `owner: { object, property }`, the slot folds into the owner's event under `property`. The payload slot is `{ added: [snapshot…], removed: [identity…], changed: [{ …identity, …changedFields }] }`. Collections of primitives omit `changed`.

**Ordered ops: `history: true`.** Instead of buckets, the slot is `{ ops: [{ op: 'add' | 'remove' | 'change', … }] }` in the order they happened within the operation. With `history: { entryFactory }` each op is `entryFactory(item, change, ctx, op)`, where `op` is `'add'`, `'remove'` or `'change'`; compensating entries carry the inverse kind.

Items passed to the constructor are treated as already persisted. Mutations made with tracking suppressed (`construct()`, `withTrackingSuppressed()`) produce no events. Item types in aggregate or history mode must declare an `@Id` or `@AutoId`.

### `TrackedEvent` / `EventState`

```typescript
interface GeneratedEvent<TEventType extends string = string, TPayload = Record<string, unknown>> {
  eventType: TEventType;
  payload: TPayload;
  trackingId?: number;
  targetId?: unknown;
}

interface TrackedEvent<TEventType, TPayload> extends GeneratedEvent<TEventType, TPayload> {
  readonly eventId: number;
  readonly state: EventState;
  readonly compensates?: number;
}

enum EventState { NotCommitted = 'NotCommitted', Committed = 'Committed', Undone = 'Undone' }
```

| Field | When present | Notes |
|---|---|---|
| `eventId` | Always | Unique within the tracker. Pass it to `onCommit` once the server has persisted the event |
| `state` | Always | See [Event states and undo/redo](#event-states-and-undoredo) |
| `compensates` | Compensating events | `eventId` of the committed event this one reverts |
| `eventType` | Always | The tag from the consumer's enum / string-literal union |
| `payload` | Always | What the operation changed, in the shape described above. `undefined` values are normalised to `null` |
| `trackingId` | Events about a specific object | Correlate with the backend's `IdAssignment[]` response, or call `tracker.getByTrackingId()` |
| `targetId` | Object events, when the model has an identity | Top-level objects: `getIdentity(obj)`. Per-item events: numeric `@AutoId` (or `@Id`), omitted otherwise |

### Ordering

Events are listed in the order they were recorded. Within one operation, event order is **deterministic**:

1. **Object order**: objects appear in the order they were registered with the tracker.
2. **Field-cluster order within one object**: by which of the object's `@EventTracked` fields with that tag was **declared first** in the class body.

To send field revisions before a state transition made in the same operation, **declare the transition field last**:

```typescript
class IssueModel extends TrackedObject {
  @EventTracked(undefined, undefined, { eventType: IssueEvents.SubmittedDetailsRevised }) accessor name: string = '';
  // Declared LAST → within one operation its event comes after the others.
  @EventTracked(undefined, undefined, { eventType: IssueEvents.StageTransitioned })       accessor stage: string = 'Submitted';
}
```

Subclass `@EventTracked` fields appear **after** base-class fields.

### Granularity: one event per operation

An event is one undo step, so granularity is controlled the same way undo granularity is:

- **Every write is its own event**, which suits state transitions: `Submitted → InAnalysis → InFixing` is recorded as two `StageTransitioned` events, and the backend can check each transition.
- **`coalesceWithin`** merges bursts such as typing into one pending event.
- **Sessions** group a whole edit, such as a dialog, into one step and one set of events.

### Migration

**v7 → v8**

8.0 splits the model base class the way 6.0 split the tracker. `DirtyTracker` and `EventTracker` behave as in 7.x.

| v7 | v8 |
|---|---|
| `class M extends TrackedObject` used with a `DirtyTracker` | `class M extends DirtyTrackedObject`, with `constructor(t: DirtyTracker)` |
| `class M extends TrackedContainer` used with a `DirtyTracker` | `class M extends DirtyTrackedContainer`, with `constructor(t: DirtyTracker)` |
| `class M extends TrackedObject` used with an `EventTracker` | Unchanged, but type the constructor as `constructor(t: EventTracker)` |
| `constructor(t: Tracker)` in a model | Name the concrete tracker: a model belongs to one kind of tracker |
| `trakrState` / `isDirty` / `dirtyCounter` on EventTracker models (always `Unchanged` / `false` / `0`) | Removed. Read `tracker.pendingEvents` / `tracker.events` instead |
| `trakrState` / `isDirty` / `dirtyCounter` on `TrackedCollection` (always `Unchanged` / `false` / `0`) | Removed |
| `session.deletedObjects` | Only on `DirtyTracker` sessions (`DirtyTrackerSession`) |
| `new EventTrackedCollection(dirtyTracker, …)` | An `EventTrackedCollection` belongs to an `EventTracker` |
| `@EventTracked` on a `DirtyTracker` model | Use `@Tracked` |

Pairing a model with the wrong tracker is a compile-time error, and throws a `TypeError` at run time.

**v6 → v7**

7.0 replaces the on-demand event diff of 6.0 with the event list described above. `DirtyTracker` is unchanged.

| v6 | v7 |
|---|---|
| `eventTracker.generateEvents()` | `eventTracker.pendingEvents` |
| `eventTracker.onCommit(sentEvents, keys?)` | `eventTracker.onCommit(sentEvents.map((e) => e.eventId), keys?)`: pass the `eventId`s |
| Several edits before a save → one collapsed event per object and type | One event per operation. Use `coalesceWithin` or a session to group writes |
| Autosave from `afterChange` saw the change in `generateEvents()` | Subscribe to `eventTracker.eventsChanged` |
| Undo past a save → a compensating diff in the next `generateEvents()` | The original event stays `Committed`; a compensating event (with `compensates`) is added |

**v5 → v6**

| v5 | v6 |
|---|---|
| `new Tracker()` | `new DirtyTracker()`. `Tracker` is now abstract; keep `Tracker` as the parameter type in models |
| `eventTracker.onCommit()` / `onCommit(keys)` | `eventTracker.onCommit(sentEvents, keys?)`, passing the events the server persisted |
| `eventTracker.deletedObjects`, `trakrState` on EventTracker objects | Removed / always `Unchanged`. Removals are `removed` entries or `itemRemoved` events |
| `EventTracker.isDirty` right after `tracker.new()` was `false` | `true`: the defaults are unsent events |
| Collection history `entryFactory(item, change, ctx)` | Gets a 4th argument, `op: 'add' \| 'remove' \| 'change'` |

Calling `EventTracker.onCommit()` without arguments, or with anything but an array of `eventId`s as the first argument, throws a `TypeError`. `DirtyTracker` keeps the v5 `Tracker` behaviour unchanged, including undo across a commit.

**v2 → v3**

Nothing to migrate. Opt in per class or per collection whenever the consumer needs event generation. A single tracker instance can mix event-tracked and non-event-tracked objects.

---

## License

MIT — Nazario Mazzotti

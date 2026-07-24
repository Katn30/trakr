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
  Tracker,
  TrackedObject,
  TrackedCollection,
  Tracked,
  AutoId,
} from '@katn30/trakr';

const tracker = new Tracker();

class InvoiceModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor status: string = '';

  @Tracked((self, value) => value < 0 ? 'Total must be positive' : undefined)
  accessor total: number = 0;

  readonly lines: TrackedCollection<string>;

  constructor(tracker: Tracker) {
    super(tracker);
    this.lines = new TrackedCollection(tracker);
  }
}

const invoices = new TrackedCollection<InvoiceModel>(tracker);
const invoice = tracker.construct(() => new InvoiceModel(tracker));
invoices.push(invoice);        // state: Insert, trackingId: 1

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
class NameModel extends TrackedObject {
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
class TagModel extends TrackedObject {
  private _tag: string = '';
  readonly tags: TrackedCollection<string>;

  constructor(tracker: Tracker) {
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

**Case 1b — `@Tracked` with `onChange` callback**

When side-effect logic needs to be kept separate from the setter body — or when using `accessor` fields where there is no setter body — pass an `onChange` callback as the second argument to `@Tracked()`. It receives `(self, newValue, oldValue)` and runs inside the tracked operation, so any `@Tracked` property writes or `TrackedCollection` mutations made inside it are automatically composed into the same undo step. The callback does not fire during undo or redo — the stored actions handle replay.

```typescript
class TagModel extends TrackedObject {
  readonly tags: TrackedCollection<string>;

  @Tracked(
    undefined,
    (self: TagModel, newValue, oldValue) => {
      if (oldValue) self.tags.remove(oldValue);
      if (newValue) self.tags.push(newValue);  // composed — same undo step as tag
    },
  )
  accessor tag: string = '';

  constructor(tracker: Tracker) {
    super(tracker);
    this.tags = new TrackedCollection(tracker);
  }
}

model.tag = 'active';

tracker.undo(); // reverts tag AND removes 'active' from tags — one step
```

**Case 2 — `TrackedCollection` event callbacks**

When a `TrackedCollection` is mutated, both its `changed` and `trackedChanged` events fire synchronously inside the tracked operation. Any `@Tracked` property write made inside either subscriber is automatically composed into the same undo step as the collection mutation.

Use `changed` when you also want the callback to run during undo and redo. Use `trackedChanged` when you only want the callback to run on direct user mutations — it will not fire during undo or redo, and writes inside it are still composed on the initial write.

```typescript
// Using changed — fires on initial write, undo, and redo
class OrderModel extends TrackedObject {
  @Tracked() accessor itemCount: number = 0;

  readonly items: TrackedCollection<string>;

  constructor(tracker: Tracker) {
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
class LoggedCollection extends TrackedObject {
  @Tracked() accessor lastAdded: string = '';

  readonly items: TrackedCollection<string>;

  constructor(tracker: Tracker) {
    super(tracker);
    this.items = new TrackedCollection(tracker);
    this.items.trackedChanged.subscribe((e) => {
      if (e.added.length > 0) this.lastAdded = e.added[e.added.length - 1]; // composed
    });
  }
}
```

The same applies to `TrackedObject.trackedChanged`. A subscriber that writes to another `@Tracked` property is composed into the same undo step:

```typescript
class TitleModel extends TrackedObject {
  @Tracked() accessor summary: string = '';

  private _title: string = '';
  get title(): string { return this._title; }
  @Tracked() set title(value: string) { this._title = value; }

  constructor(tracker: Tracker) {
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
- Once for every property on every model after `tracker.construct()` completes

Results are stored per-property in `model.validationMessages: Map<string, string>` and aggregated into:

- `model.isValid: boolean` — `true` when all validators on this model pass
- `tracker.isValid: boolean` — `true` when every model and collection passes
- `tracker.canCommit: boolean` — `true` when `isDirty && isValid`

`tracker.isValidChanged` and `tracker.canCommitChanged` fire whenever these values change, so UI can bind directly to them without polling.

**Collection validators** are a separate function passed as the third argument to the `TrackedCollection` constructor. They receive the full array and return an error string or `undefined`. The result is exposed on `collection.error` and `collection.isValid`, and rolls up into `tracker.isValid`.

```typescript
const items = new TrackedCollection<string>(
  tracker,
  [],
  (list) => list.length === 0 ? 'At least one item is required' : undefined,
);

items.isValid; // false — empty
items.push('a');
items.isValid; // true
```

### Construction via tracker.construct()

All tracked model objects must be created inside `tracker.construct()`. This call:

- Suppresses tracking for the entire constructor body — property writes during construction are silently applied without creating undo entries
- Validates every object once after construction
- Calls `tracker.revalidate()` exactly once at the end, keeping bulk creation O(n)

The tracker is clean and `canUndo` is `false` immediately after `tracker.construct()` returns.

```typescript
// Single object — returns the constructed instance
const invoice = tracker.construct(() => new InvoiceModel(tracker));

// Multiple objects — pass them all in one callback
tracker.construct(() => {
  for (const row of serverRows) {
    const item = new ItemModel(tracker);
    item.name = row.name; // suppressed — not tracked
  }
});
// tracker.revalidate() is called once here — not once per object
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

`TrackedObject` defaults to `Unchanged` at construction time. This matches the most common scenario — objects are loaded from the database and are already persisted.

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

Adding or removing a `TrackedObject` from a `TrackedCollection` transitions its state automatically:

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

When a `@Tracked` property holds a `TrackedObject` value, assigning to it has the same effect: the outgoing value transitions to `Deleted` (or `Unchanged` if it was `Insert`), and the incoming value transitions to `Insert`:

```typescript
class OrderModel extends TrackedObject {
  @Tracked()
  accessor detail: DetailModel | null = null;

  constructor(tracker: Tracker) { super(tracker); }
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

Every `TrackedObject` has a `state: State` property — the single source of truth for what the save layer needs to do with that object. State transitions are driven by three types of events:

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

**`committed/undo` reverses the server operation** — undoing past a commit puts the object into the state that requires the inverse server operation. Undoing a committed INSERT requires a DELETE; undoing a committed DELETE requires a new INSERT; undoing a committed UPDATE requires another UPDATE with the pre-edit values.

**`@AutoId` is never zeroed out** — when `committed/undo` runs after a committed INSERT, the real server id stays on the `@AutoId` field so the save layer can send `DELETE /resource/{id}`. Similarly, after `committed/undo` of a DELETE, the `@AutoId` field still holds the old real id — but since `state` is now `Insert`, the save layer must use `trackingId` to identify the item in the POST payload, not `@AutoId`.

**`trackingId` for `Insert` and `Changed` items** — `trackingId` is assigned at construction and never changes. Include it in the save payload for `Insert` and `Changed` items so the backend can echo back the new server-assigned PK for each. See [Recommended save pattern](#recommended-save-pattern) and [Temporally versioned tables](#temporally-versioned-tables) for usage.

### Recommended save pattern

trakr does not mandate a specific save strategy — you can send changes per-object, batch selectively, or structure your API however your application requires.

That said, a pattern that works well with trakr's design is **all-or-nothing saves**: when the user clicks Save, the frontend collects every dirty object across the tracker, serialises them into a single request, and the backend saves everything inside one transaction — either succeeding fully or returning an error without applying partial changes. The frontend then calls `tracker.onCommit()` only on success.

Every `TrackedObject` has a `trackingId` — a positive integer assigned at construction time, stable for the lifetime of the object, unique across the tracker. Include `trackingId` in the save payload for `Insert` and `Changed` items. The backend echoes it back alongside the server-assigned PK for any item that produced a new row. `onCommit(keys)` then iterates every entry in `keys`, matches by `trackingId`, and writes the real PK to the `@AutoId` field of any match — regardless of whether the item was `Insert` or `Changed`.

New objects can reference each other via their `trackingId` in the payload (e.g. a new parent and its new children share consistent temp IDs before the server assigns real ones). After a successful save, `tracker.onCommit(keys)` updates all matched objects in place — no page reload is needed. This is the intended experience for form-heavy back-office pages, though reloading or restructuring state on save is equally valid.

**On failure, do not call `onCommit()`.**

If the server returns an error, simply surface the error to the user and leave the tracker as-is. The tracker stays dirty, `canUndo` remains `true`, and the user can fix the problem and try again — or undo their changes. Nothing needs to be reset manually.

---

## API Reference

### `Tracker`

The central coordinator. Create one per page or form context and pass it to every model and collection.

```typescript
const tracker = new Tracker();
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
| `trackedObjects` | `TrackedObject[]` | All registered models. Read-only — iterate for save payloads; do not mutate directly |
| `deletedObjects` | `TrackedObject[]` | Subset of `trackedObjects` where `state === Deleted`. Use this to build delete requests — deleted objects are removed from collections and composed properties, making them unreachable from the model tree |
| `trackedCollections` | `TrackedCollection<any>[]` | All registered collections. Read-only — do not mutate directly |

**Undo / redo**

```typescript
tracker.undo();  // reverts the last undo step
tracker.redo();  // re-applies the last undone step
```

Calling `undo()` or `redo()` when the respective flag is `false` is a no-op.

**Commit lifecycle**

```typescript
tracker.onCommit();           // mark current state as committed — isDirty → false
tracker.onCommit(keys);       // same, plus write real server IDs to @AutoId fields
```

`onCommit(keys?)` does three things:

1. Iterates every entry in `keys`. For each entry it finds a tracked object whose `trackingId` matches `entry.trackingId` and writes `entry.value` to its `@AutoId` field. This applies to both `Insert` items (new rows) and `Changed` items (e.g. temporal tables where an update produces a new row with a new PK).
2. Transitions every tracked object's `state` to `Unchanged` and resets `dirtyCounter`.
3. Appends the state change into the existing last undo operation — so undo atomically reverts both the user's edits and the committed state together (no spurious extra undo steps).

**Lookup by trackingId**

```typescript
const obj = tracker.getByTrackingId(42);   // TrackedObject | undefined
```

Returns the tracked object whose `trackingId` matches the given value, or `undefined` if none. Deleted objects are still findable this way (they remain in `trackedObjects` until `destroy()`). Useful for debugging, correlating server responses against known objects, or hydrating a UI selection from a persisted `trackingId`.

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
session.deletedObjects; // scoped objects in Deleted state
session.isDirtyChanged;    // same event as tracker.isDirtyChanged
session.canCommitChanged;  // same event as tracker.canCommitChanged
session.versionChanged;    // same event as tracker.versionChanged
```

**Object construction**

```typescript
// Single object — returns the constructed instance
const model = tracker.construct(() => new MyModel(tracker));

// Multiple objects — returns void
tracker.construct(() => {
  new ModelA(tracker);
  new ModelB(tracker);
});
```

`tracker.construct()` suppresses tracking for the entire callback, runs validators once after all objects are created, and calls `tracker.revalidate()` exactly once at the end.

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

### `TrackedObject`

The abstract base class for all trackable models. All subclass instances must be created via `tracker.construct()`.

```typescript
class InvoiceModel extends TrackedObject {
  constructor(tracker: Tracker) {
    super(tracker); // registers the model with the tracker
  }
}

const invoice = tracker.construct(() => new InvoiceModel(tracker));
```

**Model properties and methods**

| Member | Type | Description |
|---|---|---|
| `tracker` | `Tracker` | The tracker this model belongs to (set via `super(tracker)`) |
| `state` | `State` | The current persistence state — `Unchanged`, `Insert`, `Changed`, or `Deleted` |
| `trackingId` | `number` | Positive client-assigned identifier, unique across the tracker, set at construction and never changed. Include in the save payload for `Insert` and `Changed` items so the backend can return the new server PK |
| `isDirty` | `boolean` | `true` when this model has uncommitted property changes |
| `dirtyCounter` | `number` | Net count of uncommitted property writes. Increments on each write, decrements on undo. Reset to `0` by `onCommit()`. Can be negative after undoing past a committed save |
| `isValid` | `boolean` | `true` when all `@Tracked()` validators pass |
| `validationMessages` | `Map<string, string>` | Maps property name → error message for each failing validator |
| `changed` | `TypedEvent<TrackedPropertyChanged>` | Fires on every property change, including changes triggered by undo and redo |
| `trackedChanged` | `TypedEvent<TrackedPropertyChanged>` | Fires only on direct user-initiated writes — never during undo or redo |
| `destroy()` | `void` | Removes this model from the tracker |

**Property change events**

Both `changed` and `trackedChanged` carry a `TrackedPropertyChanged` payload:

```typescript
import type { TrackedPropertyChanged } from '@katn30/trakr';
// { property: string; oldValue: unknown; newValue: unknown }
```

| Field | Description |
|---|---|
| `property` | The decorated property name |
| `oldValue` | The value before the write |
| `newValue` | The value after the write |

Both events fire synchronously **inside** the tracked operation, so any `@Tracked` property write made inside either listener is automatically composed into the same undo step as the triggering write (see [Automatic composing](#automatic-composing)).

The difference is when they fire:
- `changed` fires on every write, including during undo and redo replays
- `trackedChanged` fires only on direct user-initiated writes — never during undo or redo

```typescript
// changed — fires on initial write, undo, and redo; writes in callback are composed
this.changed.subscribe(({ property }) => {
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

Read via `obj.state`.

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
class InvoiceModel extends TrackedObject {
  @Tracked() accessor status: string = '';
  constructor(tracker: Tracker, data?: { status: string }) {
    super(tracker);
    if (data) this.status = data.status; // suppressed — not tracked
  }
}

const invoice = tracker.construct(() => new InvoiceModel(tracker, { status: 'active' })); // state: Unchanged
```

**Saving:**

Iterate `tracker.trackedObjects`, read `state` and the appropriate ID on each model, and call `tracker.onCommit()` after the server responds successfully.

> **Why `tracker.trackedObjects` and not your own model tree?**
> Deleted objects are no longer reachable through your model graph — a `TrackedCollection` removes them from its array, and a `@Tracked` property set to `null` (or replaced with another object) removes the reference. The tracker holds every registered object regardless of its state, so iterating `trackedObjects` is the only way to reach objects that need a DELETE request. `tracker.deletedObjects` is a convenience getter for the deleted subset only, but both approaches work.

```typescript
import { Tracker, TrackedObject, State, Tracked, AutoId, TrackedCollection } from '@katn30/trakr';

class InvoiceModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor status: string = '';

  constructor(tracker: Tracker, data?: { id: number; status: string }) {
    super(tracker);
    if (data) {
      this.id = data.id;
      this.status = data.status;
    }
  }
}

const tracker = new Tracker();

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
// newInvoice.trackingId === 3  (assigned at construction, never changes)
// newInvoice.id         === 0  (untouched by the library until onCommit)

// --- Save ---

// Build the payload by reading each object's state
const payload: {
  inserts: { trackingId: number; status: string }[];
  updates: { trackingId: number; id: number; status: string }[];
  deletes: { id: number }[];
} = { inserts: [], updates: [], deletes: [] };

for (const obj of tracker.trackedObjects) {
  if (!(obj instanceof InvoiceModel)) continue;
  switch (obj.state) {
    case State.Insert:
      // Send trackingId so the backend can echo back the new server PK
      payload.inserts.push({ trackingId: obj.trackingId, status: obj.status });
      break;
    case State.Changed:
      payload.updates.push({ trackingId: obj.trackingId, id: obj.id, status: obj.status });
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
// newInvoice.id === 42, state === Unchanged
// tracker.isDirty === false

// When no new PKs were assigned, keys can be omitted:
// tracker.onCommit();
```

---

### `@AutoId`

Marks a property as the server-assigned autoincrement primary key for this model. Only one `@AutoId` field is allowed per class. Enables the `onCommit` lifecycle for real-ID assignment.

`@AutoId` is a **specialisation of `@Id`**: it also registers the property as part of the model's identity (so `getIdentity(obj)` includes it), but it additionally singles the property out as the one trakr will overwrite from `onCommit(keys)`. Use `@Id` for identity properties you assign yourself; use `@AutoId` for the single property trakr should patch on commit. See [`@Id`](#id) for identity-only properties (composite keys, caller-assigned UUIDs, natural keys).

```typescript
class InvoiceModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor status: string = '';

  constructor(tracker: Tracker) {
    super(tracker);
  }
}
```

The `@AutoId` field is left at its initial value until `onCommit(keys)` writes the real server ID. The save layer identifies items that need a new PK via `trackingId` — a stable, positive integer assigned at construction and never changed. Include `trackingId` in the save payload for `Insert` (and `Changed`, for temporal tables) items; the backend returns it alongside the new PK.

**Typical save flow:**

```typescript
const invoice = tracker.construct(() => new InvoiceModel(tracker));
invoices.push(invoice);
// invoice.trackingId === 1  (assigned at construction, never changes)
// invoice.id         === 0  (untouched by the library)

invoice.status = 'draft';

// 1. Build payload — send trackingId for Insert items:
const serverIds = [{ trackingId: invoice.trackingId, value: 42 }];

// 2. Send to server, receive real IDs back.

// 3. Apply real IDs and mark clean:
tracker.onCommit(serverIds);
// invoice.id        === 42  (written by onCommit)
// tracker.isDirty   === false
```

`onCommit()` with no arguments (or an empty array) still marks the tracker as clean — it just skips the ID replacement step.

`trackingId` values are globally unique across the lifetime of the tracker and never reused, so they can safely serve as correlation keys across multiple save cycles.

**Reactivity gate.** The `@AutoId` write performed by `onCommit(keys)` is a **library-internal write, not a user edit**. It does **not** fire `TrackedObject.changed` for the `@AutoId` property, does **not** bump `dirtyCounter`, does **not** re-run `@Tracked` validators, and does **not** flicker `tracker.isDirty` back to `true` during commit. After `onCommit` returns, `state === Unchanged` and `isDirty === false` — as if the object were freshly loaded with the real PK. Treat the write as *authoritative baseline update*, not as a change event.

---

### `@Id`

Marks a property as part of the model's **caller-provided identity**. Any type is allowed (string, number, UUID, ULID, tuple-like composite via multiple decorators). Trakr never mutates the value — you set it (typically from the server, or client-generated for UUID schemas), and trakr uses it purely to compute `getIdentity(obj)`, `getIdentityObject(obj)`, and `getIdentityProperties(proto)`.

```typescript
class TenantModel extends TrackedObject {
  @Id
  code: string = '';        // caller-assigned string PK

  @Tracked()
  accessor name: string = '';
}

class LineItemModel extends TrackedObject {
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

The common interface implemented by both `TrackedObject` and `TrackedCollection`. Useful for writing utility functions that accept either:

```typescript
import { ITracked } from '@katn30/trakr';

function isReady(item: ITracked): boolean {
  return item.isDirty && item.isValid;
}
```

| Member | Type | Description |
|---|---|---|
| `tracker` | `Tracker` | The tracker this object belongs to |
| `isDirty` | `boolean` | `true` when there are uncommitted changes |
| `dirtyCounter` | `number` | Net count of uncommitted writes |
| `state` | `State` | Current persistence state (always `Unchanged` for collections) |
| `destroy()` | `void` | Removes this object from the tracker |

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
| `trackingId` | `number` | The `trackingId` of the object that received a new server-assigned PK |
| `value` | `V` (default `number`) | The real server-assigned ID to write to the `@AutoId` field |

`tracker.onCommit<V>(keys)` is generic in `V`: pass `IdAssignment<string>[]` for UUID/ULID schemas, `IdAssignment[]` for the numeric default. Trakr writes `entry.value` straight into the `@AutoId` field — the field's declared type is what enforces the match at the call site (e.g. `@AutoId id: string = ''` with `onCommit<string>(...)`).

The server returns one `IdAssignment` per item that produced a new database row — both inserted objects and, in temporal tables, updated objects (see [Temporally versioned tables](#temporally-versioned-tables)). `onCommit()` iterates every entry, matches by `trackingId` against every tracked object, and writes `value` to the `@AutoId` field of any match.

---

### `@Tracked()`

The property decorator. Intercepts every write, records an undo/redo pair, and optionally validates the new value. Works with `accessor` fields, explicit `get`/`set` pairs, and plain getters. Place it on the **accessor**, the **setter**, or the **getter**.

**With `accessor` (recommended):**

```typescript
class ProductModel extends TrackedObject {
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

  constructor(tracker: Tracker) {
    super(tracker);
  }
}
```

**With `get`/`set`** — decorate the setter:

```typescript
class ProductModel extends TrackedObject {
  private _name: string = '';

  get name(): string { return this._name; }

  @Tracked()
  set name(value: string) { this._name = value; }

  constructor(tracker: Tracker) {
    super(tracker);
  }
}
```

**With `get`/`set` and side effects** — decorate both getter and setter:

When the setter contains side-effect logic that must stay intact (e.g. cascading writes to other properties), decorate both the getter and the setter. The getter decoration registers `isEnabled` as a dependency source — any validator that reads it will automatically re-run when the setter fires. The setter decoration handles undo/redo as usual.

```typescript
class RuleModel extends TrackedObject {
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

  constructor(tracker: Tracker) {
    super(tracker);
  }
}
```

When `isEnabled` is set to `true`, `scheduleDays`'s validator automatically re-runs because the getter declared the dependency. No manual `revalidate()` call is needed.

> Note: decorating just the getter (without the setter) is valid when the getter is purely computed — it registers the property as a dependency source without attaching any undo/redo logic.

**With a validator:**

The validator receives the model instance and the incoming value. Return an error string to fail, `undefined` to pass.

```typescript
class OrderModel extends TrackedObject {
  @Tracked((self, value) => !value ? 'Status is required' : undefined)
  accessor status: string = '';

  @Tracked((self, value) => value < 0 ? 'Price must be positive' : undefined)
  accessor price: number = 0;

  // Validator can inspect other properties of the model
  @Tracked((self: OrderModel, value) =>
    value > self.price ? 'Discount exceeds price' : undefined
  )
  accessor discount: number = 0;

  constructor(tracker: Tracker) {
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
@Tracked(validator?, onChange?, options?)
```

| Parameter | Type | Applies to | Description |
|---|---|---|---|
| `validator` | `(self, newValue) => string \| undefined` | accessor, setter | Returns an error string on failure, `undefined` on success |
| `onChange` | `(self, newValue, oldValue) => void` | accessor, setter | Side-effect callback. Runs inside the tracked operation — writes to other `@Tracked` properties or `TrackedCollection`s are composed into the same undo step. Does not fire during undo or redo |
| `options.coalesceWithin` | `number` | accessor, setter | Maximum gap in ms between two consecutive writes to merge into one undo step. Omit to never coalesce |

```typescript
// validator only:
@Tracked((_, v) => v < 0 ? 'Must be positive' : undefined)
accessor price: number = 0;

// onChange only — side effects composed into the same undo step:
@Tracked(
  undefined,
  (self: TagModel, newValue, oldValue) => {
    if (oldValue) self.tags.remove(oldValue);
    if (newValue) self.tags.push(newValue);
  },
)
accessor tag: string = '';

// validator + onChange + coalesceWithin:
@Tracked(
  (_, v) => !v ? 'Required' : undefined,
  (self: MyModel, newValue) => { self.log.push(newValue); },
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

### `TypedEvent<T>`

A lightweight, strongly-typed event emitter. Used internally for `tracker.isDirtyChanged`, `tracker.isValidChanged`, `TrackedObject.changed`, `TrackedObject.trackedChanged`, `TrackedCollection.changed`, and `TrackedCollection.trackedChanged`, and available for your own use.

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

trakr handles this through `trackingId` and `onCommit`. The save flow for temporal tables is the same as the standard flow — the only difference is that the backend also returns `{ trackingId, value }` entries for `Changed` items (not just `Insert` items), and `onCommit(keys)` writes the new PK to those objects too.

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

Include `trackingId` in the payload for `Changed` items. The backend returns `{ trackingId, value }` for every item that produced a new row — inserts and temporal updates alike. `onCommit(keys)` writes the new PK to the `@AutoId` field of every matched object.

```
Before save:   obj.trackingId = 3, obj.id = 10
Payload:       { trackingId: 3, id: 10, ...fields }
Backend:       closes row 10, inserts row 99, echoes { trackingId: 3, value: 99 }
onCommit:      writes 99 to obj.id
After save:    obj.id = 99   (correct, open row), state = Unchanged
```

### Full example

```typescript
import { Tracker, TrackedObject, TrackedCollection, State, Tracked, AutoId } from '@katn30/trakr';

class RuleModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @Tracked()
  accessor value: string = '';

  constructor(tracker: Tracker) {
    super(tracker);
  }
}

const tracker = new Tracker();

// Load existing rows from the server
const rule = tracker.construct(() => new RuleModel(tracker));
tracker.withTrackingSuppressed(() => { rule.id = 10; });
// rule.state       === Unchanged
// rule.trackingId  === 1   (assigned at construction)
// rule.id          === 10  (real server PK)

// User edits a value
rule.value = '24h';
// rule.state === Changed

// --- Save ---

const payload = {
  inserts: [] as { trackingId: number; value: string }[],
  changes: [] as { trackingId: number; id: number; value: string }[],
  deletes: [] as { id: number }[],
};

for (const obj of tracker.trackedObjects) {
  if (!(obj instanceof RuleModel)) continue;
  switch (obj.state) {
    case State.Insert:
      payload.inserts.push({ trackingId: obj.trackingId, value: obj.value });
      break;
    case State.Changed:
      // Send both trackingId (to correlate the response) and id (to close the right row)
      payload.changes.push({ trackingId: obj.trackingId, id: obj.id, value: obj.value });
      break;
    case State.Deleted:
      payload.deletes.push({ id: obj.id });
      break;
  }
}

// Backend closes row 10, inserts row 99, returns the mapping
const response = await api.save(payload);
// response.ids: [{ trackingId: 1, value: 99 }]  ← returned for both inserts and temporal changes

// onCommit writes 99 to rule.id, transitions state to Unchanged
tracker.onCommit(response.ids);
// rule.id     === 99   (new open row)
// rule.state  === Unchanged
// tracker.isDirty === false
```

### Undo after a temporal commit

If the user undoes past a committed temporal update, the object transitions back to `Changed` with the old field values restored by the property undo closures. On the next save, `obj.id` now holds `99` (the last committed PK), which is correct — the backend can use it to close row 99 and open a new one.

```
onCommit:      rule.id = 99, state = Unchanged
tracker.undo() rule.value restored to previous value, state = Changed
Next save:     payload.changes includes { trackingId: 1, id: 99, value: '...' }
Backend:       closes row 99, inserts row 100, returns { trackingId: 1, value: 100 }
onCommit:      rule.id = 100
```

### Deleted items

For `Deleted` items the PK never changes — the backend just closes the existing row. No `trackingId` is needed in the delete payload; `obj.id` is always the correct row to close.

---

## Event generation (opt-in)

trakr's core is a **state diff** — after edits, iterate `tracker.trackedObjects`, group by `state`, and ship a bulk payload. That model works for most backends, but consumers moving to **event-sourced DDD** need something different: on Save, produce a **list of typed events**, one per meaningful change, that the backend appends to an event stream.

`EventTracker`, `@EventTracked`, and `EventTrackedCollection` provide a **fully opt-in** layer on top of the base API that turns dirty state into a typed event list on demand. Everything else stays identical — consumers using `Tracker` / `TrackedObject` / `TrackedCollection` / `@Tracked` see zero behavioural change.

### API at a glance

```typescript
import {
  EventTracker,
  EventTracked,
  EventTrackedCollection,
  TrackedObject,
  AutoId,
  Tracker,
  GeneratedEvent,
} from '@katn30/trakr';

enum IssueEvents {
  SubmittedDetailsRevised = 'SubmittedDetailsRevised',
  AnalysisRevised = 'AnalysisRevised',
  StageTransitioned = 'StageTransitioned',
  CommentAdded = 'CommentAdded',
  CommentRemoved = 'CommentRemoved',
  CommentEdited = 'CommentEdited',
  CommentStatusChanged = 'CommentStatusChanged',
}

class CommentModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked(IssueEvents.CommentEdited)
  accessor text: string = '';

  @EventTracked(IssueEvents.CommentStatusChanged)
  accessor status: string = 'open';

  constructor(t: Tracker) { super(t); }
}

class IssueModel extends TrackedObject {
  @AutoId
  id: number = 0;

  @EventTracked(IssueEvents.SubmittedDetailsRevised)
  accessor name: string = '';

  @EventTracked(IssueEvents.SubmittedDetailsRevised)
  accessor description: string = '';

  @EventTracked(IssueEvents.AnalysisRevised)
  accessor analysisSummary: string | null = null;

  @EventTracked(IssueEvents.AnalysisRevised)
  accessor rootCause: string | null = null;

  // Declared LAST — see "Ordering" below.
  @EventTracked(IssueEvents.StageTransitioned)
  accessor stage: string = 'Submitted';

  readonly comments: EventTrackedCollection<CommentModel>;

  constructor(t: Tracker) {
    super(t);
    this.comments = new EventTrackedCollection<CommentModel>(
      t,
      [],
      undefined,
      {
        itemAdded: IssueEvents.CommentAdded,
        itemRemoved: IssueEvents.CommentRemoved,
      },
    );
  }
}

const tracker = new EventTracker();
const issue = tracker.construct(() => new IssueModel(tracker));
tracker.onCommit(); // start clean (issue is loaded)

// user makes some edits
issue.name = 'Faulty widget';
issue.stage = 'InAnalysis';

// on Save:
const events: GeneratedEvent<IssueEvents>[] = tracker.generateEvents<IssueEvents>();
// events = [
//   { eventType: 'SubmittedDetailsRevised', payload: { name: 'Faulty widget' }, trackingId: 1, targetId: ... },
//   { eventType: 'StageTransitioned',       payload: { stage: 'InAnalysis' },    trackingId: 1, targetId: ... },
// ]
await api.publishEvents(events);
tracker.onCommit();
```

`generateEvents()` is a **pure read** — no mutation, no state transitions. Calling it twice with no intervening writes returns the same list.

### `@EventTracked`

Drop-in replacement for `@Tracked` that adds an **event-type tag** as the first argument. Everything else — validator, `onChange`, `coalesceWithin`, undo/redo, dependency tracking, no-op detection — is identical.

```typescript
@EventTracked(eventType, validator?, onChange?, options?)
```

| Parameter | Type | Description |
|---|---|---|
| `eventType` | `string` (typically an enum value) | The tag this field contributes to |
| `validator` | `(self, newValue) => string \| undefined` | Same as `@Tracked` |
| `onChange` | `(self, newValue, oldValue) => void` | Same as `@Tracked` |
| `options.coalesceWithin` | `number` | Same as `@Tracked` |

**Field-cluster grouping.** All fields on a class that share the same tag collapse into **one event**, whose payload contains **only the fields that are currently dirty relative to the last committed state**. Untouched fields are never included. `@Tracked` (untagged) fields continue to work — they participate in undo/redo/validation but do not contribute to event generation.

**Do not name an `@EventTracked` field `state`** — it collides with `TrackedObject.state`, which is the enum used by the state machine. Use a different name (`stage`, `status`, `phase`, `workflowState`…).

### `EventTracker`

Extends `Tracker` with one method:

```typescript
generateEvents<TEventType extends string = string>(): GeneratedEvent<TEventType>[]
```

Everything else is unchanged. An `EventTracker` used as a plain `Tracker` (never calling `generateEvents`) behaves **exactly** like a v2 `Tracker`. The one internal difference: `EventTracker.onCommit(keys)` also clears per-instance event-diff state, which is what makes "after commit, `generateEvents` returns `[]`" work.

### `EventTrackedCollection<T>`

Extends `TrackedCollection<T>` with an optional **lifecycle mapping** for item add/remove:

```typescript
new EventTrackedCollection<CommentModel>(
  tracker,
  initialItems,
  validator,
  {
    itemAdded: IssueEvents.CommentAdded,
    itemRemoved: IssueEvents.CommentRemoved,
  },
);
```

For items that are themselves `TrackedObject`s, the following per-item rules apply at generation time:

| Item state | With `itemAdded` set | With `itemAdded` omitted |
|---|---|---|
| `Insert` | One `itemAdded` event, payload = **all** `@EventTracked` fields on the item (regardless of tag) | No event |
| `Deleted` | One `itemRemoved` event, payload = `{}`, `targetId` = the item's `@AutoId` value | No event |
| `Changed` | Per-field-cluster events (as if the item were a standalone `Changed` model) | Same — per-field-cluster events |
| `Unchanged` | No event | No event |

Consumers can opt in to some lifecycle events but not others — the two options are independent. If both are omitted, `EventTrackedCollection` behaves like a plain `TrackedCollection` from the events perspective: only per-field events on `Changed` items are emitted.

**Insert-then-remove collapses to zero events.** If a `TrackedObject` is pushed to a collection and then removed before Save, its state returns to `Unchanged` (see [Object state machine](#object-state-machine) — `removed/do` from `Insert` collapses to `Unchanged`). No `itemAdded` event is emitted for an object that was never really added.

**Collections of primitives** — `EventTrackedCollection<string>`, `EventTrackedCollection<number>`, etc. — accept the lifecycle option bag but do not currently emit lifecycle events, because primitives have no `trackingId` or per-field tags. Track primitive add/remove via `collection.changed` if you need those events.

### `GeneratedEvent`

```typescript
interface GeneratedEvent<
  TEventType extends string = string,
  TPayload = Record<string, unknown>,
> {
  eventType: TEventType;
  payload: TPayload;
  trackingId?: number;
  targetId?: number;
}
```

| Field | When present | Notes |
|---|---|---|
| `eventType` | Always | The tag value from the consumer's enum / string-literal union |
| `payload` | Always | For lifecycle `itemAdded`: all `@EventTracked` fields' current values. For field-cluster events: only the dirty fields carrying that tag. For lifecycle `itemRemoved`: `{}`. Values of `undefined` are normalised to `null` |
| `trackingId` | On events emitted from `Insert` or `Changed` items | Correlate with the backend's `IdAssignment[]` response — same mechanism as v2 |
| `targetId` | On events emitted from `Changed` or `Deleted` items when the model has `@AutoId` | The current `@AutoId` value; the backend uses it to identify the row |

### Semantic rules

1. **Only actual differences produce events.** trakr subscribes to `TrackedObject.changed` and maintains a per-property "original vs. current" diff since the last commit. A write, followed by another write back to the original value (or a `tracker.undo()`), removes the entry — no event is emitted for that field.

2. **Insert emits everything, Changed emits deltas.** For `Insert` items, `itemAdded` sends the full snapshot of `@EventTracked` fields (a new aggregate is "born" with all its state). For `Changed` items, field-cluster events send only fields that actually changed.

3. **`onCommit` resets the baseline.** After `tracker.onCommit()`, every property's "original" is its now-committed value. Subsequent edits are diffed against this new baseline. Undoing past a commit re-populates the diff naturally, because the property undo closures emit `changed` with the reversed old/new values.

4. **`@Tracked` and `@EventTracked` are freely mixable on the same class.** `@Tracked` fields participate in undo/redo/validation as usual; they simply never appear in event payloads.

### Ordering

Event ordering is **deterministic**:

1. **Object order** — objects appear in the events in the order they were registered with the tracker (typically the order they were pushed into their collections).
2. **Field-cluster event order within one object** — determined by which of that object's `@EventTracked` fields with the same tag was **first declared** in the class body.

Consumers who need semantic ordering — for example, "field revisions before a state transition, so the backend's transition precondition sees the freshly-set field values" — control it by **declaring the transition field last** in the class body. trakr does not need to know which events are "transitions"; declaration order is the entire mechanism.

```typescript
class IssueModel extends TrackedObject {
  @EventTracked(IssueEvents.SubmittedDetailsRevised) accessor name: string = '';
  @EventTracked(IssueEvents.AnalysisRevised)         accessor analysisSummary: string | null = null;
  // Declared LAST → its event comes after all others.
  @EventTracked(IssueEvents.StageTransitioned)       accessor stage: string = 'Submitted';
}
```

Given `issue.stage = 'InAnalysis'` and `issue.analysisSummary = 'AS'`, `generateEvents()` returns:

```
[
  { eventType: 'AnalysisRevised',    payload: { analysisSummary: 'AS' }, ... },
  { eventType: 'StageTransitioned',  payload: { stage: 'InAnalysis' },   ... },
]
```

Subclass `@EventTracked` fields appear **after** base-class fields, matching the declaration order across the prototype chain.

### Scalars vs. sequences: choosing the primitive

`@EventTracked` and `EventTrackedCollection` look interchangeable when both can carry the same field on the wire — a `stage` property could sit on the model as either an accessor or an item in a collection. They are **not** interchangeable: they encode different semantics, and picking the wrong one silently loses information at Save time.

**`@EventTracked` accessor — the field is a *value*.** Multiple writes in one session collapse to **one** event carrying the field's **final** value. That is correct behaviour: consumers care about "what the field is now", not "how many times the user retyped it". Typing `Faulty widget` character by character produces one `SubmittedDetailsRevised{name: 'Faulty widget'}`, not eleven.

**`EventTrackedCollection` — the field is a *sequence of actions*.** Each push emits its own `itemAdded` event, in insertion order. Two pushes produce two events; they never collapse.

The trap: state-machine-style fields *look* like scalars ("current stage"), so it is tempting to model them as `@EventTracked accessor stage`. That is wrong. A transition is not an update to a value — it is a discrete action, and every intermediate state must be persisted for the backend's transition preconditions (`from → to` allowed?) to hold on replay.

```typescript
// WRONG — accessor collapses "Submitted → InAnalysis → InFixing" into one event
class IssueModel extends TrackedObject {
  @EventTracked(IssueEvents.StageTransitioned) accessor stage: string = 'Submitted';
}

issue.stage = 'InAnalysis';
issue.stage = 'InFixing';

// generateEvents() returns ONE event with the final value:
// [{ eventType: 'StageTransitioned', payload: { stage: 'InFixing' } }]
// Backend replays: Submitted → InFixing, rejects as illegal transition.
```

```typescript
// RIGHT — one StageTransitioned event per push, in order
class StageTransition extends TrackedObject {
  @EventTracked(IssueEvents.StageTransitioned) accessor stage: string;
  transitionedAt: string;
  transitionedBy: string | null;

  constructor(t: Tracker, stage: string, at: string, by: string | null) {
    super(t);
    this.stage = stage;
    this.transitionedAt = at;
    this.transitionedBy = by;
  }
}

class IssueModel extends TrackedObject {
  stage: string = 'Submitted';                          // plain field, drives UI only
  readonly transitions: EventTrackedCollection<StageTransition>;

  constructor(t: Tracker) {
    super(t);
    this.transitions = new EventTrackedCollection<StageTransition>(
      t, [], undefined, { itemAdded: IssueEvents.StageTransitioned },
    );
  }

  transitionTo(target: string, by: string | null): void {
    this.stage = target;
    this.transitions.push(
      this.tracker.construct(() => new StageTransition(this.tracker, target, new Date().toISOString(), by)),
    );
  }
}

issue.transitionTo('InAnalysis', 'alice');
issue.transitionTo('InFixing', 'alice');

// generateEvents() returns TWO events, in insertion order:
// [
//   { eventType: 'StageTransitioned', payload: { stage: 'InAnalysis' }, ... },
//   { eventType: 'StageTransitioned', payload: { stage: 'InFixing' },   ... },
// ]
```

**Rule of thumb.** If the field's meaning is *"what it is now"* and the backend does not need to see every intermediate write, use `@EventTracked` on an accessor. If each write is a *distinct, ordered action* the backend must apply sequentially — state transitions, audit log entries, phase changes, workflow steps — use `EventTrackedCollection` with an `itemAdded` tag.

### Migration

There is **nothing to migrate** from v2 → v3 for existing code. `Tracker`, `TrackedObject`, `TrackedCollection`, `@Tracked`, and `@AutoId` are unchanged. Opt in per class or per collection whenever the consumer needs event generation. A single tracker instance can mix event-tracked and non-event-tracked objects.

---

## License

MIT — Nazario Mazzotti

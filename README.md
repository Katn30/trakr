# chronicle

Change tracking for TypeScript models: **undo/redo**, **validation** and **saving**, driven by decorators.

You write plain model classes. Chronicle records every change as an undoable step,
keeps the model's validity up to date, and tells you what to save. It comes in two
flavours, one per way of saving:

| Package | Saves | Use it when |
|---|---|---|
| [`@chronicle/unit-of-work`](packages/unit-of-work/README.md) | the objects to **insert, update and delete** | your backend stores rows or documents: a Save button, or autosave, sends the changed objects |
| [`@chronicle/event-log`](packages/event-log/README.md) | **events**: what changed, per object | your backend is event-sourced, or merges change sets into what it already has |

Both share the same core ([`@chronicle/core`](packages/core/README.md)): models,
tracked properties and collections, validation, undo/redo and the history.
An application uses one flavour and imports everything from it.

```bash
npm install @chronicle/unit-of-work     # or: npm install @chronicle/event-log
```

Chronicle uses the standard (TC39) decorators: TypeScript 5 or later, with
`experimentalDecorators` **not** set.

---

## A first look

```ts
import { UnitOfWork, Entity, Tracked, AutoId } from "@chronicle/unit-of-work";

class Task extends Entity {
  @AutoId id: number | null = null;
  @Tracked((_self, title: string) => (title === "" ? "The title is required" : undefined))
  accessor title: string = "";
  @Tracked() accessor done: boolean = false;
  constructor(tracker: UnitOfWork) { super(tracker); }
}

const tracker = new UnitOfWork();
const task = tracker.construct(() => {           // an object the server already has
  const t = new Task(tracker);
  t.id = 7;
  t.title = "Write the README";
  return t;
});

task.done = true;          // one undoable step
tracker.isDirty;           // true
tracker.undo();            // task.done === false again
tracker.redo();

task.title = "";
tracker.isValid;           // false
task.validationMessages;   // Map { "title" => "The title is required" }
tracker.canCommit;         // false: isDirty && isValid
```

The same model with an event log differs only in its base class and decorator
(`TrackedObject`, `@EventTracked`); what changes is how the changes are saved.
See each package's README.

---

## Concepts shared by both flavours

### Models

A model extends the flavour's base class (`Entity` or `TrackedObject`) and takes
its tracker in the constructor. The pairing is checked by the compiler: an
`Entity` only accepts a `UnitOfWork`, a `TrackedObject` only an `EventLog`.

Every model gets a `chronicleId`: a stable local id, unique within its tracker,
used to match what the server returns (e.g. new ids) to the right object.

### Creating objects: `construct()` and `new()`

Models are always created inside one of the two:

```ts
const loaded = tracker.construct(() => new Task(tracker, row));   // the server has it
const draft  = tracker.new(() => new Task(tracker));              // the server does not
```

| | `construct()` | `new()` |
|---|---|---|
| For | objects loaded from the server | objects the user creates |
| Constructor writes | taken as they are: no hooks run, nothing is recorded | hooks run (defaults can cascade), nothing is recorded |
| Afterwards | clean and valid-checked | clean and valid-checked; becomes a change to save once it is used (see each package) |

Creating a model outside them throws in development builds.

### Tracked properties

```ts
@Tracked(validator?, hooks?, { coalesceWithin? }?)
accessor name: string = "";
```

- **Every write is one undoable step** (an *operation*). Writes made inside it
  (by hooks, by a setter's body, by change subscribers) belong to the same step.
- **`coalesceWithin`** (milliseconds): consecutive writes to the property within
  that time form one step, e.g. typing in a text field.
- **`accessor` fields** are the recommended form. A `get`/`set` pair works too:
  decorate the setter (and the getter, so validators can depend on it).
- **A decorated getter** (`@Tracked() get total()`) records nothing. Validators can
  depend on it, and it can have a validator of its own (e.g. "the total is over
  budget"). On an event log it is not part of the events: it is derived.

`@EventTracked` (event log) takes the same arguments plus event options.

### Validation

A validator returns an error message, or `undefined` when the value is valid:

```ts
@Tracked((self: Invoice, due: Date) => (due < self.issued ? "Due before issued" : undefined))
accessor due: Date = new Date();
```

- It re-runs whenever anything it reads changes, including other properties and
  other objects: dependencies are tracked automatically.
- `model.validationMessages` holds the message per failing property;
  `model.chronicleIsValid` says whether there is none.
- A collection can have a validator too (its constructor's third argument),
  with its message in `collection.error`.
- `tracker.isValid` covers every object and collection in the model. Objects
  removed from the model (and whole subtrees of a removed container) stop
  counting; undo brings them back.

### Hooks: `beforeChange` and `afterChange`

For logic that must run when the user changes a property, such as "moving back
to *draft* clears the approval":

```ts
@Tracked(undefined, {
  beforeChange: (self: Issue, next: string, previous: string) => {
    if (next === "draft" && previous !== "draft") self.approvedBy = null;
  },
})
accessor stage: string = "draft";
```

- **Hooks run inside the write**, so what they change is part of the same undo
  step: one undo restores the stage *and* the approval.
- **Hooks never run during undo or redo.** Those replay the recorded result;
  running the hook again would record a new change, or compute a different value.
- `beforeChange` runs right after the value is set, `afterChange` after the
  model's `changed` event.

### One user action: `batch()`

Writes compose on their own when one triggers the others (hooks, `afterChange`
subscribers). For a user action made of independent writes, such as a modal's
Save writing five fields, wrap them in `batch`:

```ts
tracker.batch(() => {
  task.title = form.title;
  task.owner = form.owner;
  task.due = form.due;
  task.labels.reset(form.labels);
});
```

- **One undo step**, one `changed` on the tracker (when the batch ends), and one
  thing to save: one updated object, or one event.
- **What the writes cascade into** (hooks, `afterChange` subscribers) is part of
  the same step.
- **A `batch` inside another** joins the outer one.
- **If the action throws,** everything it wrote is reverted and the error
  propagates.
- **Undo and redo are off** while the action runs, and its first write never
  coalesces into the step before it.

### Events you can subscribe to

| On | Event | Fires | Typical use |
|---|---|---|---|
| model | `beforeChange` / `afterChange` | user writes only, never undo or redo | the same as the hooks, as subscriptions |
| model | `changed` | every change, undo and redo included | refreshing a view |
| collection | `afterChange` | user mutations only | cascading writes |
| collection | `changed` | every change, undo and redo included | refreshing a view |
| tracker | `changed` | an operation was recorded, undone, redone or discarded (once per `batch`) | re-rendering; autosave |
| tracker | `isDirtyChanged`, `isValidChanged`, `canCommitChanged`, `canUndoChanged`, `canRedoChanged`, `isSavingChanged` | the value flipped | enabling buttons, showing a spinner |

When one change flips several flags, every flag is updated before the first of
these events fires: a handler always reads a consistent state.

Don't write to the model from a `changed` subscriber: during undo and redo those
writes would not be recorded.

### Collections

```ts
readonly lines = new TrackedCollection<Line>(tracker, [], (lines) => (lines.length === 0 ? "Add a line" : undefined));
```

A tracked collection behaves like an array: `push`, `splice`, `remove`,
`replace`, `pop`, `shift`, `unshift`, `clear`, `reset`, `fill`, `copyWithin`,
`sort`, `reverse`, index access (`items[0]`, and `items[0] = x` to replace), and
every read-only array method. Each mutation is one undoable step.

- **`collection`** is the items as a plain array, replaced by a new array on
  every change. Bind to it wherever a view compares by reference: Angular
  `OnPush` inputs, signals, a table's data source.
- **Adding a model** to a collection makes it part of the model; removing it takes
  it out (and out of `tracker.isValid`).
- **`sort()` and `reverse()`** are undoable steps too, but order is not something
  chronicle saves: the items keep their state, and no event is produced.
- **`reset(items)`** makes `items` the content, in one undoable step. Only what
  changed counts: items in both keep their state, those that left are removed and
  those that arrived are added. If only the order differs, it is a reordering;
  if nothing differs, nothing is recorded.

### Containers

A container is a model that owns other models and collections:
`EntityContainer` (unit of work) or `TrackedContainer` (event log).

```ts
class Invoice extends EntityContainer {
  readonly lines = new TrackedCollection<Line>(this.tracker, []);
  constructor(tracker: UnitOfWork) { super(tracker); this.trackChild(this.lines); }
}
```

`trackChild(child)` makes the container's validity include the child (an object,
or a collection and all its items). Removing the container from the model takes
the whole subtree with it; undo brings it back. On an event log, what a container
tracks belongs to it: its changes go into the container's event, a collection
under its name, an object under the name given with it (`trackChild(object, name)`).

### Undo, redo and the history

```ts
tracker.undo(); tracker.redo();
tracker.canUndo; tracker.canRedo;
tracker.undoable;   // undo steps, oldest first
tracker.redoable;   // redo steps, next first: [...undoable, ...redoable] is the whole history
```

Each history entry is read-only:

| Member | Meaning |
|---|---|
| `isCommitted` | the server matches this step as it stands: applied (in `undoable`) or reverted (in `redoable`) |
| `isSaving` | the save in progress will change `isCommitted` |
| `events` | event log only: the events the step produced |

An entry that is not committed means there is something to save. `tracker.isDirty`
says the same for the whole model, and `canCommit` (`isDirty && isValid`) is what
a Save button should follow.

`canUndo` is true when there is a step to undo and that step is not being saved
(and no `batch` is running); `canRedo` likewise. A save therefore turns `canUndo`
off while it runs, unless edits were made meanwhile, and back on when it ends:
`canUndoChanged` / `canRedoChanged` report it. `version` and `changed` don't move
then (nothing in the model changed), so a view must listen to those events too:

```ts
// React
const subscribe = (onChange: () => void) => {
  const offs = [tracker.changed, tracker.canUndoChanged, tracker.canRedoChanged].map((e) => e.subscribe(onChange));
  return () => offs.forEach((off) => off());
};
const canUndo = useSyncExternalStore(subscribe, () => tracker.canUndo);
```

### Saving

Both flavours save with `commit(save)`: `save` receives what to persist, and
returns the ids the server assigned.

- **Commits run one after another.** Calling `commit` while a save is running
  queues the next one.
- **If `save` throws**, nothing is committed and the error propagates.
- **Edits made while `save` runs stay pending** for the next commit. Undo stops at
  the steps being saved until the save completes.
- **`isSaving` / `isSavingChanged`** tell the UI a save is in progress.

**Autosave** is a subscription to `changed`:

```ts
tracker.changed.subscribe(() => {
  if (tracker.canCommit) tracker.commit(save);
});
```

`discardPendingChanges()` reverts what has not been saved.

### Loading data into an existing model

Writes inside `withTrackingSuppressed` are not recorded: nothing to undo, nothing
to save. For a UnitOfWork, objects added inside it are what the server has
(removing them later deletes them), and objects removed inside it are forgotten.

```ts
tracker.withTrackingSuppressed(() => {
  invoice.lines.push(...loadedLines);
});
```

### Identity: `@Id` and `@AutoId`

```ts
@Id code: string = "";                  // assigned by the application
@AutoId id: number | null = null;       // assigned by the server when the object is saved
```

Items of an event-log collection must have one (or several `@Id`s: a composite
identity), since events refer to them by it. When the server assigns an `@AutoId`, the save function returns it as
`{ chronicleId, value }` and chronicle writes it into the object.

---

## Development

This repository is an npm workspace with the three packages:

```bash
npm install
npm test          # typecheck (sources and tests) + vitest
npm run build     # builds packages/*/dist
```

- The packages are released together, at the same version, with
  [Changesets](.changeset/README.md): `npx changeset` records a change.
- `test/Architecture.test.ts` keeps the packages apart: core imports nothing
  else, and each flavour imports only `@chronicle/core`.
- `test/types/pairing.ts` is the compile-time contract: every misuse listed
  there must be a type error.

## License

MIT

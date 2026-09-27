# @katn30/chronicle-event-log

An **event log** for TypeScript models: every change is recorded as an event,
with undo/redo and validation, and `commit` sends what the server does not have
yet. For event-sourced backends, and for backends that merge change sets into
what they already store.

```bash
npm install @katn30/chronicle-event-log
```

Requires TypeScript 5 or later, with `experimentalDecorators` **not** set
(chronicle uses the standard decorators). Everything is imported from this
package; `@katn30/chronicle-core` is installed with it.

The shared concepts (models, `construct()` / `new()`, validation, hooks and
events, containers, undo/redo and the history) are described in the
[main README](https://github.com/Katn30/chronicle#concepts-shared-by-both-flavours).
This page covers what is specific to an event log.

---

## A model

```ts
import { EventLog, TrackedObject, TrackedContainer, EventTracked, EventTrackedCollection, AutoId } from "@katn30/chronicle-event-log";

class Task extends TrackedObject {
  @AutoId id: number | null = null;
  @EventTracked((_self, title: string) => (title === "" ? "The title is required" : undefined))
  accessor title: string = "";
  @EventTracked() accessor done: boolean = false;
  constructor(tracker: EventLog, title = "") { super(tracker); this.title = title; }
}

class Issue extends TrackedContainer {
  @AutoId id: number | null = null;
  @EventTracked() accessor state: string = "draft";
  @EventTracked() accessor title: string = "";
  readonly tasks = new EventTrackedCollection<Task>(this.tracker, "tasks");
  readonly labels = new EventTrackedCollection<string>(this.tracker, "labels");
  constructor(tracker: EventLog) {
    super(tracker);
    this.trackChild(this.tasks);     // the collections belong to the issue:
    this.trackChild(this.labels);    // their changes are part of the issue's event
  }
}
```

- **Properties** use `@EventTracked` (same arguments as `@Tracked`, plus event
  options). A plain `@Tracked` property would produce no events, so it does not
  compile on an event-log model; a `@Tracked` getter is fine.
- **Collections** are `EventTrackedCollection`s. The second argument, `name`, is
  the collection's key in the payload.
- **Items of a collection need an identity** (`@Id` or `@AutoId`): events refer to
  them by it.

Loading what the server has, with `construct()`, records nothing:

```ts
const log = new EventLog();
const issue = log.construct(() => {
  const i = new Issue(log);
  i.id = 42;
  i.title = "Printer broken";
  i.tasks.push(taskFromRow(row1), taskFromRow(row2));
  i.labels.push("hardware");
  return i;
});
```

---

## What an event looks like

The model's **roots** are the objects that are not inside a collection (here the
issue), and the collections that no container owns. A commit sends **one event per
changed root**, with everything that changed in it:

```ts
issue.state = "fixing";
issue.tasks.collection[0].done = true;                 // task 1
issue.tasks.remove(issue.tasks.collection[1]);         // task 2
issue.tasks.push(log.new(() => new Task(log, "Replace drum")));
issue.labels.push("urgent");

await log.commit(save);
```

`save` receives:

```json
{
  "events": [
    {
      "targetId": 42,
      "chronicleId": 1,
      "payload": {
        "state": "fixing",
        "tasks": {
          "added": [{ "chronicleId": 4, "id": null, "title": "Replace drum", "done": false }],
          "removed": [2],
          "changed": [{ "id": 1, "done": true }]
        },
        "labels": { "added": ["urgent"], "removed": [] }
      }
    }
  ]
}
```

- **`targetId`** is the root's identity: its `@Id` / `@AutoId` value, or an object
  for a composite identity. It is absent while the server has not assigned the
  root's `@AutoId` yet.
- **`chronicleId`** identifies the root locally, even before it has an id.
- **Fields:** each changed field with its current value. A field holding a model
  is sent as that model's snapshot: its identity and its fields.
- **A collection** of models: `added` (full snapshots), `removed` (identities) and
  `changed` (identity plus the changed fields). A collection of plain values:
  `added` and `removed`.
- **Nested collections:** a collection owned by an item nests into that item's
  entry, at any depth, e.g. `tasks.changed[0].checks.changed[…]`.

### Ids the server assigns

A new object with an `@AutoId` is sent with `"id": null` and its `chronicleId`.
Everything that refers to it before its id is known (a removal, a change, a
reference from another object) uses `{ "chronicleId": 4 }` in its place. The save
function returns the new ids, and chronicle writes them into the objects and into
the events not sent yet:

```ts
await log.commit(async (batch) => {
  const response = await api.saveEvents(batch.events);
  return response.ids;           // [{ chronicleId: 4, value: 3 }]
});
```

---

## New objects: `new()`

An object created with `new()` is nothing to save until it is used. Right after
`new()`, `isDirty` is still `false`. When it is first changed, or added to a
collection, its creation is sent: its **whole state**, the constructor's defaults
included.

```ts
const draft = log.new(() => new Issue(log));    // nothing pending
draft.title = "New issue";                       // now pending: its creation
```

```json
{ "chronicleId": 5, "payload": { "chronicleId": 5, "id": null, "state": "draft", "title": "New issue", "tasks": [], "labels": [] } }
```

- **Undoing that first change** leaves nothing to save again.
- **Only the first pending event of a new object carries its creation.** Later
  changes are normal change events.
- **Once its creation is committed,** the object is like any other.

---

## Saving: `commit(save, { mode })`

| `mode` | Sends |
|---|---|
| `"collapsed"` (default) | one event per changed root: the net effect of everything pending |
| `"operations"` | one event per operation, in the order they happened |

- **Commits run one after another.** A batch is built only once the previous
  save's ids are in, so it never refers to an object whose id is still coming.
- **If `save` throws,** nothing is committed and the error propagates.
- **Edits made while `save` runs stay pending** for the next commit. What is being
  saved cannot be undone, redone or merged into until the save completes.
- **`commit` resolves to `false`** when nothing was pending. Changes that cancel
  out (an item added and removed again) are committed without calling `save`.

### Autosave

```ts
log.changed.subscribe(() => {
  if (log.canCommit) log.commit(save);
});
```

---

## Undo after a save: compensations

A committed event cannot be taken back. Undoing a step that was already saved
records a new event with the previous values, a *compensation*:

```ts
issue.labels.push("urgent");
await log.commit(save);     // sends labels.added ["urgent"]
log.undo();                 // pending: labels.removed ["urgent"]
```

- **If it is saved,** redo then re-applies the change with a new event.
- **If you redo before saving,** the compensation is simply withdrawn: nothing is
  sent.
- **Undoing a step that was never sent** withdraws its events: nothing is sent.

The history shows where each step stands: `log.undoable` / `log.redoable` entries
have `isCommitted`, `isSaving` and `events` (what the step did).

---

## Shaping the payload

### `history`: every change instead of the last value

```ts
@EventTracked(undefined, undefined, { history: true }) accessor note: string = "";
```

```json
"note": [{ "property": "note", "value": "first" }, { "property": "note", "value": "second" }]
```

On a collection, `history: true` sends the list of operations instead of
`added` / `removed` / `changed`:

```json
"queue": { "ops": [
  { "op": "add", "item": { "chronicleId": 7, "id": null, "title": "Q", "done": false } },
  { "op": "change", "chronicleId": 7, "title": "Q2", "done": false },
  { "op": "remove", "chronicleId": 7 }
] }
```

### `toPayload`: what a property or an item puts in the event

On a property, `toPayload(self, newValue, oldValue)` builds its value in the event,
for example with who changed it and when:

```ts
class Issue extends TrackedContainer {
  constructor(tracker: EventLog, private readonly user: string) { super(tracker); }

  @EventTracked(undefined, undefined, {
    toPayload: (self: Issue, state: string) => ({ state, by: self.user, at: new Date().toISOString() }),
  })
  accessor state: string = "draft";
}
```

```json
"state": { "state": "fixing", "by": "u7", "at": "2026-09-26T10:00:00.000Z" }
```

On a collection, `toPayload(item, op)` returns extra fields that are added to each
item's entry (`op` is `"add"`, `"remove"` or `"change"`):

```ts
new EventTrackedCollection<string>(tracker, "tags", [], undefined, {
  toPayload: (_tag, op) => ({ by: user.oid, op }),
});
```

```json
"tags": { "added": [{ "value": "b", "by": "u7", "op": "add" }], "removed": [{ "value": "a", "by": "u7", "op": "remove" }] }
```

- **`toPayload` runs when the change happens** (undo and redo included), and the
  event carries the result of the latest change. An item added and then edited
  before the save keeps the fields of its addition, with its latest snapshot.
- **A property with `toPayload` always goes through it**, also in snapshots: one
  never changed (a default, a loaded value) is built when it is first sent, so
  the server always sees the property in the same shape.
- **With `toPayload` on a collection,** removed items and plain values become
  objects, so they can carry the fields: `{ "id": 42, … }`, `{ "value": "x", … }`.
- **With `history`,** each entry is `toPayload`'s result.

---

## Aggregates: parts of a container

A large object can be split into parts, each a `TrackedObject` or
`TrackedContainer` with its own fields, validators and collections. Track each
part with a name, and the whole aggregate is still **one event**:

```ts
class Issue extends TrackedContainer {
  @Id id = "i1";
  readonly main: Main;
  readonly analysis: Analysis;
  readonly comments = new EventTrackedCollection<Comment>(this.tracker, "comments");
  constructor(tracker: EventLog) {
    super(tracker);
    this.main = tracker.construct(() => new Main(tracker));
    this.analysis = tracker.construct(() => new Analysis(tracker));
    this.trackChild(this.main, "main");
    this.trackChild(this.analysis, "analysis");
    this.trackChild(this.comments);
  }
}

issue.main.title = "hello";
issue.analysis.summary = "ok";
```

```json
{ "targetId": "i1", "chronicleId": 1, "payload": { "main": { "title": "hello" }, "analysis": { "summary": "ok" } } }
```

- **A part sends only what changed in it**; an untouched part adds nothing.
- **Parts nest at any depth**, and can own collections and parts of their own.
  The parts of an item inside a collection go into that item's entry.
- **A new aggregate's creation** includes every part's full state.
- **Undo, compensations, `history` and `toPayload`** work as for the container's
  own fields: everything is one event on the aggregate.
- **A part has one owner.** `untrackChild(part)` ends the ownership, and the
  object is a root again.
- A part needs no `@Id`: its name in the payload is enough.

## Collections: owners and roots

- **A collection belongs to the container that tracks it** (`trackChild`): its
  changes go into the container's event under the collection's name. A collection
  has one owner.
- **A collection no container tracks is a root:** its event is
  `{ "payload": { "<name>": { … } } }`, without `targetId`.
- **`reset(items)`** reports the net difference: the items that left in
  `removed`, those that arrived in `added` (with `history: true`, one op for each).
  Items in both are not reported.
- **An item edited while out of its collection** sends nothing for those edits;
  if it is put back, they are part of what is sent.
- **The same object in two collections** is reported by each: an edit to it
  appears in the events of both collections. An item normally lives in one
  collection. Moving it (removing it from one, adding it to another) reports the
  removal and the addition.

---

## Other operations

- **`tracker.batch(action)`** makes its writes one step: one event per root
  (the container's fields, collections and parts together), and one
  compensation if it is undone after the save.
- **`discardPendingChanges()`** reverts what was not sent: unsent steps are
  undone, pending compensations withdrawn, and the redo history dropped.
- **`model.destroy()`** forgets an object for good and withdraws its unsent
  events. It is for objects that never became part of the model. To delete an
  item, remove it from its collection.

---

## Reference

What this package adds to the [shared API](https://github.com/Katn30/chronicle#concepts-shared-by-both-flavours):

| Export | Members |
|---|---|
| `EventLog` | `commit(save, { mode })`; `undoable` / `redoable` entries with `events`; everything every tracker has (`batch`, `undo`, …) |
| `TrackedObject` | the model base class |
| `TrackedContainer` | `TrackedObject`, plus the protected `trackChild(collection)`, `trackChild(object, name)` and `untrackChild(child)` |
| `@EventTracked(validator?, hooks?, { coalesceWithin?, history?, toPayload? })` | a property whose changes are events |
| `EventTrackedCollection(tracker, name, items?, validator?, { history?, toPayload? })` | a collection whose changes are events |
| `GeneratedEvent` | `{ payload, targetId?, chronicleId? }` |
| `CommitBatch` | `{ events }`: what `save` receives |
| `SaveFunction<V>` | `(batch) => ids`, sync or async; `V` is the id type (`number` by default) |
| `CommitMode`, `CommitOptions`, `EventEntry`, `EventTrackedOptions`, `EventTrackedCollectionOptions`, `PropertyToPayload`, `CollectionToPayload`, `CollectionOpKind` | types |

## License

MIT

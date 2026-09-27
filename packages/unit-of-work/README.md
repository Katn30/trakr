# @katn30/chronicle-unit-of-work

A **Unit of Work** for TypeScript models: chronicle tracks which objects are new,
changed or removed, with undo/redo and validation, and saves them together with
one call.

```bash
npm install @katn30/chronicle-unit-of-work
```

Requires TypeScript 5 or later, with `experimentalDecorators` **not** set
(chronicle uses the standard decorators). Everything is imported from this
package; `@katn30/chronicle-core` is installed with it.

The shared concepts (models, `construct()` / `new()`, `@Tracked`, validation,
hooks and events, collections, containers, undo/redo and the history) are
described in the [main README](https://github.com/Katn30/chronicle#concepts-shared-by-both-flavours).
This page covers what is specific to a unit of work.

---

## A model

```ts
import { UnitOfWork, Entity, EntityContainer, TrackedCollection, Tracked, AutoId } from "@katn30/chronicle-unit-of-work";

class Line extends Entity {
  @AutoId id: number | null = null;
  @Tracked((_self, qty: number) => (qty <= 0 ? "At least 1" : undefined))
  accessor qty: number = 1;
  @Tracked() accessor product: string = "";
  constructor(tracker: UnitOfWork, product = "") { super(tracker); this.product = product; }
}

class Invoice extends EntityContainer {
  @AutoId id: number | null = null;
  @Tracked() accessor customer: string = "";
  readonly lines = new TrackedCollection<Line>(this.tracker, []);
  constructor(tracker: UnitOfWork) {
    super(tracker);
    this.trackChild(this.lines);    // the invoice's validity and dirtiness include its lines
  }
}
```

Loading what the server has:

```ts
const tracker = new UnitOfWork();
const invoice = tracker.construct(() => {
  const inv = new Invoice(tracker);
  inv.id = row.id;
  inv.customer = row.customer;
  inv.lines.push(...row.lines.map((l) => {
    const line = new Line(tracker, l.product);
    line.id = l.id;
    line.qty = l.qty;
    return line;
  }));
  return inv;
});
```

Everything written inside `construct()` is the saved state: nothing is pending.

---

## Object state

Every model has a `chronicleState`: what the next save has to do with it.

| State | Meaning | Becomes it when |
|---|---|---|
| `Unchanged` | nothing to save | loaded, or saved |
| `Insert` | new: to be inserted | added to a collection (or assigned to a tracked property) while `Unchanged` and not saved yet |
| `Changed` | to be updated | one of its tracked properties is written |
| `Deleted` | to be deleted | removed from its collection (or its property cleared) |

```ts
const line = tracker.new(() => new Line(tracker, "Pen"));
line.chronicleState;          // Unchanged: nothing to save yet
invoice.lines.push(line);
line.chronicleState;          // Insert

invoice.customer = "ACME";
invoice.chronicleState;       // Changed

invoice.lines.remove(invoice.lines[0]);
// the removed line is Deleted
```

- **Removing a new (`Insert`) object** simply forgets it: the server never had it.
- **Putting a removed object back**, in the same collection or in another one,
  makes it `Changed`: the server still has it, and its place in the model changed.
- **Undo restores the state**: undoing the push makes the line `Unchanged` again.
- **An object lives in one collection at a time.** If the same object is in two
  collections and is removed from one of them, it becomes `Deleted`, and the next
  commit deletes it, even though the other collection still shows it. To move an
  object, remove it from one collection and add it to the other.
- **`collection.reset(items)`** leaves the items in both untouched: only those
  that left become `Deleted` (or are forgotten, if new), and those that arrived
  `Insert` (or `Changed`, if they were removed before).
- **`tracker.batch(action)`** makes several writes one step: one undo, and each
  object it touched is saved once.
- **Undo and redo cross saves.** Undoing a saved addition makes the object
  `Deleted`, undoing a saved removal makes it `Insert`, and redoing them brings it
  back to `Unchanged`.
- `dirtyCounter` is the net number of unsaved writes, adding and removing
  included (+1 per write, −1 per undo); a save resets it. `isDirty` is true while
  the object has unsaved writes. A container's `isDirty` also covers its
  children.

---

## Saving: `commit(save)`

```ts
await tracker.commit(async ({ inserted, changed, deleted }) => {
  const response = await api.save({
    inserted: inserted.map(toDto),
    changed: changed.map(toDto),
    deleted: deleted.map((obj) => obj.id),
  });
  return response.ids;       // [{ chronicleId, value }] for the inserted objects
});
```

`save` receives the objects to insert, update and delete, and returns the ids the
server assigned, as `{ chronicleId, value }` pairs. Send each new object's
`chronicleId` with it, so the server can echo it back next to the new id.

When the returned promise resolves:
- every object is `Unchanged` and `tracker.isDirty` is `false`;
- the returned ids are written into the objects' `@AutoId` fields.

`commit` resolves to `false` when there was nothing to save. Changes that cancel
out (a new line added and removed again) are committed without calling `save`.

### While a save runs

- **Edits made meanwhile stay pending** for the next commit. The objects they
  touch stay `Changed` (or `Insert`) after the save completes.
- **Undo stops at the changes being saved** until the save completes: they cannot
  be undone halfway through being written. `canUndoChanged` reports when undo
  goes off and comes back.
- **Commits run one after another**: a second `commit` waits for the first.
- **If `save` throws** (or its promise rejects), nothing is committed and the
  error propagates. Everything stays pending.
- `tracker.isSaving` is `true` meanwhile, and the history entries being saved
  have `isSaving: true`.

### Undo after a save

Undo crosses commits. Undoing a saved change makes the object dirty again, so the
next commit saves the reversal:

```ts
invoice.customer = "ACME";
await tracker.commit(save);   // saved
tracker.undo();               // customer is back to its previous value
invoice.chronicleState;       // Changed: the next commit saves the old value
```

What the next commit does depends on the step undone:

| Undone step (already saved) | The object becomes |
|---|---|
| an edit | `Changed`: the server gets the previous values |
| the step that added it | `Deleted`: the server has it, the model no longer does |
| the step that removed it | `Insert`: the server deleted it, the model has it again |

Redoing a step brings the object back to what was saved (`Unchanged`, or
`Changed` if it was edited since).

### Tables that version their rows

Some databases never update a row in place: an update closes the current row and
inserts a new one, with a new id. Return a `{ chronicleId, value }` pair for those
`changed` objects too, and chronicle writes the new id into their `@AutoId`, so the
next save refers to the current row.

---

## Autosave

```ts
tracker.changed.subscribe(() => {
  if (tracker.canCommit) tracker.commit(save);
});
```

`changed` fires once an operation is recorded, undone or redone. Commits queue
themselves, so edits made while a save runs are sent by the next one.

---

## Discarding

`tracker.discardPendingChanges()` goes back to the saved state and clears the
undo/redo history: it undoes what was not saved, and redoes saved steps that
were undone. While a save runs, what it is saving is kept.

If a saved step was undone and then replaced by a new edit, the saved state can
no longer be reached: discard reverts what it can, and the tracker stays dirty,
so the next commit saves the difference.

---

## Reference

What this package adds to the [shared API](https://github.com/Katn30/chronicle#concepts-shared-by-both-flavours):

| Export | Members |
|---|---|
| `UnitOfWork` | `commit(save)`, and everything every tracker has (`batch`, `undo`, …) |
| `Entity` | `chronicleState`, `dirtyCounter`, `isDirty` |
| `EntityContainer` | `Entity`, plus the protected `trackChild(child)` / `untrackChild(child)` |
| `State` | `Unchanged`, `Insert`, `Changed`, `Deleted` |
| `CommitBatch` | `{ inserted, changed, deleted }`: what `save` receives |
| `SaveFunction<V>` | `(batch) => ids`, sync or async; `V` is the id type (`number` by default) |

## License

MIT

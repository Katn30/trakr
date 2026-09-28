# @katn30/chronicle-event-log

## 1.0.1

### Patch Changes

- Undo, redo, discard and rollback (a failed write or `batch`) now revalidate only what depends on what they changed, as a write does, instead of running every validator: an undo costs as much as the write it reverts.

  Fixes:
  - An object taken out of the model by discard (or by undoing its addition together with an edit) kept the validity of the reverted edit; put back in the model, it counted as valid when it was not.
  - A validator on a `@Tracked` setter did not run again when the property was written (only on undo and redo); it now runs on every write.

- Updated dependencies
  - @katn30/chronicle-core@1.0.1

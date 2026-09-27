/**
 * One undo step, as the application sees it: read-only. Entries are listed by
 * `tracker.undoable` (applied) and `tracker.redoable` (undone).
 */
export interface HistoryEntry {
  /**
   * The server matches this step as it stands now: applied if the entry is in
   * `undoable`, reverted if it is in `redoable`.
   */
  readonly isCommitted: boolean;
  /** The save in progress will change `isCommitted`. */
  readonly isSaving: boolean;
}

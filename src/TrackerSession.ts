import type { TrackedObjectBase } from "./TrackedObjectBase";
import { ITrackerContext } from "./ITrackerContext";
import { TypedEvent } from "./TypedEvent";

export type PropertyScope = [TrackedObjectBase, string[]];

interface ITrackerDelegate {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): void;
  redo(): void;
  readonly isDirtyChanged: TypedEvent<boolean>;
  readonly canCommitChanged: TypedEvent<boolean>;
  readonly versionChanged: TypedEvent<number>;
}

export class TrackerSession implements ITrackerContext {
  private readonly _scope: Map<TrackedObjectBase, Set<string>> | undefined;
  private _isDirty: boolean = false;

  constructor(
    scope: PropertyScope[] | undefined,
    private readonly _tracker: ITrackerDelegate,
    private readonly _end: () => void,
    private readonly _rollback: () => void,
  ) {
    if (scope && scope.length > 0) {
      this._scope = new Map(scope.map(([obj, props]) => [obj, new Set(props)]));
    }
  }

  /** @internal */
  _onWrite(obj: TrackedObjectBase, property: string): void {
    if (this._scope === undefined) return;
    const declaredProps = this._scope.get(obj);
    if (declaredProps === undefined || !declaredProps.has(property)) return;
    this._isDirty = true;
  }

  get isDirty(): boolean {
    if (this._scope === undefined) return false;
    return this._isDirty;
  }

  get isValid(): boolean {
    if (this._scope === undefined) return true;
    for (const [obj, props] of this._scope) {
      for (const prop of props) {
        if (obj.validationMessages.has(prop)) return false;
      }
    }
    return true;
  }

  get canCommit(): boolean {
    return this.isDirty && this.isValid;
  }

  get canUndo(): boolean {
    return this._tracker.canUndo;
  }

  get canRedo(): boolean {
    return this._tracker.canRedo;
  }

  get trackedObjects(): TrackedObjectBase[] {
    if (this._scope === undefined) return [];
    return [...this._scope.keys()];
  }

  undo(): void {
    this._tracker.undo();
  }

  redo(): void {
    this._tracker.redo();
  }

  get isDirtyChanged(): TypedEvent<boolean> {
    return this._tracker.isDirtyChanged;
  }

  get canCommitChanged(): TypedEvent<boolean> {
    return this._tracker.canCommitChanged;
  }

  get versionChanged(): TypedEvent<number> {
    return this._tracker.versionChanged;
  }

  end(): void {
    this._end();
  }

  rollback(): void {
    this._rollback();
  }
}

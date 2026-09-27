import type { TrackedObjectBase } from "./TrackedObjectBase";
import type { ITracked } from "./ITracked";
import { ITrackerContext } from "./ITrackerContext";
import { TypedEvent } from "./TypedEvent";

export type PropertyScope<TModel extends TrackedObjectBase = TrackedObjectBase> = [TModel, string[]];

interface ITrackerDelegate {
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  undo(): void;
  redo(): void;
  readonly isDirtyChanged: TypedEvent<boolean>;
  readonly canCommitChanged: TypedEvent<boolean>;
  readonly changed: TypedEvent<{ version: number }>;
}

export class TrackerSession<TModel extends TrackedObjectBase = TrackedObjectBase> implements ITrackerContext {
  private readonly _scope: Map<ITracked, Set<string>> | undefined;
  private readonly _models: TModel[];
  private _isDirty: boolean = false;

  constructor(
    scope: PropertyScope<TModel>[] | undefined,
    private readonly _tracker: ITrackerDelegate,
    private readonly _end: () => void,
    private readonly _rollback: () => void,
  ) {
    this._models = (scope ?? []).map(([obj]) => obj);
    if (scope && scope.length > 0) {
      this._scope = new Map(scope.map(([obj, props]) => [obj, new Set(props)]));
    }
  }

  /** @internal */
  _onWrite(obj: ITracked, property: string): void {
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
    for (const model of this._models) {
      for (const prop of this._scope.get(model)!) {
        if (model.validationMessages.has(prop)) return false;
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

  get trackedObjects(): TModel[] {
    return [...this._models];
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

  get changed(): TypedEvent<{ version: number }> {
    return this._tracker.changed;
  }

  end(): void {
    this._end();
  }

  rollback(): void {
    this._rollback();
  }
}

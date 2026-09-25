import { Change } from "./Change";
import { OperationProperties } from "./OperationProperties";

export class Operation {
  public readonly time: Date = new Date();
  public readonly actions: Change[] = [];
  private _hasActions: boolean = false;
  public get hasActions(): boolean {
    return this._hasActions;
  }
  private set hasActions(value: boolean) {
    this._hasActions = value;
  }

  public add(
    redoAction: () => void,
    undoAction: () => void,
    properties: OperationProperties,
  ): void {
    const action = new Change(
      this.actions.length,
      redoAction,
      undoAction,
      properties,
    );
    this.actions.push(action);
    this.hasActions = true;
  }

  public updateOrAdd(
    redoAction: () => void,
    undoAction: () => void,
    properties: OperationProperties,
  ): void {
    const idx = this.actions.findLastIndex(
      (c) =>
        c.properties.trackedObject === properties.trackedObject &&
        c.properties.property === properties.property,
    );
    if (idx >= 0) {
      this.actions[idx] = new Change(this.actions[idx].number, redoAction, undoAction, properties);
    } else {
      this.add(redoAction, undoAction, properties);
    }
  }

  /**
   * Chains an effect onto the most recent action targeting the same object and
   * property, so it runs right after that action on both undo and redo. The
   * caller guarantees such an action exists.
   */
  public attachAfter(
    properties: OperationProperties,
    redoEffect: () => void,
    undoEffect: () => void,
  ): void {
    const idx = this.actions.findLastIndex(
      (c) =>
        c.properties.trackedObject === properties.trackedObject &&
        c.properties.property === properties.property,
    );
    const target = this.actions[idx];
    this.actions[idx] = new Change(
      target.number,
      () => { target.redoAction(); redoEffect(); },
      () => { target.undoAction(); undoEffect(); },
      target.properties,
    );
  }

  public redo(): void {
    this.actions.reverse().forEach((x) => x.redoAction());
  }

  public undo(): void {
    this.actions.reverse().forEach((x) => x.undoAction());
  }
}

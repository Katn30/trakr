import { TrackedObject } from "./TrackedObject";
import { TrackedCollection } from "./TrackedCollection";

export abstract class TrackedContainer extends TrackedObject {
  private _children: Array<TrackedObject | TrackedCollection<unknown>> = [];

  protected trackChild(child: TrackedObject | TrackedCollection<unknown>): void {
    this._children.push(child);
  }

  override get isValid(): boolean {
    return super.isValid && this._children.every(c => c.isValid);
  }

  override set isValid(value: boolean) {
    this._setIsValid(value);
  }

  override get isDirty(): boolean {
    return super.isDirty || this._children.some(c => c.isDirty);
  }
}

import { Tracker } from "./Tracker";
import { State } from "./State";

export interface ITracked {
  tracker: Tracker;
  isDirty: boolean;
  dirtyCounter: number;
  trakrState: State;

  /** @internal */
  _setState(value: State): void;
  /** @internal */
  _validate(property: string, errorMessage: string | undefined): void;
  /** @internal */
  _applyValidation(messages: Map<string, string>): void;
  destroy(): void;
}

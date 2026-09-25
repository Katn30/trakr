import type { Tracker } from "./Tracker";

export interface ITracked {
  tracker: Tracker;

  /** @internal */
  _validate(property: string, errorMessage: string | undefined): void;
  /** @internal */
  _applyValidation(messages: Map<string, string>): void;
  destroy(): void;
}

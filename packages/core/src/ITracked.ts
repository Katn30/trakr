import type { Tracker } from "./Tracker";

export interface ITracked {
  tracker: Tracker;

  /** @internal */
  _validate(property: string, errorMessage: string | undefined): void;
  /** @internal */
  _applyValidation(messages: Map<string, string>): void;
  /**
   * @internal After a write to it (`property`, or `undefined` for a collection's
   * items): re-run the validation that belongs to it as a whole.
   */
  _revalidateSelf(property: string | undefined): void;
  destroy(): void;
}

import { TrackedObject } from "./TrackedObject";
import { trackedImplementation } from "@chronicle/core";
import type { ChangeHooks, PropertyValidator } from "@chronicle/core";
import {
  registerEventProperty,
  ensureEventStateSubscription,
  PropertyToPayload,
} from "./EventRegistry";

export interface EventTrackedOptions<TSelf = TrackedObject, TValue = unknown> {
  coalesceWithin?: number;
  /** Send every change of the property (a list), not only its latest value. */
  history?: boolean;
  /** Builds what the property puts in the event; see {@link PropertyToPayload}. */
  toPayload?: PropertyToPayload<TSelf, TValue>;
}

type MemberContext<T, V> =
  | ClassAccessorDecoratorContext<T, V>
  | ClassSetterDecoratorContext<T, V>
  | ClassGetterDecoratorContext<T, V>;

/** A tracked property of an EventLog model: its changes are events. */
export function EventTracked<TSelf extends TrackedObject = TrackedObject, TValue = unknown>(
  validator?: PropertyValidator<TSelf, TValue>,
  hooks?: ChangeHooks<TSelf, TValue>,
  options?: EventTrackedOptions<TSelf, TValue>,
) {
  const tracked = trackedImplementation(validator, hooks, { coalesceWithin: options?.coalesceWithin });

  function decorator<T extends TSelf, V extends TValue>(
    target: ClassAccessorDecoratorTarget<T, V>,
    context: ClassAccessorDecoratorContext<T, V>,
  ): ClassAccessorDecoratorResult<T, V>;
  function decorator<T extends TSelf, V extends TValue>(
    target: (this: T, value: V) => void,
    context: ClassSetterDecoratorContext<T, V>,
  ): (this: T, value: V) => void;
  function decorator<T extends TSelf, V extends TValue>(
    target: (this: T) => V,
    context: ClassGetterDecoratorContext<T, V>,
  ): (this: T) => V;
  function decorator<T extends TSelf, V extends TValue>(target: unknown, context: MemberContext<T, V>): unknown {
    const result = tracked(target, context);
    // A getter is derived: it takes part in validation, not in events (toPayload can add it).
    if (context.kind === "getter") return result;
    const propertyName = String(context.name);

    context.addInitializer(function (this: T) {
      registerEventProperty(Object.getPrototypeOf(this), propertyName, {
        history: options?.history,
        coalesceWithin: options?.coalesceWithin,
        toPayload: options?.toPayload,
      });
      ensureEventStateSubscription(this);
    });

    return result;
  }

  return decorator;
}

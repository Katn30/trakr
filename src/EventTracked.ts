import { TrackedObject } from "./TrackedObject";
import { Tracked } from "./Tracked";
import {
  registerEventProperty,
  ensureEventStateSubscription,
  HistoryConfig,
} from "./EventRegistry";

export interface EventTrackedOptions {
  coalesceWithin?: number;
  eventType?: string;
  history?: HistoryConfig;
}

export function EventTracked(
  validator?: (self: any, newValue: any) => string | undefined,
  onChange?: (self: any, newValue: any, oldValue: any) => void,
  options?: EventTrackedOptions,
) {
  const trackedDecorator = Tracked(validator, onChange, {
    coalesceWithin: options?.coalesceWithin,
  });

  function decorator<T extends TrackedObject, V>(
    target: ClassAccessorDecoratorTarget<T, V>,
    context: ClassAccessorDecoratorContext<T, V>,
  ): ClassAccessorDecoratorResult<T, V>;
  function decorator<T extends TrackedObject, V>(
    target: (this: T, value: V) => void,
    context: ClassSetterDecoratorContext<T, V>,
  ): (this: T, value: V) => void;
  function decorator<T extends TrackedObject, V>(
    target: (this: T) => V,
    context: ClassGetterDecoratorContext<T, V>,
  ): (this: T) => V;
  function decorator(target: any, context: any): any {
    const result = (trackedDecorator as any)(target, context);
    const propertyName = String(context.name);

    context.addInitializer(function (this: TrackedObject) {
      registerEventProperty(Object.getPrototypeOf(this), propertyName, {
        eventType: options?.eventType,
        history: options?.history,
        coalesceWithin: options?.coalesceWithin,
      });
      ensureEventStateSubscription(this);
    });

    return result;
  }

  return decorator;
}

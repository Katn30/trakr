import { TrackedObject } from "./TrackedObject";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { ITracked } from "./ITracked";
import { State } from "./State";
import { registerPropertyValidator } from "./Registry";
import { DependencyTracker } from "./DependencyTracker";

export type ChangeHook<TSelf = any, TValue = any> = (
  self: TSelf,
  newValue: TValue,
  oldValue: TValue,
) => void;

export interface ChangeHooks<TSelf = any, TValue = any> {
  beforeChange?: ChangeHook<TSelf, TValue>;
  afterChange?: ChangeHook<TSelf, TValue>;
}

let legacyOnChangeWarned = false;

function normalizeHooks(
  hooks: ChangeHooks | ChangeHook | undefined,
): { before?: ChangeHook; after?: ChangeHook } {
  if (!hooks) return {};
  if (typeof hooks === "function") {
    if (!legacyOnChangeWarned) {
      legacyOnChangeWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[trakr] @Tracked/@EventTracked: passing a bare onChange function is deprecated. " +
          "Use `{ beforeChange, afterChange }` instead. The bare function is mapped to `beforeChange`.",
      );
    }
    return { before: hooks };
  }
  return { before: hooks.beforeChange, after: hooks.afterChange };
}

export function Tracked(
  validator?: (self: any, newValue: any) => string | undefined,
  hooks?: ChangeHooks | ChangeHook,
  options?: { coalesceWithin?: number },
) {
  const { before: beforeHook, after: afterHook } = normalizeHooks(hooks);

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
  function decorator(
    target: any,
    context: any,
  ): any {
    const propertyName = String(context.name);

    if (context.kind === "getter") {
      const getterFn = target as (this: any) => any;
      return function (this: any): any {
        DependencyTracker.record(this, propertyName);
        return getterFn.call(this);
      };
    }

    if (context.kind === "accessor") {
      const accessorTarget = target as ClassAccessorDecoratorTarget<any, any>;

      if (validator) {
        context.addInitializer(function (this: unknown) {
          registerPropertyValidator(
            Object.getPrototypeOf(this),
            propertyName,
            (model: any) => validator(model, (model as any)[propertyName]),
          );
        });
      }

      return {
        get(this: any): any {
          DependencyTracker.record(this, propertyName);
          return accessorTarget.get.call(this);
        },
        set(this: any, newValue: any) {
          const oldValue = accessorTarget.get.call(this);

          if (isSameValue(oldValue, newValue)) {
            return;
          }

          if (!this.tracker || this.tracker._isTrackingSuppressed) {
            accessorTarget.set.call(this, newValue);
            return;
          }

          const properties = new OperationProperties(
            this,
            propertyName,
            getPropertyType(newValue, oldValue),
            validator ? (model: any, v: any) => validator(model, v) : undefined,
            options?.coalesceWithin,
          );

          this.tracker._doAndTrack(
            () => {
              accessorTarget.set.call(this, newValue);
              const tracked = this as unknown as ITracked;
              tracked.dirtyCounter++;
              if (tracked.trakrState === State.Unchanged) tracked._setState(State.Changed);
              if (oldValue instanceof TrackedObject) oldValue._markRemoved();
              if (newValue instanceof TrackedObject) newValue._markAdded();
              const event = { property: propertyName, oldValue, newValue };
              if (!this.tracker._isReplaying && beforeHook) {
                beforeHook(this, newValue, oldValue);
              }
              this.beforeChange.emit(event);
              this.afterChange.emit(event);
              if (!this.tracker._isReplaying) {
                this.trackedChanged.emit(event);
              }
              if (!this.tracker._isReplaying && afterHook) {
                afterHook(this, newValue, oldValue);
              }
            },
            () => {
              accessorTarget.set.call(this, oldValue);
              const tracked = this as unknown as ITracked;
              tracked.dirtyCounter--;
              if (tracked.dirtyCounter === 0 && tracked.trakrState === State.Changed) tracked._setState(State.Unchanged);
              const event = { property: propertyName, oldValue: newValue, newValue: oldValue };
              this.beforeChange.emit(event);
              this.afterChange.emit(event);
            },
            properties,
          );
        },
      };
    } else {
      const setterFn = target as (this: any, value: any) => void;

      if (validator) {
        context.addInitializer(function (this: unknown) {
          registerPropertyValidator(
            Object.getPrototypeOf(this),
            propertyName,
            (model: any) => validator(model, (model as any)[propertyName]),
          );
        });
      }

      return function (this: any, newValue: any): void {
        const oldValue = (this as any)[propertyName];

        if (isSameValue(oldValue, newValue)) {
          return;
        }

        if (!this.tracker || this.tracker._isTrackingSuppressed) {
          setterFn.call(this, newValue);
          return;
        }

        const properties = new OperationProperties(
          this,
          propertyName,
          getPropertyType(newValue, oldValue),
          validator ? (model: any, v: any) => validator(model, v) : undefined,
          options?.coalesceWithin,
        );

        this.tracker._doAndTrack(
          () => {
            setterFn.call(this, newValue);
            const tracked = this as unknown as ITracked;
            tracked.dirtyCounter++;
            if (tracked.trakrState === State.Unchanged) tracked._setState(State.Changed);
            if (oldValue instanceof TrackedObject) oldValue._markRemoved();
            if (newValue instanceof TrackedObject) newValue._markAdded();
            const event = { property: propertyName, oldValue, newValue };
            if (!this.tracker._isReplaying && beforeHook) {
              beforeHook(this, newValue, oldValue);
            }
            this.beforeChange.emit(event);
            this.afterChange.emit(event);
            if (!this.tracker._isReplaying) {
              this.trackedChanged.emit(event);
            }
            if (!this.tracker._isReplaying && afterHook) {
              afterHook(this, newValue, oldValue);
            }
          },
          () => {
            setterFn.call(this, oldValue);
            const tracked = this as unknown as ITracked;
            tracked.dirtyCounter--;
            if (tracked.dirtyCounter === 0 && tracked.trakrState === State.Changed) tracked._setState(State.Unchanged);
            const event = { property: propertyName, oldValue: newValue, newValue: oldValue };
            this.beforeChange.emit(event);
            this.afterChange.emit(event);
          },
          properties,
        );
      };
    }
  }

  return decorator;
}

function isSameValue(value1: any, value2: any): boolean {
  return value1 === value2;
}

function getPropertyType(newValue: any, oldValue: any): PropertyType {
  const v = newValue ?? oldValue;
  if (v instanceof Date) return PropertyType.Date;
  switch (typeof v) {
    case "string":
      return PropertyType.String;
    case "boolean":
      return PropertyType.Boolean;
    case "number":
      return PropertyType.Number;
    case "object":
      return PropertyType.Object;
    default:
      throw new Error(`Property type '${typeof v}' not supported`);
  }
}

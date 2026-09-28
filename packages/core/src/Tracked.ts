import { TrackedObjectBase } from "./TrackedObjectBase";
import { OperationProperties } from "./OperationProperties";
import { PropertyType } from "./PropertyType";
import { registerPropertyValidator } from "./Registry";
import { DependencyTracker } from "./DependencyTracker";
import { readProperty } from "./Properties";

export type ChangeHook<TSelf = TrackedObjectBase, TValue = unknown> = (
  self: TSelf,
  newValue: TValue,
  oldValue: TValue,
) => void;

/**
 * Callbacks run inside the write that triggered them, so whatever they change
 * is composed into the same undo step. They run on user writes only — never
 * during undo or redo, which replay the recorded result instead.
 */
export interface ChangeHooks<TSelf = TrackedObjectBase, TValue = unknown> {
  /** Runs right after the value is set, before the model's `changed` event. */
  beforeChange?: ChangeHook<TSelf, TValue>;
  /** Runs after the model's `changed` event. */
  afterChange?: ChangeHook<TSelf, TValue>;
}

/** Validates a property: returns the error message, or `undefined` if the value is valid. */
export type PropertyValidator<TSelf = TrackedObjectBase, TValue = unknown> = (self: TSelf, value: TValue) => string | undefined;

export interface TrackedOptions {
  /** Consecutive writes within this many milliseconds form one undo step. */
  coalesceWithin?: number;
}

/** Models of an EventLog (branded `_eventLogModel`) use `@EventTracked` instead. */
type PlainModel = TrackedObjectBase & { readonly _eventLogModel?: never };

/** The member kinds `@Tracked` decorates. */
type MemberContext<T, V> =
  | ClassAccessorDecoratorContext<T, V>
  | ClassSetterDecoratorContext<T, V>
  | ClassGetterDecoratorContext<T, V>;

/**
 * A tracked property on a UnitOfWork model (a getter: a value validators may
 * depend on). EventLog models use `@EventTracked`.
 */
export function Tracked<TSelf extends TrackedObjectBase = TrackedObjectBase, TValue = unknown>(
  validator?: PropertyValidator<TSelf, TValue>,
  hooks?: ChangeHooks<TSelf, TValue>,
  options?: TrackedOptions,
) {
  const implementation = trackedImplementation(validator, hooks, options);
  function decorator<T extends TSelf & PlainModel, V extends TValue>(
    target: ClassAccessorDecoratorTarget<T, V>,
    context: ClassAccessorDecoratorContext<T, V>,
  ): ClassAccessorDecoratorResult<T, V>;
  function decorator<T extends TSelf & PlainModel, V extends TValue>(
    target: (this: T, value: V) => void,
    context: ClassSetterDecoratorContext<T, V>,
  ): (this: T, value: V) => void;
  function decorator<T extends TSelf, V extends TValue>(
    target: (this: T) => V,
    context: ClassGetterDecoratorContext<T, V>,
  ): (this: T) => V;
  function decorator<T extends TSelf, V extends TValue>(target: unknown, context: MemberContext<T, V>): unknown {
    return implementation(target, context);
  }
  return decorator;
}

/**
 * @internal What `@Tracked` does to a member; `@EventTracked` wraps it. Returns
 * the replacement member for the decorated one.
 */
export function trackedImplementation<TSelf extends TrackedObjectBase, TValue>(
  validator: PropertyValidator<TSelf, TValue> | undefined,
  hooks: ChangeHooks<TSelf, TValue> | undefined,
  options: TrackedOptions | undefined,
) {
  return function <T extends TSelf, V extends TValue>(target: unknown, context: MemberContext<T, V>): unknown {
    const propertyName = String(context.name);

    if (context.kind === "getter" && isGetter(target, context)) {
      if (validator) {
        context.addInitializer(function (this: T) {
          // A derived value can be validated too: the validator re-runs when what the getter reads changes.
          registerPropertyValidator(Object.getPrototypeOf(this), propertyName, (model: T) => validator(model, context.access.get(model)));
        });
      }
      return function (this: T): V {
        DependencyTracker.record(this, propertyName);
        return target.call(this);
      };
    }

    if (context.kind === "accessor" && isAccessor(target, context)) {
      if (validator) {
        context.addInitializer(function (this: T) {
          // Read through the property itself, so the validator depends on it.
          registerPropertyValidator(Object.getPrototypeOf(this), propertyName, (model: T) => validator(model, context.access.get(model)));
        });
      }
      const accessor: ClassAccessorDecoratorResult<T, V> = {
        get(this: T): V {
          DependencyTracker.record(this, propertyName);
          return target.get.call(this);
        },
        set(this: T, newValue: V) {
          const oldValue = target.get.call(this);
          if (oldValue === newValue) return;
          recordWrite(this, propertyName, oldValue, newValue, (v) => target.set.call(this, v), hooks, options?.coalesceWithin);
        },
      };
      return accessor;
    }

    // Neither a getter nor an accessor: a setter.
    assertSetter(target, context);
    if (validator) {
      context.addInitializer(function (this: T) {
        registerPropertyValidator(Object.getPrototypeOf(this), propertyName, (model: T) => {
          // The value is read through the class's own getter, which is not tracked: depend on the property explicitly.
          DependencyTracker.record(model, propertyName);
          return validator(model, readSetterProperty<V>(model, propertyName));
        });
      });
    }
    return function (this: T, newValue: V): void {
      const oldValue = readSetterProperty<V>(this, propertyName);
      if (oldValue === newValue) return;
      recordWrite(this, propertyName, oldValue, newValue, (v) => target.call(this, v), hooks, options?.coalesceWithin);
    };
  };
}

// TypeScript types a decorator's target and context separately: it cannot narrow
// one from the other's `kind`. These guards state the correspondence once.
function isGetter<T, V>(target: unknown, context: MemberContext<T, V>): target is (this: T) => V {
  return context.kind === "getter";
}
function isAccessor<T, V>(target: unknown, context: MemberContext<T, V>): target is ClassAccessorDecoratorTarget<T, V> {
  return context.kind === "accessor";
}
function assertSetter<T, V>(target: unknown, _context: MemberContext<T, V>): asserts target is (this: T, value: V) => void {}

/**
 * The current value of a setter-decorated property. A setter decorator has no
 * getter to call, so the value is read by name; it is the property the setter
 * writes, so it has the setter's value type.
 */
function readSetterProperty<V>(model: object, name: string): V {
  return readProperty(model, name) as V;
}

/**
 * Writes `newValue` as one tracked action. On a user write: set, `beforeChange`
 * (hook, then event), `changed`, `afterChange` (event, then hook). On undo and
 * redo only the value and `changed`: the hooks' own writes were recorded in the
 * same operation and are replayed with it.
 */
function recordWrite<T extends TrackedObjectBase, V>(
  self: T,
  property: string,
  oldValue: V,
  newValue: V,
  write: (value: V) => void,
  hooks: ChangeHooks<T, V> | undefined,
  coalesceWithin: number | undefined,
): void {
  const tracker = self.tracker;
  if (tracker._isTrackingSuppressed) {
    write(newValue);
    return;
  }

  tracker._doAndTrack(
    () => {
      self._onTrackedWrite();
      write(newValue);
      // A value that is a model enters or leaves the model with it.
      if (oldValue instanceof TrackedObjectBase) oldValue._markRemoved();
      if (newValue instanceof TrackedObjectBase) newValue._markAdded();
      const event = { property, oldValue, newValue };
      const userWrite = !tracker._isReplaying;
      if (userWrite) {
        hooks?.beforeChange?.(self, newValue, oldValue);
        self.beforeChange._emit(event);
      }
      self.changed._emit(event);
      if (userWrite) {
        self.afterChange._emit(event);
        hooks?.afterChange?.(self, newValue, oldValue);
      }
    },
    () => {
      write(oldValue);
      self._onTrackedWriteUndone();
      self.changed._emit({ property, oldValue: newValue, newValue: oldValue });
    },
    new OperationProperties(self, property, getPropertyType(newValue, oldValue), coalesceWithin),
  );
}

function getPropertyType(newValue: unknown, oldValue: unknown): PropertyType {
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

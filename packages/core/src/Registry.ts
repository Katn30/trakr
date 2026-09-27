import { ITracked as ITrackedItem } from "./ITracked";
import { DependencyTracker } from "./DependencyTracker";
import { ClassMetadata } from "./Properties";

// Method syntax: a validator written for a specific model class can be stored here.
interface ValidatorOf {
  check(model: ITrackedItem): string | undefined;
}
type Validator = ValidatorOf["check"];

const validators = new ClassMetadata<Map<string, Validator>>(() => new Map());

/** Every validator of `proto`'s class and its bases; a subclass's wins for the same property. */
function inheritedValidators(proto: object): Map<string, Validator> {
  const merged = new Map<string, Validator>();
  for (const own of validators.chain(proto)) {
    own.forEach((validator, property) => {
      if (!merged.has(property)) merged.set(property, validator);
    });
  }
  return merged;
}

export function registerPropertyValidator(proto: object, property: string, validator: Validator): void {
  const own = validators.own(proto);
  if (!own.has(property)) own.set(property, validator);
}

export function validate(tracked: ITrackedItem): void {
  const all = inheritedValidators(Object.getPrototypeOf(tracked));
  if (all.size === 0) return;
  const messages = new Map<string, string>();
  all.forEach((validatorFn, property) => {
    const deps = DependencyTracker.collect(() => {
      const error = validatorFn(tracked);
      if (error !== undefined) messages.set(property, error);
    });
    DependencyTracker.updateDeps(tracked, property, deps);
  });
  tracked._applyValidation(messages);
}

export function validateSingleProperty(tracked: ITrackedItem, property: string): string | undefined {
  const validatorFn = inheritedValidators(Object.getPrototypeOf(tracked)).get(property);
  if (!validatorFn) return undefined;
  let error: string | undefined;
  const deps = DependencyTracker.collect(() => {
    error = validatorFn(tracked);
  });
  DependencyTracker.updateDeps(tracked, property, deps);
  return error;
}

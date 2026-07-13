import { ITracked as ITrackedItem } from "./ITracked";
import { DependencyTracker } from "./DependencyTracker";

type ValidatorMap = Map<string, (model: any) => string | undefined>;
const VALIDATORS = Symbol("validators");

function hasOwnValidators(proto: object): boolean {
  return Object.prototype.hasOwnProperty.call(proto, VALIDATORS);
}

function ownValidators(proto: object): ValidatorMap | undefined {
  return hasOwnValidators(proto) ? ((proto as any)[VALIDATORS] as ValidatorMap) : undefined;
}

function mergeInheritedValidators(proto: object): ValidatorMap {
  const merged: ValidatorMap = new Map();
  let current: object | null = proto;
  while (current) {
    const own = ownValidators(current);
    if (own) {
      own.forEach((validator, property) => {
        if (!merged.has(property)) merged.set(property, validator);
      });
    }
    current = Object.getPrototypeOf(current);
  }
  return merged;
}

function findInheritedValidator(
  proto: object,
  property: string,
): ((model: any) => string | undefined) | undefined {
  let current: object | null = proto;
  while (current) {
    const own = ownValidators(current);
    const validator = own?.get(property);
    if (validator) return validator;
    current = Object.getPrototypeOf(current);
  }
  return undefined;
}

export function registerPropertyValidator(
  proto: object,
  property: string,
  validator: (model: any) => string | undefined,
): void {
  if (!hasOwnValidators(proto)) {
    Object.defineProperty(proto, VALIDATORS, {
      value: new Map<string, (model: any) => string | undefined>(),
      configurable: true,
    });
  }
  const map = (proto as any)[VALIDATORS] as ValidatorMap;
  if (!map.has(property)) {
    map.set(property, validator);
  }
}

export function validate(tracked: ITrackedItem): void {
  const proto = Object.getPrototypeOf(tracked);
  const validators = mergeInheritedValidators(proto);
  if (validators.size === 0) return;
  const messages = new Map<string, string>();
  validators.forEach((validatorFn, property) => {
    const deps = DependencyTracker.collect(() => {
      const error = validatorFn(tracked);
      if (error !== undefined) messages.set(property, error);
    });
    DependencyTracker.updateDeps(tracked, property, deps);
  });
  tracked._applyValidation(messages);
}

export function validateSingleProperty(
  tracked: ITrackedItem,
  property: string,
): string | undefined {
  const proto = Object.getPrototypeOf(tracked);
  const validatorFn = findInheritedValidator(proto, property);
  if (!validatorFn) return undefined;
  let error: string | undefined;
  const deps = DependencyTracker.collect(() => {
    error = validatorFn(tracked);
  });
  DependencyTracker.updateDeps(tracked, property, deps);
  return error;
}

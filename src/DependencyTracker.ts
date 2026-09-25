import { ITracked } from "./ITracked";

export type DepMap = Map<object, Set<string>>;

// Special property key used to represent "any structural change" in a TrackedCollection.
export const COLLECTION_VERSION_KEY = "__version__";

/** One validator: `prop`'s validator on `obj`. Interned, so it can live in Sets. */
interface Dependent {
  obj: ITracked;
  prop: string;
}

let collector: DepMap | null = null;

// Forward: validatedObj → validatorProp → DepMap (what the validator read)
const forwardDeps = new WeakMap<object, Map<string, DepMap>>();

// Reverse: depObj → depProp → the validators that read it
const reverseDeps = new Map<object, Map<string, Set<Dependent>>>();

// validatedObj → validatorProp → its interned Dependent
const dependents = new WeakMap<object, Map<string, Dependent>>();

interface MapLike<K, V> {
  get(key: K): V | undefined;
  set(key: K, value: V): unknown;
}

function getOrCreate<K, V>(map: MapLike<K, V>, key: K, create: () => V): V {
  let value = map.get(key);
  if (value === undefined) {
    value = create();
    map.set(key, value);
  }
  return value;
}

function dependentFor(obj: ITracked, prop: string): Dependent {
  const byProp = getOrCreate(dependents, obj, () => new Map<string, Dependent>());
  return getOrCreate(byProp, prop, () => ({ obj, prop }));
}

/** The validators that read `depObj.depProp` (an empty set is created on first use). */
function readersOf(depObj: object, depProp: string): Set<Dependent> {
  const byProp = getOrCreate(reverseDeps, depObj, () => new Map<string, Set<Dependent>>());
  return getOrCreate(byProp, depProp, () => new Set<Dependent>());
}

function forEachDep(deps: DepMap, fn: (depObj: object, prop: string) => void): void {
  deps.forEach((props, depObj) => props.forEach((prop) => fn(depObj, prop)));
}

export const DependencyTracker = {
  record(object: object, property: string): void {
    if (!collector) return;
    getOrCreate(collector, object, () => new Set<string>()).add(property);
  },

  collect(fn: () => void): DepMap {
    collector = new Map<object, Set<string>>();
    fn();
    const deps = collector;
    collector = null;
    return deps;
  },

  updateDeps(validatedObj: ITracked, validatorProp: string, newDeps: DepMap): void {
    const dependent = dependentFor(validatedObj, validatorProp);
    const forward = getOrCreate(forwardDeps, validatedObj, () => new Map<string, DepMap>());
    forEachDep(forward.get(validatorProp) ?? new Map(), (depObj, prop) => readersOf(depObj, prop).delete(dependent));
    forward.set(validatorProp, newDeps);
    forEachDep(newDeps, (depObj, prop) => readersOf(depObj, prop).add(dependent));
  },

  getDependents(depObj: object, depProp: string): Array<{ obj: ITracked; prop: string }> {
    return [...readersOf(depObj, depProp)];
  },

  clearDeps(validatedObj: ITracked): void {
    (forwardDeps.get(validatedObj) ?? new Map<string, DepMap>()).forEach((deps, validatorProp) => {
      const dependent = dependentFor(validatedObj, validatorProp);
      forEachDep(deps, (depObj, prop) => readersOf(depObj, prop).delete(dependent));
    });
    forwardDeps.delete(validatedObj);
  },
};

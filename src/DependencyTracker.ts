import { ITracked } from "./ITracked";

export type DepMap = Map<object, Set<string>>;

// Special property key used to represent "any structural change" in a TrackedCollection.
export const COLLECTION_VERSION_KEY = "__version__";

let collector: DepMap | null = null;

// Forward: validatedObj → validatorProp → DepMap (what the validator read)
const forwardDeps = new WeakMap<object, Map<string, DepMap>>();

// Reverse: depObj → depProp → [{validatedObj, validatorProp}]
const reverseDeps = new Map<
  object,
  Map<string, Array<{ obj: ITracked; prop: string }>>
>();

export const DependencyTracker = {
  record(object: object, property: string): void {
    if (!collector) return;
    let props = collector.get(object);
    if (!props) {
      props = new Set<string>();
      collector.set(object, props);
    }
    props.add(property);
  },

  collect(fn: () => void): DepMap {
    collector = new Map<object, Set<string>>();
    fn();
    const deps = collector;
    collector = null;
    return deps;
  },

  updateDeps(validatedObj: ITracked, validatorProp: string, newDeps: DepMap): void {
    // Remove old reverse entries for this validator
    const objForward = forwardDeps.get(validatedObj);
    const oldDeps = objForward?.get(validatorProp);
    if (oldDeps) {
      oldDeps.forEach((props, depObj) => {
        const propMap = reverseDeps.get(depObj);
        if (!propMap) return;
        props.forEach((prop) => {
          const list = propMap.get(prop);
          if (!list) return;
          const idx = list.findIndex(
            (x) => x.obj === validatedObj && x.prop === validatorProp,
          );
          if (idx >= 0) list.splice(idx, 1);
        });
      });
    }

    // Store new forward deps
    let fwd = forwardDeps.get(validatedObj);
    if (!fwd) {
      fwd = new Map<string, DepMap>();
      forwardDeps.set(validatedObj, fwd);
    }
    fwd.set(validatorProp, newDeps);

    // Add new reverse entries
    newDeps.forEach((props, depObj) => {
      let propMap = reverseDeps.get(depObj);
      if (!propMap) {
        propMap = new Map<string, Array<{ obj: ITracked; prop: string }>>();
        reverseDeps.set(depObj, propMap);
      }
      props.forEach((prop) => {
        let list = propMap!.get(prop);
        if (!list) {
          list = [];
          propMap!.set(prop, list);
        }
        if (!list.some((x) => x.obj === validatedObj && x.prop === validatorProp)) {
          list.push({ obj: validatedObj, prop: validatorProp });
        }
      });
    });
  },

  getDependents(
    depObj: object,
    depProp: string,
  ): Array<{ obj: ITracked; prop: string }> {
    return reverseDeps.get(depObj)?.get(depProp) ?? [];
  },

  clearDeps(validatedObj: ITracked): void {
    const objForward = forwardDeps.get(validatedObj);
    if (!objForward) return;
    objForward.forEach((depMap) => {
      depMap.forEach((props, depObj) => {
        const propMap = reverseDeps.get(depObj);
        if (!propMap) return;
        props.forEach((prop) => {
          const list = propMap.get(prop);
          if (!list) return;
          const idx = list.findIndex((x) => x.obj === validatedObj);
          if (idx >= 0) list.splice(idx, 1);
        });
      });
    });
    forwardDeps.delete(validatedObj);
  },
};

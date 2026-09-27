import { ClassMetadata, readProperty } from "./Properties";

export interface IdAssignment<V = number> {
  chronicleId: number;
  value: V;
}

interface IdentityMeta {
  autoId?: string;
  ids: string[];
}

const identity = new ClassMetadata<IdentityMeta>(() => ({ ids: [] }));

export function AutoId<This extends object, Value>(
  _target: undefined,
  context: ClassFieldDecoratorContext<This, Value>,
): void {
  context.addInitializer(function (this: This) {
    const meta = identity.own(Object.getPrototypeOf(this));
    meta.autoId ??= String(context.name);
    addIdentityProp(meta, String(context.name));
  });
}

export function Id<This extends object, Value>(
  _target: undefined,
  context: ClassFieldDecoratorContext<This, Value>,
): void {
  context.addInitializer(function (this: This) {
    addIdentityProp(identity.own(Object.getPrototypeOf(this)), String(context.name));
  });
}

function addIdentityProp(meta: IdentityMeta, propertyName: string): void {
  if (!meta.ids.includes(propertyName)) meta.ids.push(propertyName);
}

export function getAutoIdProperty(proto: object): string | undefined {
  return identity.chain(proto).find((meta) => meta.autoId !== undefined)?.autoId;
}

export function getIdentityProperties(proto: object): string[] {
  const merged: string[] = [];
  // Base classes first.
  for (const meta of identity.chain(proto).reverse()) {
    for (const name of meta.ids) {
      if (!merged.includes(name)) merged.push(name);
    }
  }
  return merged;
}

export function getIdentity(obj: object): unknown {
  const props = getIdentityProperties(Object.getPrototypeOf(obj));
  if (props.length === 0) return undefined;
  if (props.length === 1) return readProperty(obj, props[0]);
  return getIdentityObject(obj);
}

export function getIdentityObject(obj: object): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const p of getIdentityProperties(Object.getPrototypeOf(obj))) result[p] = readProperty(obj, p);
  return result;
}

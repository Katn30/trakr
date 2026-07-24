export interface IdAssignment {
  trackingId: number;
  value: number;
}

const AUTO_ID = Symbol("autoId");
const ID_PROPS = Symbol("idProps");

export function AutoId<This extends object, Value>(
  _target: undefined,
  context: ClassFieldDecoratorContext<This, Value>,
): void {
  context.addInitializer(function (this: This) {
    const proto = Object.getPrototypeOf(this);
    if (!Object.prototype.hasOwnProperty.call(proto, AUTO_ID)) {
      Object.defineProperty(proto, AUTO_ID, {
        value: String(context.name),
        configurable: true,
      });
    }
    addIdentityProp(proto, String(context.name));
  });
}

export function Id<This extends object, Value>(
  _target: undefined,
  context: ClassFieldDecoratorContext<This, Value>,
): void {
  context.addInitializer(function (this: This) {
    const proto = Object.getPrototypeOf(this);
    addIdentityProp(proto, String(context.name));
  });
}

function addIdentityProp(proto: object, propertyName: string): void {
  if (!Object.prototype.hasOwnProperty.call(proto, ID_PROPS)) {
    Object.defineProperty(proto, ID_PROPS, {
      value: [] as string[],
      configurable: true,
      writable: true,
    });
  }
  const list = (proto as any)[ID_PROPS] as string[];
  if (!list.includes(propertyName)) list.push(propertyName);
}

export function getAutoIdProperty(proto: object): string | undefined {
  return AUTO_ID in proto ? ((proto as any)[AUTO_ID] as string) : undefined;
}

export function getIdentityProperties(proto: object): string[] {
  const chain: object[] = [];
  let current: object | null = proto;
  while (current) {
    chain.push(current);
    current = Object.getPrototypeOf(current);
  }
  const merged: string[] = [];
  for (let i = chain.length - 1; i >= 0; i--) {
    const proto = chain[i];
    if (!Object.prototype.hasOwnProperty.call(proto, ID_PROPS)) continue;
    const list = (proto as any)[ID_PROPS] as string[];
    for (const name of list) {
      if (!merged.includes(name)) merged.push(name);
    }
  }
  return merged;
}

export function getIdentity(obj: object): unknown {
  const props = getIdentityProperties(Object.getPrototypeOf(obj));
  if (props.length === 0) return undefined;
  if (props.length === 1) {
    return (obj as Record<string, unknown>)[props[0]];
  }
  const result: Record<string, unknown> = {};
  for (const p of props) result[p] = (obj as Record<string, unknown>)[p];
  return result;
}

export function getIdentityObject(obj: object): Record<string, unknown> {
  const props = getIdentityProperties(Object.getPrototypeOf(obj));
  const result: Record<string, unknown> = {};
  for (const p of props) result[p] = (obj as Record<string, unknown>)[p];
  return result;
}

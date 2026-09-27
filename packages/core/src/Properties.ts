/**
 * Decorated properties are known by name at run time: these read and write
 * them. `Reflect` keeps the access typed (`unknown` in, `unknown` out).
 * @internal
 */
export function readProperty(target: object, name: string): unknown {
  return Reflect.get(target, name);
}

/** @internal */
export function writeProperty(target: object, name: string, value: unknown): void {
  Reflect.set(target, name, value);
}

/**
 * Per-class metadata registered by decorators, looked up along the prototype
 * chain (a subclass sees what its bases registered).
 * @internal
 */
export class ClassMetadata<T> {
  private readonly _own = new WeakMap<object, T>();

  constructor(private readonly _create: () => T) {}

  /** The metadata registered on `proto` itself, created on first use. */
  own(proto: object): T {
    let value = this._own.get(proto);
    if (value === undefined) {
      value = this._create();
      this._own.set(proto, value);
    }
    return value;
  }

  /** The metadata of `proto` and its bases, most derived first. */
  chain(proto: object): T[] {
    const found: T[] = [];
    for (let current: object | null = proto; current; current = Object.getPrototypeOf(current)) {
      const value = this._own.get(current);
      if (value !== undefined) found.push(value);
    }
    return found;
  }
}

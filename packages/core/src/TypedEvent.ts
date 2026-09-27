/**
 * A handler, declared with method syntax so that `TypedEvent<Derived>` can be
 * used where a `TypedEvent<Base>` is expected (e.g. a collection of `Task`s as a
 * collection of models).
 */
interface Handler<T> {
  handle(event: T): void;
}
export type EventHandler<T> = Handler<T>["handle"];

/** A typed event: subscribe to be notified; only chronicle emits it. */
export class TypedEvent<T> {
  private readonly _handlers: EventHandler<T>[] = [];

  public subscribe(handler: EventHandler<T>): () => void {
    this._handlers.push(handler);
    return () => this.unsubscribe(handler);
  }

  public unsubscribe(handler: EventHandler<T>): void {
    const index = this._handlers.indexOf(handler);
    if (index >= 0) {
      this._handlers.splice(index, 1);
    }
  }

  /** @internal */
  public _emit(event: T): void {
    // A snapshot: handlers that (un)subscribe while the event fires do not disturb the others.
    for (const handler of [...this._handlers]) handler(event);
  }
}

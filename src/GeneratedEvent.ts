export interface GeneratedEvent<
  TEventType extends string = string,
  TPayload = Record<string, unknown>,
> {
  eventType: TEventType;
  payload: TPayload;
  trackingId?: number;
  targetId?: unknown;
}

export interface EventLifecycleOptions<TEventType extends string = string> {
  itemAdded?: TEventType;
  itemRemoved?: TEventType;
}

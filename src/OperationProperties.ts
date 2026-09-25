import { ITracked } from "./ITracked";
import { PropertyType } from "./PropertyType";

export class OperationProperties {
  constructor(
    public readonly trackedObject: ITracked,
    public readonly property: string | undefined,
    public readonly type: PropertyType,
    public readonly coalesceWithin?: number,
  ) {}
}
import { OperationProperties } from "./OperationProperties";

export class Change {
  public readonly time: Date = new Date();

  constructor(
    public readonly number: number,
    public readonly redoAction: () => void,
    public readonly undoAction: () => void,
    public readonly properties: OperationProperties,
  ) {}
}

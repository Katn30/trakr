export class CollectionUtilities {
  public static getLast<T>(array: T[]): T | undefined {
    return array.length > 0 ? array[array.length - 1] : undefined;
  }
}

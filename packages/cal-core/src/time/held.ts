/**
 * A memory with a ceiling: it holds no more entries than it is told, and at the ceiling the one used
 * longest ago goes first. What is remembered under a name a stranger wrote is remembered in one of
 * these (`limits` has the ceilings), so that no text can make a memory grow for as long as it is
 * asked about.
 */
export interface Held<V> {
  /** The value held under the key, which is then the last to go; `undefined` when none is. */
  get(key: string): V | undefined;
  /** Hold the value under the key, as the last to go. At the ceiling the entry used longest ago goes first. */
  set(key: string, value: V): void;
}

export function heldUpTo<V>(ceiling: number): Held<V> {
  // A map keeps the order its entries were put in: the first is the one used longest ago.
  const held = new Map<string, V>();
  return {
    get(key) {
      const value = held.get(key);
      if (value !== undefined) {
        held.delete(key);
        held.set(key, value);
      }
      return value;
    },
    set(key, value) {
      held.delete(key);
      if (held.size >= ceiling) for (const oldest of held.keys()) {
        held.delete(oldest);
        break;
      }
      held.set(key, value);
    },
  };
}

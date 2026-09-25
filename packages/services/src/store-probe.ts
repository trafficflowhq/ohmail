/** How long a "no" about the store is believed before it is asked again. */
export const STORE_PROBE_RETRY_MS = 60_000;

/**
 * A YES/NO FACT ABOUT THE STORE, memoised per handle: a yes holds for the handle's life, a no — or
 * a probe that failed — is asked again after {@link STORE_PROBE_RETRY_MS}. A pooled handle lives as
 * long as its server instance, so a remembered no would hide an extension installed meanwhile
 * until the instance is recycled. Callers asking while a probe is in flight share its answer.
 */
export function storeProbe(
  opts: { retryMs?: number; now?: () => number } = {},
): (key: object, ask: () => Promise<boolean>) => Promise<boolean> {
  const retryMs = opts.retryMs ?? STORE_PROBE_RETRY_MS;
  const now = opts.now ?? Date.now;
  const held = new WeakMap<object, { answer: Promise<boolean>; until: number }>();
  return (key, ask) => {
    const known = held.get(key);
    if (known && known.until > now()) return known.answer;
    let answer: Promise<boolean>;
    try {
      answer = ask().then(Boolean, () => false);
    } catch {
      // A probe that throws before it asks answers no, like one that fails: asked again later.
      answer = Promise.resolve(false);
    }
    const entry = { answer, until: Number.POSITIVE_INFINITY };
    held.set(key, entry);
    void answer.then((yes) => { if (!yes) entry.until = now() + retryMs; });
    return answer;
  };
}

import type { Translator } from "./translator.js";

/**
 * A table of English sentences as a live view of one catalogue namespace. The returned object has
 * the table's shape: each string member is a getter over the translator, each function member
 * formats the same message. A getter is read on every access, so the same object answers English
 * while no translator is there and the catalogue's sentence once one is, and English again for a
 * key the catalogue answers empty.
 *
 * `params` maps each function key to its arguments' names in order: an English fallback is
 * positional, its message's values are named. The fallback runs only when the translator is
 * absent or answered empty.
 */
export function liveCopyOver<T extends Record<string, unknown>>(
  translator: () => Translator | null,
  english: T,
  params: Partial<Record<keyof T, readonly string[]>> = {},
): T {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(english)) {
    const fallback = english[key];
    if (typeof fallback === "function") {
      const names = params[key as keyof T] ?? [];
      out[key] = (...values: unknown[]): string => {
        const t = translator();
        if (t === null) return (fallback as (...a: unknown[]) => string)(...values);
        const named: Record<string, unknown> = {};
        names.forEach((name, i) => {
          named[name] = values[i];
        });
        const formatted = t(key, named as Parameters<Translator>[1]);
        return formatted === "" ? (fallback as (...a: unknown[]) => string)(...values) : formatted;
      };
      continue;
    }
    Object.defineProperty(out, key, {
      enumerable: true,
      get(): unknown {
        const t = translator();
        if (t === null) return fallback;
        const formatted = t(key);
        return formatted === "" ? fallback : formatted;
      },
    });
  }
  return out as T;
}

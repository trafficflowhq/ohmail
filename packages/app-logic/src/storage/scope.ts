/**
 * WHOSE STORED KEYS A MOUNT READS AND WRITES, handed in by the mount and never looked up.
 *
 * `null` is a surface with no account, spelled `local` as the key builders always spelled it. A scope
 * nobody handed in (`undefined`) or an empty one is refused rather than read as `local`: a forgotten
 * argument must not land one account's words in the shared key space.
 */

import { useRef } from "react";

export type StorageScope = string | null;

/** The scope as a key spells it: the scope itself, or `local` for none. Throws on a missing or empty one. */
export function scopeSuffix(scope: StorageScope): string {
  if (scope === undefined) throw new Error("ohmail: a stored key was asked for with no storage scope");
  if (scope === "") throw new Error("ohmail: a stored key was asked for with an empty storage scope");
  return scope ?? "local";
}

/**
 * The scope of a hook's first render, for the life of the mount. A change of scope is a new mount: a
 * hook handed another one throws rather than move its words, locks or decisions under it.
 */
export function usePinnedScope(scope: StorageScope): StorageScope {
  scopeSuffix(scope);
  const pinned = useRef(scope);
  if (pinned.current !== scope) throw new Error("ohmail: a mounted hook was handed another storage scope");
  return pinned.current;
}

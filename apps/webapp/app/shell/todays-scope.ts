"use client";

/**
 * THE SCOPE OF THE SHELL A PART OF TODAY'S VIEWS IS DRAWN IN — the adapter's, and it leaves with the last of today's
 * views. `ShellInner` provides the scope it read from its host, once, as it mounted; the parts drawn deep inside the
 * views that keep a look per account (the search order, a letter's original look, the picture quality, the
 * after-verb choice, Settings' demo check, the Ohbox's landing) read it here instead of looking the storage owner up.
 *
 * Null where a part is drawn in no shell: such a part names no key, so it reads none and writes none. It is not a
 * scope that defaults, and `local` is never spelled for want of one. The parts that read it are a closed list, held
 * by the tools' `ohmail/owner-lookup` rule (`tools/owner-readers.json`); a place in `packages/app` reads
 * `useFrame().host.session.scope`.
 */
import { createContext, createElement, useContext, type ReactNode } from "react";

const TodaysScope = createContext<string | null>(null);

/** The shell's own mount of its scope: `ShellInner`, once, outermost. The context itself never leaves this file. */
export function TodaysScopeProvider({ value, children }: { value: string | null; children?: ReactNode }): ReactNode {
  return createElement(TodaysScope.Provider, { value }, children);
}

/** The scope of the shell this part is drawn in. Null where it is drawn in none: such a part names no key. */
export function useTodaysScope(): string | null {
  return useContext(TodaysScope);
}

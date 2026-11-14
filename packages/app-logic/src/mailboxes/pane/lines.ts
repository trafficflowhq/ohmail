"use client";

/**
 * WHAT THE PANE SAYS AT ONE PLACE: one refusal line, one outcome line, and the line that a factor landed after Cancel
 * and nothing ran. A refusal is a press's own or a read's; an outcome is no alarm.
 */
import { useCallback, useMemo, useState } from "react";
import type { Refusal } from "../connect/types.js";
import type { PaneSaid } from "./organizer.js";

/** A sentence to say: the catalogue's, or the server's own words where no key words it. */
export type PaneLine = { readonly said: PaneSaid } | { readonly server: string };

export interface Lines {
  readonly error: PaneLine | null;
  readonly notice: PaneLine | null;
  readonly nothingRan: boolean;
  /** A refused press or read: its server's sentence, or that the answer never came. */
  refused(refusal: Refusal): void;
  fail(line: PaneLine): void;
  tell(line: PaneLine): void;
  /** A factor landed after Cancel and was thrown away. */
  nothing(): void;
  /** A new press begins: what the last one said goes. */
  clear(): void;
}

/** The server's sentence of a refusal, or the pane's own when none came. */
export function lineOf(refusal: Refusal): PaneLine {
  return refusal.message !== "" ? { server: refusal.message } : { said: { key: "probe_unknown" } };
}

export function useLines(): Lines {
  const [error, setError] = useState<PaneLine | null>(null);
  const [notice, setNotice] = useState<PaneLine | null>(null);
  const [nothingRan, setNothingRan] = useState(false);
  const refused = useCallback((r: Refusal) => setError(lineOf(r)), []);
  const clear = useCallback(() => {
    setError(null);
    setNotice(null);
    setNothingRan(false);
  }, []);
  const nothing = useCallback(() => setNothingRan(true), []);
  return useMemo(
    () => ({ error, notice, nothingRan, refused, fail: setError, tell: setNotice, nothing, clear }),
    [error, notice, nothingRan, refused, nothing, clear],
  );
}

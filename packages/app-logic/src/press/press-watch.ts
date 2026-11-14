"use client";

import { useEffect, useMemo, useRef } from "react";
import type { EntityReader } from "@ohmail/client-engine";
import { retroOf } from "./press-verdict.js";

/**
 * A PRESS TOLD ONCE WHEN THE BACKLOG PASS IT WAITED ON HAS FINISHED — in memory, while the app is
 * open; the sheet's Now line is the durable reading after that. Each reader the shell renders is
 * checked against the rules a press wrote: once none is still applying, the press is handed the
 * state (`done`, or `unknown` for a rule that went or lost its stamp) and forgotten.
 */
export interface PressWatch {
  watch: (w: { ruleIds: readonly string[]; done: (state: "done" | "unknown") => void }) => void;
}

/** What the watch reads and listens to: the engine's one reader, and its change notice. */
export interface PressWatchSource {
  read(): EntityReader;
  subscribe(listener: () => void): () => void;
}

/**
 * THE WATCH LISTENS ONLY WHILE A PRESS WAITS: it subscribes to the engine's change notice while a watch stands and lets
 * go once none does, and asks each watch's rules at every change; nothing renders for it. (It once read the reader's
 * version in a render, so the seam that held it rendered at every notice of a drain, a press waiting or not.)
 */
export function usePressWatch(source: PressWatchSource): PressWatch {
  const watches = useRef(new Set<{ ruleIds: readonly string[]; done: (state: "done" | "unknown") => void }>());
  const listening = useRef<(() => void) | null>(null);
  const latest = useRef(source);
  latest.current = source;
  const letGo = (): void => {
    listening.current?.();
    listening.current = null;
  };
  useEffect(() => letGo, []);
  return useMemo(() => {
    const check = (): void => {
      const reader = latest.current.read();
      for (const w of [...watches.current]) {
        const state = retroOf(reader, w.ruleIds);
        if (state === "applying") continue;
        watches.current.delete(w);
        w.done(state);
      }
      if (watches.current.size === 0) letGo();
    };
    return {
      watch: (w) => {
        watches.current.add(w);
        if (listening.current === null) listening.current = latest.current.subscribe(check);
      },
    };
  }, []);
}

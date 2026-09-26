"use client";

import { useEffect, useMemo, useRef } from "react";
import type { EntityReader } from "@ohmail/client-engine";
import { retroOf } from "./press-verdict";

/**
 * A PRESS TOLD ONCE WHEN THE BACKLOG PASS IT WAITED ON HAS FINISHED — in memory, while the app is
 * open; the sheet's Now line is the durable reading after that. Each reader the shell renders is
 * checked against the rules a press wrote: once none is still applying, the press is handed the
 * state (`done`, or `unknown` for a rule that went or lost its stamp) and forgotten.
 */
export interface PressWatch {
  watch: (w: { ruleIds: readonly string[]; done: (state: "done" | "unknown") => void }) => void;
}

export function usePressWatch(reader: EntityReader): PressWatch {
  const watches = useRef(new Set<{ ruleIds: readonly string[]; done: (state: "done" | "unknown") => void }>());
  useEffect(() => {
    for (const w of [...watches.current]) {
      const state = retroOf(reader, w.ruleIds);
      if (state === "applying") continue;
      watches.current.delete(w);
      w.done(state);
    }
  }, [reader]);
  return useMemo(() => ({ watch: (w) => { watches.current.add(w); } }), []);
}

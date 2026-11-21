"use client";
import type { EngineMessage } from "@ohmail/wire";
import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { claimFact, senderCheckAmong, senderCheckFact, senderCheckSentence, type SenderCheckFact } from "@ohmail/app-logic/screener";

export { senderCheckFact, senderCheckSentence, type SenderCheckFact };

type Words = (key: string, values?: Record<string, string>) => string;

/** An identity line as a surface draws it: its sentence, and the `data-reason` it carries. */
export interface SenderCheckLine { reason: "identity" | "unverified" | "failed"; text: string }

/** The words, bound once per surface: the chip props a list row spreads, and the open message's line. */
export function useSenderCheckWords(): {
  row: (m: EngineMessage) => { senderCheckLabel?: string; senderCheckTitle?: string };
  line: (m: EngineMessage) => SenderCheckLine | null;
  lineAmong: (ms: readonly EngineMessage[]) => SenderCheckLine | null;
} {
  const t = useTranslations("screener");
  const words = t as unknown as Words;
  // The chip is a claim's alone: the brand's own address is never "Not {brand}".
  const row = useCallback((m: EngineMessage) => {
    const f = claimFact(m);
    return f?.reason === "impersonation"
      ? { senderCheckLabel: words("senderCheck.chip", { brand: f.brand }), senderCheckTitle: senderCheckSentence(words, f) }
      : {};
  }, [words]);
  const lineFor = useCallback((f: SenderCheckFact | null): SenderCheckLine | null => (f === null ? null : {
    reason: f.reason === "impersonation" ? "identity" : f.reason, text: senderCheckSentence(words, f),
  }), [words]);
  const line = useCallback((m: EngineMessage) => lineFor(senderCheckFact(m)), [lineFor]);
  const lineAmong = useCallback((ms: readonly EngineMessage[]) => lineFor(senderCheckAmong(ms)), [lineFor]);
  return { row, line, lineAmong };
}

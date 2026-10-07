"use client";
import { useCallback } from "react";
import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";

/**
 * THE IDENTITY FACT AS THE WEB RENDERS IT — off the mirror's copy of `MessageDTO.senderCheck`,
 * never a dictionary of the client's own. One sentence and one chip face, keyed under the
 * Screener's catalogue and read outside any AI advice: a marked message says so whether or not a
 * suggestion was ever bought for its sender.
 */
export interface SenderCheckFact {
  brand: string;
  domainShared: boolean;
  /** The address's own domain, for the shared-provider sentence. */
  domain: string;
}

export function senderCheckFact(m: Pick<EngineMessage, "senderCheck" | "from">): SenderCheckFact | null {
  const c = m.senderCheck;
  if (!c || c.reason !== "impersonation" || !c.brand) return null;
  const at = m.from.address.lastIndexOf("@");
  return { brand: c.brand, domainShared: c.domainShared === true, domain: at < 0 ? "" : m.from.address.slice(at + 1).toLowerCase() };
}

type Words = (key: string, values?: Record<string, string>) => string;

/** The sentence a fact stands for: the shared-provider form names the domain anyone can register at. */
export function senderCheckSentence(t: Words, f: SenderCheckFact): string {
  return f.domainShared
    ? t("senderCheck.impersonationShared", { brand: f.brand, domain: f.domain })
    : t("senderCheck.impersonation", { brand: f.brand });
}

/** The words, bound once per surface: the chip props a list row spreads, and the open message's line. */
export function useSenderCheckWords(): {
  row: (m: EngineMessage) => { senderCheckLabel?: string; senderCheckTitle?: string };
  line: (m: EngineMessage) => string | null;
} {
  const t = useTranslations("screener");
  const words = t as unknown as Words;
  const row = useCallback((m: EngineMessage) => {
    const f = senderCheckFact(m);
    return f ? { senderCheckLabel: words("senderCheck.chip", { brand: f.brand }), senderCheckTitle: senderCheckSentence(words, f) } : {};
  }, [words]);
  const line = useCallback((m: EngineMessage) => {
    const f = senderCheckFact(m);
    return f ? senderCheckSentence(words, f) : null;
  }, [words]);
  return { row, line };
}

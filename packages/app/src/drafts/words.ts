/** What a draft's row says of it, from its fields alone. */
import type { EngineDraft } from "@ohmail/wire";
import { useMemo } from "react";
import type { DiscardRefusalWhy, DiscardWords } from "@ohmail/app-logic/drafts";
import { useText, type Text } from "../text/index.js";

/** Everybody it is for, by name where it has one, or nothing. */
export function recipientsOf(d: Pick<EngineDraft, "to" | "cc" | "bcc">): string {
  return [...d.to, ...d.cc, ...d.bcc].map((a) => a.name || a.address).join(", ");
}

export function refusalKey(why: DiscardRefusalWhy): string {
  return why === "still-sending"
    ? "discardStillSending"
    : why === "cancel-unknown"
      ? "discardCancelUnknown"
      : "discardUnknownJar";
}

/** What Discard's window says, in Drafts' own words: the seat hands these to `useDraftsList`. */
export function discardWordsOf(t: Text): DiscardWords {
  return {
    discarded: t("reportDiscarded"),
    undo: t("reportUndo"),
    changed: t("discardChanged"),
    unsupported: t("discardUnsupported"),
    notSent: t("discardedNotSent"),
    refused: (reason) => (reason === null ? t("discardRefusedUnnamed") : t("discardRefused", { reason })),
    queued: (wait) => (wait === "organizer" ? t("discardAwaitingOrganizer") : t("discardQueued")),
  };
}

/** {@link discardWordsOf} for the place's own namespace. */
export function useDiscardWords(): DiscardWords {
  const t = useText("drafts");
  return useMemo(() => discardWordsOf(t), [t]);
}

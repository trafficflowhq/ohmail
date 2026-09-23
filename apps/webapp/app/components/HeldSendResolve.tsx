"use client";

import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

/**
 * THE HELD SEND'S TWO ACTS — one component for the three doors that show a held message. The
 * engine looks in the Sent folder itself for a day (`HELD_SEND_RECHECK_MS`); what is left is what
 * only a person can decide: send the words again, or say it was sent and let the row go. No
 * question is asked here — the door passes its sentence as the group's label, so a screen reader
 * hears the same words. `onSendAgain` defaults to answering `not_arrived`: in an editor the text
 * is already in front of the person and Send goes live; the Drafts list's own also opens it.
 */
export function HeldSendResolve({
  draftId,
  label,
  onResolve,
  onSendAgain,
}: {
  draftId: string;
  /** The sentence this pair sits under — the group's accessible name. */
  label: string;
  onResolve: (draftId: string, outcome: "arrived" | "not_arrived") => void;
  onSendAgain?: (draftId: string) => void;
}) {
  const t = useTranslations("drafts");
  const again = onSendAgain ?? ((id: string) => { onResolve(id, "not_arrived"); });
  return (
    /* `tabIndex={-1}`: a refused Discard moves focus onto the row's refusal sentence, which sits
       beside this group; the group itself is reachable by Tab through its two buttons. */
    <div className="draft-resolve" role="group" aria-label={label}>
      <Button variant="ghost" className="draft-send-again" onClick={() => { again(draftId); }}>
        {t("sendAgain")}
      </Button>
      <Button variant="ghost" className="draft-it-was-sent" onClick={() => { onResolve(draftId, "arrived"); }}>
        {t("itWasSent")}
      </Button>
    </div>
  );
}

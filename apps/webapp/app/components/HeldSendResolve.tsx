"use client";

import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

/**
 * ── THE HELD SEND'S WAY OUT, ONE COMPONENT FOR EVERY DOOR ───────────────────────────────────
 *
 * A send the server took and never confirmed is held: it may already have arrived, so pressing
 * Send again could deliver it twice. The two verbs are the only things a reader is in a position
 * to know — they looked in their Sent folder, and the message is either there or it is not.
 *
 * ONE component because the Drafts row and the inline reply editor are the same question asked in
 * two places, and the reply door is the one that had no answer: a held reply was listed in Drafts
 * with the verbs and opened in its message's editor with nothing. Two copies of this markup would
 * be two sets of words and two chances for one of them to fall behind.
 */
export function HeldSendResolve({
  draftId,
  onResolve,
}: {
  draftId: string;
  onResolve: (draftId: string, outcome: "arrived" | "not_arrived") => void;
}) {
  const t = useTranslations("drafts");
  return (
    <div className="draft-resolve" role="group" aria-label={t("resolveWhat")}>
      <p className="set-note-inline">{t("resolveWhat")}</p>
      <div className="gate-actions">
        <Button variant="ghost" onClick={() => { onResolve(draftId, "arrived"); }}>
          {t("resolveArrived")}
        </Button>
        <Button variant="ghost" onClick={() => { onResolve(draftId, "not_arrived"); }}>
          {t("resolveNotArrived")}
        </Button>
      </div>
    </div>
  );
}

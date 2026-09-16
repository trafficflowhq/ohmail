"use client";

import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";

/**
 * THE HELD SEND'S WAY OUT — one component for the three doors that show a held message.
 *
 * A send the server took and never confirmed may already have arrived, so pressing Send again
 * could deliver it twice. These two verbs are the only things a reader is in a position to know:
 * they looked in their Sent folder, and the message is either there or it is not.
 *
 * One component because two copies of this markup are two sets of words, and one of them falls
 * behind — which is how the Drafts row came to carry the answers while the editors carried none.
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
    /* `tabIndex={-1}`: a Discard refused for this row moves focus HERE, so the question the
       reader has to answer is what they land on and hear, rather than a toast naming verbs that
       are somewhere on a list of identical pairs. Not reachable by Tab — only by that press. */
    <div className="draft-resolve" role="group" aria-label={t("resolveWhat")} tabIndex={-1}>
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

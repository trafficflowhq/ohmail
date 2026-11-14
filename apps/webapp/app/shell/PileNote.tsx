"use client";

/**
 * The note at the top of News and Receipts — letters there from senders nobody let in, and one press
 * that sends them to the Screener. Drawn only with something to say (`pile-note.ts`).
 */

import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui";
import type { PileNoteOffer } from "@ohmail/app-logic/lists/pile-note";

export function PileNote({ offer }: { offer: PileNoteOffer | null | undefined }) {
  const t = useTranslations("screener");
  if (!offer || offer.count <= 0) return null;
  return (
    <div className="scn-held pile-note" role="note">
      <p className="scn-held-lead">
        {t(offer.atLeast ? "pileUnscreenedLeadAtLeast" : "pileUnscreenedLead", { count: offer.count })}
      </p>
      <Button
        disabled={offer.screening}
        aria-busy={offer.screening || undefined}
        data-run={offer.screening ? "working" : undefined}
        onClick={() => offer.screen()}
      >
        {t("unscreenedAll", { count: offer.count })}
      </Button>
    </div>
  );
}

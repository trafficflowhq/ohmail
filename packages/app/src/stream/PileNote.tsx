import type { PileNoteOffer } from "@ohmail/app-logic/lists/pile-note";
import { Button } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

/** A pile's count from the arrival gate and the press that screens those letters. */
export function PileNote({ offer }: { offer: PileNoteOffer }) {
  const t = useText("screener");
  return (
    <div className="st-pile-note" role="note">
      <p className="oh-text">
        {t(offer.atLeast ? "pileUnscreenedLeadAtLeast" : "pileUnscreenedLead", { count: offer.count })}
      </p>
      <Button kind="two" size="s" busy={offer.screening} onPress={offer.screen}>
        {t("unscreenedAll", { count: offer.count })}
      </Button>
    </div>
  );
}

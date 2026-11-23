import type { PileNoteOffer } from "@ohmail/app-logic/lists/pile-note";
import { Notice } from "@ohmail/ui/base";
import { useText } from "../text/index.js";

/** A pile's count from the arrival gate and the press that screens those letters. */
export function PileNote({ offer, pileLabel }: { offer: PileNoteOffer; pileLabel: string }) {
  const t = useText("screener");
  return (
    <div className="st-pile-note" role="note">
      <Notice
        place="bar"
        title={t(offer.atLeast ? "pileUnscreenedLeadAtLeast" : "pileUnscreenedLead", {
          count: offer.count,
          pile: pileLabel,
        })}
        line={t("pileUnscreenedLine")}
        acts={[
          { label: t("unscreenedAll", { count: offer.count }), busy: offer.screening, onPress: offer.screen },
          { label: t("pileUnscreenedDismiss"), disabled: offer.screening, onPress: offer.dismiss },
        ]}
      />
    </div>
  );
}

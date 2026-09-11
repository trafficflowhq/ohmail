"use client";

/**
 * "A newer ohmail is available" — one quiet strip, wherever you are standing. The shell renders it (`SyncBar.tsx`
 * carries the argument): a sentence that belongs to the APP has to be rendered by the shell or only the people in the
 * remembering view ever see it — a `flex: none` sibling of the deck, nothing at all when there is nothing to say.
 */

/**
 * One strip, two doors: in a tab the newer thing is a build the origin is serving and the remedy is a reload; on the
 * desktop it is a signed release the native process verified and the remedy is a restart — this component knows
 * neither, it reads the one offer in `app-update.ts` and calls the callback it carries, so the shared shell can never
 * name a feed, a version or an install. It waits for a message being written: `quiet` holds it — the offer is not
 * withdrawn, just not drawn until the compose closes; the once-a-day restraint was already spent by the source, so a
 * suppressed notice would be a day of silence bought by typing.
 */

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";

import {
  announceUpdate,
  currentUpdateOffer,
  subscribeUpdateOffer,
  type UpdateOffer,
} from "./app-update";

/** Follow the one offer: adopt what is standing at mount, then listen. */
export function useUpdateOffer(): UpdateOffer | null {
  /* Not the current value as the initial state: a server render has no offer and adopting one
     during render would be a hydration mismatch. The mount effect below is where this document
     learns what the module already knew. */
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  useEffect(() => {
    setOffer(currentUpdateOffer());
    return subscribeUpdateOffer(setOffer);
  }, []);
  return offer;
}

export function UpdateNotice({ quiet = false }: { quiet?: boolean }) {
  const t = useTranslations("update");
  const offer = useUpdateOffer();
  if (offer === null || quiet) return null;

  const version = offer.version ?? "";
  const sentence =
    offer.kind === "reload"
      ? t("barReload")
      : offer.kind === "package"
        ? t("barPackage")
        : t("barRestart", { version });

  return (
    <div className="upd-bar" role="status">
      <span>{sentence}</span>
      {offer.act ? (
        <button type="button" className="upd-do" onClick={offer.act}>
          {offer.kind === "reload" ? t("barReloadAction") : t("barRestartAction")}
        </button>
      ) : null}
      {/* THE WAY OUT IS ALWAYS THERE, including on the notice that has no button to press.
          A strip a person cannot dismiss is a strip that has to be right about how often it
          appears; this one is right about that AND can be put away. */}
      <button
        type="button"
        className="upd-later"
        onClick={() => announceUpdate(null)}
      >
        {t("barLater")}
      </button>
    </div>
  );
}

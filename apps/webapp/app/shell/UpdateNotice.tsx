"use client";

/**
 * "A NEWER OHMAIL IS AVAILABLE" — one quiet strip, wherever you are standing.
 *
 * ── WHY THE SHELL AND NOT A VIEW ───────────────────────────────────────────────────────────
 *
 * `SyncBar.tsx` carries the long version of this argument and it applies here unchanged: a
 * sentence that belongs to the APP rather than to any one pile has to be rendered by the shell,
 * or the only people who ever see it are the ones who happen to be standing in the view that
 * remembered to render it. So this is a `flex: none` sibling of the deck, outside every list's
 * scroller by construction, and it renders nothing at all when there is nothing to say — there
 * is no permanent "you are up to date" chrome to learn to ignore.
 *
 * ── ONE STRIP, TWO COMPLETELY DIFFERENT DOORS ──────────────────────────────────────────────
 *
 * In a tab the newer thing is a build the origin is already serving, and the remedy is a
 * reload. In the desktop app it is a signed release the native process has already fetched and
 * verified, and the remedy is a restart. This component knows neither. It reads the one offer
 * in `app-update.ts` and calls the callback that offer carries — the shared shell can therefore
 * not name a feed, a version or an install, which is the boundary the desktop updater is built
 * around (`apps/desktop/src/update.ts`).
 *
 * ── AND IT WAITS FOR A MESSAGE BEING WRITTEN ───────────────────────────────────────────────
 *
 * A strip appearing above somebody mid-sentence moves the whole layout under their cursor, and
 * the one press it offers throws the draft's window away. `quiet` holds it — the offer is not
 * withdrawn and not re-decided, it simply is not drawn until the compose is closed. Waiting is
 * the right shape rather than suppressing: the once-a-day restraint has already been spent by
 * the source that armed the offer, so a suppressed notice would be a day of silence bought by a
 * person happening to be typing.
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

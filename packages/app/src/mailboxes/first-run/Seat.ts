/**
 * THE FIRST RUN'S SEAT: what stands the stage's facts on the ground. A stage has no columns to stand above, so its
 * seat is the hook its body calls once a render, as the registration's `ground`. It hands the frame's side and what
 * only a file of this package can read to the first run's live hook (`useFirstRunLive`), and nothing else: the mail
 * state, the consent row, the partition and the presented mirror are read there, through readers that throw where
 * the ground does not stand.
 *
 * THE MODEL OF A STAGE'S SEAT. It is mounted with the stage's run and unmounted with it, so the whole mirror is read
 * for the counts only while setup is on screen. It reads the Screener's one model as the ground stands it: the
 * guided decision is the Screener's own decision, and its count is the rail's.
 */
import { useCallback, useMemo } from "react";
import type { FirstRunGround } from "@ohmail/app-logic/mailboxes/first-run/ground";
import { useFirstRunLive, type FirstRunLiveOwn } from "@ohmail/app-logic/mailboxes/first-run/live";
import { useFrame, usePlaceLiveArgs } from "../../frame/index.js";
import { useScreener } from "../../screener/contract.js";
import { useLocale, useText, useTimeZone } from "../../text/index.js";
import { runWordsOf } from "./run-words.js";

export function useFirstRunSeat(): FirstRunGround {
  const { route } = useFrame();
  const { how, word } = runWordsOf(route);
  /* The Screener's one model. Throws where none stands above: a guided decision is never drawn over a guess. */
  const screener = useScreener();
  const say = useText("screener");
  const words = useMemo(
    (): FirstRunLiveOwn["words"] => ({
      notBrand: (brand) => say("senderCheck.chip", { brand }),
      /* The Screener's own caption: a first contact is named only where it stands apart from the letters' own times. */
      held: (count, firstContact) =>
        firstContact === undefined
          ? say("heldCaptionAll", { count })
          : say("heldCaption", { count, time: firstContact }),
    }),
    [say],
  );
  const locale = useLocale();
  const zone = useTimeZone();
  /* A day with no clock on it: a standing fact somebody reads once. An instant that cannot be read names none. */
  const dateOf = useCallback(
    (instant: string | null | undefined): string | null => {
      if (!instant) return null;
      const at = new Date(instant);
      if (Number.isNaN(at.getTime())) return null;
      return at.toLocaleDateString(locale, { dateStyle: "medium", timeZone: zone });
    },
    [locale, zone],
  );
  return useFirstRunLive(usePlaceLiveArgs(), { how, word, screener, words, dateOf });
}

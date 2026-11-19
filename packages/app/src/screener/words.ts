/** The Screener's words that its behaviour speaks through: the keys' rows, each pile named as the catalogue has it. */
import { useMemo } from "react";
import {
  DECISION_ORDER,
  PILE_KEY,
  type DecisionDestination,
  type ScreenerKeyWords,
  type ScreenerText,
} from "@ohmail/app-logic/screener";
import type { Translator } from "@ohmail/app-logic/text/translator";
import { useLocale, useText, useTimeZone } from "../text/index.js";

export function useKeyWords(): ScreenerKeyWords {
  const t = useText("screener");
  return useMemo(() => {
    const per = (key: "keyFile" | "keyFileRead") =>
      Object.fromEntries(DECISION_ORDER.map((d) => [d, t(key, { dest: t(PILE_KEY[d]) })])) as Record<
        DecisionDestination,
        string
      >;
    return {
      next: t("keyNext"),
      prev: t("keyPrev"),
      accept: t("keyAccept"),
      applyAll: t("keyApplyAll"),
      card: t("place.keyCard"),
      segPrev: t("keySegPrev"),
      segNext: t("keySegNext"),
      undo: t("toastUndo"),
      close: t("place.keyClose"),
      file: per("keyFile"),
      fileRead: per("keyFileRead"),
    };
  }, [t]);
}

const PLACES = ["ohbox", "reads", "receipts", "screened", "spam"] as const;

export function useScreenerWords(): ScreenerText {
  const screener = useText("screener");
  const screening = useText("screening");
  const ohbox = useText("ohbox");
  const session = useText("session");
  const place = useText("place");
  const locale = useLocale();
  const zone = useTimeZone();
  return useMemo((): ScreenerText => ({
    screener: screener as unknown as Translator,
    screening: screening as unknown as Translator,
    ohbox: ohbox as unknown as Translator,
    session: session as unknown as Translator,
    piles: {
      ohbox: screener(PILE_KEY.ohbox),
      reads: screener(PILE_KEY.reads),
      receipts: screener(PILE_KEY.receipts),
      screened: screener(PILE_KEY.screened),
      spam: screener(PILE_KEY.spam),
    },
    places: Object.fromEntries(PLACES.filter((id) => place.has(id)).map((id) => [id, place(id)])),
    locale,
    zone: () => zone,
  }), [screener, screening, ohbox, session, place, locale, zone]);
}

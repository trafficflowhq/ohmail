/** The Screener's words that its behaviour speaks through: the keys' rows, each pile named as the catalogue has it. */
import { useMemo } from "react";
import {
  DECISION_ORDER,
  PILE_KEY,
  type DecisionDestination,
  type ScreenerKeyWords,
} from "@ohmail/app-logic/screener";
import { useText } from "../text/index.js";

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

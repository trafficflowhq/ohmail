/**
 * The five pile names, in one table, for every surface that says one. `packages/ui` used to export two English
 * records read by eight surfaces; five interpolated the English word into a translated sentence, so a German reader
 * met "nach Receipts einsortieren" beside a rail saying "Belege" — the catalogue had the German the whole time
 * (`screener.pile*`). This is the replacement: a table of KEYS, resolved by whoever renders.
 */

/**
 * Two forms because the bar needs both: {@link PILE_KEY} is the PLACE ("Aussortiert") — titles, toasts, hints, the ✓
 * half; {@link PILE_VERB_KEY} is the ACT ("Aussortieren") — the five capsule labels. A table and not
 * `t(\`pile${dest}\`)`: an interpolated key is a lookup no compiler checks — a sixth destination would render the
 * literal key path into a button rather than failing to build.
 */
import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { DECISION_KEY, DECISION_QUIET, type DecisionBarCopy, type DecisionDestination } from "@ohmail/ui";

export const PILE_KEY: Record<DecisionDestination, string> = {
  ohbox: "pileOhbox",
  reads: "pileReads",
  receipts: "pileReceipts",
  screened: "pileScreened",
  spam: "pileSpam",
};

export const PILE_VERB_KEY: Record<DecisionDestination, string> = {
  ...PILE_KEY,
  screened: "pileScreenOut",
};

/** A `screener`-namespace translator, as the hooks below want it. */
type T = (key: string, values?: Record<string, string | number>) => string;

/**
 * The five place names, resolved. Every surface that puts a destination inside a sentence —
 * the sender sheet, the subject-rule sheet, the Screener's toasts and key hints — takes them
 * from here, so the word in the sentence is the word on the rail.
 */
export function usePileNames(): Record<DecisionDestination, string> {
  const t = useTranslations("screener") as unknown as T;
  return useMemo(() => pileNames(t), [t]);
}

/** The non-hook form, for a caller that already holds the `screener` translator. */
export function pileNames(t: T): Record<DecisionDestination, string> {
  return {
    ohbox: t(PILE_KEY.ohbox),
    reads: t(PILE_KEY.reads),
    receipts: t(PILE_KEY.receipts),
    screened: t(PILE_KEY.screened),
    spam: t(PILE_KEY.spam),
  };
}

/**
 * Every word the decision bar renders, built from the catalogue. `ruleTarget` is the address or
 * domain the consequence line names — already display-decoded by the caller, because what the rule
 * is WRITTEN against is the stored address and what is SHOWN may be its Unicode form (`idn.ts`).
 * The ✓ half is supplied for exactly the destinations `DECISION_QUIET` does not name, from that
 * same set rather than a second hand-written list: "a demoting destination has no read verb" is
 * one fact, and the day it moves it has to move once.
 */
export function useDecisionBarCopy(ruleTarget: string): DecisionBarCopy {
  const t = useTranslations("screener") as unknown as T;
  return useMemo(() => {
    const dest = {} as DecisionBarCopy["dest"];
    for (const d of Object.keys(PILE_KEY) as DecisionDestination[]) {
      const place = t(PILE_KEY[d]);
      const key = DECISION_KEY[d];
      dest[d] = {
        label: t(PILE_VERB_KEY[d]),
        title: t("barTitle", { dest: place, key }),
        ...(DECISION_QUIET.has(d)
          ? {}
          : {
              check: {
                label: t("barMarkRead", { dest: place }),
                title: t("barMarkReadTitle", { dest: place, key: key.toUpperCase() }),
              },
            }),
      };
    }
    return {
      dest,
      scopeAria: t("barScopeAria"),
      scopeSender: t("barScopeSender"),
      scopeDomain: t("barScopeDomain"),
      rule: t("barRule", { target: ruleTarget }),
      halvesLabel: t("barHalvesLabel"),
      halves: t("barHalves"),
      back: t("back"),
    };
  }, [t, ruleTarget]);
}

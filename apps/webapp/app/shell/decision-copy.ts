/**
 * THE FIVE PILE NAMES, IN ONE TABLE, FOR EVERY SURFACE THAT SAYS ONE.
 *
 * `packages/ui` used to export `DECISION_LABEL` and `DECISION_DONE_LABEL` — two English records —
 * and eight surfaces read them. Five of those interpolated the English word into a TRANSLATED
 * sentence, so a German reader was told "Diesen Absender nach Receipts einsortieren" while the
 * rail beside it said "Belege", and the decision bar itself was English end to end. The catalogue
 * had the German the whole time (`screener.pile*`); nothing connected the two.
 *
 * So the records are gone and this is what replaced them: a table of KEYS, resolved against the
 * catalogue by whoever is rendering. Two forms, because the bar needs both and they differ in
 * exactly one entry:
 *
 *   · {@link PILE_KEY} is the PLACE ("Screened out" / "Aussortiert") — what a message's
 *     destination is called once it is there. Titles, toasts, keyboard hints, the ✓ half.
 *   · {@link PILE_VERB_KEY} is the ACT ("Screen out" / "Aussortieren") — what pressing does.
 *     Only the five capsule labels want this one.
 *
 * A table and not `t(\`pile${dest}\`)`: the destinations are a union, and an interpolated key is a
 * lookup no compiler can check — a sixth destination would render the literal `screener.pileFoo`
 * into a button rather than failing to build. (Moved here from `views/ScreenerView.tsx`, which
 * carried the same table and the same argument for it; the argument was right and the table was
 * in the wrong file.)
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
 * Every word the decision bar renders, built from the catalogue.
 *
 * `ruleTarget` is the address or domain the consequence line names — already display-decoded by
 * the caller, because what the rule is WRITTEN against is the stored address and what is SHOWN
 * may be its Unicode form (`idn.ts`).
 *
 * The ✓ half is supplied for exactly the destinations `DECISION_QUIET` does not name, from that
 * same set rather than from a second hand-written list: "a demoting destination has no read verb"
 * is one fact, and the day it moves it has to move once.
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

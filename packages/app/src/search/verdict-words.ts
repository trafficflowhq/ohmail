/** What Search has answered so far, including the confirmed scope, count and wait. */
import type { SearchListModel, SearchVerdict } from "@ohmail/app-logic/search";
import type { Text } from "../text/index.js";

/** One line under the results. */
export interface SaidLine {
  readonly say: string;
  /** Something is still being read: a status that is busy. */
  readonly busy?: boolean;
  /** A settled scope whose change should be announced. */
  readonly said?: boolean;
  /** A refusal or a part that could not be reached. */
  readonly warn?: boolean;
  /** Its one press: ask the whole mailbox again. */
  readonly again?: boolean;
}

export interface Said {
  /** The count beside Results, as it is printed. */
  readonly count?: string;
  readonly lines: readonly SaidLine[];
}

function verdictLines(model: SearchListModel, t: Text, locale: string): SaidLine[] {
  const v = model.verdict;
  const reading: SaidLine[] = model.indexing ? [{ say: t("saidReading"), busy: true }] : [];
  switch (v.kind) {
    case "none":
      return [];
    case "device":
    case "unfinished":
    case "noStore":
      return reading;
    case "searching":
      return [...reading, { say: t("saidSearching"), busy: true }];
    case "unanswered":
      /* The one sentence that may name this device: a failure's (History's and Search's copy census admits it). */
      return [{ say: t(v.refused ? "scopeFailed" : "scopeUnanswered"), warn: true, again: true }];
    case "matched": {
      if (v.scope === "synced") return [...reading, { say: t("saidSynced"), said: true }];
      if (v.scope === "mirror") return [...reading, { say: t("saidMirror"), warn: true, again: true }];
      if (v.near || v.count.kind === "exact") return reading;
      const total = new Intl.NumberFormat(locale).format(v.count.n);
      return [...reading, { say: t(v.count.kind === "about" ? "saidAbout" : "saidAtLeast", { total }) }];
    }
    default:
      return v satisfies never;
  }
}

export function saidOf(model: SearchListModel, t: Text, locale: string): Said {
  const lines = verdictLines(model, t, locale);
  if (model.storeIndexing !== null)
    lines.push({ say: t("saidIndexing", { percent: model.storeIndexing }), busy: true });
  if (model.bounded !== null)
    lines.push({ say: t("saidBounded", { count: model.bounded.toLocaleString(locale) }) });
  const v = model.verdict;
  if (v.kind === "matched") {
    const total = new Intl.NumberFormat(locale).format(v.count.n);
    const count = v.count.kind === "atLeast" ? t("saidCountAtLeast", { total }) : total;
    return { count, lines };
  }
  return { count: new Intl.NumberFormat(locale).format(model.found), lines };
}

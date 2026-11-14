/**
 * WHAT SEARCH SAYS OF WHAT IT SEARCHED. The plain answer, the whole mailbox counted exactly, says nothing more than
 * its count beside Results. A line stands under the results only where the answer is not that: still searching,
 * still reading or indexing, an estimate or a lower bound, only the mail synced so far, only this computer's mail, a
 * server that did not answer or could not run it, the best matches only. The switch over the verdict is exhaustive:
 * a verdict the screen does not say is a compile error.
 */
import type { SearchListModel, SearchVerdict } from "@ohmail/app-logic/search";
import type { Text } from "../text/index.js";

/** One line under the results. */
export interface SaidLine {
  readonly say: string;
  /** Something is still being read: a status that is busy. */
  readonly busy?: boolean;
  /** A refusal or a part that could not be reached. */
  readonly warn?: boolean;
  /** Its one press: ask the whole mailbox again. */
  readonly again?: boolean;
}

export interface Said {
  /** The count beside Results, as it is printed: "12", "2,400", "2,000+". */
  readonly count: string;
  readonly lines: readonly SaidLine[];
}

type Count = Extract<SearchVerdict, { kind: "matched" }>["count"];

/** A paired computer's mirror answered for the account: the admitted sentence, with how many it found. */
function mirrorSentence(v: Extract<SearchVerdict, { kind: "matched" }>, t: Text): string {
  const total = v.count.n;
  if (v.count.kind === "about") return t("scopeMirrorAbout", { total });
  if (v.count.kind === "atLeast")
    return t(v.near ? "scopeMirrorNearAtLeast" : "scopeMirrorAtLeast", { total });
  return t(v.near ? "scopeMirrorNear" : "scopeMirror", { total });
}

function countOf(model: SearchListModel, t: Text, locale: string): string {
  const v = model.verdict;
  const n = (x: number) => x.toLocaleString(locale);
  /* The store is asked with what is pressed: its count is the narrowed question's, never the rows walked so far. */
  if (v.kind !== "matched") return n(model.found);
  const c: Count = v.count;
  return c.kind === "atLeast" ? t("saidCountAtLeast", { total: n(c.n) }) : n(c.n);
}

function verdictLines(model: SearchListModel, t: Text, locale: string): SaidLine[] {
  const v = model.verdict;
  const reading: SaidLine[] = model.indexing ? [{ say: t("saidReading"), busy: true }] : [];
  switch (v.kind) {
    case "none":
      return [];
    case "device":
    case "unfinished":
      return reading;
    case "searching":
      return [...reading, { say: t("saidSearching"), busy: true }];
    case "noStore":
      return [...reading, { say: t("scopeNoArchive") }];
    case "unanswered":
      /* The one sentence that may name this device: a failure's (History's and Search's copy census admits it). */
      return [{ say: t(v.refused ? "scopeFailed" : "scopeUnanswered"), warn: true, again: true }];
    case "matched": {
      const total = v.count.n.toLocaleString(locale);
      switch (v.scope) {
        /* A paired computer's mirror answered for the account: the press asks the account again. */
        case "mirror":
          return [...reading, { say: mirrorSentence(v, t), warn: true, again: true }];
        case "synced":
          return [...reading, { say: t("saidSynced") }];
        case "whole":
          if (v.near || v.count.kind === "exact") return reading;
          return [...reading, { say: t(v.count.kind === "about" ? "saidAbout" : "saidAtLeast", { total }) }];
      }
      return reading;
    }
    default:
      return v satisfies never;
  }
}

export function saidOf(model: SearchListModel, t: Text, locale: string): Said {
  const lines = verdictLines(model, t, locale);
  if (model.storeIndexing !== null)
    lines.push({ say: t("saidIndexing", { percent: model.storeIndexing }), busy: true });
  /* Only the mail synced so far: said once, by the verdict's own line where it stands. */
  if (model.syncing && !(model.verdict.kind === "matched" && model.verdict.scope === "synced"))
    lines.push({ say: t("syncing") });
  if (model.bounded !== null)
    lines.push({ say: t("saidBounded", { count: model.bounded.toLocaleString(locale) }) });
  return { count: countOf(model, t, locale), lines };
}

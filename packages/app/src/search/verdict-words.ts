/** What Search has answered so far, including the confirmed scope, count and wait. */
import type { SearchListModel, SearchVerdict } from "@ohmail/app-logic/search";
import type { Text } from "../text/index.js";

/** One line under the results. */
export interface SaidLine {
  readonly say: string;
  /** Something is still being read: a status that is busy. */
  readonly busy?: boolean;
  readonly said?: boolean;
  readonly waitedMs?: number;
  /** A refusal or a part that could not be reached. */
  readonly warn?: boolean;
  /** Its one press: ask the whole mailbox again. */
  readonly again?: boolean;
}

export interface Said {
  /** The device count and time beside Results while the verdict carries no count. */
  readonly count?: string;
  readonly lines: readonly SaidLine[];
}

type Matched = Extract<SearchVerdict, { kind: "matched" }>;

function scopeSentence(v: Matched, t: Text): string {
  const scope = { whole: "scopeWhole", synced: "scopeSynced", mirror: "scopeMirror" }[v.scope];
  const tier = v.near ? "Near" : "";
  const suffix = v.count.kind === "about" ? "About" : v.count.kind === "atLeast" ? `${tier}AtLeast` : tier;
  return t(`${scope}${suffix}`, { total: v.count.n });
}

function verdictLines(model: SearchListModel, t: Text): SaidLine[] {
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
      const mirror = v.scope === "mirror";
      return [
        {
          say: scopeSentence(v, t),
          said: true,
          waitedMs: v.waitedMs ?? model.tookMs,
          warn: mirror,
          again: mirror,
        },
      ];
    }
    default:
      return v satisfies never;
  }
}

export function saidOf(model: SearchListModel, t: Text, locale: string): Said {
  const lines = verdictLines(model, t);
  if (model.storeIndexing !== null)
    lines.push({ say: t("indexing", { percent: model.storeIndexing }), busy: true });
  if (model.syncing) lines.push({ say: t("syncing") });
  if (model.bounded !== null)
    lines.push({ say: t("bounded", { count: model.bounded.toLocaleString(locale) }) });
  const count =
    model.verdict.kind === "matched"
      ? undefined
      : t("resultsHead", { count: model.found }) + t("resultsMeta", { ms: model.tookMs });
  return { count, lines };
}

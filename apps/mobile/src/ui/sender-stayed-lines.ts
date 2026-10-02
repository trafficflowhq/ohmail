/**
 * The sender sheet's "why it stayed" lines as words — the web sheet's `stayed*` keys, one line per
 * place and reason, each with its "Move it too" unless the reason is a failed sign-in check, which
 * the person cannot overrule from here. Pure, so a test reads what the sheet renders.
 */
import { Copy } from "../copy";
import { destDone, type Destination } from "../state/model";
import { folderLeafOf } from "../state/folders";
import { ownFolderOf, stayedLines, type StayedAsk, type StayedPlace, type StayedWhy } from "../state/sender-stayed";

export interface StayedRow {
  key: string;
  text: string;
  /** The press past the reason; `null` for a failed check. */
  move: { label: string; ids: string[]; dest: Destination } | null;
}

/**
 * A place by the names the lists use: a pile, the gate, History, or a folder by its leaf, with its
 * parent when another place in `among` has the same leaf under a different path ("Work/Fixture").
 */
export function stayedPlaceName(p: StayedPlace, among: readonly StayedPlace[] = []): string {
  const folder = ownFolderOf(p);
  if (folder !== null) {
    const leaf = folderLeafOf(folder.path);
    const clash = among.some((q) => {
      const o = ownFolderOf(q);
      return o !== null && o.path !== folder.path && folderLeafOf(o.path) === leaf;
    });
    return clash ? folder.path.split("/").filter(Boolean).slice(-2).join("/") : leaf;
  }
  return p === "screener" ? Copy.placeScreener : p === "history" ? Copy.history : destDone(p as Destination);
}

const SENTENCE: Record<StayedWhy, (count: number, place: string) => string> = {
  replied: (n, p) => Copy.stayedReplied(n, p),
  "set-aside": (n, p) => Copy.stayedSetAside(n, p),
  "filed-elsewhere": (n, p) => Copy.stayedFiledElsewhere(n, p),
  "failed-checks": (n, p) => Copy.stayedFailedChecks(n, p),
};

export function stayedRows(ask: StayedAsk | null, why: ReadonlyMap<string, StayedWhy> | null): StayedRow[] {
  if (!ask || !why) return [];
  const among = ask.elsewhere.map((e) => e.place);
  return stayedLines(ask.elsewhere, why).map((line) => ({
    key: `${line.place}:${line.why}`,
    text: SENTENCE[line.why](line.ids.length, stayedPlaceName(line.place, among)),
    move: line.why === "failed-checks" ? null : { label: Copy.stayedMoveToo(line.ids.length), ids: line.ids, dest: ask.ruled },
  }));
}

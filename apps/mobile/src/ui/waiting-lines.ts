/**
 * WHAT WAITS ON THE ORGANIZER, WORDED FOR THE PHONE — the strip's one line over the Ohbox and in
 * Settings, and the sheet's row per request. Pure, over `engine.waitingOnOrganizer()`: the same
 * list the web's Rules page reads, so the two surfaces cannot disagree about what waits.
 */
import type { WaitingOnOrganizerView } from "../state/live";
import { Copy } from "../copy";
import { folderName } from "../state/live";

/** The strip: "N changes wait on <holder>", or `null` when nothing waits. Refusals are listed, not counted. */
export function waitingStripLine(list: readonly WaitingOnOrganizerView[]): string | null {
  if (list.length === 0) return null;
  const open = list.filter((w) => w.state !== "refused");
  // Only refusals left: the newest one's own sentence, never "N changes wait".
  if (open.length === 0) return waitingRowLines(list[0]!).state;
  const names = [...new Set(open.map((w) => w.holder.name).filter((n): n is string => n !== null))];
  return names.length === 1 ? Copy.waitingStrip(open.length, names[0]!) : Copy.waitingStripUnknown(open.length);
}

/** One sheet row: what was asked, and where it stands. */
export function waitingRowLines(w: WaitingOnOrganizerView): { what: string; state: string | null } {
  const t = w.target as {
    rule?: { match: string }; destination?: string; folder?: string | null; match?: string; fields?: string[];
  };
  let what: string;
  if (w.kind === "message.move") what = t.folder ? Copy.waitingMove(folderName(t.folder)) : Copy.waitingMoveSomewhere;
  else if (w.kind === "rule.delete" && t.rule) what = Copy.waitingRuleRemove(t.rule.match);
  else if ((w.kind === "rule.update" || w.kind === "rule.create") && t.rule) {
    what = t.destination ? Copy.waitingRuleChange(t.rule.match, folderName(t.destination)) : Copy.waitingRuleChangeSomewhere(t.rule.match);
  } else if (w.kind === "screener.decide" && t.match) what = Copy.waitingDecision(t.match);
  else if (w.kind === "profile.update") what = Copy.waitingSettings;
  else what = Copy.waitingOther;
  const holder = w.holder.name;
  const state = w.state === "refused"
    ? Copy.waitingRefused(holder ?? Copy.waitingTheOrganizer)
    : w.slow ? (holder ? Copy.organizerStillWaiting(holder) : Copy.organizerStillWaitingUnknown) : null;
  return { what, state };
}

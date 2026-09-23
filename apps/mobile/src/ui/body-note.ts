import { Copy } from "../copy";
import type { WorldMail } from "../state/world";

type Row = Pick<WorldMail, "bodyState" | "bodyWithheld" | "bodyJunkLeaving">;

/** A spam verdict's husk on a message no longer in the spam pile — decided by the state layer. */
export function junkLeaving(m: Row): boolean {
  return m.bodyState === "withheld" && m.bodyJunkLeaving === true;
}

/**
 * THE SENTENCE A WITHHELD BODY GETS ON THE PHONE — per marker, as on the web: the storage cap
 * names the space, the verdict names Junk only while the message is in the spam pile, a husk
 * moved out is loading until `refillExpired`, then the preview is all that could be read.
 */
export function withheldNote(m: Row, refillExpired: boolean): string {
  if (junkLeaving(m)) return refillExpired ? Copy.liveBodyFailed : Copy.liveBodyJunkLoading;
  switch (m.bodyWithheld) {
    case "junk_filed": return Copy.liveBodyWithheldJunk;
    case "expunged": return Copy.liveBodyWithheldExpunged;
    default: return Copy.liveBodyWithheld;
  }
}

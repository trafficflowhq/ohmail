import {
  FOLDER_OF_VIEW,
  consentPartition,
  presentationReader,
  pressOutcome,
  rulesList,
  stayVerdict,
  type EntityReader,
  type StayVerdict,
} from "@ohmail/client-engine";
import { shellConsentOptions, type ShellConsentFacts } from "./consent-options";
import { senderScreening, type ScreeningDest, type ScreeningScope } from "./sender-screening";

/**
 * WHAT A SCREENING PRESS MAY SAY ONCE THE LIST IS READ AGAIN. The pressed
 * rows are placed by the partition the lists are drawn with ({@link shellConsentOptions}) over the
 * mirror after the press, never by their filed folder, and the sentence they earn is the engine's
 * {@link stayVerdict} — the phone reads the same one. `none` leaves the press's own sentence.
 */
export function screeningVerdict(
  reader: EntityReader,
  messageId: string,
  address: string | undefined,
  dest: ScreeningDest,
  scope: ScreeningScope,
  o: { consent: ShellConsentFacts; now: Date; ownAddresses: readonly string[]; retro: boolean },
): StayVerdict {
  const s = senderScreening(reader, messageId, address);
  if (!s) return { key: "none" };
  const presented = presentationReader(reader, consentPartition(reader, shellConsentOptions(o.consent, o.now, o.ownAddresses)));
  return stayVerdict(pressOutcome({
    presented, subject: s.scopes[scope].messages, rules: rulesList(reader), wanted: FOLDER_OF_VIEW[dest], retro: o.retro,
  }), reader);
}

/** The catalogue key each verdict is said in, under `screening`. */
export const VERDICT_KEY = {
  kept: "verdictKept", keptMany: "verdictKeptMany", still: "verdictStill",
  stillLegacy: "verdictStillLegacy", applying: "verdictApplying",
} as const;

/**
 * THE ONE PRESS SEAM. A press is durable on this device when `port.press` resolves, which says nothing of our
 * server's answer; so the sentence waits: the queue is flushed, and only the verdict under the press's key decides
 * what is said. Still owed (the server could not be reached, the act stays queued): nothing is said, and the card's
 * waiting line speaks instead.
 */
import type { CalendarAct } from "@ohmail/wire";
import type { CalendarPort, CalendarVerdict } from "./port.js";
import { FAULT_KEYS, REFUSAL_KEYS, TAKEN_KEYS, type CalendarSentenceKey } from "./sentences.js";

const REFUSED = { ...FAULT_KEYS, ...REFUSAL_KEYS };

export const calendarRefusalSentence = (word: keyof typeof REFUSED): CalendarSentenceKey => REFUSED[word];

export interface Heard {
  readonly key: string;
  readonly verdict: CalendarVerdict | null;
  /** The one sentence to say, or null while the press is still owed. */
  readonly say: CalendarSentenceKey | null;
}

export function sentenceOf(act: CalendarAct, verdict: CalendarVerdict | null): CalendarSentenceKey | null {
  if (verdict === null) return null;
  if (
    verdict.kind === "refused" &&
    verdict.word === "validation_failed" &&
    typeof verdict.details === "object" &&
    verdict.details !== null &&
    "reason" in verdict.details &&
    verdict.details.reason === "repeat_unsupported"
  )
    return calendarRefusalSentence("repeat_unsupported");
  return verdict.kind === "taken" ? TAKEN_KEYS[act.kind] : calendarRefusalSentence(verdict.word);
}

export async function pressAndHear(
  port: Pick<CalendarPort, "press" | "flush" | "verdict" | "watchLateRefusal">,
  act: CalendarAct,
  reportLate = true,
): Promise<Heard> {
  const { key } = await port.press(act);
  await port.flush();
  const verdict = port.verdict(key);
  if (verdict === null && reportLate) port.watchLateRefusal?.(key);
  return { key, verdict, say: sentenceOf(act, verdict) };
}

/**
 * THE ONE PRESS SEAM. A press is durable on this device when `port.press` resolves, which says nothing of our
 * server's answer; so the sentence waits: the queue is flushed, and only the verdict under the press's key decides
 * what is said. Still owed (the server could not be reached, the act stays queued): nothing is said, and the card's
 * waiting line speaks instead.
 */
import type { CalendarAct } from "@ohmail/wire";
import type { CalendarPort, CalendarVerdict } from "./port.js";
import { REFUSAL_KEYS, TAKEN_KEYS, type CalendarSentenceKey } from "./sentences.js";

export interface Heard {
  readonly key: string;
  readonly verdict: CalendarVerdict | null;
  /** The one sentence to say, or null while the press is still owed. */
  readonly say: CalendarSentenceKey | null;
}

export function sentenceOf(act: CalendarAct, verdict: CalendarVerdict | null): CalendarSentenceKey | null {
  if (verdict === null) return null;
  return verdict.kind === "taken" ? TAKEN_KEYS[act.kind] : REFUSAL_KEYS[verdict.word];
}

export async function pressAndHear(
  port: Pick<CalendarPort, "press" | "flush" | "verdict">,
  act: CalendarAct,
): Promise<Heard> {
  const { key } = await port.press(act);
  await port.flush();
  const verdict = port.verdict(key);
  return { key, verdict, say: sentenceOf(act, verdict) };
}

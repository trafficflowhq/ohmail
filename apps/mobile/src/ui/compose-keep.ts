/**
 * TYPED TEXT IS NEVER LOST SILENTLY — the composer's close, as a decision rather than a branch
 * inside a sheet (`send-cancel.ts`'s idiom: there is no React Native renderer in this workspace,
 * so the decision is driven directly and `MessageActions.tsx` is read to prove it takes it).
 *
 * Every road out — Cancel, the backdrop, the back gesture — asks this after `cancelAct` said
 * "close". Text worth a row is kept as a draft first; files a draft cannot hold, or a keep that
 * failed, are said in place and the NEXT close discards, so one stray tap loses nothing.
 */
import type { ComposerPhase } from "./send-cancel";

/** What the close does: keep the text, say why it cannot and wait, or just close. */
export type KeepAct = "keep" | "ask" | "close";

/**
 * Worth a draft row — the web's `worthCreating`: a body, or a new mail's own subject. A reply's
 * subject and a recipient alone are not something the person wrote.
 */
export function worthKeeping(o: { fresh: boolean; subject: string; body: string }): boolean {
  return o.body.trim() !== "" || (o.fresh && o.subject.trim() !== "");
}

/**
 * `armed` is the second press after the sheet said why it could not keep something — that press
 * is the person choosing to discard. Only an idle composer keeps: a queued or unverified send
 * already has its text on its way, and closing a sending one is not offered.
 */
export function keepAct(o: {
  phase: ComposerPhase;
  worth: boolean;
  files: number;
  armed: boolean;
}): KeepAct {
  if (o.phase !== "idle" || o.armed) return "close";
  if (o.worth) return "keep";
  return o.files > 0 ? "ask" : "close";
}

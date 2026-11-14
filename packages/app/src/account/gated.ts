/**
 * THE ONE MACHINE OF A GATED ACT. The server guards a sensitive act with a fresh second factor; the client's half of
 * that guard is an order of events, written once here and stepped by every pane's hook:
 *
 *   idle → trying → (asking → trying again, once) → done | refused
 *
 * An act is TRIED first. The answer `factor` on that first try parks it and asks the factor. The verified factor
 * sends the parked act exactly once more, marked "after the factor"; `factor` again after that is `sign_in`, never a
 * second dialog. Cancel drops the parked act. A factor that landed after Cancel was thrown away by the dialog: the
 * place then says that nothing ran.
 *
 * Pure: it reaches no door and holds no clock. The act rides the state, and a step answers what to send now, so that
 * "once" is decided here and not in six hooks. A hook keeps the state in one place, applies each event as it
 * arrives, sends what a step hands back and gives the door's answer in as the next event. Whether the place is still
 * mounted is the hook's to know: it steps nothing after it left. It never steps inside a state updater or a reducer:
 * those may be called twice, and the act a step hands back would then be sent twice.
 *
 * One act at a time: while one is on its way or its factor is asked, a second try is not taken.
 */
import type { Answer, GatedAsk } from "./contract.js";

/** Why a gated act ended refused: the door's own word, the sign-in remedy, or the shell's sentence. Never `factor`: that asks. */
export type GatedRefusal<W extends string = never> =
  | { readonly word: W | "sign_in"; readonly minutes?: number }
  | { readonly word: "said"; readonly said: string };

/** What the door answered a try: taken, or refused with a word. A door's `Answer` is one as it stands. */
export type GatedAnswer<W extends string = never> =
  { readonly ok: true } | Exclude<Answer<never, W>, { ok: true }>;

/** An act to send now, and whether a verified factor stands before it. */
export interface GatedRun<A> {
  readonly act: A;
  readonly afterFactor: boolean;
}

export type GatedState<A, W extends string = never> = {
  /** A factor landed after Cancel and was thrown away: nothing ran. It stands until the next try. */
  readonly nothingRan: boolean;
} & (
  | { readonly at: "idle" }
  /** The act is on its way. */
  | { readonly at: "trying"; readonly act: A; readonly afterFactor: boolean }
  /** The act is parked and the factor is asked. */
  | { readonly at: "asking"; readonly act: A }
  | { readonly at: "done"; readonly act: A }
  | { readonly at: "refused"; readonly act: A; readonly refusal: GatedRefusal<W> }
);

/** The dialog's three answers: the factor verified; Cancel; a factor that landed after Cancel. */
export interface GatedDialogEvent {
  readonly kind: "verified" | "cancelled" | "discarded";
}

export type GatedEvent<A, W extends string = never> =
  /** The person's press. */
  | { readonly kind: "try"; readonly act: A }
  /** The door answered the act that is on its way. */
  | { readonly kind: "answered"; readonly answer: GatedAnswer<W> }
  | GatedDialogEvent;

export interface GatedStepped<A, W extends string = never> {
  readonly state: GatedState<A, W>;
  /** The act to send now, once; `null` where the event sends nothing. */
  readonly run: GatedRun<A> | null;
}

export const GATED_IDLE = { at: "idle", nothingRan: false } as const;

const stays = <A, W extends string>(state: GatedState<A, W>): GatedStepped<A, W> => ({ state, run: null });

/** The door's answer to the act on its way: done, the factor asked (on the first try alone), or refused. */
function answered<A, W extends string>(
  state: Extract<GatedState<A, W>, { at: "trying" }>,
  answer: GatedAnswer<W>,
): GatedState<A, W> {
  const { act, nothingRan } = state;
  if (answer.ok) return { at: "done", act, nothingRan };
  if ("said" in answer) {
    return { at: "refused", act, refusal: { word: "said", said: answer.said }, nothingRan };
  }
  if (answer.word === "factor") {
    // A second refusal right after a verified factor would ask for ever: signing in again is the remedy.
    return state.afterFactor
      ? { at: "refused", act, refusal: { word: "sign_in" }, nothingRan }
      : { at: "asking", act, nothingRan };
  }
  const refusal: GatedRefusal<W> =
    answer.minutes === undefined ? { word: answer.word } : { word: answer.word, minutes: answer.minutes };
  return { at: "refused", act, refusal, nothingRan };
}

/** One event, applied: the state after it, and the act to send now, if any. */
export function gatedStep<A, W extends string = never>(
  state: GatedState<A, W>,
  event: GatedEvent<A, W>,
): GatedStepped<A, W> {
  switch (event.kind) {
    case "try": {
      if (state.at === "trying" || state.at === "asking") return stays(state);
      const run = { act: event.act, afterFactor: false };
      return { state: { at: "trying", ...run, nothingRan: false }, run };
    }
    case "answered":
      return state.at === "trying" ? stays(answered(state, event.answer)) : stays(state);
    case "verified": {
      if (state.at !== "asking") return stays(state);
      const run = { act: state.act, afterFactor: true };
      // Every send starts clean, this one too: what an older, cancelled ceremony left is no longer what is said.
      return { state: { at: "trying", ...run, nothingRan: false }, run };
    }
    case "cancelled":
      return state.at === "asking" ? stays({ at: "idle", nothingRan: state.nothingRan }) : stays(state);
    case "discarded":
      // Still asked when its factor was thrown away: the parked act goes too, so "nothing ran" stays true.
      return state.at === "asking"
        ? stays({ at: "idle", nothingRan: true })
        : stays({ ...state, nothingRan: true });
  }
}

/**
 * What the factor's dialog is handed while the factor is asked, and `null` otherwise: its three answers as the
 * machine's three events, and the place's own line.
 */
export function gatedAsk<A, W extends string = never>(
  state: GatedState<A, W>,
  send: (event: GatedDialogEvent) => void,
  line?: string,
): GatedAsk | null {
  if (state.at !== "asking") return null;
  return {
    ...(line === undefined ? {} : { line }),
    onVerified: () => send({ kind: "verified" }),
    onCancel: () => send({ kind: "cancelled" }),
    onDiscarded: () => send({ kind: "discarded" }),
  };
}

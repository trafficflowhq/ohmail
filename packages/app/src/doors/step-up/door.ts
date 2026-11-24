/**
 * THE STEP-UP'S DOOR: the second factor asked again before a verb the server gates on a fresh one. The shell answers
 * it: which factors this account has (a passkey only where this browser can run the ceremony), and one verify per
 * press. No sign-in, no sign-out, no cookie and no address passes through it; the page that opened the dialog runs
 * its parked verb once the dialog says the factor verified.
 */

/** A passkey this browser can use, a one-time code, a recovery code. */
export type StepUpFactor = "passkey" | "code" | "recovery";

/**
 * Why a verify was refused, as a word: the lock with its minutes, the throttle, the factor that did not verify, the
 * server's plain no, the window's account gone from this browser, or a sentence the shell said for anything else.
 */
export type StepUpRefusal =
  | { readonly word: "locked"; readonly minutes: number }
  | { readonly word: "slowed" | "bad_code" | "bad_passkey" | "bad_recovery" | "refused" }
  /** The browser's marker went while the dialog was up. A host with a settle step answers it; otherwise it is said. */
  | { readonly word: "owner_absent"; readonly said: string }
  | { readonly word: "said"; readonly said: string };

/** The factors this account enrolled; `passkey` already says whether this browser can run the ceremony. */
export interface StepUpFactors {
  readonly passkey: boolean;
  readonly code: boolean;
  readonly recovery: boolean;
}

export type StepUpVerified = { readonly ok: true } | { readonly ok: false; readonly refusal: StepUpRefusal };

export interface StepUpDoor {
  /** One read, as the dialog opens. A refusal is the reason the factors could not be read. */
  factors(): Promise<
    | { readonly ok: true; readonly factors: StepUpFactors }
    | { readonly ok: false; readonly refusal: StepUpRefusal }
  >;
  /** One verify: the passkey ceremony, or the code typed. It never throws. */
  verify(factor: StepUpFactor, code: string): Promise<StepUpVerified>;
}

/** What a place that parks a verb behind the dialog hands it: the same four as the prompt it replaces. */
export interface StepUpProps {
  /** Hold the surrounding page while this question stands in its host layer. */
  inline?: boolean;
  /** The press that opened this dialog after an asynchronous refusal. */
  returnFocus?: () => HTMLElement | null;
  /** The factor verified: run the parked verb, once. */
  onVerified(): void;
  /** Cancel, Esc or the scrim: nothing ran. */
  onCancel(): void;
  /** A factor landed after Cancel and was thrown away: the parked verb did not run, and the place says so. */
  onDiscarded(): void;
  /** The marker went while the dialog was up: the place settles again, and the dialog says nothing. */
  onOwnerAbsent?: () => void;
}

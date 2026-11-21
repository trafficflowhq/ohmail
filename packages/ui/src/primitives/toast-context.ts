import { createContext, useContext } from "react";

export interface ToastOptions {
  /** Action label (e.g. "Undo"). */
  action?: string;
  /** Fired at most once, when the action is pressed. */
  onAction?: () => void;
  /** The key that presses the action from anywhere ("z"), stated to assistive tech on the button. */
  actionKey?: string;
  /** Auto-dismiss in ms; defaults to 2600 (6000+ recommended with an action). */
  duration?: number;
  /** The stored deadline of an action whose window started before the report was shown. */
  actionDeadline?: number;
  /** An independently reversible mail move keeps its button through the report's fade. */
  undoDuringFade?: boolean;
  /**
   * Aborted by the caller when its window closes EARLY — leaving the Screener commits every
   * pending decision — and the Undo capsule is withdrawn at once if it still holds the slot, so a
   * dead Undo never stands above the act's own outcome.
   */
  signal?: AbortSignal;
  /**
   * A notice nobody pressed for, such as a background batch's summary. It never replaces a notice
   * the person's own act raised: it waits for that notice's window, then draws after the fade, and
   * a newer one waiting replaces it. It replaces a standing notice of its own class. Every other
   * notice still replaces whatever notice stands, so a refusal is never held back.
   */
  yields?: boolean;
  /**
   * The label of a button that closes a notice. A notice carrying it stands until that button is
   * pressed (or a newer notice replaces it); `duration` does not apply. For a sentence the person
   * must not miss, such as the window having been reloaded.
   */
  dismiss?: string;
}

export type ToastFn = (message: string, options?: ToastOptions) => void;

export const ToastContext = createContext<ToastFn | null>(null);

export function useToast(): ToastFn {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastHost>");
  return ctx;
}

/**
 * The same reader where a host may legitimately be absent — `null` rather than a throw.
 *
 * `useToast`'s throw is a real guard and stays: a surface that MEANS to say something and says it
 * into nowhere is a bug, silently. This variant is for a caller that can answer "then I will not
 * act": a view mounted bare in a test or on a surface with no toast layer must still render, and a
 * caller here has to decide what a missing host means rather than being handed a no-op that hides
 * the question. Never a stand-in `show` that drops the message on the floor.
 */
export function useOptionalToast(): ToastFn | null {
  return useContext(ToastContext) ?? null;
}

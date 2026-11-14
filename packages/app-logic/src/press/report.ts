/**
 * HOW A PRESS REPORTS: the sentence and what stands beside it. The component kit's toast takes
 * exactly this; behaviour does not import the kit, so the shape is declared here too, and the
 * compiler holds the two equal where the shell hands the kit's toast to the press seam.
 */
export interface ToastOptions {
  /** Action label (e.g. "Undo"). */
  action?: string;
  /** Fired at most once, when the action is pressed. */
  onAction?: () => void;
  /** The key that presses the action from anywhere ("z"), stated to assistive tech on the button. */
  actionKey?: string;
  /** Auto-dismiss in ms; defaults to 2600 (6000+ recommended with an action). */
  duration?: number;
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

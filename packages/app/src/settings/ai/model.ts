/**
 * Settings › AI: the account's own off switch, as data. The pane draws this and reaches nothing; the shell's hook
 * reads and writes the account's flag through an {@link AiDoor} and steps {@link aiStep} with each answer.
 *
 * Three rules the shipped pane holds, kept here as transitions so every host keeps them:
 * - the switch is not pressable before the server has answered (`enabled: null`), and a failed read leaves it so,
 *   with the sentence;
 * - a press moves the switch at once, and the server's answer is what stays;
 * - a refusal puts the switch back where it was before the press, with the server's sentence.
 */

/** What the pane draws. */
export interface AiModel {
  /** The account's flag as the server last said it; `null` while it has not answered. */
  readonly enabled: boolean | null;
  /** Why the switch stands where it stands, when a read or a write failed. */
  readonly problem: string | null;
  /** A self-hosted server said it has no model: the switch still reads the flag, and nothing will answer. */
  readonly noModel: boolean;
  toggle(next: boolean): void;
}

/** How a host reaches the account's flag. The web fills it from its server client; each call is one request. */
export interface AiDoor {
  /** The account's flag. */
  read(): Promise<boolean>;
  /** Writes the flag and answers what the server holds now. */
  set(next: boolean): Promise<boolean>;
  /** Whether the server has a model: `false` only where it said it has none, `null` where it was not asked. */
  model(): Promise<boolean | null>;
  /** The sentence for a refused write. */
  messageFor(err: unknown): string;
}

/** The switch's state without its verb. */
export type AiState = Omit<AiModel, "toggle">;

export type AiEvent =
  /** The first read answered. */
  | { readonly kind: "read"; readonly enabled: boolean }
  /** The first read failed: the flag stays unknown. */
  | { readonly kind: "unreadable"; readonly said: string }
  /** The person pressed the switch. */
  | { readonly kind: "press"; readonly next: boolean }
  /** A write answered with what the server holds. */
  | { readonly kind: "answered"; readonly enabled: boolean }
  /** A write was refused: the switch goes back to `back`, the position before that press. */
  | { readonly kind: "refused"; readonly said: string; readonly back: boolean | null }
  /** The server said it has no model. */
  | { readonly kind: "noModel" };

export const AI_START: AiState = { enabled: null, problem: null, noModel: false };

/** One answer or press, applied. A press before the server answered changes nothing. */
export function aiStep(state: AiState, event: AiEvent): AiState {
  switch (event.kind) {
    case "read":
      return { ...state, enabled: event.enabled };
    case "unreadable":
      return { ...state, problem: event.said };
    case "press":
      return state.enabled === null ? state : { ...state, enabled: event.next, problem: null };
    case "answered":
      return { ...state, enabled: event.enabled };
    case "refused":
      return { ...state, enabled: event.back, problem: event.said };
    case "noModel":
      return { ...state, noModel: true };
  }
}

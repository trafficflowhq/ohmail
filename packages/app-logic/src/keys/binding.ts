/** The overlay section a binding is listed in; the union is closed on purpose (`keymap.tsx#BINDING_GROUPS` has the order). */
export type BindingGroup = "navigate" | "message" | "screener" | "app";

/**
 * Why a binding is resting — the ONE answer the dispatcher can act on. A union of one, deliberately
 * not a second boolean beside `disabled`: every message verb is `disabled` while the list has no
 * cursor, and the dispatcher could not tell that from "this message may not be forwarded" — so the
 * FIRST press of any message verb on a fresh list did nothing (⌫ read as broken, reported from a
 * real Ohbox). The declaring site says which; omitting this keeps the old behaviour, making the
 * rule additive. A TOKEN, never a sentence: the dispatcher acts on `"no_cursor"` alone; every other
 * member is a reason the `?` sheet turns into words. Trash's two are keys that cannot work there
 * and must keep falling through.
 */
export type DisabledReason = "no_cursor" | "no_erase" | "trash_unavailable" | "layout_same";

export interface KeyBinding {
  /**
   * The chord, in the registry's notation: `"j"` · `"Enter"` · `"?"` ·
   * `"mod+k"` · `"shift+Enter"`. `mod` is ⌘ on macOS and Ctrl elsewhere —
   * one token, because the binding is the same intent on both and
   * duplicating it would let the two drift. A SPACE makes it a two-key
   * sequence: `"g o"` is g-then-o. The ⌘K palette had advertised
   * `g o`/`g r`/`g e`/`g s` since it shipped with nothing implementing
   * them; sequences exist so the palette stops lying, not because a mail
   * client needs a chord grammar.
   */
  chord: string;
  group: BindingGroup;
  /** What it does, in the user's words. This IS the overlay row. */
  label: string;
  run: (e: KeyboardEvent) => void;
  /**
   * Fire even while focus is in a text field. Default false — the typing guard exists so
   * `j` types a `j`. Escape and ⌘K opt in, because a field you cannot leave is a trap.
   */
  inInput?: boolean;
  /**
   * Fire even while a WRITING SURFACE is mounted — see {@link useWritingSurface}. Default
   * false: with the compose form on screen, a chord somebody could TYPE (a bare letter, a
   * shifted one, `?`, a `g …` sequence) or EDIT with (⌫, ⌦) reaches no binding, because a
   * blurred composer must not let writing file the message behind it. The opt-ins are the keys
   * that belong to the surface's own chrome (the send-later digits) and the `?` sheet, which
   * moves no mail and is the one place the composer's own chords are documented.
   */
  inWriting?: boolean;
  /**
   * Fire even while a page modal stands (`modal-gate.ts#pageModal`). Default false: with a dialog
   * up, a key reaches the `overlay` layer — the thing on top — and nothing behind it, wherever
   * focus fell. A global or view binding opts in only where it answers that modal itself (the
   * Reply Run's send, the palette's toggle, Compose's Escape closing its own confirm).
   */
  inModal?: boolean;
  /**
   * Declared and listed, but inert right now (nothing to act on). It still appears in the
   * overlay: a shortcut that vanishes from the documentation when the list is empty is a
   * shortcut nobody learns.
   */
  disabled?: boolean;
  /**
   * WHY it is inert — see {@link DisabledReason}. Set it only where the answer is one of that
   * union's, and only on a `disabled` row: an explanation for an active binding is a sentence
   * nothing can be true of. `"no_cursor"` is the one the dispatcher acts on; the others are read
   * by the `?` sheet, which prints the row's reason as its `title`.
   */
  disabledReason?: DisabledReason;
  /**
   * A condition ON THE EVENT, not on the app — it decides whether this keypress is ours,
   * and a `false` falls through to the next binding. It exists for exactly one thing:
   * ↵ while a button has focus belongs to the button. Anything about application state
   * belongs in `disabled`, which the overlay can see.
   */
  when?: (e: KeyboardEvent) => boolean;
}

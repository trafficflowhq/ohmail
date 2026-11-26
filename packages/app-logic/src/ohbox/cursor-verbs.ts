/**
 * THE CURSOR ROW'S VERBS BY KEY, WHERE ONE COLUMN STANDS AND NO LETTER IS OVER THE LIST. There the cursor row is the
 * list's own (`j` and `k` move it in a list that stays drawn) and no reader is mounted, so the letter's verbs are the
 * list's: Reply (`r`), Reply all (`shift+r`, the plain reply where nobody but the sender has the letter), Forward
 * (`shift+f`), Answer later (`a`), Park (`e`), Resurface (`b`: the quick return, tomorrow at the account's hour) and
 * `⌫` and `⌦`, which move the row's letter to Trash at once with its Undo. Each runs the list's own path, the one the
 * row's menu runs. And the two that ASK, as today's shell bound them there: Move (`m`: where to, then the place
 * chosen) and Delete (`d`: asks first; the ask's own Delete runs the list's delete, with its Undo). What asks is the
 * seat's to draw (`ask`); a held `d` is one press.
 *
 * Where a letter is drawn (beside the list, or over it) the reader binds these same keys for that letter, and the
 * list binds none of them: no chord is bound twice. They are declared after the list's own keys in the same layer,
 * so with rows picked the selection's verbs take the letters.
 */
import type { EngineMessage } from "@ohmail/wire";
import type { KeyBinding } from "../keys/index.js";
import { isTypingTarget } from "../keys/keymap.js";
import type { MessageAction } from "../press/actions.js";
import { deleteKeyBindings } from "../press/delete-undo.js";
import type { Translator } from "../text/translator.js";

export interface CursorVerbParts {
  readonly pendingReplyCopy: boolean;
  /** The names the key sheet lists them under (the `shortcuts` namespace). */
  readonly t: Translator;
  /** The cursor row's letter; null while the list holds no cursor. */
  readonly row: EngineMessage | null;
  /** More than one person besides the sender has the row's letter. */
  readonly replyAll: boolean;
  /** The verb reader still holds the row: a delete has something to move. */
  readonly deletable: boolean;
  readonly act: (action: MessageAction, m: EngineMessage) => void;
  /** Ask about the row's letter: where to move it, or whether to delete it. */
  readonly ask: (kind: RowAskKind, m: EngineMessage) => void;
}

/** What a cursor row's key asks before it acts. */
export type RowAskKind = "move" | "delete";

/** The question standing over a cursor row's letter, with the list's own path for its answer. */
export interface RowAsk {
  readonly kind: RowAskKind;
  readonly letter: EngineMessage;
  readonly act: (action: MessageAction) => void;
}

/** A press inside text a person edits is a character there. */
const outsideText = (e: KeyboardEvent): boolean => !isTypingTarget(e.target);

export function cursorRowKeys({
  t,
  row,
  replyAll,
  deletable,
  pendingReplyCopy,
  act,
  ask,
}: CursorVerbParts): KeyBinding[] {
  /* With no cursor they rest for want of one: the key sheet lists them, and a first press places the cursor. */
  const resting = row === null ? ({ disabled: true, disabledReason: "no_cursor" } as const) : {};
  const verb = (
    chord: string,
    label: string,
    action: MessageAction,
    more: Partial<KeyBinding> = {},
  ): KeyBinding => ({
    chord,
    group: "message",
    label,
    when: outsideText,
    run: () => {
      if (row !== null) act(action, row);
    },
    ...resting,
    ...more,
  });
  /* A letter already booked is taken out of its booking by its chooser, which a list draws none of: the key rests. */
  const booked = row?.triage?.state === "bubbled_up";
  const held = pendingReplyCopy ? { run: () => undefined } : {};
  return [
    verb("r", t("reply"), "reply"),
    verb("shift+r", t("replyAll"), replyAll ? "reply_all" : "reply"),
    verb("shift+f", t("forward"), "forward"),
    verb("a", t("answerLater"), "later", held),
    verb("e", t("park"), "aside", held),
    verb("b", t("resurface"), "resurface", booked ? { disabled: true } : {}),
    verb("m", t("move"), "move:ohbox", {
      run: () => {
        if (row !== null) ask("move", row);
      },
    }),
    verb("d", t("deleteAsk"), "delete", {
      /* A held key is one press: auto-repeat never walks the ask. */
      when: (e) => !e.repeat && outsideText(e),
      run: () => {
        if (row !== null && deletable) ask("delete", row);
      },
      ...(row !== null && !deletable ? { disabled: true } : {}),
    }),
    ...deleteKeyBindings({
      focused: row,
      label: t("deleteKey"),
      canDelete: row !== null && deletable,
      placeable: true,
      run: (m) => act("delete", m),
    }),
  ];
}

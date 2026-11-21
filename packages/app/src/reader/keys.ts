/**
 * THE COLUMN'S KEYS, declared in the key map's registry, so a chord is bound once and the key sheet lists it; where no
 * registry stands, none is bound. Never in a field, never with a modifier.
 *
 * The open letter's verbs are the panel's (`letterKeys`), named as today's keys name them, in the reader's own words:
 * a page that draws the reader alone misses none. The list that opened the letter keeps its own keys: where it
 * handed its visit, `j`, `k` and `u` are the list's and the column binds none of them; where no list did, `u`
 * presses the column's own read slot.
 */
import type { EngineMessage } from "@ohmail/wire";
import { useOptionalKeyBindings, type KeyBinding } from "@ohmail/app-logic/keys";
import { deleteKeyBindings } from "@ohmail/app-logic/press/delete-undo";
import type { MessageAction } from "@ohmail/app-logic/press/actions";
import type { ListVisit } from "@ohmail/app-logic/reading";
import { useText, type Text } from "../text/index.js";
import type { Verbs } from "./actions/use-verbs.js";

/** A field, or text a person edits (read off the attribute too, where an engine does not report it). */
const editable = (t: EventTarget | null): boolean =>
  t instanceof HTMLElement &&
  (t.isContentEditable ||
    t.closest('[contenteditable=""], [contenteditable="true"], [contenteditable="plaintext-only"]') !==
      null ||
    t.tagName === "INPUT" ||
    t.tagName === "TEXTAREA" ||
    t.tagName === "SELECT");

/** A press inside text a person edits is a character there, whatever the registry reads of the field. */
const outsideText = (e: KeyboardEvent): boolean => !editable(e.target);

/** The column's own key while it has the keyboard: `u` presses the read slot, where no list handed its visit. */
export function useReaderKeys(on: boolean, now: { verbs: Verbs; visit: ListVisit | null }): void {
  const t = useText("reader");
  const { verbs, visit } = now;
  const read: KeyBinding = {
    chord: verbs.readSlot === "markRead" ? "shift+i" : "u",
    group: "message",
    label: t(`verb.${verbs.readSlot ?? "markUnread"}`),
    when: outsideText,
    run: () => verbs.act("unread"),
  };
  useOptionalKeyBindings(on && visit === null ? [read] : [], "view");
}

/** The panel's menus a key opens as their buttons open them. */
export type PanelMenu = "resurface" | "move" | "more" | "cardDelete" | "screening" | "tag";
export const REPLY_KEY = "r";
export const FORWARD_KEY = "shift+f";

/** The open letter, its verbs and its panel's menus; null where nothing is open. */
export interface LetterKeyDoors {
  readonly letter: EngineMessage;
  readonly verbs: Verbs;
  readonly menu: (which: PanelMenu) => void;
  readonly canAnswerKey?: (id: string) => boolean;
  readonly screeningLabel?: string;
  readonly tagLabel?: string;
  readonly calendarAction?: { label: string; onPress: () => void };
}

export type DeleteKeyTarget = Pick<LetterKeyDoors, "letter" | "verbs"> & {
  readonly canDeleteKey?: (id: string) => boolean;
};

function trashKeys(t: Text, open: DeleteKeyTarget | null): KeyBinding[] {
  return deleteKeyBindings({
    focused: open?.letter ?? null,
    label: t("key.deleteKey"),
    canDelete: open !== null,
    run: (message) => {
      if (open && open.canDeleteKey?.(message.id) !== false) open.verbs.act("delete");
    },
  });
}

/** A second deliberate letter is its own press, including when focus sits on a menu item. */
export function isCardDeleteKey(e: KeyboardEvent): boolean {
  return (
    e.key === "d" &&
    !e.repeat &&
    !e.isComposing &&
    !e.ctrlKey &&
    !e.metaKey &&
    !e.altKey &&
    !e.shiftKey &&
    outsideText(e)
  );
}

/** The embedded panel shares the reader's answer, Move and Delete bindings. */
export function useCardKeys(
  on: boolean,
  open: LetterKeyDoors | null,
  deleteTarget: DeleteKeyTarget | null,
  showPanel: boolean,
): void {
  const t = useText("reader");
  const keys: KeyBinding[] =
    on && open !== null
      ? [
          ...(showPanel ? answerKeys(t, open) : []),
          {
            chord: "m",
            group: "message",
            label: t("key.move"),
            when: outsideText,
            disabled: open.verbs.moves.length === 0,
            run: () => open.menu("move"),
          },
          {
            chord: "d",
            group: "message",
            label: t("key.deleteAsk"),
            when: isCardDeleteKey,
            run: () => open.menu("cardDelete"),
          },
          ...trashKeys(t, deleteTarget),
        ]
      : [];
  useOptionalKeyBindings(keys, "global");
}

function answerKeys(t: Text, open: LetterKeyDoors | null): KeyBinding[] {
  const answer = (chord: string, label: string, action: MessageAction): KeyBinding => ({
    chord,
    group: "message",
    label: t(label),
    when: outsideText,
    run: () => {
      if (open && open.canAnswerKey?.(open.letter.id) !== false) open.verbs.act(action);
    },
    ...(open === null ? { disabled: true, disabledReason: "no_cursor" } : {}),
  });
  return [
    answer(REPLY_KEY, "key.reply", "reply"),
    answer("shift+r", "key.replyAll", open?.verbs.replyAll ? "reply_all" : "reply"),
    answer(FORWARD_KEY, "key.forward", "forward"),
  ];
}

/**
 * THE OPEN LETTER'S VERBS by key, each the panel's own path: Reply (`r`), Reply all (`shift+r`, the plain reply where
 * nobody but the sender has the letter), Forward (`shift+f`), Later (`a`), Park (`e`), Resurface (`b`), Move's picker
 * (`m`, where the list offers moves), Delete behind More (`d`: it asks, More opens on it), and `⌫` and `⌦`, which move
 * the letter to Trash at once with its Undo. With nothing open they rest for want of a cursor: the key sheet lists
 * them, and a first press places a cursor where the list holds one and says so.
 *
 * `b` is the key it was: on a letter with no booking it books the quick return at once (tomorrow at the account's
 * hour, with its sentence and its Undo); on a letter already booked it opens the chooser its button opens.
 */
export function letterKeys(ts: Text, open: LetterKeyDoors | null): KeyBinding[] {
  const resting = open === null ? ({ disabled: true, disabledReason: "no_cursor" } as const) : {};
  const act = (action: MessageAction) => () => open?.verbs.act(action);
  const show = (which: PanelMenu) => () => open?.menu(which);
  const verb = (
    chord: string,
    label: string,
    run: () => void,
    more: Partial<KeyBinding> = {},
  ): KeyBinding => ({
    chord,
    group: "message",
    label,
    when: outsideText,
    run,
    ...resting,
    ...more,
  });
  const booked = open?.letter.triage?.state === "bubbled_up";
  return [
    ...answerKeys(ts, open),
    verb("a", ts("key.answerLater"), act("later")),
    verb("e", ts("key.park"), act("aside")),
    verb("b", ts("key.resurface"), booked ? show("resurface") : act("resurface")),
    ...(open?.tagLabel ? [verb("t", open.tagLabel, show("tag"))] : []),
    ...(open?.screeningLabel ? [verb("s", open.screeningLabel, show("screening"))] : []),
    ...(open?.calendarAction ? [verb("v", open.calendarAction.label, open.calendarAction.onPress)] : []),
    verb("m", ts("key.move"), show("move"), open === null ? {} : { disabled: open.verbs.moves.length === 0 }),
    /* A held key is one press: auto-repeat never walks the ask. */
    verb("d", ts("key.deleteAsk"), show("cardDelete"), { when: isCardDeleteKey }),
    ...trashKeys(ts, open),
  ];
}

/**
 * The open letter's keys while the column has the keyboard, or resting while nothing is open.
 *
 * Under every place's own keys (`global`), where the shell's letter verbs stood: a list with rows picked binds the
 * same letters for its set at the place's rank, and the set must take them whichever of the two was declared last.
 */
export function useLetterKeys(on: boolean, open: LetterKeyDoors | null): void {
  const ts = useText("reader");
  useOptionalKeyBindings(on ? letterKeys(ts, open) : [], "global");
}

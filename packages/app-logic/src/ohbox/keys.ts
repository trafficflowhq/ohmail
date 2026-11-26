/**
 * The Ohbox's key table: the walk's keys, the selection layer that is there only while a selection exists, and the
 * cursor's keys. Declaration order is precedence inside the layer.
 */
import type { EngineMessage } from "@ohmail/wire";
import type { KeyBinding } from "../keys/index.js";
import type { BulkAction } from "../press/actions.js";
import { isModalOpen } from "../session/modal-gate.js";
import type { Translator } from "../text/translator.js";
import type { BulkVerbs, OhboxListInput, OhboxStep, PickPanel } from "./types.js";

/**
 * The document the press landed in — `e.view` first, so a press inside a portal or a second
 * window is judged against the tree it actually happened in rather than this module's global.
 *
 * Module scope: it closes over nothing in the view, and rebuilding it per render would put a
 * fresh function into a binding's `when` on every keystroke anywhere in the app.
 */
const deleteDoc = (e: KeyboardEvent): Document =>
  (e.view as (Window & typeof globalThis) | null)?.document ?? globalThis.document;

/** The modal and repeat checks run on the press so these shortcuts stay listed in key help. */
const canDeleteByKey = (e: KeyboardEvent): boolean => !e.repeat && !isModalOpen(deleteDoc(e));

/** What the key table reads. */
export interface KeyParts {
  t: Translator;
  input: OhboxListInput;
  selected: EngineMessage | null;
  order: string[];
  stepDown: OhboxStep;
  stepUp: OhboxStep;
  open: (m: EngineMessage) => void;
  extendPick: (dir: 1 | -1) => void;
  bulk: BulkVerbs;
  picked: ReadonlySet<string>;
  pickedIds: string[];
  pickPanel: PickPanel | null;
  setPickPanel: (next: PickPanel | null) => void;
  runBulk: (action: BulkAction) => void;
  deletePicked: () => void;
  requestDeletePicked: () => void;
  onAddTag: OhboxListInput["onAddTag"];
  togglePick: (id: string) => void;
  markUnread: (m: EngineMessage) => void;
  markConversationRead: (m: EngineMessage) => void;
  markPicked: () => void;
  clearPicked: () => void;
}

/** What a cursor's key carries when there is no cursor: its own reason. */
type NoCursor = { disabledReason?: "no_cursor" };

function walkKeys({
  t,
  stepDown,
  stepUp,
  selected,
  open,
  order,
  extendPick,
  noCursor,
}: KeyParts & { noCursor: NoCursor }): KeyBinding[] {
  return [
    {
      chord: "j",
      group: "navigate",
      label: t("keyNext"),
      disabled: stepDown.disabled,
      run: stepDown.run,
    },
    {
      /**
       * The exact inverse of `j`, and that has to include the way in. The Ohbox rests with NO cursor — deliberate:
       * the reading column stays at rest until somebody chooses a message — so the keys are how a reader ENTERS the
       * list, not merely how they move inside it. `j` has always had an entry move (nothing selected → first row);
       * `k` had none, declared inert whenever the cursor was not on a row — on a fresh Ohbox `j` walked the list and
       * `k` did nothing, two keys presented as a pair, one dead. The pair is one gesture in two directions, so it
       * enters from the two ends: `j` at the top going down, `k` at the bottom going up; inside the list they are
       * strict inverses over the same row order — both read the one `order` array built above. `at < 0` covers both
       * readings of "not on a row": nothing selected, and a selection standing outside the three grouped sections.
       */
      chord: "k",
      group: "navigate",
      label: t("keyPrev"),
      disabled: stepUp.disabled,
      run: stepUp.run,
    },
    {
      chord: "Enter",
      group: "message",
      label: t("keyOpen"),
      /* DECLARED DEAD WHEN THERE IS NOTHING TO OPEN, and this is new with the fallback's
         removal. `run` has always been guarded, so ↵ on an untouched Ohbox did nothing either
         way — but the `?` sheet is generated from this table, and a binding with no `disabled`
         is advertised as available. Before, the fallback meant there was always a message and
         the question never arose; now the first thing a reader sees is a resting column, and a
         key sheet promising "open the message" beside it would be documenting a dead key. `j`
         is the way in, which is what the resting column itself says. */
      disabled: selected == null,
      ...noCursor,
      // ↵ on a focused button presses the button; that is the browser's and it stays so.
      when: (e) => (e.target as HTMLElement).tagName !== "BUTTON",
      // The `: onEnterReader()` arm is gone with the boolean it depended on. It meant
      // "open the reader on nothing" — with an empty list there is no message to read, and
      // the sheet it opened rendered a `<span/>`.
      run: () => selected && open(selected),
    },
    {
      chord: "shift+ArrowDown",
      group: "message",
      label: t("keyExtendDown"),
      disabled: order.length === 0,
      run: () => extendPick(1),
    },
    {
      chord: "shift+j",
      group: "message",
      label: t("keyExtendDown"),
      disabled: order.length === 0,
      run: () => extendPick(1),
    },
    {
      chord: "shift+ArrowUp",
      group: "message",
      label: t("keyExtendUp"),
      disabled: order.length === 0,
      run: () => extendPick(-1),
    },
    {
      chord: "shift+k",
      group: "message",
      label: t("keyExtendUp"),
      disabled: order.length === 0,
      run: () => extendPick(-1),
    },
  ];
}

/**
 * The Ohbox's keys, DECLARED.
 *
 * These were a sixth `document` listener with the shell's and four other views'; they are
 * now a view layer in the registry, which means two things: they win over the global map
 * while this view is mounted (and disappear with it), and the `?` sheet lists them
 * because they exist, not because someone remembered to write them down.
 */
/**
 * The selection layer. While a selection exists, the verb letters act on it — following a rule the product
 * already has: every verb wears its keycap, and a keycap on the selection pill must do what the pill does. The
 * pill offers Later, Park, Resurface, Tag, Screening, Move, Read, Unread and Delete, so those letters mean the
 * selection while there is one and the cursor's message when there is not. Declared FIRST, because declaration
 * order IS precedence inside a layer (`ordered()` runs the first ENABLED match): `t` and `u` have cursor twins
 * below, outranked exactly while `picked.size > 0`; `a e b s m d ⌫ ⌦` have no view-level twin — their cursor
 * versions are the SHELL's, and `view` outranks the shell, the same precedence that lets the Screener own `c`.
 */

/**
 * Every one is `disabled`, not absent, without a selection: a disabled binding still appears in the `?` sheet,
 * which keeps a shortcut learnable. The cost, stated: somebody who used `x` and then a letter expecting the
 * cursor's message now acts on the pick — Gmail's model, the sheet says so in words while the selection is up,
 * and it is a real behaviour change.
 */
/**
 * And these ten are declared only while a selection exists — not `disabled`, ABSENT: the one departure from
 * "declare it and disable it", for the `?` sheet rather than the dispatcher. `groupedBindings` dedups BY CHORD,
 * one row per key, preferring an enabled declaration over a disabled one; every chord below has a twin for the
 * cursor's message (`t`/`u` in this view, `a e b s m d ⌫ ⌦` in the shell) and the view's layer is walked FIRST —
 * so a disabled selection binding won the row and the sheet taught "Park the selection" to somebody with nothing
 * selected (measured: with no pick and no cursor, `a` read "Queue the selection for the Reply Run"). Absent, the
 * sheet is right in both states and the shared dedup rule untouched; the CHORD is still listed by the twin, only
 * the label changes.
 */

/**
 * The four extend chords above are NOT in here: they have no twin, and they are how a selection STARTS — a key
 * that creates the state cannot be gated on it.
 */
export function ohboxKeys(parts: KeyParts): KeyBinding[] {
  const {
    t,
    input,
    selected,
    bulk,
    picked,
    pickedIds,
    setPickPanel,
    runBulk,
    deletePicked,
    requestDeletePicked,
  } = parts;
  /**
   * NO CURSOR IS ITS OWN REASON — spread into every `message` binding below whose `disabled` is `selected == null`.
   * See `keymap.tsx#DisabledReason`. This is the view the defect was reported against: an Ohbox nobody had touched
   * has no cursor, so ↵, `t`, `x`, `u` and `⇧I` here — and the shell's nine verbs under them — were all `disabled`,
   * and the dispatcher dropped each one before the chord was matched. Every one of those presses did nothing at all,
   * with the `?` sheet the only place that state showed. The first press now places the cursor on the first row and
   * says which verb the next press runs. NOT on `⇧U` or the four extend chords: those rest on the PICK
   * (`picked.size`, `order.length`), not on the cursor, and ⇧↓ is how a pick starts. The selection layer above is
   * absent rather than disabled when nothing is picked, so none of it can be reached by this rule either.
   */
  const noCursor = selected == null ? ({ disabledReason: "no_cursor" } as const) : {};
  const bindings: KeyBinding[] = [
    ...walkKeys({ ...parts, noCursor }),
    ...(picked.size > 0
      ? ([
          {
            chord: "a",
            group: "message",
            label: t("keySelLater"),
            run: () => runBulk("later"),
          },
          {
            chord: "e",
            group: "message",
            label: t("keySelPark"),
            run: () => runBulk("aside"),
          },
          {
            chord: "b",
            group: "message",
            label: t("keySelResurface"),
            run: () => runBulk("resurface"),
          },
          {
            /* THE PICKER NEEDS AN ANCHOR, and from a key there is no pressed element to give it. The
         pill's own Tag button is the honest one to point at: it is where the mouse path opens
         the same picker, so the popover appears in one place however it was asked for. */
            chord: "t",
            group: "message",
            label: t("keySelTag"),
            run: () => bulk.tag(pickedIds, input.anchors.pickTag()),
          },
          {
            chord: "s",
            group: "message",
            label: t("keySelScreen"),
            run: () => setPickPanel({ kind: "screen" }),
          },
          {
            chord: "m",
            group: "message",
            label: t("keySelMove"),
            run: () => setPickPanel({ kind: "move" }),
          },
          {
            chord: "u",
            group: "message",
            label: t("keySelUnread"),
            run: () => runBulk("unread"),
          },
          {
            /* The selection's Delete button and its letter share the first-use confirmation. */
            chord: "d",
            group: "message",
            label: t("keySelDeleteAsk"),
            when: canDeleteByKey,
            run: requestDeletePicked,
          },
          {
            chord: "Backspace",
            group: "message",
            label: t("keySelDelete"),
            when: canDeleteByKey,
            run: deletePicked,
          },
          {
            chord: "Delete",
            group: "message",
            label: t("keySelDelete"),
            when: canDeleteByKey,
            run: deletePicked,
          },
        ] satisfies KeyBinding[])
      : []),
    ...cursorKeys({ ...parts, noCursor }),
  ];
  return bindings.map((binding) => ({ ...binding, place: "lists" }));
}

function cursorKeys({
  t,
  selected,
  input,
  onAddTag,
  togglePick,
  markUnread,
  markConversationRead,
  markPicked,
  picked,
  pickPanel,
  setPickPanel,
  clearPicked,
  noCursor,
}: KeyParts & { noCursor: NoCursor }): KeyBinding[] {
  return [
    ...(picked.size === 0
      ? [
          {
            chord: "t",
            group: "message" as const,
            label: t("keyTag"),
            disabled: selected == null,
            ...noCursor,
            run: () => selected && onAddTag(selected.id, input.anchors.row(selected.id)),
          },
        ]
      : []),
    {
      chord: "x",
      group: "message",
      label: t("keyPick"),
      disabled: selected == null,
      ...noCursor,
      run: () => selected && togglePick(selected.id),
    },
    {
      /**
       * THE PAIR, AND WHY IT IS NOT GMAIL'S EXACT PAIR. Gmail is ⇧I to mark read and ⇧U to mark unread, and it is the
       * precedent worth following — but `shift+u` is taken here, by the bulk "mark what I picked" verb declared a few
       * lines below, and taking it back would break a shipped shortcut to match a convention. So: `⇧I` is Gmail's,
       * verbatim, and `u` keeps the key this product has always used for unread — which is also the better mnemonic
       * of the two. `u` USED TO BE A TOGGLE. See `markUnread` for why a direction is the right shape. Both are listed
       * in the `?` sheet because both declare a label, and the sheet is generated from this registry.
       */
      chord: "u",
      group: "message",
      label: t("keyMarkUnread"),
      disabled: selected == null,
      ...noCursor,
      run: () => selected && markUnread(selected),
    },
    {
      chord: "shift+i",
      group: "message",
      label: t("keyMarkRead"),
      disabled: selected == null,
      ...noCursor,
      run: () => selected && markConversationRead(selected),
    },
    {
      /**
       * THE BULK ACTION, ON THE KEYBOARD. The complaint was that multiple messages could not be selected and marked
       * seen, and the half that shipped could only be finished with a mouse: the bar's buttons are reachable by Tab,
       * but there was no way to say "mark what I picked" from the keys that made the pick, and nothing in the `?`
       * sheet mentioned that marking a selection was possible at all. Declaring it here documents it — the sheet is
       * generated from this registry and cannot list a key that does nothing. `⇧U` and not a fresh letter: `u` is
       * already "mark read / unread" at the cursor, so the shifted twin is the same verb over the selection.
       * `chordMatches` keeps plain `u` from swallowing it.
       */
      chord: "shift+u",
      group: "message",
      label: t("keyMarkPicked"),
      disabled: picked.size === 0,
      run: () => markPicked(),
    },
    {
      /**
       * ESCAPE CANCELS THE OPEN SUB-ROW BEFORE IT CLEARS THE SELECTION. FIRST in this array, and the array's order IS
       * the precedence — `ordered()` walks a layer's bindings in declaration order and the first match runs
       * (`keymap.tsx`). So this is stated where precedence lives rather than as a condition inside the clear binding,
       * which is the shape that rots. It matters most for the confirm row: that row is the last moment before a
       * consent decision commits, and an Escape that blew past it to clear the selection would leave the user with
       * neither the confirmation nor the set they had built. NO NEW `document` LISTENER — there are already five,
       * measured. This is a registry binding in the view layer, which the shell's `overlay` scope still outranks, so
       * a `?` sheet or the palette opened over this closes first and the sub-row survives.
       */
      chord: "Escape",
      group: "message",
      label: t("keyCancelBulk"),
      disabled: pickPanel == null,
      run: () => setPickPanel(null),
    },
    {
      /**
       * Escape clears the selection — when nothing is open on top of it. This used to read `picked.size === 0 ||
       * chrome.replyTo != null`, and the second clause is the whole story. The reply tests went red the moment a
       * selection survived into the reply editor — "r opened an inline editor but Esc did not close it" — because
       * this VIEW binding outranked the shell's Escape cascade unconditionally and cleared the selection instead. The
       * patch taught this view to name ONE of the shell's overlays, which left the `?` sheet, the ⌘K palette and the
       * screening popover broken in exactly the same way and put the next overlay one line from joining them.
       */

      /**
       * The condition is gone because the precedence is stated where precedence lives: the shell's Escape is
       * registered in the `overlay` scope, which outranks every view layer while something is open and stands down
       * when nothing is (`keymap.tsx`). So this binding is once again only about this view — a picked set is the
       * innermost thing the OHBOX has — and it knows nothing about what the shell may be showing.
       */
      chord: "Escape",
      group: "message",
      label: t("keyClear"),
      disabled: picked.size === 0,
      run: clearPicked,
    },
  ];
}

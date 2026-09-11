"use client";

/**
 * The message verbs, over a view's own cursor — one declaration for every view that shows a message beside a list the
 * shell cannot see into. Folder, Tag and History mount the action bar, whose buttons print keycaps, and nine of those
 * keys did nothing there: the shell's global bindings act on `focused`, and in a split view the message on screen is
 * that view's own `shown`, local state the shell has no arm for — so the bindings register `disabled: true` while the
 * bar goes on printing the cap.
 */

/**
 * The bar is RIGHT to print it (`keymap.tsx`: a disabled owner still owns the key, and a cap that blinks out teaches
 * people to stop reading caps), so the fix is to WIRE the verbs — `TriageView` reached the conclusion first, and nine
 * verbs repeated in three files is how three views come to disagree about what `d` does.
 */

/**
 * Every gate is resolved by the SHELL and passed in, never re-derived here — `canDelete` is the
 * sharpest example: the delete ceremony's gates are the strip's own render gates, and a second
 * reading here would be a second answer to "may this be deleted", with the sheet advertising a
 * delete the bar refuses to draw. The cursor must be the message on screen, on BOTH layouts:
 * `TriageView` has the scar — where `openRow` set the cursor only on the wide layout, the narrow one
 * raised the reader on the tapped row while `shown` pointed at the first row, so a verb filed or
 * deleted a different person's mail. A host wiring these verbs sets its cursor FIRST and
 * unconditionally; stated here because this hook is what makes the bug reachable.
 */

import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { useKeyBindings } from "./keymap";
/* The two destructive chords, from the module that owns them — see the `⌫ · ⌦` binding below. */
import { deleteKeyBindings } from "./delete-undo";
import { useMessageChrome } from "./message-chrome";
import type { MessageAction } from "./MessagePane";

export interface MessageVerbsInput {
  /**
   * The message this view's reading column is showing — the view-local cursor. `null` disables
   * every verb rather than dropping them: a declared-but-disabled binding still owns its chord,
   * which is what stops a global binding with nothing to act on from answering underneath.
   */
  shown: EngineMessage | null;
  /**
   * This view's row scope, e.g. `".view-folder"`. Two verbs anchor a menu to the row they act
   * on, and an anchor resolved against `.view` alone would find another view's row on a surface
   * that mounts two.
   */
  scope: string;
  /** The pane's own dispatch seam — key and button stay one code path. */
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /** The sender menu — `s`'s target, the same one the bar's Screening button opens. */
  onScreen: (messageId: string, anchor: HTMLElement | null) => void;
  /**
   * MAY THIS MESSAGE BE DELETED — the strip's own render gates, resolved by the shell. See the
   * header for why this is not computed here.
   */
  canDelete: (message: EngineMessage) => boolean;
  /**
   * Whether a reply-all is possible for this message — `replyAllRecipients(m, ownAddresses)
   * !== null`, resolved by the shell for the same reason `canDelete` is: the address set is the
   * account's, not a view's.
   */
  canReplyAll: (message: EngineMessage) => boolean;
}

/** The row a verb should anchor its menu to, or null when the window has not mounted it. */
function anchorFor(scope: string, id: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`${scope} .row[data-id="${CSS.escape(id)}"]`);
}

/**
 * Declare the message verbs for one view. Call it once, after the view's cursor is resolved.
 *
 * The chords, the groups and the labels are the shell's — a `?` sheet must read one sentence for
 * `a` whether the Ohbox's binding answers or this one does — and only the target changes.
 */
export function useMessageVerbs(input: MessageVerbsInput): void {
  const { shown, scope, onAction, onAddTag, onScreen, canDelete, canReplyAll } = input;
  /* THE LABELS ARE READ HERE, not passed in, and that is the point of reading them at all: the
     `?` sheet must print one sentence for `a` whether the Ohbox's binding answers or this one
     does. A host that supplied its own wording would be a second copy of every verb's name.
     `tag` is the one that lives outside the `shortcuts` namespace — `OhboxView` declares `t`
     against `ohbox.keyTag` and this binding quotes the same key rather than minting a synonym. */
  const ts = useTranslations("shortcuts");
  const to = useTranslations("ohbox");
  const labels = {
    reply: ts("reply"), replyAll: ts("replyAll"), forward: ts("forward"),
    answerLater: ts("answerLater"), park: ts("park"), resurface: ts("resurface"),
    screen: ts("screen"), move: ts("move"),
    deleteAsk: ts("deleteAsk"), deleteConfirm: ts("deleteConfirm"), deleteKey: ts("deleteKey"),
    tag: to("keyTag"),
  };
  const chrome = useMessageChrome();
  const barPanel = chrome.barPanel;
  const setBarPanel = chrome.setBarPanel;

  /** Every verb rests on a view with no cursor. One predicate so none of them can forget it. */
  const none = shown == null;
  /**
   * …AND THE REASON, so the dispatcher can offer to place the cursor rather than drop the key — see
   * `keymap.tsx#DisabledReason`. Spread into every binding whose `disabled` is `none` or `none || <something else>`:
   * when `none` is false this object is EMPTY, so a verb resting for its own reason (a 1:1 message, a `no_forward`
   * one, no chrome to open a strip in) keeps falling through exactly as it does today. WHAT THIS DOES AND DOES NOT
   * BUY IN THESE THREE VIEWS. Folder, Tag and History hold their cursor in view-local state and claim no
   * `useCursorPlacer`, so the innermost claim is the shell's, which answers `false` for a route it holds no cursor
   * for — the key stays as inert as it is today. The declaration is here because it is TRUE of the binding and
   * because the host that supplies a placer is the only thing missing; a gap row names that half.
   */
  const parked = none ? ({ disabledReason: "no_cursor" } as const) : {};

  useKeyBindings([
    /**
     * ⌫ AND ⌦ — the same two chords the shell declares over its own cursor, declared here over THIS view's. They were
     * missing, and the shape of the miss is this file's founding defect exactly: the shell's bindings act on
     * `focused`, which is null in a split view, so Tag, Folder, History and Triage showed a message with a visible
     * cursor on it and both keys did nothing. Nine keycaps were dead in these three views for that reason before;
     * this is the tenth and eleventh, caught by review before anybody had to report them. The FACTORY and not a
     * hand-written pair: the chords, the label, the auto-repeat guard and the DOM modal gate are one spelling, so the
     * shell's `⌫` and this one cannot come to mean different things. `canDelete` is the host's — the same strip
     * render gates, resolved by the shell for the reason the header states, and never re-derived here.
     */
    ...deleteKeyBindings({
      focused: shown,
      label: labels.deleteKey,
      canDelete: shown != null && canDelete(shown),
      run: (m) => onAction("delete", m),
    }),
    {
      chord: "r",
      group: "message",
      label: labels.reply,
      disabled: none,
      ...parked,
      run: () => shown && onAction("reply", shown),
    },
    {
      /* Gated exactly as the bar's own Reply-all button is: a 1:1 message has nobody else to
         answer, and a key that dispatched anyway would compose a reply the send path then
         resolves to the same single recipient. */
      chord: "shift+r",
      group: "message",
      label: labels.replyAll,
      disabled: none || !canReplyAll(shown!),
      ...parked,
      run: () => shown && onAction("reply_all", shown),
    },
    {
      /* `⇧F` carries the sensitivity gate its button carries (`ActionBar#canForward`). The
         mirror half of the shell's gate is not repeated: a row this view is showing is a row it
         resolved out of the list it renders. */
      chord: "shift+f",
      group: "message",
      label: labels.forward,
      disabled: none || shown!.sensitivity?.no_forward === true,
      ...parked,
      run: () => shown && onAction("forward", shown),
    },
    {
      chord: "a",
      group: "message",
      label: labels.answerLater,
      disabled: none,
      ...parked,
      run: () => shown && onAction("later", shown),
    },
    {
      chord: "e",
      group: "message",
      label: labels.park,
      disabled: none,
      ...parked,
      run: () => shown && onAction("aside", shown),
    },
    {
      chord: "b",
      group: "message",
      label: labels.resurface,
      disabled: none,
      ...parked,
      run: () => shown && onAction("resurface", shown),
    },
    {
      /* SCREENING — this SENDER's future mail, anchored to the row so the menu opens where the
         eye already is. The shell's own `s` anchors against `.view`; this one is scoped, because
         the anchor has to be THIS view's row. */
      chord: "s",
      group: "message",
      label: labels.screen,
      disabled: none,
      ...parked,
      run: () => shown && onScreen(shown.id, anchorFor(scope, shown.id)),
    },
    {
      chord: "t",
      group: "message",
      label: labels.tag,
      disabled: none,
      ...parked,
      run: () => shown && onAddTag(shown.id, anchorFor(scope, shown.id)),
    },
    {
      /* MOVE — the bar's destination strip, through the chrome that every mount of that bar
         renders from, so the row opened by key here is the row the reader sheet shows. A toggle,
         the shell's own convention. Declared disabled where no chrome provides the setter: the
         strip is what the key opens, and a key that cannot open it must not claim it can. */
      chord: "m",
      group: "message",
      label: labels.move,
      disabled: none || !setBarPanel,
      ...parked,
      run: () => {
        if (!shown || !setBarPanel) return;
        setBarPanel(
          barPanel?.panel === "move" && barPanel.messageId === shown.id
            ? null
            : { messageId: shown.id, panel: "move" },
        );
      },
    },
    {
      /* DELETE — the shell's two-press ceremony, verbatim: the first press ASKS, the second
         clicks the strip's own danger button, so `"delete"` keeps exactly one dispatch site. */
      chord: "d",
      group: "message",
      label: barPanel?.panel === "delete" ? labels.deleteConfirm : labels.deleteAsk,
      disabled: none || !setBarPanel || !canDelete(shown!),
      ...parked,
      /* A HELD KEY IS ONE PRESS — auto-repeat would walk the ask and the confirm on its own,
         turning a finger resting on `d` into an un-undoable delete. The shell's binding states
         this as a review finding; the same ceremony needs the same guard. */
      when: (e) => !e.repeat,
      run: () => {
        if (!shown || !setBarPanel) return;
        if (barPanel?.panel === "delete" && barPanel.messageId === shown.id) {
          document.querySelector<HTMLButtonElement>(".abar-delete .abar-danger")?.click();
        } else {
          setBarPanel({ messageId: shown.id, panel: "delete" });
        }
      },
    },
  ]);
}

"use client";

/**
 * THE MESSAGE VERBS, OVER A VIEW'S OWN CURSOR — one declaration, for every view that shows a
 * message beside a list the shell cannot see into.
 *
 * ══ THE DEFECT THIS EXISTS TO CLOSE ═══════════════════════════════════════════════════════
 *
 * Folder, Tag and History mount the message pane — and with it the action bar, whose every
 * button prints the keycap for its verb. Nine of those keycaps did nothing in those three views:
 * `r`, `⇧R`, `a`, `e`, `b`, `s`, `t`, `m` and `d`. Pressing them was silent — no request, no
 * toast, no state change — while the button beside the keycap worked, and the same key worked in
 * the Ohbox.
 *
 * The cause is structural rather than a missing case. The shell's global bindings all act on
 * `focused`, which is the reader's message or the Ohbox's cursor; in a SPLIT view the message on
 * screen is that view's own `shown`, a piece of local state the shell has no arm for. So every
 * one of those bindings registers with `disabled: true` here — correctly, since it has nothing to
 * act on — and the bar goes on printing the cap.
 *
 * ── AND THE BAR IS RIGHT TO PRINT IT, WHICH IS WHY THE FIX IS TO WIRE ──────────────────────
 *
 * `MessagePane`'s `Key` renders a cap for a bound-but-disabled chord deliberately, and
 * `keymap.tsx` states the reason where `useBinding` is defined: *"a disabled owner still owns the
 * key, and the cap must not vanish while the verb rests"*. That is the right rule for a verb that
 * is momentarily unavailable — Reply-all on a 1:1 message, Forward on a `no_forward` one — because
 * a cap that blinks out as the cursor moves teaches people to stop reading caps. It is the wrong
 * outcome only when NOTHING is wired, and those two cases are indistinguishable from the bar.
 *
 * So suppression would have bought a quieter bar by making every resting verb's cap flicker, and
 * it would have left the keys still dead. The verbs are wired instead, which is what the keycap
 * always meant. `TriageView` reached the same conclusion first and declares its own set inline
 * ("views declare their own"); this module is that idea made reusable, because nine verbs
 * repeated in three files is how three views come to disagree about what `d` does.
 *
 * ══ WHAT A HOST OWES, AND WHY EACH PIECE COMES FROM OUTSIDE ═══════════════════════════════
 *
 * Every gate below is resolved by the SHELL and passed in, never re-derived here. `canDelete` is
 * the sharpest example: the delete ceremony's gates are the strip's own render gates (the folders
 * consent, and the mirror actually holding the row), they live on `AppShell`'s `consent` and
 * `reader`, and a second reading of them in this module would be a second answer to "may this be
 * deleted" — with the failure mode that the sheet advertises a delete the bar refuses to draw.
 *
 * ══ THE CURSOR MUST BE THE MESSAGE ON SCREEN, ON BOTH LAYOUTS ═════════════════════════════
 *
 * Every verb here reads `shown`. `TriageView` has the scar: where a view's `openRow` set the
 * cursor only on the WIDE layout, the narrow one raised the reader on the tapped row while
 * `shown` still pointed at the first row of the list — so a verb filed, forwarded or deleted a
 * different person's mail than the one being read. A host wiring these verbs must set its cursor
 * FIRST and unconditionally. Stated here because this hook is what makes the bug reachable.
 */

import { useTranslations } from "next-intl";
import type { EngineMessage } from "@ohmail/client-engine";
import { useKeyBindings } from "./keymap";
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
    deleteAsk: ts("deleteAsk"), deleteConfirm: ts("deleteConfirm"),
    tag: to("keyTag"),
  };
  const chrome = useMessageChrome();
  const barPanel = chrome.barPanel;
  const setBarPanel = chrome.setBarPanel;

  /** Every verb rests on a view with no cursor. One predicate so none of them can forget it. */
  const none = shown == null;

  useKeyBindings([
    {
      chord: "r",
      group: "message",
      label: labels.reply,
      disabled: none,
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
      run: () => shown && onAction("forward", shown),
    },
    {
      chord: "a",
      group: "message",
      label: labels.answerLater,
      disabled: none,
      run: () => shown && onAction("later", shown),
    },
    {
      chord: "e",
      group: "message",
      label: labels.park,
      disabled: none,
      run: () => shown && onAction("aside", shown),
    },
    {
      chord: "b",
      group: "message",
      label: labels.resurface,
      disabled: none,
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
      run: () => shown && onScreen(shown.id, anchorFor(scope, shown.id)),
    },
    {
      chord: "t",
      group: "message",
      label: labels.tag,
      disabled: none,
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

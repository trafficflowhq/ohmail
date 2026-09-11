"use client";

/**
 * One message anatomy for the Ohbox read column AND the reader overlay:
 * from-line, subject, chips (routing rationale, tracker shield, tags,
 * add-affordance), body or the protected-OTP block, attachment, actions.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FOLDER_OF_VIEW, isProtectedMessage, isResurfaced, type EngineMessage, type OhmailView, type TagDTO } from "@ohmail/client-engine";
import { Button, Chip, DatePicker, Icon, InfoNote, Kbd, ProtectedBlock, ReadingPane } from "@ohmail/ui";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { isPreviewable } from "../components/AttachmentPreview";
import { opensInSystemViewer } from "./open-attachment";
import { MessageBody } from "../components/MessageBody";
import { ConversationPanels } from "./Conversation";
import { MessageHeader } from "./MessageCard";
import type { BlockNotice } from "../components/BlockNotice";
import { PLACE_LABEL, dayNine, dayValue, hueOf, nextWeekNine, tagsOfMessage, tomorrowNine, withheldCopyKey } from "./format";
import { activeFormatLocale } from "./locale";
import { replyAllRecipients } from "./compose-from";
import { useBarDensity } from "./bar-density";
import { InlineReply } from "./InlineReply";
import { inlineForwardKey } from "./mail-send";
import { chordKeys, useBinding, useKeyPress, useModGlyph } from "./keymap";
import { useBodyStalled, useMessageChrome, type MessageBarPanel } from "./message-chrome";
import { subscribeSessionRevival, useSessionDead } from "./session-truth";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";
import "./action-bar.css";

/**
 * MOVE CARRIES ITS DESTINATION.
 *
 * It used to be a bare `"move"` that AppShell answered with a toast reading "Demo — Move
 * isn't wired yet." — on live, paying accounts. The mutation it needed has been on the
 * wire the whole time (`POST /messages/:id/move`, contract-tested), and the only thing
 * missing was a destination, so the action carries one. A template member rather than a
 * second callback argument: every pass-through of `onAction` keeps compiling unchanged.
 */
export type MoveTarget = Extract<OhmailView, "ohbox" | "reads" | "receipts" | "screened" | "spam">;
/**
 * `"unread"` is the FALLBACK arm of the read toggle, not its normal path — see
 * {@link ActionBar}. The shell answers it by dispatching the same `mark_seen` the `u` key
 * dispatches; it is reached only where `u` is not bound (the desktop shell, a test with no
 * keymap provider), and it is deliberately a toggle rather than a direction so that no
 * caller has to know the current state to use it correctly.
 */
export type MessageAction =
  /**
   * PUT THIS MESSAGE BACK WHERE IT WAS — dispatched only from the Trash reading pane's one
   * primary verb and from `⇧⌫` there. It is not a filing verb and carries no folder: the
   * destination was recorded when the message was deleted and is resolved by the server, so a
   * client naming one would be a second opinion about somebody's own mail.
   *
   * The shell answers it by opening a HELD window exactly as the delete key does, for the same
   * reason — there is no un-restore on the wire — so the row leaves the list at the press and
   * the request goes out when the Undo window closes.
   */
  | "restore"
  | "reply"
  /**
   * Reply to EVERYONE on the message — sender plus the other To/Cc recipients. Dispatched only
   * from a control that `replyAllRecipients` allowed to render, so a 1:1 message never offers
   * it; the shell resolves the same call again at send time (`AppShell.sendReply`).
   */
  | "reply_all"
  /**
   * Forward this message on — the third verb of the "answer it" family, once reachable only from a
   * panel's ⋯ menu (reported from real use: it belongs in the pill beside Reply). A row verb on the
   * bar now (`.abar-fwd`, admitted whenever the measured row has room) and an `mm-fwd` item behind
   * More otherwise — the in-the-row-or-in-the-menu rule. The shell answers with `openForward` — the
   * reply dock in forward mode, docked to THIS message, the seam the panel menus always dispatched.
   * NOT a toggle, deliberately: `openForward` refuses a `no_forward` original with a toast, and a
   * verb whose second press means "close" would swallow that refusal on the second try.
   */
  | "forward"
  | "later"
  | "aside"
  | "resurface"
  /**
   * Resurface AT a chosen instant. Plain `"resurface"` is the horizon-less default the keyboard
   * and the palette still dispatch (the shell resolves it to next Friday); the popover on the
   * bar's Resurface button feeds a specific ISO through this variant — tomorrow, next week, or a
   * picked day. Encoded in the action rather than added as a second `onAction` argument for the
   * reason `move:${MoveTarget}` is: every pass-through of `onAction` keeps compiling unchanged.
   */
  | `resurface:${string}`
  /**
   * RESURFACE NOW — the horizon chooser's fourth answer, and a different KIND of answer from the other three. Not
   * `resurface:<a moment ago>`, and the distinction is the whole point. The three dated answers all write
   * `bubbled_up` with a future instant and wait for a bubble-up pass to flip them; a past instant in that same
   * variant would be a promise nobody keeps — the pass is gated behind the worker's cycle, and a standalone desktop
   * install runs no worker. So "now" is its own member, dispatching the direct `resurfaced` transition the server
   * accepts, and the row is pinned by the time the request returns.
   */
  | "resurface_now"
  /**
   * DONE WITH A RESURFACE — the deliberate release, named. The release has existed as long as the pin has: a
   * deliberate `mark_seen` (no `via`) spends it, stamps `lastReadAt`, and the row files at the top of "Earlier". What
   * it never had was a face — the only doors were "Mark as read", `⇧I` and the bulk verbs, none of which says "this
   * resurface is finished". This action is that face, NOT a new mechanism: the shell answers it with the same
   * `mark_seen` every deliberate read dispatches, plus a `triage_set: none` first when the message is merely
   * SCHEDULED (`bubbled_up`) rather than pinned — cancelling the booking is the release's other half there, and it is
   * the existing triage vocabulary, no new wire verb anywhere.
   */
  | "resurface_done"
  | "draft"
  | "unread"
  /**
   * DELETE — the one destructive verb, and it is a MOVE: the engine's `message_delete` files the message to the
   * provider's own \Trash folder and NEVER expunges (FOLDERS-SPEC.md §16.3; the product rule lives at
   * `packages/core/src/adapters/imap-types.ts`, the third user-commanded write). Gated on the mirror holding the row
   * (`chrome.mirrorHolds`) — and NOT on the folders foundation flag, which files nothing and never did — and
   * dispatched ONLY from the confirm strip the ⋯ menu opens — there is no un-delete on the wire, so the ceremony is a
   * confirm, never an undo the product could not honour. The mobile reader ships the identical ceremony, and a parity
   * test on its side pins the two surfaces' wording to this catalogue, word for word.
   */
  | "delete"
  | `move:${MoveTarget}`;

/** The DecisionBar's vocabulary, so filing means the same thing everywhere. */
export const MOVE_TARGETS: MoveTarget[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/**
 * The same verbs, over a selection. Declared beside {@link MessageAction} rather than in the view that renders the
 * bulk bar, because the point is ONE vocabulary: the selection used to offer only ⇧U and Escape; it gets the action
 * bar's own grouping minus the one verb that cannot mean anything over a set. `later`/`aside`/`resurface` — the three
 * horizons, unchanged. `move:<view>` — this message relocated, per message, no rule. `read`/`unread` — DIRECTIONS,
 * not a toggle, the one deliberate divergence: one message has a read state to flip, a selection has a MIXED one, and
 * "toggle eleven messages" would mark six read and five unread in one gesture.
 */

/**
 * `delete` — the set filed to the provider's native \Trash, one `message_delete` per id, through the SAME
 * delayed-commit window a single delete opens (`delete-undo.ts`): a member of this union, not a separate callback,
 * because it IS the same verb over more rows — one window, one toast, one Undo; the ask belongs to the surface, the
 * only dispatch site stays the window. Screening is NOT in this union: a decision about senders with a consent
 * ceremony of its own, so it travels as its own callback — folding it in would be the design error the ruling names
 * by name.
 */
export type BulkAction =
  | "later"
  | "aside"
  | "resurface"
  | "read"
  | "unread"
  | "delete"
  | `move:${MoveTarget}`;

/**
 * Which sub-row has taken the bar's place, if any. `null` is the resting bar. It was a `moving` boolean. A second
 * disclosure (More) made two booleans able to be true at once, which is a state the bar has no rendering for — a
 * union cannot express it. `"more"` is GONE from this union and that is the shape of the change, not a detail of it.
 * A disclosure and a question are different things: Move and Resurface each ask WHERE or WHEN, and a strip that
 * replaces the bar with the possible answers and a Cancel is the right ceremony for a question. "More" asked nothing
 * — it swapped the row for a different row in the same place, with no visible connection to the press. That is a
 * menu, and a menu is what it is now ({@link MoreMenu}), anchored to the button that opened it. What is left here is
 * exactly the two ceremonies.
 */
type BarPanel = MessageBarPanel;

/**
 * WHICH CONTROL A BAR PANEL WAS OPENED FROM, so cancelling puts the keyboard back on it. A KIND and not the element,
 * and that is forced rather than chosen: the panel REPLACES the row, so the button that was pressed is unmounted
 * while the strip is up and the node the press came from is detached by the time the cancel runs. `element.focus()`
 * on a detached node does nothing and reports nothing, which is the same silence the bug being fixed here already
 * had. The row's own refs are re-bound on the render that brings the row back, so the restore reads them from an
 * effect after that render rather than from the handler. `"more"` is the disclosure menu — Delete's only door, and
 * where Resurface and Move stand once the bar is narrow enough to fold them.
 */

/**
 * No record at all means nothing in this bar opened the panel: `m` and `d` open it from the shell's keymap, and a key
 * press has no control to go back to, so the keyboard stays where the person left it.
 */
type PanelTrigger = "resurface" | "move" | "more";

/**
 * THE OPEN PANEL, RESOLVED THROUGH THE CHROME WHERE A SHELL PROVIDES ONE — the reply-draft rule (`message-chrome.tsx`
 * header) applied to the bar's strip: this bar is mounted in the reading column AND the reader sheet (and on the open
 * stream card), and a Move row opened by key in one must be the row the reader is looking at in the other. The chrome
 * keys the panel by message id, so a different message's bar always renders at rest. The local `useState` is the
 * PROVIDER-LESS fallback (the desktop shell, bare view tests): no chrome setter means each mount keeps its own strip,
 * exactly the pre-chrome behaviour, which is honest where only one mount can exist. Both arms clear on a message
 * change — a half-open destination row must not carry over (the rule both hosts already stated).
 */
function useBarPanel(messageId: string): [BarPanel | null, (next: BarPanel | null) => void] {
  const chrome = useMessageChrome();
  const [localPanel, setLocalPanel] = useState<BarPanel | null>(null);
  useEffect(() => setLocalPanel(null), [messageId]);
  const set = chrome.setBarPanel;
  if (set) {
    return [
      chrome.barPanel?.messageId === messageId ? chrome.barPanel.panel : null,
      (next) => set(next ? { messageId, panel: next } : null),
    ];
  }
  return [localPanel, setLocalPanel];
}

/**
 * A verb's keycap, READ FROM THE LIVE REGISTRY. Renders nothing when nothing is bound to `chord` here, which is the
 * whole point: the bar cannot advertise a key that does not work, and it cannot go stale when a chord moves.
 * `chordKeys` is the same notation the `?` sheet prints, so `⌘`/`⇧`/`↵` would render identically in both places if a
 * bar verb ever took a modifier. This replaces `kbdHint="s"` — one hand-typed hint on one of eight buttons, which
 * read as a stray `s` in the label row. EXPORTED because the selection pill is this pill, mounted over a set in the
 * list column's foot, and its verbs carry their keys under the same law. Importing it is what keeps the two mounts
 * from growing two notions of a keycap; the phone rule that hides them is one CSS rule over `.abar kbd`, so it covers
 * both by construction.
 */
export function Key({ chord }: { chord: string }) {
  const binding = useBinding(chord);
  const mod = useModGlyph();
  if (!binding) return null;
  return <Kbd>{chordKeys(chord, mod).join(" ")}</Kbd>;
}

/**
 * The action bar. Reported from real use: it breaks a line, does not show its shortcuts, and needs to handle
 * read/unread sensibly. The grouping is the actual fix — the eight buttons this replaces were eight peers in one
 * wrapping row, and they answer three different questions: ANSWER IT (Reply, the accent verb; Draft reply in More);
 * NOT NOW (Answer Later, Park, Resurface — the same idea at three horizons, so ONE segmented control with hairlines,
 * not three siblings competing with Reply); FILE IT (Screening — this SENDER's future mail — and Move — THIS message:
 * one control, two scopes, adjacent but two buttons, because folding Screening into Move would undo the reason it is
 * here). Beside them, not among them, the READ SWITCH — a state, not a filing decision, separated by
 * `margin-left:auto`.
 */

/**
 * Layout is in `action-bar.css`; a group is atomic, so the row cannot break mid-group — a narrow container drops
 * whole groups into More.
 */

/**
 * Every verb shows its key, and not by being told: each `<Key chord>` asks the registry. Before this the bar carried
 * exactly one hint — `kbdHint="s"`, typed at the call site — while `r`, `a`, `e`, `b` and `u` were live and silent;
 * that single hint is the stray `s` in the report. And the read switch does not fight the reader: `u` is already
 * bound in `OhboxView`, where marking unread sets a `pinnedUnread` ref the 2 s dwell checks when its timer fires
 * (`test/ohbox-read-state.test.ts` — "`u` is not undone by a dwell that is already ticking"). A button dispatching
 * `mark_seen` on its own could not set that pin, so a click inside the dwell window would be reverted two seconds
 * later. So the switch does not re-implement the verb — it PRESSES THE KEY: one handler, one pin, one place where
 * "reading has happened" is decided.
 */

/**
 * `onAction("unread")` is the fallback for surfaces where `u` is not bound (the desktop shell, a pane with no keymap
 * provider) — the only arm that can drift, which is why it is the arm never taken in the product.
 */
function ActionBar({
  message,
  now,
  panel,
  onPanel,
  onAction,
  onScreen,
  onTag,
  trash,
}: {
  message: EngineMessage;
  /**
   * THE BAR OVER A MESSAGE THAT IS IN TRASH — one primary verb and the read switch, nothing else, decided by an EARLY
   * RETURN below rather than by gating each of the eleven groups. Every other verb here is wrong over a trashed row
   * and wrong in a different way: the filing segment would move mail out of Trash by a route that records no restore,
   * the three horizons would schedule a return for a message that is not in a pile, Tag would label mail on its way
   * out, and Delete would ask to delete something already deleted. Gating them one by one would be eleven predicates
   * that all say the same thing, and the twelfth group somebody adds would arrive ungated — the "fix the path you are
   * looking at and the one beside it" failure by construction. The read switch STAYS.
   */

  /**
   * Reading a message in Trash is reading, the flag is the mailbox's own and the write is `\Seen`, which is
   * legitimate for a reader and unrelated to where the message sits.
   */
  trash?: boolean;
  /** The clock the resurface presets are computed against — tomorrow/next week from here. */
  now: Date;
  panel: BarPanel | null;
  onPanel: (next: BarPanel | null) => void;
  onAction: (action: MessageAction) => void;
  onScreen: (anchor: HTMLElement | null) => void;
  /**
   * Add a tag, anchored on the control that opened the picker. ABSENT on the stream surfaces
   * (Reads/Receipts) whose bar carries no tagging; when absent the Tag verb is in neither the
   * row nor the menu, rather than a control that opens nothing.
   */
  onTag?: (anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");
  /* Forward's label, read from where the verb's copy already lives (`message.menuForward`, the
     panel ⋯ menu's own string) rather than copied into an `ohbox.actionForward` beside it. The
     pill and the panel menu are the SAME verb, so they must be the same words; a second key is a
     second source of copy, and the two would drift the first time one of them was reworded. The
     cross-namespace read is the pattern the Screening button already uses (`tr("action")`). */
  const tm = useTranslations("message");
  /* "today", for the date picker's cell label — the Screener's own word for it, read across the
     namespace as `tr("action")` is, rather than a second copy of the same word. */
  const ts = useTranslations("screener");
  /* Trash's own words — one namespace for the view, its verb and its four toasts, so the pill
     and the toast that follows a press cannot be worded apart. */
  const tt = useTranslations("trash");
  const press = useKeyPress();
  const chrome = useMessageChrome();
  /** The runtime density measurement — which groups ACTUALLY fit; see `bar-density.ts`. */
  const density = useBarDensity();
  /**
   * May the delete confirm be on screen at all — the mirror actually holding the row. Hoisted out of the render
   * conditional because the effect beside it must ask the SAME question, and two spellings of "may this strip be
   * drawn" is how the strip and its open-state come to disagree. "Use folders" was the first term and is gone: Delete
   * files to the server's own \Trash, not a user folder, so the flag was never a fact about this strip and the
   * engine's `message_delete` never read it — meanwhile the same verb over a selection never read it either, so a
   * folders-off account could delete a picked pile and not the row under its cursor (one verb, one admission; see
   * `AppShell`'s `canDeleteMessage`).
   */

  /**
   * `mirrorHolds` ABSENT is a shell with no mirror probe (the desktop, a bare mount) and `!== false` ADMITS there —
   * "this shell has no such thing" is not "this shell answered no"; a shell that answers `false` (a Search hit the
   * mirror deliberately does not hold) gets no strip, because offering a mutation over an absent local row is a
   * control that always fails.
   */

  /**
   * What the effect below can still withdraw: the mirror, now the only operand. A flag flip
   * used to be the one way to watch that effect from a mounted shell — dropping the row also
   * moves the cursor, and the shell clears the bar's panel on a cursor move, so the shell-level
   * test stayed green with the effect deleted. With the flag no longer a gate, the guard lives
   * where the operands ARE independent: `action-bar.test.ts` flips `chrome.mirrorHolds` in
   * place under an open strip and asserts `onPanel(null)` fired, not merely that the strip is
   * undrawn; `delete-confirm-ghost.test.tsx` keeps the flag sequence as the INVERTED case — the
   * strip must now survive it.
   */
  const deleteConfirmAdmitted = chrome.mirrorHolds?.(message.id) !== false;

  /** The delete confirm's focus target (Cancel — the safe answer) and its described note. */
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteNoteId = useId();
  useEffect(() => {
    if (panel === "delete") deleteCancelRef.current?.focus();
  }, [panel]);

  /**
   * A confirm the gate has closed under is withdrawn, not remembered. "Use folders" going off, or the row leaving the
   * mirror, while the delete strip was up left `panel === "delete"` standing with nothing drawn for it. The bar's
   * fall-through to its resting row is correct; the defect is what the STATE did — the shell's Escape list has the
   * open bar panel above the reply editor and the reader (`AppShell`'s `escapeLayers`), so the next Escape was spent
   * closing a layer nobody could see: pressing Escape twice to leave a message reads as a key that did not register.
   * The strip IS the ceremony, so when it may no longer be drawn the question is withdrawn — if the gate comes back,
   * the confirmation does not reappear behind the reader's back; Delete is pressed again, the only reading that
   * cannot delete mail nobody just asked to delete.
   */

  /**
   * An EFFECT, not a render-time write: `onPanel` is in the dependency list because it closes over the message id,
   * and a stale closure would clear a different message's panel.
   */
  useEffect(() => {
    if (panel === "delete" && !deleteConfirmAdmitted) onPanel(null);
  }, [panel, deleteConfirmAdmitted, onPanel]);
  /* The `m`/`d` keys themselves are declared at the SHELL (AppShell's global map, beside
     r/a/e/b/s) so the sheet documents them even while no bar is mounted — "a shortcut that
     vanishes from the documentation when the list is empty is a shortcut nobody learns"
     (`keymap.tsx`). What the bar owns is the FOCUS half of the ceremony: `m` lands on the
     first destination (as the delete ask lands on Cancel), so `m` then ↵ files. */
  const moveFirstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (panel === "move") moveFirstRef.current?.focus();
  }, [panel]);
  /**
   * AND RESURFACE LANDS THE SAME WAY — on "Now", its first control.
   *
   * It was the one ceremony with no focus line at all: Move focuses its first destination, the
   * delete ask focuses Cancel, and opening the horizon chooser left the keyboard on a button that
   * had just unmounted. Focus fell to the document, so the chooser could not be answered from the
   * keyboard without Tabbing in from the top of the page, and nothing announced that a question
   * had appeared. "Now" is first in the strip and is the one answer that costs nothing to change
   * your mind about, which makes it the right landing for `b` then ↵.
   */
  const resurfaceFirstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (panel === "resurface") resurfaceFirstRef.current?.focus();
  }, [panel]);
  /** Hoisted above `toggleRead`, which needs it to decide WHICH key it is standing in for. */
  const read = !message.unread;
  /**
   * REPLY ALL RENDERS ONLY WHEN "ALL" IS MORE PEOPLE THAN "REPLY" — the predicate is
   * `replyAllRecipients`, the same call the shell resolves at send time, so the button and the
   * envelope cannot disagree. On a 1:1 message it returns `null` and no control renders: a
   * second reply verb whose recipients equal the first's would be noise, not an option.
   * `ownAddresses` rides the chrome (see `message-chrome.tsx`) because this bar is mounted
   * twice while the reader is open and holds no engine hook of its own.
   */
  const canReplyAll =
    replyAllRecipients(message, chrome.ownAddresses ?? []) !== null;
  /**
   * Forward is offered unless the message may not be forwarded — the `no_forward` sensitivity.
   * The server refuses such a forward with a 403 (`SendService.reserve`, the sensitive-leak
   * gate) and `AppShell.openForward` refuses it client-side with a toast, so a Forward control
   * on an OTP or a reset link is a button that can only ever say no — the same rule Delete
   * follows against `chrome.mirrorHolds`. `⇧F`'s binding carries the identical predicate
   * (`AppShell`), so key and button appear and disappear together, the discipline `shift+r`
   * already keeps.
   */

  /**
   * Off-mirror is the second half, for a reason specific to this verb: the reader shows rows the mirror deliberately
   * does not hold (an archive-only Search hit, an older Folder row). Reply survives that — `toggleReply` opens an
   * editor over the message it was handed — but `AppShell.openForward` starts with `engine.read().get("message", id)`
   * and RETURNS SILENTLY when the row is absent, so button, menu item and `⇧F` would all be no-ops giving no reason.
   * Same predicate and precedent as Delete; absent chrome reads as "holds" (`!== false`), the bare-test/desktop
   * default every consumer of this field uses. The density measurement needs no predicate for either: it measures the
   * groups this message actually renders, so a message with no Forward simply has one fewer group — no assumed worst
   * case, no `data-*` chain, which is the whole reason the static rungs went.
   */
  const canForward =
    message.sensitivity?.no_forward !== true && chrome.mirrorHolds?.(message.id) !== false;
  /** Is the disclosure menu open? A boolean, because the menu is anchored by CSS, not by a point. */
  const [menuOpen, setMenuOpen] = useState(false);
  /**
   * The button the menu belongs to, so dismissing returns the keyboard where it came from.
   *
   * A menu that closes and drops focus to the document leaves a keyboard user at the top of the
   * page, and the thing they were operating is nowhere near. Escape, an outside click and
   * choosing an item all come back through `closeMenu`.
   */
  const moreRef = useRef<HTMLButtonElement>(null);
  const closeMenu = (): void => {
    setMenuOpen(false);
    moreRef.current?.focus();
  };

  // A message swap must not leave a menu open over a different message's verbs.
  useEffect(() => setMenuOpen(false), [message.id]);

  /**
   * Cancelling a panel puts the keyboard back on the control that opened it. Three ceremonies open a strip over the
   * bar and each focuses INTO it (Cancel for the delete ask, the first destination for Move, "Now" for Resurface);
   * cancelling did the opposite of opening — the strip unmounted, the row came back, and focus was on nothing: a
   * keyboard user who opened Resurface and changed their mind was returned to the top of the document. The trigger is
   * recorded on the way IN and the restore happens in an effect on the render that brings the row back — see {@link
   * PanelTrigger} for why the element itself cannot be held. The message id rides along because this bar is mounted
   * twice (reading column, reader sheet) over a panel the chrome keys by message: a cursor move clears the panel with
   * nobody having cancelled, and a restore then would take the keyboard to a DIFFERENT message's Resurface button.
   */

  /**
   * An answer is not a cancel: choosing a destination, a horizon or Delete clears the record,
   * so the keyboard is not sent back to a verb just spent on a message that has moved out from
   * under it — the behaviour those three already had. Escape gets the same restore for free,
   * which is why this is a transition and not a callback: the shell closes the innermost layer
   * by setting the panel to null itself (`AppShell`'s `escapeLayers`), never through this file,
   * so a restore hung off the Cancel button's handler would have covered the mouse and left
   * the key people actually use unfixed.
   */
  const panelTriggerRef = useRef<{ from: PanelTrigger; messageId: string } | null>(null);
  /** The row's own Resurface and Move buttons, bound on the VISIBLE row only — see `rowGroups`. */
  const resurfaceRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const openPanel = (next: BarPanel, from: PanelTrigger): void => {
    panelTriggerRef.current = { from, messageId: message.id };
    onPanel(next);
  };
  /** The strip's own question was ANSWERED: no restore, for the reason stated above. */
  const answerPanel = (): void => {
    panelTriggerRef.current = null;
    onPanel(null);
  };
  /** Cancelled: the record stands, and the effect below spends it on the render after this one. */
  const cancelPanel = (): void => onPanel(null);
  useEffect(() => {
    if (panel !== null) return;
    const opener = panelTriggerRef.current;
    if (opener == null) return;
    panelTriggerRef.current = null;
    if (opener.messageId !== message.id) return;
    const back =
      opener.from === "resurface" ? resurfaceRef.current
        : opener.from === "move" ? moveRef.current
          : moreRef.current;
    back?.focus();
  }, [panel, message.id]);

  /**
   * THE RESURFACE CHOOSER'S DATE PICKER — open, and the capsule it hangs from. A `DatePicker`
   * (packages/ui) anchored to the "Pick a date" capsule replaces the native
   * `<input type="date">`, whose calendar the operating system drew below the bar and off the
   * display. Dismissing returns focus to the capsule, as the More menu returns it to More;
   * a message swap or a panel change closes it.
   */
  const [dateOpen, setDateOpen] = useState(false);
  const dateRef = useRef<HTMLButtonElement>(null);
  const closeDate = (): void => {
    setDateOpen(false);
    dateRef.current?.focus();
  };
  useEffect(() => setDateOpen(false), [message.id, panel]);
  /** The floor's one concession is in force: the read switch stands without its words. */
  const compact = density.admit?.split(" ").includes("compact") ?? false;

  /**
   * MARK UNREAD — the read-state verb of a message that IS read. It PRESSES `u` rather than dispatching its own
   * `mark_seen`, and `press` NOT `useBinding("u")?.run()`: the memoised binding array holds closures from the last
   * SHAPE change, and `u`'s shape does not change with read-state, so `run` would re-fire a stale handler — a bug a
   * browser caught (two presses marked read twice). `press` resolves the handler at call time, exactly as the keydown
   * dispatcher does, which is also what keeps `OhboxView`'s dwell pin in force — a button with its own mutation would
   * be reverted two seconds later by that timer (see `test/ohbox-read-state.test.ts`). `onAction("unread")` is the
   * fallback where `u` is not bound at all (the desktop shell, a pane mounted with no keymap provider).
   */
  const markUnread = () => {
    if (!press("u")) onAction("unread");
  };

  /**
   * Mark as read — the other half of the same slot, and the reason the slot is never empty. The bar used to render
   * nothing on an unread message, arguing that opening a message reads it — true of an ARMED read (the Ohbox presents
   * one as read, so `message.unread` here is presented state), false of the message `u` just put back to unread: it
   * sits under the reader's eyes with no way to say "I am done" except to leave. And a slot holding a verb in one
   * state and nothing in the other reads as a control that disappeared. It presses `⇧I`, not a toggled `u`: the
   * keyboard is two DIRECTIONS, not one flip (argued in `OhboxView`'s binding table), and a button pressing `u` on an
   * unread message would need `u` to become a toggle — the shape that ruling rejects; pressing the existing direction
   * also means the `?` sheet documents this button's key with no new row.
   */

  /**
   * Same seam as {@link markUnread} otherwise: `press` resolves at call time, and `onAction("unread")` — a deliberate
   * flip needing no direction — is the fallback for surfaces with no keymap behind them.
   */
  const markRead = () => {
    if (!press("shift+i")) onAction("unread");
  };

  /**
   * THE BAR IN TRASH: RESTORE, THEN THE READ SWITCH: Placed HERE, after every hook and derivation this component owns
   * and before the eleven groups are composed, for two reasons that are both mechanical. React requires every hook to
   * run on every render, so the return cannot sit above them; and the `trash` prop's own block explains why it is one
   * return rather than eleven predicates. No density measurement, no More menu and no admission walk: two controls
   * fit every width a message is read at, so the machinery that decides which groups the row can hold has nothing to
   * decide. That is also why the row carries no `data-*` shape attributes — the container queries in `action-bar.css`
   * switch groups that are not here.
   */

  /**
   * Restore wears `abar-b abar-solo primary`, the SAME class the pill's first verb wears today (Reply's), read off
   * that button rather than given a class of its own: it is the one primary verb of this bar, and a second accent
   * rule would be a second answer to what "primary" looks like. The read switch is the resting bar's own three-way
   * slot, transcribed — a trashed message can be resurfaced-pinned like any other (the pin is our triage state and
   * survives a delete), so the `Done` face is kept rather than dropped as unreachable.
   */
  if (trash) {
    return (
      <div className="abar abar-trash">
        <div className="abar-g">
          <button
            type="button"
            className="abar-b abar-solo primary"
            onClick={() => onAction("restore")}
          >
            {tt("restore")}
            <Key chord="shift+Backspace" />
          </button>
        </div>
        <div className="abar-g abar-read-g">
          {isResurfaced(message) ? (
            <button
              type="button"
              className="abar-b abar-solo abar-read abar-done"
              aria-label={t("actionDone")}
              title={compact ? t("actionDone") : undefined}
              onClick={() => onAction("resurface_done")}
            >
              <Icon name="check" size={13} className="abar-check" />
              <span className="abar-read-lab">{t("actionDone")}</span>
              <Key chord="shift+i" />
            </button>
          ) : read ? (
            <button
              type="button"
              className="abar-b abar-solo abar-read"
              aria-label={t("actionMarkUnread")}
              title={compact ? t("actionMarkUnread") : undefined}
              onClick={markUnread}
            >
              <span className="abar-dot" aria-hidden="true" />
              <span className="abar-read-lab">{t("actionMarkUnread")}</span>
              <Key chord="u" />
            </button>
          ) : (
            <button
              type="button"
              className="abar-b abar-solo abar-read"
              aria-label={t("actionMarkRead")}
              title={compact ? t("actionMarkRead") : undefined}
              onClick={markRead}
            >
              <span className="abar-dot abar-dot-off" aria-hidden="true" />
              <span className="abar-read-lab">{t("actionMarkRead")}</span>
              <Key chord="shift+i" />
            </button>
          )}
        </div>
      </div>
    );
  }

  /**
   * THE MESSAGE'S CURRENT PILE, REPORTED BY THE BUTTON THAT PUT IT THERE (TRI-F12). The list rows carry a state badge
   * (`OhboxView.stateNoteOf`) and this bar did not: all three horizons rendered identically whatever the message's
   * state, so `a` on something already queued was pressed in good faith, and the button that would UN-park a message
   * looked exactly like the one that parks it — on a control that is a TOGGLE (the verb that filed a message takes it
   * out again; see `AppShell`'s later/aside arms). `aria-pressed` is the toggle's own vocabulary, present in BOTH
   * states so the role never changes with the message, and `action-bar.css` styles the pressed face from the same
   * attribute — one source for the screen reader and the eye.
   */

  /**
   * `resurfaced` presses nothing: the pin is not a bottom pile (`triagePiles` ignores it by construction), and
   * Resurface's own press opens the chooser rather than clearing the pin.
   */
  const pile = message.triage?.state;
  /**
   * A FUNCTION OF `measure`, for the reason `rowGroups` is one: the row is rendered twice, once
   * visibly and once as the density measurement's inert copy, and React binds a ref to the LAST
   * render that claims it. Held as a shared element, `resurfaceRef` would point at the invisible
   * copy — which is the trap the comment at `rowGroups` already names for `moreRef`, arrived at
   * from the other direction by a ref that has to be focusable.
   */
  const defer = (measure: boolean) => (
    <>
      {/* "Later", not "Answer Later". Inside a control whose own name is "Not now", each
          segment need only carry its HORIZON — the shared idea is said once, by the group,
          instead of three times by its members. It is also the 45px that decides whether
          filing fits on the row at the 569px the reading measure allows. */}
      <button
        type="button"
        className="abar-b abar-v abar-later"
        aria-pressed={pile === "reply_later"}
        onClick={() => onAction("later")}
      >
        {t("actionLater")}
        <Key chord="a" />
      </button>
      <button
        type="button"
        className="abar-b abar-v abar-aside"
        aria-pressed={pile === "set_aside"}
        onClick={() => onAction("aside")}
      >
        {t("actionSetAside")}
        <Key chord="e" />
      </button>
      {/* Resurface OPENS A HORIZON CHOOSER — it is the one "not now" verb that answers "how
          long?", so a single click cannot mean it. `b` still stands for it: the key is the
          keyboard's quick default (the shell resolves plain `resurface` to next Friday), and
          the panel is where a specific when is chosen. */}
      <button
        ref={measure ? undefined : resurfaceRef}
        type="button"
        className="abar-b abar-v abar-resurface"
        aria-pressed={pile === "bubbled_up"}
        onClick={() => openPanel("resurface", "resurface")}
      >
        {t("actionResurface")}
        <Key chord="b" />
      </button>
    </>
  );

  /**
   * Tag, as a verb of the bar. Reported twice ("the + Tag element should go into the Pill UI"): the entry point used
   * to be a dashed `+ Tag` chip beside the subject; it is this button now, and the chip is deleted rather than kept
   * alongside — two doors to one picker was the substance of the note. It OPENS the picker the chip opened: `onTag`
   * reaches `AppShell.openTagPicker`, the same seam the `t` key and the selection bar's Tag button call, so nothing
   * here is a second implementation. The anchor is the BUTTON, exactly as Screening's and for the same reason: in the
   * reader sheet the list row is behind the overlay, so a popover placed from it would open under the message being
   * read (`.tagp` is `position: fixed` at `--z-pal`).
   */

  /**
   * Its own `.abar-g`, not a member of the filing segment: Screening and Move answer "where does this mail live", and
   * a tag is the reader's own mark on mail that lives where it lives. `.abar-tag` is a density group of its own,
   * admitted after the horizons and before filing — see the foot of `action-bar.css`.
   */
  const tag = onTag ? (
    <div className="abar-g abar-v abar-tag">
      <button
        type="button"
        className="abar-b abar-solo"
        onClick={(e) => onTag((e.currentTarget as HTMLElement | null) ?? null)}
      >
        {t("actionTag")}
        <Key chord="t" />
      </button>
    </div>
  ) : null;

  /* "Move" relocates THIS message; screening decides where this SENDER's mail goes,
     which is a different question and had no control anywhere outside the Screener.
     The anchor is the BUTTON — not a list row found by selector — because in the reader
     sheet the row is behind the overlay and a popover would open under it. */
  const file = (measure: boolean) => (
    <>
      <button
        type="button"
        className="abar-b abar-v abar-screen"
        onClick={(e) => onScreen((e.currentTarget as HTMLElement | null) ?? null)}
      >
        {tr("action")}
        <Key chord="s" />
      </button>
      <button
        ref={measure ? undefined : moveRef}
        type="button"
        className="abar-b abar-v abar-move"
        onClick={() => openPanel("move", "move")}
      >
        {t("actionMove")}
        <Key chord="m" />
      </button>
    </>
  );

  if (panel === "resurface") {
    /**
     * THE HORIZON CHOOSER — three ways to say when, feeding a concrete instant into the action. Tomorrow and next
     * week are computed from `now` at 09:00 UTC (the hour every stored `bubbleUpAt` uses, so the label reads back the
     * same). "Pick a date" opens the product's own `DatePicker` (below), floored at tomorrow through its `min` so no
     * horizon in the past can be chosen. Each choice closes the panel and dispatches `resurface:<iso>`; the shell
     * mutates and states the day. FOUR NOW, and the fourth is first because it is the only one that costs nothing to
     * change your mind about. "Now" dispatches `resurface_now` — a state, not a date; see {@link MessageAction}. It
     * is separated from the three horizons by nothing but order: the question the strip asks is still "when?", and
     * "now" is an answer to it.
     */
    const tomorrow = tomorrowNine(now);
    const nextWeek = nextWeekNine(now);
    const pick = (iso: string) => {
      answerPanel();
      onAction(`resurface:${iso}`);
    };
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{t("resurfaceWhen")}</span>
          <button
            ref={resurfaceFirstRef}
            type="button"
            className="abar-b abar-solo"
            onClick={() => {
              answerPanel();
              onAction("resurface_now");
            }}
          >
            {t("resurfaceNow")}
          </button>
          <button type="button" className="abar-b abar-solo" onClick={() => pick(tomorrow)}>
            {t("resurfaceTomorrow")}
          </button>
          <button type="button" className="abar-b abar-solo" onClick={() => pick(nextWeek)}>
            {t("resurfaceNextWeek")}
          </button>
          <button
            ref={dateRef}
            type="button"
            className="abar-b abar-solo abar-date-trigger"
            aria-haspopup="dialog"
            aria-expanded={dateOpen}
            onClick={() => setDateOpen((open) => !open)}
          >
            {t("resurfacePick")}
          </button>
          {dateOpen ? (
            <DatePicker
              locale={activeFormatLocale()}
              today={dayValue(now.toISOString())}
              min={dayValue(tomorrow)}
              anchor={dateRef.current}
              labels={{
                dialog: t("resurfacePick"),
                prevMonth: t("datePrevMonth"),
                nextMonth: t("dateNextMonth"),
                today: ts("today"),
              }}
              onPick={(day) => {
                setDateOpen(false);
                pick(dayNine(day));
              }}
              onClose={closeDate}
            />
          ) : null}
          <button type="button" className="abar-b" onClick={cancelPanel}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  if (panel === "move") {
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{t("moveLabel")}</span>
          {MOVE_TARGETS.filter((v) => FOLDER_OF_VIEW[v] !== message.folder).map((v, i) => (
            <button
              key={v}
              type="button"
              className="abar-b abar-solo"
              /* Where `m` lands focus — the first destination, so `m` then ↵ files. */
              ref={i === 0 ? moveFirstRef : undefined}
              onClick={() => {
                answerPanel();
                onAction(`move:${v}`);
              }}
            >
              → {PLACE_LABEL[v] ?? v}
            </button>
          ))}
          <button type="button" className="abar-b" onClick={cancelPanel}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  /**
   * THE DELETE CONFIRM — the second flag conditional, deliberately its own and not folded into
   * the menu item's: a stale open strip must not be able to dispatch after "Use folders" goes
   * off (the mobile reader holds the same pair of gates, and its parity test watched exactly
   * this defect red). The ask and the note render IN the strip, before the act: there is no
   * un-delete on the wire, so the question is the ceremony and no Undo follows. The ONLY
   * dispatch site of `"delete"` is the confirm button here.
   */
  if (panel === "delete" && deleteConfirmAdmitted) {
    // Flag off with a stale "delete" panel falls THROUGH to the resting bar below — the strip
    // simply is not drawn, and nothing here writes state during render. What ALSO happens, one
    // commit later and from an effect rather than from here, is that the panel is put back to
    // resting: a strip that may not be drawn is a question nobody can see, and the shell's Escape
    // list would spend a press closing it. See `deleteConfirmAdmitted` above.
    return (
      <div className="abar">
        {/* `aria-describedby` binds the consequence sentence to the dialog, and focus moves
            INTO it (the safe answer, Cancel): the More item that opened this unmounts with the
            menu, so without the move a keyboard user's focus fell to the document and the
            destructive question was never reliably announced (review finding). */}
        <div
          className="abar-panel abar-delete"
          role="alertdialog"
          aria-label={t("deleteAsk")}
          aria-describedby={deleteNoteId}
        >
          <span className="abar-lab">{t("deleteAsk")}</span>
          <span className="abar-note" id={deleteNoteId}>{t("deleteNote")}</span>
          <button
            type="button"
            className="abar-b abar-solo abar-danger"
            onClick={() => {
              answerPanel();
              onAction("delete");
            }}
          >
            {t("actionDelete")}
            <Key chord="d" />
          </button>
          <button type="button" className="abar-b" ref={deleteCancelRef} onClick={cancelPanel}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  /**
   * WHAT IS BEHIND "MORE" — the same verbs, in the same order they stand in the row. `group` is what keeps the rule
   * "a verb is in the row or in the menu, never both": the container queries at the foot of `action-bar.css` switch
   * each group off HERE at exactly the width they switch it on THERE. One set of numbers, read from both sides. The
   * two that ask a question — Resurface and Move — close the menu and open their panel, which is the same two-step
   * the row's own buttons perform. Screening opens the sender sheet anchored on the item that was pressed, so the
   * popover appears where the click was rather than under a bar that has just closed.
   */
  const menuItems: MoreMenuItem[] = [
    // Reply all mirrors its row position — first, beside the verb it varies. Present only when
    // the predicate admits it, exactly like the row button, so the menu never offers a reply
    // whose recipients would equal plain Reply's.
    ...(canReplyAll
      ? [{
          id: "reply_all",
          group: "rall",
          label: t("actionReplyAll"),
          run: () => { closeMenu(); onAction("reply_all"); },
        } as MoreMenuItem]
      : []),
    /**
     * FORWARD — the folded half of the row group, mirroring its row position: second, beside the
     * two verbs it stands with. `group: "fwd"` is what makes the admission rule hide it here
     * exactly where `.abar-fwd` stands there, keeping "a verb is in the row or in the menu,
     * never both". Gated on the SAME `canForward` the row button is, so a `no_forward` message
     * offers the verb in neither place rather than in one of them.
     */
    ...(canForward
      ? [{
          id: "forward",
          group: "fwd",
          label: tm("menuForward"),
          run: () => { closeMenu(); onAction("forward"); },
        } as MoreMenuItem]
      : []),
    { id: "later", group: "later", label: t("actionLater"), run: () => { closeMenu(); onAction("later"); } },
    { id: "aside", group: "aside", label: t("actionSetAside"), run: () => { closeMenu(); onAction("aside"); } },
    { id: "resurface", group: "resurface", label: t("actionResurface"), run: () => { closeMenu(); openPanel("resurface", "more"); } },
    /**
     * Tag — the folded half of the row button, and it used to be the only half. While tagging's always-visible entry
     * was the `+ Tag` chip under the title, this row was a convenience with no row position (no group class, like
     * Draft reply). The chip is gone and the verb stands in the bar, so this is the FOLDED HALF — `group: "tag"` lets
     * the admission rule hide it exactly where `.abar-tag` stands, keeping "a verb is in the row or in the menu,
     * never both". Placed between the horizons and filing, mirroring the row; anchored on More (`moreRef`), like
     * Screening, so the picker opens where the press was; only where the surface can tag (`onTag` present) — the
     * stream bar cannot.
     */

    /**
     * Not a second entry point, checked rather than argued: rendered in Chrome with both halves present at every
     * width, locale and face, the row and menu are exactly complementary — never both, never neither. Deleting this
     * row would make tagging unreachable from an open message in the split column and on a phone.
     */
    ...(onTag
      ? [{
          id: "tag",
          group: "tag",
          label: t("actionTag"),
          icon: <Icon name="tag" size={13} />,
          run: () => { closeMenu(); onTag(moreRef.current); },
        } as MoreMenuItem]
      : []),
    { id: "screen", group: "screen", label: tr("action"), run: () => { setMenuOpen(false); onScreen(moreRef.current); } },
    { id: "move", group: "move", label: t("actionMove"), run: () => { closeMenu(); openPanel("move", "more"); } },
    {
      id: "draft",
      label: t("actionDraftReply"),
      icon: <Icon name="spark" size={13} />,
      run: () => { closeMenu(); onAction("draft"); },
    },
    /**
     * DELETE — last, menu-only, and flag-gated (FOLDERS-SPEC.md §16.3/§16.7): the verb ships behind "Use folders",
     * and with the flag off this reader is the pre-verb reader. The item carries NO `group`, like Draft reply, so no
     * admission rule can surface it as a row button — a destructive verb does not belong where a stray click can
     * land. It opens the CONFIRM strip; only the strip dispatches (the one-dispatch-site rule the mobile parity test
     * pins on its side). The predicate is the same NAME the strip's own conditional reads, not the same expression
     * typed twice. The two conditionals stay independent — which is the point of the header at the strip: a stale
     * strip must re-ask the live question rather than trust that this item was once offered — and there is now one
     * place where the question is written down.
     */
    ...(deleteConfirmAdmitted
      ? [{
          id: "delete",
          label: t("actionDelete"),
          icon: <Icon name="trash" size={13} />,
          run: () => { closeMenu(); openPanel("delete", "more"); },
        } as MoreMenuItem]
      : []),
  ];

  /* ONE row, rendered twice — visibly, and as the density measurement's hidden copy. A
     FUNCTION rather than a shared element so the copy can drop what must not be duplicated:
     `moreRef` stays on the VISIBLE More button only (React binds a ref to the LAST render
     that claims it, and the measure row mounts after the visible row — a shared ref left
     focus-return and the Tag/Screening popover anchors pointing at the inert copy). */
  const rowGroups = (measure: boolean) => (
    <>
        <div className="abar-g">
          <button
            type="button"
            className="abar-b abar-solo primary"
            onClick={() => onAction("reply")}
          >
            {t("actionReply")}
            <Key chord="r" />
          </button>
        </div>

        {/* REPLY ALL — the same question as Reply, answered to everyone, so it stands beside
            the accent verb and NOT inside it: a segment would dilute the one primary capsule.
            Rendered only when `canReplyAll` (above), with its own `.abar-g` so the row gap
            applies. `.abar-rall` is FIRST in the admission order, which is not "always": the
            two reply verbs are the first thing the measurement seats after the floor and the
            LAST to fold — where the row cannot hold it (the 242px split column, a narrow German
            reader) it goes behind More, everything after it already gone. `mm-rall` is the
            other half of "in the row or in the menu, never both"; which widths those are
            depends on locale and face, why no number is written here. */}
        {canReplyAll ? (
          <div className="abar-g abar-v abar-rall">
            <button
              type="button"
              className="abar-b abar-solo"
              onClick={() => onAction("reply_all")}
            >
              {t("actionReplyAll")}
              <Key chord="shift+r" />
            </button>
          </div>
        ) : null}

        {/* FORWARD — the third verb of the answer family, and the reason this group exists.
            Reported from real use: "fwd message / Forward in general should be within our main
            pill-shaped UI besides Reply etc." It stood in no row at any width — the only mouse
            door was a panel's ⋯ menu, a disclosure a reader must already know about. Its own
            `.abar-g` beside the other two rather than a segment inside either: Reply is the one
            primary capsule, and Forward answers a different question — not "what do I say back"
            but "who else needs to see this". `.abar-fwd` is SECOND in the admission order, so
            the three answer verbs are seated before anything else; what pays is the horizons
            and Tag folding into More earlier — stated with the admission order at the foot of
            `action-bar.css`. `mm-fwd` is the other half of "row or menu, never both". */}
        {canForward ? (
          <div className="abar-g abar-v abar-fwd">
            <button
              type="button"
              className="abar-b abar-solo"
              onClick={() => onAction("forward")}
            >
              {tm("menuForward")}
              <Key chord="shift+f" />
            </button>
          </div>
        ) : null}

        <div
          className="abar-g abar-seg abar-defer"
          role="group"
          aria-label={t("groupDefer")}
        >
          {defer(measure)}
        </div>

        {/* Between the horizons and filing — see `tag` above for why it is its own group and
            not a third segment of "File it". */}
        {tag}

        <div
          className="abar-g abar-seg abar-file"
          role="group"
          aria-label={t("groupFile")}
        >
          {file(measure)}
        </div>

        <div className="abar-g abar-read-g">
          {/* One slot, two directions — and a third face on a resurfaced message (see
              `markUnread`/`markRead`). Exactly one of the two renders, same position, same
              shape: the verb as the label, a dot previewing the outcome, a keycap from the live
              registry. A resurfaced message owns the slot with "Done": on a pinned message the
              deliberate read IS the release — one act spends both — so "Mark as read" was the
              release wearing the wrong name; renamed where the state gives it meaning, not
              added beside (two buttons would be one mutation twice). It dispatches
              `resurface_done` rather than pressing `⇧I`, because the key acts on the SELECTED
              message and this bar can be mounted over an unselected one; a check instead of the
              dot — the previewed outcome is "finished". Part of the floor, folds nowhere. */}
          {isResurfaced(message) ? (
            <button
              type="button"
              className="abar-b abar-solo abar-read abar-done"
              aria-label={t("actionDone")}
              title={compact ? t("actionDone") : undefined}
              onClick={() => onAction("resurface_done")}
            >
              <Icon name="check" size={13} className="abar-check" />
              <span className="abar-read-lab">{t("actionDone")}</span>
              <Key chord="shift+i" />
            </button>
          ) : read ? (
            <button
              type="button"
              className="abar-b abar-solo abar-read"
              aria-label={t("actionMarkUnread")}
              title={compact ? t("actionMarkUnread") : undefined}
              onClick={markUnread}
            >
              <span className="abar-dot" aria-hidden="true" />
              <span className="abar-read-lab">{t("actionMarkUnread")}</span>
              <Key chord="u" />
            </button>
          ) : (
            <button
              type="button"
              className="abar-b abar-solo abar-read"
              aria-label={t("actionMarkRead")}
              title={compact ? t("actionMarkRead") : undefined}
              onClick={markRead}
            >
              <span className="abar-dot abar-dot-off" aria-hidden="true" />
              <span className="abar-read-lab">{t("actionMarkRead")}</span>
              <Key chord="shift+i" />
            </button>
          )}

          {/*
           * ICON-ONLY, and that is a measurement rather than a preference: dropping the word
           * "More" is 35px, and 35px is the difference between filing standing on the row at
           * the 569px reading measure and being pushed into this menu itself. A disclosure is
           * the one control here whose meaning survives without a label — pressing it is the
           * only thing it can do — so it is the right 35px to spend. The name is not lost,
           * it moves to `aria-label` and the tooltip.
           */}
          {/*
           * `aria-expanded` REPORTS THE MENU, and until this change it was the literal `false`.
           * That was not merely stale — with `aria-haspopup` beside it, it announced "there is a
           * popup and it is closed" every time, including while the disclosure was open. A
           * screen-reader user pressed the control, the row underneath was replaced, and the
           * control went on saying nothing had happened. It is a live value now, which is only
           * possible because there is a real popup to report on.
           */}
          <button
            ref={measure ? undefined : moreRef}
            type="button"
            className="abar-b abar-solo abar-more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={t("actionMore")}
            title={t("actionMore")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="chev" size={12} className="abar-chev" />
          </button>
        </div>
    </>
  );

  return (
    /* `data-rall` DECLARES THE BAR'S SHAPE: this message has an audience, so the row carries a
       Reply-all group and the admission walk has one more group at the head of its prefix.
       No stylesheet reads it — the measurement needs no predicate, which is why the per-chain
       rungs it used to select are gone. It stays because it makes the shape ASSERTABLE from
       outside: it is what lets a test and the rendered width check pair a row with the group
       set it should have, and hold the rule that `data-admit` never names a group this bar does
       not render. Set from the SAME `canReplyAll` that renders the group, or it would describe
       a row that is not on screen. */
    <div
      className="abar"
      data-rall={canReplyAll ? "" : undefined}
      /* `data-admit` IS THE MEASUREMENT'S ANSWER — the groups that actually fit, measured off
         the hidden copy below in the machine's real font. Absent until the first measurement
         (and under jsdom/no-JS), which is the FLOOR — Reply, the read switch and More, with
         every group behind More; the rules that obey it close `action-bar.css`.
         `bar-density.ts` carries the whole argument. */
      data-admit={density.admit ?? undefined}
    >
      <div className="abar-row">{rowGroups(false)}</div>
      {/* THE MEASURE ROW — the same groups rendered again, invisible and inert, so the density
          measurement reads each group's REAL rendered width (same markup, same classes, same
          font) instead of trusting a reference font's figures. Position-absolute, so it adds
          nothing to the pill's own width — and rendered only once `armed` (an
          effect, post-hydration, ResizeObserver present), so the server tree, the hydration
          tree and every environment that cannot measure keep the exact markup they had. */}
      {density.armed ? (
        <div className="abar-row abar-measure" ref={density.measureRef}>
          {rowGroups(true)}
        </div>
      ) : null}

      {/* The menu is a child of `.abar` — see `MoreMenu` for why that is the container and not
          a fixed popover, and why it drops upward. Out of flow, so the row above is unmoved. */}
      {menuOpen ? (
        <MoreMenu
          items={menuItems}
          ariaLabel={t("actionMore")}
          anchor={moreRef.current}
          onClose={closeMenu}
        />
      ) : null}
    </div>
  );
}

/** "Protected — …" renders with the leading word bolded, like the prototype. */
function ProtectedPolicy({ text }: { text: string }) {
  const dash = text.indexOf(" — ");
  if (dash < 0) return <>{text}</>;
  return (
    <>
      <b>{text.slice(0, dash)}</b>
      {text.slice(dash)}
    </>
  );
}

/**
 * Every gesture that means "I am reading this now" — see `release` in the thread anchor below.
 * Module scope so the effect that installs them has no changing dependency to declare.
 */
const HANDOVER = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

/**
 * THE MESSAGE'S VERBS, FOR A SURFACE THAT IS NOT THE READING PANE. Reads and Receipts are skim streams: the mail is
 * read in the card, in place, and there is no `ReadingPane` anywhere in either view. So the message being read there
 * had NO verbs at all — no Later, no Set aside, no Reply, no Move — while the identical message in the Ohbox had all
 * of them a click away. Two answers were available and one of them is wrong: give those views their own bar (a second
 * set of verbs, drifting from the first by construction), or hand them the bar that already exists. This is the
 * second. `ActionBar` is unchanged and stays private; what is exported is the small amount of state the reading pane
 * was holding on its behalf — the open destination panel, and the screening popover's anchor, which comes off the
 * same chrome context the pane uses.
 */

/**
 * So "Later" means precisely what it means in the Ohbox, because it IS the Ohbox's button. The panel is cleared when
 * the message changes, exactly as the pane clears it: a half-open Move row belongs to the message it was opened on,
 * and a stream re-pointing at the next card must not carry it over.
 */
export function MessageActionBar({
  message,
  now,
  onAction,
}: {
  message: EngineMessage;
  now: Date;
  onAction: (action: MessageAction) => void;
}) {
  const chrome = useMessageChrome();
  const [panel, setPanel] = useBarPanel(message.id);
  return (
    <ActionBar
      message={message}
      now={now}
      panel={panel}
      onPanel={setPanel}
      onAction={onAction}
      onScreen={(anchor) => chrome.openSenderMenu(message.id, anchor)}
    />
  );
}

export function MessagePane({
  message,
  tags,
  now,
  onEnterReader,
  onAction,
  onAddTag,
  trash,
}: {
  message: EngineMessage;
  tags: TagDTO[];
  now: Date;
  onEnterReader?: () => void;
  onAction: (action: MessageAction) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /**
   * THIS MESSAGE IS IN TRASH — forwarded to {@link ActionBar}, whose own block carries the
   * argument. Absent everywhere else, so every existing mount of this pane is byte-identical.
   */
  trash?: boolean;
}) {
  const t = useTranslations("ohbox");
  /** The conversation's copy lives with the reply's — one namespace owns the thread. */
  const tc = useTranslations("reply");
  /** Hydration state copy, shared with the Reads/Receipts cards and the Screener preview. */
  const tb = useTranslations("body");
  const tm = useTranslations("message");
  /** The conversation stack, so the pane can open at the LATEST message — see below. */
  const convRef = useRef<HTMLDivElement>(null);
  /**
   * `isProtectedMessage`, NOT `message.protected` — see the same decision in `Conversation.tsx`
   * for the failure this was. `protected` is the fixture world's display extra and is absent on
   * every live message, so this pane's protected branch had never once run against a real
   * account; the engine meanwhile refuses to hydrate those bodies, and the pane rendered the
   * resulting record-less `snippet` as "Loading the full message…" with no end and no control.
   */
  const isProtected = isProtectedMessage(message);
  const mine = tagsOfMessage(message, tags);
  // Shared with every other mount of this message's bar; clears when the message changes.
  const [panel, setPanel] = useBarPanel(message.id);
  const chrome = useMessageChrome();

  /**
   * THE CONVERSATION — oldest first, empty when there is no conversation.
   *
   * Computed on every render rather than memoised: the value it derives from is the engine
   * mirror, which has no signal reachable from here (this pane deliberately holds no engine
   * hook — see `message-chrome.tsx`). The shell re-renders this pane on every version bump,
   * so an inline call is always fresh and a `useMemo` with no version dep would go stale
   * the first time a delta landed.
   */
  const conversation = chrome.conversationOf(message.id);
  /**
   * THE MESSAGE THE OPEN EDITOR ANSWERS (or forwards) — resolved against the WHOLE conversation, not the focused id
   * alone. Every panel's ⋯ menu dispatches its OWN id (`MessageHeader`), and `chrome.replyTo` faithfully held it —
   * but the dock below mounted only when the id was the FOCUSED message's, so Reply on any sibling set state that
   * nothing anywhere rendered: the menu pressed, the editor absent, the dispatch swallowed (reported from real use as
   * a dead menu). The dock is ONE editor at the thread's foot; which member it is bound to is this resolution, and
   * every prop below — the head's audience, the send's id, the send-state lane — follows the TARGET, so answering an
   * older message from its own panel is exactly answering it.
   */
  const replyTarget = conversation.length > 0
    ? conversation.find((m) => m.id === chrome.replyTo) ?? null
    : chrome.replyTo === message.id
      ? message
      : null;
  const replying = replyTarget !== null;
  /**
   * One copy of the conversation on screen, ever — and it is this one. A reply must not repeat the message already
   * visible: this read `conversation.length > 0 && !replying` once, because the editor below carried its own
   * `.reply-context` scroller over the same list — the focused message's body rendered once as `.msg-body` and again
   * inside the editor's quote, with the textarea pushed below a duplicate of the text the reader had just finished.
   * The ownership is inverted now: the pane keeps the conversation, in full message anatomy, whether or not the
   * editor is open; `InlineReply` renders no mail at all. Nothing here touches the wire — the payload is still
   * `{inReplyTo, body}` with `body` exactly what was typed (`http-adapter.ts` `mailSend`); quoting the parent would
   * put its text into outgoing mail, and a sensitive parent carries `no_forward` with a redacted stored body.
   */

  /**
   * This slice changed what the SCREEN shows and nothing else.
   */
  const showConversation = conversation.length > 0;

  /**
   * Ask for the whole conversation's bodies, once, in one request — this is what makes the panels honest. Every
   * sibling's body is fetched HERE, on open, so a panel (`ConversationPanels`) draws a body already in the mirror
   * with no request of its own; the panels change what is drawn, never what is loaded, which is why a thread
   * withholds nothing (see `Conversation.tsx`). Keyed on the joined id list rather than `conversation`, a fresh array
   * every render: an array dep would re-fire this on every mirror version bump, and every bump is caused by the very
   * writes this call produces. It lives here rather than in the mapper, where it once lived (`ConversationEntries`,
   * mounted TWICE per thread, so one open asked twice); this is the only place that holds the whole thread.
   */

  /**
   * The opened message is NOT in the list: the shell hydrates the selected id itself, urgently, so the body that IS
   * the screen jumps the queue.
   */

  /**
   * No bounding here, and that is not an oversight: `OhmailEngine.hydrateThread` single-flights
   * per message, skips anything held or in the air, splits the id list at the route's cap, and
   * takes one slot from the body limiter — a second limiter in this file would be two guards
   * reading as belt-and-braces and behaving as neither. Protected siblings are passed in too,
   * on purpose: the engine performs no fetch for one — it notes the message as rendered and
   * PURGES any body an older build cached before the message became sensitive; filtering them
   * out here would skip that purge for exactly the messages it exists for.
   */
  const { hydrateThread } = chrome;
  const siblingKey = conversation.filter((m) => m.id !== message.id).map((m) => m.id).join(",");
  useEffect(() => {
    if (siblingKey) hydrateThread(siblingKey.split(","));
  }, [siblingKey, hydrateThread]);

  /**
   * Open a thread at its latest message — instant, no animation. A conversation renders oldest→newest
   * (`ConversationPanels`), so a fresh render sits at the TOP on the oldest mail; this puts the newest on screen the
   * moment the pane paints. The FOCUS is not remapped — `message` stays the opened id (ActionBar, reply, read-state
   * and selection key on it); the anchor is purely a scroll position, the last `[data-conv-id]` element in the stack.
   * `scrollTop` is assigned directly rather than via `scrollIntoView`: it moves ONE scroller instead of every
   * scrollable ancestor, and it is instant regardless of `scroll-behavior`. The walk to the nearest scrollable
   * ancestor is inlined (copied from `MessageBody.tsx`'s `scrollAncestors`) to keep this pane off the sanitizer
   * module.
   */

  /**
   * `useLayoutEffect` so the position is set before first paint; keyed on `[message.id, showConversation]` ONLY — a
   * dependency on body-state would re-anchor on every hydration delta and yank a reader who had scrolled up.
   */

  /**
   * One pass is not enough any more. This ran once and stopped, on the premise "the
   * conversation list is complete at first render" — true when a sibling rendered its snippet
   * at final height, false once siblings started hydrating: `Conversation` asks for every
   * sibling's body in a mount effect, each answer replaces two lines of snippet with a whole
   * message, and the newest message walks back off the bottom as its older siblings grow above
   * it — a thread opening at its OLDEST message, the exact defect this anchor prevents,
   * restored through a door that did not exist when it was written. Sharper second arm: the
   * walk requires an ancestor ALREADY overflowing — before the bodies land there may be nothing
   * to scroll, the walk falls off the top, and no later event brings it back. So the anchor is
   * re-applied while the conversation's box keeps changing size, and handed to the reader the
   * moment they touch it (wheel, drag, key, press) — bounded by that handover and a timeout, so
   * a thread that never settles cannot hold the scroller. `ResizeObserver`, not a hydration
   * dependency: it fires on what actually invalidates the position (the stack got taller), so a
   * body arriving without changing height costs nothing; guarded for environments without one.
   */
  useLayoutEffect(() => {
    if (!showConversation) return;
    const conv = convRef.current;
    if (!conv) return;

    const anchor = (): void => {
      const entries = conv.querySelectorAll<HTMLElement>("[data-conv-id]");
      const last = entries[entries.length - 1];
      if (!last) return;
      let scroller: HTMLElement | null = last.parentElement;
      while (scroller) {
        const oy = getComputedStyle(scroller).overflowY;
        if (
          (oy === "auto" || oy === "scroll" || oy === "overlay") &&
          scroller.scrollHeight > scroller.clientHeight
        ) {
          break;
        }
        scroller = scroller.parentElement;
      }
      if (!scroller) return;
      /**
       * SQUARE THE SCROLL GEOMETRY, so the flush bottom line is exact. Engines snap the maximum scroll offset to
       * whole pixels, but the panel stack's height is fractional — so scrolled to the end, the last panel could rest
       * a sub-pixel off the columns' shared baseline, or leave a hairline of canvas under itself. The last PANEL
       * absorbs that fraction as ≤1px of inner bottom padding, making content height − viewport an integer; its own
       * surface swallows the remainder and the flush edge stays exact. Reset first so the measurement is of the
       * unpadded stack; only when the stack actually overflows, because a non-scrolling thread has no maximum offset
       * to square (and jsdom, which reports zero-height rects, takes that branch and stays inert).
       */
      last.style.paddingBottom = "0px";
      const stackH = conv.getBoundingClientRect().height;
      const portH = scroller.getBoundingClientRect().height;
      if (stackH > portH) {
        const residue = (stackH - portH) % 1;
        let pad = (1 - residue) % 1;
        if (pad < 0.02 || pad > 0.98) pad = 0;
        last.style.paddingBottom = `${pad.toFixed(3)}px`;
      }
      scroller.scrollTop =
        last.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop -
        14;
    };

    anchor();

    let live = true;
    let timer = 0;
    /**
     * THE READER TAKES OVER, and after that nothing here moves the scroller again.
     *
     * Capture phase and on `window`, so it catches the gesture wherever it lands — including
     * inside the message body's own scrollers — and catches it before any handler can stop it
     * propagating. Anything that could be a person's intent counts: a wheel, a touch drag, a
     * key, a press on a button. Re-anchoring under somebody who has started reading the oldest
     * message would be a worse bug than the one this fixes, because it would be unfixable from
     * the reader's side.
     */
    const release = (): void => {
      if (!live) return;
      live = false;
      observer?.disconnect();
      window.clearTimeout(timer);
      for (const ev of HANDOVER) window.removeEventListener(ev, release, true);
    };
    const observer =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            if (live) anchor();
          });
    observer?.observe(conv);
    // A ceiling, not a schedule. Sibling bodies are fetched under a concurrency cap and a slow
    // one can be seconds out; a thread whose stack is STILL resizing after this has something
    // else wrong with it, and holding the scroller longer would only make that worse.
    timer = window.setTimeout(release, 6000);
    for (const ev of HANDOVER) window.addEventListener(ev, release, true);
    return release;
  }, [message.id, showConversation]);

  /**
   * THE BODY, HYDRATED.
   *
   * This pane used to render `message.body ?? message.snippet` — and it was the surface that
   * made the defect hardest to see, because a snippet inside full message anatomy LOOKS like
   * a short email rather than like a truncation. `bodyOf` reaches the `message_body` record
   * the shell hydrated on selection, and carries the state so the two failure modes can say
   * so beneath the text instead of passing as the mail.
   */
  const body = chrome.bodyOf(message);

  /**
   * A PROTECTED MESSAGE RENDERS NO TEXT, AND IT IS THIS BRANCH THAT MAKES IT TRUE. `isProtected` is checked FIRST and
   * `body` is not consulted inside it: a protected message renders the block and no text at all, whatever the mirror
   * or a hydration happens to hold for it. The endpoint's own text is already redacted server-side
   * (`message-service.ts` `getBody`), so hydration cannot introduce a secret here — but "the text we were given is
   * safe" and "this pane does not render a protected message's text" are two different guarantees, and the second is
   * the one a reader can see. AND IT IS NOW THE ONLY EXPRESSION THAT RENDERS THE MAIL HERE. This pane used to hand
   * `ReadingPane` a `body` STRING whenever there was no conversation — a third render path, and the one most messages
   * took, which `ReadingPane` drew as its own `<p className="msg-body">`.
   */

  /**
   * A body fix that only reached `focusedBody` would have been invisible on exactly the common case. `children`
   * replaces `body` in `ReadingPane`, so the pane composes that slot itself now, always, and the `body` prop is not
   * passed in any case.
   */
  /**
   * THE FIXTURE EXTRA IS OPTIONAL HERE, AND ON A LIVE ACCOUNT IT IS ALWAYS ABSENT.
   *
   * `message.protected` carries demo-authored copy — a label, a redaction note, a policy
   * sentence. It exists only in the fixture world. `ProtectedBlock` defaults all three to the
   * same wording the live surfaces already use for this state (`ohbox.protectedPreview`,
   * `reply.quotedProtected` — "Verification code ······ (redacted)"), so a live protected
   * message renders the block with the product's own copy and no policy line, rather than
   * throwing on `message.protected!` the moment this branch became reachable for real mail.
   */
  /**
   * WHICH RENDERING IS ON SCREEN, BECAUSE THE STRIP BELOW DEPENDS ON IT: Mail that declares no layout canvas is drawn
   * in the app's own typography over the TEXT part, and that rendering draws NO IMAGES. So a picture the sender
   * embedded with `cid:` — a photo pasted into a reply, a scanned page, a chart — is painted nowhere, while the strip
   * beside it has always withheld exactly those parts on the grounds that the body already showed them. Two
   * defensible rules that between them made a picture in somebody's mailbox unreachable from the whole product. The
   * strip therefore lists the message's pictures WHEN, AND ONLY WHEN, nothing else is drawing them. In the framed
   * rendering the html paints them and the filter stands, because a strip that listed them there would be naming each
   * picture a second time. ONE STRING, KEYED BY MESSAGE, AND BOTH HALVES MATTER.
   */

  /**
   * Keyed, so the answer for the last message cannot decide this one's strip for the frame between selecting it and
   * its body reporting; a primitive, so `setState` with an unchanged value hits React's bail-out and a child effect
   * that reports on every render cannot become a render loop. Unknown reads as FRAMED — today's behaviour — so the
   * widened list is something a positive signal turns on.
   */
  const [bodyRendering, setBodyRendering] = useState("");
  const onRenderMode = useCallback(
    (mode: "prose" | "framed") => setBodyRendering(`${message.id}:${mode}`),
    [message.id],
  );
  const nativeBody = bodyRendering === `${message.id}:prose`;

  /**
   * WHAT THE BODY HAD REFUSED, worn by the header. `MessageBody` reports it (`onNotice`) and the
   * focused message's `MessageHeader` below wears it in its right cluster — the same glyph and
   * caption the stream card wears in its head — so the bar above the body keeps only its
   * controls. Keyed by message exactly as `bodyRendering` is, and for the same reason: this pane
   * is one instance re-pointed by selection, and the last message's answer must not decide this
   * one's header for the frame before its body reports. `MessageCard` carries the same block and
   * the longer argument.
   */
  const [noticeFor, setNoticeFor] = useState<{ id: string; notice: BlockNotice | null } | null>(null);
  const onNotice = useCallback(
    (notice: BlockNotice | null) => setNoticeFor({ id: message.id, notice }),
    [message.id],
  );
  const notice = noticeFor?.id === message.id ? noticeFor.notice : null;

  /**
   * The framed rendering's unresolved `cid:` images, reported by `MessageBody` and forwarded to
   * the attachment seam — which fetches the parts' own bytes and grows the map handed back down
   * as `cidImages` below. Stable per message so the effect that calls it does not refire per
   * render; absence of the chrome (demo, a client with no attachment service) is handled where
   * the props are passed, by handing `MessageBody` neither of the pair.
   */
  const onCidImages = useCallback(
    (contentIds: string[]) => chrome.attachments?.needCidImages(message.id, contentIds),
    [chrome.attachments, message.id],
  );

  const extra = message.protected;
  const focusedBody = isProtected ? (
    <ProtectedBlock
      /* The server may name the protected field itself; when it does not, the catalogue does —
         `extra?.label` alone rendered an empty line in every locale. */
      label={extra?.label ?? tm("protectedLabel")}
      redactedNote={extra?.redactedNote ?? tm("protectedRedacted")}
      policy={extra ? <ProtectedPolicy text={extra.policy} /> : undefined}
    />
  ) : (
    /* A `<div>` rather than the `<p>` this was, because `BodyText` emits the paragraphs
       now and a `<p>` may not contain one. `.msg-body` is unchanged and stays the one element
       that holds the mail and nothing else, which is what `test/conversation.test.ts` and
       `test/inline-reply.test.ts` select on and what a reader is entitled to assume. */
    <div className="msg-body">
      {/* The consent path for remote images. `remoteImages` is ABSENT on a client with no proxy
          (`?demo=1`, the desktop shell, a test with no API), and `MessageBody` answers that with
          no button rather than a dead one. `remoteLoaded` is the OR of three facts stored in
          different places: the server's `loadedRemoteContent` (images stay loaded across a
          reload), this session's press (they appear the moment it happens), and the account's
          own setting (most readers never see the button). The mirror's body record is not
          re-fetched on consent — `hydrateBody` returns early on a `ready` record — so without
          the second term the button would write a row and change nothing on screen. `auto` is
          the product default (mail 0048): it admits PICTURES through the proxy, and the
          sanitizer still refuses the proxy to a beacon or a 1×1 in both modes. `onLoadRemote`
          is withheld in auto mode, which removes the button: "Show images" over images already
          showing is a control whose press does nothing. */}
      <MessageBody
        messageId={message.id}
        text={body.text}
        html={body.html}
        remoteLoaded={
          body.loadedRemoteContent ||
          (chrome.remoteImages?.auto ?? false) ||
          (chrome.remoteImages?.consented(message.id) ?? false)
        }
        imageProxy={chrome.remoteImages ? chrome.remoteImages.proxyFor(message.id) : null}
        onLoadRemote={
          chrome.remoteImages && !chrome.remoteImages.auto
            ? () => chrome.remoteImages!.consent(message.id)
            : undefined
        }
        /* The account's pixel switch (mail 0072). `false` — the default and the answer on a
           client with no chrome — keeps the sanitizer's refusal to proxy a beacon. */
        loadTrackingPixels={chrome.remoteImages?.loadPixels ?? false}
        /* The message's own embedded (`cid:`) images — resolved from the parts' bytes through
           the attachment seam, never from any url the sender wrote. Both halves travel
           together or not at all: a client with no attachment service (`?demo=1`) hands
           `MessageBody` neither, and every `cid:` box stays blanked exactly as before. */
        cidImages={chrome.attachments ? chrome.attachments.cidImagesOf(message.id) : undefined}
        onCidImages={chrome.attachments ? onCidImages : undefined}
        onRenderMode={onRenderMode}
        onNotice={onNotice}
      />
    </div>
  );

  /*
   * The strip travels WITH the body, so every place that renders the focused message
   * gets it and none of them has to remember. `isProtected` gates it for the same reason the
   * body is gated above: this pane renders no protected content at all, and a file
   * a sender attached is content.
   */
  const attachments = isProtected ? undefined : chrome.attachments;
  const focusedMessage = (
    <>
      {focusedBody}
      {attachments ? (
        <AttachmentStrip
          /* THE MESSAGE'S PICTURES ARE PART OF THE LIST WHERE NOTHING ELSE DRAWS THEM — see
             `nativeBody` above. The same value goes to `onDownloadAll`, because the head counts
             what this list holds and the button beneath that count must save the same set. */
          items={attachments.itemsOf(message.id, { includeInlineImages: nativeBody })}
          /* SAVING IS THE SECOND VERB NOW — the corner control on a tile that can be looked at,
             and the whole tile on one that cannot. Every attachment can be saved, whatever else
             it can do, so this is never withheld. */
          onOpen={(attachmentId) => attachments.open(message.id, attachmentId)}
          /**
           * Looking is what a press does, and WHICH files offer it is decided here rather than in the strip — the
           * strip stays a pure component, and the answer is a security judgement with one owner. A type this app can
           * draw inline (image, PDF, text) opens the Quick-Look overlay; everything else — a docx, a zip, and an SVG,
           * a document that executes script — cannot be previewed and its tile saves. The metadata carries the type
           * whatever the byte state, so the decision needs no fetch. The swap changed the geometry, not this line:
           * `isPreviewable` is the same predicate with the same refusals.
           */

          /**
           * On the desktop a PDF is not one of them — `opensInSystemViewer` subtracts: that window cannot draw a PDF
           * (the renderer needs a worker, the policy is `worker-src 'none'`, both bundles alias the library away), so
           * the eye there was a viewer whose only outcome was a panel saying to download instead. Without the eye,
           * the tile's press opens the PDF in the program this computer uses for PDFs; it answers false everywhere
           * else, including the whole web app.
           */
          onPreview={(attachmentId) => chrome.openAttachmentPreview(message.id, attachmentId)}
          canPreview={(item) => isPreviewable(item.mimeType) && !opensInSystemViewer(item.mimeType)}
          onDownloadAll={() => attachments.downloadAll(message.id, { includeInlineImages: nativeBody })}
          downloadingAll={attachments.downloadingAll(message.id)}
          /* THE EVENT CARD's feed: a calendar part whose decoded text is in hand renders as
             the event it carries (what · when · where · who), in place of its tile. The map
             is filled by the same effect that loads the list — engine-budgeted — and stays
             empty wherever fetching was refused, which keeps the plain tile standing. */
          calendarTextOf={(attachmentId) => attachments.calendarTextsOf(message.id).get(attachmentId)}
        />
      ) : null}
    </>
  );

  /**
   * Said for everything that is not the mail — and `snippet` IS one of those things here. This used to exempt
   * `snippet` alongside `full`, arguing the shell hydrates on selection so a snippet is a sub-frame state. False in
   * the case that matters: before `hydrateBody` wrote its `loading` marker at ENQUEUE, it wrote it only when a fetch
   * DEPARTED, and departures are capped at four — the fifth message opened during a busy tick had no `message_body`
   * record, `bodyOf` answered `snippet`, and this pane rendered 200 characters cut mid-word inside full message
   * anatomy with nothing saying more was coming: silent, indistinguishable from a short email, worst exactly when the
   * app is busy.
   */

  /**
   * The engine's marker closes that window; this line is the half that does not depend on getting the enqueue right —
   * a snippet AT REST in this pane is a defect by construction, and the honest thing to say is that the message is
   * still coming. The failure carries a CONTROL, not only a sentence: this pane's hydration is keyed on the selected
   * id, so without a button a single 500 leaves the body unreachable until the user selects away and returns — a dead
   * end nobody would guess the exit from.
   */
  /**
   * `snippet` is grouped with `loading` because both mean "not the mail yet" — see the note
   * above. {@link useBodyStalled} is what stops that from being said for ever: past the engine's
   * own deadline the claim is retired and the failure branch below, WITH its Retry, is shown
   * instead. A body that arrives first clears `waiting` and the timer with it.
   */
  const waitingForBody = body.state === "loading" || body.state === "snippet";
  const stalled = useBodyStalled(message.id, !isProtected && waitingForBody);
  /**
   * THE FAILURE'S TAXONOMY: AUTH LOSS IS NOT A CONTENT FAILURE: "Couldn't load the full message — Retry" was this
   * pane's one sentence for every failure, and during a dead session it was the WRONG one: the message is fine, the
   * session is gone, and the offered Retry could only re-401 — observed in live use, with the reader told the MESSAGE
   * was broken. So when the session's death is CONFIRMED (`session-truth.ts`: the server itself refused the refresh;
   * never one request's evidence), the note names the real fact and offers the real remedy. On the desktop and in the
   * demo the store never leaves its resting value and this branch is unreachable. And a failure recorded while the
   * session was bad must not outlive the recovery: on every REVIVAL — a real 204 minting a real session — a body
   * still sitting in `failed` is asked for once more.
   */

  /**
   * `retry: true` is legitimate here for the same reason the human press is: the engine's no-auto-re-ask rule guards
   * against looping on a server that KEEPS refusing, and a freshly minted session is the world having changed,
   * bounded to one ask per revival.
   */
  const sessionDead = useSessionDead();
  const bodyFailed = body.state === "failed";
  useEffect(() => {
    if (!bodyFailed || isProtected) return;
    return subscribeSessionRevival(() => chrome.hydrateBody(message.id, { retry: true }));
  }, [bodyFailed, isProtected, chrome, message.id]);
  const bodyNote =
    isProtected || body.state === "full" ? undefined : body.state === "withheld" ? (
      /* ── WITHHELD IS ANSWERED, NOT FAILED — so no Retry and no spinner. ─────────────────────
         The server said it holds no content for this message, which a retry cannot change and
         a "couldn't load" would misstate: nothing failed. WHICH policy emptied it decides the
         sentence (`withheldCopyKey`): the storage cap's copy points at the mailbox and the
         plan, the junk verdict's at the provider's Junk folder, the expunge says the copies
         are gone. The preview above it is real either way (the snippet is stored). */
      tb(withheldCopyKey(body.withheld))
    ) : body.state === "failed" || stalled ? (
      sessionDead ? (
        <>
          {tb("sessionEnded")}{" "}
          <a className="btn ghost" href="/login">
            {tb("signIn")}
          </a>
        </>
      ) : (
        <>
          {tb("failed")}{" "}
          {/* `retry` because this IS a human asking again. An automatic trigger deliberately
              does not re-ask a server that already refused — see `hydrateBody`. */}
          <Button variant="ghost" onClick={() => chrome.hydrateBody(message.id, { retry: true })}>
            {tb("retry")}
          </Button>
        </>
      )
    ) : (
      tb("loading")
    );

  /**
   * The title's chrome — signals inline, tags folded. Two different things shared one wrapping
   * row under the subject: the routing rationale and the tracker shield are SIGNALS the product
   * states about this message — read once, at most two of them — while the tags are the
   * reader's OWN marks, and rendered as full colour chips they dominated the head of every
   * tagged message. So the signals keep their inline row (rendered only when one exists) and
   * the tags move into the same collapsed `(i)` disclosure the list explainers use: a quiet
   * "{n} tags" line that opens to the chips on demand. The list rows are untouched — a tag
   * there is a scanning aid at row scale, so `MessageRow` still renders its chips inline.
   */

  /**
   * The `+ Tag` affordance is no longer one of them. A dashed chip stood here permanently,
   * outside the fold, with its own `addRef` anchor and a hand-typed `t` hint. Reported twice
   * ("the + Tag element should go into the Pill UI"), so the ENTRY POINT is a verb of the
   * action bar now (see `ActionBar`'s `tag`) and the chip is deleted rather than left standing:
   * two controls opening one picker is what the note is about. What is left under the title is
   * only the message's own marks — and with the affordance gone, an untagged message renders no
   * `.tag-chrome` at all: an empty flex box under every untagged subject is a gap with nothing
   * in it.
   */
  const titleChrome = (
    <div className="msg-marks">
      {message.rationale || message.trackerNote ? (
        <div className="msg-signals">
          {message.rationale ? <Chip variant="rationale">{message.rationale}</Chip> : null}
          {message.trackerNote ? <Chip variant="tracker">{message.trackerNote}</Chip> : null}
        </div>
      ) : null}
      {mine.length > 0 ? (
        <div className="tag-chrome">
          <InfoNote
            className="tag-note"
            lead={t("tagsLead", { count: mine.length })}
            moreLabel={t("tagsMore")}
          >
            <div className="tag-note-chips">
              {mine.map((tag) => (
                <Chip key={tag.id} variant="tag" hue={hueOf(tag)} big>
                  {tag.name}
                </Chip>
              ))}
            </div>
          </InfoNote>
        </div>
      ) : null}
    </div>
  );

  /**
   * THE FOCUSED MESSAGE'S OWN HEADER — the same {@link MessageHeader} an expanded sibling wears, so the message you
   * opened and the ones around it read identically: avatar, the names-first sender that is still the screening
   * control, the ⋯ actions menu left of the stamp, the message's own quiet subject line (SUBJECT-D — the raw
   * `m.subject`, and the subject-rule entry where the shell offers the sheet), and the recipients line whose
   * "details" press reveals the full To/Cc, the exact date and where the message physically sits (`physicalFolder`).
   * `onEnterReader` rides here now — the from-line it used to hang off is gone from `ReadingPane`. So does `notice`:
   * what the body below had refused, worn in the header's right cluster as the stream card wears it (`onNotice`,
   * above), and printed in full by the "details" press.
   */

  /**
   * NO LARGE `<h2>` AND NO THREAD LEDE ANY MORE: the 24px heading (and the one-time lede the thread wrapper opened
   * with) is deleted with the viewer redesign — the subject is per message, in the header, uniformly, on a single
   * message exactly as on every thread panel. `test/conversation.test.ts` holds the absence.
   */
  const focusedHeader = (
    <MessageHeader message={message} now={now} onEnterReader={onEnterReader} notice={notice} />
  );

  const bodyNoteFailed = body.state === "failed" || stalled;

  /**
   * THE PILL, BUILT ONCE AND MOUNTED ONCE — the same element in both layouts, so the bar the
   * single message parks in `ReadingPane`'s actions slot and the bar at the foot of the thread
   * wrapper cannot drift apart. `test/pill-snapshot.test.ts` pins its rendered markup to the bytes
   * captured before the viewer redesign: the wrapper around the bar changed, the bar did not.
   * It is bound to `message` — the OPENED id — on every surface; opening an older message via
   * search keeps the verbs on that message, never on the newest panel.
   */
  const actionBar = (
    <ActionBar
      message={message}
      now={now}
      panel={panel}
      onPanel={setPanel}
      onAction={onAction}
      onScreen={(anchor) => chrome.openSenderMenu(message.id, anchor)}
      onTag={(anchor) => onAddTag(message.id, anchor)}
      trash={trash}
    />
  );

  const replyEditor = replyTarget ? (
    <InlineReply
      /* THE TARGET, not the focused message — see `replyTarget`. The editor takes the
         message it is answering and nothing else: the `to` line, the draft key, `canSend`
         and the send-state lane all follow the member the ⋯ menu named. */
      message={replyTarget}
      /* A reply, or the inline forward — the chrome's one mode field. */
      mode={chrome.replyMode ?? "reply"}
      /* Whether this editor answers EVERYONE on the message — set by the open
         (`openReply(id, true)`), read here so the head names the same audience the
         send will carry. Absent chrome field means a plain reply. */
      replyAll={chrome.replyAll === true}
      value={chrome.replyBody}
      /* The dock's own lane: a forward's outcome lands on `fwd:<id>` (see `sendKeyOf`), so the
         button's "Sending…" and the failure it may show are THIS editor's and never the compose
         form's. */
      send={chrome.replySendState(
        (chrome.replyMode ?? "reply") === "forward" ? inlineForwardKey(replyTarget.id) : replyTarget.id,
      )}
      onChange={chrome.onReplyBody}
      onClose={chrome.closeReply}
      onSend={() => chrome.sendReply(replyTarget.id)}
      /* THE HELD REPLY'S TWO VERBS — the row this message's unconfirmed reply left behind, and
         where the reader's answer goes. Only for a reply: a forward has no such row, and the
         editor renders the verbs only while its own sentence says the send is unconfirmed. */
      heldResolve={(chrome.replyMode ?? "reply") === "forward"
        ? null
        : chrome.replyHeldResolve?.(replyTarget.id) ?? null}
      /* The audience, editable: the edit strings and their reporter live on the chrome
         beside the body (mounted-twice — `message-chrome.tsx`), and the book feeds the
         rows' suggestions. `onEnvelope` absent on the inert chrome keeps the head a
         plain statement there. */
      envelope={chrome.replyEnvelope}
      onEnvelope={chrome.onReplyEnvelope}
      book={chrome.addressBook}
      /* WHICH ADDRESS ANSWERS — the pick and its reporter live on the chrome beside the body
         (mounted-twice), so the From line the reader sees and the `mailboxId` `sendReply`
         puts on the wire are one resolution. */
      fromId={chrome.replyFromId}
      onFrom={chrome.onReplyFrom}
      /* FILES ON THE REPLY — held on the chrome (mounted-twice again), carried to the send by
         `sendReply` and stored nowhere. `onAttachments` absent on the inert chrome renders no
         attach control there. */
      attachments={chrome.replyAttachments}
      onAttachments={chrome.onReplyAttachments}
      /* THE SIGNATURE BLOCK — state on the chrome (mounted-twice), the stored map from the
         shell's consent read, serialized by `sendReply` from the same derivation the block
         renders. `onReplySig` absent on the inert chrome renders no block there. */
      signatures={chrome.signatures}
      /* The markup half, forwarded EXPLICITLY beside it. Both props are optional, so a
         missing forward here compiles and renders the plain shape for a signature the send
         carries as markup — a silent divergence no typecheck can see. */
      signaturesHtml={chrome.signaturesHtml}
      sig={chrome.replySig}
      onSig={chrome.onReplySig}
      /* THE SUBJECT, editable in place on a reply — the edit lives on the chrome
         (mounted-twice), `null` keeps the untouched wire byte-identical. */
      subjectEdit={chrome.replySubjectEdit}
      onSubject={chrome.onReplySubject}
      /* The host's ceiling on what a send can carry — the other half of the attach cap the
         editor states beside those files (`composeAttachCap(SIZE, THIS)`). Absent on the inert
         chrome and on every browser tab; `null` on the desktop's standalone door. */
      sendSurfaceMaxTotalBytes={chrome.sendSurfaceMaxTotalBytes}
      /* The AI drafter's offer renders inside the editor the draft lands in — see
         `InlineReply`. Absent where there is no drafter: the desktop shell, and any
         harness that mounts a pane without the shell. */
      /* Never in FORWARD mode: the drafter writes replies, so its card in the forward dock
         would place generated reply text into the forward's note. The offer returns with the
         reply editor; `placeDraft` flips the mode back for an arriving draft. */
      draftReply={(chrome.replyMode ?? "reply") === "forward" ? undefined : chrome.draftReply}
    />
  ) : undefined;

  /**
   * ── A SINGLE MESSAGE KEEPS THE `ReadingPane` ANATOMY ─────────────────────────────────────
   *
   * One `<article class="msg">` filling the wrapper — the panel IS the message, so the article
   * grammar holds. NO `from`, `subject`, `chips`, `time` OR `onSender` any more: the pane
   * composes its own `MessageHeader`, subject and chips in the children slot, so `ReadingPane`
   * renders no from-line and there is exactly one header per message. What stays is what is
   * ABOUT the message rather than part of it: the body-state note, the action bar and the
   * reply slot.
   */
  if (!showConversation) {
    return (
      <ReadingPane
        bodyNote={bodyNote}
        bodyNoteFailed={bodyNoteFailed}
        actions={actionBar}
        reply={replyEditor}
      >
        {focusedHeader}
        {titleChrome}
        {focusedMessage}
      </ReadingPane>
    );
  }

  /**
   * The thread does not route through `ReadingPane` — an article cannot wrap N panels. The
   * wrapper below is the scrolling column: every message on the conversation is its own
   * full-width, full-body panel (`.pm`), oldest first, on the canvas (`.read-col` drops its
   * panel skin — `message.css`); no peek rows, no counts, no "show earlier" — every panel is
   * the mail itself (`ConversationPanels`). No lede: the column opens on the oldest panel, and
   * every panel prints its OWN subject (SUBJECT-D, `MessageHeader`) — the one-time thread
   * heading is deleted, and with it the suppression that decided which panels earned a line.
   * The FOCUSED panel is composed here (the protected rule decided first, the hydrated body,
   * the attachment strip, the body-state line, the signal/tag marks — facts about THIS message,
   * riding its panel now the lede is gone); `aria-current` marks it, the focus never remapped.
   * The PILL and the reply dock are direct children of the wrapper, AFTER the panels, so
   * `.msg-actions`' sticky rule pins the one bar at the foot and the editor docks under it.
   * `role="group"` because `aria-label` on a bare div is ignored, and a `<section>` landmark
   * would be too loud for one part of one view.
   */
  return (
    <div className="conv" role="group" aria-label={tc("conversationAria")} ref={convRef}>
      <ConversationPanels
        messages={conversation}
        focusedId={message.id}
        now={now}
        focusedPanel={
          <article className="pm conv-focus" data-conv-id={message.id} aria-current="true">
            <div className="pm-in">
              {focusedHeader}
              {titleChrome}
              {focusedMessage}
              {bodyNote ? (
                <p className={bodyNoteFailed ? "msg-body-state warn" : "msg-body-state"} role="status">
                  {bodyNote}
                </p>
              ) : null}
            </div>
          </article>
        }
      />
      <div className="msg-actions">{actionBar}</div>
      {replyEditor ? <div className="reply-dock">{replyEditor}</div> : null}
    </div>
  );
}

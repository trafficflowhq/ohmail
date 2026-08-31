"use client";

/**
 * One message anatomy for the Ohbox read column AND the reader overlay:
 * from-line, subject, chips (routing rationale, tracker shield, tags,
 * add-affordance), body or the protected-OTP block, attachment, actions.
 */
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FOLDER_OF_VIEW, isProtectedMessage, isResurfaced, type EngineMessage, type OhmailView, type TagDTO } from "@ohmail/client-engine";
import { Button, Chip, Icon, InfoNote, Kbd, ProtectedBlock, ReadingPane } from "@ohmail/ui";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { isPreviewable } from "../components/AttachmentPreview";
import { opensInSystemViewer } from "./open-attachment";
import { MessageBody } from "../components/MessageBody";
import { ConversationPanels } from "./Conversation";
import { MessageHeader } from "./MessageCard";
import { PLACE_LABEL, dayNine, dayValue, hueOf, nextWeekNine, tagsOfMessage, tomorrowNine, withheldCopyKey } from "./format";
import { replyAllRecipients } from "./compose-from";
import { InlineReply } from "./InlineReply";
import { inlineForwardKey } from "./mail-send";
import { chordKeys, useBinding, useKeyPress } from "./keymap";
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
  | "reply"
  /**
   * Reply to EVERYONE on the message — sender plus the other To/Cc recipients. Dispatched only
   * from a control that `replyAllRecipients` allowed to render, so a 1:1 message never offers
   * it; the shell resolves the same call again at send time (`AppShell.sendReply`).
   */
  | "reply_all"
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
   * RESURFACE NOW — the horizon chooser's fourth answer, and a different KIND of answer from the
   * other three.
   *
   * Not `resurface:<a moment ago>`, and the distinction is the whole point. The three dated
   * answers all write `bubbled_up` with a future instant and wait for a bubble-up pass to flip
   * them; a past instant in that same variant would be a promise nobody keeps — the pass is gated
   * behind the worker's cycle, and a standalone desktop install runs no worker. So "now" is its
   * own member, dispatching the direct `resurfaced` transition the server accepts, and the row is
   * pinned by the time the request returns.
   */
  | "resurface_now"
  /**
   * DONE WITH A RESURFACE — the deliberate release, named.
   *
   * The release has existed as long as the pin has: a deliberate `mark_seen` (no `via`) spends
   * it, stamps `lastReadAt`, and the row files at the top of "Earlier". What it never had was a
   * face — the only doors were "Mark as read", `⇧I` and the bulk verbs, none of which says
   * "this resurface is finished". This action is that face, NOT a new mechanism: the shell
   * answers it with the same `mark_seen` every deliberate read dispatches, plus a
   * `triage_set: none` first when the message is merely SCHEDULED (`bubbled_up`) rather than
   * pinned — cancelling the booking is the release's other half there, and it is the existing
   * triage vocabulary, no new wire verb anywhere.
   */
  | "resurface_done"
  | "draft"
  | "unread"
  /**
   * DELETE — the one destructive verb, and it is a MOVE: the engine's `message_delete` files
   * the message to the provider's own \Trash folder and NEVER expunges (FOLDERS-SPEC.md §16.3;
   * the product rule lives at `packages/core/src/adapters/imap-types.ts`, the third
   * user-commanded write). Gated on the folders foundation flag (`chrome.foldersEnabled`) and
   * dispatched ONLY from the confirm strip the ⋯ menu opens — there is no un-delete on the
   * wire, so the ceremony is a confirm, never an undo the product could not honour. The mobile
   * reader ships the identical ceremony, and a parity test on its side pins the two surfaces'
   * wording to this catalogue, word for word.
   */
  | "delete"
  | `move:${MoveTarget}`;

/** The DecisionBar's vocabulary, so filing means the same thing everywhere. */
export const MOVE_TARGETS: MoveTarget[] = ["ohbox", "reads", "receipts", "screened", "spam"];

/**
 * THE SAME VERBS, OVER A SELECTION.
 *
 * Declared beside {@link MessageAction} rather than in the view that renders the bulk bar,
 * because the whole point is that there is ONE vocabulary. The selection used to offer only
 * ⇧U and Escape; what it gets is the action bar's own grouping minus the one verb
 * that cannot mean anything over a set.
 *
 *   · `later` / `aside` / `resurface` — the three horizons, unchanged in meaning.
 *   · `move:<view>` — this message, relocated. Per message, no rule.
 *   · `read` / `unread` — DIRECTIONS, not a toggle, and that is the one deliberate
 *     divergence from the single-message bar. `MessageAction["unread"]` is a flip because
 *     one message has a read state to flip; a selection has a MIXED one, and "toggle eleven
 *     messages" would mark six read and five unread in a gesture that reads as one decision.
 *
 * Screening is NOT in this union. It is a decision about senders with a consent ceremony of
 * its own (a confirm row stating what will persist), so it travels as its own callback —
 * folding it in here would be the design error the ruling names by name.
 */
export type BulkAction =
  | "later"
  | "aside"
  | "resurface"
  | "read"
  | "unread"
  | `move:${MoveTarget}`;

/**
 * Which sub-row has taken the bar's place, if any. `null` is the resting bar.
 *
 * It was a `moving` boolean. A second disclosure (More) made two booleans able to
 * be true at once, which is a state the bar has no rendering for — a union cannot express it.
 *
 * `"more"` is GONE from this union and that is the shape of the change, not a detail of it. A
 * disclosure and a question are different things: Move and Resurface each ask WHERE or WHEN, and
 * a strip that replaces the bar with the possible answers and a Cancel is the right ceremony for
 * a question. "More" asked nothing — it swapped the row for a different row in the same place,
 * with no visible connection to the press. That is a menu, and a menu is what it is now
 * ({@link MoreMenu}), anchored to the button that opened it. What is left here is exactly the
 * two ceremonies.
 */
type BarPanel = MessageBarPanel;

/**
 * THE OPEN PANEL, RESOLVED THROUGH THE CHROME WHERE A SHELL PROVIDES ONE — the reply-draft
 * rule (`message-chrome.tsx` header) applied to the bar's strip: this bar is mounted in the
 * reading column AND the reader sheet (and on the open stream card), and a Move row opened
 * by key in one must be the row the reader is looking at in the other. The chrome keys the
 * panel by message id, so a different message's bar always renders at rest.
 *
 * The local `useState` is the PROVIDER-LESS fallback (the desktop shell, bare view tests):
 * no chrome setter means each mount keeps its own strip, exactly the pre-chrome behaviour,
 * which is honest where only one mount can exist. Both arms clear on a message change —
 * a half-open destination row must not carry over (the rule both hosts already stated).
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
 * A verb's keycap, READ FROM THE LIVE REGISTRY.
 *
 * Renders nothing when nothing is bound to `chord` here, which is the whole point: the bar
 * cannot advertise a key that does not work, and it cannot go stale when a chord moves.
 * `chordKeys` is the same notation the `?` sheet prints, so `⌘`/`⇧`/`↵` would render
 * identically in both places if a bar verb ever took a modifier.
 *
 * This replaces `kbdHint="s"` — one hand-typed hint on one of eight buttons, which read as a
 * stray `s` in the label row.
 */
function Key({ chord }: { chord: string }) {
  const binding = useBinding(chord);
  if (!binding) return null;
  return <Kbd>{chordKeys(chord).join(" ")}</Kbd>;
}

/**
 * ═══ THE ACTION BAR ═══════════════════════════════════════════════════════════════════
 *
 * Reported from real use: the bar breaks a line, it does not show its shortcuts, and it needs
 * to handle mark read and unread sensibly.
 *
 * ── THE GROUPING, WHICH IS THE ACTUAL FIX ─────────────────────────────────────────────
 *
 * The eight buttons this replaces were eight peers in one wrapping row, and they are not
 * eight peers. They answer three different questions, and one of the three was being asked
 * three times:
 *
 *   · ANSWER IT      — Reply (the accent verb), Draft reply (the AI variant, in More).
 *   · NOT NOW        — Answer Later, Park, Resurface. **The same idea at three horizons**,
 *                      so they are ONE segmented control with hairlines between the
 *                      segments, not three siblings competing with Reply for weight.
 *   · FILE IT        — Screening (this SENDER's future mail) and Move (THIS message).
 *                      One control, two scopes, which is exactly why they belong adjacent
 *                      and exactly why they must stay two buttons: Screening is here
 *                      because "where does this sender's mail go" had no control outside
 *                      the Screener, and folding it into Move would undo that.
 *
 * and beside them, not among them, the READ SWITCH — a state, not a decision about where
 * mail goes, so it is separated by `margin-left:auto` rather than by a divider.
 *
 * Layout is in `action-bar.css`; the rule that matters is that a group is atomic, so the
 * row cannot break mid-group at any width. What a narrow container drops is whole groups,
 * into More.
 *
 * ── EVERY VERB SHOWS ITS KEY, AND NOT BY BEING TOLD ───────────────────────────────────
 *
 * Each `<Key chord>` asks the registry. Before this the bar carried exactly one hint —
 * `kbdHint="s"`, typed at the call site — while `r`, `a`, `e`, `b` and `u` were all live
 * and silent. That single hint is the stray `s` in the report: not a bug in the label, a bug
 * in the label row having only one keycap in it.
 *
 * ── AND THE READ SWITCH DOES NOT FIGHT THE READER ─────────────────────────────────────
 *
 * `u` is already bound, in `OhboxView`, and marking unread there sets a `pinnedUnread` ref
 * that the 2 s dwell checks WHEN ITS TIMER FIRES — the guard
 * `test/ohbox-read-state.test.ts` calls *"`u` is not undone by a dwell that is already
 * ticking"*. A button that dispatched `mark_seen` on its own would have no way to set that
 * pin, so a click on it inside the dwell window would be reverted two seconds later by the
 * heuristic: the exact defect that test exists to prevent, reintroduced through a new door.
 *
 * So the switch does not re-implement the verb — **it presses the key**. One handler, one
 * pin, one place where "reading has happened" is decided. `onAction("unread")` is the
 * fallback for surfaces where `u` is not bound at all (the desktop shell, a pane mounted
 * with no keymap provider), and it is the only arm that can drift, which is why it is the
 * arm that is never taken in the product.
 */
function ActionBar({
  message,
  now,
  panel,
  onPanel,
  onAction,
  onScreen,
  onTag,
}: {
  message: EngineMessage;
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
  const press = useKeyPress();
  const chrome = useMessageChrome();
  /** The delete confirm's focus target (Cancel — the safe answer) and its described note. */
  const deleteCancelRef = useRef<HTMLButtonElement>(null);
  const deleteNoteId = useId();
  useEffect(() => {
    if (panel === "delete") deleteCancelRef.current?.focus();
  }, [panel]);
  /* The `m`/`d` keys themselves are declared at the SHELL (AppShell's global map, beside
     r/a/e/b/s) so the sheet documents them even while no bar is mounted — "a shortcut that
     vanishes from the documentation when the list is empty is a shortcut nobody learns"
     (`keymap.tsx`). What the bar owns is the FOCUS half of the ceremony: `m` lands on the
     first destination (as the delete ask lands on Cancel), so `m` then ↵ files. */
  const moveFirstRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (panel === "move") moveFirstRef.current?.focus();
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
   * A label whose key is not in `messages/en.json` yet.
   *
   * The copy is read through `t.has` and falls back to the SAME wording here until the key
   * lands in that file. `en.json` wins the moment the key exists, so
   * this cannot become a second source of copy: it is a shim with one exit, not a default.
   */
  const copy = (key: string, reported: string): string => (t.has(key) ? t(key) : reported);

  /**
   * MARK UNREAD — the read-state verb of a message that IS read.
   *
   * It PRESSES `u` rather than dispatching its own `mark_seen`, and `press` NOT
   * `useBinding("u")?.run()`: the memoised binding array holds closures from the last SHAPE change,
   * and `u`'s shape does not change with read-state, so `run` would re-fire a stale handler — a bug
   * a browser caught (two presses marked read twice). `press` resolves the handler at call time,
   * exactly as the keydown dispatcher does, which is also what keeps `OhboxView`'s dwell pin in
   * force — a button with its own mutation would be reverted two seconds later by that timer (see
   * `test/ohbox-read-state.test.ts`). `onAction("unread")` is the fallback where `u` is not bound at all
   * (the desktop shell, a pane mounted with no keymap provider).
   */
  const markUnread = () => {
    if (!press("u")) onAction("unread");
  };

  /**
   * MARK AS READ — the OTHER half of the same slot, and the reason the slot is never empty.
   *
   * The bar used to render nothing at all on an unread message: the argument was that opening a
   * message reads it, so a "Mark read" arm acts on a state the message is about to be in anyway.
   * That is true of an ARMED read — and the Ohbox now presents one as read, so `message.unread`
   * here is presented state and this arm never renders over a message being read — but false of
   * the message `u` just put back to unread: it sits under the reader's eyes as unread with no way
   * to say "I am done with this" except to leave. And a slot that holds a verb in one state and
   * nothing in the other reads as a control that has disappeared rather than as a state with no
   * verb.
   *
   * IT PRESSES `⇧I`, NOT A TOGGLED `u`. The keyboard here is two DIRECTIONS and not one flip —
   * `u` marks unread, `⇧I` marks read, argued out in `OhboxView`'s own binding table — and a
   * button that pressed `u` on an unread message would need `u` to become a toggle, which is the
   * shape that ruling rejects. Pressing the direction that already exists also means the `?` sheet
   * documents this button's key without a new row: the sheet is generated from the same registry.
   *
   * Same seam as {@link markUnread} in every other respect: `press` resolves at call time, and
   * `onAction("unread")` — a deliberate flip, so it needs no direction of its own — is the fallback
   * for surfaces with no keymap behind them.
   */
  const markRead = () => {
    if (!press("shift+i")) onAction("unread");
  };

  /**
   * THE MESSAGE'S CURRENT PILE, REPORTED BY THE BUTTON THAT PUT IT THERE (TRI-F12).
   *
   * The list rows carry a state badge (`OhboxView.stateNoteOf`) and this bar did not: all
   * three horizons rendered identically whatever the message's state, so `a` on something
   * already queued was pressed in good faith, and the button that would UN-park a message
   * looked exactly like the one that parks it — on a control that is a TOGGLE (the verb that
   * filed a message takes it out again; see `AppShell`'s later/aside arms). `aria-pressed`
   * is the toggle's own vocabulary, present in BOTH states so the role never changes with
   * the message, and `action-bar.css` styles the pressed face from the same attribute — one
   * source for the screen reader and the eye. `resurfaced` presses nothing: the pin is not
   * a bottom pile (`triagePiles` ignores it by construction), and Resurface's own press
   * opens the chooser rather than clearing the pin.
   */
  const pile = message.triage?.state;
  const defer = (
    <>
      {/* "Later", not "Answer Later". Inside a control whose own name is "Not now", each
          segment need only carry its HORIZON — the shared idea is said once, by the group,
          instead of three times by its members. It is also the 45px that decides whether
          filing fits on the row at the 569px the reading measure allows. */}
      <button
        type="button"
        className="abar-b"
        aria-pressed={pile === "reply_later"}
        onClick={() => onAction("later")}
      >
        {copy("actionLater", "Later")}
        <Key chord="a" />
      </button>
      <button
        type="button"
        className="abar-b"
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
        type="button"
        className="abar-b"
        aria-pressed={pile === "bubbled_up"}
        onClick={() => onPanel("resurface")}
      >
        {t("actionResurface")}
        <Key chord="b" />
      </button>
    </>
  );

  /**
   * ── TAG, AS A VERB OF THE BAR ─────────────────────────────────────────────────────────
   *
   * Reported twice: *"Tag + is still under the title and not in the Pill shape (I gave this
   * feedback before). Added Tags should stay where they are, but the + Tag element should go into
   * the Pill UI."* The entry point used to be a dashed `+ Tag` chip beside the subject; it is this
   * button now, and the chip is deleted rather than kept alongside — two doors to one picker was
   * the substance of the note.
   *
   * It OPENS the picker the chip opened. `onTag` reaches `AppShell.openTagPicker`, which is the
   * same seam the `t` key and the selection bar's Tag button call, so nothing here is a second
   * implementation of tagging. The anchor is the BUTTON, exactly as Screening's is and for the
   * same reason: in the reader sheet the list row is behind the overlay, so a popover placed from
   * it would open under the message being read. `.tagp` is `position: fixed` at `--z-pal`, so it
   * is clipped by nothing on the way out of the pill.
   *
   * Its own `.abar-g`, not a member of the filing segment: Screening and Move both answer "where
   * does this mail live", and a tag is the reader's own mark on mail that lives where it lives.
   * `.abar-tag` is the density-ladder group — see `action-bar.css` for the tier and for why it
   * outranks Reply all.
   */
  const tag = onTag ? (
    <div className="abar-g abar-tag">
      <button
        type="button"
        className="abar-b abar-solo"
        onClick={(e) => onTag((e.currentTarget as HTMLElement | null) ?? null)}
      >
        {copy("actionTag", "Tag")}
        <Key chord="t" />
      </button>
    </div>
  ) : null;

  /* "Move" relocates THIS message; screening decides where this SENDER's mail goes,
     which is a different question and had no control anywhere outside the Screener.
     The anchor is the BUTTON — not a list row found by selector — because in the reader
     sheet the row is behind the overlay and a popover would open under it. */
  const file = (
    <>
      <button
        type="button"
        className="abar-b"
        onClick={(e) => onScreen((e.currentTarget as HTMLElement | null) ?? null)}
      >
        {tr("action")}
        <Key chord="s" />
      </button>
      <button type="button" className="abar-b" onClick={() => onPanel("move")}>
        {t("actionMove")}
        <Key chord="m" />
      </button>
    </>
  );

  if (panel === "resurface") {
    /**
     * THE HORIZON CHOOSER — three ways to say when, feeding a concrete instant into the action.
     *
     * Tomorrow and next week are computed from `now` at 09:00 UTC (the hour every stored
     * `bubbleUpAt` uses, so the label reads back the same). "Pick a date" is the native date
     * input, floored at tomorrow so the picker cannot choose a horizon in the past. Each choice
     * closes the panel and dispatches `resurface:<iso>`; the shell mutates and states the day.
     *
     * FOUR NOW, and the fourth is first because it is the only one that costs nothing to change
     * your mind about. "Now" dispatches `resurface_now` — a state, not a date; see
     * {@link MessageAction}. It is separated from the three horizons by nothing but order: the
     * question the strip asks is still "when?", and "now" is an answer to it.
     */
    const tomorrow = tomorrowNine(now);
    const nextWeek = nextWeekNine(now);
    const pick = (iso: string) => {
      onPanel(null);
      onAction(`resurface:${iso}`);
    };
    return (
      <div className="abar">
        <div className="abar-panel">
          <span className="abar-lab">{t("resurfaceWhen")}</span>
          <button
            type="button"
            className="abar-b abar-solo"
            onClick={() => {
              onPanel(null);
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
          <label className="abar-b abar-solo abar-date">
            {t("resurfacePick")}
            <input
              type="date"
              className="abar-date-input"
              min={dayValue(tomorrow)}
              aria-label={t("resurfacePick")}
              onChange={(e) => e.currentTarget.value && pick(dayNine(e.currentTarget.value))}
            />
          </label>
          <button type="button" className="abar-b" onClick={() => onPanel(null)}>
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
                onPanel(null);
                onAction(`move:${v}`);
              }}
            >
              → {PLACE_LABEL[v] ?? v}
            </button>
          ))}
          <button type="button" className="abar-b" onClick={() => onPanel(null)}>
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
  if (panel === "delete" && chrome.foldersEnabled === true && chrome.mirrorHolds?.(message.id) !== false) {
    // Flag off with a stale "delete" panel falls THROUGH to the resting bar below — the strip
    // simply is not drawn, and nothing here writes state during render.
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
              onPanel(null);
              onAction("delete");
            }}
          >
            {t("actionDelete")}
            <Key chord="d" />
          </button>
          <button type="button" className="abar-b" ref={deleteCancelRef} onClick={() => onPanel(null)}>
            {t("moveCancel")}
          </button>
        </div>
      </div>
    );
  }

  /**
   * WHAT IS BEHIND "MORE" — the same verbs, in the same order they stand in the row.
   *
   * `group` is what keeps the rule "a verb is in the row or in the menu, never both": the
   * container queries at the foot of `action-bar.css` switch each group off HERE at exactly the
   * width they switch it on THERE. One set of numbers, read from both sides.
   *
   * The two that ask a question — Resurface and Move — close the menu and open their panel,
   * which is the same two-step the row's own buttons perform. Screening opens the sender sheet
   * anchored on the item that was pressed, so the popover appears where the click was rather
   * than under a bar that has just closed.
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
    { id: "later", group: "defer", label: copy("actionLater", "Later"), run: () => { closeMenu(); onAction("later"); } },
    { id: "aside", group: "defer", label: t("actionSetAside"), run: () => { closeMenu(); onAction("aside"); } },
    { id: "resurface", group: "defer", label: t("actionResurface"), run: () => { closeMenu(); onPanel("resurface"); } },
    /**
     * TAG — THE FOLDED HALF OF THE ROW BUTTON, and it used to be the only half.
     *
     * While tagging's always-visible entry point was the `+ Tag` chip under the title, this row
     * was a convenience with no row position at all: it carried no group class, like Draft reply,
     * and no query could switch it off. The chip is gone and the verb stands in the bar, so this
     * is now a LADDER DUPLICATE — `group: "tag"` is what lets the 519px tier hide it exactly where
     * `.abar-tag` stands, keeping "a verb is in the row or in the menu, never both".
     *
     * Placed between the horizons and filing, mirroring the row: a reader who has seen Tag there
     * on a wide bar looks for it there on a narrow one. Anchored on More (`moreRef`), like
     * Screening, so the picker opens where the press was rather than under a menu that has closed.
     * Only where the surface can tag (`onTag` present) — the stream bar cannot.
     *
     * **THIS IS NOT A SECOND ENTRY POINT, and that was checked rather than argued.** Rendered in
     * Chrome with both halves present and the container stepped through every tier, the row and
     * the menu are exactly complementary — row hidden / menu shown at 242, 350, 455, 456 and 518;
     * row shown / menu hidden at 519, 572 and 576. Never both, never neither. Deleting this row to
     * make the move "a move" would instead make tagging UNREACHABLE from an open message in the
     * split column and on a phone, which are the first five of those widths.
     */
    ...(onTag
      ? [{
          id: "tag",
          group: "tag",
          label: copy("actionTag", "Tag"),
          icon: <Icon name="tag" size={13} />,
          run: () => { closeMenu(); onTag(moreRef.current); },
        } as MoreMenuItem]
      : []),
    { id: "screen", group: "file", label: tr("action"), run: () => { setMenuOpen(false); onScreen(moreRef.current); } },
    { id: "move", group: "file", label: t("actionMove"), run: () => { closeMenu(); onPanel("move"); } },
    {
      id: "draft",
      label: t("actionDraftReply"),
      icon: <Icon name="spark" size={13} />,
      run: () => { closeMenu(); onAction("draft"); },
    },
    /**
     * DELETE — last, menu-only, and flag-gated (FOLDERS-SPEC.md §16.3/§16.7): the verb ships
     * behind "Use folders", and with the flag off this reader is the pre-verb reader. The item
     * carries NO `group`, like Draft reply, so no bar tier ever surfaces it as a row button —
     * a destructive verb does not belong where a stray click can land. It opens the CONFIRM
     * strip; only the strip dispatches (the one-dispatch-site rule the mobile parity test pins
     * on its side).
     */
    ...(chrome.foldersEnabled === true && chrome.mirrorHolds?.(message.id) !== false
      ? [{
          id: "delete",
          label: t("actionDelete"),
          icon: <Icon name="trash" size={13} />,
          run: () => { closeMenu(); onPanel("delete"); },
        } as MoreMenuItem]
      : []),
  ];

  return (
    /* `data-rall` IS THE DENSITY LADDER'S ONE PREDICATE IT CANNOT MEASURE — see the rungs in
       `action-bar.css`. A container query knows the pill's width and nothing about what is in
       it, and the Reply-all group's 95.7px is present on some messages and absent on others,
       so defer and Tag are admitted at two different widths depending on whether this bar
       carries it. The attribute is set from the SAME `canReplyAll` that renders the group, so
       the row the ladder is measuring and the row on screen are the same row. */
    <div className="abar" data-rall={canReplyAll ? "" : undefined}>
      <div className="abar-row">
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
            Rendered only when `canReplyAll` (see above), and its own `.abar-g` so the row gap
            applies. `.abar-rall` is the ladder's FIRST rung, which is not the same claim as
            "always": the two reply verbs stand together at the three widths a message is read
            at on a DESKTOP — reading column 572, stream card 576, conversation 628 — and this
            group still folds into More below its rung: the 242px split column in both
            locales, and the 350px phone reader in German, where `Allen antworten` needs 478.
            `mm-rall` is the other half of "in the row or in the menu, never both". The exact
            widths are per-locale because the label's width is; see `action-bar.css`. */}
        {canReplyAll ? (
          <div className="abar-g abar-rall">
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

        <div
          className="abar-g abar-seg abar-defer"
          role="group"
          aria-label={copy("groupDefer", "Not now")}
        >
          {defer}
        </div>

        {/* Between the horizons and filing — see `tag` above for why it is its own group and
            not a third segment of "File it". */}
        {tag}

        <div
          className="abar-g abar-seg abar-file"
          role="group"
          aria-label={copy("groupFile", "File it")}
        >
          {file}
        </div>

        <div className="abar-g abar-read-g">
          {/*
           * ONE SLOT, TWO DIRECTIONS — AND A THIRD FACE ON A RESURFACED MESSAGE. See
           * `markUnread` and `markRead` above for the two directions.
           *
           * Exactly one of the two renders, in the same position, with the same shape: the verb as
           * the label (not a `role="switch"` reporting a state with the action hidden in a
           * `title`), a dot PREVIEWING the outcome, and a keycap read from the live registry, so a
           * chord that moves takes the hint with it and an unbound chord shows nothing. Filled dot
           * ⇒ the row will have one; hollow ⇒ it will not — the same mark the list uses.
           *
           * A RESURFACED MESSAGE OWNS THE SLOT WITH "DONE". On a pinned message the deliberate
           * read IS the release — one act spends both, there is no un-bold-but-pinned state — so
           * "Mark as read" here was the release wearing the wrong name: nothing on the whole
           * surface said how to END a resurface, reported from real use in exactly those terms.
           * The verb is
           * renamed where the state gives it its real meaning, not added beside it: a "Done" AND
           * a "Mark as read" would be one mutation behind two buttons, and the slot's own rule is
           * one control per state. It dispatches `resurface_done` (the shell's one release arm,
           * shared with the pin-group row and the Resurface pile) rather than pressing `⇧I`,
           * because the key acts on the SELECTED message and this bar can be mounted over an
           * unselected one (a stream card); the keycap still shows `⇧I` where it is bound, since
           * that key performs the same release on the open message. A check instead of the dot:
           * the outcome being previewed is "finished", not a read mark.
           *
           * IT REPLACES THE SLOT AT EVERY WIDTH AND FOLDS NOWHERE — the slot always stands in the
           * ladder, and "Done" plus the check is NARROWER than either label it replaces, so no
           * tier moves. Re-measure per the ladder's rule if this label ever grows.
           */}
          {isResurfaced(message) ? (
            <button
              type="button"
              className="abar-b abar-solo abar-read abar-done"
              onClick={() => onAction("resurface_done")}
            >
              <Icon name="check" size={13} className="abar-check" />
              {t("actionDone")}
              <Key chord="shift+i" />
            </button>
          ) : read ? (
            <button
              type="button"
              className="abar-b abar-solo abar-read"
              onClick={markUnread}
            >
              <span className="abar-dot" aria-hidden="true" />
              {copy("actionMarkUnread", "Mark unread")}
              <Key chord="u" />
            </button>
          ) : (
            <button
              type="button"
              className="abar-b abar-solo abar-read"
              onClick={markRead}
            >
              <span className="abar-dot abar-dot-off" aria-hidden="true" />
              {t("actionMarkRead")}
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
            ref={moreRef}
            type="button"
            className="abar-b abar-solo abar-more"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label={copy("actionMore", "More")}
            title={copy("actionMore", "More")}
            onClick={() => setMenuOpen((open) => !open)}
          >
            <Icon name="chev" size={12} className="abar-chev" />
          </button>
        </div>
      </div>

      {/* The menu is a child of `.abar` — see `MoreMenu` for why that is the container and not
          a fixed popover, and why it drops upward. Out of flow, so the row above is unmoved. */}
      {menuOpen ? (
        <MoreMenu
          items={menuItems}
          ariaLabel={copy("actionMore", "More")}
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
 * THE MESSAGE'S VERBS, FOR A SURFACE THAT IS NOT THE READING PANE.
 *
 * Reads and Receipts are skim streams: the mail is read in the card, in place, and there is no
 * `ReadingPane` anywhere in either view. So the message being read there had NO verbs at all —
 * no Later, no Set aside, no Reply, no Move — while the identical message in the Ohbox had all
 * of them a click away. Two answers were available and one of them is wrong: give those views
 * their own bar (a second set of verbs, drifting from the first by construction), or hand them
 * the bar that already exists.
 *
 * This is the second. `ActionBar` is unchanged and stays private; what is exported is the small
 * amount of state the reading pane was holding on its behalf — the open destination panel, and
 * the screening popover's anchor, which comes off the same chrome context the pane uses. So
 * "Later" means precisely what it means in the Ohbox, because it IS the Ohbox's button.
 *
 * The panel is cleared when the message changes, exactly as the pane clears it: a half-open
 * Move row belongs to the message it was opened on, and a stream re-pointing at the next card
 * must not carry it over.
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
}: {
  message: EngineMessage;
  tags: TagDTO[];
  now: Date;
  onEnterReader?: () => void;
  onAction: (action: MessageAction) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("ohbox");
  /** The conversation's copy lives with the reply's — one namespace owns the thread. */
  const tc = useTranslations("reply");
  /** Hydration state copy, shared with the Reads/Receipts cards and the Screener preview. */
  const tb = useTranslations("body");
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
   * THE MESSAGE THE OPEN EDITOR ANSWERS (or forwards) — resolved against the WHOLE
   * conversation, not the focused id alone. Every panel's ⋯ menu dispatches its OWN id
   * (`MessageHeader`), and `chrome.replyTo` faithfully held it — but the dock below mounted
   * only when the id was the FOCUSED message's, so Reply on any sibling set state that
   * nothing anywhere rendered: the menu pressed, the editor absent, the dispatch swallowed
   * (reported from real use as a dead menu). The dock is ONE editor at the thread's foot;
   * which member it is bound to is this resolution, and every prop below — the head's
   * audience, the send's id, the send-state lane — follows the TARGET, so answering an older
   * message from its own panel is exactly answering it.
   */
  const replyTarget = conversation.length > 0
    ? conversation.find((m) => m.id === chrome.replyTo) ?? null
    : chrome.replyTo === message.id
      ? message
      : null;
  const replying = replyTarget !== null;
  /**
   * ONE COPY OF THE CONVERSATION ON SCREEN, EVER — AND IT IS THIS ONE.
   *
   * A reply must not repeat the message that is already visible.
   *
   * This read `conversation.length > 0 && !replying` once, because the editor
   * below carried its own `.reply-context` scroller over the same list. The two copies of
   * the LIST were never up at once — but the copy that mattered was the focused message's
   * body, and that one was: once here as `.msg-body`, once again inside the editor's quote,
   * in one scrolling column, with the textarea pushed below a duplicate of the text the
   * reader had just finished. Redundant is exactly the word.
   *
   * The ownership is inverted now. The pane keeps the conversation, in full message anatomy,
   * whether or not the editor is open; `InlineReply` renders no mail at all. So "scroll
   * through the actual email conversation" is answered by the actual conversation instead of
   * by a 190px quote of it.
   *
   * NOTHING HERE TOUCHES THE WIRE. The payload is still `{inReplyTo, body}` with `body`
   * exactly what was typed (`http-adapter.ts` `mailSend`); quoting the parent would put its
   * text into outgoing mail, and a sensitive parent carries `no_forward` with a redacted
   * stored body — sensitive mail is never forwarded and never stored unredacted. This slice
   * changed what the SCREEN shows and nothing else.
   */
  const showConversation = conversation.length > 0;

  /**
   * ── ASK FOR THE WHOLE CONVERSATION'S BODIES, ONCE, IN ONE REQUEST ───────────────────────
   *
   * THIS IS WHAT MAKES THE PANELS HONEST. Every sibling's
   * body is fetched HERE, on open, alongside every other message on the thread — so a panel
   * (`ConversationPanels`) draws a body already in the mirror with no request of its own, and
   * every message on the thread is mail the reader has in hand rather than a placeholder for
   * some they would have to go and get. The panels change what is drawn, never what is loaded,
   * which is why a thread withholds nothing (see `Conversation.tsx`).
   *
   * Keyed on the joined id list rather than on `conversation`, which is a fresh array on every
   * render (see above — it is computed inline on purpose). An array dep would re-fire this on
   * every mirror version bump, and every bump is caused by the very writes this call produces.
   *
   * IT LIVES HERE RATHER THAN IN THE MAPPER, WHICH IS WHERE IT ONCE LIVED (as
   * `ConversationEntries`, then mounted TWICE per thread — two lists, above and below the
   * opened message — so an effect inside it asked twice for one act of opening one
   * conversation). This is the only place that holds the whole thread.
   *
   * THE OPENED MESSAGE IS NOT IN THE LIST. The shell hydrates the selected id itself, and
   * urgently (`AppShell`, keyed on `readerFor`/`selectedOhbox`), so that the body which IS the
   * screen jumps the queue rather than riding a batch behind it.
   *
   * NO BOUNDING HERE, AND THAT IS NOT AN OVERSIGHT. `OhmailEngine.hydrateThread` single-flights
   * per message, skips anything already held or already in the air, splits the id list at the
   * route's cap, and takes ONE slot from the body limiter. A second limiter in this file would
   * be the shape this repo keeps warning about: two guards read as belt-and-braces and behave as
   * neither, because deleting either leaves the suite green.
   *
   * PROTECTED SIBLINGS ARE PASSED IN TOO, on purpose. The engine performs no fetch for one — it
   * notes the message as rendered, which is true, and PURGES any body an older build cached
   * before the message became sensitive. Filtering them out here would skip that purge for
   * exactly the messages it exists for.
   */
  const { hydrateThread } = chrome;
  const siblingKey = conversation.filter((m) => m.id !== message.id).map((m) => m.id).join(",");
  useEffect(() => {
    if (siblingKey) hydrateThread(siblingKey.split(","));
  }, [siblingKey, hydrateThread]);

  /**
   * OPEN A THREAD AT ITS LATEST MESSAGE — instant, no animation.
   *
   * A conversation renders oldest→newest (`ConversationPanels`, one full-body panel per
   * message), so a fresh render sits at the TOP, on the oldest mail, and the reader has to
   * scroll down to reach what just arrived. This puts the newest on screen the moment the
   * pane paints.
   *
   * The FOCUS is NOT remapped — `message` stays the id that was opened (ActionBar, reply,
   * read-state and selection all key on it). The anchor is purely a scroll position: the LAST
   * `[data-conv-id]` element in the stack — the newest PANEL (or the focused message's own
   * panel when it is the newest).
   *
   * `scrollTop` is assigned DIRECTLY rather than via `scrollIntoView`, for two reasons: it
   * moves ONE scroller instead of every scrollable ancestor, and it is instant regardless of
   * `scroll-behavior` — neither `.read-col` (`message.css`) nor `.reader` (`reader.css`)
   * declares `smooth`, but a direct assignment does not depend on that staying true. The walk
   * to the nearest scrollable ancestor is inlined (its shape copied from `MessageBody.tsx`'s
   * `scrollAncestors`) rather than imported, to keep this pane off the sanitizer module.
   *
   * `useLayoutEffect` so the position is set before first paint; keyed on
   * `[message.id, showConversation]` ONLY — a dependency on body-state or contents would
   * re-anchor on every hydration delta, for as long as the pane is open, and yank a reader who
   * had scrolled up.
   *
   * ── AND ONE PASS IS NOT ENOUGH ANY MORE ─────────────────────────────────────────────────
   *
   * This used to run exactly once and stop, on the premise stated above it: *"the conversation
   * list is complete at first render"*. That premise was true when a sibling rendered its
   * snippet — two lines, final height, at first paint. It stopped being true when siblings
   * started hydrating: `Conversation` asks for every sibling's body in a mount effect, the
   * answers land over the following moments, and each one replaces two lines of snippet with a
   * whole message. So the stack this pass measured is not the stack the reader ends up looking
   * at, and the newest message walks back off the bottom of the screen as its older siblings
   * grow above it — a thread opening at its OLDEST message, which is the exact defect this
   * anchor exists to prevent, restored through a door that did not exist when it was written.
   *
   * There is a second, sharper arm of the same fault. The walk below requires an ancestor that
   * is ALREADY overflowing; before the bodies land there may be nothing to scroll at all, the
   * walk falls off the top and returns, and no later event brings it back. That case anchors
   * nothing whatsoever rather than anchoring imprecisely.
   *
   * So the anchor is re-applied while the conversation's own box keeps changing size, and
   * handed over to the reader the moment they touch it — a wheel, a drag, a key, a press.
   * Bounded by that handover and by a timeout, so a thread that never settles cannot hold the
   * scroller for ever. `ResizeObserver` and not a hydration dependency: it fires on the thing
   * that actually invalidates the position (the stack got taller), so a body that arrives
   * without changing the height costs nothing, and it is guarded for environments without one.
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
       * SQUARE THE SCROLL GEOMETRY, so the flush bottom line is exact. Engines snap the
       * maximum scroll offset to whole pixels, but the panel stack's height is fractional —
       * so scrolled to the end, the last panel could rest a sub-pixel off the columns'
       * shared baseline, or leave a hairline of canvas under itself. The last PANEL absorbs
       * that fraction as ≤1px of inner bottom padding, making content height − viewport an
       * integer; its own surface swallows the remainder and the flush edge stays exact.
       * Reset first so the measurement is of the unpadded stack; only when the stack
       * actually overflows, because a non-scrolling thread has no maximum offset to square
       * (and jsdom, which reports zero-height rects, takes that branch and stays inert).
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
   * A PROTECTED MESSAGE RENDERS NO TEXT, AND IT IS THIS BRANCH THAT MAKES IT TRUE.
   *
   * `isProtected` is checked FIRST and `body` is not consulted inside it: a protected
   * message renders the block and no text at all, whatever the mirror or a hydration
   * happens to hold for it. The endpoint's own text is already redacted server-side
   * (`message-service.ts` `getBody`), so hydration cannot introduce a secret here — but
   * "the text we were given is safe" and "this pane does not render a protected message's
   * text" are two different guarantees, and the second is the one a reader can see.
   *
   * AND IT IS NOW THE ONLY EXPRESSION THAT RENDERS THE MAIL HERE. This pane used to hand
   * `ReadingPane` a `body` STRING whenever there was no conversation — a third render path, and
   * the one most messages took, which `ReadingPane` drew as its own `<p className="msg-body">`.
   * A body fix that only reached `focusedBody` would have been invisible on exactly the common
   * case. `children` replaces `body` in `ReadingPane`, so the pane composes that slot itself
   * now, always, and the `body` prop is not passed in any case.
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
   * ── WHICH RENDERING IS ON SCREEN, BECAUSE THE STRIP BELOW DEPENDS ON IT ──────────────────
   *
   * Mail that declares no layout canvas is drawn in the app's own typography over the TEXT part,
   * and that rendering draws NO IMAGES. So a picture the sender embedded with `cid:` — a photo
   * pasted into a reply, a scanned page, a chart — is painted nowhere, while the strip beside it
   * has always withheld exactly those parts on the grounds that the body already showed them. Two
   * defensible rules that between them made a picture in somebody's mailbox unreachable from the
   * whole product.
   *
   * The strip therefore lists the message's pictures WHEN, AND ONLY WHEN, nothing else is drawing
   * them. In the framed rendering the html paints them and the filter stands, because a strip that
   * listed them there would be naming each picture a second time.
   *
   * ONE STRING, KEYED BY MESSAGE, AND BOTH HALVES MATTER. Keyed, so the answer for the last
   * message cannot decide this one's strip for the frame between selecting it and its body
   * reporting; a primitive, so `setState` with an unchanged value hits React's bail-out and a
   * child effect that reports on every render cannot become a render loop. Unknown reads as
   * FRAMED — today's behaviour — so the widened list is something a positive signal turns on.
   */
  const [bodyRendering, setBodyRendering] = useState("");
  const onRenderMode = useCallback(
    (mode: "prose" | "framed") => setBodyRendering(`${message.id}:${mode}`),
    [message.id],
  );
  const nativeBody = bodyRendering === `${message.id}:prose`;

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
      label={extra?.label}
      redactedNote={extra?.redactedNote}
      policy={extra ? <ProtectedPolicy text={extra.policy} /> : undefined}
    />
  ) : (
    /* A `<div>` rather than the `<p>` this was, because `BodyText` emits the paragraphs
       now and a `<p>` may not contain one. `.msg-body` is unchanged and stays the one element
       that holds the mail and nothing else, which is what `test/conversation.test.ts` and
       `test/inline-reply.test.ts` select on and what a reader is entitled to assume. */
    <div className="msg-body">
      {/* The consent path for remote images. `remoteImages` is ABSENT on a client that
          has no proxy (`?demo=1`, the desktop shell, a test with no API), and `MessageBody`
          answers that by offering no button at all rather than a dead one.

          `remoteLoaded` is the OR of THREE facts that mean the same thing to a reader and are
          stored in different places: the server's `loadedRemoteContent`, which is why images
          stay loaded across a reload; this session's press, which is why they appear at
          the moment it happens; and the ACCOUNT's own setting, which is why most readers never
          see the button at all. The mirror's body record is not re-fetched on consent —
          `hydrateBody` returns early on a `ready` record — so without the second term the
          button would write a row and change nothing on screen.

          `auto` is the product default (mail 0048). It admits PICTURES through the proxy; the
          sanitizer still refuses the proxy to a beacon or a 1×1 in both modes, so a tracking
          pixel is no more loaded here than it was before.

          `onLoadRemote` is withheld in auto mode, which is what removes the button: `MessageBody`
          offers no control it cannot honour, and "Show images" over images that are already
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
          /* LOOKING IS WHAT A PRESS DOES, and WHICH FILES OFFER IT IS DECIDED HERE rather than
             in the strip — the strip stays a pure component that asks no questions, and the
             answer is a security judgement with one owner. A type this app can draw inline
             (image, PDF, text) opens the Quick-Look overlay; everything else — a docx, a zip,
             and an SVG, which is a document that executes script — cannot be previewed at all
             and its tile saves. The metadata carries the type whatever the item's byte state, so
             the decision needs no fetch.

             THE SWAP CHANGED THE GEOMETRY, NOT THIS LINE. `isPreviewable` is the same predicate
             with the same owner and the same refusals; what moved is which control is the big
             one. An attachment is usually opened to be read once, and a press that put the file
             in ~/Downloads made the reader find it, open it elsewhere and then delete it.

             AND ON THE DESKTOP, A PDF IS NOT ONE OF THEM — `opensInSystemViewer` is the second
             half, and it subtracts rather than adds. That window cannot draw a PDF at all: the
             renderer needs a worker, the window's policy is `worker-src 'none'`, and both desktop
             bundles alias the library away for it. Offering the eye there produced a viewer whose
             only possible outcome was a panel saying to download the file instead — over a
             Download that, until this change, could not deliver one. Without the eye, the tile's
             own press is the whole gesture and it opens the PDF in the program this computer uses
             for PDFs. It answers false everywhere else, including the whole web app. */
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
   * Said for everything that is not the mail — and `snippet` IS one of those things here.
   *
   * This used to exempt `snippet` alongside `full`, on the argument that the shell hydrates on
   * selection so a snippet is a sub-frame state and a sentence that appears and vanishes within
   * one frame is noise. The premise was false in the case that matters. `hydrateBody` writes its
   * `loading` marker at ENQUEUE now, but before that it wrote it only once a fetch DEPARTED, and
   * departures are capped at four — so the fifth message opened during a busy tick had no
   * `message_body` record at all, `bodyOf` answered `snippet`, and this pane rendered 200
   * characters of the mail cut mid-word inside full message anatomy with NOTHING saying more was
   * coming. Silent, indistinguishable from a short email, and worst exactly when the app is busy.
   *
   * The engine's marker closes that window; this line is the second half of the same fix, and it
   * is the half that does not depend on getting the enqueue right. Both panes hydrate what they
   * render, so a snippet AT REST in this pane is a defect by construction — the honest thing to
   * say about it is that the message is still coming, which is what a reader can act on.
   *
   * THE FAILURE CARRIES A CONTROL, not only a sentence. The stream cards recover on their
   * own (re-expand, or scroll back and become current again); this pane's hydration is keyed
   * on the selected id, so without a button a single 500 leaves the body unreachable until
   * the user selects away and returns — a dead end nobody would guess the exit from.
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
   * ── THE FAILURE'S TAXONOMY: AUTH LOSS IS NOT A CONTENT FAILURE ───────────────────────────
   *
   * "Couldn't load the full message — Retry" was this pane's one sentence for every failure,
   * and during a dead session it was the WRONG one: the message is fine, the session is gone,
   * and the offered Retry could only re-401 — observed in live use, with the reader told the
   * MESSAGE was broken. So when the session's death is CONFIRMED (`session-truth.ts`: the
   * server itself refused the refresh; never one request's evidence), the note names the real
   * fact and offers the real remedy. On the desktop and in the demo the store never leaves its
   * resting value and this branch is unreachable.
   *
   * And a failure recorded while the session was bad must not outlive the recovery: on every
   * REVIVAL — a real 204 minting a real session — a body still sitting in `failed` is asked for
   * once more. `retry: true` is legitimate here for the same reason the human press is: the
   * engine's no-auto-re-ask rule guards against looping on a server that KEEPS refusing, and a
   * freshly minted session is the world having changed, bounded to one ask per revival.
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
   * ── THE TITLE'S CHROME — SIGNALS INLINE, TAGS FOLDED ──────────────────────────────────────
   *
   * Two different things used to share one wrapping row directly under the subject. The routing
   * rationale and the tracker shield are SIGNALS the product is stating about this message — they
   * are here to be read once, and there are at most two of them. The tags are the reader's OWN
   * marks, and a message can carry several; rendered as a row of full colour chips right under the
   * title they dominated the head of every tagged message, so a mark meant to be quiet read louder
   * than the sender.
   *
   * So the signals keep their inline row (rendered only when one exists — no empty gap otherwise),
   * and the tags move into the same collapsed `(i)` disclosure the list explainers use: a quiet
   * "{n} tags" line under the title that opens to the colour chips on demand. The list rows are
   * left exactly as they were — a tag there is a scanning aid at row scale, not the head of an
   * open letter, so `MessageRow` still renders its chips inline.
   *
   * ── AND THE `+ Tag` AFFORDANCE IS NO LONGER ONE OF THEM ───────────────────────────────────
   *
   * A dashed `+ Tag` chip used to stand here permanently, outside the fold, with its own `addRef`
   * anchor and a hand-typed `t` hint. Reported twice — *"Tag + is still under the title and not in
   * the Pill shape (I gave this feedback before). Added Tags should stay where they are, but the
   * + Tag element should go into the Pill UI."* — so the ENTRY POINT is a verb of the action bar
   * now (see `ActionBar`'s `tag`) and the chip is deleted rather than left standing beside it: two
   * controls opening one picker is what the note is about.
   *
   * What is left under the title is only what the note asked to leave alone — the message's own
   * marks. And with the affordance gone, an untagged message renders no `.tag-chrome` at all: the
   * row existed to hold a control that is somewhere else, and an empty flex box under every
   * untagged subject is a gap with nothing in it.
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
   * THE FOCUSED MESSAGE'S OWN HEADER — the same {@link MessageHeader} an expanded sibling wears,
   * so the message you opened and the ones around it read identically: avatar, the names-first
   * sender that is still the screening control, the ⋯ actions menu left of the stamp, the
   * message's own quiet subject line (SUBJECT-D — the raw `m.subject`, and the subject-rule
   * entry where the shell offers the sheet), and the recipients line whose "details" press
   * reveals the full To/Cc, the exact date and where the message physically sits
   * (`physicalFolder`). `onEnterReader` rides here now — the from-line it used to hang off is
   * gone from `ReadingPane`.
   *
   * NO LARGE `<h2>` AND NO THREAD LEDE ANY MORE: the 24px heading (and the one-time lede the
   * thread wrapper opened with) is deleted with the viewer redesign — the subject is per
   * message, in the header, uniformly, on a single message exactly as on every thread panel.
   * `test/conversation.test.ts` holds the absence.
   */
  const focusedHeader = <MessageHeader message={message} now={now} onEnterReader={onEnterReader} />;

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
   * ── THE THREAD DOES NOT ROUTE THROUGH `ReadingPane` — an article cannot wrap N panels ────
   *
   * The wrapper below is the scrolling column: every message on the conversation is its own
   * full-width, full-body panel (`.pm`), oldest first, sitting directly on the canvas — the
   * `.read-col` drops its panel skin for this case (`message.css`). No peek rows, no counts,
   * no "show earlier": every panel is the mail itself (`ConversationPanels`).
   *
   *   · NO LEDE: the column opens on the oldest panel. Every panel prints its OWN subject in
   *     its header (SUBJECT-D, `MessageHeader`) — the one-time thread heading is deleted, and
   *     with it the suppression that decided which panels earned a line.
   *   · The FOCUSED panel is composed here (the protected rule decided first, the hydrated
   *     body, the attachment strip, the body-state line — and the signal/tag marks, which are
   *     facts about THIS message and ride its panel now the lede is gone); `aria-current`
   *     marks it, and the focus is never remapped.
   *   · The PILL and the reply dock are direct children of the wrapper, AFTER the panels, so
   *     `.msg-actions`' sticky rule pins the one bar at the foot of the scrolling column
   *     exactly as it pins inside `.msg` — and the editor docks under it, one copy, below the
   *     conversation.
   *
   * `role="group"` because `aria-label` on a bare div is ignored, and a landmark
   * (`<section>`) would be too loud for one part of one view.
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

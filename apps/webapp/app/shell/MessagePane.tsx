"use client";

/**
 * One message anatomy for the Ohbox read column AND the reader overlay:
 * from-line, subject, chips (routing rationale, tracker shield, tags,
 * add-affordance), body or the protected-OTP block, attachment, actions.
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { FOLDER_OF_VIEW, isProtectedMessage, type EngineMessage, type OhmailView, type TagDTO } from "@ohmail/client-engine";
import { Button, Chip, Icon, Kbd, ProtectedBlock, ReadingPane } from "@ohmail/ui";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { isPreviewable } from "../components/AttachmentPreview";
import { MessageBody } from "../components/MessageBody";
import { ConversationEntries, ConversationHead } from "./Conversation";
import { PLACE_LABEL, avatarHue, dayNine, dayValue, displayTime, hueOf, initialsOf, metaLine, nextWeekNine, rowAddress, senderName, tagsOfMessage, tomorrowNine } from "./format";
import { InlineReply } from "./InlineReply";
import { chordKeys, useBinding, useKeyPress } from "./keymap";
import { useBodyStalled, useMessageChrome } from "./message-chrome";
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
  | "draft"
  | "unread"
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
type BarPanel = "move" | "resurface";

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
 * `ohbox-read-state.test.ts` calls *"`u` is not undone by a dwell that is already
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
}: {
  message: EngineMessage;
  /** The clock the resurface presets are computed against — tomorrow/next week from here. */
  now: Date;
  panel: BarPanel | null;
  onPanel: (next: BarPanel | null) => void;
  onAction: (action: MessageAction) => void;
  onScreen: (anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("ohbox");
  const tr = useTranslations("screening");
  const press = useKeyPress();
  /** Hoisted above `toggleRead`, which needs it to decide WHICH key it is standing in for. */
  const read = !message.unread;
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
   * Marking read/unread — the key's own handler wherever the key exists. See the header.
   *
   * `press` and NOT `useBinding("u")?.run()`. The second is what this was, and it was wrong
   * in a way only a browser showed: two presses in a row marked the message read twice,
   * because the memoised binding array holds closures from the last SHAPE change and `u`'s
   * shape does not change when read-state does. `press` resolves the handler when it is
   * called, exactly as the keydown dispatcher does. See `Registry.press`.
   *
   * ── ONE BUTTON, TWO KEYS, AND THAT IS DELIBERATE ──────────────────────────────────────
   *
   * The KEYBOARD gets two idempotent directions (`u` unread, `⇧I` read) because a toggle over
   * a mixed selection inverts it into a different mixed selection — see `OhboxView.markUnread`.
   * The BUTTON is one control, because there is only one message under it and one of the two
   * directions is always a no-op: offering both would put a dead control on the bar half the
   * time. So the button presses whichever key is the live one, which keeps every path through
   * `pinnedUnread` and means the button can never do something the key refuses to.
   */
  const markChord = read ? "u" : "shift+i";
  const toggleRead = () => {
    if (!press(markChord)) onAction("unread");
  };

  const defer = (
    <>
      {/* "Later", not "Answer Later". Inside a control whose own name is "Not now", each
          segment need only carry its HORIZON — the shared idea is said once, by the group,
          instead of three times by its members. It is also the 45px that decides whether
          filing fits on the row at the 569px the reading measure allows. */}
      <button type="button" className="abar-b" onClick={() => onAction("later")}>
        {copy("actionLater", "Later")}
        <Key chord="a" />
      </button>
      <button type="button" className="abar-b" onClick={() => onAction("aside")}>
        {t("actionSetAside")}
        <Key chord="e" />
      </button>
      {/* Resurface OPENS A HORIZON CHOOSER — it is the one "not now" verb that answers "how
          long?", so a single click cannot mean it. `b` still stands for it: the key is the
          keyboard's quick default (the shell resolves plain `resurface` to next Friday), and
          the panel is where a specific when is chosen. */}
      <button type="button" className="abar-b" onClick={() => onPanel("resurface")}>
        {t("actionResurface")}
        <Key chord="b" />
      </button>
    </>
  );

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
          {MOVE_TARGETS.filter((v) => FOLDER_OF_VIEW[v] !== message.folder).map((v) => (
            <button
              key={v}
              type="button"
              className="abar-b abar-solo"
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
    { id: "later", group: "defer", label: copy("actionLater", "Later"), run: () => { closeMenu(); onAction("later"); } },
    { id: "aside", group: "defer", label: t("actionSetAside"), run: () => { closeMenu(); onAction("aside"); } },
    { id: "resurface", group: "defer", label: t("actionResurface"), run: () => { closeMenu(); onPanel("resurface"); } },
    { id: "screen", group: "file", label: tr("action"), run: () => { setMenuOpen(false); onScreen(moreRef.current); } },
    { id: "move", group: "file", label: t("actionMove"), run: () => { closeMenu(); onPanel("move"); } },
    {
      id: "draft",
      label: t("actionDraftReply"),
      icon: <Icon name="spark" size={13} />,
      run: () => { closeMenu(); onAction("draft"); },
    },
  ];

  return (
    <div className="abar">
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

        <div
          className="abar-g abar-seg abar-defer"
          role="group"
          aria-label={copy("groupDefer", "Not now")}
        >
          {defer}
        </div>

        <div
          className="abar-g abar-seg abar-file"
          role="group"
          aria-label={copy("groupFile", "File it")}
        >
          {file}
        </div>

        <div className="abar-g abar-read-g">
          {/*
           * THE LABEL SAYS WHAT PRESSING IT WILL DO, and that is the correction.
           *
           * This was `role="switch"` labelled "Read", reporting the CURRENT state with the
           * action hidden in the `title`. A switch is the right shape for a setting; read-state
           * is a thing you DO to a message, and a control whose visible word is the state
           * leaves the reader to work out which way pressing it goes. "Mark unread" on a read
           * message answers that without being hovered — and it is the same sentence the
           * keyboard's own two verbs use, so the bar and the `?` sheet read alike.
           *
           * The keycap follows the direction: `u` marks unread, `⇧I` marks read, and the
           * button shows the one it is about to stand in for. `<Key>` reads the live registry,
           * so a chord that moves takes the hint with it and a chord that is not bound here
           * (the desktop shell, a pane with no provider) shows nothing at all.
           */}
          <button
            type="button"
            className="abar-b abar-solo abar-read"
            onClick={toggleRead}
          >
            <span className="abar-dot" aria-hidden="true" />
            {read ? copy("actionMarkUnread", "Mark unread") : copy("actionMarkRead", "Mark read")}
            <Key chord={markChord} />
          </button>

          {/*
           * ICON-ONLY, and that is a measurement rather than a preference: dropping the word
           * "More" is 35px, and 35px is the difference between filing standing on the row at
           * the 569px reading measure and being pushed into this menu itself. A disclosure is
           * the one control here whose meaning survives without a label — pressing it is the
           * only thing it can do — so it is the right 35px to spend. The name is not lost,
           * it moves to `aria-label` and the tooltip.
           */}
          {/*
           * `aria-expanded` REPORTS THE MENU, and until this slice it was the literal `false`.
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
  const [panel, setPanel] = useState<BarPanel | null>(null);
  useEffect(() => setPanel(null), [message.id]);
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
  const tr = useTranslations("screening");
  /** The conversation's copy lives with the reply's — one namespace owns the thread. */
  const tc = useTranslations("reply");
  /** Hydration state copy, shared with the Reads/Receipts cards and the Screener preview. */
  const tb = useTranslations("body");
  const addRef = useRef<HTMLSpanElement>(null);
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
  const [panel, setPanel] = useState<BarPanel | null>(null);
  const chrome = useMessageChrome();

  // A half-open destination row must not carry over to the next message.
  useEffect(() => setPanel(null), [message.id]);

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
  const replying = chrome.replyTo === message.id;
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
   * Keyed on the joined id list rather than on `conversation`, which is a fresh array on every
   * render (see above — it is computed inline on purpose). An array dep would re-fire this on
   * every mirror version bump, and every bump is caused by the very writes this call produces.
   *
   * IT LIVES HERE RATHER THAN IN `ConversationEntries`, WHICH IS WHERE IT USED TO LIVE, because
   * that component is mounted TWICE per thread — the siblings above the opened message and the
   * siblings below it are two lists — so an effect inside it asked twice for one act of opening
   * one conversation. This is the only place that holds the whole thread.
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
   * A conversation renders oldest→newest (`ConversationEntries` above/below the focused
   * message), so a fresh render sits at the TOP, on the oldest mail, and the reader has to
   * scroll down to reach what just arrived. This puts the newest on screen the moment the
   * pane paints.
   *
   * The FOCUS is NOT remapped — `message` stays the id that was opened (ActionBar, reply,
   * read-state and selection all key on it). The anchor is purely a scroll position: the LAST
   * `[data-conv-id]` element in the stack, which is the newest sibling (or the focused message
   * itself when it is the newest).
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
   * The from-line count. Real on Cloud now; the fixture fallback stays because the demo
   * world sets `threadId: null` on every row (`fixtures-adapter.ts`) and carries a curated
   * `threadCount` instead — dropping it would delete chrome the demo ships today.
   */
  const threadCount = conversation.length >= 2 ? conversation.length : message.threadCount;

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
       that holds the mail and nothing else, which is what `conversation.test.ts` and
       `inline-reply.test.ts` select on and what a reader is entitled to assume. */
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
          items={attachments.itemsOf(message.id)}
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
             in ~/Downloads made the reader find it, open it elsewhere and then delete it. */
          onPreview={(attachmentId) => chrome.openAttachmentPreview(message.id, attachmentId)}
          canPreview={(item) => isPreviewable(item.mimeType)}
          onDownloadAll={() => attachments.downloadAll(message.id)}
          downloadingAll={attachments.downloadingAll(message.id)}
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
  const bodyNote =
    isProtected || body.state === "full" ? undefined : body.state === "failed" || stalled ? (
      <>
        {tb("failed")}{" "}
        {/* `retry` because this IS a human asking again. An automatic trigger deliberately
            does not re-ask a server that already refused — see `hydrateBody`. */}
        <Button variant="ghost" onClick={() => chrome.hydrateBody(message.id, { retry: true })}>
          {tb("retry")}
        </Button>
      </>
    ) : (
      tb("loading")
    );

  return (
    <ReadingPane
      from={senderName(message)}
      address={rowAddress(message)}
      avatarInitial={initialsOf(senderName(message))}
      avatarHue={avatarHue(message.from.address)}
      onSender={(anchor) => chrome.openSenderMenu(message.id, anchor)}
      senderTitle={tr("openFor", { sender: message.from.address })}
      /* `threadMeta` used to be the literal "thread ({count}) · " and this was a
         concatenation, so a message with no `Date:` header rendered "thread (3) · " with
         nothing after the separator, and a threadless one rendered an empty stamp. The key no
         longer carries the punctuation and `metaLine` prints a separator only between two
         values that exist. */
      /**
       * WHERE IT ACTUALLY IS, whenever that is not where it is being shown.
       *
       * `physicalFolder` is set by the consent projection on exactly the messages whose place
       * and folder differ — a consented sender's backlog presented in the Ohbox while it sits
       * in the Screener folder, and everything in History. Those are the only cases; a message
       * shown in the pile it is filed in says nothing extra, because there is nothing to say.
       *
       * It matters because the product's promise is to organise a mailbox in place. A reader
       * who wants to find this message in Apple Mail needs the server's answer, not ours, and
       * a presentation that never admitted to being one would be the product quietly claiming
       * to have moved mail it deliberately did not move.
       */
      time={metaLine(
        threadCount ? t("threadMeta", { count: threadCount }) : null,
        message.physicalFolder ? t("onServer", { folder: message.physicalFolder }) : null,
        displayTime(message, now),
      )}
      subject={message.subject}
      onEnterReader={onEnterReader}
      chips={
        <>
          {message.rationale ? <Chip variant="rationale">{message.rationale}</Chip> : null}
          {message.trackerNote ? <Chip variant="tracker">{message.trackerNote}</Chip> : null}
          {mine.map((tag) => (
            <Chip key={tag.id} variant="tag" hue={hueOf(tag)} big>
              {tag.name}
            </Chip>
          ))}
          <span ref={addRef} style={{ display: "inline-flex" }}>
            <Chip
              variant="add"
              kbdHint="t"
              onPress={() => onAddTag(message.id, addRef.current)}
            >
              {t("tagChip")}
            </Chip>
          </span>
        </>
      }
      bodyNote={bodyNote}
      bodyNoteFailed={body.state === "failed" || stalled}
      actions={
        <ActionBar
          message={message}
          now={now}
          panel={panel}
          onPanel={setPanel}
          onAction={onAction}
          onScreen={(anchor) => chrome.openSenderMenu(message.id, anchor)}
        />
      }
      reply={
        replying ? (
          <InlineReply
            /* NO `context` AND NO `now` ANY MORE. The editor was handed the whole
               conversation (or `[message]`) to render in its own scroller; the pane above
               owns that job now, so the editor takes the message it is answering and
               nothing else — the `to` line, the draft key and `canSend` are all it needs
               a message FOR. */
            message={message}
            value={chrome.replyBody}
            send={chrome.replySendState(message.id)}
            onChange={chrome.onReplyBody}
            onClose={chrome.closeReply}
            onSend={() => chrome.sendReply(message.id)}
            /* The AI drafter's offer renders inside the editor the draft lands in — see
               `InlineReply`. Absent where there is no drafter: the desktop shell, and any
               harness that mounts a pane without the shell. */
            draftReply={chrome.draftReply}
          />
        ) : undefined
      }
    >
      {/* THE CONVERSATION IN THE MESSAGE.
          Oldest first, and the message you opened keeps the full anatomy — plain prose
          between carded siblings — so which one is focused needs no legend. Siblings older
          than it sit above and newer ones below, which means the stack reads in order
          whichever message was opened, not only the newest. */}
      {showConversation ? (
        // `role="group"` because `aria-label` on a bare div is ignored, and a landmark
        // (`<section>`) would be too loud for one part of one message.
        <div className="conv" role="group" aria-label={tc("conversationAria")} ref={convRef}>
          <ConversationHead count={conversation.length} />
          <ConversationEntries
            messages={conversation.filter((m) => before(m, message))}
            threadSubject={message.subject}
            now={now}
          />
          <div className="conv-focus" data-conv-id={message.id} aria-current="true">
            {focusedMessage}
          </div>
          <ConversationEntries
            messages={conversation.filter((m) => m.id !== message.id && !before(m, message))}
            threadSubject={message.subject}
            now={now}
          />
        </div>
      ) : (
        // `focusedBody`, not `isProtected ? focusedBody : undefined`. The `undefined` arm
        // was what fell through to `ReadingPane`'s own `body` string; `focusedBody` already
        // answers both cases, and the protected rule is unmoved — it is decided where it
        // always was,
        // by the `isProtected` branch at the top of this component, which is still first and
        // still never consults `body`.
        focusedMessage
      )}
    </ReadingPane>
  );
}

/**
 * Is `m` earlier in the conversation than the opened message?
 *
 * The comparison is on the ORDER `threadOf` already sorted by — date, id as the tiebreak —
 * rather than on dates alone, so a thread whose messages share a timestamp (a seeded or
 * imported chain) still splits at exactly one place and never renders a message twice or
 * not at all. The opened message itself is never "before" itself.
 */
function before(m: EngineMessage, focused: EngineMessage): boolean {
  const tm = m.date ? Date.parse(m.date) : 0;
  const tf = focused.date ? Date.parse(focused.date) : 0;
  if (tm !== tf) return tm < tf;
  return m.id < focused.id;
}

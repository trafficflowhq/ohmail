"use client";

/**
 * THE PER-MESSAGE PANEL, AND THE HEADER EVERY MESSAGE WEARS.
 *
 * ── PANELS OVER LOADED BODIES ───────────────────────────────────────────────────────────────
 *
 * A conversation renders one panel PER MESSAGE, and every one of those messages has its body
 * already in the mirror: `MessagePane` hydrates the whole thread on open (`hydrateThread`), so
 * nothing here is withheld, gated behind a fetch, or replaced by a "N older" placeholder. The
 * peek-row fold this file used to carry is gone with the viewer redesign: every message on the
 * thread shows its body, full width, and the wrapper is the one scroller — a thread is a column
 * of letters again, but each on its OWN panel, separated by the canvas, so the stack reads as a
 * conversation rather than as one unbroken scroll.
 *
 * ── TWO SHARED PIECES ───────────────────────────────────────────────────────────────────────
 *
 *  · {@link MessageHeader} — one grammar for every panel: avatar and sender NAMES-FIRST (the
 *    bold name with the small address beside it, and a no-name sender prints the bare address
 *    ONCE — `senderName`/`rowAddress`, `format.ts`), the ⋯ actions menu LEFT of the stamp with
 *    the date on the right, the message's own quiet subject line under the sender (SUBJECT-D —
 *    the RAW `m.subject`, reply prefixes included), and the recipients WRITTEN OUT (viewer redesign)
 *    — To and Cc in full, each recipient a chip that opens {@link ContactPopover}, with a
 *    "details" press left holding only what the chips do not say: the exact date and where the
 *    message physically sits. Worn by the focused message (composed by `MessagePane`) and by a
 *    sibling panel alike, so a message reads the same wherever it is.
 *
 *  · {@link MessageCard} — a conversation SIBLING's panel: the header and the body through the
 *    very same {@link MessageBody} the focused message uses. One `<article class="pm">` per
 *    message — the panel treatment every message on the thread wears, the focused one included.
 */
import { type ReactNode, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Avatar, Button, Icon } from "@ohmail/ui";
import { type EngineMessage } from "@ohmail/client-engine";
import { MessageBody } from "../components/MessageBody";
import { replyAllRecipients } from "./compose-from";
import { ContactPopover, type ContactPopoverState } from "./ContactPopover";
import {
  avatarHue,
  displayTime,
  fullDateTime,
  initialsOf,
  recipientRows,
  rowAddress,
  senderName,
  type RecipientRowChip,
} from "./format";
import { displayAddress } from "./idn";
import { useBodyStalled, useMessageChrome } from "./message-chrome";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";
import { placePicker } from "./TagPicker";

/**
 * THE HEADER — who it is from, what it is called, when, and who else it went to.
 *
 * Reads `ownAddresses` and `openSenderMenu` off the chrome rather than as props, for the reason
 * the whole chrome exists: the pane is mounted twice and holds no engine hook, and the header is
 * rendered inside both mounts. `onEnterReader` is the one thing a CALLER varies — the reader
 * affordance on the split-column focused message — so it comes as a prop. (`onCollapse` left
 * with the peek rows: there is no fold to operate any more.)
 *
 * ── THE ⋯ MENU — the message's verbs, per panel, LEFT of the stamp ─────────────────────────
 *
 * Reply / Reply all / Forward live in a disclosure menu in the header's right cluster, on every
 * panel — the focused message and its siblings wear the same one, so answering an older message
 * on the thread never requires first making it the focused one. The `.hm-foot` text-verb footer
 * this replaces is deleted, not moved. Each item dispatches THIS header's `message.id`; Reply
 * all is offered only where {@link replyAllRecipients} returns an envelope for THIS message —
 * the predicate the pill and the send path resolve, so a 1:1 message offers it nowhere. Items
 * degrade by OMISSION where the chrome is inert (the desktop shell, a bare test): no verbs, no
 * trigger — never a menu of dead controls. The menu itself is the pill's own {@link MoreMenu} —
 * same roving focus, same key claims — anchored to drop DOWN from the header (`.msg-menu`,
 * `app.css`) rather than up from the bar.
 */
export function MessageHeader({
  message,
  now,
  onEnterReader,
}: {
  message: EngineMessage;
  now: Date;
  onEnterReader?: () => void;
}) {
  const tm = useTranslations("message");
  const tr = useTranslations("screening");
  const to = useTranslations("ohbox");
  const chrome = useMessageChrome();
  const [details, setDetails] = useState(false);
  /** The ⋯ disclosure. The trigger owns the keyboard's way back — see `closeMenu`. */
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  /**
   * The open contact popover, or null — one per header, because one chip is pressed at a time
   * and a second press re-points it (the same one-question-at-a-time rule the ⋯ menu keeps).
   * The pressed chip element is held beside it so Escape can put the keyboard back where the
   * press came from, and so the screening sheet is anchored on the chip rather than nowhere.
   */
  const [contact, setContact] = useState<(ContactPopoverState & { key: string }) | null>(null);
  const contactAnchor = useRef<HTMLButtonElement | null>(null);
  // A message swap in the same mounted position (the single-message pane re-pointed by
  // selection) must not leave a menu open over a different message's verbs — same rule the
  // pill applies on `message.id`. The contact popover follows it for the same reason.
  useEffect(() => { setMenuOpen(false); setContact(null); }, [message.id]);
  const closeMenu = (): void => {
    setMenuOpen(false);
    moreRef.current?.focus();
  };
  const closeContact = (): void => {
    setContact(null);
    contactAnchor.current?.focus();
  };

  // `?? []` tolerates a bare test harness that predates the field; the real provider always
  // supplies it (default `[]`), so on every live path this is exactly `chrome.ownAddresses`.
  const ownAddresses = chrome.ownAddresses ?? [];
  const name = senderName(message);
  const address = rowAddress(message);
  const rel = displayTime(message, now);
  const abs = fullDateTime(message);
  /** Show the absolute form when the reader has asked for it AND there is one to show. */
  const showAbs = chrome.absoluteTime && !!abs;
  const rows = recipientRows(message, ownAddresses);

  /**
   * The menu's items, built from what the chrome actually wires — an unwired verb is an absent
   * item, and zero items is no trigger at all. Every `run` closes the menu FIRST so the focus
   * return does not race the editor the dispatch opens.
   */
  const menuItems: MoreMenuItem[] = [];
  if (chrome.openReply) {
    menuItems.push({
      id: "reply",
      label: tm("menuReply"),
      run: () => { closeMenu(); chrome.openReply!(message.id); },
    });
    if (replyAllRecipients(message, ownAddresses) !== null) {
      menuItems.push({
        id: "reply_all",
        label: tm("menuReplyAll"),
        run: () => { closeMenu(); chrome.openReply!(message.id, true); },
      });
    }
  }
  if (chrome.forward) {
    menuItems.push({
      id: "forward",
      label: tm("menuForward"),
      run: () => { closeMenu(); chrome.forward!(message.id); },
    });
  }

  /**
   * ── THE RECIPIENTS, WRITTEN OUT (viewer redesign) ────────────────────────────────────────────────
   *
   * To and Cc in full, one CHIP per person — the folded "to me, Anna Roth +2 · cc 2" line and
   * the details-press-to-see-everyone are retired: who a message went to is not a secret worth
   * one more press. (`Bcc` does not render because the wire does not carry it: an incoming
   * message's blind copies are, by definition, not in its headers, and `EngineMessage` has no
   * such field — a row for it would be a control over data that cannot exist.)
   *
   * The FACE is names-first and decoded (`displayAddress`); the VALUE under every chip is the
   * stored wire address, which is what the popover's verbs dispatch. A "me" chip wears the
   * ACCOUNT's identity — `chrome.ownNameOf` (from `GET /mailboxes`' `displayName`), never the
   * sender's spelling of the reader — and falls back to the bare address when the mailbox
   * carries no label, because inventing a name is worse than omitting one.
   */
  const chipRow = (label: string, group: "to" | "cc", chips: RecipientRowChip[]): ReactNode =>
    chips.length === 0 ? null : (
      <div className="rcpt-row">
        <span className="rcpt-k">{label}</span>
        {chips.map((r, i) => {
          const key = `${group}:${i}`;
          const face = r.me ? (chrome.ownNameOf?.(r.address) ?? null) : r.name;
          const shown = displayAddress(r.address);
          return (
            <button
              key={key}
              type="button"
              className="rcpt-chip"
              aria-haspopup="menu"
              aria-expanded={contact?.key === key}
              onClick={(e) => {
                contactAnchor.current = e.currentTarget;
                setContact({
                  key,
                  messageId: message.id,
                  address: r.address,
                  name: face,
                  ...placePicker(e.currentTarget),
                });
              }}
            >
              {face ? (
                <>
                  <span className="rcpt-name">{face}</span>
                  {" – "}
                  <span className="rcpt-addr">{shown}</span>
                </>
              ) : (
                <span className="rcpt-addr">{shown}</span>
              )}
            </button>
          );
        })}
      </div>
    );

  /**
   * SUBJECT-D — the message's own quiet subject line, under the sender, on EVERY panel.
   *
   * The RAW `m.subject`, reply prefixes included: "AW: …" is what this message is called, and
   * printing it is what lets a thread's panels tell each other apart now that the one large
   * heading is deleted (`MessagePane`'s `<h2>` and the thread lede both — see
   * `test/conversation.test.ts`). No normalization, no suppression against a thread heading that no
   * longer exists. The line is the subject-rule entry where the shell provides the sheet
   * (`chrome.openSubjectRule`, dispatching THIS message's id) and plain text where it does not
   * — never a dead control. An empty subject renders no line rather than an empty one.
   */
  const subjectLine = message.subject.trim() ? (
    <p className="msg-subject">
      {chrome.openSubjectRule ? (
        <button
          type="button"
          className="subj-rule"
          onClick={() => chrome.openSubjectRule!(message.id)}
        >
          {message.subject}
        </button>
      ) : (
        message.subject
      )}
    </p>
  ) : null;

  return (
    <>
      <div className="msg-from">
        <button
          type="button"
          className="msg-sender"
          // A tooltip and a screen-reader label are both things a person reads, so both get the
          // readable address; the hue below stays keyed on the stored one.
          title={tr("openFor", { sender: displayAddress(message.from.address) })}
          aria-label={tr("openFor", { sender: displayAddress(message.from.address) })}
          onClick={(e) => chrome.openSenderMenu(message.id, e.currentTarget)}
        >
          <Avatar initials={initialsOf(name)} hue={avatarHue(message.from.address)} size="s" />
          <b>{name}</b>
          {address ? <small>{address}</small> : null}
        </button>
        <span className="t num">
          {/* The ⋯ LEFT of the date, date on the right — the menu is an object in the header's
              quiet cluster, and the stamp keeps the outer edge. A real disclosure: haspopup
              with a LIVE expanded (the literal-false defect the pill already fixed), and the
              whole thing absent when there are no items. */}
          {menuItems.length > 0 ? (
            <span className="msg-menu">
              <button
                ref={moreRef}
                type="button"
                className="msg-more"
                aria-haspopup="menu"
                aria-expanded={menuOpen}
                aria-label={tm("actions")}
                title={tm("actions")}
                onClick={() => setMenuOpen((open) => !open)}
              >
                <span aria-hidden="true">⋯</span>
              </button>
              {menuOpen ? (
                <MoreMenu items={menuItems} ariaLabel={tm("actions")} onClose={closeMenu} />
              ) : null}
            </span>
          ) : null}
          {/* Relative by default, the exact instant on hover (`title`) — and clicking flips
              EVERY stamp in the open message to the absolute form at once (`onToggleAbsoluteTime`,
              session- and view-scoped; see the chrome). A `<button>` and not a bare `<time>` so
              the flip is reachable by keyboard; `dateTime` keeps the machine value on the inner
              `<time>`, and `title` names whichever form is NOT on screen. Nothing at all for a
              message with no `Date:` header, rather than an empty stamp element. */}
          {rel ? (
            <button
              type="button"
              className="stamp-toggle"
              onClick={chrome.onToggleAbsoluteTime}
              aria-pressed={chrome.absoluteTime}
            >
              {/* `title` and `dateTime` stay on the `<time>` itself — hover over the stamp shows
                  whichever form is NOT on screen, and the machine value is the element's own. */}
              <time dateTime={message.date ?? undefined} title={(showAbs ? rel : abs) || undefined}>
                {showAbs ? abs : rel}
              </time>
            </button>
          ) : null}
          {onEnterReader ? (
            <button
              type="button"
              className="msg-open"
              title="Read (↵)"
              aria-label="Open reading mode"
              onClick={onEnterReader}
            >
              <Icon name="open" size={13} />
            </button>
          ) : null}
        </span>
      </div>
      {subjectLine}
      {rows.empty ? null : (
        <div className="msg-rcpts">
          {chipRow(tm("toLabel"), "to", rows.to)}
          {chipRow(tm("ccLabel"), "cc", rows.cc)}
          {/* What the chips do not already say: the exact date and where the message
              physically sits. The full To/Cc list left this disclosure — it is ON screen now. */}
          <button
            type="button"
            className="msg-rcpt-more"
            aria-expanded={details}
            aria-label={tm("detailsAria")}
            onClick={() => setDetails((v) => !v)}
          >
            {tm("details")} <Icon name="chev" size={10} />
          </button>
        </div>
      )}
      {details ? (
        <dl className="msg-rcpt-full">
          {abs ? (
            <div>
              <dd>
                <time dateTime={message.date ?? undefined}>{abs}</time>
              </dd>
            </div>
          ) : null}
          {message.physicalFolder ? (
            <div>
              <dd>{to("onServer", { folder: message.physicalFolder })}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
      {contact ? (
        <ContactPopover
          state={contact}
          onWrite={
            chrome.writeTo
              ? () => chrome.writeTo!(contact.address, contact.name ?? undefined)
              : undefined
          }
          onScreen={
            chrome.screenAddress
              ? () => chrome.screenAddress!(message.id, contact.address, contactAnchor.current)
              : undefined
          }
          onClose={closeContact}
        />
      ) : null}
    </>
  );
}

/**
 * A CONVERSATION SIBLING'S PANEL. Pure over its props — there is no fold state left anywhere:
 * the panel renders its body, always, from `chrome.bodyOf` — the record `hydrateThread` already
 * filled on open — so rendering a thread performs NO fetch per panel. The body travels through
 * the same {@link MessageBody} the focused message uses, so a sibling inherits the sanitizer,
 * the sandboxed frame, remote-content blocking and dark adaptation with nothing re-implemented.
 */
export function MessageCard({
  message,
  now,
}: {
  message: EngineMessage;
  now: Date;
}) {
  const tb = useTranslations("body");
  const chrome = useMessageChrome();
  const body = chrome.bodyOf(message);
  const waiting = body.state === "loading" || body.state === "snippet";
  const stalled = useBodyStalled(message.id, waiting);

  const loadingNote: ReactNode = !stalled && waiting ? <p className="hm-state">{tb("loading")}</p> : null;
  /**
   * ── WITHHELD IS ANSWERED, NOT FAILED — the same rule the focused pane follows ──────────────
   *
   * The panel used to enumerate only `loading`/`snippet` and `failed`, so the storage-cap
   * slice's terminal `withheld` state matched NEITHER arm and fell through to a bare
   * {@link MessageBody} over `bodyOf`'s snippet — the PREVIEW presented as the message, with
   * nothing on screen saying the body was never stored. The focused message was honest
   * throughout, which is what kept this invisible: the dishonesty only ever appeared on a
   * sibling of an open thread.
   *
   * No Retry, deliberately, and this is not a styling choice: the server ANSWERED, and its
   * answer is that it holds no content for this message because the account's storage space was
   * full when it arrived. A retry cannot change that, and `failed`'s control exists precisely
   * because a state with no way out is a dead end — offering one that cannot succeed is worse
   * than offering none. Not `warn` either: nothing went wrong, and the mail itself is untouched
   * in the mailbox on the user's own server.
   */
  const withheldNote: ReactNode =
    body.state === "withheld" ? <p className="hm-state">{tb("withheld")}</p> : null;
  const failedNote: ReactNode =
    body.state === "failed" || (stalled && waiting) ? (
      <p className="hm-state warn">
        {tb("failed")}{" "}
        <Button variant="ghost" onClick={() => chrome.hydrateBody(message.id, { retry: true })}>
          {tb("retry")}
        </Button>
      </p>
    ) : null;

  return (
    <article className="pm" data-conv-id={message.id}>
      <div className="pm-in">
        <MessageHeader message={message} now={now} />
        <div className="pm-body">
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
        {loadingNote}
        {withheldNote}
        {failedNote}
        {/* NO VERB FOOTER, AND NOT AN OVERSIGHT. Reply / Reply all / Forward live in the
            header's ⋯ menu now (`MessageHeader`), per panel, through the same chrome the old
            `.hm-foot` buttons dispatched — `test/conversation.test.ts` holds the footer's absence
            and the menu's dispatch-by-panel-id. Still deliberately NOT a second ActionBar: a
            full bar per panel would stack the file / defer / read machinery onto a message the
            reader is only glancing back at. */}
      </div>
    </article>
  );
}

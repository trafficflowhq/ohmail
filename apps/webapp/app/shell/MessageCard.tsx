"use client";

/**
 * THE PER-MESSAGE CARD, AND THE HEADER EVERY MESSAGE WEARS.
 *
 * ── COLLAPSE OVER LOADED BODIES ─────────────────────────────────────────────────────────────
 *
 * A conversation renders one row PER MESSAGE, and every one of those messages has its body
 * already in the mirror: `MessagePane` hydrates the whole thread on open (`hydrateThread`), so
 * nothing here is withheld, gated behind a fetch, or replaced by a "N older" placeholder. A
 * collapsed row is a MESSAGE the reader can open with one press and read instantly, not a count
 * standing in for mail they cannot reach — which is the placeholder the product forbids. What
 * collapse buys is that a ten-message thread is ten legible rows instead of ten full letters
 * stacked into one scroll, with the newest (and whatever the reader opened) already open.
 *
 * ── TWO SHARED PIECES ───────────────────────────────────────────────────────────────────────
 *
 *  · {@link MessageHeader} — avatar, sender name, address (which is the SCREENING control, so it
 *    stays a real button), the relative stamp with the absolute date on hover, and a recipients
 *    line that a "details" press expands into the full To/Cc list, the exact date and where the
 *    message physically sits. Worn by the focused message (composed by `MessagePane`) and by an
 *    expanded sibling alike, so a message reads the same wherever it is.
 *
 *  · {@link MessageCard} — a conversation SIBLING, collapsible. Collapsed is a single button
 *    row (monogram · name · one-line peek · stamp); expanded is the header, the subject when it
 *    diverges from the thread's, and the body through the very same {@link MessageBody} the
 *    focused message uses. One `<article class="hmail">` per message, reusing the Blanc card the
 *    Screener already stacks — no bordered variant is minted, because Blanc is shadow-sculpted.
 */
import { type ReactNode, useState } from "react";
import { useTranslations } from "next-intl";
import { Avatar, Button, Icon } from "@ohmail/ui";
import { type EmailAddress, type EngineMessage } from "@ohmail/client-engine";
import { MessageBody } from "../components/MessageBody";
import {
  avatarHue,
  displayTime,
  fullDateTime,
  initialsOf,
  recipientSummary,
  rowAddress,
  senderName,
  type RecipientChip,
} from "./format";
import { useBodyStalled, useMessageChrome } from "./message-chrome";

/** A subject with its reply prefixes stripped, case-folded — see `Conversation.tsx`. */
const REPLY_PREFIX = /^\s*(?:(?:re|fwd?|aw|wg|sv|vs|antw)\s*(?:\[\d+\])?\s*:\s*)+/i;
export function subjectKey(subject: string): string {
  return subject.replace(REPLY_PREFIX, "").trim().toLowerCase();
}

/** A recipient shown in full in the details block: "me", or "Name <address>", or the address. */
function fullRecipient(r: EmailAddress, own: ReadonlySet<string>, me: string): string {
  if (own.has(r.address.trim().toLowerCase())) return me;
  return r.name ? `${r.name} <${r.address}>` : r.address;
}

/**
 * THE HEADER — who it is from, when, and who else it went to.
 *
 * Reads `ownAddresses` and `openSenderMenu` off the chrome rather than as props, for the reason
 * the whole chrome exists: the pane is mounted twice and holds no engine hook, and the header is
 * rendered inside both mounts. `onEnterReader` and `onCollapse` are the two things a CALLER
 * varies — the reader affordance on the split-column focused message, and the collapse control
 * an expanded sibling needs — so those come as props.
 */
export function MessageHeader({
  message,
  now,
  onEnterReader,
  onCollapse,
}: {
  message: EngineMessage;
  now: Date;
  onEnterReader?: () => void;
  /** Present only on an expanded SIBLING: the chevron that folds it back to a peek row. */
  onCollapse?: () => void;
}) {
  const tm = useTranslations("message");
  const tr = useTranslations("screening");
  const to = useTranslations("ohbox");
  const chrome = useMessageChrome();
  const [details, setDetails] = useState(false);

  // `?? []` tolerates a bare test harness that predates the field; the real provider always
  // supplies it (default `[]`), so on every live path this is exactly `chrome.ownAddresses`.
  const ownAddresses = chrome.ownAddresses ?? [];
  const name = senderName(message);
  const address = rowAddress(message);
  const rel = displayTime(message, now);
  const abs = fullDateTime(message);
  /** Show the absolute form when the reader has asked for it AND there is one to show. */
  const showAbs = chrome.absoluteTime && !!abs;
  const summary = recipientSummary(message, ownAddresses);
  const meLabel = tm("me");
  const nameOf = (chip: RecipientChip): string => ("me" in chip ? meLabel : chip.name);

  // "to me, Anna Roth +2 · cc 2" — assembled from the pure summary, separators only between
  // parts that exist (the `metaLine` rule, kept local because these parts are translated here).
  const toNames =
    summary.to.map(nameOf).join(", ") +
    (summary.toOverflow > 0 ? ` ${tm("plusN", { n: summary.toOverflow })}` : "");
  const parts: string[] = [];
  if (summary.to.length > 0) parts.push(tm("to", { names: toNames }));
  if (summary.cc) {
    parts.push(tm("cc", { who: "count" in summary.cc ? String(summary.cc.count) : nameOf(summary.cc.name) }));
  }
  const recipientLine = parts.join(" · ");

  const own = new Set(ownAddresses.map((a) => a.trim().toLowerCase()));

  return (
    <>
      <div className="msg-from">
        <button
          type="button"
          className="msg-sender"
          title={tr("openFor", { sender: message.from.address })}
          aria-label={tr("openFor", { sender: message.from.address })}
          onClick={(e) => chrome.openSenderMenu(message.id, e.currentTarget)}
        >
          <Avatar initials={initialsOf(name)} hue={avatarHue(message.from.address)} size="s" />
          <b>{name}</b>
          {address ? <small>{address}</small> : null}
        </button>
        <span className="t num">
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
          {onCollapse ? (
            <button
              type="button"
              className="msg-collapse"
              aria-expanded={true}
              aria-label={tm("collapse", { sender: name })}
              onClick={onCollapse}
            >
              <Icon name="chev" size={12} />
            </button>
          ) : null}
        </span>
      </div>
      {summary.empty ? null : (
        <div className="msg-rcpt">
          <span className="msg-rcpt-line">{recipientLine}</span>
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
          {message.to.length > 0 ? (
            <div>
              <dt>{tm("to", { names: "" }).trim()}</dt>
              <dd>{message.to.map((r) => fullRecipient(r, own, meLabel)).join(", ")}</dd>
            </div>
          ) : null}
          {message.cc.length > 0 ? (
            <div>
              <dt>{tm("cc", { who: "" }).trim()}</dt>
              <dd>{message.cc.map((r) => fullRecipient(r, own, meLabel)).join(", ")}</dd>
            </div>
          ) : null}
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
    </>
  );
}

/**
 * A CONVERSATION SIBLING. Collapsed by default unless the pane opened it; the pane owns which
 * rows are open (a `Set`) and hands down `collapsed` and the toggle, so this component holds no
 * expansion state of its own and is pure over its props.
 *
 * Expanding renders the body from `chrome.bodyOf` — the record `hydrateThread` already filled on
 * open — so there is NO new network fetch on a toggle. The body travels through the same
 * {@link MessageBody} the focused message uses, so a sibling inherits the sanitizer, the sandbox
 * and remote-content blocking with nothing re-implemented.
 */
export function MessageCard({
  message,
  now,
  collapsed,
  onToggle,
  showSubject,
}: {
  message: EngineMessage;
  now: Date;
  collapsed: boolean;
  onToggle: () => void;
  /** Render the subject as an `<h3>` — only when it diverges from the thread's own heading. */
  showSubject: boolean;
}) {
  const tm = useTranslations("message");
  const chrome = useMessageChrome();
  const name = senderName(message);
  const rel = displayTime(message, now);
  const abs = fullDateTime(message);
  const showAbs = chrome.absoluteTime && !!abs;

  if (collapsed) {
    return (
      <article className="hmail hm-collapsed" data-conv-id={message.id}>
        {/* THE WHOLE ROW IS THE TOGGLE — one button, no button-in-button, so the collapsed row
            has no nested sender menu to fight it. `aria-expanded` reports the fold. */}
        <button
          type="button"
          className="hm-peekrow"
          aria-expanded={false}
          aria-label={tm("expand", { sender: name })}
          onClick={onToggle}
        >
          <Avatar initials={initialsOf(name)} hue={avatarHue(message.from.address)} size="s" />
          <b className="hm-name">{name}</b>
          <span className="hm-peek">{message.snippet}</span>
          {/* Read-only here — the whole row is the fold toggle, so the stamp cannot own a click of
              its own — but it still follows the shared absolute-time flip and shows the exact
              instant on hover, so every stamp in the thread reads in one form together. */}
          {rel ? (
            <time
              className="t num"
              dateTime={message.date ?? undefined}
              title={(showAbs ? rel : abs) || undefined}
            >
              {showAbs ? abs : rel}
            </time>
          ) : null}
        </button>
      </article>
    );
  }

  return <ExpandedSibling message={message} now={now} onToggle={onToggle} showSubject={showSubject} />;
}

/**
 * The expanded arm, split out so its hooks (`useBodyStalled`) live under a stable component
 * rather than after the `collapsed` early-return above, where the rules of hooks would be
 * violated the moment a row toggled.
 */
function ExpandedSibling({
  message,
  now,
  onToggle,
  showSubject,
}: {
  message: EngineMessage;
  now: Date;
  onToggle: () => void;
  showSubject: boolean;
}) {
  const tb = useTranslations("body");
  const tm = useTranslations("message");
  const chrome = useMessageChrome();
  const body = chrome.bodyOf(message);
  const waiting = body.state === "loading" || body.state === "snippet";
  const stalled = useBodyStalled(message.id, waiting);
  // Copy shim — `en.json` wins the moment the key lands; the fallback keeps the verb legible
  // until it does, without this slice editing the message catalogue. See `ActionBar`'s `copy`.
  const verb = (key: string, fallback: string): string => (tm.has(key) ? tm(key) : fallback);

  const loadingNote: ReactNode = !stalled && waiting ? <p className="hm-state">{tb("loading")}</p> : null;
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
    <article className="hmail" data-conv-id={message.id}>
      <MessageHeader message={message} now={now} onCollapse={onToggle} />
      {showSubject ? <h3>{message.subject}</h3> : null}
      <div className="hm-body hm-rich">
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
      {failedNote}
      {/* THE SIBLING'S OWN VERBS — Reply and Forward, dispatched through the SAME chrome the
          focused message's bar uses, so answering (or forwarding) an older message in the thread
          does not first require making it the focused one. Deliberately NOT a second ActionBar: a
          full bar per expanded sibling would stack the file / defer / read machinery onto a
          message the reader is only glancing back at. Reply retargets the editor to THIS id;
          Forward hands THIS id to the forward model. Each button appears only where the shell has
          wired its verb — a footer of dead controls is exactly what this file refuses elsewhere. */}
      {chrome.openReply || chrome.forward ? (
        <div className="hm-foot">
          {chrome.openReply ? (
            <button type="button" className="hm-verb" onClick={() => chrome.openReply!(message.id)}>
              {verb("siblingReply", "Reply")}
            </button>
          ) : null}
          {chrome.forward ? (
            <button type="button" className="hm-verb" onClick={() => chrome.forward!(message.id)}>
              {verb("siblingForward", "Forward")}
            </button>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

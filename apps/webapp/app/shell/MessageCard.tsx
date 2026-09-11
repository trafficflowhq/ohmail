"use client";

/**
 * The per-message panel, and the header every message wears. A conversation renders one panel per
 * message, every body already in the mirror (`MessagePane` hydrates the whole thread on open), so
 * nothing is withheld or behind a "N older" placeholder; the peek-row fold is gone — a thread is a
 * column of letters, each on its own panel. Two shared pieces: {@link MessageHeader} — one grammar
 * for every panel (names-first sender, ⋯ menu left of the stamp, the quiet SUBJECT-D line, and
 * {@link MessageRecipients}, which a Reads card wears too), worn by the focused message and a
 * sibling alike; and {@link MessageCard} — a sibling's panel, the header and the body through the
 * same {@link MessageBody} the focused message uses. One `<article class="pm">` per message.
 */
import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Avatar, Button, Icon } from "@ohmail/ui";
import { isProtectedMessage, type EngineMessage } from "@ohmail/client-engine";
import { AwayMark } from "./AwayMark";
import { isPreviewable } from "../components/AttachmentPreview";
import { AttachmentStrip } from "../components/AttachmentStrip";
import { MessageBody } from "../components/MessageBody";
import { BlockNoticeGloss, type BlockNotice } from "../components/BlockNotice";
import { opensInSystemViewer } from "./open-attachment";
import { replyAllRecipients } from "./compose-from";
import {
  avatarHue,
  displayTime,
  fullDateTime,
  initialsOf,
  rowAddress,
  senderName,
  withheldCopyKey,
} from "./format";
import { displayAddress } from "./idn";
import { useBodyStalled, useMessageChrome } from "./message-chrome";
import { MessageRecipients } from "./MessageRecipients";
import { MoreMenu, type MoreMenuItem } from "./MoreMenu";

/**
 * The header — who it is from, what it is called, when, and who else it went to. Reads `ownAddresses` and
 * `openSenderMenu` off the chrome rather than as props (the pane is mounted twice and holds no engine hook);
 * `onEnterReader` and `notice` are the two things a caller varies, so they come as props. The ⋯ menu carries
 * the message's verbs per panel, left of the stamp: Reply / Reply all / Forward on every panel, so answering an
 * older message never requires focusing it first. Each item dispatches THIS header's `message.id`; Reply all is
 * offered only where {@link replyAllRecipients} returns an envelope for this message. Items degrade by omission
 * where the chrome is inert (the desktop shell, a bare test) — never a menu of dead controls. The menu is the
 * pill's own {@link MoreMenu}, anchored to drop down from the header (`.msg-menu`, `app.css`).
 */
export function MessageHeader({
  message,
  now,
  onEnterReader,
  notice = null,
}: {
  message: EngineMessage;
  now: Date;
  onEnterReader?: () => void;
  /**
   * WHAT THIS MESSAGE'S BODY HAD REFUSED — the viewer's report (`MessageBody.onNotice`), handed up
   * by the panel that mounts the body (`MessageCard` below; `MessagePane` for the focused message)
   * and worn HERE, in the header's right cluster, as the same glyph and two-word caption the
   * reading stream's card wears in its head (`BlockNoticeGloss`): one fact, one shape on every
   * surface. `null` — nothing refused, no body on screen yet, a caller with no report to make —
   * renders nothing. The open "details" block prints the whole sentence under the exact date, so
   * the fact is reachable by hover, focus, a press and a disclosure alike.
   */
  notice?: BlockNotice | null;
}) {
  const tm = useTranslations("message");
  const tr = useTranslations("screening");
  const chrome = useMessageChrome();
  /** The ⋯ disclosure. The trigger owns the keyboard's way back — see `closeMenu`. */
  const [menuOpen, setMenuOpen] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  // A message swap in the same mounted position (the single-message pane re-pointed by
  // selection) must not leave a menu open over a different message's verbs — same rule the
  // pill applies on `message.id`. The recipients block keeps the same rule for its own
  // popover and fold, on its own state — see `MessageRecipients`.
  useEffect(() => { setMenuOpen(false); }, [message.id]);
  const closeMenu = (): void => {
    setMenuOpen(false);
    moreRef.current?.focus();
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
  /**
   * Forward, under the same two predicates the pill applies (`MessagePane.ActionBar#canForward`).
   * `chrome.forward` alone was merely permissive while this menu was Forward's only door; the verb
   * now also stands in the action bar, and two surfaces offering it under DIFFERENT conditions is
   * worse than either rule: on a `no_forward` message the bar withholds Forward while the menu
   * offers it, then a refusal toast. `no_forward` — the send path answers 403 (an OTP or a reset
   * link must not leave the account inside a quote block); off-mirror — `AppShell.openForward`
   * returns silently when the row is absent, so the item would be a no-op with no reason given.
   * Degrading by omission is what this menu already does for every other unwired verb.
   */
  if (
    chrome.forward &&
    message.sensitivity?.no_forward !== true &&
    chrome.mirrorHolds?.(message.id) !== false
  ) {
    menuItems.push({
      id: "forward",
      label: tm("menuForward"),
      run: () => { closeMenu(); chrome.forward!(message.id); },
    });
  }

  /**
   * SUBJECT-D — the message's own quiet subject line, under the sender, on every panel. The RAW
   * `m.subject`, reply prefixes included: "AW: …" is what this message is called, and printing it
   * lets a thread's panels tell each other apart now that the one large heading is deleted
   * (`MessagePane`'s `<h2>` and the thread lede both — see `test/conversation.test.ts`). No
   * normalization. The line is the subject-rule entry where the shell provides the sheet
   * (`chrome.openSubjectRule`, dispatching THIS message's id) and plain text where it does not —
   * never a dead control. An empty subject renders no line rather than an empty one.
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
          {/* THE BLOCKING NOTICE LEADS THE CLUSTER — a fact before the controls, so the ⋯ menu
              keeps its place left of the stamp and the date keeps the corner (the order
              `test/conversation.test.ts` holds). The component the stream card's head wears; the
              trigger inherits this cluster's type and ink, and the primitive decides the rest. */}
          {notice ? <BlockNoticeGloss notice={notice} /> : null}
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
                <MoreMenu items={menuItems} ariaLabel={tm("actions")} anchor={moreRef.current} onClose={closeMenu} />
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
              title={tm("openReaderTitle")}
              aria-label={tm("openReader")}
              onClick={onEnterReader}
            >
              <Icon name="open" size={13} />
            </button>
          ) : null}
        </span>
      </div>
      {subjectLine}
      <MessageRecipients message={message} notice={notice} />
      {/* "Answered by the away responder · <when>" — drawn iff the server stamped this
          message, immediately under the recipients. One mount, and it serves every panel
          this header wears: the focused message in the reading pane (`MessagePane`
          composes this same header) and every sibling on an open thread. See
          `AwayMark` for why the mark is on the ORIGINAL and never on the Sent copy. */}
      <AwayMark message={message} now={now} />
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

  /**
   * ── WHICH RENDERING IS ON SCREEN — the sibling asks the same question the focused pane does ──
   *
   * `MessagePane` carries the full argument: mail drawn in the app's own typography paints no
   * images, so the strip lists the message's pictures exactly when nothing else is drawing them.
   * The mechanism is a verbatim mirror — one string keyed by message so a re-pointed card cannot
   * inherit the last message's answer, a primitive so the per-render report hits React's bail-out,
   * and unknown reads as FRAMED so the widened list is something a positive signal turns on.
   */
  const [bodyRendering, setBodyRendering] = useState("");
  const onRenderMode = useCallback(
    (mode: "prose" | "framed") => setBodyRendering(`${message.id}:${mode}`),
    [message.id],
  );
  const nativeBody = bodyRendering === `${message.id}:prose`;

  /**
   * WHAT THE BODY HAD REFUSED — reported by the viewer, worn by the header: `MessageBody` says what it refused
   * (`onNotice`: the caption a meta line shows and the whole sentence behind it) and this panel puts it in its own
   * header, the way the stream card puts it in its head — so the sentence leaves the bar above the body and every
   * surface wears one shape. Keyed by message for the reason `bodyRendering` above is: a panel re-pointed at another
   * message must not wear the last message's glyph for the frame between the re-point and the viewer's next report.
   * The setter is built per message so the viewer's effect re-fires once on a re-point and never once per render; the
   * viewer itself reports only when its three strings change, so a message with nothing refused costs no re-render
   * here.
   */
  const [noticeFor, setNoticeFor] = useState<{ id: string; notice: BlockNotice | null } | null>(null);
  const onNotice = useCallback(
    (notice: BlockNotice | null) => setNoticeFor({ id: message.id, notice }),
    [message.id],
  );
  const notice = noticeFor?.id === message.id ? noticeFor.notice : null;

  /**
   * The framed rendering's unresolved `cid:` images — the same forwarding `MessagePane` does,
   * because a sibling panel draws its html through the same `MessageBody` and a photo pasted
   * into an older reply is no less blank there. Absent chrome (demo, the desktop shell without
   * the service) hands `MessageBody` neither half, exactly as the focused pane does.
   */
  const onCidImages = useCallback(
    (contentIds: string[]) => chrome.attachments?.needCidImages(message.id, contentIds),
    [chrome.attachments, message.id],
  );

  /**
   * THE SIBLING'S FILES — the found defect this block closes: A conversation panel rendered header and body and
   * NOTHING said the message carried files: the strip lived only on the focused panel, so a reader's own sent reply —
   * ingested from the Sent folder with its attachments extracted and stamped — showed none of them anywhere on the
   * open thread. The strip below is the same `AttachmentStrip` over the same chrome reads the focused pane uses
   * (`itemsOf` / `open` / `downloadAll` — the metadata ask lives in `useMessageAttachments`, which loads the whole
   * conversation's lists); `isProtectedMessage` gates it for the reason the focused pane's does: a protected message
   * renders no content, and a file a sender attached is content.
   */
  const attachments = isProtectedMessage(message) ? undefined : chrome.attachments;

  const loadingNote: ReactNode = !stalled && waiting ? <p className="hm-state">{tb("loading")}</p> : null;
  /**
   * WITHHELD IS ANSWERED, NOT FAILED — the same rule the focused pane follows: The panel used to enumerate only
   * `loading`/`snippet` and `failed`, so the storage-cap slice's terminal `withheld` state matched NEITHER arm and
   * fell through to a bare {@link MessageBody} over `bodyOf`'s snippet — the PREVIEW presented as the message, with
   * nothing on screen saying the body was never stored. The focused message was honest throughout, which is what kept
   * this invisible: the dishonesty only ever appeared on a sibling of an open thread. No Retry, deliberately, and
   * this is not a styling choice: the server ANSWERED, and its answer is that it holds no content for this message
   * because the account's storage space was full when it arrived.
   */

  /**
   * A retry cannot change that, and `failed`'s control exists precisely because a state with no way out is a dead end
   * — offering one that cannot succeed is worse than offering none. Not `warn` either: nothing went wrong, and the
   * mail itself is untouched in the mailbox on the user's own server.
   */
  const withheldNote: ReactNode =
    // Per MARKER, not one sentence for the state: which policy emptied the stored body decides
    // what is true to say (storage cap / junk verdict / expunged) — `withheldCopyKey`.
    body.state === "withheld" ? <p className="hm-state">{tb(withheldCopyKey(body.withheld))}</p> : null;
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
        <MessageHeader message={message} now={now} notice={notice} />
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
            loadTrackingPixels={chrome.remoteImages?.loadPixels ?? false}
            cidImages={chrome.attachments ? chrome.attachments.cidImagesOf(message.id) : undefined}
            onCidImages={chrome.attachments ? onCidImages : undefined}
            onRenderMode={onRenderMode}
            onNotice={onNotice}
          />
        </div>
        {attachments ? (
          <AttachmentStrip
            /* Same list discipline as the focused pane: pictures join the list exactly where the
               frameless rendering draws none, and `onDownloadAll` enumerates the same set the
               head just counted. */
            items={attachments.itemsOf(message.id, { includeInlineImages: nativeBody })}
            onOpen={(attachmentId) => attachments.open(message.id, attachmentId)}
            /* The same preview judgement with the same owner — `isPreviewable` minus the desktop's
               system-viewer types — dispatching THIS panel's message id, so pressing a file on an
               older message never requires first making it the focused one. */
            onPreview={(attachmentId) => chrome.openAttachmentPreview(message.id, attachmentId)}
            canPreview={(item) => isPreviewable(item.mimeType) && !opensInSystemViewer(item.mimeType)}
            onDownloadAll={() => attachments.downloadAll(message.id, { includeInlineImages: nativeBody })}
            downloadingAll={attachments.downloadingAll(message.id)}
            calendarTextOf={(attachmentId) => attachments.calendarTextsOf(message.id).get(attachmentId)}
          />
        ) : null}
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

"use client";

/**
 * HISTORY — mail from people nobody ever decided about, who then went quiet.
 *
 * Every message in this list is READ, and that is guaranteed rather than arranged: a sender
 * with any unread mail is ACTIVE whatever its age, so an unread message pulls its sender into
 * the Screener queue instead. History therefore cannot contain anything that wants attention,
 * which is why the rail entry beside it carries no count and this pane shows no unread state.
 *
 * It is not called Archive. "Archive" is a verb in every other mail client — an action this
 * mail never received — and a mailbox with a real server-side Archive folder would be shown a
 * view by that name whose contents are not that folder's.
 *
 * ── NOTHING HERE HAS MOVED ─────────────────────────────────────────────────────────────────
 *
 * This is a presentation, not a location. Every message in the list is sitting exactly where
 * the mail server has it — usually the INBOX — and every other mail client the person owns
 * still shows it there. The row states the server folder for that reason: a place the product
 * invented must not be mistaken for a place mail was put.
 *
 * ── ONE WAY TO READ IT: THE OHBOX'S ─────────────────────────────────────────────────────────
 *
 * A list beside a reading column, which is the composition every other pile in the product
 * already uses. There used to be a `List` / `Split` segmented control above the rows, defaulting
 * to a solo centred list that raised a reader sheet per message — and it was a control offering
 * a choice nobody wants to make twice: going through old mail one sheet at a time is the slower
 * half of a pair, it was the DEFAULT half, and the toggle reset on every visit, so the cost was
 * paid again on each arrival. The choice is gone and the better shape is simply the shape.
 *
 * READING IN PLACE IS UNCHANGED, and it was the point of the toggle rather than of the modes.
 * A click selects into the column and the message renders where History shows it; the tag or
 * the pile never leaves the screen. Under 900px the reading column is `display:none`, so there
 * a click still raises the shell's reader sheet (`onOpen`) — the same rule the Ohbox keeps, and
 * the reason `readColumnHidden()` survives the deletion.
 *
 * ── THE ONE PILE WITH NO UPPER BOUND ───────────────────────────────────────────────────────
 *
 * Every other list here is a working set — what arrived, what is owed a decision, what was kept.
 * History is the residue of an entire mailbox: every message from everybody nobody ever screened,
 * accumulated for as long as the account has existed. On a standalone desktop client, whose
 * mirror is the whole mailbox rather than the browser's 5 000-row window, that is tens of
 * thousands of rows, and `messages.map(row)` renders all of them.
 *
 * Measured at 20 000 rows: the full list mounted in 4 050 ms as 242 904 DOM nodes, and picking a
 * row — which re-renders the list to move the selection — took 1 409 ms. So the pile that is
 * cheapest to think about was the most expensive thing in the product to look at. Windowed, the
 * same three numbers are 44 ms, 423 nodes and 6 ms.
 *
 * It is rendered through {@link useListWindow} for that reason: the rows on screen are mounted
 * and the rest are two spacer elements holding their height. See that file for why the row
 * height is measured rather than assumed, and for what the window deliberately does not do.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { physicalFolderOf, type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { InfoNote, ListPane, ListRows, MessageRow, ReadColumn } from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { useListWindow } from "../shell/list-window";
import { avatarOf, displayTime, rowAddress, senderName, tagsOfMessage, hueOf } from "../shell/format";

/** Below this the reading column is `display:none` (app.css), so a tap must open the sheet. */
function readColumnHidden(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches === true
  );
}

export function HistoryView({
  messages,
  tags,
  now,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
  onMarkAllRead,
}: {
  messages: readonly EngineMessage[];
  tags: TagDTO[];
  now: Date;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  /** Hydrate the split reading column's message, exactly as ReadsView hydrates `current`. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  /** The reading column's message verbs — the shell's `onMessageAction`. */
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /**
   * Present for uniformity with the other list views. History is all-read by construction
   * (an unread message is ACTIVE and lives in a pile, never here — see the file header), so the
   * unread set is always empty and the affordance renders nothing. Optional and self-hiding.
   */
  onMarkAllRead?: (ids: string[]) => void;
}) {
  const t = useTranslations("history");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count: messages.length });

  /**
   * The message the reading column shows — the user's pick, or the first row so the column is
   * never blank beside a list that has rows. `?? messages[0]` is safe here where it was fatal in
   * the Ohbox: History is all-read and static, so the list never re-partitions under the
   * fallback and it cannot silently re-point at a message nobody chose.
   */
  const shown = messages.find((m) => m.id === selectedId) ?? messages[0] ?? null;

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: EngineMessage) => {
    // Where the column is hidden the sheet is the only reading surface; where it is standing a
    // click is a selection into it, and nothing leaves the screen.
    if (readColumnHidden()) onOpen(m);
    else setSelectedId(m.id);
  };

  return (
    <section className="view split view-history">
      <ListPane
        title={t("title")}
        meta={messages.length ? t("metaCount", { count: messages.length }) : undefined}
        action={
          onMarkAllRead ? (
            <MarkAllRead
              unreadCount={messages.filter((m) => m.unread).length}
              onMarkAllRead={() => onMarkAllRead(messages.filter((m) => m.unread).map((m) => m.id))}
            />
          ) : null
        }
        /* The window reads this element's own scroll position; `ListPane` already offers the
           handle ("if the app drives scrolling itself"), so nothing in the pane changes. */
        scrollerRef={scrollerRef}
      >
        {/* ONE SENTENCE, ALWAYS PRESENT, AND ABOVE THE LIST.
            "History" is a word this product is using in a way no other mail client does, and a
            list of a thousand old messages under an unexplained heading is a list somebody has
            to guess the meaning of. It is not a dismissible first-run tip: the explanation is
            as true on the hundredth visit as the first, and a hint that disappears is a hint
            nobody can go back to.

            The other two sentences — that it is all read, and that nothing has moved on the
            mail server — are behind the (i). They answer the second and third questions, not
            the first, and as a block of three they pushed the first row of the list off a short
            window. Collapsed, not deleted: "a hint that disappears" above is still the rule,
            and a disclosure that is always in the same place is not a hint that disappears. */}
        <InfoNote
          className="view-note"
          lead={t("explainer")}
          moreLabel={t("explainerMoreLabel")}
        >
          {t("explainerMore")}
        </InfoNote>
        <ListRows>
          {messages.length ? (
            <>
              {/* THE ROWS ABOVE, AS HEIGHT. An empty element rather than a margin or a
                  transform: the scroller's scroll height, and therefore the scrollbar and the
                  scroll position, stay exactly what they would be with every row mounted.
                  `aria-hidden` because it is geometry — there is nothing here to announce, and
                  the mail it stands for is announced by the count above the list. */}
              {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
              {messages.slice(win.start, win.end).map((m) => (
                <MessageRow
                  key={m.id}
                  id={m.id}
                  from={senderName(m)}
                  address={rowAddress(m)}
                  {...avatarOf(m)}
                  time={displayTime(m, now)}
                  subject={m.subject}
                  preview={m.snippet}
                  amount={m.amount}
                  /* Never unread, by construction — stated rather than passed through, so that a
                     regression in the cutline shows up here as mail that stops looking read. */
                  unread={false}
                  seen
                  selected={shown?.id === m.id}
                  threadCount={m.threadCount}
                  hasAttachment={m.hasAttachments}
                  protected={m.protected != null}
                  tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                  /* WHERE IT ACTUALLY IS. Not a pile label: History is not a folder, and the
                     only honest badge is the server's own. */
                  place={physicalFolderOf(m)}
                  onClick={() => openRow(m)}
                />
              ))}
              {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
            </>
          ) : (
            <div className="empty">
              <span className="glyph">🕰</span>
              <b>{t("emptyTitle")}</b>
              {/* An empty History says what History IS, not that it is empty. Somebody
                  arriving at an empty one has learned nothing from the word alone. */}
              {t("emptyHint")}
            </div>
          )}
        </ListRows>
      </ListPane>
      {/* THE READING COLUMN — the Ohbox's own, minus the dwell it does not need: History is
          all-read, so there is no read-state to commit and nothing to arm a timer for. No
          `onEnterReader` on the pane, for the reason the Ohbox omits it — the "open reading
          mode" button it renders would sit at exactly the widths where the sheet duplicates
          this column. */}
      <ReadColumn>
        {shown ? (
          <MessagePane
            message={shown}
            tags={tags}
            now={now}
            onAction={(a) => onAction(a, shown)}
            onAddTag={onAddTag}
          />
        ) : null}
      </ReadColumn>
    </section>
  );
}

"use client";

/**
 * History — mail from people nobody ever decided about, who then went quiet. Every message here is READ, guaranteed
 * rather than arranged: a sender with any unread mail is ACTIVE and pulls into the Screener queue instead — so the
 * rail entry carries no count and the pane shows no unread state. Not called Archive: "Archive" is a verb in every
 * other client, an action this mail never received, and a mailbox with a real Archive folder would meet a view by
 * that name whose contents are not that folder's.
 */

/**
 * Nothing here has moved: this is a presentation, not a location — every message sits exactly where the mail server
 * has it, and the row states the server folder so an invented place is not mistaken for a real one. One way to read
 * it — the Ohbox's list beside a reading column (the old List/Split toggle reset per visit and defaulted to the
 * slower half; the better shape is simply the shape; under 900px a click raises the reader sheet). The one pile with
 * no upper bound: measured at 20 000 rows, `messages.map` mounted in 4 050 ms as 242 904 nodes with 1 409 ms clicks —
 * windowed ({@link useListWindow}): 44 ms, 423 nodes, 6 ms.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { useRowBadgeCopy } from "../shell/row-copy";
import { physicalFolderOf, type EngineMessage, type TagDTO } from "@ohmail/client-engine";
import { InfoNote, ListPane, ListRows, MessageRow, ReadColumn } from "@ohmail/ui";
import { MarkAllRead } from "../components/MarkAllRead";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { useListWindow } from "../shell/list-window";
import { avatarOf, rowStamp, rowAddress, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useZoneNav } from "../shell/zone-nav";
import { useMessageVerbs } from "../shell/message-verbs";
import { readColumnHidden } from "../shell/narrow";


export function HistoryView({
  messages,
  tags,
  threadParticipants,
  absoluteTime,
  onToggleTime,
  now,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
  onScreen,
  canDelete,
  canReplyAll,
  onMarkAllRead,
  windowed = false,
}: {
  messages: readonly EngineMessage[];
  /**
   * THE PEOPLE IN A ROW'S CONVERSATION, for its lead circles — bound to the engine's reader by
   * the shell (this view has none) and mapped to `{initials, hue}`. A LOOKUP into the shell's
   * per-version thread index, so calling it per row costs nothing; `[]` for a message whose
   * thread has no second voice in it, and the row then leads with the one sender's circle it
   * always did. Optional, so a view mounted without it (the demo, most tests) is unchanged.
   */
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  /**
   * THE DATE STAMPS — which form they are in, and the press that flips them.
   *
   * One boolean for every row at once: the shell owns it, resets it on a view switch and shares
   * it with the open message, so no two dates on screen are ever in different shapes. `rowStamp`
   * turns the pair into the row's stamp props. Optional, and absent leaves the rows exactly as
   * they were — relative dates, the exact instant on hover, nothing to press.
   */
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  tags: TagDTO[];
  now: Date;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  /** Hydrate the split reading column's message, exactly as ReadsView hydrates `current`. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  /** The reading column's message verbs — the shell's `onMessageAction`. */
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  /* THE THREE SEAMS THE MESSAGE VERBS NEED, resolved by the shell — see
     `useMessageVerbs`' header for why none of them is derived in a view. */
  onScreen: (messageId: string, anchor: HTMLElement | null) => void;
  canDelete: (message: EngineMessage) => boolean;
  canReplyAll: (message: EngineMessage) => boolean;
  /**
   * Present for uniformity with the other list views. History is all-read by construction
   * (an unread message is ACTIVE and lives in a pile, never here — see the file header), so the
   * unread set is always empty and the affordance renders nothing. Optional and self-hiding.
   */
  onMarkAllRead?: (ids: string[]) => void;
  /**
   * IS THIS CLIENT'S MIRROR A WINDOW? `engine.storeWindow() !== null`, resolved by the shell.
   *
   * History is derived from the whole mirror and no wire partition serves it, so on a windowed
   * client this list is what the device kept and its length is NOT the number of messages in the
   * reader's History. So the count comes off — a bounded number under an unqualified label is the
   * false state — and the tail says where the rest is. `false` for a mirror that is the mailbox,
   * which keeps the count and says nothing.
   */
  windowed?: boolean;
}) {
  const t = useTranslations("history");
  const rowBadge = useRowBadgeCopy();
  /* The list keys' shared vocabulary and the reading column's region name — the Ohbox's own
     labels and `reader.pane`, so the split views never phrase the same gesture apart. */
  const to = useTranslations("ohbox");
  const tReader = useTranslations("reader");
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

  /**
   * OPENING A ROW MOVES THE CURSOR, ON BOTH LAYOUTS.
   *
   * The cursor is set FIRST and unconditionally. Before the message verbs were declared here it
   * did not have to be: on the NARROW layout opening a row raised the reader and set no cursor,
   * which was invisible because nothing read the cursor there. Every verb in `useMessageVerbs`
   * reads it, so leaving it unset would make `d`, `⇧F` and the filing keys act on the FIRST row
   * of the list while the reader showed the tapped one — the defect `TriageView` documents
   * having already paid for.
   */
  const openRow = (m: EngineMessage) => {
    setSelectedId(m.id);
    // Where the column is hidden the sheet is the only reading surface; where it is standing the
    // selection above is the whole open, and nothing leaves the screen.
    if (readColumnHidden()) onOpen(m);
  };

  /**
   * ↓/↑ WALK THE LIST AS RENDERED — the zone model's list zone (`zone-nav.tsx`), and this
   * view's first list keys. History is all-read by construction, so selection here can have
   * no read side effect at all — showing is the whole act. → into the pane is a focus move;
   * where the column is hidden it is the sheet, the same answer a tap gets (`openRow`).
   */
  const navAt = shown ? messages.findIndex((m) => m.id === shown.id) : -1;
  const selectRow = (id: string): void => {
    setSelectedId(id);
    // Keep the new cursor in view. `?.` on the METHOD, not only the node: jsdom mounts this
    // view without implementing scrollIntoView (RulesView's precedent).
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>(`.view-history .row[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView?.({ block: "nearest" }),
    );
  };
  /* THE NINE MESSAGE VERBS, over this view's own cursor. Without this declaration the
     shell's bindings register `disabled` here (they act on `focused`, which has no arm for
     a split view's local cursor) while the action bar goes on printing their keycaps —
     nine keys that print a cap and do nothing. See `message-verbs.ts`. */
  useMessageVerbs({
    shown, scope: ".view-history", onAction, onAddTag, onScreen, canDelete, canReplyAll,
  });

  useZoneNav({
    list: {
      followId: shown?.id ?? null,
      up: {
        disabled: navAt <= 0,
        run: () => {
          if (navAt > 0) selectRow(messages[navAt - 1]!.id);
        },
        label: to("keyPrev"),
      },
      down: {
        disabled: navAt >= messages.length - 1,
        run: () => {
          if (navAt < messages.length - 1) selectRow(messages[navAt + 1]!.id);
        },
        label: to("keyNext"),
      },
    },
    reader: {
      selector: ".view-history .read-col",
      disabled: shown == null,
      onHiddenEnter: () => {
        if (shown) onOpen(shown);
      },
    },
  });

  return (
    <section className="view split view-history">
      <ListPane
        title={t("title")}
        meta={messages.length && !windowed ? t("metaCount", { count: messages.length }) : undefined}
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
        {/* One sentence, always present, above the list: "History" is a word this product uses as
            no other mail client does, and a thousand old messages under an unexplained heading is
            a list somebody has to guess at. Not a dismissible tip — the explanation is as true on
            the hundredth visit as the first, and a hint that disappears is a hint nobody can go
            back to. The other two sentences (all read; nothing moved on the mail server) are
            behind the (i): they answer the second and third questions, and as a block of three
            they pushed the first row off a short window. Collapsed, not deleted — a disclosure
            always in the same place is not a hint that disappears. */}
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
                  participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
                  {...rowStamp(m, now, absoluteTime, onToggleTime)}
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
                  protectedLabel={m.protected != null ? rowBadge.protectedLabel : undefined}
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
        {/* WHERE THIS LIST ENDS, ON A CLIENT THAT KEEPS PART OF THE MAILBOX. The Ohbox's own
            shape (`sentNote`, `olderPrompt`), without a control: History is derived from the
            whole mirror and no `GET /messages?view=` partition serves it, so there is nothing
            to page — Search reads the full store on both tiers and is the reach that works.
            The sentence states the POLICY, which is true whatever the mailbox holds today. */}
        {windowed ? <div className="tail-row">{t("windowNote")}</div> : null}
      </ListPane>
      {/* THE READING COLUMN — the Ohbox's own, minus the dwell it does not need: History is
          all-read, so there is no read-state to commit and nothing to arm a timer for. No
          `onEnterReader` on the pane, for the reason the Ohbox omits it — the "open reading
          mode" button it renders would sit at exactly the widths where the sheet duplicates
          this column. */}
      <ReadColumn regionLabel={tReader("pane")}>
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

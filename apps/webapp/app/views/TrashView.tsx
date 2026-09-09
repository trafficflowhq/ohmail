"use client";

/**
 * TRASH — mail you deleted in ohmail, and the one place it can be put back.
 *
 * The composition is `FolderView`'s, deliberately: the same two-pane list beside a reading
 * column, the same row component, the same empty and end-of-list lines, the shell's sheet under
 * 900px. A bin that looked like its own product would be a second mail client inside the first.
 *
 * ══ THE ROWS ARE NOT IN THE MIRROR, AND HERE THAT IS STRUCTURAL ═════════════════════════════
 *
 * A delete tombstones the row in every client's mirror, so there is nothing local to filter. The
 * page comes from the server and is held by {@link useTrashPage} for as long as this view is
 * mounted — see that hook's header for why it is not `older-mail.ts`.
 *
 * ══ WHAT THIS LIST CLAIMS, AND WHAT IT DOES NOT ═════════════════════════════════════════════
 *
 * "Mail you deleted in ohmail" — the message-delete verb's own rows, and nothing else. Mail
 * trashed in another mail app is in the mail server's Trash and the server here has never read
 * that folder, so it is not in this list; mail whose FOLDER was deleted is tombstoned without
 * riding to Trash, so it is not either. `trash.foot` says the first of those in the reader's own
 * words rather than leaving them to notice a gap.
 *
 * ══ TWO ROW DIFFERENCES, BOTH TEXTUAL ══════════════════════════════════════════════════════
 *
 *  · the stamp slot says WHEN IT WAS DELETED, not when the message was sent. A list somebody is
 *    scanning for what they just threw away is scanned by the deletion, and the send date would
 *    put a mail from last year at the top of a bin emptied this morning. Ordered by it too, on
 *    the server.
 *  · a quiet gloss after the subject names WHERE A RESTORE WOULD PUT IT (`MessageRowProps
 *    .destination`). It is the server's resolved answer, not this client's guess: the origin
 *    folder can be gone, and only the server holds the mailbox's folder inventory.
 *
 * ══ AND THE READING PANE HAS ONE VERB ══════════════════════════════════════════════════════
 *
 * Restore, plus the read switch. `MessagePane`'s `trash` prop carries it; the argument for one
 * early return rather than eleven gated groups is written at `ActionBar`'s own prop.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { presentsUnread, type EngineMessage, type TagDTO, type TrashRowWire } from "@ohmail/client-engine";
import { ListPane, ListRows, MessageRow, ReadColumn, Spinner } from "@ohmail/ui";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { useRowBadgeCopy } from "../shell/row-copy";
import { avatarOf, agoStamp, hueOf, placeLabel, rowAddress, senderName, tagsOfMessage } from "../shell/format";
import { useZoneNav } from "../shell/zone-nav";
import { readColumnHidden } from "../shell/narrow";
import { useListWindow } from "../shell/list-window";
import type { TrashPage } from "../shell/trash-page";

/**
 * THE ROW'S STAMP — how long ago it was deleted, plus the exact instant on hover.
 *
 * `agoStamp` and not the list's `rowStamp`: the two answer different questions. `rowStamp` says
 * WHICH DAY a message is from, which is what a reader scanning a pile by date wants; this says
 * HOW LONG AGO something happened, which is what somebody looking for what they just deleted
 * wants. `agoStamp` is already the product's answer to the second question (the mailbox rows'
 * "Synced 2 minutes ago") and reads the app's own locale and zone.
 *
 * A row whose `trashedAt` is absent — a server older than the field — falls back to no stamp at
 * all rather than to the message's own date: a date in the deletion slot would be read as a
 * deletion time, which is a false statement, and an empty slot is merely quiet.
 */
function trashStamp(
  row: TrashRowWire,
  nowMs: number,
  say: (when: string) => string,
): { time?: string; timeTitle?: string } {
  if (!row.trashedAt) return {};
  const { rel, abs } = agoStamp(row.trashedAt, nowMs);
  return { time: say(rel), timeTitle: abs };
}

/**
 * WHERE A RESTORE WOULD PUT IT, in the reader's words — the view label for one of the six, the
 * folder's leaf for one of the mailbox's own. `placeLabel` is the product's single answer to
 * "turn a folder into something a person reads"; a second mapping here is how two surfaces come
 * to call one folder two things. An absent `restoreTo` (a server older than the field) glosses
 * the inbox, which is where that server's restore would in fact put it.
 */
function restoreLabel(row: TrashRowWire): string {
  return placeLabel(row.restoreTo && row.restoreTo !== "" ? row.restoreTo : "INBOX");
}

export function TrashView({
  page,
  tags,
  threadParticipants,
  now,
  locateId,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
}: {
  page: TrashPage;
  tags: TagDTO[];
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  now: Date;
  /** The URL's open message (`#/trash/m/<id>`) — a link into a specific deleted message. */
  locateId?: string | null;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("trash");
  const to = useTranslations("ohbox");
  /* THE HEADING IS THE RAIL'S OWN WORD (`rail.trash`), not a second copy of it in this
     namespace: the transient rail entry and this pane's title name the same place, and two keys
     for one place is how a sidebar and the screen it opens come to disagree by a word. */
  const tRail = useTranslations("rail");
  const tReader = useTranslations("reader");
  const rowBadge = useRowBadgeCopy();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const rows = page.items;
  const win = useListWindow({ scrollerRef, count: rows.length });

  /* The user's pick, else the URL's open message, else the first row — `FolderView`'s rule, safe
     here for a stronger reason: this list never re-partitions (one flat order, from the server). */
  const shown =
    rows.find((m) => m.id === selectedId)
    ?? (locateId ? rows.find((m) => m.id === locateId) : null)
    ?? rows[0]
    ?? null;

  /* THE BODY OF A TOMBSTONED ROW. The body route answers for a deleted message by design
     (`schema-mail.ts` states it beside the column), which is what makes this view able to show a
     message rather than only a subject — a bin you cannot read is a bin you cannot decide about. */
  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: TrashRowWire) => {
    setSelectedId(m.id);
    if (readColumnHidden()) onOpen(m);
  };

  const navOrder = rows.map((m) => m.id);
  const navAt = shown ? navOrder.indexOf(shown.id) : -1;
  const selectRow = (id: string): void => {
    setSelectedId(id);
    // `?.` on the METHOD as well as the node — jsdom mounts this view without implementing
    // scrollIntoView (`FolderView`'s precedent, from `RulesView`'s).
    queueMicrotask(() =>
      document
        .querySelector<HTMLElement>(`.view-trash .row[data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView?.({ block: "nearest" }),
    );
  };

  /* ↓/↑ WALK THE LIST AS RENDERED. No `useMessageVerbs` here, deliberately: the nine message
     verbs are the filing keys, and none of them may act on a row that is in Trash — the shell
     declares the two this view does have (`⇧⌫` and the disabled delete keys) so the `?` sheet
     documents both, which is the rule a view-local declaration would break. */
  useZoneNav({
    list: {
      followId: shown?.id ?? null,
      up: {
        disabled: navAt <= 0,
        run: () => {
          if (navAt > 0) selectRow(navOrder[navAt - 1]!);
        },
        label: to("keyPrev"),
      },
      down: {
        disabled: navAt >= navOrder.length - 1,
        run: () => {
          if (navAt < navOrder.length - 1) selectRow(navOrder[navAt + 1]!);
        },
        label: to("keyNext"),
      },
    },
    reader: {
      selector: ".view-trash .read-col",
      disabled: shown == null,
      onHiddenEnter: () => {
        if (shown) onOpen(shown);
      },
    },
  });

  /* Reveal a linked row the window has not mounted — `FolderView`'s reveal, same reasoning:
     the slice derives from `scrollTop`, so putting the row's offset in view mounts it. */
  const locateIdx = locateId ? rows.findIndex((m) => m.id === locateId) : -1;
  const locateFound = locateIdx >= 0;
  useEffect(() => {
    if (!locateId || !locateFound) return;
    setSelectedId(locateId);
    const idx = rows.findIndex((m) => m.id === locateId);
    if (idx >= win.start && idx < win.end) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = Math.max(0, idx * win.rowHeight - el.clientHeight / 2);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateId, locateFound]);

  const nowMs = now.getTime();

  return (
    <section className="view split view-trash">
      <ListPane title={tRail("trash")} scrollerRef={scrollerRef}>
        <ListRows>
          {/* UNAVAILABLE IS ITS OWN SENTENCE and never an empty list: a demo that said "nothing
              in Trash" would be claiming something about a mailbox it does not have. */}
          {!page.available ? (
            <div className="empty">
              <span className="glyph">🗑</span>
              {t("unavailable")}
            </div>
          ) : rows.length ? (
            <>
              {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
              {rows.slice(win.start, win.end).map((m) => (
                <MessageRow
                  key={m.id}
                  id={m.id}
                  from={senderName(m)}
                  address={rowAddress(m)}
                  {...avatarOf(m)}
                  participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
                  {...trashStamp(m, nowMs, (when) => t("deletedAt", { when }))}
                  subject={m.subject}
                  destination={restoreLabel(m)}
                  preview={m.snippet}
                  amount={m.amount}
                  unread={presentsUnread(m)}
                  seen={!presentsUnread(m)}
                  selected={shown?.id === m.id}
                  threadCount={m.threadCount}
                  hasAttachment={m.hasAttachments}
                  protectedLabel={m.protected != null ? rowBadge.protectedLabel : undefined}
                  tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                  onClick={() => openRow(m)}
                />
              ))}
              {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
            </>
          ) : page.loading || !page.exhausted ? (
            /* NEITHER SENTENCE MAY BE SAID YET — the server has not finished answering, and
               "Trash is empty" about a list nobody has heard back about is a claim. The tail
               below carries the state; this slot stays quiet. */
            null
          ) : (
            <div className="empty">
              <span className="glyph">🗑</span>
              {t("empty")}
            </div>
          )}

          {/* THE END-OF-LIST LINE — the folder view's own `.tail-row`, carrying the scope
              sentence rather than a reach-past offer. It renders whenever the source is
              available, because the sentence is true of an empty Trash as well as a full one:
              what this list does and does not hold is the thing a reader most needs told, and
              telling them only when there are rows is telling them only when they are least
              likely to wonder. */}
          {page.available ? (
            <div className="tail-row" role="status">
              {page.error !== null ? (
                <>
                  {to("olderFailed", { reason: page.error })}{" "}
                  <button type="button" className="btn ghost" onClick={page.loadMore}>
                    {to("olderRetry")}
                  </button>
                </>
              ) : page.loading ? (
                <span className="mbx-wait">
                  <Spinner className="mbx-spin" />
                  {to("olderLoading")}
                </span>
              ) : (
                <>
                  {t("foot")}{" "}
                  {page.exhausted ? null : (
                    <button type="button" className="btn ghost" onClick={page.loadMore}>
                      {to("olderAction")}
                    </button>
                  )}
                </>
              )}
            </div>
          ) : null}
        </ListRows>
      </ListPane>
      <ReadColumn regionLabel={tReader("pane")}>
        {shown ? (
          <MessagePane
            message={shown.unread === presentsUnread(shown) ? shown : { ...shown, unread: presentsUnread(shown) }}
            tags={tags}
            now={now}
            onAction={(a) => onAction(a, shown)}
            onAddTag={onAddTag}
            trash
          />
        ) : null}
      </ReadColumn>
    </section>
  );
}

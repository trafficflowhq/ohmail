"use client";

/**
 * FOLDER — one of the mailbox's OWN folders, opened from the rail (FOLDERS-SPEC.md §3,
 * "Views: a user folder opens as a parameterized view — a list filtered on `m.folder`").
 *
 * The composition is `TagView`'s — a lens read in place: the two-pane list beside a reading
 * column, a click selecting into the column, the shell's sheet under 900px. The differences
 * are the folder's, both deliberate:
 *
 *  · the list wears the standard NEW-FOR-YOU / EARLIER grouping (iteration 2, feedback 5 —
 *    "it's perfect that you show the earlier / unread layout on the folders");
 *  · an EMPTY folder is an answer, not an error: it exists on the server and holds no mail,
 *    and the empty state says exactly that — the folder list comes from the mailbox itself,
 *    not from the messages in it.
 *
 * THE LIST IS WINDOWED, for History's measured reason (`useListWindow`): a folder is the
 * user's own filing and has no upper bound — an archive-style folder holds years of mail by
 * the thousands, and on the standalone desktop the mirror is the whole mailbox — so
 * `messages.map` would mount every row at once, which is the multi-second freeze History
 * already paid for and solved. One window over the flat unread-then-read ordering; the two group labels render
 * with the first row of their group, so they unmount when scrolled past — a bounded (two
 * label-heights) spacer drift, taken over per-row offset bookkeeping the rows do not need.
 *
 * Read-only in the foundation stage: no move verb, no rules door, no menu — later stages.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { type EngineMessage, type FolderEntity, type TagDTO } from "@ohmail/client-engine";
import { ListGroupLabel, ListPane, ListRows, MessageRow, ReadColumn } from "@ohmail/ui";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { avatarOf, rowStamp, hueOf, rowAddress, senderName, tagsOfMessage } from "../shell/format";
import { folderLeafOf, folderParentOf } from "../shell/folders";
import { useListWindow } from "../shell/list-window";
import type { OlderMail } from "../shell/older-mail";

/** Below this the reading column is `display:none` (app.css), so a tap must open the sheet. */
function readColumnHidden(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 900px)").matches === true
  );
}

export function FolderView({
  folder,
  messages,
  locateId,
  older,
  tags,
  threadParticipants,
  absoluteTime,
  onToggleTime,
  now,
  onOpen,
  hydrateBody,
  onAction,
  onAddTag,
}: {
  folder: FolderEntity;
  /** The folder's mail, newest first — filtered by the shell on (mailboxId, name). */
  messages: EngineMessage[];
  /**
   * The URL's open message (`#/folder/<id>/m/<mid>`) — a search hit's landing. The window
   * mounts the top of the list, so a deep hit needs its row REVEALED (scrolled into the
   * window) and selected, or the shell's locator polls for a row that never existed and
   * closing the reader leaves the list at the top instead of at the hit.
   */
  locateId?: string | null;
  /**
   * MAIL FROM BEYOND WHAT THIS DEVICE KEPT — the Ohbox's own reach-past, pointed at this
   * folder (the folders foundation: a fresh web mirror is a bootstrap WINDOW, and a folder's
   * older, untagged mail lives entirely past it). Required for the same reason the Ohbox makes
   * it required: without it the end of the list — and worse, an EMPTY list — is a claim about
   * somebody's whole folder that this device cannot make. The empty state below renders only
   * once this says the source is exhausted.
   */
  older: OlderMail;
  tags: TagDTO[];
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  now: Date;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
}) {
  const t = useTranslations("folder");
  const to = useTranslations("ohbox");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  // The user's pick, else the URL's open message (a search hit's landing), else the first row
  // so the column is never blank beside a list that has rows — TagView's rule, safe for
  // TagView's reason: the list does not re-partition under it.
  const shown =
    messages.find((m) => m.id === selectedId)
      ?? older.items.find((m) => m.id === selectedId)
      ?? (locateId ? messages.find((m) => m.id === locateId) : null)
      ?? messages[0]
      ?? older.items[0]
      ?? null;

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: EngineMessage) => {
    if (readColumnHidden()) onOpen(m);
    else setSelectedId(m.id);
  };

  // The standard grouping, the Ohbox's own labels: unread is what is unhandled here, read is
  // the folder's past. Both keys live in the `ohbox` namespace so the two lists can never
  // drift apart in copy. Flattened unread-first so ONE window covers both groups.
  const unreadRows = messages.filter((m) => m.unread);
  const readRows = messages.filter((m) => !m.unread);
  const ordered = [...unreadRows, ...readRows];
  const win = useListWindow({ scrollerRef, count: ordered.length });

  /**
   * AN EMPTY MIRROR IS A QUESTION, NOT AN ANSWER — probe once. The reach-past never fires
   * speculatively (older-mail.ts's rule: a person asks), and an empty list IS the ask: the
   * surface is about to claim "nothing in this folder" about a device that keeps a window over
   * a server holding everything. One page settles which sentence is true; everything past it
   * stays on the explicit button below.
   */
  const mirrorEmpty = ordered.length === 0;
  useEffect(() => {
    if (mirrorEmpty && older.available && !older.exhausted && !older.loading
      && older.items.length === 0 && older.error === null) {
      older.loadMore();
    }
    // Keyed on the emptiness question, not on the paging state: one probe per empty arrival.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mirrorEmpty, older.available]);

  /**
   * REVEAL A TARGET THE WINDOW HAS NOT MOUNTED — the Ohbox window's own rule, verbatim in
   * spirit: the slice derives from `scrollTop`, so putting the row's offset in view mounts
   * it, and the shell's locate pass then finds, centers and flashes it.
   *
   * Keyed on the target AND on whether the list holds it: on a cold restore the folder entity
   * rides snapshot page 1 while an old target message can arrive on a LATER page, so the first
   * run finds no index and a target-only dependency would never fire again. `locateFound`
   * flips exactly once when the row enters the mirror, which re-runs the reveal without ever
   * re-running on scroll or on ordinary list churn — the window's own fields are still read at
   * fire time, so it cannot re-scroll the list under the user.
   *
   * The target also becomes the SELECTION, not merely a fallback: closing the reader clears
   * the URL's `/m/<id>` tail (and with it `locateId`), and a fallback-only target would snap
   * the wide layout's column back to the first row over a scroller still centered on the hit.
   */
  const locateIdx = locateId ? ordered.findIndex((m) => m.id === locateId) : -1;
  const locateFound = locateIdx >= 0;
  useEffect(() => {
    if (!locateId || !locateFound) return;
    setSelectedId(locateId);
    const idx = ordered.findIndex((m) => m.id === locateId);
    if (idx >= win.start && idx < win.end) return;
    const el = scrollerRef.current;
    if (el) el.scrollTop = Math.max(0, idx * win.rowHeight - el.clientHeight / 2);
    // Only the target and its arrival: the window's fields are read at fire time, and
    // re-running on every scroll-driven change would re-scroll the list under the user.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locateId, locateFound]);

  const parent = folderParentOf(folder.name);

  return (
    <section className="view split view-folder">
      <ListPane
        title={folderLeafOf(folder.name)}
        // The full path as the meta line when the folder is nested, so "Q1" says where it
        // lives; the count otherwise — TagView's meta, one namespace over.
        meta={parent ? folder.name : t("metaCount", { count: messages.length })}
        scrollerRef={scrollerRef}
      >
        <ListRows>
          {ordered.length ? (
            <>
              {win.padTop > 0 ? <div aria-hidden style={{ height: win.padTop }} /> : null}
              {ordered.slice(win.start, win.end).map((m, i) => {
                const index = win.start + i;
                // Each group's label rides its first row, so labels appear exactly where the
                // grouping puts them and unmount with the rows they head.
                const label =
                  index === 0 && unreadRows.length > 0
                    ? to("newForYou")
                    : index === unreadRows.length && readRows.length > 0
                      ? to("previouslySeen")
                      : null;
                return (
                  <div key={m.id}>
                    {label ? <ListGroupLabel>{label}</ListGroupLabel> : null}
                    <MessageRow
                      id={m.id}
                      from={senderName(m)}
                      address={rowAddress(m)}
                      {...avatarOf(m)}
                      participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
                      {...rowStamp(m, now, absoluteTime, onToggleTime)}
                      subject={m.subject}
                      preview={m.snippet}
                      amount={m.amount}
                      unread={m.unread}
                      seen={!m.unread}
                      selected={shown?.id === m.id}
                      threadCount={m.threadCount}
                      hasAttachment={m.hasAttachments}
                      protected={m.protected != null}
                      tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                      onClick={() => openRow(m)}
                    />
                  </div>
                );
              })}
              {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
            </>
          ) : older.available && !older.exhausted ? (
            // The mirror holds nothing AND the server has not finished answering: neither
            // sentence may be said yet. The tail below carries the state (probing / failed /
            // load more); this slot stays quiet rather than claiming emptiness early.
            null
          ) : (
            <div className="empty">
              <span className="glyph">📁</span>
              <b>{t("emptyTitle")}</b>
              {t("emptyHint")}
            </div>
          )}
          {/* MAIL FROM BEYOND WHAT THIS DEVICE KEPT — the Ohbox tail, verbatim in idiom and in
              copy (one namespace, so the two surfaces can never phrase the boundary apart).
              Rendered below the window under its own label: rows that came from the server a
              moment ago and are not in the mirror, never silently merged into "Earlier". */}
          {older.items.length > 0 ? (
            <>
              <ListGroupLabel>{to("olderTitle")}</ListGroupLabel>
              {older.items.map((m) => (
                <MessageRow
                  key={m.id}
                  id={m.id}
                  from={senderName(m)}
                  address={rowAddress(m)}
                  {...avatarOf(m)}
                  {...rowStamp(m, now, absoluteTime, onToggleTime)}
                  subject={m.subject}
                  preview={m.snippet}
                  amount={m.amount}
                  unread={m.unread}
                  seen={!m.unread}
                  selected={shown?.id === m.id}
                  threadCount={m.threadCount}
                  hasAttachment={m.hasAttachments}
                  protected={m.protected != null}
                  tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
                  onClick={() => openRow(m)}
                />
              ))}
            </>
          ) : null}
          {older.available ? (
            <div className="tail-row" role="status">
              {older.error !== null ? (
                <>
                  {to("olderFailed", { reason: older.error })}{" "}
                  <button type="button" className="btn ghost" onClick={older.loadMore}>
                    {to("olderRetry")}
                  </button>
                </>
              ) : older.loading ? (
                <span className="mbx-wait">
                  <span className="mbx-spin" aria-hidden="true" />
                  {to("olderLoading")}
                </span>
              ) : (
                <>
                  {older.items.length > 0
                    ? to("olderShowing", { count: older.items.length })
                    : to("olderPrompt")}{" "}
                  {older.exhausted ? (
                    to("olderEnd")
                  ) : (
                    <button type="button" className="btn ghost" onClick={older.loadMore}>
                      {to("olderAction")}
                    </button>
                  )}
                </>
              )}
            </div>
          ) : null}
        </ListRows>
      </ListPane>
      {/* The reading column — the Ohbox's own; no `onEnterReader`, TagView's reason. */}
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

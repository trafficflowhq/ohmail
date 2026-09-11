"use client";

/**
 * Trash — mail you deleted in ohmail, and the one place it can be put back. The composition is `FolderView`'s,
 * deliberately: a bin that looked like its own product would be a second mail client inside the first. The rows are
 * NOT in the mirror, structurally: a delete tombstones the row in every mirror, so the page comes from the server
 * ({@link useTrashPage}). What the list claims: the message-delete verb's own rows and nothing else — mail trashed in
 * another app is in the server's Trash folder this server never reads, and `trash.foot` says so.
 */

/**
 * Two row differences, both textual: the stamp says WHEN IT WAS DELETED (ordered by it, on the server), and a quiet
 * gloss names where a restore would put it — the server's resolved answer, since the origin folder can be gone. A
 * second section reads the mail server's OWN Trash live (`useTrashWindow`, never mirrored); the sections are
 * independent. The reading pane has one verb or none: restore over a mirrored row; over a LIVE row nothing ({@link
 * trashReadVerbs}) — a message the mirror never held records no folder for a restore to aim at.
 */
import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { presentsUnread, type EngineMessage, type TagDTO, type TrashRowWire } from "@ohmail/client-engine";
import { ListPane, ListRows, MessageRow, ReadColumn, Spinner } from "@ohmail/ui";
import type { TrashWindowItemWire } from "../api-client";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { useRowBadgeCopy } from "../shell/row-copy";
import {
  avatarHue, avatarOf, agoStamp, displayTime, hueOf, initialsOf, placeLabel, rowAddress,
  senderName, tagsOfMessage,
} from "../shell/format";
import { displayAddressee, displayAddressUnder } from "../shell/idn";
import { BodyText } from "../shell/BodyText";
import { useZoneNav } from "../shell/zone-nav";
import { readColumnHidden } from "../shell/narrow";
import { useListWindow } from "../shell/list-window";
import type { TrashPage } from "../shell/trash-page";
import {
  trashLiveKeyOf, trashLiveState, trashReadVerbs, type TrashWindowControl,
} from "../shell/trash-window";

/**
 * The row's stamp — how long ago it was deleted, plus the exact instant on hover. `agoStamp`, not
 * the list's `rowStamp`: `rowStamp` says WHICH DAY a message is from, this says HOW LONG AGO
 * something happened, which is what somebody looking for what they just deleted wants — `agoStamp`
 * is already the product's answer to that question and reads the app's own locale and zone. A row
 * whose `trashedAt` is absent (a server older than the field) falls back to no stamp at all rather
 * than the message's own date: a date in the deletion slot would be read as a deletion time, a
 * false statement, while an empty slot is merely quiet.
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
  live,
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
  /**
   * THE LIVE WINDOW onto the mail server's own Trash. Absent — no server to ask, the demo, or
   * "Use folders" off — and the view is byte-identical to before this section existed, with the
   * mirror-only foot sentence. Present, it is read-only: the control carries no verb.
   */
  live?: TrashWindowControl;
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
  /** The live section's pick, by its epoch-scoped key. Null means the reader is in the mirror. */
  const [liveKey, setLiveKey] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);

  const rows = page.items;
  const win = useListWindow({ scrollerRef, count: rows.length });

  /* The user's pick, else the URL's open message, else the first row — `FolderView`'s rule, safe
     here for a stronger reason: this list never re-partitions (one flat order, from the server). */
  const mirroredShown =
    rows.find((m) => m.id === selectedId)
    ?? (locateId ? rows.find((m) => m.id === locateId) : null)
    ?? rows[0]
    ?? null;
  /* ONE READING COLUMN, TWO POPULATIONS. A live pick wins while it stands, because the mirrored
     fallback is the first row and would otherwise keep a deleted message on screen beside the
     live row somebody just opened. Picking a mirrored row clears the live key, and vice versa. */
  const openLive = liveKey === null
    ? null
    : live?.items.find((i) => trashLiveKeyOf(i) === liveKey) ?? null;
  const shown = openLive === null ? mirroredShown : null;

  /* THE BODY OF A TOMBSTONED ROW. The body route answers for a deleted message by design
     (`schema-mail.ts` states it beside the column), which is what makes this view able to show a
     message rather than only a subject — a bin you cannot read is a bin you cannot decide about. */
  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: TrashRowWire) => {
    setLiveKey(null);
    setSelectedId(m.id);
    if (readColumnHidden()) onOpen(m);
  };

  /* THE LIVE BODY, ON OPEN. Keyed on the row's key alone and NOT on the control — the control is
     a fresh object per render, and this door re-asks a failed key, so a render-keyed effect would
     be a billed retry loop with nobody behind it (`session-body.ts` records the measurement).
     There is no narrow-width branch: the Trash view's reading column is not hidden at phone
     widths, and a live row has no mirror id the reader sheet could open. */
  const liveRef = useRef(live);
  liveRef.current = live;
  const openLiveKey = openLive === null ? null : trashLiveKeyOf(openLive);
  useEffect(() => {
    if (openLiveKey === null) return;
    const held = liveRef.current;
    const item = held?.items.find((i) => trashLiveKeyOf(i) === openLiveKey);
    if (item) held?.openBody(item);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openLiveKey]);

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
      disabled: shown == null && openLive == null,
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
    // A link names a MIRRORED message, so it takes the reading column back from a live pick.
    setLiveKey(null);
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
                  {/* THE SCOPE SENTENCE, PER CONFIGURATION. With the live section present it
                      names both populations and says the second is read-only; without it, it
                      names the mirror and where the rest of the mail is. Two keys rather than
                      one, because a single sentence would claim a section that is not there. */}
                  {live ? t("footLive") : t("foot")}{" "}
                  {page.exhausted ? null : (
                    <button type="button" className="btn ghost" onClick={page.loadMore}>
                      {to("olderAction")}
                    </button>
                  )}
                </>
              )}
            </div>
          ) : null}

          {/* THE SECOND SECTION — the mail server's own Trash, read live. Outside every branch
              above: `page.available` is about the MIRROR's route, and a client that cannot list
              ohmail's deletes can still read the folder. */}
          {live ? (
            <TrashLiveSection
              live={live}
              activeKey={liveKey}
              now={now}
              onSelect={(key) => {
                setSelectedId(null);
                setLiveKey(key);
              }}
            />
          ) : null}
        </ListRows>
      </ListPane>
      <ReadColumn regionLabel={tReader("pane")}>
        {/* WHICH VERBS THIS COLUMN OFFERS is decided ONCE, by which population is open, and the
            decision is the only switch: a mirrored row gets `MessagePane`'s restore bar, a live
            row gets a pane with no action set at all. Not an omitted prop — `MessagePane` with
            no `trash` renders the full eleven-group bar, so omission would arm every filing verb
            over a message the mirror has never held. */}
        {trashReadVerbs({ live: openLive !== null }).verbs === "restore_and_read" ? (
          shown ? (
            <MessagePane
              message={shown.unread === presentsUnread(shown) ? shown : { ...shown, unread: presentsUnread(shown) }}
              tags={tags}
              now={now}
              onAction={(a) => onAction(a, shown)}
              onAddTag={onAddTag}
              trash
            />
          ) : null
        ) : openLive !== null && live !== undefined ? (
          <TrashLiveRead item={openLive} live={live} now={now} />
        ) : null}
      </ReadColumn>
    </section>
  );
}

/* ══════════════════════════════════════════════════════════════════════════════════════════
   THE LIVE SECTION — the mail server's own Trash, read through `useTrashWindow`.
   Presentational only: every fact comes through {@link TrashWindowControl}, which carries no
   verb, so there is nothing here to dispatch but a selection, a retry and "show older".
   ══════════════════════════════════════════════════════════════════════════════════════════ */

/**
 * Newest first, by the message's own date. The server merges each mailbox's page newest-first
 * but under a per-mailbox sequence-prefix rule, so two mailboxes can interleave slightly out of
 * date order; the section claims date order, so it sorts. A stable sort, so rows the provider
 * gave no date keep the server's order among themselves rather than jumping about.
 */
function byDateDesc(rows: readonly TrashWindowItemWire[]): TrashWindowItemWire[] {
  return [...rows]
    .map((row, at) => ({ row, at, ms: row.date === null ? -1 : Date.parse(row.date) || -1 }))
    .sort((a, b) => (b.ms - a.ms) || (a.at - b.at))
    .map((x) => x.row);
}

function TrashLiveSection({
  live,
  activeKey,
  now,
  onSelect,
}: {
  live: TrashWindowControl;
  activeKey: string | null;
  now: Date;
  onSelect: (key: string) => void;
}) {
  const t = useTranslations("trash");
  /* ONE VERDICT FOR THE WHOLE SECTION (`trashLiveState`), so no two branches here can each
     decide what the window's silence means. */
  const verdict = trashLiveState(live).state;
  const degraded = live.mailboxes.filter((m) => m.window !== "ok");
  const older = live.nextCursor !== null ? (
    <div className="trash-live-older">
      <button
        type="button"
        className="btn ghost"
        onClick={live.loadOlder}
        disabled={live.olderLoading}
      >
        {live.olderLoading ? t("liveOlderLoading") : t("liveOlder")}
      </button>
    </div>
  ) : null;

  return (
    <div className="trash-live">
      <h3 className="trash-live-head">{t("liveHead")}</h3>

      {verdict === "loading" ? (
        <p className="trash-live-note" role="status" aria-busy="true">
          <span className="mbx-wait">
            <Spinner className="mbx-spin" />
            {t("liveLoading")}
          </span>
        </p>
      ) : null}

      {/* FAILED, NEVER EMPTY: "nothing in your mail server's Trash" is an answer, and a read that
          did not happen has no business giving it. The retry is this press, not a loop. */}
      {verdict === "failed" ? (
        <div className="empty" role="status">
          <span className="glyph" aria-hidden="true">🗑</span>
          {t("liveFailed")}
          <button type="button" className="btn ghost" onClick={live.reload}>
            {t("liveRetry")}
          </button>
        </div>
      ) : null}

      {verdict === "rows"
        ? byDateDesc(live.items).map((i) => (
          <MessageRow
            key={trashLiveKeyOf(i)}
            id={trashLiveKeyOf(i)}
            from={displayAddressee(i.from.name, i.from.address)}
            address={displayAddressUnder(i.from.name, i.from.address)}
            time={i.date ? displayTime({ date: i.date }, now) : undefined}
            subject={i.subject}
            avatarInitial={initialsOf(i.from.name ?? i.from.address)}
            avatarHue={avatarHue(i.from.address)}
            /* WHERE IT IS, named on every row — the mirrored rows above gloss where a restore
               would put them, and these have no such destination to name. */
            place={t("liveOrigin")}
            dull
            selected={trashLiveKeyOf(i) === activeKey}
            onClick={() => onSelect(trashLiveKeyOf(i))}
          />
        ))
        : null}

      {/* The three quiet answers, each its own sentence: no folder to read, a read that ran past
          the server's budget, and a folder that was read and is empty. */}
      {verdict === "unavailable" ? (
        <p className="trash-live-note">{t("liveUnavailable")}</p>
      ) : null}
      {verdict === "read_limited" ? (
        <p className="trash-live-note" role="status">{t("liveReadLimited")}</p>
      ) : null}
      {verdict === "empty" ? <p className="trash-live-note">{t("liveEmpty")}</p> : null}

      {/* Per-mailbox degrades, named under whatever DID load. */}
      {verdict === "rows"
        ? degraded.map((m) => (
          <p key={m.id} className="trash-live-note">
            {t(m.window === "no_trash_folder" ? "liveNoFolder" : "liveUnreachable", {
              address: m.address,
            })}
          </p>
        ))
        : null}

      {verdict === "rows" || verdict === "more_to_read" ? older : null}
    </div>
  );
}

/**
 * ONE LIVE ROW, READ — the head line, the read-only statement, and the body the route fetched,
 * as TEXT. Never the sender's html: Trash holds whatever was deleted, spam included, so it
 * renders on the Junk window's terms — no remote content, no markup, no tracker.
 *
 * NO ACTION BAR AND NO `onAction`. The absence is decided by {@link trashReadVerbs} at the
 * reading column, and the prop does not exist on this component: there is no verb to pass.
 */
function TrashLiveRead({
  item,
  live,
  now,
}: {
  item: TrashWindowItemWire;
  live: TrashWindowControl;
  now: Date;
}) {
  const t = useTranslations("trash");
  const tb = useTranslations("body");
  const body = live.bodyFor(item);
  return (
    <article className="trash-live-read">
      <header className="trash-live-read-head">
        <div className="trash-live-read-who">
          <span className="trash-live-read-from">
            {displayAddressee(item.from.name, item.from.address)}
          </span>
          <span className="trash-live-read-addr">
            {displayAddressUnder(item.from.name, item.from.address)}
          </span>
          {item.date ? (
            <span className="trash-live-read-time num">{displayTime({ date: item.date }, now)}</span>
          ) : null}
        </div>
        <h2 className="trash-live-read-subj">{item.subject}</h2>
      </header>
      <p className="trash-live-note trash-live-readonly">{t("liveReadOnly")}</p>
      {body.phase === "ready" ? (
        <BodyText text={body.text} />
      ) : body.phase === "failed" ? (
        <p className="trash-live-note" role="status">
          {t("liveBodyFailed")}{" "}
          <button
            type="button"
            className="btn ghost"
            onClick={() => live.openBody(item, { retry: true })}
          >
            {tb("retry")}
          </button>
        </p>
      ) : (
        /* IDLE AND LOADING READ THE SAME HERE: the body is asked for the moment a row is
           selected, so there is no resting state between the two worth a different sentence. */
        <p className="trash-live-note" role="status" aria-busy="true">
          <span className="mbx-wait">
            <Spinner className="mbx-spin" />
            {t("liveBodyLoading")}
          </span>
        </p>
      )}
    </article>
  );
}

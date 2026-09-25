"use client";

/**
 * History — every message the account owns, newest first, back to the first one. It is the
 * store's timeline ({@link useStoreTimeline}): the list is as long as the store's total, rows are
 * fetched a page at a time as the window nears them, and the month rail jumps anywhere in it.
 * Nothing here has moved — every row names the server folder the message sits in. The mirror only
 * paints first and is replaced in place; no path here reads or writes the mirror's window.
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslations } from "next-intl";
import { useRowBadgeCopy } from "../shell/row-copy";
import { rowThreadOf } from "../shell/row-thread";
import {
  countWhen, listSurface, physicalFolderOf, saysEmpty,
  type EngineMessage, type OhmailEngine, type TagDTO,
} from "@ohmail/client-engine";
import { InfoNote, ListPane, ListRows, MessageRow, ReadColumn, Spinner } from "@ohmail/ui";
import { MessagePane, type MessageAction } from "../shell/MessagePane";
import { useListWindow } from "../shell/list-window";
import { useStoreTimeline } from "../shell/store-timeline";
import { avatarOf, rowStamp, rowAddress, senderName, tagsOfMessage, hueOf } from "../shell/format";
import { useZoneNav } from "../shell/zone-nav";
import { useMessageVerbs } from "../shell/message-verbs";
import { readColumnHidden } from "../shell/narrow";
import { useLoadingGrace } from "../shell/loading-grace";
import { HistoryRail } from "./HistoryRail";
import "./history-rail.css";

/**
 * The mirror's rows in the store's reading order: `date desc nulls last, id desc`. Each date is
 * parsed once, not per comparison — the comparator parsed two dates per comparison, n log n of
 * them on every visit to History.
 */
export function newestFirst(rows: readonly EngineMessage[]): EngineMessage[] {
  const keyed = rows.map((m) => {
    const t = Date.parse(m.date ?? "");
    return { m, t: Number.isFinite(t) ? t : Number.NEGATIVE_INFINITY };
  });
  keyed.sort((a, b) => b.t - a.t || (a.m.id < b.m.id ? 1 : a.m.id > b.m.id ? -1 : 0));
  return keyed.map((k) => k.m);
}

export function HistoryView({
  engine,
  version,
  settled,
  owed,
  tags,
  threadParticipants,
  threadCountOf,
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
  held,
}: {
  /** The store's timeline and pages come through the engine's doors; the mirror paints first. */
  engine: OhmailEngine;
  /** The mirror's version — page rows re-read the mirror's live row when it moves. */
  version: number;
  /** `MailState.settled` / `owed`: emptiness is stated only over a read mirror (the demo's arm). */
  settled: boolean;
  owed: boolean;
  /** The people in a row's conversation, for its lead circles — optional, as in every list. */
  threadParticipants?: (threadId: string) => { initials: string; hue: number }[];
  threadCountOf?: (threadId: string) => number;
  absoluteTime?: boolean;
  onToggleTime?: () => void;
  tags: TagDTO[];
  now: Date;
  /** The reader sheet, in place — the narrow-width tap, where there is no reading column. */
  onOpen: (m: EngineMessage) => void;
  /** Hydrate the reading column's message; off-mirror rows take the body door. */
  hydrateBody: (id: string, opts?: { retry?: boolean }) => void;
  onAction: (action: MessageAction, message: EngineMessage) => void;
  onAddTag: (messageId: string, anchor: HTMLElement | null) => void;
  onScreen: (messageId: string, anchor: HTMLElement | null) => void;
  canDelete: (message: EngineMessage) => boolean;
  canReplyAll: (message: EngineMessage) => boolean;
  /** Rows inside a delete's undo window — gone from every list while the toast stands. */
  held?: ReadonlySet<string>;
}) {
  const t = useTranslations("history");
  const rowBadge = useRowBadgeCopy();
  const to = useTranslations("ohbox");
  const tReader = useTranslations("reader");

  const mirrorRows = useMemo(
    () => newestFirst(engine.read().list<EngineMessage>("message")),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, version],
  );
  const store = useStoreTimeline(engine, version, mirrorRows);
  const tl = useMemo(() => (held === undefined || held.size === 0 ? store : {
    ...store,
    rowAt: (i: number) => {
      const r = store.rowAt(i);
      return r !== null && r !== "gone" && held.has(r.id) ? "gone" as const : r;
    },
  }), [store, held]);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const win = useListWindow({ scrollerRef, count: tl.length });

  /* The pages the window nears — asked after every move and every landed page. */
  const { want } = tl;
  useEffect(() => {
    want(win.visibleStart, win.visibleEnd);
  }, [want, win.visibleStart, win.visibleEnd]);

  const speak = useLoadingGrace(tl.state === "loading" || (tl.state === "unavailable"
    && !saysEmpty(listSurface({ settled, count: tl.length, pending: owed }))));

  /**
   * The open message is held as the ROW, not an index: a page can be evicted while it is read,
   * and the column must not follow the cache. Absent a pick, the first slot's row.
   */
  const [picked, setPicked] = useState<{ row: EngineMessage; at: number } | null>(null);
  const first = tl.rowAt(0);
  const shown = picked
    ? (engine.storePageRow(picked.row) ?? picked.row)
    : first !== null && first !== "gone" ? first : null;
  const shownAt = picked ? picked.at : shown ? 0 : -1;

  useEffect(() => {
    if (shown) hydrateBody(shown.id);
  }, [shown?.id, hydrateBody]);

  const openRow = (m: EngineMessage, at: number) => {
    setPicked({ row: m, at });
    if (readColumnHidden()) onOpen(m);
  };

  /** Move the cursor to slot `i`: select the row there, or scroll to it so its page is fetched. */
  const selectAt = (i: number): void => {
    const r = tl.rowAt(i);
    if (r !== null && r !== "gone") setPicked({ row: r, at: i });
    const el = scrollerRef.current;
    if (el) {
      const top = win.offsetOf(i);
      if (top < el.scrollTop || top > el.scrollTop + el.clientHeight - win.rowHeight) {
        el.scrollTop = Math.max(0, top - win.rowHeight);
      }
    }
  };
  const loaded = (() => {
    const out: EngineMessage[] = [];
    for (let i = win.start; i < win.end; i++) {
      const r = tl.rowAt(i);
      if (r !== null && r !== "gone") out.push(r);
    }
    return out;
  })();
  useMessageVerbs({
    shown, scope: ".view-history", onAction, onAddTag, onScreen, canDelete, canReplyAll,
    rows: loaded, select: (id) => {
      for (let i = win.start; i < win.end; i++) {
        const r = tl.rowAt(i);
        if (r !== null && r !== "gone" && r.id === id) return selectAt(i);
      }
    },
  });

  useZoneNav({
    list: {
      followId: shown?.id ?? null,
      up: { disabled: shownAt <= 0, run: () => selectAt(shownAt - 1), label: to("keyPrev") },
      down: { disabled: shownAt < 0 || shownAt >= tl.length - 1, run: () => selectAt(shownAt + 1), label: to("keyNext") },
    },
    reader: {
      selector: ".view-history .read-col",
      disabled: shown == null,
      onHiddenEnter: () => {
        if (shown) onOpen(shown);
      },
    },
  });

  /**
   * A RAIL PRESS HOLDS ITS SLOT AT THE TOP EDGE until the reader moves the list: the rows above it
   * are priced before they are drawn, and their measured heights would move it after the jump.
   * The rail marks the pressed month while the press holds (a year too short to reach the top
   * edge still opens on its press), then the month under the top edge, never the overscan's.
   */
  const pin = useRef<{ slot: number; count: number } | null>(null);
  const [railAt, setRailAt] = useState(0);
  const slotAt = (y: number): number => {
    let lo = 0;
    let hi = Math.max(0, tl.length - 1);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (win.offsetOf(mid) <= y) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    if (pin.current !== null && pin.current.count !== tl.length) pin.current = null;
    const held = pin.current;
    const node = held ? el.querySelector<HTMLElement>(`.rows > [data-index="${held.slot}"]`) : null;
    if (node) {
      const d = node.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientTop;
      if (Math.abs(d) >= 1) {
        el.scrollTop += d;
        el.dispatchEvent(new Event("scroll"));
      }
    }
    const at = held ? held.slot : slotAt(el.scrollTop + 0.5);
    const month = tl.segments.find((s) => at >= s.start && at < s.start + s.count);
    const next = month ? month.start : at;
    if (next !== railAt) setRailAt(next);
  });
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return undefined;
    const release = () => { pin.current = null; };
    el.addEventListener("wheel", release, { passive: true });
    el.addEventListener("touchstart", release, { passive: true });
    el.addEventListener("pointerdown", release);
    window.addEventListener("keydown", release, true);
    return () => {
      el.removeEventListener("wheel", release);
      el.removeEventListener("touchstart", release);
      el.removeEventListener("pointerdown", release);
      window.removeEventListener("keydown", release, true);
    };
  }, []);

  /** The rail's jump: the month's first slot at the top edge; the effect above fetches it. */
  const jumpTo = (start: number) => {
    tl.jump(start);
    pin.current = { slot: start, count: tl.length };
    setRailAt(start);
    const el = scrollerRef.current;
    if (el) el.scrollTop = win.offsetOf(start);
    el?.dispatchEvent(new Event("scroll"));
  };

  const meta = tl.state === "ready"
    ? t("metaCount", { count: tl.total ?? tl.length })
    : tl.state === "unavailable"
      ? countWhen({ settled, count: tl.length, pending: owed },
        tl.length ? t("metaCount", { count: tl.length }) : undefined)
      : undefined;
  const empty = tl.length === 0 && (tl.state === "ready"
    || (tl.state === "unavailable" && saysEmpty(listSurface({ settled, count: 0, pending: owed }))));

  const slots: ReactElement[] = [];
  for (let i = win.start; i < win.end; i++) {
    const m = tl.rowAt(i);
    if (m === "gone") {
      /* Deleted here since the page was read: the slot folds away until the page is asked again. */
      slots.push(<div key={`g${i}`} data-index={i} className="history-gone" aria-hidden />);
    } else if (m === null) {
      slots.push(
        <div key={`p${i}`} data-index={i} className="row history-ghost" aria-hidden>
          <span className="history-ghost-bar" />
          <span className="history-ghost-bar short" />
        </div>,
      );
    } else {
      slots.push(
        <MessageRow
          spoken={rowBadge.spoken}
          key={m.id}
          id={m.id}
          windowIndex={i}
          inSet={{ size: tl.length, position: i + 1 }}
          from={senderName(m)}
          address={rowAddress(m)}
          {...avatarOf(m)}
          participants={m.threadId ? threadParticipants?.(m.threadId) : undefined}
          {...rowStamp(m, now, absoluteTime, onToggleTime)}
          subject={m.subject}
          preview={m.snippet}
          amount={m.amount}
          unread={m.unread}
          seen
          selected={shown?.id === m.id}
          {...rowThreadOf(m, threadCountOf, rowBadge.thread)}
          hasAttachment={m.hasAttachments}
          protectedLabel={m.protected != null ? rowBadge.protectedLabel : undefined}
          tags={tagsOfMessage(m, tags).map((x) => ({ name: x.name, hue: hueOf(x) }))}
          place={physicalFolderOf(m)}
          onClick={() => openRow(m, i)}
        />,
      );
    }
  }

  return (
    <section className="view split view-history">
      <ListPane title={t("title")} meta={meta} scrollerRef={scrollerRef}>
        <InfoNote className="view-note" lead={t("explainer")} moreLabel={t("explainerMoreLabel")}>
          {t("explainerMore")}
        </InfoNote>
        {tl.state === "ready" && tl.segments.length > 1 ? (
          <HistoryRail segments={tl.segments} at={railAt} onJump={jumpTo} />
        ) : null}
        {tl.state === "unanswered" ? (
          <div className="tail-row history-unanswered" role="status">
            {t("storeUnavailable")}{" "}
            <button type="button" className="btn ghost" onClick={tl.retry}>{t("storeRetry")}</button>
          </div>
        ) : tl.state === "loading" && tl.length > 0 && speak ? (
          <div className="tail-row" role="status">{t("loading")}</div>
        ) : null}
        <ListRows ariaLabel={t("title")}>
          {tl.length > 0 ? (
            <>
              <div aria-hidden data-window-top="" style={{ height: win.padTop }} />
              {slots}
              {win.padBottom > 0 ? <div aria-hidden style={{ height: win.padBottom }} /> : null}
            </>
          ) : empty ? (
            <div className="empty">
              <span className="glyph">🕰</span>
              <b>{t("emptyTitle")}</b>
              {t("emptyHint")}
            </div>
          ) : (
            <div className="empty" role="status" aria-busy="true">
              <span className="mbx-wait">
                <Spinner className="mbx-spin" />
                {speak ? <b>{t("loading")}</b> : null}
              </span>
            </div>
          )}
        </ListRows>
      </ListPane>
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

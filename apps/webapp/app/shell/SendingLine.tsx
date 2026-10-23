"use client";

/**
 * THE SIDEBAR'S FOOT LINE FOR A SEND THAT LEFT ITS EDITOR. When the connection is healthy, Send
 * closes the compose or the reply dock the moment the send is on disk (`send-handoff.ts`), and the
 * sending finishes here: "Sending to Mila…", then "Sent", which settles away. A refusal or a give-up
 * stands here as the editor's own sentence (`sendLine`) with Open, which brings the message back
 * with every word. One line; nothing here decides anything about a send (`MailSendApi.line`).
 *
 * Every kind the line holds stands on its own row (`lineRows`), so an ending that waits for the
 * person hides no later send and swallows no "Sent"; and an outcome names its message, by whom it was
 * for and its subject in a few words, so a "Not sent" is never read as being about the send just made.
 *
 * Two shapes on the sync line's rule (`SyncBar.tsx`): `rail` in the rail's sync slot, `shell` as the
 * corner pill under 1024px; `app.css` shows exactly one. Absent from the DOM when there is nothing
 * to say.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Spinner } from "@ohmail/ui";
import { useTranslations } from "next-intl";
import { COMPOSE_SEND_KEY, SENDING_LONG_MS, type MailSendApi, type SendLineItem } from "./mail-send";
import { sendLine, sendLineValues } from "./SendStatus";
import { footLineSeen } from "./narrow";

type LineApi = Pick<MailSendApi, "line" | "subscribeLine" | "lineVersion" | "mountLine" | "dismissLine">;

/** One row of the line: one kind, and its items. */
export interface LineRow { kind: SendLineItem["state"]; items: SendLineItem[] }

/**
 * THE LINE'S ROWS: every kind present, in this order — a not-sent ending, queued, sending, sent —
 * each counted when it holds several. #185's rule stands within the endings: only refusals that left
 * their row are counted "weren't sent"; an unverified send (it may have gone), a duplicate or a
 * refusal with no row says its own line, the latest one, on a row above the count.
 */
export function lineRows(items: readonly SendLineItem[]): LineRow[] {
  const rows: LineRow[] = [];
  for (const kind of ["ended", "queued", "sending", "sent"] as const) {
    const of = items.filter((i) => i.state === kind);
    if (of.length === 0) continue;
    if (kind === "ended") {
      const kept = (i: SendLineItem): boolean => i.ended?.phase === "failed" && i.left !== undefined;
      const own = of.filter((i) => !kept(i));
      if (own.length > 0) rows.push({ kind, items: [own[own.length - 1]!] });
      if (of.some(kept)) rows.push({ kind, items: of.filter(kept) });
      continue;
    }
    rows.push({ kind, items: of });
  }
  return rows;
}

export function SendingLine({ api, variant, onOpen, onOpenMany }: {
  api: LineApi;
  variant: "rail" | "shell";
  /**
   * Open one item's lane: the message back with every word, or its editor while it waits. `false`:
   * nothing opened (the composer holds a letter being written), and the ending keeps its place.
   */
  onOpen: (item: SendLineItem) => boolean;
  /** Several not sent: Drafts holds them. */
  onOpenMany: () => void;
}) {
  const t = useTranslations("sendingLine");
  const tc = useTranslations("compose");
  const tr = useTranslations("reply");
  useEffect(() => api.mountLine(() => footLineSeen(variant)), [api, variant]);
  useSyncExternalStore(api.subscribeLine, api.lineVersion, api.lineVersion);
  const rows = lineRows(api.line());

  // "Still sending" past SENDING_LONG_MS, from the oldest send's own stamp.
  const sending = rows.find((r) => r.kind === "sending");
  const since = sending ? Math.min(...sending.items.map((i) => i.since ?? Date.now())) : undefined;
  const [longAt, setLongAt] = useState(false);
  useEffect(() => {
    if (since === undefined) { setLongAt(false); return; }
    const left = SENDING_LONG_MS - (Date.now() - since);
    if (left <= 0) { setLongAt(true); return; }
    setLongAt(false);
    const timer = setTimeout(() => setLongAt(true), left);
    return () => clearTimeout(timer);
  }, [since]);

  if (rows.length === 0) return null;
  const scoped = (item: SendLineItem): typeof tc => (item.key === COMPOSE_SEND_KEY ? tc : tr);
  /** Which message an outcome is about: whom it was for, and its subject in a few words. */
  const about = (item: SendLineItem): string | null => (item.to !== null && item.subject !== null
    ? t("aboutBoth", { name: item.to, subject: item.subject })
    : item.to !== null ? t("aboutTo", { name: item.to })
      : item.subject !== null ? t("aboutSubject", { subject: item.subject }) : null);

  const said = rows.map((row) => {
    const one = row.items.length === 1 ? row.items[0]! : null;
    let title: string;
    let detail: string | null = null;
    let open: (() => void) | null = null;
    let dismiss: (() => void) | null = null;
    if (row.kind === "ended") {
      if (one !== null) {
        const line = one.ended ? sendLine(one.ended, false) : null;
        const sentence = line ? scoped(one)(line.key, sendLineValues()) : tr("statusFailed");
        const named = about(one);
        title = named ?? sentence;
        detail = named !== null ? sentence : null;
        open = () => { if (onOpen(one)) api.dismissLine(one.id); };
        dismiss = () => api.dismissLine(one.id);
      } else {
        title = tc("notSentMany", { count: row.items.length });
        open = () => { for (const i of row.items) api.dismissLine(i.id); onOpenMany(); };
        dismiss = () => { for (const i of row.items) api.dismissLine(i.id); };
      }
    } else if (row.kind === "queued") {
      const sentence = one !== null ? scoped(one)("statusQueued") : tc("statusQueued");
      const named = one !== null ? about(one) : null;
      title = named ?? sentence;
      detail = named !== null ? sentence : null;
      if (one !== null) open = () => onOpen(one);
    } else if (row.kind === "sending") {
      title = one === null
        ? t("sendingMany", { count: row.items.length })
        : one.to !== null
          ? t(longAt ? "sendingLong" : "sending", { name: one.to })
          : t(longAt ? "sendingLongUnnamed" : "sendingUnnamed");
    } else {
      title = one === null || one.to === null ? t("sent")
        : one.subject !== null ? t("sentToAbout", { name: one.to, subject: one.subject })
          : t("sentTo", { name: one.to });
    }
    return { row, title, detail, open, dismiss };
  });

  const tone = rows.some((r) => r.kind === "ended") ? "warn" : "busy";
  const mark = (kind: LineRow["kind"]) => (kind === "sending"
    ? <Spinner className="mbx-spin" />
    : <span className="glyph" aria-hidden="true">{kind === "ended" ? "⚠" : "✉"}</span>);
  const actions = (s: (typeof said)[number]) => (s.open || s.dismiss ? (
    <span className="sl-actions">
      {s.open ? <button type="button" className="sl-act" onClick={s.open}>{t("open")}</button> : null}
      {s.dismiss ? <button type="button" className="sl-act sl-quiet" onClick={s.dismiss}>{t("dismiss")}</button> : null}
    </span>
  ) : null);

  if (variant === "rail") {
    return (
      <div className={`rail-sync sending-line ${tone}`} role="status" aria-live="polite">
        {said.map((s) => (
          <div className="sl-row" key={`${s.row.kind}:${s.row.items.map((i) => i.id).join(",")}`}>
            <div className="rs-line">
              {mark(s.row.kind)}
              <b>{s.title}</b>
            </div>
            {s.detail !== null ? <span className="sl-say">{s.detail}</span> : null}
            {actions(s)}
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="sync-bar busy sending-pill" role="status" aria-live="polite">
      {said.map((s) => (
        <div className="sl-row" key={`${s.row.kind}:${s.row.items.map((i) => i.id).join(",")}`}>
          {mark(s.row.kind)}
          <b>{s.title}</b>
          {s.detail !== null ? <span className="sl-say">{s.detail}</span> : null}
          {actions(s)}
        </div>
      ))}
      <SendPillReserve />
    </div>
  );
}

/** The pill's own room in the phone scrollers' bottom reservation, as `PillReserve` does (app.css). */
const SEND_PILL_VAR = "--send-pill-h";
function SendPillReserve() {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const bar = ref.current?.parentElement;
    if (!bar) return;
    const root = document.documentElement;
    const write = (): void => {
      const h = bar.offsetHeight;
      root.style.setProperty(SEND_PILL_VAR, h > 0 ? `${h + 8}px` : "0px");
    };
    write();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(write);
    ro?.observe(bar);
    return () => {
      ro?.disconnect();
      root.style.removeProperty(SEND_PILL_VAR);
    };
  }, []);
  return <span ref={ref} hidden />;
}

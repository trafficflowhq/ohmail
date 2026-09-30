"use client";

/**
 * Who organizes these mailboxes changed — said once, then gone. Two kinds are news (`organizerNotices`): another
 * install took a mailbox, or its holder stopped and nothing files it. ONE BLOCK PER KIND, `stopped` first; a block
 * about several mailboxes is one sentence with the count, and the count opens the list. Rendered at the rail's foot
 * (`variant="rail"`) and, under 901px where the rail is a drawer, as the topbar's twin (`variant="shell"`) — one
 * query in `app.css` shows exactly one. "Mark read" acknowledges every row its block lists, on the row itself, so the
 * press holds on every device and across a relaunch (DESIGN-026 §1.2-1.4).
 */

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";

import type { OrganizerNotice as OrganizerNoticeFact, OrganizerNoticeKind } from "./mail-state";
import { goSettings } from "./routing";

/**
 * How "Mark read" reaches the row. Injected rather than imported, on the seam rule the away
 * responder and the profile card follow: the browser reaches a hosted API, the desktop window
 * reaches an engine on the same machine over a pipe, and the sentence, the gate and the
 * once-per-change rule have exactly one implementation between them. MUST REJECT on failure: a
 * resolved promise is read as "acknowledged" and the line leaves the screen until the next poll
 * agrees; a rejection puts it back — the truthful outcome for a stamp that was not written.
 */
export type OrganizerNoticeTransport = (mailboxId: string) => Promise<unknown>;

export function OrganizerNotice({
  notices,
  onAcknowledge,
  variant = "rail",
}: {
  /** `organizerNotices(facts)`, newest change first. Empty renders nothing at all. */
  notices: readonly OrganizerNoticeFact[];
  onAcknowledge: OrganizerNoticeTransport;
  variant?: "rail" | "shell";
}) {
  const t = useTranslations("mailboxes");
  /**
   * Changes acknowledged in this session, so the block leaves on the press rather than on the poll.
   * Keyed by `${id}@${at}` — the CHANGE, not the mailbox: a later real change on a mailbox dismissed
   * earlier carries a new instant and shows. Optimistic and NOT authoritative: the row decides. A
   * change whose write REJECTED is removed from here again, so it comes back alone.
   */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  /** Which blocks show their mailboxes. Local UI state, remembered nowhere. */
  const [open, setOpen] = useState<ReadonlySet<OrganizerNoticeKind>>(() => new Set());
  const ackKey = (n: OrganizerNoticeFact): string => `${n.id}@${n.at}`;
  const live = notices.filter((n) => !acknowledged.has(ackKey(n)));
  if (live.length === 0) return null;

  const acknowledge = (rows: readonly OrganizerNoticeFact[]): void => {
    setAcknowledged((s) => new Set([...s, ...rows.map(ackKey)]));
    for (const n of rows) {
      // The transport takes the bare mailbox id; the row's stamp answers the change standing now.
      void onAcknowledge(n.id).catch(() => {
        setAcknowledged((s) => {
          const next = new Set(s);
          next.delete(ackKey(n));
          return next;
        });
      });
    }
  };

  const block = (kind: OrganizerNoticeKind, rows: readonly OrganizerNoticeFact[]): ReactNode => {
    const one = rows.length === 1 ? rows[0]! : null;
    const isOpen = open.has(kind);
    const mark = { b: (chunks: ReactNode) => <b>{chunks}</b> };
    /* THE COUNT IS THE DISCLOSURE. `{count}` is at least 2 in the *Many keys — one mailbox takes
       the named sentence — so the catalogues need no plural form. */
    const count = (chunks: ReactNode) => (
      <button
        type="button"
        className="rn-count"
        aria-expanded={isOpen}
        aria-label={t(isOpen ? "noticeCountHide" : "noticeCountShow")}
        onClick={() => setOpen((s) => {
          const next = new Set(s);
          if (next.has(kind)) next.delete(kind); else next.add(kind);
          return next;
        })}
      >
        {chunks}
      </button>
    );
    const sentence = one
      ? kind === "stopped"
        ? one.name
          ? t.rich("noticeStopped", { ...mark, name: one.name, address: one.address })
          : t.rich("noticeStoppedUnknown", { ...mark, address: one.address })
        : one.name
          ? t("noticeElsewhere", { name: one.name, address: one.address })
          : t("noticeElsewhereUnknown", { address: one.address })
      : t.rich(kind === "stopped" ? "noticeStoppedMany" : "noticeElsewhereMany",
        { ...mark, c: count, count: rows.length });
    const holder = (n: OrganizerNoticeFact): string => kind === "stopped"
      ? n.name ? t("noticeRowStopped", { name: n.name }) : t("noticeRowStoppedUnknown")
      : n.name ?? t("noticeRowUnknown");
    return (
      <div
        className={variant === "rail" ? "rail-notice" : "notice-shell"}
        role="status"
        data-state={kind}
        key={kind}
      >
        <div className="rn-line">
          <span className="rn-mark" aria-hidden="true" />
          <span className="rn-text">{sentence}</span>
        </div>
        {!one && isOpen ? (
          <ul className="rn-rows">
            {rows.map((n) => (
              <li key={n.id}>
                <span className="rn-addr">{n.address}</span>
                <span className="rn-holder"> · {holder(n)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="rn-verbs">
          {/* The way to act, on the one kind that names something to act on; "Mark read" last. */}
          {kind === "stopped" ? (
            <button type="button" onClick={() => goSettings("mailboxes")}>
              {t("noticeOpenMailboxes")}
            </button>
          ) : null}
          <button type="button" onClick={() => acknowledge(rows)}>
            {t("noticeDismiss")}
          </button>
        </div>
      </div>
    );
  };

  // The open condition above the settled one; inside a block, the roster's order (DESIGN-026 §1.2).
  const ofKind = (k: OrganizerNoticeKind) =>
    live.filter((n) => n.kind === k).sort((x, y) => x.order - y.order);
  const stopped = ofKind("stopped");
  const elsewhere = ofKind("elsewhere");
  return (
    <>
      {stopped.length > 0 ? block("stopped", stopped) : null}
      {elsewhere.length > 0 ? block("elsewhere", elsewhere) : null}
    </>
  );
}

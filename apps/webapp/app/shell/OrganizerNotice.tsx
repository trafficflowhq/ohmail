"use client";

/**
 * Who organizes these mailboxes changed — said once, then gone. Two kinds are news (`organizerNotices`): another
 * install took a mailbox, or its holder stopped and nothing files it. ONE BLOCK PER KIND, `stopped` first; a block
 * about several mailboxes is one sentence with the count, and the count opens the list. Rendered at the rail's foot
 * (`variant="rail"`) and, under 1024px where the rail is a drawer, as the topbar's twin (`variant="shell"`) — one
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
 * agrees; a rejection keeps it, with one line saying why ({@link refusalOf}).
 */
export type OrganizerNoticeTransport = (mailboxId: string) => Promise<unknown>;

type RefusalKey = "noticeDismissOffline" | "noticeDismissInactive" | "noticeDismissFailed";

/** The two codes that mean this install reached nothing: the desktop proxy's, the web client's. */
const OFFLINE_CODES: ReadonlySet<unknown> = new Set(["offline_read_only", "network_unreachable"]);

/**
 * Why a Mark read did not land, read off the rejection's `status` and `code` (the web client's
 * `ApiError`, the desktop bridge's refusal) or a fetch that reached nothing (`TypeError`). Offline
 * only by its code — a server's own 503 is not the install being offline; 402 is the account's
 * access refusal; anything else is said plainly.
 */
export function refusalOf(err: unknown): RefusalKey {
  const e = (err ?? {}) as { status?: unknown; code?: unknown };
  if (err instanceof TypeError || OFFLINE_CODES.has(e.code)) return "noticeDismissOffline";
  if (e.status === 402) return "noticeDismissInactive";
  return "noticeDismissFailed";
}

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
   * Changes whose Mark read was ANSWERED in this session, so the block leaves on the write's answer
   * rather than on the poll. Keyed by `${id}@${at}` — the CHANGE, not the mailbox: a later real
   * change on a mailbox dismissed earlier carries a new instant and shows. Not authoritative: the
   * row decides. A refused row never enters, so the notice stays and {@link refused} says why.
   */
  const [acknowledged, setAcknowledged] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * Per block, why its last press did not land and which changes it refused. Said only while one
   * of those changes is still on screen, so it never lands under a later, unrelated change; the
   * block's next press replaces it and a press that lands everywhere clears it.
   */
  const [refused, setRefused] = useState<ReadonlyMap<OrganizerNoticeKind, { why: RefusalKey; rows: ReadonlySet<string> }>>(
    () => new Map(),
  );
  /** Which blocks show their mailboxes. Local UI state, remembered nowhere. */
  const [open, setOpen] = useState<ReadonlySet<OrganizerNoticeKind>>(() => new Set());
  const ackKey = (n: OrganizerNoticeFact): string => `${n.id}@${n.at}`;
  const live = notices.filter((n) => !acknowledged.has(ackKey(n)));
  if (live.length === 0) return null;

  const acknowledge = (kind: OrganizerNoticeKind, rows: readonly OrganizerNoticeFact[]): void => {
    // The transport takes the bare mailbox id; the row's stamp answers the change standing now.
    const answers = rows.map((n) => onAcknowledge(n.id).then(
      () => { setAcknowledged((s) => new Set([...s, ackKey(n)])); return null; },
      (err: unknown) => ({ key: ackKey(n), why: refusalOf(err) }),
    ));
    void Promise.all(answers).then((all) => {
      const no = all.filter((a): a is { key: string; why: RefusalKey } => a !== null);
      setRefused((m) => {
        const next = new Map(m);
        if (no.length === 0) next.delete(kind);
        else next.set(kind, { why: no[0]!.why, rows: new Set(no.map((a) => a.key)) });
        return next;
      });
    });
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
    const said = refused.get(kind);
    const why = said && rows.some((n) => said.rows.has(ackKey(n))) ? said.why : null;
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
          <button type="button" onClick={() => acknowledge(kind, rows)}>
            {t("noticeDismiss")}
          </button>
        </div>
        {why ? <p className="rn-refused">{t(why)}</p> : null}
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

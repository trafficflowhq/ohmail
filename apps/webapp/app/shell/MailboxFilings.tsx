/**
 * SETTINGS → MAILBOXES → THE FILINGS THAT WAIT. The strip says "6 messages have not been filed"
 * and links here; this is the block it links to: per mailbox with waiting filings, how many, since
 * when, into which folder, why, and two presses — "Try again now" (the worker picks them up on its
 * next pass) and "Leave them where they are" (the intent settles on the folder the mail is in).
 * Neither press moves mail here. Each host hands in its own transport, as `MailboxSelfCheck` does.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsRow, SettingsSection } from "@ohmail/ui";

import { ApiError } from "../api-client";
import { PILE_KEY_OF_FOLDER } from "./decision-copy";
import { waterlineStamp } from "./format";
import { displayAddress } from "./idn";
import { activeFormatLocale, activeFormatZone } from "./locale";
import { clock } from "@ohmail/client-engine";
import { useMailState, useMailboxFacts } from "./MailStateProvider";
import { FILING_REFUSAL_REASONS, type MailboxFacts } from "./mail-state";
import { useHashRoute } from "./routing";

export interface MailboxFilingsApi {
  read: (mailboxId: string) => Promise<unknown>;
  retry: (mailboxId: string, folder: string) => Promise<{ reset: number; skipped?: number }>;
  leave: (mailboxId: string, folder: string, through: string) => Promise<{ settled: number; remaining?: number }>;
}

interface Group {
  folder: string;
  count: number;
  /** Deletes waiting to land in Trash: Leave never settles them. */
  deletes: number;
  through: string | null;
  since: string | null;
  nextAttemptAt: string | null;
  at: string | null;
  reasons: Array<{ reason: string | null; count: number }>;
}

type Say = (key: string, values?: Record<string, string | number>) => string;
type Read = { k: "loading" } | { k: "read"; groups: Group[] } | { k: "unread" };
type Note = { k: "retried" | "left"; count: number } | { k: "failed" | "elsewhere" } | null;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** The wire narrowed: anything that is not the shape reads as unreadable, never as "nothing waits". */
function groupsOf(body: unknown, mailboxId: string): Group[] | null {
  const b = body as { mailboxId?: unknown; groups?: unknown } | null;
  if (!b || b.mailboxId !== mailboxId || !Array.isArray(b.groups)) return null;
  const out: Group[] = [];
  for (const g of b.groups as Array<Record<string, unknown>>) {
    const folder = str(g?.folder);
    if (folder === null || !Array.isArray(g.reasons)) return null;
    out.push({
      folder, count: num(g.count), deletes: num(g.deletes), through: str(g.through), since: str(g.since),
      nextAttemptAt: str(g.nextAttemptAt), at: str(g.at),
      reasons: (g.reasons as Array<Record<string, unknown>>).map((r) => ({ reason: str(r?.reason), count: num(r?.count) })),
    });
  }
  return out;
}

/** Waiting by the strip's rule: stuck or deferred. */
const waits = (m: MailboxFacts): boolean =>
  m.status !== "disabled" && m.organizerRole !== "reader"
  && Boolean(m.filing && ((m.filing.stuck ?? 0) > 0 || m.filing.deferred > 0));

export function MailboxFilings({ api }: { api: MailboxFilingsApi }) {
  const facts = useMailboxFacts();
  // A block pressed in this visit stays to say what the press did, after its rows have cleared.
  const [pressed, setPressed] = useState<ReadonlySet<string>>(() => new Set());
  const onPressed = useCallback((id: string) => setPressed((p) => (p.has(id) ? p : new Set(p).add(id))), []);
  const rows = (facts ?? []).filter((m) => waits(m) || (pressed.has(m.id) && m.status !== "disabled"));
  if (rows.length === 0) return null;
  return <>{rows.map((m) => <MailboxFilingsBlock key={m.id} mailbox={m} api={api} onPressed={onPressed} />)}</>;
}

function MailboxFilingsBlock({ mailbox: m, api, onPressed }: {
  mailbox: MailboxFacts; api: MailboxFilingsApi; onPressed: (id: string) => void;
}) {
  const t = useTranslations("mailboxFilings") as unknown as Say;
  const ts = useTranslations("sync") as unknown as Say;
  const tp = useTranslations("screener") as unknown as Say;
  const { refresh } = useMailState();
  const route = useHashRoute();
  const [read, setRead] = useState<Read>({ k: "loading" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  const heading = useRef<HTMLDivElement>(null);
  const focusedFor = useRef<string | null>(null);

  const load = useCallback(async () => {
    try {
      const groups = groupsOf(await api.read(m.id), m.id);
      setRead(groups === null ? { k: "unread" } : { k: "read", groups });
    } catch {
      setRead({ k: "unread" });
    }
  }, [api, m.id]);

  // Re-read when this mailbox's own figures move; no timer of its own — the facts poll is the clock.
  const f = m.filing;
  useEffect(() => { void load(); }, [load, f?.stuck, f?.deferred, m.pendingMoves]);

  // Opened from the strip: this mailbox's block takes the focus, once per hash.
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  useLayoutEffect(() => {
    if (route.settingsMailboxId !== m.id || focusedFor.current === hash) return;
    focusedFor.current = hash;
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: "start" });
  }, [route.settingsMailboxId, m.id, hash]);

  const pressed = async (act: () => Promise<Note>) => {
    onPressed(m.id);
    setBusy(true);
    let next: Note;
    try {
      next = await act();
    } catch (err) {
      next = err instanceof ApiError && err.status === 409 ? { k: "elsewhere" } : { k: "failed" };
    }
    await refresh();
    await load();
    setNote(next);
    setBusy(false);
  };

  const name = m.displayName?.trim() || displayAddress(m.address);
  const folderName = (folder: string): string => {
    const key = PILE_KEY_OF_FOLDER[folder];
    return key ? tp(key) : folder;
  };
  const reasonWords = (r: string | null): string => {
    const known = r !== null && (FILING_REFUSAL_REASONS as readonly string[]).includes(r) ? r : r === null ? "none" : "unknown";
    return ts(`filingReason_${known}`);
  };
  const time = (iso: string): string => clock(new Date(iso), activeFormatZone());

  return (
    <SettingsSection className="mbx-filings">
      <div className="set-sub" role="heading" aria-level={3} tabIndex={-1} ref={heading}>
        {t("title", { mailbox: name })}
      </div>
      {read.k === "unread" && f ? (
        <SettingsRow label={t("unread", { count: f.due + f.deferred })} />
      ) : null}
      {read.k === "read" ? read.groups.map((g) => {
        const reasons = g.reasons.length === 1
          ? reasonWords(g.reasons[0]!.reason)
          : g.reasons.map((r) => t("reasonCounted", { reason: reasonWords(r.reason), count: r.count })).join(", ");
        const lines = [
          t("why", { reasons }),
          g.nextAttemptAt ? t("next", { at: time(g.nextAttemptAt) }) : null,
          g.at ? t("at", { count: g.count, at: folderName(g.at) }) : null,
          g.deletes > 0 ? t(g.deletes >= g.count ? "deletesAll" : "deletesSome", { count: g.deletes }) : null,
        ].filter((x): x is string => x !== null);
        return (
          <SettingsRow
            key={g.folder}
            label={t("group", {
              count: g.count, folder: folderName(g.folder),
              since: g.since ? waterlineStamp(g.since, new Date(), activeFormatLocale()) : "—",
            })}
            description={(
              <>
                {lines.join(" ")}
                <span className="mbx-actions">
                  <Button
                    variant="ghost" className="mbx-btn" disabled={busy}
                    onClick={() => { void pressed(async () => ({ k: "retried", count: (await api.retry(m.id, g.folder)).reset })); }}
                  >
                    {t("retry")}
                  </Button>
                  {g.count > g.deletes ? (
                    <Button
                      variant="ghost" className="mbx-btn" disabled={busy || g.through === null}
                      onClick={() => {
                        void pressed(async () => ({ k: "left", count: (await api.leave(m.id, g.folder, g.through!)).settled }));
                      }}
                    >
                      {t("leave")}
                    </Button>
                  ) : null}
                </span>
              </>
            )}
          />
        );
      }) : null}
      <p className="set-note-inline" role="status">
        {note === null ? null : note.k === "retried" || note.k === "left" ? t(note.k, { count: note.count }) : t(note.k)}
      </p>
    </SettingsSection>
  );
}

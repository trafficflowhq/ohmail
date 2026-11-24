/**
 * SETTINGS → MAILBOXES → THE FILINGS THAT WAIT. The strip says "6 messages have not been filed"
 * and links here; these are the lines it links to, drawn under the other lines of the mailbox's own
 * sheet: how many, since when, into which folder, why, and two presses — "Try again now" (the
 * worker picks them up on its next pass) and "Leave them where they are" (the intent settles on the
 * folder the mail is in). Neither press moves mail. Each host hands in its own transport, as
 * `MailboxSelfCheck` does. A mailbox with nothing waiting draws nothing and asks for nothing; a
 * press that cleared the wait keeps the lines standing to say what the press did.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@ohmail/ui/base";
import { SettingLine } from "@ohmail/ui/mail";

import { ApiError } from "../api-client";
import { PILE_KEY_OF_FOLDER } from "./decision-copy";
import { waterlineStamp } from "./format";
import { displayAddress } from "@ohmail/app-logic/text/idn";
import { activeFormatLocale, activeFormatZone } from "./locale";
import { clock } from "@ohmail/client-engine";
import { useMailState } from "@ohmail/app-logic/mail-state/mail-state-binding";
import { FILING_REFUSAL_REASONS, type MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { useHashRoute } from "./routing";
/* The block's reader moved beside the Mailboxes pane's rules; this file draws it. */
import { filingGroupsOf as groupsOf, filingWaits as waits, type FilingGroup as Group } from "@ohmail/app-logic/mailboxes/moved";

export interface MailboxFilingsApi {
  read: (mailboxId: string) => Promise<unknown>;
  retry: (mailboxId: string, folder: string) => Promise<{ reset: number; skipped?: number }>;
  leave: (mailboxId: string, folder: string, through: string) => Promise<{ settled: number; remaining?: number }>;
}

type Say = (key: string, values?: Record<string, string | number>) => string;
type Read = { k: "loading" } | { k: "read"; groups: Group[] } | { k: "unread" };
type Note = { k: "retried" | "left"; count: number } | { k: "failed" | "elsewhere" } | null;

/** One mailbox's waiting filings, as lines of that mailbox's own sheet. */
export function MailboxFilings({ mailbox: m, api }: { mailbox: MailboxFacts; api: MailboxFilingsApi }) {
  const t = useTranslations("mailboxFilings") as unknown as Say;
  const ts = useTranslations("sync") as unknown as Say;
  const tp = useTranslations("screener") as unknown as Say;
  const { refresh } = useMailState();
  const route = useHashRoute();
  const [read, setRead] = useState<Read>({ k: "loading" });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note>(null);
  /** A press cleared the wait: the lines stay to say what the press did, until the row leaves. */
  const [kept, setKept] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedFor = useRef<string | null>(null);

  const waiting = waits(m);
  useEffect(() => {
    if (waiting) setKept(true);
  }, [waiting]);
  const shown = waiting || kept;

  const load = useCallback(async () => {
    try {
      const groups = groupsOf(await api.read(m.id), m.id);
      setRead(groups === null ? { k: "unread" } : { k: "read", groups });
    } catch {
      setRead({ k: "unread" });
    }
  }, [api, m.id]);

  // Re-read when this mailbox's own figures move; no timer of its own — the facts poll is the clock.
  // Nothing waiting and nothing pressed: nothing to read, so no request is made.
  const f = m.filing;
  useEffect(() => {
    if (!shown) return;
    void load();
  }, [load, shown, f?.stuck, f?.deferred, m.pendingMoves]);

  // Opened from the strip: this mailbox's lines take the focus, once per hash.
  const hash = typeof window === "undefined" ? "" : window.location.hash;
  useLayoutEffect(() => {
    if (route.settingsMailboxId !== m.id || focusedFor.current === hash) return;
    focusedFor.current = hash;
    heading.current?.focus();
    heading.current?.scrollIntoView?.({ block: "start" });
  }, [route.settingsMailboxId, m.id, hash]);

  const pressed = async (act: () => Promise<Note>) => {
    setKept(true);
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

  if (!shown) return null;

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
    <>
      <h3 className="oh-text" ref={heading} tabIndex={-1}>{t("title", { mailbox: name })}</h3>
      {read.k === "unread" && f ? (
        <SettingLine label={t("unread", { count: f.due + f.deferred })} />
      ) : null}
      {read.k === "read" ? read.groups.map((g) => {
        const reasons = g.reasons.length === 1
          ? reasonWords(g.reasons[0]!.reason)
          : g.reasons.map((r) => t("reasonCounted", { reason: reasonWords(r.reason), count: r.count })).join(", ");
        const value = [
          t("waitingValue", { count: g.count, folder: folderName(g.folder) }),
          g.nextAttemptAt ? t("next", { at: time(g.nextAttemptAt) }) : null,
        ].filter(Boolean).join(" · ");
        const lines = [
          t("waitingSince", { since: g.since ? waterlineStamp(g.since, new Date(), activeFormatLocale()) : "—" }),
          t("why", { reasons }),
          g.at ? t("at", { count: g.count, at: folderName(g.at) }) : null,
          g.deletes > 0 ? t(g.deletes >= g.count ? "deletesAll" : "deletesSome", { count: g.deletes }) : null,
        ].filter((x): x is string => x !== null);
        return (
          <SettingLine
            key={g.folder}
            label={t("waiting")}
            value={value}
            valueStatus
            description={lines.join(" ")}
            narrow="under"
          >
            <Button
              kind="quiet" size="s" disabled={busy}
              onPress={() => { void pressed(async () => ({ k: "retried", count: (await api.retry(m.id, g.folder)).reset })); }}
            >
              {t("retry")}
            </Button>
            {g.count > g.deletes ? (
              <Button
                kind="quiet" size="s" disabled={busy || g.through === null}
                onPress={() => {
                  void pressed(async () => ({ k: "left", count: (await api.leave(m.id, g.folder, g.through!)).settled }));
                }}
              >
                {t("leave")}
              </Button>
            ) : null}
          </SettingLine>
        );
      }) : null}
      <p className="oh-text" role="status">
        {note === null ? null : note.k === "retried" || note.k === "left" ? t(note.k, { count: note.count }) : t(note.k)}
      </p>
    </>
  );
}

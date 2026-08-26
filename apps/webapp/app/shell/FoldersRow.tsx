"use client";

/**
 * "USE FOLDERS" — the folders feature's master toggle (FOLDERS-SPEC.md §6; owner decision 1:
 * fully optional, disabled by default).
 *
 * ── WHAT THE DESCRIPTION MAY NOT SAY ──────────────────────────────────────────────────────────
 *
 * The honest sentence is the prototype's: these are THE REAL FOLDERS ON THE MAIL SERVER, NOT A
 * COPY. ohmail already reads them (the passive presence); this switch only decides whether they
 * are SHOWN — in the rail, as views, with counts. It must not promise filing, rules or AI: the
 * foundation stage ships none of those, and claims are contracts. Turning it off returns the
 * account to today's interface and moves nothing — the mail is in the user's own folders, where
 * the user put it, which is the whole leave-anytime argument (spec §13).
 *
 * ── WHY A PLAIN SWITCH AND NOT A CONFIRM ──────────────────────────────────────────────────────
 *
 * {@link AutoSuggestRow} confirms because ON starts spending. This spends nothing in either
 * direction and writes nothing into the mailbox — ON is a read-only act on a fifteen-year-old
 * mailbox (spec §10) — so a confirm would be a ceremony in front of a view toggle.
 *
 * ── IT WRITES THROUGH THE HOOK ────────────────────────────────────────────────────────────────
 *
 * `setFoldersEnabled` is `useConsentState().setFoldersEnabled`, never `consentApi` directly:
 * `AppShell` gates the rail group, the folder views and this pane's own state on the same hook's
 * `foldersEnabled`, so the rail changes on the same render the server confirms. The switch
 * renders the value the SERVER last answered with, never the optimistic pick — a refused write
 * must not draw a rail the account does not have.
 */

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { SettingsRow, Switch } from "@ohmail/ui";

export function FoldersRow({
  on,
  setFoldersEnabled,
  mailboxes,
  mailboxesOff,
  setMailboxFoldersEnabled,
}: {
  /** The STORED answer, as the server last gave it. */
  on: boolean;
  /** `useConsentState().setFoldersEnabled` — one writer, the value the whole shell reads. */
  setFoldersEnabled: (enabled: boolean) => Promise<boolean>;
  /**
   * The account's mailboxes for the PER-MAILBOX list (FOLDERS-SPEC.md §17) — id + address,
   * `GET /mailboxes`' order. Absent, or fewer than two: no list renders — with one mailbox the
   * master switch IS the mailbox switch, and a second row saying the same thing would be a
   * control that does nothing on its own.
   */
  mailboxes?: ReadonlyArray<{ id: string; address: string }>;
  /** The stored exceptions — `{ mailboxId: instant switched off }`. Absent map = all show. */
  mailboxesOff?: Record<string, string>;
  /** `useConsentState().setMailboxFoldersEnabled` — same one-writer rule as the master's. */
  setMailboxFoldersEnabled?: (mailboxId: string, enabled: boolean) => Promise<Record<string, string>>;
}) {
  const t = useTranslations("settings");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  /** The mailbox whose switch is in flight, or null — one write at a time, like the master. */
  const [mbPending, setMbPending] = useState<string | null>(null);
  const [mbFailed, setMbFailed] = useState(false);

  /** Unmounted-after-await guard — the pane is swapped by a nav press, so this really happens. */
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const write = (enabled: boolean) => {
    if (pending) return;
    setPending(true);
    setFailed(false);
    void (async () => {
      try {
        await setFoldersEnabled(enabled);
      } catch {
        if (alive.current) setFailed(true);
      } finally {
        if (alive.current) setPending(false);
      }
    })();
  };

  const writeMailbox = (mailboxId: string, enabled: boolean) => {
    if (mbPending !== null || !setMailboxFoldersEnabled) return;
    setMbPending(mailboxId);
    setMbFailed(false);
    void (async () => {
      try {
        await setMailboxFoldersEnabled(mailboxId, enabled);
      } catch {
        if (alive.current) setMbFailed(true);
      } finally {
        if (alive.current) setMbPending(null);
      }
    })();
  };

  /* THE PER-MAILBOX LIST (FOLDERS-SPEC.md §17; owner ruling 2026-08-25) — under the master,
     only while it is ON (below the toggle nothing renders when off, the pane's standing rule),
     and only when a second mailbox exists: with one, the master IS the mailbox switch. Each
     row wears the address (data, not chrome — no catalogue key) and the SERVER's answer: a
     mailbox is on exactly when it has no stored exception, so a refused write never draws a
     tree the rail will not have. */
  const showMailboxList =
    on && setMailboxFoldersEnabled !== undefined && (mailboxes?.length ?? 0) >= 2;

  return (
    <>
      <SettingsRow
        label={t("folders.useTitle")}
        description={on ? t("folders.useOn") : t("folders.useOff")}
        control={
          <Switch
            checked={on}
            disabled={pending}
            ariaLabel={t("folders.useTitle")}
            onChange={write}
          />
        }
      />
      <p className="set-note-inline">{t("folders.microcopy")}</p>
      {failed ? <span className="scn-sg-note">{t("folders.failed")}</span> : null}
      {showMailboxList ? (
        <>
          <p className="set-note-inline">{t("folders.mailboxesNote")}</p>
          {mailboxes!.map((mb) => {
            const mbOn = (mailboxesOff?.[mb.id] ?? null) === null;
            return (
              <SettingsRow
                key={mb.id}
                label={mb.address}
                description={mbOn ? t("folders.mailboxOn") : t("folders.mailboxOff")}
                control={
                  <Switch
                    checked={mbOn}
                    disabled={mbPending !== null}
                    ariaLabel={`${t("folders.mailboxesTitle")}: ${mb.address}`}
                    onChange={(enabled) => writeMailbox(mb.id, enabled)}
                  />
                }
              />
            );
          })}
          {mbFailed ? <span className="scn-sg-note">{t("folders.failed")}</span> : null}
        </>
      ) : null}
    </>
  );
}

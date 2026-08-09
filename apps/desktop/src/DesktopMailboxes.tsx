/**
 * WHICH MAILBOX THIS INSTALL IS OPENING — the facts, and the Settings pane that shows them.
 *
 * Two surfaces, one read, and they were both empty for the same reason: this window handed the
 * shared client no way to ask about mailboxes.
 *
 *  · the SYNC LINE at the foot of the rail. It is driven by a ladder that starts with "can we see
 *    this account's mailboxes at all?" and answers `null` — say nothing — when it cannot. A browser
 *    tab supplies a probe over the hosted API, which this window may not name; so it supplied none,
 *    the ladder returned its resting value on every render, and a first sync ran to completion with
 *    the window silent throughout. That is the missing loader.
 *  · SETTINGS → MAILBOXES. The shared pane USED TO fall back to the mirror's `mailbox` entities,
 *    and `mailbox` is not a kind of thing the change feed carries — only the invented sample world
 *    has any — so the pane was reliably empty on a real install, which is exactly the surface
 *    somebody opens to find out what their install is connected to. That fallback is deleted now;
 *    the pane is host-supplied on every surface, and this file IS the desktop's host node.
 *
 * Both are answered by `GET /mailboxes`, which BOTH doors serve out of the database on this machine
 * — the standalone engine from its own row, the hosted one from the mirror — so this file needs no
 * knowledge of which door it is behind.
 *
 * ── THE PROBE MUST REJECT, NOT RETURN AN EMPTY LIST ─────────────────────────────────────────
 *
 * "We could not ask" and "there are none" are different facts and the ladder acts on them
 * differently: the second renders "No mailbox connected, so nothing can arrive". Mapping a failed
 * read to `[]` would put that sentence in front of somebody whose mailbox is working and whose
 * engine simply had not answered yet. So a failure propagates and the caller keeps the last thing
 * it actually knew.
 */

import { SettingsNote, SettingsRow, SettingsSection } from "@ohmail/ui";

import type { MailboxFacts } from "../../webapp/app/shell/mail-state";
import { useMailboxFacts } from "../../webapp/app/shell/MailStateProvider";
import { bridgeFetch } from "./bridge-fetch.js";

/** What `GET /mailboxes` answers with, narrowed to the fields these two surfaces read. */
interface MailboxWire {
  id: string;
  address: string;
  status: string;
  errorCode?: string | null;
  disabledReason?: string | null;
  syncBlockedReason?: string | null;
  syncBlockedSince?: string | null;
  lastSyncAt: string | null;
  initialImportCompletedAt?: string | null;
  createdAt?: string;
}

/**
 * The mailboxes this install opens, for the shared shell's sync line.
 *
 * Narrowed at the seam rather than passed through as the engine's own shape, for the reason the
 * hosted client narrows it: the ladder may consult only the fields it names, and mapping here is
 * what makes that a fact rather than an intention.
 *
 * `initialImportCompletedAt` is forwarded UNTOUCHED — no `?? null`. The ladder reads a null as "the
 * first import is not known to have finished" and an ABSENT field as "this engine predates the
 * column, fall back to watching the mirror grow". Collapsing the second into the first would pin
 * "Syncing your mail" over a mailbox that finished months ago.
 */
export async function readMailboxFacts(): Promise<MailboxFacts[]> {
  const res = await bridgeFetch("/mailboxes");
  if (!res.ok) throw new Error(`the mail engine answered ${res.status} for the mailbox list`);
  const body = (await res.json()) as { items?: MailboxWire[] };
  return (body.items ?? []).map((m) => ({
    id: m.id,
    address: m.address,
    status: m.status,
    errorCode: m.errorCode ?? null,
    disabledReason: m.disabledReason ?? null,
    syncBlockedReason: m.syncBlockedReason ?? null,
    syncBlockedSince: m.syncBlockedSince ?? null,
    lastSyncAt: m.lastSyncAt,
    ...("initialImportCompletedAt" in m
      ? { initialImportCompletedAt: m.initialImportCompletedAt }
      : {}),
    createdAt: m.createdAt ?? new Date().toISOString(),
  }));
}

/** A timestamp as something a person reads, or the em dash when there is none. */
function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString();
}

/**
 * What each mailbox is doing, in one line.
 *
 * The wording is this file's rather than the shared `mailboxes` namespace's, because the states a
 * desktop install can be in are a subset of a hosted account's and the words differ: nothing here
 * is "waiting for our servers", because there are none in the standalone case.
 */
function stateOf(m: MailboxFacts): string {
  if (m.status === "error") return `Not connecting (${m.errorCode ?? "unknown"})`;
  if (m.status === "disabled") {
    return m.disabledReason ? "Handed over to another install" : "Disconnected";
  }
  if (m.syncBlockedSince) return "Paused";
  if (m.lastSyncAt === null) return "Opening for the first time";
  if (m.initialImportCompletedAt === null) return "Still catching up";
  return "Up to date";
}

/**
 * SETTINGS → MAILBOXES, on the desktop.
 *
 * Read out of the same context the sync line reads, rather than fetched again: there is one poller
 * for this already, and two would be two answers to one question. `null` means the read has not
 * landed or could not be made, and it says so instead of claiming the install has no mailbox.
 */
export function DesktopMailboxes() {
  const facts = useMailboxFacts();

  if (facts === null) {
    return (
      <SettingsSection>
        {/* Names the mode, like the Cloud pane's "Cloud mailboxes" heading — one mode per
            install, never both in parallel. */}
        <h2 className="acct-h">Local mailboxes on this computer</h2>
        <p className="set-note-inline">Asking the mail engine which mailbox this install opens…</p>
      </SettingsSection>
    );
  }

  return (
    <SettingsSection>
      <h2 className="acct-h">Local mailboxes on this computer</h2>
      {facts.length === 0 ? (
        <p className="set-note-inline">
          This install has no mailbox yet — choose one in the Desktop settings pane.
        </p>
      ) : null}
      {facts.map((m) => (
        <SettingsRow
          key={m.id}
          label={m.address}
          description={`Last checked ${when(m.lastSyncAt)}`}
          value={stateOf(m)}
        />
      ))}
      <SettingsNote>
        {/* WHERE THE MAIL ACTUALLY IS, said on the screen that lists it. The claim is the
            product's own and is true on both doors: the master copy is the mailbox on the server,
            and what is on this machine is a copy that can be deleted without losing anything. */}
        Your mail lives on your mail server. What this app keeps on this computer is a copy — you
        can remove it and nothing is lost from the mailbox itself.
      </SettingsNote>
    </SettingsSection>
  );
}

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
 * ── WHAT THE HOSTED DOOR ACTUALLY ANSWERS WITH, WHICH IS NEWER THAN THIS PANE ───────────────
 *
 * "From the mirror" was, for a while, an overstatement worth correcting rather than deleting. The
 * hosted engine held ONE mailbox row — a placeholder its local schema needs, addressed with the
 * account LOGIN — and answered this route from it. So the pane and the From selector showed a
 * single mailbox that was not one of the account's, an account with two addresses could not be
 * told apart here, and a send carrying that row's id was refused by the account outright.
 *
 * The engine now mirrors the account's mailbox rows themselves, under the account's own ids, at
 * the start of every pull. This pane reads what it always read; what changed is that the rows
 * underneath it are the ones a browser tab would show.
 *
 * ── THE PROBE MUST REJECT, NOT RETURN AN EMPTY LIST ─────────────────────────────────────────
 *
 * "We could not ask" and "there are none" are different facts and the ladder acts on them
 * differently: the second renders "No mailbox connected, so nothing can arrive". Mapping a failed
 * read to `[]` would put that sentence in front of somebody whose mailbox is working and whose
 * engine simply had not answered yet. So a failure propagates and the caller keeps the last thing
 * it actually knew.
 *
 * ── WHAT THIS PANE CAN CHANGE, AND WHY THAT SET IS THE SIZE IT IS ───────────────────────────
 *
 * Exactly one mailbox mutation is available to a desktop install on the HOSTED door, and it is
 * here: `POST /mailboxes/:id/resync`. It is the one route in `mailboxRoutes` that writes and
 * carries no `stepUp` option, so it survives the gate described below; the engine's write-through
 * proxy relays it to the account with the install's bearer, and nothing in this window opens a
 * socket to do it.
 *
 * Everything else that changes a hosted mailbox — `POST /mailboxes`, `PATCH /mailboxes/:id`,
 * `DELETE /mailboxes/:id` — is step-up gated: the account demands a second factor asserted within
 * the last few minutes, because what those three store is a mailbox password. A desktop install's
 * session is stamped with such an assertion exactly once, when its link code was claimed, and
 * nothing rotates that stamp forward (`mintRotation` does not touch `last_twofa_at`). So a form
 * here would work for the first five minutes of an install's life and answer 403 for ever
 * afterwards — a control whose only reliable function is to say it has none, which is the shape
 * this app has removed elsewhere and must not reintroduce.
 *
 * The obstacle is NOT the transport, and that is worth stating plainly because the next reader
 * will find the pipe and wonder why nobody used it: the proxy would carry a PATCH perfectly well,
 * and Cloud would refuse it. Nor is a browser tab getting away with anything — it runs the
 * ceremony itself, with a password field and a passkey against a real origin, which is precisely
 * what this window cannot offer.
 *
 * So the hosted door gets the list, the one action it can take, a sentence, and a way OUT — the
 * browser, where the person is already signed in and where a second factor can actually be asked
 * for. `openWeb` is the same named-place mechanism the account and sign-in links use; this window
 * still names no address.
 *
 * The STANDALONE door is untouched by all of that, and its mailbox IS editable: the door chooser
 * configures the server through the shell and sends the password to the engine over this same
 * bridge (`doors.ts`, `PATCH /mailboxes/:id`), which the local engine serves itself against a
 * single-user database with no account and no factor in the picture. Nothing on that door is sent
 * to a browser, because there is no hosted account to administer.
 */

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsNote, SettingsRow, SettingsSection } from "@ohmail/ui";

import type { MailboxFacts } from "../../webapp/app/shell/mail-state";
import { useMailState } from "../../webapp/app/shell/MailStateProvider";
import { bridgeFetch } from "./bridge-fetch.js";
import { openWeb } from "./native.js";

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
  smtpMaxSizeBytes?: number | null;
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
  return readMailboxFactsVia(bridgeFetch);
}

/**
 * The same read over an INJECTED transport — the served host-client asks the identical question
 * over its bearer socket (`host-client/transports.ts`), and the absent-versus-null discipline
 * below must not be duplicated to be reused.
 */
export async function readMailboxFactsVia(
  fetchImpl: (url: string, init?: unknown) => Promise<Response>,
): Promise<MailboxFacts[]> {
  const res = await fetchImpl("/mailboxes");
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
    // WHAT THIS MAILBOX'S SUBMISSION SERVER SAID IT WILL ACCEPT (the connect-time probe's
    // RFC 1870 `SIZE`). Forwarded untouched, same rule as the line above: `null` is a server
    // that announced no ceiling, an ABSENT field is an engine that predates the column, and
    // the compose surface resolves both to the strict constant — but collapsing them here
    // would erase a distinction this shape documents. This field is the whole reason the
    // standalone door's attach cap can follow the user's own server instead of the hosted
    // constant; the engine has served it all along, and this narrowing used to drop it.
    ...("smtpMaxSizeBytes" in m ? { smtpMaxSizeBytes: m.smtpMaxSizeBytes } : {}),
    createdAt: m.createdAt ?? new Date().toISOString(),
  }));
}

/**
 * A refusal, as the sentence whoever made the decision wrote.
 *
 * The engine has a real one for every case on this path — this install is offline so writes are
 * paused, the account is no longer signed in, the mailbox is not this account's — and none of them
 * is inferable from a status code. A second taxonomy composed here is how somebody who is merely
 * offline is told their mailbox is broken.
 */
async function reasonOf(res: Response): Promise<string> {
  try {
    const wire = (await res.json()) as { error?: { message?: string } };
    if (wire.error?.message) return wire.error.message;
  } catch {
    /* Not JSON. The status is all there is to say, and saying it beats inventing a reason. */
  }
  return `the mail engine answered ${res.status}`;
}

/** A timestamp as something a person reads, or the em dash when there is none. */
function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString();
}

/**
 * SETTINGS → MAILBOXES, on the desktop.
 *
 * Read out of the same context the sync line reads, rather than fetched again: there is one poller
 * for this already, and two would be two answers to one question. `null` means the read has not
 * landed or could not be made, and it says so instead of claiming the install has no mailbox.
 *
 * ── THE HEADING NAMES THE DOOR, BECAUSE THE DOOR IS THE MODE ────────────────────────────────
 *
 * The pane names which kind of mailbox it lists — one mode per install, never both in parallel.
 * On the cloud door the mailbox is the hosted account's, organized in the cloud, so the heading is
 * "Cloud mailboxes", the same words the browser client uses — the same catalogue key, in fact.
 * On the local door the engine opens the user's own server on this machine, so it is "Local
 * mailboxes on this computer". Reading the same `door` the rest of the settings pane reads keeps
 * the heading from ever contradicting the door row two lines up.
 *
 * ── THE COPY IS THE CATALOGUE'S, NOT THIS FILE'S ────────────────────────────────────────────
 *
 * It used to be a dozen English literals, which meant a German install read this pane — the one
 * surface that says what an install is connected to and whether it is working — in English, with
 * no way for a translation to ever reach it. The states a desktop install can be in are still a
 * subset of a hosted account's and are still worded for it (nothing here is "waiting for our
 * servers"; on the standalone door there are none), so the keys are the desktop's own; what
 * changed is that they are keys.
 */
export function DesktopMailboxes({ door }: { door?: string | null }) {
  const t = useTranslations("mailboxes");
  /* The SAME binding the sync line reads, and `refresh` is what its own comment offers this pane:
     "Re-read the mailbox facts now. The Settings pane calls it after a connect or a resync." */
  const { mailboxes: facts, refresh } = useMailState();
  /* What can go wrong here: the engine refuses a resync (offline, most often), or the operating
     system refuses to open a browser. One line, rendered where the press happened. */
  const [problem, setProblem] = useState<string | null>(null);
  /** Mailboxes whose resync this pane has queued, so the row can say so until it lands. */
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  const cloud = door === "cloud";
  const heading = cloud ? t("modeCloud") : t("desktopModeLocal");

  /**
   * ASK FOR A FRESH PASS OVER ONE MAILBOX. 202 — nothing is synced when this returns.
   *
   * The only mutation this pane makes, and the only one it can make on the hosted door; see the
   * header. It is the same route the browser's own "Sync now" calls, over the pipe instead of a
   * socket, and it is served on BOTH doors — by the local engine's own route table on the
   * standalone one, by the write-through proxy on the hosted one.
   *
   * A failure clears the queued mark, because a row that stays disabled after a refusal is a
   * control somebody cannot retry.
   */
  const resync = (id: string): void => {
    setProblem(null);
    setQueued((q) => new Set(q).add(id));
    void (async () => {
      try {
        const res = await bridgeFetch(`/mailboxes/${encodeURIComponent(id)}/resync`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(await reasonOf(res));
        // The strip at the foot of the rail reads the same route on its own slower clock; without
        // this the row and the strip disagree about one mailbox for up to thirty seconds.
        refresh();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
        setQueued((q) => {
          const next = new Set(q);
          next.delete(id);
          return next;
        });
      }
    })();
  };

  if (facts === null) {
    return (
      <SettingsSection>
        <h2 className="acct-h">{heading}</h2>
        <p className="set-note-inline">{t("desktopLoading")}</p>
      </SettingsSection>
    );
  }

  /**
   * What each mailbox is doing, in one line. A closure rather than a module function so it reads
   * the same translator the rest of the pane does; there is nothing to share it with.
   */
  const stateOf = (m: MailboxFacts): string => {
    if (m.status === "error") {
      return t("desktopStateError", { code: m.errorCode ?? t("desktopUnknownCode") });
    }
    if (m.status === "disabled") {
      return m.disabledReason ? t("desktopStateHandedOver") : t("desktopStateDisconnected");
    }
    if (m.syncBlockedSince) return t("desktopStatePaused");
    if (m.lastSyncAt === null) return t("desktopStateFirstOpen");
    if (m.initialImportCompletedAt === null) return t("desktopStateCatchingUp");
    return t("desktopStateUpToDate");
  };

  return (
    <SettingsSection>
      <h2 className="acct-h">{heading}</h2>
      {facts.length === 0 ? (
        <p className="set-note-inline">{cloud ? t("desktopNoneCloud") : t("desktopNoneLocal")}</p>
      ) : null}

      {/* Above the rows rather than inside one: both things that can fail here — a refused resync
          and a refused browser — are about the pane, and a sentence that moves around as the
          failure changes is harder to find than one that does not. */}
      {problem ? <p className="join-error">{problem}</p> : null}

      {facts.map((m) => (
        <SettingsRow
          key={m.id}
          label={m.address}
          description={t("desktopLastChecked", { when: when(m.lastSyncAt) })}
          value={stateOf(m)}
          control={
            /* Not offered on a DISCONNECTED mailbox: nothing is opening it, so a pass over it is
               not a thing that can be asked for. The browser pane withholds it on the same test. */
            m.status === "disabled" ? undefined : (
              <Button
                className="mbx-btn"
                onClick={() => resync(m.id)}
                disabled={queued.has(m.id)}
              >
                {queued.has(m.id) ? t("syncQueued") : t("syncNow")}
              </Button>
            )
          }
        />
      ))}

      {/* THE HAND-OFF, ON THE HOSTED DOOR ONLY. See this file's header for why there is no edit
          form to offer beside the resync above: the account asks for a fresh second factor before
          it will store a mailbox password, and this install cannot assert one. The browser can,
          and is already signed in. A standalone install edits its mailbox on this machine through
          the door chooser and needs none of this. */}
      {cloud ? (
        <SettingsRow
          label={t("desktopManageOnWeb")}
          description={t("desktopManageOnWebWhy")}
          control={
            <Button
              onClick={() =>
                void openWeb("mailboxes").catch(() => setProblem(t("desktopNoBrowser")))
              }
            >
              {t("desktopOpenWeb")}
            </Button>
          }
        />
      ) : null}

      <SettingsNote>
        {/* WHERE THE MAIL ACTUALLY IS, said on the screen that lists it. The claim is the
            product's own and is true on both doors: the master copy is the mailbox on the server,
            and what is on this machine is a copy that can be deleted without losing anything. */}
        {t("desktopCopyIsACopy")}
      </SettingsNote>
    </SettingsSection>
  );
}

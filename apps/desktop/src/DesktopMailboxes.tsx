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
 * bridge (`doors.ts`, `PATCH /local/mailboxes/:id`), which the local engine serves itself against
 * a single-user database with no account and no factor in the picture. Nothing on that door is
 * sent to a browser, because there is no hosted account to administer.
 *
 * ── AND THAT DOOR CAN NOW REMOVE ONE, WHICH IT COULD NOT ────────────────────────────────────
 *
 * `DELETE /local/mailboxes/:id` is the fourth member of that same family and it has been served
 * since the removal was made to mean removal — release the organizer claim, wipe this machine's
 * mirror, stop the timer, close the login. NO CLIENT CALLED IT. This pane offered "Reading only"
 * and "Sync now", its own footnote said "you can remove it and nothing is lost from the mailbox
 * itself", and a release note described a remove-then-re-add walk that nobody standing at this
 * door could perform. The control is below, beside the resync, on the local door alone.
 */

import { Fragment, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button, SettingsActions, SettingsBanner, SettingsNote, SettingsRow, SettingsSection, SettingsVerdict } from "@ohmail/ui";

import {
  deviceHoldings, holdingsSpeak, readerStandDown, showInboundQuiet, type MailboxFacts,
} from "../../webapp/app/shell/mail-state";
import { addressKey } from "../../webapp/app/shell/address-key";
import { agoStamp } from "../../webapp/app/shell/format";
import { activeFormatLocale, activeFormatZone } from "../../webapp/app/shell/locale";
import { useMailState } from "../../webapp/app/shell/MailStateProvider";
import { goFirstRun } from "../../webapp/app/shell/routing";
import { bridgeFetch, engineLogout, type EngineStatus } from "./bridge-fetch.js";
import { firstRunDoorFor } from "./doors.js";
import { openWeb } from "./native.js";

/** What `GET /mailboxes` answers with, narrowed to the fields these two surfaces read. */
interface MailboxWire {
  id: string;
  address: string;
  /** The mailbox's user-facing label — `MailboxDTO.displayName`, null when nobody typed one. */
  displayName?: string | null;
  status: string;
  errorCode?: string | null;
  disabledReason?: string | null;
  syncBlockedReason?: string | null;
  syncBlockedSince?: string | null;
  /**
   * WHO ORGANIZES THIS MAILBOX, and whether that is this install.
   *
   * Unconditional on the polled row, so a reader is visible while `status` is `connected` —
   * which is the whole point of the split: a reader is CONNECTED AND SYNCING, not disabled.
   * Optional here because an engine older than the field is an ordinary state on a desktop that
   * updates on its own schedule; absent reads as `organizer`, which is what every install was
   * before the field existed.
   */
  organizerRole?: "organizer" | "reader";
  organizedBy?: { kind?: string | null; name?: string | null; since?: string | null } | null;
  organizerState?: "held" | "stopped" | null;
  lastSyncAt: string | null;
  initialImportCompletedAt?: string | null;
  smtpMaxSizeBytes?: number | null;
  /** Why sending is not set up, or absent/null when it is. See `MailboxFacts`. */
  sendingUnsettledReason?: string | null;
  /**
   * How many messages the ACCOUNT holds for this mailbox, as the local engine learned it from
   * the hosted mailbox list. Absent on a local-only install (there is no other copy to be
   * behind), absent before the engine's first counted refresh, and absent from any engine that
   * predates the field — all three are "cannot tell", which is what the shell's ladder does with
   * an absent number. Never confused with a count of the mirror: see `MailboxFacts`.
   */
  hostedMessageCount?: number;
  /**
   * HOW MUCH MAIL THE SERVER SAYS IS IN THIS MAILBOX — the local door's own Σ of
   * `mailbox_folders.server_exists` over the folders a cycle has opened (mail 0083).
   *
   * It is the FIRST PULL'S DENOMINATOR and the only fact on this door that can say where the
   * walk ends: the mirror's own count is the numerator, and without this there is no horizon to
   * compare it against. The engine has served it all along and this narrowing dropped it, so the
   * first-run pull stage showed no remaining count, no progress bar and never an ETA — see the
   * map below.
   *
   * Grows as the folder tree is walked, so a consumer must clamp the remainder at zero rather
   * than treat it as a fixed total (`pull-rate.ts` owns that rule).
   */
  serverMessageCount?: number;
  /** When this install was told it may organize this mailbox (mail 0083); null pre-consent. */
  organizeConsentedAt?: string | null;
  /** OUR filings this mailbox has not applied yet — the strip's `filing` arm reads it. */
  pendingMoves?: number;
  /**
   * The forwarding-detection notice's evidence pair (mail 0078): a standing quiet episode's
   * newest genuine inbound date, and this mailbox's dismissal. Absent on an engine that
   * predates the columns; forwarded by the `in`-spread below on the same rule as its
   * neighbours, because absent must render nothing rather than a false "no episode".
   */
  inboundQuietSince?: string | null;
  inboundQuietDismissedAt?: string | null;
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
    ...("displayName" in m ? { displayName: m.displayName } : {}),
    status: m.status,
    errorCode: m.errorCode ?? null,
    disabledReason: m.disabledReason ?? null,
    syncBlockedReason: m.syncBlockedReason ?? null,
    syncBlockedSince: m.syncBlockedSince ?? null,
    /* ABSENT READS AS `organizer`, deliberately: every install was one before the column existed,
       and an engine that predates it cannot have demoted anybody. The dangerous default is the
       other one — a window that assumed `reader` would put a claim banner on a mailbox this
       machine is already organizing. */
    organizerRole: m.organizerRole === "reader" ? "reader" : "organizer",
    organizedBy: m.organizedBy
      ? {
          kind: m.organizedBy.kind ?? null,
          name: m.organizedBy.name ?? null,
          since: m.organizedBy.since ?? null,
        }
      : null,
    organizerState: m.organizerState ?? null,
    /* Read HERE and nowhere else: one line above coerces the absent role away, and this is the
       last point at which "the engine never sent one" can be told from "the engine said
       organizer". See `MailboxFacts.legacyStandDown`. */
    legacyStandDown: m.organizerRole === undefined && m.status === "disabled" && Boolean(m.disabledReason),
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
    /* SPREAD, on the rule this file follows for every optional field: absent means an engine that
       predates the field and has nothing to say, which is a different answer from `null`
       ("sending is settled") even though both render the same. */
    ...("sendingUnsettledReason" in m
      ? { sendingUnsettledReason: m.sendingUnsettledReason }
      : {}),
    // THE ACCOUNT'S OWN COUNT, forwarded by the same `in` spread and for a sharper version of the
    // same reason: this is the denominator of the sentence "this device holds N of M", so a `?? 0`
    // here would not merely lose a field, it would assert that the account is empty and turn the
    // strip's comparison upside down. Absent must arrive absent. This seam has dropped a field
    // exactly once before — `smtpMaxSizeBytes`, on the line above — and it did so silently.
    ...("hostedMessageCount" in m ? { hostedMessageCount: m.hostedMessageCount } : {}),
    // ── AND IT DID IT A SECOND TIME, WITH THE FIELD THAT SAYS WHERE THE PULL ENDS ────────
    //
    // `serverMessageCount` is the local door's Σ of `server_exists`, and it never reached the
    // shell: the engine answers it beside every mailbox row and this narrowing forwarded
    // nothing, so `pullRemaining` had no denominator, the first-run pull stage rendered
    // neither the remaining counter nor the bar nor an ETA, and no surface on this door could
    // tell "the walk reached the end" from "the walk is still going".
    //
    // Absent must arrive ABSENT, on `hostedMessageCount`'s rule above: a `?? 0` would claim the
    // server holds no mail, which is a confident wrong answer rather than a missing one.
    //
    // The three drops share one cause — a hand-written field list beside a growing wire — so
    // `test/desktop-facts-census.test.ts` now derives the required set from `MailboxFacts`
    // itself and fails on any key this map does not forward. A fourth silent drop is not
    // available any more.
    ...("serverMessageCount" in m ? { serverMessageCount: m.serverMessageCount } : {}),
    ...("organizeConsentedAt" in m ? { organizeConsentedAt: m.organizeConsentedAt } : {}),
    ...("pendingMoves" in m ? { pendingMoves: m.pendingMoves } : {}),
    // THE FORWARDING-DETECTION PAIR (mail 0078), forwarded by the same `in` spread and for the
    // same reason as every optional field above: absent is an engine that predates the columns
    // and must arrive absent, so the pane renders nothing rather than asserting "no episode".
    ...("inboundQuietSince" in m ? { inboundQuietSince: m.inboundQuietSince } : {}),
    ...("inboundQuietDismissedAt" in m ? { inboundQuietDismissedAt: m.inboundQuietDismissedAt } : {}),
    // ── NEVER `?? new Date()`, AND THAT DEFAULT WAS A BUG THE FLOOR COULD NOT SURVIVE ───
    //
    // `importFloorSpeaks` trusts an unwritten `initial_import_completed_at` ABSOLUTELY for
    // `IMPORT_FLOOR_MAX_MS` (24 h) after `createdAt`, and only past that window does it demand
    // corroboration before repeating a claim the server never made. Defaulting an absent
    // `createdAt` to NOW re-based that window on every poll, so `now - connectedAt` was always
    // ~0, the bound could never elapse, and the strip would announce "Syncing your mail" for
    // ever over a finished mirror — the exact permanent falsehood the bound exists to end.
    //
    // The empty string is "the engine did not say", and every reader of this field already
    // treats an unparseable stamp as unknown rather than as a time: `importFloorSpeaks`'s
    // `Number.isFinite` guard takes the CORROBORATED path (documented there as deliberate, so
    // the floor may still speak — it just may no longer speak unconditionally), `earliest`
    // skips it and `minutesSince` answers null. Absent therefore degrades to "this client must
    // have something of its own to say", which is the honest reading of not knowing.
    createdAt: m.createdAt ?? "",
  }));
}

/**
 * THE DESKTOP'S FRESHNESS SOURCE — `GET /mirror/freshness` over the bridge, for the shared
 * shell's "As of <time> · catching up" arm (INSTANT-ARCH §6.6). The window's own engine drains
 * the sidecar's LOCAL feed and is always current relative to it; this asks the sidecar how old
 * ITS mirror is against the hosted account, which is the only honest answer on this surface.
 *
 * The narrowing is the ladder's own three-state check, and anything that is not one of the
 * three — a route this engine predates (404), a signed-out door (409), a body that is not a
 * verdict — REJECTS, per the `FreshnessProbe` contract: the provider keeps the last answer it
 * saw, and an unanswerable question must not be dressed as "current" (which would silently
 * unlabel a days-old mirror) or "stale" (which would label a current one). The LOCAL door has
 * no such route yet and lands here as a 404: its organizer syncs in-process and the label
 * stays silent — parked, stated in the stage-2 close-out.
 */
export async function readMirrorFreshness(): Promise<{
  state: "unknown" | "stale" | "current";
  asOf: string | null;
}> {
  const res = await bridgeFetch("/mirror/freshness");
  if (!res.ok) throw new Error(`the mail engine answered ${res.status} for the mirror freshness`);
  const wire = (await res.json()) as { state?: unknown; asOf?: unknown };
  if (wire.state !== "unknown" && wire.state !== "stale" && wire.state !== "current") {
    throw new Error("the mail engine answered something that is not a freshness verdict");
  }
  return { state: wire.state, asOf: typeof wire.asOf === "string" ? wire.asOf : null };
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
/**
 * A stamp in THE APP'S OWN LANGUAGE, not the browser's.
 *
 * `toLocaleString()` with no locale reads the BROWSER's, which is the defect `agoStamp` was
 * written to end — a German session rendered "Synchronisiert 1 minute ago", half a sentence in
 * each language. `activeFormatLocale()` is the choice the language row actually made, and the zone
 * comes from the same register for the same reason.
 */
function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleString(activeFormatLocale(), { timeZone: activeFormatZone() });
}

/**
 * THE DAY SOMETHING BECAME TRUE — a DATE, with no clock on it.
 *
 * "Organized by ohmail Cloud since 31 Aug 2026" is a standing fact somebody reads once. Putting a
 * timestamp in it ("since 8/31/2026, 3:28:43 AM") makes it look like an event log and invites
 * watching, which is the same reason the DTO deliberately carries when an install BECAME the
 * organizer rather than when it was last seen: a heartbeat on a screen is a thing people stare at.
 */
function day(iso: string | null | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return at.toLocaleDateString(activeFormatLocale(), { dateStyle: "medium", timeZone: activeFormatZone() });
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
/**
 * ONE ROW PER ADDRESS — the desktop half of the rule `app/shell/address-key.ts` sets out.
 *
 * Deliberately NOT an import of the browser pane's `groupByAddress`: that one is typed to
 * `MailboxDTO` and lives inside a route component this app must not pull in. What must be shared
 * is the KEY, and it is — everything below is the same three lines of bookkeeping the browser pane
 * does, over this pane's own fact shape.
 *
 * `shown` is the live row when there is one and the first otherwise; `superseded` counts the rest.
 * A group of only-disabled rows therefore keeps a real row with its own state, which is the case
 * the whole fold must not swallow.
 */
export function foldByAddress<T extends { id: string; address: string; status: string }>(
  items: readonly T[],
): { shown: T; superseded: number }[] {
  const order: string[] = [];
  const byKey = new Map<string, T[]>();
  for (const m of items) {
    const key = addressKey(m.address);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(m);
    else { byKey.set(key, [m]); order.push(key); }
  }
  return order.map((key) => {
    const rows = byKey.get(key)!;
    const live = rows.find((m) => m.status !== "disabled");
    return { shown: live ?? rows[0]!, superseded: rows.length - 1 };
  });
}

/**
 * The four answers `POST /local/organizer/takeover` can give, as the copy keys the pane owns.
 *
 * A narrowing function and not a bare template on the wire value, for `standDownToken`'s reason
 * verbatim: an outcome this build does not know — an engine newer than this window, which the
 * desktop's own update flow makes an ordinary state — would otherwise compose a key that does not
 * exist and throw inside a render. `authorized` is the fallback because it is the outcome that
 * changed something, and it is now the one that composes NO key at all: it renders
 * `organizeHereQueued` through the verdict block, so an unrecognised outcome cannot reach the
 * template either. The other three keep their own sentences.
 */
const TAKEOVER_OUTCOMES = ["authorized", "already_organizing", "removed", "no_mailbox"] as const;
type TakeoverOutcome = (typeof TAKEOVER_OUTCOMES)[number];
export function takeoverOutcome(wire: unknown): TakeoverOutcome {
  return (TAKEOVER_OUTCOMES as readonly string[]).includes(wire as string)
    ? (wire as TakeoverOutcome)
    : "authorized";
}

/**
 * THE PANE'S `door` STRING AS THE DOOR RULES READ IT.
 *
 * `firstRunDoorFor` takes an `EngineStatus` because every other door rule does, and asking it the
 * question here rather than re-spelling `door === "local"` is what keeps this row and the mount in
 * `DesktopGate` from ever disagreeing about which door has a setup flow. The pane is handed only
 * the mode, which is the whole of what the rule reads.
 */
function statusOf(door?: string | null): EngineStatus | null {
  return door === "local" || door === "cloud"
    ? ({ state: "serving", mode: door } as EngineStatus)
    : null;
}

/**
 * ── `servedMailboxId` IS GONE, AND ITS ABSENCE IS THE POINT ─────────────────────────────────
 *
 * Remove used to be offered on ONE row: the mailbox `engine_status` said the engine was opening.
 * That gate was correct for exactly as long as the engine opened one mailbox. The local removal
 * route released the claim, wiped this machine's copy of the mail and stopped the timer only
 * `if (mailboxId === world.mailboxId)`; on any other row it tombstoned and deleted the credential
 * and nothing else — so the confirmation's five consequences, one of which is the wipe, would
 * have promised an act the request did not perform.
 *
 * The route keys on the ROSTER now. Every live row has a runtime, and the DELETE wipes whichever
 * row it names — so the consequences are true of every row and the control belongs on every row.
 * The engine still reports one `mailboxId`, and what it MEANS has narrowed to "the seed": the
 * address this install was configured with, or the oldest live row when that one is gone. Gating
 * a per-mailbox verb on it would now hide the control on every mailbox but one, arbitrarily.
 *
 * {@link onShellStatus} is what the LAST removal needs. Removing the final mailbox leaves an
 * install configured for a mailbox it no longer has, so the pane runs the shell's own sign-out
 * after the route — and the gate has to hear about the new engine state or it would keep rendering
 * the app over an install with no door. ABSENT means this pane cannot tell the shell anything, so
 * it does not try: the removal still happens and the door configuration survives it, which is the
 * released behaviour and the honest degradation.
 *
 * ── WHICH "LAST" — AND THE ANSWER IS THE ROSTER'S, NOT THE ENGINE'S ───────────────────────────
 *
 * The single-mailbox shape of this asked whether the row being removed was the one the engine
 * served. With several, that would sign the whole install out on a removal that leaves mailboxes
 * running. It is `isLastLive` — the last row this install still holds, tombstones excluded and
 * legacy stand-downs counted — and the confirmation states the extra consequence only when it is
 * true.
 */
export function DesktopMailboxes(
  { door, onShellStatus }: {
    door?: string | null;
    onShellStatus?: (next: EngineStatus) => void;
  },
) {
  const t = useTranslations("mailboxes");
  /* The SAME binding the sync line reads, and `refresh` is what its own comment offers this pane:
     "Re-read the mailbox facts now. The Settings pane calls it after a connect or a resync." */
  const { mailboxes: facts, mirrored, state: mailState, freshness, refresh } = useMailState();
  /* What can go wrong here: the engine refuses a resync (offline, most often), or the operating
     system refuses to open a browser. One line, rendered where the press happened. */
  const [problem, setProblem] = useState<string | null>(null);
  /** Mailboxes whose resync this pane has queued, so the row can say so until it lands. */
  const [queued, setQueued] = useState<ReadonlySet<string>>(() => new Set());
  /** Mailboxes whose quiet-notice dismissal is in flight, so the button debounces (mail 0078). */
  const [dismissing, setDismissing] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * The answer to "Organize from this machine", per mailbox — the outcome key the pane quotes
   * back. Kept as the OUTCOME rather than a rendered sentence so the copy stays in the catalogue,
   * and per mailbox rather than in the pane's one `problem` line because this one is not a
   * failure: the sentence it needs is a durable instruction ("quit and reopen ohmail"), and a
   * line that moves when some other row fails would take it away mid-read.
   */
  /**
   * WHAT WAS ASKED FOR, AND WHETHER IT COULD HAVE WORKED — the second half is why this is a record
   * rather than a bare outcome.
   *
   * The entry exists to stop a one-shot being pressed twice. A request made while the mailbox was
   * BLOCKED is not a one-shot at all: it achieves nothing, the running loop clears the stamp, and
   * the answer it produced tells somebody to stop the other organizer and ask again. So a blocked
   * entry must never consume the button — not while the holder is still there, and above all not
   * at the moment it stops, which is exactly when the retry becomes the thing that works.
   */
  const [reclaimed, setReclaimed] = useState<ReadonlyMap<string, { outcome: TakeoverOutcome; blocked: boolean }>>(
    () => new Map(),
  );
  /** Mailboxes whose takeover request is in flight, so the button debounces. */
  const [reclaiming, setReclaiming] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * WHICH MAILBOX'S CLAIM IS ASKING WHETHER YOU MEANT IT, or `null` when none is.
   *
   * An id rather than the old `"rest" | "confirm"` pair, and the widening is forced by the pane
   * holding more than one mailbox: two readers on one install would have shared a single confirm
   * flag, so pressing "Organize here instead" on the second would have opened the ceremony under
   * the first as well — one press, two panels, and a confirm button whose subject is whichever
   * one you scroll to. The same shape {@link removing} already uses, for the same reason.
   */
  const [claimFor, setClaimFor] = useState<string | null>(null);
  /**
   * WHICH MAILBOX REMOVE IS ASKING ABOUT, or `null` when nothing is asking.
   *
   * The mailbox itself rather than an id, because the confirmation names the ADDRESS and a row
   * that vanishes from `facts` mid-question (a poll landing between the press and the answer)
   * must not leave the panel titled "Remove ?".
   */
  const [removing, setRemoving] = useState<MailboxFacts | null>(null);
  /** True while the DELETE is in flight, so the destructive button cannot be pressed twice. */
  const [removeBusy, setRemoveBusy] = useState(false);
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

  /**
   * ASK FOR THIS MACHINE — the exit from a stand-down, and until it existed there was none.
   *
   * A desktop install that has stood down to another organizer had no way back at all. This pane
   * rendered no control on a `disabled` row; the remedy this file used to name — "reconnect the
   * address" — goes through the door chooser and is refused by the engine's own invariant that a
   * disabled mailbox holds no credential ("This mailbox is disconnected. Reconnect it before
   * setting new credentials."), which is the thing the person just did; and the authorized
   * takeover existed on the Cloud webapp only. Measured on a released build against a claim whose
   * last heartbeat was 25 minutes old: the install stood down with `verdict=available` and the
   * only remaining cure was deleting a message from an IMAP folder by hand.
   *
   * `available` is correct and is not the defect: BECOMING an organizer always requires an
   * explicit human action, which is exactly why a crashed machine's mailbox is not seized. The
   * defect was that the product offered no such action on this door. This is it.
   *
   * IT AUTHORIZES, IT DOES NOT SEIZE — the engine reads the lease first on the next launch, and a
   * holder that is still renewing keeps the mailbox. So this button cannot make two organizers;
   * the worst it can do is ask and be told no, which the row then says.
   *
   * LOCAL DOOR ONLY. On the hosted door the mailbox belongs to an account, the takeover is the
   * account's ceremony, and this install is looking at a mirror it does not own — the route
   * simply is not served there. The pane's `cloud` test is the same one the header uses for every
   * other asymmetry between the two doors.
   */
  const reclaim = (id: string, blockedAtPress: boolean): void => {
    setProblem(null);
    setReclaiming((q) => new Set(q).add(id));
    void (async () => {
      try {
        const res = await bridgeFetch("/local/organizer/takeover", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ mailboxId: id }),
        });
        if (!res.ok) throw new Error(await reasonOf(res));
        const body = (await res.json()) as { outcome?: unknown };
        setReclaimed((m) =>
          new Map(m).set(id, { outcome: takeoverOutcome(body.outcome), blocked: blockedAtPress }));
        // The row's own state moved (`disabled` → `connected` with the stamp), so the pane must
        // re-read rather than keep rendering the stand-down it was showing.
        refresh();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setReclaiming((q) => {
          const next = new Set(q);
          next.delete(id);
          return next;
        });
      }
    })();
  };

  /**
   * REMOVE THIS MAILBOX FROM THIS COMPUTER — and until now this door had no way to do it.
   *
   * The route has existed since the hotfix that made removal mean removal (release the organizer
   * claim, wipe this machine's mirror, stop the timer and close the login), and NO CLIENT CALLED
   * IT: the pane offered "Reading only" and "Sync now" and nothing else, while its own footnote
   * said "you can remove it and nothing is lost from the mailbox itself" — a promise with no
   * control behind it, and a released changelog describing a remove-then-re-add walk that a
   * person standing at this door could not perform.
   *
   * `DELETE /local/mailboxes/:id`, NOT the shared `DELETE /mailboxes/:id`. The shared one is
   * `stepUp: true`, and on this door a step-up is a permanent refusal rather than a guard: the
   * launch session's second-factor stamp is written once at boot ("there is no second factor on
   * a local install"), so the shared route answers 403 from five minutes after launch for the
   * life of the process. The local route's authority is the per-launch bearer, added shell-side,
   * which is the same protection the other three routes in that family carry.
   *
   * LOCAL DOOR ONLY, and structurally so: the hosted door's removal is the ACCOUNT's ceremony —
   * a password and a fresh factor against a real origin — which is exactly what this window
   * cannot offer and why the pane sends a hosted install to the browser instead.
   *
   * `refresh()` and not an optimistic splice: the row's state moved (it is a tombstone now), and
   * the shared poller is the one thing entitled to say what this install is connected to.
   */
  /**
   * IS THIS THE ONLY MAILBOX THIS COMPUTER STILL HOLDS — the condition the sign-out below hangs
   * on, and the one the confirmation states as a sixth consequence.
   *
   * LIVE rows: `status === 'disabled'` with no reason is a tombstone, the service refuses it, and
   * counting tombstones would make an install that has removed and re-added a mailbox permanently
   * believe it has several. `foldByAddress` is not used here on purpose — it answers a rendering
   * question (which row of a group to SHOW), and this one is about what the store still holds.
   *
   * ── AND A LEGACY STAND-DOWN COUNTS, WHICH THE FIRST VERSION OF THIS GOT WRONG ─────────────
   *
   * It filtered on `status !== "disabled"` alone, and that excludes the pre-role engine's
   * stand-down shape — `disabled` WITH a `disabled_reason` — which `claimable` deliberately
   * INCLUDES: such a row is rendered with a state line and a working "Organize here instead".
   * So on an upgraded install holding one live mailbox beside one legacy stood-down one, removing
   * the live mailbox made this true: the confirmation announced "this is the only mailbox on this
   * computer" with the other one visibly listed a row away, and the removal then signed the door
   * out — deleting the only route back to the mailbox that was still there.
   *
   * The test is therefore "is this row a TOMBSTONE", not "is it disabled".
   */
  const isTombstone = (r: MailboxFacts): boolean =>
    r.status === "disabled" && r.legacyStandDown !== true;
  const isLastLive = (m: MailboxFacts): boolean => {
    const live = (facts ?? []).filter((r) => !isTombstone(r));
    return live.length === 1 && live[0]!.id === m.id;
  };

  const remove = (m: MailboxFacts): void => {
    setProblem(null);
    setRemoveBusy(true);
    const last = isLastLive(m);
    void (async () => {
      try {
        const res = await bridgeFetch(`/local/mailboxes/${encodeURIComponent(m.id)}`, {
          method: "DELETE",
        });
        if (!res.ok) throw new Error(await reasonOf(res));
        /* ── THE SINGLE-MAILBOX SIGN-OUT STOOD HERE, AND ITS OWN NOTE ASKED FOR THIS ──────────
         *
         * It read: *"the multi-mailbox version of this is a roster-aware decision … and it
         * supersedes this predicate wholesale. Kept deliberately single-mailbox-shaped so that
         * replacement is a deletion rather than an untangling."* This is that deletion, and the
         * measurement it was built on stands: on the released 0.13.7 a removal cleared the row,
         * the credential, the claim and the mirror and NOT `config.json`, so the next launch
         * minted a fresh row for the same address and the window opened on a mailbox the person
         * had removed. `engine_logout` is still the command that ends it.
         *
         * What changed is the PREDICATE. It asked `door !== "cloud" && servedMailboxId === m.id &&
         * every other row is disabled` — correct while the engine opened one mailbox, and wrong
         * the moment it opens several: `servedMailboxId` has narrowed to meaning "the seed", so
         * that test would sign the whole install out on a removal that leaves mailboxes running,
         * and skip the sign-out entirely once the seed itself has gone. `isLastLive` above is the
         * roster's own answer — tombstones excluded, legacy stand-downs counted — and the
         * sign-out it gates runs below, after the route rather than inside it. */
        setRemoving(null);
        /**
         * ── AND WHEN IT WAS THE LAST ONE, THE INSTALL HAS TO STOP BEING CONFIGURED FOR IT ────
         *
         * The route does three things — release the claim, wipe this machine's copy, stop the
         * runtime — and all three are about the ENGINE's store. None of them touches the SHELL's
         * settings file, and the settings file is what the engine composes its dial from at every
         * launch. So removing the only mailbox left an install whose store held nothing and whose
         * door still named an address: the next launch re-created the row as a consent-less reader
         * with no credential, and a person who had removed their mailbox found it listed again.
         * Measured, and filed as `REMOVE-DOES-NOT-SURVIVE-A-RELAUNCH`.
         *
         * The shell already has the command that clears a door — its sign-out
         * (`DELETE /local/stored-login`, then the settings file is removed) — and it is the same
         * one Settings → Desktop presses. Running it HERE is what makes the removal survive: the
         * engine reports `not_configured`, the gate renders the door chooser, and the next launch
         * has nothing to dial.
         *
         * ONLY WHEN IT WAS THE LAST, and that condition is the whole difference between the two
         * removals. With mailboxes left the install is still correctly configured — for the seed,
         * or, when the seed is the one going, for whichever live row the engine settles on — and
         * signing out would take away mailboxes nobody asked to remove. The route alone is the
         * answer there, which is why nothing below runs.
         *
         * AFTER the route, never before: the sign-out stops the engine, and an engine that is not
         * running cannot release a claim or wipe a mirror. The order is release → wipe → stop →
         * forget the door.
         */
        if (last) {
          try {
            onShellStatus?.(await engineLogout());
          } catch (logoutErr) {
            /* THE MAILBOX IS GONE EITHER WAY. The removal committed; what failed is the tidying
               that keeps it gone across a relaunch. Reported rather than swallowed, because the
               consequence is one a person can act on — the pane says so, and quitting and
               reopening is where the stale door would otherwise reappear. */
            setProblem(logoutErr instanceof Error ? logoutErr.message : String(logoutErr));
          }
        }
        refresh();
      } catch (err) {
        /* THE PANEL STAYS OPEN ON A FAILURE, on the browser pane's rule: dropping somebody back
           to a list that still shows the mailbox says nothing about whether the removal
           happened. The sentence goes to the pane's one problem line, above the rows. */
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setRemoveBusy(false);
      }
    })();
  };

  /**
   * DISMISS the forwarding-detection notice for one mailbox (mail 0078) — the same route the
   * browser's pane calls, over the pipe, served on BOTH doors like the resync above. `refresh`
   * re-reads the facts so the notice leaves the pane on the answer rather than on the poller's
   * slower clock; a failure leaves it standing with the pane's one problem line saying why.
   */
  const dismissQuiet = (id: string): void => {
    setProblem(null);
    setDismissing((q) => new Set(q).add(id));
    void (async () => {
      try {
        const res = await bridgeFetch(`/mailboxes/${encodeURIComponent(id)}/inbound-quiet/dismiss`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(await reasonOf(res));
        refresh();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setDismissing((q) => {
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
   * WHICH ROWS MAY BE CLAIMED, and this predicate is the fix for a control that was offered on
   * exactly the set the handler refuses.
   *
   * The button used to be gated on `status === "disabled" && disabledReason` — a stand-down as the
   * OLD schema encoded it. The role is its own column now, and the backfill moved every stood-down
   * row to `status='connected', organizer_role='reader'`, so that arm names a state nothing writes
   * any more AND the one `organizeHere` declines: a `disabled` row is a tombstone, and offering a
   * claim on one would resurrect a mailbox somebody deliberately took off this machine.
   *
   * A reader is CONNECTED AND SYNCING. That is the whole point of the split, and it is why the
   * test is on the role rather than on the status.
   *
   * NOT COMPLETE, and the missing half is named rather than guessed: the server's predicate is
   * `status <> 'disabled' AND (organizer_role = 'reader' OR organize_consented_at IS NULL)`, and
   * `organizeConsentedAt` is not on the DTO. `organizedBy` cannot stand in for it — its own
   * contract says `null` means "this install organizes it" OR "nobody ever has", which are the two
   * cases that would have to be told apart. So the reader half is served here and the
   * consent-less half waits for the field.
   */
  const claimable = (m: MailboxFacts): boolean =>
    !cloud
    && ((m.status !== "disabled" && m.organizerRole === "reader")
      /* THE LEGACY ARM, and it is not a contradiction of the paragraph above. That paragraph is
         about an engine that HAS the role column, where a `disabled` row is a tombstone and
         `organizeHere` declines it. An engine that predates the column reports a stand-down the
         old way AND runs the old handler, which accepted exactly that row — the two travel
         together, because they are the same process. So the discriminator is the engine's own
         vocabulary: no role at all, plus `disabled` with a reason. On any current engine the role
         is always present and this arm is unreachable. */
      || m.legacyStandDown === true);

  /* ── THE BANNER IS PER ROW, AND "THE FIRST CLAIMABLE ROW" IS RETIRED ────────────────────
   *
   * It used to read: *"A standalone install opens one mailbox, so a list of readers would be a
   * list of one — and a banner per row would repeat the same sentence down the pane."* The first
   * half stopped being true (a standalone install holds as many mailboxes as somebody adds), and
   * the second was the consequence of it rather than a reason of its own.
   *
   * What the old rule COST once there were two readers: the banner named one holder, the claim
   * button acted on one mailbox, and both were the first row in list order — so the second
   * reader was a mailbox with a visible "Reading only" state, no holder, and no way to take it
   * back. The sentence is not repeated down the pane in practice either; two readers usually
   * have two different holders, and where they have the same one, saying it twice is what makes
   * the two rows separately actionable.
   */

  /**
   * WHETHER THE LEASE CAN GRANT WHAT THIS PRESS ASKS FOR — and it depends on WHO holds it.
   *
   * `decideLease` (`organizer-lease.ts:556-585`) ranks kinds cloud > local > unknown, and this
   * install is `local`:
   *
   *   · a live LOCAL peer — rule 6 — is DISPLACED by an authorized request, unless it renews
   *     during the gate. The direct promise is true here;
   *   · a live CLOUD holder — rule 5 — wins "even with authorization". §4 gives a local install no
   *     path over a live Cloud on purpose: the honest action is to stop it organizing there;
   *   · a live UNKNOWN kind — rule 2 — stands us down and no authorization overrides it;
   *   · anything stopped or gone quiet — rules 7-8 — leaves the request free to win.
   *
   * So one universal sentence is wrong in one direction or the other, which is how the copy here
   * was wrong twice: first promising the takeover flat, then promising a running holder always
   * keeps it. This is the branch, and it is on the row's own two columns.
   */
  const claimWouldBeRefused = (m: MailboxFacts): boolean =>
    /* `null` IS "THIS INSTALL HAS NOT LOOKED", NOT "STOPPED" — the DTO says so, and the state stays
       unset when the lease look has not run or failed. Treating it as beatable promised a takeover
       against a claim that may be perfectly fresh, which rules 5 and 2 refuse whatever was
       authorized. Unknown is grouped with held for the kinds we cannot beat: the honest position on
       a state we have not observed is the cautious one, and the cost of being wrong that way is a
       sentence pointing at an action that also works. */
    m.organizerState !== "stopped"
    && (m.organizedBy?.kind === "cloud" || m.organizedBy?.kind === "unknown");

  /** The holder's own name for a sentence, or the kind when it did not send one. */
  const holderOf = (m: MailboxFacts): string =>
    m.organizedBy?.name
    ?? (m.organizedBy?.kind === "cloud" ? "ohmail Cloud" : t("readerHolderUnknown"));

  /**
   * WHY SENDING IS NOT SET UP for one mailbox, in the product's own words — or `null`.
   *
   * ── AN OUTGOING SERVER IS NOT A REASON TO STOP RECEIVING ──────────────────────────────────
   *
   * The local door stores the incoming credential when only the SUBMISSION dial is refused, and
   * records the probe's reason. So a mailbox can be connected, organizing and completely healthy
   * on the receiving side while sending is not available — a state nothing on this row would
   * otherwise show, because every other line is about receiving.
   *
   * ONE FIELD, ONE SENTENCE. The send path refuses with the same reason and the setup flow's
   * summary states the same line, so the three surfaces cannot drift. The reason is rendered from
   * the PROBE TAXONOMY the connect form already uses, and an unrecognised code falls to the
   * `unknown` wording rather than being interpolated raw — a server's own words are not this
   * pane's to print.
   */
  const sendingProblem = (m: MailboxFacts): string | null => {
    const code = m.sendingUnsettledReason;
    if (typeof code !== "string" || code === "") return null;
    const known = ["auth", "connect", "tls", "timeout"].includes(code) ? code : "unknown";
    return t("sendingUnsettled", {
      reason: t(`sendingUnsettledReason_${known}` as "sendingUnsettledReason_unknown"),
    });
  };

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
    if (m.organizerRole === "reader") return t("stateReading");
    if (m.syncBlockedSince) return t("desktopStatePaused");
    if (m.lastSyncAt === null) return t("desktopStateFirstOpen");
    if (m.initialImportCompletedAt === null) return t("desktopStateCatchingUp");
    return t("desktopStateUpToDate");
  };

  /**
   * THE "ORGANIZED SOMEWHERE ELSE" BANNER AND ITS CEREMONY, FOR ONE ROW.
   *
   * A closure inside the component rather than a module function, on the rule the rest of this
   * pane follows: it reads the pane's translator, its `reclaimed`/`reclaiming` records and its
   * confirm state, and there is nothing to share it with.
   *
   * It renders UNDER the row it is about, which is the change multi-mailbox forced. A reader is
   * connected and syncing, so nothing else on the row says this: the mailbox looks healthy
   * because it IS healthy, and what is missing is that this machine moves nothing and screens
   * nothing. `SettingsBanner` is the composite for a standing condition with its one verb: the
   * fact, since when and from where, and the action.
   *
   * `organizerState === "stopped"` is the arm that turns the fact into a problem — the holder
   * stopped renewing and new mail is waiting in the inbox with nobody to file it — so it gets
   * its own sentence rather than a variant of the calm one.
   */
  const claimBlock = (m: MailboxFacts): ReactNode => (
    <>
      {claimable(m) ? (
        <SettingsBanner
          label={
            /* A legacy row carries no holder columns at all — the pre-role engine recorded only
               `disabled_reason` — so there is no name to put in `readerLabel`. */
            m.legacyStandDown === true
              ? t("readerLabelLegacy")
              : t("readerLabel", { name: holderOf(m) })
          }
          description={
            /* ── A LEGACY STAND-DOWN IS FROZEN, AND SAYING IT READS WOULD CONTRADICT ITS OWN ROW ──
               The modern reader is CONNECTED AND SYNCING, which is what every sentence below is
               about. A pre-role engine's stand-down did the opposite: it closed the IMAP handle and
               stopped the poll timer (`engine.ts:1991-1997`, the path that became the
               tombstone-only branch), so that row is not reading anything — and its own state
               column says "Handed over to another install" three lines to the right. It also needs
               the restart, which the sentence says, because that engine spends the stamp at its
               next process assembly rather than on a tick. */
            m.legacyStandDown === true
              ? t("readerLegacyStandDown")
              : m.organizerState === "stopped"
              /* NO AGE, because there is no timestamp that would make one true. It said "last
                 checked in {when}" and was handed `organizedBy.since` — which is when that install
                 BECAME the organizer, and the heartbeat is deliberately not persisted
                 (`index.ts:1349-1353` says why). A holder that organized for eight months and
                 stopped this morning was reported absent for eight months. The fact worth stating
                 is that it stopped, and that is all this sentence claims now. */
              ? t("readerStopped", { name: holderOf(m) })
              /* EVERY KIND ON ITS OWN BRANCH. `unknown` is a legal kind and a reader may have no
                 holder recorded at all, and both used to fall through to the CLOUD sentence — so a
                 row whose wire says nothing about Cloud announced "ohmail Cloud". The third
                 sentence names no holder, because none is known. */
              : m.organizedBy?.kind === "local"
                ? t("readerSinceLocal", {
                    name: holderOf(m),
                    since: day(m.organizedBy?.since ?? null),
                  })
                : m.organizedBy?.kind === "cloud"
                  ? t("readerSinceCloud", {
                      name: holderOf(m),
                      since: day(m.organizedBy?.since ?? null),
                    })
                  : t("readerSinceUnknown", { since: day(m.organizedBy?.since ?? null) })
          }
          /* THE RETRY THE ANSWER TELLS SOMEBODY TO USE HAS TO BE THERE WHEN THEY COME BACK.
              `reclaimed` records that a request was made and is never cleared, which is right for
              a request that can succeed: the row's own role is what ends it. A BLOCKED request can
              never succeed — the holder keeps the mailbox for as long as it is checking in — so
              its entry would hide the button for the life of the pane, and the sentence it just
              printed says "stop it organizing there, then ask again". That is the dead end this
              screen exists to close, arriving through the one branch whose whole purpose is to
              tell somebody to come back.

              The order the answer gives IS the reliable one, which is why it is worth keeping
              reachable: the stamp is cleared by the STAND-DOWN write (`engine.ts:2038`), and once
              the other holder has gone quiet the lease returns available rather than standing this
              install down — so nothing clears it and the relaunch spends it.

              THE BUTTON IS SPENT IN ONE QUADRANT OF FOUR, and each of the other three was found
              by walking a path somebody actually takes. Write the request's blocked-ness against
              the row's current blocked-ness:

                · beatable then, beatable now  → SPENT. The request is genuinely in flight and a
                  second press would be a second one-shot;
                · blocked then, blocked now    → offered. A blocked request achieves nothing, so it
                  never consumed anything, and the answer beside it says to come back;
                · blocked then, beatable now   → offered. This is the transition the answer sends
                  somebody to make, and gating on the row alone removed the button at exactly the
                  moment the retry would have worked;
                · beatable then, blocked now   → offered. The holder resumed before this install
                  was promoted, the lease refused the authorization and the loop cleared it, so the
                  spent marker describes a request that no longer exists.

              Only the first can still succeed on its own; every other one needs the press back. */
          {...(claimFor !== m.id
            && (!reclaimed.has(m.id)
              || reclaimed.get(m.id)!.blocked
              || claimWouldBeRefused(m))
            ? {
                action: (
                  <Button variant="primary" onClick={() => setClaimFor(m.id)}>
                    {t("organizeHere")}
                  </Button>
                ),
              }
            : {})}
        />
      ) : null}
      {/* THE CEREMONY, AND WHAT IT COSTS THE OTHER SIDE, BEFORE IT IS TAKEN. The other install is
          not killed: it becomes a reader on its next pass and keeps its copy of the mail. Saying
          so here is the difference between a button somebody presses and one they hesitate over
          for the wrong reason. */}
      {claimFor === m.id ? (
        <SettingsActions>
          <span className="set-note-inline">
            {/* THE CEREMONY PROMISES WHAT THIS ENGINE WILL DO, and the two engines do different
                things. The modern sentence says "on its next pass" — and for a while this comment
                said that while the copy still said "quit and reopen", which is the shape a claim
                takes when the code is corrected and the sentence is not. A pre-role engine stopped
                its poll timer at the stand-down and spends the stamp at its next process assembly,
                so on that one the confirmation would contradict the acknowledgement it produces
                one press later. It also names no holder, because a legacy row carries none. */}
            {m.legacyStandDown === true
              ? t("organizeHereWhatLegacy")
              : claimWouldBeRefused(m)
                ? t("organizeHereWhatBlocked", { name: holderOf(m) })
                : t("organizeHereWhat", { name: holderOf(m) })}
          </span>
          {/* THE PRESS IS KEPT EVEN WHERE THE LEASE WILL REFUSE TODAY, and withholding it was a
              worse answer than the one it replaced.

              Hiding it rests on `organizerState` becoming something other than `held` once the
              other holder stops — and that is the assumption that must not be made here. A person
              who follows the sentence above, stops the organizer there, and comes back to a pane
              whose only control has vanished has exactly the dead end this whole surface exists to
              close: no way back at all. Recording the request costs nothing and is not lost — the
              stamp waits for the relaunch that reads the lease — so keeping the button is safe
              whichever way the state behaves, and hiding it is safe only one way.

              What changes for this holder is the WORDS: the confirmation says it cannot take the
              mailbox yet and names the order to do it in, and the answer says the holder keeps it
              while it is still checking in, whatever was asked for here. Neither promises the
              renewal race, which is the other branch's condition and not this one's. */}
          <Button
            variant="primary"
            disabled={reclaiming.has(m.id)}
            onClick={() => {
              setClaimFor(null);
              reclaim(m.id, claimWouldBeRefused(m));
            }}
          >
            {t("organizeHereConfirm")}
          </Button>
          <Button variant="ghost" onClick={() => setClaimFor(null)}>{t("cancel")}</Button>
        </SettingsActions>
      ) : null}
    </>
  );

  return (
    <SettingsSection>
      <h2 className="acct-h">{heading}</h2>
      {facts.length === 0 ? (
        <p className="set-note-inline">{cloud ? t("desktopNoneCloud") : t("desktopNoneLocal")}</p>
      ) : null}
      {/* ── ADD MAILBOX — ABOVE THE LIST, because it is about the list rather than about a row ──
          A standalone install holds as many mailboxes as somebody adds. The route that does it
          (`POST /local/mailboxes`) writes the row, proves its password against its own server and
          starts a runtime for it; this is the only control that reaches it, and without one the
          capability would be a claim with nothing behind it — the shape this pane already had
          once, when the removal route existed and no button called it.

          IT OPENS THE GUIDED FLOW rather than a form of its own. The flow already asks every
          question adding a mailbox needs answered — the server and the password with a real test
          verdict, who organizes it if somebody does, consent, how far back to screen — and a
          second form here would be a second write path into `mailbox_credentials` and a second
          place for that copy to drift. `#/first-run/add` is the intent: the install has been
          through setup, so the derivation says "nothing to do" and the ROUTE is what says
          otherwise. The walk it opens is 1, 2, 3, 4, 7, 8, 9 — no welcome and no AI question,
          because those are the install's and were answered when it was set up.

          THE STANDALONE DOOR ALONE. On the hosted door mailboxes are the ACCOUNT's and this
          window sends people to the browser for them, which the rows below already say. */}
      {firstRunDoorFor(statusOf(door)) === "local" ? (
        <SettingsRow
          label={t("desktopAdd")}
          description={t("desktopAddWhy")}
          control={
            <Button variant="primary" onClick={() => goFirstRun({ add: true })}>
              {t("desktopAddAction")}
            </Button>
          }
        />
      ) : null}

      {/* Above the rows rather than inside one: both things that can fail here — a refused resync
          and a refused browser — are about the pane, and a sentence that moves around as the
          failure changes is harder to find than one that does not. */}
      {problem ? <p className="join-error">{problem}</p> : null}

      {/* ── ONE ROW PER ADDRESS, folded with the SAME key the rail and the browser pane use ──
          A stood-down mailbox is taken back with the row's own "Organize from this machine"
          (`reclaim` above); connecting the address again mints a SECOND row, which is what the
          partial unique index exists to permit and what leaves the dead row behind for ever.
          This comment used to name that reconnect as the remedy, and it was wrong in a way that
          cost a QA lane an afternoon: the door chooser's connect form refuses a disabled mailbox
          with "Reconnect it before setting new credentials", so the instruction was circular and
          the install had no exit at all. Rendering `facts` raw put "Handed over to another
          install" beside "Up to date" for one address — and once the rail began folding, the rail
          and this pane disagreed on the same screen, which is the defect the fold was for.

          Live row wins; a group with no live row keeps its own row and its reason, because an
          account whose only mailbox was stood down must still see it. `addressKey` and not a local
          copy: the browser pane and the rail fold with that function, and a third rule here would
          be the same divergence wearing different clothes. */}
      {foldByAddress(facts).map(({ shown, superseded }) => (
        <Fragment key={shown.id}>
          <SettingsRow
            label={shown.address}
            description={
              /* ── THE ROLE, BESIDE WHEN IT LAST LOOKED ──────────────────────────────────────
                 With one mailbox the role was implicit: this install organized it, and the only
                 thing worth saying was the exception. With several it is the fact that tells the
                 rows apart — which of these mailboxes this computer files, and which it only
                 reads — and it belongs on every row rather than on the ones where it is bad news.

                 ONLY THE ORGANIZING SENTENCE IS HERE. A reader's role, its holder and its since
                 are one statement and they are made together in the banner under the row
                 (`claimBlock`); printing "Reading only" here as well would say it twice, once
                 without the half that matters. The hosted door says neither — its rows are a
                 mirror of an account whose organizing is the service's, not this machine's. */
              /* ── CONSENT IS THE CONDITION, NOT THE ROLE ────────────────────────────────────
                 `organizerRole` rests `'organizer'` — the column's default, and the mapper coerces
                 anything that is not literally `"reader"` to it — so the role alone says
                 "Organized on this computer" about a mailbox that has been connected and never
                 agreed to, while nothing is filed and `ohmail/*` does not exist. Reachable from
                 this pane's own Add mailbox: connect, then cancel at the consent screen.
                 `organizeConsentedAt` is the truth-condition and it is already on the facts. */
              !cloud && shown.status !== "disabled" && shown.organizerRole !== "reader"
              && Boolean(shown.organizeConsentedAt) ? (
                <>
                  {t("desktopLastChecked", { when: when(shown.lastSyncAt) })}
                  {" · "}
                  {t("desktopRoleOrganizer")}
                </>
              ) : t("desktopLastChecked", { when: when(shown.lastSyncAt) })
            }
            value={stateOf(shown)}
            control={
              /* ── THE CLAIM IS NOT A ROW CONTROL ANY MORE, AND THE ROW IT WAS ON WAS THE WRONG
                 ONE ────────────────────────────────────────────────────────────────────────────
                 It was offered here on `status === "disabled" && disabledReason` — a stand-down as
                 the OLD schema encoded it. Two things ended that. The role is its own column now
                 and the backfill moved every stood-down row to `connected` + `organizer_role =
                 'reader'`, so this arm named a state nothing writes; and `organizeHere` REFUSES a
                 `disabled` row, because a `disabled` row is a tombstone and resurrecting a mailbox
                 somebody took off this machine is not what the button is for. The control was
                 therefore offered on exactly the set the handler declines.

                 It lives in the banner UNDER THIS ROW now, where the fact it acts on is stated.
                 See `claimable` and `claimBlock`. What stays here is Sync now, withheld on a
                 disconnected mailbox for its own reason: nothing is opening it, so a pass over it
                 cannot be asked for. */
              shown.status === "disabled" ? undefined : (
                <>
                  <Button
                    className="mbx-btn"
                    onClick={() => resync(shown.id)}
                    disabled={queued.has(shown.id)}
                  >
                    {queued.has(shown.id) ? t("syncQueued") : t("syncNow")}
                  </Button>
                  {/* ── RUN SETUP AGAIN, ON THE ROW IT IS ABOUT ──────────────────────────────
                      It used to be one row at the foot of the pane, which was the right shape
                      while an install had one mailbox and wrong the moment it had two: the flow
                      writes a consent stamp and a screening window for a NAMED mailbox, and a
                      control at the foot of a list of three names none of them. `?mailbox=<id>`
                      is how the route says which, and `AppShell` resolves the run's subject from
                      it rather than from the first row.

                      `#/first-run/again`, never the bare hash: a finished install derives to
                      "nothing to do", correctly, so the RE-RUN INTENT has to ride the route or
                      the stage would open, find the completion stamp and close again on the same
                      render.

                      THE STANDALONE DOOR ALONE, because that is the only door this window gives
                      the flow a host on (`local-first-run.ts`). On the hosted door `#/first-run`
                      renders nothing at all, so the button would navigate somewhere blank. */}
                  {firstRunDoorFor(statusOf(door)) === "local" ? (
                    <Button
                      className="mbx-btn"
                      onClick={() => goFirstRun({ rerun: true, mailboxId: shown.id })}
                    >
                      {t("setupAgainAction")}
                    </Button>
                  ) : null}
                  {/* ── REMOVE — the door out, and this door had none ─────────────────────
                      Ghost beside the resync, which is the row cluster's own ranking: Sync now
                      is the ordinary verb and this is the one somebody should have to mean.

                      NO KEYCAP. The registry is checked rather than guessed: the two other verbs
                      in this pane — Sync now and Organize here — carry none, so a keycap on the
                      destructive one would be the only shortcut on the surface and it would be
                      on the press that deletes a stored password.

                      It opens a CONFIRMATION, never the removal. On the hosted door the
                      destructive press is two screens away behind the account's second factor;
                      here there is no second factor to ask for, so the statement of consequences
                      IS the ceremony and it has to carry its weight. */}
                  {!cloud ? (
                    <Button
                      className="mbx-btn"
                      variant="ghost"
                      onClick={() => { setProblem(null); setRemoving(shown); }}
                    >
                      {t("remove")}
                    </Button>
                  ) : null}
                </>
              )
            }
          />
          {/* ── SENDING, WHEN IT IS NOT SET UP ───────────────────────────────────────────────
              Its own line rather than folded into the state value, because the state value is
              about RECEIVING and this mailbox is receiving perfectly. `set-note-inline` is the
              pane's quiet standing-fact line — not `join-error`, which is for something that just
              failed here; this is a condition the mailbox has been carrying since it connected. */}
          {sendingProblem(shown)
            ? <p className="set-note-inline">{sendingProblem(shown)}</p>
            : null}
          {/* ── WHO ORGANIZES THIS ONE, UNDER THE ROW IT IS ABOUT ────────────────────────────
              Per row, because the pane holds several and each can be held by somebody different.
              It renders nothing on a row this machine organizes — see `claimBlock`. */}
          {claimBlock(shown)}
          {/* ══ THE REMOVAL CONFIRMATION — FIVE CONSEQUENCES, AND THE FIFTH IS THIS DOOR'S ══
              The hosted pane's panel, verbatim in shape and in four of its five statements,
              because they are true on both doors: organizing stops, THE MAIL IS UNTOUCHED (the
              removal opens no IMAP connection to delete anything), the stored password goes, and
              scheduled sends are closed rather than sent.

              The fifth differs and had to. On the hosted door the copy already synced STAYS —
              erasure there is account-scoped and there is no per-mailbox purge, so claiming the
              local copy goes would be false. On THIS door the local mirror is deleted, by this
              route, in the same request: that is the wipe the doubling fix added, and it is the
              honest sentence here. Saying "stays in your account" on a machine that has no
              account would be the same class of false statement pointing the other way.

              Under the row rather than over the pane, so a machine with two addresses cannot
              show a confirmation whose subject is ambiguous. `role="alertdialog"` and the SAFE
              ANSWER FIRST in the DOM, the browser pane's discipline. */}
          {removing?.id === shown.id ? (
            <div
              className="acct-confirm"
              role="alertdialog"
              aria-label={t("removeTitle", { address: shown.address })}
            >
              <h3 className="acct-sub">{t("removeTitle", { address: shown.address })}</h3>
              <ul className="acct-fine mbx-remove-list">
                {/* ── THE FIRST BULLET USED TO CLAIM WORK THIS INSTALL NEVER DID ─────────────
                    "ohmail stops organizing this mailbox." — measured on the released 0.13.7 on
                    an install that had never organized it, one pane away from the banner saying
                    so. The reader's bullet also has to answer the question the organizer's does
                    not raise: if it was not organizing, what actually changes at the mailbox?
                    Nothing, and the sentence says that rather than leaving it to be guessed.

                    `readerStandDown` on THIS ROW, not the roster-wide `screenerReadOnly` the
                    panes above use — this confirmation is about one mailbox, and it is the row
                    the pane already has in hand. Same predicate underneath. */}
                <li>{readerStandDown(shown) ? t("removeStopsReader") : t("removeStops")}</li>
                <li>{t("removeMailSafe")}</li>
                <li>{t("removeCredential")}</li>
                <li>{t("removeScheduled")}</li>
                <li>{t("removeCopyLocal")}</li>
                {/* ── AND THE SIXTH, ON THE LAST MAILBOX ONLY ────────────────────────────────
                    Removing the only mailbox leaves nothing for this install to open, so the
                    pane signs the door out afterwards and the app returns to the setup screen.
                    That is a bigger consequence than the five above and it is stated before the
                    press, not discovered after it. Withheld while other mailboxes remain, where
                    it would be false: the install stays configured and keeps organizing them. */}
                {isLastLive(shown) ? <li>{t("removeLastDoor")}</li> : null}
              </ul>
              <p className="acct-fine">{t("removeReconnect")}</p>
              <div className="acct-actions">
                <Button onClick={() => setRemoving(null)} disabled={removeBusy}>
                  {t("removeCancel")}
                </Button>
                {/* `primary danger` — the account section's convention for a destructive
                    confirm, so this and the browser's pane read as one product. */}
                <Button
                  variant="primary"
                  className="danger"
                  disabled={removeBusy}
                  onClick={() => remove(shown)}
                >
                  {removeBusy ? t("removeWorking") : t("removeConfirm")}
                </Button>
              </div>
            </div>
          ) : null}
          {/* WHAT THE ANSWER WAS, under the row it is about.
              `authorized` NO LONGER SAYS "QUIT AND REOPEN". That sentence was true when the engine
              only read the lease at launch; the gate spends the stamp on its next tick now, so the
              mailbox moves within a pass and telling somebody to restart the app is an instruction
              to do something that is not needed and does not help.

              ── AND IT IS NOT A SPINNER, WHICH IS TWO DEFECTS IN ONE ─────────────────────────
              It was `state="wait"`, and `reclaimed` is only ever added to. So after a takeover
              actually SUCCEEDED — the poll flips the role, the banner goes — the spinner stayed on
              screen for ever, still claiming the change was pending. And a spinner is the wrong
              shape even before that: the route only RECORDS the request. `runLeaseGate` reads the
              lease on the next tick and may clear the stamp without promoting anything
              (`engine.ts:1951-1955`), in which case nothing further will ever happen and there is
              nothing to spin about.

              So the press is reported as a COMPLETED action with a stated caveat, and the entry is
              dropped the moment the role confirms it worked. `off` rather than `ok`: this window
              has not been told the mailbox moved, and a tick would say it had. */}
          {reclaimed.has(shown.id) ? (
            reclaimed.get(shown.id)!.outcome === "authorized" ? (
              /* ── THE LEGACY ROW COULD NOT REACH THE ANSWER AT ALL ─────────────────────────
                 The gate below tests `organizerRole === "reader"`, and the mapper coerces a legacy
                 row's ABSENT role to `organizer` — so on precisely the rows the legacy arm exists
                 for, this rendered nothing: the button vanished and no acknowledgement replaced it,
                 with the takeover still unapplied.

                 And the sentence it needs is the one this lane retired. That was right for the
                 modern engine, which reads the lease on its next tick; a pre-role engine STOPPED
                 its poll loop at the stand-down and spends the stamp at its next process assembly,
                 so there a restart is not a superstition, it is the mechanism. The sentence is back
                 under a name that says when it applies, and it persists until the relaunch clears
                 the row — because the instruction is outstanding until then. */
              /* TWO MECHANISMS, AND THIS COMMENT USED TO CLAIM THERE WAS ONE. It read "the
                 relaunch is what spends the stamp on both engines ... Arming the live loop —
                 re-reading the column each cycle — would let the press be honoured on the next
                 pass instead; until it does, this sentence is what is true." **The live loop is
                 armed.** `mayOrganize` re-reads `takeover_authorized_at` at the top of every gate
                 (`apps/sidecar/src/engine.ts`, "THE STAMP IS RE-READ EVERY RUN"), and it had to
                 be: a polling reader otherwise DESTROYS the press, because the poll asks with
                 `takeover: "none"`, is refused by the very claim being taken over, and the refusal
                 arm clears the row. So a modern reader is spent on its next poll, and the copy
                 says so.

                 The LEGACY row is the one the relaunch is still the mechanism for, and the reason
                 is the roster rather than the gate: it is `disabled`, `loadEnabledMailboxes`
                 filters on `ne(status, 'disabled')`, so no gate ever runs for it and the stamp is
                 spent at the next process assembly.

                 What still differs is where losing leaves this install, and there are three
                 answers rather than one. A modern reader keeps reading — that is what a reader IS.
                 A legacy stand-down closed its handle and stopped its timer, so it goes on reading
                 nothing. And a blocked holder keeps the mailbox for as long as it is checking in,
                 with no renewal race to lose — so its sentence names the order that works instead
                 of a condition that does not apply to it, and it does NOT claim the request is
                 held: the same loop that cannot see the stamp clears it on its next stand-down
                 poll, so asking again after the other organizer stops is the reliable path. */
              shown.legacyStandDown === true ? (
                <SettingsVerdict state="off" headline={t("organizeHereQueuedLegacy")} />
              ) : claimWouldBeRefused(shown) ? (
                <SettingsVerdict
                  state="off"
                  headline={t("organizeHereQueuedBlocked", { name: holderOf(shown) })}
                />
              ) : shown.organizerRole === "reader" ? (
                <SettingsVerdict state="off" headline={t("organizeHereQueued")} />
              ) : null
            ) : (
              <SettingsNote>{t(`desktopOrganizeHere_${reclaimed.get(shown.id)!.outcome}`)}</SettingsNote>
            )
          ) : null}
          {superseded > 0 ? <SettingsNote>{t("superseded")}</SettingsNote> : null}
          {/* ── THE FORWARDING-DETECTION NOTICE (mail 0078), the browser pane's twin ─────────
              `showInboundQuiet` (shared shell, one rule for both surfaces) gates it: a standing
              quiet episode on a HEALTHY row, not dismissed since this episode's evidence. Its
              own row rather than a longer description, because the description line is the sync
              stamp and a notice folded into it would vanish with the next tick. Two keys —
              "the last mail came {when}" is false for a mailbox that never received any, and
              the pass stamps `createdAt` there, told apart by identity. */}
          {showInboundQuiet(shown, Date.now()) ? (
            <SettingsRow
              label=""
              description={shown.inboundQuietSince === shown.createdAt
                ? t("inboundQuietNever")
                : t("inboundQuiet", { when: agoStamp(shown.inboundQuietSince!, Date.now()).rel })}
              control={
                <Button
                  className="mbx-btn"
                  onClick={() => dismissQuiet(shown.id)}
                  disabled={dismissing.has(shown.id)}
                >
                  {t("inboundQuietDismiss")}
                </Button>
              }
            />
          ) : null}
        </Fragment>
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

      {/* ── HOW MUCH OF THE ACCOUNT IS ON THIS COMPUTER — a fact, not an alarm ───────────────
          This sentence used to be a warning triangle at the foot of the RAIL, standing in every
          view for as long as the two numbers differed ("This device holds N of the account's M
          messages"). It was removed on 2026-08-30; `deviceHoldings` in the shared shell
          carries the full argument, and the short form is that a windowed copy in front of
          working reach-past doors is this product behaving correctly, so alarming about it
          trains people to ignore the alarms that mean something. It also contradicted its own
          destination: the banner linked HERE, and every row here said "Up to date".

          So it is stated where somebody asking "what is actually on this machine" is standing,
          in the register of the sentence below it, with no icon of any kind. `set-note-inline`
          and not `SettingsNote` for exactly that reason — `SettingsNote` leads with a mark, and
          the one thing this line must not do is carry one.

          THE CLAIM IS PINNED, and it has to be, because it promises a behaviour: the mail
          outside the window loads from the account when it is reached. Both halves of that are
          real and both are the sidecar's doing — `cloud-read.ts` deliberately does NOT answer
          `GET /messages` (the reach-past LIST door) from the mirror, so the ask falls through to
          the hosted account, and `cloud-engine.ts` falls a body read through the same way for a
          row the mirror never held. If either door is ever served locally, this sentence becomes
          false and must go with it.

          `deviceHoldings` is the SHARED derivation — the same every-or-nothing sum and the same
          strict `total > count` clamp the strip's own `importing` denominator uses — so this
          pane cannot answer the question differently from the strip. `null` (no counts, one
          silent mailbox, a caught-up device, a local-only install that has no other copy to
          compare against) renders nothing at all, which is the resting case. */}
      {(() => {
        /* TWO GATES IN FRONT OF THE ARITHMETIC, both from review findings, both cases where the
           pair is comparable and the SENTENCE is false at the moment it would be said:

            · `cloud` — the claim promises that the rest loads FROM THE ACCOUNT, which is only a
              thing the hosted door can do. A standalone install has no account to reach into, and
              its engine reports no hosted counts, so the arithmetic would withhold anyway — this
              gate is the statement of intent in front of that coincidence, and it is what makes
              the door, rather than the shape of the data, the thing that decides.
            · `holdingsSpeak` — the mirror has actually been read, and the loop is not frozen. See
              its own doc-block; the short version is that a cold launch would otherwise announce
              "holds 0 of your M messages" about a machine whose store already holds them — only
              this client's own count is still climbing — and that a stopped session cannot keep
              the sentence's promise. */
        const held = cloud && holdingsSpeak(mailState, freshness)
          ? deviceHoldings(facts, mirrored)
          : null;
        return held === null ? null : (
          <p className="set-note-inline">
            {t("desktopHoldsCount", { count: held.count, total: held.total })}
          </p>
        );
      })()}

      {/* ── "RUN SETUP AGAIN" IS ON THE ROWS NOW, AND THIS IS WHERE IT WAS ────────────────
          One row at the foot of the pane, gated on `firstRunDoorFor` and `facts.length > 0`,
          navigating to `#/first-run/again`. Both gates were right and the PLACE stopped being:
          the flow writes a consent stamp and a screening window for one named mailbox, and a
          control at the foot of a list of three names none of them — it would have re-run setup
          for whichever row happened to be first. It is a row control now, carrying
          `?mailbox=<id>`. */}
      <SettingsNote>
        {/* WHERE THE MAIL ACTUALLY IS, said on the screen that lists it. The claim is the
            product's own and is true on both doors: the master copy is the mailbox on the server,
            and what is on this machine is a copy that can be deleted without losing anything. */}
        {t("desktopCopyIsACopy")}
      </SettingsNote>
    </SettingsSection>
  );
}

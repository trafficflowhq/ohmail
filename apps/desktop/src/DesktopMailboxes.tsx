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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Button, Gloss, SettingsActions, SettingsNote, SettingsRow, SettingsSection, SettingsVerdict } from "@ohmail/ui";

import {
  deviceHoldings, holdingsSpeak, readerStandDown, showInboundQuiet, type MailboxFacts,
} from "../../webapp/app/shell/mail-state";
import { addressKey } from "../../webapp/app/shell/address-key";
import { agoStamp, dayStamp } from "../../webapp/app/shell/format";
import { activeFormatLocale, activeFormatZone } from "../../webapp/app/shell/locale";
import { useMailState } from "../../webapp/app/shell/MailStateProvider";
import { goFirstRun } from "../../webapp/app/shell/routing";
import { readerHolder } from "../../webapp/app/shell/reader-holder";
import { bridgeFetch, engineLogout, retryingBridgeFetch, type EngineStatus } from "./bridge-fetch.js";
import { firstRunDoorFor } from "./doors.js";
import { openWeb } from "./native.js";

/** Whether this install can reach ONE mailbox's server right now — see {@link MailboxReachSlice}. */
export interface MailboxReach {
  /**
   * WHETHER THE ELEMENT DESCRIBING THIS ROW COULD BE READ AT ALL. `false` makes every other field
   * here meaningless, and the state line says so rather than reading them.
   *
   * It exists because the roster is read ELEMENT BY ELEMENT: one malformed entry is a fact about
   * one row, and the rows around it answered perfectly well. Folding it into `reachable` would
   * make an unreadable entry claim an outage at a mail server nothing has learned anything about.
   */
  answered: boolean;
  reachable: boolean;
  /** The server answered and refused the sign-in — a different fact with a different remedy. */
  signInRefused: boolean;
  /** ISO instant of the FIRST observation of death in the current outage; null while reachable. */
  unreachableSince: string | null;
}

/**
 * ONE POLL'S ANSWER — the per-row facts, and the verdict on the ANSWER ITSELF.
 *
 * A record alone could not carry the difference the poll has to report. "No id in the map" has to
 * mean "this row was not spoken about", because that is the ordinary case for a mailbox with no
 * runtime; so the state "the engine was asked and could not say anything about any of them" had
 * nowhere to live and arrived as the same empty map, which the pane reads as a healthy mailbox.
 */
export interface MailboxReachSlice {
  /** What the engine said, per mailbox id. Empty when it said nothing. */
  rows: Record<string, MailboxReach>;
  /**
   * WHEN THIS PANE LEARNED THIS — `Date.now()` at the answer, or at the moment the wait for the
   * first one began; `null` on a door that never asks, where nothing ages.
   *
   * An answer's AGE is what makes silence visible. A poll that never resolves writes no slice at
   * all, so with nothing stamped the last thing on screen — `unasked` at a mount, or a healthy
   * verdict — stands for the life of the pane. See {@link reachStale}.
   */
  at: number | null;
  /** WHERE THIS POLL LANDED — see {@link MailboxReachPollState}. */
  state: MailboxReachPollState;
  /** WHICH silence or fault it was; `null` for a verdict and for a poll that has not landed. */
  reason: MailboxReachPollReason | null;
  /** The engine's status when it answered; `null` when nothing arrived. */
  status: number | null;
  /**
   * WHAT THE TRANSPORT THREW, class and message, bounded — the only diagnosis a silence carries.
   *
   * It exists so a repeat of the reading below can be NAMED rather than guessed at: the bridge's
   * own refusals are sentences about this process's pipe ("32 requests are already waiting on the
   * engine; this one was not sent", "the engine is still starting"), and none of them reaches the
   * engine's log, because a request the shell refused to send was never sent. Bounded because a
   * thrown value is somebody else's string, and no address or credential is in reach of it: the
   * bridge composes these lines itself and the page never holds the engine's token.
   */
  detail: string | null;
}

/**
 * WHERE ONE POLL OF THE REACH ROUTE LANDED — and the reason "silence" is not one state.
 *
 * There used to be two: a verdict, and `faulted` for "the engine answered and what it answered
 * was not a verdict". Everything else — a transport that never delivered the question, and an
 * engine answering 404 because it predates the route — arrived as an un-faulted empty map, which
 * is byte for byte the value a healthy engine holding no runtimes produces. So a silence and an
 * answer were one state, and the row read whatever it read before this existed.
 *
 * MEASURED, and this is the reading the four states are for: on the Windows guest, 2026-09-09,
 * the Settings row for a mailbox this install organizes read "Up to date" for eleven samples of
 * eleven across a nine-minute cut, while the engine's own log held the death (ECONNRESET), six
 * failed re-dials and twenty-four failed cycles, and the engine's outage clock stayed armed the
 * whole time. The engine was right and the pane never received its answer; with one state for
 * "no answer" and "answered healthy", nothing on screen or in the log could tell the two apart.
 *
 *  · `unasked`  — no poll has landed yet, or this is not the local door. Nothing is claimed and
 *                 nothing denied: the row keeps its ordinary state, which is what keeps the pane
 *                 from flashing "Can't check" on the tick between mounting and the first answer.
 *  · `verdict`  — the engine answered with a roster. A row it NAMES is decided by that record; a
 *                 row it does not name ordinarily has no local runtime at all, which is the state
 *                 of every mailbox ohmail Cloud organizes — see {@link reachUnknownForRow} for
 *                 the one row where that absence is news instead.
 *  · `silent`   — nothing was answered, and WHICH silence decides the sentence: `route-absent` is
 *                 an engine older than the route (an ordinary state on a desktop that updates on
 *                 its own schedule, and on a transport that does not carry the local routes);
 *                 `transport-threw` is the question never arriving, which is not ordinary.
 *  · `faulted`  — the engine on this machine was reached and refused or fell over.
 */
export type MailboxReachPollState = "unasked" | "verdict" | "silent" | "faulted";

/**
 * WHICH silence or fault this was.
 *
 * It reaches the LOG and never a sentence. The row has one honest thing to say for all of them —
 * "Can't check the mail server right now" — because every one of them is the same fact from the
 * person's side: this install cannot say. Which of them it was is the diagnostician's question.
 */
export type MailboxReachPollReason =
  /** THE QUESTION NEVER ARRIVED: the bridge itself rejected, so the engine never saw a request. */
  | "transport-threw"
  /** 404 — an engine that predates the route, or a transport that does not carry the local ones. */
  | "route-absent"
  /** The engine answered and refused or fell over: any other non-OK status. */
  | "refused"
  /** An OK answer whose body is not JSON. */
  | "unparseable-body"
  /** A body that parsed and is not a roster. */
  | "not-a-roster";

/**
 * A DOOR THAT DOES NOT ASK: nothing has been asked and nothing will be, so `at` is null and this
 * never goes stale. A fresh object per call, on {@link readMailboxReachVia}'s rule.
 */
export const unaskedReach = (): MailboxReachSlice =>
  ({ rows: {}, state: "unasked", reason: null, status: null, detail: null, at: null });

/**
 * THE SAME STATE ON A DOOR THAT IS ASKING — no answer yet, and the wait has a clock. One `state`,
 * two facts: a door with no poll coming can never go stale, and a first poll that hangs must.
 */
export const waitingReach = (at: number): MailboxReachSlice => ({ ...unaskedReach(), at });

/**
 * THE PANE'S REACH CADENCE, AND HOW OLD AN ANSWER MAY BE.
 *
 * Fifteen seconds is the engine's own poll interval. The bound is that plus two of grace: a read
 * takes longer than the interval whenever the engine is mid-reconnect, and the sentence must not
 * flash on a healthy pane that missed one tick — while a silence outlasting three of them is not
 * a tick any more.
 */
export const REACH_POLL_MS = 15_000;
export const REACH_STALE_MS = REACH_POLL_MS * 3;

/**
 * WHETHER THE PANE'S LAST ANSWER IS TOO OLD TO BE SPOKEN FOR — one stamp, one comparison.
 *
 * `at: null` is a door that never asks and it never ages: a slice going stale there would put
 * "Can't check the mail server right now" on every hosted row, whose connection belongs to a
 * worker on a shard and was never this machine's to report.
 */
export function reachStale(slice: Pick<MailboxReachSlice, "at">, now: number): boolean {
  return slice.at !== null && now - slice.at > REACH_STALE_MS;
}

/**
 * WHAT THE TRANSPORT THREW, as one bounded line — see {@link MailboxReachSlice.detail}.
 *
 * `err.name` and not the constructor: an `AbortError` is a plain `Error` whose NAME carries the
 * fact, which is the shape the bridge produces for the one call it bounds.
 */
function describeThrown(err: unknown): string {
  const text = err instanceof Error ? `${err.name}: ${err.message}` : `${typeof err}: ${String(err)}`;
  return text.length > 240 ? `${text.slice(0, 240)}\u2026` : text;
}

/**
 * WHETHER AN ABSENT RECORD ABOUT ONE ROW MEANS "CANNOT CHECK" — the whole of the fix, in one
 * pure function, because a rule that decides a sentence has to be assertable without a render.
 *
 * `rows[id]` being absent is FOUR different facts, and the pane used to act on one of them:
 * only a `faulted` slice said "Can't check", so a transport that threw and an engine answering
 * 404 both left the ladder to fall through to "Up to date" — over an install whose own log held
 * the outage. Each arm below is a different answer to "is this absence news?", and each is
 * watched by a case in `desktop-mailboxes.test.ts` that reddens when that arm alone is flipped.
 */
export function reachUnknownForRow(
  slice: Pick<MailboxReachSlice, "state" | "reason" | "at">,
  organizedHere: boolean,
  now: number,
): boolean {
  /* THE BOUND, and it is gated on the row's own claim for the reason the `verdict` arm below is:
     with no roster in hand nothing says this install holds a connection for a row it does not
     file, and a row reading "Organized by ohmail Cloud" must not start saying "Can't check". */
  const overdue = organizedHere && reachStale(slice, now);
  switch (slice.state) {
    /* NOTHING HAS BEEN ASKED YET — the mount before the first answer, or another door. A pane
       that read this as "cannot check" would print the sentence for a tick every time somebody
       opened Settings, which is a false alarm with a true one's words.

       BOUNDED, because a first poll that never RESOLVES is not a tick: nothing writes a slice,
       so `unasked` used to stand for the life of the mount and the ladder fell through to "Up to
       date" over an install whose own log held the outage. Past the bound that wait is news. */
    case "unasked": return overdue;
    /* THE ENGINE ANSWERED SOMETHING THAT IS NOT A VERDICT. Unchanged: this arm is what the pane
       already did, and it is the one silence that was already news. */
    case "faulted": return true;
    /* A 404 IS AN ORDINARY STATE AND A THROW IS NOT, and folding the two is what this fix undoes.
       An engine older than the route cannot answer and is not broken; the desktop's own frame
       door, by contrast, serves this route in the same build as the window, so a throw there is
       the question failing to arrive at an engine that would have answered it. */
    case "silent": return slice.reason === "transport-threw" || overdue;
    /* A ROSTER THAT DOES NOT NAME THIS ROW. For a mailbox this computer does not file, that is
       the ordinary and correct answer — ohmail Cloud organizes it, this process holds no
       connection for it, and a row reading "Organized by ohmail Cloud" must not start saying
       "Can't check". For a row whose own description says THIS COMPUTER FILES IT, the engine
       holds a runtime and the route answers from every runtime it holds, so an absence is a
       missing answer rather than an answer — and "Up to date" would be a claim with nothing
       behind it, which is the shape the whole of this function exists to refuse. */
    case "verdict": return organizedHere;
  }
}

/**
 * CAN THIS MACHINE REACH ITS MAILBOXES RIGHT NOW — a desktop-only read, on purpose.
 *
 * It is NOT part of `MailboxFacts`, and that is not tidiness. Those facts are the shared shell's,
 * served by `GET /mailboxes` on both doors and consumed by the hosted client too, where "our
 * socket to your provider" is a fact about a worker on a shard that no user is sitting at. The
 * liveness of THIS process's own connections has a reader on exactly one surface, so it has a
 * route on exactly one door.
 *
 * ── SILENCE IS "CANNOT TELL"; A BAD ANSWER IS NOT SILENCE ────────────────────────────────────
 *
 * Two ways this legitimately says nothing and leaves every row alone: an engine older than the
 * route (a desktop updates on its own schedule, so a window newer than its engine is an ordinary
 * state, and that engine answers 404), and a transport that never delivered the question at all.
 * Both mean "no answer", the ladder's fallback for an absent id is the state it had before this
 * existed, and the dangerous default is the other one — a pane that read silence as "unreachable"
 * would tell somebody their mail had stopped every time an update landed.
 *
 * ── AND THE THIRD CASE, WHICH USED TO WEAR THE FIRST TWO'S CLOTHES ───────────────────────────
 *
 * `if (!res.ok) return {}` folded a 401, a 403 and a 500 into that same silence. Those are the
 * route ANSWERING — the engine on this machine is up, it was asked about the sockets it holds,
 * and it refused or fell over. Read as silence, every row kept its last ordinary state, so the
 * pane rendered "Up to date" over an install that could not say whether one byte of mail was
 * moving. That is a confident wrong answer standing in for a missing one, which is the one shape
 * this file's every other absent/null rule exists to avoid, and it was the one place that had it
 * backwards. A body that cannot be parsed is the same fact and takes the same arm: the route
 * answered, and what it answered was not a verdict.
 */
export async function readMailboxReachVia(
  fetchImpl: (url: string, init?: unknown) => Promise<Response>,
): Promise<MailboxReachSlice> {
  /* Fresh objects rather than a shared constant: `rows` is handed to a `useState` setter and a
     module-level literal would be one object shared by every poll of every pane. */
  const silent = (
    reason: MailboxReachPollReason, over: Partial<MailboxReachSlice> = {},
  ): MailboxReachSlice =>
    ({ rows: {}, state: "silent", reason, status: null, detail: null, at: Date.now(), ...over });
  const faulted = (reason: MailboxReachPollReason, status: number): MailboxReachSlice =>
    ({ rows: {}, state: "faulted", reason, status, detail: null, at: Date.now() });
  let res: Response;
  try {
    res = await fetchImpl("/local/mailboxes/connections");
  } catch (err) {
    /* THE QUESTION NEVER ARRIVED. Nothing was answered, so nothing is known — and the throw is
       CARRIED rather than swallowed, because it is the only account of a silence that leaves no
       trace in the engine's log: a request the shell refused to send was never sent. */
    return silent("transport-threw", { detail: describeThrown(err) });
  }
  /* THE ENGINE PREDATES THE ROUTE — the one non-OK status that is genuinely silence, and the
     reason this is a status test rather than `!res.ok`. */
  if (res.status === 404) return silent("route-absent", { status: 404 });
  if (!res.ok) return faulted("refused", res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    /* AN OK RESPONSE THAT IS NOT A VERDICT. `readMirrorFreshness` rejects on the same grounds and
       for the same reason: an unanswerable question must not be dressed as an answer. */
    return faulted("unparseable-body", res.status);
  }
  /* ── AND A BODY THAT PARSED IS STILL NOT NECESSARILY A VERDICT ──────────────────────────────
   *
   * `body.items ?? []` treated `{}`, `{"items": null}`, a bare string and an array as "the engine
   * answered about no mailboxes", which is the SILENT slice — every row keeps its last ordinary
   * state, so a mailbox whose socket died goes on reading "Up to date" for as long as the malformed
   * answer keeps arriving. That is the same confident-wrong-answer-for-a-missing-one this function
   * was rewritten to stop, surviving one line below the status check that stopped it.
   *
   * The verdict is the SHAPE: an object carrying an `items` ARRAY. `{"items": []}` is a genuine
   * verdict — an engine holding no runtimes — and stays un-faulted with an empty roster, which is
   * the case that keeps this from being a check that fires on everything. */
  const items = (body as { items?: unknown } | null)?.items;
  if (typeof body !== "object" || body === null || Array.isArray(body) || !Array.isArray(items)) {
    return faulted("not-a-roster", res.status);
  }
  /* ── ONE ELEMENT IS A FACT ABOUT ONE ROW, AND NEVER ABOUT THE WHOLE READ ──────────────────
   *
   * `const it = raw as {…}` followed by `it.mailboxId` THREW on a `null` element, and the throw
   * left the whole function — past the poll's `.then`, so `setReach` was never called and the
   * slice on screen stayed whatever it was. After a healthy read that means a mailbox whose
   * socket has since died goes on saying "Up to date", and so does every row after the bad
   * element, for as long as the roster keeps carrying it. One unreadable entry silenced the
   * answer about every OTHER mailbox, which is the opposite of what it is evidence for.
   *
   * So the seam's invariant, once, and it is the same one the state line follows: a row's
   * rendered state comes only from a verdict about THAT row. An element that names a row and
   * cannot be read marks that row unanswered; an element that names no row is dropped, because
   * there is nothing to attribute it to; the rest publish. The whole-body checks above stay where
   * they are — a body that is not a roster is a fact about the READ, and that one is not per-row.
   */
  const out: Record<string, MailboxReach> = {};
  for (const raw of items) {
    const it = (typeof raw === "object" && raw !== null ? raw : {}) as {
      mailboxId?: unknown; reachable?: unknown; unreachableSince?: unknown; signInRefused?: unknown;
    };
    /* NO ID, NOTHING TO SAY IT ABOUT. Dropped rather than faulted: marking the slice would let one
       unattributable entry speak for rows it never named. */
    if (typeof it.mailboxId !== "string" || it.mailboxId === "") continue;
    if (typeof it.reachable !== "boolean") {
      out[it.mailboxId] = {
        answered: false, reachable: false, signInRefused: false, unreachableSince: null,
      };
      continue;
    }
    out[it.mailboxId] = {
      answered: true,
      reachable: it.reachable,
      unreachableSince: typeof it.unreachableSince === "string" ? it.unreachableSince : null,
      /* ABSENT READS AS `false`, on this file's standing rule: an engine older than the field
         cannot have refused a sign-in, and the dangerous default is the other one — telling
         somebody their password was rejected because their app is out of date. */
      signInRefused: it.signInRefused === true,
    };
  }
  /* STAMPED WHERE THE ANSWER IS MADE, not where it is stored: the sequence guard discards a read
     that landed out of order, and a stamp taken at the setter would make that stale answer look
     like the newest thing this pane knows. */
  return { rows: out, state: "verdict", reason: null, status: res.status, detail: null, at: Date.now() };
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
 *
 * The rule itself moved to the shared shell (`format.ts#dayStamp`) when the browser's Mailboxes
 * pane grew the same released sentence: one catalogue key rendered on two panes must not be able
 * to carry two different dates. This name stays because the call sites below read better with it.
 */
const day = dayStamp;

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
  { door, host, onShellStatus }: {
    door?: string | null;
    /**
     * THE OTHER COMPUTER THIS INSTALL READS THROUGH, when it reads through one.
     *
     * A separate parameter rather than a fourth `door` value, because the two answer different
     * questions and this pane needs both: `door` decides what the ENGINE will serve (the paired
     * door is a cloud door and every route behaves as one), and this decides what the pane may
     * SAY. Folded into `door` the first would have changed with the second, and the resync verb —
     * which works perfectly well through a host — would have gone with the wording.
     */
    host?: string | null;
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
  /**
   * WHICH MAILBOXES THIS MACHINE CAN REACH — its own poll, and it has to be its own.
   *
   * The facts poller reads `GET /mailboxes`, which is the shared route and carries no answer to
   * this question; see `readMailboxReachVia`. Fifteen seconds is the engine's own poll interval,
   * so the pane converges within one cycle of the engine noticing, and the first read runs
   * immediately rather than after a delay — a person opening Settings during an outage is
   * exactly who this line is for.
   */
  const [reach, setReach] = useState<MailboxReachSlice>(unaskedReach);
  /**
   * THE RENDER'S CLOCK, advanced by the poll's own interval — see {@link reachStale}.
   *
   * A poll that never answers writes no state, so nothing re-renders and an answer's age would
   * never be read. This ticks whether or not the engine replies, and it is the only thing here
   * that does. Between ticks it lags, which can make the bound fire late and never early.
   */
  const [now, setNow] = useState(() => Date.now());
  /* THE ROWS THIS PANE IS SHOWING, for the poll's log line and for nothing else — through a REF
     because the poll must not RESTART when the facts poller lands. `facts` in the dependency list
     would tear the interval down and re-issue a read twice a minute, and a callback that outlives
     the render it was made in has to read the current value rather than the one it closed over. */
  const factsRef = useRef<MailboxFacts[] | null>(facts);
  factsRef.current = facts;
  useEffect(() => {
    /* ── LOCAL DOOR ONLY ──────────────────────────────────────────────────────────────────
     *
     * `/local/mailboxes/connections` exists on the local engine and nowhere else. Mounted
     * unconditionally, this asked for it on the CLOUD door too, where it falls through the cloud
     * engine's catch-all proxy and becomes a hosted round trip — four a minute, for a route that
     * does not exist, for as long as the pane is open. The state it would fill is meaningless
     * there anyway: a Cloud mailbox's connection belongs to a worker on a shard, not to this
     * machine. `door` is in the dependency list, so switching doors starts or stops it. */
    /* `unaskedReach()` AND NOT A SILENT SLICE: on another door nothing has been asked, and the
       difference decides a sentence now — a slice that says "asked, no answer" would put "Can't
       check the mail server right now" on every hosted row, whose connection belongs to a worker
       on a shard and was never this machine's to report. */
    if (door !== "local") { setReach(unaskedReach()); return; }
    let live = true;
    /* THE SEQUENCE GUARD. Two reads are in flight whenever one takes longer than the interval —
       an engine mid-reconnect is exactly when it will — and promises settle in whatever order
       they finish, not the order they started. Without this a slow read that started first can
       land second and overwrite a newer answer, so the row flips back to "reachable" during an
       outage (or back to unreachable after it ended) and stays wrong until the next tick. Only a
       strictly newer response is allowed to write. */
    let issued = 0;
    let shown = 0;
    /* ── THE POLL SAYS WHERE IT LANDED, ONCE PER CHANGE ────────────────────────────────────
     *
     * The five landings this line tells apart are the ones the row's sentence is derived from:
     * the engine answered badly; nothing arrived, and which silence it was; it answered a roster
     * that does not name a row this pane is showing; and it named one — reachable, or not. Before
     * this, a silence and a healthy verdict produced the same screen AND the same nothing
     * anywhere else, which is why a nine-minute outage on the Windows guest could be measured on
     * screen and not attributed afterwards to either half of the pair.
     *
     * ON CHANGE, not per poll: four lines a minute for as long as Settings is open would bury the
     * transition that anybody is actually looking for.
     *
     * `console` IS THE WHOLE OF THIS PANE'S REACH, said here so that a later reader does not take
     * the line for a field instrument. The window holds two shell commands and has no route into
     * the engine's log, so this is visible in the web inspector and nowhere else; the half a
     * released install would be diagnosed from is one line where the engine's roster route
     * ANSWERS, and that line is not in this change. */
    let noted = "";
    const noteLanding = (r: MailboxReachSlice): void => {
      const rows = (factsRef.current ?? []).filter((m) => m.status !== "disabled");
      const named = rows.filter((m) => r.rows[m.id] !== undefined);
      const answered = named.filter((m) => r.rows[m.id]!.answered);
      const line = JSON.stringify({
        where: r.state,
        ...(r.reason === null ? {} : { reason: r.reason }),
        ...(r.status === null ? {} : { status: r.status }),
        ...(r.detail === null ? {} : { detail: r.detail }),
        /* COUNTS AND NEVER IDS OR ADDRESSES. Which mailbox is on which provider is the
           identifying signal this product keeps out of diagnostics, and the row's own sentence
           on screen is what pairs a count with a row. */
        rows: {
          shown: rows.length,
          withoutRecord: rows.length - named.length,
          unanswered: named.length - answered.length,
          reachable: answered.filter((m) => r.rows[m.id]!.reachable).length,
          unreachable: answered.filter((m) => !r.rows[m.id]!.reachable).length,
        },
      });
      if (line === noted) return;
      noted = line;
      console.info("ohmail reach poll:", line);
    };
    const read = (): void => {
      const seq = ++issued;
      void readMailboxReachVia(retryingBridgeFetch).then((r) => {
        if (!live || seq <= shown) return;
        shown = seq;
        noteLanding(r);
        setReach(r);
      });
    };
    /* THE WAIT IS STAMPED WHERE IT STARTS. A door that comes back to local holds the not-asking
       slice, whose `at` is null and never ages; without this the first poll's silence on that
       path is unbounded again. */
    setReach((prev) => (prev.state === "unasked" ? waitingReach(Date.now()) : prev));
    read();
    const id = setInterval(() => { setNow(Date.now()); read(); }, REACH_POLL_MS);
    return () => { live = false; clearInterval(id); };
  }, [door]);
  /** Mailboxes whose resync this pane has queued — a press the engine has not been given yet.
   *  The engine's own poll cycle never writes here. See {@link resync}. */
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
   * WHAT WAS ASKED FOR — a bare outcome now, and the half that is gone went with its premise.
   *
   * It used to carry `blocked` beside the outcome, because a press could be refused outright by
   * the lease on the HOLDER'S KIND: a request made in that state achieved nothing, so it could
   * not be allowed to consume the one-shot button. Kind no longer ranks — an explicit press
   * outranks a claim carrying none, and the holder stands down on its next pass — so there is no
   * blocked state left to keep a retry reachable for. The entry means what it says again: a
   * request was made, and the row's own role is what ends it.
   */
  const [reclaimed, setReclaimed] = useState<ReadonlyMap<string, {
    outcome: TakeoverOutcome;
    /**
     * THE ROW'S RELEASE STAMP AT THE MOMENT OF THE PRESS — what makes this note END.
     *
     * The note is a promise about ONE press, and a press is only the newest word until another
     * one is made. Its render condition was "the role is not organizer yet", which is true again
     * after a STOP — so a note reading "Asked for. This computer takes over on its next pass"
     * came back over a row whose organizing this person had since given up, and the same map hid
     * the button that would undo it. The stop is not the only way: any release, made in any
     * window, stamps this column afresh, and a press made before that stamp is not about the
     * state the row is in now.
     *
     * `null` when the row carried none — an install that has never let this mailbox go — which
     * compares equal to itself and to nothing else.
     */
    releasedAt: string | null;
  }>>(() => new Map());
  /** Mailboxes whose takeover request is in flight, so the button debounces. */
  const [reclaiming, setReclaiming] = useState<ReadonlySet<string>>(() => new Set());
  /**
   * THE OTHER DIRECTION — what "stop organizing here" answered, per mailbox.
   *
   * Two outcomes reach a person and both are successes: `requested`, which the gate honours on
   * its next pass, and `not_organizing`, which is a mailbox this install was not organizing
   * anyway. Kept as the outcome rather than a rendered sentence, on `reclaimed`'s own rule, so
   * the words stay in the catalogue.
   */
  const [released, setReleased] = useState<ReadonlyMap<string, string>>(() => new Map());
  /** Mailboxes whose release is in flight, so the confirm debounces. */
  const [releasingIds, setReleasingIds] = useState<ReadonlySet<string>>(() => new Set());
  /** Which mailbox's release is asking whether you meant it, or `null` when none is. */
  const [releaseFor, setReleaseFor] = useState<string | null>(null);
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
  /* PAIRED: a cloud door whose far side is a computer of the person's own. Everything the ENGINE
     does is the cloud door's; what changes is what this pane may claim. */
  const paired = cloud && !!host;
  const heading = cloud ? t("modeCloud") : t("desktopModeLocal");

  /**
   * ASK FOR A FRESH PASS OVER ONE MAILBOX. 202 — nothing is synced when this returns.
   *
   * The only mutation this pane makes, and the only one it can make on the hosted door; see the
   * header. It is the same route the browser's own "Sync now" calls, over the pipe instead of a
   * socket, and it is served on BOTH doors — by the local engine's own route table on the
   * standalone one, by the write-through proxy on the hosted one.
   *
   * BOTH answers end the queued mark: a refusal, because a row left disabled after one is a
   * control nobody can retry, and an acceptance — at that point the press is the engine's and the
   * row's own state line says what the mailbox is doing. "Syncing" is a state, not a lock, and
   * nothing but a press writes this set.
   *
   * Pressing again is safe: the engine honours a forced dial at most once per backoff base step
   * (`forcedNotBefore`), so rationing it here would be rationing it in the wrong process.
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
        /* 202 is the whole answer this route gives, so the mark ends here. */
        setQueued((q) => {
          const next = new Set(q);
          next.delete(id);
          return next;
        });
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
  const reclaim = (id: string, releasedAt: string | null): void => {
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
        setReclaimed((m) => new Map(m).set(
          id,
          { outcome: takeoverOutcome(body.outcome), releasedAt },
        ));
        /* ── AND A TAKEOVER IS A NEWER PRESS ABOUT THE SAME MAILBOX ────────────────────────
         *
         * The mirror of the delete in `release()`. Without it a stop's own note came back onto
         * the row the moment a takeover restored the role and cleared the request stamp — the
         * pane promising a stop the person had just withdrawn, until Settings was reopened. */
        setReleased((m) => {
          if (!m.has(id)) return m;
          const next = new Map(m);
          next.delete(id);
          return next;
        });
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
   * STOP ORGANIZING THIS MAILBOX HERE, AND KEEP THE MAIL — the mirror of `reclaim`.
   *
   * `POST /mailboxes/:id/release`, the shared route rather than a local-only one, because the act
   * is the same on both doors: it records a request on the caller's own row and the organizing
   * gate honours it on its next pass. Nothing here expunges anything — the claim lives in the
   * mailbox itself, so only the process holding that connection can give it up, which is why the
   * copy says "within a minute" rather than reporting it done.
   *
   * `refresh` on the answer, so the row's state line moves as soon as the gate has acted rather
   * than on the poller's slower clock. A failure lands in the pane's one problem line, and the
   * row keeps saying what it said.
   */
  const release = (id: string): void => {
    setProblem(null);
    setReleasingIds((q) => new Set(q).add(id));
    void (async () => {
      try {
        const res = await bridgeFetch(`/mailboxes/${encodeURIComponent(id)}/release`, {
          method: "POST",
        });
        if (!res.ok) throw new Error(await reasonOf(res));
        const body = (await res.json()) as { outcome?: unknown };
        setReleased((m) => new Map(m).set(
          id,
          body.outcome === "requested" ? "requested" : "not_organizing",
        ));
        /* ── A STOP IS A NEWER PRESS ABOUT THE SAME MAILBOX ────────────────────────────────
         *
         * Cleared HERE as well as by the stamp comparison in `takeoverStanding`, and the two are
         * not redundant: the stamp only moves once the release has actually been recorded, which
         * is a poll away, and in the meantime this pane would go on showing a promise the person
         * has just withdrawn. This is the press's own answer to its own press. */
        setReclaimed((m) => {
          if (!m.has(id)) return m;
          const next = new Map(m);
          next.delete(id);
          return next;
        });
        refresh();
      } catch (err) {
        setProblem(err instanceof Error ? err.message : String(err));
      } finally {
        setReleasingIds((q) => {
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
        /* ── THE MAILBOX IS GONE; ITS CLAIM ON THE MAIL SERVER MAY NOT BE ────────────────────
         *
         * The route releases this install's organizer claim out of `ohmail/_meta` before it stops
         * the runtime, and that release can fail on its own — the mail server can refuse the
         * search that finds our own records in that folder. When it does the claim STAYS, and
         * until it goes stale any other install connecting this mailbox stands itself down and
         * says only that something else organizes it. That is a wait with no visible cause, about
         * a machine the person has just removed the mailbox from.
         *
         * The route reports the outcome because it is the only thing that knows it, and this is
         * the pane that can say it. Same shape as the sign-out failure below: the removal
         * committed, what is being reported is the tidying that did not.
         *
         * THREE STATES, NOT TWO, and the middle one is why this reads `=== false` rather than
         * falsy. `true` is released; `false` is a release that was attempted and could not be
         * completed; ABSENT is an engine that predates the field and cannot answer — which is not
         * a claim left behind and must not be announced as one. The shell and the engine ship
         * together, so absent means "older engine", not "unknowable".
         */
        const outcome = await res.json().catch(() => null) as { claimReleased?: boolean } | null;
        if (outcome?.claimReleased === false) setProblem(t("desktopRemovedClaimLeftBehind"));
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

  /* THE "WOULD THE LEASE REFUSE THIS?" PREDICATE IS GONE, WITH THE RULE IT ENCODED.
   *
   * It branched on the holder's KIND, because the lease ranked a live hosted claim above a local
   * one and refused a takeover of it "even with authorization" — so on those rows the pane had to
   * say the press could not take the mailbox and name the order to do it in. Kind no longer
   * ranks: what ranks is an explicit press, and a claim carrying none loses to one that does,
   * whichever machine wrote it. Every row a reader can press is a row the press can take, so
   * there is one sentence again instead of two.
   */

  /**
   * The holder's own name for a sentence, or the kind when it did not send one.
   *
   * `|| null` AND NOT `??`, because an EMPTY name is not a name. The holder columns are written
   * together and an install that sent no display name writes `""`, so `??` — which only falls
   * back on `null`/`undefined` — put the empty string into the sentence: the row read "Organized
   * by " and the date line ended where the name should be. `readerHolder`, which decides WHICH of
   * the three reader states this row is in, has trimmed and tested for empty since it was
   * written, so the row was already correctly classified as "a holder we cannot name" and then
   * named it blankly — the two halves of one fact disagreeing inside one banner.
   */
  const holderOf = (m: MailboxFacts): string =>
    m.organizedBy?.name?.trim()
    || (m.organizedBy?.kind === "cloud" ? "ohmail Cloud" : t("readerHolderUnknown"));

  /**
   * IS THE TAKEOVER PRESS MADE HERE STILL THE NEWEST WORD ON THIS MAILBOX?
   *
   * One predicate for the note and for the button it withholds, because they are two halves of
   * one answer and they used to disagree with each other after a stop: the note came back and the
   * button stayed hidden, so the row promised a takeover that was no longer wanted and offered no
   * way to ask for it again. See {@link reclaimed}'s `releasedAt`.
   */
  const takeoverStanding = (m: MailboxFacts): boolean => {
    const asked = reclaimed.get(m.id);
    return asked !== undefined && (m.organizerReleasedAt ?? null) === asked.releasedAt;
  };

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
   * What each mailbox is doing, in one line — the SENTENCE, and apart from it the one clause that
   * TICKS. A closure rather than a module function so it reads the same translator the rest of
   * the pane does; there is nothing to share it with.
   *
   * ── WHY TWO PARTS ─────────────────────────────────────────────────────────────────────────
   * The cell is a live region (the row's value slot, `role="status"`), and a live region announces
   * every text change inside it. With the relative stamp inside the sentence an outage read
   * "Last answered 3 minutes ago", then "4 minutes ago", once a minute for as long as it lasted —
   * a reader told every minute what it was told the first time. So the stamp comes back apart:
   * `said` is what the live node holds, and it changes only when the STATE moves; `when` stands
   * beside it in the cell, exposed to the tree but never announced. Every other arm has nothing
   * that ticks. The visible text is the same two clauses in the same order.
   */
  /**
   * WHETHER THIS COMPUTER FILES THIS MAILBOX — the row's own claim, in one place.
   *
   * The description renders "Organized on this computer" from it and the state ladder reads it to
   * decide whether an ABSENT connection record is news (see {@link reachUnknownForRow}). Two
   * spellings of one rule is how the two halves of a row come to contradict each other, so the
   * expression the description carried is now this and the ladder asks the same question.
   *
   * `organizeConsentedAt` and not the role alone: the column rests at `'organizer'` and the
   * mapper coerces anything that is not literally `"reader"` to it, so the role by itself says
   * this about a mailbox that was connected and never agreed to, while nothing is filed and
   * `ohmail/*` does not exist.
   */
  const organizesHere = (m: MailboxFacts): boolean =>
    !cloud && m.status !== "disabled" && m.organizerRole !== "reader"
    && Boolean(m.organizeConsentedAt);

  const stateOf = (m: MailboxFacts): { said: string; when: string | null } => {
    const say = (said: string): { said: string; when: null } => ({ said, when: null });
    if (m.status === "error") {
      return say(t("desktopStateError", { code: m.errorCode ?? t("desktopUnknownCode") }));
    }
    if (m.status === "disabled") {
      return say(m.disabledReason ? t("desktopStateHandedOver") : t("desktopStateDisconnected"));
    }
    /* ── UNREACHABLE OUTRANKS BOTH THE ROLE AND THE PROGRESS ───────────────────────────────
     *
     * Above the reader arm and above every progress arm, because all of them describe mail
     * MOVING and none of it is. "Reading only" over a dead socket reads nothing; "Up to date" is
     * true of a mirror that stopped growing an hour ago. It stays BELOW `error` and `disabled`,
     * which are durable statements about the row that a live socket would not contradict.
     *
     * It says a fact and nothing else — no "signed out", no "check your connection", no advice.
     * The mailbox is untouched, the password is untouched, and the engine re-dials on its own;
     * a sentence implying the person must act would be asking for work that is not theirs. */
    const r = reach.rows[m.id];
    /* THE ROW'S OWN ENTRY COULD NOT BE READ — first, because nothing else on `r` means anything
       when this is false, and `reachable: false` sitting under it would announce an outage at a
       mail server this read learned nothing about. Same sentence as the whole-slice arm below:
       the question about this row went unanswered, which is what both of them are. */
    if (r && !r.answered) return say(t("desktopStateUnknown"));
    /* THE SERVER ANSWERED AND SAID NO — above the unreachable arm, because it is a MORE specific
       answer to the same question and the generic one would send somebody to check a network
       that is working perfectly. */
    if (r?.signInRefused) return say(t("desktopStateSignInRefused"));
    /* ── THE ENGINE COULD NOT SAY, AND THAT IS ITS OWN SENTENCE ─────────────────────────────
     *
     * Only when the row has no answer of its own — the check is written on the row rather than on
     * the poll, so a partial answer keeps whatever it managed to say — and then only when that
     * absence is NEWS: {@link reachUnknownForRow} owns that decision, and it owns it because the
     * arm used to read `reach.faulted` alone. A transport that threw and an engine answering 404
     * both left this arm unentered and the ladder fell through to "Up to date"; that is the
     * Windows reading of 2026-09-09, eleven samples of eleven over a nine-minute cut the engine
     * had recorded correctly the whole time.
     *
     * NOT `desktopStateUnreachable`. That sentence — "Can't reach the mail server" — is a claim
     * about the PERSON'S MAIL SERVER, and what actually happened is that the engine on this
     * machine refused or fell over when asked about its own sockets. A stale bearer after an
     * engine restart answers 401 for every poll, and every row would announce an outage at a
     * provider that is working perfectly, while mail carries on arriving.
     *
     * "Can't check the mail server right now" is the honest one, and it is also what makes a
     * single transient 5xx harmless: the row states an unanswered question for one poll and the
     * next good answer replaces it, rather than asserting an outage and then withdrawing it. No
     * debounce for that reason — a delay would hold a true outage back by as long as it holds a
     * false one, and this arm no longer claims anything that needs holding back. */
    if (!r && reachUnknownForRow(reach, organizesHere(m), now)) {
      return say(t("desktopStateUnknown"));
    }
    if (r && !r.reachable) {
      /* `agoStamp(...).rel` AND NOT `day(...)`: an outage is a DURATION, and the neighbouring
         `day` stamp is deliberately date-only because the sentences it serves are standing facts
         somebody reads once. "Unreachable since 5 Sep 2026" tells a person nothing about an
         outage that began twenty minutes ago; "unreachable since 20 minutes ago" is the whole
         answer. It is the same stamp the quiet-mailbox line already uses on this pane. The
         stamp's clause is the `when` half — see the header — so the sentence the live node
         announces is the verdict alone, once. */
      return r.unreachableSince
        ? {
            said: t("desktopStateUnreachable"),
            when: t("desktopStateLastAnswered", { when: agoStamp(r.unreachableSince, Date.now()).rel }),
          }
        : say(t("desktopStateUnreachable"));
    }
    /* ── AN ANSWER HAS AN AGE, AND AN OLD ONE IS NOT AN ANSWER ──────────────────────
     *
     * BELOW the outage arm, so a detected outage keeps its own sentence however old the roster
     * is, and above the role and progress arms for the reason those sit under the outage: all of
     * them describe mail MOVING and this pane can no longer say that it is. No `organizesHere`
     * gate, unlike the absence rule above: a roster that NAMED this row proves the engine holds a
     * connection for it, so the silence since is this row's own news. */
    if (r && reachStale(reach, now)) return say(t("desktopStateUnknown"));
    if (m.organizerRole === "reader") return say(t("stateReading"));
    if (m.syncBlockedSince) return say(t("desktopStatePaused"));
    if (m.lastSyncAt === null) return say(t("desktopStateFirstOpen"));
    if (m.initialImportCompletedAt === null) return say(t("desktopStateCatchingUp"));
    return say(t("desktopStateUpToDate"));
  };

  /**
   * WHO ORGANIZES THIS MAILBOX, AND THE ONE VERB THAT CHANGES IT — for one row, permanently.
   *
   * A closure inside the component rather than a module function, on the rule the rest of this
   * pane follows: it reads the pane's translator, its `reclaimed`/`reclaiming` records and its
   * confirm state, and there is nothing to share it with.
   *
   * It renders UNDER the row it is about, which is the change multi-mailbox forced. The row
   * answers "is my mail coming down?"; this answers the other question somebody with two machines
   * has — which machine files it — and it never goes away. That is the division of labour with
   * the quiet line above the Ohbox: that one says what CHANGED, once, and disappears; this is the
   * standing record, with the controls beside it.
   *
   * ── THREE STATES, ONE SHAPE ───────────────────────────────────────────────────────────────
   *
   *  · ORGANIZING HERE — the ordinary state on a standalone install. Its verb is the release:
   *    stop filing this mailbox, keep every message where it is, and let any install take it.
   *  · READING ONLY — somebody else holds it. Its verb is the takeover.
   *  · NOBODY — this install let it go, or the holder vanished. Its verb is the takeover again,
   *    and here it is the primary one, because nothing is filing the mailbox at all.
   *
   * ONE CHIP for all three, with the verb beside it. The chip's caption is the fact; the sentence
   * that says since when and what this computer does is the chip's accessible DESCRIPTION, opened
   * beside it on hover, focus or a press (the `Gloss` primitive in its caption form). It used to
   * be a `SettingsBanner` — a boxed label, the sentence in full and the verb — under every row,
   * which spent three lines per mailbox on a sentence a person reads once. Told apart by how loud
   * the chip is rather than by three constructions — a tint under EVERY row would mean nothing,
   * so the ordinary state wears a hairline and the two exceptions wear the wash.
   *
   * ── AND THE CONSEQUENCE IS STATED BEFORE THE PRESS, NOT AFTER IT ──────────────────────────
   *
   * Both verbs open a well under the chip line with one sentence in it and the confirm underneath.
   * Handing a mailbox between machines is the one act on this pane that changes what another
   * computer does, and the sentence is what makes the press a decision rather than a discovery.
   * The verb is withheld while the well is open, so there is exactly one place to answer. The
   * stop verb carries a (i) of its own as well, for the person who has not pressed yet: what this
   * computer does from its next pass, and that nothing takes the mailbox over until another
   * install asks for it.
   */
  const organizerBlock = (m: MailboxFacts): ReactNode => {
    /* WHAT THIS ROW IS, in the vocabulary the block renders. `released` is not merely "reader
       with no holder": a mailbox nobody has ever agreed to organize is a fresh connection whose
       next screen is the agreement, and putting "nothing organizes this" over it would be a
       sentence about a state it was never in. `claimable` keeps that rule.

       ── AND "HOLDER" IS THE OBJECT'S PRESENCE, NOT `kind || name` ────────────────────────────
       This read `Boolean(m.organizedBy && (m.organizedBy.kind || m.organizedBy.name))`, so an
       `organizedBy` OBJECT whose `kind` and `name` are both empty — a peek that read a lease it
       could not attribute, a claim written before those columns — was classified `released`, and
       this pane said "Nothing organizes this mailbox" over a row that has a holder record while
       the browser's rows said "Organized by another install" for the same wire. The holder
       columns travel together and the projection emits the object only when one of them was
       written (`mailbox-service.ts`, the `organizedBy` field: "NULL as a whole when nothing is
       named, rather than an object of three nulls"), so the object's PRESENCE is the recorded
       -holder fact, and `readerHolder` is the one place that says so.

       NOT the routing predicate. `deriveOnboardingStep`'s row 3 keeps its own `kind || name`
       test on purpose — it decides whether to put a whole SCREEN in front of somebody, and its
       comment argues that case. This decides which of three sentences is true on a row that is
       already on screen. Same fact, two questions, and only this one was disagreeing with the
       browser. */
    const holder = readerHolder(m.organizedBy) !== "nobody";
    /* THE LEGACY ARM IS TESTED BEFORE THE HOLDER, and getting that order wrong is not cosmetic.
       A pre-role engine records a stand-down as `disabled` + a reason and carries NO holder
       columns at all, so it looks exactly like a mailbox nobody organizes — and it is the
       opposite: something else took it. Reading it as `released` would put "nothing organizes
       this mailbox" over a row whose own state column says it was handed over, and would lose the
       one sentence that says the frozen install is not even reading it. */
    const role: "organizer" | "reader" | "released" =
      !claimable(m) ? "organizer"
        : m.legacyStandDown === true || holder ? "reader" : "released";
    /* THE RELEASE IS A STANDALONE-DOOR CONTROL. On the hosted door these rows are a mirror of an
       account whose organizing is the service's, and the browser's own pane is where that is
       given up — offering it here would be a second door onto one decision, with this one unable
       to report what the account's worker then did. */
    const offerRelease = !cloud && role === "organizer" && m.status !== "disabled"
      && Boolean(m.organizeConsentedAt);
    /* ── THE BLOCK CARRIES A STANDING ASK EVEN WHERE IT CARRIES NO CONTROL ────────────────────
     *
     * This read `if (role === "organizer" && !offerRelease) return null`, and the consent stamp
     * inside `offerRelease` is what made that a false state rather than a withheld control. Two
     * shapes reach it: an install promoted by the gate's own pass, which writes the role and not
     * the stamp (`engine.ts`, the promotion arm), and a row from before the column existed, whose
     * `organizer_role` took the migration's `organizer` default. Both organize the mailbox; both
     * can be asked to stop through another door; and on both the whole banner vanished, so a
     * standing request showed nowhere at all and the row read as an ordinary organized mailbox
     * with nothing pending. MEASURED on a release build, on a stop pressed while the link was cut.
     *
     * The ask is a FACT about the row and the release is a CONTROL, and only the control needs
     * the stamp — the route refuses a release the consent never authorized, so offering one here
     * would be a button whose press cannot work. So the exception is exactly one fact wide: the
     * block renders when there is something standing to say, and `action` below still withholds
     * the verb on a row that carries the request. */
    /* THE DTO'S OWN ROLE, never the derived one. `role` above answers `organizer` for anything
       `claimable` refuses, and `claimable` refuses EVERY row on the hosted door — so a hosted row
       the wire calls a `reader` was reclassified here, and a retained release stamp on it made
       this block say "Organizing · Stopping on the next pass" about the service's organizer. The
       stamp can outlive the role that wrote it (a local install organizes, a stop is asked for,
       the row goes back to being organized in the cloud), and a stamp is not an authority on who
       organizes anything: it says a request was made, and the ROLE says whose it was. A reader
       row with a stamp renders as a reader here and offers nothing. */
    const pendingStop = m.organizerRole !== "reader" && Boolean(m.releaseRequestedAt);
    if (role === "organizer" && !offerRelease && !pendingStop) return null;

    const open = claimFor === m.id;
    const releasing = releaseFor === m.id;
    /* ── THE STOP, ASKED FOR AND THEN STANDING — two clocks, one chip ──────────────────────────
       This window's own "requested" note used to render as a verdict line under the banner while
       the banner still read "Organizing"; a poll later the row's request stamp replaced the
       banner's sentence. They are the same fact on two clocks — the press made here, then the
       server's confirmation — so both wear one chip that reads "Stopping", and its sentence says
       which clock it is on. The conditions are the note's and the description's, unchanged: the
       note's while the row has not yet answered (`released` says requested, the role is still
       organizer, no stamp on the row); the row's own once the stamp is there. */
    /* No `!takeoverStanding(m)` term here, and its absence is measured rather than assumed: a
       `reclaimed` entry is written only by `reclaim()`, which now deletes this row's `released`
       entry in the same statement, so "a stop note standing while a takeover made here stands" is
       unreachable. Removing the term changed no answer in 113 rows — a condition no fixture can
       make matter reads as a guarantee to the next author. The map delete is the whole fix; a
       reopen clears the map, which is why nothing durable is needed. */
    const stopQueued = released.get(m.id) === "requested" && role === "organizer"
      && !m.releaseRequestedAt;
    const stopState: "queued" | "pending" | undefined =
      stopQueued ? "queued" : role === "organizer" && m.releaseRequestedAt ? "pending" : undefined;
    /* THE CHIP'S LABEL, computed once: it is the chip's caption AND the text of the live node
       beside the chip (below), and the two must never disagree. */
    const chipLabel =
      role === "organizer"
        ? (stopState ? t("chipStopping") : t("stateOrganizing"))
        /* A legacy row carries no holder columns at all — the pre-role engine recorded only
           `disabled_reason` — so there is no name to put in `readerLabel`. */
        : m.legacyStandDown === true
          ? t("readerLabelLegacy")
          : role === "released"
            ? t("stateNotOrganized")
            : t("readerLabel", { name: holderOf(m) });
    return (
      <div className="mbx-org" data-role={role} data-state={stopState}>
        <div className="mbx-role">
        {/* THE CHIP IS THE (i). One button: its caption is the role's label, the sentence that
            stood under the label is its accessible description, and hover, focus or a press opens
            that sentence beside it. The banner rendered label and sentence as two sibling text
            nodes inside one note, and on Linux a reader of the accessibility tree heard the label
            and never the sentence; `aria-describedby` is what a reader computes a description
            from, and the primitive sets it from the caption. */}
        <Gloss
          className="mbx-chip"
          placement="chip"
          caption={chipLabel}
          text={
            role === "organizer"
              /* ── A STANDING STOP REQUEST IS ON THE ROW, NOT ONLY IN A LOG (0.14.1) ─────────
                 The request is honoured by the engine's own next pass, and on a server that keeps
                 refusing the confirmation that pass retries per poll — measured live: a whole
                 session of retries with this row reading "files this mailbox" throughout, so the
                 press showed no trace anywhere. While the request stands the row is still an
                 ORGANIZER and deliberately files nothing, so the ordinary sentence is false in
                 both halves; the pending one names the actual state. Before the row carries the
                 stamp, this window's own press is the newest word — see `stopQueued`. */
              ? (stopQueued
                ? t("stopOrganizingQueued")
                : m.releaseRequestedAt
                  ? t("stopOrganizingPending")
                  : t("stateOrganizingHere"))
              : role === "released"
                /* THE ONE SENTENCE THAT DATES SOMETHING THE PERSON HERE DID. A mailbox whose
                   holder simply vanished and one this install released look identical from every
                   other column; only `organizerReleasedAt` tells them apart, and only the second
                   is worth a sentence in the second person. Absent — an engine that predates the
                   column — falls back to the holder-less reader line rather than inventing a
                   date. */
                ? (m.organizerReleasedAt
                  ? t("stateReleased", { when: day(m.organizerReleasedAt) })
                  /* ── NO HOLDER MEANS NO DATE LINE, AND THIS ROW PRINTED ONE ANYWAY ──────
                     MEASURED on the released build, on a mailbox connected here and never
                     agreed to: the four holder columns are unwritten, so `day(null)` is an em
                     dash and the row read *"Since —. This computer reads the mailbox; it moves
                     nothing and screens nothing"*. Both halves were wrong for this state — a
                     date the row does not have, and a sentence that stops one clause before the
                     fact somebody here needs, which is that nothing is organizing the mailbox
                     and which press changes that.

                     UNCONDITIONAL, and it was a `readerHolder(...) === "nobody"` test until the
                     classification above started using the same helper. `released` now MEANS no
                     holder was recorded — that is the one thing it is — so the other side of that
                     test could not be reached by any row, and a condition whose contrary state
                     cannot occur is read by the next person as a guarantee the code is keeping.
                     A row that carries a `since` and nothing else IS a holder now, is classified
                     `reader` above, and keeps its dated sentence there. */
                  : t("readerNobodyReads"))
              /* ── A LEGACY STAND-DOWN IS FROZEN, AND SAYING IT READS WOULD CONTRADICT ITS OWN ROW ──
                 The modern reader is CONNECTED AND SYNCING, which is what every sentence below is
                 about. A pre-role engine's stand-down did the opposite: it closed the IMAP handle and
                 stopped the poll timer, so that row is not reading anything — and its own state
                 column says "Handed over to another install" three lines to the right. It also needs
                 the restart, which the sentence says, because that engine spends the stamp at its
                 next process assembly rather than on a tick. */
              : m.legacyStandDown === true
                ? t("readerLegacyStandDown")
                : m.organizerState === "stopped"
                /* NO AGE, because there is no timestamp that would make one true. It said "last
                   checked in {when}" and was handed `organizedBy.since` — which is when that install
                   BECAME the organizer, and the heartbeat is deliberately not persisted. A holder
                   that organized for eight months and stopped this morning was reported absent for
                   eight months. The fact worth stating is that it stopped. */
                ? t("readerStopped", { name: holderOf(m) })
                /* ── NO DATE LINE WITHOUT A DATE, and the em dash is why this arm exists ───────
                   `day(null)` is "—" deliberately: these strings are interpolated into sentences
                   and `format.ts` argues that a dash reads better than "Invalid Date". That is
                   right for a stamp somebody hovers and wrong for the one clause that PROMISES a
                   date — a real holder whose `since` column was never written announced "Since —
                   · ohmail Cloud", which reads as a fault in the mailbox. Every arm below opens
                   with the date, so with no date there is nothing for any of them to open with,
                   and the holder's name is not lost with it: the label carries it.

                   ABOVE the kind and BELOW `readerStopped`, which carries no date by design and
                   would lose its own sentence to this one. The browser's two reader surfaces
                   select the same arm in the same position, from the same key. */
                : !m.organizedBy?.since
                ? t("readerReadsOnly")
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
        />
        {/* ── THE PRESS IS ANNOUNCED ────────────────────────────────────────────────────────────
            The "asked for" note used to be a verdict with a live region, so a screen reader heard
            the stop's answer at the press. The chip carries that answer now, and a caption inside
            a button cannot be a live region — a button's descendants are presentational, and its
            card would be announced a second time each time it opened. So the chip's LABEL is
            repeated here in a polite live node a sighted person never sees: silent at rest, it
            speaks when the label moves — "Stopping" at the press, then the role the row settles
            into. The same `chipLabel`, so it cannot say something the chip does not. */}
        <span className="mbx-say" role="status">{chipLabel}</span>
        {/* THE VERB, WITHHELD WHILE ITS OWN WELL IS OPEN — one place to answer, and no button
            that re-asks a question already on screen.

            THE TAKEOVER'S BUTTON IS ALWAYS OFFERED NOW, and the arithmetic that used to hide it
            is gone with the rule it rested on. A press used to be refusable by the lease on the
            holder's KIND, so the pane tracked whether a request had been made and whether it had
            been blocked, to keep the retry reachable in the case where the answer said "come back
            later". Kind no longer ranks: an explicit press outranks a claim that carries none,
            and the holder stands down on its next pass. There is no blocked case to keep a
            retry reachable for, so `reclaimed` gates the button and nothing else does. */}
        {open || releasing ? null
          : role === "organizer" ? (
            /* ── THE COUNTERMAND, WHICH HAD NO DOOR ────────────────────────────────────────
               While the row carries the request, the STOP verb is withheld — it would write the
               very ask the chip says is being carried out — and until now nothing stood in its
               place, so the engine's "stop, then organize here before the release lands" arm was
               unreachable from the product. The takeover is what reaches it: the door admits an
               organizer row with a pending release (it is `already_organizing` only when the
               request is null) and stamps the authorization the engine's release arm compares
               against, so the later press stands and nothing is recorded as released. */
            m.releaseRequestedAt ? (
              <span className="mbx-verb">
                <Button className="mbx-btn" onClick={() => setClaimFor(m.id)}>{t("organizeHere")}</Button>
                <Gloss placement="chip" text={t("organizeHereCountermandWhat")} />
              </span>
            ) : (
              <span className="mbx-verb">
                <Button variant="ghost" className="mbx-quiet" onClick={() => setReleaseFor(m.id)}>
                  {t("stopOrganizingHandBack")}
                </Button>
                {/* WHAT FOLLOWS THE PRESS, for the person who has not made it: this computer
                    goes on reading and stops filing — moves nothing, screens nothing, applies
                    none of the rules — and NOTHING takes the mailbox over by itself; another
                    install has to press Organize here. The verb hands the mailbox back, to be
                    taken; it never promises a hand-over that happens. The confirm well under it
                    says what stays where it is, which is the other half of the same decision. */}
                <Gloss placement="chip" text={t("stopOrganizingHandBackWhat")} />
              </span>
            )
          ) : takeoverStanding(m) ? null : (
            <Button
              className="mbx-btn"
              variant={role === "released" ? "primary" : undefined}
              onClick={() => setClaimFor(m.id)}
            >
              {/* ── "INSTEAD" NEEDS SOMETHING TO BE INSTEAD OF ────────────────────────
                  One key served both states and its words were written for the one with a
                  holder, so a row nothing organizes offered an alternative to nobody — while
                  its own sentence two lines up names the press as "Organize here". The
                  catalogue and the button disagreed on one screen. The browser pane's only
                  call site is its released row, so `organizeHere` keeps the plain wording it
                  always should have had there and the takeover gets its own key. */}
              {role === "released" ? t("organizeHere") : t("organizeHereInstead")}
            </Button>
          )}
        </div>
        {/* AND WHY A DECISION CANNOT BE MADE HERE, on the mailboxes where the answer is the
            sign-in rather than a version somebody can update. A password mailbox lets both
            installs derive the same signing key from the credential they already share; an OAuth
            one has no such shared secret. Only on a reader row — on a mailbox this install
            organizes there is no refusal to explain — and only where the field says so, so a
            build that cannot tell says nothing. */}
        {role !== "organizer" && m.authKind === "oauth" ? (
          <SettingsNote>{t("oauthDecideElsewhere")}</SettingsNote>
        ) : null}
        {/* ── THE HANDOVER, AND WHAT IT COSTS THE OTHER SIDE, BEFORE IT IS TAKEN ──────────────
            The other install is not killed: it becomes a reader on its next pass and keeps its
            copy of the mail. Saying so here is the difference between a button somebody presses
            and one they hesitate over for the wrong reason.

            THE SENTENCE PROMISES WHAT THIS ENGINE WILL DO, and the two engines do different
            things. The modern one says "within a minute" — the gate re-reads the stamp at the top
            of every cycle, so a press on a running install is honoured on the next poll with no
            relaunch. A pre-role engine stops its poll timer at the stand-down and spends the stamp
            at its next process assembly, so on that one the sentence has to say to quit and
            reopen. It also names no holder, because a legacy row carries none. */}
        {open ? (
          <div className="mbx-handover">
            <p className="mbx-handover-what">
              {/* THE WELL NAMES A HOLDER, so a row that has none may not use this sentence: it
                  promises that "{name} stops organizing it on its next pass", and with nothing
                  organizing the mailbox `holderOf` supplies "another install" — a consequence
                  described for a machine that does not exist, one press behind the button this
                  row's own wording was just corrected on. The released arm states what actually
                  happens instead, and names nobody. */}
              {m.legacyStandDown === true
                ? t("organizeHereWhatLegacy")
                : role === "released"
                  ? t("organizeHereWhatNobody")
                  : t("organizeHereWhat", { name: holderOf(m) })}
            </p>
            <SettingsActions>
              <Button
                variant="primary"
                disabled={reclaiming.has(m.id)}
                onClick={() => {
                  setClaimFor(null);
                  reclaim(m.id, m.organizerReleasedAt ?? null);
                }}
              >
                {t("organizeHereConfirm")}
              </Button>
              <Button variant="ghost" onClick={() => setClaimFor(null)}>{t("cancel")}</Button>
            </SettingsActions>
          </div>
        ) : null}
        {/* ── AND THE OTHER DIRECTION, WHICH IS THE ONE THAT WAS MISSING ─────────────────────
            Until this control existed the only way to make an install stop organizing a mailbox
            was to remove the mailbox — which deletes the stored password and stops the mail. The
            sentence's whole job is to say that this is not that: the folders and everything in
            them stay exactly where they are, and any install can take the mailbox afterwards,
            including this one. Nothing about it is destructive, and nothing about it is red. */}
        {releasing ? (
          <div className="mbx-handover">
            <p className="mbx-handover-what">{t("stopOrganizingWhat")}</p>
            <SettingsActions>
              <Button
                variant="primary"
                disabled={releasingIds.has(m.id)}
                onClick={() => {
                  setReleaseFor(null);
                  release(m.id);
                }}
              >
                {t("stopOrganizingConfirm")}
              </Button>
              <Button variant="ghost" onClick={() => setReleaseFor(null)}>{t("cancel")}</Button>
            </SettingsActions>
          </div>
        ) : null}
        {/* WHAT THE ENGINE ANSWERED — and the ROW is what ends it, for real now (0.14.1).
            The comment here used to claim "the row is what ends them" while nothing did: both
            notes rendered on the row's every later state, so "Asked for … within a minute" stood
            beside a release that had finished an hour ago — or had lapsed — which is a promise
            about a clock that has long since run out. Each note now renders only while the row
            has NOT answered: the takeover's while the role is not yet `organizer`; the stop's
            while the role is still `organizer` AND the row does not yet carry the request (once
            it does, the chip's own pending sentence says the same thing from the row's clock,
            which is the one that is true). The stop's note is the CHIP now — see `stopQueued`
            above — so only the "was not organizing" answer still renders as a line here. */}
        {/* `off`, NEVER `wait`. A spinner claims something is in flight, and nothing is: the
            route RECORDS a request and returns. The gate acts on it at its next tick, which may
            be a minute away and is not this window's to watch. And not `ok`
            either: this window has not been told the mailbox moved, and a tick would say it had. */}
        {takeoverStanding(m) ? (
          reclaimed.get(m.id)!.outcome === "authorized" ? (
            role !== "organizer" ? (
              <SettingsVerdict
                state="off"
                headline={m.legacyStandDown === true ? t("organizeHereQueuedLegacy") : t("organizeHereQueued")}
              />
            ) : null
          ) : (
            /* The other three outcomes take the same predicate rather than bare `reclaimed.has`:
               "this mailbox is not here any more" is an answer to a press too, and one that has
               been superseded is as stale as the queued one. */
            <SettingsNote>{t(`desktopOrganizeHere_${reclaimed.get(m.id)!.outcome}`)}</SettingsNote>
          )
        ) : null}
        {released.has(m.id) && released.get(m.id) !== "requested" ? (
          <SettingsNote>{t("stopOrganizingNot")}</SettingsNote>
        ) : null}
      </div>
    );
  };

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
      {/* ONE CARD PER MAILBOX — the row, the quiet role line under it, the wells and the removal
          panel — so the rule between mailboxes runs between cards. The settings grammar draws its
          rules with sibling combinators (`.set-row + .set-row`), which cannot see past the sending
          note and the organizer block that stand between one mailbox's row and the next; the
          browser's pane wraps its rows in `.mbx-entry` for the same reason. */}
      {foldByAddress(facts).map(({ shown, superseded }) => (
        <div className="mbx-card" key={shown.id}>
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
                 (`organizerBlock`); printing "Reading only" here as well would say it twice, once
                 without the half that matters. The hosted door says neither — its rows are a
                 mirror of an account whose organizing is the service's, not this machine's. */
              /* ── CONSENT IS THE CONDITION, NOT THE ROLE ────────────────────────────────────
                 `organizerRole` rests `'organizer'` — the column's default, and the mapper coerces
                 anything that is not literally `"reader"` to it — so the role alone says
                 "Organized on this computer" about a mailbox that has been connected and never
                 agreed to, while nothing is filed and `ohmail/*` does not exist. Reachable from
                 this pane's own Add mailbox: connect, then cancel at the consent screen.
                 `organizeConsentedAt` is the truth-condition and it is already on the facts. */
              organizesHere(shown) ? (
                <>
                  {t("desktopLastChecked", { when: when(shown.lastSyncAt) })}
                  {" · "}
                  {t("desktopRoleOrganizer")}
                </>
              ) : t("desktopLastChecked", { when: when(shown.lastSyncAt) })
            }
            /* THE STATE CELL IS A LIVE REGION. It carries the one fact on the row a person most
               needs — whether the mail server can be reached at all — and it changes on its own,
               from the reach poll. A bare span with text in it is dropped from the accessibility
               tree on Linux, so a reader heard the row's buttons and never this; `role="status"`
               puts it in the tree with its text and announces the change when "Up to date" turns
               into the outage sentence. The ticking stamp stands BESIDE the live node, not inside
               it (see `stateOf`): in the tree as a note, never announced. The text and its place
               in the row are untouched. */
            value={(() => {
              const s = stateOf(shown);
              return (
                <>
                  <span className="mbx-reach" role="status">{s.said}</span>
                  {s.when ? <> <span className="mbx-reach-when" role="note">{s.when}</span></> : null}
                </>
              );
            })()}
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
                 See `claimable` and `organizerBlock`. What stays here is Sync now, withheld on a
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
              On a row this machine organizes it is the release; on every other one it is the fact and
              the way back — see `organizerBlock`. */}
          {organizerBlock(shown)}
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
          {/* THE ANSWER TO A PRESS IS INSIDE `organizerBlock` NOW, under the banner whose verb
              raised it. It used to stand here, three constructions away from the fact it was
              about, and it carried a third arm for a takeover the lease would refuse — a state
              that no longer exists. */}
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
        </div>
      ))}

      {/* THE HAND-OFF, ON THE HOSTED DOOR ONLY. See this file's header for why there is no edit
          form to offer beside the resync above: the account asks for a fresh second factor before
          it will store a mailbox password, and this install cannot assert one. The browser can,
          and is already signed in. A standalone install edits its mailbox on this machine through
          the door chooser and needs none of this. */}
      {/* ── WHERE A MAILBOX IS ACTUALLY MANAGED, per door ─────────────────────────────────
          The hosted door sends somebody to a browser, because the account asks for a fresh second
          factor before it will store a mailbox password and this window cannot assert one.

          THE PAIRED DOOR HAS NOWHERE TO SEND THEM, and saying so is the whole row. "Open
          ohmail.app" here would be a door out to a service this install has no account with, over
          a mailbox that lives on the person's own server — the wrong place twice. There is no
          button because this window cannot open another computer's window; what it can do is name
          the machine and the pane. */}
      {/* NO `{machine}` IN THESE TWO SENTENCES, and the reason is a payload boundary rather than
          a style choice: this pane is in the SERVED host client's import graph
          (`desktop-messages.test.ts` proves it), and the machine's own word — "Mac" / "PC" /
          "computer" — lives in `desktopDoor`, which is window-only. Reading it here would ship
          that whole namespace to a phone loading the served client, or draw raw keys there. The
          plain noun is the honest substitute; every other paired sentence in the WINDOW's own
          panes still says "this Mac". */}
      {paired ? (
        <SettingsRow
          label={t("desktopManageOnHost", { host: host! })}
          description={t("desktopManageOnHostWhy", { host: host! })}
        />
      ) : cloud ? (
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
        /* THE SENTENCE NAMES WHERE THE REST COMES FROM, and on this door that is not "your
           account" — it is the other computer. The promise is the same and it is still true: the
           reach-past doors are served by whatever is on the far side, which here is a host. */
        return held === null ? null : (
          <p className="set-note-inline">
            {paired
              ? t("desktopHoldsCountHost", { count: held.count, total: held.total, host: host! })
              : t("desktopHoldsCount", { count: held.count, total: held.total })}
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

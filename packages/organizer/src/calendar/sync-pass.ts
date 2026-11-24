/**
 * THE CALENDAR'S SYNC: one turn of one connection. In order: the account's binding, the two gates
 * (the account's calendar is on, the provider is served here), the sign-in, the writes owed to the
 * provider, the list of calendars, and each due calendar's reading, in pages, each written in its
 * own short transactions so that a first read never holds the person's mail.
 *
 * Nothing is dialled and nothing is decrypted before both gates said yes. A provider is reached
 * only through the request port it was made with; the rows a turn writes take their account and
 * connection from the turn's key, never from anything a provider answered. A word that waits for
 * the person is written only where the stored sign-in is still the one this turn opened.
 */
import { calendarKey, type ProviderWord } from "@ohmail/cal-providers";
import { and, eq, ne, or, isNull, sql } from "drizzle-orm";
import { calCalendars, calConnections } from "@trafficflow/db";
import { organizerPrincipalAddress, ownOrganizerAddresses, publishCalendarOrganizerChanges } from "@trafficflow/db/calendar";
import { applyListing, mergeDuplicateCalendars, pruneUnlistedCalendars, storedCalendars, type DuplicateCalendar, type StoredCalendar } from "./calendars.js";
import { inConnection, passDb, type ConnectionDb, type ConnectionKey } from "./connection.js";
import { exchangeInvitationPass } from "./exchange-invitations.js";
import { releaseReadings, remember } from "./memory.js";
import { holdCalendar, readCalendar, type ReadingContext, type TurnBudget } from "./reading.js";
import { CalendarKeyRingFault, openPassSignIn, sealedCredentialOf, type PassSignIn } from "./sign-in.js";
import { calendarEnabledAt, holdCalendarUntil, holdConnectionUntil, setConnectionState } from "./state.js";
import type { CalendarSyncDeps, CalendarSyncOutcome, DueConnection } from "./types.js";
import {
  FAILING_FROM, LIST_EVERY_MS, OFF_RECHECK_MS, PAGE_LINK_RESET_AFTER, READING_PLACE_WAIT_MS, TURN_MS, TURN_PAGES, WAIT_DAY_MS, WORD_PLAN,
  actsOnConnection, doublingWait, faultWord, turnOverdue, waitFor, type CalendarSyncFault,
} from "./words.js";

const PROVIDER_WORDS: ReadonlySet<string> = new Set<ProviderWord>(["google", "caldav", "microsoft", "ics"]);
export const isProviderWord = (word: string): word is ProviderWord => PROVIDER_WORDS.has(word);

/** One more failure in a row of `id`, and how many that makes. */
function failed(deps: CalendarSyncDeps, id: string): number {
  const n = (deps.memory.failures.get(id) ?? 0) + 1;
  remember(deps.memory.failures, id, n);
  return n;
}

/**
 * One connection's turn. `signal` ends with the worker's stop, or with the reason
 * `CalendarTurnOverdue` when the turn's own time ran out: the first writes nothing (`halted`), the
 * second is said on the connection as `timeout` and waited out like any other.
 *
 * A fault of this program or of the store is thrown, as a crash would end the turn; whoever runs
 * turns says it on the row with {@link calendarTurnFailed}.
 */
export async function calendarSyncPass(deps: CalendarSyncDeps, c: DueConnection, signal: AbortSignal): Promise<CalendarSyncOutcome> {
  let readsOn = false;
  try {
    const outcome = await turnOf(deps, c, signal);
    readsOn = (outcome.kind === "synced" && outcome.more) || outcome.kind === "halted";
    return outcome;
  } finally {
    // Only a connection that reads on at once keeps a reading from this turn to the next: one that waits holds no place.
    if (!readsOn) releaseReadings(deps.memory, c.id);
  }
}

async function openMoveDestination(
  deps: CalendarSyncDeps, db: ConnectionDb, calendarId: string, source: ConnectionKey, signIn: PassSignIn,
) {
  const destination = await inConnection(db, source, async ({ tx }) => {
    const [row] = await tx.select({ connectionId: calCalendars.connectionId }).from(calCalendars)
      .where(and(eq(calCalendars.accountId, source.accountId), eq(calCalendars.id, calendarId), eq(calCalendars.access, "owner"))).limit(1);
    return row ?? null;
  });
  if (destination === "gone" || !destination) return null;
  const key = { accountId: source.accountId, id: destination.connectionId };
  const gate = await inConnection(db, key, async ({ tx, held }) => {
    if (!isProviderWord(held.provider) || held.provider === "ics" || await calendarEnabledAt(tx, key.accountId) === null) return null;
    const [calendar] = await tx.select({ id: calCalendars.providerId }).from(calCalendars).where(and(
      eq(calCalendars.accountId, key.accountId), eq(calCalendars.connectionId, key.id), eq(calCalendars.id, calendarId),
      eq(calCalendars.access, "owner"),
    )).limit(1);
    const provider = deps.providers.get(held.provider);
    return calendar && provider?.writer?.readForMove ? {
      held, calendar, word: held.provider, provider,
      sealed: key.id === source.id ? null : await sealedCredentialOf(tx, key, held.provider),
    } : null;
  });
  if (gate === "gone" || !gate || !gate.provider.writer) return null;
  if (key.id === source.id) return { writer: gate.provider.writer, cal: gate.calendar, connection: signIn.connection,
    markDue: () => markMoveDue(db, key, calendarId, deps.clock.now()) };
  const opened = await openPassSignIn(deps, { db, key }, gate.sealed, gate.held, gate.word, gate.provider);
  if (!opened.ok) return null;
  return { writer: gate.provider.writer, cal: gate.calendar, connection: opened.signIn.connection,
    markDue: () => markMoveDue(db, key, calendarId, deps.clock.now()),
  };
}

async function markMoveDue(db: ConnectionDb, key: ConnectionKey, calendarId: string, now: number) {
  await inConnection(db, key, async ({ tx, held }) => {
    if (held.status === "active" && held.errorCode === null) {
      await holdConnectionUntil(tx, key, new Date(now));
      await holdCalendarUntil(tx, key, calendarId, new Date(now));
    }
  });
}

async function turnOf(deps: CalendarSyncDeps, c: DueConnection, signal: AbortSignal): Promise<CalendarSyncOutcome> {
  const db = passDb(deps.db, c.accountId);
  const key: ConnectionKey = { accountId: c.accountId, id: c.id };
  /** The worker is stopping. A call its stop ended answers `timeout` like a late one: that word is never written. */
  const stopping = (): boolean => deps.halted() || (signal.aborted && !turnOverdue(signal));
  if (stopping()) return { kind: "halted" };

  const word = isProviderWord(c.provider) ? c.provider : null;
  const provider = word === null ? null : deps.providers.get(word);
  const gate = await inConnection(db, key, async ({ tx, held }) => {
    const on = await calendarEnabledAt(tx, key.accountId);
    if (on === null || word === null || provider === null) {
      await holdConnectionUntil(tx, key, new Date(deps.clock.now() + OFF_RECHECK_MS));
      if (on === null) return { kind: "calendar_off" as const };
      // Said on the connection, so the person sees why it is not read; no request was made.
      await setConnectionState(tx, key, held, { status: held.status, errorCode: "provider_off", synced: false });
      return { kind: "provider_off" as const };
    }
    return {
      kind: "open" as const, held,
      sealed: await sealedCredentialOf(tx, key, word),
      calendars: await storedCalendars(tx, key),
      own: await ownOrganizerAddresses(tx, key.accountId, held.principal),
    };
  }, { lock: "no key update" });
  if (gate === "gone") return { kind: "gone" };
  if (gate.kind !== "open") return { kind: "off", why: gate.kind };
  // Both gates said yes: the word and the provider are known from here on.
  const w = word!;
  const p = provider!;

  const opened = await openPassSignIn(deps, { db, key }, gate.sealed, gate.held, w, p);
  if (!opened.ok) return settleConnection(deps, db, key, null, opened.word, null);
  const signIn = opened.signIn;

  let changed = 0;
  let calendars = gate.calendars;
  let missing: readonly string[] | null = null;
  /** The provider answered a calendar listing this turn, even if the list was empty. */
  let freshList = false;
  let duplicates: readonly DuplicateCalendar[] = [];
  const listingContext = { db, key, memory: deps.memory, halted: deps.halted };
  const listedAt = deps.memory.listedAt.get(key.id) ?? Number.NEGATIVE_INFINITY;
  // A subscription is one calendar whose id never changes, and listing it fetches its whole file: it is
  // listed once, while it has no row, and from then on asked only as often as the file itself wishes.
  const listsAgain = w !== "ics" && deps.clock.now() - listedAt >= LIST_EVERY_MS;
  if (w === "caldav" && (listsAgain || gate.held.organizerAddresses === null)) {
    const identity = await p.reader.checkSignIn(signIn.connection, signal);
    if (stopping()) return { kind: "halted" };
    if (signIn.superseded()) return { kind: "superseded" };
    // Withdraw cached aliases if a new discovery is ambiguous or cannot bind the principal.
    if (!identity.ok && identity.reason !== "unreadable" && identity.reason !== "no_service")
      return settleConnection(deps, db, key, signIn, identity.reason, identity.retryAfterMs);
    const addresses = !identity.ok || identity.value.principal === null ? [] : [...new Set(identity.value.addresses.flatMap((value) => {
      const address = organizerPrincipalAddress(value);
      return address && address.length <= 254 && !/[\s<>?,]/.test(address) ? [address] : [];
    }))].sort().slice(0, 32);
    const refreshed = await inConnection(db, key, async ({ tx, held }) => {
      if (!await signIn.stillStored(tx)) return "superseded";
      if (JSON.stringify(held.organizerAddresses) !== JSON.stringify(addresses)) {
        await tx.update(calConnections).set({ organizerAddresses: addresses })
          .where(and(eq(calConnections.accountId, key.accountId), eq(calConnections.id, key.id)));
        await publishCalendarOrganizerChanges(tx, key.accountId, key.id, held.organizerAddresses ?? [], addresses);
      }
      return "kept";
    }, { lock: "no key update" });
    if (refreshed !== "kept") return { kind: refreshed };
    if (!identity.ok) return settleConnection(deps, db, key, signIn, identity.reason, identity.retryAfterMs);
  }
  if (calendars.length === 0 || listsAgain) {
    const listed = await p.reader.listCalendars(signIn.connection, signal);
    if (stopping()) return { kind: "halted" };
    if (signIn.superseded()) return { kind: "superseded" };
    if (!listed.ok) return settleConnection(deps, db, key, signIn, listed.reason, listed.retryAfterMs);
    const applied = await applyListing(listingContext, listed.value, calendars, (id) => calendarKey(w, id));
    if (!applied.ok) return { kind: applied.why };
    remember(deps.memory.listedAt, key.id, deps.clock.now());
    freshList = true;
    changed += applied.changed;
    missing = applied.missing;
    duplicates = applied.duplicates;
  }

  // A due listing refreshes access before the drain checks each queued write.
  let drainNext: Date | null = null;
  if (deps.drainWrites !== undefined) {
    const drained = await deps.drainWrites({ db, key, provider: p, connection: signIn.connection, signal, moveDestination: (calendarId) => openMoveDestination(deps, db, calendarId, key, signIn) });
    const asked = drained.nextAttemptAt;
    // A time no clock holds would make this turn's settle throw, every turn: such an answer asks for nothing.
    drainNext = asked !== null && Number.isFinite(asked.getTime()) ? asked : null;
    if (stopping()) return { kind: "halted" };
    if (turnOverdue(signal)) return settleConnection(deps, db, key, signIn, "timeout", null);
    // The provider asked a write to wait: nothing more of the connection is asked before that has passed, its readings neither.
    if (drained.wait !== undefined) return settleConnection(deps, db, key, signIn, drained.wait.word, drained.wait.retryAfterMs);
  }

  if (missing !== null) {
    const merged = await mergeDuplicateCalendars(listingContext, duplicates);
    if (!merged.ok) return { kind: merged.why };
    changed += merged.changed;
    const pruned = await pruneUnlistedCalendars(listingContext, missing);
    if (!pruned.ok) return { kind: pruned.why };
    changed += pruned.changed;
    const again = await inConnection(db, key, ({ tx }) => storedCalendars(tx, key));
    if (again === "gone") return { kind: "gone" };
    calendars = again;
  }

  const turn = deps.turn ?? { pages: TURN_PAGES, ms: TURN_MS };
  const budget: TurnBudget = { pagesLeft: turn.pages, deadline: deps.clock.now() + turn.ms };
  const reading: ReadingContext = {
    deps, db, key, word: w, provider: p, signIn, signal, budget, map: { zones: deps.zones, ownAddresses: gate.own, principal: gate.held.principal },
  };
  let pages = 0;
  let dropped = 0;
  let read = 0;
  let more = false;
  /** A calendar's reading found no place to be kept: it stays due, and the connection looks again shortly. */
  let crowded = false;
  for (const cal of calendars) {
    if (cal.errorCode === "ended") continue;
    const open = deps.memory.readings.has(cal.id);
    if (!open && cal.nextPollAt !== null && cal.nextPollAt.getTime() > deps.clock.now()) continue;
    if (stopping()) return { kind: "halted" };
    if (turnOverdue(signal)) return settleConnection(deps, db, key, signIn, "timeout", null);
    if (budget.pagesLeft <= 0 || deps.clock.now() >= budget.deadline) {
      more = true;
      break;
    }
    const r = await readCalendar(reading, cal);
    if (r.kind === "gone" || r.kind === "halted" || r.kind === "superseded") return { kind: r.kind };
    pages += r.pages;
    changed += r.changed;
    if (r.kind === "more") {
      more = true;
      break;
    }
    if (r.kind === "no_place") {
      crowded = true;
      continue;
    }
    if (r.kind === "done") {
      read += 1;
      dropped += r.dropped;
      deps.memory.failures.delete(`calendar:${cal.id}`);
      deps.memory.failures.delete(`host:${cal.id}`);
      continue;
    }
    if (actsOnConnection(r.word, w)) {
      if (w === "ics" && r.word === "ended") await holdCalendar(db, key, cal, "ended", new Date(deps.clock.now() + WAIT_DAY_MS));
      const retryHost = w === "caldav" && r.word === "host_changed" && r.continuing === true;
      return settleConnection(deps, db, key, signIn, r.word, r.retryAfterMs, retryHost ? cal.id : null);
    }
    if (await settleCalendar(deps, db, key, cal, r.word, r.retryAfterMs) === "gone") return { kind: "gone" };
  }

  const settled = await inConnection(db, key, async ({ tx, held }) => {
    const [next] = await tx.select({ at: sql<number | null>`floor(extract(epoch from min(coalesce(${calCalendars.nextPollAt}, now()))) * 1000)` })
      .from(calCalendars)
      .where(and(eq(calCalendars.accountId, key.accountId), eq(calCalendars.connectionId, key.id),
        or(isNull(calCalendars.errorCode), ne(calCalendars.errorCode, "ended"))));
    const nowMs = deps.clock.now();
    let at = next?.at === null || next?.at === undefined ? nowMs + LIST_EVERY_MS : Number(next.at);
    if (drainNext !== null) at = Math.min(at, drainNext.getTime());
    // Someone asked for this connection while the turn ran (a press's wake after its drain, a retry): kept, never written over.
    const asked = held.nextPollAt?.getTime() ?? null;
    if (asked !== (gate.held.nextPollAt?.getTime() ?? null)) at = Math.min(at, asked ?? nowMs);
    if (more) at = nowMs;
    else if (crowded) at = Math.max(at, nowMs + READING_PLACE_WAIT_MS);
    at = Math.max(at, nowMs);
    // The listing is asked again within the hour whatever the calendars say; a subscription has no listing to ask for.
    if (w !== "ics") at = Math.min(at, (deps.memory.listedAt.get(key.id) ?? nowMs) + LIST_EVERY_MS);
    await holdConnectionUntil(tx, key, new Date(at));
    await setConnectionState(tx, key, held, { status: "active", errorCode: null, synced: freshList || read > 0 });
  }, { lock: "no key update" });
  if (settled === "gone") return { kind: "gone" };
  deps.memory.failures.delete(key.id);

  // Invitations that came as an Outlook Web App link are looked up in this connection's own calendar.
  // What it finds or fails at is no part of the turn's outcome.
  if (!more && p.invitations !== undefined && !stopping()) {
    try {
      await exchangeInvitationPass({
        db, key, provider: p, connection: signIn.connection, memory: deps.memory, zones: deps.zones,
        now: () => deps.clock.now(), signal, log: deps.log,
      });
    } catch (err) {
      deps.log.warn("calendar_exchange_invitations_failed", { accountId: key.accountId, err });
    }
  }

  if (!more && deps.notices !== undefined && read > 0) {
    const live = calendars.filter((cal) => cal.errorCode !== "ended").map((cal) => ({ id: cal.id, providerId: cal.providerId }));
    await deps.notices({ db, key, provider: p, connection: signIn.connection, calendars: live, signal });
  }
  return { kind: "synced", calendars: read, pages, changed, dropped, more };
}

/**
 * A word that acts on the whole connection, written, and the turn's end. A word that waits for
 * the person is written only where the stored sign-in is still the one this turn opened; a refusal
 * of this deployment's own registration in a trade waits for time, never for the person.
 */
async function settleConnection(
  deps: CalendarSyncDeps, db: ConnectionDb, key: ConnectionKey, signIn: PassSignIn | null, reason: string, retryAfterMs: number | null,
  retryHostFor: string | null = null,
): Promise<CalendarSyncOutcome> {
  const fault = faultWord(reason);
  const fromTrade = signIn?.tradeRefusal()?.reason === fault;
  let act = WORD_PLAN[fault];
  if (fromTrade && fault === "sign_in_refused") act = "retry";
  if (act === "calendar_day" || act === "calendar_retry") act = "connection_day";
  const now = deps.clock.now();
  const outcome = await inConnection(db, key, async ({ tx, held }): Promise<CalendarSyncOutcome> => {
    if (act === "reconnect" || act === "ended") {
      if (signIn !== null && !(await signIn.stillStored(tx))) return { kind: "superseded" };
      await holdConnectionUntil(tx, key, new Date(now + WAIT_DAY_MS));
      await setConnectionState(tx, key, held, { status: "reconnect", errorCode: fault, synced: false });
      return { kind: "stopped", word: fault };
    }
    if (act === "off") {
      await holdConnectionUntil(tx, key, new Date(now + OFF_RECHECK_MS));
      await setConnectionState(tx, key, held, { status: held.status, errorCode: fault, synced: false });
      return { kind: "off", why: "provider_off" };
    }
    // A first page can succeed every time a refused continuation starts over.
    const retryHost = retryHostFor !== null;
    const failures = retryHost ? failed(deps, `host:${retryHostFor}`) : act === "retry" ? failed(deps, key.id) : FAILING_FROM;
    const until = now + (retryHost && failures < FAILING_FROM ? doublingWait(failures) : waitFor(fault, failures, retryAfterMs));
    await holdConnectionUntil(tx, key, new Date(until));
    await setConnectionState(tx, key, held, {
      status: failures >= FAILING_FROM ? "failing" : held.status, errorCode: fault, synced: false,
    });
    return { kind: "backed_off", word: fault, untilMs: until };
  }, { lock: "no key update" });
  return outcome === "gone" ? { kind: "gone" } : outcome;
}

/** A word that acts on one calendar: its copy stays, its word is shown, and it waits. */
async function settleCalendar(
  deps: CalendarSyncDeps, db: ConnectionDb, key: ConnectionKey, cal: StoredCalendar, word: CalendarSyncFault, retryAfterMs: number | null,
): Promise<"gone" | void> {
  const act = WORD_PLAN[word];
  const now = deps.clock.now();
  if (act === "ended") return holdCalendar(db, key, cal, "ended", new Date(now + WAIT_DAY_MS));
  if (act === "calendar_retry") {
    const n = failed(deps, `calendar:${cal.id}`);
    // A provider's page link refused again and again, or a token it no longer knows: read from no token.
    const reset = word === "token_gone" || (word === "page_link_refused" && n >= PAGE_LINK_RESET_AFTER);
    if (reset && word === "page_link_refused") deps.memory.failures.delete(`calendar:${cal.id}`);
    return holdCalendar(db, key, cal, word, new Date(now + waitFor(word, n, retryAfterMs)), { resetToken: reset });
  }
  return holdCalendar(db, key, cal, word, new Date(now + waitFor(word, 1, retryAfterMs)));
}

/**
 * A TURN THAT THREW, said on its row, so that a connection nobody can read is seen and the roster
 * stops handing it over every tick. A fault of this program or of the store is nobody's sign-in:
 * the connection reads `unknown` and waits, doubling, `failing` from the third in a row. A key ring
 * that could not open the sign-in is the host's: the row waits and says nothing.
 *
 * Returns when the connection is asked again, or `null` where it is no longer there. It can throw
 * where the store itself is what failed; the caller then keeps the wait in its own memory.
 */
export async function calendarTurnFailed(deps: CalendarSyncDeps, c: DueConnection, err: unknown): Promise<number | null> {
  const db = passDb(deps.db, c.accountId);
  const key: ConnectionKey = { accountId: c.accountId, id: c.id };
  if (err instanceof CalendarKeyRingFault) {
    const until = deps.clock.now() + doublingWait(failed(deps, key.id));
    const held = await inConnection(db, key, ({ tx }) => holdConnectionUntil(tx, key, new Date(until)), { lock: "no key update" });
    return held === "gone" ? null : until;
  }
  const outcome = await settleConnection(deps, db, key, null, "unknown", null);
  return outcome.kind === "backed_off" ? outcome.untilMs : null;
}

/** A parked account's connection is looked at again at `until`, through its own binding; nothing a person sees moves. */
export async function parkConnection(pool: CalendarSyncDeps["db"], c: DueConnection, until: Date): Promise<void> {
  const key: ConnectionKey = { accountId: c.accountId, id: c.id };
  await inConnection(passDb(pool, c.accountId), key, ({ tx }) => holdConnectionUntil(tx, key, until), { lock: "no key update" });
}

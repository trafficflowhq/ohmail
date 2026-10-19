import {
  BLANK_FINGERPRINT_KEY, blankPlaceAction, fingerprintDedupKey, messageFingerprint, normalizeMime,
  type BlankMessageRow, type BlankPlace, type BlankPlaceAction, type BlankPlaceReading, type FolderAttribution,
  type Logger, type NativeLocator,
} from "@trafficflow/core/mail";
import {
  MessageGoneError, WriteDeclinedError, epochOf, epochVerdict, makeRef, parseRef, type MailboxAdapter,
} from "@trafficflow/core/adapters/imap";
import type { WorkerRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { LeaseUnavailableError } from "@trafficflow/core/adapters/organizer-lease";
import { MailboxErasedError } from "@trafficflow/db";
import {
  assertMayWriteToMailbox, OrganizerStandDownError, writeDoorOf, type MailboxWriteAuthority,
} from "./lease.js";

/**
 * THE BLANK REPAIR (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS). An older build took another
 * session's flag change for a letter's reply and stored a blank message in the letter's place; the
 * letter was never imported, and where the organizer filed the blank it moved the letter. Every blank
 * of a mailbox shares one row (`core/blank-repair.ts`), so the work is counted in places.
 *
 * At the visit's tail, only when the cycle deferred nothing (the junk restore's rule), at most
 * {@link BLANK_REPAIR_PLACES_PER_VISIT} places a visit. Each place is read first and its bytes decide
 * (`blankPlaceAction`): a real content-free letter is kept; a place the server no longer holds is
 * released; a letter the blank's own move filed away goes back to INBOX and the place is released;
 * any other letter is released with a re-read owed. The ordinary scan then imports each letter once
 * and the person's rules route it; the reaper tombstones the blank once it holds no place. A reader
 * never moves anything. `dry` reads each place once, counts, and writes nothing anywhere.
 */

/** Places one visit reads or settles. A mailbox with many blanks heals over visits. */
export const BLANK_REPAIR_PLACES_PER_VISIT = 5;

/** The re-read's ceiling: a content-free letter is a few bytes, so anything past this is a letter. */
export const BLANK_REPAIR_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Places one visit lists beyond those this process holds a reading of. A count settles nothing, so
 * its listing grows with what it has read and reaches every place in the end.
 */
export const BLANK_REPAIR_LISTED_PLACES = 100;

/** How long a place whose read or action failed waits before it is tried again, doubled by each further failure. */
export const BLANK_REPAIR_RETRY_BASE_MS = 10 * 60_000;

/** The longest such a place waits: a move that never succeeds is tried once a day. */
export const BLANK_REPAIR_RETRY_MAX_MS = 24 * 60 * 60_000;

/**
 * WHAT ONE PROCESS KNOWS OF ONE MAILBOX'S BLANK PLACES, in memory and written nowhere; a restart reads
 * once more. A UID's bytes never change under its epoch, so a reading stands for as long as its place
 * does: no place is downloaded twice by one process, in either mode, and a dry visit counts from the
 * readings instead of reading again. A place whose read or action failed waits, longer after each
 * failure, instead of being fetched on every cycle.
 * Gmail refuses IMAP to every client of an account that downloads more than about 2.5 GB a day: that cap is the cost this guards.
 */
export interface BlankRepairMemory {
  /** What the bytes at a place said. `blank` is a real content-free letter, kept for good. */
  readonly readings: Map<string, Exclude<BlankPlaceReading, "unreadable">>;
  /** Places whose read or action failed: the failures so far, and the instant before which they wait. */
  readonly waiting: Map<string, { failures: number; until: number }>;
  /**
   * The modes that found nothing left to do here. A build with the fix stores no new blank, so the
   * mailbox stays that way and every later visit skips even the store read (the idle drain's ratchet).
   */
  readonly settled: Set<"dry" | "apply">;
}

/** An empty memory: what a process starts each mailbox with, and a test's stand-in for one process. */
export function newBlankRepairMemory(): BlankRepairMemory {
  return { readings: new Map(), waiting: new Map(), settled: new Set() };
}

const memoryByMailbox = new Map<string, BlankRepairMemory>();
function memoryFor(mailboxId: string): BlankRepairMemory {
  const hit = memoryByMailbox.get(mailboxId);
  if (hit) return hit;
  const fresh = newBlankRepairMemory();
  memoryByMailbox.set(mailboxId, fresh);
  return fresh;
}

/** One more failure at a place: it waits the base delay, doubled for each failure before this one, at most a day. */
function waitLonger(memory: BlankRepairMemory, key: string, nowMs: number): void {
  const failures = (memory.waiting.get(key)?.failures ?? 0) + 1;
  const delay = Math.min(BLANK_REPAIR_RETRY_BASE_MS * 2 ** (failures - 1), BLANK_REPAIR_RETRY_MAX_MS);
  memory.waiting.set(key, { failures, until: nowMs + delay });
}

export interface BlankRepairDeps {
  repo: WorkerRepo;
  adapter: MailboxAdapter;
  accountId: string;
  mailboxId: string;
  role: "organizer" | "reader";
  mode: "dry" | "apply";
  /** The cycle's fenced group; every database write rides it. */
  write: <T>(fn: (r: WorkerRepo) => Promise<T>) => Promise<T>;
  /** What authorises the one server write, the move back to INBOX. */
  writeAuthority: MailboxWriteAuthority;
  /** The build's version, stamped on the re-read a released letter is owed. */
  version: string;
  log?: Logger;
  now?: () => Date;
  placesPerVisit?: number;
  /** Test seam for this process's memory of the mailbox ({@link newBlankRepairMemory}). */
  memory?: BlankRepairMemory;
}

/**
 * What one visit did (apply), or what the repair would do at every place this process has read so
 * far (dry: the count grows by up to {@link BLANK_REPAIR_PLACES_PER_VISIT} places a visit until
 * `remaining` is 0).
 */
export interface BlankRepairResult {
  mode: "dry" | "apply";
  /** Live blank rows in the mailbox. */
  blanks: number;
  /** apply: places this visit settled or tried. dry: places counted so far. */
  places: number;
  /** Places whose bytes this visit downloaded: none this process already holds a reading of. */
  read: number;
  /** Real content-free letters, left alone. */
  kept: number;
  /** Letters moved back to INBOX (dry: that would be). */
  returned: number;
  /** Places forgotten, gone or owed a re-read (dry: that would be). */
  released: number;
  /** Of `released`, the places whose letter is owed a targeted re-read. */
  owed: number;
  /** Places that could not be read, each waiting before it is read again (dry: of `remaining`). */
  unreadable: number;
  /** Letters whose move back to INBOX failed, each waiting before it is tried again. */
  failed: number;
  /** Places left for a later visit: a newer decision reached the row while it was read. */
  deferred: number;
  /** Places still to settle (apply) or to count (dry): not reached yet, waiting, or past the listing's bound. */
  remaining: number;
}

/** A place's action, counted as the result counts it. A reading never answers `skip`. */
function tally(result: BlankRepairResult, action: BlankPlaceAction): void {
  if (action === "keep") result.kept++;
  else if (action === "return") result.returned++;
  else if (action === "release" || action === "reread") {
    result.released++;
    if (action === "reread") result.owed++;
  }
}

const placeKey = (p: BlankPlace): string => `${p.folder}|${p.uidValidity}|${p.uid}`;
const locatorOf = (p: BlankPlace): NativeLocator => ({ folder: p.folder, ref: makeRef(p.uidValidity, p.uid) });

/** The bytes at each place, read and fingerprinted; one targeted FETCH per folder. */
async function readPlaces(
  adapter: MailboxAdapter, places: readonly BlankPlace[], log: Logger | undefined, mailboxId: string,
): Promise<Map<BlankPlace, BlankPlaceReading>> {
  const out = new Map<BlankPlace, BlankPlaceReading>();
  const byFolder = new Map<string, BlankPlace[]>();
  for (const p of places) byFolder.set(p.folder, [...(byFolder.get(p.folder) ?? []), p]);
  for (const [folder, here] of byFolder) {
    let found: Awaited<ReturnType<NonNullable<MailboxAdapter["fetchByUid"]>>>;
    try {
      found = await adapter.fetchByUid!(folder, here.map((p) => p.uid), { maxBytes: BLANK_REPAIR_MAX_BYTES });
    } catch (err) {
      log?.warn("blank_repair_fetch_failed", { mailboxId, err });
      for (const p of here) out.set(p, "unreadable");
      continue;
    }
    for (const p of here) {
      const verdict = epochVerdict(epochOf(p.uidValidity), epochOf(found.uidValidity));
      if (verdict === "unknown") { out.set(p, "unreadable"); continue; }
      if (verdict === "stale" || found.absent.includes(p.uid)) { out.set(p, "gone"); continue; }
      // Past the ceiling, and a content-free letter is a few bytes: a letter.
      if (found.oversize.includes(p.uid)) { out.set(p, "letter"); continue; }
      const raw = found.creates.find((c) => parseRef(c.locator.ref).uid === p.uid)?.raw;
      if (raw === undefined || raw.length === 0) { out.set(p, "unreadable"); continue; }
      let key: string;
      try {
        key = fingerprintDedupKey(messageFingerprint(await normalizeMime(Buffer.isBuffer(raw) ? raw : Buffer.from(raw))));
      } catch {
        // Bytes that do not even parse are not the empty source a blank came from.
        out.set(p, "letter");
        continue;
      }
      out.set(p, key === BLANK_FINGERPRINT_KEY ? "blank" : "letter");
    }
  }
  return out;
}

/** The refusals that are not this place's — `junk-rescue.ts#isRefusal`'s set; they stop the pass. */
function isRefusal(err: unknown): boolean {
  if (err instanceof OrganizerStandDownError || err instanceof LeaseUnavailableError) return true;
  if (err instanceof WriteDeclinedError) return true;
  if (err instanceof MailboxErasedError) return true;
  return err instanceof Error && (err.name === "LeaderFencedError" || err.name === "MailboxRemovedError");
}

/** THE PASS. Never throws but a refusal (`isRefusal`) or what `write` raises. */
export async function blankRepairPass(deps: BlankRepairDeps): Promise<BlankRepairResult> {
  const { repo, adapter, accountId, mailboxId, log, mode } = deps;
  const result: BlankRepairResult = {
    mode, blanks: 0, places: 0, read: 0, kept: 0, returned: 0, released: 0, owed: 0, unreadable: 0,
    failed: 0, deferred: 0, remaining: 0,
  };
  if (typeof repo.listBlankMessages !== "function" || !adapter.fetchByUid) return result;
  const memory = deps.memory ?? memoryFor(mailboxId);
  if (memory.settled.has(mode)) return result;
  const rows: BlankMessageRow[] = await repo.listBlankMessages(mailboxId, BLANK_REPAIR_LISTED_PLACES + memory.readings.size);
  result.blanks = rows.length;
  const now = deps.now ?? (() => new Date());
  const nowMs = now().getTime();

  const listed = rows.flatMap((row) => row.places.map((place) => ({ row, place, key: placeKey(place) })));
  // Past the listing's bound: still to do, and listed once the places ahead of them are settled or read.
  const unlisted = rows.reduce((n, row) => n + Math.max(0, row.placeCount - row.places.length), 0);
  // A kept letter is done for good, and for a count so is every place already read.
  const open = listed.filter(({ key }) => {
    const reading = memory.readings.get(key);
    return reading !== "blank" && (mode === "apply" || reading === undefined);
  });
  // Nothing left: no blank, or only kept letters and, for a count, places already counted.
  if (open.length === 0 && unlisted === 0) { memory.settled.add(mode); return result; }
  // Due now: the never-failed in the listing's order, then the failed in the order they fell due.
  const waitsUntil = (key: string): number => memory.waiting.get(key)?.until ?? 0;
  const work = open.filter(({ key }) => waitsUntil(key) <= nowMs)
    .sort((a, b) => waitsUntil(a.key) - waitsUntil(b.key))
    .slice(0, deps.placesPerVisit ?? BLANK_REPAIR_PLACES_PER_VISIT);
  // Downloaded only where this process holds no reading; a failed read waits.
  const unread = work.filter(({ key }) => !memory.readings.has(key));
  if (unread.length > 0) {
    const fresh = await readPlaces(adapter, unread.map((w) => w.place), log, mailboxId);
    result.read = unread.length;
    for (const { place, key } of unread) {
      const reading = fresh.get(place) ?? "unreadable";
      if (reading === "unreadable") { waitLonger(memory, key, nowMs); continue; }
      memory.readings.set(key, reading);
      memory.waiting.delete(key);
    }
  }

  if (mode === "dry") {
    // THE COUNT, from every reading this process holds: what apply would do at each place read so far.
    for (const { row, place, key } of listed) {
      const reading = memory.readings.get(key);
      if (reading === undefined) {
        result.remaining++;
        if (memory.waiting.has(key)) result.unreadable++;
        continue;
      }
      result.places++;
      tally(result, blankPlaceAction(reading, place, row.folderState, deps.role));
    }
    result.remaining += unlisted;
    // Every place counted: no later visit of this process reads or lists again.
    if (result.remaining === 0) memory.settled.add("dry");
    // Said when the count grew: a count that stands is no news every visit.
    if (result.read > 0) say(log, result, mailboxId, accountId);
    return result;
  }

  result.remaining = open.length + unlisted;
  // What is left waits.
  if (work.length === 0) return result;
  result.places = work.length;

  /* A MOVE STILL OWED FOR A BLANK IS WITHDRAWN before any of its places is let go: the reconciler
     files from `native_locator`, which a released place leaves behind, so the blank's pending desire
     would carry the very letter it hid into the Screener. Read before the round trip, so written only
     against that desire (`adoptFolderState`): false when a newer decision owns the row, and the place
     waits for a later visit. Once withdrawn, the row's other places in this visit see it settled. */
  const live = new Map(rows.map((row) => [row.messageId, row.folderState]));
  const withdraw = async (r: WorkerRepo, row: BlankMessageRow): Promise<boolean> => {
    const fs = live.get(row.messageId) ?? null;
    if (fs === null || fs.desired === fs.observed) return true;
    return r.adoptFolderState(row.messageId, {
      desiredFolder: fs.observed, observedFolder: fs.observed, lastSetBy: fs.lastSetBy as FolderAttribution,
    }, fs.desired, null);
  };
  const settle = (row: BlankMessageRow): void => {
    const fs = live.get(row.messageId) ?? null;
    if (fs !== null) live.set(row.messageId, { ...fs, desired: fs.observed });
  };

  for (const { row, place, key } of work) {
    const action = blankPlaceAction(memory.readings.get(key) ?? "unreadable", place, live.get(row.messageId) ?? null, deps.role);
    const at = locatorOf(place);
    // Not settled this visit: tried again after a wait that grows with each failure.
    const later = (): void => { waitLonger(memory, key, nowMs); };
    // Settled: the place leaves the store, and its reading and its wait go with it.
    const done = (): void => { memory.readings.delete(key); memory.waiting.delete(key); result.remaining--; };
    if (action === "skip") { result.unreadable++; continue; }
    if (action === "keep") { result.kept++; result.remaining--; continue; }
    if (action === "release" || action === "reread") {
      const owed = action === "reread";
      const released = await deps.write(async (r) => {
        if (!(await withdraw(r, row))) return false;
        await r.forgetInstanceAt(mailboxId, at);
        if (owed) {
          await r.recordMessageFailure(mailboxId, {
            accountId, folder: place.folder, uidValidity: place.uidValidity, uid: place.uid,
            code: "unclassified", version: deps.version, nextAttemptAt: now(),
          });
        }
        return true;
      });
      if (!released) { later(); result.deferred++; continue; }
      settle(row);
      done();
      result.released++;
      if (owed) result.owed++;
      continue;
    }
    // action === "return": the letter the blank's own move filed away goes back to INBOX.
    try {
      await assertMayWriteToMailbox(deps.writeAuthority, "move");
      await adapter.move(at, "INBOX", writeDoorOf(deps.writeAuthority));
    } catch (err) {
      if (isRefusal(err)) throw err;
      if (err instanceof MessageGoneError) {
        // Moved or expunged elsewhere since the read: the place is the server's no longer.
        await deps.write((r) => r.forgetInstanceAt(mailboxId, at));
        done();
        result.released++;
        continue;
      }
      log?.warn("blank_repair_move_failed", { mailboxId, accountId, err });
      later();
      result.failed++;
      continue;
    }
    await deps.write((r) => r.forgetInstanceAt(mailboxId, at));
    done();
    result.returned++;
  }

  // Said when a place was tried: a blank whose places are all gone, kept or waiting is no news every visit.
  if (result.places > 0) say(log, result, mailboxId, accountId);
  return result;
}

/** The pass's one line: counts, the mode and the ids, never a folder, a UID or anything of a message. */
function say(log: Logger | undefined, result: BlankRepairResult, mailboxId: string, accountId: string): void {
  log?.info("blank_repair", {
    mailboxId, accountId, mode: result.mode, blanks: result.blanks, places: result.places, read: result.read,
    kept: result.kept, returned: result.returned, released: result.released, owed: result.owed,
    unreadable: result.unreadable, failed: result.failed, deferred: result.deferred, remaining: result.remaining,
  });
}

import { describe, it, expect, afterEach, vi } from "vitest";
import {
  ImapAdapter, ImapBoundExceeded, isImapBoundExceeded, MoveVerifyError,
  IMAP_LIST_MAX_FOLDERS, IMAP_FOLDER_PATH_MAX_CHARS, IMAP_FOLDER_PATH_MAX_BYTES, utf8ByteLength, IMAP_ENUM_MAX_UIDS,
  IMAP_SEARCH_MAX_UIDS, IMAP_CANDIDATE_BODY_PROBES_MAX,
  IMAP_READ_DEADLINE_MS, IMAP_CYCLE_DEADLINE_MS, IMAP_BODY_OVERRUN_FLOOR_BYTES, minOf,
  IMAP_SAMPLE_MAX_ROWS,
} from "../../src/adapters/imap.js";
import type { ChangeBatch, ImapCursor } from "../../src/adapters/imap-types.js";
import { MAX_RAW_MESSAGE_BYTES } from "../../src/mime.js";
import { FIXTURE_DOOR } from "./_door.js";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/**
 * ═══ A HOSTILE MAIL SERVER MEETS THE ADAPTER'S CEILINGS ════════════════════════════════════
 *
 * The user names their own IMAP host, the worker process is SHARED, and
 * until these ceilings existed every count, size and wait the adapter accepted from that host was
 * a lever on every other mailbox on the shard. `imap-bounds.ts` carries the argument for each
 * number; this file is the part that watches them fire.
 *
 * ## What "proved" means here, and why it is not GreenMail
 *
 * GreenMail on :3143 is environmentally red in this checkout, and it would be the wrong instrument
 * anyway: **GreenMail is an HONEST server.** It cannot claim an absurd number of folders, answer a SEARCH
 * with an enormous list of UIDs, declare `RFC822.SIZE 10` for a two-megabyte body, or spend three
 * minutes emitting one UID. Every shape this row is about is a server BEHAVING BADLY, which is
 * exactly what a fake at the client seam can express and a real cooperative server cannot. The
 * adapter is a real `ImapAdapter` throughout — only the socket's other end is ours, which is the
 * pattern `imap.epoch-guard.test.ts` and `imap.changes.bytebudget.test.ts` already use.
 *
 * ## Two things every case asserts, not one
 *
 * A ceiling that merely CHANGES THE RETURN VALUE is the defect this row is about — "the cap is
 * applied to the RESULT instead of to the READ". So where the distinction is observable, the
 * assertions check **what the server was allowed to do**, not only what the adapter answered:
 * how many items the fake actually yielded before the pull stopped, and whether the expensive
 * follow-up command (the body fetch, the per-candidate download) was issued at all.
 *
 * ## The clock is injected, and that is deliberate
 *
 * The wall-clock ceilings are minutes long. A test proving them against the real clock would
 * sleep for minutes; one proving them against lowered constants would be exercising numbers the
 * product does not ship. `ImapAdapterOpts.nowMs` lets these cases drive the SHIPPING constants
 * ({@link IMAP_READ_DEADLINE_MS}, {@link IMAP_CYCLE_DEADLINE_MS}) to the millisecond.
 *
 * ## MUTATIONS WATCHED RED AND RESTORED (2026-09-01), all eight, scripted and re-run
 *
 *  · `boundedCollect`'s `if (seen > opts.max)` → never throws ⇒ red;
 *  · `boundListResponse`'s count check removed ⇒ red;
 *  · its path-length filter removed ⇒ red;
 *  · `boundSearchResult` returning `found` unchecked ⇒ red;
 *  · `ImapDeadline.check` → a no-op ⇒ red;
 *  · the `IMAP_CANDIDATE_BODY_PROBES_MAX` gate in `destinationLook` removed ⇒ red;
 *  · the per-message `body_overrun` throw removed ⇒ red;
 *  · the `finally { this.cycleDeadline = undefined }` in `changesSince` removed ⇒ red.
 *
 * ── TWO OF THEM SURVIVED THE FIRST TIME, AND BOTH SURVIVALS WERE REAL ──────────────────────
 *
 * This list was written before the mutations were run and claimed all eight. Two were false, and
 * neither was a flaw in the ceiling — both were assertions checking something the code could not
 * get wrong:
 *
 *  · **the per-message body ceiling.** The original case declared 10 bytes and streamed past the
 *    1 MiB floor, which trips the BATCH total as well; removing the per-message throw left the
 *    case green because the other guard caught it. The two are now separated by construction —
 *    one case sized so only the per-message ceiling can fire, one so only the batch total can —
 *    and each asserts `bodiesYielded`, which is what makes "refused before the memory was spent"
 *    observable rather than inferred.
 *  · **the leaked cycle budget.** The original case asserted that the NEXT `changesSince`
 *    succeeds — but `changesSince` assigns a fresh budget on entry, so a leaked one is
 *    overwritten before anything reads it. The reads that actually consult a stale budget are the
 *    ones taken BETWEEN passes (attachment reads, the Junk window, folder discovery), and only
 *    once enough time has passed for it to have expired. The case does both now.
 *
 * Written down because it is the point of the exercise: a guard nobody has watched fail is not
 * evidence, and two of these were being asserted by tests that would have passed without them.
 *
 * ## ROUND TWO — THE REVIEW'S SEVEN, AND FOUR MORE TESTS THAT WERE NOT TESTING ANYTHING
 *
 * A max-effort review of the first version raised seven findings, all valid, and the fixes got
 * their own battery. **Four of those seven guards passed their new test with the fix REMOVED**:
 *
 *  · the hung-SELECT case mutated the wrong call site — `sampleSenders` and the sync loop both
 *    select `serverPath`, and the first occurrence in the file is the one that does not matter;
 *  · the retry's byte accounting was being proved by a case the BATCH ceiling also caught, which
 *    is the SAME mistake round one made about the first body loop, made again one function over;
 *  · the candidate-probe case asserted that the move rejects — which it does either way, because
 *    it cannot fingerprint a body it declined. The bytes on the wire were the property; the
 *    refusal was a coincidence;
 *  · the spread case drove `changesSince` with a huge spread of UIDs and never reached `minOf` at all,
 *    because that line is only on the SENT folder's first scan and the fake had no Sent folder.
 *    A case that cannot reach the line it is about is worth nothing however plausible it reads.
 *
 * ## AND ONE MUTATION THAT SURVIVES ON PURPOSE
 *
 * The candidate probe has TWO independent byte guards — the `download` ceiling and the
 * count-as-we-go in the loop — and either alone bounds the bytes, so removing just the in-loop
 * one changes no observable behaviour. It is killed together with its partner, and the
 * battery asserts that the single-guard mutation SURVIVES, so losing the redundancy is a change
 * somebody has to make deliberately.
 *
 * Its partner started out equally unkillable and stopped being so once the requested-ceiling
 * assertion landed — that one reads the `maxBytes` the adapter actually asks for, which is
 * white-box and worth it: the `+ 1` is the whole mechanism and nothing about the RESULT reveals
 * whether it was requested.
 */

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };

const FOLDERS = [
  "INBOX", "ohmail/Screener", "ohmail/News",
  "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine",
];

function emptyCursor(folders: readonly string[] = FOLDERS): ImapCursor {
  const out: ImapCursor["folders"] = {};
  for (const f of folders) out[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders: out };
}

/** A clock the test advances by hand — see the header. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_700_000_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

interface HostileOpts {
  /** Folder paths the LIST response names. Defaults to the frozen six. */
  listPaths?: string[];
  /** How many UIDs the enumeration fetch will yield if nobody stops it. */
  floodUids?: number;
  /** UIDs a SEARCH answers with. */
  searchUids?: number[];
  /** Bytes each body actually streams, whatever `RFC822.SIZE` said. */
  actualBodyBytes?: number;
  /** What `RFC822.SIZE` declares. */
  declaredSize?: number;
  /** Milliseconds of clock the server burns per item yielded — the slow-loris dial. */
  msPerItem?: number;
  /** Start a row after this many items and never finish it. */
  stallAfterItems?: number;
  /** Clock burned at the moment of the stall, before the pull that never returns. */
  msBeforeStall?: number;
  /** Accept the SELECT and never answer it. */
  hangSelect?: boolean;
  /** Omit the first body row, forcing `fetchCapped`'s envelope-free retry. */
  omitFirstBodyRow?: boolean;
  /**
   * Bytes the ENVELOPE-FREE RETRY returns, when it differs from the ordinary body size.
   *
   * Needed so the retry can be the ONLY oversized body in a batch: otherwise the first body
   * loop's own ceiling fires first and the retry's accounting is never the thing under test.
   */
  retryBodyBytes?: number;
  /**
   * Bytes the CANDIDATE probe's `download` offers — separate from `actualBodyBytes` on purpose.
   *
   * The move's own source probe goes through `fetchOne` and its bytes have to stay small and
   * PARSEABLE, or `fingerprintOf` returns null, `sourceFingerprint` is null, and the candidate
   * loop this case exists to reach is never entered at all. (Measured: one shared size made the
   * case assert on a loop that had not run.)
   */
  candidateBodyBytes?: number;
  /**
   * Rows the PAGE fetch answers with, whatever the range asked for — a server over-answering a
   * bounded page. The ceiling for this is a `break`, not a throw, which is exactly why it needs
   * its own case: nothing propagates, so a silent retirement would be invisible.
   */
  overAnswerPage?: number;
  /**
   * Every folder holds mail, not just INBOX — so a pass issues one enumeration PER FOLDER.
   * The cycle-budget case needs several reads that are each legal on their own.
   */
  populateAllFolders?: boolean;
  clock?: { now: () => number; advance: (ms: number) => void };
}

/**
 * One fake for every shape in this file. It COUNTS what it was allowed to do, which is the half
 * that separates a read bound from a result bound.
 */
function hostileClient(o: HostileOpts) {
  const clock = o.clock ?? fakeClock();
  const counters = {
    /** UIDs the enumeration fetch actually yielded before the consumer stopped pulling. */
    uidsYielded: 0,
    /** Envelope/flag rows the page fetch yielded. */
    fetched: 0,
    /** Full-body `fetchOne` calls the move's candidate loop issued. */
    bodyProbes: 0,
    /** Body rows the batch fetch yielded. */
    bodiesYielded: 0,
    lists: 0,
    searches: 0,
    /** `forceClose()` reached the driver — the connection was RETIRED, not merely abandoned. */
    closed: 0,
    /** Bytes `download` actually put on the wire — the measurement a byte CEILING is judged by. */
    downloadBytes: 0,
    /** `onConnectionError` calls the adapter made — how the adapter's owner learns a retirement happened. */
    ownerTold: [] as string[],
    /** The `maxBytes` each `download` was asked for — the ceiling, as REQUESTED. */
    downloadCaps: [] as Array<number | undefined>,
    /** LOGOUTs issued — a retired connection must never be sent one. */
    logouts: 0,
  };
  const paths = o.listPaths ?? [...FOLDERS];
  // READ AT CALL TIME, not captured: the 'does not poison the next pass' case has to run TWO
  // passes through the SAME adapter — a second adapter would carry a fresh field and prove
  // nothing about the leak. So the test makes this server honest between passes.
  const flood = (): number => o.floodUids ?? 0;
  const mailbox = {
    path: "INBOX", uidValidity: 100n, uidNext: flood() + 1, highestModseq: 0n,
    exists: flood() > 0 ? flood() : 1,
  };
  /**
   * A REAL message of exactly `n` bytes: headers, a blank line, then filler.
   *
   * Plain filler is not parseable, so `fingerprintOf` answers null for it — and a null source
   * fingerprint makes `move` refuse before it ever reaches the candidate loop. A case built on
   * filler therefore tests the refusal it was written to avoid, silently.
   */
  const messageOf = (n: number): Buffer => {
    const head = Buffer.from("Message-ID: <m@x>\r\nSubject: s\r\nFrom: a@b.c\r\n\r\n");
    return n <= head.length
      ? head.subarray(0, Math.max(1, n))
      : Buffer.concat([head, Buffer.alloc(n - head.length, 0x61)]);
  };
  const body = (): Buffer => messageOf(o.actualBodyBytes ?? 64);

  /**
   * Uids this server has EXPUNGED. `messageDelete` answering `true` is a server saying the uid is
   * gone, so a later `fetchOne` for it must answer `false` the way a real one does. Without this
   * the fake reported the expunge done and then produced the message anyway — which is exactly the
   * shape `move`'s custody read exists to refuse, so the adopt case below failed for the fake's own
   * incoherence rather than for anything the adapter did.
   */
  const expunged = new Set<number>();

  const client = {
    counters, clock,
    usable: true,
    capabilities: new Map<string, boolean>([["MOVE", true], ["UIDPLUS", true]]),
    mailbox: mailbox as unknown,
    _path: "INBOX",
    async list() {
      counters.lists++;
      return paths.map((path) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set<string>(),
      }));
    },
    async mailboxCreate(path: string) { return { path }; },
    async getMailboxLock(path: string) {
      if (o.hangSelect) {
        // The server accepted the SELECT and will never finish it. No count ceiling sees this and
        // the socket never goes idle in a way Node's inactivity timer would catch.
        await new Promise(() => { /* for ever */ });
      }
      client._path = path;
      client.mailbox = (path === "INBOX" || o.populateAllFolders)
        ? { ...mailbox, path }
        : { ...mailbox, path, exists: 0, uidNext: 1 };
      return { path, release() { /* nothing */ } };
    },
    async search() {
      counters.searches++;
      return o.searchUids ?? [];
    },
    async fetchOne(_range: string, query?: { source?: boolean; envelope?: boolean }) {
      if (expunged.has(Number(_range))) return false;   // this server already said it was gone
      // The MOVE's source probe asks for the envelope too; the candidate loop asks for the body
      // ALONE. That is what makes `bodyProbes` count only the per-candidate downloads — the
      // expensive thing the ceiling exists to stop — and not the one legitimate source read.
      if (query?.source && !query?.envelope) {
        counters.bodyProbes++;
        return { uid: 1, source: body() };
      }
      return {
        uid: 1,
        envelope: { messageId: "<shared@example.com>" },
        ...(query?.source ? { source: body() } : {}),
      };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, _options?: any) {
      if (client._path !== "INBOX" && !o.populateAllFolders) return;
      const asked: number[] = Array.isArray(range) ? range : [];
      if (query?.source) {
        // The iCloud shape: a UID answered for RFC822.SIZE and omitted from any fetch asking for
        // ENVELOPE. It is what `fetchCapped`'s envelope-free retry exists for — and the retry was
        // where the byte accounting was missing.
        const rows = (asked.length > 0 ? asked : [1])
          .filter((u) => !(o.omitFirstBodyRow && query?.envelope && u === asked[0]));
        for (const uid of rows) {
          counters.bodiesYielded++;
          if (o.msPerItem) clock.advance(o.msPerItem);
          // The envelope-free retry is the fetch that does NOT ask for the envelope.
          const isRetry = !query?.envelope;
          const bodyFor = isRetry && o.retryBodyBytes !== undefined
            ? Buffer.alloc(o.retryBodyBytes, 0x61)
            : body();
          yield {
            uid, flags: new Set<string>(), envelope: { messageId: `<m${uid}@x>` },
            source: bodyFor, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000),
          };
        }
        return;
      }
      if (query?.size) {
        for (const uid of asked) yield { uid, size: o.declaredSize ?? body().length };
        return;
      }
      if (query?.envelope && query?.flags) {
        // The page/search fetch — `listFolderPage` / `searchFolderPage`.
        const pageRows = o.overAnswerPage !== undefined
          ? Array.from({ length: o.overAnswerPage }, (_v, i) => i + 1)
          : (asked.length > 0 ? asked : [1]);
        for (const uid of pageRows) {
          counters.fetched++;
          // The page loop is one of the hand-written `deadline.check()` sites, so it needs a way
          // to burn the clock: those loops are NOT covered by the raced-pull guard.
          if (o.msPerItem) clock.advance(o.msPerItem);
          yield {
            uid, seq: uid,
            envelope: { subject: `s${uid}`, from: [{ name: null, address: "a@b.c" }], date: new Date(), messageId: `<m${uid}@x>` },
            flags: new Set<string>(), internalDate: new Date(),
          };
        }
        return;
      }
      if (query?.internalDate) {
        for (const uid of asked) yield { uid, internalDate: new Date(Date.UTC(2026, 0, 1) + uid * 1000) };
        return;
      }
      // THE ENUMERATION — `1:*`. This is the flood, and it will run to `flood` unless the
      // consumer stops pulling. `uidsYielded` is therefore the measurement that says whether the
      // ceiling bounded the READ or merely the result.
      for (let uid = 1; uid <= flood(); uid++) {
        counters.uidsYielded++;
        if (o.msPerItem) clock.advance(o.msPerItem);
        yield { uid };
        if (o.stallAfterItems !== undefined && uid >= o.stallAfterItems) {
          // ── THE SHAPE THAT DEFEATED THE FIRST VERSION OF THE DEADLINE ────────────────────
          //
          // A row is STARTED and never completed. A `for await` suspends inside `next()`, so a
          // per-iteration `deadline.check()` is never reached and the clock is never consulted
          // again. The server is not sending too much and is not idle; it is simply never
          // finishing. Only racing the PULL itself sees this.
          if (o.msBeforeStall) clock.advance(o.msBeforeStall);
          await new Promise(() => { /* for ever */ });
        }
      }
    },
    async messageMove() { return { uidValidity: 100n, uidMap: new Map<number, number>([[1, 9]]) }; },
    async messageCopy() { return { uidValidity: 100n, uidMap: new Map<number, number>([[1, 9]]) }; },
    async messageDelete(range?: number[] | number) {
      const uids = Array.isArray(range) ? range : range == null ? [] : [range];
      for (const uid of uids) expunged.add(Number(uid));
      return true;
    },
    async download(_range: string, _part: unknown, opts?: { maxBytes?: number }) {
      // A single ENORMOUS literal, delivered in chunks. `maxBytes` is what the caller is supposed
      // to hand the driver; this fake honours it the way imapflow does — by stopping at a chunk
      // boundary — and reports the real size, so a caller that omitted the limit is visible.
      const total = o.candidateBodyBytes ?? o.actualBodyBytes ?? 64;
      const cap = opts?.maxBytes ?? Number.POSITIVE_INFINITY;
      counters.downloadCaps.push(opts?.maxBytes);
      // Below a sane size the candidate is a REAL message, so a candidate and a source of equal
      // size are byte-identical and actually fingerprint the same. Above it, filler — those cases
      // are about refusing an absurd body, never about matching one.
      const real = total <= 64 * 1024 * 1024 ? messageOf(total) : null;
      counters.bodyProbes++;
      const chunk = 64 * 1024;
      return {
        meta: { expectedSize: total, contentType: "message/rfc822", filename: null },
        content: (async function* () {
          let sent = 0;
          while (sent < total && sent < cap + chunk) {
            const nBytes = Math.min(chunk, total - sent);
            const piece = real !== null
              ? real.subarray(sent, sent + nBytes)
              : Buffer.alloc(nBytes, 0x61);
            sent += nBytes;
            counters.downloadBytes += nBytes;
            yield piece;
          }
        })(),
      };
    },
    async logout() { counters.logouts++; },
    close() { counters.closed++; },
  };
  return client;
}

/** The refusal, narrowed — every case asserts the CLASS, not a message substring. */
async function refusal(fn: () => Promise<unknown>): Promise<ImapBoundExceeded> {
  try {
    await fn();
  } catch (err) {
    if (err instanceof ImapBoundExceeded) return err;
    throw new Error(`expected ImapBoundExceeded, got ${String(err)}`);
  }
  throw new Error("expected a refusal, the call returned");
}

/**
 * A per-message overrun does not throw: the pass stops there, retires the connection and RETURNS,
 * so the work before it is kept and the caller can set that message aside.
 */
async function overrunIn(fn: () => Promise<ChangeBatch>): Promise<ImapBoundExceeded> {
  const batch = await fn();
  const breach = batch.overrun?.breach;
  if (breach instanceof ImapBoundExceeded) return breach;
  throw new Error("expected the pass to stop at an overrun, it did not");
}

describe("hostile IMAP server — COUNT ceilings", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a LIST naming more folders than the ceiling refuses the connection", async () => {
    const client = hostileClient({
      listPaths: Array.from({ length: IMAP_LIST_MAX_FOLDERS + 1 }, (_v, i) => `f/${i}`),
    });
    adapter = new ImapAdapter(cfg, { client });
    const err = await refusal(() => adapter!.connect());
    expect(err.bound).toBe("list_folders");
    expect(err.limit).toBe(IMAP_LIST_MAX_FOLDERS);
    expect(err.observed).toBe(IMAP_LIST_MAX_FOLDERS + 1);
  });

  it("…and a LIST exactly AT the ceiling is accepted — the bound is not off by one", async () => {
    const client = hostileClient({
      listPaths: ["INBOX", ...Array.from({ length: IMAP_LIST_MAX_FOLDERS - 1 }, (_v, i) => `f/${i}`)],
    });
    adapter = new ImapAdapter(cfg, { client });
    await expect(adapter.connect()).resolves.toBeUndefined();
  });

  it("one unusably-named folder is DROPPED and the rest still list", async () => {
    const absurd = "x".repeat(IMAP_FOLDER_PATH_MAX_CHARS + 1);
    const client = hostileClient({ listPaths: ["INBOX", absurd, "Work"] });
    adapter = new ImapAdapter(cfg, { client });
    await adapter.connect();
    const folders = await adapter.listFolders();
    // The asymmetry is the point: too MANY folders fails the mailbox, one bad NAME is skipped —
    // refusing thousands of good folders over one absurd name is the worse answer.
    expect(folders).toEqual(["INBOX", "Work"]);
    expect(folders.some((f) => f.length > IMAP_FOLDER_PATH_MAX_CHARS)).toBe(false);
  });

  it("a folder name inside the character bound and past the btree in BYTES is dropped and counted", async () => {
    // Three-byte characters: as many UTF-16 units, three times as many bytes, past the btree's limit.
    const wide = Array.from({ length: 1000 }, (_v, i) => String.fromCharCode(0x4e00 + ((i * 7919) % 0x5000))).join("");
    // Exactly AT the byte ceiling, of the same three-byte class plus ASCII — admitted.
    const atCeiling = "\u4e2d".repeat(Math.floor(IMAP_FOLDER_PATH_MAX_BYTES / 3)) + "a".repeat(IMAP_FOLDER_PATH_MAX_BYTES % 3);
    expect([wide.length <= IMAP_FOLDER_PATH_MAX_CHARS, utf8ByteLength(wide), utf8ByteLength(atCeiling)])
      .toEqual([true, 3000, IMAP_FOLDER_PATH_MAX_BYTES]);
    const lines: Array<[string, Record<string, unknown>]> = [];
    const client = hostileClient({ listPaths: ["INBOX", wide, atCeiling, `${atCeiling}b`, "Work"] });
    adapter = new ImapAdapter(cfg, { client, log: (event, detail) => { lines.push([event, detail]); } });
    await adapter.connect();
    const folders = await adapter.listFolders();
    expect(folders).toEqual(["INBOX", atCeiling, "Work"]);
    // Reported once, by count, and the line carries no name.
    expect(lines.filter(([e]) => e === "imap_folder_paths_dropped")).toEqual([["imap_folder_paths_dropped", { dropped: 2 }]]);
  });

  it("utf8ByteLength agrees with the encoder, surrogate pairs and lone halves included", () => {
    const enc = new TextEncoder();
    for (const s of ["", "a", "\u00e9", "\u4e2d", "\u{1F600}", "a\u{1F600}\u4e2d\u00e9", "\ud800", "x\udc00y", "\ud83d\ud83d\ude00"]) {
      expect(utf8ByteLength(s), JSON.stringify(s)).toBe(enc.encode(s).length);
    }
  });

  it("a folder claiming more UIDs than the ceiling STOPS THE PULL, not just the array", async () => {
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 5_000 });
    adapter = new ImapAdapter(cfg, {
      client, capabilityOverrides: { condstore: false },
    });
    await adapter.connect();

    const err = await refusal(() => adapter!.changesSince(emptyCursor()));
    expect(err.bound).toBe("enumerate_uids");
    expect(err.limit).toBe(IMAP_ENUM_MAX_UIDS);

    /*
     * THE ASSERTION THIS WHOLE ROW IS ABOUT.
     *
     * The server was PREPARED to yield far past IMAP_ENUM_MAX_UIDS. A cap applied to the result
     * would have let it yield every one of them and then measured the array — which is precisely
     * what `enumerateUids` used to do, and precisely the sentence in the ledger row ("the cap is
     * applied to the RESULT instead of to the READ"). Bounding the read means the generator was
     * stopped: it produced the ceiling plus the one item that revealed the overflow, and not one
     * more.
     */
    expect(client.counters.uidsYielded).toBe(IMAP_ENUM_MAX_UIDS + 1);
    expect(client.counters.uidsYielded).toBeLessThan(IMAP_ENUM_MAX_UIDS + 5_000);
    // …and no body was ever fetched: the refusal precedes the expensive half.
    expect(client.counters.bodiesYielded).toBe(0);
  });

  it("a SEARCH answering past the ceiling refuses BEFORE the sort and BEFORE the fetch", async () => {
    const client = hostileClient({
      searchUids: Array.from({ length: IMAP_SEARCH_MAX_UIDS + 1 }, (_v, i) => i + 1),
    });
    adapter = new ImapAdapter(cfg, { client });
    await adapter.connect();

    const err = await refusal(() => adapter!.searchFolderPage("INBOX", "invoice"));
    expect(err.bound).toBe("search_uids");
    expect(err.observed).toBe(IMAP_SEARCH_MAX_UIDS + 1);
    // The old code did `[...found].sort()` and THEN sliced 50. The refusal has to land before the
    // envelope fetch, or the ceiling bought nothing but a smaller answer.
    expect(client.counters.fetched).toBe(0);
  });

  it("a Message-ID SEARCH flooding the move's candidate set refuses before ONE body download", async () => {
    const client = hostileClient({
      searchUids: Array.from({ length: IMAP_CANDIDATE_BODY_PROBES_MAX + 1 }, (_v, i) => i + 1),
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { uidplus: false } });
    await adapter.connect();

    const err = await refusal(
      () => adapter!.move({ folder: "INBOX", ref: "100:1" }, "ohmail/News", FIXTURE_DOOR),
    );
    expect(err.bound).toBe("candidate_body_probes");
    expect(err.limit).toBe(IMAP_CANDIDATE_BODY_PROBES_MAX);
    /*
     * The worst count-to-bytes multiplier in the adapter: the candidate loop downloads a FULL
     * BODY per element. Unbounded, this move would have issued 33 body downloads here and
     * unboundedly many against a server that felt like it — on the worker's shared, long-lived
     * connection. The measurement is that it issued NONE.
     */
    expect(client.counters.bodyProbes).toBe(0);
  });
});

describe("hostile IMAP server — the SIZE ceiling (a lying RFC822.SIZE)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("ONE body far past its own declared size is refused on the FIRST body, by the per-message ceiling", async () => {
    /*
     * EVERY byte ceiling above `fetchCapped`'s body fetch — the per-message refusal, the batch
     * budget, the anti-stall rule — is computed from `RFC822.SIZE`, a number the SERVER chose,
     * and the fetch itself had no byte accounting at all.
     *
     * ── THE NUMBERS ARE CHOSEN SO ONLY THE PER-MESSAGE CEILING CAN FIRE ──────────────────────
     *
     * Four messages declaring 2 MiB each: the batch's declared total is 8 MiB and its ceiling is
     * 12 MiB. The first body arrives at 4 MiB — past its own 3 MiB ceiling and nowhere near the
     * batch's. `bodiesYielded === 1` is the assertion that makes the distinction observable:
     * remove the per-message throw and the batch ceiling eventually fires anyway, but only after
     * FOUR bodies have been pulled and retained, which is the memory this guard exists to refuse.
     * (Watched: with that throw removed this case goes red on `bodiesYielded`, not on `bound`.)
     */
    const mib = 1024 * 1024;
    const client = hostileClient({
      floodUids: 4, declaredSize: 2 * mib, actualBodyBytes: 4 * mib,
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();

    const err = await overrunIn(() => adapter!.changesSince(emptyCursor()));
    expect(err.bound).toBe("body_overrun");
    expect(err.observed).toBe(4 * mib);
    expect(err.limit).toBe(3 * mib);
    expect(client.counters.bodiesYielded).toBe(1);
    // The breach names the message whose own bytes crossed it, so the caller can set it aside.
    expect(err.site?.uidValidity).toBe("100");
    expect(err.site?.uid).toBeGreaterThanOrEqual(1);
    expect(err.site?.uid).toBeLessThanOrEqual(4);
  });

  it("many bodies each individually under the floor are stopped by the BATCH total, keeping what arrived", async () => {
    /*
     * The per-message ceiling has a 1 MiB floor, so a server can stay under it for ever by
     * declaring nothing and streaming just under the floor a message. A batch of those is a large total through a
     * process shared with every other mailbox on the shard, and not one message breaks a rule.
     * The batch total is what closes that: 10 declared bytes apiece makes the batch ceiling the
     * 1 MiB floor, and the second body crosses it. Both arrived whole, inside their own ceilings,
     * so both are kept and the pass ends there; the next pass takes the rest.
     */
    const client = hostileClient({
      floodUids: 3, declaredSize: 10, actualBodyBytes: 900_000,
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();

    const batch = await adapter.changesSince(emptyCursor());
    const err = await overrunIn(async () => batch);
    expect(batch.creates.map((c) => c.locator.ref)).toEqual(["100:3", "100:2"]);
    expect(err.bound).toBe("body_overrun");
    expect(err.limit).toBe(IMAP_BODY_OVERRUN_FLOOR_BYTES);
    // Each body is under its own ceiling, so the per-message guard cannot be what fired — and it
    // stopped at the second rather than draining all three.
    expect(900_000).toBeLessThan(IMAP_BODY_OVERRUN_FLOOR_BYTES);
    expect(client.counters.bodiesYielded).toBe(2);
    // No one message crossed its own ceiling, so none is named to be set aside.
    expect(err.site).toBeUndefined();
  });

  it("the targeted re-read is byte-accounted too: a body past its declared size's ceiling is refused, named", async () => {
    // Every set-aside row is re-read by UID once a build; that read must not buffer a liar whole.
    const mib = 1024 * 1024;
    const client = hostileClient({ floodUids: 2, declaredSize: 10, actualBodyBytes: 2 * mib });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const err = await refusal(() => adapter!.fetchByUid("INBOX", [1, 2]));
    expect(err.bound).toBe("body_overrun");
    expect(err.limit).toBe(IMAP_BODY_OVERRUN_FLOOR_BYTES);
    expect(err.site?.uidValidity).toBe("100");
    await refusal(() => adapter!.listFolders());
  });

  it("CONTROL: the targeted re-read admits an honest body", async () => {
    const client = hostileClient({ floodUids: 2, declaredSize: 60, actualBodyBytes: 64 });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    expect((await adapter.fetchByUid("INBOX", [1, 2])).creates).toHaveLength(2);
  });

  it("an honest small discrepancy is NOT refused — the ceiling is not a tripwire on real mail", async () => {
    // A body a little larger than its declared size is ordinary (line-ending normalisation).
    const client = hostileClient({ floodUids: 2, declaredSize: 60, actualBodyBytes: 64 });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates.length).toBe(2);
  });
});

describe("hostile IMAP server — the TIME ceilings (the slow loris)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a server that answers glacially but never goes idle is refused by the wall clock", async () => {
    /*
     * THE SHAPE NO OTHER GUARD IN THE STACK SEES.
     *
     * `WORKER_NET_TIMEOUTS.socketMs` is Node's INACTIVITY timer — 120 s that every arriving byte
     * resets. This server emits a UID every 30 s: it is never inactive, so no socket timer fires;
     * it is not sending too much, so no count ceiling fires. Without a wall clock it holds this
     * mailbox's connection, its lock and its slot in the SHARED process indefinitely.
     */
    const clock = fakeClock();
    const client = hostileClient({ floodUids: 10_000, msPerItem: 30_000, clock });
    adapter = new ImapAdapter(cfg, {
      client, capabilityOverrides: { condstore: false }, nowMs: clock.now,
    });
    await adapter.connect();

    const err = await refusal(() => adapter!.changesSince(emptyCursor()));
    expect(err.bound).toBe("read_deadline");
    // It was stopped by the CLOCK, not by the count ceiling: far fewer UIDs than the count bound.
    const yielded = client.counters.uidsYielded;
    expect(yielded).toBeLessThan(IMAP_ENUM_MAX_UIDS);
    expect(yielded).toBeLessThanOrEqual(Math.ceil(IMAP_READ_DEADLINE_MS / 30_000) + 1);
  });

  it("a pass made of many individually-legal slow reads is refused by the CYCLE budget", async () => {
    /*
     * The per-read ceiling composes badly by construction: six watched folders each stopping just
     * short of it is a cycle of many minutes. `IMAP_CYCLE_DEADLINE_MS` is the per-mailbox time
     * budget that closes it, and it lives on the pass rather than in the worker's scheduler.
     *
     * Each read here burns most of the per-read ceiling — legal on its own, three of them are not.
     */
    const clock = fakeClock();
    // ONE UID per folder, and the server takes two thirds of the per-read ceiling to produce it.
    // Every individual read is therefore legal; the frozen six together are not.
    const perItem = Math.floor(IMAP_READ_DEADLINE_MS * (2 / 3));
    const client = hostileClient({
      floodUids: 1, msPerItem: perItem, populateAllFolders: true, clock,
    });
    adapter = new ImapAdapter(cfg, {
      client, capabilityOverrides: { condstore: false }, nowMs: clock.now,
    });
    await adapter.connect();

    const err = await refusal(() => adapter!.changesSince(emptyCursor()));
    expect(err.bound).toBe("cycle_deadline");
    expect(err.limit).toBe(IMAP_CYCLE_DEADLINE_MS);
  });

  it("a refused pass does NOT poison the next one — the budget is cleared in a finally", async () => {
    /*
     * The failure mode this guards is self-inflicted: a `cycleDeadline` left set by a pass that
     * THREW would make every later pass refuse instantly on an expired clock, turning one hostile
     * cycle into a permanently broken mailbox. The first pass here is refused on the clock; the
     * second, against an honest folder, must succeed.
     */
    const clock = fakeClock();
    /*
     * ── THIS IS DRIVEN BY A *SUCCESSFUL* PASS NOW, AND THE REASON IS A LATER FIX ────────────
     *
     * It used to refuse a pass and then read again through the same adapter. That stopped being
     * a test of the budget: a refused pass RETIRES the adapter, and a retired adapter refuses
     * everything afterwards by a stronger rule — so the leak would be masked rather than shown.
     *
     * A healthy pass exercises the same `finally`. Time then passes (real cycles are minutes
     * apart), and the reads taken BETWEEN passes must not inherit a budget that has since
     * expired. Remove the `finally` and they do.
     */
    const opts = { floodUids: 2, msPerItem: 0, clock };
    adapter = new ImapAdapter(cfg, {
      client: hostileClient(opts), capabilityOverrides: { condstore: false }, nowMs: clock.now,
    });
    await adapter.connect();
    const healthy = await adapter.changesSince(emptyCursor());
    expect(healthy.creates.length).toBe(2);

    clock.advance(IMAP_CYCLE_DEADLINE_MS * 2);

    /*
     * ── THE READ THAT ACTUALLY CATCHES THE LEAK IS THE ONE BETWEEN PASSES ────────────────────
     *
     * Asserting only that the next `changesSince` succeeds does NOT test the `finally`, and this
     * case said it did until the mutation was run: `changesSince` ASSIGNS a fresh budget on entry,
     * so a leaked one is overwritten before it can be read, and removing the `finally` leaves
     * that assertion green. The mutation surviving is what found this — the claim was checking
     * something the code could not get wrong.
     *
     * The reads that DO consult a leaked budget are the ones taken outside a pass, where nothing
     * reassigns it: the worker's on-demand attachment reads, the Junk window's list and search,
     * folder discovery. Each composes the per-read ceiling with `cycleDeadline` via
     * `soonest`, so a stale expired budget makes every one of them refuse instantly and for ever
     * — one hostile cycle turned into a permanently broken mailbox.
     */
    await expect(adapter.listFolders()).resolves.toContain("INBOX");
    await expect(adapter.searchFolderPage("INBOX", "anything")).resolves.toBeDefined();

    // …and the next pass is healthy too.
    const batch = await adapter.changesSince(emptyCursor());
    expect(batch.creates.length).toBe(2);
  });
});

describe("per-mailbox isolation — what the refusal IS", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("the refusal is a mailbox-attributable class, recognisable without importing it", async () => {
    /*
     * THE ISOLATION ACCEPTANCE, and it is inherited rather than built in the adapter.
     *
     * The worker attributes a throw out of `runSyncCycle` to the mailbox it came from: that
     * folder's cursor is held, the cycle fails, the connection is closed and this mailbox
     * accumulates toward its ordinary quarantine cadence while every other mailbox on the shard
     * proceeds. What the adapter has to get right is that the error is attributable BY CLASS —
     * the worker deliberately RETHROWS shared-service faults (a database blip,
     * `LeaseUnavailableError`) so a shard-wide outage is not blamed on individual mailboxes, and
     * a bounds breach must not be mistaken for one of those. A server handing back an absurd number of
     * folders IS this mailbox's problem.
     */
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 10 });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();

    let caught: unknown;
    try { await adapter.changesSince(emptyCursor()); } catch (err) { caught = err; }

    expect(caught).toBeInstanceOf(ImapBoundExceeded);
    expect(isImapBoundExceeded(caught)).toBe(true);
    expect((caught as ImapBoundExceeded).code).toBe("EIMAPBOUND");
    expect((caught as ImapBoundExceeded).name).toBe("ImapBoundExceeded");
    // It names the mailbox's own folder, which is what an operator answering "why did this
    // mailbox quarantine" needs — and it is a closed-set code, not a sentence to match on.
    expect((caught as ImapBoundExceeded).folder).toBe("INBOX");
  });

  it("one mailbox's breach leaves a sibling adapter's cycle untouched", async () => {
    /*
     * The row's headline: the worker is SHARED, so the acceptance is not "the hostile mailbox
     * fails" but "the hostile mailbox fails ALONE". Two adapters, two connections, one process —
     * the shape the worker runs. The hostile one refuses; the honest one completes its cycle
     * afterwards with its creates intact.
     */
    const hostile = new ImapAdapter(cfg, {
      client: hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 10 }),
      capabilityOverrides: { condstore: false },
    });
    const honest = new ImapAdapter(cfg, {
      client: hostileClient({ floodUids: 3 }),
      capabilityOverrides: { condstore: false },
    });
    await hostile.connect();
    await honest.connect();
    try {
      await refusal(() => hostile.changesSince(emptyCursor()));
      const batch = await honest.changesSince(emptyCursor());
      expect(batch.creates.length).toBe(3);
      expect(batch.hasBacklog).toBe(false);
    } finally {
      await hostile.close();
      await honest.close();
    }
  });
});

/**
 * ═══ THE SEVEN THE REVIEW FOUND, AND WHY EACH ONE MATTERED ═════════════════════════════════
 *
 * A max-effort review of the first version raised seven findings and every one was valid. Five
 * were the same mistake in different clothes: **a ceiling that stops READING is not the same as a
 * ceiling that stops the SERVER.** The rest of this file proved the arrays stayed small; it did
 * not prove the commands behind them ended, and they did not.
 *
 *  1. `boundedCollect` checked the clock BETWEEN items, so a row started and never finished parked
 *     the loop inside `next()` where the clock is never read. The headline slow-loris defence was
 *     defeated by the most obvious slow loris there is.
 *  2. Only LIST and SEARCH were raced. `SELECT`, `STATUS`, `fetchOne` and `download` were awaited
 *     bare, so a pass could hang for ever without reaching one `check()`.
 *  3. The byte accounting was on the first body fetch only — and `fetchCapped`'s envelope-free
 *     RETRY is also a body fetch. Declare one byte, omit the row, return a gigabyte on the retry.
 *  4. The candidate ceiling counts PROBES. One probe of unbounded size satisfies it exactly.
 *  5. Breaking out of an ImapFlow generator does not cancel the FETCH, so every truncation left a
 *     read running and the next command queued behind it.
 *  6. A raced promise leaves its command outstanding, and the worker retains adapters across
 *     generic failures — so the connection had to be retired here, not by convention.
 *  7. `Math.min(...uids)` throws `RangeError` past the engine's argument limit, which is INSIDE the
 *     enumeration ceiling. Raising what was admissible created a crash.
 */
describe("abandoning a read is not ending it — the review's findings", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a row STARTED AND NEVER FINISHED is refused — the pull is raced, not the gap between pulls", async () => {
    const clock = fakeClock();
    const client = hostileClient({
      floodUids: 10_000, stallAfterItems: 1, msBeforeStall: IMAP_READ_DEADLINE_MS + 1, clock,
    });
    adapter = new ImapAdapter(cfg, {
      client, capabilityOverrides: { condstore: false }, nowMs: clock.now,
    });
    await adapter.connect();

    const err = await refusal(() => adapter!.changesSince(emptyCursor()));
    expect(err.bound).toBe("read_deadline");
    // One item arrived; the second pull never returned. A per-iteration check would still be
    // suspended inside `next()` and this call would never come back at all.
    expect(client.counters.uidsYielded).toBe(1);
    // RETIRED — proved by the adapter refusing again rather than by a close, which it no longer
    // performs from inside a throwing path (that is what stranded the failure count).
    await refusal(() => adapter!.listFolders());
  });

  it("a SELECT the server never answers is refused — not only LIST and SEARCH are raced", async () => {
    /*
     * THE TIMER PATH, and it needs vitest's fake timers rather than the injected clock.
     *
     * Every other time case here advances an injected `nowMs`, which is enough because the clock
     * is read between items. This one is different in kind: the SELECT never returns, so nothing
     * reads a clock at all and the only thing that can rescue the call is the `setTimeout` inside
     * `ImapDeadline.race`. That timer runs on the real clock, and the ceiling is three minutes —
     * so the timer itself has to be driven. Using an injected clock here would prove nothing,
     * because a hung promise never consults it.
     */
    vi.useFakeTimers();
    try {
      const client = hostileClient({ floodUids: 1, hangSelect: true });
      adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
      // `connect()` issues LIST only and selects nothing, so it completes.
      await adapter.connect();

      const pass = adapter.changesSince(emptyCursor());
      const settled = pass.then(() => "resolved" as const, (e: unknown) => e);
      // Just short of the ceiling: still waiting, which is what makes the next line meaningful.
      await vi.advanceTimersByTimeAsync(IMAP_READ_DEADLINE_MS - 1_000);
      // Past it.
      await vi.advanceTimersByTimeAsync(2_000);
      const outcome = await settled;
      expect(outcome).toBeInstanceOf(ImapBoundExceeded);
      expect((outcome as ImapBoundExceeded).bound).toBe("read_deadline");
      // The SELECT is still outstanding on the driver, so the adapter is finished — shown by its
      // refusal to do anything else, not by a close it deliberately no longer performs.
      await refusal(() => adapter!.listFolders());
    } finally {
      vi.useRealTimers();
    }
  });

  it("the envelope-free RETRY is byte-accounted too — declare small, omit the row, send a huge body", async () => {
    /*
     * SIZED SO ONLY THE RETRY'S OWN CEILING CAN FIRE, which is the whole difficulty of testing
     * this one. Four messages declaring 2 MiB each: the batch ceiling is 12 MiB and the
     * per-message ceiling is 3 MiB. The ordinary bodies arrive at their declared size, so the
     * first body loop has nothing to refuse; the row the server OMITTED comes back through the
     * envelope-free retry at 8 MiB — past its own ceiling and nowhere near the batch's.
     *
     * Written the obvious way first (tiny declared size, one big body) and the mutation SURVIVED:
     * the batch total caught it, so removing the retry's per-message check changed nothing.
     */
    const mib = 1024 * 1024;
    const client = hostileClient({
      floodUids: 4, declaredSize: 2 * mib, actualBodyBytes: 2 * mib,
      omitFirstBodyRow: true, retryBodyBytes: 8 * mib,
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();

    const err = await overrunIn(() => adapter!.changesSince(emptyCursor()));
    expect(err.bound).toBe("body_overrun");
    expect(err.observed).toBe(8 * mib);
    expect(err.limit).toBe(3 * mib);
    expect(err.site?.uidValidity).toBe("100");
    await refusal(() => adapter!.listFolders());
  });

  it("ONE candidate body of unbounded size is refused — the probe COUNT ceiling cannot see it", async () => {
    // A single candidate satisfies IMAP_CANDIDATE_BODY_PROBES_MAX exactly, and says nothing about
    // how large that one literal is.
    const client = hostileClient({
      // A parseable little source message, and ONE candidate offering 512 MiB.
      searchUids: [7],
      actualBodyBytes: 256,
      candidateBodyBytes: 512 * 1024 * 1024,
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { uidplus: false } });
    await adapter.connect();

    // The move refuses (it cannot verify the candidate) rather than adopting an unverified UID.
    await expect(
      adapter.move({ folder: "INBOX", ref: "100:1" }, "ohmail/News", FIXTURE_DOOR),
    ).rejects.toThrow();
    /*
     * AND THE ASSERTION IS THE BYTE COUNT, not the refusal. The move refuses either way — it
     * cannot fingerprint a body it declined — so "rejects" is true with and without the ceiling
     * and proves nothing. What the ceiling buys is that the half-gigabyte was never put on the
     * wire. (Written without this line first, and the mutation survived.)
     */
    expect(client.counters.bodyProbes).toBeGreaterThan(0);
    /*
     * THE ACCOUNTING, stated because the number is not obvious. `move` inspects the destination
     * more than once (a pre-check, and a re-look after the write decision), so the one candidate
     * is probed a small fixed number of times. Each probe is capped at the per-message ceiling
     * (64 MiB), so the total is a small multiple of it — measured 128 MiB for two probes.
     *
     * UNBOUNDED, each probe would take the whole 512 MiB the server offered, so the total would
     * exceed what was offered once. That is the discriminating threshold: anything at or above
     * 512 MiB means at least one probe ran without a ceiling.
     */
    expect(client.counters.downloadBytes).toBeGreaterThan(0);
    expect(client.counters.downloadBytes).toBeLessThan(512 * 1024 * 1024);
  });

  it("a UID array the ceiling ADMITS does not crash — no spread over a server-sized array", () => {
    /*
     * `Math.min(...uids)` passes one ARGUMENT per element and the JS engine throws
     * `RangeError: Maximum call stack size exceeded` well inside IMAP_ENUM_MAX_UIDS — measured on
     * this runtime well inside it, and at the next size up too. So the enumeration ceiling was
     * advertising a number the code could not then process, which is a ceiling that is not a
     * promise. Raising what is admissible is what made the shape reachable.
     *
     * TESTED DIRECTLY, and the first version did not. It drove `changesSince` with a huge spread of UIDs
     * and the mutation survived — because `minOf` is only reached on the SENT folder's FIRST scan
     * (`enumFloorUid`), and that fake had no Sent folder, so the spread was never evaluated. A
     * case that cannot reach the line it is about is worth nothing however plausible it reads.
     * The direct assertion also states the property in full: same ANSWER as the spread, at a size
     * the spread cannot survive.
     */
    const big = Array.from({ length: 200_000 }, (_v, i) => 200_000 - i);
    expect(big.length).toBeLessThan(IMAP_ENUM_MAX_UIDS);
    expect(minOf(big, Number.MAX_SAFE_INTEGER)).toBe(1);
    expect(() => Math.min(...big)).toThrow(RangeError);
    // The empty answer is the caller's sentinel, not 0 or Infinity.
    expect(minOf([], Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("a count breach retires the connection — the FETCH behind it is still running", async () => {
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 5 });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    await refusal(() => adapter!.changesSince(emptyCursor()));
    // Without the retirement, the next command would queue behind an abandoned read. It is shown
    // by the refusal rather than by a close — see the round-five block for why closing here is
    // what lost the mailbox's failure count.
    await refusal(() => adapter!.listFolders());
  });

  it("a SEARCH count breach does NOT retire the connection — that command already finished", async () => {
    /*
     * THE LINE BETWEEN THE TWO KINDS OF BREACH, asserted rather than assumed — and this case was
     * written the other way round first, expecting a retirement, which is what made the
     * distinction worth pinning.
     *
     * `search()` and `list()` return an already-materialised ARRAY: by the time the count ceiling
     * runs, the command has COMPLETED and nothing is outstanding. Retiring the connection there
     * would be throwing away a healthy socket over a response we simply declined to keep — and it
     * would make every over-answered Junk search cost a reconnect.
     *
     * Retirement is for ABANDONMENT: a stream we stopped pulling, or a command we stopped waiting
     * for. Both leave the driver holding a read nobody is consuming; a finished command does not.
     */
    const client = hostileClient({
      searchUids: Array.from({ length: IMAP_SEARCH_MAX_UIDS + 1 }, (_v, i) => i + 1),
    });
    adapter = new ImapAdapter(cfg, { client });
    await adapter.connect();
    await refusal(() => adapter!.searchFolderPage("INBOX", "invoice"));
    expect(client.counters.closed).toBe(0);
  });
});

/**
 * ═══ ROUND THREE — TWO CONSEQUENCES OF ROUND TWO'S OWN FIXES ═══════════════════════════════
 *
 * The review of round two raised two findings, both valid, and both were created BY round two.
 * That is worth stating plainly: each fix moved the failure rather than inventing it, and neither
 * would have existed before the thing that fixed something else.
 *
 *  1. Handing the driver `maxBytes: MAX_RAW_MESSAGE_BYTES` makes it emit exactly that many bytes
 *     and stop, so `total > MAX_RAW_MESSAGE_BYTES` can never be true. The read looks COMPLETE, the
 *     truncated prefix is fingerprinted, and a prefix can match — a source whose meaningful
 *     content ends before the cap fingerprints identically to its own truncation. The outcome is
 *     not a slow move but the WRONG one, followed by an expunge of the real source. This is the
 *     only finding in the whole slice that could have reached somebody's mail.
 *  2. `retireConnection` sets `closing` before closing, which is exactly what stops the adapter
 *     reporting a deliberate teardown as an out-of-band death — and wrong for a retirement whose
 *     caller does not throw. A `"stop"` truncation throws nothing, and the worker deliberately
 *     swallows `rearmWatch` failures because it expects the close listener to detach. The
 *     connection would be dead, marked closed, and still held.
 *
 * MUTATIONS WATCHED (2026-09-01), scripted and re-run:
 *  · the candidate cap asked for as exactly `MAX_RAW_MESSAGE_BYTES` ⇒ RED (the requested-ceiling
 *    assertion; that one byte is the whole mechanism);
 *  · the retirement no longer notifies the adapter's owner ⇒ RED on both the throwing and the truncating
 *    case — and the truncating one is the case a convention could never have covered;
 *  · refusing every read that REACHED the cap (`>=`) ⇒ RED, and it is the reverse of what round
 *    three shipped. That version refused a body of exactly the maximum as possibly-truncated —
 *    but with the limiter asked for `MAX + 1` such a body ends normally with a byte to spare, so
 *    it is COMPLETE and `normalizeMime` accepts exactly that size. Discarding it made a
 *    legitimate 64 MiB message permanently unverifiable, and on the COPY fallback (no MOVE, no
 *    UIDPLUS) verification is the only way to learn the destination UID — so every retry left the
 *    source and added another 64 MiB copy. The exactly-maximum case pins it, with the candidate
 *    byte-identical to the source so the adopt/refuse outcome actually turns on the rule.
 *
 * Also fixed with these, one layer out and guarded in the worker's own suite: a ceiling breach was
 * classified by the ingest fault table as a poison MESSAGE (its catch-all), so a server tripping a
 * ceiling every cycle earned durable failure rows against messages still sitting on the server. It
 * is infrastructure — the host's fault, not the message's — which holds the row and fails the
 * cycle instead.
 */
describe("round three — the two the second review found", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a candidate that SATURATES the byte cap is unverifiable — never fingerprinted as a match", async () => {
    /*
     * The server understates `RFC822.SIZE` and offers a body far past the ceiling, so the driver
     * stops at the cap. The old check (`total > MAX_RAW_MESSAGE_BYTES`, with the cap asked for
     * exactly) could not see that; the prefix went to `fingerprintOf` and a matching prefix would
     * have made the move adopt this UID and expunge the real source.
     *
     * The assertion is that the move REFUSES. With the saturation treated as evidence it would
     * instead return a locator — and that locator would be the stranger's.
     */
    const client = hostileClient({
      searchUids: [7], actualBodyBytes: 256, candidateBodyBytes: 512 * 1024 * 1024,
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { uidplus: false } });
    await adapter.connect();

    /*
     * THE ASSERTION IS THE ERROR CLASS, and the first version of this case did not have it.
     * `rejects.toThrow()` was satisfied by a `TypeError` from a driver method the fake had not
     * implemented, so BOTH mutations of this guard survived — the move "failed" either way, for a
     * reason that had nothing to do with the ceiling. `MoveVerifyError` is the honest refusal: the
     * destination holds something this adapter cannot prove is ours.
     *
     * Treat the saturated prefix as evidence instead and the fingerprints match (two buffers of
     * the same filler parse to the same empty message), so the move RESOLVES — with a locator
     * pointing at the stranger's UID, and an expunge of the real source behind it.
     */
    await expect(
      adapter.move({ folder: "INBOX", ref: "100:1" }, "ohmail/News", FIXTURE_DOOR),
    ).rejects.toThrow(MoveVerifyError);

    /*
     * AND THE CEILING IS ASKED FOR AS `MAX + 1`, asserted white-box because that ONE byte is the
     * whole mechanism. Ask for exactly the maximum and the driver emits exactly that and stops:
     * the read is indistinguishable from a complete one, `total > MAX` can never be true, and the
     * prefix goes to the fingerprint.
     *
     * ── AND WHAT THIS FILE DOES *NOT* PROVE, STATED PLAINLY ──────────────────────────────────
     *
     * That a saturated prefix would actually MATCH. Producing the collision needs a source that
     * is a byte-prefix of the candidate and whose MIME parse survives truncation at the ceiling —
     * a 64 MiB multipart whose meaningful content ends early — and this harness does not build
     * one. `normalizeMime` accepts a body of exactly the maximum, so the collision is reachable
     * rather than hypothetical; the refusal is by CONSTRUCTION (a read that reached the ceiling is
     * unverifiable, full stop) rather than by a case reproducing it. Recorded here so the next
     * reader knows which half is measured.
     */
    expect(client.counters.downloadCaps.length).toBeGreaterThan(0);
    for (const cap of client.counters.downloadCaps) {
      expect(cap).toBe(MAX_RAW_MESSAGE_BYTES + 1);
    }
  });

  it("a retirement TELLS THE OWNER, so a caller that swallows the failure still detaches", async () => {
    /*
     * `forceClose()` marks the teardown deliberate, which silences the adapter's own close
     * listener. That is right for a close we asked for and wrong here, because the retirement may
     * be the only signal there is. Reported as the connection-ENDED class, which the worker reads
     * as "detach, do not quarantine" — a retired socket is not a broken mailbox, and the breach is
     * separately quarantining through the cycle's failure count.
     */
    const told: unknown[] = [];
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 5 });
    adapter = new ImapAdapter(cfg, {
      client, capabilityOverrides: { condstore: false },
      onConnectionError: (err) => { told.push(err); },
    });
    await adapter.connect();
    await refusal(() => adapter!.changesSince(emptyCursor()));

    /*
     * ── AND IT IS SILENT, WHICH IS THE REVERSE OF WHAT THIS CASE FIRST ASSERTED ─────────────
     *
     * Round three notified unconditionally and this case checked that it did. The next review
     * showed the notification BREAKS the quarantine contract: a detach deletes the runtime, the
     * next attach starts at `failures: 0`, and a server breaching every cycle therefore never
     * reaches the consecutive-failure threshold — reconnected every roster interval, for ever,
     * never quarantined. The isolation this whole file exists for, undone by the line meant to
     * strengthen it.
     *
     * A breach that THROWS is already reported by the throw, and that report is the one that
     * counts. So the connection is retired and nobody is told.
     */
    /*
     * ── THIS CASE HAS NOW ASSERTED BOTH ANSWERS, AND THAT IS THE RECORD ────────────────────
     *
     * It first checked that a retirement TELLS the consumer, then that it does NOT (because a
     * report of the wrong class reset the mailbox's failure count), and now that it tells it with
     * the BREACH. The three readings are in `retiredBecause`; what survives all of them is that
     * the connection ends and the consumer learns something it can act on.
     */
    expect(client.counters.closed).toBeGreaterThan(0);
    expect(told.length).toBe(1);
    expect(told[0]).toBeInstanceOf(ImapBoundExceeded);
    // Finished: it refuses everything from here.
    await refusal(() => adapter!.listFolders());
  });

  it("…and a TRUNCATING ceiling, which throws nothing at all, tells the user too", async () => {
    /*
     * The case the convention could never have covered. A sample scan that hits its row ceiling
     * returns a perfectly good answer and raises nothing — so if the retirement were silent, the
     * caller would carry on holding a closed connection with no error anywhere to explain it.
     */
    const told: unknown[] = [];
    const client = hostileClient({ floodUids: 5, overAnswerPage: 40 });
    adapter = new ImapAdapter(cfg, {
      client, onConnectionError: (err) => { told.push(err); },
    });
    await adapter.connect();
    // Forty rows for a page of two — the over-answer the page ceiling declines with a `break`.
    const page = await adapter.listFolderPage("INBOX", { limit: 2 });
    expect(page).not.toBeNull();
    expect(page!.items.length).toBe(2);
    // Nothing threw, and the connection is still retired and the adapter's owner still told.
    // Nothing threw, so the report is the ONLY signal there is — and it carries the breach, not
    // a blameless disconnect, because the second is what a consumer declines to act on.
    expect(client.counters.closed).toBeGreaterThan(0);
    expect(told.length).toBe(1);
    expect(told[0]).toBeInstanceOf(ImapBoundExceeded);
  });

  it("a body of EXACTLY the maximum is complete, not saturated — it still fingerprints", async () => {
    /*
     * The correction to round three's own over-caution. With the limiter asked for `MAX + 1`, a
     * genuine body of exactly the maximum ends normally with a byte still available, so it is
     * COMPLETE — and `normalizeMime` accepts exactly that size. Treating it as truncated made a
     * legitimate 64 MiB message permanently unverifiable, and on the COPY fallback (no MOVE, no
     * UIDPLUS) verification is the ONLY way to learn the destination UID: every retry would leave
     * the source in place and add another 64 MiB copy at the destination.
     *
     * THE CANDIDATE IS BYTE-IDENTICAL TO THE SOURCE, and that is what makes the case
     * discriminating rather than merely plausible. Asserting "the body was read" proves nothing:
     * the bytes cross the wire either way, and the only difference is whether they are allowed to
     * REACH the fingerprint. So the destination holds our own message, at exactly the maximum
     * size, and the correct outcome is that the move recognises it and ADOPTS that UID.
     *
     * Discard the exactly-maximum read and there is no match, so the move raises `MoveVerifyError`
     * — a message the mailbox already holds, permanently unverifiable, with a fresh 64 MiB copy
     * added on every retry.
     */
    const client = hostileClient({
      searchUids: [7],
      actualBodyBytes: MAX_RAW_MESSAGE_BYTES,
      candidateBodyBytes: MAX_RAW_MESSAGE_BYTES,
    });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { uidplus: false } });
    await adapter.connect();
    const moved = await adapter.move({ folder: "INBOX", ref: "100:1" }, "ohmail/News", FIXTURE_DOOR);
    expect(moved.folder).toBe("ohmail/News");
    // Our own copy, recognised: the destination UID the SEARCH named.
    expect(moved.ref.endsWith(":7")).toBe(true);
    expect(client.counters.downloadBytes).toBeGreaterThanOrEqual(MAX_RAW_MESSAGE_BYTES);
  });
});

/**
 * ═══ ROUND SIX — CLOSE, AND REPORT THE BREACH ══════════════════════════════════════════════
 *
 * Three designs preceded this one and each was undone by review; `retiredBecause` in the adapter
 * carries the full account. The short version: a breach has to END the connection (an abandoned
 * command holds the driver's queue) AND MARK the mailbox (or a server breaching every cycle is
 * reconnected for ever), and the first three attempts each satisfied one at the other's expense.
 *
 * Keeping the socket alive so later cycles could be counted was the worst of them, and it failed
 * in three ways at once: the lease read runs before the cycle and on the raw client, so it queued
 * behind the abandoned command rather than reaching the refusal; a socket the server then closed
 * reported itself as a blameless disconnect; and the polite teardown queues behind the same hung
 * command, so detaching — and the status write that depends on it — could hang for ever.
 *
 * So the connection is destroyed and the BREACH is reported. A consumer reads it as this mailbox's
 * fault and quarantines it at once, which is stricter than a consecutive-failure threshold and
 * deliberately so: a threshold is for faults that recover, and a server that sent an unreasonable
 * amount, lied about a size, or took minutes over one command is not that. Quarantine is a marked
 * status and a backoff, not a permanent door.
 *
 * MUTATIONS WATCHED (2026-09-01), scripted and re-run — see the battery for the table.
 */
describe("a breach ends the connection and reports itself, so the mailbox is marked", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("THE BREACH ITSELF is what the consumer is told — not a blameless closed connection", async () => {
    /*
     * THE ASSERTION THE WHOLE CONTRACT TURNS ON, and the one every earlier design got wrong.
     *
     * A consumer's handler reads a connection-ENDED error as nobody's fault: detach, do not mark.
     * Reporting a breach that way — or not reporting it at all — left the mailbox unmarked and
     * reconnected on the next pass, for ever. The class of this error is therefore the mechanism,
     * not a detail: it is what makes the mailbox get quarantined.
     */
    const told: unknown[] = [];
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 5 });
    adapter = new ImapAdapter(cfg, {
      client, capabilityOverrides: { condstore: false },
      onConnectionError: (err) => { told.push(err); },
    });
    await adapter.connect();

    const first = await refusal(() => adapter!.changesSince(emptyCursor()));
    expect(first.bound).toBe("enumerate_uids");

    expect(told.length).toBe(1);
    expect(told[0]).toBeInstanceOf(ImapBoundExceeded);
    expect((told[0] as ImapBoundExceeded).bound).toBe("enumerate_uids");
    // NOT the blameless class, which is the whole point.
    expect((told[0] as Error).name).not.toBe("ImapConnectionClosedError");
    // The connection is really gone, so the abandoned FETCH cannot hold the next command.
    expect(client.counters.closed).toBeGreaterThan(0);
    // Reported ONCE, however many surfaces are tried afterwards.
    await refusal(() => adapter!.listFolders());
    expect(told.length).toBe(1);
  });

  it("the LEASE accessors refuse too — they run before the cycle and on the raw client", async () => {
    /*
     * The bypass that sank the previous design. `mayOrganize()` reads the lease BEFORE
     * `changesSince`, through an object holding the raw client, so a retired adapter would have
     * been reached for there — and that failure is wrapped as a lease fault, which a consumer
     * deliberately does not blame the mailbox for. The breach has to escape before the wrapping.
     */
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 5 });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    await refusal(() => adapter!.changesSince(emptyCursor()));

    for (const reach of [
      () => adapter!.leaseIo(TEST_META_ID), () => adapter!.profileIo(TEST_META_ID), () => adapter!.leasePeekIo(),
    ]) {
      let caught: unknown;
      try { reach(); } catch (e) { caught = e; }
      expect(caught).toBeInstanceOf(ImapBoundExceeded);
    }
  });

  it("close() does NOT wait out the hang it is escaping", async () => {
    /*
     * The polite teardown issues a LOGOUT, the driver serialises commands, and the abandoned
     * command is exactly what a LOGOUT queues behind — so `close()` after a breach would wait for
     * the stall it was called to escape. On the quarantine path the status write happens after the
     * detach, so a teardown that never returns is a mailbox that is never marked.
     */
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 5 });
    const a = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await a.connect();
    await refusal(() => a.changesSince(emptyCursor()));
    const before = client.counters.logouts;
    await a.close();
    // No LOGOUT was issued on the dead connection.
    expect(client.counters.logouts).toBe(before);
  });

  it("every server-touching entry point refuses once retired, not just the cycle", async () => {
    // A retired adapter that answered one surface and refused another would leave the worker
    // holding something half-alive, which is the state this whole mechanism exists to end.
    const client = hostileClient({ floodUids: IMAP_ENUM_MAX_UIDS + 5 });
    adapter = new ImapAdapter(cfg, { client, capabilityOverrides: { condstore: false } });
    await adapter.connect();
    await refusal(() => adapter!.changesSince(emptyCursor()));

    await refusal(() => adapter!.listFolders());
    await refusal(() => adapter!.searchFolderPage("INBOX", "anything"));
    await refusal(() => adapter!.listFolderPage("INBOX", { limit: 2 }));
  });

  it("a TRUNCATING ceiling reports and closes too — one rule, not two", async () => {
    /*
     * Earlier designs split this: throwing paths silent, truncating paths reported. The split was
     * what made the mailbox's marking depend on WHICH ceiling fired, and every version of it
     * lost the marking somewhere. One rule now — a breach ends the connection and reports itself
     * — and a truncating ceiling is no exception even though it returns a usable answer.
     */
    const told: unknown[] = [];
    const client = hostileClient({ floodUids: 5, overAnswerPage: 40 });
    adapter = new ImapAdapter(cfg, {
      client, onConnectionError: (err) => { told.push(err); },
    });
    await adapter.connect();
    const page = await adapter.listFolderPage("INBOX", { limit: 2 });
    expect(page!.items.length).toBe(2);
    expect(client.counters.closed).toBeGreaterThan(0);
    expect(told.length).toBe(1);
    expect(told[0]).toBeInstanceOf(ImapBoundExceeded);
    /*
     * ── AND IT NAMES THE CEILING THAT ACTUALLY FIRED ──────────────────────────────────────
     *
     * The truncating ceilings raise nothing of their own, so this retirement first reported a
     * fabricated `read_deadline` with a limit of zero — a clock that had not run out, sent to the
     * consumer and rethrown by every later call. The report is HOW a mailbox gets marked, so the
     * condition it names is what an operator reads and what bound-specific handling branches on.
     * A code naming the wrong condition is worse than no code.
     */
    expect((told[0] as ImapBoundExceeded).bound).toBe("page_rows");
    expect((told[0] as ImapBoundExceeded).limit).toBe(2);
  });

  it("a SAMPLE ceiling names sample_rows, not a clock that never ran out", async () => {
    // The other truncating ceiling, and the same requirement: a smaller sample is an honest
    // answer, and the retirement it causes has to say what caused it.
    const told: unknown[] = [];
    const client = hostileClient({ floodUids: IMAP_SAMPLE_MAX_ROWS + 50 });
    adapter = new ImapAdapter(cfg, {
      client, onConnectionError: (err) => { told.push(err); },
    });
    await adapter.connect();
    const senders = await adapter.sampleSenders("INBOX", 5);
    expect(Array.isArray(senders)).toBe(true);
    expect(told.length).toBe(1);
    expect((told[0] as ImapBoundExceeded).bound).toBe("sample_rows");
    expect((told[0] as ImapBoundExceeded).limit).toBe(IMAP_SAMPLE_MAX_ROWS);
  });
});

describe("the hand-written stream loops read the clock too", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("a page whose rows arrive glacially is refused by the per-read clock", async () => {
    /*
     * NOT every stream goes through the raced-pull helper. The flag drain, the two sample scans,
     * the two paged reads and the body fetch each drive their own `for await`, and each consults
     * `ImapDeadline.check` between rows. Those checks had no case at all once the enumeration
     * moved to the raced iterator — a mutation to `check()` survived, which is how this was found.
     *
     * The server here answers a two-item page one row per two minutes: never idle, never
     * over-answering by count, and never finishing inside the ceiling.
     */
    const clock = fakeClock();
    const client = hostileClient({
      floodUids: 5, overAnswerPage: 40, msPerItem: 120_000, clock,
    });
    adapter = new ImapAdapter(cfg, { client, nowMs: clock.now });
    await adapter.connect();
    const err = await refusal(() => adapter!.listFolderPage("INBOX", { limit: 30 }));
    expect(err.bound).toBe("read_deadline");
  });
});

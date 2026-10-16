import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import {
  IMAP_LIST_MAX_FOLDERS, IMAP_FOLDER_PATH_MAX_CHARS, IMAP_ENUM_MAX_UIDS,
  IMAP_SEARCH_MAX_UIDS, IMAP_CANDIDATE_BODY_PROBES_MAX, IMAP_ENVELOPE_ADDRESSES_MAX,
  IMAP_FLAG_SCAN_MAX_ROWS, IMAP_SAMPLE_MAX_ROWS,
  IMAP_BODY_OVERRUN_FACTOR, IMAP_BODY_OVERRUN_FLOOR_BYTES,
  IMAP_READ_DEADLINE_MS, IMAP_CYCLE_DEADLINE_MS,
  IMAP_META_BYTES_MAX, IMAP_META_DEADLINE_MS,
  type ImapBoundKind,
} from "../../src/adapters/imap-bounds.js";

/**
 * ═══ THE ADAPTER'S SERVER-VALUE CENSUS ═════════════════════════════════════════════════════
 *
 * The input-bounds census in `packages/api/test/` made it impossible to
 * add a CALLER-chosen count or size to the API without an author saying, in a diff, what bounds
 * it. This is the same instrument pointed at the other end of the adapter: **a new read from an
 * arbitrary IMAP server cannot enter `imap.ts` without being dispositioned.**
 *
 * ## Why a census and not four patches
 *
 * The ledger row named four sites. Enumerating the file's actual server reads found NINE, and
 * three of the extra five were found by this census while it was being written rather than by
 * reading — the flag drain (whose budget counts CHANGES, so the two commonest dispositions cost
 * nothing and a verbose provider streams a whole folder for free), and the two sample scans
 * (whose open-ended ranges exit on a condition a hostile server simply never satisfies). A patch
 * per named site would have fixed four and taught the file nothing.
 *
 * ## Three censuses, each EXACT over a stated domain, with no remainder
 *
 *  1. **Every `this.client.<method>(…)` call in `imap.ts`**, derived from the AST. Each is
 *     classified. A new one — or a new method on an existing function — is red until placed.
 *  2. **`list` and `search` have exactly ONE call site each**, and it is inside the bounded
 *     helper. This is the structural guarantee: the ceiling cannot be forgotten at a new call
 *     site, because there is no new call site to forget it at.
 *  3. **Every {@link ImapBoundKind} is enforced somewhere in the source.** A declared bound that
 *     nothing raises is a ceiling that exists only in the type.
 *
 * ## What this does NOT claim — the honest half
 *
 *  · **A disposition of `bounded_by_input` is an INVENTORY, not a clearance.** It says the range
 *    or array handed to that fetch was itself produced by a bounded read. That is a real
 *    argument and it is only as good as the bound upstream; it is recorded here so the chain is
 *    visible rather than assumed.
 *  · **`no_server_sized_result` is a claim about the COMMAND, not about the server.** `mailboxCreate`,
 *    `messageMove`, `status` and the locks answer a fixed-size result whatever the server holds.
 *    A server can still be SLOW on any of them, and the wall clock — not this census — is what
 *    covers that.
 *  · **This census sees `this.client.…` and nothing else.** A read reached through a helper
 *    object (`leaseIo()`, `profileIo()`) is out of its domain by construction; those have their
 *    own modules and a separate row tracks them. Stated so the gap is
 *    named rather than discovered.
 *  · **Nothing here proves a ceiling WORKS.** That is `imap.hostile-server.test.ts`, which drives
 *    a real `ImapAdapter` against a lying server and watches each guard refuse — and watches each
 *    one go red when it is removed. This file proves only that every server read has been LOOKED
 *    AT, and that a new one cannot arrive unlooked-at.
 */

const ADAPTER = resolve(__dirname, "../../src/adapters/imap.ts");
const BOUNDS = resolve(__dirname, "../../src/adapters/imap-bounds.ts");
/* The two modules the adapter hands its RAW client to — out of the census above by construction,
   which is the residual its docblock names and this file now covers instead of stating. */
const LEASE = resolve(__dirname, "../../src/adapters/organizer-lease.ts");
const PROFILE = resolve(__dirname, "../../src/adapters/organizer-profile.ts");
/* The API's own doors. Read from source rather than imported: the question is which call sites
   exist, and an import answers a different one. */
const API_SRC = resolve(__dirname, "../../../api/src");

/**
 * How a server read is bounded. An exact, closed set — a call site must be exactly one of these,
 * and the string is the ARGUMENT, so a wrong one is visible in review rather than plausible.
 */
type Disposition =
  /** Goes through `listBounded` / `searchBounded` / `boundedCollect` — a ceiling on the pull. */
  | "bounded_read"
  /** A loop with its own row ceiling and deadline check, written out at the site. */
  | "bounded_loop"
  /** The range or array asked for was itself produced by an already-bounded read. */
  | "bounded_by_input"
  /** One message, named by the caller — the count is 1 by construction. */
  | "single_message"
  /** Bounded in bytes by the driver's own `maxBytes`, or by a count-as-we-go on the stream. */
  | "bounded_bytes"
  /** The command's result is not sized by what the server holds. */
  | "no_server_sized_result";

/**
 * THE LEDGER. `function|method` → why the read this site issues cannot be made unbounded by the
 * server, in the author's own words.
 *
 * Exact in both directions: a site in the source and not here is red, and a site here and not in
 * the source is red (a stale row is how a census stops describing the file it audits).
 */
const SINKS: Record<string, { how: Disposition; why: string }> = {
  // ── LIST: one site, inside the helper ──────────────────────────────────────────────────────
  "listBounded|list": {
    how: "bounded_read",
    why: "boundListResponse — IMAP_LIST_MAX_FOLDERS on the count and IMAP_FOLDER_PATH_MAX_CHARS per path, plus the read deadline, which is what actually bounds it because the driver has already buffered the array",
  },
  // ── SEARCH: one site, inside the helper ────────────────────────────────────────────────────
  "searchBounded|search": {
    how: "bounded_read",
    why: "boundSearchResult — IMAP_SEARCH_MAX_UIDS before any caller copies, sorts or iterates it",
  },

  // ── UID ENUMERATION: the row's `:1677,1681` ────────────────────────────────────────────────
  "enumerateUids|fetch": {
    how: "bounded_read",
    why: "boundedCollect stops PULLING at IMAP_ENUM_MAX_UIDS; the batch budget bounds bodies and is consulted long after this array exists",
  },
  "enumerateNewestUids|fetch": {
    how: "bounded_read",
    why: "boundedCollect at IMAP_ENUM_MAX_UIDS — a sequence range asks for `count` and the server decides what it sends",
  },
  "messageIdsHeld|fetch": {
    how: "bounded_read",
    why: "boundedFetch at IMAP_ENUM_MAX_UIDS on the count and MESSAGE_ID_FIELD_MAX_BYTES per enumerated UID on the header bytes, under the read clock; a breach refuses and retires the connection",
  },
  "enumerateUidsFrom|fetch": {
    how: "bounded_read",
    why: "boundedCollect counts what the server SENDS, not what survives the `uid >= fromUid` filter, or a reversed-range flood would stream while the array stayed empty",
  },

  // ── THE FLAG DRAIN: found by this census, not by the row ───────────────────────────────────
  "changesSinceInner|fetch": {
    how: "bounded_loop",
    why: "IMAP_FLAG_SCAN_MAX_ROWS on rows EXAMINED — the flag budget counts CHANGES, and the unknown-UID and agreement dispositions spend none of it. It REFUSES and retires the connection: it truncated at first, on the premise that breaking out of the generator stops the read, which is false — the driver keeps draining and the next SELECT queues behind it",
  },

  // ── THE SAMPLE SCANS: found by this census ─────────────────────────────────────────────────
  "sampleSenders|fetch": {
    how: "bounded_loop",
    why: "IMAP_SAMPLE_MAX_ROWS — an open-ended range whose exit condition is `limit` DISTINCT addresses, which a server repeating one address never satisfies",
  },
  "scanSentRecipients|fetch": {
    how: "bounded_loop",
    why: "IMAP_SAMPLE_MAX_ROWS, and boundEnvelopeAddresses per message so one 4 000-address header is not spread whole",
  },

  // ── THE TWO BOUNDED PAGES ──────────────────────────────────────────────────────────────────
  "listFolderPage|fetch": {
    how: "bounded_loop",
    why: "the sequence window names at most `limit`; rows past it are the server over-answering a bounded page and are declined rather than retained",
  },
  "searchFolderPage|fetch": {
    how: "bounded_loop",
    why: "`wanted` is at most `limit` UIDs sliced from an already-bounded SEARCH; a longer answer is declined",
  },

  // ── THE BODY PATHS ─────────────────────────────────────────────────────────────────────────
  "fetchCapped|fetch": {
    how: "bounded_by_input",
    why: "the RFC822.SIZE pre-fetch, over `slice`, already capped at the pass's message budget",
  },
  "fetchSized|fetch": {
    how: "bounded_bytes",
    why: "three sites: the BODY fetch, the withheld retry and its structure-free last resort, over the already-capped `take`; all count arriving bytes against IMAP_BODY_OVERRUN_FACTOR per message and against the batch's declared total, because every byte ceiling above it trusts a number the server chose. The BODYSTRUCTURE beside the source is server-sized like the ENVELOPE: the read clock bounds it while imapflow parses, and structureOf keeps at most MAX_STRUCTURE_NODES nodes",
  },
  "fetchUnsized|fetch": {
    how: "bounded_bytes",
    why: "three sites, one UID each, for messages the server stated no RFC822.SIZE for: every row is capped at the MIME ceiling (messageOverrunCeiling) and every row of a command, another UID's included, counts against UNSIZED_COMMAND_CEILING, which retires the connection; the next UID is asked only while the bytes that arrived leave pass budget, so a pass overshoots by at most one capped message",
  },
  "oversizeHeads|fetch": {
    how: "bounded_bytes",
    why: "over `refused`, the UIDs this pass's size pre-fetch already capped; BODY.PEEK[HEADER] with maxLength OVERSIZE_HEAD_MAX_BYTES, a header over it retires the connection like a body overrun, under the read clock",
  },
  "arrivalDatesFor|fetch": {
    how: "bounded_by_input",
    why: "chunked over `misses`, a subset of the UID list `enumerateUids` already bounded",
  },
  "fetchByUid|fetch": {
    how: "bounded_by_input",
    why: "four sites, all over `wanted` / `take` / `withheld` / `bare` — UID arrays the CALLER names, bounded by the API door that produced them",
  },
  "streamPart|download": {
    how: "bounded_bytes",
    why: "counts as it goes inside the stream loop and abandons past `opts.maxBytes` — the pre-existing ceiling this row did not need to change; `fetchPart` and `fetchPartTo` both read through it",
  },
  "fetchRaw|download": {
    how: "bounded_bytes",
    why: "hands `maxBytes` to the driver so the fetch stops at a chunk boundary, then refuses a short read against RFC822.SIZE",
  },
  "serverCopyAt|download": {
    how: "bounded_bytes",
    why: "the server's own Sent copy after a send: `maxBytes` MAX_RAW_MESSAGE_BYTES + 1 to the driver, drained, refused past the ceiling or short of RFC822.SIZE, inside the send's find clock",
  },

  // ── SINGLE-MESSAGE READS ───────────────────────────────────────────────────────────────────
  "destinationLook|download": {
    how: "bounded_bytes",
    why: "one candidate body per probe, bounded TWICE and it needs both: IMAP_CANDIDATE_BODY_PROBES_MAX caps how many, and the download's byte ceiling caps how large each one is — a candidate count of ONE satisfies the count ceiling and says nothing about the size of that one literal. It replaced a `fetchOne(source: true)`, which materialised the whole body before this code saw a byte of it",
  },
  "sourceFingerprintOf|fetchOne": { how: "single_message", why: "one UID, named by the caller's locator" },
  "fetchStructure|fetchOne": {
    how: "single_message",
    why: "one UID's BODYSTRUCTURE, named by the door's locator, under the operation clock the API door races it with; structureOf keeps at most MAX_STRUCTURE_NODES nodes",
  },
  "move|fetchOne": { how: "single_message", why: "one UID, the move's source probe" },
  "setFlags|fetchOne": { how: "single_message", why: "one UID, the existence probe" },
  "moveMany|fetchAll": {
    how: "bounded_by_input",
    why: "over the caller's group, bounded by FILING_BATCH_MAX before it reaches the adapter",
  },

  // ── COMMANDS WHOSE RESULT THE SERVER DOES NOT SIZE ─────────────────────────────────────────
  "connect|connect": { how: "no_server_sized_result", why: "the greeting and login; bounded by the connect and greeting timeouts" },
  "close|logout": { how: "no_server_sized_result", why: "teardown" },
  "close|close": { how: "no_server_sized_result", why: "teardown" },
  "forceClose|close": { how: "no_server_sized_result", why: "teardown" },
  "ensureFolders|mailboxCreate": { how: "no_server_sized_result", why: "CREATE answers a status line" },
  "createFolder|mailboxCreate": { how: "no_server_sized_result", why: "CREATE answers a status line" },
  "resolveSentFolder|mailboxCreate": { how: "no_server_sized_result", why: "CREATE answers a status line" },
  "renameFolder|mailboxRename": { how: "no_server_sized_result", why: "RENAME answers a status line" },
  "deleteFolderByPath|mailboxDelete": { how: "no_server_sized_result", why: "DELETE answers a status line" },
  "folderStatedGone|status": { how: "no_server_sized_result", why: "STATUS answers a fixed set of counters, under the read deadline through `bounded`" },
  "folderFence|mailboxOpen": {
    how: "no_server_sized_result",
    why: "EXAMINE answers the mailbox's own counters — and it replaced deleteFolder's STATUS, which RFC 3501 6.3.10 lets a server answer from the state it already reported for the selected mailbox",
  },
  "ensureFolders|mailboxRename": { how: "no_server_sized_result", why: "RENAME answers a tagged OK — the one-time News rename (0.22), organizer-only" },
  "moveAllByPath|messageMove": { how: "no_server_sized_result", why: "MOVE answers a UID map for a range the caller named" },
  "move|messageMove": { how: "no_server_sized_result", why: "one message" },
  "move|messageCopy": { how: "no_server_sized_result", why: "one message" },
  "move|messageDelete": { how: "no_server_sized_result", why: "one message" },
  "moveMany|messageMove": { how: "no_server_sized_result", why: "a caller-bounded group" },
  "setFlags|messageFlagsAdd": { how: "no_server_sized_result", why: "one message" },
  "setFlags|messageFlagsRemove": { how: "no_server_sized_result", why: "one message" },
  "send|append": { how: "no_server_sized_result", why: "APPEND answers a status line" },
  "startIdle|idle": { how: "no_server_sized_result", why: "IDLE is a wait, ended by the driver; the untagged responses it delivers are handled by the watch callbacks, not accumulated here" },
  "noop|noop": { how: "no_server_sized_result", why: "NOOP answers a status line, and the untagged responses it may carry are the driver's to deliver. It is the ONE site here with no deadline of its own: the heartbeat that issues it owns a window shorter than the read deadline, and bounding it here would make the fast detector as slow as the slow one" },
  /*
   * THE WAKE-STORM SINK, enumerated and dispositioned rather than left unexamined.
   *
   * A server may emit untagged EXISTS without limit, and `watch`'s handler calls the wake callback
   * on every one of them — so the obvious worry is a flood turning into a flood of sync cycles.
   * It does not, and the bound is at the WORKER rather than here: `kickCycle` opens with
   * `if (stopped || cycleQueued) return`, so any number of wakes collapses into at most one queued
   * rotation, and `noteWake` writes a single timestamp per mailbox. Nothing accumulates.
   *
   * Checked rather than assumed, because "the callback is cheap" is only half an answer — the half
   * that matters is that the callback's EFFECT is idempotent, and that is a property of code in
   * another package. Recorded here so the next reader does not have to re-derive it, and so that a
   * change which removed the coalescing would have to argue with this note.
   *
   * The residual is one equality test and one clock read per event, bounded by the socket's read
   * rate. That is not worth a ceiling of its own.
   */
  "watch|on": { how: "no_server_sized_result", why: "an event registration; the events it delivers are coalesced by the worker's kickCycle, so an EXISTS flood yields at most one queued rotation" },
  "watch|removeListener": { how: "no_server_sized_result", why: "an event registration, not a command" },
  // Every `getMailboxLock` — a SELECT answering one mailbox status object.
  "changesSinceInner|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "changesSinceInner|mailboxOpen": {
    how: "no_server_sized_result", why: "the re-SELECT of a folder imapflow held selected, for fresh quiet keys",
  },
  "destinationLook|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "fetchByUid|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "streamPart|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "fetchStructure|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "fetchRaw|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "listFolderPage|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "messageInSent|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "serverCopyAt|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "deleteFolderByPath|getMailboxLock": { how: "no_server_sized_result", why: "EXAMINE" },
  "moveAllByPath|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "moveMany|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "move|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "rearmWatch|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "sampleSenders|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "scanSentRecipients|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "searchFolderPage|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "sourceFingerprintOf|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "setFlags|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "watch|getMailboxLock": { how: "no_server_sized_result", why: "SELECT" },
  "folderStatus|status": { how: "no_server_sized_result", why: "STATUS answers one folder's three counters, under the caller's deadline composed with the read ceiling" },
};

/** Every `this.client.<method>(…)` in the adapter, as `enclosingFunction|method` → lines. */
function clientCallSites(file: string): Map<string, number[]> {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Map<string, number[]>();

  /**
   * The nearest enclosing NAMED function. Walking up rather than tracking a stack on the way
   * down, so an arrow nested inside a method still attributes to the method — a call moved into
   * a callback must not silently leave the census's domain.
   */
  const enclosing = (n: ts.Node): string => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
      if (ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c)) {
        return c.name ? c.name.getText(sf) : "<anonymous>";
      }
    }
    return "<module>";
  };

  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.expression.getText(sf) === "this.client") {
      const key = `${enclosing(n)}|${n.expression.name.getText(sf)}`;
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      found.set(key, [...(found.get(key) ?? []), line]);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

describe("the adapter's server-value census — every IMAP read is dispositioned", () => {
  const sites = clientCallSites(ADAPTER);

  it("the census is not vacuous — it found the reads it is auditing", () => {
    // A census over an empty set passes every assertion below it. This is the guard that says
    // the AST walk still matches the file: a rename of `this.client` would otherwise turn this
    // whole file green and silent.
    expect(sites.size).toBeGreaterThan(40);
    expect([...sites.keys()]).toContain("enumerateUids|fetch");
    expect([...sites.keys()]).toContain("listBounded|list");
  });

  it("EXACT: every server read in the adapter is in the ledger, and every ledger row is real", () => {
    const inSource = [...sites.keys()].sort();
    const inLedger = Object.keys(SINKS).sort();

    const undispositioned = inSource.filter((k) => !(k in SINKS));
    const stale = inLedger.filter((k) => !sites.has(k));

    // A NEW `this.client.…` call is red until its author says what bounds it. That is the whole
    // point of the file: the ceiling cannot be forgotten silently, because the census names the
    // site and the build fails.
    expect(undispositioned).toEqual([]);
    // …and a row for a site that no longer exists is red too. A stale ledger is how a census
    // stops describing the file it audits while still passing.
    expect(stale).toEqual([]);
    expect(inSource).toEqual(inLedger);
  });

  it("STRUCTURAL: `list` and `search` have exactly one call site each, inside the bounded helper", () => {
    /*
     * The strongest guarantee in this file, and the reason it is worth more than the ledger.
     * Ten `list()` sites and four `search()` sites each did something O(n) with the answer, and
     * bounding them one at a time would leave the eleventh unbounded. Funnelling them through one
     * helper means a new call site cannot forget the ceiling — there is nowhere to forget it.
     */
    const listSites = [...sites.keys()].filter((k) => k.endsWith("|list"));
    const searchSites = [...sites.keys()].filter((k) => k.endsWith("|search"));
    expect(listSites).toEqual(["listBounded|list"]);
    expect(searchSites).toEqual(["searchBounded|search"]);
  });

  it("EXACT: every declared bound kind is actually raised somewhere in the source", () => {
    /*
     * A kind in the union that nothing ever raises is a ceiling that exists only in the type —
     * which is this repository's own named failure (a type-level guard that silently does not
     * guard). Derived from the two source files rather than from a list, so adding a kind and
     * forgetting to enforce it is red.
     */
    const src = readFileSync(ADAPTER, "utf8") + readFileSync(BOUNDS, "utf8");
    /*
     * `;?` IS LOad-BEARING, and it was missing. The union's LAST member ends the type alias, so
     * its line is `| "cycle_deadline";` — with the trailing semicolon the `"$" `anchor never
     * matched it, and the last kind was silently absent from `declared` for the whole of this
     * assertion's first life. A mutation that appended an unenforced kind to the end of the union
     * therefore SURVIVED, which is how this was found: the parse under-collected, and an
     * under-collecting parse makes this test weaker in exactly the direction nobody looks.
     */
    const declared = [...readFileSync(BOUNDS, "utf8").matchAll(/^\s*\|\s*"([a-z_]+)"\s*;?\s*$/gm)]
      .map((m) => m[1] as ImapBoundKind);
    expect(declared.length).toBeGreaterThan(5);
    // The FIRST and the LAST member of the union, named — a parse that drops either end is red
    // rather than merely smaller. Without this the regex above can regress silently.
    expect(declared[0]).toBe("list_folders");
    expect(declared.at(-1)).toBe("cycle_deadline");

    const unenforced = declared.filter((kind) => {
      // Raised either by a literal at a `throw`/`bound:` site, or as the `bound` a deadline
      // was constructed with.
      const raised = new RegExp(`"${kind}"`, "g");
      const hits = [...src.matchAll(raised)].length;
      // One hit is the union declaration itself; a kind that is enforced has at least two.
      return hits < 2;
    });
    expect(unenforced).toEqual([]);
  });

  it("the ceilings are finite, positive, and ordered the way their rationale claims", () => {
    /*
     * Not decoration: several of these numbers are only correct RELATIVE to each other, and the
     * docblocks assert those relations in prose. A prose claim nothing checks is the thing this
     * repository calls the claim under test rather than evidence for it.
     */
    for (const [name, v] of Object.entries({
      IMAP_LIST_MAX_FOLDERS, IMAP_FOLDER_PATH_MAX_CHARS, IMAP_ENUM_MAX_UIDS,
      IMAP_SEARCH_MAX_UIDS, IMAP_CANDIDATE_BODY_PROBES_MAX, IMAP_ENVELOPE_ADDRESSES_MAX,
      IMAP_FLAG_SCAN_MAX_ROWS, IMAP_SAMPLE_MAX_ROWS, IMAP_BODY_OVERRUN_FLOOR_BYTES,
      IMAP_READ_DEADLINE_MS, IMAP_CYCLE_DEADLINE_MS,
    })) {
      expect(Number.isFinite(v), name).toBe(true);
      expect(v, name).toBeGreaterThan(0);
    }
    // The pass budget must exceed one read's, or the per-read ceiling could never fire and every
    // refusal would name the cycle — the composition in `readDeadline` would be decorative.
    expect(IMAP_CYCLE_DEADLINE_MS).toBeGreaterThan(IMAP_READ_DEADLINE_MS);
    // …and it must stay under the 15-minute `sync_lag` alert, so a stalled mailbox fails inside
    // the window an operator finds out in rather than after it.
    expect(IMAP_CYCLE_DEADLINE_MS).toBeLessThan(15 * 60_000);
    // The body overrun is SLACK, not a licence: a multiplier at or below 1 would refuse honest
    // mail, and a large one would make the ceiling meaningless.
    expect(IMAP_BODY_OVERRUN_FACTOR).toBeGreaterThan(1);
    expect(IMAP_BODY_OVERRUN_FACTOR).toBeLessThan(3);
    // The candidate probe budget buys BODIES; it must stay far below the SEARCH ceiling, which
    // buys only array slots. Collapsing the two is how the multiplier came back.
    expect(IMAP_CANDIDATE_BODY_PROBES_MAX).toBeLessThan(IMAP_SEARCH_MAX_UIDS / 100);
  });
});

/**
 * ═══ THE SECOND CENSUS: THE READS THE FIRST ONE CANNOT SEE ══════════════════════════════════
 *
 * The census above sees `this.client.…` in the adapter and says so — a read reached through
 * `leaseIo()`, `leasePeekIo()` or `profileIo()` is outside its domain, because those hand the RAW
 * client to another module. That residual is where the `ohmail/_meta` reads live, and it is the
 * one folder in the mailbox that decides who organizes it, so "out of scope" was the wrong place
 * to leave them.
 *
 * Same instrument, same exactness, one difference worth stating: these modules WRITE as well as
 * read, and a write is dispositioned too — `no_server_sized_result` for a command that answers a
 * status line, because a census that quietly skipped the writes would not be exact in either
 * direction and a new FETCH could arrive wearing an APPEND's clothes.
 */
type MetaDisposition =
  /** Through `boundedFetch` — a ceiling on the pull, on the bytes, and a clock. */
  | "bounded_read"
  /** A windowed walk with its own per-window ceiling and window budget. */
  | "bounded_loop"
  /** The messageset was produced by an already-bounded read. */
  | "bounded_by_input"
  /** The command's result is not sized by what the server holds. */
  | "no_server_sized_result";

/**
 * WHETHER THE COMMAND RUNS UNDER THE READ'S WALL CLOCK — the axis {@link MetaDisposition} cannot
 * answer.
 *
 * A disposition says how much a server may SEND; it says nothing about how long it may take, and
 * `no_server_sized_result` was the disposition three unclocked commands wore. A STATUS answers a
 * fixed set of counters and can still take an hour; a SELECT can queue behind a command nobody is
 * reading; a LIST is one array and one array is not one instant. So each sink also declares which
 * clock it runs under, and the census pins the EXEMPT set by name: a new unclocked read has to be
 * written into that list to pass, which is an edit somebody reviews.
 */
type MetaClock =
  /** Raced against the one budget the read entered with — `metaReadBudget`. */
  | "under_read_budget"
  /**
   * A WRITE, deliberately not raced. Abandoning a read costs a connection; abandoning an APPEND or
   * an EXPUNGE abandons a command that may still land, so the caller would be left unable to say
   * whether it did. The profile's io states the same rule for the same reason.
   */
  | "write_not_raced";

const META_SINKS: Record<string, { how: MetaDisposition; clock: MetaClock; why: string }> = {
  // ── organizer-lease.ts ───────────────────────────────────────────────────────────────────
  "readMetaFolderWindow|fetch": {
    clock: "under_read_budget",
    how: "bounded_read",
    why: "boundedFetch with all three axes — META_RECORDS_MAX_PER_FETCH evicting from the FRONT (the folder appends, so stopping would keep the superseded half), IMAP_META_BYTES_MAX on the headers the window keeps, and IMAP_META_DEADLINE_MS on the pull. Past any of them `truncated` is true, which every caller reads as could-not-look",
  },
  "custodyOf|fetch": {
    clock: "write_not_raced",
    how: "bounded_by_input",
    why: "the caller's own uid list, read back to prove an expunge removed them",
  },
  "probeUndeletable|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT" },
  "probeUndeletable|messageDelete": { clock: "write_not_raced", how: "no_server_sized_result", why: "EXPUNGE of one remembered uid answers a status line" },
  "searchDescending|search": {
    clock: "under_read_budget",
    how: "bounded_loop",
    why: "compaction's uid enumeration, with no HEADER term: SEARCH_UID_WINDOW per window and SEARCH_WINDOW_BUDGET windows — a bare search is answered with however many uids the server chooses and the whole array lands before any ceiling of ours runs",
  },
  "folderBottomUid|fetch": {
    clock: "under_read_budget",
    how: "bounded_by_input",
    why: "ONE row — sequence 1, whose uid is the lowest the folder holds — which tells compaction how deep the folder is; a SEARCH for the same fact answers with every uid in the folder, which is the unbounded reply the windows exist to avoid",
  },
  "compactMeta|messageCopy": {
    clock: "write_not_raced",
    how: "bounded_loop",
    why: "one uid WINDOW per copy so the COPYUID map is bounded by SEARCH_UID_WINDOW however dense the folder is beneath it, and COMPACT_WINDOWS_MAX_PER_CYCLE windows per pass; a partial compaction is the same answer later, because a moved record is durable progress",
  },
  /* The sweep's window question, asked by FETCH only: a header SEARCH a server answers with
     nothing would report "none stale" and stop the one thing that shrinks this folder. Unclocked
     for the sweep's own reason: it holds the folder's lock and chose the size of every command. */
  "staleAckUidsInWindow|fetch": {
    clock: "write_not_raced",
    how: "bounded_by_input",
    why: "one uid WINDOW the caller named, fetched headers-only, inside SWEEP_SEARCH_WINDOW_BUDGET windows and SWEEP_BATCHES_MAX_PER_CYCLE deletes — bounded by the window, by META_RECORDS_MAX_PER_FETCH and by IMAP_META_BYTES_MAX, and a window it could not read whole THROWS rather than answering short, because the sweep's cursor must not pass what it never saw",
  },
  /* The sweep's cutoff, read off the server (SWEEP-CUTOFF-READS-THE-HOST-CLOCK): one row, under the
     sweep's own lock and unclocked for the sweep's reason. */
  "newestInternalDate|fetch": {
    clock: "write_not_raced",
    how: "bounded_by_input",
    why: "ONE row — the folder's last sequence number, from STATUS — asked only for its INTERNALDATE, the server's clock the sweep's cutoff is taken from",
  },
  /* Our newest claim, which caps the sweep's cutoff: one remembered uid, else one uid window. */
  "ownNewestClaim|fetch": {
    clock: "write_not_raced",
    how: "bounded_by_input",
    why: "the uid the gate remembers writing, else ONE uid window below UIDNEXT, headers and INTERNALDATE only, bounded by META_RECORDS_MAX_PER_FETCH and IMAP_META_BYTES_MAX under the sweep's own lock",
  },
  "makeMetaFolderRef|list": {
    clock: "under_read_budget",
    how: "bounded_read",
    why: "boundListResponse — the adapter's own ceilings (IMAP_LIST_MAX_FOLDERS, IMAP_FOLDER_PATH_MAX_CHARS) applied to a LIST reached with the RAW client, which is what put it outside the first census's structural guarantee",
  },
  "lastSequence|status": { clock: "under_read_budget", how: "no_server_sized_result", why: "STATUS answers a fixed set of counters" },
  "highestUid|status": { clock: "under_read_budget", how: "no_server_sized_result", why: "STATUS answers a fixed set of counters" },
  "stampMeta|status": { clock: "under_read_budget", how: "no_server_sized_result", why: "STATUS answers a fixed set of counters — the three a permit compares between reads, and the whole of what it asks the server" },
  /**
   * THE ONE SELECT THE READS TAKE. Four call sites used to open this folder for themselves, each
   * awaiting a lock nothing bounded; they take it through `lockWithin` now, which races the wait
   * against the read's own budget and attaches the release to a lock that arrives after the clock
   * ran out — a lock whose waiter has left is held by nobody and every later command queues behind
   * it.
   */
  "lockWithin|getMailboxLock": { clock: "under_read_budget", how: "no_server_sized_result", why: "SELECT" },
  "removeClaims|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT" },
  "remove|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT" },
  "sweepStaleAcks|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT" },
  "compactMeta|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT" },
  "appendClaim|append": { clock: "write_not_raced", how: "no_server_sized_result", why: "APPEND answers a status line" },
  "append|append": { clock: "write_not_raced", how: "no_server_sized_result", why: "APPEND answers a status line" },
  "ack|append": { clock: "write_not_raced", how: "no_server_sized_result", why: "APPEND answers a status line" },
  "removeClaims|messageDelete": { clock: "write_not_raced", how: "no_server_sized_result", why: "EXPUNGE answers a status line" },
  "remove|messageDelete": { clock: "write_not_raced", how: "no_server_sized_result", why: "EXPUNGE answers a status line" },
  "sweepStaleAcks|messageDelete": { clock: "write_not_raced", how: "no_server_sized_result", why: "EXPUNGE answers a status line" },
  "compactMeta|messageDelete": { clock: "write_not_raced", how: "no_server_sized_result", why: "EXPUNGE answers a status line" },
  "ensureMetaFolder|mailboxCreate": { clock: "write_not_raced", how: "no_server_sized_result", why: "CREATE answers a status line" },
  "createParentFirst|mailboxCreate": { clock: "write_not_raced", how: "no_server_sized_result", why: "CREATE of the parent answers a status line" },
  "ensureMetaFolder|mailboxUnsubscribe": { clock: "write_not_raced", how: "no_server_sized_result", why: "UNSUBSCRIBE answers a status line" },

  "enumerateMetaFolder|fetch": {
    clock: "under_read_budget",
    how: "bounded_read",
    why: "the one enumeration of the whole folder: `UID 1:*` headers through boundedFetch, META_ENUM_RECORDS_MAX rows and META_ENUM_BYTES_MAX charged on every row, refusing on either; STATUS above the ceiling refuses before it; under the caller's one budget",
  },

  // ── organizer-profile.ts ─────────────────────────────────────────────────────────────────
  "listMeta|fetch": {
    clock: "under_read_budget",
    how: "bounded_read",
    why: "two sites — the ranged source read of the newest documents only (`BODY.PEEK[]<0.N>`, at most PROFILE_MESSAGES_MAX_PER_FETCH bodies inside PROFILE_BYTES_MAX_PER_FETCH), and a one-uid UID check for a body that did not come back; the folder's headers come from enumerateMetaFolder, and the whole read is raced against one IMAP_META_DEADLINE_MS budget at the seam",
  },
  "listMeta|getMailboxLock": { clock: "under_read_budget", how: "no_server_sized_result", why: "SELECT" },
  "removeProfiles|fetch": { clock: "write_not_raced", how: "bounded_by_input", why: "the caller's own uid list, read back to prove the expunge" },
  "removeProfiles|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT" },
  "removeProfiles|messageDelete": { clock: "write_not_raced", how: "no_server_sized_result", why: "EXPUNGE answers a status line" },
  "appendProfile|append": { clock: "write_not_raced", how: "no_server_sized_result", why: "APPEND answers a status line" },
  "appendProfile|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT, so the APPEND's \\Seen is filtered by _meta's own PERMANENTFLAGS" },
  "markSeen|getMailboxLock": { clock: "write_not_raced", how: "no_server_sized_result", why: "SELECT" },
  "markSeen|messageFlagsAdd": { clock: "write_not_raced", how: "no_server_sized_result", why: "STORE +FLAGS.SILENT answers a status line" },
};

/** Every `client.<method>(…)` / `c.<method>(…)` in a module, as `enclosingFunction|method`. */
function rawClientCallSites(file: string): Map<string, number[]> {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found = new Map<string, number[]>();
  const enclosing = (n: ts.Node): string => {
    for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
      if (ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c)) {
        return c.name ? c.name.getText(sf) : "<anonymous>";
      }
    }
    return "<module>";
  };
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && /^(client|c)$/.test(n.expression.expression.getText(sf))) {
      const key = `${enclosing(n)}|${n.expression.name.getText(sf)}`;
      const line = sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
      found.set(key, [...(found.get(key) ?? []), line]);
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return found;
}

describe("the meta folder's census — the reads the adapter hands its raw client", () => {
  const sites = new Map([...rawClientCallSites(LEASE), ...rawClientCallSites(PROFILE)]);

  it("is not vacuous — it found the reads it is auditing", () => {
    expect(sites.size).toBeGreaterThan(25);
    expect([...sites.keys()]).toContain("readMetaFolderWindow|fetch");
    expect([...sites.keys()]).toContain("listMeta|fetch");
  });

  it("EXACT: every server command in both modules is in the ledger, and every row is real", () => {
    const inSource = [...sites.keys()].sort();
    const inLedger = Object.keys(META_SINKS).sort();
    expect(inSource.filter((k) => !(k in META_SINKS))).toEqual([]);
    expect(inLedger.filter((k) => !sites.has(k))).toEqual([]);
    expect(inSource).toEqual(inLedger);
  });

  it("STRUCTURAL: the meta window is the ONLY read of the folder's records", () => {
    /*
     * Three reads used to run their own `FETCH 1:*` against this folder and the ceiling, the
     * ordering and the empty-folder defence drifted between them. One window means a new caller
     * cannot get any of the three wrong, because there is no second window to get wrong.
     *
     * A WINDOW is what this is about, which is why the two fetches that name their own messages —
     * the custody read-back and the folder's own bottom — are not in it: neither chooses a
     * ceiling, an ordering or an empty-folder rule, because the range names exactly the messages
     * the caller already has in hand.
     */
    const windows = [...sites.keys()]
      .filter((k) => k.endsWith("|fetch") && META_SINKS[k]?.how === "bounded_read");
    // The third is the whole-folder enumeration both readers share (FIX-026): it refuses, never evicts.
    expect(windows.sort()).toEqual(["enumerateMetaFolder|fetch", "listMeta|fetch", "readMetaFolderWindow|fetch"]);
  });

  /**
   * ── THE CLOCK AXIS ────────────────────────────────────────────────────────────────────────
   *
   * `IMAP_META_DEADLINE_MS` is named "one read of `ohmail/_meta`" and bounded the FETCH alone: the
   * LIST that resolves the folder, the SELECT that opens it and the STATUS that counts it ran
   * under nothing, and the FETCH then started the whole ceiling fresh however long they had taken.
   * A disposition cannot see that — all three are `no_server_sized_result`, which is true and says
   * nothing about how long the server may take to produce it.
   *
   * So the exempt set is pinned BY NAME rather than by count: adding an unclocked read means
   * writing its key into this list, which is an edit somebody reviews, and forgetting to means a
   * red census. The behaviour itself is driven in `meta-read-budget.test.ts`, where four segments
   * of a third of the ceiling each refuse under one budget and would pass under four.
   */
  it("EXACT: every meta READ runs under the read's budget; only the writes are exempt", () => {
    const unclocked = Object.entries(META_SINKS)
      .filter(([, v]) => v.clock === "write_not_raced")
      .map(([k]) => k).sort();
    expect(unclocked).toEqual([
      "ack|append",
      "append|append",
      "appendClaim|append",
      "appendProfile|append",
      "appendProfile|getMailboxLock",
      "markSeen|getMailboxLock",
      "markSeen|messageFlagsAdd",
      "ensureMetaFolder|mailboxCreate",
      "ensureMetaFolder|mailboxUnsubscribe",
      "createParentFirst|mailboxCreate",
      "custodyOf|fetch",
      "probeUndeletable|getMailboxLock",
      "probeUndeletable|messageDelete",
      "remove|getMailboxLock",
      "remove|messageDelete",
      "removeClaims|getMailboxLock",
      "removeClaims|messageDelete",
      "removeProfiles|fetch",
      "removeProfiles|getMailboxLock",
      "removeProfiles|messageDelete",
      "sweepStaleAcks|getMailboxLock",
      "sweepStaleAcks|messageDelete",
      "staleAckUidsInWindow|fetch",
      "newestInternalDate|fetch",
      "ownNewestClaim|fetch",
      /* The compaction is a WRITE pass like the sweep, and unclocked for the sweep's reason: it
         holds the folder's lock and every command it issues is one it chose the size of. The one
         read it depends on — the folder's own bottom — is on the clock, above. */
      "compactMeta|getMailboxLock",
      "compactMeta|messageCopy",
      "compactMeta|messageDelete",
    ].sort());
    // Not vacuous in the other direction either: the four segments of the ordinary read are all
    // on the clock, and those four are what the constant's own sentence is about.
    for (const k of [
      "makeMetaFolderRef|list", "lockWithin|getMailboxLock",
      "lastSequence|status", "readMetaFolderWindow|fetch",
    ]) {
      expect(META_SINKS[k]?.clock, k).toBe("under_read_budget");
    }
  });

  it("the folder's own ceilings are ordered the way their rationale claims", () => {
    expect(IMAP_META_DEADLINE_MS).toBeGreaterThan(0);
    expect(IMAP_META_DEADLINE_MS).toBeLessThanOrEqual(IMAP_READ_DEADLINE_MS);
    expect(IMAP_META_BYTES_MAX).toBeGreaterThan(0);
    // A window of records whose own payload ceiling is 4 KiB has to fit, or the ceiling refuses
    // the legitimate population it was sized for.
    expect(IMAP_META_BYTES_MAX).toBeGreaterThan(500 * 4096);
  });
});

/**
 * ═══ THE THIRD CENSUS: THE API'S DOORS ══════════════════════════════════════════════════════
 *
 * Every API-side dial of a customer's mail server has to run under a budget and destroy its
 * socket on a breach. That is a property of the DIAL, so it is guaranteed the way the adapter
 * guarantees its LIST: one door, one call site, nowhere to forget it.
 *
 * The attachment path holds ONE adapter across a multi-part download and closes it itself, so the
 * dial-and-read budget is the wrong UNIT for it in both directions — it would end an honest
 * download making steady progress, and a walk of parts each just under it is a stall nothing sees.
 * It was the stated exception and carried no clock at all; it now carries a PER-OPERATION one,
 * placed in the factory so neither of its two callers can forget it, at the adapter's own
 * `IMAP_READ_DEADLINE_MS` rather than a second number for the same question.
 */
const DOOR_SITES: Record<string, string> = {
  "imap-door.ts": "the door itself — one budget for dial and read, forceClose on any breach",
};

const OPEN_ADAPTER_SITES: Record<string, string> = {
  "routes/attachments.ts": "the attachment download — bounded in BYTES (ATTACHMENT_MAX_FETCH_BYTES, the driver's own maxBytes inside the stream), in parts, and PER OPERATION: `makeOpenAdapter` races every `fetchPart` against IMAP_OPERATION_DEADLINE_MS and destroys the socket on a breach, so a hung part ends without ending an honest walk",
  "routes/drafts.ts": "the draft's attachment re-fetch, on the same adapter, the same byte ceilings and the same per-operation clock",
};

/** Which files call `<name>(…)`, by repo-relative path under `packages/api/src`. */
function callersOf(name: string): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) { walkDir(full); continue; }
      if (!entry.endsWith(".ts")) continue;
      const text = readFileSync(full, "utf8");
      const sf = ts.createSourceFile(full, text, ts.ScriptTarget.Latest, true);
      let hit = false;
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) hit = true;
        ts.forEachChild(n, walk);
      };
      walk(sf);
      if (hit) out.push(full.slice(API_SRC.length + 1));
    }
  };
  walkDir(API_SRC);
  return out.sort();
}

describe("the API's IMAP doors — one budget, and nowhere to forget it", () => {
  it("STRUCTURAL: `openMailboxImap` is called from the door and from nowhere else", () => {
    /*
     * The defect this closes: four doors each dialled `openMailboxImap` directly and put the
     * socket down in a `finally`, and three of them had no clock at all. A new door added the
     * same way would be correct on the day it was written and unbounded for ever after.
     */
    const callers = callersOf("openMailboxImap").filter((f) => f !== "attachments-adapter.ts");
    expect(callers).toEqual(Object.keys(DOOR_SITES).sort());
  });

  /**
   * The per-operation clock is the adapter's OWN number. Two ceilings answering "how long may one
   * read of one mail server take" would be a second thing to keep true, and the one that drifted
   * would be the one nobody was looking at.
   */
  it("the attachment door's per-operation clock is IMAP_READ_DEADLINE_MS, not a second literal", async () => {
    const budget = await import("../../../api/src/imap-budget.js");
    expect(budget.IMAP_OPERATION_DEADLINE_MS).toBe(IMAP_READ_DEADLINE_MS);
    // …and the door's own dial budget stays SHORTER, because it is chosen against a serverless
    // invocation ceiling and not against a download.
    expect(budget.IMAP_DOOR_DEADLINE_MS).toBeLessThan(budget.IMAP_OPERATION_DEADLINE_MS);
  });

  it("EXACT: every caller of the attachment adapter factory is dispositioned", () => {
    const callers = callersOf("makeOpenAdapter").filter((f) => f !== "attachments-adapter.ts");
    expect(callers).toEqual(Object.keys(OPEN_ADAPTER_SITES).sort());
  });
});

/**
 * EVERY SOURCE FETCH ASKS FOR THE TREE (ARCH-ATTACHMENT-PART-ID-AT-INGEST, ruling 1). Ingest takes
 * each file's section from the BODYSTRUCTURE asked in the same FETCH as `source`, so an item set
 * carrying `source: true` without `bodyStructure: true` ships creates whose files keep mailparser's
 * ids. One exception, by name and by its declaration: STRUCTURE_FREE_LAST_RESORT, asked only for
 * UIDs both fetches withheld. The two `fetchOne` source probes of `move` are not ingest.
 */
interface SourceFetch { fn: string; line: number; items: string; source: boolean; bodyStructure: boolean }

function sourceFetches(file: string): SourceFetch[] {
  const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const consts = new Map<string, ts.ObjectLiteralExpression>();
  const unwrap = (e: ts.Expression): ts.Expression => (ts.isAsExpression(e) ? unwrap(e.expression) : e);
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue;
    for (const d of st.declarationList.declarations) {
      const init = d.initializer ? unwrap(d.initializer) : undefined;
      if (ts.isIdentifier(d.name) && init && ts.isObjectLiteralExpression(init)) consts.set(d.name.text, init);
    }
  }
  const truthy = (o: ts.ObjectLiteralExpression, key: string): boolean => o.properties.some((p) =>
    ts.isPropertyAssignment(p) && p.name.getText(sf) === key && p.initializer.kind === ts.SyntaxKind.TrueKeyword);
  const out: SourceFetch[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression)
        && n.expression.expression.getText(sf) === "this.client" && n.expression.name.text === "fetch") {
      const arg = n.arguments[1];
      const lit = arg === undefined ? undefined
        : ts.isObjectLiteralExpression(arg) ? arg : ts.isIdentifier(arg) ? consts.get(arg.text) : undefined;
      let fn = "<module>";
      for (let c: ts.Node | undefined = n.parent; c; c = c.parent) {
        if ((ts.isMethodDeclaration(c) || ts.isFunctionDeclaration(c)) && c.name) { fn = c.name.getText(sf); break; }
      }
      out.push({
        fn, line: sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1,
        items: arg === undefined ? "<none>" : ts.isIdentifier(arg) ? arg.text : ts.isObjectLiteralExpression(arg) ? "<literal>" : "<unread>",
        source: lit ? truthy(lit, "source") : false, bodyStructure: lit ? truthy(lit, "bodyStructure") : false,
      });
    }
    ts.forEachChild(n, walk);
  };
  walk(sf);
  return out;
}

describe("every source fetch asks the server for the message's tree", () => {
  const sites = sourceFetches(ADAPTER);

  it("CONTROL: the census reads the six ruled sites, each with source and bodyStructure", () => {
    const withTree = sites.filter((s) => s.source && s.bodyStructure).map((s) => s.fn);
    expect(withTree).toEqual(["fetchUnsized", "fetchUnsized", "fetchSized", "fetchSized", "fetchByUid", "fetchByUid"]);
  });

  it("EXACT: a source item set without bodyStructure is the named last resort, and only there", () => {
    const bare = sites.filter((s) => s.source && !s.bodyStructure);
    expect(bare.map((s) => `${s.fn}|${s.items}`)).toEqual([
      "fetchUnsized|STRUCTURE_FREE_LAST_RESORT", "fetchSized|STRUCTURE_FREE_LAST_RESORT", "fetchByUid|STRUCTURE_FREE_LAST_RESORT",
    ]);
    // An item set the walk could not read is red, not skipped: it could be carrying `source`.
    expect(sites.filter((s) => s.items === "<unread>" || s.items === "<none>")).toEqual([]);
  });
});

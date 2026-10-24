import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bracketSpan, withoutComments } from "../../../../scripts/lib/source-scan.mjs";

import { beforeEach, describe, expect, it } from "vitest";

import { memoryImapServer } from "./_metaworld.js";
import { peekMemo, resetMetaMemos } from "../../src/adapters/meta-memo.js";
import {
  CLAIM_PROTOCOL,
  ClaimReleaseError,
  LeaseUnavailableError,
  META_RECORDS_MAX_PER_FETCH,
  MetaEnumRefusedError,
  formatAck,
  formatClaim,
  makeLeaseIo,
  makeLeasePeekIo,
  makeRequestOrganizerIo,
  metaReadBudget,
  readLeasePeek,
  readMetaFolderWindow,
  readMetaRecords,
  runLeaseGate,
  type LeaseImapClient,
  type LeaseSelf,
} from "../../src/adapters/organizer-lease.js";

/**
 * The io seams refuse a memory they cannot attribute, so every fixture states one — the gate's own
 * install id, as every host binds it (`readMailboxLease`): the read's own-claim control matches it.
 */
const TEST_META_ID = { installId: "us", mailboxId: "test-mailbox" };

// The memo is process-wide and keyed by identity; a case must not inherit another case's uid.
beforeEach(() => { resetMetaMemos(); });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A FULL `ohmail/_meta` MUST NOT HIDE THE NEWEST RECORDS, AND MUST NOT DO IT SILENTLY
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ohmail/_meta` is a folder anyone with APPEND rights on the mailbox can write to — a shared-folder
 * grantee, a filing rule, any other mail client the person owns. Three reads in the lease module
 * consumed it, and all three had the same two defects.
 *
 * **The read was bounded in the wrong direction.** `FETCH 1:*` returns the LOWEST sequence numbers
 * first, so a ceiling applied by stopping the loop keeps the OLDEST messages. Everything live in
 * this folder is at the END of it: a claim is renewed by APPENDING, a decision is APPENDED, an
 * acknowledgement is APPENDED. So a window's worth of harmless messages hid every claim, decision and
 * acknowledgement written after them, permanently.
 *
 * **And the truncation was invisible.** A partial read and a complete read were the same value at
 * every call site, so each one drew the worst available conclusion from it: the gate read an empty
 * election and claimed a mailbox somebody was actively organizing; the peek told a person nobody
 * organized their mailbox; the record drain found no decisions and let them expire reporting that
 * nobody had taken them.
 *
 * The window now runs from the end of the folder, and it says when it did not cover the whole
 * thing. Every caller treats that as "I could not look", which is the rule this module already
 * holds for a folder it cannot read at all.
 */

const NOW = new Date("2026-09-04T12:00:00.000Z");
const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");

function self(installId = "us"): LeaseSelf {
  return { installId, kind: "cloud", displayName: "Cloud", lastNonce: null };
}

/** A live claim by somebody else — freshly renewed, so it ranks and wins any election it is in. */
function incumbentClaim(): string {
  return formatClaim({
    installId: "incumbent-install",
    kind: "local",
    displayName: "The Kitchen Mac",
    claimedAt: new Date(NOW.getTime() - 600_000),
    heartbeat: new Date(NOW.getTime() - 5_000),
    nonce: "incumbent-nonce",
    authorizedAt: new Date(NOW.getTime() - 600_000),
    capabilities: ["requests"],
    protocol: CLAIM_PROTOCOL,
  });
}

/** A DIFFERENT install's live claim — the competitor an election must be able to see. */
function rivalClaim(): string {
  return formatClaim({
    installId: "rival-install",
    kind: "local",
    displayName: "The Laptop",
    claimedAt: new Date(NOW.getTime() - 300_000),
    heartbeat: new Date(NOW.getTime() - 4_000),
    nonce: "rival-nonce",
    authorizedAt: new Date(NOW.getTime() - 300_000),
    capabilities: ["requests"],
    protocol: CLAIM_PROTOCOL,
  });
}

/**
 * A folder of `filler` innocuous messages with ONE live claim appended last — the shape a flooded
 * mailbox actually has, because the flood arrives after the organizer has been running for a while
 * and the organizer keeps renewing on top of it.
 */
function floodedWorld(filler: number) {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  for (let i = 0; i < filler; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
  const claimUid = server.seed(META, incumbentClaim());
  return { server, claimUid };
}

/**
 * THE CLAIM UNDER THE FLOOD — the opposite seeding order to `floodedWorld`, and the reason both
 * exist. The claim goes in FIRST and the filler on top of it, so a newest-first window of
 * `META_RECORDS_MAX_PER_FETCH` does not reach it: a live incumbent the window cannot see.
 *
 * REACHING FOR THE WRONG ONE DOES NOT FAIL — IT QUIETLY PASSES, which is how the invariant test
 * below spent its first life. `floodedWorld` puts the claim LAST, where every window contains it,
 * so an election over the window still finds it and still stands down, for a reason that looks
 * exactly like the right one. The test was named for a buried claim, handed one sitting on top of
 * the flood, and could not fail for the reason it claimed: mutating the election to treat the
 * window as a complete read left the verdict at `stand_down` and moved only a log assertion.
 */
function buriedWorld(filler: number) {
  const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
  const claimUid = server.seed(META, incumbentClaim());
  for (let i = 0; i < filler; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
  return { server, claimUid };
}

/** Every FETCH messageset this connection issued against the meta folder, in order. */
function fetchRanges(server: { log: string[] }): string[] {
  return server.log
    .filter((l) => l.startsWith(`fetch ${META} `))
    .map((l) => l.slice(`fetch ${META} `.length));
}

/** How many times this connection asked the SERVER for the folder's size. */
function searchCount(server: { log: string[] }): number {
  return server.log.filter((l) => l.startsWith(`status ${META} `)).length;
}

describe("the shared bounded read of ohmail/_meta", () => {
  /**
   * THE READ THIS WHOLE CHANGE EXISTS FOR.
   *
   * More messages than the window, the live claim last. The window covers the NEWEST of them, so the claim is in it.
   *
   * MUTATION WATCHED RED: put the range back to `1:*` and break at the ceiling, and the records
   * come back holding `newsletter 0 … newsletter 499` and no claim at all — the read that made a
   * held mailbox look unheld.
   */
  it("covers the NEWEST records, so a claim appended after a flood is still in the window", async () => {
    const { server, claimUid } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    await server.getMailboxLock(META);

    const read = await readMetaFolderWindow(server, META);

    expect(read.total).toBe(META_RECORDS_MAX_PER_FETCH + 101);
    expect(read.records).toHaveLength(META_RECORDS_MAX_PER_FETCH);
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
    expect(read.records.at(-1)!.raw).toContain("incumbent-install");
    // The oldest are the ones left behind, which is the whole point of the direction.
    expect(read.records[0]!.raw).toContain("newsletter 101");
    // …and the window was asked for as a range from the END, not filtered client-side out of `1:*`.
    expect(fetchRanges(server)).toEqual([`${102}:*`]);
  });

  /** And it SAYS it did not cover the folder. Nothing downstream can tell without this. */
  it("reports truncated when the folder holds more than the ceiling", async () => {
    const { server } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    await server.getMailboxLock(META);
    expect((await readMetaFolderWindow(server, META)).truncated).toBe(true);
  });

  /**
   * THE BOUNDARY IS COMPLETE, and reporting it as truncated would stop a mailbox for no reason.
   *
   * One message past the ceiling is read and thrown away rather than the fullness of the window
   * being taken as proof there is more — so exactly-the-ceiling is a complete read.
   */
  it("a folder holding EXACTLY the ceiling is complete, not truncated", async () => {
    const { server } = floodedWorld(META_RECORDS_MAX_PER_FETCH - 1);
    await server.getMailboxLock(META);

    const read = await readMetaFolderWindow(server, META);
    expect(read.total).toBe(META_RECORDS_MAX_PER_FETCH);
    expect(read.records).toHaveLength(META_RECORDS_MAX_PER_FETCH);
    expect(read.truncated).toBe(false);
    expect(fetchRanges(server)).toEqual(["1:*"]);
  });

  /** An empty folder is still a real answer, and `1:*` is still never sent against one. */
  it("a positively known zero still skips the FETCH entirely", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    await server.getMailboxLock(META);

    const read = await readMetaFolderWindow(server, META);
    expect(read).toEqual({ records: [], truncated: false, total: 0 });
    expect(fetchRanges(server)).toEqual([]);
  });

  /* A CONNECTION THAT DIED UNDER THE READ IS "COULD NOT LOOK": its STATUS fails, imapflow's FETCH
     yields nothing once the mailbox is gone, and the answer read as an empty folder — the gate's
     verify then said its own claim was missing, the peek that nobody held the mailbox. */
  it("a read over a dead connection refuses list_claims rather than answer an empty folder", async () => {
    const dropped = Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    const client = {
      mailbox: false, usable: false,
      status: async () => { throw dropped; },
      // eslint-disable-next-line require-yield
      fetch: async function* () { return; },
    } as unknown as LeaseImapClient;
    const err = await readMetaRecords(client, META, metaReadBudget(), { keep: () => true, probe: null })
      .then(() => null, (e: unknown) => e);
    expect(err, "a dead connection read as an empty folder").toBeInstanceOf(LeaseUnavailableError);
    expect((err as LeaseUnavailableError).op).toBe("list_claims");
  });

});

/**
 * PAST THE WINDOW THE LEASE READS EVERY CLAIM (FIX-026, ARCH-LEASE-BLIND-SEARCH L1-L4). Every case
 * here was a SEARCH-path case and is now its enumeration twin, or went with the mechanism it
 * guarded (named in the lane's changes file): the election, the verify, the release and the peek
 * each read the whole folder by one header FETCH, proved complete by the server's own count.
 */
describe("past the window: the lease reads every claim by one complete header FETCH", () => {
  /**
   * THE INVARIANT: a live incumbent, then more than a window of later appends on top of it. A
   * newest-first window drops exactly that claim, and an election over it appends a second
   * organizer. The enumeration sees it wherever it sits. `buriedWorld` is load-bearing: handed
   * `floodedWorld`, whose claim is on top, this passes under the mutation and proves nothing.
   *
   * MUTATION WATCHED RED: hand the election the window instead of the enumeration and the verdict
   * flips to `organize` while a live incumbent holds the mailbox.
   */
  it("THE INVARIANT: a claim buried under a flood is found, and this install stands down", async () => {
    const { server } = buriedWorld(META_RECORDS_MAX_PER_FETCH + 10);
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];

    const res = await runLeaseGate({
      capabilities: [], io, self: self(), now: NOW, newNonce: () => "n-us",
      log: (event, detail) => events.push({ event, detail }),
    });

    expect(res.verdict.verdict, "a live incumbent buried by a flood was read as no incumbent")
      .toBe("stand_down");
    expect(res.verdict.verdict === "stand_down" ? res.verdict.reason : null)
      .toBe("organized_elsewhere:local");
    expect(server.log.filter((l) => l.startsWith(`append ${META}`))).toHaveLength(0);
    const enumerated = events.find((e) => e.event === "lease_meta_enumerated");
    expect(enumerated?.detail).toMatchObject({ claims: 1, records: META_RECORDS_MAX_PER_FETCH + 11, total: META_RECORDS_MAX_PER_FETCH + 11 });
    expect(server.log.filter((l) => l.startsWith(`search ${META}`)), "the election asked SEARCH").toEqual([]);
  });

  /** A connection with no SEARCH at all elects over the whole folder: SEARCH decides nothing. */
  it("a connection with no SEARCH elects over the whole folder, and appends nothing", async () => {
    const { server } = buriedWorld(META_RECORDS_MAX_PER_FETCH + 10);
    const res = await runLeaseGate({
      capabilities: [], io: makeLeaseIo({ ...server, search: undefined }, toServerPath, TEST_META_ID),
      self: self(), now: NOW, newNonce: () => "n-us",
    });
    expect(res.verdict.verdict).toBe("stand_down");
    expect(server.log.filter((l) => l.startsWith(`append ${META}`))).toHaveLength(0);
  });

  /** A SEARCH the server refuses is not read at all; the whole folder is. */
  it("a server that refuses SEARCH still stands this install down to the incumbent", async () => {
    const server = memoryImapServer({
      prefix: "INBOX.", folders: ["INBOX.ohmail", META], refuseSearch: true,
    });
    server.seed(META, incumbentClaim());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }
    const res = await runLeaseGate({
      capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID), self: self(), now: NOW,
      newNonce: () => "n-us",
    });
    expect(res.verdict.verdict).toBe("stand_down");
    expect(server.log.filter((l) => l.startsWith(`append ${META}`))).toHaveLength(0);
  });

  /**
   * AND A READ THAT CANNOT PROVE ITSELF COMPLETE REFUSES — IN THE EXISTING CLASS, WRITING NOTHING.
   * No STATUS count past the window: the window comes back truncated and the enumeration refuses
   * `no_count`. `list_claims`, the class every host exempts, and no APPEND, no EXPUNGE.
   *
   * MUTATION WATCHED RED: work with the truncated window and this resolves `organize`.
   */
  it("no count past the window: refuses list_claims, appends nothing, expunges nothing", async () => {
    const { server } = buriedWorld(META_RECORDS_MAX_PER_FETCH + 10);
    const events: string[] = [];
    await expect(runLeaseGate({
      capabilities: [], io: makeLeaseIo({ ...server, status: undefined }, toServerPath, TEST_META_ID),
      self: self(), now: NOW, newNonce: () => "n-us", log: (e) => { events.push(e); },
    })).rejects.toMatchObject({ name: "LeaseUnavailableError", op: "list_claims" });

    expect(events).toContain("lease_enum_refused");
    expect(server.log.filter((l) => l.startsWith(`append ${META}`))).toHaveLength(0);
    expect(server.log.filter((l) => l.startsWith(`delete ${META}`))).toHaveLength(0);
  });

  /**
   * A PILE OF THIS INSTALL'S OWN CLAIMS PAST THE WINDOW. The only install that can honestly leave
   * hundreds here is one whose expunge kept failing. The election reads them all and the incumbent
   * wins; the stand-down releases our own records and never the incumbent's. (Was: the over-500
   * own-prune, which refused the cycle; that branch went with the SEARCH path.)
   */
  it("a pile of our own claims past the window: stands down to the incumbent, releases only ours", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 100; i++) {
      server.seed(META, formatClaim({
        installId: "us", kind: "local", displayName: "This Mac", authorizedAt: null, capabilities: [],
        heartbeat: new Date(NOW.getTime() - (i + 2) * 1000),
        claimedAt: new Date(NOW.getTime() - 600_000), nonce: `own-${i}`,
      }));
    }
    const foreignUid = server.seed(META, incumbentClaim());
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);

    const res = await runLeaseGate({ capabilities: [], io, self: self(), now: NOW, newNonce: () => "n-us" });

    expect(res.verdict.verdict).toBe("stand_down");
    const left = server.tree.get(META)!.messages;
    expect(left.map((m) => m.uid), "another install's claim was expunged").toContain(foreignUid);
    expect(left.filter((m) => /^X-Ohmail-Install-Id: us\r?$/m.test(m.raw)), "our own pile was left behind")
      .toHaveLength(0);
  });

  /**
   * ══ THE SAME INVARIANT, REACHED THROUGH THE VERIFY ══════════════════════════════════════════
   *
   * The election reads the folder; a rival then renews under a window's worth of appends before
   * our verify. A verify over the window sees one claim, ours, and confirms: two organizers with no
   * write lost. The verify reads the folder whole, as the election does. (Was the SEARCH-to-FETCH
   * gap; the gap went with the search, and the verify's reach is what it measured.)
   *
   * MUTATION WATCHED RED: let the verify reuse the election's read and this returns `organize`.
   */
  it("THE INVARIANT, SECOND ROUTE: a rival renewing under a burst between the reads is caught by the verify", async () => {
    const renewed = formatClaim({
      installId: "incumbent-install", kind: "local", displayName: "The Kitchen Mac",
      claimedAt: new Date(NOW.getTime() - 600_000), heartbeat: new Date(NOW.getTime() - 1_000),
      nonce: "incumbent-nonce-2", authorizedAt: new Date(NOW.getTime() - 600_000),
      capabilities: ["requests"], protocol: CLAIM_PROTOCOL,
    });
    const server = memoryImapServer({
      prefix: "INBOX.", folders: ["INBOX.ohmail", META],
      onBetweenReads: (s, read) => {
        if (read !== 1) return;
        s.seed(META, renewed);
        for (let i = 0; i < META_RECORDS_MAX_PER_FETCH; i++) s.seed(META, `Subject: burst ${i}\r\n\r\nbody`);
      },
    });
    for (let i = 0; i < 20; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);

    const events: Array<{ event: string; detail: Record<string, unknown> }> = [];
    const res = await runLeaseGate({
      capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID), self: self(), now: NOW,
      newNonce: () => "n-us", log: (event, detail) => events.push({ event, detail }),
    });

    expect(res.verdict.verdict,
      "a rival that renewed between the reads was invisible to the verify, so two installs organize one mailbox")
      .not.toBe("organize");
    // The election really did see nothing: our claim was appended, so the gap this is about opened.
    expect(server.log.filter((l) => l.startsWith(`append ${META}`))).toHaveLength(1);
  });

  it("a provider that refuses SEARCH still gets a release — the locate is a current read", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(NOW.getTime() - 1000),
      claimedAt: new Date(NOW.getTime() - 600_000), nonce: "own",
    }));
    server.seed(META, formatClaim({
      installId: "them", kind: "local", displayName: "Elsewhere", authorizedAt: null, capabilities: [],
      heartbeat: new Date(NOW.getTime() - 2000),
      claimedAt: new Date(NOW.getTime() - 600_000), nonce: "theirs",
    }));
    const io = makeLeaseIo({
      ...server,
      // The production shape: imapflow resolves `false` when the server refuses the command.
      async search(): Promise<false> { return false; },
    }, toServerPath, TEST_META_ID);

    const own = await io.findOwnRecords!("us");

    expect(own, "the locate still rests on the server's search").not.toBeNull();
    expect(own!.length, "the current read did not return the folder's records as candidates").toBe(2);
  });

  /**
   * PAST THE WINDOW THE RELEASE READS THE WHOLE FOLDER — NEVER A SLICE. A release deletes what
   * comes back and returns a COUNT; a slice would leave the omitted claim holding the mailbox while
   * the log says released. (Was: refused `over_ceiling` past 500; the release now works there.)
   *
   * MUTATION WATCHED RED: keep the window read and this is `over_ceiling` for a folder past the window.
   */
  it("a folder past the window is released whole, every own claim found", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < 700; i++) {
      server.seed(META, formatClaim({
        installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
        heartbeat: new Date(NOW.getTime() - (i + 1) * 1000),
        claimedAt: new Date(NOW.getTime() - 600_000), nonce: `own-${i}`,
      }));
    }
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);

    const own = await io.findOwnRecords!("us");
    expect(own, "a folder past the window came back as a slice").toHaveLength(700);
  });

  it("a read that dies mid-release is refused as unreadable, and the provider's fault rides in cause", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, formatClaim({
      installId: "us", kind: "cloud", displayName: "Cloud", authorizedAt: null, capabilities: [],
      heartbeat: new Date(NOW.getTime() - 1000),
      claimedAt: new Date(NOW.getTime() - 600_000), nonce: "own",
    }));
    const dropped = Object.assign(new Error("Connection not available"), { code: "NoConnection" });
    server.fetch = async function* () { throw dropped; } as unknown as typeof server.fetch;
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);

    const err = await io.findOwnRecords!("us").then(() => null, (e: unknown) => e);
    expect(err, "a dead read came back as an answer").toBeInstanceOf(ClaimReleaseError);
    expect((err as ClaimReleaseError).code).toBe("unreadable");
    expect((err as Error).cause, "the provider's fault was dropped on the way out").toBe(dropped);
  });

  /**
   * THE PEEK SHOWS THE WHOLE CLAIM SET, NEVER PART OF ONE. More stale claims than the window and one live
   * renewal appended last: a slice by uid drops the newest and renders "stopped" over a mailbox
   * somebody is organizing. (Was: the peek refused a set past its bound; it now reads it whole.)
   *
   * MUTATION WATCHED RED: let the peek answer from the window and it reads `stopped`.
   */
  it("the peek names the live holder among seven hundred stale claims", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, incumbentClaim());
    for (let i = 0; i < 700; i++) {
      server.seed(META, formatClaim({
        installId: `old-install-${i}`, kind: "local", displayName: `Machine ${i}`,
        authorizedAt: null, capabilities: [],
        heartbeat: new Date(NOW.getTime() - 86_400_000),
        claimedAt: new Date(NOW.getTime() - 86_400_000), nonce: `stale-${i}`,
      }));
    }

    const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });
    expect(peek.state, "a live holder under a pile of stale claims rendered as nobody").toBe("held");
    expect(peek.holders[0]?.displayName).toBe("The Kitchen Mac");
  });

  /**
   * ══ THE DAY THE FOLDER SPENDS OVER THE WINDOW MUST NOT COST THE MAILBOX ITS ORGANIZER ════════
   *
   * The drain settles requests by replacing each with an ACKNOWLEDGEMENT, so a folder can sit over
   * the window for up to a day. During it the organizer must still RENEW and a reader must still
   * see WHO HOLDS the mailbox. The verdict alone cannot tell a healthy renewal from a gate that
   * read an empty window and claimed afresh, so the case asks HOW: the renewal rewrites this
   * install's own claim (one of ours stands, carrying the new nonce), the read went past the window,
   * and no header SEARCH was asked.
   */
  it("over the window with a day of acknowledgements, the gate still renews and the peek still names the holder", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const claimUid = server.seed(META, incumbentClaim());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) {
      server.seed(META, formatAck({
        requestId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        mailboxId: "22222222-2222-4222-8222-222222222222",
        outcome: "applied",
        ackedAt: new Date(NOW.getTime() - 60_000),
        key: "kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk",
      }));
    }

    const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });
    expect(peek.state, "a reader was told nobody organizes a mailbox that has an organizer")
      .toBe("held");
    expect(peek.holders.map((h) => h.displayName)).toEqual(["The Kitchen Mac"]);

    const events: string[] = [];
    const res = await runLeaseGate({
      capabilities: [], now: NOW, newNonce: () => "n-renewed", log: (e) => { events.push(e); },
      io: makeLeaseIo(server, toServerPath, { ...TEST_META_ID, installId: "incumbent-install" }),
      self: {
        installId: "incumbent-install", kind: "local", displayName: "The Kitchen Mac",
        lastNonce: "incumbent-nonce",
      },
    });

    expect(res.verdict.verdict).toBe("organize");
    expect(res.nonce, "the gate did not renew — it claimed as though the mailbox were unheld")
      .toBe("n-renewed");
    expect(events, "the gate decided from the window").toContain("lease_meta_enumerated");
    expect(server.log.filter((l) => l.startsWith(`search ${META}`)), "the lease asked SEARCH").toEqual([]);
    const left = server.tree.get(META)!.messages;
    expect(left.map((m) => m.uid), "the claim being renewed was left behind in the folder")
      .not.toContain(claimUid);
    const ours = left.filter((m) => m.raw.includes("incumbent-install"));
    expect(ours, "the renewal did not land, or landed beside the record it replaces").toHaveLength(1);
    expect(ours[0]!.raw, "the surviving claim is not the renewed one").toContain("n-renewed");
  });

  /**
   * ══ UID DEPTH DECIDES NOTHING ══════════════════════════════════════════════════════════════
   *
   * The SEARCH walk covered a fixed span below the top of the uid space; churn moved records past
   * it and a rival there went unseen, or the incumbent could never renew. The enumeration reads by
   * SEQUENCE (`1:*`), so a folder whose uids start far down reads like any other.
   * (Twins of "sees a rival below the walk's floor" and "finds its own record however deep".)
   */
  function deepWorld(firstUid: number): ReturnType<typeof memoryImapServer> {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.tree.get(META)!.nextUid = firstUid;
    return server;
  }

  it("sees a rival claim at any uid depth, so the election still has it", async () => {
    const server = deepWorld(12_000);
    server.seed(META, rivalClaim());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) server.seed(META, `Subject: filler ${i}\r\n\r\nbody`);

    const set = await makeLeaseIo(server, toServerPath, TEST_META_ID).listClaims();
    expect(set.some((m) => m.raw.includes("rival-install")),
      "the rival's claim was never read, so an election here would organize over it").toBe(true);
  });

  it("an incumbent at any uid depth still renews", async () => {
    const server = deepWorld(12_000);
    server.seed(META, incumbentClaim());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) server.seed(META, `Subject: filler ${i}\r\n\r\nbody`);
    const res = await runLeaseGate({
      capabilities: [], now: NOW, newNonce: () => "n-renewed",
      io: makeLeaseIo(server, toServerPath, { ...TEST_META_ID, installId: "incumbent-install" }),
      self: { installId: "incumbent-install", kind: "local", displayName: "The Kitchen Mac", lastNonce: "incumbent-nonce" },
    });
    expect(res.verdict.verdict, "the incumbent's own claim became unreadable, so it can never renew").toBe("organize");
  });

  /**
   * ══ THE OWN-CLAIM CONTROL: A REMEMBERED UID IS A PROBE, AND ONLY UNDER ITS OWN NUMBERING ═══════
   *
   * Past the window our last claim, by the uid the server gave it, is read through the same FETCH
   * and must come back recognised (L6). The memo is keyed by (install, mailbox) and carries its
   * generation: a renumbered folder discards it, a reconnect keeps it, another install never
   * borrows it, and a uid our claim no longer holds is forgotten. Each is told apart by WHICH
   * refusal a blanked row draws: `blind` names the probe, `headerless` the general rule.
   */
  async function pastWindowWithOurClaim(): Promise<{ server: ReturnType<typeof memoryImapServer>; ownUid: number }> {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) server.seed(META, `Subject: filler ${i}\r\n\r\nbody`);
    await makeLeaseIo(server, toServerPath, TEST_META_ID).appendClaim(incumbentClaim());
    return { server, ownUid: server.tree.get(META)!.nextUid - 1 };
  }
  const codeOf = async (p: Promise<unknown>): Promise<string> =>
    p.then(() => "read", (e: unknown) => (e instanceof MetaEnumRefusedError ? e.code : `other:${String(e)}`));

  it("discards a remembered uid from an older numbering rather than probing a stranger's record", async () => {
    const { server } = await pastWindowWithOurClaim();
    server.renumber(META);
    server.seed(META, rivalClaim());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) server.seed(META, `Subject: filler ${i}\r\n\r\nbody`);

    const set = await makeLeaseIo(server, toServerPath, TEST_META_ID).listClaims();
    expect(set.some((m) => m.raw.includes("rival-install")), "the rival was left out of the read").toBe(true);
  });

  it("still probes its own claim after a reconnect that changed nothing about the folder", async () => {
    const { server, ownUid } = await pastWindowWithOurClaim();
    server.misbehave({ headersBlankFor: [ownUid] });
    // A DIFFERENT client object over the same folder: that is what a reconnect is from here.
    const after = makeLeaseIo({ ...server, get mailbox() { return server.mailbox; } }, toServerPath, TEST_META_ID);
    expect(await codeOf(after.listClaims()), "the reconnect lost the own-claim control").toBe("blind");
  });

  it("does not lend its own-claim control to another install on the same folder", async () => {
    const { server, ownUid } = await pastWindowWithOurClaim();
    server.misbehave({ headersBlankFor: [ownUid] });
    const theirs = makeLeaseIo(server, toServerPath, { installId: "a-different-install", mailboxId: TEST_META_ID.mailboxId });
    expect(await codeOf(theirs.listClaims()), "another install probed this install's remembered uid").toBe("headerless");
  });

  it("forgets a remembered uid its claim no longer holds, and reads on", async () => {
    const { server, ownUid } = await pastWindowWithOurClaim();
    server.seed(META, rivalClaim());
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    await io.removeClaims([ownUid]);

    expect(peekMemo(TEST_META_ID)?.memo.claimUid).toBe(ownUid);
    const set = await io.listClaims();
    expect(set.some((m) => m.raw.includes("rival-install"))).toBe(true);
    expect(peekMemo(TEST_META_ID)?.memo.claimUid, "the vanished uid was kept as a probe").toBeUndefined();
  });

  /**
   * A CACHED COUNT AND A FRESH ONE, EVERYTHING ELSE HELD CONSTANT: the count is asked of the server
   * by STATUS, never read off the connection's cached `exists` (twin of the cached-ceiling case).
   * The stale cache is a ZERO, the shape measured on Dovecot, which a trusting read elects over.
   *
   * MUTATION WATCHED RED: take the count from `client.mailbox.exists` and the stale connection
   * reads nothing, while the fresh one still finds the incumbent.
   */
  it("the claim read is the same whether the connection's cached count is stale or not", async () => {
    const build = (): ReturnType<typeof memoryImapServer> => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
      server.seed(META, incumbentClaim());
      for (let i = 0; i < META_RECORDS_MAX_PER_FETCH + 10; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
      return server;
    };
    const freshBox = build();
    const fresh = { ...freshBox, get mailbox() { return { exists: freshBox.tree.get(META)!.messages.length, uidValidity: 1_000 }; } };
    const staleBox = build();
    const stale = { ...staleBox, get mailbox() { return { exists: 0, uidValidity: 1_000 }; } };

    const fromFresh = await makeLeaseIo(fresh, toServerPath, TEST_META_ID).listClaims();
    const fromStale = await makeLeaseIo(stale, toServerPath, TEST_META_ID).listClaims();

    expect(fromFresh.some((m) => m.raw.includes("incumbent-install"))).toBe(true);
    expect(fromStale.some((m) => m.raw.includes("incumbent-install")),
      "a stale cached count hid the incumbent's claim, so the election would organize over it").toBe(true);
  });

  /**
   * THE NEGATIVE CONTROL. Under the window nothing new runs: the same engine claims, by the same
   * read, and no enumeration and no search is issued. See L14 for the byte-for-byte command log.
   */
  it("under the window: elects on the window, and issues no search", async () => {
    const { server } = floodedWorld(META_RECORDS_MAX_PER_FETCH - 200);
    const events: string[] = [];
    const res = await runLeaseGate({
      capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID), self: self(), now: NOW,
      newNonce: () => "n-us", log: (e) => { events.push(e); },
    });

    expect(res.verdict.verdict).toBe("stand_down");
    expect(server.log.filter((l) => l.startsWith(`search ${META}`)),
      "a folder inside the window asked the server for the claim set anyway").toHaveLength(0);
    expect(events).not.toContain("lease_meta_enumerated");
  });

  /** AND THE PEEK SHOWS THE PERSON WHO HOLDS THEIR MAILBOX over a folder past the window. */
  it("the peek names the holder over a folder past the window", async () => {
    const { server } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 10);
    const peek = await readLeasePeek({ io: makeLeasePeekIo(server, toServerPath), now: NOW });

    expect(peek.state).toBe("held");
    expect(peek.holders.map((h) => h.displayName),
      "the person is told nobody holds their mailbox, over a folder that names a holder")
      .toEqual(["The Kitchen Mac"]);
    expect(peek.unreadable).toBe(0);
    expect(server.log.filter((l) => l.startsWith(`append ${META}`))).toHaveLength(0);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE SECOND REVIEW ROUND — the window's guarantee must not invert, and an absence must be earned
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 */
describe("the window's guarantees under the cases a review round found", () => {
  /**
   * A COUNT THAT IS MISSING OR UNREFRESHED IS ASKED FOR, NOT GUESSED AT.
   *
   * `from` counts BACK from the end, so a count that is wrong LOW walks the window toward the start
   * of the folder and hands back exactly the oldest-first read this function exists to replace. Two
   * ways to get one and neither announces itself: the client reports no `exists`, or the NOOP that
   * would have corrected a stale value failed — and that failure is swallowed by design, because a
   * refresh that did not happen leaves the caller no worse off than not asking. No worse for the old
   * code; for this arithmetic it is the difference between the newest window and the oldest.
   *
   * So the server is asked outright: `*` is the highest existing sequence number, so fetching that
   * one message carries the folder's true count in its own `seq`.
   */
  it("with no cached count, ASKS the server and still reads the newest window", async () => {
    const { server, claimUid } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    await server.getMailboxLock(META);
    const countless = { ...server, mailbox: false as const, noop: undefined };

    const read = await readMetaFolderWindow(countless, META);

    // The count was LEARNED rather than left unknown…
    expect(read.total).toBe(META_RECORDS_MAX_PER_FETCH + 101);
    expect(read.truncated).toBe(true);
    expect(read.records).toHaveLength(META_RECORDS_MAX_PER_FETCH);
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
    // …so the window is computed rather than walked, and the probe is visible in the trace.
    // The probe is a SEARCH — it is not a fetch and must not appear in the fetch trace.
    expect(searchCount(server)).toBe(1);
    expect(fetchRanges(server)).toEqual([`${102}:*`]);
  });

  /**
   * A NOOP THAT FAILED IS THE SAME SITUATION, and it is the one that actually happens: the count is
   * present, plausible, and possibly stale-low. It is asked for too.
   */
  it("asks the server when the refresh that would have corrected the count FAILED", async () => {
    const { server, claimUid } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    await server.getMailboxLock(META);
    const noopBroken = {
      ...server,
      get mailbox() { return server.mailbox; },
      async noop(): Promise<unknown> { throw new Error("the server refused the NOOP"); },
    };

    const read = await readMetaFolderWindow(noopBroken, META);

    expect(read.total).toBe(META_RECORDS_MAX_PER_FETCH + 101);
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
    // The probe is a SEARCH — it is not a fetch and must not appear in the fetch trace.
    expect(searchCount(server)).toBe(1);
    expect(fetchRanges(server)).toEqual([`${102}:*`]);
  });

  /**
   * AND THE SLIDING EVICTION IS STILL THE FLOOR, for a client that answers neither — no `exists`
   * and no `seq` on its fetch responses. The range stays `1:*`, records arrive oldest-first, and
   * dropping from the FRONT is what keeps the guarantee. It costs the whole folder over the wire,
   * which is the honest price of a server that will say nothing about what it holds.
   *
   * MUTATION WATCHED RED: replace `records.shift()` with a `break` and the claim at the end of the
   * folder leaves the window again.
   */
  it("falls back to the sliding window when the server reports no sequence either", async () => {
    const { server, claimUid } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    await server.getMailboxLock(META);
    // A client that will say nothing about the folder's size: no cached count, no refresh, and no
    // SEARCH either. (It used to be a client whose FETCH omitted `seq`, which stopped meaning
    // anything once the probe stopped being a fetch.)
    const silent = { ...server, mailbox: false as const, noop: undefined, status: undefined };

    const read = await readMetaFolderWindow(silent, META);

    expect(read.total).toBeNull();
    expect(read.truncated).toBe(true);
    expect(read.records).toHaveLength(META_RECORDS_MAX_PER_FETCH);
    // THE ASSERTION THIS CASE EXISTS FOR: the live claim is the LAST message in the folder, so a
    // window that kept the oldest records would not have it.
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
    expect(read.records.at(-1)!.raw).toContain("incumbent-install");
  });

  /**
   * A COUNT THAT IS WRONG **HIGH** IS WORSE THAN NO COUNT AT ALL, AND THE FALLBACK TOOK IT.
   *
   * The two cases above both end with the server answering the probe. This is the one where it does
   * not, and the old fallback then reached for the very count the probe was sent because it could
   * not be trusted — `probed ?? count`, with no memory of the fact that `refreshed` was false.
   *
   * Wrong LOW walks the window toward the start of the folder, which is the failure the cases above
   * cover. Wrong HIGH is a different and quieter one, because a messageset is a RANGE whose
   * endpoints are unordered (RFC 3501 §9). A connection still caching 1000 against a folder another
   * client has cut to 400 computes `501:*`; `*` is 400; the server reads `501:400` as `400:501` and
   * returns the single message 400. It does not error and it does not answer empty.
   *
   * What arrives is one record, and `truncated` — because `from > 1` — for a folder holding less
   * than its ceiling. Both halves mislead in the direction that costs the most. The drains
   * refuse a folder that is well inside the limit. The gate, which ACTS on a truncated window by
   * design, elects over a one-record election in which the live claim three messages earlier simply
   * is not present, and starts organizing a mailbox somebody else holds.
   *
   * The fix is to say the length is unknown, which is what it is. `1:*` and the sliding eviction
   * cost the whole folder over the wire — the honest price of a connection that can tell you
   * nothing about what it is looking at.
   *
   * MUTATION WATCHED RED: restore `probed ?? (typeof count === "number" ? count : null)` and the
   * range goes back to `501:*`, one record, `truncated: true`, and no claim.
   */
  it("does NOT count back from a stale count the probe could not confirm", async () => {
    const TRUE_COUNT = META_RECORDS_MAX_PER_FETCH - 100;
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < TRUE_COUNT - 3; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    // The claim is NOT the last message, so a read that returns only the folder's tail loses it.
    const claimUid = server.seed(META, incumbentClaim());
    server.seed(META, "Subject: later 0\r\n\r\nbody");
    server.seed(META, "Subject: later 1\r\n\r\nbody");
    await server.getMailboxLock(META);

    const stale = {
      ...server,
      // The connection's cache, from before another client expunged the folder down to 400.
      mailbox: { exists: META_RECORDS_MAX_PER_FETCH * 2 },
      async noop(): Promise<unknown> { throw new Error("the server refused the NOOP"); },
      // …and no SEARCH either, so the probe comes back with nothing.
      status: undefined,
    };

    const read = await readMetaFolderWindow(stale, META);

    // THE HARM FIRST, so this guard's failure names what goes wrong rather than how.
    expect(read.records).toHaveLength(TRUE_COUNT);
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
    // A folder under its ceiling is a COMPLETE read, and must not claim otherwise.
    expect(read.truncated).toBe(false);
    expect(read.total).toBeNull();
    // …and the mechanism: this connection cannot be asked (no cached count it will admit to, no
    // refresh, no SEARCH), so the read went WIDE rather than doing arithmetic on a number it had
    // just declared untrustworthy. ZERO searches, because there is no probe to make.
    expect(searchCount(server)).toBe(0);
    expect(fetchRanges(server)).toEqual(["1:*"]);
  });

  /**
   * AN EXPUNGE BETWEEN THE COUNT AND THE FETCH SLIDES THE WINDOW OUT FROM UNDER THE RANGE.
   *
   * `from` is a SEQUENCE number computed from a count taken one round trip earlier, and sequence
   * numbers are not stable: expunging a message renumbers every message above it downward at once.
   * The existing renumbering guard cannot see this — it compares UIDVALIDITY, and an EXPUNGE does
   * not change UIDVALIDITY. It is not a renumbering of uids at all, only of the coordinate this
   * range happens to be written in.
   *
   * Here the count says 1000, so the range is `501:*`; another connection then takes the folder to
   * 400. `501:400` is `400:501` by the unordered-range rule, so ONE record comes back, still
   * flagged truncated — the one-record election window again, reached by a race rather than a
   * stale cache. The read notices because a capped window that returns less than the ceiling did
   * not get what it asked for, and re-reads the folder whole.
   *
   * MUTATION WATCHED RED: drop the `records.length < META_RECORDS_MAX_PER_FETCH` re-read and the
   * window is one record with no claim in it.
   */
  it("re-reads whole when an EXPUNGE shifts the numbering under the range", async () => {
    const TRUE_COUNT = META_RECORDS_MAX_PER_FETCH - 100;
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < TRUE_COUNT - 3; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    const claimUid = server.seed(META, incumbentClaim());
    server.seed(META, "Subject: later 0\r\n\r\nbody");
    server.seed(META, "Subject: later 1\r\n\r\nbody");
    await server.getMailboxLock(META);

    // A STATUS answered BEFORE the other connection's expunge: a real server reply, correct when it
    // was given, and stale by the time the FETCH goes out. The count no longer comes from the
    // connection's cache, so that is where this race has to be injected.
    const shifted = {
      ...server,
      async status(): Promise<{ messages: number }> {
        return { messages: META_RECORDS_MAX_PER_FETCH * 2 };
      },
    };

    const read = await readMetaFolderWindow(shifted, META);

    // The claim is back, and the folder is reported as what it actually holds.
    expect(read.records).toHaveLength(TRUE_COUNT);
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
    expect(read.truncated).toBe(false);
    expect(read.total).toBe(TRUE_COUNT);
    // The count was asked for and answered — with a number that had just stopped being true.
    expect(searchCount(server)).toBe(0); // the fake's own STATUS is overridden here, so none logged
    // The capped range was tried, came back short, and the whole folder was read instead.
    expect(fetchRanges(server)).toEqual([`${META_RECORDS_MAX_PER_FETCH + 1}:*`, "1:*"]);
  });

  /**
   * A PROBE THAT ANSWERS `false` IS AN ANSWER, AND IT MEANS "I DO NOT KNOW".
   *
   * The library's STATUS does not throw when its preconditions are not met — it RETURNS `false`
   * (`imapflow/lib/commands/status.js`: *"Status information object, or false if preconditions not
   * met or on failure"*). So `false` is a value the probe must handle rather than a case it can
   * optional-chain through, and it means exactly what a missing field means: the count is unknown,
   * so read the folder whole and let the sliding eviction keep the newest.
   *
   * Worth its own case because the failure it guards is silent in the expensive direction: treat
   * `false` as a count and the arithmetic below it is done on `NaN` or on nothing.
   */
  it("treats a STATUS of `false` as an unknown count, not as an answer", async () => {
    const { server, claimUid } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    await server.getMailboxLock(META);
    const refusing = {
      ...server,
      mailbox: false as const,
      noop: undefined,
      async status(): Promise<false> { return false; },
    };

    const read = await readMetaFolderWindow(refusing, META);

    expect(read.total).toBeNull();
    expect(read.truncated).toBe(true);
    expect(read.records).toHaveLength(META_RECORDS_MAX_PER_FETCH);
    // The whole-folder fallback still keeps the NEWEST, which is the guarantee that matters.
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
    expect(fetchRanges(server)).toEqual(["1:*"]);
  });


  /**
   * A NOOP THAT RESOLVES PROVES NOTHING, SO A CACHED ZERO MUST NOT END THE READ.
   *
   * The library discards the command's own result — `async noop() { await this.run('NOOP'); }`
   * (`imap-flow.js` 1.5.0) — so a server that REFUSES the NOOP produces a call that resolves
   * exactly like an accepted one. Code that set `refreshed = true` on that basis was inferring a
   * refresh from the absence of a throw.
   *
   * The consequence was the worst available: a connection caching `exists = 0` from before another
   * install appended its claim would refuse the NOOP, record itself as refreshed, return the stale
   * zero, and the GATE would elect over an empty folder and append a second live claim. Two
   * organizers on one mailbox, out of a boolean.
   *
   * The double here does what the library does — resolves, having done nothing.
   *
   * MUTATION WATCHED RED: trust a cached zero before asking the server and the claim vanishes.
   */
  it("a NOOP that resolves without refreshing cannot make a cached zero true", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], staleExists: true });
    const claimUid = server.seed(META, incumbentClaim());
    await server.getMailboxLock(META);
    const lying = {
      ...server,
      // The cache from before the append, and a NOOP that RESOLVES while refreshing nothing.
      mailbox: { exists: 0 },
      async noop(): Promise<unknown> { return undefined; },
    };

    const read = await readMetaFolderWindow(lying, META);

    expect(read.records, "a stale zero ended the read and hid a live claim").toHaveLength(1);
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
  });

  /**
   * AN EXPUNGE THAT REMOVED NOTHING MUST NOT REPORT A REMOVAL.
   *
   * `messageDelete` is `resolveRange` then `run('EXPUNGE', …)`. The STORE that marks `\Deleted` is
   * internal to it and its result is NOT propagated, so a refused STORE followed by an accepted
   * EXPUNGE — which then deletes nothing — resolves `true`. Checking the return value catches a
   * refused command and nothing else.
   *
   * On the lease this is load-bearing twice over: a displacement that silently did not land returns
   * `organize`, spends the caller's one-shot authorization, and leaves the beaten claim standing to
   * win the next election.
   *
   * The double behaves exactly like the library: returns `true`, removes nothing.
   *
   * MUTATION WATCHED RED: drop the custody read-back and this passes while the claim is still there.
   */
  it("an expunge that resolves true while removing nothing is a failure, not a removal", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const claimUid = server.seed(META, incumbentClaim());
    const io = makeLeaseIo({
      ...server,
      // Accepts the command, deletes nothing — the shape a refused STORE plus an accepted EXPUNGE
      // produces, and indistinguishable from success by the return value alone.
      async messageDelete(): Promise<boolean> { return true; },
    }, toServerPath, TEST_META_ID);

    await expect(io.removeClaims([claimUid]),
      "a claim that survived its own expunge was reported as removed").rejects.toThrow(/survived/);
  });

  /**
   * ── AND A CUSTODY READ THAT COULD NOT RUN IS NOT PROOF EITHER ─────────────────────────────
   *
   * The read-back above is the only thing that can tell a real expunge from a server that accepts
   * the command and removes nothing. When that read REJECTS, this returned normally — on the
   * reasoning that an unreadable folder is not evidence the expunge failed. It is not evidence it
   * succeeded either, and the caller cannot tell the two apart: `releaseMailboxClaim` reports a
   * positive count from a normal return, so "released" was said about a claim that may still be
   * holding the mailbox against the next install.
   *
   * The expunge is allowed to have worked. What is refused is REPORTING that it did.
   *
   * MUTATION WATCHED RED: restore the `return` in the custody catch and this resolves.
   */
  it("a custody read that could not run is reported as unproven, not as a removal", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const claimUid = server.seed(META, incumbentClaim());
    let deleted = false;
    const io = makeLeaseIo({
      ...server,
      async messageDelete(range: unknown, opts: unknown): Promise<unknown> {
        deleted = true;
        return (server as unknown as {
          messageDelete(r: unknown, o: unknown): Promise<unknown>;
        }).messageDelete(range, opts);
      },
      // The connection drops between the expunge and the read that would prove it.
      fetch(): AsyncGenerator<never> { throw new Error("connection reset by peer"); },
    }, toServerPath, TEST_META_ID);

    await expect(io.removeClaims([claimUid]),
      "an expunge nothing could verify was reported as a removal")
      .rejects.toThrow(/could not be verified/);
    // The point is the REPORT, not the delete: the command did run.
    expect(deleted, "the expunge itself never issued, so this proves nothing about the report")
      .toBe(true);
  });

  /**
   * THE OTHER HALF, AND WITHOUT IT THE ONE ABOVE PASSES FOR THE WRONG REASON: a custody read that
   * runs and finds the folder EMPTY must resolve. `UID FETCH <uid>` against an emptied mailbox is a
   * valid command that matches nothing, and if that reads as a failure then every honest release
   * throws and the guard above is indistinguishable from "custody always throws".
   *
   * This is also the case the double got wrong. It refused every FETCH on an empty folder, so the
   * ordinary release took the swallowed-exception path and the defect above was invisible here.
   */
  /**
   * ── THE UID GENERATION, WHICH DECIDES WHETHER THESE REFS MEAN ANYTHING AT ALL ─────────────
   *
   * `removeClaims` expunges by uid, and a uid is a fact only under the numbering it was read
   * under. Both arms of that decision existed in the code and NEITHER had ever been watched fail:
   * a PROVEN renumbering refuses, and an unknowable generation proceeds on a stated reason (the
   * confirm-by-re-read is the backstop, and refusing there would refuse every cleanup a server
   * that names no generation will ever need).
   *
   * MUTATION WATCHED RED for the first: drop the `stale` arm and the rival's claim is expunged by
   * uid coincidence. For the second: make an unknown epoch refuse and an ordinary release throws.
   */
  it("a PROVEN renumbering refuses the expunge, and the stranger's claim survives it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);
    const claimUid = server.seed(META, incumbentClaim());
    // The read that names the refs is also the read that samples the generation they belong to.
    await io.listClaims();

    // The folder is deleted and recreated, and somebody else's claim lands on the recycled uid.
    server.renumber(META);
    const rivalUid = server.seed(META, rivalClaim());
    expect(rivalUid, "the fixture proves nothing unless the uid is genuinely recycled").toBe(claimUid);

    const verdict = await io.removeClaims([claimUid]).then(
      () => "expunged",
      (err: unknown) => (/renumbered/.test(String((err as Error).message)) ? "refused" : "other"),
    );
    expect(verdict).toBe("refused");
    // THE POINT: the rival's claim is still there. Expunging it would have handed this mailbox to
    // whoever asked next, by nothing more than a uid coincidence.
    const left = await io.listClaims();
    expect(left.map((c) => JSON.stringify(c)).join(" ")).toContain("rival-install");
  });

  it("an UNKNOWABLE generation proceeds, which is the decided behaviour and not an oversight", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const claimUid = server.seed(META, incumbentClaim());
    // A server that never names a generation. The getter is defined AFTER the spread on purpose:
    // spreading evaluates `mailbox` once, and a fixture that froze the first reading would answer
    // for a folder nobody is selected into.
    const silent = {
      ...server,
      get mailbox(): { exists?: number; uidValidity?: number } | false {
        const m = server.mailbox;
        // `mailbox` is OPTIONAL on the client contract, so "no mailbox selected" and "not reported
        // at all" both arrive here and both mean the same thing to this fixture.
        return m === false || m === undefined ? false : { exists: m.exists };
      },
    };
    const io = makeLeaseIo(silent, toServerPath, TEST_META_ID);
    await io.listClaims();

    await expect(io.removeClaims([claimUid]),
      "a server that names no generation cannot be made to refuse every cleanup it will ever need")
      .resolves.toBeUndefined();
    expect(await io.listClaims(), "the claim was not removed").toHaveLength(0);
  });

  it("a custody read that finds the folder empty is a proved removal", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const claimUid = server.seed(META, incumbentClaim());
    const io = makeLeaseIo(server, toServerPath, TEST_META_ID);

    await expect(io.removeClaims([claimUid])).resolves.toBeUndefined();
    expect(await io.listClaims(), "the claim is still in the folder").toHaveLength(0);
  });


  /**
   * A REFUSED SEARCH IS "COULD NOT ASK", NEVER "THERE ARE NONE".
   *
   * The library resolves `false` when the server refuses a SEARCH — it does not reject. Mapping
   * every non-array reply to `[]` told the caller this install owns no records in the folder, which
   * is precisely the answer that lets a release report success having removed nothing.
   *
   * `null` sends the caller to the bounded window instead, which is the behaviour it had before the
   * finder existed — worse than a complete answer, and honest about being so.
   *
   * MUTATION WATCHED RED: map a refusal back to `[]` and this returns an empty array.
   */
  /* "a SEARCH that resolves false reports 'could not ask', not 'no records'" stood here and is
     SUPERSEDED, not weakened: `findOwnRecords` no longer asks the server's search at all, so a
     refused search can no longer be misread as an empty folder by that path. The same fixture with
     the new contract's expectation is "a provider that refuses SEARCH still gets a release" above;
     the null-vs-empty rule still holds for the reads that DO search (`listClaimRecords`, asserted
     elsewhere in this file). */

  /** And a folder that FITS is unchanged on every path — no shifting, nothing dropped. */
  it("with no count available and a folder inside the ceiling, nothing is dropped", async () => {
    const { server, claimUid } = floodedWorld(3);
    await server.getMailboxLock(META);
    const countless = { ...server, mailbox: false as const, noop: undefined };

    const read = await readMetaFolderWindow(countless, META);
    expect(read.truncated).toBe(false);
    expect(read.records).toHaveLength(4);
    expect(read.records.map((m) => m.ref)).toContain(claimUid);
  });

  /**
   * THE REQUEST LISTING READS PAST THE WINDOW WHOLE, through the same door as the lease: a request
   * buried under the flood is listed, and the count is the folder's, not the window's.
   */
  it("the request listing reads a folder past the window whole", async () => {
    const { server } = buriedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    server.seed(META, "X-Ohmail-Request: 1\r\nSubject: newest request\r\n\r\nbody");
    const buried = server.tree.get(META)!.messages[0]!.uid;
    const total = server.tree.get(META)!.messages.length;
    const listed = await makeRequestOrganizerIo(server, toServerPath, TEST_META_ID).listMetaRecords();
    expect(listed.count).toBe(total);
    expect(listed.records.map((r) => r.ref)).toContain(total);
    expect(listed.records.map((r) => r.ref), "the claim is not a request or an ack").not.toContain(buried);
  });

  /**
   * THE PEEK REPORTS THE FULL FOLDER, not only in a sentence it throws.
   *
   * The gate emits `lease_enum_refused` on this condition; the peek was silent, so one mailbox
   * reported the fault from one door and not from the other. A thrown message reaches somebody only
   * if the caller renders it, and this refusal usually renders as "we could not check" — which a
   * person reads as a blip.
   *
   * MUTATION WATCHED RED: drop the `input.log?.(…)` call and no line is emitted.
   */
  /**
   * THE PEEK ANSWERS A FOLDER PAST THE WINDOW — it reads it whole, as the gate does. The refusal it
   * keeps is the one that is still real, a read that cannot prove itself complete, below.
   */
  it("logs the truncated read, and answers from the claim set rather than refusing", async () => {
    const { server } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    const total = server.tree.get(META)!.messages.length;
    const events: Array<[string, Record<string, unknown>]> = [];

    const peek = await readLeasePeek({
      io: makeLeasePeekIo(server, toServerPath),
      now: NOW,
      log: (event, detail) => { events.push([event, detail]); },
    });

    /* NO LINE HERE: the peek logs only a read that refused, and this one answered. Asserted so the
     * absence is a decision on the record and not a line that quietly stopped being emitted. */
    expect(events).toEqual([]);
    expect(total).toBeGreaterThan(META_RECORDS_MAX_PER_FETCH);
    expect(peek.state).toBe("held");
    expect(peek.holders.map((h) => h.displayName)).toEqual(["The Kitchen Mac"]);
  });

  /**
   * AND IT REFUSES WHEN THE READ CANNOT PROVE ITSELF COMPLETE: "I could not see all of it" renders
   * as unknown, never as nobody. No count past the window is that read. (Was: a peek that cannot
   * search; SEARCH no longer decides the peek.)
   */
  it("a peek that cannot count a folder past the window refuses rather than reporting an unheld mailbox", async () => {
    const { server } = floodedWorld(META_RECORDS_MAX_PER_FETCH + 100);
    await expect(readLeasePeek({
      io: makeLeasePeekIo({ ...server, status: undefined }, toServerPath), now: NOW,
    })).rejects.toMatchObject({ name: "LeaseUnavailableError", op: "list_claims" });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE HANDOVER CONFIRM PROVES CUSTODY FROM A COMPLETE READ
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The handover CONFIRM is a custody check — "is the claim I displaced really gone" — and a
 * newest-first window drops exactly the old refs it has to prove gone. Every lease read is now
 * complete, so an absent ref is an expunged one wherever it sat (L13), and a surviving one is seen
 * wherever it sits; only an incomparable uid generation leaves an absence unprovable.
 */
describe("the handover confirm does not read an unread ref as an expunged one", () => {
  /** A server whose EXPUNGE reports success and removes nothing — the documented lying shape. */
  function serverThatKeepsWhatItDeletes() {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const deleted: number[][] = [];
    return Object.assign(server, {
      deleted,
      async messageDelete(range: number[]): Promise<unknown> {
        // Resolves TRUE — "the STORE was refused under a no-op EXPUNGE" — while the folder keeps
        // every message. `removeClaims` treats a `false` as a failure and cannot see this one.
        deleted.push([...range]);
        return true;
      },
    });
  }

  /** An incumbent nobody pressed for, which is exactly the holder an authorized press takes. */
  function unpressedIncumbent(): string {
    return formatClaim({
      installId: "incumbent-install",
      kind: "local",
      displayName: "The Kitchen Mac",
      claimedAt: new Date(NOW.getTime() - 600_000),
      heartbeat: new Date(NOW.getTime() - 5_000),
      nonce: "incumbent-nonce",
      authorizedAt: null,
      capabilities: [],
      protocol: CLAIM_PROTOCOL,
    });
  }

  /**
   * L13: THE DISPLACED CLAIM BELOW THE OLD WINDOW, REALLY EXPUNGED, CONFIRMS. The incumbent's uid
   * is the lowest in a folder past the window; the takeover removes it and the custody read, past
   * the window too, proves it gone. (Was "refuses … fell OUT of the confirm's window": at base the
   * truncated custody read counted it a survivor and every such takeover refused.)
   *
   * MUTATION WATCHED RED: give the custody read the window and this refuses as a survivor.
   */
  it("L13: completes the takeover when the displaced claim lay below the old window", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, unpressedIncumbent());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);

    const out = await runLeaseGate({
      capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID), self: self(), now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" },
    }).then((r) => r.verdict.verdict, (e: unknown) => `${(e as Error).name}:${(e as LeaseUnavailableError).op}`);

    expect(out, "a takeover whose displaced claim sat below the window was refused").toBe("organize");
    const raws = server.tree.get(META)!.messages.map((m) => m.raw);
    expect(raws.filter((r) => r.includes("incumbent-install"))).toHaveLength(0);
    expect(raws.filter((r) => /^X-Ohmail-Install-Id: us\r?$/m.test(r))).toHaveLength(1);
  });

  /**
   * AND THE SURVIVOR IS SEEN WHEREVER IT SITS: a server that keeps what it deletes, past the
   * window, refuses on the evidence, and our claim is withdrawn.
   */
  it("refuses the takeover when the displaced claim below the window survived the expunge", async () => {
    const server = serverThatKeepsWhatItDeletes();
    server.seed(META, unpressedIncumbent());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH; i++) server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);

    const err = await runLeaseGate({
      capabilities: [], io: makeLeaseIo(server, toServerPath, TEST_META_ID), self: self(), now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseUnavailableError);
    expect((err as LeaseUnavailableError).op).toBe("remove_claims");
    expect((err as Error).message).toMatch(/could not be recorded/);
    const raws = server.tree.get(META)!.messages.map((m) => m.raw);
    expect(raws.filter((r) => r.includes("incumbent-install"))).toHaveLength(1);
  });

  /**
   * A UIDVALIDITY CHANGE MAKES THE TWO READS' REFS INCOMPARABLE, and that is a second route to the
   * same false confirmation.
   *
   * Refs are UIDs. Across a UIDVALIDITY change the server has renumbered the folder, so a ref the
   * election recorded names a different message now, or none — and `stillRefs.has(r)` is then a
   * comparison between two numbering schemes. It can answer "gone" for a claim sitting right there
   * under a new uid, which confirms a handover that never happened.
   *
   * The folder here is small, so the coverage rule cannot be what refuses this: the window covers
   * everything. Only the renumbering check can.
   *
   * MUTATION WATCHED RED: drop the `renumbered` term and this resolves an `organize` verdict.
   */
  /**
   * A server that reports one generation for the ELECTION read and another — or none at all — for
   * the CONFIRM's, flipping at the APPEND, which is exactly the window in which a long-lived
   * connection can be handed a replaced folder. Every other member stays the real server's, so the
   * expunge really happens and the displaced ref really is gone: whatever these cases refuse on,
   * it is not the evidence.
   */
  function generationFlipsAtAppend(
    server: ReturnType<typeof memoryImapServer>,
    before: number | undefined,
    after: number | undefined,
  ): ReturnType<typeof memoryImapServer> {
    let generation = before;
    const appendOriginal = server.append.bind(server);
    // `Object.create` rather than a spread or an assign: `mailbox` is a live GETTER on the fake, so
    // a spread would snapshot it and an assign cannot replace it. Prototype delegation leaves every
    // other member — the tree, the command log, the fetch — pointing at the real server.
    const flipping = Object.create(server) as ReturnType<typeof memoryImapServer>;
    Object.defineProperty(flipping, "mailbox", {
      get(): { exists?: number; uidValidity?: number } | false {
        return { exists: server.tree.get(META)?.messages.length ?? 0, uidValidity: generation };
      },
    });
    Object.defineProperty(flipping, "append", {
      value: async (name: string, content: string | Buffer): Promise<unknown> => {
        const r = await appendOriginal(name, content);
        generation = after;
        return r;
      },
    });
    return flipping;
  }

  /** The gate over a folder holding one unpressed incumbent, with its log collected. */
  async function pressTakeover(
    driver: ReturnType<typeof memoryImapServer>,
  ): Promise<{ outcome: unknown; lines: { event: string; detail: Record<string, unknown> }[] }> {
    const lines: { event: string; detail: Record<string, unknown> }[] = [];
    const outcome = await runLeaseGate({
      capabilities: [],
      io: makeLeaseIo(driver, toServerPath, TEST_META_ID),
      self: self(),
      now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" },
      log: (event, detail) => { lines.push({ event, detail }); },
    }).catch((e: unknown) => e);
    return { outcome, lines };
  }

  it("refuses the takeover when the folder was RENUMBERED between the election and the confirm", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, unpressedIncumbent());

    const { outcome, lines } = await pressTakeover(generationFlipsAtAppend(server, 1, 2));

    expect(outcome).toBeInstanceOf(LeaseUnavailableError);
    expect((outcome as LeaseUnavailableError).op).toBe("remove_claims");
    // One line per class, so an operator can tell a replaced folder from a silent one.
    expect(lines.filter((l) => l.event === "lease_folder_renumbered")).toHaveLength(1);
    expect(lines.filter((l) => l.event === "lease_epoch_unknown")).toHaveLength(0);
  });

  /**
   * ═══ AND AN UNNAMED GENERATION IS "CANNOT SAY", NOT "NO CHANGE DETECTED" ═══════════════════
   *
   * `ORGANIZER-LEASE-READS-AN-UNNAMED-EPOCH-AS-NO-CHANGE`. The check above used to be written as
   * three `!== null` comparisons, so a confirm read the server named no generation for resolved to
   * `renumbered === false` — the one case with nothing to prove was the case nothing was asked of,
   * and the gate CONFIRMED the handover. The folder here is small and the expunge is real, so the
   * coverage rule cannot be what refuses and neither can the evidence: only the door can.
   *
   * `0` is the same state as absent and gets its own case, because that is the spelling this
   * defect class actually arrives in — a server that reports the field and puts nothing in it.
   *
   * MUTATIONS WATCHED RED (2026-09-12, restores verified by `cmp`):
   *  · `epochs !== "usable"` → `epochs === "stale"` (the old "no change detected" reading) ⇒ both
   *    cases below resolve an `organize` verdict with the incumbent's claim never proved gone;
   *  · the `unknown` arm made a stand-down instead ⇒ the third case below reddens on a mailbox
   *    handed back over a read failure.
   */
  for (const [name, reported] of [
    ["reports no UIDVALIDITY at all", undefined],
    ["spells 'no generation' as a zero", 0],
  ] as ReadonlyArray<readonly [string, number | undefined]>) {
    it(`refuses the takeover when the confirm read ${name}`, async () => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
      server.seed(META, unpressedIncumbent());

      const { outcome, lines } = await pressTakeover(generationFlipsAtAppend(server, 1, reported));

      expect(outcome, "a takeover confirmed over refs the read could not speak about")
        .toBeInstanceOf(LeaseUnavailableError);
      expect((outcome as LeaseUnavailableError).op).toBe("remove_claims");

      // NEVER A STAND-DOWN: the class is could-not-look, which every host exempts and which leaves
      // the mailbox with the organizer it has. A stand-down would hand it back over a read failure.
      expect((outcome as Error).message).toMatch(/could not be recorded/);

      // ONE LINE, NAMING THE CLASS AND WHICH READ WENT SILENT.
      const said = lines.filter((l) => l.event === "lease_epoch_unknown");
      expect(said).toHaveLength(1);
      expect(said[0]!.detail.state).toBe("confirm_read");
      expect(lines.filter((l) => l.event === "lease_folder_renumbered")).toHaveLength(0);

      // AND OUR OWN CLAIM IS WITHDRAWN, so nothing stands under a takeover that was refused. The
      // incumbent's record really did go — this server expunges for real — which is the point of
      // the fixture: there is nothing in the folder for the refusal to have come from.
      const raws = server.tree.get(META)!.messages.map((m) => m.raw);
      expect(raws.filter((r) => /^X-Ohmail-Install-Id: us\r?$/m.test(r)),
        "a claim of ours left standing under a refused takeover").toHaveLength(0);
      expect(raws.filter((r) => r.includes("incumbent-install")),
        "the displaced claim, which the expunge really took").toHaveLength(0);
    });
  }

  /**
   * THE POSITIVE CONTROL FOR THAT ARM, through the SAME harness: the generation is named and does
   * not move, and the takeover completes. Without it the two cases above would pass just as well
   * against a gate that refused every takeover driven through `generationFlipsAtAppend`.
   */
  it("completes the takeover when the generation is named and unchanged across both reads", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, unpressedIncumbent());

    const { outcome, lines } = await pressTakeover(generationFlipsAtAppend(server, 1, 1));

    expect((outcome as { verdict: { verdict: string } }).verdict.verdict).toBe("organize");
    expect(lines.filter((l) => l.event === "lease_epoch_unknown")).toHaveLength(0);
    const raws = server.tree.get(META)!.messages.map((m) => m.raw);
    expect(raws.filter((r) => r.includes("incumbent-install"))).toHaveLength(0);
  });

  /**
   * ═══ WHAT A SILENT SERVER ACTUALLY COSTS, READ OFF THE GATE ════════════════════════════════
   *
   * `LEASE-TAKEOVER-CANNOT-COMPLETE-ON-A-SERVER-THAT-NAMES-NO-EPOCH` was filed with a bound
   * REASONED from the code — "it refuses every pass until the incumbent ages out of the staleness
   * window". These two cases are the measurement, and they are here because a stated cost nobody
   * has read off the subject is a claim, not a bound.
   */
  it("MEASURED: the pass after a refused takeover has nothing left to displace, and organizes", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, unpressedIncumbent());

    const first = await pressTakeover(generationFlipsAtAppend(server, 1, undefined));
    expect(first.outcome).toBeInstanceOf(LeaseUnavailableError);
    expect(server.tree.get(META)!.messages, "the refusal leaves the folder empty").toHaveLength(0);

    const second = await pressTakeover(generationFlipsAtAppend(server, undefined, undefined));
    const v = (second.outcome as { verdict: { verdict: string; displace: readonly unknown[]; authorized: boolean } }).verdict;
    expect(v.verdict).toBe("organize");
    expect(v.displace).toEqual([]);
    expect(v.authorized).toBe(true);
    expect(second.lines.filter((l) => l.event === "lease_epoch_unknown")).toHaveLength(0);
  });

  it("MEASURED: while a rival keeps renewing, every pass refuses", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, unpressedIncumbent());

    const first = await pressTakeover(generationFlipsAtAppend(server, 1, undefined));
    expect(first.outcome).toBeInstanceOf(LeaseUnavailableError);

    server.seed(META, unpressedIncumbent());
    const second = await pressTakeover(generationFlipsAtAppend(server, 1, undefined));
    expect(second.outcome).toBeInstanceOf(LeaseUnavailableError);
  });

  /**
   * THE COUNTERWEIGHT. The same lying server with a folder that stays inside the ceiling: the
   * confirm's window covers every ref, the surviving claim is SEEN, and the refusal comes from the
   * evidence rather than from the coverage rule. Without this, the case above would pass just as
   * well against a gate that refused every takeover.
   */
  it("still refuses on the evidence when the window covers everything", async () => {
    const server = serverThatKeepsWhatItDeletes();
    server.seed(META, unpressedIncumbent());

    const err = await runLeaseGate({
      capabilities: [],
      io: makeLeaseIo(server, toServerPath, TEST_META_ID),
      self: self(),
      now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" },
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(LeaseUnavailableError);
    expect((err as LeaseUnavailableError).op).toBe("remove_claims");
  });

  /**
   * AND AN HONEST SERVER STILL COMPLETES THE TAKEOVER over a folder past the ceiling. The coverage
   * rule must not refuse a handover that actually landed — the refusal is about what the read could
   * not see, and an expunge that really happened removes the ref from the folder entirely.
   */
  it("completes the takeover when the expunge really happened, ceiling or no ceiling", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, unpressedIncumbent());
    for (let i = 0; i < META_RECORDS_MAX_PER_FETCH - 1; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }

    const res = await runLeaseGate({
      capabilities: [],
      io: makeLeaseIo(server, toServerPath, TEST_META_ID),
      self: self(),
      now: NOW,
      takeover: { authorizedAt: NOW, intent: "takeover" },
    });

    expect(res.verdict.verdict).toBe("organize");
    const raws = server.tree.get(META)!.messages.map((m) => m.raw);
    expect(raws.filter((r) => r.includes("incumbent-install"))).toHaveLength(0);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ONE LOOP, AND THE CENSUS IS WHAT KEEPS IT ONE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The module's own header says the folder's three record kinds come off "the same headers FETCH in
 * one round trip". It said that while three separate `FETCH 1:*` loops stood in the file, each with
 * its own copy of the ceiling, the ordering and the empty-folder defence — and two of the three
 * bounded the read in the wrong direction. A comment is the claim under test, not evidence for it,
 * so this counts.
 */
describe("the census: ohmail/_meta is fetched in exactly one place", () => {
  it("organizer-lease.ts fetches ohmail/_meta at seven named sites and searches it at one, with no header", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/adapters/organizer-lease.ts", import.meta.url)),
      "utf8",
    );
    // Comments talk ABOUT the call, so only lines that are not comments count.
    const calls = src
      .split("\n")
      .filter((line) => !/^\s*(\*|\/\/)/.test(line))
      .filter((line) => line.includes("client.fetch("));

    /* FIVE, and each is a different question — the census keeps them COUNTABLE, and the temptation
     * when it goes red is to bump the number rather than ask what the new reader is.
     *
     *   · the WINDOW, this file's bounded newest-first read;
     *   · the CUSTODY read-back, because `messageDelete` resolves `true` after a refused STORE;
     *   · the FOLDER'S OWN BOTTOM, which tells compaction how deep the folder is;
     *   · the ACK SWEEP's uid window, read by FETCH on every provider;
     *   · the ENUMERATION (`enumerateMetaFolder`), the whole folder by one header FETCH proved
     *     complete by the count, which the settings listing and the lease past its window share;
     *   · the NEWEST RECORD's INTERNALDATE, the server's clock the sweep's cutoff is taken from;
     *   · OUR NEWEST CLAIM, which caps that cutoff so a future-dated record cannot reach it.
     * The count probe is a STATUS, asserted below. An EIGHTH is a new reader and should fail here. */
    expect(calls).toHaveLength(7);
    /* THREE STATUS SITES, each a different question of the same command: the shared count probe
     * (`MESSAGES`), the top of the uid space (`UIDNEXT`) the descending search walks down from,
     * and the permit's stamp (all three counters at once), which is the only one that asks while
     * ANOTHER folder is selected. All must come from the SERVER — the second exists precisely
     * because it used to be read off the connection's cached mailbox object, where a stale value
     * could send every window below the newest records and cost the mailbox its one-organizer
     * guarantee. A FOURTH is a new way of asking this server about this folder and fails here. */
    expect(src.match(/client\.status\(/g)?.length ?? 0,
      "the server is asked about this folder's counters from somewhere new").toBe(3);
    /* ONE search, compaction's uid enumeration, and it names no header: no lease decision and no
     * sweep rests on what a server's header SEARCH answers (L16). Read by one left-to-right pass,
     * so a search spelled inside a string or a comment is neither counted nor missed. */
    const code = withoutComments(src);
    // Any receiver and the optional-call form too: `client.search?.(` evaded a `client.search(` count.
    expect(code.match(/\.search\s*(\?\.)?\s*\(/g)?.length ?? 0,
      "the server is asked about this folder from somewhere new").toBe(1);
    const callers = [...code.matchAll(/searchDescending\(/g)]
      .filter((m) => !/function\s+$/.test(code.slice(Math.max(0, m.index! - 20), m.index)));
    expect(callers.length, "the one search has no caller, so the census reads nothing").toBeGreaterThan(0);
    for (const m of callers) {
      const at = m.index! + "searchDescending".length;
      const args = code.slice(at + 1, bracketSpan(code, at).end);
      expect(args, "a search asked a header term").toMatch(/\{\s*header:\s*\{\s*\}\s*\}/);
      expect(args.match(/header:/g)?.length, "a search carried a second header term").toBe(1);
    }
    for (const gone of ["searchHeaders", "listClaimRecords", "claimReadFact", "electionRead"]) {
      expect(code.includes(gone), `${gone} is back in the lease`).toBe(false);
    }
    // `start`, not `from`: the window fetch moved into a function so the shift check can run it a
    // SECOND TIME with a wider range. That is one call site issued twice, which is what this census
    // is about — the count below is still two, and a third `client.fetch(` anywhere in the module
    // still fails here.
    /* The window fetch takes a computed RANGE now, because the same call site serves the newest
     * window and a page below a cursor. What the census pins is that the call is still there and
     * that the unbounded form is still the newest-first `start:*` — the range moved into a
     * variable, the guarantee did not. */
    expect(calls.some((l) => l.includes("client.fetch(range,"))).toBe(true);

    /* ── EVERY FETCH THAT BUILDS A RECORD ASKS FOR THE SERVER'S CLOCK ───────────────────────
     *
     * INTERNALDATE is not a header: it has to be ASKED FOR and carried beside the raw, and the
     * decision layer ages and ranks by it. MEASURED: the header-SEARCH path (gone since FIX-026)
     * dropped it, so the full-folder election, the peek and a release carried no stamp. Per CALL:
     * a fetch asking `headers` builds a record and must ask `internalDate`; the uid-only probe need
     * not. Read over the call's own text (400 characters), since the query may span lines. */
    for (let at = src.indexOf("client.fetch("); at !== -1; at = src.indexOf("client.fetch(", at + 1)) {
      const call = src.slice(at, at + 400);
      const query = call.slice(0, call.indexOf("}") + 1);
      if (!query.includes("headers:")) continue;
      expect(query, "a fetch that builds a record does not ask for the server's clock")
        .toContain("internalDate: true");
    }
    expect(src.includes("`${start}:*`"),
      "the unbounded window no longer runs from `start` to the end of the folder").toBe(true);
  });
});

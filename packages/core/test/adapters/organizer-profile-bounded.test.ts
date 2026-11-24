import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import { memoryImapServer, type MemoryImapServer } from "./_metaworld.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { META_ENUM_RECORDS_MAX } from "../../src/adapters/organizer-lease.js";
import {
  PROFILE_BYTES_MAX_PER_FETCH,
  PROFILE_MESSAGES_MAX_PER_FETCH,
  PROFILE_VERSION,
  makeProfileIo,
  writeOrganizerProfile,
} from "../../src/adapters/organizer-profile.js";

/** The io seams refuse a memory they cannot attribute, so every fixture states one. */
const TEST_META_ID = { installId: "test-install", mailboxId: "test-mailbox" };

/* The meta memo is module-level: an own uid remembered by one case's server would be the positive
   control on the next case's fresh server, where the same uid is somebody else's message. */
beforeEach(() => { resetMetaMemos(); });

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE PROFILE READ OF `ohmail/_meta` IS BOUNDED ON BOTH AXES, AND ITS ZERO IS A KNOWN ZERO
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The lease's read of this folder was bounded first; this one was not, and it is the costlier of the
 * two. It asks for FULL SOURCES rather than headers, buffers them into an array, and runs on the
 * organizer's hot paths — once per attach for the hold, once per cycle for the routing question. So
 * whoever can append to the folder chose how much work every cycle did AND how much memory it took.
 * `PROFILE_DOC_MAX_BYTES` never bounded that: it bounds ONE DOCUMENT and is checked by the parser,
 * after the bytes are already in hand.
 *
 * Two ceilings, because they stop different attacks and an attacker picks the cheaper: the count
 * stops many small messages, the byte accumulator stops a few enormous ones.
 *
 * And newest-first is not a preference here either. The profile is a document the organizer
 * APPENDS, newest wins, so everything this read is about is at the END of the folder — a ceiling
 * that kept the oldest records would report "nobody has published settings" for a mailbox that has.
 */

const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");

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

/** A profile document, as the format layer writes one, padded to a chosen size. */
function profileDoc(marker: string, padBytes = 0): string {
  return [
    "X-Ohmail-Profile: 1",
    "X-Ohmail-Profile-Version: 1",
    `X-Ohmail-Install-Id: ${marker}`,
    "Subject: ohmail settings",
    "",
    `${marker}${"x".repeat(padBytes)}`,
    "",
  ].join("\r\n");
}

describe("mail 0094 — the REAL io stamps every message with the read's own generation", () => {
  /**
   * THE LOAD-BEARING HALF, and it needs the real io rather than a fake ProfileIo.
   *
   * `found.generation` is only worth having if it is the generation the uid was ISSUED under. What
   * makes that true is where the io takes it from: one `generationOf(client)` inside the same
   * `getMailboxLock` as the fetches. A generation asked for at the call site instead is the
   * manufactured pair — the caller's adapter selects other folders between calls, so a value read
   * afterwards may describe a different folder and one read before may be stale by the time the
   * uid is issued.
   *
   * A fake `ProfileIo` cannot show any of that, because it supplies the field directly. These
   * drive `makeProfileIo` over the memory server, which has a real `mailbox.uidValidity` getter
   * and a real renumber.
   */
  it("every message carries the folder's uidValidity, from the connection", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("install-a"));
    const before = (server.mailbox as { uidValidity?: number } | false);
    void before;   // the folder is not selected yet; the io selects it under its own lock

    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();
    expect(out.length).toBeGreaterThan(0);

    /* THE SERVER'S OWN VALUE, not a constant and not null. Read AFTER the io's lock released, so
       this is the assertion that the io looked while it held the folder. */
    server.resolve(META);
    const live = server.mailbox as { uidValidity?: number } | false;
    const expected = live === false ? null : live.uidValidity ?? null;
    for (const m of out) {
      expect(m.generation, "a message came back without the folder's generation").toBe(expected);
    }
  });

  it("after a RENUMBER a fresh read reports the NEW generation, and it is not the old one", async () => {
    /* The whole point of the pair. A renumber re-issues uid 1, so a uid remembered under the old
       epoch now names a different message — and the only thing that can tell the two apart is the
       generation travelling WITH it. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("before-the-renumber"));
    const first = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();
    const firstGen = first[0]!.generation;
    expect(firstGen, "the first read carried no generation").not.toBeNull();

    server.renumber(META);
    server.seed(META, profileDoc("after-the-renumber"));
    const second = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();
    const secondGen = second[0]!.generation;

    expect(secondGen, "a read after the renumber reported the OLD generation").not.toBe(firstGen);
    /* AND THE UIDS COLLIDE, which is what makes the generation load-bearing rather than
       decorative: the same small number names a different document in each epoch. */
    expect(second[0]!.ref).toBe(first[0]!.ref);
    expect(String(second[0]!.raw)).toContain("after-the-renumber");
    expect(String(first[0]!.raw)).toContain("before-the-renumber");
  });

  it("one call reports ONE generation across every message it returns", async () => {
    // One SELECT, one folder, one epoch. A set that disagreed would be evidence the io was
    // manufacturing the pair, and `readOrganizerProfile` refuses such a set outright.
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < 5; i++) server.seed(META, profileDoc(`install-${i}`));
    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();
    expect(out.length).toBeGreaterThan(1);
    expect(new Set(out.map((m) => m.generation)).size,
      "messages from one call disagreed about the folder's generation").toBe(1);
  });
});

describe("the profile read is bounded, and reads the newest", () => {
  /**
   * THE COUNT AXIS, ON THE KNOWN-COUNT PATH. The range already starts in the right place here, so
   * this pins the arithmetic rather than the eviction.
   */
  it("returns the NEWEST document when the folder is past the count ceiling", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < PROFILE_MESSAGES_MAX_PER_FETCH + 50; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }
    server.seed(META, profileDoc("current-install"));

    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();

    expect(out.length).toBeLessThanOrEqual(PROFILE_MESSAGES_MAX_PER_FETCH);
    expect(out.at(-1)!.raw).toContain("current-install");
  });

  /**
   * A FLOOD OF NON-PROFILE MESSAGES MUST NOT EVICT THE DOCUMENT — AND THE WRITE IS WHY.
   *
   * Both ceilings used to be spent on every message the range delivered, and `ohmail/_meta` is a
   * folder that also holds the lease's claims and whatever anyone with APPEND rights puts there. So
   * a window's worth of later messages evicted the current document from the list.
   *
   * That is not merely a read returning nothing. `writeOrganizerProfile` builds its `newer` and
   * `foreign` refusals from this same list, and the `newer` refusal is the entire reason a build
   * that cannot represent a v2 document will not overwrite one. Evict the v2 and the refusal never
   * fires: an older organizer appends v1 over settings it never saw, and every later read agrees
   * the rollback is current. Silent, durable, in the customer's own mailbox.
   *
   * MUTATION WATCHED RED: move the `looksLikeProfile` test back below the ceilings — i.e. retain
   * every message again — and the v2 document is gone from the list and the write proceeds.
   */
  it("keeps a NEWER document behind a flood of non-profile messages, so the write still refuses", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    // A document this build cannot represent, written by a later ohmail…
    const v2 = [
      "X-Ohmail-Profile: 1",
      `X-Ohmail-Profile-Version: ${PROFILE_VERSION + 1}`,
      "X-Ohmail-Install-Id: a-later-build",
      "Subject: ohmail settings",
      "",
      "ohmail settings for this mailbox.",
      JSON.stringify({ v: PROFILE_VERSION + 1, updatedAt: "2026-09-04T00:00:00.000Z", screener: [], rules: [] }),
      "",
    ].join("\r\n");
    server.seed(META, v2);
    // …buried under more than a ceiling's worth of messages that are not profiles at all.
    for (let i = 0; i < PROFILE_MESSAGES_MAX_PER_FETCH + 50; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }

    const io = makeProfileIo(server, toServerPath, TEST_META_ID);

    /* ── THE READ REACHES IT TOO NOW, AND THIS LINE USED TO ASSERT THE DEFECT ────────────────
     *
     * It read `toHaveLength(0)` and called that legitimate: the read was windowed, so a document
     * this far back was simply out of range. That is exactly the fault a later round named. The
     * READ is what `armHoldFromFolder` and `importHoldNow` consult when an install takes
     * a mailbox over, so "legitimately does not reach it" means the incoming organizer starts
     * routing somebody's mail by local defaults while their published settings sit in the folder,
     * unread. No error and no refusal -- the write's complete scan objects later, long after the
     * mail has been filed.
     *
     * A window was never the right instrument for the question. Only settings records carry the
     * discriminator, so the server can be asked for them by header and answers regardless of
     * position, and the ceilings then apply to settings records rather than to whatever else
     * shares the folder. The assertion is INVERTED rather than deleted, because the case it
     * describes is still the one worth testing: a flood must not hide the current document from
     * any reader.
     */
    const forRead = await io.listProfileMessages();
    expect(forRead, "a buried settings document was invisible to the read that routes mail")
      .toHaveLength(1);
    expect(forRead[0]!.raw).toContain("a-later-build");
    // THE WRITE'S list is complete, because its refusals are made from it.
    const forWrite = await io.listProfileMessages({ complete: true });
    expect(forWrite.some((m) => m.raw.includes("a-later-build"))).toBe(true);
    // And the ceilings now describe profile records, so the flood costs transfer and nothing else.
    expect(forWrite).toHaveLength(1);
  });

  /**
   * AND THE REFUSAL ITSELF, END TO END — the assertion the case above only sets up.
   *
   * This is the one that matters: not "the list contains the document" but "the write DID NOT
   * happen". A v2 document buried under a flood, and a v1 build that must leave it alone.
   */
  it("REFUSES to overwrite a newer document buried under a flood", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, [
      "X-Ohmail-Profile: 1",
      `X-Ohmail-Profile-Version: ${PROFILE_VERSION + 1}`,
      "X-Ohmail-Install-Id: a-later-build",
      "Subject: ohmail settings",
      "",
      "ohmail settings for this mailbox.",
      JSON.stringify({ v: PROFILE_VERSION + 1, updatedAt: "2026-09-04T00:00:00.000Z", screener: [], rules: [] }),
      "",
    ].join("\r\n"));
    for (let i = 0; i < PROFILE_MESSAGES_MAX_PER_FETCH + 50; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }
    const before = server.log.filter((l) => l.startsWith(`append ${META}`)).length;

    const result = await writeOrganizerProfile({
      io: makeProfileIo(server, toServerPath, TEST_META_ID),
      doc: {
        v: 1,
        updatedAt: "2026-09-04T12:00:00.000Z",
        producer: { kind: "cloud", version: "test" },
        screener: [],
        rules: [],
        notifyRules: [],
        awayResponder: null,
        tagNames: [],
      } as never,
      installId: "this-build",
    });

    expect(result.written).toBe(false);
    expect(result).toMatchObject({ reason: "newer", v: PROFILE_VERSION + 1 });
    // The refusal is only real if nothing was appended.
    expect(server.log.filter((l) => l.startsWith(`append ${META}`)).length).toBe(before);
  });

  /**
   * A COMPLETE SCAN THAT CANNOT RETAIN EVERYTHING REFUSES — IT DOES NOT RETURN THE SHORT LIST.
   *
   * Reading the whole folder fixed the RANGE. The ceilings are the other half: they still evict,
   * and on the complete path eviction is the same defect wearing the fix's clothes. Enough
   * profile-LOOKING records — the discriminator header is all it takes to make one — and the
   * protected document is dropped from the very list the refusal is computed from, so the write
   * proceeds and appends over it.
   *
   * A caller that must not be wrong is handed an ERROR rather than a short list. What the write
   * does with "I could not see all of it" is refuse, and a refusal it can act on is worth more than
   * a plausible answer it cannot check. The READ keeps evicting, because there the newest document
   * is the answer — asserted below so the two paths cannot quietly converge.
   *
   * MUTATION WATCHED RED: drop the `if (complete) throw` and the write appends over the v2.
   */
  it("a NEWER document under a flood of profile-looking records is seen by its header, and nothing is written", async () => {
    /* FIX-026: the version header is read off every settings message's header block, so a flood
       cannot push a newer format out of view, and no body is fetched once one is seen. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, [
      "X-Ohmail-Profile: 1",
      `X-Ohmail-Profile-Version: ${PROFILE_VERSION + 1}`,
      "X-Ohmail-Install-Id: a-later-build",
      "Subject: ohmail settings",
      "",
      "ohmail settings for this mailbox.",
      JSON.stringify({ v: PROFILE_VERSION + 1, updatedAt: "2026-09-04T00:00:00.000Z", screener: [], rules: [] }),
      "",
    ].join("\r\n"));
    for (let i = 0; i < PROFILE_MESSAGES_MAX_PER_FETCH + 50; i++) {
      server.seed(META, profileDoc(`filler-${i}`));
    }
    const io = makeProfileIo(server, toServerPath, TEST_META_ID);

    const read = await io.listProfileMessages();
    expect(read).toHaveLength(PROFILE_MESSAGES_MAX_PER_FETCH + 51);
    expect(read.every((m) => m.headerOnly === true), "a body was fetched beside a newer document").toBe(true);

    const before = server.log.filter((l) => l.startsWith(`append ${META}`)).length;
    await expect(writeOrganizerProfile({
      io,
      doc: {
        v: 1,
        updatedAt: "2026-09-04T12:00:00.000Z",
        producer: { kind: "cloud", version: "test" },
        screener: [],
        rules: [],
        notifyRules: [],
        awayResponder: null,
        tagNames: [],
      } as never,
      installId: "this-build",
    })).resolves.toEqual({ written: false, reason: "newer", v: PROFILE_VERSION + 1 });
    expect(server.log.filter((l) => l.startsWith(`append ${META}`)).length).toBe(before);
  });

  it("a flood of undated settings-looking records past the body ceiling refuses by name", async () => {
    /* No ohmail writer produces it: every copy carries a Date. Read by body because the header
       cannot date it, and refused past the ceiling rather than decided from part of it (K5). */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < PROFILE_MESSAGES_MAX_PER_FETCH + 50; i++) server.seed(META, profileDoc(`filler-${i}`));
    const io = makeProfileIo(server, toServerPath, TEST_META_ID);

    await expect(io.listProfileMessages({ complete: true }))
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_group_too_large" });
    await expect(io.listProfileMessages())
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_group_too_large" });
  });

  /**
   * THE BYTE AXIS, AND THIS IS THE ONE THAT MATTERED.
   *
   * The count ceiling cannot reach the inversion on the known-count path — the range already starts
   * where it should. The BYTE ceiling can, and cheaply: ONE large append EARLY in the window and a
   * read that stopped on the ceiling would return everything except the current document, reporting
   * "no settings have been published" for a mailbox that has some. One oversize older message is
   * the whole attack.
   *
   * MUTATION WATCHED RED: replace the front-eviction with a `break` on the byte ceiling and the
   * current document is not in what comes back.
   */
  it("keeps the NEWEST document past one oversize OLDER message", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    // One message alone past the byte ceiling, appended FIRST…
    server.seed(META, profileDoc("ancient-and-enormous", PROFILE_BYTES_MAX_PER_FETCH + 1024));
    // …then the document that actually matters.
    server.seed(META, profileDoc("current-install"));

    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();

    // THE ASSERTION THIS CASE EXISTS FOR.
    expect(out.at(-1)!.raw).toContain("current-install");
    // …and the enormous one was evicted rather than kept.
    expect(out.some((m) => m.raw.includes("ancient-and-enormous"))).toBe(false);
  });

  /**
   * AND A LONE OVERSIZE MESSAGE IS REFUSED — OUT LOUD, WHICH IS THE HALF THAT MATTERED.
   *
   * This asserted that such a record was RETURNED, on the reasoning that refusing it SILENTLY
   * would be the "no settings published" lie by another route, and that an unreadably large
   * document is the parser's refusal to make rather than this read's. The word carrying that
   * argument is SILENTLY.
   *
   * Returning it is no longer available. The document is deliberately never transferred whole —
   * that is what the byte range is for, and the alternative is the unbounded transfer this read
   * exists to prevent — so there is nothing to hand a parser. What must not follow is an empty
   * list, because every caller reads that as "nobody has published settings" and routes a
   * person's mail by local defaults. The read REFUSES instead, which is the loud form of the same
   * honesty and reaches the same surface an unreadable lease does.
   *
   * A skip is still right where there is something else to answer with — the case above passes
   * over an old enormous document and returns the current one. Only a skip that would leave the
   * read with NOTHING becomes a refusal.
   */
  it("refuses a lone oversize message rather than answering with nothing", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("enormous-and-only", PROFILE_BYTES_MAX_PER_FETCH + 1024));

    await expect(makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages(),
      "a read that could not transfer the only document answered as though there were none")
      .rejects.toThrow(/larger than the .* budget/);
  });

  /** A folder inside both ceilings reads exactly as it always did. */
  it("reads a small folder whole", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("only-install"));

    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();
    expect(out).toHaveLength(1);
    expect(out[0]!.raw).toContain("only-install");
  });

  /** An empty folder is still a real answer, and `1:*` is never sent against one. */
  it("a positively known zero skips the fetch", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();

    expect(out).toEqual([]);
    expect(server.log.filter((l) => l.startsWith(`fetch ${META}`))).toEqual([]);
  });

  /**
   * ── A CACHED ZERO IS NOT A KNOWN ZERO, AND THIS READ WAS THE ONE THAT STILL BELIEVED IT ────
   *
   * `client.mailbox.exists` is a CACHE a connection updates only from untagged responses, and
   * taking the folder lock does not refresh it when that folder is already selected. Three reads in
   * the lease were corrected for this; this was the fourth and was missed. A stale zero here reads
   * as "nobody has published settings for this mailbox" — which is a routing answer, not a missing
   * one.
   *
   * MUTATION WATCHED RED: remove the NOOP and this returns `[]` for a folder holding a document.
   */
  /**
   * A CACHED ZERO IS CONFIRMED BY THE SERVER, NOT BY A NOOP.
   *
   * This case used to assert that a NOOP was issued before a cached zero was trusted, on the
   * premise that a NOOP proves the cache is current. It does not, and could not: the library
   * discards the command's result (`async noop() { await this.run('NOOP'); }`), so a REFUSED noop
   * resolves exactly like an accepted one. The old assertion pinned a ceremony, not a guarantee.
   *
   * What must hold is that a stale zero cannot end the read: another connection appended the
   * settings document after this one cached `exists = 0`, and the read must still find it.
   *
   * MUTATION WATCHED RED: trust the cached zero (return early on `cached === 0` before asking) and
   * the document is not found.
   */
  it("a cached zero does not end the read when the server says otherwise", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], staleExists: true });
    server.seed(META, profileDoc("arrived-later"));
    // The connection's cache from before that append, and a NOOP that RESOLVES while refusing —
    // which is what the real client does, and why nothing may rest on it.
    const stale = {
      ...server,
      mailbox: { exists: 0 },
      async noop(): Promise<unknown> { return undefined; },
    };

    const out = await makeProfileIo(stale, toServerPath, TEST_META_ID).listProfileMessages();

    expect(out).toHaveLength(1);
    expect(out[0]!.raw).toContain("arrived-later");
  });

  /**
   * ONE OVERSIZED DOCUMENT IS NOT AN EXEMPTION ON A COMPLETE SCAN.
   *
   * The byte ceiling keeps the newest record even when it ALONE exceeds the limit, so that a
   * document too large to read is the PARSER's refusal to make rather than a silent absence. That
   * exemption is right for a READ and a hole on a COMPLETE scan, because the write path parses this
   * list directly — `writeOrganizerProfile` calls `parseProfileMessage` without the reader's
   * per-document guard in front of it. So a single profile-shaped message larger than the aggregate
   * ceiling becomes an unbounded parse on the settings-WRITE path, from a folder anyone with append
   * rights can write to.
   *
   * MUTATION WATCHED RED: restore `win.length > 1` alone and the complete scan returns it.
   */
  it("a complete scan refuses a single document over the byte ceiling", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    /* A ceiling small enough to HOLD. Against the real 128 MiB constant this case cannot be run at
     * all: the document alone exhausts what the runner can serialise, and the first attempt died
     * with `RangeError: Invalid array length` inside vitest's IPC — a red that proves nothing,
     * which is the exact shape this lane exists to remove. The injected ceiling is the seam that
     * makes the bound observable; the census below pins that no product caller uses it. */
    const CEILING = 4096;
    server.seed(META, profileDoc("enormous", CEILING + 1024));
    const io = makeProfileIo(server, toServerPath, TEST_META_ID, { maxBytes: CEILING });

    /* The READ refuses too, for the reason the case below gives: the document is never
     * transferred whole, so answering WITH it is not available and answering with NOTHING would
     * say no settings have been published. */
    await expect(io.listProfileMessages()).rejects.toThrow(/larger than the .* budget/);
    /* The COMPLETE scan refuses too, and the REASON it gives changed on purpose. It used to come
     * from the size prefilter — reported sizes added up, refused before a byte was fetched — and
     * that handed the decision to the server: one answering in gigabytes for tiny records could
     * refuse a perfectly readable folder, which is a person's settings write failing on a number
     * nobody checked. Sizes only order the work now, and every refusal is decided by bytes that
     * actually arrived through the ranged fetch, so the message names the record and the budget. */
    await expect(io.listProfileMessages({ complete: true }))
      .rejects.toThrow(/larger than the .* budget/);
  });

  /**
   * ── AND IT IS UNTRUSTED IN THE OTHER DIRECTION TOO ─────────────────────────────────────────
   *
   * The case below covers a server that UNDER-reports to get an oversized message through. This
   * is the same number abused the other way: a server that OVER-reports refuses a folder which is
   * perfectly readable.
   *
   * The prefilter used to add reported sizes up and refuse a complete scan before a single byte
   * was fetched, which handed that decision to the server. A settings write that refuses is a
   * person's rules not applying, so believing a hostile number here costs the same order as
   * believing it the other way — and a number cannot be authority in one direction while being a
   * lie in the other.
   *
   * Sizes order the work now; every refusal is decided by bytes that actually arrived.
   *
   * MUTATION WATCHED RED: restore the size-authoritative prefilter and this refuses a folder whose
   * documents all fit.
   */
  /**
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *  A READ THAT COULD NOT ASK REFUSES; IT DOES NOT ANSWER A DIFFERENT QUESTION
   * ══════════════════════════════════════════════════════════════════════════════════════════
   *
   * Six cases used to live here, and every one of them exercised a fallback that read the folder
   * by sequence range when no header search was available. They were removed with it, and the
   * reason is worth writing down because "the tests went green after the code was deleted" is
   * the shape of a fix that isn't one.
   *
   * The fallback answered a FAILED ASK. A refused search, a server with no SEARCH, no usable
   * UIDNEXT, or a walk that ran out of window budget all produced the same empty-handed value an
   * empty folder produces, and the caller responded by enumerating the whole folder with
   * `UID FETCH 1:*` and keeping whatever survived two ceilings. For a valid document sitting
   * below a flood of ordinary mail that is an EMPTY result — and empty is exactly what a mailbox
   * that never published settings returns, so the effective profile lapsed with nothing logged.
   *
   * Each of the six guarded a hazard of that path — counting back from an unconfirmed total, a
   * sequence window sliding under an expunge, sources discarded before the discriminator could
   * see them. Two said so in their own comments: the discarded-source shape "only arises on the
   * path that has no SEARCH", and the expunge race needed "the fallback path, which addresses
   * messages individually". With the fallback gone the hazards are gone with it — the surviving
   * path names records by uid, and a uid does not move when the folder does.
   *
   * What replaces them is the contract that took its place, including the exact inverse of the
   * old `1:*` assertion.
   */
  it("a connection that cannot SEARCH reads the buried document, because the listing never asks one", async () => {
    /* FIX-026's inverse of the old refusal: settings are found by ONE header FETCH checked against
       STATUS, so a server without SEARCH, or whose SEARCH is blind, loses nothing. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < PROFILE_MESSAGES_MAX_PER_FETCH + 50; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }
    server.seed(META, profileDoc("current-install"));
    const unsearchable = { ...server, get mailbox() { return server.mailbox; }, search: undefined };

    const out = await makeProfileIo(unsearchable, toServerPath, TEST_META_ID).listProfileMessages();

    expect(out.map((m) => m.raw).join("\n")).toContain("current-install");
    expect(fetchRanges(server).filter((r) => r === "1:*"), "not one whole-folder header FETCH").toHaveLength(1);
    expect(server.log.filter((l) => l.startsWith("search ")), "the listing asked SEARCH").toEqual([]);
  });

  /**
   * ── DEPTH MUST NOT MAKE A MAILBOX\'S SETTINGS DISAPPEAR ────────────────────────────────────
   *
   * The settings walk covers a fixed distance below the top of the uid space, and removing the
   * unbounded fallback — correctly, because it could answer with nothing for a folder that plainly
   * holds a document — left depth as a way to lose the document outright. Months of appends and
   * expunges put the records further down than the walk reaches, every window comes back empty,
   * and the read refuses for ever: the rules a person set simply stop applying.
   *
   * The anchor is the uid the server reported when this install wrote the document. The walk still
   * starts at the TOP, because a document written after ours has a higher uid and starting at ours
   * would answer with a stale one; the anchor only says how far down the covered stretch has to
   * reach.
   *
   * MUTATION WATCHED RED: remove the gap read below the walk and a document this deep is
   * unavailable again.
   */
  it("our own document is the positive control, found at any depth by the uid the server gave it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.tree.get(META)!.nextUid = 12_000;
    const io = makeProfileIo(server, toServerPath, TEST_META_ID);
    // Written through the io, so the uid the server reports is the remembered one.
    await io.appendProfile(profileDoc("current-install"));

    const out = await io.listProfileMessages();

    expect(out.at(-1)?.raw, "a settings document deep in the uid space became unreadable")
      .toContain("current-install");
    expect(out.at(-1)?.ref).toBe(12_000);
  });

  it("the ordinary read still admits — the refusal is not the read refusing everything", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < 20; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }
    server.seed(META, profileDoc("current-install"));

    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();

    expect(out.at(-1)!.raw, "the ordinary profile read stopped returning the document").toContain("current-install");
  });

  it("an EMPTY folder is still an answer, and it is the only thing that reads as no profile", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < 20; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }

    const out = await makeProfileIo(server, toServerPath, TEST_META_ID).listProfileMessages();

    expect(out, "a folder with no profile record must answer, not refuse").toEqual([]);
  });

  it("reads a folder in full when every reported size is a lie ten times the budget", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const CEILING = 8192;
    // Three small documents — the real bytes fit inside the budget several times over.
    for (let i = 0; i < 3; i++) server.seed(META, profileDoc(`doc-${i}`, 256));

    const boastful = {
      ...server,
      fetch(
        range: string,
        query: { source?: boolean | { start?: number; maxLength?: number }; size?: boolean },
        options?: { uid?: boolean },
      ) {
        if (query.size === true) {
          return (async function* () {
            for await (const m of server.fetch(range, { uid: true }, options)) {
              yield { uid: m.uid, size: CEILING * 10 };
            }
          })();
        }
        return server.fetch(range, { ...query, size: false }, options);
      },
    };

    const out = await makeProfileIo(boastful, toServerPath, TEST_META_ID, { maxBytes: CEILING })
      .listProfileMessages({ complete: true });

    expect(out, "a readable folder was refused on the server's word about its size")
      .toHaveLength(3);
  });

  /**
   * ── THE SERVER'S SIZE CLAIM IS UNTRUSTED INPUT ─────────────────────────────────────────────
   *
   * Asking for `RFC822.SIZE` before asking for the message is a PREFILTER, not a bound. A server
   * that answers `1` is free to send ten megabytes when the source is asked for, and a read that
   * decides what to transfer from a number that same server supplied is trusting the thing it is
   * defending against. The previous version fetched every MEASURED record with `source: true` on
   * exactly that trust, so one dishonest number reopened the whole hole.
   *
   * Asserted on the COMMAND, because a reply cannot show what was asked for: the record is small
   * by its own account, and the fetch still carries a range.
   *
   * MUTATION WATCHED RED: fetch measured records with `source: true` again — the ten megabytes
   * arrive, the budget is blown by a message that claimed to be one byte, and no ranged command
   * is ever sent.
   */
  it("ranges the fetch even when the server SWEARS the record is tiny", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const CEILING = 4096;
    server.seed(META, profileDoc("liar", CEILING * 4));

    let delivered = 0;
    const lying = {
      ...server,
      fetch(
        range: string,
        query: { source?: boolean | { start?: number; maxLength?: number }; size?: boolean },
        options?: { uid?: boolean },
      ) {
        // "One byte, honestly."
        if (query.size === true) {
          return (async function* () {
            for await (const m of server.fetch(range, { uid: true }, options)) {
              yield { uid: m.uid, size: 1 };
            }
          })();
        }
        const inner = server.fetch(range, query, options);
        return (async function* () {
          for await (const m of inner) {
            if (m.source) delivered += m.source.byteLength;
            yield m;
          }
        })();
      },
    };

    await expect(makeProfileIo(lying, toServerPath, TEST_META_ID, { maxBytes: CEILING })
      .listProfileMessages({ complete: true }),
    "a record that lied about its size was transferred on that word")
      .rejects.toThrow(/larger than the .* budget/);

    expect(delivered,
      "more bytes crossed the connection than the budget, so the size claim was trusted")
      .toBeLessThanOrEqual(CEILING + 1);
    expect(server.log.filter((l) => /<0\.\d+>$/.test(l)).length,
      "no fetch carried a byte range, so nothing bounded the transfer").toBeGreaterThan(0);
  });

  /**
   * ── ONE BUDGET, SPENT ONCE — NOT HANDED TO EVERY RECORD IN TURN ────────────────────────────
   *
   * Each record was individually within the budget and the batch collectively was not: the range
   * was computed from a `held` that did not move until the whole batch had arrived, so every one of the
   * replies got the same nearly-full range and transferred many times what the ceiling
   * allowed. A per-message bound that shares one budget across an unbounded number of messages is
   * not a bound at all.
   *
   * Ten records of a quarter of the budget each: the ranges must SHRINK as the budget is spent,
   * and once it is gone the rest are refused rather than fetched.
   *
   * MUTATION WATCHED RED: charge the budget after the loop instead of after each reply, and every
   * range is the full budget again.
   */
  it("charges each reply to the budget before computing the next range", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const CEILING = 8192;
    for (let i = 0; i < 10; i++) server.seed(META, profileDoc(`doc-${i}`, CEILING / 4));

    const sizeless = {
      ...server,
      fetch(
        range: string,
        query: { source?: boolean | { start?: number; maxLength?: number }; size?: boolean },
        options?: { uid?: boolean },
      ) {
        if (query.size === true) return (async function* () { /* declines RFC822.SIZE */ })();
        return server.fetch(range, { ...query, size: false }, options);
      },
    };

    await makeProfileIo(sizeless, toServerPath, TEST_META_ID, { maxBytes: CEILING })
      .listProfileMessages()
      .catch(() => undefined);

    const caps = server.log
      .map((l) => /<0\.(\d+)>$/.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => Number(m[1]));

    expect(caps.length, "no ranged fetch was issued at all").toBeGreaterThan(2);
    expect(caps[caps.length - 1]! < caps[0]!,
      "every record was offered the same range, so one budget was spent many times over")
      .toBe(true);
    /* ── AND NO SINGLE RANGE EXCEEDS WHAT IS LEFT, WHICH IS THE INVARIANT THAT HOLDS ────────
     *
     * The first draft asserted a bound on the SUM of the ranges. That is a property this design
     * does not have and must not claim: the read EVICTS, and an eviction deliberately gives the
     * budget back, so a folder of many small documents legitimately transfers more in total than
     * the ceiling while never HOLDING more than it. Bounding the sum would fail an honest folder,
     * and it would have been an assertion about something untrue.
     *
     * What is true, and what the bound exists for: no ONE reply may exceed what remains, so no
     * single message can exhaust the process however the server describes it. */
    expect(Math.max(...caps), "a fetch offered a range larger than the whole budget")
      .toBeLessThanOrEqual(CEILING + 1);
  });

  /**
   * ── THE BOUND IS ON THE WIRE, NOT ON WHAT SURVIVES THE READ ────────────────────────────────
   *
   * The read asks for sizes before it asks for source, so a hostile literal is never sent. That
   * pass only works for a server that answers `RFC822.SIZE`, and a server may decline it.
   *
   * The previous version of this case asserted that such a document was REFUSED, and it passed
   * against a fix that fetched the whole thing and measured it afterwards. That bounds what is
   * RETAINED and nothing about what is TRANSFERRED: the message is already in memory by the time
   * the ceiling looks at it, which is the defect intact behind a green test. A later round said so
   * and was right.
   *
   * What tells the two apart is the COMMAND. An unmeasured record is asked for as
   * `BODY.PEEK[]<0.N>` — imapflow's `{ source: { start, maxLength } }`, read in its own
   * `lib/commands/fetch.js` rather than assumed — so the server sends at most N bytes whatever the
   * message weighs, and a reply that FILLS the range means the document did not fit.
   *
   * The double here answers the way a server does: no size, and NO SOURCE AT ALL unless the fetch
   * carried a range. A read that asks for the whole message therefore gets nothing back, which is
   * what makes the mutation below fail rather than quietly pass.
   *
   * MUTATION WATCHED RED: drop the byte range and ask for the whole source — the document is never
   * delivered, so the complete scan resolves instead of refusing.
   */
  it("asks for an unmeasured document with a BYTE RANGE, and refuses one that fills it", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const CEILING = 4096;
    server.seed(META, profileDoc("enormous", CEILING + 1024));

    /* A server that declines RFC822.SIZE and will not send a message except by byte range. Both
     * halves are things a real server does; together they are the only shape that can see whether
     * this read bounded the transfer or merely the retention. */
    const wire = {
      ...server,
      fetch(
        range: string,
        query: { source?: boolean | { start?: number; maxLength?: number }; size?: boolean },
        options?: { uid?: boolean },
      ) {
        if (query.size === true) return (async function* () { /* no RFC822.SIZE */ })();
        if (query.source === true) return (async function* () { /* whole-source asks get nothing */ })();
        return server.fetch(range, { ...query, size: false }, options);
      },
    };
    const io = makeProfileIo(wire, toServerPath, TEST_META_ID, { maxBytes: CEILING });

    await expect(io.listProfileMessages({ complete: true }),
      "a document the server would not size was read without any bound on what it could send")
      .rejects.toThrow(/larger than the .* budget/);

    // …and the bound was expressed ON THE WIRE: the command carried the range.
    const ranged = server.log.filter((l) => /^fetch .*<0\.\d+>$/.test(l));
    expect(ranged.length, "no fetch carried a byte range, so nothing bounded the transfer")
      .toBeGreaterThan(0);
  });

  /**
   * AND A CLEANUP THAT REMOVED NOTHING IS NOT A CLEANUP.
   *
   * `messageDelete` resolves `false` when the server refuses — it does not reject — and this
   * discarded the value entirely, so a refused cleanup was reported as a completed one. A `true` is
   * not proof either: the STORE that marks `\Deleted` is internal to the library and its result is
   * not propagated, so a refused STORE with an accepted EXPUNGE removes nothing and still resolves
   * `true`.
   *
   * Left alone this accumulates: every superseded document stays, and once the complete scan's
   * ceiling is crossed every later settings write refuses.
   *
   * MUTATION WATCHED RED: ignore the result and skip the custody read, and this passes.
   */
  it("a settings cleanup that resolves true while removing nothing is a failure", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const ref = server.seed(META, profileDoc("old"));
    const io = makeProfileIo({
      ...server,
      async messageDelete(): Promise<boolean> { return true; },
    }, toServerPath, TEST_META_ID);

    await expect(io.removeProfiles([ref]),
      "a settings message that survived its own expunge was reported as removed")
      .rejects.toThrow(/survived/);
  });


  /**
   * AND THE SEAM STAYS A TEST SEAM.
   *
   * `makeProfileIo`'s ceiling parameter exists so the byte bound can be watched rejecting at a size
   * a test can hold. That is worth having and worth fencing: a product caller passing its own
   * ceiling would be a bound set from somewhere this file cannot see, which is how a limit stops
   * meaning anything.
   */
  it("no product code passes its own byte ceiling", () => {
    const roots = ["packages/core/src", "packages/services/src", "apps/worker/src", "packages/organizer/src", "apps/sidecar/src"];
    const hits: string[] = [];
    let scanned = 0;
    for (const root of roots) {
      const dir = fileURLToPath(new URL(`../../../../${root}`, import.meta.url));
      const walk = (d: string): void => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, e.name);
          if (e.isDirectory()) { walk(full); continue; }
          if (!e.name.endsWith(".ts")) continue;
          // The file that DECLARES the parameter is not a caller of it. Excluded by name rather
          // than by a cleverer pattern, because the declaration and a call read almost alike and
          // the pattern that tells them apart is the one that stops telling them apart later.
          if (e.name === "organizer-profile.ts") continue;
          scanned += 1;
          // NOT `[^)]*`: that stops at the first `)`, which an arrow argument supplies before the
          // option object is reached — the first version of this scanner passed with a planted
          // violation in front of it. Bounded by the STATEMENT instead, so nested parens are
          // crossed and neighbouring statements are not.
          if (/makeProfileIo\((?:[^;]){0,400}?maxBytes/s.test(readFileSync(full, "utf8"))) hits.push(full);
        }
      };
      walk(dir);
    }
    // A scanner that found no files reports no violations, which is the same silence it exists to
    // break. The count is the guard on the guard.
    expect(scanned, "the scanner walked nothing — the roots do not resolve from here")
      .toBeGreaterThan(50);
    expect(hits, "a product caller sets its own settings byte ceiling").toEqual([]);
  });

});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A READER READS THE ORGANIZER'S DOCUMENT OUT OF A DEEP `ohmail/_meta`
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `ohmail/_meta` holds the lease's claims as well as the settings document, and a claim is
 * APPENDED per organizer heartbeat and expunged later — so the folder stays small while its uid
 * space climbs for ever, because uids are never reused. Past `20 × 500` uids the descending walk
 * spent its whole budget without reaching uid 1, and the gap walk beneath it was gated on a memo
 * only a WRITE leaves behind. A reader has never written one, so the read refused every time,
 * holding the document it had just found.
 *
 * Measured on a reader install, 2026-09-10: `profile_mirror_read_failed` 47 times over nine
 * hours, 37 of them bracketed by two successful drains (so not the connection), and a message
 * parked on the organizer never reached the reader's pile.
 *
 * The folder is modelled the way the server leaves it — few messages, a high `UIDNEXT` — rather
 * than by seeding a deep pile of records, which would measure the fake's search loop instead.
 */
describe("a deep uid space does not hide the document a walk already found", () => {
  /**
   * A FRESH IDENTITY PER CASE, because the meta memory is a MODULE-LEVEL store keyed by identity
   * and the cases above this one write into it through `appendProfile`. Reusing the shared id
   * handed a reader an anchor no reader can have, and three of these cases passed on it before
   * the fix — a fixture answering the question with the other mechanism.
   */
  let readers = 0;
  const readerId = (): { installId: string; mailboxId: string } => {
    readers += 1;
    return { installId: `reader-${readers}`, mailboxId: `deep-mailbox-${readers}` };
  };

  /** The live shape: the uid space has moved on past the walk's budget, the folder has not. */
  function deepMeta(server: MemoryImapServer, path: string, nextUid: number): void {
    const folder = server.tree.get(path);
    if (folder === undefined) throw new Error(`the fixture has no ${path}`);
    folder.nextUid = nextUid;
  }

  it("a READER with no memo reads a document sitting near the top of a deep uid space", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    // 11_900 > 20 × 500, so the walk cannot reach uid 1 — and window ONE covers the document.
    deepMeta(server, META, 11_900);
    // SEEDED, not appended through the io: a reader never writes, so it never has the memo whose
    // absence was the whole defect.
    server.seed(META, profileDoc("organizer-install"));

    const out = await makeProfileIo(server, toServerPath, readerId()).listProfileMessages();

    expect(out.at(-1)?.raw,
      "a reader's read of a deep folder refused while holding the document it had found")
      .toContain("organizer-install");
  });

  it("the same read on a SLASH-delimited server, so the answer is not the delimiter's", async () => {
    const server = memoryImapServer({ prefix: "", delimiter: "/", folders: ["ohmail", "ohmail/_meta"] });
    deepMeta(server, "ohmail/_meta", 11_900);
    server.seed("ohmail/_meta", profileDoc("organizer-install"));

    const out = await makeProfileIo(server, (c) => c, readerId()).listProfileMessages();

    expect(out.at(-1)?.raw, "the slash-delimited reader read refused").toContain("organizer-install");
  });

  it("a document BELOW one walk is still reached, without a memo", async () => {
    // The gap walk's own case for a reader: `bottomFor()` answers uid 1 when there is no memo,
    // and that branch was unreachable while the arm also required an anchor.
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("organizer-install"));
    deepMeta(server, META, 11_900);

    const out = await makeProfileIo(server, toServerPath, readerId()).listProfileMessages();

    expect(out.at(-1)?.raw, "a document under the first budget was unreachable for a reader")
      .toContain("organizer-install");
  });

  it("a folder above the listing's ceiling REFUSES by name before a byte is fetched", async () => {
    /* THE HONESTY CONTROL for the enumeration: past META_ENUM_RECORDS_MAX messages, the one
       ceiling the settings and the lease share, the answer is a named refusal, never an absence. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i <= META_ENUM_RECORDS_MAX; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }

    await expect(makeProfileIo(server, toServerPath, readerId()).listProfileMessages())
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_meta_too_full" });
    expect(fetchRanges(server), "the folder was listed despite the count").toEqual([]);
  });

  it("the refusal names itself in the alphabet a log line can carry", async () => {
    /* `errorCode` is derived from the thrown value's `code` by `log.ts#describeError`, so a code
     * set on the error needs no call site to remember to extract it. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], fetchTruncatesAt: 1 });
    server.seed(META, profileDoc("organizer-install"));
    server.seed(META, profileDoc("organizer-install"));

    await expect(makeProfileIo(server, toServerPath, readerId()).listProfileMessages())
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_enum_incomplete" });
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  ABSENT IS AN ANSWER — A FOLDER THAT HOLDS NO DOCUMENT SAYS SO, AND THE WRITER MAY CREATE ONE
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on the 0.18.0 release candidate, and reproduced at 0.17.0: `ohmail/_meta` held three
 * lease claims and no settings document — a fixture reset had deleted the messages while the uid
 * space kept the weeks of heartbeats behind it. The person pressed Organize, the takeover was
 * authorized, and from that moment every write refused `profile_gap_too_deep` at
 * `op: list_profiles`: the reader could not reach uid 1 inside two budgets, answered "could not
 * ask", and the WRITER cannot create a first document while it cannot see whether one exists. Run
 * setup to the end wrote no settings; the row read Organized · Up to date; eight appended
 * messages stayed in INBOX for ever.
 *
 * The walk's honesty rule stands and is the reason this took a new answer rather than a relaxed
 * refusal: an empty window is not an absent document, because something may lie below. What is
 * new is that a COMPLETE search can prove absence — and completeness is affordable when the cost
 * is read off the MESSAGE COUNT rather than the uid range. A folder inside
 * `PROFILE_MESSAGES_MAX_PER_FETCH` is searched once over `1:*`; `profile_gap_too_deep` survives
 * for the folder that is deep AND populous, which is the only one no bounded read can settle.
 */
describe("a claims-only ohmail/_meta answers ABSENT rather than refusing for ever", () => {
  /** Fresh per case: the meta memo is module-level and keyed by identity. */
  let installs = 0;
  const freshId = (): { installId: string; mailboxId: string } => {
    installs += 1;
    return { installId: `absent-install-${installs}`, mailboxId: `absent-mailbox-${installs}` };
  };

  function deepMeta(server: MemoryImapServer, path: string, nextUid: number): void {
    const folder = server.tree.get(path);
    if (folder === undefined) throw new Error(`the fixture has no ${path}`);
    folder.nextUid = nextUid;
  }

  /** The measured folder: weeks of claims behind it, three left in it, no document. */
  function claimsOnlyDeepMeta(server: MemoryImapServer): void {
    for (let i = 0; i < 3; i++) {
      server.seed(META, `X-Ohmail-Lease: 1\r\nSubject: claim ${i}\r\n\r\nclaim`);
    }
    deepMeta(server, META, 50_000);
  }

  const searches = (server: MemoryImapServer): string[] =>
    server.log.filter((l) => l.startsWith(`search ${META} `));

  it("the read answers with no documents instead of refusing", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    claimsOnlyDeepMeta(server);

    const out = await makeProfileIo(server, toServerPath, freshId()).listProfileMessages();

    expect(out, "a folder holding no settings document reported a refusal instead of an absence")
      .toEqual([]);
  });

  it("and the WRITE that was refused for ever now creates the first document", async () => {
    /* The half the person feels. `writeOrganizerProfile` asks for the COMPLETE list first, and
     * the refusal there is what made Run setup write nothing on a mailbox it had just claimed. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    claimsOnlyDeepMeta(server);
    const io = makeProfileIo(server, toServerPath, freshId());

    const result = await writeOrganizerProfile({
      io,
      doc: {
        v: PROFILE_VERSION,
        updatedAt: "2026-09-13T12:00:00.000Z",
        producer: { kind: "desktop", version: "test" },
        screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [],
      } as never,
      installId: "this-build",
    });

    expect(result, "the first settings document could not be created on a claimed mailbox")
      .toMatchObject({ written: true });
    const back = await makeProfileIo(server, toServerPath, freshId()).listProfileMessages();
    expect(back.at(-1)?.raw, "the document was reported written and is not in the folder")
      .toContain("this-build");
  });

  it("absence is PROVED by one complete header FETCH checked against STATUS", async () => {
    /* One `1:*` header read, complete by the server's own count, and no SEARCH at all: a folder
       with a deep uid space costs what it holds. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    claimsOnlyDeepMeta(server);

    await makeProfileIo(server, toServerPath, freshId()).listProfileMessages();

    expect(server.log.filter((l) => l === `fetch ${META} 1:*`), "absence was answered without one whole-folder read")
      .toHaveLength(1);
    expect(searches(server)).toHaveLength(0);
  });

  it("a document below both budgets is FOUND by that search, never reported absent", async () => {
    /* THE POSITIVE CONTROL ON THE SEARCH ITSELF. Without it, an `absent` returned unconditionally
     * at the same point would pass every case above — and it would be the silent lapse this
     * module's whole honesty rule exists to prevent: a published document read as "nobody has
     * published settings", every later organizer routing by local defaults. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, profileDoc("organizer-install"));
    for (let i = 0; i < 3; i++) {
      server.seed(META, `X-Ohmail-Lease: 1\r\nSubject: claim ${i}\r\n\r\nclaim`);
    }
    deepMeta(server, META, 50_000);

    const out = await makeProfileIo(server, toServerPath, freshId()).listProfileMessages();

    expect(out.at(-1)?.raw, "a document the complete search should have found was read as absent")
      .toContain("organizer-install");
  });

  it("a folder that is deep AND populous is still read whole, inside the listing's ceiling", async () => {
    /* The walk refused this folder (`profile_gap_too_deep`); the enumeration lists it in one FETCH
       and proves the absence. The ceiling's own refusal is the case above. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    for (let i = 0; i < PROFILE_MESSAGES_MAX_PER_FETCH * 4; i++) {
      server.seed(META, `Subject: newsletter ${i}\r\n\r\nbody`);
    }
    deepMeta(server, META, 50_000);

    await expect(makeProfileIo(server, toServerPath, freshId()).listProfileMessages()).resolves.toEqual([]);
  });

  it("a server that cannot be asked for a count still refuses — absence is never inferred", async () => {
    /* The count is what makes the listing a proof. A server with no STATUS count leaves the read
       with nothing to prove completeness against, and that is a named refusal. */
    const countless = memoryImapServer({
      prefix: "INBOX.", folders: ["INBOX.ohmail", META], refuseMessagesCount: true,
    });
    claimsOnlyDeepMeta(countless);

    await expect(makeProfileIo(countless, toServerPath, freshId()).listProfileMessages())
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_no_count" });
  });

  it("an EMPTY deep folder is absent without any read at all", async () => {
    /* Zero messages end this read before the FETCH: `1:*` is not a valid range against an empty
       mailbox on the servers that refuse it, and there is nothing to find. */
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    deepMeta(server, META, 50_000);

    const out = await makeProfileIo(server, toServerPath, freshId()).listProfileMessages();

    expect(out).toEqual([]);
    expect(searches(server), "an empty folder was searched").toHaveLength(0);
    expect(fetchRanges(server), "an empty folder was fetched").toEqual([]);
  });
});

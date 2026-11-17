import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, mailboxProfileMirror } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import {
  DEFAULT_PROFILE_FLUSH_INTERVAL_MS, applyProfileRead, forgetMirrorCadence, syncProfileMirror,
  type MirrorOutcome,
} from "../src/profile.js";
import type { ProfileIo, ProfileReadResult } from "@trafficflow/core/adapters/organizer-profile";
import { ProfileUnavailableError, formatProfileMessage } from "@trafficflow/core/adapters/organizer-profile";
import { createLogger } from "@trafficflow/core/mail";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  `syncProfileMirror` — a remembered uid is a fact ONLY under its generation
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The reader caches the organizing install's published document so its settings panes can show
 * what is actually in force. The whole care in this module is the `(uidvalidity, uid)` pair:
 * a folder deleted and recreated numbers from one again, so a uid that survived a renumber points
 * confidently at the wrong message.
 *
 * ── THE DOUBLE IS THE READ RESULT, NOT THE IMAP CLIENT, AND THAT IS DELIBERATE ─────────────
 *
 * `readOrganizerProfile` takes the generation from inside the same lock as the fetch, so a `found`
 * arm's generation and ref are consistent BY CONSTRUCTION and a mixed-epoch set is refused
 * `unreadable` before it ever becomes `found`. Driving this function with a stubbed `ProfileIo`
 * would test that guarantee a second time rather than test THIS module; what this module has to get
 * right is what it does with each of the four answers. So the double supplies the answers.
 *
 * A double must fail the way production fails. The three non-`found` answers here are the real
 * union members, spelled as the engine spells them, and the read-throws case throws — because
 * `state: "unreadable"` and a thrown `ProfileUnavailableError` are DIFFERENT productions and this
 * module treats them the same way for different reasons.
 */

const DOC = {
  v: 1, updatedAt: "2026-09-07T10:00:00.000Z",
  producer: { kind: "cloud", version: "0.15.0" },
  screener: [], rules: [], notifyRules: [], tagNames: [],
  awayResponder: null, signature: "— Mila",
} as unknown as ProfileReadResult extends { doc: infer D } ? D : never;

const NOW = new Date("2026-09-07T11:00:00.000Z");

async function world() {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `pm-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `pm-${accountId.slice(0, 8)}@mirror.test`,
    organizerRole: "reader", organizerState: "held",
    organizedByKind: "cloud", organizedByName: "ohmail Cloud",
  }).returning();
  return { db, accountId, mailboxId: mb!.id };
}

type W = Awaited<ReturnType<typeof world>>;

async function row(w: W) {
  const [r] = await w.db.select().from(mailboxProfileMirror)
    .where(eq(mailboxProfileMirror.mailboxId, w.mailboxId));
  return r;
}

/** Seed a cached copy read under a named generation, so "discarded" is a positive fact. */
async function seedCached(w: W, generation: bigint, uid: number) {
  await w.db.insert(mailboxProfileMirror).values({
    mailboxId: w.mailboxId, accountId: w.accountId,
    uidvalidity: generation, uid, doc: DOC as unknown as object,
    readAt: new Date("2026-09-01T00:00:00.000Z"),
  });
}

const logs: Array<{ event: string; detail: Record<string, unknown> }> = [];
const log = (event: string, detail: Record<string, unknown>) => { logs.push({ event, detail }); };

/** One pass over an already-read answer — the decision logic, driven directly. */
async function pass(w: W, answer: ProfileReadResult): Promise<MirrorOutcome> {
  return applyProfileRead(
    { db: w.db as never, accountId: w.accountId, mailboxId: w.mailboxId, now: NOW, log },
    answer,
  );
}

/**
 * THE READ ENTRY, driven through a `ProfileIo` THAT FAILS THE WAY ONE FAILS.
 *
 * `readOrganizerProfile` reaches `listProfileMessages` first; a mailbox whose FETCH dies throws out
 * of exactly there. So the double throws from that method rather than being a stub that returns a
 * union member — a fixture returning `state: "unreadable"` would exercise a DIFFERENT branch and
 * would never enter this one.
 */
async function passThroughRead(w: W, thrown: Error): Promise<MirrorOutcome> {
  const io: ProfileIo = {
    ensureMetaFolder: async () => { throw thrown; },
    listProfileMessages: async () => { throw thrown; },
    appendProfile: async () => { throw new Error("a mirror read must never append"); },
    removeProfiles: async () => { throw new Error("a mirror read must never expunge"); },
  };
  return syncProfileMirror({
    db: w.db as never, accountId: w.accountId, mailboxId: w.mailboxId, io, now: NOW, log,
  });
}

describe("a found document is cached with the generation its uid was read under", () => {
  it("writes both columns together", async () => {
    const w = await world();
    logs.length = 0;
    const out = await pass(w, {
      state: "found", doc: DOC as never, installId: "cloud-1", ref: 42,
      generation: 1757000000, residue: 0,
    });
    expect(out).toEqual({ state: "written", generation: 1757000000, uid: 42 });
    const r = await row(w);
    expect(r).toMatchObject({ uid: 42, uidvalidity: 1757000000n });
    expect(r!.doc).toEqual(DOC);
    expect(r!.readAt.toISOString()).toBe(NOW.toISOString());
  });

  it("A ROW READ UNDER G IS NEVER LEFT STANDING ONCE THE FOLDER READS G+1", async () => {
    /* THE CONTROL THIS MODULE EXISTS FOR. The row is replaced WHOLE, so the two columns can never
     * disagree about which epoch they describe. A partial update — the shape a careless fix
     * reaches for — would leave the OLD generation beside the NEW uid, and that row would be
     * served as a current document by a locator addressing whatever now holds that small integer. */
    const w = await world();
    await seedCached(w, 1757000000n, 42);

    const out = await pass(w, {
      state: "found", doc: DOC as never, installId: "cloud-1", ref: 7,
      generation: 1757000001, residue: 0,
    });
    expect(out).toMatchObject({ state: "written" });

    const r = await row(w);
    // Both moved. Neither the old generation nor the old uid survives anywhere in the row.
    expect(r).toMatchObject({ uidvalidity: 1757000001n, uid: 7 });
    expect(r!.uidvalidity).not.toBe(1757000000n);
    expect(r!.uid).not.toBe(42);
  });

  it("a bigint generation is stored as itself — a server may report either type", async () => {
    const w = await world();
    const out = await pass(w, {
      state: "found", doc: DOC as never, installId: "c", ref: 9,
      generation: 9007199254740993n, residue: 0,
    });
    expect(out).toMatchObject({ state: "written" });
    expect((await row(w))!.uidvalidity).toBe(9007199254740993n);
  });
});

describe("a locator that is not usable is not remembered", () => {
  it("a NULL generation writes nothing and says why", async () => {
    /* `null` is "the server reported no epoch", never "any generation will do". Caching a uid
     * without its epoch is caching a number that means nothing. */
    const w = await world();
    logs.length = 0;
    const out = await pass(w, {
      state: "found", doc: DOC as never, installId: "c", ref: 42, generation: null, residue: 0,
    });
    expect(out).toEqual({ state: "skipped", reason: "no_generation" });
    expect(await row(w)).toBeUndefined();
    const said = logs.find((l) => l.event === "profile_mirror_skipped");
    expect(String(said!.detail.reason)).toContain("no folder generation");
  });

  it("a null generation does not disturb a cached copy either", async () => {
    // The skip is a skip, not a discard: an earlier good read stays usable.
    const w = await world();
    await seedCached(w, 500n, 3);
    const out = await pass(w, {
      state: "found", doc: DOC as never, installId: "c", ref: 42, generation: null, residue: 0,
    });
    expect(out).toMatchObject({ state: "skipped" });
    expect(await row(w)).toMatchObject({ uidvalidity: 500n, uid: 3 });
  });

  it("a document with no usable uid is skipped", async () => {
    const w = await world();
    const out = await pass(w, {
      state: "found", doc: DOC as never, installId: "c", ref: undefined,
      generation: 1757000000, residue: 0,
    });
    expect(out).toEqual({ state: "skipped", reason: "no_uid" });
    expect(await row(w)).toBeUndefined();
  });
});

describe("the four answers are not interchangeable", () => {
  it("NO DOCUMENT discards the cached copy — a locator addressing nothing is worse than none", async () => {
    /* Also the renumber case: after a UIDVALIDITY bump the old uid addresses whatever now holds
     * that small integer, so keeping it would serve a real document under a false locator. */
    const w = await world();
    await seedCached(w, 1757000000n, 42);
    logs.length = 0;

    const out = await pass(w, { state: "none" });
    expect(out).toEqual({ state: "discarded", reason: "no_document" });
    expect(await row(w)).toBeUndefined();
    expect(logs.some((l) => l.event === "profile_mirror_discarded")).toBe(true);
  });

  it("UNREADABLE leaves the cached copy alone — a transient fault is not cleared settings", async () => {
    /* The lease peek's rule for this table: "I could not look" and "nobody holds it" must not be
     * reachable from one another. Discarding here would make one FETCH failure indistinguishable
     * from the organizer clearing everything. */
    const w = await world();
    await seedCached(w, 1757000000n, 42);

    const out = await pass(w, { state: "unreadable", reason: "corrupt profile message" });
    expect(out).toEqual({ state: "kept", reason: "unreadable" });
    expect(await row(w)).toMatchObject({ uidvalidity: 1757000000n, uid: 42 });
  });

  it("NEWER leaves it alone and does not parse it", async () => {
    const w = await world();
    await seedCached(w, 1757000000n, 42);
    const out = await pass(w, { state: "newer", v: 99 });
    expect(out).toEqual({ state: "kept", reason: "newer" });
    expect(await row(w)).toMatchObject({ uid: 42 });
  });

  it("a READ THAT THROWS leaves it alone too, and is logged as its own event", async () => {
    /* A DIFFERENT production from `state: "unreadable"`, and the double throws rather than
     * returning a union member, because the module reaches the same decision by another path and a
     * fixture that only returned `unreadable` would never enter this one. */
    const w = await world();
    await seedCached(w, 1757000000n, 42);
    logs.length = 0;

    const out = await passThroughRead(w, new Error("FETCH died mid-flight"));
    expect(out).toEqual({ state: "kept", reason: "read_failed" });
    expect(await row(w)).toMatchObject({ uid: 42 });
    expect(logs.some((l) => l.event === "profile_mirror_read_failed")).toBe(true);
  });

  it("discarding when there was nothing cached is not an event", async () => {
    // Anti-noise, and it keeps the steady state of a mailbox whose organizer publishes nothing
    // from logging once per poll for ever.
    const w = await world();
    logs.length = 0;
    const out = await pass(w, { state: "none" });
    expect(out).toEqual({ state: "discarded", reason: "no_document" });
    expect(logs.some((l) => l.event === "profile_mirror_discarded")).toBe(false);
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE CADENCE — a reader reads the document once per cadence, never once per poll
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * WHAT THIS KEEPS, and it is a shipped fix rather than a preference. "the profile module outlives
 * the role now, and a reader was still paying for it" (2026-09-02) removed a reader's fetch of the
 * whole profile source out of the customer's `ohmail/_meta` every 30 s for the life of the
 * attachment, and created `FakeMetaFolder.profileReads` because the ABSENCE of a call was the
 * claim. Mail 0094 gives a reader a REASON to read the document — it renders the organizer's
 * settings instead of its own dead rows — and the reader arm calls this once per 60 s poll, so
 * without a cadence that cost comes straight back at twice the interval and no TTL at all.
 *
 * The bound is {@link DEFAULT_PROFILE_FLUSH_INTERVAL_MS}: a reader's view is at most five minutes
 * behind, and a reader cannot act on what it shows.
 *
 * DRIVEN THROUGH `syncProfileMirror` AND A COUNTING `ProfileIo`, not through `applyProfileRead`:
 * the whole question is whether the READ HAPPENS, so a fixture that hands over an already-read
 * answer cannot ask it. The double counts appends and expunges too — a mirror read that published
 * or deleted anything would be a far worse defect than the one being bounded.
 */
describe("the cadence bounds what a reader pays", () => {
  function countingIo(state: { generation: number; uid: number }) {
    const calls = { list: 0, append: 0, expunge: 0 };
    const io: ProfileIo = {
      ensureMetaFolder: async () => { /* the reader never creates the folder */ },
      listProfileMessages: async () => {
        calls.list++;
        return [{
          ref: state.uid,
          raw: formatProfileMessage(DOC as never, { installId: "the-organizer" }),
          generation: state.generation,
        }];
      },
      appendProfile: async () => { calls.append++; },
      removeProfiles: async () => { calls.expunge++; },
    };
    return { io, calls };
  }

  const mirror = async (w: W, io: ProfileIo, now: Date): Promise<MirrorOutcome> =>
    syncProfileMirror({
      db: w.db as never, accountId: w.accountId, mailboxId: w.mailboxId, io, now, log,
    });

  /** The reader arm's real poll interval, which is what makes the count below a cost and not a
   * number: `pollIntervalMs` is 60 s, so five polls fit inside one five-minute cadence and the
   * sixth does not. An earlier draft of this case ran NINE polls 60 s apart and read twice — eight
   * minutes is not "inside one window", and the fixture was wrong rather than the gate. */
  const POLL_MS = 60_000;
  const POLLS_INSIDE = Math.floor(DEFAULT_PROFILE_FLUSH_INTERVAL_MS / POLL_MS);

  it("every poll inside one cadence window reads the document ONCE, and the one AT the boundary reads again", async () => {
    forgetMirrorCadence();
    const w = await world();
    const { io, calls } = countingIo({ generation: 1757000000, uid: 42 });

    expect(await mirror(w, io, NOW)).toMatchObject({ state: "written", uid: 42 });
    for (let i = 1; i < POLLS_INSIDE; i++) {
      expect(await mirror(w, io, new Date(NOW.getTime() + i * POLL_MS)))
        .toEqual({ state: "kept", reason: "within_cadence" });
    }
    expect(calls.list, "a reader paid for a document read on a later poll").toBe(1);
    expect(calls.append, "a mirror read published something").toBe(0);
    expect(calls.expunge, "a mirror read expunged something").toBe(0);

    /* THE BOUNDARY IS ASSERTED RATHER THAN LEFT TO `<` VS `<=`. A copy exactly one cadence old is
     * EXPIRED — otherwise the bound would be "five minutes plus one poll" and the docblock's
     * sentence would be false by one interval. */
    const atBoundary = new Date(NOW.getTime() + DEFAULT_PROFILE_FLUSH_INTERVAL_MS);
    expect(await mirror(w, io, atBoundary)).toMatchObject({ state: "written" });
    expect(calls.list, "a copy exactly one cadence old was served as fresh").toBe(2);
  });

  it("past the cadence a BUMPED GENERATION costs exactly one more read, and the pair moves", async () => {
    /* The arm is not vacuous: the folder is renumbered and the document sits at a new uid, so a
     * second read that did not happen, or a row left carrying the old pair, both fail here. */
    forgetMirrorCadence();
    const w = await world();
    const state = { generation: 1757000000, uid: 42 };
    const { io, calls } = countingIo(state);

    expect(await mirror(w, io, NOW)).toMatchObject({ state: "written", uid: 42 });
    expect(calls.list).toBe(1);

    state.generation = 1757000001;
    state.uid = 7;
    const later = new Date(NOW.getTime() + DEFAULT_PROFILE_FLUSH_INTERVAL_MS + 1_000);
    expect(await mirror(w, io, later)).toMatchObject({ state: "written", uid: 7 });

    expect(calls.list, "the cadence expired and the read did not happen, or happened twice").toBe(2);
    const r = await row(w);
    expect(r).toMatchObject({ uidvalidity: 1757000001n, uid: 7 });
    expect(r!.uid).not.toBe(42);
    expect(calls.append).toBe(0);
    expect(calls.expunge).toBe(0);
  });

  it("a mailbox whose organizer has published NOTHING is bounded too", async () => {
    /* THE STEADY STATE THE ROW ALONE CANNOT BOUND, and the reason the cadence has a second source.
     * `none` DELETES rather than writing — a row of nulls would be indistinguishable from a
     * document that says nothing — so no `read_at` is ever stamped here, and a cadence read only
     * from the row would fetch every poll for ever on the commonest reader mailbox there is. */
    forgetMirrorCadence();
    const w = await world();
    const calls = { list: 0 };
    const io: ProfileIo = {
      ensureMetaFolder: async () => { /* no-op */ },
      listProfileMessages: async () => { calls.list++; return []; },
      appendProfile: async () => { throw new Error("a mirror read must never append"); },
      removeProfiles: async () => { throw new Error("a mirror read must never expunge"); },
    };

    expect(await mirror(w, io, NOW)).toEqual({ state: "discarded", reason: "no_document" });
    for (let i = 1; i < POLLS_INSIDE; i++) {
      expect(await mirror(w, io, new Date(NOW.getTime() + i * POLL_MS)))
        .toEqual({ state: "kept", reason: "within_cadence" });
    }
    expect(calls.list, "an empty folder was re-read on a later poll").toBe(1);
    expect(await row(w), "nothing was cached for a mailbox with no document").toBeUndefined();
  });
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  THE LINE A FAILED MIRROR READ EMITS SAYS WHAT FAILED
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Measured on a reader install over nine hours: `profile_mirror_read_failed` 47 times, every one
 * of them `errorClass: "String"` with no code and no cause, because the call site handed the
 * logger `err.message` instead of the thrown value. `err` is the logger's own slot — it reduces a
 * thrown value to class, `code` and one wrapper of cause, and publishes a thrown STRING's text as
 * `errorText`. Pre-stringifying inverted both halves: the taxonomy was lost and the driver
 * message was published.
 *
 * ASSERTED ON THE EMITTED BYTES, not on the detail object, because the defect lived in what the
 * logger made of the fields rather than in the fields themselves — the composition production
 * performs is the thing under test.
 */
describe("a failed mirror read is diagnosable from its own line", () => {
  function emitted(detail: Record<string, unknown>): Record<string, unknown> {
    const lines: string[] = [];
    createLogger({ service: "sidecar", sink: (l: string) => { lines.push(l); } })
      .error("profile_mirror_read_failed", detail);
    return JSON.parse(lines[0]!) as Record<string, unknown>;
  }

  it("carries the refusal's class and code, and one wrapper of cause", async () => {
    const w = await world();
    forgetMirrorCadence();
    logs.length = 0;
    const thrown = new ProfileUnavailableError("the organizer profile could not be read", {
      op: "list_profiles",
      cause: new ProfileUnavailableError("the profile records could not be enumerated", {
        op: "list_profiles", code: "profile_gap_too_deep",
      }),
    });

    const out = await passThroughRead(w, thrown);

    expect(out).toEqual({ state: "kept", reason: "read_failed" });
    const failed = logs.find((l) => l.event === "profile_mirror_read_failed");
    expect(failed, "the failure was not reported at all").toBeDefined();
    const line = emitted(failed!.detail);
    expect(line, "the line said a string had been thrown, which is what hid the fault").toMatchObject({
      errorClass: "ProfileUnavailableError",
      causeClass: "ProfileUnavailableError",
      causeCode: "profile_gap_too_deep",
      op: "list_profiles",
      mailboxId: w.mailboxId,
      accountId: w.accountId,
    });
  });

  it("does NOT publish the thrown Error's own message, and still names the refusal", async () => {
    /* TWO HALVES, failing in opposite directions. `errorText` is for a thrown PRIMITIVE, whose
     * value IS the diagnosis; an `Error`'s message is driver-written and a pre-stringified one
     * arrived through that door. And `errorCode` has to survive the WRAPPER `readOrganizerProfile`
     * puts around the io's refusal — `describeCause` walks a bounded chain, so a name two wrappers
     * down reaches no line at all. */
    const w = await world();
    forgetMirrorCadence();
    logs.length = 0;

    await passThroughRead(w, new ProfileUnavailableError("SELECT failed for u@example.test", {
      op: "list_profiles", code: "profile_search_refused",
    }));

    const line = emitted(logs.find((l) => l.event === "profile_mirror_read_failed")!.detail);
    expect("errorText" in line, "an Error's driver message reached the line").toBe(false);
    expect(line.errorCode, "the refusal's own name did not survive the wrapper")
      .toBe("profile_search_refused");
  });
});

import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, mailboxes, tags, type Tx } from "@trafficflow/db";
import { createLogger, describeError } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  ProfileUnavailableError,
  type ProfileIo, type RawProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { OrganizerProfileSync } from "../src/profile.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  THE PROFILE'S FAILURE LINE SAYS A STATE, NOT A TICK
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `OrganizerProfileSync` runs on the drain's cadence — every poll, which is fifteen seconds on
 * a desktop install. Both of its failure arms log `organizer_profile_write_failed` from a
 * per-tick catch, so a condition that lasts logs once per tick for as long as it lasts.
 * Measured on the release candidate, 2026-09-07: after a mailbox was taken over from another
 * door, `op: "list_profiles"` with `ProfileUnavailableError` every fifteen seconds, for as long
 * as it was watched.
 *
 * That is not a small thing to leave alone. A line that fires on a cadence is a line people
 * learn to skip, and the next real profile fault arrives in a log that is already full of this
 * one — the same defect as a guard that fires on innocent content, seen from the reader's side.
 *
 * ── WHAT THE LINE MUST MEAN ───────────────────────────────────────────────────────────────
 *
 * One line per STATE: the first failure of a kind, and then silence until either the kind
 * changes — a different `op`, a different error class, which is a different fault and worth
 * saying — or the condition clears, which is worth saying exactly once too
 * (`organizer_profile_recovered`). A latch with no recovery line would be worse than the noise:
 * a reader would have no way to tell "still broken" from "fixed twenty minutes ago".
 *
 * ── WHY THE FIXTURE THROWS FROM THE IO AND NOT FROM THE MODULE ────────────────────────────
 *
 * Production's failure is an IMAP command refusing on a connection that is up: the raw throw
 * comes out of `listProfileMessages`, and `readOrganizerProfile` — the real one, running here —
 * wraps it in `ProfileUnavailableError` with `op: "list_profiles"` and the provider's own error
 * as its `cause`. A double that threw `ProfileUnavailableError` itself would be asserting the
 * wrapper this repository has already been bitten by trusting: the module must meet the class
 * the SERVER's failure actually becomes, produced by the same code that produces it in
 * production.
 */

/** A profile IO whose every command is decided by the test, one command at a time. */
class ScriptedProfileIo implements ProfileIo {
  /** Thrown by `listProfileMessages` when set — the raw provider refusal, never the wrapper. */
  listThrows: Error | string | null = null;
  /**
   * The first (1-based) `listProfileMessages` call `listThrows` applies to.
   *
   * A tick reads the folder more than once — the seed reads it, and the empty-store arm's
   * preflight reads it again — so "the second read fails" is the only way to reach the state
   * where a NESTED arm records a failure inside a tick that then returns normally.
   */
  listThrowsFromCall = 1;
  listCalls = 0;
  /** Thrown by `ensureMetaFolder` when set — the write path's own first step. */
  ensureThrows: Error | null = null;
  /** What the folder holds. Empty is the ordinary state of a mailbox nobody has written to. */
  messages: RawProfileMessage[] = [];
  /** One generation per LIST call, as the real io stamps it inside the mailbox lock. */
  generation: number = 1_000;
  appends = 0;

  async ensureMetaFolder(): Promise<void> {
    if (this.ensureThrows) throw this.ensureThrows;
  }

  async listProfileMessages(): Promise<RawProfileMessage[]> {
    this.listCalls += 1;
    if (this.listThrows !== null && this.listCalls >= this.listThrowsFromCall) throw this.listThrows;
    return this.messages.map((m) => ({ ...m, generation: this.generation }));
  }

  async appendProfile(raw: string): Promise<void> {
    this.appends += 1;
    this.messages.push({ ref: this.messages.length + 1, raw, generation: this.generation });
  }

  async removeProfiles(): Promise<void> { /* nothing this file measures */ }
}

/**
 * imapflow after the socket is gone — the shape the provider's refusal actually has, with the
 * `code` the logger reads. Never a `ProfileUnavailableError`: producing the wrapper is the
 * module's own job and is the thing under test.
 */
function providerRefusal(text = "Connection not available"): Error {
  return Object.assign(new Error(text), { code: "NoConnection" });
}

interface Rig {
  sync: OrganizerProfileSync;
  io: ScriptedProfileIo;
  /** Makes the unwrapped `profileIo()` call throw whatever the test hands it. */
  gate: { throws: unknown };
  lines: Array<{ event: string; detail: Record<string, unknown> }>;
  seen: (event: string) => Array<Record<string, unknown>>;
  /**
   * The same events as `lines`, as the REAL logger's bytes.
   *
   * `lines` is a fake logger, so it proves what this module hands over and nothing about what
   * reaches a drain. That gap is not theoretical here: the thrown-string case below passed for
   * a build whose emitted line carried no text at all.
   */
  emitted: string[];
}

async function rig(opts: { withStoredConfiguration?: boolean } = {}): Promise<Rig> {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  if (opts.withStoredConfiguration) {
    // SOMETHING TO WRITE. A mailbox that has said nothing gets no document, so an empty store
    // never reaches the write path at all — and the write path is where the second `op` lives.
    await db.insert(tags).values({ accountId, name: "invoices" });
  }
  const io = new ScriptedProfileIo();
  /* THE ONE CALL IN EITHER ARM THAT IS NOT WRAPPED BY THE ENGINE'S OWN READER, so it is the
     only place a value reaches the catch exactly as the thrower produced it. Everything the
     folder's IO throws passes through `readOrganizerProfile`, which normalizes it to
     `ProfileUnavailableError`; `profileIo()` does not. */
  const gate: { throws: unknown } = { throws: null };
  const lines: Array<{ event: string; detail: Record<string, unknown> }> = [];
  /* The bytes, through the shipped logger — `createLogger` applies the census, the value
     scrubber and the error discipline, none of which a fake `log` exercises. */
  const emitted: string[] = [];
  const capture = (event: string, detail: Record<string, unknown>): string[] => {
    const out: string[] = [];
    createLogger({ service: "worker", sink: (l) => { out.push(l); } }).error(event, detail);
    return out;
  };
  await db.insert(accounts).values({ id: accountId, name: "latch", createdAt: new Date("2026-01-01T00:00:00Z") });
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@x.test`, createdAt: new Date("2026-01-01T00:00:00Z") })
    .returning({ id: mailboxes.id });
  const sync = new OrganizerProfileSync({
    db,
    accountId,
    mailboxId: mb!.id,
    /* THE ONLY METHOD THIS MODULE USES. `hasProfileIo` is a structural check for exactly this
       one, and a fixture carrying the whole adapter surface would be asserting a coupling that
       does not exist. */
    adapter: {
      profileIo: () => {
        if (gate.throws !== null) throw gate.throws;
        return io;
      },
    } as unknown as MailboxAdapter,
    self: { installId: "install-under-test", kind: "cloud" },
    producerVersion: "0.14.2-test",
    /* EVERY CALL IS A TICK. The cadence gate is the drain's, not this file's subject: with it
       in force the second and third calls would return before reaching either arm, and a test
       that measured one tick three times could not tell a latch from a debounce. */
    flushIntervalMs: 0,
    log: (event, detail) => {
      lines.push({ event, detail });
      emitted.push(...capture(event, detail));
    },
  });
  return {
    sync,
    io,
    gate,
    lines,
    emitted,
    seen: (event) => lines.filter((l) => l.event === event).map((l) => l.detail),
  };
}

describe("the profile's failure line is latched to the state, not to the tick", () => {
  it("THREE TICKS OF ONE FAILURE ARE ONE LINE", async () => {
    const r = await rig();
    r.io.listThrows = providerRefusal();

    for (let i = 0; i < 3; i++) await r.sync.onOrganize();

    const failed = r.seen("organizer_profile_write_failed");
    expect(
      failed.length,
      "one standing failure logged once per tick — on a desktop poll that is four lines a "
      + "minute for as long as the condition lasts",
    ).toBe(1);
    expect(failed[0]!.op, "the line lost the operation that failed").toBe("list_profiles");
    expect(describeError(failed[0]!.err).errorClass).toBe("ProfileUnavailableError");
  });

  it("THE PREFLIGHT ARM LATCHES TOO — the path beside the one the defect was found on", async () => {
    const r = await rig();
    r.io.listThrows = providerRefusal();

    for (let i = 0; i < 3; i++) await r.sync.armHoldFromFolder();

    expect(
      r.seen("organizer_profile_write_failed").length,
      "the hold preflight logs once per drain, and it runs on the same cadence as the tick",
    ).toBe(1);
  });

  it("A TICK THAT WORKS AGAIN SAYS SO, ONCE", async () => {
    const r = await rig();
    r.io.listThrows = providerRefusal();
    await r.sync.onOrganize();
    await r.sync.onOrganize();
    expect(r.seen("organizer_profile_write_failed")).toHaveLength(1);

    // The mailbox comes back.
    r.io.listThrows = null;
    await r.sync.onOrganize();
    await r.sync.onOrganize();

    expect(
      r.seen("organizer_profile_recovered").length,
      "a latched failure that cleared said nothing, so a reader cannot tell a standing fault "
      + "from one that ended twenty minutes ago",
    ).toBe(1);
    expect(
      r.seen("organizer_profile_write_failed"),
      "the recovery re-opened the failure line",
    ).toHaveLength(1);
  });

  it("A HEALTHY INSTALL SAYS NEITHER — the latch admits the ordinary case", async () => {
    const r = await rig();
    for (let i = 0; i < 3; i++) await r.sync.onOrganize();
    expect(r.seen("organizer_profile_write_failed")).toHaveLength(0);
    expect(
      r.seen("organizer_profile_recovered"),
      "a recovery was announced for a failure that never happened",
    ).toHaveLength(0);
  });

  it("A DIFFERENT OPERATION SPEAKS AGAIN — the latch is not a mute button", async () => {
    const r = await rig({ withStoredConfiguration: true });
    // A readable folder, so the seed completes and the WRITE path is what runs from here.
    r.io.ensureThrows = providerRefusal("NO [SERVERBUG] CREATE failed");
    await r.sync.onOrganize();
    await r.sync.onOrganize();
    const first = r.seen("organizer_profile_write_failed");
    expect(first, "the write path's own first step never failed").toHaveLength(1);
    expect(first[0]!.op).toBe("ensure_meta");

    // A SECOND, DIFFERENT FAULT while the first is still latched.
    r.io.ensureThrows = null;
    r.io.listThrows = providerRefusal();
    await r.sync.onOrganize();

    const all = r.seen("organizer_profile_write_failed");
    expect(
      all.length,
      "a different operation failed while the previous one was latched and the log said nothing",
    ).toBe(2);
    expect(all[1]!.op).toBe("list_profiles");
  });

  it("THE PREFLIGHT ANNOUNCES NO RECOVERY THE TICK HAS NOT EARNED", async () => {
    /* THE STATE THAT MAKES THE ASYMMETRY LOAD-BEARING: a folder that LISTS fine and a CREATE the
       server refuses. The preflight is a read, so it succeeds every drain; the tick fails every
       drain in its write path. A preflight that cleared the latch would print a recovery and
       then a failure on every single drain — two lines where the defect being fixed printed one.
       The sidecar drives exactly this pair per drain (engine.ts calls `armHoldFromFolder` before
       the cycle and `onOrganize` at the end of it), so the order below is production's. */
    const r = await rig({ withStoredConfiguration: true });
    r.io.ensureThrows = providerRefusal("NO [SERVERBUG] CREATE failed");

    for (let i = 0; i < 3; i++) {
      await r.sync.armHoldFromFolder();
      await r.sync.onOrganize();
    }

    expect(
      r.seen("organizer_profile_write_failed").length,
      "the standing write failure was re-reported",
    ).toBe(1);
    expect(
      r.seen("organizer_profile_recovered").length,
      "a recovery was announced while the write path was still refusing — the preflight's read "
      + "succeeding is not evidence the profile is being maintained",
    ).toBe(0);
  });

  it("A DIFFERENT ERROR CLASS SPEAKS AGAIN, at the same operation", async () => {
    /* THE OTHER HALF OF THE LATCH KEY. The operation alone is not the fault's identity: a folder
       that refuses a FETCH and one whose client is gone are different things to look into, and a
       latch keyed on the step would report the first and swallow the second for ever. Both
       throws below arrive through the unwrapped call, so both carry no `op` and differ only in
       class — which is exactly the discrimination this asserts. */
    const r = await rig();
    r.gate.throws = new Error("the adapter has no live client");
    await r.sync.onOrganize();
    await r.sync.onOrganize();
    expect(r.seen("organizer_profile_write_failed")).toHaveLength(1);

    r.gate.throws = new TypeError("profileIo is not a function on this build");
    await r.sync.onOrganize();

    const all = r.seen("organizer_profile_write_failed");
    expect(
      all.length,
      "a different error class at the same step was swallowed by the latch",
    ).toBe(2);
    expect(describeError(all[0]!.err).errorClass).toBe("Error");
    expect(describeError(all[1]!.err).errorClass).toBe("TypeError");
  });

  it("A FAILURE RECORDED INSIDE A TICK IS NOT UNDONE BY THAT TICK RETURNING", async () => {
    /* THE NESTING THE PRODUCT ACTUALLY HAS: `onOrganize`'s empty-store arm calls
       `armHoldFromFolder`, which has its own catch — so a tick can record a failure a few frames
       down and then return NORMALLY. A tick that judged itself by whether it threw would then
       announce a recovery in the same breath as the failure, and do it again every drain. */
    const r = await rig();
    r.io.listThrows = providerRefusal();
    r.io.listThrowsFromCall = 2;          // the seed reads; the nested preflight does not.

    for (let i = 0; i < 3; i++) await r.sync.onOrganize();

    expect(
      r.seen("organizer_profile_write_failed").length,
      "the nested failure was announced more than once",
    ).toBe(1);
    expect(
      r.seen("organizer_profile_recovered").length,
      "the tick claimed a recovery in the same drain that recorded the failure",
    ).toBe(0);
  });

  it("A THROWN STRING KEEPS ITS TEXT ON THE EMITTED LINE — the only thing such a throw carries", async () => {
    const r = await rig();
    /* NOT HYPOTHETICAL: measured on the Omarchy guest, 2026-09-07, on this very event.
       Everything the folder's IO throws is already normalized by `readOrganizerProfile`; the
       unwrapped `profileIo()` call is where a raw value still reaches the catch, so that is
       where the fixture puts it.

       ASSERTED ON THE BYTES. The previous version of this case read the object handed to the
       fake logger and passed against a build that wrapped the string in an `Error` — whose
       message the logger discards, so the emitted line carried `errorClass: "Error"` and no
       text at all. Only the line can tell those apart. */
    r.gate.throws = "the provider hung up mid-FETCH";

    await r.sync.onOrganize();

    const failed = r.seen("organizer_profile_write_failed");
    expect(failed).toHaveLength(1);
    expect(
      describeError(failed[0]!.err).errorClass,
      "the primitive was normalized before the logger saw it, so it cannot derive its text",
    ).toBe("String");
    const line = r.emitted.filter((l) => l.includes("organizer_profile_write_failed"));
    expect(line).toHaveLength(1);
    const parsed = JSON.parse(line[0]!) as Record<string, unknown>;
    expect(parsed.errorClass).toBe("String");
    expect(
      parsed.errorText,
      "the one thing a thrown string carries — its text — is not on the line",
    ).toBe("the provider hung up mid-FETCH");
  });

});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A PERSISTENT PROFILE REFUSAL BECOMES A SENTENCE — the latch's other reader
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The latch above ends a log line that repeated. It never ended the SILENCE, which is the half
 * a person feels. Measured on the 0.18.0 release candidate: `organizer_profile_write_failed`
 * `op: list_profiles` `errorCode: profile_gap_too_deep` every drain, a restart reproducing it at
 * boot, and the mailbox row reading Organized on this computer · Up to date · Organizing
 * throughout. Nobody reads a desktop log. The same shape as the unreadable-credential outage:
 * a reliability feature rendering as its own healthy state.
 *
 * ── WHY TWO, AND WHY ONE AT BOOT ────────────────────────────────────────────────────────────
 *
 * A single refusal can be a provider that was not ready on one drain, and a sentence raised on
 * it would be noise a person cannot act on — the `confirmed` rule the credential block already
 * states. The exception is an attachment that has never had a working tick: there is no
 * successful reading for that one to be a blip against, so its first refusal is already the
 * whole of what this install knows.
 */
describe("a standing profile refusal is readable off the sync, not only off the log", () => {
  it("nothing is blocked while the profile is being maintained", async () => {
    const r = await rig({ withStoredConfiguration: true });

    await r.sync.onOrganize();

    expect(r.sync.profileBlock(), "a healthy attachment reported a block").toBeNull();
  });

  it("ONE refusal after a good tick is not yet a sentence; the SECOND is", async () => {
    const r = await rig({ withStoredConfiguration: true });
    await r.sync.onOrganize();
    r.io.listThrows = providerRefusal();

    await r.sync.onOrganize();
    expect(r.sync.profileBlock(),
      "a single refusal raised a sentence — a provider that was not ready on one drain is not news")
      .toBeNull();

    await r.sync.onOrganize();
    expect(r.sync.profileBlock(), "two consecutive refusals left the row with nothing to say")
      .not.toBeNull();
  });

  it("the FIRST refusal speaks when nothing has ever worked — the boot case", async () => {
    /* The measured install: a restart reproduced the refusal at boot, so the very first tick of
     * the attachment's life is already everything this install knows about the folder. */
    const r = await rig({ withStoredConfiguration: true });
    r.io.listThrows = providerRefusal();

    await r.sync.onOrganize();

    expect(r.sync.profileBlock(), "the first refusal of an attachment that never worked was held silent")
      .not.toBeNull();
  });

  it("and it names the refusal in the alphabet the log line carries", async () => {
    /* `errorCode`, so the sentence a person is shown and the line a maintainer reads name the
     * same fact — `profile_gap_too_deep` is what the measured install repeated for its whole life.
     *
     * A `ProfileUnavailableError` HERE, and it is not the wrapper this file refuses elsewhere: a
     * named refusal is the io layer's OWN production, thrown by `makeProfileIo` itself, and
     * `readOrganizerProfile` lifts its code onto the error it re-wraps it in (`askCodeOf` reads
     * the code off nothing else). A bare `Error` carrying the same `code` field is a shape the
     * real io never produces, and a fixture built from one would be measuring a path that does
     * not exist. The provider-refusal cases above keep the raw shape, which is theirs. */
    const r = await rig({ withStoredConfiguration: true });
    r.io.listThrows = new ProfileUnavailableError("no bounded read can reach it", {
      op: "list_profiles", code: "profile_gap_too_deep",
    });

    await r.sync.onOrganize();

    expect(r.sync.profileBlock()?.code).toBe("profile_gap_too_deep");
  });

  it("a recovered tick takes the sentence down", async () => {
    /* The latch already says the condition ended in the log; a sentence that outlived the fault
     * would be the same defect pointing the other way — a person told their mailbox is unreadable
     * while it is being maintained. */
    const r = await rig({ withStoredConfiguration: true });
    r.io.listThrows = providerRefusal();
    await r.sync.onOrganize();
    expect(r.sync.profileBlock()).not.toBeNull();

    r.io.listThrows = null;
    await r.sync.onOrganize();

    expect(r.sync.profileBlock(), "the sentence outlived the fault").toBeNull();
  });

  it("a demotion forgets it with the rest of the organizing life", async () => {
    /* `forgetOrganizerLife` exists because the runtime outlives the role. A block carried across
     * would have a reader's row reporting a fault from an organizing life that is over. */
    const r = await rig({ withStoredConfiguration: true });
    r.io.listThrows = providerRefusal();
    await r.sync.onOrganize();
    expect(r.sync.profileBlock()).not.toBeNull();

    r.sync.forgetOrganizerLife();

    expect(r.sync.profileBlock(), "a demoted install kept the previous life's fault").toBeNull();
  });
});

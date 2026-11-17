import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import type {
  MetaBaselineReading, MetaFolderStamp,
} from "@trafficflow/core/adapters/organizer-lease";
import {
  LeaseUnavailableError, MIN_PERMIT_TTL_MS, OrganizerStandDownError, acquireLeasePermit,
  leaseStoodDown, readMailboxLease,
} from "../src/lease.js";
import { FakeMetaFolder } from "./_fakeadapter.js";
import { PermitClock } from "./_permit-clock.js";

/**
 * ═══ A LEASE READ WITH A DEADLINE ON IT ══════════════════════════════════════════════════════
 *
 * The permit exists because "exactly one active organizer per mailbox" and "exactly one organizer
 * at the instant this pass began" are different statements, and every destructive pass in this
 * tree was enforcing the second one. the sharpest seam
 * (`run-junk-sweep.ts`) enforced neither — it never looked at all — and its sibling row
 * names the general shape: a successful check hands out a permit with
 * no expiry, which is then spent on as many destructive cycles as the pass has.
 *
 * `junk-sweep-lease.pg.test.ts` proves the SEAM: a takeover mid-sweep moves no mail. This file
 * proves the MECHANISM the seam leans on, on an INJECTED clock — which is the only way to assert
 * on a deadline at all, and the reason these properties are not left to the seam test to imply.
 *
 * ── AN ENGINE HAZARD THIS FILE EXISTS PARTLY TO AVOID, MEASURED HERE ────────────────────────
 *
 * The permit's first draft allowed `ttlMs: 0` — "ask at every boundary" — which read as the
 * carefully paranoid setting. It is the opposite. Two `runLeaseGate` runs inside ONE millisecond
 * make the gate answer `stand_down` against a folder holding one claim, our own, bearing the nonce
 * we passed as `lastNonce`; the stand-down then RELEASES that claim and the mailbox is left with no
 * organizer at all. Roughly one run in three, following the random nonce's ordering, so it presents
 * as flakiness. Reproduced with `runLeaseGate` alone, no permit involved, and NOT reproducible once
 * the clock advances between the two runs. `MIN_PERMIT_TTL_MS` carries the full argument and the
 * reason the fix is a floor here rather than an edit to the engine's decision table.
 *
 * ── MUTATIONS WATCHED (each restored) ────────────────────────────────────────────────────────
 *
 *  2.  the TTL comparison `>=` becomes `>`
 *      ⇒ "the permit expires AT its deadline" RED. The deadline instant is the ONLY instant at
 *        which the two spellings differ, which is why the test steps to the deadline and then one past it
 *        rather than asserting on a real elapsed time — on a real clock this mutation is invisible,
 *        and an earlier version of this suite proved nothing about it while appearing to.
 *  6.  the permit re-verifies with `lastNonce: null` instead of threading the renewed nonce
 *      ⇒ "a restored clone wearing our install id is not us" RED: `decideLease`'s clone defence
 *        is disarmed once per TTL, and the permit answers `organize` for a mailbox a second live
 *        process bearing our identity is organizing. A fresh process trusts its own id exactly
 *        once, on purpose; a permit that re-armed that trust every minute would turn a
 *        once-per-process allowance into a standing one.
 *  7.  `check()` never re-reads (`return;` first)
 *      ⇒ "a takeover past the TTL stands this organizer down" RED.
 *  8.  the floor clamp becomes `input.ttlMs ?? DEFAULT_PERMIT_TTL_MS` (no `Math.max`)
 *      ⇒ "a TTL shorter than the floor is raised to it" RED, and the seam is reopened.
 */

const OUR_ID = "ohmail-cloud:test";

const selfOf = () => ({
  installId: OUR_ID, kind: "cloud" as const, displayName: "ohmail Cloud", lastNonce: null,
});

/** The minimum an adapter must be for the lease: it hands out its `_meta` IO. */
const adapterOf = (meta: FakeMetaFolder): MailboxAdapter =>
  ({ leaseIo: () => meta }) as unknown as MailboxAdapter;

const claim = (o: {
  kind: string; installId: string; nonce: string; claimedAt: Date; heartbeat?: Date;
  displayName?: string; protocol?: number;
}): string => [
  "X-Ohmail-Lease: 1",
  `X-Ohmail-Organizer-Kind: ${o.kind}`,
  `X-Ohmail-Install-Id: ${o.installId}`,
  `X-Ohmail-Protocol: ${o.protocol ?? 1}`,
  `X-Ohmail-Heartbeat: ${(o.heartbeat ?? new Date()).toISOString()}`,
  `X-Ohmail-Claimed-At: ${o.claimedAt.toISOString()}`,
  `X-Ohmail-Display-Name: ${o.displayName ?? "somebody"}`,
  `X-Ohmail-Nonce: ${o.nonce}`,
  "", "",
].join("\r\n");

describe("the organizer lease permit — a dated receipt, not a boolean", () => {
  it("acquiring it takes the lease for real: the gate renews, and the verdict is `organize`", async () => {
    const meta = new FakeMetaFolder();
    const permit = await acquireLeasePermit({ adapter: adapterOf(meta), self: selfOf() });
    expect(permit.reads).toBe(1);
    // An empty `ohmail/_meta` is arm 4 — nobody has ever organized this mailbox — and
    // `runLeaseGate` then APPENDS our claim. That append is the proof the gate really ran.
    expect(meta.appends).toBe(1);
    expect(meta.messages).toHaveLength(1);
  });

  it("inside the TTL the answer is free — the lease is NOT re-read on every write boundary", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...t.pair, ttlMs: 60_000,
    });
    for (let i = 0; i < 25; i++) { t.advance(1_000); await permit.check(); }
    // 25 s of writing on one 60 s permit: one read. The cost argument the TTL exists to make.
    expect(permit.reads).toBe(1);
    expect(meta.appends).toBe(1);
    // And one STAMP per boundary — the cheap question that replaced the blind stretch. A read is a
    // whole-folder FETCH plus an APPEND and an EXPUNGE; this is a STATUS that reads no record.
    expect(permit.probes).toBe(25);
  });

  it("the permit expires AT its deadline, not one tick after it", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...t.pair, ttlMs: 60_000,
    });

    // One tick short of the deadline: still inside, still free.
    t.advance(59_999);
    await permit.check();
    expect(permit.reads).toBe(1);

    // EXACTLY the deadline. `>=` re-reads here; `>` would serve this instant from the stale
    // receipt and not look again until 60_001. That is the boundary the operator decides, and it
    // is the only instant at which the two spellings differ — so it is the instant to assert on.
    t.advance(1);
    await permit.check();
    expect(permit.reads).toBe(2);
  });

  it("a TTL shorter than the floor is raised to it — the caller cannot ask for same-instant re-entry", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    // Zero means "ask every time", and asking every time is the one thing a permit must not do:
    // two `runLeaseGate` runs inside one millisecond make the engine stand this organizer down
    // against its OWN claim about a third of the time. See `MIN_PERMIT_TTL_MS`.
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...t.pair, ttlMs: 0,
    });
    expect(MIN_PERMIT_TTL_MS).toBeGreaterThan(0);

    // Inside the floor: not re-read, however many boundaries the pass crosses.
    for (let i = 0; i < 10; i++) { t.advance(50); await permit.check(); }
    expect(permit.reads).toBe(1);

    // Past it: re-read, exactly once.
    t.advance(MIN_PERMIT_TTL_MS);
    await permit.check();
    expect(permit.reads).toBe(2);
  });

  it("a takeover past the TTL stands this organizer down, with the reason and the holder", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...t.pair, ttlMs: 60_000,
    });

    const before = await meta.stampMeta();

    // The user's laptop takes the mailbox: an authorized takeover DISPLACES the beaten
    // organizer's claims (arm 6) and appends its own, so the folder holds theirs and not ours.
    meta.messages.length = 0;
    meta.messages.push({
      ref: 42,
      raw: claim({
        kind: "local", installId: "ohmail-desktop:laptop", nonce: randomUUID(),
        claimedAt: new Date(t.ms), heartbeat: new Date(t.ms), displayName: "ohmail on the laptop",
      }),
    });

    /* ── WHAT THIS CASE MEASURES, NOW THAT THE FOLDER IS ALSO WATCHED ────────────────────────
     *
     * The clock, and only the clock. The swap above puts a record IN PLACE: the count comes back
     * to what it was and no uid was issued, so the folder's stamp is unmoved — a shape no real
     * takeover has, because a takeover APPENDS its own claim and `uidNext` only ever rises. The
     * premise is asserted rather than assumed, and the real thing is driven against a real server
     * in `lease-permit-takeover.imap.test.ts`, where the next write after the handover is refused.
     */
    expect(await meta.stampMeta(), "this fixture moved the folder's counters").toEqual(before);

    // Still inside the TTL, with nothing the stamp can see: the permit has not looked.
    t.advance(30_000);
    await expect(permit.check()).resolves.toBeUndefined();

    // Past it: it looks, and it loses.
    t.advance(31_000);
    const err = await permit.check().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrganizerStandDownError);
    const stand = err as OrganizerStandDownError;
    expect(stand.reason).toBe("organized_elsewhere:local");
    expect(stand.state).toBe("held");
    expect(stand.heldBy).toBe("ohmail on the laptop");
  });

  it("a restored clone wearing our install id is not us — the nonce is threaded, never re-armed", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...t.pair, ttlMs: MIN_PERMIT_TTL_MS,
    });

    // A SECOND LIVE PROCESS running a restored copy of us: our install id, a nonce we never wrote.
    //
    // ITS HEARTBEAT MUST BE THE NEWER ONE, and that is not test-rigging — it is what makes the
    // record survive `coalesce`, which keeps exactly ONE claim per install id (the folder
    // legitimately holds duplicates of a single organizer's claim: append-then-expunge's own crash
    // residue). A clone that renewed LESS recently than us is collapsed into our own record and is
    // invisible to the gate by design. The dangerous clone is the one that is still going, so the
    // clock moves and the clone renews at the later instant.
    t.advance(5_000);
    meta.messages.push({
      ref: 7,
      raw: claim({
        kind: "cloud", installId: OUR_ID, nonce: "a-nonce-we-never-wrote",
        claimedAt: new Date(t.ms - 60_000), heartbeat: new Date(t.ms), displayName: "ohmail Cloud",
      }),
    });

    // `decideLease`'s clone defence: a claim bearing our id whose nonce is not the one WE wrote,
    // and which is live, is somebody else. It can only reach that conclusion if the permit hands
    // it the nonce its own renew produced — with `lastNonce: null` the gate trusts anything
    // carrying our id (own-role resumption, which a fresh process is allowed exactly once) and
    // answers `organize` for a mailbox two live processes are now both organizing.
    const err = await permit.check().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(OrganizerStandDownError);
    expect((err as OrganizerStandDownError).reason).toBe("organized_elsewhere:cloud");
  });

  it("an UNREADABLE lease is not a stand-down, and does not wear its class", async () => {
    const meta = new FakeMetaFolder();
    const clock = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...clock.pair, ttlMs: MIN_PERMIT_TTL_MS,
    });
    clock.advance(MIN_PERMIT_TTL_MS);

    // The connection dies. Every lease operation now throws imapflow's `NoConnection`, which
    // `runLeaseGate` wraps as `LeaseUnavailableError` — through the code path a long
    // production outage actually took.
    meta.deadConnection = true;

    const err = await permit.check().then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(LeaseUnavailableError);
    // THE SEPARATION IS THE POINT (`ORGANIZER-LEASE-RESUME.md` §3.4): "somebody else holds this"
    // and "I could not look" must not be reachable from one another. A pass that read an
    // unreadable lease as a takeover would stand a mailbox down on a dropped socket; one that read
    // a takeover as unreadable would keep writing to somebody else's mailbox.
    expect(err).not.toBeInstanceOf(OrganizerStandDownError);
  });

  /* A BAD NETWORK INSIDE ONE PERMIT: a renewal commits and its answer is lost, the next never lands.
     Remembering one nonce forgot the committed claim, and the permit stood its own install down. */
  it("a renewal that lost its answer, then one that never landed: the permit still organizes", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...t.pair, ttlMs: 60_000,
    });
    const append = meta.appendClaim.bind(meta);
    const faults: Array<"lose" | "drop"> = ["lose", "drop"];
    meta.appendClaim = async (raw: string): Promise<void> => {
      const fault = faults.shift();
      if (fault === "drop") throw new Error("the socket closed before the APPEND reached the server");
      await append(raw);
      if (fault === "lose") throw new Error("the socket closed before the APPEND was answered");
    };
    for (let i = 0; i < 2; i++) {
      t.advance(60_000);
      await expect(permit.check()).rejects.toBeInstanceOf(LeaseUnavailableError);
    }
    t.advance(60_000);
    await permit.check();
    expect(permit.revoked, "the permit read its own committed renewal as a copy of itself").toBe(false);
    expect(permit.names.mintedNonces, "the permit forgot a nonce it minted").toHaveLength(4);
    expect(meta.messages, "the renewal left more than its own claim standing").toHaveLength(1);
  });

  it("acquiring against a mailbox ALREADY held refuses up front — the CLI never starts", async () => {
    const meta = new FakeMetaFolder();
    meta.messages.push({
      ref: 1,
      raw: claim({
        kind: "local", installId: "ohmail-desktop:laptop", nonce: randomUUID(),
        claimedAt: new Date(), displayName: "ohmail on the laptop",
      }),
    });
    await expect(acquireLeasePermit({ adapter: adapterOf(meta), self: selfOf() }))
      .rejects.toBeInstanceOf(OrganizerStandDownError);
    // And it did not write itself in as the organizer on the way to refusing.
    expect(meta.appends).toBe(0);
  });
});

/**
 * The two fields `LeasePermitInput` requires and the cases above leave out — spelled here so the
 * new cases typecheck, rather than inheriting an omission the ratchet already counts.
 */
const REQUIRED = { mailboxId: "mb-permit", hasRequestKey: false } as const;

/**
 * ═══ WHAT THE PERMIT TELLS THE RUNTIME THAT HOLDS THE NONCE ══════════════════════════════════
 *
 * A re-read is a RENEW: a new claim in the folder, the previous one expunged. The runtime that
 * went on holding the old nonce asked its next gate with a nonce nothing in the folder carried,
 * `decideLease` read this install's own claim as a restored clone of itself, and the install stood
 * ITSELF down — leaving a live claim with nobody behind it, which refuses the next install's
 * ordinary start for a whole staleness window, and leaving `releaseMailboxClaim` addressing a
 * claim that no longer exists. One writer owns the settled nonce, and it is the permit.
 *
 * ── MUTATIONS WATCHED (each restored, verified by `cmp`) ─────────────────────────────────────
 *
 *  the `onRenew` call deleted from `read()`
 *      ⇒ "a renewal is reported with the nonce it wrote" RED, and the sidecar seam's own case
 *        ("a drain driven past the permit's deadline keeps organizing") RED with it.
 *  `leaseStoodDown` returning `false` unconditionally
 *      ⇒ both stand-down cases in `apps/sidecar/test/lease-permit-stand-down-and-renew.test.ts`
 *        RED: the post-drain channel writes into a mailbox another install now organizes.
 */
describe("a renewal this permit performed is reported to the runtime that holds the nonce", () => {
  const nonceIn = (raw: string): string =>
    /^X-Ohmail-Nonce: (.+)$/m.exec(raw)?.[1]?.trim() ?? "";

  it("reports the nonce the renewal actually wrote, at the instant of the read", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const seen: Array<{ nonce: string | null; at: number }> = [];
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...t.pair, ttlMs: 60_000,
      onRenew: ({ nonce, at }) => seen.push({ nonce, at: at.getTime() }),
    });

    // The acquisition's own read is a renew like any other — this permit wrote that claim, so it
    // says so. (A caller that ran the gate itself hands the result over as `adopt`, and then there
    // is no read here and nothing to report; the case below asserts that.)
    expect(seen).toHaveLength(1);
    expect(permit.reads).toBe(1);

    t.advance(60_000);
    await permit.check();
    expect(permit.reads).toBe(2);

    expect(seen).toHaveLength(2);
    expect(seen[1]!.at, "the instant reported is not the instant of the read").toBe(t.ms);
    // THE CLAIM THAT IS ACTUALLY IN THE FOLDER, and not merely some new string: the whole value of
    // this callback is that a gate asked with the reported nonce recognises what it reads back.
    const standing = meta.messages.map((m) => nonceIn(m.raw)).filter((n) => n !== "");
    expect(standing, "the renew left more than one claim of ours standing").toHaveLength(1);
    expect(seen[1]!.nonce).toBe(standing[0]);
    expect(seen[1]!.nonce).toBe(permit.names.nonce);
    // …and the nonce the FIRST report carried is gone from the folder, which is what made holding
    // it a defect rather than a detail.
    expect(seen[0]!.nonce).not.toBe(standing[0]);
  });

  it("reports nothing for an ADOPTED read — the caller ran that gate and already holds its nonce", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const seen: string[] = [];
    const first = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...t.pair, ttlMs: 60_000,
    });
    const adopted = await acquireLeasePermit({
      adapter: adapterOf(meta), self: { ...selfOf(), lastNonce: first.names.nonce }, ...REQUIRED,
     
      ...t.pair, ttlMs: 60_000,
      adopt: {
        // THE READING THAT CALLER'S OWN GATE TOOK travels with the outcome — see
        // `MailboxLeaseOutcome.stamp`. Taken here, as the caller takes it, not inside the permit.
        outcome: {
          organize: true, nonce: first.names.nonce, by: null, uidValidity: null,
          /* CUSTODY AND THE COUNTERS TOGETHER, as the gate hands them over — the adopt path takes
             the caller's own reading whole, so a fixture that handed over bare counters would be
             driving a shape no gate produces. */
          stamp: meta.stampMeta().then((st) => ({ custody: "held", stamp: st }) as const),
        },
        at: new Date(t.ms),
      },
      onRenew: ({ nonce }) => seen.push(String(nonce)),
    });
    expect(adopted.reads).toBe(1);
    expect(seen, "an adopted read was reported as a renewal this permit performed").toEqual([]);
  });

  it("reports nothing when the re-read did not renew — a stand-down, and an unreadable lease", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const seen: string[] = [];
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...t.pair, ttlMs: MIN_PERMIT_TTL_MS,
      onRenew: ({ nonce }) => seen.push(String(nonce)),
    });

    // Somebody else has the mailbox. The re-read stands us down and writes no claim of ours, so
    // there is no renewal to report — a callback firing here would hand the runtime a nonce for a
    // claim it does not hold.
    meta.messages.length = 0;
    meta.messages.push({
      ref: 42,
      raw: claim({
        kind: "local", installId: "ohmail-desktop:laptop", nonce: randomUUID(),
        claimedAt: new Date(t.ms), heartbeat: new Date(t.ms), displayName: "ohmail on the laptop",
      }),
    });
    const before = seen.length;
    t.advance(MIN_PERMIT_TTL_MS);
    await expect(permit.check()).rejects.toBeInstanceOf(OrganizerStandDownError);
    expect(seen.length, "a stand-down was reported as a renewal").toBe(before);

    // And the could-not-look case, on a fresh permit: the read throws before any outcome exists.
    const meta2 = new FakeMetaFolder();
    const t2 = new PermitClock(1_000_000);
    const seen2: string[] = [];
    const permit2 = await acquireLeasePermit({
      adapter: adapterOf(meta2), self: selfOf(), ...REQUIRED, ...t2.pair,
      ttlMs: MIN_PERMIT_TTL_MS,
      onRenew: ({ nonce }) => seen2.push(String(nonce)),
    });
    const before2 = seen2.length;
    meta2.deadConnection = true;
    t2.advance(MIN_PERMIT_TTL_MS);
    await expect(permit2.check()).rejects.toBeInstanceOf(LeaseUnavailableError);
    expect(seen2.length, "an unreadable lease was reported as a renewal").toBe(before2);
  });
});

describe("`leaseStoodDown` — the one question a post-pass write asks", () => {
  it("answers for the permit's own latch, and never for a composition that holds none", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...t.pair, ttlMs: MIN_PERMIT_TTL_MS,
    });
    // A live permit: the pass may still write, which is the admission half of the rule.
    expect(leaseStoodDown(permit)).toBe(false);

    // A READER holds no permit, and "there is no lease here" is not "the lease was lost" — a
    // reader's own decision channel must not be refused by this.
    expect(leaseStoodDown({ noLease: "reader" })).toBe(false);
    expect(leaseStoodDown({ noLease: "not_supplied" })).toBe(false);

    meta.messages.length = 0;
    meta.messages.push({
      ref: 42,
      raw: claim({
        kind: "local", installId: "ohmail-desktop:laptop", nonce: randomUUID(),
        claimedAt: new Date(t.ms), heartbeat: new Date(t.ms), displayName: "ohmail on the laptop",
      }),
    });
    t.advance(MIN_PERMIT_TTL_MS);
    await expect(permit.check()).rejects.toBeInstanceOf(OrganizerStandDownError);

    // AND IT STAYS ANSWERED. The latch outlives the throw that carried it, which is the whole
    // reason the question can be asked at the END of a pass whose cycle swallowed the refusal.
    expect(leaseStoodDown(permit)).toBe(true);
  });
});

/**
 * THE ROW FOLLOWS THE CLAIM — the permit's half, for every caller. A claim on the server with the
 * caller's row still saying `reader` is admissible only inside the lease's own act, never across a round
 * trip: the row is what every write door consults, so an install in that window refuses its own requests
 * `409 organized_elsewhere`, naming itself. The phone and the worker write the row before taking their
 * permit; a caller with no `adopt` cannot, because the claim and the verify both happen inside the
 * acquisition. `onClaimHeld` is that one place. MUTATIONS WATCHED, restored by `cmp`: `announceHeld`
 * moved after `await takeBaseline(...)` reddens the order assertion; the one-shot latch removed
 * reddens the renewal case at two calls for one permit.
 *
 * WHAT THE ORDER LOG MEASURES, re-derived when the baseline reading moved to the claim's instant:
 * the invariant is that NOTHING IS AWAITED in front of the row, never that no IMAP command was
 * issued. The reading is issued WITH the claim now, so a call-order log would record it first and
 * say nothing about the row's wait. The stamp therefore settles a macrotask late and is logged
 * where it SETTLES — so the log answers "what ran while the permit was waiting", which is the
 * question, and a permit that awaited the reading in front of the hook still reddens it.
 */
describe("the permit announces the becoming it just took, once, before it waits on anything", () => {
  /** The reading a caller's own gate took, settling late so the order log means what it says. */
  const settlesLate = async (
    meta: FakeMetaFolder, order: string[],
  ): Promise<MetaFolderStamp | null> => {
    const st = await meta.stampMeta();
    await new Promise((r) => { setTimeout(r, 0); });
    order.push("stamp");
    return st;
  };
  /* THE SAME READING AT THE OUTCOME'S SHAPE — what an ADOPT caller hands over is the GATE's
     answer, custody and counters together, so the fixture has to be that and not bare counters. */
  const adoptedReading = async (
    meta: FakeMetaFolder, order: string[],
  ): Promise<MetaBaselineReading> => ({ custody: "held", stamp: await settlesLate(meta, order) });

  /** The folder, with the one reading this contract is about logged where it SETTLES. */
  const watched = (meta: FakeMetaFolder, order: string[]): FakeMetaFolder =>
    new Proxy(meta, {
      get(target, prop): unknown {
        if (prop === "stampMeta") {
          return async (): Promise<MetaFolderStamp | null> => settlesLate(target, order);
        }
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as FakeMetaFolder;

  it("runs between the verified claim and anything this permit waits on, exactly once", async () => {
    const meta = new FakeMetaFolder();
    const order: string[] = [];
    let appendsAtHook = -1;
    const permit = await acquireLeasePermit({
      adapter: adapterOf(watched(meta, order)), self: selfOf(), ...REQUIRED,
      onClaimHeld: ({ nonce }) => {
        order.push("held");
        appendsAtHook = meta.appends;
        // The nonce handed over is the one this permit just wrote, not the one it was asked with.
        expect(nonce).not.toBeNull();
      },
    });
    expect(order, "the becoming was announced behind a wait, or not at all").toEqual(["held", "stamp"]);
    // The CLAIM was already written and verified when the hook ran — that is what makes the row
    // it writes true rather than hopeful.
    expect(appendsAtHook, "the hook ran before the gate had written the claim").toBe(1);
    expect(permit.names.nonce).not.toBeNull();
  });

  it("a renewal does not announce a second becoming", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    let calls = 0;
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED,
      ...t.pair, ttlMs: 60_000, onClaimHeld: () => { calls++; },
    });
    t.advance(60_000);
    await permit.check();
    expect(permit.reads, "the permit did not re-read, so nothing was measured").toBe(2);
    // What the caller records here is one-shot — a press spent, a role flipped — so a renewal
    // re-announcing it is the no-op UPDATE per cycle the promotion's own header refuses to pay for.
    expect(calls).toBe(1);
  });

  it("a decision that is not `organize` announces nothing", async () => {
    const meta = new FakeMetaFolder();
    meta.messages.push({
      ref: 1,
      raw: claim({
        kind: "local", installId: "ohmail-desktop:laptop", nonce: randomUUID(),
        claimedAt: new Date(), displayName: "ohmail on the laptop",
      }),
    });
    let calls = 0;
    await expect(acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, onClaimHeld: () => { calls++; },
    })).rejects.toBeInstanceOf(OrganizerStandDownError);
    // The row must not follow a claim this install does not hold: the throw comes first.
    expect(calls, "a stand-down announced a becoming").toBe(0);
    expect(meta.appends, "and the gate wrote no claim either").toBe(0);
  });

  it("a hook that THROWS leaves the receipt issued, and says so rather than swallowing it", async () => {
    const meta = new FakeMetaFolder();
    const events: string[] = [];
    // The lease is held either way — the claim is in the folder and the verify passed — so a
    // caller whose own record failed still gets its permit; what it must not get is silence.
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED,
      onClaimHeld: () => { throw new Error("the row could not be written"); },
      log: (event) => { events.push(event); },
    });
    expect(permit.reads).toBe(1);
    expect(meta.appends).toBe(1);
    expect(events.filter((e) => e === "lease_permit_claim_held_failed"),
      "a hook that threw was swallowed in silence").toHaveLength(1);
    // And the receipt still works: a throw in the caller's bookkeeping is not a lease verdict.
    await permit.check();
    expect(permit.revoked).toBe(false);
  });

  it("an ADOPT caller is announced to as well — never silently dropped", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const order: string[] = [];
    const first = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...t.pair, ttlMs: 60_000,
    });
    await acquireLeasePermit({
      adapter: adapterOf(watched(meta, order)),
      self: { ...selfOf(), lastNonce: first.names.nonce }, ...REQUIRED,
      ...t.pair, ttlMs: 60_000,
      adopt: {
        outcome: {
          organize: true, nonce: first.names.nonce, by: null, uidValidity: null,
          stamp: adoptedReading(meta, order),
        },
        at: new Date(t.ms),
      },
      onClaimHeld: () => { order.push("held"); },
    });
    // That caller decided before it called, so this runs at entry rather than at the decision —
    // no later than the permit's first await, which is what the invariant needs. A hook the adopt
    // path ignored would be the worst of the three answers: wired, believed, and never run.
    expect(order).toEqual(["held", "stamp"]);
  });
});

/**
 * ═══ THE BASELINE AND THE CLAIM ARE ONE READING ══════════════════════════════════════════════
 *
 * `LEASE-BASELINE-CAPTURED-AFTER-TAKEOVER-WINDOW`. The permit's baseline is the folder reading
 * every later write boundary compares against, and it used to be taken AFTER the caller's row
 * write rather than with the claim. A take-over landing in that gap was baked into the baseline,
 * so every boundary answered "nothing moved" while somebody else moved the folder — for a whole
 * TTL or the whole write budget, which is two organizers across the hand-over. The adopt arm had the
 * same gap and wider: the adopted read is the CALLER's, and both adopt callers write a row inside
 * it.
 *
 * THE FIX IS AN ORDER, not a comparison: the reading is issued the instant the gate's last write
 * lands and travels on the outcome, so anything arriving afterwards is OUTSIDE the baseline and
 * the first write boundary's probe sees it. What it does about that is unchanged and deliberate —
 * a STATUS says something moved, never who, and only the gate may reach a verdict. `ohmail/_meta`
 * carries request records, acks and the settings document as well as claims, so a permit refusing
 * on a counter delta would stand an organizer down because a reader pressed a button
 * (`lease-permit-takeover.imap.test.ts` drives that benign case against a real server).
 *
 * ── MUTATIONS WATCHED (each restored by copying the pristine file back, verified by `cmp`) ───
 *
 *  a.  the baseline is taken inside the permit again (`takeBaseline` ignores the reading it is
 *      handed and asks `stampIo` itself)
 *      ⇒ both take-over cases RED: the foreign claim is inside the baseline, every boundary reads
 *        "nothing moved", and the permit keeps authorizing writes. The defect, exactly.
 *  b.  `readMailboxLease` returns `stamp: Promise.resolve(null)` instead of issuing the reading
 *      ⇒ both take-over cases RED and the cost case RED: an unstamped permit rides its clock.
 */
describe("a permit's baseline is the reading its own claim was verified in", () => {
  /** The laptop, taking the mailbox — an incumbent by `claimedAt`, which is what wins arm 3. */
  const laptopClaim = (at: number): string => claim({
    kind: "local", installId: "ohmail-desktop:laptop", nonce: randomUUID(),
    claimedAt: new Date(at - 600_000), heartbeat: new Date(at), displayName: "ohmail on the laptop",
  });

  it("a take-over landing while the row is written is outside the baseline: the next write loses", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    // THE GAP, made reachable: `onClaimHeld` is the caller's row write, and it is the one thing
    // that runs between the verified claim and the baseline. A real hand-over APPENDS, so the
    // fixture appends — both counters move, which is what a claim swapped in place would not do.
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED,
      ...t.pair, ttlMs: 60_000,
      onClaimHeld: async () => { await meta.appendClaim(laptopClaim(t.ms)); },
    });
    expect(permit.reads).toBe(1);
    expect(permit.revoked, "the acquisition itself refused — this case measures the boundary").toBe(false);

    // Neither bound is near: 1 s of a 60 s permit, one write boundary of the budget. What refuses
    // this write has to be the folder having moved since the reading the claim was verified in.
    t.advance(1_000);
    const err = await permit.check().then(() => null, (e: unknown) => e);
    expect(err, "the permit authorized a write to a mailbox the laptop now organizes")
      .toBeInstanceOf(OrganizerStandDownError);
    // AND IT NAMES THE HOLDER, because the gate decided it and not the probe: a counter delta
    // knows only that something landed.
    expect((err as OrganizerStandDownError).reason).toBe("organized_elsewhere:local");
    expect((err as OrganizerStandDownError).heldBy).toBe("ohmail on the laptop");
    expect(permit.revoked).toBe(true);
    expect(permit.probes, "the boundary did not probe the folder at all").toBe(1);
  });

  it("the adopt arm too — the caller's own gap is the wider one, and the reading comes with it", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const outcome = await readMailboxLease({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, now: new Date(t.ms), onNonceMinted: () => undefined,
    });
    expect(outcome.organize, "the fixture's own gate did not take the mailbox").toBe(true);
    if (!outcome.organize) return;

    // THE CALLER'S GAP: between its gate and the permit it writes the row that follows the claim —
    // a database transaction, not a microtask. The hand-over lands inside it.
    await meta.appendClaim(laptopClaim(t.ms));

    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: { ...selfOf(), lastNonce: outcome.nonce }, ...REQUIRED,
      ...t.pair, ttlMs: 60_000,
      adopt: { outcome, at: new Date(t.ms) },
    });
    t.advance(1_000);
    const err = await permit.check().then(() => null, (e: unknown) => e);
    expect(err, "the adopted baseline swallowed the take-over that landed before this permit existed")
      .toBeInstanceOf(OrganizerStandDownError);
    expect((err as OrganizerStandDownError).reason).toBe("organized_elsewhere:local");
    expect(permit.revoked).toBe(true);
  });

  it("costs no round trip it did not cost before: one STATUS per read, and a quiet folder is free", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...t.pair, ttlMs: 60_000,
    });
    // THE WHOLE ADDED COST, counted rather than claimed. The reading moved to the claim's instant;
    // it did not become a second one.
    expect(meta.stamps, "the acquisition paid more than one STATUS").toBe(1);

    for (let i = 0; i < 10; i++) { t.advance(100); await permit.check(); }
    // Ten boundaries, ten probes, no gate run — the baseline is current, so nothing looks again.
    expect(permit.reads, "a folder nobody touched cost a gate run").toBe(1);
    expect(permit.probes).toBe(10);
    expect(meta.stamps, "a boundary paid more than one STATUS").toBe(11);
    expect(meta.appends, "the permit renewed against a folder that had not moved").toBe(1);
  });

  it("an adopt caller pays it once, in its own gate — the permit adds nothing", async () => {
    const meta = new FakeMetaFolder();
    const t = new PermitClock(1_000_000);
    const outcome = await readMailboxLease({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, now: new Date(t.ms), onNonceMinted: () => undefined,
    });
    expect(outcome.organize).toBe(true);
    if (!outcome.organize) return;
    expect(meta.stamps, "the gate's own reading was not taken, or was taken twice").toBe(1);

    await acquireLeasePermit({
      adapter: adapterOf(meta), self: { ...selfOf(), lastNonce: outcome.nonce }, ...REQUIRED,
      ...t.pair, ttlMs: 60_000, adopt: { outcome, at: new Date(t.ms) },
    });
    // The permit adopts the read AND the reading. A second STATUS here is the gap this row closes.
    expect(meta.stamps, "the permit took a reading of its own after the caller's gap").toBe(1);
  });
});

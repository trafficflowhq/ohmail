import { afterEach, describe, expect, it, vi } from "vitest";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { acquireLeasePermit, readMailboxLease } from "../src/lease.js";
import { FakeMetaFolder } from "./_fakeadapter.js";
import { PermitClock } from "./_permit-clock.js";

/**
 * A PERMIT'S AGE IS ONE READING OF TWO CLOCKS. The receipt was aged by the
 * wall clock alone, so a clock set back extended it by the whole step. `permitAge()` is the larger
 * of the wall and monotonic deltas: the monotonic one carries a step back, the wall one a suspend
 * (which CLOCK_MONOTONIC does not count), and a step forward only expires the receipt early.
 * Mutations watched red: the age as the wall delta alone, and as the monotonic delta alone.
 */

const selfOf = () => ({ installId: "ohmail-cloud:test", kind: "cloud" as const, displayName: "ohmail Cloud", lastNonce: null });
const REQUIRED = { mailboxId: "m-1", hasRequestKey: false } as const;
const adapterOf = (meta: FakeMetaFolder): MailboxAdapter => ({ leaseIo: () => meta }) as unknown as MailboxAdapter;
const TEN_MINUTES = 10 * 60 * 1000;

async function permitOn(clock: PermitClock) {
  return acquireLeasePermit({ adapter: adapterOf(new FakeMetaFolder()), self: selfOf(), ...REQUIRED, ...clock.pair, ttlMs: 60_000 });
}

describe("the permit's age: one reading, two clocks", () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  it("a wall clock set back ten minutes does not extend the receipt past its TTL", async () => {
    const clock = new PermitClock(10_000_000);
    const permit = await permitOn(clock);
    clock.stepWall(-TEN_MINUTES);
    clock.advance(61_000);
    await permit.check();
    expect(permit.reads, "61 s of real time passed; the receipt is past its TTL").toBe(2);
  });

  it("…nor keeps the write door open past the window a peer reads the claim fresh in", async () => {
    const clock = new PermitClock(10_000_000);
    const permit = await permitOn(clock);
    clock.stepWall(-TEN_MINUTES);
    clock.advance(460_000);
    expect(permit.standing(), "460 s passed; the held window is 450 s").toBe("stale");
  });

  it("a suspend — the wall moves, the monotonic clock does not — still ages the receipt", async () => {
    const clock = new PermitClock(10_000_000);
    const permit = await permitOn(clock);
    clock.stepWall(460_000);
    expect(permit.standing()).toBe("stale");
  });

  it("a wall clock set forward only expires the receipt early: one extra gate run", async () => {
    const clock = new PermitClock(10_000_000);
    const permit = await permitOn(clock);
    clock.stepWall(61_000);
    await permit.check();
    expect(permit.reads).toBe(2);
  });

  it("an adopted look is aged from its own instant, on the monotonic clock too", async () => {
    const clock = new PermitClock(10_000_000);
    const meta = new FakeMetaFolder();
    const outcome = await readMailboxLease({ adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, now: clock.now(), onNonceMinted: () => undefined });
    if (!outcome.organize) throw new Error("an empty folder organizes");
    const at = clock.now();
    clock.advance(30_000);
    const permit = await acquireLeasePermit({
      adapter: adapterOf(meta), self: selfOf(), ...REQUIRED, ...clock.pair, ttlMs: 60_000, adopt: { outcome, at },
    });
    clock.stepWall(-TEN_MINUTES);
    clock.advance(31_000);
    await permit.check();
    expect(permit.reads, "61 s since the adopted look, 31 s since this call").toBe(2);
  });

  it("refuses one clock without the other", async () => {
    const clock = new PermitClock(10_000_000);
    await expect(acquireLeasePermit({
      adapter: adapterOf(new FakeMetaFolder()), self: selfOf(), ...REQUIRED, now: clock.now,
    } as unknown as Parameters<typeof acquireLeasePermit>[0])).rejects.toThrow(/one pair/);
  });

  it("refuses a runtime with no monotonic clock rather than aging by the wall alone", async () => {
    vi.stubGlobal("performance", undefined);
    await expect(acquireLeasePermit({ adapter: adapterOf(new FakeMetaFolder()), self: selfOf(), ...REQUIRED }))
      .rejects.toThrow(/performance\.now/);
  });

  it("POSITIVE CONTROL — neither clock supplied: the real pair, and the permit is granted", async () => {
    const permit = await acquireLeasePermit({ adapter: adapterOf(new FakeMetaFolder()), self: selfOf(), ...REQUIRED });
    expect(permit.reads).toBe(1);
    expect(permit.standing()).toBe("held");
  });
});

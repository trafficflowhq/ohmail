import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { imapAdmissionKey, makeOwnedDb, acquireImapSlot, releaseImapSlot, type OwnedDb } from "@trafficflow/db/cloud";
import { authThrottle } from "@trafficflow/db/cloud";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable, serviceUp } from "@trafficflow/db/testing";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { ServiceError } from "@trafficflow/services";
import {
  makeImapProbe, probeAdmissionKey, MAX_PROBES_PER_ADDRESS,
} from "../src/imap-probe.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * **THE PROBE AGAINST A REAL IMAP SERVER AND A REAL POSTGRES.**
 *
 * Everything in `imap-probe-classify.wprobe.test.ts` is a fabricated error object, which proves
 * the ORDER of the classifier and nothing about whether a real server produces the shapes it
 * reads. And PGlite is a single connection, so the admission counter's whole subject — one
 * claimant blocking on another's row lock — is unreachable there. CLAUDE.md's rule, both halves.
 *
 * So this file dials for real:
 *
 *  · **Dovecot on 127.0.0.1:3144** (`test/dovecot/dovecot.conf`) has a STATIC passdb with
 *    `password=testpass-password`, so the right password logs in and any other is refused by the server
 *    itself. That is the `auth` verdict proven by a mail server rather than by a fixture — and it
 *    is the case that must never be produced by a busy provider, which is the whole of
 *    an earlier change and of this change's copy.
 *  · **127.0.0.1:1**, where nothing listens, for a real `ECONNREFUSED`.
 *  · **The docker Postgres on :5433** for the counter, over `makeOwnedDb`'s pool of FIVE — the
 *    number matters and `max: 1` would make this test prove nothing, because five claimants on
 *    one backend serialise into five sequential increments and the row lock is never contended.
 *
 * The suite's network hook (`test/setup/no-external-network.ts`) permits loopback and only
 * loopback, so nothing here can accidentally become a test that dials somebody's real provider.
 *
 * To watch the admission assertion bite, raise `MAX_PROBES_PER_ADDRESS`: the last test stops
 * refusing.
 */

const HAVE_PG = await realPgAvailable();
const IMAP_HOST = process.env.PROBE_IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.PROBE_IMAP_PORT ?? 3144);
const IMAP_PASS = "testpass-password";

/** Is the dovecot harness up? The run's one probe (test/setup/services.global.ts); skipped, not failed, without it. */
const HAVE_IMAP = serviceUp("dovecot", `${IMAP_HOST}:${IMAP_PORT}`).up;

const NOW = new Date("2026-08-04T12:00:00.000Z");

describe.skipIf(!HAVE_PG)("the add-time probe, live", () => {
  let owned: OwnedDb | null = null;
  let depsList: ApiDeps[] = [];
  const keys: string[] = [];

  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    owned = makeOwnedDb(PG_TEST_URL);
    // Five `ApiDeps` over one pool of five: each concurrent acquire takes its own backend, so
    // the row lock is genuinely contended. They are separate objects rather than one reused
    // handle because production has five INSTANCES, and the point is that the bound is global.
    for (let i = 0; i < 5; i += 1) {
      // The REAL counter: one of the cases below is "concurrent probes for one address are capped",
      // so a stub would leave that assertion testing the stub. `runMigrations` replayed both
      // journals here, so `auth_throttle` exists.
      depsList.push({
        db: owned.db, now: () => NOW,
        services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
      } as unknown as ApiDeps);
    }
  }, 60_000);

  afterAll(async () => {
    for (const k of keys) {
      await owned?.db.delete(authThrottle)
        .where(eq(authThrottle.key, imapAdmissionKey(k))).catch(() => undefined);
    }
    await owned?.close();
    owned = null;
    depsList = [];
    vi.restoreAllMocks();
  });

  const freshAddress = (): string => `probe-${randomUUID().slice(0, 8)}@trafficflow.test`;

  const track = (accountId: string, address: string): string => {
    const k = probeAdmissionKey(accountId, address);
    keys.push(k);
    return k;
  };

  it.skipIf(!HAVE_IMAP)("a real login a real server ACCEPTS is `ok`", async () => {
    const accountId = randomUUID();
    const address = freshAddress();
    track(accountId, address);
    const verdict = await makeImapProbe(depsList[0]!)({
      accountId, address,
      imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: address, pass: IMAP_PASS },
    });
    // The verdict now carries the PROVEN combination — the explicit host/port/mode this test
    // supplied, echoed back because it is what a create would store. A real server proved it.
    expect(verdict).toEqual({
      verdict: "ok",
      proven: { host: IMAP_HOST, port: IMAP_PORT, secure: false },
    });
  }, 30_000);

  /**
   * THE ONE THAT MATTERS. A wrong password, refused by a server that really parsed it.
   *
   * `imapflow` stamps `authenticationFailed` on this AND on every other LOGIN failure, so a
   * classifier that reads the flag first answers `auth` here by luck rather than by evidence.
   * The value of this case is that it is the ONE where `auth` is the true answer, so it pins the
   * bottom of the order while the specimen table pins everything above it.
   */
  it.skipIf(!HAVE_IMAP)("a real login a real server REFUSES is `refuse`/`auth`", async () => {
    const accountId = randomUUID();
    const address = freshAddress();
    track(accountId, address);
    const verdict = await makeImapProbe(depsList[0]!)({
      accountId, address,
      imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: address, pass: "not-the-password" },
    });
    expect(verdict).toEqual({ verdict: "refuse", code: "auth" });
  }, 30_000);

  it("a port with nothing behind it is `refuse`/`connect`, not a rejected password", async () => {
    const accountId = randomUUID();
    const address = freshAddress();
    track(accountId, address);
    const verdict = await makeImapProbe(depsList[0]!)({
      accountId, address,
      // Port 1 on loopback: a real SYN, a real RST, a real ECONNREFUSED. No fixture involved.
      imap: { host: "127.0.0.1", port: 1, secure: false, user: address, pass: "irrelevant-password" },
    });
    expect(verdict).toEqual({ verdict: "refuse", code: "connect" });
  }, 30_000);

  it("every finished probe leaves the counter at zero, whatever the verdict", async () => {
    const accountId = randomUUID();
    const address = freshAddress();
    const key = track(accountId, address);
    const probe = makeImapProbe(depsList[0]!);
    const target = { host: "127.0.0.1", port: 1, secure: false, user: address, pass: "irrelevant-password" };
    for (let i = 0; i < 3; i += 1) await probe({ accountId, address, imap: target });
    const [row] = await depsList[0]!.db.select().from(authThrottle)
      .where(eq(authThrottle.key, imapAdmissionKey(key)));
    // Three refusals in a row do not accumulate. A counter that only ever went up would lock
    // somebody out of their own mailbox for a window after three typos.
    expect(row?.failures).toBe(0);
  }, 30_000);

  /**
   * THE ADMISSION ITSELF, under genuine parallelism on real Postgres.
   *
   * The counter's own race is proven in `packages/db/test/imap-admission.at2.pg.test.ts`; what
   * this adds is that the PROBE participates in it — that a probe is not a second, uncounted way
   * to open an IMAP connection, which is the design constraint this slice was given.
   *
   * The dial is stubbed to a 300 ms sleep for one reason only: real logins to loopback finish in
   * single-digit milliseconds and would never overlap, so the peak concurrency would be 1 by
   * accident. The ADMISSION being measured is entirely real — five independent Postgres
   * connections, five separate `ApiDeps`.
   */
  it("concurrent probes for one address are capped, and the excess is refused, not queued", async () => {
    const accountId = randomUUID();
    const address = freshAddress();
    const key = track(accountId, address);

    let live = 0;
    let peak = 0;
    vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async () => {
      live += 1;
      if (live > peak) peak = live;
      await new Promise((r) => setTimeout(r, 300));
    });
    vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async () => { live -= 1; });

    const results = await Promise.allSettled(depsList.map((d) => makeImapProbe(d)({
      accountId, address,
      imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, user: address, pass: IMAP_PASS },
    })));
    vi.restoreAllMocks();

    const admitted = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected");
    expect(admitted.length).toBeLessThanOrEqual(MAX_PROBES_PER_ADDRESS);
    // The sockets, not just the answers: this is the number the provider counts.
    expect(peak).toBeLessThanOrEqual(MAX_PROBES_PER_ADDRESS);
    expect(refused.length).toBe(depsList.length - admitted.length);
    expect(refused.length).toBeGreaterThan(0);

    // A refusal is OURS and says so: 429, retryable, and no verdict about the mailbox.
    for (const r of refused) {
      const err = (r as PromiseRejectedResult).reason as ServiceError;
      expect(err).toBeInstanceOf(ServiceError);
      expect(err.code).toBe("mailbox_busy");
      expect(err.httpStatus).toBe(429);
      expect(err.retryable).toBe(true);
    }

    // And the burst does not leave the address locked out: every slot came back.
    const [row] = await depsList[0]!.db.select().from(authThrottle)
      .where(eq(authThrottle.key, imapAdmissionKey(key)));
    expect(row?.failures).toBe(0);
  }, 60_000);
});

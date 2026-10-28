import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { imapAdmissionKey, acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { authThrottle } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { ServiceError } from "@trafficflow/services";
import { makeOpenAdapter, MAX_IMAP_PER_MAILBOX } from "../src/attachments-adapter.js";
import { PART_FETCHES_PER_MAILBOX } from "../../client-engine/src/part-lane.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * Gap **THE API COULD OPEN UNLIMITED CONCURRENT IMAP LOGINS FOR ONE MAILBOX.**
 *
 * `makeOpenAdapter` built a fresh `ImapAdapter` and did a full LOGIN + LIST per request, with no
 * cap of any kind. The worker holds one persistent connection per mailbox; nothing bounded the
 * API's contribution on top of it. Providers cap concurrent connections per account — iCloud
 * notably low — and the consequence is not a failed download. It is this:
 *
 *   imapflow sets `err.authenticationFailed = true` for EVERY failure of the LOGIN command
 *   (`imapflow/lib/commands/login.js:38`, unconditional in the catch), the worker's
 *   `classifyMailboxError` reads that flag FIRST (`apps/worker/src/mailboxes.ts:469`) and returns
 *   `"auth"`, and `apps/webapp/messages/en.json:971` renders `err_auth` as **"Sync failed — the
 *   mailbox rejected the password."** Three consecutive failures detach the mailbox.
 *
 * So an attachment burst tells the user their password is wrong and quarantines their mailbox.
 *
 * This file measures the SOCKETS, not the responses: `ImapAdapter.prototype.connect`/`close` are
 * spied so `peakLive` is the real high-water mark of simultaneously-open connections that
 * `makeOpenAdapter` produced. Before the fix, six concurrent opens produced six.
 */

/**
 * A live-connection counter around the two lifecycle methods `makeOpenAdapter` drives.
 *
 * Membership is keyed on the ADAPTER INSTANCE rather than counted, and that is not fussiness: a
 * naive `live -= 1` in the close spy double-counts a double close and so UNDER-reports the peak —
 * it masked the very defect the idempotence test exists to catch. A socket is open or it is not,
 * and closing a closed socket is not a socket closing.
 */
function trackConnections(): { peakLive: () => number; live: () => number; opened: () => number } {
  const open = new WeakSet<object>();
  let live = 0;
  let peak = 0;
  let opened = 0;
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: object) {
    // A real LOGIN + LIST is 1–3 s. The delay is what makes the opens genuinely OVERLAP: without
    // it each promise would resolve before the next was scheduled and the peak would be 1 by
    // accident, which is the shape of a concurrency test that proves nothing.
    await new Promise((r) => setTimeout(r, 20));
    if (open.has(this)) return;
    open.add(this);
    live += 1;
    opened += 1;
    if (live > peak) peak = live;
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async function (this: object) {
    if (!open.has(this)) return;
    open.delete(this);
    live -= 1;
  });
  vi.spyOn(ImapAdapter.prototype, "fetchPart").mockResolvedValue({
    contentType: "application/pdf", filename: "x.pdf", body: new Uint8Array([1]),
  });
  return { peakLive: () => peak, live: () => live, opened: () => opened };
}

/** A real (PGlite) database with one mailbox + its IMAP credential row. */
async function seed(): Promise<{ deps: ApiDeps; mailboxId: string; otherMailboxId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const ids: string[] = [];
  for (const address of ["a@example.invalid", "b@example.invalid"]) {
    const [row] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address })
      .returning({ id: mailboxes.id });
    await db.insert(mailboxCredentials).values({
      mailboxId: row!.id,
      transport: "imap",
      secretEnc: "enc",
      keyVersion: 1,
      meta: { host: "imap.example.invalid", port: 993, secure: true, user: address },
    });
    ids.push(row!.id);
  }
  const deps = {
    db,
    // The decrypted value is never asserted on and never printed — only that a fetch was possible.
    keyProvider: { decrypt: async () => "not-printed" },
    // The cap is injected now (`ImapAdmissionPort`), and this file must pass the REAL counter: every
    // assertion below is about `auth_throttle` and about two adapters contending through it, so a
    // stub would leave the whole file testing its own stub.
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
  } as unknown as ApiDeps;
  return { deps, mailboxId: ids[0]!, otherMailboxId: ids[1]! };
}

/** Open `n` handles at once and report what happened to each. */
async function openConcurrently(
  deps: ApiDeps, mailboxId: string, n: number, waitMs: number,
): Promise<{ handles: { close(): Promise<void> }[]; refusals: ServiceError[]; other: unknown[] }> {
  const open = makeOpenAdapter(deps, { waitMs });
  const settled = await Promise.allSettled(Array.from({ length: n }, () => open(mailboxId)));
  const handles: { close(): Promise<void> }[] = [];
  const refusals: ServiceError[] = [];
  const other: unknown[] = [];
  for (const s of settled) {
    if (s.status === "fulfilled") handles.push(s.value);
    else if (s.reason instanceof ServiceError && s.reason.code === "mailbox_busy") refusals.push(s.reason);
    else other.push(s.reason);
  }
  return { handles, refusals, other };
}

/** What the SHARED counter row says is held for this mailbox — what another instance would read. */
async function slotCount(deps: ApiDeps, mailboxId: string): Promise<number> {
  const rows = await deps.db.select({ failures: authThrottle.failures }).from(authThrottle)
    .where(eq(authThrottle.key, imapAdmissionKey(mailboxId)));
  return rows[0]?.failures ?? 0;
}

let track: ReturnType<typeof trackConnections>;

beforeEach(() => { track = trackConnections(); });
afterEach(() => { vi.restoreAllMocks(); });

describe("concurrent IMAP logins per mailbox are capped", () => {
  it("the client engine never asks one mailbox for more parts at once than this door admits", () => {
    expect(PART_FETCHES_PER_MAILBOX).toBeLessThanOrEqual(MAX_IMAP_PER_MAILBOX);
  });

  it("six simultaneous opens on ONE mailbox never exceed the cap", async () => {
    const { deps, mailboxId } = await seed();

    const { handles, refusals, other } = await openConcurrently(deps, mailboxId, 6, 30);
    try {
      expect(other, "an unexpected rejection — see the reason").toEqual([]);
      // THE ASSERTION THIS FILE EXISTS FOR. Before the fix this was 6.
      expect(track.peakLive()).toBeLessThanOrEqual(MAX_IMAP_PER_MAILBOX);
      expect(handles.length).toBeLessThanOrEqual(MAX_IMAP_PER_MAILBOX);
      // The refused ones are REFUSED, not hung and not lied to.
      expect(refusals.length).toBe(6 - handles.length);
      for (const r of refusals) {
        expect(r.httpStatus).toBe(429);
        // The sentence a user reads must not mention credentials — that is the lie this cap is about.
        expect(r.message).not.toMatch(/password|credential|auth/i);
        expect(r.retryable).toBe(true);
      }
    } finally {
      await Promise.all(handles.map((h) => h.close()));
    }
  });

  it("a refusal names a wait the client can act on", async () => {
    const { deps, mailboxId } = await seed();
    const { handles, refusals } = await openConcurrently(deps, mailboxId, 6, 30);
    try {
      expect(refusals.length).toBeGreaterThan(0);
      // `retryAfter`, the one spelling the envelope turns into `Retry-After`.
      const details = refusals[0]!.details as { retryAfter?: number };
      expect(typeof details?.retryAfter).toBe("number");
      expect(details.retryAfter).toBeGreaterThan(0);
    } finally {
      await Promise.all(handles.map((h) => h.close()));
    }
  });

  it("closing a handle returns its slot — the cap throttles, it does not permanently spend", async () => {
    const { deps, mailboxId } = await seed();
    const open = makeOpenAdapter(deps, { waitMs: 30 });

    const first = await open(mailboxId);
    await first.close();
    const second = await open(mailboxId);
    await second.close();
    const third = await open(mailboxId);
    await third.close();

    // Three SEQUENTIAL fetches must all succeed — a user clicking one attachment after another
    // must never be refused. This is the assertion an open-RATE limiter could not satisfy.
    expect(track.opened()).toBe(3);
    expect(track.live()).toBe(0);
  });

  it("two DIFFERENT mailboxes do not contend — one provider must not starve the other", async () => {
    const { deps, mailboxId, otherMailboxId } = await seed();
    const open = makeOpenAdapter(deps, { waitMs: 30 });

    const a = await Promise.all([open(mailboxId), open(mailboxId)]);
    const b = await Promise.all([open(otherMailboxId), open(otherMailboxId)]);
    try {
      expect(a.length + b.length).toBe(4);
      expect(track.peakLive()).toBe(4);
    } finally {
      await Promise.all([...a, ...b].map((h) => h.close()));
    }
  });

  it("a waiter is admitted the moment a holder closes", async () => {
    const { deps, mailboxId } = await seed();
    const open = makeOpenAdapter(deps, { waitMs: 2_000 });

    const held = await Promise.all(
      Array.from({ length: MAX_IMAP_PER_MAILBOX }, () => open(mailboxId)),
    );
    // This one has nowhere to go until a holder leaves.
    const waiter = open(mailboxId);
    let resolved = false;
    void waiter.then(() => { resolved = true; }, () => { /* asserted below */ });
    await new Promise((r) => setTimeout(r, 60));
    expect(resolved, "the waiter must not be admitted while the cap is full").toBe(false);

    await held[0]!.close();
    const admitted = await waiter;
    try {
      expect(track.peakLive()).toBeLessThanOrEqual(MAX_IMAP_PER_MAILBOX);
    } finally {
      await admitted.close();
      await Promise.all(held.slice(1).map((h) => h.close()));
    }
  });

  it("the DEFAULTS cap — production passes no options at all", async () => {
    const { deps, mailboxId } = await seed();
    // `routes/attachments.ts` calls `makeOpenAdapter(deps)` with no second argument on all three
    // byte routes. Every other test here passes a short `waitMs` to stay fast, so without this one
    // the whole file could pass while the shipped default admitted everything.
    const open = makeOpenAdapter(deps);

    const settled = await Promise.allSettled([open(mailboxId), open(mailboxId), open(mailboxId)]);
    const handles = settled.flatMap((s) => (s.status === "fulfilled" ? [s.value] : []));
    try {
      expect(handles.length).toBe(MAX_IMAP_PER_MAILBOX);
      expect(track.peakLive()).toBeLessThanOrEqual(MAX_IMAP_PER_MAILBOX);
      const refused = settled.find((s) => s.status === "rejected");
      expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(ServiceError);
      expect(((refused as PromiseRejectedResult).reason as ServiceError).code).toBe("mailbox_busy");
    } finally {
      await Promise.all(handles.map((h) => h.close()));
    }
  }, 15_000);

  it("the CROSS-INSTANCE counter is really consulted, not just the in-process one", async () => {
    const { deps, mailboxId } = await seed();
    const open = makeOpenAdapter(deps, { waitMs: 30 });

    // Without this assertion the whole database tier could be deleted and every other test in this
    // file would still pass: they all run in ONE process, where the in-process semaphore alone
    // caps everything. On a serverless host that is the difference between bounding an ACCOUNT and
    // bounding one warm instance the user's requests may never share.
    expect(await slotCount(deps, mailboxId)).toBe(0);
    const held = await open(mailboxId);
    expect(await slotCount(deps, mailboxId), "a second instance must be able to SEE this connection").toBe(1);

    await held.close();
    expect(await slotCount(deps, mailboxId), "and must see it go away").toBe(0);
  });

  it("a connection that FAILS to come up returns its slot", async () => {
    const { deps, mailboxId } = await seed();
    vi.spyOn(ImapAdapter.prototype, "connect").mockRejectedValue(new Error("greeting timeout"));
    const open = makeOpenAdapter(deps, { waitMs: 30 });

    // Fail the cap's worth of opens. If the failure path leaked its slot, the mailbox would be
    // permanently unusable — a worse outage than the one the cap prevents.
    for (let i = 0; i < MAX_IMAP_PER_MAILBOX + 2; i += 1) {
      await expect(open(mailboxId)).rejects.toThrow(/greeting timeout/);
    }

    vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
    const handle = await open(mailboxId);
    await handle.close();
  });

  it("close() is idempotent — a double close must not hand back a slot twice", async () => {
    const { deps, mailboxId } = await seed();
    const open = makeOpenAdapter(deps, { waitMs: 30 });

    // `downloadAll`'s `finally` and an error path can both reach `close()`. A release that ran
    // twice would hand back a slot that was never taken, so the cap would silently rise by one for
    // every double close.
    //
    // THE ASSERTION HAS TO BE THE LIVE SOCKET COUNT, NOT THE ADMISSION COUNT, and that distinction
    // is a finding: an earlier version of this test opened six after the double close and asserted
    // two were admitted, which passed WITH the idempotence removed — the second tier caught the
    // extra admission and nothing was observable. What is observable is a THIRD socket alive at
    // once while the second handle is still open.
    const first = await open(mailboxId);
    const second = await open(mailboxId);          // the cap is now full: two live
    await first.close();
    await first.close();                           // the double close — must change nothing

    const third = await open(mailboxId);           // legitimately takes `first`'s slot
    const { handles, refusals } = await openConcurrently(deps, mailboxId, 1, 30);
    try {
      // `second` and `third` are live. A fourth may not be.
      expect(track.peakLive()).toBeLessThanOrEqual(MAX_IMAP_PER_MAILBOX);
      expect(handles.length).toBe(0);
      expect(refusals.length).toBe(1);
    } finally {
      await Promise.all([second, third, ...handles].map((h) => h.close()));
    }
  });
});

import { accountOfMailbox, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { imapAdmissionKey, acquireImapSlot, releaseImapSlot, authThrottle } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { ServiceError } from "@trafficflow/services";
import {
  closeKeptImap, makeOpenAdapter, openMailboxImap, KEPT_IMAP_IDLE_MS, KEPT_IMAP_MAX_AGE_MS, KEPT_IMAP_PROVE_AFTER_MS,
} from "../src/attachments-adapter.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE SINGLE-PART DOOR KEEPS ITS SIGN-IN FOR THE NEXT PART OF THE SAME MAILBOX, AND FOR NOTHING
 * ELSE. A letter's embedded pictures are one request each; each used to dial, sign in and list the
 * folders. With `keep`, the connection a request gives back waits a short while for the next request
 * of the same mailbox and the same stored sign-in. These cases drive the real admission counter
 * (PGlite) and count sign-ins on spied `ImapAdapter` lifecycle methods.
 */

/** `logouts` are polite LOGOUTs (`close`); `drops` destroy the socket (`forceClose`). */
interface Track { signIns: () => number; logouts: () => number; drops: () => number; live: () => number }

function track(): Track {
  const open = new WeakSet<object>();
  let signIns = 0;
  let logouts = 0;
  let drops = 0;
  let live = 0;
  vi.spyOn(ImapAdapter.prototype, "connect").mockImplementation(async function (this: object) {
    open.add(this); signIns += 1; live += 1;
  });
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async function (this: object) {
    if (!open.has(this)) return;
    open.delete(this); logouts += 1; live -= 1;
  });
  vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(function (this: object) {
    if (!open.has(this)) return;
    open.delete(this); drops += 1; live -= 1;
  });
  vi.spyOn(ImapAdapter.prototype, "noop").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "isLive").mockImplementation(function (this: object) { return open.has(this); });
  vi.spyOn(ImapAdapter.prototype, "fetchPart").mockResolvedValue({ contentType: "image/png", filename: null, body: new Uint8Array([1]) });
  return { signIns: () => signIns, logouts: () => logouts, drops: () => drops, live: () => live };
}

const locator = { folder: "INBOX", ref: "1:7" } as const;

/** Two accounts; the first holds two mailboxes, the second one. Every mailbox has its IMAP sign-in. */
async function seed() {
  const db = await makeTestDb();
  const accountA = randomUUID();
  const accountB = randomUUID();
  const mailbox = async (accountId: string, address: string): Promise<string> => {
    const [row] = await db.insert(mailboxes).values({ accountId, provider: "imap", address }).returning({ id: mailboxes.id });
    await db.insert(mailboxCredentials).values({
      mailboxId: row!.id, accountId: accountOfMailbox(row!.id), transport: "imap", secretEnc: "sealed", keyVersion: 1,
      meta: { host: "imap.example.invalid", port: 993, secure: true, user: address },
    });
    return row!.id;
  };
  const a1 = await mailbox(accountA, "a1@example.invalid");
  const a2 = await mailbox(accountA, "a2@example.invalid");
  const b1 = await mailbox(accountB, "b1@example.invalid");
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
  } as unknown as ApiDeps;
  const shared = async (mailboxId: string): Promise<number> => {
    const rows = await db.select({ n: authThrottle.failures }).from(authThrottle).where(eq(authThrottle.key, imapAdmissionKey(mailboxId)));
    return rows[0]?.n ?? 0;
  };
  return { db, deps, a1, a2, b1, shared };
}

/** One picture request: open, fetch, close — what `fetchBytes` does per request. */
async function picture(open: ReturnType<typeof makeOpenAdapter>, mailboxId: string): Promise<void> {
  const h = await open(mailboxId);
  try { await h.fetchPart(locator, "2"); } finally { await h.close(); }
}

let t: Track;
beforeEach(() => { t = track(); });
afterEach(() => {
  closeKeptImap();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the single-part door keeps one sign-in for a letter's pictures", () => {
  it("eight pictures one after the other sign in once", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    for (let i = 0; i < 8; i++) await picture(open, a1);
    expect(t.signIns()).toBe(1);
    expect(t.live()).toBe(1);
  });

  it("eight pictures two at a time sign in twice, within the mailbox's bound", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    for (let i = 0; i < 8; i += 2) await Promise.all([picture(open, a1), picture(open, a1)]);
    expect(t.signIns()).toBe(2);
  });

  it("without keep every request still signs in and logs out", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps);
    for (let i = 0; i < 3; i++) await picture(open, a1);
    expect(t.signIns()).toBe(3);
    expect(t.live()).toBe(0);
  });

  it("a waiting connection gives the shared slot back: another instance reads the mailbox as free", async () => {
    const { deps, a1, shared } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await picture(open, a1);
    expect(t.live()).toBe(1);
    expect(await shared(a1)).toBe(0);
  });
});

describe("a kept sign-in is never used for anything but its own mailbox and sign-in", () => {
  it("another mailbox of the same account signs in on its own", async () => {
    const { deps, a1, a2 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await picture(open, a1);
    await picture(open, a2);
    expect(t.signIns()).toBe(2);
  });

  it("another account's mailbox signs in on its own", async () => {
    const { deps, a1, b1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await picture(open, a1);
    await picture(open, b1);
    await picture(open, a1);
    await picture(open, b1);
    expect(t.signIns()).toBe(2);
  });

  it("a changed sign-in is not reused: the old connection is dropped and a new one signs in", async () => {
    const { db, deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await picture(open, a1);
    await db.update(mailboxCredentials).set({ secretEnc: "sealed-again", keyVersion: 2 })
      .where(and(eq(mailboxCredentials.mailboxId, a1), eq(mailboxCredentials.transport, "imap")));
    await picture(open, a1);
    expect(t.signIns()).toBe(2);
    expect(t.drops()).toBe(1);
    expect(t.live()).toBe(1);
  });

  it("a mailbox signed out here refuses, and its kept connection serves nothing", async () => {
    const { db, deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await picture(open, a1);
    await db.delete(mailboxCredentials).where(eq(mailboxCredentials.mailboxId, a1));
    await expect(open(a1)).rejects.toMatchObject({ code: "mailbox_not_signed_in" });
    expect(vi.mocked(ImapAdapter.prototype.fetchPart).mock.calls.length).toBe(1);
  });

  it("a connection that died while it waited is not used; the next request signs in afresh", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await picture(open, a1);
    vi.mocked(ImapAdapter.prototype.isLive).mockReturnValue(false);
    await picture(open, a1);
    expect(t.signIns()).toBe(2);
  });

  it("a request whose read failed never leaves its connection waiting", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    vi.mocked(ImapAdapter.prototype.fetchPart).mockRejectedValueOnce(new Error("the server dropped the line"));
    await expect(picture(open, a1)).rejects.toThrow("dropped");
    expect(t.live()).toBe(0);
    await picture(open, a1);
    expect(t.signIns()).toBe(2);
  });
});

describe("a kept connection ends", () => {
  it("is dropped after its idle time, and its slot goes back", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true, keepIdleMs: 20, maxPerMailbox: 1 });
    await picture(open, a1);
    expect(t.live()).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(t.drops()).toBe(1);
    expect(t.live()).toBe(0);
    // The slot is free: a plain opener that may not wait at all is admitted.
    const h = await openMailboxImap(deps, a1, { maxPerMailbox: 1, waitMs: 0 });
    await h.close();
  });

  it("the default idle time is short, and no kept connection is used past its age", () => {
    expect(KEPT_IMAP_IDLE_MS).toBeLessThanOrEqual(10_000);
    expect(KEPT_IMAP_MAX_AGE_MS).toBeLessThan(60_000);
  });

  it("an old connection is not used again", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await picture(open, a1);
    clock.mockReturnValue(now + KEPT_IMAP_MAX_AGE_MS);
    await picture(open, a1);
    expect(t.signIns()).toBe(2);
    expect(t.drops()).toBeGreaterThanOrEqual(1);
  });

  it("steps aside for another opener of the same mailbox instead of making it wait", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true, maxPerMailbox: 1 });
    await picture(open, a1);
    // The organizer peek and the archive door open without keep; one slot, no wait.
    const h = await openMailboxImap(deps, a1, { maxPerMailbox: 1, waitMs: 0 });
    expect(t.drops()).toBe(1);
    await h.close();
  });

  it("an opener already queueing gets the slot when a request is done, not a kept connection", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true, maxPerMailbox: 1, waitMs: 2_000 });
    const first = await open(a1);
    const queued = openMailboxImap(deps, a1, { maxPerMailbox: 1, waitMs: 2_000 });
    await new Promise((r) => setTimeout(r, 10));
    await first.close();
    const h = await queued;
    expect(t.logouts()).toBe(1);
    await h.close();
  });

  it("the shared counter refusing a kept connection's request refuses it as busy and closes the connection", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await picture(open, a1);
    (deps.services as { imapAdmission: { acquire: unknown } }).imapAdmission.acquire = async () => false;
    const err = await open(a1).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ServiceError);
    expect((err as ServiceError).code).toBe("mailbox_busy");
    expect(t.live()).toBe(0);
  });
});

describe("dropping a kept connection never waits on the mail server", () => {
  it("a server that went silent holds up neither the quit nor another opener of the mailbox", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true, maxPerMailbox: 2 });
    await Promise.all([picture(open, a1), picture(open, a1)]);
    expect(t.live()).toBe(2);
    // A LOGOUT now would never be answered.
    vi.mocked(ImapAdapter.prototype.close).mockImplementation(() => new Promise<void>(() => {}));
    const late = new Promise<string>((r) => setTimeout(() => r("waited"), 500));
    // Another opener finds both slots held by waiting connections; one steps aside at once.
    const h = await Promise.race([openMailboxImap(deps, a1, { maxPerMailbox: 2, waitMs: 0 }), late]);
    expect(h).not.toBe("waited");
    expect(t.drops()).toBe(1);
    // The quit: whatever is still kept is gone before it returns.
    const quit = await Promise.race([Promise.resolve(closeKeptImap()).then(() => "done"), late]);
    expect(quit).toBe("done");
    expect(t.drops()).toBe(2);
    await (h as Awaited<ReturnType<typeof openMailboxImap>>).forceClose();
    expect(t.live()).toBe(0);
  });

  it("the quit drops every kept connection and frees their slots", async () => {
    const { deps, a1, a2 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    await Promise.all([picture(open, a1), picture(open, a1), picture(open, a2)]);
    expect(t.live()).toBe(3);
    closeKeptImap();
    expect(t.live()).toBe(0);
    expect(t.drops()).toBe(3);
    const h = await openMailboxImap(deps, a1, { maxPerMailbox: 1, waitMs: 0 });
    await h.close();
  });
});

describe("a connection that has waited a while proves itself before it is used", () => {
  it("the pictures of one letter, right after each other, send no NOOP", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    for (let i = 0; i < 4; i++) await picture(open, a1);
    expect(vi.mocked(ImapAdapter.prototype.noop).mock.calls.length).toBe(0);
    expect(t.signIns()).toBe(1);
  });

  it("one that answers the NOOP is used again", async () => {
    const { deps, a1 } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await picture(open, a1);
    clock.mockReturnValue(now + KEPT_IMAP_PROVE_AFTER_MS);
    await picture(open, a1);
    expect(vi.mocked(ImapAdapter.prototype.noop).mock.calls.length).toBe(1);
    expect(t.signIns()).toBe(1);
  });

  it("one the server no longer answers is dropped, and the picture comes over a fresh sign-in", async () => {
    const { deps, a1, shared } = await seed();
    const open = makeOpenAdapter(deps, { keep: true });
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    await picture(open, a1);
    clock.mockReturnValue(now + KEPT_IMAP_PROVE_AFTER_MS);
    vi.mocked(ImapAdapter.prototype.noop).mockRejectedValueOnce(new Error("the server hung up"));
    await picture(open, a1);
    expect(t.signIns()).toBe(2);
    expect(t.drops()).toBe(1);
    expect(t.live()).toBe(1);
    expect(await shared(a1)).toBe(0);
  });
});

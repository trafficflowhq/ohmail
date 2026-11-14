import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxes, mailboxCredentials } from "@trafficflow/db";
import { makeDb, pushSubscriptions } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger, type Logger } from "@trafficflow/core";
import { META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { startWorker } from "../src/index.js";
import { imapCfg, rawClient } from "./_workerenv.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";

/**
 * THE PARK, ON A REAL MAILBOX (mail 0124) — the fake-fleet file's headline case, replayed against
 * GreenMail so the claim's removal is read out of the REAL `ohmail/_meta` by a second,
 * independent IMAP client. Asking the code under test where it put something proves nothing;
 * organize-in-place means the server is the fact. One case, deliberately: the mechanics'
 * permutations live in `parked-account.test.ts` on the in-memory lease, and what only this file
 * can say is that the release the roster performs reaches the wire.
 */

type Db = ReturnType<typeof makeDb>;
type Cfg = ReturnType<typeof imapCfg>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 13));
let DB = "";

function fakePlane(): { server: Server; url: () => string; parked: Set<string>; close: () => Promise<void> } {
  const parked = new Set<string>();
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      const accountId = (JSON.parse(raw || "{}") as { accountId?: string }).accountId ?? "";
      const closed = parked.has(accountId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        entitlements: {
          mailboxLimit: closed ? 0 : null, canAddMailbox: !closed, aiEnabled: !closed,
          syncEnabled: !closed, storageBytesLimit: null, reason: closed ? "canceled" : "active",
        },
        balance: 0, setupCredits: { remaining: 0, expiresAt: null },
        storageUsedBytes: 0, invoiceGranted: false, manageUrl: null,
        lifecycle: closed
          ? { state: "closed", closedReason: "trial_ended", trialEndsAt: null, graceUntil: null,
              closedAt: "2026-09-01T00:00:00.000Z", erasureAt: "2026-10-01T00:00:00.000Z",
              erasedAt: null, formerlyPaid: false }
          : { state: "active", closedReason: null, trialEndsAt: null, graceUntil: null,
              closedAt: null, erasureAt: null, erasedAt: null, formerlyPaid: false },
      }));
    });
  });
  return {
    server, parked,
    url: () => {
      const a = server.address();
      if (a === null || typeof a === "string") throw new Error("the fake plane has no port");
      return `http://127.0.0.1:${a.port}`;
    },
    close: () => new Promise((r) => { server.close(() => { r(); }); }),
  };
}

/** Every live claim in the REAL `ohmail/_meta`, by a second IMAP client (the e2e's instrument). */
async function claimsOnServer(cfg: Cfg): Promise<string[]> {
  const c = await rawClient(cfg);
  try {
    const list = await c.list();
    const path = META_FOLDER.split("/").join(".");
    if (!list.some((f) => f.path === path)) return [];
    const lock = await c.getMailboxLock(path);
    try {
      const newest = new Map<string, { installId: string; at: number }>();
      for await (const m of c.fetch("1:*", { uid: true, headers: true })) {
        if (!m.headers) continue;
        const claim = parseClaim(m.headers.toString("utf8"));
        if (!claim || "malformed" in claim) continue;
        const prior = newest.get(claim.installId);
        if (!prior || claim.heartbeat.getTime() > prior.at) {
          newest.set(claim.installId, { installId: claim.installId, at: claim.heartbeat.getTime() });
        }
      }
      return [...newest.keys()];
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function waitFor(cond: () => boolean | Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await cond()) return;
    if (Date.now() - start >= ms) throw new Error(`timed out after ${ms}ms waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

function recordingLogger(): { logger: Logger; lines: Array<Record<string, unknown>> } {
  const lines: Array<Record<string, unknown>> = [];
  return {
    lines,
    logger: createLogger({
      service: "worker", level: "info",
      sink: (l: string) => { lines.push(JSON.parse(l) as Record<string, unknown>); },
    }),
  };
}

describe("the park reaches the wire: the claim leaves the real ohmail/_meta", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_wall_e2e"); }, 60_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } }
  }, ISOLATED_DB_RESET_BUDGET_MS);

  it("claim on the server → park → claim GONE, row released, reason written, push rows gone → " +
     "reopen → Cloud's claim BACK on the server and the row organized, logged once", async () => {
    const db: Db = makeDb(DB);
    const cfg = imapCfg();
    const plane = fakePlane();
    await new Promise<void>((r) => plane.server.listen(0, "127.0.0.1", () => { r(); }));
    closers.push(plane.close);

    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "wall-e2e" });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: cfg.auth.user,
      organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 3_600_000),
    }).returning();
    const enc = await KP.encrypt(cfg.auth.pass);
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, accountId: mb!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: cfg.host, port: cfg.port, secure: false, user: cfg.auth.user },
    });
    await db.insert(pushSubscriptions).values({
      accountId, transport: "webpush", endpoint: `https://push.example/${accountId}`,
    });

    const rec = recordingLogger();
    const worker = await startWorker({
      databaseUrl: DB, keyProvider: KP, pollIntervalMs: 500, sentDomain: "trafficflow.test",
      rosterIntervalMs: 600, syncBlockGraceMs: 0, logger: rec.logger,
      organizer: { installId: "cloud-wall-e2e", displayName: "Cloud", staleAfterMs: 60_000 },
      entitlements: { url: plane.url(), secret: "x".repeat(24), accessTtlMs: 200 },
    });
    closers.push(() => worker.stop());

    await waitFor(async () => (await claimsOnServer(cfg)).includes("cloud-wall-e2e"),
      30_000, "the worker's claim to appear in the real ohmail/_meta");

    plane.parked.add(accountId);

    await waitFor(async () => (await claimsOnServer(cfg)).length === 0,
      30_000, "the claim to LEAVE the real ohmail/_meta");
    await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb!.id));
      return row!.organizerRole === "reader" && row!.syncBlockedReason === "account_closed";
    }, 30_000, "the row to be released with the account_closed reason");
    const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb!.id));
    expect(row!.organizeConsentedAt, "consent is KEPT — reopening resumes by a press").not.toBeNull();
    expect(row!.organizedByInstallId).toBeNull();
    await waitFor(async () =>
      (await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId))).length === 0,
    30_000, "the push rows to be deleted");
    expect(row!.organizerParkedAt, "the park records itself on the row").not.toBeNull();

    // THE REOPENING (mail 0135): the account pays, the plane answers open, and the wall's release is
    // asked back as a join. The server is the fact again: Cloud's claim is in the real folder.
    plane.parked.delete(accountId);
    await waitFor(async () => (await claimsOnServer(cfg)).includes("cloud-wall-e2e"),
      30_000, "Cloud's claim to be BACK in the real ohmail/_meta");
    await waitFor(async () => {
      const [r] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb!.id));
      return r!.organizerRole === "organizer" && r!.syncBlockedReason === null;
    }, 30_000, "the row to be organized again, with its account_closed cleared");
    const [back] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb!.id));
    expect(back!.syncBlockedReason).toBeNull();
    expect(back!.organizerParkedAt, "the promotion spends the marker").toBeNull();
    expect(rec.lines.filter((l) => l.event === "organizer_parked_resume" && l.mailboxId === mb!.id))
      .toHaveLength(1);
  }, 120_000);
});

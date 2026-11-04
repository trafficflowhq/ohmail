import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { contacts, rules, tags } from "@trafficflow/db";
import { META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import { formatProfileMessage, makeProfileDoc, profileCopyKey } from "@trafficflow/core/adapters/organizer-profile";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { startSlowProvider, type SlowProvider } from "./_slow-provider.js";

/**
 * IMPORT SETTINGS ON A SLOW PROVIDER, through the desktop's LOCAL door. The engine dials its
 * mailbox through a relay that delays every chunk each way (a pace per command matching the
 * measured slow provider); the independent clients below talk to the server directly. The
 * dial and the settings read no longer fit one request's budget, so the press is handed to the
 * organizer, which reads the document on its own connection and applies it.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const META_PATH = META_FOLDER.split("/").join(".");
const SLOW_MS = 1100;

async function withdrawClaim(cfg: { host: string; port: number; secure: false; auth: { user: string; pass: string } }): Promise<void> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  try {
    const lock = await c.getMailboxLock(META_PATH);
    try {
      const claimUids: number[] = [];
      for await (const m of c.fetch("1:*", { uid: true, source: true })) {
        if (m.source && parseClaim(m.source.toString("utf8")) !== null) claimUids.push(m.uid);
      }
      for (const uid of claimUids) await c.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function call(s: Sidecar, method: string, path: string, body?: unknown): Promise<{ status: number; json: any; ms: number }> {
  const t0 = Date.now();
  const res = await s.handle(new Request(`http://sidecar${path}`, {
    method,
    headers: {
      authorization: `Bearer ${s.sessionToken}`,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  }));
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null, ms: Date.now() - t0 };
}

const dirs: string[] = [];
const running: Sidecar[] = [];
const relays: SlowProvider[] = [];
afterEach(async () => {
  for (const r of relays) r.setDelay(0);
  for (const s of running.splice(0)) await s.stop().catch(() => undefined);
  for (const r of relays.splice(0)) await r.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}, 60_000);
function dataDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

/** Install A leaves a settings document and withdraws; install B attaches THROUGH the relay. */
async function travelledThroughRelay(): Promise<{ b: Sidecar; relay: SlowProvider }> {
  const user = `t-${randomUUID()}@trafficflow.test`;
  const direct = { host: IMAP_HOST, port: IMAP_PORT, secure: false as const, auth: { user, pass: "test" } };
  const a = await createSidecar({
    dataDir: dataDir("ohmail-slow-a-"), imap: direct, machineName: "the previous Mac",
    pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
  });
  await grantOrganizeConsent(a);
  running.push(a);
  await a.start();
  await a.syncUntilQuiet();
  const aId = a.world.accountId;
  await a.db.insert(contacts).values({ accountId: aId, address: "anna@x.example", name: "Anna" });
  await a.db.insert(rules).values({
    accountId: aId, kind: "sender", match: "anna@x.example", destination: "INBOX", provenance: "promoted", enabled: true,
  });
  await a.db.insert(tags).values({ accountId: aId, name: "Invoices", hue: "moss" });
  await a.syncUntilQuiet();
  await a.stop();
  await withdrawClaim(direct);

  const relay = await startSlowProvider({ host: IMAP_HOST, port: IMAP_PORT });
  relays.push(relay);
  const b = await createSidecar({
    dataDir: dataDir("ohmail-slow-b-"), imap: { ...direct, host: "127.0.0.1", port: relay.port },
    machineName: "this Mac", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
    profileFlushIntervalMs: 0, keks: { 1: randomBytes(32) },
  });
  await grantOrganizeConsent(b);
  running.push(b);
  await b.start();
  await b.syncUntilQuiet();
  return { b, relay };
}

describe("Import settings finishes on a slow provider (the desktop local door)", () => {
  it("the press is handed to the organizer, which finishes it; the card reads the result", async () => {
    const { b, relay } = await travelledThroughRelay();
    const mailboxId = b.world.mailboxId;
    const candidate = await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`);
    expect(candidate.json.state).toBe("found");
    const fingerprint = candidate.json.fingerprint as string;

    relay.setDelay(SLOW_MS);
    const press = await call(b, "POST", `/mailboxes/${mailboxId}/profile-import`, { fingerprint });
    console.log(`SLOW-PRESS status=${press.status} ms=${press.ms} code=${press.json?.error?.code ?? press.json?.state}`);
    expect(press.status, JSON.stringify(press.json)).toBe(202);
    expect(press.json).toMatchObject({ state: "importing", fingerprint, reason: "slow" });

    const status = `/mailboxes/${mailboxId}/profile-import/status?fingerprint=${encodeURIComponent(fingerprint)}`;
    expect((await call(b, "GET", status)).json).toMatchObject({ state: "importing" });

    // Nothing else is driven: the 202 itself wakes the organizer, whose drain runs the ask on
    // its own connection, still through the slow provider.
    const t0 = Date.now();
    let done = await call(b, "GET", status);
    while (done.json?.state === "importing" && Date.now() - t0 < 300_000) {
      await new Promise((r) => setTimeout(r, 2000));
      done = await call(b, "GET", status);
    }
    console.log(`SLOW-ORGANIZER ms=${Date.now() - t0} state=${done.json?.state}`);
    expect(done.json).toMatchObject({
      state: "imported",
      imported: { screener: 1, rules: 1, tags: 1 },
      skippedRules: 0,
    });
    const bId = b.world.accountId;
    expect(await b.db.select().from(contacts).where(eq(contacts.accountId, bId))).toHaveLength(1);
    expect((await b.db.select().from(tags).where(eq(tags.accountId, bId))).map((t) => t.name)).toEqual(["Invoices"]);
    expect((await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`)).json).toEqual({ state: "none" });
  }, 420_000);

  /* THE CARD'S OWN QUESTION on the same provider. A document lands while the provider is slow;
     the organizer's drain reads it on its own connection and records it, and the card is answered
     from that record — the relay counts no connection for the question. At the base the question
     re-dialled inside the 20 s door and answered 502, so the card never appeared. */
  it("the card appears after the organizer's drain on a slow provider, and its question dials nothing", async () => {
    const user = `t-${randomUUID()}@trafficflow.test`;
    const direct = { host: IMAP_HOST, port: IMAP_PORT, secure: false as const, auth: { user, pass: "test" } };
    const relay = await startSlowProvider({ host: IMAP_HOST, port: IMAP_PORT });
    relays.push(relay);
    const b = await createSidecar({
      dataDir: dataDir("ohmail-slow-card-"), imap: { ...direct, host: "127.0.0.1", port: relay.port },
      machineName: "this Mac", pollIntervalMs: 60 * 60 * 1000, leaseStaleAfterMs: 60_000,
      profileFlushIntervalMs: 0, keks: { 1: randomBytes(32) },
    });
    await grantOrganizeConsent(b);
    running.push(b);
    await b.start();
    await b.syncUntilQuiet();
    const mailboxId = b.world.mailboxId;
    expect((await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`)).json).toEqual({ state: "none" });

    // Another install's settings land in the mailbox, and the provider turns slow.
    const doc = makeProfileDoc({
      screener: [{ address: "anna@x.example" }], rules: [], notifyRules: [], awayResponder: null,
      tagNames: ["Invoices"], signature: null,
    }, { updatedAt: new Date("2026-09-20T08:00:00Z"), producer: { kind: "local", version: "0.25.1" } });
    const c = new ImapFlow({ ...direct, logger: false });
    await c.connect();
    try {
      await c.append(META_PATH, Buffer.from(formatProfileMessage(doc, { installId: "the-previous-mac" }), "utf8"));
    } finally {
      await c.logout();
    }
    relay.setDelay(SLOW_MS);
    const t0 = Date.now();
    await b.syncUntilQuiet();
    console.log(`SLOW-CARD drain ms=${Date.now() - t0}`);

    const before = relay.connections();
    const asked = await call(b, "GET", `/mailboxes/${mailboxId}/profile-import`);
    const dials = relay.connections() - before;
    console.log(`SLOW-CARD status=${asked.status} ms=${asked.ms} state=${asked.json?.state ?? asked.json?.error?.code} dials=${dials}`);
    expect(asked.status, JSON.stringify(asked.json)).toBe(200);
    expect(asked.json).toMatchObject({ state: "found", fingerprint: profileCopyKey(doc, "the-previous-mac") });
    expect(dials, "the card's question dialled the mailbox").toBe(0);
  }, 600_000);
});

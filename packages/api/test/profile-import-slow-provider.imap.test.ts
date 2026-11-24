import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, type ApiDeps } from "@trafficflow/api";
import { mailboxCredentials, mailboxes } from "@trafficflow/db";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { makeProfileDoc, profileFingerprint, writeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile";
import { makeDeps, seedSession, seedMailbox, req, FIXED_NOW } from "./helpers.js";
import { startSlowProvider, type SlowProvider } from "./_slow-provider.js";

/**
 * IMPORT SETTINGS ON A SLOW PROVIDER, through the CLOUD route: `apiRoutes` over a real IMAP server
 * behind a relay that delays every chunk each way (a slow provider's pace per command), the door budget at its
 * shipped value. The press no longer fails at the door: it is recorded on the mailbox row, the
 * worker's doorbell is rung, and the POST answers 202 with the fingerprint as its ticket. A fast
 * provider still answers in one request (the control).
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });

const relays: SlowProvider[] = [];
afterEach(async () => { for (const r of relays.splice(0)) await r.close().catch(() => undefined); });

/** A mailbox on the server carrying another install's settings document, and the account's row for it. */
async function travelled(): Promise<{ deps: ApiDeps; token: string; mailboxId: string; fingerprint: string; relay: SlowProvider }> {
  const user = `t-${randomUUID()}@trafficflow.test`;
  // The previous install's document, written by the product's own writer over a direct connection.
  const previous = new ImapAdapter({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth: { user, pass: "test" } });
  await previous.connect();
  const doc = makeProfileDoc({
    screener: [{ address: "anna@x.example", name: "Anna" }],
    rules: [{ kind: "sender", match: "anna@x.example", destination: "INBOX", priority: 0, enabled: true, provenance: "promoted" }],
    notifyRules: [], awayResponder: null, tagNames: ["Invoices"], signature: null,
  }, { updatedAt: new Date("2026-09-20T10:00:00.000Z"), producer: { kind: "local", version: "0.25.1" } });
  try {
    const written = await writeOrganizerProfile({
      io: previous.profileIo({ installId: "the-previous-mac", mailboxId: "the-previous-row" }),
      doc, installId: "the-previous-mac", replaceable: [],
    });
    expect(written.written, "the fixture document was not written").toBe(true);
  } finally {
    await previous.close();
  }
  const relay = await startSlowProvider({ host: IMAP_HOST, port: IMAP_PORT });
  relays.push(relay);
  const { db, deps } = await makeDeps();
  // `makeDeps` stubs the IMAP dial for tests that must not reach a server; this one reaches one.
  vi.restoreAllMocks();
  const s = await seedSession(db, { now: FIXED_NOW });
  const mailboxId = await seedMailbox(db, { accountId: s.accountId, address: user });
  await db.insert(mailboxCredentials).values({
    mailboxId, accountId: s.accountId, transport: "imap", secretEnc: "sealed", keyVersion: 1,
    meta: { host: "127.0.0.1", port: relay.port, secure: false, user },
  });
  // The credential is the fixture's; the key provider hands it back rather than decrypting a seal.
  const withKey = { ...deps, keyProvider: { ...deps.keyProvider, decrypt: async () => "test" } } as ApiDeps;
  return { deps: withKey, token: s.token, mailboxId, fingerprint: profileFingerprint(doc), relay };
}

describe("Import settings on a slow provider — the Cloud route", () => {
  it("the press is recorded and handed to the organizer: 202 inside the door, the ticket is the fingerprint", async () => {
    const { deps, token, mailboxId, fingerprint, relay } = await travelled();
    relay.setDelay(1100);
    const t0 = Date.now();
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import`, {
      bearer: token, body: JSON.stringify({ fingerprint }),
    }), deps);
    const ms = Date.now() - t0;
    const body = await res.json();
    console.log(`CLOUD-SLOW-PRESS status=${res.status} ms=${ms}`);
    expect(res.status, JSON.stringify(body)).toBe(202);
    expect(body).toEqual({ state: "importing", fingerprint, reason: "slow" });
    const [row] = await deps.db.select({
      fp: mailboxes.profileImportAskFingerprint, outcome: mailboxes.profileImportAskOutcome,
      rung: mailboxes.syncRequestedAt,
    }).from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row).toMatchObject({ fp: fingerprint, outcome: null });
    expect(row!.rung, "the worker's doorbell was not rung").not.toBeNull();

    const status = await H(req("GET", `/mailboxes/${mailboxId}/profile-import/status?fingerprint=${encodeURIComponent(fingerprint)}`, {
      bearer: token,
    }), deps);
    expect(await status.json()).toEqual({ state: "importing", fingerprint });

    // The same press again: the same ticket, answered from the row with no dial.
    const t1 = Date.now();
    const again = await H(req("POST", `/mailboxes/${mailboxId}/profile-import`, {
      bearer: token, body: JSON.stringify({ fingerprint }),
    }), deps);
    expect(again.status).toBe(202);
    expect(Date.now() - t1, "the repeated press dialled the slow provider").toBeLessThan(5_000);
  }, 90_000);

  it("CONTROL: a fast provider still answers in one request, with what arrived", async () => {
    const { deps, token, mailboxId, fingerprint } = await travelled();
    const res = await H(req("POST", `/mailboxes/${mailboxId}/profile-import`, {
      bearer: token, body: JSON.stringify({ fingerprint }),
    }), deps);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      imported: { screener: 1, rules: 1, notifyRules: 0, tags: 1, awayResponder: false }, skippedRules: 0,
    });
    const [row] = await deps.db.select({ fp: mailboxes.profileImportAskFingerprint })
      .from(mailboxes).where(eq(mailboxes.id, mailboxId));
    expect(row!.fp, "an inline import asked nobody").toBeNull();
  }, 60_000);
});

import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, auditLog, changeLog, mailboxes, messageBodies, messages, type Tx } from "@trafficflow/db";
import { fingerprintDedupKey, messageFingerprint, normalizeMime } from "@trafficflow/core";
import { type MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { redactedRestorePass } from "../src/redacted-restore.js";

/**
 * RESTORING THE FULL BODY OF HISTORICALLY-REDACTED SENSITIVE MAIL.
 *
 * A green run over an empty database is worthless here, so the first case seeds a real redacted
 * row and asserts the body came back AND the sensitivity flags did NOT change — the whole point
 * of this pass being separate from `sensitive-backfill.ts`. The transactional lock-and-recheck
 * (`STILL_REDACTED` re-read `FOR UPDATE`) is a single-row transaction of the exact shape
 * `sensitive-backfill.ts#repairOne` uses, whose two-driver behaviour is pinned on real Postgres in
 * `sensitive-backfill.pg.test.ts`; PGlite is single-connection, so that race is not re-observable
 * here and is not re-asserted.
 */
const CODE_TEXT = "Hi — your verification code is 482913. It expires in 10 minutes.";
const CODE_RAW = [
  "From: security@bank.example.com",
  "To: someone@ohmail.test",
  "Subject: Re: AW: AW: AW: Webshop",
  "Message-ID: <webshop-thread-9@bank.example.com>",
  "Date: Tue, 21 Jul 2026 11:46:23 +0000",
  "MIME-Version: 1.0",
  'Content-Type: multipart/alternative; boundary="bnd"',
  "",
  "--bnd",
  "Content-Type: text/plain; charset=utf-8",
  "",
  CODE_TEXT,
  "",
  "--bnd",
  "Content-Type: text/html; charset=utf-8",
  "",
  "<html><body><p>Hi — your verification code is 482913.</p></body></html>",
  "",
  "--bnd--",
  "",
].join("\r\n");
/** What was STORED: body redacted to the literal placeholder, html deleted — the old pipeline. */
const STORED_REDACTED = "Hi — your verification code is [REDACTED]. It expires in 10 minutes.";

interface World { db: Tx; accountId: string; mailboxId: string; server: Map<string, string>; }

async function newWorld(): Promise<World> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `rr-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@ohmail.test`,
  }).returning();
  return { db: db as unknown as Tx, accountId, mailboxId: mb!.id, server: new Map() };
}

/** A genuinely-sensitive row: every flag set, body the redaction placeholder, html deleted. */
async function seedRedacted(
  w: World, opts: { storedText?: string; ref?: string; identity?: "fingerprint" | "wrong" } = {},
): Promise<string> {
  const ref = opts.ref ?? `1:${Math.floor(Math.random() * 100000)}`;
  const raw = CODE_RAW.replace(/^Message-ID: <([^>]+)>$/m, `Message-ID: <${ref.replace(":", "-")}-$1>`);
  const norm = await normalizeMime(Buffer.from(raw, "utf8"));
  const dedupKey = (opts.identity ?? "fingerprint") === "wrong"
    ? `mid:somebody-elses-message@example.com`
    : fingerprintDedupKey(messageFingerprint(norm));
  const [m] = await w.db.insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId,
    messageIdHeader: (opts.identity ?? "fingerprint") === "wrong"
      ? "somebody-elses-message@example.com" : norm.canonical.messageIdHeader,
    bodyHash: norm.canonical.bodyHash, dedupKey,
    subject: norm.subject, fromAddress: norm.from.address,
    nativeLocator: { folder: "ohmail/Screened", ref },
    sensitivityCategory: "otp", noAi: true, noForward: true, noKb: true, priority: true,
    snippet: (opts.storedText ?? STORED_REDACTED).slice(0, 200),
  }).returning();
  await w.db.insert(messageBodies).values({
    messageId: m!.id, accountId: m!.accountId, text: opts.storedText ?? STORED_REDACTED, html: null, headers: { ...norm.headers },
  });
  w.server.set(ref, raw);
  return m!.id;
}

function fakeAdapter(w: World, opts: { fetchRaw?: boolean } = {}): MailboxAdapter {
  const a: Partial<MailboxAdapter> = {
    move: async () => { throw new Error("this pass must never move mail"); },
    setFlags: async () => { throw new Error("this pass must never flag mail"); },
    send: async () => { throw new Error("this pass must never send mail"); },
  };
  if (opts.fetchRaw !== false) {
    a.fetchRaw = async (locator) => {
      const raw = w.server.get(locator.ref);
      if (!raw) throw new Error(`no message at ${locator.ref}`);
      return new Uint8Array(Buffer.from(raw, "utf8"));
    };
  }
  return a as MailboxAdapter;
}

const run = (w: World, adapter?: MailboxAdapter) =>
  redactedRestorePass({
    db: w.db, adapter: adapter ?? fakeAdapter(w), accountId: w.accountId, mailboxId: w.mailboxId,
  });

const bodyOf = async (w: World, id: string) =>
  (await w.db.select().from(messageBodies).where(eq(messageBodies.messageId, id)))[0]!;
const msgOf = async (w: World, id: string) =>
  (await w.db.select().from(messages).where(eq(messages.id, id)))[0]!;

describe("redactedRestorePass", () => {
  it("restores the full body and KEEPS every sensitivity flag", async () => {
    const w = await newWorld();
    const id = await seedRedacted(w);

    const r = await run(w);
    expect(r.restored).toBe(1);

    const body = await bodyOf(w, id);
    expect(body.text.trim()).toBe(CODE_TEXT);   // the real code is back (MIME adds a trailing \n)
    expect(body.text).not.toContain("[REDACTED]");
    expect(body.html).toContain("482913");       // html restored too

    const m = await msgOf(w, id);
    // FLAGS UNCHANGED — this row is genuinely sensitive and stays so.
    expect(m.sensitivityCategory).toBe("otp");
    expect(m.noAi).toBe(true);
    expect(m.noKb).toBe(true);
    expect(m.noForward).toBe(true);
    expect(m.priority).toBe(true);
    // The list preview is no longer the placeholder.
    expect(m.snippet).not.toContain("[REDACTED]");

    // One `update` delta so the mirror re-materializes; an audit row for the operator.
    const deltas = await w.db.select().from(changeLog).where(eq(changeLog.op, "update"));
    expect(deltas.map((d) => d.entityId)).toEqual([id]);
    const audits = await w.db.select().from(auditLog).where(eq(auditLog.action, "redacted_body_restore"));
    expect(audits).toHaveLength(1);
  });

  it("is idempotent — a second run restores nothing", async () => {
    const w = await newWorld();
    await seedRedacted(w);
    expect((await run(w)).restored).toBe(1);
    expect((await run(w)).restored).toBe(0);
  });

  it("leaves a non-redacted body untouched", async () => {
    const w = await newWorld();
    const id = await seedRedacted(w, { storedText: "nothing sensitive here" });
    const r = await run(w);
    expect(r.restored).toBe(0);
    expect((await bodyOf(w, id)).text).toBe("nothing sensitive here");
  });

  it("refuses to store bytes for a message whose identity does not match the row", async () => {
    const w = await newWorld();
    const id = await seedRedacted(w, { identity: "wrong" });
    const r = await run(w);
    expect(r.restored).toBe(0);
    expect(r.mismatched).toBe(1);
    // The placeholder stays — we did NOT write another message's bytes into this row.
    expect((await bodyOf(w, id)).text).toContain("[REDACTED]");
  });

  it("does nothing (and does not crash) when the adapter cannot re-read", async () => {
    const w = await newWorld();
    const id = await seedRedacted(w);
    const r = await run(w, fakeAdapter(w, { fetchRaw: false }));
    expect(r.restored).toBe(0);
    expect((await bodyOf(w, id)).text).toContain("[REDACTED]");
  });
});

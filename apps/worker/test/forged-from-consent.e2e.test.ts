import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { contacts, folderState, mailboxes, mailboxCredentials, messages } from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider } from "@trafficflow/core";
import { startWorker, type RunningWorker } from "../src/index.js";
import type { WorkerConfig } from "../src/config.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { ORGANIZER_CONSENT } from "./_workerdb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  A FORGED `From` MUST NOT INHERIT CONSENT, PROVEN AT THE REAL COMPOSITION ROOT
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * `authVerdictFromHeaders` was correct and inert: every production site fed it the empty set,
 * so a stranger writing a known contact's address into `From` reached the Ohbox with zero user
 * action. The fix is one line in `index.ts#attach` —
 * `trustedAuthservIds: providerAuthservIds(creds.imap.host)` — and THAT LINE is what this file
 * guards. The core-level halves (the resolver, the demotion) have unit tests in
 * `packages/core/test/authserv-ids.test.ts`; none of them can see a composition root quietly
 * going back to `NO_TRUSTED_AUTHSERV_IDS`, which is exactly how the defect shipped the first
 * time. So this runs the REAL worker — `startWorker`, the real attach, the real credential row,
 * the real pipeline — against a fake adapter delivering the forgery.
 *
 * MUTATION (verified red on 2026-08-12): replace that line's value with
 * `NO_TRUSTED_AUTHSERV_IDS` and "the forged mail is screened" fails with desired=INBOX —
 * the forgery admitted to the Ohbox.
 *
 * Isolated database, fake adapter, nowhere near anyone's mailbox.
 */

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 43));
let DB = "";
type Db = ReturnType<typeof makeDb>;

const CONTACT = "anna@work.example";
/** Gmail's own report: the DKIM signature aligned with the claimed author FAILED. */
const GMAIL_FAIL =
  "Authentication-Results: mx.google.com; dkim=fail header.d=work.example; dmarc=fail header.from=work.example";

async function seedMailbox(db: Db, imapHost: string): Promise<{ accountId: string; mailboxId: string }> {
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`, ...ORGANIZER_CONSENT }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: row!.accountId, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: imapHost, port: 993, secure: true, user: "u" },
  });
  // Anna is a KNOWN SENDER: `evaluateRules` admits her mail to the Ohbox. The whole attack is
  // borrowing that admission.
  await db.insert(contacts).values({ accountId, address: CONTACT });
  return { accountId, mailboxId: row!.id };
}

function cfgFor(fleet: FakeAdapterFleet, over: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    databaseUrl: DB, keyProvider: KP, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory,
    pollIntervalMs: 60_000, rosterIntervalMs: 60_000, lockHeartbeatMs: 60_000,
    alertIntervalMs: 600_000, maxSyncFailures: 3, mailboxRetryMs: 1_000,
    ...over,
  };
}

async function waitFor(cond: () => Promise<boolean>, ms: number, label: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out after ${ms}ms waiting for ${label}`);
}

describe("the worker's own wiring demotes a forged known-contact From", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_x1g2"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) { try { await c(); } catch { /* ignore */ } } }, ISOLATED_DB_RESET_BUDGET_MS);

  async function desiredOf(db: Db, mailboxId: string, messageId: string): Promise<string | null> {
    const all = await db.select({ id: messages.id, mid: messages.messageIdHeader })
      .from(messages).where(eq(messages.mailboxId, mailboxId));
    // `messageIdHeader` is stored NORMALIZED — bare, no angle brackets (`_workerenv.ts#byMessageId`).
    const target = all.find((m) => m.mid === messageId);
    if (!target) return null;
    const fs = await db.select({ desired: folderState.desiredFolder })
      .from(folderState).where(eq(folderState.messageId, target.id));
    return fs[0]?.desired ?? null;
  }

  it("on a Gmail-host mailbox the forged mail is SCREENED; the contact's real mail is not", async () => {
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db, "imap.gmail.com");

    fleet.behave(mb.mailboxId, {
      deliver: [
        // The forgery: Anna's address in From, and Gmail's own header saying the aligned
        // signature failed. Under the empty set this reaches the Ohbox.
        { from: CONTACT, subject: "urgent — new bank details", messageId: "forged-1@attacker.example", headers: [GMAIL_FAIL] },
        // The control: Anna's real mail, which Gmail vouches for. It must stay admitted —
        // the demotion is the FAIL verdict, never the mere presence of a header.
        {
          from: CONTACT, subject: "lunch tomorrow?", messageId: "genuine-1@work.example",
          headers: ["Authentication-Results: mx.google.com; dkim=pass header.d=work.example; dmarc=pass header.from=work.example"],
        },
      ],
    });

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    await waitFor(async () => (await desiredOf(db, mb.mailboxId, "forged-1@attacker.example")) !== null
      && (await desiredOf(db, mb.mailboxId, "genuine-1@work.example")) !== null,
    15_000, "both messages ingested");

    // The consent boundary, held at the real wiring: the forgery is held at the gate…
    expect(await desiredOf(db, mb.mailboxId, "forged-1@attacker.example")).toBe("ohmail/Screener");
    // …and the demote-only rule kept its other half: Anna's genuine mail is admitted.
    expect(await desiredOf(db, mb.mailboxId, "genuine-1@work.example")).toBe("INBOX");
  }, 30_000);

  it("on an unknown-provider mailbox the same forgery is still admitted — the documented tail", async () => {
    // Not a defect marker: the provider table refuses to guess for hosts nobody vouches for,
    // and `"unavailable"` demotes nothing (the pre-population behaviour, byte for byte). The
    // self-hosted tail has its own pending ruling; this test is what makes the boundary of the
    // fix visible rather than assumed.
    const db = makeDb(DB);
    const fleet = new FakeAdapterFleet();
    const mb = await seedMailbox(db, "mail.selfhosted.example");

    fleet.behave(mb.mailboxId, {
      deliver: [
        { from: CONTACT, subject: "urgent — new bank details", messageId: "forged-2@attacker.example", headers: [GMAIL_FAIL] },
      ],
    });

    const worker: RunningWorker = await startWorker(cfgFor(fleet));
    closers.push(() => worker.stop());

    await waitFor(async () => (await desiredOf(db, mb.mailboxId, "forged-2@attacker.example")) !== null,
      15_000, "message ingested");

    expect(await desiredOf(db, mb.mailboxId, "forged-2@attacker.example")).toBe("INBOX");
  }, 30_000);
});

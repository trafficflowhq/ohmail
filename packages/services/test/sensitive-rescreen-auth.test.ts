import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  accounts, contacts, folderState, mailboxes, mailboxCredentials, messageBodies, messages, type Tx,
} from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { mailboxProviderAuthservIds } from "@trafficflow/core/adapters/drizzle-repo";
import { runSensitiveRescreen } from "../src/sensitive-rescreen.js";
import type { Db } from "../src/context.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 * THE RE-SCREEN PASS READS THE PROVIDER'S REPORT — and still leaves consented mail alone.
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * The third of the three producers a critical review finding named. It hard-coded
 * `auth: "unauthenticated"` behind the claim that "this row carries no raw bytes to verify" —
 * true of an offline DKIM check, false of `authVerdictFromHeaders`, which reads
 * `Authentication-Results` and nothing else. {@link RescreenRow} has carried
 * `message_bodies.headers` since the pass was written.
 *
 * ── THE DIRECTION THIS PASS CAN BE BROKEN IN IS THE OPPOSITE OF THE KICKSTART'S ───────────
 *
 * This pass acts only on `decision.source === "screener"`, so a verdict that screens rows makes
 * it move MORE mail, not less. That is why the negatives here are about what it must NOT sweep
 * up: a known sender's OTP is supposed to STAY in the Ohbox, and the pass moved hundreds of messages
 * nobody asked it to touch the first time it ran. Anything that makes an unauthenticated
 * -but-not-failing message answer `screener` empties the Ohbox of exactly the mail it exists to
 * leave alone.
 *
 * PGlite, like `sensitive-rescreen.no-imap.test.ts` beside it: the claim is which answer the
 * pass computes, not how Postgres schedules it. The transactional claims are on :5433 in
 * `sensitive-rescreen.pg.test.ts`.
 */

const OHBOX = "INBOX";
const SCREENER = "ohmail/Screener";

/** The authserv-id this deployment believes. */
const PROVIDER: ReadonlySet<string> = new Set(["mx.google.com"]);

const TRUSTED_FAIL = ["mx.google.com; dkim=fail header.d=work.example; spf=fail"];
const FORGED_FAIL = ["attacker.example; dkim=fail header.d=work.example"];

interface World { db: Db; accountId: string; mailboxId: string }

async function world(knownSenders: string[] = []): Promise<World> {
  const db = (await makeTestDb()) as unknown as Db;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `w1a-${accountId.slice(0, 8)}` });
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `w1a-${accountId.slice(0, 8)}@example.test`,
  }).returning();
  for (const address of knownSenders) await db.insert(contacts).values({ accountId, address });
  return { db, accountId, mailboxId: mb!.id };
}

/**
 * One sensitive message sitting in the Ohbox — the exact shape the consent bypass produced.
 * `sensitivityCategory` is what makes it a candidate at all.
 */
async function seedOhbox(
  w: World, o: { from: string; headers?: Record<string, string[]> },
): Promise<string> {
  const [m] = await (w.db as unknown as Tx).insert(messages).values({
    accountId: w.accountId, mailboxId: w.mailboxId, bodyHash: "h",
    dedupKey: `w1a:${randomUUID()}`, subject: "Your verification code",
    fromAddress: o.from, sensitivityCategory: "otp",
    nativeLocator: { folder: OHBOX, ref: `1:${Math.floor(Math.random() * 100000)}` },
  }).returning();
  await (w.db as unknown as Tx).insert(messageBodies).values({
    messageId: m!.id, accountId: m!.accountId, text: "", html: null, headers: o.headers ?? {},
  });
  await (w.db as unknown as Tx).insert(folderState).values({
    messageId: m!.id, accountId: m!.accountId, desiredFolder: OHBOX, observedFolder: OHBOX,
    lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
  });
  return m!.id;
}

const desiredOf = async (w: World, id: string): Promise<string> =>
  (await (w.db as unknown as Tx).select().from(folderState)
    .where(eq(folderState.messageId, id)))[0]!.desiredFolder;

describe("runSensitiveRescreen: the provider's report is read, and only demotes", () => {
  /**
   * THE BASELINE. Anna is a contact, so `evaluateRules` answers `unclear` and her code STAYS in
   * the Ohbox. This is the case the pass exists to leave alone.
   */
  it("a known sender's code with no Authentication-Results stays in the Ohbox", async () => {
    const w = await world(["anna@work.example"]);
    const id = await seedOhbox(w, { from: "anna@work.example" });

    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => PROVIDER,
    });

    expect(r.examined).toBe(1);
    expect(r.kept).toBe(1);
    expect(r.rescreened).toBe(0);
    expect(await desiredOf(w, id)).toBe(OHBOX);
  });

  /**
   * TO WATCH IT FAIL: put `auth: "unauthenticated"` back at the `evaluateRules` call in
   * `packages/services/src/sensitive-rescreen.ts`.
   */
  it("the same code, which the provider says is forged, is screened out", async () => {
    const w = await world(["anna@work.example"]);
    const id = await seedOhbox(w, {
      from: "anna@work.example", headers: { "authentication-results": TRUSTED_FAIL },
    });

    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => PROVIDER,
    });

    // An OTP claiming to be from a contact, which that contact's own domain did not sign, is the
    // exact message the consent gate is for.
    expect(r.rescreened).toBe(1);
    expect(await desiredOf(w, id)).toBe(SCREENER);
  });

  it("a failure from an UNTRUSTED position leaves the contact's mail alone", async () => {
    const w = await world(["anna@work.example"]);
    const id = await seedOhbox(w, {
      from: "anna@work.example", headers: { "authentication-results": FORGED_FAIL },
    });

    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => PROVIDER,
    });

    expect(r.kept).toBe(1);
    expect(await desiredOf(w, id)).toBe(OHBOX);
  });

  /**
   * THE UNKNOWN-PROVIDER GUARANTEE. A mailbox whose IMAP host the provider table does not name
   * resolves to the empty set — and that must route byte-identically to the pre-population
   * behaviour: `"unavailable"` for every candidate, nothing demoted.
   */
  it("with an EMPTY trusted set the SAME forged code stays in the Ohbox", async () => {
    const w = await world(["anna@work.example"]);
    const id = await seedOhbox(w, {
      from: "anna@work.example", headers: { "authentication-results": TRUSTED_FAIL },
    });

    // The explicit empty set — what `mailboxProviderAuthservIds` answers for a self-hosted or
    // unlisted provider (and for a mailbox with no credential row yet).
    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => new Set<string>(),
    });

    expect(r.kept).toBe(1);
    expect(r.rescreened).toBe(0);
    expect(await desiredOf(w, id)).toBe(OHBOX);
  });

  /**
   * THE CANONICAL RESOLVER, END TO END: the credential row's `meta.host` says Gmail, so
   * `mailboxProviderAuthservIds` answers `mx.google.com`, and Gmail's own `dmarc/dkim=fail`
   * report about a forged contact address screens the message — the full review-finding chain with no
   * hand-built set anywhere.
   *
   * TO WATCH IT FAIL: pass `async () => new Set<string>()` instead — the forged code is kept.
   */
  it("the resolver reads the mailbox's own IMAP host and the forged code is screened", async () => {
    const w = await world(["anna@work.example"]);
    await (w.db as unknown as Tx).insert(mailboxCredentials).values({
      mailboxId: w.mailboxId, accountId: w.accountId, transport: "imap", secretEnc: "sealed", keyVersion: 1,
      meta: { host: "imap.gmail.com", port: 993, secure: true, user: "u" },
    });
    const id = await seedOhbox(w, {
      from: "anna@work.example", headers: { "authentication-results": TRUSTED_FAIL },
    });

    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: mailboxProviderAuthservIds,
    });

    expect(r.rescreened).toBe(1);
    expect(await desiredOf(w, id)).toBe(SCREENER);
  });

  /**
   * THE REGRESSION THIS PASS IS ONE EDIT AWAY FROM.
   *
   * Five codes from people the user knows, none carrying an `Authentication-Results` — the
   * ordinary state of a real mailbox. If a verdict were ever REQUIRED, all five answer `screener`
   * and the pass sweeps the user's own correspondents into the consent gate.
   *
   * MUTATION: change `evaluateRules`'s known-sender arm to `if (auth !== "pass") return screened`
   * and this reports `rescreened: 5`.
   */
  it("a mailbox of known-sender codes is left entirely alone", async () => {
    const senders = ["anna@work.example", "bob@work.example", "cara@work.example", "dan@work.example", "eve@work.example"];
    const w = await world(senders);
    const ids: string[] = [];
    for (const from of senders) ids.push(await seedOhbox(w, { from }));

    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => PROVIDER,
    });

    expect(r.examined).toBe(5);
    expect(r.kept).toBe(5);
    expect(r.rescreened).toBe(0);
    for (const id of ids) expect(await desiredOf(w, id)).toBe(OHBOX);
  });

  it("a stranger is screened either way — the verdict adds nothing at first contact", async () => {
    const w = await world();
    const plain = await seedOhbox(w, { from: "stranger@nowhere.example" });
    const forged = await seedOhbox(w, {
      from: "stranger@nowhere.example", headers: { "authentication-results": TRUSTED_FAIL },
    });

    const r = await runSensitiveRescreen({
      db: w.db, mailboxId: w.mailboxId, trustedAuthservIdsFor: async () => PROVIDER,
    });

    // The damage the pass was written for. The demotion branch is unreachable for a sender who
    // is already behind the gate, which is what keeps its blast radius at exactly the rows the
    // bypass created.
    expect(r.rescreened).toBe(2);
    expect(await desiredOf(w, plain)).toBe(SCREENER);
    expect(await desiredOf(w, forged)).toBe(SCREENER);
  });
});

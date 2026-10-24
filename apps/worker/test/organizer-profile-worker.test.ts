import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  accounts, accountSettings, auditLog, awayResponders, changeLog, contacts, folderState, idempotencyKeys, latestProfileFoundMarker,
  mailboxCredentials, mailboxes, messages, notifyRules, profileImportResolutionExists,
  recordProfileImportResolution, rules, tags,
} from "@trafficflow/db";
import { makeDb } from "@trafficflow/db/cloud";
import { StaticKeyProvider, createLogger } from "@trafficflow/core";
import { formatClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  PROFILE_LIST_MAX, PROFILE_VERSION,
  formatProfileMessage, makeProfileDoc, parseProfileMessage, profileFingerprint, isMalformedProfile,
  readOrganizerProfile,
  type OrganizerProfilePayload, type ParsedProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { startWorker } from "../src/index.js";
import { OrganizerProfileSync, serializeOrganizerProfile, serializeOrganizerProfileCounted, PROFILE_FOUND_AUDIT_ACTION } from "../src/profile.js";
import { prepareIsolatedDb, truncateAll, ISOLATED_DB_RESET_BUDGET_MS } from "./_isolateddb.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { KEY_RING_PREFIX, keyRingVar } from "../../../test/support/key-ring-env.js";

/**
 * THE PORTABLE ORGANIZER PROFILE — the worker's write-behind, against the real store. Four claims:
 * (1) only the active organizer writes, asserted through `startWorker` (the lease gate is the
 * single-writer mechanism); (2) write-behind is debounced by the cycle — a burst is ONE append,
 * an unchanged store none; (3) read-on-takeover surfaces and never applies: a foreign document is
 * recorded and NOT overwritten until local state converges onto it or the person imports or
 * replaces it ("Not now" leaves it standing); (4) the document carries configuration and nothing
 * else, its key census pinned against a store holding credential and model sentinels.
 * Real Postgres (the lease-worker suite's harness), because the serializer reads the store.
 */

type Db = ReturnType<typeof makeDb>;

const KP = StaticKeyProvider.fromSecret(Buffer.alloc(32, 7));
let DB = "";

const INSTALL = "cloud-profile-test";

/**
 * Seed a mailbox THIS INSTALL ORGANIZES — which is the premise of every write-behind below.
 *
 * The pair moves together and neither column may be left to its default. This named neither, so
 * the row took the schema default `organizer_role='organizer'` (`schema-mail.ts:151`) beside
 * `organize_consented_at` NULL — a combination no product path writes, and one mail 0083's
 * consent gate reads as "nobody has asked this install to organize this mailbox".
 *
 * The consequence was not a failing test, it was a vacuous file: `mayOrganize` returned false for
 * every mailbox here, so all 43 cases ran against a READER, and the write-behind's own headline
 * claim — *"the lease gate is the single-writer mechanism"* — was asserted on a fixture in which
 * the gate had already said no and the profile was appended regardless. The single-writer
 * mechanism was the one thing the file could not see.
 */
async function seedMailbox(db: Db, accountId = randomUUID()): Promise<{ accountId: string; mailboxId: string }> {
  await db.insert(accounts).values({ id: accountId, name: "profile" });
  const [row] = await db.insert(mailboxes)
    .values({
      accountId, provider: "imap", address: `${randomUUID()}@trafficflow.test`,
      organizerRole: "organizer",
      organizeConsentedAt: new Date(Date.now() - 60 * 60 * 1000),
    }).returning();
  const enc = await KP.encrypt("pw");
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
    meta: { host: "fake.invalid", port: 1143, secure: false, user: "u" },
  });
  return { accountId, mailboxId: row!.id };
}

/**
 * A DATABASE WHOSE INSERTS FAIL WHILE `fail()` SAYS SO — on the outer handle AND on every
 * transaction it opens. The marker is written inside `fencedAccountWrite`, so a proxy over the
 * outer handle alone never meets it and the retry cases would pass for the wrong reason.
 */
function failingInserts(db: Db, fail: () => boolean): Db {
  const wrap = <T extends object>(handle: T): T => new Proxy(handle, {
    get(target, prop, receiver) {
      if (prop === "insert" && fail()) return () => { throw new Error("transient database blip"); };
      if (prop === "transaction") {
        const open = Reflect.get(target, prop, receiver) as (cb: (t: object) => unknown, ...rest: unknown[]) => unknown;
        return (cb: (t: object) => unknown, ...rest: unknown[]) => open.call(target, (t: object) => cb(wrap(t)), ...rest);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  return wrap(db);
}

async function waitFor(pred: () => Promise<boolean>, ms = 20_000, step = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

/** The profile documents currently in one mailbox's fake `_meta`, parsed. */
function profileDocs(fleet: FakeAdapterFleet, mailboxId: string): ParsedProfileMessage[] {
  return fleet.metaFor(mailboxId).messages
    .map((m) => parseProfileMessage(m.raw, m.ref))
    .filter((r): r is ParsedProfileMessage => r !== null && !isMalformedProfile(r));
}

function workerConfig(fleet: FakeAdapterFleet, logger?: ReturnType<typeof createLogger>) {
  return {
    databaseUrl: DB, keyProvider: KP, pollIntervalMs: 200, sentDomain: "trafficflow.test",
    adapterFactory: fleet.factory,
    /* THE ROSTER PASS IS WHAT CARRIES A PRESS TO THE GATE, and its default is thirty seconds —
       longer than these cases are willing to wait. `takeover_authorized_at` is written by another
       process and read onto the runtime by the roster refresh, so a test that waited out the
       default would be measuring the interval rather than the promotion. */
    rosterIntervalMs: 200,
    organizer: {
      installId: INSTALL, displayName: "Cloud", staleAfterMs: 60_000,
      // Flush-per-cycle: the debounce under test is the CYCLE itself — a burst between two
      // cycles must still be one append, at the tightest flush interval there is.
      profileFlushIntervalMs: 0,
    },
    ...(logger === undefined ? {} : { logger }),
  };
}

describe("the worker's portable profile write-behind", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_profile"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c().catch(() => undefined); }, ISOLATED_DB_RESET_BUDGET_MS);

  it("absence ⇒ defaults and no litter; a burst of changes ⇒ exactly ONE append; unchanged ⇒ none", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const lines: string[] = [];
    const logger = createLogger({ sink: (l) => { lines.push(l); } });

    const worker = await startWorker(workerConfig(fleet, logger));
    closers.push(() => worker.stop());
    expect(await waitFor(async () => worker.stats().mailboxes === 1)).toBe(true);

    // A few cycles with an EMPTY configuration: the read reported `none`, and nothing was
    // written — a mailbox that has said nothing gets no document, its absence already meaning
    // defaults for whoever connects it next.
    expect(await waitFor(async () =>
      lines.some((l) => l.includes("organizer_profile_detected") && l.includes("\"state\":\"none\"")))).toBe(true);
    await new Promise((r) => setTimeout(r, 700));
    const meta = fleet.metaFor(mb.mailboxId);
    expect(meta.profileAppends).toBe(0);
    expect(profileDocs(fleet, mb.mailboxId)).toHaveLength(0);

    // A BURST: one transaction carrying a screener verdict's whole footprint (contact + promoted
    // rule) plus a tag — committed atomically, exactly as `ScreenerService.decide` commits.
    await db.transaction(async (tx) => {
      await tx.insert(contacts).values({ accountId: mb.accountId, address: "anna@x.example", name: "Anna" });
      await tx.insert(rules).values({
        accountId: mb.accountId, kind: "sender", match: "anna@x.example",
        destination: "INBOX", provenance: "promoted", enabled: true,
      });
      await tx.insert(tags).values({ accountId: mb.accountId, name: "Invoices", hue: "moss" });
    });

    expect(await waitFor(async () => meta.profileAppends >= 1)).toBe(true);
    // …and it stays 1: the burst was one write, and an unchanged store re-appends nothing.
    await new Promise((r) => setTimeout(r, 900));
    expect(meta.profileAppends, "a burst of config writes must be ONE append, and steady state appends nothing").toBe(1);

    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs).toHaveLength(1);
    const doc = docs[0]!.doc!;
    // The version the writer stamps, read off the writer: a literal here is a second place to
    // remember a format change in, and the two drift silently apart.
    expect(doc.v).toBe(PROFILE_VERSION);
    // A contact with no stated source is a person's (mail 0148), and the document says so.
    expect(doc.screener).toEqual([{ address: "anna@x.example", name: "Anna", source: "person" }]);
    // The rule carries its age beside it, outside the fingerprint.
    expect(doc.rules).toEqual([{
      kind: "sender", match: "anna@x.example", destination: "INBOX",
      priority: 0, enabled: true, provenance: "promoted", updatedAt: expect.any(String),
    }]);
    expect(doc.tagNames).toEqual(["Invoices"]);
    expect(docs[0]!.installId).toBe(INSTALL);

    // A SECOND burst — notify rule + away responder — is one more append, and the folder still
    // holds exactly one document (append new + expunge old, through the worker's own path).
    await db.transaction(async (tx) => {
      await tx.insert(notifyRules).values({ accountId: mb.accountId, kind: "sender", target: "boss@x.example" });
      await tx.insert(awayResponders).values({
        accountId: mb.accountId, enabled: true, body: "Back Monday.", audience: "screened_in", throttle: "per_day", enabledAt: new Date("2026-08-01T00:00:00.000Z"),
      });
    });
    expect(await waitFor(async () => meta.profileAppends >= 2)).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(meta.profileAppends).toBe(2);
    const after = profileDocs(fleet, mb.mailboxId);
    expect(after).toHaveLength(1);
    expect(after[0]!.doc!.notifyRules).toEqual([{ kind: "sender", target: "boss@x.example" }]);
    expect(after[0]!.doc!.awayResponder).toMatchObject({ enabled: true, audience: "screened_in", throttle: "per_day" });
    // The organizer claim shares the folder and every profile write left it standing.
    expect(meta.messages.length - after.length, "the lease claim must still be beside the profile").toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("a STOOD-DOWN organizer with a dirty store writes NOTHING — the lease gate is the single-writer mechanism", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    // Dirty configuration, waiting to be flushed by anything that organizes.
    await db.insert(rules).values({
      accountId: mb.accountId, kind: "sender", match: "x@y.z", destination: "ohmail/News", provenance: "manual",
    });
    // A live foreign local claim: the worker stands down at attach and never reaches a cycle.
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "Mila's MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));

    const worker = await startWorker(workerConfig(fleet));
    closers.push(() => worker.stop());

    // `organizer_role`, not `status`. Mail 0083 moved the demotion onto the role and left
    // `status` meaning tombstone-or-plan-disable — a loser is `connected` and syncing — so a wait
    // for `disabled` waits for a state the product no longer reaches. That it timed out for 15 s
    // and then asserted `profileAppends === 0` against a worker that had never started organizing
    // is why this had to be read rather than re-pointed: the zero was true for the wrong reason.
    expect(await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      return row!.organizerRole === "reader";
    })).toBe(true);
    await new Promise((r) => setTimeout(r, 700));

    const meta = fleet.metaFor(mb.mailboxId);
    expect(meta.profileAppends, "a stood-down organizer must never write the profile").toBe(0);
    // …and it IS running, which is what makes the zero above a refusal rather than an absence.
    // A reader syncs; it does not publish the mailbox's settings.
    expect(fleet.syncs, "the reader never ran, so the zero above proves nothing").toBeGreaterThan(0);
    expect(profileDocs(fleet, mb.mailboxId)).toHaveLength(0);
    // …and it never even read for one: no marker row exists.
    expect(await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))))
      .toHaveLength(0);
  }, 60_000);

  it("a mailbox that changes hands MID-FLIGHT stops getting profile writes on the same cycle it stops being organized", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "before", hue: "moss" });

    const worker = await startWorker(workerConfig(fleet));
    closers.push(() => worker.stop());
    const meta = fleet.metaFor(mb.mailboxId);
    expect(await waitFor(async () => meta.profileAppends === 1)).toBe(true);

    // PARK the next cycle's lease read, so the hand-over and the dirty store both land INSIDE
    // the verdict window: the cycle that resumes will read a folder another cloud already owns,
    // with a store that already owes a flush. The claim under test is the ORDERING — the profile
    // tick sits behind that cycle's own verdict, so the losing cycle flushes nothing.
    let parked = false;
    let release: () => void = () => undefined;
    const barrier = new Promise<void>((r) => { release = r; });
    const realListClaims = meta.listClaims.bind(meta);
    meta.listClaims = async () => {
      parked = true;
      await barrier;
      return realListClaims();
    };
    expect(await waitFor(async () => parked)).toBe(true);

    // Another CLOUD deployment claims the mailbox with an OLDER incumbency — the election's
    // incumbency rule makes it the winner the moment the parked read resumes…
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "another-cloud", kind: "cloud", displayName: "their Cloud",
      heartbeat: new Date(), claimedAt: new Date(Date.now() - 60 * 60 * 1000), nonce: "n9",
    }));
    // …and the store goes dirty in the same window.
    await db.insert(tags).values({ accountId: mb.accountId, name: "after", hue: "moss" });
    release();

    // The role, not the status — see the note in the test above.
    expect(await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      return row!.organizerRole === "reader";
    })).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    // The loser wrote nothing more: the new organizer's read must never race a ghost's flush.
    expect(meta.profileAppends, "a stood-down organizer must not flush on the cycle it lost").toBe(1);
  }, 60_000);

  it("a FOREIGN document is surfaced (log + one audit marker), kept byte-identical, and this install's own is published beside it", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);

    // What travelled with the mailbox: one screened-in sender and one rule, written by another
    // install. This is the takeover shape — the whole reason the document exists.
    const foreignPayload: OrganizerProfilePayload = {
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [{
        kind: "sender", match: "friend@elsewhere.example", destination: "INBOX",
        priority: 0, enabled: true, provenance: "promoted",
      }],
      notifyRules: [], awayResponder: null, tagNames: [],
      signature: null,
    };
    const foreignDoc = makeProfileDoc(foreignPayload, {
      updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
    });
    const meta = fleet.metaFor(mb.mailboxId);
    await meta.appendProfile(formatProfileMessage(foreignDoc, { installId: "someone-elses-mac" }));
    const seededAppends = meta.profileAppends;
    const foreignRaw = meta.messages.find((m) => parseProfileMessage(m.raw) !== null)!.raw;

    // …and DIFFERENT local configuration, so the two genuinely disagree.
    await db.insert(rules).values({
      accountId: mb.accountId, kind: "sender", match: "local@here.example", destination: "ohmail/News", provenance: "manual",
    });

    const lines: string[] = [];
    const worker = await startWorker(workerConfig(fleet, createLogger({ sink: (l) => { lines.push(l); } })));
    closers.push(() => worker.stop());

    // The fact is surfaced…
    expect(await waitFor(async () =>
      lines.some((l) => l.includes("organizer_profile_detected") && l.includes("\"state\":\"found\"")))).toBe(true);
    expect(await waitFor(async () =>
      (await db.select().from(auditLog)
        .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))))
        .length === 1)).toBe(true);
    // …with what the confirm flow needs: provenance and section counts, never an auto-apply.
    const [marker] = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)));
    expect(marker!.payload).toMatchObject({
      mailboxId: mb.mailboxId, state: "found",
      producer: { kind: "local", version: "0.9.3" },
      counts: { screener: 1, rules: 1, notifyRules: 0, tagNames: 0, awayResponder: 0 },
    });

    // …NOT overwritten, cycle after cycle, and this install's own settings published beside it.
    expect(await waitFor(async () => profileDocs(fleet, mb.mailboxId).some((d) => d.installId === INSTALL)),
      "this install's settings never reached the mailbox beside the found document").toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(meta.messages.find((m) => parseProfileMessage(m.raw) !== null)!.raw,
      "the found document must survive byte-identically while the decision is open").toBe(foreignRaw);
    expect(profileDocs(fleet, mb.mailboxId).map((d) => d.installId).sort()).toEqual([INSTALL, "someone-elses-mac"].sort());
    // The import was never applied by this slice: local rules are exactly what the test wrote.
    expect(await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).toHaveLength(0);

    // CONVERGENCE — the shape P.2's confirmed import produces: local state becomes the document.
    await db.transaction(async (tx) => {
      await tx.delete(rules).where(eq(rules.accountId, mb.accountId));
      await tx.insert(contacts).values({ accountId: mb.accountId, address: "friend@elsewhere.example" });
      await tx.insert(rules).values({
        accountId: mb.accountId, kind: "sender", match: "friend@elsewhere.example",
        destination: "INBOX", provenance: "promoted", enabled: true,
      });
    });
    // The hold releases, and the NEXT change leaves one document, ours, carrying it: the
    // released foreign copy is residue the write gate removes before it appends.
    await new Promise((r) => setTimeout(r, 900));
    await db.insert(tags).values({ accountId: mb.accountId, name: "après", hue: "moss" });
    expect(await waitFor(async () => {
      const d = profileDocs(fleet, mb.mailboxId);
      return d.length === 1 && d[0]!.installId === INSTALL && d[0]!.doc!.tagNames.includes("après");
    }), `documents: ${JSON.stringify(profileDocs(fleet, mb.mailboxId).map((d) => [d.installId, d.doc!.tagNames]))}`).toBe(true);
    expect(meta.profileAppends).toBeGreaterThan(seededAppends);
  }, 60_000);

  it("TAKEOVER-RESCREEN: while the import decision is open the gate adopts what the document admits and screens a stranger, and screens again once it is answered", async () => {
    // The drill's defect, end to end: a cold store used to move the INBOX mail of the travelling
    // document's screened-in senders into the Screener. (1) The hold is armed before the first
    // routing decision; (2) the named sender's letter is adopted, `'external'`; (3) a sender the
    // document does not know is screened NOW, `'us'` (measured on 0.25.1); (4) the answer resumes the
    // gate for later arrivals and what was adopted stays adopted.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);

    const foreignDoc = makeProfileDoc({
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [{
        kind: "sender", match: "friend@elsewhere.example", destination: "INBOX",
        priority: 0, enabled: true, provenance: "promoted",
      }],
      notifyRules: [], awayResponder: null, tagNames: [],
      signature: null,
    }, { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "0.9.3" } });
    await fleet.metaFor(mb.mailboxId).appendProfile(
      formatProfileMessage(foreignDoc, { installId: "someone-elses-mac" }),
    );

    // A letter ALREADY IN the INBOX from the sender the document screened in, and one from a
    // sender nobody knows — both on the first cycle.
    const held = { from: "friend@elsewhere.example", subject: "standing", messageId: "held-1@x" };
    const stranger = { from: "history@elsewhere.example", subject: "first contact", messageId: "stranger-1@x" };
    fleet.behave(mb.mailboxId, { deliver: [held, stranger] });

    const lines: string[] = [];
    const worker = await startWorker(workerConfig(fleet, createLogger({ sink: (l) => { lines.push(l); } })));
    closers.push(() => worker.stop());

    const rowFor = async (from: string) => {
      const [msg] = await db.select().from(messages)
        .where(and(eq(messages.mailboxId, mb.mailboxId), eq(messages.fromAddress, from)));
      if (!msg) return null;
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msg.id));
      return { msg, fs };
    };

    expect(await waitFor(async () => (await rowFor(held.from)) !== null)).toBe(true);
    const adopted = (await rowFor(held.from))!;
    expect(adopted.fs?.desiredFolder, "the takeover must not empty the inbox into the Screener").toBe("INBOX");
    expect(adopted.fs?.lastSetBy, "an adopted placement is the user's, not this organizer's").toBe("external");

    // …and the stranger is at the gate while the question is still open, on the server too.
    expect(await waitFor(async () => (await rowFor(stranger.from)) !== null)).toBe(true);
    const gated = (await rowFor(stranger.from))!;
    expect(gated.fs?.desiredFolder, "a sender the document does not know stayed past the gate").toBe("ohmail/Screener");
    expect(gated.fs?.lastSetBy).toBe("us");
    expect(await waitFor(async () => fleet.moves.some((m) => m.mailboxId === mb.mailboxId
      && m.locator.ref === "1:1001" && m.toFolder === "ohmail/Screener")), "the stranger was never filed").toBe(true);
    expect(fleet.moves.some((m) => m.mailboxId === mb.mailboxId && m.locator.ref === "1:1000"),
      "the named sender's letter was moved").toBe(false);

    // The user answers (a decline keeps local state — the ROUTING hold releases either way).
    // Routing reads the answer at every cycle edge (`importHoldNow`); a decline releases no
    // write hold, so it logs no `resolved` line to wait on.
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "declined", fingerprint: profileFingerprint(foreignDoc),
    });

    // …and the gate RESUMES for what arrives after: same stranger shape, ordinary screening.
    fleet.behave(mb.mailboxId, {
      deliver: [held, stranger, { from: "newcomer@elsewhere.example", subject: "fresh", messageId: "fresh-1@x" }],
    });
    expect(await waitFor(async () => (await rowFor("newcomer@elsewhere.example")) !== null)).toBe(true);
    const screened = (await rowFor("newcomer@elsewhere.example"))!;
    expect(screened.fs?.desiredFolder, "the consent gate must resume once the question is answered").toBe("ohmail/Screener");
    expect(screened.fs?.lastSetBy).toBe("us");

    // What was adopted STAYS adopted — placement on the master is user intent.
    const still = (await rowFor(held.from))!;
    expect(still.fs?.desiredFolder).toBe("INBOX");
    expect(still.fs?.lastSetBy).toBe("external");
  }, 60_000);

  /**
   * ══════════════════════════════════════════════════════════════════════════════════════
   *  THE SAME DRILL, REACHED BY THE DOOR MAIL 0083 OPENED — A PROMOTION WITH NO ATTACH
   * ══════════════════════════════════════════════════════════════════════════════════════
   *
   * The test above proves the hold is armed at ATTACH. That was the only way to become a
   * mailbox's organizer when it was written, and `attach()`'s own comment said as much: *"on
   * promotion the hold is armed by the attach that follows it."*
   *
   * Mail 0083 deleted the attach that sentence depended on. A loser is now a READER that keeps
   * its connection, and the READER -> ORGANIZER flip happens IN PLACE on the cycle path — no
   * re-attach, so nothing armed the hold, so the first organizing cycle ran with the import
   * decision CLOSED and filed the inherited history into `ohmail/Screener`. That is
   * TAKEOVER-RESCREEN verbatim, restored by the change that was supposed to make handovers
   * seamless to the person watching.
   *
   * The whole content of this test is the ROUTE: same document, same stranger, same assertions
   * as the attach case — reached by releasing a foreign claim under a running reader rather than
   * by starting a worker. MEASURED 2026-09-22: dropping the promotion's `armHoldFromFolder()`
   * alone stays green, because a reader never evaluates the decision, so no CLOSED verdict is
   * cached for that arm to invalidate (filed: PROMOTION-PREFLIGHT-ARM-GUARDS-AN-UNREACHABLE-CACHE).
   * TO WATCH IT FAIL: blind `importHoldNow`'s `found` verdict in `profile.ts`; the message
   * lands in `ohmail/Screener`.
   */
  it("a READER PROMOTED IN PLACE arms the import hold before its first organizing cycle", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    // The state a demotion leaves: consented, connected, reading, not organizing.
    await db.update(mailboxes).set({ organizerRole: "reader" }).where(eq(mailboxes.id, mb.mailboxId));

    // A live desktop claim, and the mailbox's decisions travelling beside it in the same folder.
    fleet.seedClaim(mb.mailboxId, formatClaim({
      authorizedAt: null, capabilities: [],
      installId: "a-desktop-install", kind: "local", displayName: "Mila's MacBook",
      heartbeat: new Date(), claimedAt: new Date(), nonce: "n1",
    }));
    const foreignDoc = makeProfileDoc({
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [{
        kind: "sender", match: "friend@elsewhere.example", destination: "INBOX",
        priority: 0, enabled: true, provenance: "promoted",
      }],
      notifyRules: [], awayResponder: null, tagNames: [],
      signature: null,
    }, { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "0.9.3" } });
    const meta = fleet.metaFor(mb.mailboxId);
    const appendsAfterSeed = meta.profileAppends;

    /* A REAL FLUSH INTERVAL, and it is the whole experiment rather than a detail.
     *
     * `workerConfig` uses `profileFlushIntervalMs: 0`, which makes `importHoldNow`'s TTL
     * `Math.min(EVAL_TAKEOVER_TTL_MS, 0)` — the eval cache expires on every single call, so the
     * folder is re-read every cycle and no stale verdict can survive. That is the right setting
     * for the debounce tests it was written for and it makes THIS defect unobservable: with a
     * zero TTL the promotion re-reads anyway and the missing arm costs nothing.
     *
     * At a real interval the cache holds, and the reader phase leaves a `closed` verdict in it —
     * honestly, because when it was evaluated the folder held no document. The invalidation for
     * exactly that case is conditioned on a hold having been armed (`profile.ts`: *"a CLOSED
     * verdict cached before a hold was armed is stale by construction"*), so the arm is what
     * makes the promoting cycle re-read.
     */
    const worker = await startWorker({
      ...workerConfig(fleet),
      organizer: { ...workerConfig(fleet).organizer, profileFlushIntervalMs: 30_000 },
    });
    closers.push(() => worker.stop());

    // It attaches as a READER and stays one while the desktop holds the mailbox.
    expect(await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      return row!.organizerRole === "reader";
    }), "the gate did not demote against a live foreign claim").toBe(true);
    expect(await waitFor(async () => fleet.syncs > 0), "the reader never ran").toBe(true);
    expect(meta.profileAppends, "a reader published the mailbox's settings").toBe(appendsAfterSeed);

    // ── THE DESKTOP RELEASES, AND THE STRANGER'S MAIL ARRIVES FOR THE PROMOTED CYCLE ──────
    // From the sender the document screened in: under the hold only mail it admits is adopted.
    const held = { from: "friend@elsewhere.example", subject: "standing", messageId: "promo-held-1@x" };
    // The outgoing organizer writes its travelling document and only THEN lets go — the ordering
    // a real handover has, and the one that leaves this process's cached verdict describing a
    // folder that no longer exists.
    await meta.appendProfile(formatProfileMessage(foreignDoc, { installId: "someone-elses-mac" }));
    await meta.removeClaims(meta.messages.filter((m) => m.raw.includes("a-desktop-install")).map((m) => m.ref));

    /* ── THE MAIL MUST REACH THE FIRST ORGANIZING CYCLE, NOT THE READER ────────────────────
     *
     * Delivered before the press, a reader cycle ingested it first (`'peer'`), so no assertion
     * below read the promoted cycle's routing at all: with the decision blinded the case stayed
     * green (measured 2026-09-22). So every sync is parked on a gate, and the mail is delivered
     * only once the parked sync is the PROMOTED one — the role already `organizer`. */
    let open!: () => void;
    fleet.behave(mb.mailboxId, { syncGate: new Promise<void>((r) => { open = r; }) });
    /* ── AND SOMEBODY PRESSES "ORGANIZE HERE" (0.14.1) — an empty folder promotes nobody on its own. */
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date() })
      .where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => {
      if (fleet.syncInFlight !== 1) return false;
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      if (row!.organizerRole === "organizer") return true;
      // A reader cycle is parked: let it through under a fresh gate and wait for the next one.
      const through = open;
      fleet.behave(mb.mailboxId, { syncGate: new Promise<void>((r) => { open = r; }) });
      through();
      return false;
    }), "the press did not promote the reader in place").toBe(true);
    fleet.behave(mb.mailboxId, { deliver: [held], syncGate: undefined });
    open();

    const rowFor = async (from: string) => {
      const [msg] = await db.select().from(messages)
        .where(and(eq(messages.mailboxId, mb.mailboxId), eq(messages.fromAddress, from)));
      if (!msg) return null;
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msg.id));
      return { msg, fs };
    };
    expect(await waitFor(async () => (await rowFor(held.from)) !== null)).toBe(true);
    const adopted = (await rowFor(held.from))!;
    expect(adopted.fs?.desiredFolder,
      "the promotion emptied the inbox into the Screener — the hold was not armed").toBe("INBOX");
    // The import hold's attribution, as in the attach case above: the organizer kept the mail
    // where the incoming decision placed it, and did not decide itself (`'us'`).
    expect(adopted.fs?.lastSetBy, "the promoted organizer decided about inherited mail").toBe("external");
    /* The marker below says the HOLD was armed; the value above says the mail was routed under it. */
    /* ── THE DURABLE MARKER, POLLED, AND FOR ITS OWN FIELD ────────────────────────────────
     *
     * This was a bare `select` for ANY row with this action, and it was wrong twice over.
     *
     * IT RACED. The row is written by the same asynchronous pass the assertions above polled for
     * — arming the hold and writing the marker are consecutive statements in one function
     * (`profile.ts`), so there is no ordering that makes the folder state visible and the marker
     * durable. Read without a poll, the case passed and failed across runs on one tree.
     *
     * AND IT PROVED LESS THAN IT LOOKED. The two assertions above cannot tell an armed hold from
     * a feature that did nothing at all: `desiredFolder: "INBOX"` with `lastSetBy: "external"` is
     * exactly what an untouched message looks like, because a message this organizer never
     * classified stays where it landed and is attributed to the user. Both would pass with the
     * import hold entirely absent. `heldForImport: true` is the only observation in this case
     * that distinguishes them — a marker written by the READER's path carries `false` and would
     * have satisfied the old "not empty" check while proving nothing about the promotion.
     */
    expect(await waitFor(async () => {
      const rows = await db.select().from(auditLog)
        .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)));
      return rows.some((r) => (r.payload as { heldForImport?: boolean } | null)?.heldForImport === true);
    }), "no marker says the mail is being HELD for a decision — the import hold was never armed")
      .toBe(true);
  }, 90_000);

  /**
   * THE ROUND TRIP: ORGANIZER -> READER -> ORGANIZER, WHICH KEEPS THE SAME OBJECT ALIVE THROUGH IT.
   *
   * The test above promotes a reader that has never organized anything. This one promotes a
   * runtime that ALREADY DID, and it is a different defect wearing the same clothes.
   *
   * `OrganizerProfileSync` is per-attachment, and before mail 0083 a demotion detached — the
   * object died with the runtime and a later promotion built a fresh one that had never seen the
   * mailbox. The runtime now survives its own demotion, so the second organizing life inherits
   * the first one's memory: `seeded` and `lastWrittenFingerprint` still set. Two things follow,
   * and they compound rather than cancel.
   *
   *  1. `armHoldFromFolder` returns at its `seeded && lastWrittenFingerprint !== null` guard, so
   *     the promotion's preflight — added directly above — probes nothing at all.
   *  2. The evaluator then reads the document the OTHER organizer wrote and classifies it as an
   *     established incumbent's mid-flight residue, which is precisely the case it refuses to
   *     hold on. So the mailbox is routed on OUR stale rules and the inherited document is
   *     superseded rather than offered.
   *
   * The fix is at the DEMOTION, not the promotion: `forgetOrganizerLife()` says the process is no
   * longer this mailbox's organizer, and everything it believed about owning the document stops
   * being true at that moment rather than being unwound later.
   *
   * TO WATCH IT FAIL: drop `rt.profile.forgetOrganizerLife()` from the demotion branch in
   * `index.ts`. The message lands in `ohmail/Screener`, and the test above stays green — it never
   * organized, so it has nothing to forget.
   */
  it("an organizer DEMOTED and later re-promoted adopts the document written while it was a reader", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    // Something of our own to write, so this install really does own a document before it loses
    // the mailbox — the precondition the whole test is about.
    await db.insert(tags).values({ accountId: mb.accountId, name: "ours", hue: "moss" });

    const worker = await startWorker({
      ...workerConfig(fleet),
      organizer: { ...workerConfig(fleet).organizer, profileFlushIntervalMs: 30_000 },
    });
    closers.push(() => worker.stop());

    // ── LIFE ONE: it organizes, and publishes its own document. ────────────────────────────
    expect(await waitFor(async () => meta.profileAppends === 1),
      "this install never became the organizer, so it has nothing to forget").toBe(true);

    /* ── A PEER WE CANNOT RANK TAKES THE MAILBOX. ─────────────────────────────────────────
     *
     * A fresh LOCAL claim deliberately cannot do this: `decideLease` arm 3 keeps an entitled,
     * actively covering Cloud organizing, or a desktop install could take a paying customer's
     * mailbox by writing one message. What preempts a live Cloud is a claim in a protocol we
     * cannot read — treated as foreign AND fresh, never as unparseable-so-ignored.
     */
    fleet.seedClaim(mb.mailboxId, [
      "X-Ohmail-Lease: 1",
      "X-Ohmail-Organizer-Kind: local",
      "X-Ohmail-Install-Id: a-desktop-install",
      "X-Ohmail-Protocol: 99",
      `X-Ohmail-Heartbeat: ${new Date().toISOString()}`,
      `X-Ohmail-Claimed-At: ${new Date().toISOString()}`,
      "X-Ohmail-Display-Name: Mila's MacBook",
      "X-Ohmail-Nonce: n1",
      "", "",
    ].join("\r\n"));
    expect(await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      return row!.organizerRole === "reader";
    }), "the gate did not demote against a live foreign claim").toBe(true);

    // …and while it holds the mailbox it supersedes our document with its own — append its own,
    // expunge ours, which is what the write-behind does on the other side of a handover.
    const theirs = makeProfileDoc({
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [{
        kind: "sender", match: "friend@elsewhere.example", destination: "INBOX",
        priority: 0, enabled: true, provenance: "promoted",
      }],
      notifyRules: [], awayResponder: null, tagNames: ["theirs"],
      signature: null,
    }, { updatedAt: new Date(Date.now() + 60_000), producer: { kind: "local", version: "0.9.3" } });
    await meta.appendProfile(formatProfileMessage(theirs, { installId: "someone-elses-mac" }));
    await meta.removeProfiles(meta.messages.filter((m) => m.raw.includes(INSTALL)).map((m) => m.ref));

    // ── AND THEN IT LETS GO, SO WE ARE PROMOTED IN PLACE. ─────────────────────────────────
    await meta.removeClaims(meta.messages.filter((m) => m.raw.includes("a-desktop-install")).map((m) => m.ref));
    /* ── AND SOMEBODY PRESSES "ORGANIZE HERE" (0.14.1) ────────────────────────────────────
     *
     * A released claim leaves an EMPTY folder, and an empty folder used to promote this process on
     * its own. That auto-resume is deleted: a reader with no press never enters the write gate on
     * either door, because "the last organizer tidied up after itself" is not somebody asking for
     * this machine. So the promotion this case is about needs the human action it always should
     * have needed, and the stamp is what the ceremony writes.
     *
     * The subject of the case is unchanged and is everything after the promotion — the import hold,
     * and the document the outgoing organizer left. */
    await db.update(mailboxes).set({ takeoverAuthorizedAt: new Date() })
      .where(eq(mailboxes.id, mb.mailboxId));
    expect(await waitFor(async () => {
      const [row] = await db.select().from(mailboxes).where(eq(mailboxes.id, mb.mailboxId));
      return row!.organizerRole === "organizer";
    }), "the press did not promote the reader in place").toBe(true);

    // A sender their document answers for, delivered to the organizing runtime.
    const held = { from: "friend@elsewhere.example", subject: "standing", messageId: "repromo-1@x" };
    fleet.behave(mb.mailboxId, { deliver: [held] });

    const rowFor = async (from: string) => {
      const [msg] = await db.select().from(messages)
        .where(and(eq(messages.mailboxId, mb.mailboxId), eq(messages.fromAddress, from)));
      if (!msg) return null;
      const [fs] = await db.select().from(folderState).where(eq(folderState.messageId, msg.id));
      return { msg, fs };
    };
    expect(await waitFor(async () => (await rowFor(held.from)) !== null)).toBe(true);
    const adopted = (await rowFor(held.from))!;
    expect(adopted.fs?.desiredFolder,
      "a re-promoted organizer re-screened a history the inherited document answers for").toBe("INBOX");
    expect(adopted.fs?.lastSetBy).toBe("external");
  }, 120_000);

  it("a foreign document appearing MID-FLIGHT is surfaced (marker, unheld) and then superseded — never silently expunged", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });

    const worker = await startWorker(workerConfig(fleet));
    closers.push(() => worker.stop());
    const meta = fleet.metaFor(mb.mailboxId);
    expect(await waitFor(async () => meta.profileAppends === 1)).toBe(true);

    // The transient overlap's loser appends a DIFFERENT document under the established
    // organizer. Last-incumbent-wins says our store is the truth — but the content must be
    // surfaced durably before anything supersedes it.
    const ghost = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null },
      { updatedAt: new Date(Date.now() + 1000), producer: { kind: "local", version: "0.9.3" } },
    );
    await meta.appendProfile(formatProfileMessage(ghost, { installId: "the-overlap-loser" }));

    // Dirty the store, so the write path is the discovery site.
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine-too", hue: "moss" });

    // Surfaced: one durable marker, NOT held for import (we are the incumbent, not an importer)…
    expect(await waitFor(async () =>
      (await db.select().from(auditLog)
        .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))))
        .some((r) => (r.payload as { heldForImport?: boolean }).heldForImport === false))).toBe(true);
    // …and then superseded: exactly one document, ours, carrying the incumbent's store.
    expect(await waitFor(async () => {
      const docs = profileDocs(fleet, mb.mailboxId);
      return docs.length === 1 && docs[0]!.installId === INSTALL
        && docs[0]!.doc!.tagNames.join(",") === "mine,mine-too";
    }), "the incumbent's write must supersede the surfaced ghost").toBe(true);
  }, 60_000);

  it("overlap residue heals with NO local change: the verify pass surfaces the differing document and rewrites", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "steady", hue: "moss" });

    const worker = await startWorker(workerConfig(fleet));
    closers.push(() => worker.stop());
    const meta = fleet.metaFor(mb.mailboxId);
    expect(await waitFor(async () => meta.profileAppends === 1)).toBe(true);

    // The loser's document lands NEWER than ours, and nothing about our store ever changes —
    // the state the fingerprint comparison alone can never leave (a review finding).
    const ghost = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["ghost"], signature: null },
      { updatedAt: new Date(Date.now() + 1000), producer: { kind: "local", version: "0.9.3" } },
    );
    await meta.appendProfile(formatProfileMessage(ghost, { installId: "the-overlap-loser" }));

    // Healed: the verify pass surfaces it and the next tick rewrites — one document, ours.
    expect(await waitFor(async () => {
      const docs = profileDocs(fleet, mb.mailboxId);
      return docs.length === 1 && docs[0]!.installId === INSTALL
        && docs[0]!.doc!.tagNames.join(",") === "steady";
    }), "the steady-state verify must heal the overlap residue").toBe(true);
    const markers = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)));
    expect(markers.length).toBeGreaterThanOrEqual(1);
    expect((markers[0]!.payload as { heldForImport?: boolean }).heldForImport).toBe(false);
  }, 60_000);

  it("a NEWER document appearing mid-flight blocks writes AND leaves the durable marker", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "v1-era", hue: "moss" });

    const worker = await startWorker(workerConfig(fleet));
    closers.push(() => worker.stop());
    const meta = fleet.metaFor(mb.mailboxId);
    expect(await waitFor(async () => meta.profileAppends === 1)).toBe(true);

    // A newer producer's document lands (a v2 build organized this mailbox for a moment).
    const v2 = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["from-the-future"], signature: null },
      { updatedAt: new Date(Date.now() + 1000), producer: { kind: "local", version: "9.9.9" } },
    ) as unknown as Record<string, unknown>;
    v2.v = PROFILE_VERSION + 1;
    await meta.appendProfile(formatProfileMessage(v2 as never, { installId: "a-newer-build" }));
    // AFTER the seeded append: the worker's own appends are what must not grow from here.
    const appendsBefore = meta.profileAppends;

    // Dirty the store so the write path meets it.
    await db.insert(tags).values({ accountId: mb.accountId, name: "v1-change", hue: "moss" });

    // The refusal leaves the durable marker (a review finding — the log line alone is not readable by
    // the confirm flow), and nothing is ever appended over the newer document.
    expect(await waitFor(async () =>
      (await db.select().from(auditLog)
        .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))))
        .some((r) => (r.payload as { state?: string; v?: number }).state === "newer"))).toBe(true);
    await new Promise((r) => setTimeout(r, 900));
    expect(meta.profileAppends, "an older build must never write over a newer document").toBe(appendsBefore);
    const raws = meta.messages.map((m) => parseProfileMessage(m.raw)).filter((r) => r !== null);
    expect(raws.some((r) => !isMalformedProfile(r!) && (r as { status: string }).status === "newer"),
      "the newer document must still be in the folder").toBe(true);
  }, 60_000);

  it("a detection marker that fails transiently is RETRIED — the confirm flow's record is owed, not best-effort", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);

    // A travelling profile awaits import (the hold case), and the FIRST marker write fails.
    const travelling = makeProfileDoc(
      { screener: [{ address: "friend@x.example" }], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null },
      { updatedAt: new Date(), producer: { kind: "local", version: "0.9.3" } },
    );
    const meta = fleet.metaFor(mb.mailboxId);
    await meta.appendProfile(formatProfileMessage(travelling, { installId: "another-mac" }));
    await db.insert(tags).values({ accountId: mb.accountId, name: "local-state", hue: "moss" });

    let failInserts = 1;
    const flakyDb = failingInserts(db, () => failInserts > 0 && failInserts-- > 0);

    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    const events: string[] = [];
    const sync = new OrganizerProfileSync({
      db: flakyDb, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: 0,
      log: (event) => { events.push(event); },
    });

    await sync.onOrganize(); // seed: hold engaged, marker write FAILS
    expect(events).toContain("organizer_profile_marker_failed");
    expect(await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))))
      .toHaveLength(0);

    await sync.onOrganize(); // the database recovered: the pending marker is delivered
    const rows = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)));
    expect(rows, "the marker must be retried once the database recovers").toHaveLength(1);
    expect((rows[0]!.payload as { heldForImport?: boolean }).heldForImport).toBe(true);
    // …and the hold never lapsed while the marker was owed: the travelling document is still there,
    // with this install's own written beside it and nothing removed.
    expect(sync.importDecisionOpen()).toBe(true);
    expect(profileDocs(fleet, mb.mailboxId).map((d) => d.installId).sort()).toEqual(["another-mac", INSTALL].sort());
  }, 30_000);

  it("our OWN stale document is refreshed on resume — same install id, no hold", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    // A previous run of THIS organizer wrote a document; configuration changed while it was down.
    const stale = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["old-tag"], signature: null },
      { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "cloud", version: "dev" } },
    );
    const meta = fleet.metaFor(mb.mailboxId);
    await meta.appendProfile(formatProfileMessage(stale, { installId: INSTALL }));
    const seededAppends = meta.profileAppends;
    await db.insert(tags).values({ accountId: mb.accountId, name: "new-tag", hue: "moss" });

    const worker = await startWorker(workerConfig(fleet));
    closers.push(() => worker.stop());

    expect(await waitFor(async () => meta.profileAppends === seededAppends + 1)).toBe(true);
    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.doc!.tagNames).toEqual(["new-tag"]);
    // No import marker for our own bookkeeping: there is no decision to make.
    expect(await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))))
      .toHaveLength(0);
  }, 60_000);
});

describe("the hold's OTHER release — the user's durable answer", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_profile"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  /** The durable view the confirm surface composes: the latest marker, closed by its answer. */
  async function durableOpen(db: Db, accountId: string, mailboxId: string): Promise<boolean> {
    const m = await latestProfileFoundMarker(db, accountId, mailboxId);
    if (!m) return false;
    if (m.state === "found") {
      if (!m.heldForImport || m.fingerprint === null) return false;
      return !(await profileImportResolutionExists(db, { accountId, mailboxId, fingerprint: m.fingerprint }));
    }
    return typeof m.v === "number" && !(await profileImportResolutionExists(db, { accountId, mailboxId, newerV: m.v }));
  }

  /** A sync driven tick by tick — the marker-retry test's harness, shared by these. */
  function directSync(
    db: Db, fleet: FakeAdapterFleet, mb: { accountId: string; mailboxId: string }, events: string[],
    flushIntervalMs = 0,
  ) {
    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    return new OrganizerProfileSync({
      db, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs,
      log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
    });
  }

  /** The fingerprint `seedForeignDoc` seeds — recomputable without the fleet. */
  function seedForeignDocFingerprint(): string {
    return profileFingerprint({
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"],
      signature: null,
    });
  }

  /** The travelling document these tests hold on: one screened-in sender, foreign install. */
  /** What routing holds, in one word: the kind of `importHoldNow()`'s answer, or `closed`. */
  async function holdOf(sync: OrganizerProfileSync): Promise<"document" | "unreadable" | "closed"> {
    return (await sync.importHoldNow())?.kind ?? "closed";
  }

  async function seedForeignDoc(
    fleet: FakeAdapterFleet, mailboxId: string, updatedAt = new Date("2026-08-01T00:00:00Z"),
  ): Promise<string> {
    const payload: OrganizerProfilePayload = {
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"],
      signature: null,
    };
    const doc = makeProfileDoc(payload, {
      updatedAt, producer: { kind: "local", version: "0.9.3" },
    });
    await fleet.metaFor(mailboxId).appendProfile(formatProfileMessage(doc, { installId: "someone-elses-mac" }));
    return profileFingerprint(payload);
  }

  it("the answer releases at the CYCLE EDGE — `importDecisionOpenFresh` does not wait out the flush debounce", async () => {
    // Review round 1: the write-behind's five-minute debounce is a WRITE cadence, and a hold
    // released only on the flush tick keeps adopting strangers' mail as `external` for a whole
    // interval after the person decided. The cycle-edge read releases without a flush.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const fingerprint = await seedForeignDoc(fleet, mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events, 600_000); // the debounce that must NOT gate the release

    await sync.onOrganize(); // seed: hold armed
    expect(sync.importDecisionOpen()).toBe(true);
    expect(await sync.importDecisionOpenFresh(), "unanswered ⇒ still open").toBe(true);

    // "Not now" settles ROUTING at once and keeps the WRITE hold: the declined document stays.
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", fingerprint,
    });
    expect(await holdOf(sync), "a decline closes the routing question").toBe("closed");
    expect(await sync.importDecisionOpenFresh(), "a decline is not a write release").toBe(true);
    expect(sync.importDecisionOpen()).toBe(true);
    // Not even one that re-arms onto the same document: `resolved` is the release, and it waits.
    expect(events.some((e) => e.includes("\"state\":\"resolved\"")), "a decline released the hold").toBe(false);

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "replaced", fingerprint,
    });
    // No onOrganize tick between the answer and this read — the debounce would swallow one.
    expect(await sync.importDecisionOpenFresh(), "replaced ⇒ released before the next flush").toBe(false);
    expect(sync.importDecisionOpen()).toBe(false);
    expect(events.some((e) => e.includes("\"state\":\"resolved\""))).toBe(true);
  }, 30_000);

  it("the seed CLEARS a provisional hold whose document is gone — an armed question the folder no longer asks", async () => {
    // Review round 1: `armHoldFromFolder` runs at attach, the seed at the first tick, and a
    // document expunged in between must not leave a hold with nothing behind it — that would
    // suppress screening and write-behind for ever, with nothing for the confirm surface to answer.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);

    await sync.armHoldFromFolder();
    expect(sync.importDecisionOpen()).toBe(true);

    // The document vanishes before the first tick (another client expunged it by hand).
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    expect(i).toBeGreaterThanOrEqual(0);
    meta.messages.splice(i, 1);

    await sync.onOrganize(); // the authoritative seed
    expect(sync.importDecisionOpen(), "no document ⇒ no import question ⇒ no hold").toBe(false);
    // …and by the SEED's own reading, not by the lapse valve: the provisional hold is superseded
    // BEFORE the hold block runs, so this tick reports the folder's true state (`none`) and never
    // a lapse of a question the folder never asked. Restore the seed's provisional-hold clear
    // mutation (delete the two nulls above the `detected` closure) and this line goes red.
    expect(events.some((e) => e.includes("\"state\":\"hold_lapsed\""))).toBe(false);
    expect(events.some((e) => e.includes("\"state\":\"none\""))).toBe(true);
  }, 30_000);

  it("a HELD document expunged by hand LAPSES the hold on the next tick — screening is not suppressed for ever", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);

    await sync.onOrganize(); // seed: hold armed on the found document
    expect(sync.importDecisionOpen()).toBe(true);
    const appends = meta.profileAppends;

    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);

    await sync.onOrganize(); // the lapse tick: releases, writes nothing
    expect(sync.importDecisionOpen()).toBe(false);
    expect(events.some((e) => e.includes("\"state\":\"hold_lapsed\""))).toBe(true);
    expect(meta.profileAppends, "the lapse tick itself writes nothing").toBe(appends);
  }, 30_000);

  /**
   * THE FIND IS ASKED FOR AT ONCE: the marker lands with one `settings` change row, the doorbell
   * every client drains and keys its card's re-ask on (`ProfileImportCard.tsx`). A repeated fact
   * rings nothing, a lapse rings so a standing card elsewhere retires, and no settings row is
   * written, so no consent stamp moves. Delete the `recordChanges` call in `writeMarker` and the
   * first ring assertion goes red.
   */
  it("the FIND rings the settings doorbell with its marker; a repeated fact rings nothing; a lapse rings", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const count = async (rows: Promise<unknown[]>): Promise<number> => (await rows).length;
    const rings = () => count(db.select({ seq: changeLog.seq }).from(changeLog).where(and(
      eq(changeLog.accountId, mb.accountId), eq(changeLog.entityType, "settings"), eq(changeLog.entityId, mb.accountId))));
    const markers = () => count(db.select({ id: auditLog.id }).from(auditLog).where(and(
      eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))));
    expect(await rings(), "the fixture starts with a doorbell already rung").toBe(0);

    await sync.onOrganize(); // the seed finds the foreign document and arms the hold
    expect(sync.importDecisionOpen()).toBe(true);
    expect(await markers()).toBe(1);
    expect(await rings(), "the find recorded its marker and rang no client").toBe(1);

    // A second attachment meeting the SAME held document: the marker dedups and nothing rings.
    await directSync(db, fleet, mb, events).armHoldFromFolder();
    expect(await markers()).toBe(1);
    expect(await rings(), "an unchanged fact rang the doorbell again").toBe(1);

    // The document is expunged: the hold lapses, the lapse is a new fact, and it rings.
    const meta = fleet.metaFor(mb.mailboxId);
    meta.messages.splice(meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null), 1);
    await sync.onOrganize();
    expect(sync.importDecisionOpen()).toBe(false);
    expect(await markers()).toBe(2);
    expect(await rings(), "the lapse did not ring, so a card elsewhere keeps asking a closed question").toBe(2);
    expect(await count(db.select().from(accountSettings).where(eq(accountSettings.accountId, mb.accountId))),
      "the doorbell wrote the settings row, which moves every consent stamp").toBe(0);
  }, 30_000);

  it("`armHoldFromFolder` does not re-open an answered question", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const fingerprint = await seedForeignDoc(fleet, mb.mailboxId);
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", fingerprint,
    });
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await sync.armHoldFromFolder();
    expect(sync.importDecisionOpen(), "a decline already on record answers the same document").toBe(false);
  }, 30_000);

  it("a held document REPLACED by another foreign document RE-ARMS the hold — the question changed, it did not close", async () => {
    // Review round 2: the confirm surface reads the FOLDER and offers whatever stands there, so
    // a lapse on replacement would resume screening under an open prompt. The hold tracks the
    // folder instead: released only when the folder asks nothing, re-armed when it asks anew.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);

    await sync.onOrganize(); // seed: hold on the first document
    expect(sync.importDecisionOpen()).toBe(true);

    // The previous organizer writes AGAIN while the question is open: new content, new question.
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "second@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-v2"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));

    await sync.onOrganize(); // the re-derivation tick
    expect(sync.importDecisionOpen(), "the hold must track the folder's CURRENT question").toBe(true);
    expect(events.some((e) => e.includes("\"state\":\"hold_lapsed\"")), "a replacement is not a lapse").toBe(false);

    // A STALE answer — a tab answering the REPLACED document A after the folder moved on to B —
    // must not release B's hold (review round 6: the old mailbox-wide since-valve did exactly
    // that). Only the exact subject releases.
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: await seedForeignDocFingerprint(),
    });
    expect(await sync.importDecisionOpenFresh(),
      "an answer to the superseded document is not an answer to this one").toBe(true);

    // …and the answer for the REPLACEMENT (what the surface actually offers) releases it.
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: profileFingerprint(replacement),
    });
    expect(await sync.importDecisionOpenFresh()).toBe(false);
  }, 30_000);

  it("a NEWER format's document arms the routing hold too, and the dismiss releases it — the write posture stands", async () => {
    // Review round 2: a v(n+1) document carries decisions this build cannot read but knows
    // exist. Routing a takeover from a cold store past them is the same defect with a version
    // bump, so the update-or-dismiss question holds the gate exactly as an import question does.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    const v2 = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["from-the-future"], signature: null },
      { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "9.9.9" } },
    ) as unknown as Record<string, unknown>;
    v2.v = PROFILE_VERSION + 1;
    await meta.appendProfile(formatProfileMessage(v2 as never, { installId: "a-newer-build" }));
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    // The preflight arms it — the first routing decision must already see it (the drill's race).
    await sync.armHoldFromFolder();
    expect(sync.importDecisionOpen(), "a newer document is an open question").toBe(true);

    // …and it survives the seed (which also takes the write posture).
    await sync.onOrganize();
    expect(sync.importDecisionOpen()).toBe(true);

    // The user dismisses ("organize with what you have") — the surface's newerV resolution.
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", newerV: PROFILE_VERSION + 1,
    });
    expect(await sync.importDecisionOpenFresh(), "the dismiss settles the ROUTING question").toBe(false);

    // The WRITE posture stands: a local change after the dismiss still writes nothing over a
    // document this build cannot represent.
    await db.insert(tags).values({ accountId: mb.accountId, name: "post-dismiss", hue: "moss" });
    const appends = meta.profileAppends;
    await sync.onOrganize();
    expect(meta.profileAppends, "blockedByNewer is not released by the routing answer").toBe(appends);
  }, 30_000);

  it("a newer-format hold SWAPPED for a found one still releases behind the write wall", async () => {
    // Review round 3: `blockedByNewer` returns for the life of the process, and a fingerprint
    // hold walled off behind it would never run its release or re-derivation again — held for
    // ever once its document vanished, with nothing for the confirm surface to answer. The
    // found-hold block therefore runs BEFORE that return.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    const v2 = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["future"], signature: null },
      { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "9.9.9" } },
    ) as unknown as Record<string, unknown>;
    v2.v = PROFILE_VERSION + 1;
    await meta.appendProfile(formatProfileMessage(v2 as never, { installId: "a-newer-build" }));
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await sync.onOrganize(); // seed: newer ⇒ write wall up + routing hold on v2
    expect(sync.importDecisionOpen()).toBe(true);

    // The newer build hands back: its document is replaced by a readable foreign one.
    const i = meta.messages.findIndex((m) => m.raw.includes("a-newer-build") || parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    await seedForeignDoc(fleet, mb.mailboxId);
    await sync.onOrganize(); // re-derivation: the hold swaps to the found document
    expect(sync.importDecisionOpen(), "the swapped question keeps holding").toBe(true);

    // …and that document vanishes too. The found hold must still lapse — the write wall
    // (`blockedByNewer`) may never wall off the hold's own release.
    const j = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    expect(j).toBeGreaterThanOrEqual(0);
    meta.messages.splice(j, 1);
    await sync.onOrganize();
    expect(sync.importDecisionOpen(), "an unanswerable hold lapses even behind the write wall").toBe(false);
    expect(events.some((e) => e.includes("\"state\":\"hold_lapsed\""))).toBe(true);
  }, 30_000);

  it("the DURABLE hold predicate answers for a process that is not this one — the backstop's read", async () => {
    // Review round 4: the reconcile backstop runs precisely when no worker leads, so the
    // in-memory hold died with the worker. the durable pair (marker + resolution) derives the same answer from
    // the marker + the resolution rows alone.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const fingerprint = await seedForeignDoc(fleet, mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "no marker yet ⇒ nothing to hold").toBe(false);
    await sync.onOrganize(); // seed: hold + durable marker
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "a held marker with no answer is an open question, in any process").toBe(true);
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", fingerprint,
    });
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "the durable answer closes it").toBe(false);
  }, 30_000);

  it("a faulted preflight is RETRIED — `armed` is stamped only when the decision completed", async () => {
    // Review round 4: an `armed` set right after the folder read survives a throw from the
    // serializer, and in the sidecar the next seed is a whole drain away — one profile-specific
    // database blip must cost ONE cycle, not a drain's worth.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    let failSelects = 1;
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select" && failSelects > 0) {
          return () => { failSelects--; throw new Error("transient database blip"); };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    const events: string[] = [];
    const sync = new OrganizerProfileSync({
      db: flakyDb, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: 0,
      log: (event) => { events.push(event); },
    });

    await sync.armHoldFromFolder(); // the serializer faults mid-preflight
    expect(sync.importDecisionOpen()).toBe(false);
    await sync.armHoldFromFolder(); // the retry completes and arms
    expect(sync.importDecisionOpen(), "a half-run preflight must not be remembered as done").toBe(true);
  }, 30_000);

  it("CONVERGENCE releases at the cycle edge too — a sibling mailbox's import must not leave this one adopting", async () => {
    // Review round 4: the store is account-scoped; the same travelling profile imported through
    // another mailbox makes local state equal this hold's document with no resolution row for
    // THIS mailbox, and the candidate vanishes from the confirm surface the moment they match.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId); // screener: a foreign sender, tag "theirs"
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events, 600_000); // the debounce must not gate this

    await sync.onOrganize(); // seed: hold armed
    expect(await sync.importDecisionOpenFresh()).toBe(true);

    // The sibling's import lands: the ACCOUNT store now says exactly what the document says.
    await db.insert(contacts).values({ accountId: mb.accountId, address: "friend@elsewhere.example" });
    await db.insert(tags).values({ accountId: mb.accountId, name: "theirs", hue: "moss" });

    expect(await sync.importDecisionOpenFresh(),
      "local == document is the answered state, however it was reached").toBe(false);
    // …and the DURABLE half closes with it (round 14): the held marker must not outlive the
    // question, or the backstop adopts and the candidate surface dials IMAP for nothing.
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "a convergence release must reach the marker the backstop reads").toBe(false);
  }, 30_000);

  it("an OLDER ohmail's document saying exactly what we say is not a question — it is re-canonicalised", async () => {
    /**
     * THE VERSIONED CANONICAL FORM, at the seam where it decides what a person sees.
     *
     * The fingerprint is taken over a canonical form and the form is versioned, so hashing the
     * local store at this build's version and the folder's v1 document at v1 answers a question
     * about WHO WROTE THEM, not about what they say: identical configuration compares different,
     * the seed arms a hold, and the confirm surface offers to import the settings already in use —
     * every tick asking the same way, so it cannot be cleared. The content question is asked at
     * the DOCUMENT's version; the v1 copy is rewritten as v2 by the next WRITE, never on read.
     */
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    // Local state FIRST: the store already says what the folder is about to.
    await db.insert(contacts).values({ accountId: mb.accountId, address: "friend@elsewhere.example" });
    await db.insert(tags).values({ accountId: mb.accountId, name: "theirs", hue: "moss" });

    const payload: OrganizerProfilePayload = {
      screener: [{ address: "friend@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs"], signature: null,
    };
    const older = makeProfileDoc(
      payload,
      { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "0.17.0" } },
      1,
    );
    expect(older.v, "the fixture is not a v1 document").toBe(1);
    expect(
      profileFingerprint(older),
      "the two canonical versions hash alike here — this fixture would pass without the fix",
    ).not.toBe(profileFingerprint(payload));
    const meta = fleet.metaFor(mb.mailboxId);
    await meta.appendProfile(formatProfileMessage(older, { installId: "an-older-install" }));

    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    await sync.onOrganize();

    expect(sync.importDecisionOpen(), "an older ohmail's copy of our own settings became a question").toBe(false);
    expect(await durableOpen(db, mb.accountId, mb.mailboxId), "…and reached the durable marker").toBe(false);
    expect(events.join("\n"), "the seed did not read it as in sync").toContain("found_in_sync");

    // …and a local change is written OVER it, at THIS build's version. That is the whole of the
    // re-canonicalisation: at the write, once, and never as a rewrite triggered by a read.
    await db.insert(tags).values({ accountId: mb.accountId, name: "ours", hue: "moss" });
    const appendsBefore = meta.profileAppends;
    await sync.onOrganize();
    expect(meta.profileAppends, "the write refused the older copy as a stranger's").toBe(appendsBefore + 1);
    const live = meta.messages
      .map((m) => parseProfileMessage(m.raw))
      .filter((r) => r !== null && !isMalformedProfile(r));
    expect(live).toHaveLength(1);
    const only = live[0]!;
    if (only === null || isMalformedProfile(only)) throw new Error("the folder holds no readable document");
    expect(only.doc!.v, "the rewrite carried the older document's version forward").toBe(PROFILE_VERSION);
    expect(only.doc!.tagNames).toEqual(["ours", "theirs"]);
  }, 30_000);

  it("a fault during the re-derivation leaves the STANDING hold standing", async () => {
    // Review round 5: the rehold used to clear the active hold BEFORE the replacement's
    // resolution read, so a one-off database blip there released the gate for a whole debounce
    // interval. The swap now commits only after every fallible read has answered.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const meta = fleet.metaFor(mb.mailboxId);
    // auditLog reads only, counted: the tick under test reads (1) the old hold's resolution,
    // then the REHOLD's replacement check is read #2 — the one that faults. (`writeMarker`'s
    // dedupe read comes later and self-catches, so faulting from #3 on would prove nothing —
    // review round 9 caught this test aimed there after the since-valve's removal shifted the
    // indices.) Serialization reads other tables and is untouched.
    let auditReads = 0;
    let failFrom = Number.POSITIVE_INFINITY;
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) => {
            const builder = (target as unknown as { select: (...a: unknown[]) => unknown }).select(...args);
            return new Proxy(builder as object, {
              get(bt, bprop, br) {
                if (bprop === "from") {
                  return (tbl: unknown) => {
                    if (tbl === auditLog) {
                      auditReads++;
                      if (auditReads >= failFrom) throw new Error("transient database blip");
                    }
                    return (bt as unknown as { from: (t: unknown) => unknown }).from(tbl);
                  };
                }
                return Reflect.get(bt, bprop, br);
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    const events: string[] = [];
    const sync = new OrganizerProfileSync({
      db: flakyDb, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: 0,
      log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
    });

    await sync.onOrganize(); // seed: hold on the first document
    expect(sync.importDecisionOpen()).toBe(true);

    // The document is replaced while the question is open…
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc({
        screener: [{ address: "replacement@elsewhere.example" }],
        rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-b"],
        signature: null,
      }, { updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" } }),
      { installId: "someone-elses-mac" },
    ));

    // …and the replacement's own resolution read faults mid-rehold.
    auditReads = 0;
    failFrom = 2;
    await sync.onOrganize(); // throws inside, caught by the tick — the hold must survive
    expect(sync.importDecisionOpen(), "a faulted re-derivation must not release the gate").toBe(true);

    failFrom = Number.POSITIVE_INFINITY;
    await sync.onOrganize(); // the retry completes the swap onto the replacement
    expect(sync.importDecisionOpen()).toBe(true);
  }, 30_000);

  it("a LAPSE is durable — the backstop's predicate closes with it, and a crashed hold lapses at the next preflight", async () => {
    // Review round 5: the lapse lived only in the process that observed it, so a worker exit
    // right after (or during) a lapse left the durable marker saying HELD — and the reconcile
    // backstop then adopted for ever on a question the import surface no longer offers.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const meta = fleet.metaFor(mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await sync.onOrganize(); // seed: hold + durable marker
    expect(await durableOpen(db, mb.accountId, mb.mailboxId)).toBe(true);

    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    await sync.onOrganize(); // the lapse tick
    expect(sync.importDecisionOpen()).toBe(false);
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "the lapse must reach the durable half the backstop reads").toBe(false);

    // The crash shape: a hold armed and marked by a process that died before any rehold tick.
    const fleet2 = new FakeAdapterFleet();
    const mb2 = await seedMailbox(db);
    await seedForeignDoc(fleet2, mb2.mailboxId);
    const events2: string[] = [];
    const first = directSync(db, fleet2, mb2, events2);
    await first.armHoldFromFolder(); // marker written; the process "dies" here
    expect(await durableOpen(db, mb2.accountId, mb2.mailboxId)).toBe(true);
    const meta2 = fleet2.metaFor(mb2.mailboxId);
    const j = meta2.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta2.messages.splice(j, 1); // the document is gone before any successor looks

    const successor = directSync(db, fleet2, mb2, events2);
    await successor.armHoldFromFolder(); // the next preflight reconciles the stale marker
    expect(await durableOpen(db, mb2.accountId, mb2.mailboxId),
      "a successor's preflight lapses a held marker the folder no longer backs").toBe(false);
  }, 30_000);

  it("an ANSWERED release re-derives from the folder — an answer to A is not an answer to the B that replaced it", async () => {
    // Review round 7: a stale tab answers A after the folder moved on to B; the exact-subject
    // release must not resume the gate while B's question is open. The release re-reads the
    // folder and arms whatever stands there.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const meta = fleet.metaFor(mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events, 600_000);

    await sync.onOrganize(); // seed: hold on A
    expect(sync.importDecisionOpen()).toBe(true);

    // The folder moves on to B while the question is open…
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "replacement-b@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-b"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));

    // …and the STALE answer to A lands (the in-memory hold still keys A — no tick ran between).
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: seedForeignDocFingerprint(),
    });
    expect(await sync.importDecisionOpenFresh(),
      "the release must arm the question the folder now asks").toBe(true);

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: profileFingerprint(replacement),
    });
    expect(await sync.importDecisionOpenFresh()).toBe(false);
  }, 30_000);

  it("an answered release that meets a DECLINED replacement re-holds it at once — never a lapse", async () => {
    // The derivation asks the WRITE question (`profileImportWriteReleased`): B was declined, so B
    // is still a document this install may not overwrite, and the hold moves onto it directly.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const fpA = await seedForeignDoc(fleet, mb.mailboxId);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    const meta = fleet.metaFor(mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    await sync.onOrganize(); // seed: hold on A

    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "declined-b@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-declined-b"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "declined", fingerprint: profileFingerprint(replacement),
    });
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "replaced", fingerprint: fpA,
    });

    await sync.onOrganize(); // the release of A re-derives onto B
    expect(sync.importDecisionOpen(), "the declined B is held on the release tick itself").toBe(true);
    expect(events.some((e) => e.includes("\"state\":\"hold_lapsed\"")), "a declined document is not a lapse").toBe(false);
    for (let tick = 0; tick < 3; tick++) await sync.onOrganize();
    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs.filter((d) => d.installId !== INSTALL).map((d) => profileFingerprint(d.doc!)),
      "the declined document stands").toEqual([profileFingerprint(replacement)]);
    expect(docs.map((d) => d.installId), "ours is published beside it").toContain(INSTALL);
  }, 30_000);

  it("a fault DURING an answered release's re-derivation leaves the answered hold standing", async () => {
    // Review round 8: the release must decide the folder's next posture BEFORE clearing — a
    // fault between "cleared" and "re-armed" would strand the mailbox with no hold, no retry,
    // and the replacement's question open.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const meta = fleet.metaFor(mb.mailboxId);
    let auditReads = 0;
    let failFrom = Number.POSITIVE_INFINITY;
    const flakyDb = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === "select") {
          return (...args: unknown[]) => {
            const builder = (target as unknown as { select: (...a: unknown[]) => unknown }).select(...args);
            return new Proxy(builder as object, {
              get(bt, bprop, br) {
                if (bprop === "from") {
                  return (tbl: unknown) => {
                    if (tbl === auditLog) {
                      auditReads++;
                      if (auditReads >= failFrom) throw new Error("transient database blip");
                    }
                    return (bt as unknown as { from: (t: unknown) => unknown }).from(tbl);
                  };
                }
                return Reflect.get(bt, bprop, br);
              },
            });
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as typeof db;
    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    const events: string[] = [];
    const sync = new OrganizerProfileSync({
      db: flakyDb, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: 600_000,
      log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
    });

    await sync.onOrganize(); // seed: hold on A
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "replacement-c@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-c"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: seedForeignDocFingerprint(),
    });

    // The answered check (read 1) succeeds; the derivation's replacement check (read 2) faults.
    auditReads = 0;
    failFrom = 2;
    expect(await sync.importDecisionOpenFresh(),
      "a fault mid-release must leave the hold held — retried, never stranded").toBe(true);
    failFrom = Number.POSITIVE_INFINITY;
    expect(await sync.importDecisionOpenFresh(), "the retry completes the swap onto B").toBe(true);
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: profileFingerprint(replacement),
    });
    expect(await sync.importDecisionOpenFresh()).toBe(false);
  }, 30_000);

  it("a NEWER document landing MID-WRITE arms the routing hold before the write wall rises", async () => {
    // Review round 8: the write path's `newer` refusal sets the permanent write wall, and it is
    // the LAST look the attachment ever takes at the folder — a hold not armed here would have
    // mail re-screened under an unanswered update-or-dismiss prompt for the attachment's life.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await db.insert(tags).values({ accountId: mb.accountId, name: "first", hue: "moss" });
    await sync.onOrganize(); // seed (none) + first write: OUR document stands
    expect(meta.profileAppends).toBe(1);

    // A newer build's document lands; our next write refuses `newer`.
    const v2 = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["future"], signature: null },
      { updatedAt: new Date(Date.now() + 1000), producer: { kind: "local", version: "9.9.9" } },
    ) as unknown as Record<string, unknown>;
    v2.v = PROFILE_VERSION + 1;
    await meta.appendProfile(formatProfileMessage(v2 as never, { installId: "a-newer-build" }));
    await db.insert(tags).values({ accountId: mb.accountId, name: "second", hue: "moss" });
    await sync.onOrganize(); // the write meets the newer document
    expect(sync.importDecisionOpen(), "the newer question holds routing from the moment it is seen").toBe(true);

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", newerV: PROFILE_VERSION + 1,
    });
    expect(await sync.importDecisionOpenFresh()).toBe(false);
  }, 30_000);

  it("the debounced CONVERGENCE release re-reads the folder — a replaced document re-arms instead of slipping out", async () => {
    // Review round 9: local converged onto held document A, but the folder had moved on to
    // unanswered B; the debounced convergence arm released without looking, and B surfaced later
    // as an unheld mid-flight document — the hold must swap to B here exactly as it does at the
    // cycle edge.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const meta = fleet.metaFor(mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await sync.onOrganize(); // seed: hold on A
    // Local converges onto A (a sibling import / hand-edit)…
    await db.insert(contacts).values({ accountId: mb.accountId, address: "friend@elsewhere.example" });
    await db.insert(tags).values({ accountId: mb.accountId, name: "theirs", hue: "moss" });
    // …while the folder moves on to B.
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "conv-b@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-conv-b"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));

    await sync.onOrganize(); // the debounced tick: convergence arm, folder re-read
    expect(sync.importDecisionOpen(), "the hold must swap to the replacement, not slip out").toBe(true);
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: profileFingerprint(replacement),
    });
    expect(await sync.importDecisionOpenFresh()).toBe(false);
  }, 30_000);

  it("a marker that LANDED supersedes an older fact still owed from a failed write", async () => {
    // Review round 9: a pending failed marker retried AFTER a newer successful one would file
    // the stale fact as the LATEST row — an answered or replaced question resurrected over the
    // current one, read newest-first by the confirm surface and the backstop predicate alike.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const meta = fleet.metaFor(mb.mailboxId);
    let failInserts = 0;
    const flakyDb = failingInserts(db, () => failInserts > 0 && failInserts-- > 0);
    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    const events: string[] = [];
    const sync = new OrganizerProfileSync({
      db: flakyDb, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: 0,
      log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
    });

    failInserts = 1;
    await sync.onOrganize(); // seed: hold on A armed, A's marker write FAILS and is owed
    expect(events.some((e) => e.includes("organizer_profile_marker_failed"))).toBe(true);

    // The folder moves on to B, and the CYCLE-EDGE release commits B's marker — the path that
    // does not run the owed-marker retry first (`onOrganize` retries pending facts before its
    // hold blocks, so it cannot reproduce this ordering on its own).
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "pending-b@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-pending-b"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: seedForeignDocFingerprint(),
    });
    expect(await sync.importDecisionOpenFresh(), "the release re-derives onto B").toBe(true); // B's marker lands here
    await sync.onOrganize(); // a further tick must NOT re-file A's stale owed fact over B's
    const markers = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)))
      .orderBy(auditLog.createdAt);
    const latest = markers[markers.length - 1]!.payload as { fingerprint?: string | null };
    expect(latest.fingerprint, "the latest marker must stay the folder's current question")
      .toBe(profileFingerprint(replacement));
  }, 30_000);

  it("a preflight that found NOTHING keeps probing — a document landing in the overlap window is still held", async () => {
    // Review round 10: the lease permits a one-cycle organizer overlap, so the outgoing
    // organizer's last admitted cycle can append the travelling document AFTER an early
    // preflight honestly read `none`. A completed-read memo here would hide the document for
    // the sidecar's whole first drain; the preflight re-probes until the seed runs.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await sync.armHoldFromFolder(); // the folder is empty: nothing to hold — yet
    expect(sync.importDecisionOpen()).toBe(false);

    await seedForeignDoc(fleet, mb.mailboxId); // the outgoing organizer's late flush lands
    await sync.armHoldFromFolder(); // the next cycle's probe must see it
    expect(sync.importDecisionOpen(),
      "a nothing-there answer is a fact about ONE probe, never a memo").toBe(true);
  }, 30_000);

  it("a LAPSE closes only the subject it names — a stale process cannot hide a successor's question", async () => {
    // Review round 12: across a leadership handoff, an old instance's in-flight lapse (derived
    // from a folder snapshot that predates the successor's newly-armed question) can land AFTER
    // the successor's held marker. The lapse names its subject, and the durable reader honours
    // it only against that subject.
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const writeMarkerRow = async (payload: Record<string, unknown>): Promise<void> => {
      await db.insert(auditLog).values({
        accountId: mb.accountId, action: PROFILE_FOUND_AUDIT_ACTION,
        payload: { mailboxId: mb.mailboxId, ...payload }, inverse: null,
      });
      await new Promise((r) => setTimeout(r, 5)); // distinct created_at ordering
    };

    // The old instance held A; the successor armed B; the old instance's stale lapse(A) lands last.
    await writeMarkerRow({ state: "found", fingerprint: "fp-A", heldForImport: true });
    await writeMarkerRow({ state: "found", fingerprint: "fp-B", heldForImport: true });
    await writeMarkerRow({ state: "lapsed", fingerprint: "fp-A", heldForImport: false, v: null });
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "a lapse of A must not close B's open question").toBe(true);

    // …while a lapse that names the standing subject closes it.
    await writeMarkerRow({ state: "lapsed", fingerprint: "fp-B", heldForImport: false, v: null });
    expect(await durableOpen(db, mb.accountId, mb.mailboxId)).toBe(false);

    // The newer-format subject reads the same way.
    const mb2 = await seedMailbox(db);
    const writeMarkerRow2 = async (payload: Record<string, unknown>): Promise<void> => {
      await db.insert(auditLog).values({
        accountId: mb2.accountId, action: PROFILE_FOUND_AUDIT_ACTION,
        payload: { mailboxId: mb2.mailboxId, ...payload }, inverse: null,
      });
      await new Promise((r) => setTimeout(r, 5));
    };
    await writeMarkerRow2({ state: "newer", fingerprint: null, heldForImport: false, v: 2 });
    await writeMarkerRow2({ state: "lapsed", fingerprint: null, heldForImport: false, v: 3 });
    expect(await durableOpen(db, mb2.accountId, mb2.mailboxId),
      "a lapse of v3 must not close v2's question").toBe(true);
    await writeMarkerRow2({ state: "lapsed", fingerprint: null, heldForImport: false, v: 2 });
    expect(await durableOpen(db, mb2.accountId, mb2.mailboxId)).toBe(false);
  }, 30_000);

  it("an owed `found` fact survives a lapse landing — found-before-lapse ordering is preserved", async () => {
    // Review round 14: marker A durable, B's marker write transiently FAILS (owed), the user
    // answers B, and the answered release writes `lapsed(B)`. Dropping the owed `found(B)` at
    // that landing would leave the reader walking past lapsed(B) onto unmatched A — an already
    // answered mailbox reported open for ever.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const meta = fleet.metaFor(mb.mailboxId);
    let failInserts = 0;
    const flakyDb = failingInserts(db, () => failInserts > 0 && failInserts-- > 0);
    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    const events: string[] = [];
    const sync = new OrganizerProfileSync({
      db: flakyDb, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: 0,
      log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
    });

    await sync.onOrganize(); // seed: hold on A, marker A lands
    // The folder moves to B; B's re-arm succeeds but B's marker write FAILS and is owed.
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "owed-b@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-owed-b"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));
    failInserts = 1;
    await sync.onOrganize(); // rehold arms B; found(B)'s marker write fails and is owed
    expect(events.some((e) => e.includes("organizer_profile_marker_failed"))).toBe(true);
    expect(sync.importDecisionOpen()).toBe(true);

    // The user answers B; the release writes lapsed(B) — the owed found(B) must survive it.
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "replaced", fingerprint: profileFingerprint(replacement),
    });
    expect(await sync.importDecisionOpenFresh()).toBe(false);
    await sync.onOrganize(); // the owed found(B) is retried and files ABOVE the lapse
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "an answered mailbox must not read as open through a dropped owed marker").toBe(false);
  }, 30_000);

  it("`importHoldNow` evaluates the question from the current facts — nothing armed, nothing cached", async () => {
    // The structural answer fifteen review rounds converged on: routing consults the folder,
    // the store and the resolutions AT THE CYCLE EDGE, so there is no arm/release ordering to
    // race. Every state below is answered with no prior tick having run.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);

    expect(await holdOf(sync), "no document ⇒ no question").toBe("closed");

    const fingerprint = await seedForeignDoc(fleet, mb.mailboxId);
    expect(await holdOf(sync), "found, foreign, different, unanswered ⇒ open").toBe("document");

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", fingerprint,
    });
    expect(await holdOf(sync), "answered ⇒ closed, no tick needed").toBe("closed");

    // A NEW document re-opens (new content is new information)…
    const second: OrganizerProfilePayload = {
      screener: [{ address: "now-b@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["now-b"],
      signature: null,
    };
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(second, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));
    expect(await holdOf(sync)).toBe("document");

    // …and CONVERGENCE closes it with no resolution row and no tick.
    await db.insert(contacts).values({ accountId: mb.accountId, address: "now-b@elsewhere.example" });
    await db.insert(tags).values({ accountId: mb.accountId, name: "now-b", hue: "moss" });
    expect(await holdOf(sync), "local == document ⇒ nothing to import").toBe("closed");
  }, 30_000);

  it("`importHoldNow` carries the document's gate view, and an oversized document is no hold", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const sync = directSync(db, fleet, mb, []);
    await seedForeignDoc(fleet, mb.mailboxId);
    const hold = await sync.importHoldNow();
    expect(hold?.kind).toBe("document");
    expect(hold?.kind === "document" ? [...hold.knownSenders.addresses] : null, "the view is the document's screener").toEqual(["friend@elsewhere.example"]);

    // Import refuses a document over its list ceiling, so the hold has no answer to wait for.
    const big = makeProfileDoc({
      screener: Array.from({ length: PROFILE_LIST_MAX.screener + 1 }, (_, i) => ({ address: `s${i}@elsewhere.example` })),
      rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null,
    }, { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "0.9.3" } });
    const mb2 = await seedMailbox(db);
    await fleet.metaFor(mb2.mailboxId).appendProfile(formatProfileMessage(big, { installId: "someone-elses-mac" }));
    expect(await holdOf(directSync(db, fleet, mb2, [])), "an oversized document held routing").toBe("closed");
  }, 60_000);

  it("`importHoldNow`: a document the seed found IN SYNC is this install's own — a later local change opens no hold", async () => {
    // Measured on 0.25.1: a fresh install met another install's document equal to its
    // own empty settings (`found_in_sync`), no card was shown, and after its first decision arrivals
    // were held until its own write. The folder verdict was cached BEFORE the seed made the
    // document ours, so ownership is asked at every evaluation, not only at the folder read.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events, 600_000);
    const empty = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [], signature: null },
      { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "0.25.1" } },
    );
    await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(empty, { installId: "someone-elses-mac" }));

    expect(await holdOf(sync), "before the seed: local says what the document says").toBe("closed");
    await sync.onOrganize();
    expect(events.some((e) => e.includes("found_in_sync")), events.join("\n")).toBe(true);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    expect(await holdOf(sync), "an in-sync document read as an open question").toBe("closed");
  }, 30_000);

  it("`importHoldNow`: a NEWER document is open until dismissed, and a fault answers the previous cycle", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);
    const v2 = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["future"], signature: null },
      { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "9.9.9" } },
    ) as unknown as Record<string, unknown>;
    v2.v = PROFILE_VERSION + 1;
    await meta.appendProfile(formatProfileMessage(v2 as never, { installId: "a-newer-build" }));
    expect(await holdOf(sync), "unreadable decisions still exist ⇒ open").toBe("unreadable");

    // A fault answers what the previous evaluation answered — one stale cycle, retried.
    const io = (sync as unknown as { deps: { adapter: { profileIo: () => unknown } } }).deps.adapter;
    const realProfileIo = io.profileIo.bind(io);
    io.profileIo = () => { throw new Error("transient _meta fault"); };
    expect(await holdOf(sync), "fault ⇒ the previous answer, never a flip").toBe("unreadable");
    io.profileIo = realProfileIo;

    // …and a KNOWN armed hold outranks a stale answer (round 17): arm through the preflight on
    // a FRESH instance whose evaluator has never answered, fault the evaluation, and the armed
    // question must still hold the gate.
    const sync2 = directSync(db, fleet, mb, events);
    await sync2.armHoldFromFolder();
    expect(sync2.importDecisionOpen()).toBe(true);
    const io2 = (sync2 as unknown as { deps: { adapter: { profileIo: () => unknown } } }).deps.adapter;
    io2.profileIo = () => { throw new Error("transient _meta fault"); };
    expect(await holdOf(sync2),
      "an armed hold is stronger evidence than a fallback that never evaluated").toBe("unreadable");
    io2.profileIo = realProfileIo;

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", newerV: PROFILE_VERSION + 1,
    });
    expect(await holdOf(sync), "dismissed ⇒ closed").toBe("closed");

    // …and the fault direction holds from the closed side too.
    io.profileIo = () => { throw new Error("transient _meta fault"); };
    expect(await holdOf(sync)).toBe("closed");
  }, 30_000);

  it("`importHoldNow`: an ESTABLISHED incumbent does not hold on mid-flight overlap residue", async () => {
    // Review round 16: the permitted overlap's loser can append its document under an organizer
    // that already owns this mailbox's configuration. The write path surfaces and supersedes it
    // (last-incumbent-wins); the routing evaluator must agree, or overlap residue diverts the
    // consent gate until the next debounced rewrite.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);

    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    await sync.onOrganize(); // seed (none) + first write: this organizer OWNS the document
    expect(meta.profileAppends).toBe(1);

    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc({
        screener: [{ address: "loser@elsewhere.example" }],
        rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-late"],
        signature: null,
      }, { updatedAt: new Date(Date.now() + 1000), producer: { kind: "local", version: "0.9.3" } }),
      { installId: "the-overlap-loser" },
    ));
    expect(await holdOf(sync),
      "mid-flight residue under an incumbent is superseded, never held").toBe("closed");
  }, 30_000);

  it("`importHoldNow` reads the folder on a CLOCK, not per call — a drain cannot re-download the document per batch", async () => {
    // Review round 18: the document is unbounded and `readOrganizerProfile` fetches full source,
    // so the folder verdict is cached (seeded: the flush interval; unseeded: a short takeover
    // TTL) while the database-side answer stays per-call.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events, 600_000); // seeded TTL = the flush interval
    const io = (sync as unknown as { deps: { adapter: { profileIo: () => { listProfileMessages: () => Promise<unknown[]> } } } }).deps.adapter;
    const realProfileIo = io.profileIo.bind(io);
    let folderReads = 0;
    io.profileIo = (...args: unknown[]) => {
      /* FORWARDS ITS ARGUMENTS. The seam refuses an identity it cannot key a memory by,
       * so a spy that calls through with none turns every profile read into a swallowed
       * fault — the spy would be measuring its own omission. */
      const real = (realProfileIo as (...a: unknown[]) => unknown)(...args);
      return new Proxy(real as object, {
        get(t, prop, r) {
          if (prop === "listProfileMessages") {
            return (...a: unknown[]) => { folderReads++; return (t as { listProfileMessages: (...x: unknown[]) => unknown }).listProfileMessages(...a); };
          }
          return Reflect.get(t, prop, r);
        },
      }) as never;
    };

    await sync.onOrganize(); // seed (its own read, not counted through the eval cache)
    folderReads = 0;
    expect(await holdOf(sync)).toBe("document");
    expect(await holdOf(sync)).toBe("document");
    expect(await holdOf(sync)).toBe("document");
    expect(folderReads, "three cycle edges inside one interval read the folder ONCE").toBe(1);
  }, 30_000);

  it("a dismissed NEWER document handed back as a readable one is re-askable — never a hold no surface can answer", async () => {
    // Review round 18: the write wall (`blockedByNewer`) outlived its referent, so a readable
    // replacement was routed under an open hold that no marker ever surfaced. The evaluator's
    // fresh read drops the stale wall, and a never-owned organizer meeting a readable document
    // takes the TAKEOVER posture: hold + HELD marker, answerable.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    const v2 = makeProfileDoc(
      { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["future"], signature: null },
      { updatedAt: new Date("2026-08-01T00:00:00Z"), producer: { kind: "local", version: "9.9.9" } },
    ) as unknown as Record<string, unknown>;
    v2.v = PROFILE_VERSION + 1;
    await meta.appendProfile(formatProfileMessage(v2 as never, { installId: "a-newer-build" }));
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    await db.insert(tags).values({ accountId: mb.accountId, name: "local-cfg", hue: "moss" });

    await sync.onOrganize(); // seed: newer ⇒ wall + hold
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", newerV: PROFILE_VERSION + 1,
    });
    expect(await holdOf(sync)).toBe("closed"); // dismissed

    // The newer build hands back: a READABLE foreign document replaces its own.
    const i = meta.messages.findIndex((m) => parseProfileMessage(m.raw) !== null);
    meta.messages.splice(i, 1);
    const replacement: OrganizerProfilePayload = {
      screener: [{ address: "handback@elsewhere.example" }],
      rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-handback"],
      signature: null,
    };
    await meta.appendProfile(formatProfileMessage(
      makeProfileDoc(replacement, {
        updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
      }),
      { installId: "someone-elses-mac" },
    ));

    expect(await holdOf(sync), "a readable hand-back re-opens the question").toBe("document");
    await sync.onOrganize(); // wall was dropped by the fresh read; never-owned ⇒ hold + HELD marker
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "the question must be answerable — a held marker the surface can offer").toBe(true);

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId,
      decision: "declined", fingerprint: profileFingerprint(replacement),
    });
    expect(await holdOf(sync)).toBe("closed");
  }, 30_000);

  it("a NEVER-OWNED organizer with an EMPTY store still surfaces a late-landing document", async () => {
    // Review round 18's answerability half: the empty-store tick path reaches neither the
    // verify pass nor the write path, so without its own preflight call a document landing
    // after the seed would be a routing hold (the evaluator sees it) with no held marker —
    // a question no surface could ever offer for answering, for the attachment's whole life.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await sync.onOrganize(); // seed: none — the store is EMPTY, nothing is ever written
    expect(meta.profileAppends).toBe(0);

    const fp = await seedForeignDoc(fleet, mb.mailboxId); // the travelling document lands late
    expect(await holdOf(sync), "the evaluator holds the routing").toBe("document");

    await sync.onOrganize(); // the empty-store tick must surface it — hold + HELD marker
    expect(sync.importDecisionOpen()).toBe(true);
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "an open question must be answerable through the marker the surface reads").toBe(true);

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", fingerprint: fp,
    });
    expect(await holdOf(sync)).toBe("closed");
  }, 30_000);

  it("\"Not now\" keeps the mailbox's settings: the declined document stands until the person replaces it", async () => {
    // a decline used to release the write hold, and within one flush this install
    // wrote its own document and pruned the other computer's — the only copy of those rules,
    // Screener decisions and away reply in the mailbox. A decline settles routing only.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const fingerprint = await seedForeignDoc(fleet, mb.mailboxId);
    // Local configuration that genuinely differs — what the write would carry over the document.
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });

    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);

    await sync.onOrganize(); // seed: hold + marker, and this install's settings written beside
    expect(meta.profileAppends).toBe(2); // the seeded foreign doc's, then ours

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", fingerprint,
    });
    for (let tick = 0; tick < 4; tick++) await sync.onOrganize();
    let docs = profileDocs(fleet, mb.mailboxId);
    expect(docs.map((d) => d.installId).sort(), "a decline must keep the other install's document beside ours")
      .toEqual([INSTALL, "someone-elses-mac"].sort());
    expect(events.some((e) => e.includes("\"state\":\"hold_lapsed\"")), "the hold stands while the document does").toBe(false);
    // …and it was never RELEASED on the way: `resolved` is the replace's line, not the decline's.
    expect(events.some((e) => e.includes("\"state\":\"resolved\"")), "a decline released the hold").toBe(false);
    expect(await holdOf(sync), "routing is settled by the decline").toBe("closed");

    // "Save this ohmail's settings to the mailbox": the explicit release. Two ticks: the release
    // writes nothing of its own (the stale-write window), the next one's tidy removes theirs.
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "replaced", fingerprint,
    });
    await sync.onOrganize();
    await sync.onOrganize();
    docs = profileDocs(fleet, mb.mailboxId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.installId, "after the replace, OURS is the mailbox's one document").toBe(INSTALL);
    expect(docs[0]!.doc!.tagNames).toEqual(["mine"]);
    // …and nothing was ever imported: both answers kept local exactly as it was.
    expect(await db.select().from(contacts).where(eq(contacts.accountId, mb.accountId))).toHaveLength(0);
  }, 30_000);

  it("a NEVER-OWNED organizer with settings meets a late-landing document: held, asked, written beside, never pruned unasked", async () => {
    // The write path's foreign arm: an organizer that has written nothing here yet, meeting a
    // document that landed after its seed, used to surface it UNHELD and prune it on the next
    // tick — no card, no consent. It takes the takeover posture instead.
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);

    await sync.onOrganize(); // seed: none, and an EMPTY store writes nothing — never owned
    expect(meta.profileAppends).toBe(0);

    const fp = await seedForeignDoc(fleet, mb.mailboxId); // the travelling document lands late
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" }); // now there is something to say
    await sync.onOrganize(); // the write meets it: the engine's foreign refusal
    expect(sync.importDecisionOpen(), "the late document is held, as at takeover").toBe(true);
    expect(await durableOpen(db, mb.accountId, mb.mailboxId),
      "and answerable: a HELD marker the surface offers").toBe(true);

    for (let tick = 0; tick < 3; tick++) await sync.onOrganize();
    let docs = profileDocs(fleet, mb.mailboxId);
    expect(docs.map((d) => d.installId).sort(), "nobody was asked, so theirs stays beside ours")
      .toEqual([INSTALL, "someone-elses-mac"].sort());

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "declined", fingerprint: fp,
    });
    for (let tick = 0; tick < 3; tick++) await sync.onOrganize();
    docs = profileDocs(fleet, mb.mailboxId);
    expect(docs.map((d) => d.installId), "a decline keeps it").toContain("someone-elses-mac");

    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "replaced", fingerprint: fp,
    });
    await sync.onOrganize();
    await sync.onOrganize();
    docs = profileDocs(fleet, mb.mailboxId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.installId).toBe(INSTALL);
    expect(docs[0]!.doc!.tagNames).toEqual(["mine"]);
  }, 30_000);
  it("a MERGED import (local ⊃ document, fingerprints never meet) releases through the same resolution", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const fingerprint = await seedForeignDoc(fleet, mb.mailboxId);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });

    const sync = directSync(db, fleet, mb, []);
    const meta = fleet.metaFor(mb.mailboxId);
    await sync.onOrganize(); // hold, and ours written beside the held document
    expect(meta.profileAppends).toBe(2);

    // The confirm flow applies the document INTO the existing configuration and records the
    // answer in the same transaction — reproduced here at the store level: after the merge the
    // local state is a superset, so convergence alone would hold for ever.
    await db.transaction(async (tx) => {
      // What the import writes for the document's unstated entry: an inferred contact (mail 0148).
      await tx.insert(contacts).values({ accountId: mb.accountId, address: "friend@elsewhere.example", source: "inferred" });
      await tx.insert(tags).values({ accountId: mb.accountId, name: "theirs", hue: "moss" });
      await recordProfileImportResolution(tx, {
        accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "imported", fingerprint,
      });
    });

    await sync.onOrganize(); // release (writes nothing of its own)
    await sync.onOrganize(); // the resumed write-behind
    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.installId).toBe(INSTALL);
    // The merged truth travels: the document's content AND the local-only tag, one document.
    expect(docs[0]!.doc!.tagNames).toEqual(["mine", "theirs"]);
    expect(docs[0]!.doc!.screener).toEqual([{ address: "friend@elsewhere.example" }]);
  }, 30_000);

  it("an answer for the folder's CURRENT document releases a hold keyed to an OLDER one", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await seedForeignDoc(fleet, mb.mailboxId); // document A — the hold's key
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });

    const sync = directSync(db, fleet, mb, []);
    const meta = fleet.metaFor(mb.mailboxId);
    await sync.onOrganize(); // hold on A, and ours written beside it
    expect(meta.profileAppends).toBe(2);

    // The other organizer writes AGAIN while the decision is open: the folder now holds B, and
    // the confirm surface — which reads the folder, not the hold — offers and records B.
    const payloadB: OrganizerProfilePayload = {
      screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: ["theirs-v2"],
      signature: null,
    };
    const docB = makeProfileDoc(payloadB, {
      updatedAt: new Date("2026-08-02T00:00:00Z"), producer: { kind: "local", version: "0.9.3" },
    });
    await meta.appendProfile(formatProfileMessage(docB, { installId: "someone-elses-mac" }));
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "replaced",
      fingerprint: profileFingerprint(payloadB),
    });

    // The hold's key (A) was never answered BY FINGERPRINT — but the mailbox's import question
    // WAS answered, after the hold began, and an answered mailbox must not stay frozen until a
    // process restart. Three ticks: the release (writes nothing of its own), the resumed write
    // meeting B unseen (the engine's foreign refusal — B is surfaced durably first), and the
    // supersede. Nothing leaves the folder unrecorded, even on the way out of a hold.
    await sync.onOrganize();
    await sync.onOrganize();
    await sync.onOrganize();
    // FIX-026's gate: A is stale beside B, so one write-due tick tidies it instead of appending.
    await sync.onOrganize();
    // B, the answered newest, is superseded. A, surfaced when the hold began and weeks older than
    // the current document, is a stale copy of another install's: FIX-026's tidy removes it
    // (fix-025 left it in the mailbox for ever). Never refused on, and never removed unsurfaced.
    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs.map((d) => [d.installId, d.doc!.tagNames])).toEqual([
      [INSTALL, ["mine"]],
    ]);
    const read = await readOrganizerProfile(fleet.metaFor(mb.mailboxId));
    expect(read.state === "found" && read.installId, "the answered mailbox's write-behind must resume")
      .toBe(INSTALL);
  }, 30_000);

  it("a release WRITES NOTHING on its own tick — the resumed flush serializes the store fresh", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const fingerprint = await seedForeignDoc(fleet, mb.mailboxId);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });

    const sync = directSync(db, fleet, mb, []);
    const meta = fleet.metaFor(mb.mailboxId);
    await sync.onOrganize(); // hold
    await recordProfileImportResolution(db, {
      accountId: mb.accountId, mailboxId: mb.mailboxId, decision: "replaced", fingerprint,
    });

    // The releasing tick serialized the store BEFORE it saw the answer, so anything it wrote
    // now could be a snapshot from before an import that landed in between — the stale-write
    // window. The release therefore returns, and the NEXT tick writes what the store says THEN.
    const held = meta.profileAppends; // the seeded document, and ours written beside it
    await sync.onOrganize();
    expect(meta.profileAppends, "the releasing tick itself must write nothing").toBe(held);
    await sync.onOrganize();
    // The next tick's tidy removes the released document; ours already says what the store says.
    expect(meta.profileAppends).toBe(held);
    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.installId).toBe(INSTALL);
  }, 30_000);

  it("a NEWER document of a LATER version is a new marker — a dismissed newer must not mask a later one", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    const meta = fleet.metaFor(mb.mailboxId);

    const newerDoc = (v: number, tag: string): string => {
      const d = makeProfileDoc(
        { screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [tag], signature: null },
        { updatedAt: new Date(), producer: { kind: "local", version: "9.9.9" } },
      ) as unknown as Record<string, unknown>;
      d.v = v;
      return formatProfileMessage(d as never, { installId: "a-newer-build" });
    };

    // TWO versions ABOVE this build's, named by the constant: as literals they stopped meaning
    // "the future" the moment the writer's own version reached them.
    const nextV = PROFILE_VERSION + 1;
    const laterV = PROFILE_VERSION + 2;
    await meta.appendProfile(newerDoc(nextV, "from-next"));
    await directSync(db, fleet, mb, []).onOrganize(); // marker: newer nextV

    // That build hands the mailbox back; a later one passes through next. A fresh attachment
    // (restart semantics — `blockedByNewer` is for the runtime's life) meets the later version.
    await meta.removeProfiles(meta.messages.filter((m) => parseProfileMessage(m.raw) !== null).map((m) => m.ref));
    await meta.appendProfile(newerDoc(laterV, "from-later"));
    await directSync(db, fleet, mb, []).onOrganize(); // must record a SECOND marker, laterV

    const markers = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)));
    const vs = markers.map((m) => (m.payload as { v?: number }).v).sort();
    expect(vs, "a dismissed newer marker must not swallow the later detection").toEqual([nextV, laterV]);
  }, 30_000);

  it("an OLDER foreign copy under an established organizer: no refusal, no marker, and removed once stale", async () => {
    /* Only the NEWEST document can refuse a write. fix-025 then left an older foreign copy in the
       mailbox for ever; FIX-026's tidy removes it once it is ten minutes older than the current
       document and its writer holds no fresh claim. The next case keeps one inside the window. */
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);
    await sync.onOrganize();
    expect(meta.profileAppends).toBe(1);

    const oldFp = await seedForeignDoc(fleet, mb.mailboxId); // weeks older; the fixture's append counts too
    const seeded = meta.profileAppends;
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine-too", hue: "moss" }); // dirty
    await sync.onOrganize(); // the write's gate tidies the stale copy first
    await sync.onOrganize(); // then the write lands

    expect(meta.profileAppends, "the older copy refused the write").toBe(seeded + 1);
    expect(events.some((e) => e.includes("found_midflight")), "an older copy was surfaced").toBe(false);
    expect(profileDocs(fleet, mb.mailboxId).some((d) => profileFingerprint(d.doc!) === oldFp),
      "the stale older copy was kept").toBe(false);
    expect(events.some((e) => e.startsWith("profile_tidied ")), "no tidy removed it").toBe(true);
  }, 30_000);

  it("an older foreign copy within ten minutes of the current document stays", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    const events: string[] = [];
    const sync = directSync(db, fleet, mb, events);
    await sync.onOrganize();

    const closeFp = await seedForeignDoc(fleet, mb.mailboxId, new Date(Date.now() - 5 * 60_000));
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine-too", hue: "moss" }); // dirty
    await sync.onOrganize();

    expect(profileDocs(fleet, mb.mailboxId).some((d) => profileFingerprint(d.doc!) === closeFp),
      "a copy inside the window was removed").toBe(true);
    expect(events.some((e) => e.includes("found_midflight")), "an older copy was surfaced").toBe(false);
  }, 30_000);

  it("an OWED detection marker gates the write: nothing is superseded while its durable record keeps failing", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });

    // The database refuses audit inserts until told otherwise — the transient blip, held open.
    let failing = true;
    const flakyDb = failingInserts(db, () => failing);

    const events: string[] = [];
    const sync = directSync(flakyDb, fleet, mb, events);
    const meta = fleet.metaFor(mb.mailboxId);

    await sync.onOrganize(); // seed (none found) + first flush: our own document
    expect(meta.profileAppends).toBe(1);

    // The overlap's loser lands a differing document under the established organizer, written
    // after ours — the newest, so it is the one that can refuse the write.
    const ghostFp = await seedForeignDoc(fleet, mb.mailboxId, new Date(Date.now() + 60_000));
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine-too", hue: "moss" }); // dirty

    await sync.onOrganize(); // the write path meets it: foreign refusal, marker write FAILS → owed
    expect(events.some((e) => e.includes("organizer_profile_marker_failed"))).toBe(true);
    const ghostStillThere = (): boolean => profileDocs(fleet, mb.mailboxId)
      .some((d) => d.doc !== undefined && profileFingerprint(d.doc) === ghostFp);
    expect(ghostStillThere()).toBe(true);

    // WHILE THE MARKER IS OWED, THE WRITE IS GATED. Without the gate this tick would supersede
    // the ghost — its fingerprint is already on the replaceable list — with no durable record
    // anywhere that it ever existed: the "expunged unsurfaced" edge, closed.
    await sync.onOrganize();
    expect(ghostStillThere(), "an unsurfaced document must survive every tick the marker keeps failing").toBe(true);

    // The database recovers: the owed marker lands, and only then does the write supersede.
    failing = false;
    await sync.onOrganize();
    // FIX-026's gate: our own older copy beside the ghost is tidied on that tick, and the write
    // that supersedes the ghost lands on the next.
    await sync.onOrganize();
    const markers = await db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, mb.accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION)));
    expect(markers.some((m) => (m.payload as { heldForImport?: boolean }).heldForImport === false)).toBe(true);
    expect(ghostStillThere()).toBe(false);
    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs).toHaveLength(1);
    expect(docs[0]!.installId).toBe(INSTALL);
    expect(docs[0]!.doc!.tagNames).toEqual(["mine", "mine-too"]);
  }, 30_000);
});

describe("the serialized document carries configuration and NOTHING else", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_profile"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  /** Every key path in a JSON value, arrays collapsed — the document's census. */
  function keyPaths(v: unknown, prefix = ""): Set<string> {
    const out = new Set<string>();
    if (Array.isArray(v)) {
      for (const e of v) for (const p of keyPaths(e, `${prefix}[]`)) out.add(p);
      return out;
    }
    if (typeof v === "object" && v !== null) {
      for (const [k, val] of Object.entries(v)) {
        const path = prefix === "" ? k : `${prefix}.${k}`;
        out.add(path);
        for (const p of keyPaths(val, path)) out.add(p);
      }
    }
    return out;
  }

  /**
   * THE FROZEN v1 CENSUS. A key path not on this list turning up in the document is the
   * no-secrets tripwire firing: the serializer reached a column this format never admitted.
   * Growing this list is a reviewed format decision, not a merge conflict to resolve.
   */
  const V1_KEY_PATHS = new Set([
    "v", "updatedAt", "producer", "producer.kind", "producer.version",
    "screener", "screener[].address", "screener[].name",
    /* Mail 0148 — who made the contact, admitted as an OPTIONAL key on `piles`' rule: present only
       for a person's contact, so a document of inferred entries keeps its fingerprint, and read as
       inferred when absent. The fixture's contact is a person's (NULL source), so a dropped key is
       as red here as a smuggled one. */
    "screener[].source",
    "rules", "rules[].kind", "rules[].match", "rules[].destination", "rules[].priority",
    "rules[].enabled", "rules[].provenance", "rules[].subjectContains", "rules[].bodyContains",
    "notifyRules", "notifyRules[].kind", "notifyRules[].target",
    /* mail 0087 — `subject` OUT, `throttle` IN, and PROFILE_VERSION deliberately did not move.
       The responder is reply-only now: it answers under `Re: <what they wrote>` and has no
       subject of its own to carry. Both halves are compatible in BOTH directions at the field
       level, which is what the envelope's version is actually about — an older reader ignores an
       unknown `throttle` and applies the rest correctly, and this reader defaults an absent one to
       `per_day`. Bumping would make every older install refuse a document it can read perfectly
       well, which is the opposite of what the version is for. A document written by an older
       ohmail may still carry `subject`; the parser simply does not read it. */
    "awayResponder", "awayResponder.enabled", "awayResponder.throttle", "awayResponder.body",
    "awayResponder.startsAt", "awayResponder.endsAt", "awayResponder.audience",
    /* mail 0096 — the piles the responder answers, admitted into v1 as an OPTIONAL key and
       PROFILE_VERSION again deliberately unmoved. The column has a real default, so a serialized
       responder always states its scope; an OLDER document that states none is not saying "answer
       the Ohbox" but saying nothing, so the key is absent there and the reader keeps what it has
       stored. Absent and omitted are one state and fingerprint identically — which is what lets
       this field arrive without re-fingerprinting every profile an older ohmail wrote (the twins
       are in `packages/core/test/adapters/organizer-profile.test.ts`). */
    "awayResponder.piles",
    "tagNames",
    // Mail 0094 — `mailboxes.signature`, the text appended to mail sent from THIS address. It is
    // the first per-MAILBOX field in a document that was otherwise entirely account-scoped, which
    // is why the serializer takes a mailbox id now: two mailboxes on one account have two
    // signatures, and an account-wide read would publish one into the other's document.
    // `PROFILE_VERSION` deliberately did not move for it — see the field's own comment.
    "signature",
    /* The signature's MARKUP, admitted into v1 as an OPTIONAL key on `awayResponder.piles`' rule
       and for its exact reason: a document that never had it keeps the fingerprint it was written
       with, so the canonical form omits it rather than serializing `null` the way the frozen
       `signature` beside it does. The case below sets real markup on the mailbox, so a DROPPED
       key is as red here as a smuggled one — which is the only reason this list can be an exact
       set. Before it the document carried the text alone and a reader showed the organizer's
       sign-off unformatted, while the reader-to-organizer REQUEST payload had carried
       `signatureHtml` since 2026-09-10. */
    "signatureHtml",
    /* The person's decision on a rule (mail 0128's `person_decided_at`), admitted as an OPTIONAL
       key on `piles`' rule: present only when stamped, so an unstamped rule keeps the bytes and
       the fingerprint it had. It is what keeps another organizer's learning off a sender the
       person decided; the fixture below stamps its rule, so a dropped key is red here too. */
    "rules[].personDecidedAt",
    /* The rule's age (`rules.updated_at`), outside the canonical form and the fingerprint: the gap
       pass reads it after an import, so a rule keeps the age it had where it was made. Every rule
       carries it, so a dropped key is red here too. */
    "rules[].updatedAt",
    /* The producer's statement that its rules carry every stamp (mail 0146), in the ENVELOPE and
       out of the fingerprint: it describes the write. Every build that writes it writes it, so the
       document below carries it and a dropped key is red here as well. */
    "producer.stamped",
    /* The organizer's SCREENING WINDOW, an ENVELOPE key (RULING-026): out of the canonical form and
       the fingerprint, read by every reader as the window in force. The fixture records a real
       baseline, so a dropped key is red here too. */
    "screening", "screening.baselineAt", "screening.dormancyDays", "screening.scope",
    /* The request ids this organizer applied (`meta-request:<id>`), an ENVELOPE key out of the
       fingerprint: a reader knows its own applied press is in this copy. Opaque ids, written plain
       (`applied[]`). The fixture claims one, so a dropped key is red here too. */
    "applied",
  ]);

  it("key census exact, and sentinels planted in every non-config table stay out of the message", async () => {
    const db = makeDb(DB);
    const accountId = randomUUID();
    await db.insert(accounts).values({ id: accountId, name: "census" });
    const [mb] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: "census@trafficflow.test" }).returning();
    // SENTINELS beside the configuration, in the same store: the mailbox credential and a model
    // setting. Neither table is a source of this document, and the assertion is that no shape
    // of either reaches the serialized message.
    const enc = await KP.encrypt(`${keyRingVar(9)}=super-secret-material`);
    await db.insert(mailboxCredentials).values({
      mailboxId: mb!.id, transport: "imap", secretEnc: enc.ciphertext, keyVersion: enc.keyVersion,
      meta: { host: "fake.invalid", port: 1143, secure: false, user: "TF_SECRET_SENTINEL_USER" },
    });
    await db.insert(accountSettings).values({
      accountId, ohboxBar: "TF_SECRET_SENTINEL_BAR", updatedAt: new Date(),
      screeningBaselineAt: new Date("2026-07-01T00:00:00Z"), dormancyDays: 30,
    });
    // …and the full configuration, every section populated.
    await db.insert(contacts).values({ accountId, address: "anna@x.example", name: "Anna" });
    await db.insert(rules).values({
      accountId, kind: "domain", match: "shop.example", destination: "ohmail/Receipts",
      provenance: "manual", subjectContains: "order", bodyContains: "invoice",
      personDecidedAt: new Date("2026-08-01T00:00:00Z"),
    });
    await db.insert(notifyRules).values({ accountId, kind: "sender", target: "boss@x.example" });
    await db.insert(awayResponders).values({
      accountId, enabled: true, subject: "Away", body: "Back Monday.",
      startsAt: new Date("2026-08-01T00:00:00Z"), endsAt: new Date("2026-08-20T00:00:00Z"),
      audience: "screened_in",
    });
    await db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" });
    // …including the one per-mailbox field, set to a real value rather than left NULL: this case
    // asserts that a DROPPED key is as red as a smuggled one, and a null would still produce the
    // key while proving nothing about the round trip carrying its VALUE.
    await db.update(mailboxes).set({
      signature: "-- \nMila Brunner",
      // …and its MARKUP, for the same reason the text is set to a real value rather than left
      // NULL: an optional key proves nothing about the round trip carrying its value unless the
      // fixture has one to carry.
      signatureHtml: "<p>-- <br>Mila Brunner</p>",
    })
      .where(eq(mailboxes.id, mb!.id));

    // The requests it answered: an applied one, a refusal, an expired one and an erased one.
    const at = new Date();
    const key = (id: string, applied: boolean, expiresAt: Date, erasedAt: Date | null = null) => ({
      accountId, key: `meta-request:${id}`, requestHash: "h", responseStatus: 200,
      responseJson: applied ? { applied: true, requestId: id } : { applied: false, requestId: id, reason: "conflict" },
      seq: null, expiresAt, erasedAt,
    });
    const later = new Date(at.getTime() + 3_600_000);
    const APPLIED = randomUUID();
    await db.insert(idempotencyKeys).values([
      key(APPLIED, true, later), key(randomUUID(), false, later),
      key(randomUUID(), true, new Date(at.getTime() - 1000)), key(randomUUID(), true, later, at),
      { ...key(randomUUID(), true, later), key: "some-post-key" },
    ]);

    const { payload, screening, applied } = await serializeOrganizerProfileCounted(db, accountId, mb!.id, { applied: true, now: at });
    expect(applied, "only applied, unexpired, unerased meta-request ids").toEqual([APPLIED]);
    expect(payload.signature, "the serializer did not reach the mailbox's own signature")
      .toBe("-- \nMila Brunner");
    expect(screening).toEqual({ baselineAt: "2026-07-01T00:00:00.000Z", dormancyDays: 30, scope: "window" });
    const doc = makeProfileDoc(payload, { updatedAt: new Date(), producer: { kind: "cloud", version: "dev" }, screening, applied });
    const raw = formatProfileMessage(doc, { installId: INSTALL });

    // The census, TWICE, and the first one is the sharper tripwire: `makeProfileDoc`
    // canonicalizes — it rebuilds the payload from the known fields, so a column the SERIALIZER
    // smuggles is dropped before the document is formatted and a document-level census alone
    // would stay green. The raw payload's census is where such a column is caught.
    const ENVELOPE = new Set([
      "v", "updatedAt", "producer", "producer.kind", "producer.version", "producer.stamped",
      "screening", "screening.baselineAt", "screening.dormancyDays", "screening.scope", "applied",
    ]);
    expect([...keyPaths(payload)].sort(), "the serializer reached a column v1 never admitted")
      .toEqual([...V1_KEY_PATHS].filter((k) => !ENVELOPE.has(k)).sort());
    // …and exactly the frozen v1 key paths in the document as written (every section populated
    // above, so a DROPPED key is as red as a smuggled one).
    expect([...keyPaths(doc)].sort()).toEqual([...V1_KEY_PATHS].sort());

    // The sentinel sweep — on the WHOLE message, headers and preamble included.
    for (const shape of [new RegExp(KEY_RING_PREFIX, "i"), /TF_SECRET_SENTINEL/i, /secretEnc/i, /keyVersion/i, /password/i, /BEGIN [A-Z ]*PRIVATE KEY/]) {
      expect(raw, `the serialized message must not match ${String(shape)}`).not.toMatch(shape);
    }

    // And the round trip holds at this level too: what the store said is what the message says.
    const parsed = parseProfileMessage(raw);
    if (parsed === null || isMalformedProfile(parsed)) throw new Error("expected a readable document");
    expect(profileFingerprint(parsed.doc!)).toBe(profileFingerprint(payload));
    expect(parsed.doc!.screening).toEqual(screening);
    expect(parsed.doc!.applied).toEqual([APPLIED]);
  }, 30_000);
});

/**
 * FIX-026 THE ORGANIZER HEALS A PILE BY TIDYING, NEVER BY WRITING. The read's residue used
 * to reopen the dirty check, and the rewrite it caused added a copy each interval wherever the
 * removal did not stick. Now the residue owes a tidy, and `count` mode (the first Cloud deploy)
 * only logs the plan while the write removes nothing but the copy it replaces.
 */
describe("FIX-026: a pile of settings copies is tidied, not rewritten", () => {
  beforeAll(async () => { DB = await prepareIsolatedDb("trafficflow_worker_profile"); }, 120_000);
  beforeEach(async () => { await truncateAll(DB); }, ISOLATED_DB_RESET_BUDGET_MS);

  /** `n` copies of what the store says, ours, one second apart; the last is current. */
  async function seedOwnCopies(db: Db, fleet: FakeAdapterFleet, mb: { accountId: string; mailboxId: string }, n: number): Promise<void> {
    // What the store says includes the window it publishes (RULING-026), or the first tick writes it.
    const { payload, screening } = await serializeOrganizerProfileCounted(db, mb.accountId, mb.mailboxId);
    for (let i = 0; i < n; i++) {
      const doc = makeProfileDoc(payload, {
        updatedAt: new Date(Date.UTC(2026, 8, 27, 0, 0, i)), producer: { kind: "cloud", version: "old" }, screening,
      });
      await fleet.metaFor(mb.mailboxId).appendProfile(formatProfileMessage(doc, { installId: INSTALL }));
    }
  }
  function clockedSync(db: Db, fleet: FakeAdapterFleet, mb: { accountId: string; mailboxId: string },
    events: string[], now: () => Date, tidyMode?: "remove" | "count") {
    const adapter = fleet.factory(
      { host: "fake.invalid", port: 1143, secure: false, auth: { user: "u", pass: "p" }, sentDomain: "t" } as never,
      { accountId: mb.accountId, mailboxId: mb.mailboxId, onConnectionError: () => undefined },
    );
    return new OrganizerProfileSync({
      db, accountId: mb.accountId, mailboxId: mb.mailboxId, adapter,
      self: { installId: INSTALL, kind: "cloud" }, producerVersion: "dev", flushIntervalMs: 0, now,
      ...(tidyMode === undefined ? {} : { tidyMode }),
      log: (event, detail) => { events.push(`${event} ${JSON.stringify(detail)}`); },
    });
  }
  const planned = (events: string[]): Array<Record<string, unknown>> => events
    .filter((e) => e.startsWith("profile_tidy_planned ")).map((e) => JSON.parse(e.slice("profile_tidy_planned ".length)));

  it("an applied request id rides the next write and never causes one", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    let t = Date.UTC(2026, 8, 28, 0, 0, 0);
    const sync = clockedSync(db, fleet, mb, [], () => new Date(t));
    await sync.onOrganize();
    const meta = fleet.metaFor(mb.mailboxId);
    const written = meta.profileAppends;
    expect(profileDocs(fleet, mb.mailboxId).at(-1)!.doc!.applied).toEqual([]);
    const id = randomUUID();
    await db.insert(idempotencyKeys).values({
      accountId: mb.accountId, key: `meta-request:${id}`, requestHash: "h", responseStatus: 200,
      responseJson: { applied: true, requestId: id }, seq: null, expiresAt: new Date(t + 86_400_000),
    });
    t += 60_000;
    await sync.onOrganize();
    expect(meta.profileAppends, "an applied id alone wrote a copy").toBe(written);
    await db.insert(tags).values({ accountId: mb.accountId, name: "two", hue: "moss" });
    t += 60_000;
    await sync.onOrganize();
    expect(meta.profileAppends).toBe(written + 1);
    expect(profileDocs(fleet, mb.mailboxId).at(-1)!.doc!.applied).toEqual([id]);
  }, 30_000);

  it("five copies of what the store says — found_own, planned removable 4, removed 4, and no APPEND", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    await seedOwnCopies(db, fleet, mb, 5);
    const meta = fleet.metaFor(mb.mailboxId);
    const appends = meta.profileAppends;
    const events: string[] = [];
    let now = new Date("2026-09-28T12:00:00Z");
    const sync = clockedSync(db, fleet, mb, events, () => now);

    await sync.onOrganize();
    now = new Date(now.getTime() + 31_000);
    await sync.onOrganize();

    expect(events.some((e) => e.startsWith("organizer_profile_detected ") && e.includes("found_own"))).toBe(true);
    expect(planned(events)[0]).toMatchObject({ records: 5, current: 1, removable: 4, own: 4 });
    expect(events.some((e) => e.startsWith("profile_tidied ") && e.includes("\"removed\":4"))).toBe(true);
    expect(profileDocs(fleet, mb.mailboxId)).toHaveLength(1);
    expect(meta.profileAppends, "the heal appended a copy").toBe(appends);
  }, 30_000);

  it("a pile past one pass is finished by the next tidy, and still nothing is appended", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    await seedOwnCopies(db, fleet, mb, 150);
    const meta = fleet.metaFor(mb.mailboxId);
    const appends = meta.profileAppends;
    const events: string[] = [];
    let now = new Date("2026-09-28T12:00:00Z");
    const sync = clockedSync(db, fleet, mb, events, () => now);

    await sync.onOrganize();            // seed, tidy 100, the verify owes the rest
    expect(profileDocs(fleet, mb.mailboxId)).toHaveLength(50);
    now = new Date(now.getTime() + 10_000);
    await sync.onOrganize();            // inside the tidy's spacing: nothing
    expect(profileDocs(fleet, mb.mailboxId)).toHaveLength(50);
    now = new Date(now.getTime() + 21_000);
    await sync.onOrganize();            // 31 s after the first pass: the rest
    await sync.onOrganize();

    expect(profileDocs(fleet, mb.mailboxId)).toHaveLength(1);
    expect(meta.profileAppends, "the heal appended a copy").toBe(appends);
  }, 30_000);

  it("count mode removes nothing, and a settings change replaces only the current copy — five stays five", async () => {
    const fleet = new FakeAdapterFleet();
    const db = makeDb(DB);
    const mb = await seedMailbox(db);
    await db.insert(tags).values({ accountId: mb.accountId, name: "mine", hue: "moss" });
    await seedOwnCopies(db, fleet, mb, 5);
    const events: string[] = [];
    let now = new Date("2026-09-28T12:00:00Z");
    const sync = clockedSync(db, fleet, mb, events, () => now, "count");

    await sync.onOrganize();
    expect(profileDocs(fleet, mb.mailboxId)).toHaveLength(5);
    expect(planned(events)[0]).toMatchObject({ removable: 4, tidyMode: "count" });

    await db.insert(tags).values({ accountId: mb.accountId, name: "changed", hue: "moss" });
    now = new Date(now.getTime() + 31_000);
    await sync.onOrganize();

    const docs = profileDocs(fleet, mb.mailboxId);
    expect(docs, "count mode grew the pile or removed more than the replaced copy").toHaveLength(5);
    expect(docs.some((d) => d.doc!.tagNames.includes("changed")), "the change was never written").toBe(true);
    expect(events.some((e) => e.startsWith("profile_tidied ")), "count mode removed").toBe(false);
  }, 30_000);
});

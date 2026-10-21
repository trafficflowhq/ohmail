import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it } from "vitest";
import { awayResponders, contacts, notifyRules, rules, tags } from "@trafficflow/db";
import { eq } from "drizzle-orm";
import { META_FOLDER, parseClaim } from "@trafficflow/core/adapters/organizer-lease";
import {
  parseProfileMessage, isMalformedProfile, readOrganizerProfile, type ParsedProfileMessage,
  PROFILE_VERSION,
  PROFILE_VERSION_MIN_READ,
} from "@trafficflow/core/adapters/organizer-profile";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";

/**
 * THE PORTABLE ORGANIZER PROFILE — the LOCAL half, against a real IMAP server and the real
 * on-disk store.
 *
 * The worker suite proves the composition against Postgres; what only THIS level proves is the
 * whole desktop path: the sidecar's PGlite store serialized by the SAME composition, the document
 * physically appended over a `.`-delimited hierarchy (GreenMail's, so `ohmail/_meta` has to
 * survive the path mapping), exactly one current document across updates, and a relaunch that
 * recognises its own document and rewrites nothing.
 *
 * Every read below is by an INDEPENDENT client — organize-in-place means the folder on the
 * user's mailbox is the fact, and asking the code under test where it put something proves
 * nothing (this suite's own convention, from the send e2e).
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
/** GreenMail's delimiter is `.`, so the canonical `ohmail/_meta` is `ohmail._meta`. */
const META_PATH = META_FOLDER.split("/").join(".");

function greenmail(): { host: string; port: number; secure: false; auth: { user: string; pass: string } } {
  return {
    host: IMAP_HOST, port: IMAP_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" },
  };
}

/** Every message in `ohmail/_meta`, FULL SOURCE, read by an independent client. */
async function metaMessages(cfg: ReturnType<typeof greenmail>): Promise<string[]> {
  const c = new ImapFlow({ ...cfg, logger: false });
  await c.connect();
  try {
    const list = await c.list();
    if (!list.some((f) => f.path === META_PATH)) return [];
    const lock = await c.getMailboxLock(META_PATH);
    try {
      const out: string[] = [];
      for await (const m of c.fetch("1:*", { uid: true, source: true })) {
        if (m.source) out.push(m.source.toString("utf8"));
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

/** The readable profile documents currently on the server. */
async function profileDocs(cfg: ReturnType<typeof greenmail>): Promise<ParsedProfileMessage[]> {
  const parsed = (await metaMessages(cfg)).map((raw) => parseProfileMessage(raw));
  return parsed.filter((r): r is ParsedProfileMessage => r !== null && !isMalformedProfile(r));
}

describe("the sidecar writes this mailbox's settings into ohmail/_meta", () => {
  const dirs: string[] = [];
  const running: Sidecar[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  function dataDir(): string {
    const d = mkdtempSync(join(tmpdir(), "ohmail-profile-"));
    dirs.push(d);
    return d;
  }

  it("one document, updated in place, recognised as its own across a relaunch", async () => {
    const cfg = greenmail();
    const dir = dataDir();
    const sidecar = await createSidecar({
      dataDir: dir, imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
    });
    await grantOrganizeConsent(sidecar);
    running.push(sidecar);
    await sidecar.start();
    await sidecar.syncUntilQuiet();

    // A mailbox that has said nothing gets no document — absence already means defaults.
    expect(await profileDocs(cfg)).toHaveLength(0);

    // The user configures: a screener yes (contact + promoted rule), a tag, a notify rule and an
    // away reply — the whole v1 payload, in the LOCAL PGlite store.
    const accountId = sidecar.world.accountId;
    await sidecar.db.insert(contacts).values({ accountId, address: "anna@x.example", name: "Anna" });
    await sidecar.db.insert(rules).values({
      accountId, kind: "sender", match: "anna@x.example", destination: "INBOX",
      provenance: "promoted", enabled: true,
    });
    await sidecar.db.insert(tags).values({ accountId, name: "Invoices", hue: "moss" });
    await sidecar.db.insert(notifyRules).values({ accountId, kind: "sender", target: "boss@x.example" });
    await sidecar.db.insert(awayResponders).values({
      accountId, enabled: false, subject: "Away", body: "Back Monday.", audience: "screened_in",
    });
    await sidecar.syncUntilQuiet();

    // EXACTLY ONE document on the server, beside the organizer claim, carrying the natural keys.
    const docs = await profileDocs(cfg);
    expect(docs).toHaveLength(1);
    const doc = docs[0]!.doc!;
    // THE WRITER'S OWN VERSION, not a number typed here: this read 1 for a build that had moved
    // to 2, so the case failed for the bump rather than for anything it measures.
    expect(doc.v).toBe(PROFILE_VERSION);
    expect(doc.v).toBeGreaterThanOrEqual(PROFILE_VERSION_MIN_READ);
    expect(doc.producer.kind).toBe("local");
    // A screener yes is a person's contact (mail 0148), and the document says so.
    expect(doc.screener).toEqual([{ address: "anna@x.example", name: "Anna", source: "person" }]);
    // A rule's age travels with the document (outside its fingerprint), so a phone that imports
    // these rules does not read them as younger than the letters they would file.
    expect(doc.rules).toEqual([{
      kind: "sender", match: "anna@x.example", destination: "INBOX",
      priority: 0, enabled: true, provenance: "promoted",
      updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/),
    }]);
    expect(doc.notifyRules).toEqual([{ kind: "sender", target: "boss@x.example" }]);
    /* NO `subject`, AND THAT IS THE ASSERTION. The away responder became reply-only in 0087 and
     * `organizer-profile.ts#canonicalize` stopped writing the field while `parseProfile` stopped
     * reading it; this line still demanded `subject: "Away"` because the file needed a mail
     * server to say otherwise. Pinned as an absence rather than dropped, so a re-added subject
     * fails here instead of travelling silently into somebody else's mailbox. */
    expect(doc.awayResponder).toMatchObject({ enabled: false, audience: "screened_in" });
    expect(doc.awayResponder).not.toHaveProperty("subject");
    expect(doc.tagNames).toEqual(["Invoices"]);
    // The document's install id is this install's lease identity — the local accounts row.
    expect(docs[0]!.installId).toBe(accountId);
    // The claim shares the folder and the profile write left it standing.
    const raws = await metaMessages(cfg);
    expect(raws.filter((r) => parseClaim(r) !== null).length).toBeGreaterThanOrEqual(1);

    // An UPDATE is append-new + expunge-old: still one document, the newer content.
    await sidecar.db.insert(tags).values({ accountId, name: "travel", hue: "moss" });
    await sidecar.db.delete(notifyRules).where(eq(notifyRules.accountId, accountId));
    await sidecar.syncUntilQuiet();
    const updated = await profileDocs(cfg);
    expect(updated).toHaveLength(1);
    expect(updated[0]!.doc!.tagNames).toEqual(["Invoices", "travel"]);
    expect(updated[0]!.doc!.notifyRules).toEqual([]);
    const updatedAtBeforeRelaunch = updated[0]!.doc!.updatedAt;

    // …and an unchanged store appends nothing more.
    await sidecar.syncUntilQuiet();
    expect((await profileDocs(cfg))[0]!.doc!.updatedAt).toBe(updatedAtBeforeRelaunch);

    // THE QUIT WRITES ONCE ON THE WAY OUT, and that is the one rewrite of an unchanged store: the
    // instant it let go travels in `gap` (RULING-026 lane A, as amended), so an install that slept
    // through this turn counts from there. Still one document, the same content.
    await sidecar.stop();
    const quit = await profileDocs(cfg);
    expect(quit).toHaveLength(1);
    expect(quit[0]!.doc!.gap, "the quit left no moment").toMatchObject({ by: accountId });
    expect(quit[0]!.doc!.tagNames).toEqual(["Invoices", "travel"]);

    // RELAUNCH, same data directory: the same install finds its OWN document and seeds its dirty
    // check from it. Its first publish drops the quit's key (a key never outlives its exit), and
    // after that it rewrites nothing — `updatedAt` is the witness that no append happened.
    const second = await createSidecar({
      dataDir: dir, imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
    });
    await grantOrganizeConsent(second);
    running.push(second);
    await second.start();
    await second.syncUntilQuiet();
    const afterRelaunch = await profileDocs(cfg);
    expect(afterRelaunch).toHaveLength(1);
    expect(afterRelaunch[0]!.installId, "the relaunch did not take the document as its own").toBe(accountId);
    expect(afterRelaunch[0]!.doc!.gap, "the quit's key outlived its exit").toBeUndefined();
    expect(afterRelaunch[0]!.doc!.tagNames).toEqual(["Invoices", "travel"]);
    const relaunchedAt = afterRelaunch[0]!.doc!.updatedAt;
    await second.syncUntilQuiet();
    expect((await profileDocs(cfg))[0]!.doc!.updatedAt, "an unchanged store must not be rewritten after the relaunch").toBe(relaunchedAt);

    // A change AFTER the relaunch flows again — the seed resumed write-behind, not just reads.
    await second.db.insert(tags).values({ accountId: second.world.accountId, name: "after-relaunch", hue: "moss" });
    await second.syncUntilQuiet();
    const final = await profileDocs(cfg);
    expect(final).toHaveLength(1);
    expect(final[0]!.doc!.tagNames).toContain("after-relaunch");
  }, 120_000);
});

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  A READER READS THE ORGANIZER'S DOCUMENT OVER A DOT-DELIMITED HIERARCHY
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The POSITIVE CONTROL for the reader door, on a real server, at the seam the finding came in
 * at: the organizing sidecar publishes, and an INDEPENDENT login with a reader's identity reads it
 * back through the same `profileIo()` the reader arm uses. GreenMail's delimiter is `.`, so this
 * is also the delimiter's own control — `ohmail/_meta` has to survive the path mapping for a
 * reader exactly as it does for the writer.
 *
 * It reads through the real adapter rather than a hand-built client because the mapping is the
 * adapter's: `toServerPath` is private to it and learned at login.
 */
describe("a reader reads the organizer's settings document", () => {
  const dirs: string[] = [];
  const running: Sidecar[] = [];
  afterEach(async () => {
    for (const s of running.splice(0)) await s.stop().catch(() => undefined);
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("finds it on a `.`-delimited server, with no memory of its own", async () => {
    const cfg = greenmail();
    const dir = mkdtempSync(join(tmpdir(), "ohmail-profile-reader-"));
    dirs.push(dir);
    const sidecar = await createSidecar({
      dataDir: dir, imap: cfg, machineName: "Mila's MacBook",
      pollIntervalMs: 60_000, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
    });
    await grantOrganizeConsent(sidecar);
    running.push(sidecar);
    await sidecar.start();

    /* A MAILBOX THAT HAS SAID NOTHING PUBLISHES NOTHING — absence already means defaults — so the
       organizer is given one setting to publish. Otherwise a reader read of an empty folder would
       pass this case while answering a different question. */
    await sidecar.db.insert(tags).values({ accountId: sidecar.world.accountId, name: "Invoices", hue: "moss" });
    await sidecar.syncUntilQuiet();

    // Asserted INDEPENDENTLY, so a reader read of nothing cannot pass.
    expect((await profileDocs(cfg)).length, "the organizer published no document to read").toBe(1);

    /* A SEPARATE LOGIN AND A READER'S IDENTITY. `installId` is the reader arm's own
       (`reader-profile-mirror`), which has never written, so there is no remembered position to
       carry the read — the state the finding was measured in. */
    const reader = new ImapAdapter(cfg);
    try {
      await reader.connect();
      const read = await readOrganizerProfile(
        reader.profileIo({ installId: "reader-profile-mirror", mailboxId: "reader-mailbox" }),
      );
      expect(read.state, "a reader could not read the organizer's document").toBe("found");
    } finally {
      await reader.close().catch(() => undefined);
    }
    // The sibling case's budget: a real login, a real sync and a second real login.
  }, 120_000);
});

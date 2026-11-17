import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import {
  MIGRATED_DB_SETUP_BUDGET_MS, MIGRATED_DB_TEARDOWN_BUDGET_MS, realPgAvailable, throwawayDb,
} from "@trafficflow/db/testing";
import {
  PROFILE_FOUND_AUDIT_ACTION, accountSettings, accounts, auditLog, contacts, fencedAccountWrite, mailboxProfileMirror, mailboxes,
  statePreference, tags, type LedgerTx, type Tx,
} from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import {
  isMalformedProfile, makeProfileIo, parseProfileMessage, profileFingerprint, readProfilePreferences,
  type OrganizerProfileDoc, type ParsedProfileMessage,
} from "@trafficflow/core/adapters/organizer-profile";
import { serializeOrganizerProfile } from "@trafficflow/core/adapters/organizer-profile-store";
import { OrganizerProfileSync, syncProfileMirror } from "@ohmail/organizer/profile";
import { memoryImapServer } from "../../../packages/core/test/adapters/_metaworld.js";
import { makeStoreAtOldHeads, plantAccount } from "../../../packages/db/test/_store-at-old-heads.js";

/**
 * A RELEASED ORGANIZER REWRITES THE SETTINGS COPY, AND NOTHING A PERSON STATED IS LOST.
 *
 * The released organizer does not know the key that carries what a person stated for every
 * install, so the copy it writes has none. This file runs that organizer itself (the release's own
 * code, pinned under fixtures/released) on a store walked to the release's shape, beside this
 * tree's organizer on a store of its own, over one mailbox folder, on real Postgres.
 *
 * THE WALK. This tree's install states where the subject stands, by the door's own writer, and
 * writes. The person changes their mind before the next write (or, in one more walk per arm, does
 * not: the written press is the last before the mailbox leaves). The mailbox goes to the released
 * install, which organizes and writes, in three arms: the person imports the found settings there,
 * says Not now, or the two stores already say the same. This tree's install reads the mailbox as a
 * reader, before and after that rewrite, then organizes again.
 *
 * WHAT HOLDS. The row and its instant never move. No copy the released organizer writes carries
 * the key. This tree's next copy states the pair again, with the instant of the press. Its one
 * rewrite of a copy the server handed back plain still states it. And the person is asked exactly
 * as often as on the same walk with nothing stated.
 */
const PG_UP = await realPgAvailable();

/** The released organizer's settings code, as the fixture exports it. Typed by what this walk takes. */
interface Released {
  OrganizerProfileSync: new (deps: Record<string, unknown>) => { onOrganize(): Promise<void> };
  PROFILE_VERSION: number;
  makeProfileIo(client: unknown, toServerPath: (canonical: string) => string, identity: { installId: string; mailboxId: string }): unknown;
  readOrganizerProfile(io: unknown): Promise<{ state: string; doc?: unknown; installId?: string | null }>;
  applyOrganizerProfile(tx: unknown, o: Record<string, unknown>): Promise<unknown>;
  serializeOrganizerProfile(db: unknown, accountId: string, mailboxId: string): Promise<unknown>;
  profileFingerprint(payload: unknown): string;
  brandDialect<T>(db: T, name: "pg"): T;
  fencedAccountWrite<T>(db: unknown, scope: { accountId: string }, fn: (tx: unknown) => Promise<T>): Promise<T>;
  latestProfileFoundMarker(db: unknown, accountId: string, mailboxId: string): Promise<{ state: string; fingerprint: string | null; heldForImport?: boolean } | null>;
  recordProfileImportResolution(tx: unknown, o: Record<string, unknown>): Promise<unknown>;
  contacts: never; tags: never;
}
const FIXTURE = fileURLToPath(new URL("./fixtures/released/1.0.11/organizer-profile.mjs", import.meta.url));
const released = (await import(/* @vite-ignore */ pathToFileURL(FIXTURE).href)) as Released;

const atOldHeads = throwawayDb("released_rewrite_old");
const atThisTree = throwawayDb("released_rewrite_new");

const META = "INBOX.ohmail._meta";
const THIS = "this-trees-install";
const RELEASED = "the-released-install";
const INTERVAL_MS = 5 * 60_000;
const BORN = new Date("2026-01-01T00:00:00.000Z");
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");

type Arm = "import" | "not now" | "already equal";
const ARMS: readonly Arm[] = ["import", "not now", "already equal"];

/** The plain form a server that stores other bytes hands back. */
function plainOf(raw: string): string {
  const doc = JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as unknown;
  return `${raw.slice(0, raw.indexOf("{"))}${JSON.stringify(doc, null, 2)}\r\n`;
}
/** A settings message's document exactly as its bytes say it, every key a writer put there. */
const rawDocOf = (raw: string): Record<string, unknown> => JSON.parse(raw.slice(raw.indexOf("{"), raw.lastIndexOf("}") + 1)) as Record<string, unknown>;

describe.skipIf(!PG_UP)("a released organizer rewrites the settings copy this tree wrote", () => {
  let oldSql: ReturnType<typeof postgres>;
  let newSql: ReturnType<typeof postgres>;
  let oldDb: unknown;
  let newDb: Tx;

  beforeAll(async () => {
    await atOldHeads.create(makeStoreAtOldHeads);
    await atThisTree.createFromTemplate();
    oldSql = postgres(atOldHeads.url, { max: 3, onnotice: () => { /* quiet */ } });
    newSql = postgres(atThisTree.url, { max: 3, onnotice: () => { /* quiet */ } });
    // Each side's handle carries its own code's mark: the released code reads the released one.
    oldDb = released.brandDialect(drizzle(oldSql), "pg");
    newDb = brandDialect(drizzle(newSql, { schema }), "pg") as unknown as Tx;
  }, 2 * MIGRATED_DB_SETUP_BUDGET_MS);
  afterAll(async () => {
    await oldSql?.end({ timeout: 5 });
    await newSql?.end({ timeout: 5 });
    await atOldHeads.drop();
    await atThisTree.drop();
  }, 2 * MIGRATED_DB_TEARDOWN_BUDGET_MS);

  /**
   * One walk of one mailbox between the two installs; `states` is whether the person states anything,
   * `changesMind` whether a second press follows the written one before the mailbox leaves.
   */
  async function walk(arm: Arm, states: boolean, changesMind = true) {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const clock = { at: new Date("2026-11-01T12:00:00.000Z") };
    const pass = (ms: number): void => { clock.at = new Date(clock.at.getTime() + ms); };
    const said: string[] = [];

    // ── THIS TREE'S INSTALL, on a store at this tree's shape ──────────────────────────────────
    const accountId = randomUUID();
    await newDb.insert(accounts).values({ id: accountId, name: "this tree", createdAt: BORN });
    const [mb] = await newDb.insert(mailboxes).values({ accountId, provider: "imap", address: `${randomUUID()}@rewrite.example`, createdAt: BORN })
      .returning({ id: mailboxes.id });
    const mailboxId = mb!.id;
    await newDb.insert(contacts).values({ accountId, address: "anna@example.org", name: "Anna", createdAt: BORN });
    await newDb.insert(tags).values({ accountId, name: "kiln", createdAt: BORN, updatedAt: BORN });
    // Other settings of the same row, which a rewrite must leave as they stand too.
    await newDb.insert(accountSettings).values({ accountId, dormancyDays: 45, locale: "de", themeFace: "paper", resurfaceTime: "07:30", updatedAt: BORN });
    /* The person's press, as the settings door runs it: the account's fence, then the one writer of the pair.
       (The door itself, with its refusals, is walked where the services may be imported.) */
    const press = (word: "head" | "each") =>
      fencedAccountWrite(newDb, { accountId }, (tx) => statePreference(tx as unknown as LedgerTx, accountId, "subject", word, clock.at));
    const io = () => makeProfileIo(server, toServerPath, { installId: THIS, mailboxId });
    const log = (event: string, detail: Record<string, unknown>): void => {
      said.push(`${event}${typeof detail.state === "string" ? `:${detail.state}` : ""}${typeof detail.by === "string" ? `:${detail.by}` : ""}`);
    };
    const sync = new OrganizerProfileSync({
      db: newDb, accountId, mailboxId, flushIntervalMs: INTERVAL_MS, now: () => clock.at,
      adapter: { profileIo: () => io() } as unknown as MailboxAdapter,
      self: { installId: THIS, kind: "local" }, producerVersion: "test", log,
    });
    const organize = async (): Promise<void> => { pass(INTERVAL_MS + 60_000); await sync.onOrganize(); };
    const readAsReader = async () => {
      pass(INTERVAL_MS + 60_000);
      return syncProfileMirror({ db: newDb, accountId, mailboxId, io: io(), now: clock.at, log });
    };
    const settingsRow = async () => (await newDb.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0];
    const stated = async () => {
      const row = await settingsRow();
      return { word: row?.subjectHeading ?? null, at: row?.subjectHeadingAt?.toISOString() ?? null };
    };
    /** How often this tree's install put the found-settings question to the person. */
    const questions = async (): Promise<number> => (await newDb.select({ payload: auditLog.payload }).from(auditLog)
      .where(and(eq(auditLog.accountId, accountId), eq(auditLog.action, PROFILE_FOUND_AUDIT_ACTION))))
      .filter((r) => (r.payload as { state?: string; heldForImport?: boolean } | null)?.state === "found"
        && (r.payload as { heldForImport?: boolean }).heldForImport === true).length;

    // ── THE FOLDER, as both installs left it ─────────────────────────────────────────────────
    const copies = (): Array<{ by: string | null; doc: OrganizerProfileDoc; raw: string; uid: number; encoded: boolean }> =>
      server.tree.get(META)!.messages.map((m) => ({ parsed: parseProfileMessage(m.raw, m.uid), raw: m.raw, uid: m.uid }))
        .filter((x): x is { parsed: ParsedProfileMessage; raw: string; uid: number } => x.parsed !== null && !isMalformedProfile(x.parsed) && x.parsed.status === "ok")
        .map((x) => ({ by: x.parsed.installId, doc: x.parsed.doc!, raw: x.raw, uid: x.uid, encoded: x.parsed.encoded === true }))
        .sort((a, b) => Date.parse(a.doc.updatedAt) - Date.parse(b.doc.updatedAt));
    const newestBy = (installId: string) => copies().filter((c) => c.by === installId).at(-1);

    // 1 · This tree's install organizes: a first copy, which states nothing yet.
    await organize();
    expect(newestBy(THIS)?.doc.preferences, "nothing stated writes no key").toBeUndefined();

    // 2 · The person states where the subject stands, and it is written; then changes their mind, and that is not written yet.
    let standing: { word: string; at: string } | null = null;
    if (states) {
      pass(1_000);
      const first = await press("each");
      await organize();
      expect(newestBy(THIS)!.doc.preferences).toEqual({ subject: { value: "each", at: first.at.toISOString() } });
      // Or the written press is the last: then only a reset of what the last write stated can state it again.
      standing = { word: first.value, at: first.at.toISOString() };
      if (changesMind) {
        pass(1_000);
        const second = await press("head");
        standing = { word: second.value, at: second.at.toISOString() };
        expect(second.at.getTime()).toBeGreaterThan(first.at.getTime());
      }
    }
    const pressed = await stated();
    expect(pressed).toEqual(standing === null ? { word: null, at: null } : standing);

    // 3 · The mailbox goes to the released install. This tree's install only reads now, and the first
    //     copy it reads is its own, with its own earlier statement: the later one stands.
    sync.forgetOrganizerLife();
    expect((await readAsReader()).state).toBe("written");
    expect(await stated(), "an earlier statement read back takes nothing").toEqual(pressed);

    // 4 · The released organizer, on a store at the release's shape.
    const oldAccountId = randomUUID();
    const { mailboxId: oldMailboxId } = await plantAccount(oldSql, oldAccountId);
    // As text: the query builder took this client's own date writer when it wrapped it.
    await oldSql`update accounts set created_at = ${BORN.toISOString()} where id = ${oldAccountId}`;
    await oldSql`update mailboxes set created_at = ${BORN.toISOString()} where id = ${oldMailboxId}`;
    const old = oldDb as { insert: (table: never) => { values: (row: Record<string, unknown>) => Promise<unknown> } };
    if (arm === "not now") await old.insert(released.tags).values({ accountId: oldAccountId, name: "from the released install", createdAt: BORN, updatedAt: BORN });
    if (arm === "already equal") {
      await old.insert(released.contacts).values({ accountId: oldAccountId, address: "anna@example.org", name: "Anna", createdAt: BORN });
      await old.insert(released.tags).values({ accountId: oldAccountId, name: "kiln", createdAt: BORN, updatedAt: BORN });
      // The arm's premise, each side read by its own code: the two stores say the same.
      expect(released.profileFingerprint(await released.serializeOrganizerProfile(oldDb, oldAccountId, oldMailboxId)))
        .toBe(profileFingerprint(await serializeOrganizerProfile(newDb, accountId, mailboxId)));
    }
    const oldIo = () => released.makeProfileIo(server, toServerPath, { installId: RELEASED, mailboxId: oldMailboxId });
    const oldSaid: string[] = [];
    const oldSync = new released.OrganizerProfileSync({
      db: oldDb, accountId: oldAccountId, mailboxId: oldMailboxId, flushIntervalMs: INTERVAL_MS, now: () => clock.at,
      adapter: { profileIo: () => oldIo() },
      self: { installId: RELEASED, kind: "local" }, producerVersion: "1.0.11",
      log: (event: string, detail: Record<string, unknown>) => { oldSaid.push(`${event}${typeof detail.state === "string" ? `:${detail.state}` : ""}`); },
    });
    const oldOrganizes = async (times: number): Promise<void> => {
      for (let i = 0; i < times; i++) { pass(INTERVAL_MS + 60_000); await oldSync.onOrganize(); }
    };
    await oldOrganizes(1);
    if (arm !== "already equal") {
      // It found settings that differ from its own and asks; the person answers on that install.
      const question = await released.latestProfileFoundMarker(oldDb, oldAccountId, oldMailboxId);
      expect(question, oldSaid.join(",")).toMatchObject({ state: "found", heldForImport: true });
      if (arm === "import") {
        const found = await released.readOrganizerProfile(released.makeProfileIo(server, toServerPath, { installId: RELEASED, mailboxId: oldMailboxId }));
        expect(found.state).toBe("found");
        expect(found.installId).toBe(THIS);
        await released.fencedAccountWrite(oldDb, { accountId: oldAccountId }, (tx) => released.applyOrganizerProfile(tx, {
          accountId: oldAccountId, mailboxId: oldMailboxId, doc: found.doc, fingerprint: question!.fingerprint, now: clock.at, signatureReplaces: null,
        }));
      } else {
        await released.fencedAccountWrite(oldDb, { accountId: oldAccountId }, (tx) => released.recordProfileImportResolution(tx, {
          accountId: oldAccountId, mailboxId: oldMailboxId, decision: "declined", fingerprint: question!.fingerprint,
        }));
      }
    } else {
      expect(await released.latestProfileFoundMarker(oldDb, oldAccountId, oldMailboxId), "the same settings ask nothing").toBeNull();
    }
    await oldOrganizes(3);
    const rewrites = copies().filter((c) => c.by === RELEASED);
    expect(rewrites.length, `the released organizer wrote (${oldSaid.join(",")})`).toBeGreaterThan(0);
    expect(copies().at(-1)!.by, "the newest copy in the mailbox is the released organizer's").toBe(RELEASED);
    // No copy it wrote carries the key, read from its bytes.
    for (const c of rewrites) expect(Object.keys(rawDocOf(c.raw))).not.toContain("preferences");

    // 5 · This tree's install reads the rewrite as a reader. Absent reads as not stated, and nothing stored is cleared.
    const beforeTheRewriteWasRead = await settingsRow();
    expect((await readAsReader()).state).toBe("written");
    const [mirrored] = await newDb.select({ doc: mailboxProfileMirror.doc }).from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, mailboxId));
    expect((mirrored!.doc as { preferences?: unknown; producer?: { version?: string } }).producer?.version, "the reader holds the released copy").toBe("1.0.11");
    expect(readProfilePreferences(rawDocOf(copies().at(-1)!.raw).preferences)).toEqual({});
    expect("preferences" in (mirrored!.doc as object)).toBe(false);
    expect(await settingsRow(), "the whole settings row stands as it stood").toEqual(beforeTheRewriteWasRead);
    expect(await stated(), "the statement and its instant stand").toEqual(pressed);
    expect(said.filter((line) => line.startsWith("profile_preferences_adopted"))).toEqual([]);

    // 6 · The mailbox comes back: this tree's install organizes again, its runtime kept.
    await organize();
    await organize();
    const again = newestBy(THIS);
    if (standing !== null) {
      expect(again?.doc.preferences, `this tree's next copy states the pair with the instant of the press (${said.join(",")})`)
        .toEqual({ subject: { value: standing.word, at: standing.at } });
      expect(Date.parse(again!.doc.updatedAt), "and it was written after the released organizer's").toBeGreaterThan(Date.parse(rewrites.at(-1)!.doc.updatedAt));
    }
    expect(await stated()).toEqual(pressed);
    expect(await settingsRow()).toMatchObject({ dormancyDays: 45, locale: "de", themeFace: "paper", resurfaceTime: "07:30" });
    const asked = await questions();

    // 7 · Where no question stands, the server hands this tree's copy back in the plain form: its one rewrite states the pair too.
    let rewrittenPlain = false;
    if (standing !== null && again !== undefined && again.uid === copies().at(-1)!.uid && asked === 0) {
      const storedCopy = server.tree.get(META)!.messages.find((m) => m.uid === again.uid)!;
      storedCopy.raw = plainOf(storedCopy.raw);
      expect(newestBy(THIS)!.encoded).toBe(false);
      await organize();
      rewrittenPlain = said.includes("profile_reencoded");
      expect(rewrittenPlain, said.join(",")).toBe(true);
      expect(newestBy(THIS)!.encoded).toBe(true);
      expect(newestBy(THIS)!.doc.preferences, "the rewrite of a plain copy states the pair").toEqual({ subject: { value: standing.word, at: standing.at } });
      expect(await stated()).toEqual(pressed);
    }
    return { asked: await questions(), rewrittenPlain, standing };
  }

  it.each(ARMS)("%s: nothing the person stated is lost, and nothing more is asked", async (arm) => {
    const withStatement = await walk(arm, true);
    const control = await walk(arm, false);
    expect(withStatement.standing).not.toBeNull();
    expect(withStatement.asked, "the person is asked as often as with nothing stated").toBe(control.asked);
    if (arm === "already equal") {
      expect(withStatement.asked, "two stores that say the same ask nothing").toBe(0);
      expect(withStatement.rewrittenPlain, "the plain copy's rewrite was walked").toBe(true);
    }
    if (arm === "not now") expect(withStatement.asked, "the released install's own settings are asked about, once").toBe(1);
  }, 240_000);

  it.each(ARMS)("%s: a press already written before the mailbox leaves is stated again, with its instant, when it comes back", async (arm) => {
    const written = await walk(arm, true, false);
    expect(written.standing).toMatchObject({ word: "each" });
  }, 240_000);
});

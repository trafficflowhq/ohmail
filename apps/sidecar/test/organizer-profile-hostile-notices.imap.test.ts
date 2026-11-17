import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { accountSettings, accounts, mailboxProfileMirror, mailboxes, statePreference, tags, type LedgerTx, type Tx } from "@trafficflow/db";
import { pushSubscriptions } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { readOrganizerProfile, type OrganizerProfileDoc } from "@trafficflow/core/adapters/organizer-profile";
import { adoptableProfilePreferences } from "@trafficflow/core/adapters/organizer-profile-store";
import { OrganizerProfileSync, forgetMirrorCadence, syncProfileMirror } from "@ohmail/organizer/profile";
import { CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore } from "../../../packages/core/test/adapters/_imapenv.js";
import { MARK, NOW, PLANTED, STATED_AT, messageWith } from "./_hostile-profile.js";

/**
 * A FORGED SETTINGS COPY ON A REAL MAIL SERVER (the security ruling's acceptance 5). Every copy the
 * in-process test plants (`organizer-profile-hostile-notices.test.ts`: the hostile values, a date far
 * ahead, the instants before 1970) is appended to the mailbox's settings folder on GreenMail and on
 * Dovecot, through the adapter's own settings io as any writer to the folder could, then taken in by
 * a reader's pass and by an organizer's takeover, on a store that states "each" and on one that
 * states nothing. Every member reads as not stated, the pass is written, the organizer writes its own
 * copy and keeps its settings, and nothing stored moves.
 */
vi.setConfig({ testTimeout: 240_000 });

type Config = ReturnType<typeof greenmailConfig>;
function dovecotConfig(): Config {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  };
}

const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: greenmailConfig, enabled: true, why: "" },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok, why: CONDSTORE.ok ? "" : CONDSTORE.why },
];

const open: Array<{ close: () => Promise<unknown> }> = [];
async function closeAll(): Promise<void> {
  for (const c of open.splice(0).reverse()) await c.close().catch(() => { /* already down */ });
}
afterEach(closeAll);

async function connected(cfg: Config): Promise<ImapAdapter> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  open.push(adapter);
  return adapter;
}

const HERE = "this-install";
const FORGER = "another-install";
const BORN = new Date("2026-01-01T00:00:00.000Z");

/** One store with a wake registration beside its settings row, which states "each" or nothing yet. */
async function store(states: boolean) {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: "forged", createdAt: BORN });
  await db.insert(tags).values({ accountId, name: "kiln", createdAt: BORN, updatedAt: BORN });
  if (states) {
    await (db as unknown as { transaction: (f: (tx: LedgerTx) => Promise<unknown>) => Promise<unknown> })
      .transaction((tx) => statePreference(tx, accountId, "subject", "each", new Date(STATED_AT)));
  } else {
    await db.insert(accountSettings).values({ accountId, updatedAt: BORN });
  }
  await db.insert(pushSubscriptions).values({
    accountId, transport: "webpush", endpoint: "https://push.example/the-device-own", p256dh: "own-key", auth: "own-auth", createdAt: BORN,
  });
  const reading = async () => ({
    settings: (await db.select().from(accountSettings).where(eq(accountSettings.accountId, accountId)))[0],
    registrations: await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.accountId, accountId)),
  });
  return { db, accountId, reading };
}

for (const server of SERVERS) {
  if (!server.enabled) {
    console.warn(`\n[condstore] SKIPPING the forged settings copies against ${server.name} — ${server.why}\n`);
    describe(`a forged settings copy, appended on ${server.name}`, () => {
      it.skip(`NOT RUN — ${server.why}`, () => { /* the name is the report */ });
    });
    continue;
  }

  describe(`a forged settings copy, appended on ${server.name}`, () => {
    it.each([
      { world: "a store that states \"each\"", states: true },
      { world: "a store that states nothing", states: false },
    ])("$world: every member is not stated, the pass and the organizer's copy are written, and nothing stored moves", async ({ states }) => {
      const s = await store(states);
      const before = await s.reading();
      for (const [name, json] of PLANTED) {
        // A mailbox of its own on the server and in the store, for each copy.
        const cfg = server.config();
        const [mb] = await s.db.insert(mailboxes).values({ accountId: s.accountId, provider: "imap", address: cfg.auth.user, createdAt: BORN })
          .returning({ id: mailboxes.id });
        const mailboxId = mb!.id;
        const forger = (await connected(cfg)).profileIo({ installId: FORGER, mailboxId });
        await forger.ensureMetaFolder();
        await forger.appendProfile(messageWith(json, new Date(NOW.getTime() - 60_000), FORGER));
        const said: string[] = [];
        const log = (event: string): void => { said.push(event); };

        // A reader's pass.
        const adapter = await connected(cfg);
        forgetMirrorCadence();
        const outcome = await syncProfileMirror({ db: s.db, accountId: s.accountId, mailboxId, io: adapter.profileIo({ installId: HERE, mailboxId }), now: NOW, log });
        expect(outcome.state, name).toBe("written");
        const [kept] = await s.db.select({ doc: mailboxProfileMirror.doc }).from(mailboxProfileMirror).where(eq(mailboxProfileMirror.mailboxId, mailboxId));
        // The copy is kept as read; what a store may take of it is nothing.
        expect(adoptableProfilePreferences(kept!.doc as OrganizerProfileDoc, NOW), name).toEqual({});
        expect(JSON.stringify(kept!.doc), name).not.toContain(MARK);

        // An organizer's takeover of the same mailbox.
        let clock = NOW.getTime();
        const sync = new OrganizerProfileSync({
          db: s.db, accountId: s.accountId, mailboxId, flushIntervalMs: 0, now: () => new Date(clock),
          adapter, self: { installId: HERE, kind: "local" }, producerVersion: "test", log,
        });
        for (let i = 0; i < 3; i++) { clock += 31_000; await sync.onOrganize(); }
        expect(sync.profileBlock(), `${name} (${said.join(",")})`).toBeNull();
        // Through a fresh connection: a session that had the folder open learns of a change only later.
        const newest = await readOrganizerProfile((await connected(cfg)).profileIo({ installId: `look-${randomUUID()}`, mailboxId }));
        expect(newest.state === "found" ? newest.installId : newest.state, `${name}: the organizer wrote its own copy`).toBe(HERE);
        if (newest.state === "found") {
          expect(newest.doc.preferences, name).toEqual(states ? { subject: { value: "each", at: STATED_AT } } : undefined);
          expect(JSON.stringify(newest.doc), name).not.toContain(MARK);
        }

        expect(said.filter((e) => e === "profile_preferences_adopted"), name).toEqual([]);
        expect(await s.reading(), name).toEqual(before);
        await closeAll();
      }
    });
  });
}

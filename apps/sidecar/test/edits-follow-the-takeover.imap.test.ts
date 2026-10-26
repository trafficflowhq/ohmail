import { randomBytes } from "node:crypto";
import { rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ImapFlow } from "imapflow";
import { eq } from "drizzle-orm";
import type { ImapConfig } from "@trafficflow/core/adapters/imap";
import {
  isMalformedProfile, parseProfileMessage, type OrganizerProfileDoc,
} from "@trafficflow/core/adapters/organizer-profile";
import { accountSettings, mailboxes, organizerRequests, rules } from "@trafficflow/db";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";
import {
  CONDSTORE_HOST, CONDSTORE_PORT, greenmailConfig, probeCondstore,
} from "../../../packages/core/test/adapters/_imapenv.js";

vi.setConfig({ testTimeout: PGLITE_STANDUP_BUDGET_MS * 6 });

/**
 * EDITS MADE DURING A TAKEOVER REACH THE MAILBOX THROUGH THE NEW HOLDER, on GreenMail and
 * Dovecot. W-old organizes and publishes a rule and an away reply; W-new presses "Organize here
 * instead" and edits a rule, the away reply and the screening choice before its claim lands. Read
 * by an independent client: W-new's settings document carries them beside W-old's, which is byte
 * for byte what W-old wrote, no request was queued, and W-old's next pass stands down and appends
 * nothing. Import by the shown fingerprint then lets W-new's document stand alone; "Not now" keeps
 * both. The screening choice does not travel in the settings document: it is read in W-new's store.
 */

function dovecotConfig(): ImapConfig {
  return {
    host: CONDSTORE_HOST, port: CONDSTORE_PORT, secure: false,
    auth: { user: `t-${crypto.randomUUID()}@trafficflow.test`, pass: "testpass-password" },
  } as ImapConfig;
}
const CONDSTORE = await probeCondstore();
const SERVERS = [
  { name: "GreenMail", config: (): ImapConfig => greenmailConfig(), enabled: true },
  { name: "Dovecot", config: dovecotConfig, enabled: CONDSTORE.ok },
];
const HOUR = 60 * 60 * 1000;

type Doc = { installId: string | null; doc: OrganizerProfileDoc; raw: string };

/** Every settings document in `ohmail/_meta`, by a fresh connection each time (see the one-copy file). */
async function settingsDocs(cfg: ImapConfig): Promise<Doc[]> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  try {
    const row = (await c.list()).find((f) => /(^|[./])ohmail[./]_meta$/.test(f.path));
    if (!row) return [];
    const lock = await c.getMailboxLock(row.path);
    try {
      const out: Doc[] = [];
      for await (const m of c.fetch("1:*", { uid: true, source: true })) {
        const raw = m.source?.toString("utf8") ?? "";
        const r = parseProfileMessage(raw);
        if (r !== null && !isMalformedProfile(r) && r.status === "ok") out.push({ installId: r.installId, doc: r.doc!, raw });
      }
      return out;
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => c.close());
  }
}

describe("an edit during a takeover is written through the new holder", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  async function boot(cfg: ImapConfig, name: string): Promise<Sidecar> {
    const dataDir = await freshDataDir(`ohmail-edits-takeover-${name}-`);
    const sidecar = await createSidecar({
      dataDir, imap: { host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth },
      address: cfg.auth.user, machineName: name,
      pollIntervalMs: HOUR, leaseStaleAfterMs: 60_000, profileFlushIntervalMs: 0,
      // A durable key, so the first run seals the credential the import card is offered over.
      keks: { 1: randomBytes(32) },
      log: () => {},
    });
    cleanups.push(async () => { await sidecar.stop().catch(() => undefined); rmSync(dataDir, { recursive: true, force: true }); });
    return sidecar;
  }
  const call = (s: Sidecar, method: string, path: string, body?: unknown): Promise<Response> =>
    s.handle(new Request(`http://engine.invalid${path}`, {
      method, headers: { authorization: `Bearer ${s.sessionToken}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
  const role = async (s: Sidecar) =>
    (await s.db.select().from(mailboxes).where(eq(mailboxes.id, s.world.mailboxId)))[0]!.organizerRole;

  /** W-old organizing and published, W-new taken over with its three edits made before the claim. */
  async function takenOver(cfg: ImapConfig) {
    const old = await boot(cfg, "W-old");
    await grantOrganizeConsent(old);
    await old.start();
    await old.syncUntilQuiet();
    expect((await call(old, "POST", "/rules", { kind: "sender", match: "old@b.test", destination: "INBOX" })).status).toBe(201);
    expect((await call(old, "PUT", "/away-responder", { enabled: true, body: "Old away.", audience: "everyone" })).status).toBe(200);
    await old.syncUntilQuiet();
    const oldDocs = await settingsDocs(cfg);
    expect(oldDocs.map((d) => d.installId), "premise: W-old published").toHaveLength(1);

    const fresh = await boot(cfg, "W-new");
    await fresh.start();
    const pressed = await call(fresh, "POST", `/local/mailboxes/${fresh.world.mailboxId}/organize`, {
      screening: { scope: "window" }, intent: "takeover",
    });
    expect(pressed.status).toBe(200);
    expect(await role(fresh), "the claim has not landed").toBe("reader");
    const statuses = [
      (await call(fresh, "POST", "/rules", { kind: "sender", match: "new@b.test", destination: "INBOX" })).status,
      (await call(fresh, "PUT", "/away-responder", { enabled: true, body: "New away.", audience: "everyone" })).status,
      (await call(fresh, "PATCH", "/account/screening", { ohboxPolicy: "people_only" })).status,
    ];
    expect(statuses, "an account door refused or queued the edit").toEqual([201, 200, 200]);
    await fresh.syncUntilQuiet();
    expect(await role(fresh), "the claim landed").toBe("organizer");
    return { old, fresh, oldRaw: oldDocs[0]!.raw };
  }

  for (const server of SERVERS) {
    describe.skipIf(!server.enabled)(server.name, () => {
      it("the edits are in the new holder's document beside the old one, and the old holder writes nothing", async () => {
        const cfg = server.config();
        const w = await takenOver(cfg);
        const docs = await settingsDocs(cfg);
        const mine = docs.filter((d) => d.installId !== null && d.raw !== w.oldRaw);
        expect({
          count: docs.length,
          oldKept: docs.some((d) => d.raw === w.oldRaw),
          newRules: mine.flatMap((d) => d.doc.rules.map((r) => r.match)),
          newAway: mine.map((d) => d.doc.awayResponder?.body ?? null),
          requests: (await w.fresh.db.select().from(organizerRequests)).length,
          screening: (await w.fresh.db.select().from(accountSettings))[0]?.ohboxPolicy ?? null,
        }).toEqual({
          count: 2, oldKept: true, newRules: ["new@b.test"], newAway: ["New away."], requests: 0, screening: "people_only",
        });

        await w.old.syncUntilQuiet();
        const after = await settingsDocs(cfg);
        expect(await role(w.old), "W-old did not stand down").toBe("reader");
        expect(after.map((d) => d.raw).sort(), "W-old wrote after the takeover").toEqual(docs.map((d) => d.raw).sort());
      });

      it("\"Not now\" keeps both; Import by the shown fingerprint lets the new document stand alone", async () => {
        const cfg = server.config();
        // W-old's document is minutes old, too fresh for the tidy's ten minutes: only the answer removes it.
        const w = await takenOver(cfg);
        // A row this install kept from its reader-only days, of a rule W-old removed long before it published:
        // after Not now this install organizes with it, so the later Import keeps it.
        const [dead] = await w.fresh.db.insert(rules).values({
          accountId: w.fresh.world.accountId, kind: "sender", match: "gone@b.test", destination: "INBOX",
          priority: 0, enabled: true, provenance: "manual", updatedAt: new Date(Date.now() - HOUR),
        }).returning();
        const asked = await (await call(w.fresh, "GET", `/mailboxes/${w.fresh.world.mailboxId}/profile-import`)).json() as {
          state: string; fingerprint?: string;
        };
        expect(asked.state, JSON.stringify(asked)).toBe("found");
        expect((await call(w.fresh, "POST", `/mailboxes/${w.fresh.world.mailboxId}/profile-import/decline`, { fingerprint: asked.fingerprint })).status).toBe(200);
        await w.fresh.syncUntilQuiet();
        expect((await settingsDocs(cfg)).length, "a decline pruned the other install's settings").toBe(2);

        const imported = await call(w.fresh, "POST", `/mailboxes/${w.fresh.world.mailboxId}/profile-import`, { fingerprint: asked.fingerprint });
        expect(imported.status, await imported.clone().text()).toBe(200);
        await call(w.fresh, "POST", "/rules", { kind: "sender", match: "after@b.test", destination: "INBOX" });
        await w.fresh.syncUntilQuiet();
        await w.fresh.syncUntilQuiet();
        const docs = await settingsDocs(cfg);
        expect({ count: docs.length, rules: docs.flatMap((d) => d.doc.rules.map((r) => r.match)).sort() })
          .toEqual({ count: 1, rules: ["after@b.test", "gone@b.test", "new@b.test", "old@b.test"] });
        expect(await w.fresh.db.select().from(rules).where(eq(rules.id, dead!.id)), "an Import after Not now removed a row organized with").toHaveLength(1);
      });

      it("THE OVERLAP: both holders editing and syncing at once never leave more than own + held + one copy", async () => {
        const cfg = server.config();
        const w = await takenOver(cfg);
        const seen: number[] = [(await settingsDocs(cfg)).length];
        for (let i = 0; i < 3; i++) {
          await Promise.all([
            call(w.old, "POST", "/rules", { kind: "sender", match: `old-${i}@b.test`, destination: "INBOX" }),
            call(w.fresh, "POST", "/rules", { kind: "sender", match: `new-${i}@b.test`, destination: "INBOX" }),
          ]);
          await Promise.all([w.old.syncUntilQuiet(), w.fresh.syncUntilQuiet()]);
          seen.push((await settingsDocs(cfg)).length);
        }
        expect(Math.max(...seen), `settings messages after each round: ${seen.join(",")}`).toBeLessThanOrEqual(3);
        expect(Math.min(...seen), "a round left the folder with no settings").toBeGreaterThanOrEqual(1);
        expect(await role(w.fresh)).toBe("organizer");
      });
    });
  }
});

import { describe, it, expect, beforeAll } from "vitest";
import { bindDb } from "@trafficflow/db";
import { and, eq, sql } from "drizzle-orm";
import { accountSettings, contacts, folderState, mailboxes, messages, rules } from "@trafficflow/db";
import type { Tx } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import { realPgAvailable } from "@trafficflow/db/testing";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { rulesService, type ServiceContext } from "@trafficflow/services/mail";
import { runSyncCycle, type SyncDeps } from "@ohmail/organizer/sync";
import { ruleRetroPass } from "@ohmail/organizer/rule-retro";
import { makeHarness, rawClient, DB_URL } from "../../../packages/organizer/test/_workerenv.js";
import { FIXTURE_LEASE } from "../../../packages/organizer/test/_door.js";

/**
 * "ALL THEIR MAIL -> OHBOX" HOLDS FOR THE NEXT NEWSLETTER TOO, under "Keep my Ohbox for what matters".
 * The sheet read "Ohbox · News 1" with the newest issue left in News: the sender's twin was a rule
 * the Screener promoted to News, the press retargeted it and left it `promoted`, the retro pass
 * moved the backlog, and `people_only` filed the next issue to News as an inference's automated
 * mail. Real ingest on GreenMail, the real press and pass. The posture still refiles an inference
 * nobody pressed.
 */

const AVAILABLE = await realPgAvailable(DB_URL);
const SENDER = "news@letter.example";
type H = Awaited<ReturnType<typeof makeHarness>>;

function issue(i: number, to: string): string {
  return [
    `Message-ID: <issue-${i}-${Math.random().toString(36).slice(2, 10)}@letter.example>`,
    `From: Letter Weekly <${SENDER}>`, `To: ${to}`, `Subject: Issue ${i}`,
    `Date: ${new Date(Date.UTC(2026, 6, 1, 19, 35) + i * 86_400_000).toUTCString()}`,
    "List-Id: Letter Weekly <weekly.letter.example>", `List-Unsubscribe: <https://letter.example/u/${i}>`,
    "Content-Type: text/plain", "", `issue ${i}`,
  ].join("\r\n");
}

async function drain(deps: SyncDeps): Promise<void> {
  for (let i = 0; i < 20; i++) {
    const { hasBacklog, owesFiling } = await runSyncCycle(deps);
    if (!hasBacklog && !owesFiling) return;
  }
}

/** The sender's mail by where the server files it, the newest issue named apart. */
async function placement(h: H) {
  const rows = await h.db.select({ subject: messages.subject, desired: folderState.desiredFolder })
    .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
    .where(and(eq(messages.accountId, h.accountId), eq(sql`lower(${messages.fromAddress})`, SENDER)));
  const by: Record<string, number> = {};
  for (const r of rows) by[r.desired] = (by[r.desired] ?? 0) + 1;
  return { by, total: rows.length, of: (subject: string) => rows.find((r) => r.subject === subject)?.desired };
}

/** One organizer mailbox on `people_only`, an inferred twin for the sender, `backlog` issues filed by it. */
async function world(twinDestination: string, backlog: number, provenance: "promoted" | "seeded-from-sent" = "promoted") {
  const h = await makeHarness();
  await h.db.update(mailboxes).set({ organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 3_600_000) })
    .where(eq(mailboxes.id, h.mailboxId));
  await h.db.insert(accountSettings).values({ accountId: h.accountId, ohboxPolicy: "people_only" });
  const [twin] = await h.db.insert(rules).values({
    accountId: h.accountId, kind: "sender", match: SENDER, destination: twinDestination, priority: 0, provenance,
  }).returning({ id: rules.id });
  const deps: SyncDeps = {
    repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
    storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE, trustedAuthservIds: new Set<string>(),
    role: "organizer", ohboxPolicy: "people_only",
  };
  const c = await rawClient(h.cfg);
  for (let i = 0; i < backlog; i++) await c.append("INBOX", issue(i, h.cfg.auth.user));
  await drain(deps);
  const close = async () => { await c.logout(); await h.adapter.close(); };
  return { h, c, deps, twin: twin!.id, close };
}

describe.skipIf(!AVAILABLE)("a sender press outranks the people_only posture for that sender's next mail", () => {
  beforeAll(async () => { await runMigrations(DB_URL); }, 120_000);

  it("press News -> Ohbox with the backlog: the 66 move AND the 67th, arriving after, lands in the Ohbox", async () => {
    const w = await world("ohmail/News", 66);
    try {
      expect((await placement(w.h)).by, "the backlog was not filed to News by the twin").toEqual({ "ohmail/News": 66 });
      const ctx = { db: bindDb(w.h.db, { account: w.h.accountId }), accountId: w.h.accountId, now: () => new Date() } as unknown as ServiceContext;
      await rulesService.update(ctx, w.twin, { destination: "INBOX", applyRetro: true });
      const pass = await ruleRetroPass(w.h.db as unknown as Tx, { accountId: w.h.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, new Date());
      expect(pass.moved).toBe(66);
      await w.c.append("INBOX", issue(66, w.h.cfg.auth.user));
      await drain(w.deps);
      const p = await placement(w.h);
      expect(p.of("Issue 66"), "the next issue went to News under the rule just pressed").toBe("INBOX");
      expect(p.by).toEqual({ INBOX: 67 });
    } finally { await w.close(); }
  }, 180_000);

  it("a rule inferred from sent mail, already at the Ohbox: the press re-arms it and the next issue stays", async () => {
    const w = await world("INBOX", 0, "seeded-from-sent");
    try {
      await w.c.append("INBOX", issue(1, w.h.cfg.auth.user));
      await drain(w.deps);
      expect((await placement(w.h)).of("Issue 1"), "the posture did not refile the inference's newsletter").toBe("ohmail/News");
      const ctx = { db: bindDb(w.h.db, { account: w.h.accountId }), accountId: w.h.accountId, now: () => new Date() } as unknown as ServiceContext;
      await rulesService.update(ctx, w.twin, { destination: "INBOX", applyRetro: true });
      await ruleRetroPass(w.h.db as unknown as Tx, { accountId: w.h.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, new Date());
      await w.c.append("INBOX", issue(2, w.h.cfg.auth.user));
      await drain(w.deps);
      const p = await placement(w.h);
      expect(p.of("Issue 2"), "the next issue went to News under the rule just pressed").toBe("INBOX");
      expect(p.by).toEqual({ INBOX: 2 });
    } finally { await w.close(); }
  }, 120_000);

  it("the positive control: with no press, people_only still files an inference's newsletter to News", async () => {
    const w = await world("INBOX", 0);
    try {
      await w.c.append("INBOX", issue(1, w.h.cfg.auth.user));
      await drain(w.deps);
      expect((await placement(w.h)).of("Issue 1"), "the posture stopped refiling an inference").toBe("ohmail/News");
    } finally { await w.close(); }
  }, 120_000);
});

/* THE SAME PRESS WITH THE POSTURE OFF, over a rule inferred from sent mail that already files to the
   Ohbox: the person's newsletters were filed to News before the rule existed, and the press asks for
   them. It is a re-arm (the place does not move), so the press must still write and the pass must
   still move what is here. */
describe.skipIf(!AVAILABLE)("a press over an inferred rule already at the Ohbox, the posture off", () => {
  beforeAll(async () => { await runMigrations(DB_URL); }, 120_000);

  it("makes the rule the person's and moves the older News mail the organizer filed", async () => {
    const h = await makeHarness();
    const c = await rawClient(h.cfg);
    try {
      await h.db.update(mailboxes).set({ organizerRole: "organizer", organizeConsentedAt: new Date(Date.now() - 3_600_000) })
        .where(eq(mailboxes.id, h.mailboxId));
      await h.db.insert(accountSettings).values({ accountId: h.accountId, ohboxPolicy: "people_and_replied" });
      // A correspondent: the organizer files their bulk mail to News by its headers, before any rule.
      await h.db.insert(contacts).values({ accountId: h.accountId, address: SENDER });
      const deps: SyncDeps = {
        repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId,
        storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE, trustedAuthservIds: new Set<string>(),
        role: "organizer", ohboxPolicy: "people_and_replied",
      };
      for (let i = 0; i < 22; i++) await c.append("INBOX", issue(i, h.cfg.auth.user));
      await drain(deps);
      expect((await placement(h)).by, "the organizer did not file the older mail to News").toEqual({ "ohmail/News": 22 });
      // The sent-mail seed's rule, written after that mail was filed: it files to the Ohbox already.
      const seeded = new Date(Date.now() - 7 * 86_400_000);
      const [twin] = await h.db.insert(rules).values({
        accountId: h.accountId, kind: "sender", match: SENDER, destination: "INBOX", priority: 0,
        provenance: "seeded-from-sent", createdAt: seeded, updatedAt: seeded,
      }).returning({ id: rules.id });
      // The sheet's press over a twin already at the place: the re-arm the client sends.
      const ctx = { db: bindDb(h.db, { account: h.accountId }), accountId: h.accountId, now: () => new Date() } as unknown as ServiceContext;
      await rulesService.update(ctx, twin!.id, { destination: "INBOX", applyRetro: true });
      const pass = await ruleRetroPass(h.db as unknown as Tx, { accountId: h.accountId, trustedAuthservIdsFor: async () => new Set<string>() }, new Date());
      const [rule] = await h.db.select().from(rules).where(eq(rules.id, twin!.id));
      // Soft, so a run reports every half: the write, the ask, whose rule it is, and the mail.
      expect.soft(rule!.updatedAt.getTime(), "the press wrote nothing to the rule").toBeGreaterThan(seeded.getTime());
      expect.soft(rule!.retroRequestedAt, "the press did not ask for the mail already here").not.toBeNull();
      expect.soft(rule!.provenance, "the press left the rule an inference").toBe("manual");
      expect.soft(pass.moved, "the pass moved none of the older News mail").toBe(22);
      expect.soft((await placement(h)).by).toEqual({ INBOX: 22 });
    } finally { await c.logout(); await h.adapter.close(); }
  }, 180_000);
});

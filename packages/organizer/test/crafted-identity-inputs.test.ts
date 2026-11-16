import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, accountSettings, folderState, mailboxes, messages, type Tx } from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A CRAFTED SENDER IS READ IN BOUNDED TIME AT INGEST (mail 0148), through a real sync cycle: a name,
 * a local part and a subject thousands of characters each, and a long local part the fold
 * expands, arrive with three messages carrying a real claim at the end of a name or of a 256-unit
 * local part, or in the lead-in. The cycle stores every one with the right fact inside its bound;
 * unbounded, the local part alone ran the worker out of memory.
 */
const NAME = "a".repeat(2000) + " ubs".repeat(250);
const LOCAL = "ab1cd2".repeat(500);
const SUBJECT = "Aa" + " ".repeat(2997) + "x";
const PAREN = Array.from({ length: 4096 }, (_, i) => String.fromCodePoint(0x249c + ((i * 7 + (i >> 3)) % 26))).join("");

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `cii-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const [mb] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: `me-${accountId.slice(0, 8)}@own.invalid` }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials */ } });
  const cycle = async (mail: Array<{ from: string; subject: string }>) => {
    fleet.behave(mb!.id, { deliver: mail.map((m) => ({ ...m, messageId: `ci-${randomUUID()}@x.invalid` })) });
    const t = performance.now();
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer", trustedAuthservIds: new Set<string>(),
    });
    return performance.now() - t;
  };
  const factOf = async (subjectStart: string) => {
    const rows = await db.select({ check: messages.senderCheck, brand: messages.senderCheckBrand, subject: messages.subject })
      .from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.accountId, accountId)));
    const row = rows.find((r) => r.subject.startsWith(subjectStart));
    return row === undefined ? undefined : { check: row.check, brand: row.brand };
  };
  return { cycle, factOf };
}

describe("crafted senders through real ingest", () => {
  it("three crafted inputs claim nothing and three real claims are held, in one bounded cycle", async () => {
    const w = await world();
    const ms = await w.cycle([
      { from: `"${NAME}" <anna@firma.invalid>`, subject: "crafted name" },
      { from: `"Crafted Sender" <${LOCAL}@firma.invalid>`, subject: "crafted local part" },
      { from: `"Crafted Sender" <${PAREN}@firma.invalid>`, subject: "crafted expanding local part" },
      { from: "Anna <anna@firma.invalid>", subject: SUBJECT },
      { from: `"${NAME.slice(0, 2988)} PostFinance" <anna@firma.invalid>`, subject: "claim at the end of the name" },
      { from: `<${LOCAL.slice(0, 244)}.postfinance@firma.invalid>`, subject: "claim at the end of the local part" },
      { from: "Anna <anna@firma.invalid>", subject: `PostFinance: Ihre Karte${SUBJECT.slice(23)}` },
    ]);
    expect(await w.factOf("crafted name")).toEqual({ check: "none", brand: null });
    expect(await w.factOf("crafted local part")).toEqual({ check: "none", brand: null });
    expect(await w.factOf("crafted expanding local part")).toEqual({ check: "none", brand: null });
    expect(await w.factOf("Aa ")).toEqual({ check: "none", brand: null });
    expect(await w.factOf("claim at the end of the name")).toEqual({ check: "impersonation", brand: "PostFinance" });
    expect(await w.factOf("claim at the end of the local part")).toEqual({ check: "impersonation", brand: "PostFinance" });
    expect(await w.factOf("PostFinance: Ihre Karte")).toEqual({ check: "impersonation", brand: "PostFinance" });
    expect(ms, "one cycle over the seven crafted messages").toBeLessThan(15_000);
  }, 60_000);
});

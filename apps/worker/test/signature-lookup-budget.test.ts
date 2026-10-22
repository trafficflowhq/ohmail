import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeSignatureCheck, type DkimKeyLookup } from "@trafficflow/core/adapters/dkim";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { mailboxes, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";
import { letter, nodemailerSign, rsaKey } from "../../../packages/core/test/fixtures/dkim-signed.js";

/**
 * ONE BUDGET PER CYCLE FOR THE SENDERS' KEY LOOKUPS, through a real sync cycle on the in-process
 * store. A page plans its letters one after another, and a stranger's one-click letter at a provider
 * nobody names asks its sender's DNS for a key: a deadline bounds one lookup, and only a budget the
 * cycle holds bounds the page. Each letter here is signed at a domain of its own whose name server
 * never answers. Mutations: make the budget per letter, or leave it off the plan (`sync.ts`).
 */

const ACCOUNT = "00000000-0000-4000-8000-00000000d1c1";
const DEADLINE_MS = 150;
const KEY = rsaKey(1024);

async function signedAt(domain: string, n: number): Promise<Buffer> {
  const raw = letter({
    from: `News <news@${domain}>`, messageId: `<m${n}@${domain}>`, subject: `Issue ${n}`,
    extra: [`List-Unsubscribe: <https://${domain}/u/${n}>`, "List-Unsubscribe-Post: List-Unsubscribe=One-Click"],
  });
  return Buffer.from(await nodemailerSign(raw, domain, "s1", KEY), "latin1");
}

describe("the senders' key lookups share one budget per cycle", () => {
  it("a page whose senders' name servers never answer costs the cycle its budget, and the next cycle has its own", async () => {
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes)
      .values({ accountId: ACCOUNT, provider: "imap", address: `mb-${randomUUID().slice(0, 8)}@lichtgrat.example` })
      .returning();
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    const asked: string[] = [];
    const keys: DkimKeyLookup = { lookup: (name) => { asked.push(name); return new Promise(() => undefined); } };
    const signatures = {
      ...makeSignatureCheck({ keys, lookupDeadlineMs: DEADLINE_MS, cycleLookupMs: 2.5 * DEADLINE_MS }), listLetters: true,
    };
    const deliver: { from: string; subject: string; messageId: string; raw: Buffer }[] = [];
    const add = async (n: number) => {
      deliver.push({ from: "-", subject: "-", messageId: `m${n}`, raw: await signedAt(`d${n}.example`, n) });
      fleet.behave(mb!.id, { deliver: [...deliver] });
    };
    const cycle = () => runSyncCycle({
      writeAuthority: FIXTURE_LEASE, repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT,
      mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP, role: "organizer",
      trustedAuthservIds: new Set<string>(), signatures,
    });

    for (let n = 0; n < 6; n++) await add(n);
    await cycle();
    expect(await db.select({ id: messages.id }).from(messages), "the page was ingested whole").toHaveLength(6);
    expect(asked.length, "a lookup per letter: no budget held across the page").toBeLessThanOrEqual(3);
    expect(asked.length).toBeGreaterThanOrEqual(1);

    const first = asked.length;
    await add(6);
    await cycle();
    expect(asked, "the next cycle began with this one's spent budget").toHaveLength(first + 1);
  });
});

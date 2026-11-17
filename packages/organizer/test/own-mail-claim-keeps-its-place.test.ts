import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, accountSettings, folderState, mailboxes, messages, type OrganizerRole, type Tx } from "@trafficflow/db";
import { runSyncCycle } from "../src/sync.js";
import { FakeAdapterFleet } from "./_fakeadapter.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * THE ACCOUNT'S OWN MAIL KEEPS ITS PLACE WHEN IT CLAIMS A COMPANY (REVIEW-02518 HIGH-1), through the
 * visit both organizer doors run, on both stores: the review's two probes stay in INBOX with the fact
 * on the row, while an own From failing DMARC at a trusted id and a stranger's claim are held. The
 * one-time own-mail release and the router agree on each message. Addresses are `.invalid`.
 */
const GATE = "ohmail/Screener";
const AUTHSERV = "mx.provider.invalid";

async function world() {
  const db = (await makeTestDb()) as unknown as Tx;
  const accountId = randomUUID();
  await db.insert(accounts).values({ id: accountId, name: `omc-${accountId.slice(0, 8)}` });
  await db.insert(accountSettings).values({ accountId, screeningScope: "all_time" });
  const me = `me-${accountId.slice(0, 8)}@own.invalid`;
  const [mb] = await db.insert(mailboxes).values({ accountId, provider: "imap", address: me }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory({ host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } });
  const cycle = (role: OrganizerRole = "organizer") => runSyncCycle({
    writeAuthority: role === "reader" ? { noLease: "reader" as const } : FIXTURE_LEASE,
    repo: makeDrizzleRepo(db as never), adapter, accountId, mailboxId: mb!.id,
    storageCap: UNMETERED_STORAGE_CAP, role, trustedAuthservIds: new Set([AUTHSERV]),
  });
  const own = {
    leadIn: { from: me, subject: "Fwd: PostFinance: Kontoauszug September" },
    name: { from: `Anna Muster Swisscom <${me}>`, subject: "a note" },
    forged: {
      from: me, subject: "PostFinance: Kontoauszug September",
      headers: [`Authentication-Results: ${AUTHSERV}; dmarc=fail header.from=own.invalid`],
    },
  };
  const deliver = (mail: Array<{ from: string; subject: string; headers?: string[] }>, folder?: string) =>
    fleet.behave(mb!.id, {
      deliver: mail.map((m) => ({ ...m, ...(folder ? { folder } : {}), messageId: `omc-${randomUUID()}@own.invalid` })),
    });
  const rowOf = async (subject: string) => {
    const [r] = await db.select({
      id: messages.id, desired: folderState.desiredFolder, check: messages.senderCheck, brand: messages.senderCheckBrand,
    }).from(messages).innerJoin(folderState, eq(folderState.messageId, messages.id))
      .where(and(eq(messages.mailboxId, mb!.id), eq(messages.subject, subject)));
    return r!;
  };
  const placeOf = async (subject: string) => {
    const r = await rowOf(subject);
    return { desired: r.desired, check: r.check, brand: r.brand };
  };
  /** The state the pre-fix router left: settled at the gate by this install. */
  const fileAtGate = async (subject: string) => db.update(folderState)
    .set({ desiredFolder: GATE, observedFolder: GATE, lastSetBy: "us", reconcileStatus: "reconciled" })
    .where(eq(folderState.messageId, (await rowOf(subject)).id));
  return { fleet, mb: mb!, cycle, own, deliver, placeOf, fileAtGate };
}

describe("own mail claiming a company, through the visit", () => {
  it("keeps its INBOX place with the fact on the row; a forged own From and a stranger's claim are held", async () => {
    const w = await world();
    w.deliver([
      w.own.leadIn, w.own.name, w.own.forged,
      { from: "PostFinance <kundendienst@stranger.invalid>", subject: "Ihre Karte" },
      { from: w.own.leadIn.from, subject: "a note to myself" },
    ]);
    await w.cycle();
    expect(await w.placeOf(w.own.leadIn.subject)).toEqual({ desired: "INBOX", check: "impersonation", brand: "PostFinance" });
    expect(await w.placeOf(w.own.name.subject)).toEqual({ desired: "INBOX", check: "impersonation", brand: "Swisscom" });
    expect(await w.placeOf(w.own.forged.subject)).toEqual({ desired: GATE, check: "impersonation", brand: "PostFinance" });
    expect(await w.placeOf("Ihre Karte")).toEqual({ desired: GATE, check: "impersonation", brand: "PostFinance" });
    // CONTROL: own mail with no claim is unchanged.
    expect(await w.placeOf("a note to myself")).toEqual({ desired: "INBOX", check: "none", brand: null });
    expect(w.fleet.movesFor(w.mb.id)).toEqual([GATE, GATE]);
  });

  it("the one-time release puts back what the router keeps, and leaves what the router holds", async () => {
    const keys = ["leadIn", "name", "forged"] as const;
    const router = await world();
    router.deliver(keys.map((k) => router.own[k]));
    await router.cycle();

    // The pre-fix router's filing, met by the organizer's first visit after a reader's ingest.
    const repair = await world();
    // In the gate folder, where the pre-fix router's move left them.
    repair.deliver(keys.map((k) => repair.own[k]), GATE);
    await repair.cycle("reader");
    for (const k of keys) await repair.fileAtGate(repair.own[k].subject);
    await repair.cycle();

    for (const k of keys) {
      const routed = (await router.placeOf(router.own[k].subject)).desired;
      expect((await repair.placeOf(repair.own[k].subject)).desired, k).toBe(routed);
    }
    expect((await repair.placeOf(repair.own.forged.subject)).desired).toBe(GATE);
    expect(repair.fleet.movesFor(repair.mb.id)).toEqual(["INBOX", "INBOX"]);
  });
});

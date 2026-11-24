import { accountOfMailbox } from "@trafficflow/db";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { accounts, mailboxCredentials, mailboxes } from "@trafficflow/db";
import { makeMailboxService } from "../src/mailbox-service.js";
import { makeCtx } from "./helpers.js";

/**
 * THE HOSTED DOOR CAN REFUSE `held` (TAKEOVER-DOORS-CANNOT-REFUSE-HELD). A join — setup's Agree when
 * nobody chose "Organize here instead" — over a holder the row shows renewing was authorized and
 * then yielded at the fence, so setup never asked the claim question. It is refused before anything
 * is written, like the local door's 409, naming the holder with an opaque per-mailbox reference and
 * never its install id. To watch it fail: drop the join arm in `MailboxService.organizeHere`.
 */

const SELF = "ohmail-cloud:test";

async function readerUnder(holder: { state: "held" | "stopped" | null; installId?: string | null; kind?: string | null }) {
  const w = await makeCtx();
  await w.db.insert(accounts).values({ id: w.accountId, name: "join" }).onConflictDoNothing();
  await w.db.update(mailboxes).set({
    organizerRole: "reader", organizerState: holder.state,
    organizedByKind: holder.kind === undefined ? "local" : holder.kind,
    organizedByName: holder.kind === null ? null : "W-live",
    organizedByInstallId: holder.installId === undefined ? "local:w-live" : holder.installId,
    organizedSince: holder.kind === null ? null : new Date("2026-09-20T08:00:00.000Z"),
  }).where(eq(mailboxes.id, w.mailboxId));
  await w.db.insert(mailboxCredentials).values({
    mailboxId: w.mailboxId, accountId: accountOfMailbox(w.mailboxId), transport: "imap", secretEnc: "sealed", keyVersion: 1,
    meta: { host: "imap.example.test", port: 993, secure: true, user: "u" }, updatedAt: new Date(),
  });
  const organize = (intent: "takeover" | "join") => makeMailboxService({ allowance: async () => {}, installId: SELF })
    .organizeHere(w.ctx, w.mailboxId, { intent, screening: { scope: "window" } });
  const row = async () => (await w.db.select().from(mailboxes).where(eq(mailboxes.id, w.mailboxId)))[0]!;
  return { ...w, organize, row };
}

type Refusal = { code: string; httpStatus: number; details: { by: { kind: string | null; name: string | null; ref?: string | null } } };

async function refusalOf(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (err) { return err as Refusal; }
  throw new Error("the press was admitted");
}

describe("a join over a live holder is refused on the hosted door, the holder named", () => {
  it("409 organized_elsewhere with the holder and an opaque reference; nothing written", async () => {
    const w = await readerUnder({ state: "held" });
    const e = await refusalOf(w.organize("join"));
    expect(e.code).toBe("organized_elsewhere");
    expect(e.httpStatus).toBe(409);
    expect(e.details.by).toMatchObject({ kind: "local", name: "W-live" });
    const ref = e.details.by.ref;
    expect(typeof ref, "the refusal carries no holder reference").toBe("string");
    expect(ref, "the reference is the install id itself").not.toContain("w-live");
    const after = await w.row();
    expect(after.organizeConsentedAt, "a refused join wrote consent").toBeNull();
    expect(after.takeoverAuthorizedAt, "a refused join wrote a stamp").toBeNull();
  });

  it("the reference names one holder on one mailbox: the same twice, another mailbox's differs", async () => {
    const a = await readerUnder({ state: "held" });
    const first = (await refusalOf(a.organize("join"))).details.by.ref;
    const again = (await refusalOf(a.organize("join"))).details.by.ref;
    expect(again).toBe(first);
    const b = await readerUnder({ state: "held" });
    expect((await refusalOf(b.organize("join"))).details.by.ref, "one holder, two mailboxes, one reference").not.toBe(first);
  });

  it.each([
    ["the named takeover", { state: "held" as const }, "takeover" as const],
    ["a join over a stopped holder", { state: "stopped" as const }, "join" as const],
    // The local door's rule: NULL is not a reading, so the row cannot refuse (`liveForeignHolder`).
    ["a join over a holder the row has not looked at", { state: null }, "join" as const],
    ["a join over nobody", { state: null, kind: null, installId: null }, "join" as const],
    ["a join over this deployment's own claim", { state: "held" as const, kind: "cloud", installId: SELF }, "join" as const],
  ])("CONTROL: %s is authorized as before", async (_label, holder, intent) => {
    const w = await readerUnder(holder);
    expect((await w.organize(intent)).outcome).toBe("authorized");
  });
});

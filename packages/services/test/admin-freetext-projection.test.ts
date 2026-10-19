import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { makeTestDb } from "@trafficflow/db/testing";
import { accounts, users, mailboxes, auditLog, STAFF_CHANNEL_OTHER } from "@trafficflow/db";
import { adminAccountDetail } from "../src/admin-service.js";

/**
 * INVARIANT #9 AT THE READ SIDE.
 *
 * The console's own comment used to say the redaction is at the write, "so this projection does
 * not have to remember to be narrow". Every case below plants a row DIRECTLY — the shape a
 * migration, a support script, a restored backup or an uncensused writer produces — and asks what
 * the staff DTO says. A member, or `other`. Never the planted text.
 */

const NOW = new Date("2026-09-12T18:00:00.000Z");
const ACCT = "11111111-1111-4111-8111-111111111111";
const MBX = "22222222-2222-4222-8222-222222222222";

/* What a leak actually looks like: a subject line and an address, the two things a mail server or
   a careless writer can put in a diagnostic column. Never printed by the assertions on failure. */
const PLANTED_DETAIL = "550 5.1.1 <a.person@example.invalid>: Recipient address rejected";
const PLANTED_CODE = "auth (Re: Q3 board pack)";
const PLANTED_ACTION = "admin.note: spoke to a.person@example.invalid about the invoice";

type Db = Awaited<ReturnType<typeof makeTestDb>>;

async function seed(db: Db, over: {
  errorCode: string | null; errorDetail: string | null; action: string;
}): Promise<void> {
  const w = db as unknown as { insert: (t: unknown) => { values: (v: unknown) => Promise<unknown> } };
  await w.insert(accounts).values({ id: ACCT, name: "Planted", createdAt: NOW });
  await w.insert(users).values({
    id: "33333333-3333-4333-8333-333333333333", accountId: ACCT,
    email: "owner@example.invalid", displayName: "Owner", createdAt: NOW,
  });
  await w.insert(mailboxes).values({
    id: MBX, accountId: ACCT, provider: "imap", address: "owner@example.invalid",
    status: "error", authKind: "password", createdAt: NOW, failedAt: NOW,
    errorCode: over.errorCode, errorDetail: over.errorDetail, retryCount: 1,
  });
  await w.insert(auditLog).values({ accountId: ACCT, action: over.action, createdAt: NOW });
}

describe("the staff projection reads the closed set, not the column", () => {
  it("renders planted free text as `other` on every one of the three channels", async () => {
    const db = await makeTestDb();
    await seed(db as Db, {
      errorCode: PLANTED_CODE, errorDetail: PLANTED_DETAIL, action: PLANTED_ACTION,
    });
    const detail = await adminAccountDetail(db as never, NOW, ACCT, { roles: ["owner"] });
    expect(detail).not.toBeNull();

    const box = detail!.mailboxes[0]!;
    expect(box.lastError).toBe(`${STAFF_CHANNEL_OTHER}: ${STAFF_CHANNEL_OTHER}`);
    // The whole DTO, serialised: no fragment of any planted string survives anywhere in it.
    const wire = JSON.stringify(detail);
    for (const needle of ["Recipient address rejected", "Q3 board pack", "about the invoice",
      "a.person", "5.1.1"]) {
      expect(wire.includes(needle), "a planted fragment reached the staff DTO").toBe(false);
    }
    expect(detail!.audit.map((a) => a.action)).toEqual([STAFF_CHANNEL_OTHER]);
  });

  it("ADMITS the ordinary case — a real code, a real detail, a real action", async () => {
    const db = await makeTestDb();
    await seed(db as Db, {
      errorCode: "auth", errorDetail: "AUTHENTICATIONFAILED", action: "admin.mailbox.resync",
    });
    const detail = await adminAccountDetail(db as never, NOW, ACCT, { roles: ["owner"] });
    expect(detail!.mailboxes[0]!.lastError).toBe("auth: AUTHENTICATIONFAILED");
    expect(detail!.audit.map((a) => a.action)).toEqual(["admin.mailbox.resync"]);
  });

  it("a null detail is a code alone, and an unwritten code reads `unknown`", async () => {
    const db = await makeTestDb();
    await seed(db as Db, {
      errorCode: null, errorDetail: null, action: "admin.mailbox.resync",
    });
    // `unknown`, not `other`: nothing was recorded, which is not the same as a foreign word.
    expect((await adminAccountDetail(db as never, NOW, ACCT, { roles: ["owner"] }))!.mailboxes[0]!.lastError)
      .toBe("unknown");
  });
});

/**
 * THE CENSUS. `admin-service.ts` is the console's only projection of these columns, and every
 * read of one has to go through `staffChannelWord`. A new panel that selects `errorDetail` and
 * ships it raw is what this counts.
 */
describe("every staff projection of a registered column passes the membership check", () => {
  const SRC = join(
    fileURLToPath(new URL(".", import.meta.url)), "..", "src", "admin-service.ts",
  );

  it("names the three reads and no fourth", () => {
    const text = readFileSync(SRC, "utf8");
    const guarded = [...text.matchAll(/staffChannelWord\("([^"]+)"/g)].map((m) => m[1]!);
    expect(guarded.sort()).toEqual([
      "audit_log.action", "mailboxes.error_code", "mailboxes.error_detail",
    ]);
  });

  it("no row field of a registered column reaches a DTO unguarded", () => {
    const text = readFileSync(SRC, "utf8");
    // Every mention of the two mailbox fields and the audit action as a row READ. Each must be
    // a `select` projection, a `staffChannelWord` argument, or the helper's own parameters.
    const reads = [...text.matchAll(/\brow\.(errorCode|errorDetail|action)\b/g)];
    expect(reads.length).toBeGreaterThan(0);
    for (const m of reads) {
      const line = text.slice(text.lastIndexOf("\n", m.index) + 1,
        text.indexOf("\n", m.index));
      expect(line, line.trim()).toMatch(/staffChannelWord|lastErrorWord/);
    }
  });
});

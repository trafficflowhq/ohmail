import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { makeTestDb } from "../src/testing.js";
import { accountStorage, accounts, UNMETERED, UNMETERED_ACCESS, type AccessVerdict, type Tx } from "@trafficflow/db";
import { heldStorageLimitOf, STORAGE_DROP_GRACE_MS } from "../src/storage-hold.js";
import { accountsAtCapOf, alertReadersOf, AT_CAP_READ_LIMIT } from "../src/at-cap-reader.js";
import { alertKindArms, evaluateAlertsWithScope } from "../src/alerts.js";

/**
 * THE STORAGE-CAP RULE HAS A READER, AND A SHORT READING SAYS SO (ALERT-STORAGE-CAP-RULE-HAS-NO-
 * READER). No host passed `accountsAtCap`, so `storage_at_cap` could not fire outside tests and read
 * as zero. The reader is the drivers' bag; its bound and its faults make the reading partial.
 */

type Db = Awaited<ReturnType<typeof makeTestDb>>;
const NOW = new Date("2026-09-29T08:00:00.000Z");
const GB = 1_000_000_000;

/** A program that states a cap per account, or none; `fault` answers the client's fault arm. */
function program(caps: Map<string, number | "fault">) {
  return {
    access: async (id: string): Promise<AccessVerdict> => {
      const cap = caps.get(id);
      if (cap === "fault") return UNMETERED_ACCESS;
      return { ok: true, limits: { mailboxes: null, storageBytes: cap ?? null, canAddMailbox: true, aiEnabled: true } };
    },
  } as never;
}

async function stored(db: Db, rows: Array<{ id: string; bytes: number }>): Promise<void> {
  for (let i = 0; i < rows.length; i += 200) {
    await db.insert(accountStorage).values(rows.slice(i, i + 200).map((r) => ({ accountId: r.id, bytes: r.bytes })));
  }
}

describe("storage_at_cap is read by the drivers' reader, and says when it is not", () => {
  it("no reader is unread by name, and a host that caps nobody reads clear", async () => {
    const db = await makeTestDb();
    await stored(db, [{ id: randomUUID(), bytes: 3 * GB }]);
    const none = await evaluateAlertsWithScope(db, { now: NOW });
    expect(none.scope.unreadReasons.get("storage_at_cap")).toBe("no_reader");
    expect(none.alerts.some((a) => a.kind === "storage_at_cap")).toBe(false);
    expect(accountsAtCapOf(UNMETERED), "an unmetered host caps nobody and says so").toBeNull();
    expect(alertReadersOf(UNMETERED)).toEqual({ parkedAccounts: null, accountsAtCap: null, planeOps: null });
    const stated = await evaluateAlertsWithScope(db, { now: NOW, accountsAtCap: null });
    expect(stated.scope.unread.has("storage_at_cap")).toBe(false);
  });

  it("an account at its cap fires the rule; one under it does not", async () => {
    const db = await makeTestDb();
    const full = randomUUID();
    const roomy = randomUUID();
    await stored(db, [{ id: full, bytes: 2 * GB }, { id: roomy, bytes: 1 * GB }]);
    const reader = accountsAtCapOf(program(new Map([[full, 2 * GB], [roomy, 5 * GB]])))!;
    const { alerts, scope } = await evaluateAlertsWithScope(db, { now: NOW, accountsAtCap: reader });
    const hit = alerts.find((a) => a.kind === "storage_at_cap");
    expect(hit?.count).toBe(1);
    expect(hit?.detail).not.toContain("Partial reading");
    expect(scope.unread.has("storage_at_cap")).toBe(false);
  });

  it("an account between a held limit and the lower one is not at its cap; after the hold's date it is", async () => {
    const db = await makeTestDb();
    const held = randomUUID();
    await db.insert(accounts).values({ id: held, name: "Held" });
    await stored(db, [{ id: held, bytes: 3 * GB }]);
    const cap = { ok: true as const, limits: { mailboxes: null, storageBytes: 10 * GB, canAddMailbox: true, aiEnabled: true } };
    await heldStorageLimitOf(db as unknown as Tx, held, cap, NOW);
    await heldStorageLimitOf(db as unknown as Tx, held, { ...cap, limits: { ...cap.limits, storageBytes: 2 * GB } }, NOW);
    const reader = accountsAtCapOf(program(new Map([[held, 2 * GB]])))!;
    expect((await reader(db, NOW)).atCap).toEqual([]);
    const after = new Date(NOW.getTime() + STORAGE_DROP_GRACE_MS + 86_400_000);
    expect((await reader(db, after)).atCap).toEqual([{ accountId: held, bytes: 3 * GB, storageBytesLimit: 2 * GB }]);
  });

  it("past the bound the reading is partial: '500 of 501', and its silence clears nothing", async () => {
    const db = await makeTestDb();
    const ids = Array.from({ length: AT_CAP_READ_LIMIT + 1 }, () => randomUUID());
    await stored(db, ids.map((id, i) => ({ id, bytes: 3 * GB + i })));
    const reader = accountsAtCapOf(program(new Map(ids.map((id) => [id, 2 * GB]))))!;
    const { alerts, scope } = await evaluateAlertsWithScope(db, { now: NOW, accountsAtCap: reader });
    const hit = alerts.find((a) => a.kind === "storage_at_cap");
    expect(hit?.count).toBe(AT_CAP_READ_LIMIT);
    expect(hit?.detail).toContain("500 of 501 accounts read");
    expect(scope.unreadReasons.get("storage_at_cap")).toBe("partial");
    expect(alertKindArms("storage_at_cap").evaluated("storage_at_cap", scope)).toBe(false);
  });

  it("an account whose cap could not be asked is not read, never 'under its cap'", async () => {
    const db = await makeTestDb();
    const asked = randomUUID();
    const faulted = randomUUID();
    await stored(db, [{ id: asked, bytes: 1 * GB }, { id: faulted, bytes: 4 * GB }]);
    const reader = accountsAtCapOf(program(new Map<string, number | "fault">([[asked, 5 * GB], [faulted, "fault"]])))!;
    const reading = await reader(db, NOW);
    expect(reading).toEqual({ atCap: [], read: 1, total: 2 });
    const { scope } = await evaluateAlertsWithScope(db, { now: NOW, accountsAtCap: reader });
    expect(scope.unreadReasons.get("storage_at_cap")).toBe("partial");
  });
});

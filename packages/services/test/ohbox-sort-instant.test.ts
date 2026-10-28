import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { mailboxes, messages } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { planChange, commitChange, UNMETERED_STORAGE_CAP } from "@trafficflow/core";
import type { Change } from "@trafficflow/core";
import { materializeMessage, sortAtOf, SORT_TOLERANCE_MS } from "../src/dto/materialize.js";

/**
 * `MessageDTO.sortAt` — THE ROW'S SORTING INSTANT. Every position keyed to the sender-written
 * `Date:` header, so a message whose header disagrees with its arrival by months took a position
 * months from where the reader watched the row. The clamp: the header decides while it lies
 * within {@link SORT_TOLERANCE_MS} of a KNOWN arrival (`messages.arrived_at`, mail 0119), else
 * arrival decides. NULL arrival ⇒ NO sortAt ⇒ the header keeps deciding — the exact pre-field
 * order, so nothing in history re-sorts. `created_at` is deliberately NOT the fallback: for a
 * backfilled mailbox it is the import day, and clamping against it would re-sort years of real
 * April mail to the day the account connected.
 */

const NOW = new Date("2026-09-18T13:19:00.000Z");
const APRIL = new Date("2026-04-14T09:00:00.000Z");

describe("sortAtOf — the clamp, both directions, and the null contract", () => {
  it("keeps the header while it agrees with arrival within tolerance", () => {
    const near = new Date(NOW.getTime() - 6 * 3600 * 1000);
    expect(sortAtOf(near, NOW)).toBe(near.toISOString());
  });

  it("a header months BEHIND a known arrival stops deciding — arrival does", () => {
    expect(sortAtOf(APRIL, NOW)).toBe(NOW.toISOString());
  });

  it("a header AHEAD of a known arrival beyond tolerance is a lie — arrival decides", () => {
    const future = new Date(NOW.getTime() + 30 * 864e5);
    expect(sortAtOf(future, NOW)).toBe(NOW.toISOString());
  });

  it("a header ahead of a known arrival never decides, inside the tolerance too", () => {
    // The tester's letter: Date two days ahead, appended seconds later, so just inside 48 h.
    for (const ahead of [1, SORT_TOLERANCE_MS - 4000, SORT_TOLERANCE_MS]) {
      expect(sortAtOf(new Date(NOW.getTime() + ahead), NOW), `+${ahead} ms`).toBe(NOW.toISOString());
    }
  });

  it("exactly at the tolerance boundary the header still decides; one ms past it does not", () => {
    const atEdge = new Date(NOW.getTime() - SORT_TOLERANCE_MS);
    const pastEdge = new Date(NOW.getTime() - SORT_TOLERANCE_MS - 1);
    expect(sortAtOf(atEdge, NOW)).toBe(atEdge.toISOString());
    expect(sortAtOf(pastEdge, NOW)).toBe(NOW.toISOString());
  });

  it("no header: arrival is the instant; no arrival: NO sortAt — the header keeps deciding", () => {
    expect(sortAtOf(null, NOW)).toBe(NOW.toISOString());
    expect(sortAtOf(APRIL, null)).toBeUndefined();
    expect(sortAtOf(null, null)).toBeUndefined();
  });

  /**
   * THE MIRROR'S ROUND TRIP — `cloud-mirror.ts` stores the wire's `sortAt` into the local
   * `arrived_at`, and the local door re-derives with `sortAtOf(date, that)`. The re-derivation
   * must answer the wire's own value or a paired desktop would sort one way on first pull and
   * another after its local materialize — the two-surfaces divergence FIX-020 exists to end.
   */
  it("is idempotent through the mirror: sortAtOf(date, sortAt(date, arrival)) === sortAt(date, arrival)", () => {
    const cases: Array<[Date | null, Date | null]> = [
      [APRIL, NOW], [NOW, NOW], [null, NOW],
      [new Date(NOW.getTime() - 3600e3), NOW],
      [new Date(NOW.getTime() + 90 * 864e5), NOW],
    ];
    for (const [date, arrival] of cases) {
      const first = sortAtOf(date, arrival);
      expect(first).toBeDefined();
      expect(sortAtOf(date, new Date(first!))).toBe(first);
    }
  });
});

function eml(dateHeader: string | null): Buffer {
  return Buffer.from([
    `Message-ID: <sort-${randomUUID()}@cal.example>`,
    "From: organizer@cal.example",
    "To: a@example.test",
    "Subject: Invitation: Sync @ Tue Sep 29, 2026 10am (CEST)",
    ...(dateHeader === null ? [] : [`Date: ${dateHeader}`]),
    "Content-Type: text/plain; charset=utf-8",
    "",
    "You have been invited.",
  ].join("\r\n"));
}

/**
 * THE INGEST CARRIES THE ARRIVAL — through the ONE pipeline both the Cloud worker and the
 * sidecar drive (`one-pipeline.test.ts` is the census that there is no second one). This file
 * runs in BOTH projects: the default (PGlite — the worker's dialect) and `pnpm test:sqlite`
 * (the device store — the sidecar's and the phone's), so each ingest path's dialect round-trips
 * the column it now writes.
 */
describe("ingest writes messages.arrived_at from the change's INTERNALDATE", () => {
  async function world() {
    const db = await makeTestDb();
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes)
      .values({ accountId, provider: "imap", address: `${accountId.slice(0, 8)}@example.test` }).returning();
    return { db, accountId, mailboxId: mb!.id };
  }

  async function ingest(
    w: Awaited<ReturnType<typeof world>>, raw: Buffer, internalDate?: Date,
  ): Promise<string> {
    const change: Change = {
      type: "create", locator: { folder: "INBOX", ref: `1:${Math.floor(Math.random() * 1e6)}` },
      raw, ...(internalDate ? { internalDate } : {}),
    };
    const repo = makeDrizzleRepo(w.db);
    const plan = await planChange(change, { repo, accountId: w.accountId, mailboxId: w.mailboxId, routing: repo, readerMode: false });
    const res = await repo.transaction((tx) => commitChange(plan, {
      repo: tx, routing: tx, accountId: w.accountId, mailboxId: w.mailboxId,
      storageCap: UNMETERED_STORAGE_CAP,
    }));
    return res.messageId;
  }

  it("a message ingested with an INTERNALDATE carries it, to the millisecond", async () => {
    const w = await world();
    const id = await ingest(w, eml(NOW.toUTCString()), NOW);
    const [row] = await w.db.select().from(messages).where(eq(messages.id, id));
    expect(row!.arrivedAt?.getTime()).toBe(NOW.getTime());
  });

  it("an April header on a today arrival: the DTO's sortAt is the ARRIVAL", async () => {
    const w = await world();
    const id = await ingest(w, eml(APRIL.toUTCString()), NOW);
    const dto = await materializeMessage(w.db, w.accountId, id);
    expect(dto!.sortAt).toBe(NOW.toISOString());
    // Shown as the sender wrote it — the clamp moves the position, never the displayed date.
    expect(new Date(dto!.date!).getTime()).toBe(APRIL.getTime());
  });

  it("a header that agrees with arrival: sortAt is the header — the finer instant", async () => {
    const w = await world();
    const sent = new Date(NOW.getTime() - 90 * 60 * 1000);
    const id = await ingest(w, eml(sent.toUTCString()), NOW);
    const dto = await materializeMessage(w.db, w.accountId, id);
    expect(dto!.sortAt).toBe(sent.toISOString());
  });

  it("no INTERNALDATE: arrived_at stays NULL and the DTO carries NO sortAt key at all", async () => {
    const w = await world();
    const id = await ingest(w, eml(APRIL.toUTCString()));
    const [row] = await w.db.select().from(messages).where(eq(messages.id, id));
    expect(row!.arrivedAt).toBeNull();
    const dto = await materializeMessage(w.db, w.accountId, id);
    // ABSENT, not present-and-undefined: absent is the wire's "the header decides", and a
    // present key would survive JSON where absent does not — the `autoReplyByUs` rule.
    expect(Object.hasOwn(dto!, "sortAt")).toBe(false);
  });
});

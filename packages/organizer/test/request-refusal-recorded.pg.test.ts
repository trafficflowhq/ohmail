import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { mailboxes, readIdempotencyKey, type Tx } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import {
  formatRequest, acksIn, deriveRequestKey, RequestUnavailableError,
  type RequestOrganizerIo, type RawMetaMessage, type MetaRecordsList,
} from "@trafficflow/core/adapters/organizer-lease";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { applyMetaRequests } from "../src/request-drain.js";
import { listedOf } from "./_meta-list.js";

/**
 * AN APPLIER'S REFUSAL IS RECORDED AFTER ITS ROLLBACK, on real Postgres. The apply claims
 * `meta-request:<id>` inside its transaction and the refusal throws it back out; the refusal is
 * then claimed under the same key in a transaction of its own, before the ack. Only a real server
 * says the rolled-back claim released the unique key for the second one. When the ack fails the
 * record stays and the next pass answers it from that key, once.
 */

const AVAILABLE = await realPgAvailable();
const sql = postgres(PG_TEST_URL, { max: 3 });
const db = brandDialect(drizzle(sql, { schema }), "pg") as unknown as Tx;
const NOW = new Date("2026-09-29T08:00:00.000Z");
const MIN = 60_000;
const ADDRESS = "refusal@mailbox.example";
const KEY = deriveRequestKey({ auth: { user: ADDRESS, pass: "shared-password" }, address: ADDRESS })!;

function folder(o: { ackFails: () => boolean }) {
  const store = new Map<number, string>();
  let nextUid = 1;
  const io: RequestOrganizerIo = {
    async listMetaRecords(): Promise<MetaRecordsList> { return listedOf([...store.entries()].map(([ref, raw]) => ({ ref, raw }))); },
    async ack(raw: string): Promise<void> {
      if (o.ackFails()) {
        throw new RequestUnavailableError("an acknowledgement could not be appended to ohmail/_meta", {
          op: "append_request", cause: new Error("NO [OVERQUOTA] the server refused the append"),
        });
      }
      store.set(nextUid++, raw);
    },
    async remove(refs: readonly unknown[]): Promise<void> { for (const r of refs) if (typeof r === "number") store.delete(r); },
  };
  return { store, io, seed: (raw: string): void => { store.set(nextUid++, raw); } };
}

describe.skipIf(!AVAILABLE)("a refusal recorded after the apply's rollback, on real Postgres", () => {
  beforeAll(async () => { await runMigrations(PG_TEST_URL); });
  afterAll(async () => { await sql.end({ timeout: 5 }); });

  it("the key holds the refusal, the record stays for its answer, and the next pass sends it once", async () => {
    const accountId = randomUUID();
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `${randomUUID()}@x.example`,
    }).returning({ id: mailboxes.id });
    const mailboxId = mb!.id;
    let failing = true;
    const f = folder({ ackFails: () => failing });
    const requestId = randomUUID();
    // A move of a message this store never synced: the applier refuses it inside the apply.
    f.seed(formatRequest({
      requestId, kind: "message.move", mailboxId, installId: "reader-install", organizerKind: "local",
      decidedAt: NOW, key: KEY, payload: { dedupKey: `mid:${randomUUID()}`, destination: "inbox" },
    }));
    const run = (at: Date) => applyMetaRequests(db, {
      mailboxId, accountId, installId: "organizer-install",
      adapter: { requestOrganizerIo: () => f.io } as unknown as MailboxAdapter, requestKey: KEY,
    }, at, () => undefined);

    const first = await run(NOW);
    const key = await db.transaction((tx) => readIdempotencyKey(tx, accountId, `meta-request:${requestId}`, NOW));
    failing = false;
    const second = await run(new Date(NOW.getTime() + MIN));
    const acks = acksIn([...f.store.entries()].map(([ref, raw]) => ({ ref, raw })), KEY);

    expect({
      first, keyAnswer: key?.responseJson ?? null,
      second, acks: acks.map((a) => [a.requestId === requestId, a.outcome, a.reason ?? null]),
      recordsLeft: [...f.store.values()].filter((raw) => /(^|\n)X-Ohmail-Request:/i.test(raw)).length,
    }).toEqual({
      first: { applied: 0, refused: 0, deferred: 1, standing: 0 },
      keyAnswer: { applied: false, requestId, reason: "no_such_message" },
      second: { applied: 0, refused: 1, deferred: 0, standing: 0 },
      acks: [[true, "refused", "no_such_message"]],
      recordsLeft: 0,
    });
  });
});

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import { brandDialect } from "@trafficflow/db/dialect";
import { runMigrations } from "@trafficflow/db/admin";
import { PG_TEST_URL, realPgAvailable } from "@trafficflow/db/testing";
import { accounts, folderState, mailboxes, messageInstances, messages } from "@trafficflow/db";
import { schema } from "@trafficflow/db/cloud";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { UNMETERED_STORAGE_CAP, type LogFields } from "@trafficflow/core/mail";
import type { NativeLocator } from "@trafficflow/core";
import { WriteDeclinedError, type ChangeBatch, type MailboxAdapter, type WriteDoor } from "@trafficflow/core/adapters/imap";
import { runSyncCycle, type SyncDeps } from "../src/sync.js";
import { FIXTURE_LEASE } from "./_door.js";

/**
 * A CYCLE COMPOSED WITHOUT A PERMIT FILES NOTHING. Real Postgres (the lane db), a real repo, one
 * message owed a move, and an adapter that asks the door the way `ImapAdapter` does. Composed with
 * no `writeAuthority` the cycle reads `not_supplied`: the move is refused before it goes out, the
 * row stays owed, and the refusal is said at error by name. The fixture lease files the same row.
 */

const AVAILABLE = await realPgAvailable();

describe.skipIf(!AVAILABLE)("a cycle composed without a permit", () => {
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let sql: ReturnType<typeof postgres>;
  beforeAll(async () => {
    await runMigrations(PG_TEST_URL);
    sql = postgres(PG_TEST_URL, { max: 4, onnotice: () => {} });
    db = brandDialect(drizzle(sql, { schema }), "pg");
  }, 60_000);
  afterAll(async () => { await sql?.end({ timeout: 5 }); });

  async function owedOneMove(): Promise<{ accountId: string; mailboxId: string; messageId: string }> {
    const accountId = randomUUID();
    const tag = accountId.slice(0, 8);
    await db.insert(accounts).values({ id: accountId, name: `np-${tag}` });
    const [mb] = await db.insert(mailboxes).values({
      accountId, provider: "imap", address: `np-${tag}@example.test`, status: "connected",
    }).returning();
    const [m] = await db.insert(messages).values({
      accountId, mailboxId: mb!.id, dedupKey: `mid:<np-${tag}@example.test>`,
      messageIdHeader: `np-${tag}@example.test`, fromAddress: "stranger@example.test", subject: "s",
      date: new Date("2026-08-13T12:00:00.000Z"), bodyHash: `np-hash-${tag}`,
      nativeLocator: { folder: "INBOX", ref: "1:200" },
    }).returning();
    await db.insert(messageInstances).values({
      accountId, messageId: m!.id, mailboxId: mb!.id, folder: "INBOX", uid: 200, uidvalidity: 1n, isPrimary: true,
    });
    await db.insert(folderState).values({
      messageId: m!.id, accountId: m!.accountId, desiredFolder: "ohmail/News", observedFolder: "INBOX", reconcileStatus: "pending", lastSetBy: "us",
    });
    return { accountId, mailboxId: mb!.id, messageId: m!.id };
  }

  /** Asks the door before the MOVE, as the real adapter does; a declined move is never issued. */
  function doorAskingHost(): { adapter: MailboxAdapter; moves: string[] } {
    const moves: string[] = [];
    const adapter = {
      move: async (locator: NativeLocator, toFolder: string, door: WriteDoor): Promise<NativeLocator> => {
        const answer = door.ask("move");
        if (!answer.admit) throw new WriteDeclinedError("move", answer.reason);
        moves.push(`${locator.folder}/${locator.ref}→${toFolder}`);
        return { folder: toFolder, ref: "1:7" };
      },
      setFlags: async () => {},
      changesSince: async (): Promise<ChangeBatch> =>
        ({ creates: [], moves: [], flagChanges: [], deletes: [], newCursor: { folders: {} }, hasBacklog: false }) as ChangeBatch,
    } as unknown as MailboxAdapter;
    return { adapter, moves };
  }

  function recordingLog() {
    const lines: Array<{ level: string; event: string; fields: LogFields }> = [];
    const mk = (bound: LogFields): unknown => {
      const at = (level: string) => (event: string, fields?: LogFields): void => { lines.push({ level, event, fields: { ...bound, ...fields } }); };
      return { level: "debug", child: (f: LogFields) => mk({ ...bound, ...f }), debug: at("debug"), info: at("info"), warn: at("warn"), error: at("error") };
    };
    return { lines, log: mk({}) as SyncDeps["log"] };
  }

  const stateOf = async (messageId: string) =>
    (await db.select().from(folderState).where(eq(folderState.messageId, messageId)))[0]!;

  it("is refused the move, keeps the row owed, and says why at error", async () => {
    const w = await owedOneMove();
    const host = doorAskingHost();
    const { lines, log } = recordingLog();
    // COMPOSED WITHOUT A PERMIT: the required field is left out, as a root that forgot it would.
    const deps = {
      repo: makeDrizzleRepo(db as never), adapter: host.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
      role: "organizer", storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(), log,
    } as unknown as SyncDeps;
    const refused = await runSyncCycle(deps).then(() => null, (e: unknown) => e);
    expect(refused).toBeInstanceOf(WriteDeclinedError);
    expect((refused as WriteDeclinedError).reason).toBe("not_supplied");
    expect(host.moves, "a cycle with no lease moved mail").toEqual([]);
    const st = await stateOf(w.messageId);
    expect({ desired: st.desiredFolder, observed: st.observedFolder, status: st.reconcileStatus, attempts: st.attempts })
      .toEqual({ desired: "ohmail/News", observed: "INBOX", status: "pending", attempts: 0 });
    expect(lines.filter((l) => l.event === "write_declined_mid_cycle").map((l) => [l.level, l.fields.verdict]))
      .toEqual([["error", "not_supplied"]]);
  }, 60_000);

  it("the admitting control: the fixture's held lease files the same row", async () => {
    const w = await owedOneMove();
    const host = doorAskingHost();
    const deps: SyncDeps = {
      repo: makeDrizzleRepo(db as never), adapter: host.adapter, accountId: w.accountId, mailboxId: w.mailboxId,
      role: "organizer", storageCap: UNMETERED_STORAGE_CAP, trustedAuthservIds: new Set<string>(),
      writeAuthority: FIXTURE_LEASE,
    };
    await runSyncCycle(deps);
    expect(host.moves).toEqual(["INBOX/1:200→ohmail/News"]);
    expect((await stateOf(w.messageId)).observedFolder).toBe("ohmail/News");
  }, 60_000);
});

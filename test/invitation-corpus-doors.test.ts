import { describe, expect, it } from "vitest";
import { mailboxes, messageInvitations, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { readLetterInvitation, UNMETERED_STORAGE_CAP, type Logger } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../apps/worker/src/sync";
import { ingestRunRepository } from "../apps/worker/src/ingest-run";
import { INGEST_RUN_BOUNDS } from "../apps/worker/src/config";
import { FakeAdapterFleet } from "../apps/worker/test/_fakeadapter";
import { FIXTURE_LEASE } from "../apps/worker/test/_door";
import { invitationLetter, ME } from "../apps/worker/test/_invitations";
import { CORPUS } from "../packages/cal-core/test/corpus/index";
import { text } from "../packages/cal-core/test/support";

/**
 * THE CALENDAR'S CORPUS THROUGH BOTH OF THE WORKER'S DOORS. Every text of the calendar package's
 * corpus, each as a letter of its own, is stored one letter at a time and through a first import
 * with runs on: both stores keep the same rows, and each row is what the reader says of its text.
 * Here and not under the worker, because the worker does not depend on the calendar's package.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000c44e";

const letters = CORPUS.map((f, i) => ({ name: f.name, text: text(f), letter: invitationLetter(`corpus-${i}@studio.example`, text(f)) }));

function quiet(): Logger & { events: string[] } {
  const events: string[] = [];
  const log = {
    level: "debug" as const, events, child: () => log,
    debug: (e: string) => { events.push(e); }, info: (e: string) => { events.push(e); },
    warn: (e: string) => { events.push(e); }, error: (e: string) => { events.push(e); },
  };
  return log as unknown as Logger & { events: string[] };
}

async function store(runs: boolean): Promise<{ rows: Map<string, unknown>; events: string[] }> {
  const db = (await makeTestDb()) as unknown as Tx;
  const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: ME }).returning();
  const fleet = new FakeAdapterFleet();
  const adapter = fleet.factory(
    { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
    { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
  );
  fleet.behave(mb!.id, { deliver: letters.map((l) => l.letter) });
  const base = makeDrizzleRepo(db as never);
  const log = quiet();
  await runSyncCycle({
    log, writeAuthority: FIXTURE_LEASE, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null,
    repo: runs ? ingestRunRepository(base) : base, adapter, accountId: ACCOUNT, mailboxId: mb!.id,
    storageCap: UNMETERED_STORAGE_CAP, ...(runs ? { ingestRuns: INGEST_RUN_BOUNDS } : {}),
  });
  const mids = new Map((await db.select({ id: messages.id, mid: messages.messageIdHeader }).from(messages)).map((m) => [m.id, m.mid ?? ""]));
  const rows = await db.select().from(messageInvitations);
  return {
    rows: new Map(rows.map(({ messageId, mailboxId: _b, createdAt: _c, ...rest }) => [mids.get(messageId) ?? "", rest])),
    events: log.events,
  };
}

describe("the calendar's corpus, stored by the worker's two doors", () => {
  it("one letter at a time and in runs keep the same rows, each the reader's", async () => {
    const one = await store(false);
    const runs = await store(true);
    expect(runs.rows).toEqual(one.rows);
    expect(runs.events).not.toContain("sync_ingest_run_fell_back");
    let kept = 0;
    for (const l of letters) {
      const read = readLetterInvitation([{ id: "1", contentType: "text/calendar", text: l.text }]);
      const row = one.rows.get(l.letter.messageId) as Record<string, unknown> | undefined;
      if (read === undefined) {
        expect(row, l.name).toBeUndefined();
        continue;
      }
      kept++;
      expect(row, l.name).toMatchObject({
        uid: read.uid, recurrenceId: read.recurrenceId, sequence: read.sequence, method: read.method,
        startRaw: read.startRaw, startsAt: read.startsAt, organizer: read.organizer,
      });
    }
    expect(kept).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

import { describe, expect, it } from "vitest";
import { mailboxes, messageInvitations, messages, type Tx } from "@trafficflow/db";
import { makeTestDb } from "@trafficflow/db/testing";
import { readLetterInvitation, UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { runSyncCycle } from "../packages/organizer/src/sync";
import { FakeAdapterFleet } from "../packages/organizer/test/_fakeadapter";
import { FIXTURE_LEASE } from "../packages/organizer/test/_door";
import { invitationLetter, ME } from "../packages/organizer/test/_invitations";
import { CORPUS } from "../packages/cal-core/test/corpus/index";
import { text } from "../packages/cal-core/test/support";

/**
 * THE CALENDAR'S CORPUS, STORED ONE LETTER AT A TIME, on the store a server holds and on the one a
 * phone holds (the `sqlite` project runs this file too): each letter keeps the row the reader says
 * of its text, and a text that keeps none stores none. The batched import's door is compared with
 * this one in `invitation-corpus-doors.test.ts`, on the server's store alone, where it runs.
 */
const ACCOUNT = "00000000-0000-4000-8000-00000000c45e";

describe("the calendar's corpus, one letter at a time", () => {
  it("every letter keeps the row its calendar part says, and no other", async () => {
    const letters = CORPUS.map((f, i) => ({ name: f.name, text: text(f), letter: invitationLetter(`corpus-${i}@studio.example`, text(f)) }));
    const db = (await makeTestDb()) as unknown as Tx;
    const [mb] = await db.insert(mailboxes).values({ accountId: ACCOUNT, provider: "imap", address: ME }).returning();
    const fleet = new FakeAdapterFleet();
    const adapter = fleet.factory(
      { host: "h", port: 143, secure: false, auth: { user: "u", pass: "p" } },
      { accountId: ACCOUNT, mailboxId: mb!.id, onConnectionError: () => { /* nothing dials here */ } },
    );
    fleet.behave(mb!.id, { deliver: letters.map((l) => l.letter) });
    await runSyncCycle({
      writeAuthority: FIXTURE_LEASE, role: "organizer", trustedAuthservIds: new Set<string>(), signatures: null,
      repo: makeDrizzleRepo(db as never), adapter, accountId: ACCOUNT, mailboxId: mb!.id, storageCap: UNMETERED_STORAGE_CAP,
    });
    const mids = new Map((await db.select({ id: messages.id, mid: messages.messageIdHeader }).from(messages)).map((m) => [m.id, m.mid ?? ""]));
    expect(mids.size).toBe(letters.length);
    const rows = new Map((await db.select().from(messageInvitations)).map((r) => [mids.get(r.messageId) ?? "", r]));
    let kept = 0;
    for (const l of letters) {
      const read = readLetterInvitation([{ id: "1", contentType: "text/calendar", text: l.text }]);
      if (read === undefined) {
        expect(rows.get(l.letter.messageId), l.name).toBeUndefined();
        continue;
      }
      kept++;
      expect(rows.get(l.letter.messageId), l.name).toMatchObject({
        uid: read.uid, recurrenceId: read.recurrenceId, sequence: read.sequence, method: read.method,
        startRaw: read.startRaw, startsAt: read.startsAt, organizer: read.organizer, mailboxId: mb!.id,
      });
    }
    expect(kept).toBeGreaterThanOrEqual(4);
  }, 120_000);
});

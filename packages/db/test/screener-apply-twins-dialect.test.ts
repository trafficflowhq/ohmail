import { accountOfMessage } from "../src/parent-account.js";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  changeLog as pgChangeLog, folderState as pgFolderState, mailboxes as pgMailboxes,
  messages as pgMessages, rules as pgRules,
} from "@trafficflow/db";
import {
  changeLog as deviceChangeLog, folderState as deviceFolderState, mailboxes as deviceMailboxes,
  messages as deviceMessages, rules as deviceRules,
} from "../src/schema-mail-sqlite.js";
import { makeTestDb, TEST_DIALECT_ENV } from "../src/testing.js";
import { carryDialect } from "../src/dialect/index.js";
import { applyScreenerDecision, SCREENER_FOLDER } from "../src/screener-apply.js";

/**
 * THE DECIDE'S TWIN RETARGET ON BOTH STORES. The standalone phone decides through the same
 * `applyScreenerDecision` on the device store, so the retarget's statement runs here on whichever
 * store the matrix points at: a deny twin moves to the decided place, a term rule does not, and the
 * change log carries the update. The Postgres-only cases are `screener-apply-twins.test.ts`.
 */
const ON_SQLITE = process.env[TEST_DIALECT_ENV] === "sqlite";
const mailboxes = (ON_SQLITE ? deviceMailboxes : pgMailboxes) as unknown as typeof pgMailboxes;
const messages = (ON_SQLITE ? deviceMessages : pgMessages) as unknown as typeof pgMessages;
const folderState = (ON_SQLITE ? deviceFolderState : pgFolderState) as unknown as typeof pgFolderState;
const rules = (ON_SQLITE ? deviceRules : pgRules) as unknown as typeof pgRules;
const changeLog = (ON_SQLITE ? deviceChangeLog : pgChangeLog) as unknown as typeof pgChangeLog;

const ACCOUNT = "11111111-2222-3333-4444-555555555556";
const MAILBOX = "22222222-3333-4444-5555-666666666667";
const MESSAGE = "33333333-4444-5555-6666-777777777771";
const DENY = "44444444-5555-6666-7777-888888888881";
const TERM = "44444444-5555-6666-7777-888888888882";
const ADDR = "lena@atelier.example";
const NOW = new Date("2026-09-25T09:00:00.000Z");

describe("the decide retargets the subject's twins, on this store", () => {
  it("a deny twin files where the sender was admitted; a term rule keeps its place", async () => {
    const db = await makeTestDb();
    await db.insert(mailboxes).values({ id: MAILBOX, accountId: ACCOUNT, provider: "imap", address: "twin@example.test" } as never);
    await db.insert(messages).values({
      id: MESSAGE, accountId: ACCOUNT, mailboxId: MAILBOX, bodyHash: "h", dedupKey: "twin:1",
      subject: "held", snippet: "", fromAddress: ADDR, unread: true, createdAt: NOW,
    } as never);
    await db.insert(folderState).values({
      messageId: MESSAGE, accountId: accountOfMessage(MESSAGE), desiredFolder: SCREENER_FOLDER, observedFolder: SCREENER_FOLDER,
      lastSetBy: "us", reconcileStatus: "reconciled", conflict: false,
    } as never);
    for (const [id, over] of [[DENY, {}], [TERM, { subjectContains: "invoice" }]] as const) {
      await db.insert(rules).values({
        id, accountId: ACCOUNT, kind: "sender", match: ADDR, destination: "ohmail/Screened", provenance: "manual",
        ...over,
      } as never);
    }

    await db.transaction((tx) => applyScreenerDecision(carryDialect(db, tx), {
      accountId: ACCOUNT, scope: "sender", address: ADDR, appliedFolder: "INBOX", decision: "yes",
      triggeringActionId: `screener:${MESSAGE}`, now: NOW, decidedBy: "person", overExisting: "converge",
    }));

    const destination = async (id: string) => (await db.select().from(rules).where(eq(rules.id, id)))[0]!.destination;
    expect(await destination(DENY)).toBe("INBOX");
    expect(await destination(TERM)).toBe("ohmail/Screened");
    const logged = await db.select().from(changeLog).where(eq(changeLog.entityId, DENY));
    expect(logged.map((c) => c.op)).toEqual(["update"]);
  });
});

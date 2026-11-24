import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { mailboxFolders, messageStates } from "@trafficflow/db";
import {
  planChange, commitChange, UNMETERED_STORAGE_CAP,
} from "@trafficflow/core";
import type { Change } from "@trafficflow/core";
import { makeDrizzleRepo } from "@trafficflow/core/adapters/drizzle-repo";
import { MessageService, TriageService, setFoldersEnabled } from "../src/index.js";
import { makeCtx, seedMessage } from "./helpers.js";

/**
 * EVERY LIST PAGE COSTS ONE PAGE OF ROUND-TRIPS, NOT ONE PER ROW.
 *
 * `search-materialize.test.ts` states this property for `GET /search` and guards it there. The
 * four other readers that assemble a page of `MessageDTO`s did not have it: each ran
 * `for (const r of pageRows) await materializeMessage(...)`, and the singular form is a
 * one-element wrapper over the batch, so a page cost six sequential statements PER ROW.
 *
 * ── WHY IT WAS INVISIBLE, WHICH IS THE PART WORTH KEEPING ─────────────────────────────────
 *
 * The sidecar's liveness file measured this read at ~520 reads/s in August and used that figure
 * to size its read budget. That measurement was taken against an EMPTY imbox — the fixture's
 * mail was organized into the Screener, so `view=imbox` matched no rows and the "read" was two
 * statements that assembled nothing. When the same fixture's mail began landing in INBOX the
 * identical read became 122 statements and 61 ms, the read budget took 47 s instead of 1.5 s,
 * and a liveness ceiling failed for a cost defect that had been there the whole time.
 *
 * So the assertion here is about the SHAPE, never a millisecond figure — a timing assertion
 * passes on a fast machine with the per-row loop restored — and every case asserts HOW MANY
 * ROWS it got back as well as how many statements it took. A constant-cost guard whose list is
 * empty is constant at zero and proves nothing, which is precisely how this went unnoticed.
 */

type Counted = { selects: number; hits: number };

/** Count drizzle-level SELECTs issued by one read, the way the search guard does. */
async function count(
  db: Awaited<ReturnType<typeof makeCtx>>["db"],
  read: () => Promise<{ items: unknown[] }>,
): Promise<Counted> {
  const spy = vi.spyOn(db, "select");
  try {
    const res = await read();
    return { selects: spy.mock.calls.length, hits: res.items.length };
  } finally {
    spy.mockRestore();
  }
}

describe("a page of messages is materialized in one batch, not once per row", () => {
  it("MessageService.list: the SELECT count is the same for one row and for six", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new MessageService();
    const seed = (n: number) => seedMessage(db, accountId, mailboxId, {
      folder: "INBOX", subject: `imbox ${n}`,
    });

    await seed(0);
    const one = await count(db, () => svc.list(ctx, { view: "imbox" }));
    expect(one.hits, "the imbox list is empty, so it is not a control").toBe(1);

    for (let n = 1; n < 6; n++) await seed(n);
    const six = await count(db, () => svc.list(ctx, { view: "imbox" }));
    expect(six.hits).toBe(6);
    // THE GUARD. Red the moment the per-row loop comes back: 8 statements become 38.
    expect(six.selects).toBe(one.selects);
  });

  it("MessageService.list view=folder: the SELECT count is the same for one row and for six", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new MessageService();
    await setFoldersEnabled(ctx, true);
    const [folder] = await db.insert(mailboxFolders)
      .values({ mailboxId, accountId, folder: "Projects", uidvalidity: 1n, uidnext: 1n, highestmodseq: 1n })
      .returning();
    const seed = (n: number) => seedMessage(db, accountId, mailboxId, {
      folder: "Projects", subject: `project ${n}`,
    });

    await seed(0);
    const read = () => svc.list(ctx, { view: "folder", folderId: folder!.id });
    const one = await count(db, read);
    expect(one.hits, "the folder list is empty, so it is not a control").toBe(1);

    for (let n = 1; n < 6; n++) await seed(n);
    const six = await count(db, read);
    expect(six.hits).toBe(6);
    expect(six.selects).toBe(one.selects);
  });

  it("MessageService.markSeen: the echo costs the same for one id and for six", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new MessageService();
    const ids: string[] = [];
    for (let n = 0; n < 6; n++) {
      ids.push(await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: `seen ${n}` }));
    }

    const one = await count(db, () => svc.markSeen(ctx, { ids: ids.slice(0, 1), unread: false }));
    expect(one.hits, "the echo returned nothing, so it is not a control").toBe(1);
    const six = await count(db, () => svc.markSeen(ctx, { ids, unread: true }));
    expect(six.hits).toBe(6);
    // The route accepts up to 200 ids; the per-row form made that 200 sequential materializes.
    expect(six.selects).toBe(one.selects);
  });

  it("TriageService.listByState: the SELECT count is the same for one row and for six", async () => {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const svc = new TriageService();
    const pin = async (n: number) => {
      const id = await seedMessage(db, accountId, mailboxId, { folder: "INBOX", subject: `later ${n}` });
      await db.insert(messageStates).values({
        id: randomUUID(), accountId, messageId: id, state: "reply_later",
      });
    };

    await pin(0);
    const read = () => svc.listByState(ctx, "reply_later");
    const one = await count(db, read);
    expect(one.hits, "the triage pile is empty, so it is not a control").toBe(1);

    for (let n = 1; n < 6; n++) await pin(n);
    const six = await count(db, read);
    expect(six.hits).toBe(6);
    expect(six.selects).toBe(one.selects);
  });
});

/**
 * WHOSE WORLD THE FOUR GUARDS ABOVE ARE SEEDED IN — the premise that was never written down.
 *
 * Their `hits` assertions only hold because a first-contact stranger's mail SITS IN `INBOX`, and
 * that is a property of the install, not of the fixture: a consent-less READER adopts the arrival
 * folder (`pipeline.ts#planChange`, the `readerMode` arm), a consented ORGANIZER files the same
 * message to `ohmail/Screener`. Between 2026-08-04 and 2026-09-06 the world these measurements ran
 * in was an organizer's, so `view=imbox` matched nothing and a constant-cost guard was constant at
 * zero; the standalone door then began creating a consent-less reader and the same read became
 * real. Both arms are driven here so the flip cannot happen again unannounced.
 */
describe("a reader's mail stays in INBOX and an organizer's lands in ohmail/Screener", () => {
  const stranger = (): Buffer => Buffer.from([
    "Message-ID: <fixture-world@stranger.invalid>",
    "From: stranger@nowhere.invalid",
    "To: mila@lichtgrat.example",
    "Subject: we have not met",
    "Content-Type: text/plain; charset=utf-8",
    "", "Hello.",
  ].join("\r\n"));

  async function ingestAs(readerMode: boolean) {
    const { db, accountId, mailboxId, ctx } = await makeCtx();
    const repo = makeDrizzleRepo(db);
    const change: Change = { type: "create", locator: { folder: "INBOX", ref: "1:1" }, raw: stranger() };
    const plan = await planChange(change, { repo, accountId, mailboxId, routing: repo, readerMode });
    await repo.transaction((tx) => commitChange(plan, {
      repo: tx, routing: tx, accountId, mailboxId, storageCap: UNMETERED_STORAGE_CAP,
    }));
    const imbox = await new MessageService().list(ctx, { view: "imbox" });
    return { desired: plan.new?.desired, imbox: imbox.items.length };
  }

  it("the consent-less reader: adopted at INBOX, and that is what fills view=imbox", async () => {
    const out = await ingestAs(true);
    expect(out.desired, "a reader decided a destination instead of adopting the arrival folder").toBe("INBOX");
    expect(out.imbox, "the guards above are seeded in this world; an empty imbox makes them vacuous").toBe(1);
  });

  it("the consented organizer: filed to ohmail/Screener, and view=imbox is then empty", async () => {
    const out = await ingestAs(false);
    expect(out.desired, "an organizer left a first-contact sender in INBOX instead of the Screener").toBe("ohmail/Screener");
    expect(out.imbox, "this is the reading that made the cost guards constant at zero for five weeks").toBe(0);
  });
});

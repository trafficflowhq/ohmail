import { UNMETERED_STORAGE_CAP } from "@trafficflow/core/mail";
import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { messages, folderState, auditLog } from "@trafficflow/db";
import { runMigrations } from "@trafficflow/db/admin";
import type { NativeLocator } from "@trafficflow/core";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { runSyncCycle, reconcileMailbox } from "../src/sync.js";
import { byMessageId, makeHarness, rawClient, emlOf, uidInFolder, dbUrlFor } from "./_workerenv.js";
import { FIXTURE_LEASE } from "./_door.js";

const DB_URL = dbUrlFor(import.meta.url);

/**
 * ═══ AGAINST A REAL MAIL SERVER — one move it will not perform, three that it will ═════
 *
 * The Postgres guard (`reconcile-atomicity.pg.test.ts`) owns the rows and the transaction. It buys
 * its determinism with a fake adapter, so the refusal it isolates is one the test invented. This
 * file spends the other half of the argument: the refusal is raised by the REAL adapter against a
 * REAL server, from a mailbox state a real account can genuinely reach, and the mail that is not
 * poisoned genuinely lands in the destination folder — verified by asking the server, not the
 * database.
 *
 * ── THE POISON IS THE ADAPTER'S OWN SAFETY RULE, NOT AN INJECTED ERROR ─────────────────────
 *
 * `ImapAdapter.move` reads the destination before it writes, so it can never leave a second copy
 * behind. When the destination already holds MORE THAN ONE message it cannot tell apart from the
 * one being filed, it refuses with `MoveVerifyError` — before writing anything — because guessing
 * would mean either duplicating the user's mail or expunging the wrong copy.
 *
 * That refusal is permanent while the ambiguity is: every cycle asks, the server answers the same
 * way, and nothing about waiting changes it. Which is exactly the shape that used to punish the
 * whole mailbox — the folder pass retried it every cycle for ever, and, until this slice, one
 * refused `\Seen` in the pass behind it failed the entire cycle. Two duplicate copies in a
 * destination folder is not an exotic state: it is what an interrupted migration from another
 * client, or a rule that filed the same mail twice, leaves behind.
 *
 * ── WHAT ONLY THIS FILE CAN SAY ────────────────────────────────────────────────────────────
 *
 *  · the messages BEHIND the refusal are in the destination folder ON THE SERVER, and gone from
 *    their source — the physical outcome, which no repo assertion reaches;
 *  · the refused message is still where it was, with its copy intact. Isolation must not cost the
 *    user the mail it could not file;
 *  · the deferral survives into the next cycle against the real adapter: the refused locator is
 *    not asked about again, so the permanent ambiguity stops costing an IMAP round trip per cycle.
 */

const DEST = "ohmail/News";
const DEST_PATH = "ohmail.News";

describe("a move the server will not perform is isolated, deferred, and does not stop the rest", () => {
  beforeAll(async () => { await runMigrations(DB_URL); });
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const c of closers.splice(0)) await c(); });

  it("files everything behind the poison, leaves the poisoned copy untouched, and sleeps it", async () => {
    const h = await makeHarness();
    closers.push(() => h.adapter.close());
    const deps = { repo: h.repo, adapter: h.adapter, accountId: h.accountId, mailboxId: h.mailboxId, storageCap: UNMETERED_STORAGE_CAP, writeAuthority: FIXTURE_LEASE };

    const c = await rawClient(h.cfg);
    closers.push(async () => { await c.logout().catch(() => {}); });

    // Three ordinary messages, ingested the ordinary way.
    const ids = ["p0@x", "p1@x", "p2@x"];
    for (const id of ids) {
      await c.append("INBOX", emlOf({ from: "stranger@x.example", subject: `poison ${id}`, messageId: id }));
    }
    await runSyncCycle(deps);

    const rows = new Map<string, { id: string; folder: string }>();
    for (const id of ids) {
      const [m] = await h.db.select().from(messages).where(byMessageId(h.mailboxId, id));
      expect(m, `${id} was ingested`).toBeDefined();
      rows.set(id, { id: m!.id, folder: (m!.nativeLocator as NativeLocator).folder });
    }

    // ── THE AMBIGUITY. Two copies of p0, byte for byte, already sitting in the destination. The
    // adapter cannot tell which one it would be duplicating or expunging, so it refuses the move
    // outright rather than risk the user's mail.
    const twin = emlOf({ from: "stranger@x.example", subject: "poison p0@x", messageId: "p0@x" });
    await c.append(DEST_PATH, twin);
    await c.append(DEST_PATH, twin);
    expect((await uidInFolder(c, DEST_PATH, "p0@x")).length, "the destination is ambiguous").toBe(2);

    // What the API writes when a user files mail: intent only, no IMAP.
    for (const id of ids) {
      const r = rows.get(id)!;
      await h.repo.upsertFolderState(r.id, {
        desiredFolder: DEST, observedFolder: r.folder, lastSetBy: "us",
      });
    }

    // BEFORE THIS SLICE the refusal was retried every cycle for ever, and a refused `\Seen` in the
    // pass behind it rejected here and counted a mailbox failure.
    await expect(reconcileMailbox(deps as never)).resolves.toBeDefined();

    // ── THE MAIL BEHIND THE POISON REACHED THE SERVER ────────────────────────────────────────
    for (const id of ["p1@x", "p2@x"]) {
      expect((await uidInFolder(c, DEST_PATH, id)).length, `${id} is in the destination`).toBe(1);
      expect((await uidInFolder(c, "INBOX", id)).length, `${id} left the source`).toBe(0);
      const fs = await h.db.select().from(folderState).where(eq(folderState.messageId, rows.get(id)!.id));
      expect(fs[0]!.reconcileStatus).toBe("reconciled");
      expect(fs[0]!.observedFolder).toBe(DEST);
    }

    // ── THE POISONED MESSAGE STILL EXISTS, WHERE IT WAS ──────────────────────────────────────
    // Isolation may not cost the user the mail it could not file, and the two twins in the
    // destination are untouched: nothing was duplicated and nothing was expunged on a guess.
    expect((await uidInFolder(c, rows.get("p0@x")!.folder.replace("/", "."), "p0@x")).length).toBe(1);
    expect((await uidInFolder(c, DEST_PATH, "p0@x")).length).toBe(2);

    const poisoned = (await h.db.select().from(folderState)
      .where(eq(folderState.messageId, rows.get("p0@x")!.id)))[0]!;
    expect(poisoned.reconcileStatus, "still owed — the intent is not discarded").toBe("pending");
    expect(poisoned.desiredFolder, "and it is still the folder the user asked for").toBe(DEST);
    expect(poisoned.attempts).toBe(1);
    expect(poisoned.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    const failed = await h.db.select().from(auditLog)
      .where(and(eq(auditLog.accountId, h.accountId), eq(auditLog.action, "reconcile.move.failed")));
    expect(failed, "the refusal is on the record, with its count").toHaveLength(1);
    expect(failed[0]!.payload).toMatchObject({ messageId: rows.get("p0@x")!.id, to: DEST, attempts: 1 });

    // ── AND THE NEXT CYCLE DOES NOT ASK AGAIN ────────────────────────────────────────────────
    // The ambiguity is permanent until somebody removes a copy, so asking every cycle is a round
    // trip that can only ever get the same answer. The counting proxy wraps the REAL adapter, so
    // this counts calls that would have reached the real server.
    let asked = 0;
    const counting = new Proxy(h.adapter as unknown as MailboxAdapter, {
      get(t, p, r) {
        const v = Reflect.get(t, p, r);
        if ((p !== "move" && p !== "moveMany") || typeof v !== "function") {
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(t) : v;
        }
        return (...args: unknown[]) => { asked++; return (v as (...a: unknown[]) => unknown).apply(t, args); };
      },
    });

    await reconcileMailbox({ ...deps, adapter: counting } as never);
    expect(asked, "a sleeping row costs no IMAP round trip").toBe(0);
  }, 60_000);
});

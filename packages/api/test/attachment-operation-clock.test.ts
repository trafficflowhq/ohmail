import { accountOfMailbox } from "@trafficflow/db";
import { describe, it, expect, vi, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { ImapAdapter, IMAP_READ_DEADLINE_MS } from "@trafficflow/core/adapters/imap";
import { mailboxes, mailboxCredentials } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { makeOpenAdapter } from "../src/attachments-adapter.js";
import { IMAP_DOOR_DEADLINE_MS, IMAP_OPERATION_DEADLINE_MS } from "../src/imap-budget.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * ── THE ATTACHMENT DOOR'S CLOCK IS PER OPERATION ──────────────────────────────────────────
 *
 * Every other API dial of a customer's mail server runs under `withinDoorBudget` — one budget for
 * the dial and the read together, `forceClose` on a breach. This door could not use it and
 * therefore had no clock at all: it holds ONE adapter across a multi-part walk and closes it
 * itself, so a dial-and-read budget would end an honest download making steady progress, while a
 * walk of parts each just under it is a stall the budget never sees.
 *
 * The unit is one OPERATION. What that has to get right is three things, and each is a case here:
 * a hung fetch ends with the product's own "could not read" sentence; the SOCKET dies with it,
 * because a graceful close is a LOGOUT the driver queues behind the command that is hanging — the
 * teardown would wait in the same queue as the read we just abandoned, holding the mailbox's slot
 * in the shared cap; and an honest walk is untouched.
 *
 * The BUDGET is injected in the driving cases and the DEFAULT is asserted against the adapter's own
 * constant in its own case — so neither "the mechanism works" nor "it ships at the right number" is
 * taken on trust.
 */

/** A real (PGlite) database with one mailbox and its IMAP credential row. */
async function seed(): Promise<{ deps: ApiDeps; mailboxId: string }> {
  const db = await makeTestDb();
  const accountId = randomUUID();
  const [row] = await db.insert(mailboxes)
    .values({ accountId, provider: "imap", address: "a@example.invalid" })
    .returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: row!.id, accountId: accountOfMailbox(row!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "a@example.invalid" },
  });
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
  } as unknown as ApiDeps;
  return { deps, mailboxId: row!.id };
}

/**
 * A server that accepts the command and never answers — the shape no count ceiling sees and the
 * socket's own inactivity timer never fires on, because a reply that never starts is not idle in
 * any way the driver measures.
 */
function silentServer(): { closes: () => number; destroys: () => number } {
  let closes = 0;
  let destroys = 0;
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined as never);
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async () => { closes += 1; });
  vi.spyOn(ImapAdapter.prototype, "forceClose").mockImplementation(() => { destroys += 1; });
  vi.spyOn(ImapAdapter.prototype, "fetchPart")
    .mockImplementation(() => new Promise(() => { /* never answers */ }));
  return { closes: () => closes, destroys: () => destroys };
}

/** A server that answers at once — the positive control's half. */
function honestServer(): { closes: () => number } {
  let closes = 0;
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined as never);
  vi.spyOn(ImapAdapter.prototype, "close").mockImplementation(async () => { closes += 1; });
  vi.spyOn(ImapAdapter.prototype, "fetchPart").mockResolvedValue({
    contentType: "application/pdf", filename: "x.pdf", body: new Uint8Array([1]),
  });
  return { closes: () => closes };
}

const PART = { folder: "INBOX", ref: "1:1" };

afterEach(() => { vi.restoreAllMocks(); });

describe("the attachment door's per-operation clock", () => {
  it("ends a hung operation with the door's own refusal", async () => {
    silentServer();
    const { deps, mailboxId } = await seed();
    const open = makeOpenAdapter(deps, { operationBudgetMs: 40 });
    const adapter = await open(mailboxId);

    const err = await adapter.fetchPart(PART, "2", {}).catch((e: unknown) => e);

    // The product's one sentence for "our clock ran out", not a 500 and not a private class.
    expect((err as { code?: string })?.code).toBe("mailbox_read_timeout");
  });

  it("destroys the socket on the breach, so the slot is not held by a queued LOGOUT", async () => {
    const server = silentServer();
    const { deps, mailboxId } = await seed();
    const open = makeOpenAdapter(deps, { operationBudgetMs: 40 });
    const adapter = await open(mailboxId);

    await adapter.fetchPart(PART, "2", {}).catch(() => { /* the refusal is the other case */ });
    // DESTROYED, not closed: `close()` is a LOGOUT the driver queues behind the hung command, so
    // the teardown would wait exactly where the read we just abandoned is waiting.
    expect(server.destroys()).toBe(1);
    expect(server.closes()).toBe(0);

    // …and the caller's own close afterwards is a no-op rather than that same queued LOGOUT.
    await adapter.close();
    expect(server.closes()).toBe(0);
    expect(server.destroys()).toBe(1);
  });

  it("ends a hung tree read the same way: the door's refusal, and the socket destroyed", async () => {
    const server = silentServer();
    vi.spyOn(ImapAdapter.prototype, "fetchStructure").mockImplementation(() => new Promise(() => { /* never answers */ }));
    const { deps, mailboxId } = await seed();
    const adapter = await makeOpenAdapter(deps, { operationBudgetMs: 40 })(mailboxId);

    const err = await adapter.fetchStructure!(PART).catch((e: unknown) => e);

    expect((err as { code?: string })?.code).toBe("mailbox_read_timeout");
    expect([server.destroys(), server.closes()]).toEqual([1, 0]);
  });

  /**
   * THE POSITIVE CONTROL, and the reason the unit is per operation: a walk of several parts, each
   * answering inside the budget, is not ended by it however many parts there are.
   */
  it("leaves an honest multi-part walk alone", async () => {
    const server = honestServer();
    const { deps, mailboxId } = await seed();
    const open = makeOpenAdapter(deps, { operationBudgetMs: 500 });
    const adapter = await open(mailboxId);

    for (const partId of ["1", "2", "3", "4"]) {
      const got = await adapter.fetchPart(PART, partId, {});
      expect(got.filename).toBe("x.pdf");
    }
    await adapter.close();

    expect(server.closes()).toBe(1);
  });

  /**
   * THE NUMBER, checked where the mechanism cannot check it. The cases above drive an injected
   * budget so they finish in milliseconds; this is what says the shipping default is the adapter's
   * own read deadline and not a second literal answering the same question.
   */
  it("defaults to the adapter's own read deadline, and the dial budget stays shorter", () => {
    expect(IMAP_OPERATION_DEADLINE_MS).toBe(IMAP_READ_DEADLINE_MS);
    // The dial budget is chosen against a serverless invocation ceiling; the operation budget
    // against a download. Collapsing them is how one of the two stops meaning anything.
    expect(IMAP_DOOR_DEADLINE_MS).toBeLessThan(IMAP_OPERATION_DEADLINE_MS);
  });
});

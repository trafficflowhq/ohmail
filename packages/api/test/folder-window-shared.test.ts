import { accountOfMailbox } from "@trafficflow/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { ImapAdapter } from "@trafficflow/core/adapters/imap";
import { accountSettings, mailboxCredentials, mailboxes } from "@trafficflow/db";
import { acquireImapSlot, releaseImapSlot } from "@trafficflow/db/cloud";
import { makeTestDb } from "@trafficflow/db/testing";
import { listJunk, junkBody } from "../src/junk-window.js";
import { listServerTrash, serverTrashBody } from "../src/trash-window.js";
import type { ApiDeps } from "../src/deps.js";

/**
 * THE TWO LIVE WINDOWS ANSWER ONE RULE, AND THIS FILE READS IT THROUGH BOTH DOORS.
 *
 * Junk and Trash are the same mechanism over two folders: one cursor codec, one epoch shape, one
 * folders gate, one account-scoped mailbox read. Every case below drives the SAME fixture through
 * a Junk door and a Trash door and asserts the SAME answer — so a rule that moves in one window
 * and not the other is a red here rather than a divergence a reader finds later. The only thing
 * these doors are allowed to differ in is the NOUN in the sentence, which each case states.
 */

const NOW = new Date("2026-08-24T12:00:00.000Z");
const JUNK_PATH = "INBOX/Spamverdacht";
const TRASH_PATH = "INBOX/Trash";

interface Seeded {
  deps: ApiDeps;
  accountId: string;
  mailboxId: string;
}

async function seed(opts: { foldersOn?: boolean } = {}): Promise<Seeded> {
  const db = await makeTestDb();
  vi.restoreAllMocks();
  vi.spyOn(ImapAdapter.prototype, "connect").mockResolvedValue(undefined);
  vi.spyOn(ImapAdapter.prototype, "close").mockResolvedValue(undefined);
  const accountId = randomUUID();
  if (opts.foldersOn ?? true) {
    await db.insert(accountSettings).values({ accountId, foldersEnabledAt: NOW });
  }
  const [mb] = await db.insert(mailboxes).values({
    accountId, provider: "imap", address: `win-${randomUUID().slice(0, 8)}@example.invalid`,
    junkFolder: JUNK_PATH, trashFolder: TRASH_PATH,
  }).returning({ id: mailboxes.id });
  await db.insert(mailboxCredentials).values({
    mailboxId: mb!.id, accountId: accountOfMailbox(mb!.id), transport: "imap", secretEnc: "enc", keyVersion: 1,
    meta: { host: "imap.example.invalid", port: 993, secure: true, user: "u" },
  });
  const deps = {
    db,
    keyProvider: { decrypt: async () => "not-printed" },
    services: { imapAdmission: { acquire: acquireImapSlot, release: releaseImapSlot } },
    now: () => NOW,
  } as unknown as ApiDeps;
  return { deps, accountId, mailboxId: mb!.id };
}

/** The thrown refusal as a comparable tuple — code, status and message, nothing else. */
async function refusalOf(run: () => Promise<unknown>): Promise<[string, number, string]> {
  try {
    await run();
  } catch (err) {
    const e = err as { code?: string; httpStatus?: number; message?: string };
    return [e.code ?? "(no code)", e.httpStatus ?? 0, e.message ?? "(no message)"];
  }
  throw new Error("expected a refusal, got an answer");
}

beforeEach(() => vi.restoreAllMocks());

describe("the cursor codec, read through both list doors", () => {
  it("refuses a cursor over the wire ceiling with the same code and status", async () => {
    const { deps, accountId } = await seed();
    const tooLong = "a".repeat(128 * 1024 + 1);
    const junk = await refusalOf(() => listJunk(deps, accountId, { cursor: tooLong }));
    const trash = await refusalOf(() => listServerTrash(deps, accountId, { cursor: tooLong }));
    expect(junk.slice(0, 2)).toEqual(["validation_failed", 400]);
    expect(trash.slice(0, 2)).toEqual(junk.slice(0, 2));
    expect(junk[2]).toBe("cursor is not a junk-window cursor");
    expect(trash[2]).toBe("cursor is not a trash-window cursor");
  });

  it("refuses the same malformed cursors through both doors", async () => {
    const { deps, accountId } = await seed();
    const bad = [
      // A key that is not a mailbox uuid.
      { "not-a-uuid": { v: "7", s: 3 } },
      // An epoch outside the protocol's uint32.
      { [randomUUID()]: { v: "4294967296", s: 3 } },
      // A seq that is not a positive integer.
      { [randomUUID()]: { v: "7", s: 0 } },
      // Not an object at all.
      [1, 2, 3],
    ];
    for (const shape of bad) {
      const cursor = Buffer.from(JSON.stringify(shape), "utf8").toString("base64url");
      const junk = await refusalOf(() => listJunk(deps, accountId, { cursor }));
      const trash = await refusalOf(() => listServerTrash(deps, accountId, { cursor }));
      expect(junk.slice(0, 2)).toEqual(["validation_failed", 400]);
      expect(trash.slice(0, 2)).toEqual(junk.slice(0, 2));
    }
  });

  it("takes a well-formed cursor through both doors without refusing", async () => {
    const { deps, accountId, mailboxId } = await seed();
    const cursor = Buffer.from(
      JSON.stringify({ [mailboxId]: { v: "7", s: 5 } }), "utf8",
    ).toString("base64url");
    vi.spyOn(ImapAdapter.prototype, "listFolderPage").mockResolvedValue({
      uidValidity: "7", total: 0, items: [], nextBeforeSeq: null,
    });
    const junk = await listJunk(deps, accountId, { cursor });
    const trash = await listServerTrash(deps, accountId, { cursor });
    expect(junk.mailboxes.map((m) => m.window)).toEqual(["ok"]);
    expect(trash.mailboxes.map((m) => m.window)).toEqual(["ok"]);
  });
});

describe("the epoch shape, read through both body doors", () => {
  it("refuses the same epochs with the same sentence", async () => {
    const { deps, accountId, mailboxId } = await seed();
    for (const uidValidity of ["0", "-1", "1e9", "4294967296", "1".repeat(11), "abc", ""]) {
      const junk = await refusalOf(() => junkBody(deps, accountId, { mailboxId, uid: 1, uidValidity }));
      const trash = await refusalOf(() => serverTrashBody(deps, accountId, { mailboxId, uid: 1, uidValidity }));
      expect(junk[0]).toBe("validation_failed");
      // The whole tuple, message included: this refusal carries no window noun at all.
      expect(trash).toEqual(junk);
    }
  });

  it("refuses the same out-of-range uids through both doors", async () => {
    const { deps, accountId, mailboxId } = await seed();
    for (const uid of [0, -1, 1.5, 4_294_967_296]) {
      const junk = await refusalOf(() => junkBody(deps, accountId, { mailboxId, uid, uidValidity: "7" }));
      const trash = await refusalOf(() => serverTrashBody(deps, accountId, { mailboxId, uid, uidValidity: "7" }));
      expect(junk[0]).toBe("validation_failed");
      expect(trash).toEqual(junk);
    }
  });
});

describe("the account-scoped mailbox read, through both body doors", () => {
  it("refuses a malformed mailboxId identically, before any predicate reaches Postgres", async () => {
    const { deps, accountId } = await seed();
    const junk = await refusalOf(() => junkBody(deps, accountId, { mailboxId: "nope", uid: 1, uidValidity: "7" }));
    const trash = await refusalOf(() => serverTrashBody(deps, accountId, { mailboxId: "nope", uid: 1, uidValidity: "7" }));
    expect(junk[0]).toBe("validation_failed");
    expect(trash).toEqual(junk);
  });

  it("answers 404 for a mailbox this account does not own, through both doors", async () => {
    const { deps, accountId } = await seed();
    const foreign = randomUUID();
    const junk = await refusalOf(() => junkBody(deps, accountId, { mailboxId: foreign, uid: 1, uidValidity: "7" }));
    const trash = await refusalOf(() => serverTrashBody(deps, accountId, { mailboxId: foreign, uid: 1, uidValidity: "7" }));
    expect(junk).toEqual(["not_found", 404, "mailbox not found"]);
    expect(trash).toEqual(junk);
  });
});

describe("the folders gate, through every door", () => {
  it("refuses with the same code and status until “Use folders” is on", async () => {
    const { deps, accountId, mailboxId } = await seed({ foldersOn: false });
    const doors: Array<[string, () => Promise<unknown>]> = [
      ["listJunk", () => listJunk(deps, accountId)],
      ["listServerTrash", () => listServerTrash(deps, accountId)],
      ["junkBody", () => junkBody(deps, accountId, { mailboxId, uid: 1, uidValidity: "7" })],
      ["serverTrashBody", () => serverTrashBody(deps, accountId, { mailboxId, uid: 1, uidValidity: "7" })],
    ];
    for (const [, run] of doors) {
      const [code, status, message] = await refusalOf(run);
      expect([code, status]).toEqual(["folders_disabled", 409]);
      expect(message).toMatch(/is part of the folders feature — turn on “Use folders” first$/);
    }
  });
});

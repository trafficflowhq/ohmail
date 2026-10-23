import { describe, it, expect } from "vitest";
import { ImapAdapter, MoveRefusedError, isRefusedCommand, makeRef } from "../../src/adapters/imap.js";
import type { NativeLocator } from "../../src/adapters/imap-types.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * ── WHAT `moveMany` ANSWERS ONCE THE MAIL HAS MOVED ────────────────────────────────────────
 *
 * `batched: false` meant one thing to its callers — NOTHING WAS WRITTEN, file the group one at a
 * time — and three returns handed it back AFTER `UID MOVE` had already moved the mail: a server
 * reporting the move as a bare `true`, a `uidMap` naming fewer messages than were sent, and a
 * member missing from that map. The reconciler then re-filed mail that had moved, and the Junk
 * sweep counted landed work as gone.
 *
 * The answer is now three-valued, and these cases drive the two halves that cannot be produced
 * against a real server: GreenMail always answers a full COPYUID map. The fake is the seam — it
 * RECORDS the `UID MOVE` it performed, so every case below asserts the mail moved AND that the
 * result says so.
 */

const cfg = { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } };
const LOC = (folder: string, epoch: number, uid: number): NativeLocator =>
  ({ folder, ref: makeRef(epoch, uid) });

/** `moveAnswer` is the server's reply to `UID MOVE`, which is the whole subject of this file. */
function makeClient(moveAnswer: unknown, present: number[] = [2, 3]) {
  const writes: string[] = [];
  const client = {
    writes,
    usable: true,
    capabilities: new Map([["IDLE", true], ["UIDPLUS", true], ["MOVE", true]]),
    mailbox: false as unknown,
    async list() {
      return ["Junk", "INBOX"].map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(path: string) {
      client.mailbox = { path, exists: present.length, uidValidity: 9n };
      return { path, release() { /* nothing */ } };
    },
    async search() { return [] as number[]; },
    async fetchAll() { return present.map((uid) => ({ uid, envelope: { messageId: `<m${uid}@x>` } })); },
    async messageMove(uids: number[] | number, to: string) {
      writes.push(`messageMove ${JSON.stringify(uids)} → ${to}`);
      return moveAnswer;
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return client;
}

async function adapterOver(moveAnswer: unknown, present?: number[]) {
  const client = makeClient(moveAnswer, present);
  const adapter = new ImapAdapter(cfg, { client: client as never });
  await adapter.connect();
  return { adapter, client };
}

const chunk = [LOC("Junk", 9, 2), LOC("Junk", 9, 3)];

describe("moveMany — a move that landed is never reported as a refusal", () => {
  it("a server that answers `UID MOVE` with a bare `true` answers `moved_unmapped`", async () => {
    // RFC-legal and real: the mail is in the destination and the server named no UIDs for it.
    const { adapter, client } = await adapterOver(true);
    const res = await adapter.moveMany(chunk, "INBOX", FIXTURE_DOOR);

    expect(client.writes, "the mail moved — that is the whole point of this case")
      .toEqual(["messageMove [2,3] → INBOX"]);
    expect(res.outcome).toBe("moved_unmapped");
    expect(res.moved.size, "nothing may be recorded: the server named no destination uid").toBe(0);
  });

  it("a `uidMap` that names FEWER messages than were sent answers `moved_unmapped`", async () => {
    const { adapter, client } = await adapterOver({ uidValidity: 100n, uidMap: new Map([[2, 1002]]) });
    const res = await adapter.moveMany(chunk, "INBOX", FIXTURE_DOOR);

    expect(client.writes).toEqual(["messageMove [2,3] → INBOX"]);
    expect(res.outcome).toBe("moved_unmapped");
    expect(res.moved.size).toBe(0);
  });

  it("a map of the right SIZE with a member missing answers `moved_unmapped` too", async () => {
    // The size check and the per-member check are two conditions; a map that names a stranger
    // passes the first and must still not be read as an answer about our messages.
    const { adapter, client } = await adapterOver(
      { uidValidity: 100n, uidMap: new Map([[2, 1002], [99, 1099]]) },
    );
    const res = await adapter.moveMany(chunk, "INBOX", FIXTURE_DOOR);

    expect(client.writes).toEqual(["messageMove [2,3] → INBOX"]);
    expect(res.outcome).toBe("moved_unmapped");
  });

  it("POSITIVE CONTROL — a full COPYUID map still answers `batched`, with both destinations", async () => {
    const { adapter, client } = await adapterOver(
      { uidValidity: 100n, uidMap: new Map([[2, 1002], [3, 1003]]) },
    );
    const res = await adapter.moveMany(chunk, "INBOX", FIXTURE_DOOR);

    expect(client.writes).toEqual(["messageMove [2,3] → INBOX"]);
    expect(res.outcome).toBe("batched");
    expect([...res.moved.values()].map((l) => l.ref)).toEqual([makeRef(100, 1002), makeRef(100, 1003)]);
  });

  it("POSITIVE CONTROL — a refusal taken BEFORE the move still answers `declined`", async () => {
    // No `UID MOVE` was issued, so the group is genuinely owed to the per-message path.
    const { adapter, client } = await adapterOver(true);
    const res = await adapter.moveMany([LOC("Junk", 7, 2), LOC("Junk", 9, 3)], "INBOX", FIXTURE_DOOR);

    expect(client.writes).toEqual([]);
    expect(res.outcome).toBe("declined");
  });
});

/**
 * ── AND A REFUSED ONE IS NOT A MOVE ─────────────────────────────────────────────────────────
 *
 * imapflow 1.7.8 catches a tagged NO to `UID MOVE` (or `UID COPY`) and resolves `false`. Read as
 * "moved, unmapped", the batch recorded nothing and was sent again every pass for ever, and the
 * per-message path guessed at the destination. The source is re-probed instead: a letter still
 * there is a refusal; a letter gone moved after all.
 */
describe("a UID MOVE the server refused", () => {
  /** `afterMove` is what the source holds once the command has answered. */
  function refusingClient(answer: unknown, afterMove: number[] = [2, 3], caps: string[] = ["MOVE", "UIDPLUS"]) {
    const writes: string[] = [];
    let moved = false;
    const holds = () => (moved ? afterMove : [2, 3]);
    const client = {
      writes,
      usable: true,
      capabilities: new Map<string, boolean>([["IDLE", true], ...caps.map((c) => [c, true] as [string, boolean])]),
      mailbox: false as unknown,
      async list() {
        return ["Junk", "INBOX"].map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
      },
      async getMailboxLock(path: string) {
        client.mailbox = { path, exists: path === "Junk" ? holds().length : 0, uidValidity: 9n };
        return { path, release() { /* nothing */ } };
      },
      async search() { return [] as number[]; },
      async fetchAll() {
        if ((client.mailbox as { path: string }).path !== "Junk") return [];
        return holds().map((uid) => ({ uid, envelope: { messageId: `<m${uid}@x>` } }));
      },
      async fetchOne(range: string) {
        if ((client.mailbox as { path: string }).path !== "Junk") return false;
        const uid = Number(range);
        return holds().includes(uid) ? { uid, envelope: { messageId: `<m${uid}@x>` } } : false;
      },
      async messageMove(uids: number[] | number, to: string) {
        writes.push(`messageMove ${JSON.stringify(uids)} → ${to}`);
        moved = true;
        return answer;
      },
      async messageCopy(uids: number[] | number, to: string) {
        writes.push(`messageCopy ${JSON.stringify(uids)} → ${to}`);
        return answer;
      },
      async messageDelete(uids: number[] | number) {
        writes.push(`messageDelete ${JSON.stringify(uids)}`);
        return true;
      },
      async logout() { /* nothing */ },
      close() { /* nothing */ },
    };
    return client;
  }
  const over = async (client: ReturnType<typeof refusingClient>) => {
    const adapter = new ImapAdapter(cfg, { client: client as never });
    await adapter.connect();
    return adapter;
  };

  it("moveMany: `false` with every member still at its source answers `refused`, nothing recorded", async () => {
    const client = refusingClient(false);
    const res = await (await over(client)).moveMany(chunk, "INBOX", FIXTURE_DOOR);
    expect(client.writes).toEqual(["messageMove [2,3] → INBOX"]);
    expect(res).toEqual({ outcome: "refused", moved: new Map(), gone: [] });
  });

  it("moveMany: `false` with a member gone from its source answers `moved_unmapped`", async () => {
    const res = await (await over(refusingClient(false, [3]))).moveMany(chunk, "INBOX", FIXTURE_DOOR);
    expect(res.outcome).toBe("moved_unmapped");
  });

  it("move: `false` with the letter still there refuses as the server's NO, and nothing is expunged", async () => {
    const client = refusingClient(false);
    const err = await (await over(client)).move(LOC("Junk", 9, 2), "INBOX", FIXTURE_DOOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveRefusedError);
    expect(isRefusedCommand(err)).toBe(true);
    expect(client.writes).toEqual(["messageMove [2] → INBOX"]);
  });

  it("move: a refused COPY (no MOVE) refuses the same way and expunges nothing", async () => {
    const client = refusingClient(false, [2, 3], ["UIDPLUS"]);
    const err = await (await over(client)).move(LOC("Junk", 9, 2), "INBOX", FIXTURE_DOOR).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MoveRefusedError);
    expect(client.writes).toEqual(["messageCopy [2] → INBOX"]);
  });
});

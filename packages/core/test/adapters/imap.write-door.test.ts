import { describe, expect, it } from "vitest";
import {
  ImapAdapter, WriteDeclinedError, makeRef, type MailboxWriteKind, type NativeLocator,
  type WriteDoor, type WriteDoorAnswer,
} from "../../src/adapters/imap.js";

/**
 * ═══ THE WRITE DOOR, AT THE ADAPTER ══════════════════════════════════════════════════════════
 *
 * Every organizer write the adapter issues asks the door handed in, once, with nothing awaited
 * between the answer and the command; a write handed no door is refused. A COPY-then-DELETE pair
 * is one unit: asked before the COPY, and the DELETE follows without a second ask. The door costs
 * no command, so a batch's command sequence is the one it was before the door existed.
 */

const cfg = { host: "rig.invalid", port: 0, secure: false, auth: { user: "u", pass: "p" } };
const LOC = (uid: number, folder = "INBOX"): NativeLocator => ({ folder, ref: makeRef(42, uid) });

interface Rig { calls: string[]; onRead: (() => void) | null; onCopy: (() => void) | null; ours: Buffer | null }

function client(opts: { move: boolean; present: number[] }, rig: Rig) {
  const present = new Set(opts.present);
  let dst = 900;
  const read = (): void => { const h = rig.onRead; rig.onRead = null; h?.(); };
  const c = {
    usable: true,
    capabilities: new Map<string, boolean>([
      ["UIDPLUS", true], ...(opts.move ? [["MOVE", true] as [string, boolean]] : []),
    ]),
    mailbox: false as unknown,
    async list() {
      rig.calls.push("LIST");
      return ["INBOX", "ohmail/News"].map((path) => ({ path, name: path, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(path: string) {
      rig.calls.push(`SELECT ${path}`);
      c.mailbox = { path, exists: present.size, uidValidity: 42n };
      return { path, release() { /* nothing */ } };
    },
    async fetchAll(range: string) {
      rig.calls.push("FETCH"); read();
      return range.split(",").map(Number).filter((u) => present.has(u))
        .map((uid) => ({ uid, envelope: { messageId: `<m${uid}@rig>` } }));
    },
    async fetchOne(uid: string) {
      rig.calls.push("FETCH1"); read();
      const n = Number(uid);
      return present.has(n) ? { uid: n, envelope: { messageId: `<m${n}@rig>` }, source: rig.ours ?? undefined } : false;
    },
    async search() { rig.calls.push("SEARCH"); return rig.ours ? [77] : [] as number[]; },
    async download() {
      rig.calls.push("DOWNLOAD");
      const body = rig.ours!;
      return { meta: { expectedSize: body.length }, content: (async function* () { yield body; })() };
    },
    async messageMove(uids: number[] | string) {
      rig.calls.push("MOVE");
      const list = Array.isArray(uids) ? uids : [];
      for (const u of list) present.delete(u);
      return { uidValidity: 7n, uidMap: new Map(list.map((u) => [u, dst++])) };
    },
    async messageCopy(uids: number[]) {
      rig.calls.push("COPY");
      const h = rig.onCopy; rig.onCopy = null; h?.();
      return { uidValidity: 7n, uidMap: new Map(uids.map((u) => [u, dst++])) };
    },
    async messageDelete(uids: number[]) {
      rig.calls.push("EXPUNGE");
      for (const u of uids) present.delete(u);
      return true;
    },
    async messageFlagsAdd() { rig.calls.push("STORE+"); return true; },
    async messageFlagsRemove() { rig.calls.push("STORE-"); return true; },
    async mailboxCreate(path: string) { rig.calls.push(`CREATE ${path}`); return { path }; },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return c;
}

async function adapterOver(opts: { move: boolean; present: number[] }) {
  const rig: Rig = { calls: [], onRead: null, onCopy: null, ours: null };
  const adapter = new ImapAdapter(cfg, { client: client(opts, rig) as never });
  await adapter.connect();
  rig.calls.length = 0;
  return { adapter, rig };
}

/** A door that records every ask and answers from a switch the case flips. */
function doorOf(): WriteDoor & { asked: MailboxWriteKind[]; admit: boolean } {
  const d = {
    asked: [] as MailboxWriteKind[],
    admit: true,
    ask(write: MailboxWriteKind): WriteDoorAnswer {
      d.asked.push(write);
      return d.admit ? { admit: true } : { admit: false, reason: "claim_stale" };
    },
  };
  return d;
}

const declinedWith = async (p: Promise<unknown>): Promise<string> => {
  const err = await p.then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(WriteDeclinedError);
  return (err as WriteDeclinedError).reason;
};

describe("the adapter asks the write door at the command", () => {
  it("a batch handed no door is refused, and nothing is written", async () => {
    const { adapter, rig } = await adapterOver({ move: true, present: [1, 2] });
    const call = (adapter.moveMany as (...a: unknown[]) => Promise<unknown>).bind(adapter);
    expect(await declinedWith(call([LOC(1), LOC(2)], "ohmail/News"))).toBe("no_door");
    expect(rig.calls).not.toContain("MOVE");
  });

  it("a door that stops admitting during the preflight: the batch sends no MOVE", async () => {
    const { adapter, rig } = await adapterOver({ move: true, present: [1, 2] });
    const door = doorOf();
    rig.onRead = () => { door.admit = false; };
    expect(await declinedWith(adapter.moveMany([LOC(1), LOC(2)], "ohmail/News", door))).toBe("claim_stale");
    expect(rig.calls).not.toContain("MOVE");
    expect(door.asked, "asked once, after the preflight").toEqual(["move"]);
  });

  it("POSITIVE CONTROL — an admitting door: one ask, and the batch's commands are unchanged", async () => {
    const { adapter, rig } = await adapterOver({ move: true, present: [1, 2] });
    const door = doorOf();
    const res = await adapter.moveMany([LOC(1), LOC(2)], "ohmail/News", door);
    expect(res.outcome).toBe("batched");
    expect(door.asked).toEqual(["move"]);
    expect(rig.calls).toEqual(["SELECT INBOX", "FETCH", "SELECT ohmail/News", "SEARCH", "SELECT INBOX", "MOVE"]);
  });

  it("a COPY-then-DELETE pair asks once, and a door that turns after the COPY still finishes the pair", async () => {
    const { adapter, rig } = await adapterOver({ move: false, present: [1] });
    const door = doorOf();
    // From the moment the COPY lands this door refuses everything; the DELETE must still go.
    rig.onCopy = () => { door.admit = false; };
    await adapter.move(LOC(1), "ohmail/News", door);
    expect(door.asked).toEqual(["move"]);
    expect(rig.calls.filter((c) => c === "COPY" || c === "EXPUNGE")).toEqual(["COPY", "EXPUNGE"]);
  });

  it("a lone DELETE finishing an earlier call's COPY asks the door, and a refusal leaves both copies", async () => {
    const { adapter, rig } = await adapterOver({ move: false, present: [1] });
    // The destination already holds our copy (a crash between the COPY and the DELETE).
    rig.ours = Buffer.from("Message-ID: <m1@rig>\r\nSubject: s\r\n\r\nbody\r\n");
    const door = doorOf();
    door.admit = false;
    expect(await declinedWith(adapter.move(LOC(1), "ohmail/News", door))).toBe("claim_stale");
    expect(door.asked).toEqual(["expunge"]);
    expect(rig.calls).not.toContain("EXPUNGE");
    expect(rig.calls).not.toContain("COPY");
  });

  it("a `\\Seen` STORE asks the door; refused, nothing is stored", async () => {
    const { adapter, rig } = await adapterOver({ move: true, present: [3] });
    const door = doorOf();
    door.admit = false;
    expect(await declinedWith(adapter.setFlags(LOC(3), { seen: true }, door))).toBe("claim_stale");
    expect(door.asked).toEqual(["seen"]);
    expect(rig.calls.some((c) => c.startsWith("STORE"))).toBe(false);
    door.admit = true;
    await adapter.setFlags(LOC(3), { seen: true }, door);
    expect(rig.calls).toContain("STORE+");
  });

  it("every folder CREATE of the organizer's tree asks; refused, none is created", async () => {
    const { adapter, rig } = await adapterOver({ move: true, present: [] });
    const door = doorOf();
    door.admit = false;
    await declinedWith(adapter.ensureFolders(door));
    expect(rig.calls.some((c) => c.startsWith("CREATE"))).toBe(false);
    door.admit = true;
    door.asked.length = 0;
    await adapter.ensureFolders(door);
    const creates = rig.calls.filter((c) => c.startsWith("CREATE"));
    expect(creates.length).toBeGreaterThan(0);
    expect(door.asked).toEqual(creates.map(() => "folder_create"));
  });

  it("re-making one of ohmail's folders asks once; refused, nothing is created", async () => {
    const { adapter, rig } = await adapterOver({ move: true, present: [] });
    const door = doorOf();
    door.admit = false;
    await declinedWith(adapter.ensureOwnFolder("ohmail/Screened", door));
    expect(rig.calls.some((c) => c.startsWith("CREATE"))).toBe(false);
    door.admit = true;
    door.asked.length = 0;
    expect(await adapter.ensureOwnFolder("ohmail/Screened", door)).toBe("made");
    expect(rig.calls.filter((c) => c.startsWith("CREATE"))).toEqual(["CREATE ohmail/Screened"]);
    expect(door.asked).toEqual(["folder_create"]);
  });
});


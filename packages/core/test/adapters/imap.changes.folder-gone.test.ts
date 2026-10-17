import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { ImapAdapter, statesMailboxNonexistent } from "../../src/adapters/imap.js";
import {
  WATCHED_FOLDERS, PASSIVE_FOLDERS_MAX_NO_STATUS, type ImapCursor,
} from "../../src/adapters/imap-types.js";
import { ImapBoundExceeded } from "../../src/adapters/imap-bounds.js";

/**
 * A FOLDER DELETED ELSEWHERE, AND A RESET'S LETTER DELETED MEANWHILE, THROUGH `changesSince`.
 *
 * A remembered folder an answered LIST leaves out is asked by name, and its letters go only on the
 * server's own statement that it does not exist. STATUS here is imapflow's own command module over
 * a tagged NO parsed from a wire line, so the double fails the way the driver does; the two NO
 * texts are the ones Dovecot and GreenMail were measured sending.
 */

const require = createRequire(import.meta.url);
const statusCommand = require("imapflow/lib/commands/status.js") as
  (conn: unknown, path: string, query: unknown) => Promise<unknown>;
const { parser } = require("imapflow/lib/handler/imap-handler.js") as {
  parser: (b: Buffer) => Promise<{ command: string }>;
};

const DOVECOT_NO = "A" + "1 NO Mailbox doesn't exist: Projects (0.001 + 0.000 secs).";
const GREENMAIL_NO = "A" + "1 NO STATUS failed. No such mailbox";

interface Mail { uid: number; id: string }
interface FakeFolder {
  uidValidity: bigint; uidNext: number; modseq: bigint; mails: Mail[];
  flags?: string[];
}
const folder = (mails: Mail[], uidValidity = 100n): FakeFolder => ({
  uidValidity, uidNext: Math.max(0, ...mails.map((m) => m.uid)) + 1, modseq: 60n, mails,
});
const mails = (prefix: string, n: number): Mail[] =>
  Array.from({ length: n }, (_, i) => ({ uid: i + 1, id: `${prefix}-${i + 1}@x` }));

type StatusAnswer = { no: string; listedByName?: boolean } | "hang";

/** The server's folders are `folders`; `listOmits` hides some from LIST; `status` overrides STATUS. */
function makeClient(folders: Record<string, FakeFolder>, opts: {
  listOmits?: string[]; status?: StatusAnswer; withholdHeaderUid?: number; onHang?: () => void;
} = {}) {
  const asked: string[] = [];
  const client = {
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true]]),
    mailbox: {} as { path: string; uidValidity: bigint; uidNext: number; highestModseq: bigint; exists: number },
    asked,
    _path: "INBOX",
    async list() {
      return Object.entries(folders).filter(([p]) => !(opts.listOmits ?? []).includes(p)).map(([path, f]) => ({
        path, name: path.split("/").pop()!, delimiter: "/", flags: new Set(f.flags ?? []),
      }));
    },
    async status(path: string, query: unknown) {
      asked.push(path);
      if (opts.status === "hang") { opts.onHang?.(); return new Promise(() => undefined); }
      const f = folders[path];
      const answer = opts.status ?? (f ? null : { no: DOVECOT_NO });
      if (answer === null) return { path, messages: f!.mails.length };
      const conn = {
        states: { AUTHENTICATED: 2, SELECTED: 3 }, state: 2, capabilities: new Map(), enabled: new Set(),
        namespace: { delimiter: "/", prefix: "" }, mailbox: false, log: { warn() { /* quiet */ } },
        async exec() {
          const err = Object.assign(new Error("Command failed"), { response: await parser(Buffer.from(answer.no)) });
          throw Object.assign(err, { responseStatus: (err.response as { command: string }).command.toUpperCase() });
        },
        async run() { return answer.listedByName ? [{ path }] : []; },
      };
      return statusCommand(conn, path, query);
    },
    async getMailboxLock(path: string) {
      const f = folders[path];
      if (!f) throw new Error(`no such mailbox ${path}`);
      this._path = path;
      this.mailbox = { path, uidValidity: f.uidValidity, uidNext: f.uidNext, highestModseq: f.modseq, exists: f.mails.length };
      return { path, release() { /* no lock in the fake */ } };
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async *fetch(range: any, query: any, options: any) {
      const f = folders[this._path]!;
      const byUid = (uids: number[]) => f.mails.filter((m) => uids.includes(m.uid));
      if (options?.changedSince !== undefined) return;
      if (query?.headers) {
        for (const m of f.mails) {
          if (m.uid === opts.withholdHeaderUid) continue;
          yield { uid: m.uid, headers: Buffer.from(`Message-ID: <${m.id}>\r\n\r\n`) };
        }
        return;
      }
      if (query?.source) {
        for (const m of byUid(Array.isArray(range) ? range : [])) {
          const source = Buffer.from(`Message-ID: <${m.id}>\r\nFrom: a@example.com\r\nSubject: s\r\n\r\nbody`);
          yield {
            uid: m.uid, flags: new Set<string>(), envelope: { messageId: `<${m.id}>` }, source,
            internalDate: new Date("2026-09-01T10:00:00Z"), size: source.length,
          };
        }
        return;
      }
      if (query?.size) { for (const m of byUid(Array.isArray(range) ? range : [])) yield { uid: m.uid, size: 80 }; return; }
      if (query?.internalDate || query?.envelope) {
        for (const m of byUid(Array.isArray(range) ? range : [])) {
          yield { uid: m.uid, internalDate: new Date("2026-09-01T10:00:00Z"), envelope: { date: new Date("2026-09-01T10:00:00Z") } };
        }
        return;
      }
      // `N:*` by sequence (Sent's newest window), or by UID when the driver is told so.
      const from = Number(String(range).split(":")[0]) || 1;
      for (const [i, m] of f.mails.entries()) if ((options?.uid ? m.uid : i + 1) >= from) yield { uid: m.uid };
    },
  };
  return client;
}

/** What the store remembers: each named folder at its epoch, every letter known. */
function cursorOf(remembered: Record<string, FakeFolder>): ImapCursor {
  const cursor: ImapCursor = { folders: {} };
  for (const [name, f] of Object.entries(remembered)) {
    cursor.folders[name] = {
      uidValidity: String(f.uidValidity), uidNext: f.uidNext, highestModseq: String(f.modseq),
      known: f.mails.map((m) => ({ uid: m.uid, messageId: m.id, seen: true })),
    };
  }
  return cursor;
}

const watched = (): Record<string, FakeFolder> =>
  Object.fromEntries(WATCHED_FOLDERS.map((f) => [f, folder([])]));

async function pass(client: unknown, cursor: ImapCursor, over: { maxBatchMessages?: number; nowMs?: () => number } = {}) {
  const adapter = new ImapAdapter({ host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } }, { client, ...over });
  await adapter.connect();
  return adapter.changesSince(cursor);
}

const refsIn = (changes: ReadonlyArray<{ locator: { folder: string; ref: string } }>, folderName: string) =>
  changes.filter((c) => c.locator.folder === folderName).map((c) => c.locator.ref).sort();

describe("statesMailboxNonexistent — the server's own words, read from imapflow's error", () => {
  const answer = async (no: string, listedByName = false) => {
    const client = makeClient({}, { status: { no, listedByName } });
    return client.status("Projects", { messages: true }).then(() => false, (e: unknown) => statesMailboxNonexistent(e));
  };
  it("reads the RFC 5530 code, and the two measured texts that carry none", async () => {
    expect(await answer("A" + "1 NO [NONEXISTENT] Unknown Mailbox: Projects (Failure)")).toBe(true);
    expect(await answer(DOVECOT_NO)).toBe(true);
    expect(await answer(GREENMAIL_NO)).toBe(true);
  });
  it("refuses any other code, any other text, and a NO while LIST still names the folder", async () => {
    expect(await answer("A" + "1 NO [NOPERM] Mailbox doesn't exist: Projects")).toBe(false);
    expect(await answer("A" + "1 NO [UNAVAILABLE] Mailbox doesn't exist: Projects")).toBe(false);
    expect(await answer("A" + "1 NO Permission denied")).toBe(false);
    expect(await answer(DOVECOT_NO, true)).toBe(false);
    expect(await answer("A" + "1 BAD Mailbox doesn't exist: Projects")).toBe(false);
    expect(statesMailboxNonexistent(new TypeError("status is not a function"))).toBe(false);
    // The same NO carried by anything but imapflow's NotFound (whose LIST of that name answered
    // empty) is not the statement.
    const inner = Object.assign(new Error("Command failed"), { responseStatus: "NO", response: await parser(Buffer.from(DOVECOT_NO)) });
    expect(statesMailboxNonexistent(Object.assign(new Error("Mailbox doesn't exist: Projects"), { code: "NotFound", response: inner }))).toBe(true);
    expect(statesMailboxNonexistent(Object.assign(new Error("Connection not available"), { code: "NoConnection", response: inner }))).toBe(false);
    expect(statesMailboxNonexistent(null)).toBe(false);
  });
});

describe("changesSince — a remembered folder the LIST no longer names", () => {
  const projects = folder(mails("p", 3), 777n);

  it("the server says it does not exist: each letter is a delete at the remembered epoch", async () => {
    const client = makeClient(watched());
    const batch = await pass(client, cursorOf({ ...watched(), Projects: projects }));
    expect(client.asked).toEqual(["Projects"]);
    expect(batch.foldersGone).toEqual(["Projects"]);
    expect(refsIn(batch.deletes, "Projects")).toEqual(["777:1", "777:2", "777:3"]);
    // Carried at its epoch, so the cycle's epoch guard believes the deletes.
    expect(batch.newCursor.folders.Projects?.uidValidity).toBe("777");
  });

  it("GreenMail's wording licenses it too; a NO for another cause keeps every letter", async () => {
    for (const [no, gone] of [[GREENMAIL_NO, true], ["A" + "1 NO [NOPERM] Permission denied", false], ["A" + "1 NO Try again later", false]] as const) {
      const batch = await pass(makeClient(watched(), { status: { no } }), cursorOf({ ...watched(), Projects: projects }));
      expect(batch.foldersGone ?? [], no).toEqual(gone ? ["Projects"] : []);
      expect(refsIn(batch.deletes, "Projects").length, no).toBe(gone ? 3 : 0);
    }
  });

  it("a LIST that omits a folder STATUS then finds keeps its letters", async () => {
    const client = makeClient({ ...watched(), Projects: projects }, { listOmits: ["Projects"] });
    const batch = await pass(client, cursorOf({ ...watched(), Projects: projects }));
    expect(client.asked).toEqual(["Projects"]);
    expect(batch.foldersGone).toBeUndefined();
    expect(refsIn(batch.deletes, "Projects")).toEqual([]);
  });

  it("a STATUS that never answers fails the pass on its clock, and nothing is reported gone", async () => {
    let now = 1_000_000;
    const client = makeClient(watched(), { status: "hang", onHang: () => { now += 10 * 60_000; } });
    const run = pass(client, cursorOf({ ...watched(), Projects: projects }), { nowMs: () => now });
    await expect(run).rejects.toBeInstanceOf(ImapBoundExceeded);
    expect(client.asked).toEqual(["Projects"]);
  });

  it("a folder the rule excludes, or the ceiling passes over, is LISTED and never asked", async () => {
    // `Projects` is still listed, as a node that cannot be selected: the exclusion rule's class.
    const excluded = makeClient({ ...watched(), Projects: { ...folder([]), flags: ["\\Noselect"] } });
    const a = await pass(excluded, cursorOf({ ...watched(), Projects: projects }));
    expect(excluded.asked).toEqual([]);
    expect(a.foldersGone).toBeUndefined();
    // No LIST-STATUS: the ceiling is 32, and `zz-remembered` sorts past it.
    const own: Record<string, FakeFolder> = {};
    for (let i = 0; i < PASSIVE_FOLDERS_MAX_NO_STATUS; i++) own[`f${String(i).padStart(2, "0")}`] = folder([]);
    const over = makeClient({ ...watched(), ...own, "zz-remembered": folder([]) });
    const b = await pass(over, cursorOf({ ...watched(), "zz-remembered": projects }));
    expect(over.asked).toEqual([]);
    expect(b.foldersGone).toBeUndefined();
  });

  it("a Sent-shaped folder is never asked", async () => {
    const client = makeClient(watched());
    const batch = await pass(client, cursorOf({ ...watched(), "Sent Items": projects }));
    expect(client.asked).toEqual([]);
    expect(batch.foldersGone).toBeUndefined();
  });

  it("an EMPTY remembered folder is asked too, and goes with no delete, epoch or none", async () => {
    // The finding: a folder with no letters was never asked, so it stayed in every folder list.
    const client = makeClient(watched());
    const cursor = cursorOf({ ...watched(), Empty: folder([]) });
    cursor.folders.Unopened = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
    const batch = await pass(client, cursor);
    expect(client.asked.sort()).toEqual(["Empty", "Unopened"]);
    expect(batch.foldersGone?.slice().sort()).toEqual(["Empty", "Unopened"]);
    expect(refsIn(batch.deletes, "Empty")).toEqual([]);
    // Letters still need their epoch: a folder holding some under none is not asked.
    const blind = makeClient(watched());
    const held = cursorOf({ ...watched() });
    held.folders.Blind = { uidValidity: "0", uidNext: 4, highestModseq: "0", known: [{ uid: 1, messageId: "b@x", seen: true }] };
    expect((await pass(blind, held)).foldersGone).toBeUndefined();
    expect(blind.asked).toEqual([]);
  });

  it("a LIST refresh that errors retires nothing; the same refresh answered does", async () => {
    // LIST-STATUS: the pass refreshes the inventory every time. `connect()`'s own LIST already
    // left the folder out, so only the failed refresh stands between it and a retirement.
    const withStatus = (failRefresh: boolean) => {
      const c = makeClient(watched());
      c.capabilities.set("LIST-STATUS", true);
      const list = c.list.bind(c);
      // Only the refresh carries the STATUS query; `connect()` and the Sent lookup do not.
      c.list = async (opts?: { statusQuery?: unknown }) => {
        if (failRefresh && opts?.statusQuery) throw new Error("LIST failed: the server dropped the command");
        return list();
      };
      return c;
    };
    const failed = withStatus(true);
    const a = await pass(failed, cursorOf({ ...watched(), Empty: folder([]), Projects: projects }));
    expect(failed.asked, "a pass whose LIST errored asked about an absence").toEqual([]);
    expect(a.foldersGone).toBeUndefined();
    expect(refsIn(a.deletes, "Projects")).toEqual([]);
    const answered = withStatus(false);
    const b = await pass(answered, cursorOf({ ...watched(), Empty: folder([]), Projects: projects }));
    expect(b.foldersGone?.slice().sort()).toEqual(["Empty", "Projects"]);
  });

  it("renamed elsewhere: the new folder's letters pair as moves in the same pass", async () => {
    const renamed = folder(mails("p", 3), 901n);
    const batch = await pass(makeClient({ ...watched(), Work: renamed }), cursorOf({ ...watched(), Projects: projects }));
    expect(batch.foldersGone).toEqual(["Projects"]);
    expect(refsIn(batch.moves, "Work")).toEqual(["901:1", "901:2", "901:3"]);
    expect(refsIn(batch.deletes, "Projects")).toEqual([]);
    expect(batch.creates.filter((c) => c.locator.folder === "Work")).toEqual([]);
  });

  it("renamed past the ceiling: its letters are not read as deleted while a listed folder goes unread", async () => {
    // FOLDER-RENAMED-PAST-THE-PASS-LIMIT-READS-AS-DELETED. No LIST-STATUS, so the cap is 32 and
    // `zz-renamed` (where the letters now are) sorts past it: the pass never meets its creates.
    const own: Record<string, FakeFolder> = {};
    for (let i = 0; i < PASSIVE_FOLDERS_MAX_NO_STATUS; i++) own[`f${String(i).padStart(2, "0")}`] = folder([]);
    const server = { ...watched(), ...own, "zz-renamed": folder(mails("p", 3), 901n) };
    const client = makeClient(server);
    const batch = await pass(client, cursorOf({ ...watched(), Projects: projects, Empty: folder([]) }));
    expect(refsIn(batch.deletes, "Projects"), "letters read as deleted past the ceiling").toEqual([]);
    expect(batch.foldersGone ?? []).not.toContain("Projects");
    expect(client.asked).not.toContain("Projects");
    // An empty folder loses nothing and still leaves the list.
    expect(batch.foldersGone).toEqual(["Empty"]);
    // Once nothing listed goes unread, the same absence is believed again.
    const fewer = makeClient({ ...watched(), "zz-renamed": folder(mails("p", 3), 901n) });
    const next = await pass(fewer, cursorOf({ ...watched(), Projects: projects }));
    expect(next.foldersGone).toEqual(["Projects"]);
  });

  it("not asked while creates are owed, so a big rename cannot read as a delete", async () => {
    const renamed = folder(mails("p", 3), 901n);
    const client = makeClient({ ...watched(), Work: renamed });
    const batch = await pass(client, cursorOf({ ...watched(), Projects: projects }), { maxBatchMessages: 2 });
    expect(batch.hasBacklog).toBe(true);
    expect(client.asked).toEqual([]);
    expect(refsIn(batch.deletes, "Projects")).toEqual([]);
  });
});

describe("changesSince — a UIDVALIDITY reset with a letter deleted meanwhile", () => {
  const before = folder([{ uid: 1, id: "a@x" }, { uid: 2, id: "b@x" }, { uid: 3, id: "c@x" }], 100n);
  const after = folder([{ uid: 1, id: "a@x" }, { uid: 2, id: "b@x" }], 200n);

  it("a remembered Message-ID the whole re-read does not hold is proved gone at its old epoch", async () => {
    const batch = await pass(makeClient({ ...watched(), INBOX: after }), cursorOf({ ...watched(), INBOX: before }));
    expect(refsIn(batch.resetGone ?? [], "INBOX")).toEqual(["100:3"]);
    expect(refsIn(batch.moves, "INBOX")).toEqual(["200:1", "200:2"]);
    expect(refsIn(batch.deletes, "INBOX")).toEqual([]);
  });

  it("a re-read that does not answer for every UID proves nothing", async () => {
    const batch = await pass(makeClient({ ...watched(), INBOX: after }, { withholdHeaderUid: 2 }), cursorOf({ ...watched(), INBOX: before }));
    expect(batch.resetGone).toBeUndefined();
  });

  it("Sent's reset reads its window, and the proof still reads the whole folder", async () => {
    const sentBefore = folder([{ uid: 1, id: "a@x" }, { uid: 2, id: "b@x" }, { uid: 3, id: "c@x" }], 100n);
    const sentAfter = folder([{ uid: 1, id: "a@x" }, { uid: 2, id: "b@x" }], 200n);
    const adapter = new ImapAdapter(
      { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
      { client: makeClient({ ...watched(), Sent: sentAfter }), sentHistoryMessages: 1 },
    );
    await adapter.connect();
    const batch = await adapter.changesSince(cursorOf({ ...watched(), Sent: sentBefore }));
    // `a@x` is older than the window and still held: its reset delete stays silence.
    expect(refsIn(batch.resetGone ?? [], "Sent")).toEqual(["100:3"]);
    expect(refsIn(batch.moves, "Sent")).toEqual(["200:2"]);
  });

  it("presence errs wide: a remembered Message-ID spelled in another case is still held", async () => {
    const upper = folder([{ uid: 1, id: "A@X" }, { uid: 2, id: "b@x" }, { uid: 3, id: "c@x" }], 100n);
    const batch = await pass(makeClient({ ...watched(), INBOX: after }), cursorOf({ ...watched(), INBOX: upper }));
    expect(refsIn(batch.resetGone ?? [], "INBOX")).toEqual(["100:3"]);
  });

  it("a letter filed elsewhere meanwhile is a move, not a delete", async () => {
    const batch = await pass(
      makeClient({ ...watched(), INBOX: after, Projects: folder([{ uid: 9, id: "c@x" }], 5n) }),
      cursorOf({ ...watched(), INBOX: before }),
    );
    expect(batch.resetGone).toBeUndefined();
    expect(refsIn(batch.moves, "Projects")).toEqual(["5:9"]);
  });
});

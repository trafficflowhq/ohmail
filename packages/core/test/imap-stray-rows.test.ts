import { describe, expect, it } from "vitest";
import { ImapAdapter, makeRef, parseRef } from "../src/adapters/imap.js";
import { WATCHED_FOLDERS, type ImapCursor } from "../src/adapters/imap-types.js";
import type { Change } from "../src/mail.js";
import { FIXTURE_DOOR } from "./adapters/_door.js";

/**
 * A FETCH ANSWERS ONLY FOR WHAT IT ASKED (IMAP-STREAMING-FETCH-TAKES-UNSOLICITED-FLAGS).
 *
 * imapflow's `fetch()` yields every untagged FETCH its command receives, and a server sends the flag
 * changes another session made while the command runs (RFC 3501 §5.2): `* 4 FETCH (UID 9 FLAGS
 * (\Seen))`. Read as an answer, that row became a create with an empty source and no Message-ID, the
 * blank took the letter's place, and the real letter was never imported and was moved out of INBOX.
 *
 * This fake server answers each command with the rows asked for and, per case, flags-only rows
 * ("strays") ahead of or behind them, for an asked UID or another one, a duplicate reply, or a
 * withheld one. Every site of the adapter that reads a FETCH stream is driven here; the same race
 * on GreenMail and Dovecot is `adapters/imap.sync-flag-race.test.ts`.
 */

type Row = Record<string, unknown>;
type Kind = "enumerate" | "size" | "date" | "body" | "headers" | "envelope" | "page" | "flags" | "heads";
interface Command { kind: Kind; asked: number[]; query: Record<string, unknown>; byUid: boolean }

interface Letter {
  uid: number;
  id: string;
  date: Date;
  /** RFC822.SIZE as the server states it; `null`: it states none. */
  size: number | null;
  source: Buffer;
  /** The header-field answer, when not the Message-ID line (GreenMail answers a missing field empty). */
  headerAnswer?: Buffer;
}
interface Box { uidValidity: bigint; letters: Letter[] }

interface Script {
  strays?: (c: Command) => { before?: Row[]; after?: Row[] } | undefined;
  withhold?: (c: Command, uid: number) => boolean;
  duplicate?: (c: Command) => boolean;
  search?: (path: string, query: unknown) => number[];
}

const sourceOf = (uid: number, id: string): Buffer => Buffer.from([
  `Message-ID: <${id}>`, `From: Anna <anna${uid}@x.example>`, "To: mila@lichtgrat.example", `Subject: letter ${uid}`,
  "Content-Type: text/plain; charset=utf-8", "", `body of letter ${uid}`, "",
].join("\r\n"));

function letter(uid: number, over: Partial<Letter> = {}): Letter {
  const id = over.id ?? `letter-${uid}@x.example`;
  const source = over.source ?? sourceOf(uid, id);
  return { uid, id, date: new Date(Date.UTC(2026, 0, uid)), size: source.length, source, ...over };
}

/** Another session's flag change: UID, FLAGS and MODSEQ, nothing asked for. */
const stray = (uid?: number, seq = 1): Row => ({
  seq, ...(uid === undefined ? {} : { uid }), flags: new Set(["\\Seen"]), modseq: 99n,
});

function kindOf(q: Record<string, unknown>): Kind {
  if (q.source) return "body";
  if (q.bodyParts) return "heads";
  if (q.headers) return "headers";
  if (q.size) return "size";
  if (q.envelope && q.flags) return "page";
  if (q.envelope && q.internalDate) return "date";
  if (q.envelope) return "envelope";
  if (q.flags) return "flags";
  return "enumerate";
}

/** The letters a range names, each once, in the folder's order. */
function named(box: Box, range: unknown, byUid: boolean): Letter[] {
  const top = byUid ? Math.max(0, ...box.letters.map((l) => l.uid)) : box.letters.length;
  const nums = new Set<number>();
  const parts = Array.isArray(range) ? range.map(String) : String(range).split(",");
  for (const p of parts) {
    const [a, b] = p.split(":");
    const lo = a === "*" ? top : Number(a);
    const hi = b === undefined ? lo : b === "*" ? top : Number(b);
    for (let n = Math.min(lo, hi); n <= Math.max(lo, hi); n++) nums.add(n);
  }
  return byUid ? box.letters.filter((l) => nums.has(l.uid)) : box.letters.filter((_, i) => nums.has(i + 1));
}

function rowFor(kind: Kind, l: Letter, seq: number, q: Record<string, unknown>): Row {
  const envelope = { messageId: `<${l.id}>`, date: l.date, subject: `letter ${l.uid}`, from: [{ name: "Anna", address: `anna${l.uid}@x.example` }] };
  switch (kind) {
    case "enumerate": return { seq, uid: l.uid };
    case "size": return { seq, uid: l.uid, ...(l.size === null ? {} : { size: l.size }) };
    case "date": return { seq, uid: l.uid, internalDate: l.date, envelope: { date: l.date, messageId: `<${l.id}>` } };
    case "body": return {
      seq, uid: l.uid, flags: new Set<string>(), source: l.source, internalDate: l.date,
      ...(q.envelope ? { envelope } : {}),
    };
    case "headers": return { seq, uid: l.uid, headers: l.headerAnswer ?? Buffer.from(`Message-ID: <${l.id}>\r\n\r\n`) };
    case "envelope": return { seq, uid: l.uid, envelope: { messageId: `<${l.id}>` } };
    case "page": return { seq, uid: l.uid, flags: new Set<string>(), internalDate: l.date, envelope };
    case "flags": return { seq, uid: l.uid, flags: new Set<string>() };
    case "heads": return { seq, uid: l.uid, flags: new Set<string>(), internalDate: l.date, headers: l.source };
  }
}

function fakeServer(boxes: Record<string, Box>, script: Script = {}) {
  const commands: Command[] = [];
  const moves: string[] = [];
  const searches: string[] = [];
  let path = "INBOX";
  const client = {
    usable: true,
    capabilities: new Map<string, boolean>([["CONDSTORE", true], ["MOVE", true], ["UIDPLUS", true]]),
    mailbox: false as unknown,
    async list() {
      return Object.keys(boxes).map((p) => ({ path: p, name: p.split("/").pop()!, delimiter: "/", flags: new Set<string>() }));
    },
    async getMailboxLock(p: string) {
      const b = boxes[p];
      if (!b) throw new Error(`no such mailbox ${p}`);
      path = p;
      client.mailbox = {
        path: p, uidValidity: b.uidValidity, uidNext: Math.max(0, ...b.letters.map((l) => l.uid)) + 1,
        highestModseq: 60n, exists: b.letters.length,
      };
      return { path: p, release() { /* no lock in the fake */ } };
    },
    async *fetch(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean; changedSince?: bigint }) {
      const box = boxes[path]!;
      const byUid = options?.uid === true;
      const kind = kindOf(query);
      const asked = named(box, range, byUid);
      const c: Command = { kind, asked: asked.map((l) => l.uid), query, byUid };
      commands.push(c);
      if (options?.changedSince !== undefined) return;
      const around = script.strays?.(c) ?? {};
      for (const r of around.before ?? []) yield r;
      for (const l of asked) {
        if (script.withhold?.(c, l.uid)) continue;
        const row = rowFor(kind, l, box.letters.indexOf(l) + 1, query);
        yield row;
        if (script.duplicate?.(c)) yield { ...row };
      }
      for (const r of around.after ?? []) yield r;
    },
    async fetchAll(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean }) {
      const out: Row[] = [];
      for await (const r of client.fetch(range, query, options)) out.push(r);
      return out;
    },
    async search(q: unknown) {
      searches.push(JSON.stringify(q));
      return script.search?.(path, q) ?? [];
    },
    async messageMove(uids: number[], to: string) {
      moves.push(`${JSON.stringify(uids)} → ${to}`);
      return { uidValidity: 7n, uidMap: new Map(uids.map((u, i) => [u, 1000 + i])) };
    },
    async logout() { /* nothing */ },
    close() { /* nothing */ },
  };
  return { client, commands, moves, searches };
}

function world(inbox: Letter[], extra: Record<string, Box> = {}): Record<string, Box> {
  const boxes: Record<string, Box> = {};
  for (const f of WATCHED_FOLDERS) boxes[f] = { uidValidity: 100n, letters: [] };
  boxes.INBOX = { uidValidity: 100n, letters: inbox };
  return { ...boxes, ...extra };
}

const cold = (): ImapCursor => {
  const folders: ImapCursor["folders"] = {};
  for (const f of WATCHED_FOLDERS) folders[f] = { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] };
  return { folders };
};

async function adapterOver(boxes: Record<string, Box>, script: Script = {}, opts: { maxBatchMessages?: number } = {}) {
  const server = fakeServer(boxes, script);
  const adapter = new ImapAdapter(
    { host: "x", port: 0, secure: false, auth: { user: "u", pass: "p" } },
    { client: server.client, ...opts },
  );
  await adapter.connect();
  return { adapter, ...server };
}

const uidOf = (c: Change): number => parseRef(c.locator.ref).uid;

/** Exactly one create per expected UID, each the letter's own bytes, and never an empty one. */
function expectOneRealCreateEach(creates: readonly Change[], letters: readonly Letter[], uids: readonly number[]): void {
  expect(creates.filter((c) => (c.raw?.length ?? 0) === 0).map(uidOf), "an empty create").toEqual([]);
  expect(creates.map(uidOf).sort((a, b) => a - b), "one create per asked UID").toEqual([...uids].sort((a, b) => a - b));
  for (const c of creates) {
    const l = letters.find((x) => x.uid === uidOf(c))!;
    expect(c.raw?.equals(l.source), `uid ${l.uid} carries its own letter`).toBe(true);
  }
}

const ON = (kind: Kind, envelope?: boolean) => (c: Command): boolean =>
  c.kind === kind && (envelope === undefined || Boolean(c.query.envelope) === envelope);

describe("the sync body fetch (fetchSized) creates only from the rows it asked for", () => {
  const letters = [letter(1), letter(2), letter(3)];

  it("a stray ahead of the reply for a page letter: one create, the real bytes", async () => {
    const { adapter } = await adapterOver(world(letters), { strays: (c) => (ON("body")(c) ? { before: [stray(3, 3)] } : undefined) });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2, 3]);
  });

  it("a stray behind the reply for a page letter: one create, the real bytes", async () => {
    const { adapter } = await adapterOver(world(letters), { strays: (c) => (ON("body")(c) ? { after: [stray(2, 2)] } : undefined) });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2, 3]);
  });

  it("a stray for a letter outside the page (not yet imported) is no create at all", async () => {
    const four = [...letters, letter(4)];
    const { adapter } = await adapterOver(
      world(four), { strays: (c) => (ON("body")(c) ? { after: [stray(1, 1)] } : undefined) }, { maxBatchMessages: 2 },
    );
    const batch = await adapter.changesSince(cold());
    // The page is the two newest; letter 1 waits for its own page with its own bytes.
    expectOneRealCreateEach(batch.creates, four, [3, 4]);
    expect(batch.hasBacklog).toBe(true);
  });

  it("strays for a UID the folder does not hold, or naming no UID, are no create", async () => {
    const { adapter } = await adapterOver(world(letters), {
      strays: (c) => (ON("body")(c) ? { before: [stray(99, 4)], after: [stray(undefined, 2)] } : undefined),
    });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2, 3]);
  });

  it("a server that answers a UID twice still yields one create for it", async () => {
    const { adapter } = await adapterOver(world(letters), { duplicate: ON("body") });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2, 3]);
  });

  it("a stray for a UID the envelope fetch withheld does not stand in for its answer: the retry still asks", async () => {
    const { adapter, commands } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("body", true)(c) && uid === 2,
      strays: (c) => (ON("body", true)(c) ? { after: [stray(2, 2)] } : undefined),
    });
    const batch = await adapter.changesSince(cold());
    expectOneRealCreateEach(batch.creates, letters, [1, 2, 3]);
    expect(commands.filter(ON("body", false)).map((c) => c.asked)).toEqual([[2]]);
    expect(batch.unanswered ?? []).toEqual([]);
  });

  it("a stray ahead of the withheld retry's reply: one create, the real bytes", async () => {
    const { adapter } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("body", true)(c) && uid === 2,
      strays: (c) => (ON("body", false)(c) ? { before: [stray(2, 2)] } : undefined),
    });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2, 3]);
  });

  it("a stray ahead of the structure-free last resort's reply: one create, the real bytes", async () => {
    const { adapter } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("body")(c) && Boolean(c.query.bodyStructure) && uid === 2,
      strays: (c) => (ON("body")(c) && !c.query.bodyStructure ? { before: [stray(2, 2)] } : undefined),
    });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2, 3]);
  });

  it("a stray is not an answer: a UID every body fetch withheld is unanswered, never an empty create", async () => {
    const { adapter } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("body")(c) && uid === 2,
      strays: (c) => (ON("body")(c) ? { after: [stray(2, 2)] } : undefined),
    });
    const batch = await adapter.changesSince(cold());
    expectOneRealCreateEach(batch.creates, letters, [1, 3]);
    expect(batch.unanswered).toEqual([{ folder: "INBOX", uidValidity: "100", uid: 2 }]);
  });

  it("CONTROL: a UID every body fetch withheld is unanswered after the two retries", async () => {
    const { adapter, commands } = await adapterOver(world(letters), { withhold: (c, uid) => ON("body")(c) && uid === 2 });
    const batch = await adapter.changesSince(cold());
    expectOneRealCreateEach(batch.creates, letters, [1, 3]);
    expect(batch.unanswered).toEqual([{ folder: "INBOX", uidValidity: "100", uid: 2 }]);
    expect(commands.filter(ON("body")).map((c) => c.asked)).toEqual([[1, 2, 3], [2], [2]]);
  });
});

describe("the RFC822.SIZE pre-fetch keeps a stated size", () => {
  const letters = [letter(1), letter(2), letter(3)];

  it("a flag change during the size fetch zeroes nothing: one batched body fetch", async () => {
    const { adapter, commands } = await adapterOver(world(letters), {
      strays: (c) => (ON("size")(c) ? { after: [stray(3, 3)] } : undefined),
    });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2, 3]);
    // An unstated size sends a letter down the one-at-a-time path, past the size gate.
    expect(commands.filter(ON("body")).map((c) => c.asked)).toEqual([[1, 2, 3]]);
  });

  it("a stated size past the MIME ceiling stays refused when a stray follows it", async () => {
    const big = letter(3, { size: 70 * 1024 * 1024 });
    const { adapter, commands } = await adapterOver(world([letter(1), big]), {
      strays: (c) => (ON("size")(c) ? { after: [stray(3, 2)] } : undefined),
    });
    const batch = await adapter.changesSince(cold());
    expect(commands.filter(ON("body")).flatMap((c) => c.asked)).toEqual([1]);
    expect(batch.creates.find((c) => uidOf(c) === 3)?.oversizeBytes).toBe(70 * 1024 * 1024);
  });
});

describe("the unsized path (fetchUnsized) lets only the asked letter's own reply claim it", () => {
  const letters = [letter(1, { size: null }), letter(2, { size: null })];

  it("a stray ahead of the reply claims nothing: one create, the real bytes", async () => {
    const { adapter } = await adapterOver(world(letters), {
      strays: (c) => (ON("body")(c) ? { before: c.asked.map((u) => stray(u, u)) } : undefined),
    });
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2]);
  });

  it("a stray is not an answer: a letter withheld from all three reads is unanswered", async () => {
    const { adapter } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("body")(c) && uid === 2,
      strays: (c) => (ON("body")(c) && c.asked.includes(2) ? { after: [stray(2, 2)] } : undefined),
    });
    const batch = await adapter.changesSince(cold());
    expectOneRealCreateEach(batch.creates, letters, [1]);
    expect(batch.unanswered).toEqual([{ folder: "INBOX", uidValidity: "100", uid: 2 }]);
  });

  it("CONTROL: a server that states no size still imports each letter on its own command", async () => {
    const { adapter, commands } = await adapterOver(world(letters));
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [1, 2]);
    expect(commands.filter(ON("body")).map((c) => c.asked)).toEqual([[2], [1]]);
  });
});

describe("the arrival-date read dates only what it asked, from rows that carry a date", () => {
  it("a stray behind a candidate's date row does not undate it: the newest letter leads the page", async () => {
    const letters = [letter(1), letter(2), letter(3)];
    const { adapter } = await adapterOver(
      world(letters), { strays: (c) => (ON("date")(c) ? { after: [stray(3, 3)] } : undefined) }, { maxBatchMessages: 1 },
    );
    expectOneRealCreateEach((await adapter.changesSince(cold())).creates, letters, [3]);
  });
});

describe("the UID enumeration maps numeric UIDs, each once", () => {
  it("a stray for a listed UID does not cost the page a letter", async () => {
    const letters = [letter(1), letter(2), letter(3)];
    const { adapter } = await adapterOver(
      world(letters), { strays: (c) => (ON("enumerate")(c) ? { after: [stray(3, 3), stray(undefined, 1)] } : undefined) },
      { maxBatchMessages: 3 },
    );
    const batch = await adapter.changesSince(cold());
    expectOneRealCreateEach(batch.creates, letters, [1, 2, 3]);
    expect(batch.hasBacklog).toBe(false);
  });
});

describe("a reset's whole re-read counts only rows that carry the header", () => {
  it("a stray for a letter the header fetch withheld proves nothing gone", async () => {
    const letters = [letter(1), letter(2)];
    const cursor = cold();
    cursor.folders.INBOX = {
      uidValidity: "50", uidNext: 3, highestModseq: "40",
      known: letters.map((l) => ({ uid: l.uid, seen: false, messageId: l.id })),
    };
    const { adapter } = await adapterOver(world(letters), {
      // Letter 2 answers the enumeration and nothing else; its flag change arrives all the same.
      withhold: (c, uid) => c.kind !== "enumerate" && uid === 2,
      strays: (c) => (ON("headers")(c) ? { after: [stray(2, 2)] } : undefined),
    });
    const batch = await adapter.changesSince(cursor);
    // The old epoch's letter 2 may be the new epoch's letter 2: the read was not whole.
    expect(batch.resetGone ?? []).toEqual([]);
    expect(batch.deletes.map((d) => d.locator.ref)).toContain("50:2");
  });

  it("CONTROL: a letter with no Message-ID (GreenMail answers the field empty) still answers, so the proof stands", async () => {
    const noId = letter(3, { headerAnswer: Buffer.alloc(0) });
    const cursor = cold();
    cursor.folders.INBOX = {
      uidValidity: "50", uidNext: 3, highestModseq: "40",
      known: [{ uid: 1, seen: false, messageId: "letter-1@x.example" }, { uid: 2, seen: false, messageId: "letter-2@x.example" }],
    };
    const { adapter } = await adapterOver(world([letter(1), noId]));
    const batch = await adapter.changesSince(cursor);
    // Letter 2 is gone from the new epoch, and the whole re-read proves it.
    expect((batch.resetGone ?? []).map((d) => d.locator.ref)).toEqual(["50:2"]);
  });
});

describe("moveMany reads the Message-ID only from a row that carries an envelope", () => {
  const letters = [letter(1), letter(2)];
  const loc = (uid: number) => ({ folder: "INBOX", ref: makeRef(100, uid) });
  const dupInScreener = (path: string, q: unknown): number[] =>
    (path === "ohmail/Screener" && JSON.stringify(q).includes("letter-2@x.example") ? [500] : []);

  it("a stray behind a letter's envelope keeps its Message-ID for the destination check", async () => {
    const { adapter, moves } = await adapterOver(world(letters), {
      search: dupInScreener,
      strays: (c) => (ON("envelope")(c) ? { after: [stray(2, 2)] } : undefined),
    });
    const res = await adapter.moveMany([loc(1), loc(2)], "ohmail/Screener", FIXTURE_DOOR);
    // The destination already holds letter 2's Message-ID: the batch goes back to the per-message path.
    expect(res.outcome).toBe("declined");
    expect(moves).toEqual([]);
  });

  it("a letter seen only through a stray declines the batch", async () => {
    const { adapter, moves } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("envelope")(c) && uid === 2,
      strays: (c) => (ON("envelope")(c) ? { after: [stray(2, 2)] } : undefined),
    });
    const res = await adapter.moveMany([loc(1), loc(2)], "ohmail/Screener", FIXTURE_DOOR);
    expect(res.outcome).toBe("declined");
    expect(moves).toEqual([]);
  });

  it("CONTROL: an undisturbed batch moves, and a letter the server does not hold is gone", async () => {
    const { adapter, moves } = await adapterOver(world(letters));
    const res = await adapter.moveMany([loc(1), loc(2), loc(3)], "ohmail/Screener", FIXTURE_DOOR);
    expect(res.outcome).toBe("batched");
    expect(moves).toEqual(["[1,2] → ohmail/Screener"]);
    expect(res.gone.map((l) => l.ref)).toEqual([makeRef(100, 3)]);
  });
});

describe("the header pages list only rows that carry an envelope", () => {
  const letters = [letter(1), letter(2), letter(3)];

  it("listFolderPage: a stray is no item", async () => {
    const { adapter } = await adapterOver(world(letters), { strays: (c) => (ON("page")(c) ? { after: [stray(2, 2)] } : undefined) });
    const page = await adapter.listFolderPage("INBOX");
    expect(page?.items.map((i) => [i.uid, i.subject])).toEqual([[3, "letter 3"], [2, "letter 2"], [1, "letter 1"]]);
  });

  it("searchFolderPage: a stray, or a row for a UID the search did not find, is no item", async () => {
    const outsider = { ...rowFor("page", letters[0]!, 1, {}) };
    const { adapter } = await adapterOver(world(letters), {
      search: () => [2, 3],
      strays: (c) => (ON("page")(c) ? { before: [stray(1, 1), outsider], after: [stray(3, 3)] } : undefined),
    });
    const page = await adapter.searchFolderPage("INBOX", "letter");
    expect(page?.items.map((i) => [i.uid, i.subject])).toEqual([[3, "letter 3"], [2, "letter 2"]]);
  });
});

describe("the targeted re-read (fetchByUid) answers only for the UIDs it was asked", () => {
  const letters = [letter(1), letter(2), letter(3)];

  it("D: a stray for another letter during the body fetch is no create", async () => {
    const { adapter } = await adapterOver(world(letters), { strays: (c) => (ON("body")(c) ? { after: [stray(1, 1)] } : undefined) });
    const got = await adapter.fetchByUid("INBOX", [3]);
    expectOneRealCreateEach(got.creates, letters, [3]);
    expect(got.absent).toEqual([]);
  });

  it("E: a stray for the asked letter ahead of its reply: one create, the real bytes", async () => {
    const { adapter } = await adapterOver(world(letters), { strays: (c) => (ON("body")(c) ? { before: [stray(3, 3)] } : undefined) });
    const got = await adapter.fetchByUid("INBOX", [3]);
    expectOneRealCreateEach(got.creates, letters, [3]);
  });

  it("a stray in the size probe does not zero a stated size past the caller's ceiling", async () => {
    const big = letter(3, { size: 500 });
    const { adapter, commands } = await adapterOver(world([letter(1), letter(2), big]), {
      strays: (c) => (ON("size")(c) ? { after: [stray(3, 3)] } : undefined),
    });
    const got = await adapter.fetchByUid("INBOX", [3], { maxBytes: 100 });
    expect(got.oversize).toEqual([3]);
    expect(got.creates).toEqual([]);
    expect(commands.filter(ON("body")).length).toBe(0);
  });

  it("a stray in the size probe for a UID nobody asked is not fetched", async () => {
    const { adapter, commands } = await adapterOver(world(letters), {
      strays: (c) => (ON("size")(c) ? { after: [stray(1, 1)] } : undefined),
    });
    const got = await adapter.fetchByUid("INBOX", [3]);
    expectOneRealCreateEach(got.creates, letters, [3]);
    expect(commands.filter(ON("body")).map((c) => c.asked)).toEqual([[3]]);
  });

  it("a stray for a letter the envelope fetch withheld does not stand in for it: the retry asks", async () => {
    const { adapter } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("body", true)(c) && uid === 3,
      strays: (c) => (ON("body", true)(c) ? { after: [stray(3, 3)] } : undefined),
    });
    const got = await adapter.fetchByUid("INBOX", [3]);
    expectOneRealCreateEach(got.creates, letters, [3]);
  });

  it("a stray ahead of the retries' replies: one create, the real bytes", async () => {
    const { adapter } = await adapterOver(world(letters), {
      withhold: (c, uid) => ON("body")(c) && Boolean(c.query.bodyStructure) && uid === 3,
      strays: (c) => (ON("body")(c) ? { before: [stray(3, 3)] } : undefined),
    });
    const got = await adapter.fetchByUid("INBOX", [3]);
    expectOneRealCreateEach(got.creates, letters, [3]);
  });

  it("a stray is not an answer: a letter every body fetch withheld is absent", async () => {
    const { adapter } = await adapterOver(world([letter(1), letter(3)]), {
      withhold: (c, uid) => ON("body")(c) && uid === 3,
      strays: (c) => (ON("body")(c) ? { after: [stray(3, 2)] } : undefined),
    });
    const got = await adapter.fetchByUid("INBOX", [2, 3]);
    expect(got.creates).toEqual([]);
    expect(got.absent.sort()).toEqual([2, 3]);
  });

  it("CONTROL: an expunged UID is absent, and so is one every body fetch withheld", async () => {
    const { adapter } = await adapterOver(world([letter(1), letter(3)]), { withhold: (c, uid) => ON("body")(c) && uid === 3 });
    const got = await adapter.fetchByUid("INBOX", [2, 3]);
    expect(got.creates).toEqual([]);
    expect(got.absent.sort()).toEqual([2, 3]);
  });
});

import { describe, expect, it } from "vitest";

import { memoryImapServer, reencodeBody, type MemoryImapServer } from "./_metaworld.js";
import { resetMetaMemos } from "../../src/adapters/meta-memo.js";
import { createLogger } from "../../src/log.js";
import {
  formatProfileMessage,
  isMalformedProfile,
  makeProfileDoc,
  makeProfileIo,
  parseProfileMessage,
  profileFingerprint,
  readOrganizerProfile,
  tidyOrganizerProfile,
  writeOrganizerProfile,
  type OrganizerProfilePayload,
} from "../../src/adapters/organizer-profile.js";

/**
 * The settings document is found without asking the server to SEARCH (FIX-026). Infomaniak answered
 * `HEADER X-Ohmail-Profile ""` with nothing, and iCloud answers the settings search with nothing, so
 * a writer that trusted the search appended a new copy on every change and removed none. Four
 * servers, driven through the production io: `rfc` (GreenMail, Dovecot), `whole-word` (Gmail-like),
 * `empty-matches-nothing` (Infomaniak-like) and `blind` (every header term finds nothing). The wire
 * twins are `organizer-profile-presence.imap.test.ts` and `organizer-profile-one-copy.imap.test.ts`.
 */

const META = "INBOX.ohmail._meta";
const toServerPath = (canonical: string): string => canonical.replace(/\//g, ".");
const SERVERS = ["rfc", "whole-word", "empty-matches-nothing", "blind"] as const;

let ids = 0;
/** A fresh identity per read: the meta memo is module-level and would anchor a later case. */
const freshId = (): { installId: string; mailboxId: string } => {
  ids += 1;
  return { installId: `presence-reader-${ids}`, mailboxId: `presence-mailbox-${ids}` };
};

function payload(tag: string): OrganizerProfilePayload {
  return {
    screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [tag], signature: null,
  };
}

function settings(tag: string, at: string, installId: string): string {
  const doc = makeProfileDoc(payload(tag), {
    updatedAt: new Date(at), producer: { kind: "desktop", version: "test" },
  });
  return formatProfileMessage(doc, { installId });
}

/** A settings message's first tag, by the parser, whatever spelling the body uses. */
function tagOf(raw: string): string | undefined {
  const r = parseProfileMessage(raw);
  return r !== null && !isMalformedProfile(r) && r.status === "ok" ? r.doc!.tagNames[0] : undefined;
}

/** The tester's folder: eight copies from two installs, one claim, one stranger. */
function seedEightCopies(server: MemoryImapServer): void {
  for (let i = 0; i < 6; i++) {
    server.seed(META, settings(`old-${i}`, `2026-09-26T11:${String(31 + i).padStart(2, "0")}:00Z`, "install-b5f7"));
  }
  server.seed(META, settings("second-newest", "2026-09-26T15:46:55Z", "install-1aa6"));
  server.seed(META, settings("newest", "2026-09-26T15:52:52Z", "install-1aa6"));
  server.seed(META, "X-Ohmail-Lease: 1\r\nX-Ohmail-Install-Id: install-1aa6\r\nSubject: claim\r\n\r\nclaim");
  server.seed(META, "Subject: a stranger's message\r\n\r\nbody");
}

function deepMeta(server: MemoryImapServer, nextUid: number): void {
  const folder = server.tree.get(META);
  if (folder === undefined) throw new Error(`the fixture has no ${META}`);
  folder.nextUid = nextUid;
}

const expunges = (server: MemoryImapServer): string[] =>
  server.log.filter((l) => /^(expunge|delete|store)/i.test(l));

for (const mode of SERVERS) {
  describe(`the settings document is found on a ${mode} server`, () => {
    it("the newest of eight copies is taken, and nothing is removed", async () => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      seedEightCopies(server);
      const held = server.tree.get(META)!.messages.length;

      const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));

      expect(read.state, `${mode}: the folder holds eight documents and the read found none`).toBe("found");
      if (read.state !== "found") return;
      expect(read.doc.tagNames).toEqual(["newest"]);
      expect(read.installId).toBe("install-1aa6");
      /* The tidy's count, as the newest's writer: its own older copy, and install-b5f7's six, which
         are hours older and whose writer holds no claim (fix-025 left those; FIX-026 removes them). */
      expect(read.residue).toBe(7);
      expect(server.tree.get(META)!.messages.length, "a read removed a copy").toBe(held);
      expect(expunges(server)).toEqual([]);
    });

    it("a document below one walk of a deep uid space is found (the gap walk)", async () => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      server.seed(META, settings("deep", "2026-09-26T12:00:00Z", "install-1aa6"));
      deepMeta(server, 11_900);

      const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));

      expect(read.state, `${mode}: the gap walk missed the document`).toBe("found");
    });

    it("a document below both walks is found by the complete search", async () => {
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      server.seed(META, settings("deeper", "2026-09-26T12:00:00Z", "install-1aa6"));
      deepMeta(server, 50_000);

      const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));

      expect(read.state, `${mode}: the complete search missed the document`).toBe("found");
    });

    it("an empty folder, and a folder holding only a claim, still read none", async () => {
      const empty = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      expect((await readOrganizerProfile(makeProfileIo(empty, toServerPath, freshId()))).state).toBe("none");

      const claimOnly = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      claimOnly.seed(META, "X-Ohmail-Lease: 1\r\nSubject: claim\r\n\r\nclaim");
      claimOnly.seed(META, "X-Ohmail-Profile-Note: 1\r\nSubject: near miss\r\n\r\nbody");
      expect((await readOrganizerProfile(makeProfileIo(claimOnly, toServerPath, freshId()))).state).toBe("none");
    });
  });
}

describe("no SEARCH at any site", () => {
  /* fix-025 pinned ONE spelling of the settings search at its three sites; FIX-026 removed the
     search, so the pin is now its absence, on the read, the write and the tidy alike. */
  it("the read, the write and the tidy find settings by one header FETCH and never ask SEARCH", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, settings("deeper", "2026-09-26T12:00:00Z", "install-1aa6"));
    deepMeta(server, 50_000);
    const id = freshId();

    await readOrganizerProfile(makeProfileIo(server, toServerPath, id));
    await writeOrganizerProfile({
      io: makeProfileIo(server, toServerPath, id), installId: id.installId, replaceable: [],
      doc: makeProfileDoc(payload("after"), { updatedAt: new Date("2026-09-27T00:00:00Z"), producer: { kind: "desktop", version: "test" } }),
    }).catch(() => undefined);
    await tidyOrganizerProfile({ io: makeProfileIo(server, toServerPath, id), installId: id.installId });

    expect(server.log.filter((l) => l.startsWith("search ")), "a settings path asked SEARCH").toEqual([]);
    expect(server.log.filter((l) => l === `fetch ${META} 1:*`).length).toBeGreaterThanOrEqual(3);
  });
});

/**
 * THE WRITE AFTER THE READ, on the folder the tester measured. Only the newest can refuse. fix-025
 * then left another install's older copies in the mailbox for ever; FIX-026 removes them once they
 * are ten minutes older than the current document and their writer holds no fresh claim, and the
 * write gate removes them BEFORE it appends, so the folder never holds more than two.
 */
describe("a write supersedes the newest and tidies the stale copies first", () => {
  const writer = "install-new";
  async function readThenWrite(server: MemoryImapServer, tag: string, seenNewest: boolean) {
    const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));
    if (read.state !== "found") throw new Error(`expected found, got ${read.state}`);
    const doc = makeProfileDoc(payload(tag), {
      updatedAt: new Date("2026-09-27T00:00:00Z"), producer: { kind: "desktop", version: "test" },
    });
    return writeOrganizerProfile({
      io: makeProfileIo(server, toServerPath, { installId: writer, mailboxId: "presence-writer" }),
      doc, installId: writer, replaceable: seenNewest ? [profileFingerprint(read.doc)] : [],
    });
  }
  const tagsIn = (server: MemoryImapServer): string[] => server.tree.get(META)!.messages
    .map((m) => tagOf(m.raw)).filter((t): t is string => t !== undefined);

  it("a writer that has seen the newest tidies the six stale copies, then replaces the newest", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: "empty-matches-nothing" });
    seedEightCopies(server);

    // The gate: install-b5f7's six are hours older than the newest and go; second-newest is six
    // minutes older than the newest, inside the window, and stays.
    expect(await readThenWrite(server, "mine", true)).toEqual({ written: false, reason: "cleanup_owed", removed: 6 });
    expect(tagsIn(server).sort()).toEqual(["newest", "second-newest"]);
    expect(await readThenWrite(server, "mine", true)).toEqual({ written: true, removed: 1 });
    expect(tagsIn(server).sort()).toEqual(["mine", "second-newest"]);
    const after = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));
    expect(after.state === "found" && after.doc.tagNames).toEqual(["mine"]);
    // second-newest is now hours older than "mine": the next tidy owes its removal.
    expect(after.state === "found" && after.residue).toBe(1);
  });

  it("another install's copy within ten minutes of the current document stays", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, settings("foreign-close", "2026-09-26T10:55:00Z", "install-b5f7"));
    server.seed(META, settings("own-newest", "2026-09-26T11:00:00Z", writer));

    const r = await tidyOrganizerProfile({ io: makeProfileIo(server, toServerPath, freshId()), installId: writer });

    expect(r).toMatchObject({ removed: 0, remaining: 0 });
    expect(r.planned).toMatchObject({ records: 2, current: 1, removable: 0, keptForeignFresh: 1 });
    expect(tagsIn(server).sort()).toEqual(["foreign-close", "own-newest"]);
  });

  it("an unseen foreign NEWEST still refuses, and names the newest rather than an older copy", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    seedEightCopies(server);
    const held = server.tree.get(META)!.messages.length;

    const result = await readThenWrite(server, "mine", false);

    expect(result).toMatchObject({ written: false, reason: "foreign", installId: "install-1aa6" });
    if (!result.written && result.reason === "foreign") expect(result.doc.tagNames).toEqual(["newest"]);
    expect(server.tree.get(META)!.messages.length).toBe(held);
  });

  it("this install's own older copy and a stale foreign one are cleared, and then the write lands", async () => {
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    server.seed(META, settings("foreign-old", "2026-09-26T09:00:00Z", "install-b5f7"));
    server.seed(META, settings("own-old", "2026-09-26T10:00:00Z", writer));
    server.seed(META, settings("own-newest", "2026-09-26T11:00:00Z", writer));

    expect(await readThenWrite(server, "own-next", false)).toEqual({ written: false, reason: "cleanup_owed", removed: 2 });
    expect(await readThenWrite(server, "own-next", false)).toEqual({ written: true, removed: 1 });
    expect(tagsIn(server).sort()).toEqual(["own-next"]);
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════
//  FIX-026: ONE SETTINGS MESSAGE PER MAILBOX, AND NEVER MORE THAN TWO
// ══════════════════════════════════════════════════════════════════════════════════════════════

const WRITER = "install-writer";
const CLAIM = "X-Ohmail-Lease: 1\r\nX-Ohmail-Install-Id: install-other\r\nX-Ohmail-Protocol: 1\r\n"
  + "X-Ohmail-Heartbeat: 2026-09-26T09:00:00.000Z\r\nSubject: ohmail organizer claim\r\n\r\nclaim";
const ACK = "X-Ohmail-Ack: 1\r\nX-Ohmail-Install-Id: install-other\r\nSubject: ack\r\n\r\nack";
const STRANGER_NOTE = "Subject: a stranger's note\r\nX-Note: kept\r\n\r\nnot ohmail's";

/** The double's own truth, read without the io: every message whose header says it is a settings record. */
function settingsHeld(server: MemoryImapServer): number {
  return server.tree.get(META)!.messages.filter((m) => {
    const head = m.raw.split(/\r?\n\r?\n/, 1)[0] ?? "";
    return /^X-Ohmail-Profile:[ \t]*1[ \t]*$/im.test(head);
  }).length;
}
const rawsOf = (server: MemoryImapServer): string[] => server.tree.get(META)!.messages.map((m) => m.raw);
const writeAt = (i: number): Date => new Date(Date.UTC(2026, 8, 27, 0, i, 0));

async function writeAs(
  server: MemoryImapServer, tag: string, at: Date, opts: { log?: (e: string, d: Record<string, unknown>) => void; id?: { installId: string; mailboxId: string } } = {},
) {
  const doc = makeProfileDoc(payload(tag), { updatedAt: at, producer: { kind: "cloud", version: "test" } });
  return writeOrganizerProfile({
    io: makeProfileIo(server, toServerPath, opts.id ?? { installId: WRITER, mailboxId: "fix026" }),
    doc, installId: WRITER, ...(opts.log === undefined ? {} : { log: opts.log }),
  });
}

describe("five writes on a server whose header SEARCH finds nothing leave one settings message", () => {
  for (const mode of ["blind", "rfc"] as const) {
    it(`${mode}: 12 older copies of ours, a claim, an ack and a stranger → 1 settings message after every write`, async () => {
      resetMetaMemos();
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], headerSearch: mode });
      for (let i = 0; i < 12; i++) server.seed(META, settings(`old-${i}`, `2026-09-26T10:${String(i).padStart(2, "0")}:00Z`, WRITER));
      server.seed(META, CLAIM);
      server.seed(META, ACK);
      server.seed(META, STRANGER_NOTE);
      const others = [CLAIM, ACK, STRANGER_NOTE];

      const held: number[] = [];
      for (let i = 1; i <= 5; i++) {
        await writeAs(server, `w${i}`, writeAt(i));
        held.push(settingsHeld(server));
      }

      expect(held, `${mode}: settings messages after each write`).toEqual([1, 1, 1, 1, 1]);
      for (const o of others) expect(rawsOf(server).filter((r) => r === o), "a record that is not ohmail's settings moved").toHaveLength(1);
      expect(server.log.filter((l) => l.startsWith("search ")), "the profile asked SEARCH").toEqual([]);
    });
  }
});

describe("a listing that comes back short of STATUS refuses, and nothing is appended", () => {
  it("80 messages, the FETCH answering 50 → profile_enum_incomplete; untruncated → the write lands", async () => {
    resetMetaMemos();
    const short = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], fetchTruncatesAt: 50 });
    for (let i = 0; i < 79; i++) short.seed(META, `Subject: n${i}\r\n\r\nx`);
    short.seed(META, settings("current", "2026-09-26T10:00:00Z", WRITER));

    await expect(writeAs(short, "next", writeAt(1)))
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_enum_incomplete" });
    expect(short.log.filter((l) => l.startsWith("append ")), "a short listing appended").toEqual([]);

    short.heal("fetchTruncatesAt");
    await expect(writeAs(short, "next", writeAt(1))).resolves.toEqual({ written: true, removed: 1 });
    expect(settingsHeld(short)).toBe(1);
  });
});

describe("our own last document is the listing's positive control", () => {
  it("listed without its header → profile_enum_blind and no append; really expunged → forgotten and the write lands", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    await writeAs(server, "first", writeAt(1));
    const ownUid = server.tree.get(META)!.messages.at(-1)!.uid;

    server.misbehave({ headersBlankFor: [ownUid] });
    const appends = server.log.filter((l) => l.startsWith("append ")).length;
    await expect(writeAs(server, "second", writeAt(2)))
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_enum_blind" });
    expect(server.log.filter((l) => l.startsWith("append ")).length, "a blind listing appended").toBe(appends);

    server.heal("headersBlankFor");
    server.tree.get(META)!.messages = server.tree.get(META)!.messages.filter((m) => m.uid !== ownUid);
    await expect(writeAs(server, "second", writeAt(2))).resolves.toEqual({ written: true, removed: 0 });
    expect(settingsHeld(server)).toBe(1);
  });

  it("another row listed without headers refuses profile_enum_incomplete, and nothing is appended", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    await writeAs(server, "first", writeAt(1));
    const stranger = server.seed(META, STRANGER_NOTE);
    server.misbehave({ headersBlankFor: [stranger] });
    const appends = server.log.filter((l) => l.startsWith("append ")).length;

    await expect(writeAs(server, "second", writeAt(2)))
      .rejects.toMatchObject({ name: "ProfileUnavailableError", code: "profile_enum_incomplete" });
    expect(server.log.filter((l) => l.startsWith("append ")).length, "a headerless listing appended").toBe(appends);
  });
});

describe("a server that refuses every EXPUNGE never holds more than two", () => {
  it("six writes, two APPENDs, the hold logged; healed, one tidy pass leaves one", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], expungeRefused: true });
    const events: string[] = [];
    const log = (e: string): void => { events.push(e); };
    const held: number[] = [];
    for (let i = 1; i <= 6; i++) {
      await writeAs(server, `w${i}`, writeAt(i), { log });
      held.push(settingsHeld(server));
    }

    expect(Math.max(...held), `settings messages after each write: ${held.join(",")}`).toBeLessThanOrEqual(2);
    expect(server.log.filter((l) => l.startsWith("append ")).length).toBeLessThanOrEqual(2);
    expect(events).toContain("profile_write_held_for_cleanup");

    server.heal("expungeRefused");
    const r = await tidyOrganizerProfile({ io: makeProfileIo(server, toServerPath, { installId: WRITER, mailboxId: "fix026" }), installId: WRITER });
    expect(r).toMatchObject({ removed: 1, remaining: 0 });
    expect(settingsHeld(server)).toBe(1);
  });
});

describe("without UIDPLUS the append is located by its header, and a plain EXPUNGE takes only what is flagged", () => {
  it("ends at one; a stranger without \\Deleted is byte-identical; a copy another install appends in between is not taken for ours", async () => {
    resetMetaMemos();
    let interleaved = false;
    const foreignNewer = settings("theirs", "2026-09-27T00:30:00Z", "install-other");
    const server = memoryImapServer({
      prefix: "INBOX.", folders: ["INBOX.ohmail", META], noUidplus: true,
      afterAppend: (srv, path, raw) => {
        if (interleaved || tagOf(raw) !== "w2") return;
        interleaved = true;
        srv.seed(path, foreignNewer);
      },
    });
    server.seed(META, STRANGER_NOTE);

    await expect(writeAs(server, "w1", writeAt(1))).resolves.toEqual({ written: true, removed: 0 });
    await expect(writeAs(server, "w2", writeAt(2))).resolves.toEqual({ written: true, removed: 1 });

    const tags = rawsOf(server).map(tagOf).filter((t) => t !== undefined);
    expect(tags.sort(), "our copy was mistaken for another's, or theirs for ours").toEqual(["theirs", "w2"]);
    expect(rawsOf(server).filter((r) => r === STRANGER_NOTE), "the plain EXPUNGE took the stranger").toHaveLength(1);
  });
});

describe("a copy that does not read back as written costs itself, never the current document", () => {
  const signature = "s".repeat(2_000);
  const rich = (tag: string): OrganizerProfilePayload => ({ ...payload(tag), signature });
  const seedCurrent = (server: MemoryImapServer): void => {
    server.seed(META, formatProfileMessage(makeProfileDoc(rich("current"), {
      updatedAt: new Date("2026-09-26T10:00:00Z"), producer: { kind: "cloud", version: "test" },
    }), { installId: WRITER }));
  };
  const writeRich = (
    server: MemoryImapServer, log?: (e: string, d: Record<string, unknown>) => void, next = rich("next"),
    beforeAppend?: (second: number) => Promise<void>,
  ) => writeOrganizerProfile({
    io: makeProfileIo(server, toServerPath, { installId: WRITER, mailboxId: "fix026-t6" }),
    doc: makeProfileDoc(next, { updatedAt: writeAt(1), producer: { kind: "cloud", version: "test" } }),
    installId: WRITER, ...(log === undefined ? {} : { log }), ...(beforeAppend === undefined ? {} : { beforeAppend }),
  });
  /** A server that folds every line longer than 998 octets, the RFC 5322 limit. */
  const rewrap = (raw: string): string => raw.split("\r\n")
    .map((l) => (l.length <= 998 ? l : (l.match(/.{1,998}/g) ?? [l]).join("\r\n "))).join("\r\n");
  /** A server that keeps the JSON valid and changes a value in it, however the body spells it. */
  const altered = (raw: string): string => {
    const at = raw.indexOf("{");
    const doc = JSON.parse(raw.slice(at, raw.lastIndexOf("}") + 1)) as { tagNames: string[] };
    doc.tagNames = ["nexx"];
    return `${raw.slice(0, at)}${JSON.stringify(doc, null, 2)}\r\n`;
  };

  for (const [name, transform, why] of [
    ["rewraps long lines", rewrap, { why: "served_malformed", malformed: "document is not JSON" }],
    ["alters a value", altered, { why: "served_different", sections: ["tagNames"] }],
  ] as const) {
    it(`a server that ${name}: the new copy is removed, the current one kept, and the line says why`, async () => {
      resetMetaMemos();
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], transformOnAppend: transform });
      seedCurrent(server);
      const said: Array<Record<string, unknown>> = [];

      await expect(writeRich(server, (e, d) => { if (e === "profile_append_unreadable") said.push(d); }))
        .resolves.toEqual({ written: false, reason: "append_unreadable", why: why.why });

      expect(said).toEqual([expect.objectContaining({ count: 1, ...why, transfer: "7bit" })]);
      expect(said[0]!.longestLine, "the written copy's long line").toBeGreaterThan(998);
      // …in fields the real logger keeps.
      const out: string[] = [];
      createLogger({ service: "worker", sink: (l) => { out.push(l); } }).info("profile_append_unreadable", said[0]!);
      expect(JSON.parse(out[0]!)).not.toHaveProperty("droppedFields");
      expect(settingsHeld(server)).toBe(1);
      const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));
      expect(read.state === "found" && read.doc.tagNames).toEqual(["current"]);
    });
  }

  for (const cte of ["quoted-printable", "base64"] as const) {
    it(`a server that stores the body as ${cte}: the write lands, and a fresh reader finds it`, async () => {
      resetMetaMemos();
      const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], transformOnAppend: (raw) => reencodeBody(raw, cte) });
      seedCurrent(server);
      await expect(writeRich(server)).resolves.toEqual({ written: true, removed: 1 });
      const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));
      expect(read.state === "found" && read.doc.tagNames).toEqual(["next"]);
    });
  }

  it("a copy this reader would not read back as written is never appended, and nothing is recorded for it", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    seedCurrent(server);
    const said: Array<Record<string, unknown>> = [];
    const recorded: number[] = [];
    const past = { ...rich("next"), rules: [{ kind: "sender", match: "hi@example.test", destination: "INBOX", priority: 1500, enabled: true, provenance: "manual" }] };

    await expect(writeRich(server, (e, d) => { if (e === "profile_append_unreadable") said.push(d); }, past, async (s) => { recorded.push(s); }))
      .resolves.toEqual({ written: false, reason: "append_unreadable", why: "not_self_readable" });

    expect(server.log.filter((l) => l.startsWith("append ")), "an unreadable copy was appended").toEqual([]);
    expect(recorded, "a copy never appended was recorded").toEqual([]);
    expect(said).toEqual([expect.objectContaining({ count: 0, why: "not_self_readable", sections: ["rules"], transfer: "7bit" })]);
    const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));
    expect(read.state === "found" && read.doc.tagNames).toEqual(["current"]);
  });

  it("control: a byte-faithful server admits the same write", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    seedCurrent(server);
    await expect(writeRich(server)).resolves.toEqual({ written: true, removed: 1 });
    const read = await readOrganizerProfile(makeProfileIo(server, toServerPath, freshId()));
    expect(read.state === "found" && read.doc.tagNames).toEqual(["next"]);
  });
});

describe("every settings message carries \\Seen", () => {
  it("appended while a folder with empty PERMANENTFLAGS is selected, it still lands \\Seen", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META], permanentFlags: { INBOX: [] } });
    await server.getMailboxLock("INBOX");
    const io = makeProfileIo(server, toServerPath, { installId: WRITER, mailboxId: "fix026-t10" });

    await io.appendProfile(settings("seen", "2026-09-26T10:00:00Z", WRITER));

    expect([...server.tree.get(META)!.messages.at(-1)!.flags]).toContain("\\Seen");
  });

  it("a current document without \\Seen gets one STORE from the tidy; an unseen claim and stranger are untouched", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const c = server.seed(META, settings("current", "2026-09-26T10:00:00Z", WRITER), undefined, []);
    const claim = server.seed(META, CLAIM, undefined, []);
    const stranger = server.seed(META, STRANGER_NOTE, undefined, []);

    const r = await tidyOrganizerProfile({ io: makeProfileIo(server, toServerPath, { installId: WRITER, mailboxId: "fix026-t10" }), installId: WRITER });

    expect(r.planned).toMatchObject({ current: 1, unseenCurrent: 1, removable: 0 });
    expect(server.log.filter((l) => l.startsWith("store ")), "one STORE, on the current document").toEqual([`store ${META} ${c} +\\Seen`]);
    const flagsOf = (uid: number): string[] => [...server.tree.get(META)!.messages.find((m) => m.uid === uid)!.flags];
    expect(flagsOf(c)).toContain("\\Seen");
    expect(flagsOf(claim)).toEqual([]);
    expect(flagsOf(stranger)).toEqual([]);
  });
});

describe("a pile past the body budget costs one body per pass", () => {
  it("700 copies of 200 KB: the write succeeds after the tidy passes, and only the current group is read by body", async () => {
    resetMetaMemos();
    const server = memoryImapServer({ prefix: "INBOX.", folders: ["INBOX.ohmail", META] });
    const pad = "p".repeat(200 * 1024);
    for (let i = 0; i < 700; i++) {
      const at = new Date(Date.UTC(2026, 8, 26, 0, 0, i));
      server.seed(META, formatProfileMessage(makeProfileDoc({ ...payload(`old-${i}`), signature: pad }, {
        updatedAt: at, producer: { kind: "cloud", version: "test" },
      }), { installId: WRITER }));
    }

    let result: Awaited<ReturnType<typeof writeAs>> | null = null;
    for (let pass = 0; pass < 10; pass++) {
      result = await writeAs(server, "next", writeAt(1));
      if (result.written) break;
    }

    expect(result).toEqual({ written: true, removed: 1 });
    expect(settingsHeld(server)).toBe(1);
    const listings = server.log.filter((l) => l === `fetch ${META} 1:*`).length;
    const bodies = server.log.filter((l) => l.startsWith(`fetch ${META} `) && l.includes("<0.")).length;
    expect(bodies, `${bodies} body reads over ${listings} listings`).toBeLessThanOrEqual(2 * listings);
    // No wait of its own: 140 MB through the in-memory server, up to 23.6 s on the CI VMs and 340 s
    // under 10% of a CPU. It never yields, so no budget can fire; this is the ladder's top.
  }, 300_000);
});

import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, SameFolderMoveError, parseRef } from "../../src/adapters/imap.js";
import { NEWS_FOLDER, LEGACY_NEWS_FOLDER } from "../../src/types.js";
import { greenmailConfig, eml, seedInbox } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * A LEGACY `ohmail/Reads` BESIDE `ohmail/News` ON A LIVE MAILBOX (GreenMail). Re-created after the
 * rename by an older install, another client or a server rule, it is read by nothing: the resolver
 * prefers News and the scan leaves the ohmail folders out. The organizer folds it into News on any
 * pass (`foldLegacyNews`), and the self-check asks it by its own name (`predecessorStatus`).
 * GreenMail's delimiter is `.`, hence the raw spellings on the setup side.
 */

type Cfg = ReturnType<typeof greenmailConfig>;

async function raw(cfg: Cfg) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

async function appendTo(cfg: Cfg, path: string, n: number, tag: string): Promise<void> {
  const c = await raw(cfg);
  try {
    await c.mailboxCreate(path).catch((err) => {
      if (!/already exists/i.test(String((err as Error).message))) throw err;
    });
    for (let i = 0; i < n; i++) {
      await c.append(path, eml({ from: `sender-${tag}@x.example`, subject: `${tag} ${i}`, messageId: `${tag}-${i}@x` }));
    }
  } finally {
    await c.logout();
  }
}

async function paths(cfg: Cfg): Promise<Set<string>> {
  const c = await raw(cfg);
  try { return new Set((await c.list()).map((f) => f.path)); } finally { await c.logout(); }
}

async function countIn(cfg: Cfg, path: string): Promise<number> {
  const c = await raw(cfg);
  try { return (await c.status(path, { messages: true })).messages ?? 0; } finally { await c.logout(); }
}

async function uidsIn(cfg: Cfg, path: string): Promise<number[]> {
  const c = await raw(cfg);
  try {
    const l = await c.getMailboxLock(path);
    try { return (await c.search({ all: true }, { uid: true })) || []; } finally { l.release(); }
  } finally { await c.logout(); }
}

type Verb = (...a: unknown[]) => Promise<unknown>;
interface Client {
  messageMove: Verb; messageCopy: Verb; messageDelete: Verb; mailboxDelete: Verb; capabilities: Map<string, unknown>;
}
const clientOf = (a: ImapAdapter): Client => (a as unknown as { client: Client }).client;
/** Every DELETE the adapter sends, counted on the wire. */
function deletesOf(a: ImapAdapter): string[] {
  const c = clientOf(a);
  const del = c.mailboxDelete.bind(c);
  const seen: string[] = [];
  c.mailboxDelete = async (...args: unknown[]) => { seen.push(String(args[0])); return del(...args); };
  return seen;
}
/** A LIST refresh, as a later pass makes one. */
async function relist(a: ImapAdapter): Promise<void> {
  const p = a as unknown as { listBounded(): Promise<unknown>; learnPassiveFolders(l: unknown): void };
  p.learnPassiveFolders(await p.listBounded());
}

describe("a legacy News folder beside News (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  async function connected(cfg: Cfg): Promise<ImapAdapter> {
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    return adapter;
  }

  it("legacyNewsBeside names it only when both are listed", async () => {
    const readsOnly = greenmailConfig();
    await appendTo(readsOnly, "ohmail.Reads", 1, "ro");
    expect((await connected(readsOnly)).legacyNewsBeside()).toBeNull();
    await adapter!.close();

    const newsOnly = greenmailConfig();
    await appendTo(newsOnly, "ohmail.News", 1, "no");
    expect((await connected(newsOnly)).legacyNewsBeside()).toBeNull();
    await adapter!.close();

    expect((await connected(greenmailConfig())).legacyNewsBeside()).toBeNull();
    await adapter!.close();

    const both = greenmailConfig();
    await appendTo(both, "ohmail.News", 1, "bn");
    await appendTo(both, "ohmail.Reads", 1, "br");
    expect((await connected(both)).legacyNewsBeside()).toBe(LEGACY_NEWS_FOLDER);
  });

  it("a reader connect folds nothing; predecessorStatus counts the old folder, not News", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 5, "n");
    await appendTo(cfg, "ohmail.Reads", 4, "r");
    const a = await connected(cfg);
    const st = await a.predecessorStatus(5_000);
    expect(st?.folder).toBe(LEGACY_NEWS_FOLDER);
    expect(st?.answer).toMatchObject({ k: "status", messages: 4 });
    expect(await countIn(cfg, "ohmail.Reads")).toBe(4);
    expect(await countIn(cfg, "ohmail.News")).toBe(5);
  });

  it("predecessorStatus asks nothing when no old folder is listed", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 2, "n");
    expect(await (await connected(cfg)).predecessorStatus(5_000)).toBeNull();
  });

  it("foldLegacyNews sweeps every letter into News and sends no DELETE; an empty sweep parks until a LIST", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 1, "n");
    await appendTo(cfg, "ohmail.Reads", 3, "r");
    const a = await connected(cfg);
    const dels = deletesOf(a);
    expect(await a.foldLegacyNews(FIXTURE_DOOR)).toEqual({ moved: 3, acted: "merged", refused: null });
    expect(await countIn(cfg, "ohmail.News")).toBe(4);
    expect(await countIn(cfg, "ohmail.Reads")).toBe(0);
    expect(await a.foldLegacyNews(FIXTURE_DOOR)).toEqual({ moved: 0, acted: "none", refused: null });
    expect(a.legacyNewsBeside()).toBeNull();
    // Something files there again: the next LIST names it, the next fold takes the letters.
    const other = await raw(cfg);
    for (const id of ["again-0", "again-1"]) {
      await other.append("ohmail.Reads", eml({ from: "again@x.example", subject: id, messageId: `${id}@x` }));
    }
    await other.logout();
    await relist(a);
    expect(a.legacyNewsBeside()).toBe(LEGACY_NEWS_FOLDER);
    expect(await a.foldLegacyNews(FIXTURE_DOOR)).toEqual({ moved: 2, acted: "merged", refused: null });
    expect(await countIn(cfg, "ohmail.News")).toBe(6);
    expect(dels).toEqual([]);
  });

  it("mail arriving mid-sweep stays in the old folder for the next fold", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 1, "n");
    await appendTo(cfg, "ohmail.Reads", 2, "r");
    const a = await connected(cfg);
    const dels = deletesOf(a);
    const other = await raw(cfg);
    const c = clientOf(a);
    const move = c.messageMove.bind(c);
    let once = true;
    c.messageMove = async (...args: unknown[]) => {
      const r = await move(...args);
      if (once) {
        once = false;
        await other.append("ohmail.Reads", eml({ from: "late@x.example", subject: "late", messageId: "late@x" }));
      }
      return r;
    };
    const first = await a.foldLegacyNews(FIXTURE_DOOR).finally(() => other.logout());
    expect(first).toEqual({ moved: 2, acted: "merged", refused: null });
    expect(await countIn(cfg, "ohmail.Reads")).toBe(1);
    expect(await a.foldLegacyNews(FIXTURE_DOOR)).toEqual({ moved: 1, acted: "merged", refused: null });
    expect(await countIn(cfg, "ohmail.News")).toBe(4);
    expect(dels).toEqual([]);
  });

  it("a refused MOVE loses nothing and parks the fold", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 1, "n");
    await appendTo(cfg, "ohmail.Reads", 2, "r");
    const a = await connected(cfg);
    clientOf(a).messageMove = async () => false;
    const out = await a.foldLegacyNews(FIXTURE_DOOR);
    expect(out).toMatchObject({ moved: 0, acted: "none" });
    expect(out.refused).not.toBeNull();
    expect(await countIn(cfg, "ohmail.Reads")).toBe(2);
    expect(a.legacyNewsBeside()).toBeNull();
  });

  it("without MOVE, a refused COPY loses nothing, at a fold and at the attach", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 1, "n");
    await appendTo(cfg, "ohmail.Reads", 3, "r");
    const a = await connected(cfg);
    const c = clientOf(a);
    c.capabilities.delete("MOVE");
    c.messageCopy = async () => false; // NO [OVERQUOTA]
    const dels = deletesOf(a);
    const out = await a.foldLegacyNews(FIXTURE_DOOR);
    expect(out).toMatchObject({ moved: 0, acted: "none" });
    expect(out.refused).not.toBeNull();
    expect(await countIn(cfg, "ohmail.Reads")).toBe(3);
    await a.ensureFolders(FIXTURE_DOOR);
    expect(await countIn(cfg, "ohmail.Reads")).toBe(3);
    expect(await countIn(cfg, "ohmail.News")).toBe(1);
    expect(dels).toEqual([]);
    expect(a.legacyNewsBeside()).toBeNull();
  });

  it("without MOVE, a refused EXPUNGE copies once and is not retried until the next attach", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 1, "n");
    await appendTo(cfg, "ohmail.Reads", 3, "r");
    const a = await connected(cfg);
    const c = clientOf(a);
    c.capabilities.delete("MOVE");
    c.messageDelete = async () => false;
    for (let i = 0; i < 3; i++) {
      const out = await a.foldLegacyNews(FIXTURE_DOOR);
      expect(out.moved).toBe(0);
      await relist(a);
    }
    expect(await countIn(cfg, "ohmail.News")).toBe(4);
    expect(await countIn(cfg, "ohmail.Reads")).toBe(3);
  });

  it("without MOVE, with or without UIDPLUS, a sweep the server takes moves every letter", async () => {
    for (const drop of [["MOVE"], ["MOVE", "UIDPLUS"]]) {
      const cfg = greenmailConfig();
      await appendTo(cfg, "ohmail.News", 1, "n");
      await appendTo(cfg, "ohmail.Reads", 3, "r");
      const a = await connected(cfg);
      for (const cap of drop) clientOf(a).capabilities.delete(cap);
      expect(await a.foldLegacyNews(FIXTURE_DOOR), drop.join("+")).toEqual({ moved: 3, acted: "merged", refused: null });
      expect(await countIn(cfg, "ohmail.News")).toBe(4);
      expect(await countIn(cfg, "ohmail.Reads")).toBe(0);
      await a.close();
    }
  });

  it("a move between the two spellings of News is refused before any write, and the letter stays at its UID", async () => {
    const cfg = greenmailConfig();
    const a = await connected(cfg);
    await a.ensureFolders(FIXTURE_DOOR);
    const seeded = await seedInbox(cfg, "same@x");
    const inNews = await a.move({ folder: "INBOX", ref: seeded.ref }, NEWS_FOLDER, FIXTURE_DOOR);
    // The worker settles such a filing where it is, with one audit row (move-before-the-walk.imap).
    for (const [from, to] of [[NEWS_FOLDER, LEGACY_NEWS_FOLDER], [LEGACY_NEWS_FOLDER, NEWS_FOLDER]] as const) {
      await expect(a.move({ folder: from, ref: inNews.ref }, to, FIXTURE_DOOR)).rejects.toBeInstanceOf(SameFolderMoveError);
    }
    expect(await uidsIn(cfg, "ohmail.News")).toEqual([parseRef(inNews.ref).uid]);
  });

  it("a move named with the legacy spelling lands in News and is recorded as News", async () => {
    const cfg = greenmailConfig();
    const a = await connected(cfg);
    await a.ensureFolders(FIXTURE_DOOR);
    const seeded = await seedInbox(cfg, "label@x");
    const loc = await a.move({ folder: "INBOX", ref: seeded.ref }, LEGACY_NEWS_FOLDER, FIXTURE_DOOR);
    expect(loc.folder).toBe(NEWS_FOLDER);
    expect(await countIn(cfg, "ohmail.News")).toBe(1);
    // A group from News to the old spelling is the same folder, refused before any write.
    await expect(a.moveMany!([loc], LEGACY_NEWS_FOLDER, FIXTURE_DOOR)).rejects.toBeInstanceOf(SameFolderMoveError);
  });

  it("moveMany into the legacy spelling records News", async () => {
    const cfg = greenmailConfig();
    const a = await connected(cfg);
    await a.ensureFolders(FIXTURE_DOOR);
    const one = await seedInbox(cfg, "group-1@x");
    const two = await seedInbox(cfg, "group-2@x");
    const out = await a.moveMany!([{ folder: "INBOX", ref: one.ref }, { folder: "INBOX", ref: two.ref }], LEGACY_NEWS_FOLDER, FIXTURE_DOOR);
    expect(out.outcome).toBe("batched");
    const folders = out.outcome === "batched" ? [...out.moved.values()].map((l) => l.folder) : [];
    expect(folders).toEqual([NEWS_FOLDER, NEWS_FOLDER]);
  });
});

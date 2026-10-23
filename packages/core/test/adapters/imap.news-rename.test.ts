import { describe, it, expect, afterEach } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, SameFolderMoveError, parseRef } from "../../src/adapters/imap.js";
import { NEWS_FOLDER, LEGACY_NEWS_FOLDER } from "../../src/types.js";
import { greenmailConfig, eml, seedInbox } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";

/**
 * THE 0.22 NEWS RENAME ON A REAL SERVER (GreenMail) — the four mailbox shapes plus the refused
 * rename and the reader install. The act lives in `ensureFolders`, which only an organizer under
 * the lease ever calls (the worker gates on role, the sidecar on `organizing`/`permitted`), so
 * "a reader never renames" is the connect-only cell. GreenMail's hierarchy delimiter is `.`,
 * hence the raw `ohmail.Reads` spellings on the setup side.
 */

async function raw(cfg: ReturnType<typeof greenmailConfig>) {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: cfg.secure, auth: cfg.auth, logger: false });
  await c.connect();
  return c;
}

/** Server-path presence read straight off LIST — the census the cells assert against. */
async function serverPaths(cfg: ReturnType<typeof greenmailConfig>): Promise<Set<string>> {
  const c = await raw(cfg);
  try {
    const list = await c.list();
    return new Set(list.map((f) => f.path));
  } finally {
    await c.logout();
  }
}

async function appendTo(cfg: ReturnType<typeof greenmailConfig>, path: string, n: number, tag: string): Promise<void> {
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

/** `<uidValidity>:<uid>` of every message in a folder, read off the server. */
async function refsIn(cfg: ReturnType<typeof greenmailConfig>, path: string): Promise<string[]> {
  const c = await raw(cfg);
  try {
    const lock = await c.getMailboxLock(path);
    try {
      const epoch = String((c.mailbox as { uidValidity: bigint }).uidValidity);
      const uids = await c.search({ all: true }, { uid: true });
      return (uids || []).map((u) => `${epoch}:${u}`);
    } finally {
      lock.release();
    }
  } finally {
    await c.logout();
  }
}

async function countIn(cfg: ReturnType<typeof greenmailConfig>, path: string): Promise<number> {
  const c = await raw(cfg);
  try {
    const st = await c.status(path, { messages: true });
    return st.messages ?? 0;
  } finally {
    await c.logout();
  }
}

describe("the News rename on a live mailbox (GreenMail)", () => {
  let adapter: ImapAdapter | undefined;
  afterEach(async () => { await adapter?.close(); adapter = undefined; });

  it("READS-ONLY: one atomic rename, messages intact, the epoch read back from the server", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.Reads", 3, "ro");
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const report = adapter.newsFolderReport();
    expect(report.acted).toBe("renamed");
    expect(report.refused).toBeNull();
    expect(report.physical).toBe(NEWS_FOLDER);
    const paths = await serverPaths(cfg);
    expect(paths.has("ohmail.News")).toBe(true);
    expect(paths.has("ohmail.Reads")).toBe(false);
    expect(await countIn(cfg, "ohmail.News")).toBe(3);

    // The epoch after the rename is READ, never derived: a RENAME may stamp a fresh UIDVALIDITY.
    // The locator a move hands back carries the epoch the adapter used — it must be the one the
    // server states NOW for the renamed folder.
    const seeded = await seedInbox(cfg, "ro-move@x");
    const loc = await adapter.move({ folder: "INBOX", ref: seeded.ref }, NEWS_FOLDER, FIXTURE_DOOR);
    const c = await raw(cfg);
    let uidValidityNow = "0";
    try {
      const lock = await c.getMailboxLock("ohmail.News");
      try {
        const mb = c.mailbox;
        if (mb && mb.uidValidity != null) uidValidityNow = String(mb.uidValidity);
      } finally {
        lock.release();
      }
    } finally {
      await c.logout();
    }
    expect(parseRef(loc.ref).uidValidity).toBe(uidValidityNow);
    expect(await countIn(cfg, "ohmail.News")).toBe(4);
  });

  it("NEWS-ONLY: nothing happens — no rename, no legacy folder invented", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 1, "no");
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const report = adapter.newsFolderReport();
    expect(report.acted).toBe("none");
    expect(report.refused).toBeNull();
    expect(report.physical).toBe(NEWS_FOLDER);
    const paths = await serverPaths(cfg);
    expect(paths.has("ohmail.News")).toBe(true);
    expect(paths.has("ohmail.Reads")).toBe(false);
    expect(await countIn(cfg, "ohmail.News")).toBe(1);
  });

  it("BOTH: merged into News, counts equal before and after, Reads deleted only once empty", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.Reads", 2, "b1");
    await appendTo(cfg, "ohmail.News", 1, "b2");
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    const report = adapter.newsFolderReport();
    expect(report.acted).toBe("merged");
    expect(report.physical).toBe(NEWS_FOLDER);
    const paths = await serverPaths(cfg);
    expect(paths.has("ohmail.Reads")).toBe(false);
    expect(await countIn(cfg, "ohmail.News")).toBe(3);
  });

  it("NEITHER: a fresh mailbox gets ohmail/News created — the legacy name is never made", async () => {
    const cfg = greenmailConfig();
    adapter = new ImapAdapter(cfg);
    await adapter.connect();
    await adapter.ensureFolders(FIXTURE_DOOR);

    expect(adapter.newsFolderReport()).toEqual({ physical: NEWS_FOLDER, acted: "none", refused: null });
    const paths = await serverPaths(cfg);
    expect(paths.has("ohmail.News")).toBe(true);
    expect(paths.has("ohmail.Reads")).toBe(false);
  });

  it("REFUSED RENAME: the mailbox is left exactly as found, every read resolves to Reads, the next cycle retries", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.Reads", 1, "rr");
    adapter = new ImapAdapter(cfg);
    await adapter.connect();

    // The server says NO. Patched on the INSTANCE so deleting it restores the real verb — the
    // "next cycle" below is the same adapter asking again against a server that now permits it.
    const client = (adapter as unknown as { client: { mailboxRename?: unknown } }).client;
    (client as { mailboxRename: () => never }).mailboxRename = () => {
      throw new Error("NO Rename refused by test");
    };
    await adapter.ensureFolders(FIXTURE_DOOR);

    const refusedReport = adapter.newsFolderReport();
    expect(refusedReport.acted).toBe("none");
    expect(refusedReport.refused).toMatch(/Rename refused by test/);
    expect(refusedReport.physical).toBe(LEGACY_NEWS_FOLDER);
    const paths = await serverPaths(cfg);
    expect(paths.has("ohmail.Reads")).toBe(true);
    // The create loop must NOT fork the tree by making News beside a pile that lives at Reads.
    expect(paths.has("ohmail.News")).toBe(false);
    expect(await countIn(cfg, "ohmail.Reads")).toBe(1);

    // Meanwhile every reader and filer reaches the pile through the resolver: a read addressed
    // to the CANONICAL name answers the legacy folder's mail.
    const senders = await adapter.sampleSenders(NEWS_FOLDER);
    expect(senders).toContain("sender-rr@x.example");

    // The next cycle retries and succeeds.
    delete (client as { mailboxRename?: unknown }).mailboxRename;
    await adapter.ensureFolders(FIXTURE_DOOR);
    expect(adapter.newsFolderReport().acted).toBe("renamed");
    const after = await serverPaths(cfg);
    expect(after.has("ohmail.News")).toBe(true);
    expect(after.has("ohmail.Reads")).toBe(false);
    expect(await countIn(cfg, "ohmail.News")).toBe(1);
  });

  it("READER INSTALL: connect alone renames nothing and files nothing — it reads Reads through the resolver", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.Reads", 1, "rd");
    adapter = new ImapAdapter(cfg);
    // A reader never calls `ensureFolders` — the worker gates it on role, the sidecar on
    // `organizing`/`permitted` — so the reader cell is exactly a connect and reads.
    await adapter.connect();

    const report = adapter.newsFolderReport();
    expect(report.acted).toBe("none");
    expect(report.physical).toBe(LEGACY_NEWS_FOLDER);
    // Positive control: the read through the CANONICAL name reaches the legacy folder's mail.
    const senders = await adapter.sampleSenders(NEWS_FOLDER);
    expect(senders).toContain("sender-rd@x.example");
    // And the mailbox is exactly as found: no rename, no created folders.
    const paths = await serverPaths(cfg);
    expect(paths.has("ohmail.Reads")).toBe(true);
    expect(paths.has("ohmail.News")).toBe(false);
  });

  it("ONE FOLDER, TWO NAMES: a move between the spellings is refused, with and without MOVE, and the letter stays", async () => {
    const cfg = greenmailConfig();
    await appendTo(cfg, "ohmail.News", 1, "sf");
    const [ref] = await refsIn(cfg, "ohmail.News");
    const asked = (p: Promise<unknown>) => p.then(() => "moved", (e: unknown) => e);
    const outcomes: unknown[] = [];
    for (const capabilityOverrides of [{}, { move: false, uidplus: false }]) {
      const a = new ImapAdapter(cfg, { capabilityOverrides });
      await a.connect();
      outcomes.push(
        await asked(a.move({ folder: LEGACY_NEWS_FOLDER, ref: ref! }, NEWS_FOLDER, FIXTURE_DOOR)),
        await asked(a.move({ folder: NEWS_FOLDER, ref: ref! }, LEGACY_NEWS_FOLDER, FIXTURE_DOOR)),
        await asked(a.moveMany([{ folder: LEGACY_NEWS_FOLDER, ref: ref! }], NEWS_FOLDER, FIXTURE_DOOR)),
      );
      await a.close();
    }
    expect(await refsIn(cfg, "ohmail.News"), "the move expunged the only copy").toEqual([ref]);
    for (const o of outcomes) expect(o).toBeInstanceOf(SameFolderMoveError);
  });
});

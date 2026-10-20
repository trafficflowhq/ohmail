import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";

import { ImapAdapter, makeRef, withholdUidExpunge } from "../../src/adapters/imap.js";
import { runLeaseGate, type LeaseSelf } from "../../src/adapters/organizer-lease.js";
import type { ImapConfig } from "../../src/adapters/imap-types.js";
import { greenmailConfig } from "./_imapenv.js";
import { FIXTURE_DOOR } from "./_door.js";
import { startDavmailLike, type DavmailLike, type DavmailLikeOptions } from "./_davmail-like.js";

/**
 * ═══ THE ORGANIZER ON A SERVER THAT ANSWERS LIKE DAVMAIL 7.0.0 ═════════════════════════════
 *
 * DavMail turns IMAP into Exchange calls, and EWS `createFolder` needs the parent: `CREATE
 * ohmail/Screener` with no `ohmail` is answered `BAD unable to handle request: Folder 'ohmail' not
 * found` and the connection ends. GreenMail and Dovecot create the parent themselves, so every
 * other test here passes on a server that would refuse the organizer its folders and its lease.
 * The relay (`_davmail-like.ts`) speaks DavMail's wire over the lane GreenMail.
 */

const ID = { installId: "davmail-install", mailboxId: "33333333-3333-4333-8333-333333333333" };

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  while (closers.length > 0) await closers.pop()!().catch(() => undefined);
});

async function davmail(o: Omit<DavmailLikeOptions, "upstream"> = {}): Promise<{ gm: DavmailLike; cfg: ImapConfig }> {
  const base = greenmailConfig();
  const gm = await startDavmailLike({ upstream: { host: base.host, port: base.port }, ...o });
  closers.push(() => gm.close());
  return { gm, cfg: { ...base, host: gm.host, port: gm.port } };
}

async function adapterOn(cfg: ImapConfig): Promise<ImapAdapter> {
  const adapter = new ImapAdapter(cfg);
  await adapter.connect();
  closers.push(() => adapter.close());
  return adapter;
}

/** The folder paths a fresh connection LISTs, read without the adapter in between. */
async function listed(cfg: ImapConfig): Promise<string[]> {
  const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
  await c.connect();
  try {
    return (await c.list()).map((r) => r.path).sort();
  } finally {
    await c.logout().catch(() => undefined);
  }
}

describe("a DavMail-shaped server — the fixture's own control", () => {
  it("speaks DavMail's capability set, its `/` delimiter and UIDVALIDITY 1", async () => {
    const { cfg } = await davmail();
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
    await c.connect();
    try {
      // imapflow keys the base capability as `IMAP4rev1` whatever case the server sent.
      const caps = [...c.capabilities.keys()].map((k) => k.toUpperCase()).sort();
      expect(caps).toEqual(["AUTH=LOGIN", "IMAP4REV1", "MOVE", "SPECIAL-USE", "UIDPLUS"]);
      await c.mailboxCreate("Top");
      const rows = await c.list();
      expect(rows.find((r) => r.path === "Top")?.delimiter).toBe("/");
      const lock = await c.getMailboxLock("INBOX");
      try {
        expect(String(c.mailbox && c.mailbox.uidValidity)).toBe("1");
      } finally {
        lock.release();
      }
    } finally {
      await c.logout().catch(() => undefined);
    }
  });

  it("refuses a CREATE under a missing parent with BAD and ends the connection", async () => {
    const { gm, cfg } = await davmail();
    const c = new ImapFlow({ host: cfg.host, port: cfg.port, secure: false, auth: cfg.auth, logger: false });
    c.on("error", () => { /* the server hangs up; the rejection below is the reading */ });
    await c.connect();
    const err = await c.mailboxCreate("ohmail/Screener").then(() => null, (e: unknown) => e);
    expect((err as { response?: string } | null)?.response)
      .toMatch(/ BAD unable to handle request: Folder 'ohmail' not found$/);
    expect(gm.refusedCreates).toEqual(["ohmail/Screener"]);
    // The hang-up reaches imapflow a tick after the BAD; wait for it, bounded.
    for (let i = 0; i < 40 && c.usable; i++) await new Promise((r) => setTimeout(r, 50));
    expect(c.usable).toBe(false);
  });
});

describe("the organizer creates `ohmail` before anything under it", () => {
  it("ensureFolders: the parent first, then the five, and nothing refused", async () => {
    const { gm, cfg } = await davmail();
    const adapter = await adapterOn(cfg);
    await adapter.ensureFolders(FIXTURE_DOOR);
    expect(gm.refusedCreates).toEqual([]);
    expect(gm.creates[0]).toBe("ohmail");
    const paths = await listed(cfg);
    for (const f of ["ohmail", "ohmail/Screener", "ohmail/News", "ohmail/Receipts", "ohmail/Screened", "ohmail/Quarantine"]) {
      expect(paths, `${f} is on the server`).toContain(f);
    }
  });

  it("the lease's ensureMetaFolder: `ohmail`, then `ohmail/_meta`", async () => {
    const { gm, cfg } = await davmail();
    const adapter = await adapterOn(cfg);
    await adapter.leaseIo(ID).ensureMetaFolder();
    expect(gm.refusedCreates).toEqual([]);
    expect(gm.creates).toEqual(["ohmail", "ohmail/_meta"]);
    expect(await listed(cfg)).toContain("ohmail/_meta");
  });

  it("the settings document's ensureMetaFolder, the lease's twin, the same", async () => {
    const { gm, cfg } = await davmail();
    const adapter = await adapterOn(cfg);
    await adapter.profileIo(ID).ensureMetaFolder();
    expect(gm.refusedCreates).toEqual([]);
    expect(gm.creates).toEqual(["ohmail", "ohmail/_meta"]);
  });

  it("a parent the LIST already names is never created again (positive control)", async () => {
    const { gm, cfg } = await davmail();
    await (await adapterOn(cfg)).ensureFolders(FIXTURE_DOOR);
    const before = gm.creates.length;
    const second = await adapterOn(cfg);
    await second.ensureFolders(FIXTURE_DOOR);
    await second.leaseIo(ID).ensureMetaFolder();
    // Only `_meta` is new; `ohmail` is listed and the five exist.
    expect(gm.creates.slice(before)).toEqual(["ohmail/_meta"]);
  });

  it("a parent listed as \\Noselect (GreenMail's and Dovecot's implicit one) is not created", async () => {
    const base = greenmailConfig();
    const direct = new ImapFlow({ host: base.host, port: base.port, secure: false, auth: base.auth, logger: false });
    await direct.connect();
    await direct.mailboxCreate("ohmail.Screener"); // GreenMail files `ohmail` as \Noselect
    await direct.logout();
    const gm = await startDavmailLike({ upstream: { host: base.host, port: base.port } });
    closers.push(() => gm.close());
    const adapter = await adapterOn({ ...base, host: gm.host, port: gm.port });
    await adapter.ensureFolders(FIXTURE_DOOR);
    expect(gm.creates).not.toContain("ohmail");
    expect(gm.refusedCreates).toEqual([]);
  });
});

describe("a DavMail-shaped server — UID EXPUNGE is never answered (the fixture's control)", () => {
  it("a bare imapflow removal waits out the socket timeout and loses the connection", async () => {
    const base = greenmailConfig();
    const seeded = await seedPersonFolder(base);
    const gm = await startDavmailLike({ upstream: { host: base.host, port: base.port } });
    closers.push(() => gm.close());
    const c = new ImapFlow({ host: gm.host, port: gm.port, secure: false, auth: base.auth, logger: false, socketTimeout: 4_000 });
    c.on("error", () => { /* the socket timeout ends it; the reading is below */ });
    await c.connect();
    const lock = await c.getMailboxLock("INBOX");
    const started = Date.now();
    const done = await c.messageDelete([seeded.ours], { uid: true }).catch(() => "threw");
    const waited = Date.now() - started;
    lock.release();
    expect(gm.uidExpungesUnanswered).toBe(1);
    expect(done === false || done === "threw").toBe(true);
    expect(waited).toBeGreaterThanOrEqual(3_500);
    for (let i = 0; i < 40 && c.usable; i++) await new Promise((r) => setTimeout(r, 50));
    expect(c.usable).toBe(false);
    // Ends on its own 4 s socket timer, plus a GreenMail seed and up to 2 s of polling: 4.5 s idle.
  }, 30_000);
});

/** Short deadlines: a command DavMail never answers fails in seconds here, not in two minutes. */
const SHORT = { connectionMs: 5_000, greetingMs: 5_000, socketMs: 4_000 };

/** Seed INBOX straight on GreenMail: ours, and a foreign one another client flagged \Deleted and left. */
async function seedPersonFolder(base: ImapConfig): Promise<{ ours: number; foreign: number }> {
  const c = new ImapFlow({ host: base.host, port: base.port, secure: false, auth: base.auth, logger: false });
  await c.connect();
  try {
    const a = await c.append("INBOX", "Subject: ours\r\nMessage-ID: <ours@davmail.test>\r\n\r\nours\r\n");
    const b = await c.append("INBOX", "Subject: foreign\r\nMessage-ID: <foreign@davmail.test>\r\n\r\nforeign\r\n");
    const ours = (a as { uid?: number }).uid!;
    const foreign = (b as { uid?: number }).uid!;
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageFlagsAdd([foreign], ["\\Deleted"], { uid: true });
    } finally {
      lock.release();
    }
    return { ours, foreign };
  } finally {
    await c.logout().catch(() => undefined);
  }
}

/** The uids a folder holds now, and which carry \Deleted — read on GreenMail, past the relay. */
async function inboxOnServer(base: ImapConfig, folder = "INBOX"): Promise<Map<number, boolean>> {
  const c = new ImapFlow({ host: base.host, port: base.port, secure: false, auth: base.auth, logger: false });
  await c.connect();
  const out = new Map<number, boolean>();
  try {
    const lock = await c.getMailboxLock(folder);
    try {
      for await (const m of c.fetch("1:*", { uid: true, flags: true })) out.set(m.uid, m.flags?.has("\\Deleted") ?? false);
    } finally {
      lock.release();
    }
  } finally {
    await c.logout().catch(() => undefined);
  }
  return out;
}

describe("RULED uid-expunge — a removal on a DavMail-greeted connection", () => {
  it("three lease renews complete: no UID EXPUNGE, a plain one only in ohmail/_meta, one claim left", async () => {
    const { gm, cfg } = await davmail();
    const adapter = await adapterOn({ ...cfg, timeouts: SHORT });
    let self: LeaseSelf = { installId: ID.installId, kind: "local", displayName: "This computer", lastNonce: null };
    for (let i = 0; i < 3; i++) {
      const res = await runLeaseGate({ capabilities: [], io: adapter.leaseIo(ID), self, now: new Date() });
      expect(res.verdict.verdict, `renew ${i + 1}`).toBe("organize");
      self = { ...self, lastNonce: res.nonce };
    }
    expect(gm.uidExpungesUnanswered).toBe(0);
    expect(gm.plainExpunges.length).toBeGreaterThan(0);
    expect(new Set(gm.plainExpunges)).toEqual(new Set(["ohmail/_meta"]));
    expect((await adapter.leaseIo(ID).listClaims()).length).toBe(1);
  });

  it("in a person's folder it is the STORE alone: a foreign \\Deleted message stays (imapAutoExpunge off)", async () => {
    const base = greenmailConfig();
    const seeded = await seedPersonFolder(base);
    const gm = await startDavmailLike({ upstream: { host: base.host, port: base.port }, autoExpunge: false });
    closers.push(() => gm.close());
    const c = new ImapFlow({ host: gm.host, port: gm.port, secure: false, auth: base.auth, logger: false, socketTimeout: 4_000 });
    await c.connect();
    closers.push(() => c.logout());
    expect(withholdUidExpunge(c)).toBe(true);
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageDelete([seeded.ours], { uid: true });
    } finally {
      lock.release();
    }
    const after = await inboxOnServer(base);
    expect(after.has(seeded.foreign), "the foreign \\Deleted message is still there").toBe(true);
    // DAVMAIL-AUTOEXPUNGE-OFF-LEAVES-REMOVALS-FLAGGED: with auto-expunge off ours stays, flagged.
    expect(after.get(seeded.ours)).toBe(true);
    expect(gm.plainExpunges).toEqual([]);
    expect(gm.uidExpungesUnanswered).toBe(0);
  });

  it("LOW 3: a dedupe removal in ohmail/Screener is the STORE alone; a foreign \\Deleted message there stays", async () => {
    // ohmail/Screener holds a person's mail. The organizer files a message here that another client
    // flagged \Deleted and left, then finds the same message already in INBOX and removes this copy.
    const base = greenmailConfig();
    const raw = `Subject: filed twice\r\nMessage-ID: <dup-${base.auth.user}>\r\n\r\nfiled twice\r\n`;
    const c0 = new ImapFlow({ host: base.host, port: base.port, secure: false, auth: base.auth, logger: false });
    await c0.connect();
    let ours = 0;
    let foreign = 0;
    try {
      await c0.mailboxCreate("ohmail.Screener");
      ours = ((await c0.append("ohmail.Screener", raw)) as { uid?: number }).uid!;
      await c0.append("INBOX", raw);
      foreign = ((await c0.append("ohmail.Screener",
        "Subject: theirs\r\nMessage-ID: <theirs@davmail.test>\r\n\r\ntheirs\r\n")) as { uid?: number }).uid!;
      const lock = await c0.getMailboxLock("ohmail.Screener");
      try { await c0.messageFlagsAdd([foreign], ["\\Deleted"], { uid: true }); } finally { lock.release(); }
    } finally {
      await c0.logout().catch(() => undefined);
    }
    const gm = await startDavmailLike({ upstream: { host: base.host, port: base.port }, autoExpunge: false });
    closers.push(() => gm.close());
    const adapter = await adapterOn({ ...base, host: gm.host, port: gm.port, timeouts: SHORT });
    const outcome = await adapter.move({ folder: "ohmail/Screener", ref: makeRef(1, ours) }, "INBOX", FIXTURE_DOOR)
      .then(() => "moved", (e: unknown) => (e as Error).name);
    const screener = await inboxOnServer(base, "ohmail.Screener");
    expect(screener.get(foreign), "the foreign \\Deleted message in ohmail/Screener").toBe(true);
    expect(gm.plainExpunges, "a plain EXPUNGE ran in a folder holding a person's mail").not.toContain("ohmail/Screener");
    expect(gm.uidExpungesUnanswered).toBe(0);
    // DAVMAIL-AUTOEXPUNGE-OFF-LEAVES-REMOVALS-FLAGGED: auto-expunge off leaves our copy flagged, so the
    // move reports it incomplete and is tried again; nothing of the person's is lost.
    expect(screener.get(ours)).toBe(true);
    expect(outcome).toBe("MoveIncompleteError");
  });

  it("with DavMail's default imapAutoExpunge the STORE removes ours (positive control)", async () => {
    const base = greenmailConfig();
    const c0 = new ImapFlow({ host: base.host, port: base.port, secure: false, auth: base.auth, logger: false });
    await c0.connect();
    const a = await c0.append("INBOX", "Subject: ours\r\nMessage-ID: <ours2@davmail.test>\r\n\r\nours\r\n");
    await c0.logout();
    const gm = await startDavmailLike({ upstream: { host: base.host, port: base.port } });
    closers.push(() => gm.close());
    const c = new ImapFlow({ host: gm.host, port: gm.port, secure: false, auth: base.auth, logger: false, socketTimeout: 4_000 });
    await c.connect();
    closers.push(() => c.logout());
    withholdUidExpunge(c);
    const lock = await c.getMailboxLock("INBOX");
    try {
      await c.messageDelete([(a as { uid?: number }).uid!], { uid: true });
    } finally {
      lock.release();
    }
    expect((await inboxOnServer(base)).has((a as { uid?: number }).uid!)).toBe(false);
    expect(gm.plainExpunges).toEqual([]);
  });

  it("a server whose greeting does not name DavMail is left exactly as it was", () => {
    const fake = { greeting: "IMAP4rev1 Server GreenMail v2.1.3 ready", messageDelete: async () => true, messageFlagsAdd: async () => true };
    const before = fake.messageDelete;
    expect(withholdUidExpunge(fake)).toBe(false);
    expect(fake.messageDelete).toBe(before);
  });
});


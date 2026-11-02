import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { ImapFlow } from "imapflow";
import { ImapAdapter, SERVER_SENT_COPY_FIND_MS, parseRef } from "../../src/adapters/imap.js";
import type { ImapConfig, ImapCursor } from "../../src/adapters/imap-types.js";
import { greenmailConfig } from "./_imapenv.js";
import { sentUidsFor, startGmailLikePair, type GmailLikeOptions, type GmailLikePair } from "./_gmail-like.js";

/**
 * ONE SENT LETTER IS ONE MESSAGE IN SENT — the adapter's send over a server that files its own.
 *
 * Gmail saves every SMTP submission under Sent Mail itself, and the send path used to APPEND its
 * own copy beside it: two messages with one Message-ID in every client that reads the folder.
 * `_gmail-like.ts` is that server over GreenMail. The adapter is a real `ImapAdapter` over real
 * sockets throughout; the copies are counted over a separate connection straight to GreenMail.
 */

const opened: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  for (const o of opened.splice(0).reverse()) await o.close().catch(() => undefined);
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function world(opts: Omit<GmailLikeOptions, "upstream" | "auth"> & { microsoft?: boolean } = {}): Promise<{
  gm: ImapConfig; pair: GmailLikePair; adapter: ImapAdapter; mid: string; uidValidity: string;
}> {
  const gm = greenmailConfig();
  const upstream = { host: gm.host, port: gm.port };
  const auth = gm.auth as { user: string; pass: string };
  // The mailbox exists with its Sent folder before anything is sent, as a Gmail account does.
  const c = new ImapFlow({ ...upstream, secure: false, auth, logger: false });
  await c.connect();
  await c.mailboxCreate("Sent").catch(() => undefined);
  const st = await c.status("Sent", { uidValidity: true });
  await c.logout();
  const { microsoft, ...pairOpts } = opts;
  const pair = await startGmailLikePair({ upstream, auth, ...pairOpts, ...(microsoft === true ? { xoauth2: true } : {}) });
  opened.push(pair);
  const adapter = new ImapAdapter({
    ...gm, host: pair.imap.host, port: pair.imap.port,
    // A Microsoft OAuth mailbox: the token is the fixture's password, which GreenMail takes over XOAUTH2.
    ...(microsoft === true ? { auth: { user: auth.user, fetchAccessToken: async () => auth.pass, provider: "microsoft" as const } } : {}),
    smtp: { host: pair.smtp.host, port: pair.smtp.port, secure: false },
  });
  opened.push(adapter);
  await adapter.connect();
  return { gm, pair, adapter, mid: `<gm-${randomUUID()}@trafficflow.test>`, uidValidity: String(st.uidValidity) };
}

function letter(gm: ImapConfig, messageId: string) {
  return { from: gm.auth.user, to: "someone@elsewhere.test", subject: "one letter", text: "body", messageId };
}

describe("a server that files its own submissions keeps ONE sent copy", () => {
  it("the fixture is what it says: X-GM-EXT-1 is announced through the relay and not by GreenMail", async () => {
    const { gm, pair } = await world();
    const auth = gm.auth as { user: string; pass: string };
    const read = async (host: string, port: number): Promise<boolean> => {
      const c = new ImapFlow({ host, port, secure: false, auth, logger: false });
      await c.connect();
      try { return c.capabilities.has("X-GM-EXT-1"); } finally { await c.logout(); }
    };
    expect(await read(pair.imap.host, pair.imap.port)).toBe(true);
    expect(await read(gm.host, gm.port)).toBe(false);
  }, 30_000);

  it("Gmail-like: no second copy is appended, and the send carries the SERVER's copy and its bytes", async () => {
    const { gm, pair, adapter, mid, uidValidity } = await world();
    const res = await adapter.send(letter(gm, mid));
    await pair.whenFiled(1);
    const uids = await sentUidsFor({ host: gm.host, port: gm.port }, gm.auth as { user: string; pass: string }, mid);
    expect(pair.submissions).toBe(1);
    expect(uids, "Sent holds this Message-ID more than once").toEqual([pair.filedUids[0]]);
    expect(res.sentLocator).toEqual({ folder: "Sent", ref: `${uidValidity}:${pair.filedUids[0]}` });
    // The bytes are the server's, not a recompile of ours: only its copy carries its Received line.
    expect(res.raw?.toString("latin1")).toContain("by gmail-like.test");
    expect(pair.strippedGmailItems, "imapflow never asked for a Gmail fetch item").toBeGreaterThan(0);
  }, 30_000);

  it("Gmail-like, copy LATE past the bound: nothing is appended, the send has no locator, Sent ends with one", async () => {
    const { gm, pair, adapter, mid } = await world({ fileDelayMs: SERVER_SENT_COPY_FIND_MS + 1_500 });
    const res = await adapter.send(letter(gm, mid));
    expect(res.sentLocator).toBeNull();
    expect(res.raw).toBeNull();
    await pair.whenFiled(1);
    await sleep(500);
    const uids = await sentUidsFor({ host: gm.host, port: gm.port }, gm.auth as { user: string; pass: string }, mid);
    expect(uids).toEqual([pair.filedUids[0]]);
  }, 30_000);

  it("Gmail-like, copy late but inside the bound: found on a later look", async () => {
    const { gm, pair, adapter, mid, uidValidity } = await world({ fileDelayMs: 900 });
    const res = await adapter.send(letter(gm, mid));
    expect(res.sentLocator).toEqual({ folder: "Sent", ref: `${uidValidity}:${pair.filedUids[0]}` });
    const uids = await sentUidsFor({ host: gm.host, port: gm.port }, gm.auth as { user: string; pass: string }, mid);
    expect(uids).toEqual([pair.filedUids[0]]);
  }, 30_000);

  it("Gmail-like, a look the server never answers: the find ends on its own clock, no copy appended", async () => {
    const { gm, pair, adapter, mid } = await world({ hangSearch: true });
    const started = Date.now();
    const res = await adapter.send(letter(gm, mid));
    expect(Date.now() - started).toBeLessThan(SERVER_SENT_COPY_FIND_MS + 2_000);
    expect(res.sentLocator).toBeNull();
    // The abandoned SEARCH owns the connection's queue, so the connection is retired, not reused.
    expect(adapter.isLive()).toBe(false);
    await pair.whenFiled(1);
    const uids = await sentUidsFor({ host: gm.host, port: gm.port }, gm.auth as { user: string; pass: string }, mid);
    expect(uids).toEqual([pair.filedUids[0]]);
  }, 30_000);

  it("an ordinary server (no announcement, files nothing) still gets exactly ONE appended copy", async () => {
    const { gm, pair, adapter, mid, uidValidity } = await world({ announce: false, files: false });
    const res = await adapter.send(letter(gm, mid));
    const uids = await sentUidsFor({ host: gm.host, port: gm.port }, gm.auth as { user: string; pass: string }, mid);
    expect(pair.submissions).toBe(1);
    expect(pair.filedUids).toEqual([]);
    expect(uids).toHaveLength(1);
    expect(res.sentLocator).toEqual({ folder: "Sent", ref: `${uidValidity}:${uids[0]}` });
    expect(res.raw?.toString("latin1")).not.toContain("by gmail-like.test");
  }, 30_000);

  it("a Microsoft OAuth mailbox (files submissions, announces nothing): ONE copy, the server's", async () => {
    const { gm, pair, adapter, mid, uidValidity } = await world({ announce: false, microsoft: true });
    const res = await adapter.send(letter(gm, mid));
    await pair.whenFiled(1);
    const uids = await sentUidsFor({ host: gm.host, port: gm.port }, gm.auth as { user: string; pass: string }, mid);
    expect({ submissions: pair.submissions, uids }).toEqual({ submissions: 1, uids: [pair.filedUids[0]] });
    expect(res.sentLocator).toEqual({ folder: "Sent", ref: `${uidValidity}:${pair.filedUids[0]}` });
    expect(res.providerMessageId).toBe(mid);
  }, 30_000);

  it("the next sync fills the locator in: the late copy arrives as the user's own Sent message", async () => {
    const { gm, pair, adapter, mid, uidValidity } = await world({ fileDelayMs: SERVER_SENT_COPY_FIND_MS + 1_500 });
    const res = await adapter.send(letter(gm, mid));
    expect(res.sentLocator).toBeNull();
    await pair.whenFiled(1);
    const sync = new ImapAdapter({ ...gm, host: pair.imap.host, port: pair.imap.port });
    opened.push(sync);
    await sync.connect();
    const cursor: ImapCursor = { folders: { INBOX: { uidValidity: "0", uidNext: 0, highestModseq: "0", known: [] } } };
    const batch = await sync.changesSince(cursor);
    const mine = batch.creates.filter((c) => c.locator.folder === "Sent");
    expect(mine).toHaveLength(1);
    expect(mine[0]!.ownAuthored).toBe(true);
    expect(mine[0]!.locator.ref).toBe(`${uidValidity}:${pair.filedUids[0]}`);
    expect(parseRef(mine[0]!.locator.ref).uid).toBe(pair.filedUids[0]);
    expect(mine[0]!.raw?.toString("latin1")).toContain(`Message-ID: ${mid}`);
  }, 30_000);
});

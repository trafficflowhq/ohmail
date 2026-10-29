import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { PassThrough } from "node:stream";
import { ImapFlow } from "imapflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, ohboxView, type EngineMessage } from "@ohmail/client-engine";
import { messages, rules } from "@trafficflow/db";
import { connectOverStdio, type StdioClient } from "../src/client.js";
import { createSidecar, type Sidecar } from "../src/engine.js";
import { serveOverStdio, type StdioHost } from "../src/host.js";
import { grantOrganizeConsent } from "./_consent.js";
import { freshDataDir } from "./_datadir.js";
import { rigAppendDates } from "../../../test/support/rig-append-date.js";
import { PGLITE_STANDUP_BUDGET_MS } from "./pglite-budget.js";

vi.setConfig({ testTimeout: 4 * PGLITE_STANDUP_BUDGET_MS });

/**
 * THE OPEN READ ON THE DESKTOP'S STANDALONE DOOR (owner 2026-10-07): the local engine over on-disk
 * PGlite, a real IMAP server, the app behind the frame codec, and the shell's own `HttpAdapter` +
 * `OhmailEngine`. A message opened, read and left takes the top of Earlier; the stamp is this
 * install's own column, it survives a reload, `u` clears it, the `\Seen` reaches the server, and a
 * `\Seen` another client sets files that row at its arrival slot.
 */

const IMAP_HOST = process.env.IMAP_HOST ?? "127.0.0.1";
const IMAP_PORT = Number(process.env.IMAP_PORT ?? 3143);
const SENDER = "mara@rig.test";
const H = 3_600_000;
const D = 24 * H;

interface World { sidecar: Sidecar; host: StdioHost; client: StdioClient; dataDir: string; raw: ImapFlow }
const worlds: World[] = [];
afterEach(async () => {
  for (const w of worlds.splice(0)) {
    w.client.close();
    w.host.stop();
    await w.raw.logout().catch(() => undefined);
    await w.sidecar.stop().catch(() => undefined);
    rmSync(w.dataDir, { recursive: true, force: true });
  }
});

async function standUp(): Promise<World> {
  const auth = { user: `t-${randomUUID()}@trafficflow.test`, pass: "test" };
  const dataDir = await freshDataDir("ohmail-open-read-e2e-");
  const sidecar = await createSidecar({
    dataDir, imap: { host: IMAP_HOST, port: IMAP_PORT, secure: false, auth }, address: auth.user,
    displayName: "This computer", pollIntervalMs: 60 * 60 * 1000,
  });
  await grantOrganizeConsent(sidecar);
  // The sender is known: an INBOX rule, so the letters stand in the Ohbox rather than the Screener.
  await sidecar.db.insert(rules).values({
    accountId: sidecar.world.accountId, kind: "sender", match: SENDER, destination: "INBOX", provenance: "manual",
  });
  const toHost = new PassThrough({ highWaterMark: 1024 });
  const toClient = new PassThrough({ highWaterMark: 1024 });
  const host = serveOverStdio({ handle: (req) => sidecar.handle(req), input: toHost, output: toClient });
  const client = connectOverStdio({ input: toClient, output: toHost, baseUrl: "http://sidecar" });
  await host.ready({
    baseUrl: "http://sidecar", sessionToken: sidecar.sessionToken, accountId: sidecar.world.accountId,
    userId: sidecar.world.userId, mailboxId: sidecar.world.mailboxId, credentialState: await sidecar.credentialState(),
  });
  const raw = new ImapFlow({ host: IMAP_HOST, port: IMAP_PORT, secure: false, auth, logger: false });
  await raw.connect();
  const w = { sidecar, host, client, dataDir, raw };
  worlds.push(w);
  return w;
}

function shell(w: World): OhmailEngine {
  const adapter = new HttpAdapter({
    baseUrl: "http://sidecar", fetch: w.client.fetch,
    headers: () => ({ authorization: `Bearer ${w.sidecar.sessionToken}` }),
  });
  return new OhmailEngine({ adapter, store: new MemoryMirrorStore() });
}

const LETTERS = [
  { k: "r1", ago: 1 * H, seen: true }, { k: "r2", ago: 2 * H, seen: true }, { k: "r3", ago: 3 * H, seen: true },
  { k: "f", ago: 3 * D, seen: false }, { k: "g", ago: 4 * D, seen: false },
];
const midOf = (k: string, tag: string) => `${tag}-${k}@rig.test`;

async function plant(w: World, tag: string): Promise<void> {
  const dates = rigAppendDates(LETTERS.map((x) => x.ago));
  for (const [i, x] of LETTERS.entries()) {
    const when = dates[i]!;
    const eml = [`Message-ID: <${midOf(x.k, tag)}>`, `From: Mara <${SENDER}>`, "To: me@trafficflow.test",
      `Subject: Letter ${x.k}`, `Date: ${when.toUTCString()}`, "Content-Type: text/plain; charset=utf-8", "", `Letter ${x.k}.`].join("\r\n");
    await w.raw.append("INBOX", eml, x.seen ? ["\\Seen"] : [], when);
  }
}

async function idOf(w: World, k: string, tag: string): Promise<string> {
  const [row] = await w.sidecar.db.select({ id: messages.id }).from(messages).where(eq(messages.messageIdHeader, midOf(k, tag)));
  if (!row) throw new Error(`letter ${k} was never ingested`);
  return row.id;
}
async function openReadAtOf(w: World, id: string): Promise<Date | null> {
  const [row] = await w.sidecar.db.select().from(messages).where(eq(messages.id, id));
  return (row as { openReadAt?: Date | null }).openReadAt ?? null;
}
async function seenOnServer(w: World, k: string, tag: string): Promise<boolean> {
  const lock = await w.raw.getMailboxLock("INBOX");
  try {
    const uids = await w.raw.search({ header: { "message-id": midOf(k, tag) } }, { uid: true });
    const msg = Array.isArray(uids) && uids.length === 1 ? await w.raw.fetchOne(String(uids[0]), { flags: true }, { uid: true }) : false;
    if (!msg) throw new Error(`letter ${k} is not in INBOX on the server`);
    return msg.flags?.has("\\Seen") ?? false;
  } finally { lock.release(); }
}

describe("the standalone door: an open read takes the top of Earlier", () => {
  it("open, read, leave → first; the stamp is local and durable; u clears it; a \\Seen elsewhere keeps arrival", async () => {
    const w = await standUp();
    const tag = randomUUID().slice(0, 8);
    await plant(w, tag);
    await w.sidecar.start();
    await w.sidecar.syncUntilQuiet();
    const ids = Object.fromEntries(await Promise.all(LETTERS.map(async (x) => [x.k, await idOf(w, x.k, tag)] as const)));
    const label = (list: readonly EngineMessage[]) => list.map((m) => Object.keys(ids).find((k) => ids[k] === m.id) ?? "?");

    const engine = shell(w);
    await engine.start();
    const box = () => ohboxView(engine.read(), engine.openRowHeld());
    expect(label(box().newForYou), "the premise: two old unread letters in New").toEqual(["f", "g"]);
    expect(label(box().previouslySeen)).toEqual(["r1", "r2", "r3"]);

    // 1. Open F, read it, move on: the top of Earlier.
    expect(engine.holdOpenRow(ids.f!)).toBe(true);
    const pressedAt = performance.now();
    expect((await engine.mutate({ kind: "mark_seen", messageIds: [ids.f!], unread: false, via: "glance" })).status).toBe("confirmed");
    // The read reaches the mailbox on its own, with no drain asked for, within a second.
    await vi.waitFor(async () => expect(await seenOnServer(w, "f", tag)).toBe(true), { timeout: 1_000, interval: 20 });
    expect(performance.now() - pressedAt, "\\Seen took over a second to reach the server").toBeLessThan(1_000);
    engine.releaseOpenRow(ids.f!);
    await engine.syncOnce();
    expect(label(box().previouslySeen)).toEqual(["f", "r1", "r2", "r3"]);
    // 2. The local door stamped its own column.
    expect(await openReadAtOf(w, ids.f!), "the open read was not stamped locally").toBeInstanceOf(Date);
    // …and a drain after it leaves it there.
    await w.sidecar.syncUntilQuiet();
    expect(await seenOnServer(w, "f", tag), "\\Seen did not reach the server").toBe(true);

    // 3. A reload: a fresh shell engine over the same door keeps F first.
    const reloaded = shell(w);
    await reloaded.start();
    expect(label(ohboxView(reloaded.read()).previouslySeen)[0]).toBe("f");

    // 4. u: back in New, the stamp cleared.
    await engine.mutate({ kind: "mark_seen", messageIds: [ids.f!], unread: true });
    await engine.syncOnce();
    expect(label(box().newForYou)).toEqual(["f", "g"]);
    expect(await openReadAtOf(w, ids.f!)).toBeNull();

    // 5. Another client sets \Seen on G: the row files at its arrival slot, never the top.
    const lock = await w.raw.getMailboxLock("INBOX");
    try {
      const uids = await w.raw.search({ header: { "message-id": midOf("g", tag) } }, { uid: true });
      await w.raw.messageFlagsAdd(String((uids as number[])[0]), ["\\Seen"], { uid: true });
    } finally { lock.release(); }
    await w.sidecar.syncUntilQuiet();
    await engine.syncOnce();
    expect(await seenOnServer(w, "g", tag), "the other client's \\Seen, read back").toBe(true);
    expect(label(box().previouslySeen), "a read in another app placed the row").toEqual(["r1", "r2", "r3", "g"]);
    expect(await openReadAtOf(w, ids.g!)).toBeNull();
  });
});

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, OhmailEngine, type EngineMutation } from "@ohmail/client-engine";

import { WindowOutboxStore } from "../../desktop/src/window-outbox-store.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { windowOutboxFilesOf, windowOutboxOwnerKey } from "../src/window-outbox.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A WRITE THE WINDOW MADE IS APPLIED BY ITS ACCOUNT'S SERVER UNDER ITS OWN KEY, OR KEPT ON THIS
 * COMPUTER FOR THAT ACCOUNT AND SERVER — across sign-outs, refused sessions and other accounts'
 * launches. The desktop window's own chain: the real client engine and its `WindowOutboxStore`
 * over the real cloud engine, with a hosted server that records every write it is sent.
 */
const dirs: string[] = [];
const sidecars: CloudSidecar[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
const MSG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MBX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const MBX_B = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const A = "first@ohmail.test";
const B = "second@ohmail.test";
const BASE1 = "https://host.test";
const BASE2 = "https://other.test";
const VERB = { kind: "mark_seen", messageIds: [MSG], unread: false } as unknown as EngineMutation;
const MIN = 60_000;

type WriteMode = "ok" | "late401" | "late200" | "busy503" | "unreachable";
interface Server {
  write: WriteMode;
  refresh: "minted" | "refused";
  writes: Array<{ key: string | null; host: string; answered: number }>;
}

function serverFetch(s: Server, address: string): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/messages" && method === "PATCH") {
      const row = { key: new Headers(init?.headers).get("idempotency-key"), host: url.host, answered: 0 };
      s.writes.push(row);
      if (s.write === "ok") { row.answered = 200; return json({ updated: 1 }); }
      if (s.write === "unreachable") throw new TypeError("fetch failed");
      if (s.write === "busy503") {
        row.answered = 503;
        return json({ error: { code: "unavailable", message: "busy", retryable: true } }, 503);
      }
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => {
          row.answered = s.write === "late200" ? 200 : 401;
          resolve(s.write === "late200" ? json({ updated: 1 })
            : json({ error: { code: "unauthorized", message: "authentication required" } }, 401));
        }, 1_500);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(init.signal!.reason); });
      });
    }
    if (url.pathname === "/auth/refresh") {
      if (s.refresh === "refused") return json({ error: { code: "refresh_revoked", message: "revoked" } }, 401);
      return json({ tokens: { accessToken: "minted-access", refreshToken: "minted-refresh", expiresIn: 900 } });
    }
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox(address === B ? MBX_B : MBX, address)]));
    if (url.pathname === "/sync") {
      return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    }
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

let launches = 0;
async function launch(dataDir: string, s: Server, who: { address: string; base: string }) {
  launches += 1;
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: who.base, address: who.address, fetchImpl: serverFetch(s, who.address),
    pollIntervalMs: 3_600_000, keks: { 1: Buffer.alloc(32, 7) },
    tokens: { accessToken: `access-${launches}`, refreshToken: `refresh-${launches}` },
  });
  sidecars.push(sidecar);
  /** Every request the window sends its engine, by method and path. */
  const asked: string[] = [];
  const bridge = async (path: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as RequestInit;
    asked.push(`${(i.method ?? "GET").toUpperCase()} ${path.split("?")[0]}`);
    const headers = new Headers(i.headers);
    headers.set("authorization", `Bearer ${sidecar.sessionToken}`);
    return sidecar.handle(new Request(`http://sidecar${path}`, { ...i, headers }));
  };
  const stop = async (): Promise<void> => {
    sidecars.splice(sidecars.indexOf(sidecar), 1);
    await sidecar.stop();
  };
  return { sidecar, bridge, asked, stop, signOut: () => bridge("/cloud/session", { method: "DELETE" }) };
}

function windowOver(bridge: (p: string, i?: unknown) => Promise<Response>, scope: string, clock: { ms: number }) {
  return new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "", fetch: bridge as never }),
    store: new WindowOutboxStore({ scope, write: bridge, read: bridge }),
    now: () => new Date(clock.ms),
  });
}

/** The outbox rows on disk for one account on one server, and only that owner's file. */
function kept(dataDir: string, address: string, base: string): Array<{ attempts: number }> {
  const file = join(dataDir, windowOutboxFilesOf(windowOutboxOwnerKey({ address, base }))[0]!);
  if (!existsSync(file)) return [];
  const rows = (JSON.parse(readFileSync(file, "utf8")) as { rows: Array<{ type: string; entity: { attempts?: number } }> }).rows;
  return rows.filter((r) => r.type === "outbox_entry").map((r) => ({ attempts: r.entity.attempts ?? 0 }));
}
const until = async (ms: number, ok: () => boolean): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return ok();
};
const codeOf = (e: unknown): string => (e as { code?: string } | null)?.code ?? "threw";
const drive = (w: OhmailEngine): Promise<string | null> => w.syncOnce().then(() => null, codeOf);
const writesAsked = (asked: string[]): number => asked.filter((a) => a === "PATCH /messages").length;

describe("a write the window made outlives a sign-out", () => {
  it("(2) a write that meets the ended session after the press stays queued through a drive in the gap", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-gap-"); dirs.push(dataDir);
    const s: Server = { write: "late401", refresh: "minted", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    const pending = w.mutate(VERB);
    expect(await until(10_000, () => s.writes.length === 1), "the write never reached the server").toBe(true);
    expect((await a.signOut()).status).toBe(200);
    expect((await pending).status, "the window was not told its write is waiting").toBe("queued");
    expect(kept(dataDir, A, BASE1), "control: the write was on disk before the drive").toHaveLength(1);
    const drainError = await drive(w);
    expect(drainError, "the read still refuses: this install is signed out").toBe("not_signed_in");
    expect(kept(dataDir, A, BASE1), "the drive in the gap dropped the write").toHaveLength(1);
    expect(w.pendingMutations()).toHaveLength(1);
    expect(w.abandoned()).toHaveLength(0);
    expect(s.writes.map((x) => x.answered), "a write went out with no session").toEqual([401]);
  });

  it("(2) control: a replay that meets the outage again keeps the write too", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-503-"); dirs.push(dataDir);
    const s: Server = { write: "busy503", refresh: "minted", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    clock.ms += 10 * MIN;
    expect(await drive(w)).toBeNull();
    expect(s.writes.map((x) => x.answered)).toEqual([503, 503]);
    expect(kept(dataDir, A, BASE1)).toHaveLength(1);
    expect(w.pendingMutations()).toHaveLength(1);
  });

  it("(3) a refused session keeps the queued write, and the same account's next launch delivers it once under its key", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-refused-"); dirs.push(dataDir);
    const s: Server = { write: "busy503", refresh: "refused", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    await a.bridge("/cloud/session/renew", { method: "POST" });
    const health = (await (await a.bridge("/health")).json()) as { signedIn?: boolean; sessionExpired?: boolean; queued?: unknown };
    expect(health, "control: the session was refused at the refresh door").toMatchObject({ signedIn: false, sessionExpired: true });
    expect(health.queued, "the card cannot say what waits").toEqual({ count: 1 });
    clock.ms += 10 * MIN;
    expect(await drive(w)).toBe("not_signed_in");
    expect(kept(dataDir, A, BASE1), "the refused session dropped the write").toHaveLength(1);
    expect(w.pendingMutations()).toHaveLength(1);
    expect(w.abandoned()).toHaveLength(0);
    expect(s.writes.map((x) => x.answered)).toEqual([503]);
    const key = s.writes[0]!.key;
    await a.stop();

    s.write = "ok";
    s.refresh = "minted";
    clock.ms += 10 * MIN; // the next sign-in, past the wait the last answer named
    const again = await launch(dataDir, s, { address: A, base: BASE1 });
    const w2 = windowOver(again.bridge, again.sidecar.servedMailboxId(), clock);
    await w2.start();
    expect(await until(10_000, () => s.writes.length === 2), "the next sign-in did not send the kept write").toBe(true);
    expect(s.writes[1], "delivered under another key, or not delivered").toEqual({ key, host: "host.test", answered: 200 });
    expect(await drive(w2)).toBeNull();
    // The drain that proves the echo deletes the row on the store's write lane, unawaited: wait for the disk.
    expect(await until(10_000, () => kept(dataDir, A, BASE1).length === 0), "a delivered write stayed on disk").toBe(true);
    expect(s.writes, "delivered twice").toHaveLength(2);
  });

  it("(4) signed out, a write is asked again for a day and never counted or given up", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-day-"); dirs.push(dataDir);
    const s: Server = { write: "ok", refresh: "minted", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await a.signOut()).status).toBe(200);
    expect((await w.mutate(VERB)).status, "a write made signed out was refused").toBe("queued");
    for (let i = 0; i < 20; i++) {
      clock.ms += 75 * MIN;
      await drive(w);
    }
    expect(writesAsked(a.asked), "control: the drives asked again").toBeGreaterThanOrEqual(20);
    expect(kept(dataDir, A, BASE1), "a day signed out spent the write's attempts").toEqual([{ attempts: 0 }]);
    expect(w.abandoned(), "a day signed out gave the write up").toHaveLength(0);
    expect(s.writes, "a write went out with no session").toEqual([]);
  });

  it("(4) control: a write the outage holds past a day is still given up, visibly", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-outage-"); dirs.push(dataDir);
    const s: Server = { write: "unreachable", refresh: "minted", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    for (let i = 0; i < 20; i++) {
      clock.ms += 75 * MIN;
      await drive(w);
    }
    expect(w.abandoned(), "the outage's day ceiling no longer holds").toHaveLength(1);
    expect(w.pendingMutations()).toHaveLength(0);
  });

  it("(5) signed out, twenty drives in 25 s ask the engine's write door once", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-spin-"); dirs.push(dataDir);
    const s: Server = { write: "ok", refresh: "minted", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await a.signOut()).status).toBe(200);
    expect((await w.mutate(VERB)).status).toBe("queued");
    const before = writesAsked(a.asked);
    for (let i = 0; i < 20; i++) {
      clock.ms += 1_250;
      await drive(w);
    }
    expect(writesAsked(a.asked) - before, "a signed-out write was re-asked on every drive").toBe(0);
    clock.ms += 30_000;
    await drive(w);
    expect(writesAsked(a.asked) - before, "control: the named wait ended and the write was asked again").toBe(1);
  });
});

describe("what the sign-out says waits", () => {
  it("(9) a change the account applies during the press's share is not said to wait", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-share-"); dirs.push(dataDir);
    const s: Server = { write: "late200", refresh: "minted", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    const pending = w.mutate(VERB);
    expect(await until(10_000, () => s.writes.length === 1)).toBe(true);
    const said = (await (await a.signOut()).json()) as { queued?: unknown };
    const result = await pending;
    expect(result.status, "control: the server applied it under the session").toBe("confirmed");
    expect(kept(dataDir, A, BASE1), "control: its row stays, for its echo, which no drain can prove now").toHaveLength(1);
    expect(said.queued, "a change the server applied was said to wait").toBe(0);
    const health = (await (await a.bridge("/health")).json()) as { queued?: unknown };
    expect(health.queued, "the card would say it waits").toEqual({ count: 0 });
  });

  it("(9) control: a change the account has not applied is counted", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-unapplied-"); dirs.push(dataDir);
    const s: Server = { write: "busy503", refresh: "minted", writes: [] };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    const said = (await (await a.signOut()).json()) as { queued?: unknown };
    expect(said.queued).toBe(1);
  });
});

describe("a kept write is its own account's, on its own server", () => {
  it("(6) A -> B -> A: B never reads or sends A's write; A's next launch delivers it once", { timeout: 90_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-aba-"); dirs.push(dataDir);
    const s: Server = { write: "busy503", refresh: "minted", writes: [] };
    const clock = { ms: Date.now() };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const firstScope = a.sidecar.servedMailboxId();
    const w = windowOver(a.bridge, firstScope, clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    const key = s.writes[0]!.key;
    expect((await a.signOut()).status).toBe(200);
    await a.stop();

    s.write = "ok";
    clock.ms += 10 * MIN;
    const b = await launch(dataDir, s, { address: B, base: BASE1 });
    const outbox = `/local/window/outbox?scope=${encodeURIComponent(b.sidecar.servedMailboxId())}`;
    expect(((await (await b.bridge(outbox)).json()) as { rows: unknown[] }).rows, "B's door served A's write").toEqual([]);
    const wb = windowOver(b.bridge, b.sidecar.servedMailboxId(), clock);
    await wb.start();
    expect(await drive(wb)).toBeNull();
    expect(s.writes.filter((x) => x.key === key), "B's session sent A's write").toHaveLength(1);
    expect(kept(dataDir, A, BASE1), "B's launch removed A's write").toHaveLength(1);
    await b.stop();

    clock.ms += 10 * MIN;
    const a2 = await launch(dataDir, s, { address: A, base: BASE1 });
    expect(a2.sidecar.servedMailboxId(), "control: the mailbox id is minted anew").not.toBe(firstScope);
    const w2 = windowOver(a2.bridge, a2.sidecar.servedMailboxId(), clock);
    await w2.start();
    expect(await until(10_000, () => s.writes.length === 2)).toBe(true);
    expect(s.writes[1], "A's write, under its key, on A's server").toEqual({ key, host: "host.test", answered: 200 });
    expect(await drive(w2)).toBeNull();
    expect(await until(10_000, () => kept(dataDir, A, BASE1).length === 0), "a delivered write stayed on disk").toBe(true);
    expect(s.writes).toHaveLength(2);
  });

  it("(6) base1 -> base2 -> base1: the other server never reads or is sent the write", { timeout: 90_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-writes-survive-servers-"); dirs.push(dataDir);
    const s: Server = { write: "busy503", refresh: "minted", writes: [] };
    const clock = { ms: Date.now() };
    const a = await launch(dataDir, s, { address: A, base: BASE1 });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    const key = s.writes[0]!.key;
    expect((await a.signOut()).status).toBe(200);
    await a.stop();

    s.write = "ok";
    clock.ms += 10 * MIN;
    const elsewhere = await launch(dataDir, s, { address: A, base: BASE2 });
    const we = windowOver(elsewhere.bridge, elsewhere.sidecar.servedMailboxId(), clock);
    await we.start();
    expect(await drive(we)).toBeNull();
    expect(s.writes.filter((x) => x.host === "other.test"), "the other server was sent the write").toEqual([]);
    expect(kept(dataDir, A, BASE2)).toHaveLength(0);
    expect(kept(dataDir, A, BASE1), "the other server's launch removed the write").toHaveLength(1);
    await elsewhere.stop();

    clock.ms += 10 * MIN;
    const back = await launch(dataDir, s, { address: A, base: BASE1 });
    const wb = windowOver(back.bridge, back.sidecar.servedMailboxId(), clock);
    await wb.start();
    expect(await until(10_000, () => s.writes.length === 2)).toBe(true);
    expect(s.writes[1]).toEqual({ key, host: "host.test", answered: 200 });
  });
});

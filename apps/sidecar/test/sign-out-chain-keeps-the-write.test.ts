import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, OhmailEngine, type EngineMutation } from "@ohmail/client-engine";

import { WindowOutboxStore } from "../../desktop/src/window-outbox-store.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * THE WINDOW'S OWN CHAIN KEEPS A WRITE ITS SESSION COULD NOT SEND: the real client engine and its
 * `WindowOutboxStore` over the real cloud engine. A write that meets a 401 after the press, a drive
 * in the signed-out gap, a session refused at the refresh door: each keeps the row on disk, and the
 * same account's next launch delivers it once, under its own key.
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
const VERB = { kind: "mark_seen", messageIds: [MSG], unread: false } as unknown as EngineMutation;

type WriteMode = "ok" | "late401" | "busy503";
interface Server { write: WriteMode; refresh: "minted" | "refused"; writes: Array<{ key: string | null; answered: number }>; refreshes: number }

function serverFetch(s: Server): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    if (url.pathname === "/messages" && method === "PATCH") {
      const row = { key: new Headers(init?.headers).get("idempotency-key"), answered: 0 };
      s.writes.push(row);
      if (s.write === "ok") { row.answered = 200; return json({ updated: 1 }); }
      if (s.write === "busy503") {
        row.answered = 503;
        return json({ error: { code: "unavailable", message: "busy", retryable: true } }, 503);
      }
      return new Promise<Response>((resolve, reject) => {
        const t = setTimeout(() => {
          row.answered = 401;
          resolve(json({ error: { code: "unauthorized", message: "authentication required" } }, 401));
        }, 1_500);
        init?.signal?.addEventListener("abort", () => { clearTimeout(t); reject(init.signal!.reason); });
      });
    }
    if (url.pathname === "/auth/refresh") {
      s.refreshes += 1;
      if (s.refresh === "refused") return json({ error: { code: "refresh_revoked", message: "revoked" } }, 401);
      return json({ tokens: { accessToken: "minted-access", refreshToken: "minted-refresh", expiresIn: 900 } });
    }
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox(MBX, "me@ohmail.test")]));
    if (url.pathname === "/sync") {
      return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "c", hasMore: false, serverTime: new Date().toISOString() });
    }
    if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
}

async function launch(dataDir: string, s: Server, tokens: { accessToken: string; refreshToken: string }) {
  const sidecar = await createCloudSidecar({
    dataDir, cloudUrl: "https://host.test", address: "me@ohmail.test", fetchImpl: serverFetch(s),
    pollIntervalMs: 3_600_000, keks: { 1: Buffer.alloc(32, 7) }, tokens,
  });
  sidecars.push(sidecar);
  // The window mounts once the account's list has named the mailbox it is scoped to.
  await sidecar.start();
  const bridge = async (path: string, init?: unknown): Promise<Response> => {
    const i = (init ?? {}) as RequestInit;
    const headers = new Headers(i.headers);
    headers.set("authorization", `Bearer ${sidecar.sessionToken}`);
    return sidecar.handle(new Request(`http://sidecar${path}`, { ...i, headers }));
  };
  const stop = async (): Promise<void> => {
    sidecars.splice(sidecars.indexOf(sidecar), 1);
    await sidecar.stop();
  };
  return { sidecar, bridge, stop };
}

function windowOver(bridge: (p: string, i?: unknown) => Promise<Response>, scope: string, clock: { ms: number }) {
  return new OhmailEngine({
    adapter: new HttpAdapter({ baseUrl: "", fetch: bridge as never }),
    store: new WindowOutboxStore({ scope, write: bridge, read: bridge }),
    now: () => new Date(clock.ms),
  });
}

/** Every outbox_entry row in every outbox file of the directory, whoever's file it is. */
const outboxRows = (dataDir: string): number => {
  let n = 0;
  for (const f of readdirSync(dataDir)) {
    if (!/^window-outbox(\.[0-9a-f]{24})?\.json$/.test(f)) continue;
    const rows = (JSON.parse(readFileSync(join(dataDir, f), "utf8")) as { rows?: Array<{ type: string }> }).rows ?? [];
    n += rows.filter((r) => r.type === "outbox_entry").length;
  }
  return n;
};
const until = async (ms: number, ok: () => boolean): Promise<boolean> => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (ok()) return true;
    await new Promise((r) => setTimeout(r, 10));
  }
  return ok();
};
const drive = (w: OhmailEngine): Promise<string | null> =>
  w.syncOnce().then(() => null, (e: { code?: string }) => e?.code ?? "threw");
const codeOf = (r: unknown): string | null => (r as { error?: { code?: string } }).error?.code ?? null;

describe("the window's own chain keeps a write its session could not send", () => {
  it("control: no press, the write is confirmed", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-chain-c0-"); dirs.push(dataDir);
    const s: Server = { write: "ok", refresh: "minted", writes: [], refreshes: 0 };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), { ms: Date.now() });
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("confirmed");
    expect(s.writes.map((x) => x.answered)).toEqual([200]);
  });

  it("a write that meets a 401 after the press is kept, and the same account's next sign-in sends it once", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-chain-c1-"); dirs.push(dataDir);
    const s: Server = { write: "late401", refresh: "minted", writes: [], refreshes: 0 };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    const pending = w.mutate(VERB);
    expect(await until(10_000, () => s.writes.length === 1)).toBe(true);
    const del = await a.bridge("/cloud/session", { method: "DELETE" });
    const r = await pending;
    expect(del.status).toBe(200);
    expect([r.status, codeOf(r)], "the window was not told its write is waiting").toEqual(["queued", "offline_read_only"]);
    expect(s.refreshes, "the press renewed the session it was ending").toBe(0);
    expect(existsSync(join(dataDir, "cloud-tokens.seal")), "a seal outlived the press").toBe(false);
    expect(outboxRows(dataDir), "the write was not kept").toBe(1);
    await a.stop();

    s.write = "ok";
    const b = await launch(dataDir, s, { accessToken: "second-access", refreshToken: "second-refresh" });
    const w2 = windowOver(b.bridge, b.sidecar.servedMailboxId(), clock);
    await w2.start();
    expect(await until(10_000, () => s.writes.length >= 2), "the next sign-in did not send it").toBe(true);
    expect(await drive(w2)).toBeNull();
    expect(await until(3_000, () => outboxRows(dataDir) === 0), "a delivered write stayed on disk").toBe(true);
    expect(s.writes.map((x) => x.answered)).toEqual([401, 200]);
    expect(s.writes[1]!.key, "delivered under another key").toBe(s.writes[0]!.key);
  });

  it("the same write, then a drive inside the signed-out gap: still kept", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-chain-c2-"); dirs.push(dataDir);
    const s: Server = { write: "late401", refresh: "minted", writes: [], refreshes: 0 };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), { ms: Date.now() });
    await w.start();
    const pending = w.mutate(VERB);
    expect(await until(10_000, () => s.writes.length === 1)).toBe(true);
    await a.bridge("/cloud/session", { method: "DELETE" });
    expect((await pending).status).toBe("queued");
    expect(outboxRows(dataDir)).toBe(1);
    expect(await drive(w), "the read still refuses: this install is signed out").toBe("not_signed_in");
    expect(outboxRows(dataDir), "the drive in the gap dropped the write").toBe(1);
    expect(w.pendingMutations()).toHaveLength(1);
    expect(w.abandoned()).toHaveLength(0);
  });

  it("a queued change, then the refresh door refuses the session: still kept", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-chain-c3-"); dirs.push(dataDir);
    const s: Server = { write: "busy503", refresh: "refused", writes: [], refreshes: 0 };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    expect(outboxRows(dataDir)).toBe(1);
    await a.bridge("/cloud/session/renew", { method: "POST" });
    const health = (await (await a.bridge("/health")).json()) as { signedIn?: boolean; sessionExpired?: boolean };
    expect(health, "control: the session was refused").toMatchObject({ signedIn: false, sessionExpired: true });
    clock.ms += 10 * 60_000;
    expect(await drive(w)).toBe("not_signed_in");
    expect(outboxRows(dataDir), "the refused session dropped the write").toBe(1);
    expect(w.pendingMutations()).toHaveLength(1);
    expect(w.abandoned()).toHaveLength(0);
    expect(s.writes.map((x) => x.answered), "a write went out with no session").toEqual([503]);
  });

  it("the refused session's kept write is delivered once, under its key, by the same account's next launch", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-chain-c4-"); dirs.push(dataDir);
    const s: Server = { write: "busy503", refresh: "refused", writes: [], refreshes: 0 };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    await a.bridge("/cloud/session/renew", { method: "POST" });
    const health = (await (await a.bridge("/health")).json()) as { sessionExpired?: boolean; queued?: { count?: number | null } };
    expect(health).toMatchObject({ sessionExpired: true, queued: { count: 1 } });
    clock.ms += 10 * 60_000;
    expect(await drive(w)).toBe("not_signed_in");
    expect(outboxRows(dataDir)).toBe(1);
    const firstKey = s.writes[0]?.key ?? null;
    await a.stop();

    s.write = "ok";
    s.refresh = "minted";
    clock.ms += 60_000; // past the 30 s wait the signed-out answer named
    const b = await launch(dataDir, s, { accessToken: "second-access", refreshToken: "second-refresh" });
    const w2 = windowOver(b.bridge, b.sidecar.servedMailboxId(), clock);
    await w2.start();
    expect(await until(8_000, () => s.writes.some((x) => x.answered === 200)), "the next launch did not send it").toBe(true);
    expect(await drive(w2)).toBeNull();
    expect(await until(3_000, () => outboxRows(dataDir) === 0), "a delivered write stayed on disk").toBe(true);
    const delivered = s.writes.filter((x) => x.answered === 200);
    expect(delivered, "not delivered exactly once").toHaveLength(1);
    expect(delivered[0]!.key, "delivered under another key").toBe(firstKey);
  });
});

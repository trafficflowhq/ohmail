import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HttpAdapter, OhmailEngine, type EngineMutation } from "@ohmail/client-engine";

import { WindowOutboxStore } from "../../desktop/src/window-outbox-store.js";
import { createCloudSidecar, type CloudSidecar } from "../src/cloud-engine.js";
import { hostedMailbox, mailboxList } from "./fixtures/hosted-mailbox.js";
import { freshDataDir } from "./_datadir.js";

/**
 * A SESSION ENDED AT THE SERVER — this desktop removed under Settings → Devices on the web, its
 * refresh lapsed — DOES NOT DELETE A WRITE. When the write itself is what meets the account's 401
 * and its renewal is refused, the window is answered the signed-out wait, keeps the row on disk,
 * and the same account's next sign-in sends it once. The server ends sessions the way the API does.
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

interface Server { revoked: boolean; busy: boolean; writes: Array<{ key: string | null; answered: number }> }

function serverFetch(s: Server): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const unauthorized = () => json({ error: { code: "unauthorized", message: "authentication required" } }, 401);
    if (url.pathname === "/messages" && method === "PATCH") {
      const row = { key: new Headers(init?.headers).get("idempotency-key"), answered: 0 };
      s.writes.push(row);
      if (s.revoked) { row.answered = 401; return unauthorized(); }
      if (s.busy) {
        row.answered = 503;
        return json({ error: { code: "unavailable", message: "busy", retryable: true } }, 503);
      }
      row.answered = 200;
      return json({ updated: 1 });
    }
    if (url.pathname === "/auth/refresh") {
      if (s.revoked) return json({ error: { code: "refresh_revoked", message: "revoked" } }, 401);
      return json({ tokens: { accessToken: "minted-access", refreshToken: "minted-refresh", expiresIn: 900 } });
    }
    if (url.pathname === "/auth/logout") return new Response(null, { status: 204 });
    if (s.revoked) return unauthorized();
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
const codeOf = (r: unknown): string | null => (r as { error?: { code?: string } }).error?.code ?? null;

describe("a write the ended session answers 401 is kept for that account", () => {
  it("control: with the session live, the write is confirmed", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-refused401-0-"); dirs.push(dataDir);
    const s: Server = { revoked: false, busy: false, writes: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), { ms: Date.now() });
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("confirmed");
    expect(s.writes.map((x) => x.answered)).toEqual([200]);
  });

  it("removed on the web, then a write: kept, counted on the card, delivered once at the next sign-in", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-refused401-1-"); dirs.push(dataDir);
    const s: Server = { revoked: false, busy: false, writes: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    s.revoked = true;
    const r = await w.mutate(VERB);
    expect([r.status, codeOf(r)], "a write the ended session answered was dropped").toEqual(["queued", "not_signed_in"]);
    expect(outboxRows(dataDir), "the row went").toBe(1);
    expect(w.abandoned()).toHaveLength(0);
    const health = (await (await a.bridge("/health")).json()) as { sessionExpired?: boolean; queued?: { count?: number | null } };
    expect(health, "the card was not told the change waits").toMatchObject({ sessionExpired: true, queued: { count: 1 } });
    const firstKey = s.writes[0]?.key ?? null;
    await a.stop();

    s.revoked = false;
    clock.ms += 10 * 60_000;
    const b = await launch(dataDir, s, { accessToken: "second-access", refreshToken: "second-refresh" });
    const w2 = windowOver(b.bridge, b.sidecar.servedMailboxId(), clock);
    await w2.start();
    expect(await until(8_000, () => s.writes.some((x) => x.answered === 200)), "the next sign-in sent nothing").toBe(true);
    expect(s.writes.map((x) => x.answered)).toEqual([401, 200]);
    expect(s.writes[1]!.key, "delivered under another key").toBe(firstKey);
  });

  it("queued under 503, then removed on the web: the replay that meets the 401 keeps it", { timeout: 60_000 }, async () => {
    const dataDir = await freshDataDir("ohmail-refused401-2-"); dirs.push(dataDir);
    const s: Server = { revoked: false, busy: true, writes: [] };
    const a = await launch(dataDir, s, { accessToken: "held-access", refreshToken: "held-refresh" });
    const clock = { ms: Date.now() };
    const w = windowOver(a.bridge, a.sidecar.servedMailboxId(), clock);
    await w.start();
    expect((await w.mutate(VERB)).status).toBe("queued");
    expect(outboxRows(dataDir)).toBe(1);
    s.busy = false;
    s.revoked = true;
    clock.ms += 10 * 60_000;
    await w.syncOnce().catch(() => undefined);
    expect(s.writes.map((x) => x.answered), "control: the replay is what met the ended session").toEqual([503, 401]);
    expect(outboxRows(dataDir), "the replay into the ended session dropped the write").toBe(1);
    expect(w.pendingMutations()).toHaveLength(1);
    expect(w.abandoned()).toHaveLength(0);
  });
});

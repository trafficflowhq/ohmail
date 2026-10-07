/** @vitest-environment jsdom */
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { createLocalEngine } from "../src/bridge-fetch.js";
import messages from "../../webapp/messages/en.json";
import { createCloudSidecar, type CloudSidecar } from "../../sidecar/src/cloud-engine.js";
import { openLocalDb, PGDATA_SUBDIR } from "../../sidecar/src/db.js";

/* jsdom's `Blob` has no `arrayBuffer()`; PGlite hands its extensions over as one. A gap in the TEST
   environment only, shimmed as `desktop-first-cloud-door.test.tsx` does. */
if (typeof (Blob.prototype as { arrayBuffer?: unknown }).arrayBuffer !== "function") {
  (Blob.prototype as unknown as { arrayBuffer: () => Promise<ArrayBuffer> }).arrayBuffer =
    function (this: Blob) {
      return new Promise<ArrayBuffer>((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result as ArrayBuffer);
        fr.onerror = () => reject(fr.error);
        fr.readAsArrayBuffer(this);
      });
    };
}

/**
 * DESKTOP-WALLED-ACCOUNT-READS-AS-OFFLINE, through the whole window over the REAL Cloud engine. The
 * account is suspended while the device still holds an open verdict, so the window paints the mail
 * and must learn of the wall from a request it relays. The engine's mirror has already pulled once
 * and met the 402. Cloud's own refusal (a 4xx with the API's error body) is Cloud reached, so the
 * mirror stays reachable, the window's reads are forwarded and meet the 402, and the lock rises. A
 * pull that reaches nothing, Cloud's own 503 and the hosting platform's own 404 page are offline: the
 * window's changes are held, uncounted, and land after.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

interface Host {
  __TAURI_INTERNALS__?: {
    invoke: (command: string, payload?: Record<string, unknown>) => Promise<unknown>;
    transformCallback: (cb: (payload: unknown) => void, once?: boolean) => number;
  };
}
const host = globalThis as unknown as Host;
const ADDRESS = "me@ohmail.test";

function encode(res: { status: number; statusText: string; headers: Headers }, body: Uint8Array): Uint8Array {
  const pairs: [string, string][] = [];
  res.headers.forEach((v, k) => pairs.push([k, v]));
  const meta = new TextEncoder().encode(JSON.stringify({ status: res.status, statusText: res.statusText, h: pairs }));
  const out = new Uint8Array(4 + meta.byteLength + body.byteLength);
  new DataView(out.buffer).setUint32(0, meta.byteLength, false);
  out.set(meta, 4);
  out.set(body, 4 + meta.byteLength);
  return out;
}

/* One `initdb` for the file, copied per case (`desktop-first-cloud-door.test.tsx`'s reason). */
let template: Promise<string> | null = null;
afterAll(async () => {
  const built = await template?.catch(() => null);
  if (built) rmSync(built, { recursive: true, force: true });
});
async function freshDataDir(tag: string): Promise<string> {
  template ??= (async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-walled-template-"));
    await (await openLocalDb(dir)).close();
    return dir;
  })();
  const built = await template;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), tag));
  cpSync(join(built, PGDATA_SUBDIR), join(dir, PGDATA_SUBDIR), { recursive: true });
  return dir;
}

type Mode = "walled" | "unreachable" | "outage" | "edge-404" | "up";

/** ohmail Cloud for one account: suspended (every product door 402, the access read refused) or gone from the network. */
function hostedCloud(mode: () => Mode) {
  let moves = 0;
  const json = (v: unknown, status = 200): Response =>
    new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw);
    if (mode() === "unreachable") throw new TypeError("fetch failed");
    const move = /^\/messages\/([^/]+)\/move$/.exec(url.pathname);
    if (move && (init?.method ?? "GET").toUpperCase() === "POST") moves += 1;
    // Cloud down: its own 503 on every route, the answer a server error gives.
    if (mode() === "outage") return json({ error: { code: "service_unavailable", message: "down" } }, 503);
    // The API gone from its host: the platform's own page on every route, plain text, no API body.
    if (mode() === "edge-404") {
      return new Response("The deployment could not be found.\n\nDEPLOYMENT_NOT_FOUND\n", {
        status: 404, headers: { "content-type": "text/plain; charset=utf-8", "x-vercel-error": "DEPLOYMENT_NOT_FOUND" },
      });
    }
    if (mode() === "up") {
      if (move) return json({ id: move[1], folder: "ohmail/News", updatedAt: "2026-10-07T10:00:00.000Z" });
      if (url.pathname === "/mailboxes") return json({ items: [] });
      if (url.pathname === "/sync/snapshot") return new Response("no snapshot", { status: 404 });
      if (url.pathname === "/sync") {
        return json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "1", hasMore: false, serverTime: "2026-10-07T10:00:00.000Z" });
      }
      if (url.pathname === "/messages/bodies") return json({ items: [], nextCursor: null });
      return json({ error: { code: "not_found", message: "not in the stand-in" } }, 404);
    }
    if (url.pathname === "/account/access") {
      return json({
        metered: true, access: "refused", reason: "suspended", canAddMailbox: false, mailboxes: 0, aiEnabled: false,
        lifecycle: { state: "closed", closedReason: "suspended", closedAt: "2026-10-07T09:00:00.000Z", erasureAt: null },
      });
    }
    return json({
      error: {
        code: "subscription_required", message: "not active",
        details: { reason: "suspended", lifecycle: { state: "closed", closedReason: "suspended", closedAt: "2026-10-07T09:00:00.000Z", erasureAt: null } },
      },
    }, 402);
  }) as unknown as typeof fetch;
  return { fetchImpl, moves: (): number => moves };
}

interface Relayed { path: string; status: number; code: string | null }

/** The shell's command channel over one serving Cloud engine; every request the window makes is recorded with its answer. */
function standInShell(engine: CloudSidecar) {
  const relayed: Relayed[] = [];
  let nextId = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => nextId++,
    invoke: async (command, payload) => {
      if (command === "engine_status") {
        return {
          state: "serving", mailboxId: engine.world.mailboxId, accountId: engine.world.accountId,
          userId: engine.world.userId, baseUrl: "http://sidecar", credentialState: engine.signedIn() ? "ready" : "absent",
          mode: "cloud", address: ADDRESS,
        };
      }
      if (command === "engine_request") {
        const bytes = new Uint8Array((payload!.body as number[]) ?? []);
        const method = String(payload!.method);
        const path = String(payload!.url);
        const res = await engine.handle(new Request(`http://sidecar${path}`, {
          method,
          headers: [...(payload!.headers as [string, string][]), ["authorization", `Bearer ${engine.sessionToken}`]],
          ...(method === "GET" || method === "HEAD" ? {} : { body: bytes }),
        }));
        const body = new Uint8Array(await res.arrayBuffer());
        let code: string | null = null;
        try { code = (JSON.parse(new TextDecoder().decode(body)) as { error?: { code?: string } }).error?.code ?? null; } catch { /* not JSON */ }
        relayed.push({ path: path.split("?")[0]!, status: res.status, code });
        return encode(res, body);
      }
      if (command === "plugin:event|listen") return nextId++;
      return null;
    },
  };
  return { relayed };
}

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  delete host.__TAURI_INTERNALS__;
  localStorage.clear();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function render(): Promise<HTMLElement> {
  mountPoint = document.createElement("div");
  document.body.appendChild(mountPoint);
  root = createRoot(mountPoint);
  await act(async () => {
    root!.render(h(IntlProvider, {
      locale: "en", messages: messages as never, timeZone: "UTC",
      children: h(ThemeProvider, { storageKey: "ohmail.theme", children: h(ToastHost, null, h(DesktopGate, null)) }),
    }));
  });
  return mountPoint;
}
const tick = async (ms = 25): Promise<void> => { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); };
async function settle(el: HTMLElement, ms: number, done: () => boolean): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && !done()) await tick();
  void el;
}
const LOCK_TITLE = (messages as unknown as { accessLock: { suspendedTitle: string } }).accessLock.suspendedTitle;

/** A Cloud engine signed in for the suspended account; its mirror's first pull has run and met the 402. */
async function walledEngine(mode: () => Mode, cloud = hostedCloud(mode)): Promise<CloudSidecar> {
  const dataDir = await freshDataDir("ohmail-walled-");
  dirs.push(dataDir);
  const engine = await createCloudSidecar({
    dataDir, cloudUrl: "https://cloud.test", address: ADDRESS,
    tokens: { accessToken: "a", refreshToken: "r" },
    fetchImpl: cloud.fetchImpl, pollIntervalMs: 3_600_000,
  });
  sidecars.push(engine);
  await engine.start();
  // This device last found the account open: the window paints the mail and asks nothing first.
  // The window's storage owner is the mailbox the engine serves (`DesktopGate`'s `mount.key`).
  localStorage.setItem(`ohmail.access.${engine.world.mailboxId}`, "open");
  return engine;
}

/** A Cloud that is down as `failing` says, then up: the window's queued move waits at the door, then lands once. */
async function heldThenLanded(failing: "outage" | "edge-404"): Promise<void> {
  let mode: Mode = failing;
  const cloud = hostedCloud(() => mode);
  const engine = await walledEngine(() => mode, cloud);
  const online = async (): Promise<boolean> => ((await (await engine.handle(new Request("http://sidecar/health", {
    headers: { authorization: `Bearer ${engine.sessionToken}` },
  }))).json()) as { online?: unknown }).online === true;
  expect(await online(), `${failing} read as reachable`).toBe(false);
  const shell = standInShell(engine);
  const local = createLocalEngine(engine.world.mailboxId);
  await local.hydrate();
  const queued = await local.mutate({ kind: "move", messageId: "m-1", folder: "ohmail/News" });
  expect(queued.status).toBe("queued");
  for (let i = 0; i < 3; i++) await local.syncOnce().catch(() => undefined);
  const attempts = shell.relayed.filter((r) => r.path === "/messages/m-1/move");
  expect(attempts.length, "the queued move was never offered to the door").toBeGreaterThanOrEqual(1);
  // `offline_read_only` is the one refusal the engine counts against nothing (engine.ts `unreachable`).
  expect(attempts.every((r) => r.status === 503 && r.code === "offline_read_only"), JSON.stringify(attempts)).toBe(true);
  expect(cloud.moves(), `the move went out during ${failing}: a counted failure, or a final refusal`).toBe(0);
  expect(local.pendingMutations().map((p) => p.mutation.kind), "the move was not held").toEqual(["move"]);

  mode = "up";
  // The mirror's failure ladder asks again within seconds; its served pull makes Cloud reachable.
  for (let waited = 0; waited < 20_000 && !(await online()); waited += 100) await new Promise((r) => setTimeout(r, 100));
  expect(await online(), "Cloud came back and the mirror stayed offline").toBe(true);
  for (let i = 0; i < 20 && cloud.moves() === 0; i++) {
    await local.syncOnce().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(cloud.moves(), "the held move did not land once after Cloud returned").toBe(1);
  for (let i = 0; i < 20 && local.pendingMutations().length > 0; i++) await new Promise((r) => setTimeout(r, 50));
  expect(local.pendingMutations(), "the landed move stayed queued").toEqual([]);
}

describe("a suspended account's desktop window meets the wall, not an offline sentence", () => {
  it("the mirror met the 402 before the window opened: the window's reads are forwarded, meet the 402, and the lock rises", { timeout: 60_000 }, async () => {
    const engine = await walledEngine(() => "walled");
    const shell = standInShell(engine);
    const el = await render();
    await settle(el, 20_000, () => (el.textContent ?? "").includes(LOCK_TITLE));
    const offline = shell.relayed.filter((r) => r.code === "offline_read_only");
    const walled = shell.relayed.filter((r) => r.status === 402 && r.code === "subscription_required");
    expect(offline, `a refused account's reads were answered offline: ${JSON.stringify(shell.relayed)}`).toEqual([]);
    expect(walled.length, `no read the window relayed met the wall: ${JSON.stringify(shell.relayed)}`).toBeGreaterThanOrEqual(1);
    expect(el.textContent, "the window showed no lock for a suspended account").toContain(LOCK_TITLE);
  });

  it("a Cloud outage (its own 503) holds a queued move at the door, uncounted, and it lands once after Cloud returns", { timeout: 60_000 }, async () => {
    await heldThenLanded("outage");
  });

  it("the hosting platform's own 404 at every route is an outage too: the move is held, uncounted, and lands once after", { timeout: 60_000 }, async () => {
    await heldThenLanded("edge-404");
  });

  it("CONTROL: a pull that reaches nothing still reads offline, and the window's relayed reads are answered offline", { timeout: 60_000 }, async () => {
    let mode: Mode = "unreachable";
    const engine = await walledEngine(() => mode);
    const health = await engine.handle(new Request("http://sidecar/health", { headers: { authorization: `Bearer ${engine.sessionToken}` } }));
    expect(((await health.json()) as { online?: unknown }).online, "a network loss did not read offline").toBe(false);
    const shell = standInShell(engine);
    const el = await render();
    await settle(el, 8_000, () => shell.relayed.some((r) => r.code === "offline_read_only"));
    expect(shell.relayed.some((r) => r.code === "offline_read_only"), `nothing was answered offline: ${JSON.stringify(shell.relayed)}`).toBe(true);
    expect(el.textContent, "a lock rose with no answer from the account").not.toContain(LOCK_TITLE);
    mode = "walled";
  });
});

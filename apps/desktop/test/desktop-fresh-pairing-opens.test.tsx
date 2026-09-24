/** @vitest-environment jsdom */
import { cpSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate, LIFECYCLE_POLL_MS } from "../src/DesktopGate.js";
import { DOOR_COPY } from "../src/door-copy.js";
import messages from "../../webapp/messages/en.json";
import { createCloudSidecar, type CloudSidecar } from "../../sidecar/src/cloud-engine.js";
import { openLocalDb, PGDATA_SUBDIR } from "../../sidecar/src/db.js";
import { FIXTURE_MAILBOX, FIXTURE_MESSAGE, hostedMailbox, messagePage } from "./fixtures/approval-server.js";

/* jsdom's `Blob` has no `arrayBuffer()`; the in-process store loads its extensions as a Blob. */
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
 * A FRESH INSTALL PAIRED THROUGH "ANOTHER COMPUTER" SHOWS THE MAIL WITHOUT A RELAUNCH — the whole
 * window over the REAL cloud engine, behind a stand-in shell that keeps the Rust shell's rule for
 * the served mailbox: recorded from `ready`, filled afterwards only by the engine's `mailbox`
 * frame, and only where `ready` left it empty. A paired `ready` names none, so the base's window
 * sat on "Opening your mailbox…" for good. Watched red: the engine's naming, the pairing's wait
 * for it, and the gate recording a delivered status before it paints.
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

const ORIGIN = "https://192.168.1.24:8443";
const PIN = "a".repeat(43);
const LINK = `${ORIGIN}/pair#k1.${PIN}.tok_xyz`;
const OWNER = "mila@ohmail.test";

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

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

/** The other computer: the redeem, its one mailbox, one message in the feed, no push stream. */
const otherComputer = (async (input: string | URL | Request): Promise<Response> => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.pathname === "/pair/redeem") {
    return json({ grant: "device-pair", tokens: { accessToken: "access-1", refreshToken: "refresh-1" } }, 200,
      { "x-ohmail-account": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
  }
  if (url.pathname === "/mailboxes") return json({ items: [hostedMailbox(FIXTURE_MAILBOX, OWNER)] });
  if (url.pathname === "/sync") return json(messagePage(OWNER));
  if (url.pathname === "/events") return json({ error: { code: "events_disabled" } }, 503);
  return json({ error: { code: "not_found", message: "not found" } }, 404);
}) as unknown as typeof fetch;

let template: Promise<string> | null = null;
afterAll(async () => {
  const built = await template?.catch(() => null);
  if (built) rmSync(built, { recursive: true, force: true });
});
async function freshDataDir(tag: string): Promise<string> {
  template ??= (async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-fresh-pair-template-"));
    await (await openLocalDb(dir)).close();
    return dir;
  })();
  const built = await template;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), tag));
  cpSync(join(built, PGDATA_SUBDIR), join(dir, PGDATA_SUBDIR), { recursive: true });
  return dir;
}

/** The shell's rules over one real engine: a configure replaces it, `ready` is read once. */
function standInShell(dataDir: string, startMs: number) {
  let engine: CloudSidecar | null = null;
  let starting: Promise<void> | null = null;
  let door: Record<string, unknown> | null = null;
  /** The served mailbox as the Rust shell holds it: `ready`'s, then an empty one filled by a frame. */
  let served = "";
  const configured: Record<string, unknown>[] = [];
  const events: { event: string; at: number }[] = [];
  const status = (): Record<string, unknown> => {
    const run = engine
      ? { state: "serving", mailboxId: served, accountId: engine.world.accountId, userId: engine.world.userId,
          baseUrl: "http://sidecar", credentialState: engine.signedIn() ? "ready" : "absent" }
      : starting ? { state: "starting", attempt: 1, of: 4 } : { state: "not_configured", missing: ["config.json"] };
    return { ...run, mode: door ? door.mode : null, ...(door ? { flavor: door.flavor, cloudUrl: door.cloudUrl } : {}) };
  };
  const configure = async (config: Record<string, unknown>): Promise<Record<string, unknown>> => {
    configured.push(config);
    door = config;
    const leaving = engine;
    engine = null;
    starting = (async () => {
      await leaving?.stop();
      if (startMs > 0) await new Promise((r) => setTimeout(r, startMs));
      const next = await createCloudSidecar({
        dataDir, cloudUrl: String(config.cloudUrl), address: null, hostPin: String(config.hostPin),
        keks: { 1: Buffer.alloc(32, 7) }, fetchImpl: otherComputer, pollIntervalMs: 3_600_000,
        log: (event: string) => { events.push({ event, at: Date.now() }); },
        onServedMailbox: async (id: string) => { if (served === "") served = id; },
      } as Parameters<typeof createCloudSidecar>[0]);
      served = next.world.mailboxId;
      engine = next;
      starting = null;
      void next.start();
    })();
    return status();
  };
  let nextId = 1;
  host.__TAURI_INTERNALS__ = {
    transformCallback: () => nextId++,
    invoke: async (command, payload) => {
      if (command === "engine_status") return status();
      if (command === "engine_configure") return configure(payload!.config as Record<string, unknown>);
      if (command === "host_candidate_probe") return { status: 200, body: { ok: true, flavor: "desktop-host", base: ORIGIN } };
      if (command === "engine_request") {
        if (!engine) throw new Error("the engine is not serving");
        const bytes = new Uint8Array((payload!.body as number[]) ?? []);
        const method = String(payload!.method);
        const res = await engine.handle(new Request(`http://sidecar${String(payload!.url)}`, {
          method,
          headers: [...(payload!.headers as [string, string][]), ["authorization", `Bearer ${engine.sessionToken}`]],
          ...(method === "GET" || method === "HEAD" ? {} : { body: bytes }),
        }));
        return encode(res, new Uint8Array(await res.arrayBuffer()));
      }
      if (command === "plugin:event|listen") return nextId++;
      return null;
    },
  };
  return {
    configured,
    events,
    async stop(): Promise<void> {
      await starting?.catch(() => undefined);
      await engine?.stop().catch(() => undefined);
    },
  };
}

let root: Root | null = null;
let mountPoint: HTMLElement | null = null;
const dirs: string[] = [];
let shell: ReturnType<typeof standInShell> | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  mountPoint?.remove();
  mountPoint = null;
  await shell?.stop();
  shell = null;
  delete host.__TAURI_INTERNALS__;
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
async function until(el: HTMLElement, what: string, test: () => boolean, ms: number, each?: () => void): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    each?.();
    if (test()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}; the window said: ${el.textContent?.slice(0, 400)}`);
}
function press(el: HTMLElement, label: string): Promise<void> {
  const found = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").trim() === label);
  if (found.length !== 1) throw new Error(`expected one button saying "${label}", found ${found.length}`);
  return act(async () => { found[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
const text = (el: HTMLElement): string => el.textContent ?? "";
const mailMounted = (el: HTMLElement): boolean => text(el).includes("Ohbox") && el.querySelector(".gate-boot") === null;

describe("a fresh pairing opens the mail the moment the paired engine serves it", () => {
  /* Twice: with the engine up at once, and held past the gate's five-second lifecycle poll, so the
     poll lands while the paired engine is still starting. */
  it.each([0, 6_000])("Another computer → the link → Pair → the mail, one configure and no relaunch (engine start held %i ms)", async (startMs) => {
    const dataDir = await freshDataDir("ohmail-fresh-pair-data-");
    dirs.push(dataDir);
    shell = standInShell(dataDir, startMs);
    const el = await render();

    await until(el, "the first-run chooser", () => text(el).includes("Which mailbox is this?"), 30_000);
    const tile = [...el.querySelectorAll(".door-tile")].find((b) => b.querySelector(".door-name")?.textContent === DOOR_COPY.doorHostName);
    await act(async () => { tile!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    await type(el, "host-link", LINK);
    await press(el, DOOR_COPY.hostCheck);
    await until(el, "the proved link", () => [...el.querySelectorAll("button")].some((b) => b.textContent?.trim() === DOOR_COPY.hostPair), 30_000);
    await press(el, DOOR_COPY.hostPair);
    /* WHAT THE WINDOW SHOWED, read on every DOM change, so a frame shorter than a tick is seen. */
    const pressed = Date.now();
    const shown: string[] = [];
    const shape = (): string => (mailMounted(el) ? "mail" : el.querySelector(".gate-boot") ? "boot" : "card");
    const watch = new MutationObserver(() => {
      const now = shape();
      if (shown[shown.length - 1]?.endsWith(now) !== true) shown.push(`${Date.now() - pressed}ms ${now}`);
    });
    watch.observe(el, { childList: true, subtree: true });

    await until(el, "the mail", () => mailMounted(el), 60_000);
    const mountedAt = Date.now();
    const paired = shell.events.find((e) => e.event === "cloud_paired");
    expect(paired, "the engine never paired").toBeDefined();
    expect(mountedAt - paired!.at, "the mail came up later than a relaunch brings it").toBeLessThanOrEqual(5_000);

    // AND IT STAYS across the gate's next lifecycle poll: never replaced by a boot frame again.
    await tick(LIFECYCLE_POLL_MS + 3_000);
    watch.disconnect();
    console.info(`FIXTURE start held ${startMs} ms: cloud_paired at ${paired!.at - pressed} ms, mail ${mountedAt - paired!.at} ms after it; shown ${shown.join(", ")}`);
    expect(shown.filter((s2) => s2.endsWith("mail")), "the mail left the screen after it had opened").toHaveLength(1);
    expect(shown[shown.length - 1]).toMatch(/ mail$/);
    expect(shell.configured.map((c) => c.flavor)).toEqual(["desktop-host"]);

    const { bridgeFetch } = await import("../src/bridge-fetch.js");
    expect((await bridgeFetch(`/messages/${FIXTURE_MESSAGE}`)).ok, "the paired engine does not serve the other computer's message").toBe(true);
  }, 150_000);
});

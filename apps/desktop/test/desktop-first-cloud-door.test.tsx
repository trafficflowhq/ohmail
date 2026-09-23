/** @vitest-environment jsdom */
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { IntlProvider } from "use-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";

import { DesktopGate } from "../src/DesktopGate.js";
import { CLOUD_URL } from "../src/doors.js";
import { DOOR_COPY, machineWord } from "../src/door-copy.js";
import messages from "../../webapp/messages/en.json";
import { createCloudSidecar, readMirrorOwner, type CloudSidecar } from "../../sidecar/src/cloud-engine.js";
import { openLocalDb, PGDATA_SUBDIR } from "../../sidecar/src/db.js";
import { approvalServer, FIXTURE_MESSAGE, type ApprovalServer } from "./fixtures/approval-server.js";

/* jsdom's `Blob` has no `arrayBuffer()`, and the store this walk opens in-process now loads its
   search extensions, which PGlite hands over as a Blob. Shimmed through jsdom's own FileReader, as
   desktop-open-attachment.test.ts does: a gap in the TEST environment only — the engine runs under
   Node in the app, where the method exists. */
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
 * A FRESH INSTALL SIGNS IN TO OHMAIL CLOUD WITH NO ADDRESS TYPED ANYWHERE — the whole window
 * over the REAL cloud engine, against a fake ohmail Cloud answering the five approval routes. The
 * stand-in shell keeps the Rust shell's rules: a pending door is not written to `config.json`, its
 * engine is reported `identityPending`, a configure replaces the engine. The browser (this test)
 * confirms, the claim writes the door, the window relaunches behind it with the address the CLAIM
 * wrote, and the gate holds the chooser saying "Signing in…" until mail mounts. Watched red: the
 * gate's hold (a boot frame during the relaunch), the gate's pending route (the unheard claim),
 * the chooser's relaunch.
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

interface Door { mode: string; cloudUrl?: string; address?: string }

/* ONE `initdb` FOR THE FILE: PGlite pays ~10 s to initialise a store, so the first case builds a
   migrated one and every case copies its PGDATA — the engine then opens it as a first launch. */
let template: Promise<string> | null = null;
afterAll(async () => {
  const built = await template?.catch(() => null);
  if (built) rmSync(built, { recursive: true, force: true });
});
async function freshDataDir(tag: string): Promise<string> {
  template ??= (async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-first-door-template-"));
    await (await openLocalDb(dir)).close();
    return dir;
  })();
  const built = await template;
  const dir = mkdtempSync(join(realpathSync(tmpdir()), tag));
  cpSync(join(built, PGDATA_SUBDIR), join(dir, PGDATA_SUBDIR), { recursive: true });
  return dir;
}

/** The shell's rules over real engines: one data directory, one door file, one engine at a time. */
function standInShell(
  root: string,
  dataDir: string,
  server: ApprovalServer,
  onOpen: (request: string) => void,
  onLink: (challenge: string) => void = () => undefined,
  /** How long an addressed engine takes to come up — past the gate's own lifecycle poll, when set. */
  relaunchMs = 0,
) {
  const doorFile = join(root, "config.json");
  let engine: CloudSidecar | null = null;
  let starting: Promise<void> | null = null;
  let pendingDoor = false;
  const configured: Record<string, unknown>[] = [];
  const readDoor = (): Door | null => {
    try { return JSON.parse(readFileSync(doorFile, "utf8")) as Door; } catch { return null; }
  };
  const status = (): Record<string, unknown> => {
    const door = readDoor();
    const run = engine
      ? { state: "serving", mailboxId: engine.world.mailboxId, accountId: engine.world.accountId,
          userId: engine.world.userId, baseUrl: "http://sidecar", credentialState: engine.signedIn() ? "ready" : "absent" }
      : starting ? { state: "starting", attempt: 1, of: 4 } : { state: "not_configured", missing: ["config.json"] };
    return {
      ...run,
      mode: door ? door.mode : null,
      ...(door?.address ? { address: door.address } : {}),
      ...(pendingDoor ? { identityPending: true } : {}),
    };
  };
  const configure = async (config: Record<string, unknown>): Promise<Record<string, unknown>> => {
    configured.push(config);
    const pending = config.identityPending === true;
    if (pending) {
      if (readDoor()) throw new Error("this install already has a door");
      rmSync(doorFile, { force: true });
    } else {
      writeFileSync(doorFile, JSON.stringify({ mode: "cloud", cloudUrl: config.cloudUrl, address: config.address }));
    }
    pendingDoor = pending;
    const leaving = engine;
    engine = null;
    starting = (async () => {
      await leaving?.stop();
      if (!pending && relaunchMs > 0) await new Promise((r) => setTimeout(r, relaunchMs));
      const next = await createCloudSidecar({
        dataDir, cloudUrl: String(config.cloudUrl), address: pending ? null : String(config.address),
        ...(pending ? { identityPending: { doorFile } } : {}),
        keks: { 1: Buffer.alloc(32, 7) }, fetchImpl: server.fetchImpl, pollIntervalMs: 3_600_000,
      });
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
      if (command === "open_link") {
        if (payload?.key === "approve") onOpen(String(payload.request));
        if (payload?.key === "link-desktop") onLink(String(payload.challenge));
        return null;
      }
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
    doorFile,
    /** Until the engine behind the last configure is serving — for set-up done outside the window. */
    async served(): Promise<void> {
      await starting;
    },
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
async function until(el: HTMLElement, what: string, test: () => boolean, ms = 30_000, each?: () => void): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    each?.();
    if (test()) return;
    await tick();
  }
  throw new Error(`timed out waiting for ${what}; the window said: ${el.textContent?.slice(0, 400)}`);
}
function press(el: HTMLElement, label: string): Promise<void> {
  const found = [...el.querySelectorAll("button")].filter((b) => (b.textContent ?? "").includes(label));
  if (found.length !== 1) throw new Error(`expected one button saying "${label}", found ${found.length}`);
  return act(async () => { found[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
const text = (el: HTMLElement): string => el.textContent ?? "";
const mailMounted = (el: HTMLElement): boolean => text(el).includes("Ohbox");
async function type(el: HTMLElement, id: string, value: string): Promise<void> {
  const input = el.querySelector<HTMLInputElement>(`#${id}`);
  if (!input) throw new Error(`no field #${id} on screen`);
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
async function pickCloud(el: HTMLElement): Promise<void> {
  await until(el, "the first-run chooser", () => text(el).includes("Which mailbox is this?"));
  const tile = [...el.querySelectorAll(".door-tile")].find((b) => b.querySelector(".door-name")?.textContent === "ohmail Cloud");
  await act(async () => { tile!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
}
async function fresh(tag: string): Promise<{ root: string; dataDir: string }> {
  const root0 = mkdtempSync(join(realpathSync(tmpdir()), `ohmail-${tag}-`));
  const dataDir = await freshDataDir(`ohmail-${tag}-data-`);
  dirs.push(root0, dataDir);
  return { root: root0, dataDir };
}

describe("a fresh install's Cloud door is one motion", () => {
  /* Twice: as the engine comes up here, which is the figure the report names, and with the
     relaunch held past the gate's five-second lifecycle poll, so the poll lands while the adopted
     engine is still starting — the moment a boot frame would replace the chooser. */
  it.each([0, 6_000])("chooser → Sign in with browser → confirm → mail, no address typed, the relaunch invisible (held %i ms)", async (relaunchMs) => {
    const root0 = mkdtempSync(join(realpathSync(tmpdir()), "ohmail-first-door-"));
    const dataDir = await freshDataDir("ohmail-first-door-data-");
    dirs.push(root0, dataDir);
    const server = approvalServer(CLOUD_URL);
    let confirmedAt = 0;
    shell = standInShell(root0, dataDir, server, (request) => {
      // THE BROWSER: the page reads the request and the person presses Confirm.
      void server.read(request).then(() => server.confirm(request)).then(() => { confirmedAt = Date.now(); });
    }, undefined, relaunchMs);

    const el = await render();
    await pickCloud(el);
    // The first press on the Cloud door: no field at all.
    expect(el.querySelector("#cloud-address"), "the first-run Cloud door asked for an address").toBeNull();
    expect(el.querySelector("input"), "the first-run Cloud door showed a field").toBeNull();
    await press(el, "Sign in with browser");

    let sawSigningIn = false;
    let heldBroken: string | null = null;
    await until(el, "the mail", () => mailMounted(el), 60_000, () => {
      if (el.querySelector("#cloud-address")) heldBroken = "an address field appeared";
      const t = text(el);
      if (t.includes("Signing in…")) sawSigningIn = true;
      // FROM THE CLAIM ON: the chooser stays until the mail — no boot frame, no second chooser.
      if (sawSigningIn && !mailMounted(el)) {
        if (el.querySelector(".gate-boot")) heldBroken ??= "a boot frame replaced the held chooser";
        if (t.includes("Which mailbox is this?")) heldBroken ??= "the chooser started over";
        if (!t.includes("Signing in…")) heldBroken ??= "the held chooser stopped saying it is signing in";
      }
    });
    const mountedAt = Date.now();
    expect(heldBroken).toBeNull();
    expect(sawSigningIn, "the window never said it was signing in").toBe(true);

    // The two configures: the pending door with NO address, then the relaunch behind the door the
    // claim wrote — carrying exactly the account the session named, which nobody typed.
    const [first, second, ...more] = shell.configured;
    expect(first).toEqual({ mode: "cloud", cloudUrl: CLOUD_URL, identityPending: true });
    expect(second).toEqual({ mode: "cloud", cloudUrl: CLOUD_URL, address: server.browser });
    expect(more).toEqual([]);
    expect(JSON.parse(readFileSync(shell.doorFile, "utf8"))).toMatchObject({ mode: "cloud", address: server.browser });
    expect(readMirrorOwner(dataDir)).toBe(server.browser);
    expect(existsSync(join(dataDir, "cloud-tokens.seal"))).toBe(true);

    // THE FIRST DRAIN RAN: the relaunched engine serves the fixture's message over the bridge.
    const { bridgeFetch } = await import("../src/bridge-fetch.js");
    let firstMailAt = 0;
    await until(el, "the first message", () => firstMailAt > 0, 30_000, () => {
      void bridgeFetch(`/messages/${FIXTURE_MESSAGE}`).then((r) => { if (r.ok && firstMailAt === 0) firstMailAt = Date.now(); }, () => undefined);
    });
    const health = (await (await bridgeFetch("/health")).json()) as Record<string, unknown>;
    expect(health).toMatchObject({ mode: "cloud", signedIn: true, identityPending: false });
    console.info(
      `FIXTURE held ${relaunchMs} ms: confirm->mail mounted ${mountedAt - confirmedAt} ms; confirm->first message served ${Math.max(firstMailAt, mountedAt) - confirmedAt} ms (the 2000 ms claim-poll cadence included)`,
    );
  }, 120_000);
  it("a claim the window never heard is finished by the next press, never asked again", async () => {
    const { root: r, dataDir } = await fresh("orphan");
    const server = approvalServer(CLOUD_URL);
    shell = standInShell(r, dataDir, server, () => undefined);
    // The pending engine claimed and wrote its door, and the window that asked went away.
    await host.__TAURI_INTERNALS__!.invoke("engine_configure", { config: { mode: "cloud", cloudUrl: CLOUD_URL, identityPending: true } });
    await shell.served();
    const { bridgeFetch } = await import("../src/bridge-fetch.js");
    const post = (path: string, body: unknown) =>
      bridgeFetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const { approvalId } = (await (await post("/cloud/signin/approval", {})).json()) as { approvalId: string };
    await server.confirm(approvalId);
    expect((await (await post("/cloud/signin", { approval: true })).json())).toMatchObject({ adopted: true });

    const el = await render();
    await pickCloud(el);
    expect(text(el)).not.toContain(DOOR_COPY.cloudLeadSignIn(machineWord()));
    await press(el, "Sign in with browser");
    await until(el, "the mail", () => mailMounted(el), 60_000);
    expect(shell.configured).toEqual([
      { mode: "cloud", cloudUrl: CLOUD_URL, identityPending: true },
      { mode: "cloud", cloudUrl: CLOUD_URL, address: server.browser },
    ]);
  }, 120_000);

  it("another account's copy here: refused with its sentence, and the address is the way on", async () => {
    const { root: r, dataDir } = await fresh("owned");
    writeFileSync(join(dataDir, "mirror-owner"), JSON.stringify({ address: "first@ohmail.test", base: CLOUD_URL, account: null }));
    const server = approvalServer(CLOUD_URL, "second@ohmail.test");
    shell = standInShell(r, dataDir, server, (request) => { void server.confirm(request); });
    const el = await render();
    await pickCloud(el);
    await press(el, "Sign in with browser");
    await until(el, "the refusal", () => text(el).includes(DOOR_COPY.cloudApproveOwned(machineWord())), 30_000);
    expect(el.querySelector("#cloud-address"), "the refusal offered no way on").not.toBeNull();
    expect(existsSync(shell.doorFile), "a refused claim wrote a door").toBe(false);
    expect(readMirrorOwner(dataDir)).toBe("first@ohmail.test");
  }, 120_000);

  it("a denied and an expired request each render their own sentence", async () => {
    const { root: r, dataDir } = await fresh("ended");
    const server = approvalServer(CLOUD_URL);
    let ending: "deny" | "expire" = "deny";
    shell = standInShell(r, dataDir, server, (request) => {
      if (ending === "deny") void server.deny(request);
      else server.expire(request);
    });
    const el = await render();
    await pickCloud(el);
    await press(el, "Sign in with browser");
    await until(el, "the declined sentence", () => text(el).includes(DOOR_COPY.cloudApproveDenied), 30_000);
    ending = "expire";
    await press(el, "Sign in with browser");
    await until(el, "the expired sentence", () => text(el).includes(DOOR_COPY.cloudApproveExpired), 30_000);
    expect(existsSync(shell.doorFile)).toBe(false);
  }, 120_000);

  it("the control: the code fallback still asks for the address, and still signs in", async () => {
    const { root: r, dataDir } = await fresh("code");
    const server = approvalServer(CLOUD_URL);
    let minted: string | null = null;
    shell = standInShell(r, dataDir, server, () => undefined, (challenge) => {
      void server.mintCode(challenge).then((code) => { minted = code; });
    });
    const el = await render();
    await pickCloud(el);
    await press(el, DOOR_COPY.cloudSignInWithCode);
    expect(el.querySelector("#cloud-address"), "the code path asked for no address").not.toBeNull();
    await type(el, "cloud-address", server.browser);
    await press(el, DOOR_COPY.cloudOpenBrowser);
    await until(el, "a code from the page", () => minted !== null, 30_000);
    await type(el, "cloud-handoff", minted!);
    await press(el, DOOR_COPY.signIn);
    await until(el, "the mail", () => mailMounted(el), 60_000);
    expect(shell.configured).toEqual([{ mode: "cloud", cloudUrl: CLOUD_URL, address: server.browser }]);
  }, 120_000);
});

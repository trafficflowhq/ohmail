/**
 * THE DOOR'S PAGE AS THE BUILD WRITES IT, AND ITS SIDE OF THE BRIDGE. The page states the scoped page's policy word
 * for word and runs no inline script; its bundle is its own and holds nothing of the scoped page's engine, kept
 * stores or storage owner, and nothing of another app; served as the native door serves it, it asks native what it
 * is, draws the doors' stage, says it drew, and reads and writes no storage. Over the bridge a kind's fields cross
 * nested, a refusal stays a refusal, and a state of a page that ended is dropped.
 */
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";
import { readDoorRequest, type DoorConfig, type DoorState } from "../src/shell/door-kinds";
import { BENCH_MARKER, DOOR_NAMESPACES, buildShell, pageCatalogue, policyOf } from "../scripts/build-shell.mjs";
import { BridgeRefused, createDoorBridge } from "../web/src/door/bridge";
import { doorHandle } from "../web/src/door/handle";
import type { PagePort } from "../web/src/port";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; " +
  "connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));
/** The one file of the engine the door's page holds: the provider table the connect form reads, a leaf. */
const PROVIDER_LEAF = "packages/client-engine/src/providers.ts";

const STATE: DoorState = {
  session: "none", migrating: null, said: null, openId: null, syncing: false, syncSaid: null, syncStopped: null, pinned: false, total: null, paired: [], after: null,
};
const CONFIG: DoorConfig = {
  app: "ohmail", os: "android", pad: false, language: "en", build: { version: "2.0.0", commit: null }, at: "welcome",
  organizes: "offered", canPin: true,
  facts: { posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 }, keyboard: { height: 0 }, online: true },
  state: STATE,
};

const out = mkdtempSync(join(tmpdir(), "door-page-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));
let building: ReturnType<typeof buildShell> | null = null;
const built = () => (building ??= buildShell({ out }));

describe("the door's page, built", () => {
  it("states the page's policy, once, word for word, with no inline script, and is listed with its digest", async () => {
    const manifest = await built();
    const html = readFileSync(join(out, "door.html"), "utf8");
    expect(policyOf(html)).toBe(POLICY);
    expect(policyOf(html)).toBe(manifest.csp);
    expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts).toHaveLength(1);
    expect(scripts[0]![1]).toMatch(/src="\.\/door\.js"/);
    expect(scripts[0]![2]!.trim()).toBe("");
    expect(manifest.pages).toEqual({ shell: "index.html", door: "door.html" });
    for (const name of ["door.html", "door.js"]) {
      expect(manifest.files[name], name).toBe(createHash("sha256").update(readFileSync(join(out, name))).digest("hex"));
    }
    // The page's own markup still names its own bundle alone.
    expect(readFileSync(join(out, "index.html"), "utf8")).not.toContain("door.js");
  }, 120_000);

  it("is a bundle of its own: no input from the scoped page's start, engine, kept stores or owner, none of another app", async () => {
    const { doorInputs, inputs } = await built();
    const scoped = /^apps\/mobile\/web\/src\/(boot|engine|engine-package|kept-storage|kept-store|owner|old-copy|bridge-fetch|account-guard|host|page|main|bench)\.tsx?$/;
    expect(doorInputs.filter((p: string) => scoped.test(p))).toEqual([]);
    expect(doorInputs.filter((p: string) => /^apps\/(webapp|desktop|paired-page|sidecar|worker|server)\//.test(p))).toEqual([]);
    // Of the engine, the provider table alone: the connect form reads it, and the next case holds that it imports nothing.
    expect(doorInputs.filter((p: string) => /^packages\/(client-engine|core|db|db-mail|services|api|testing)\//.test(p) && p !== PROVIDER_LEAF)).toEqual([]);
    // The census reads a real list: the door's own files and the doors' stage are in it, and the scoped page's has the engine.
    expect(doorInputs).toContain("apps/mobile/web/src/door/main.tsx");
    expect(doorInputs).toContain("apps/mobile/web/src/door/pages.tsx");
    expect(doorInputs.some((p: string) => p.startsWith("packages/app/src/doors/stage/"))).toBe(true);
    expect(inputs.some((p: string) => scoped.test(p))).toBe(true);
    expect(inputs).not.toContain("apps/mobile/web/src/door/main.tsx");
    expect(readFileSync(join(out, "door.js"), "utf8")).not.toContain(BENCH_MARKER);
    expect((await buildShell({ out: join(out, "bench"), bench: true })).doorInputs.filter((p: string) => scoped.test(p))).toEqual([]);
    expect(readFileSync(join(out, "bench", "door.js"), "utf8")).not.toContain(BENCH_MARKER);
    expect(DOOR_NAMESPACES).toEqual(["phoneDoor", "phoneRefusal", "servers", "providerPicker", "mailboxes"]);
  }, 120_000);

  it("may hold the provider table because that file imports nothing: built alone, it names no import and is its bundle's one input", async () => {
    // Read as the census reads the page, off what the bundler took: a comment that names a path changes nothing.
    const { metafile } = await build({
      absWorkingDir: ROOT, entryPoints: [PROVIDER_LEAF], bundle: true, write: false, metafile: true,
      format: "esm", platform: "browser", conditions: ["ohmail-source"], logLevel: "silent",
    });
    expect(metafile.inputs[PROVIDER_LEAF]?.imports, "the provider table imports something: the door's page would carry it").toEqual([]);
    expect(Object.keys(metafile.inputs)).toEqual([PROVIDER_LEAF]);
  });

  /**
   * The native side as the door's page sees it, and a watch on the four doors to storage, in before any script of the
   * page's. Reads are watched too: the door's web view shares the scoped page's origin and storage, so a door page
   * that read them could read the last account's kept words.
   */
  function nativeDouble({ config, refuseScope }: { config: DoorConfig; refuseScope?: string }) {
    const w = window as unknown as Record<string, unknown>;
    const asked: string[] = [];
    const touched: string[] = [];
    const listeners: ((e: { data: string }) => void)[] = [];
    const imported: unknown[] = [];
    const ready: unknown[] = [];
    w.__native = { asked, touched, ...(config.app === "ohcal" ? { imported, ready } : {}) };
    for (const verb of ["getItem", "key", "setItem", "removeItem", "clear"] as const) {
      const real = Storage.prototype[verb];
      Storage.prototype[verb] = function (this: Storage, ...args: unknown[]) {
        touched.push(`${this === sessionStorage ? "session" : "local"}.${verb}`);
        return (real as (...a: unknown[]) => unknown).apply(this, args);
      } as never;
    }
    for (const verb of ["open", "deleteDatabase"] as const) {
      const real = IDBFactory.prototype[verb];
      IDBFactory.prototype[verb] = function (this: IDBFactory, ...args: unknown[]) {
        touched.push(`indexedDB.${verb}`);
        return (real as (...a: unknown[]) => unknown).apply(this, args);
      } as never;
    }
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie")!;
    Object.defineProperty(document, "cookie", {
      get: () => cookie.get!.call(document),
      set: (value: string) => {
        touched.push("cookie");
        cookie.set!.call(document, value);
      },
    });
    w.ohmailShell = {
      postMessage(text: string) {
        const m = JSON.parse(text) as { id: number; epoch: string; kind: string; ask?: { legacy?: boolean; puts?: unknown[]; scope?: string } };
        asked.push(m.kind);
        if (m.kind === "keepRows" && m.ask?.legacy === true) imported.push(...(m.ask.puts ?? []));
        if (m.kind === "ready") ready.push(m.ask);
        const answer = { id: m.id, epoch: m.epoch, ok: true,
          answer: m.kind === "config" ? config : m.kind === "keepRows" ? { kept: m.ask?.legacy === true && m.ask.scope !== refuseScope } : {} };
        setTimeout(() => { for (const l of listeners) l({ data: JSON.stringify(answer) }); }, 0);
      },
      addEventListener(_t: string, l: (e: { data: string }) => void) { listeners.push(l); },
      removeEventListener() {},
    };
  }

  it("served as native serves it: asks what it is, draws the stage, says it drew, asks no address and reads and writes no storage", async () => {
    const manifest = await built();
    const outside: string[] = [];
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://door").pathname;
      const name = path.replace(/^\/shell\//, "");
      if (path.startsWith("/shell/") && manifest.files[name]) {
        const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html";
        res.writeHead(200, { "content-type": type, "content-security-policy": `${manifest.csp}; frame-ancestors 'none'` });
        res.end(readFileSync(join(out, name)));
        return;
      }
      outside.push(path);
      res.writeHead(403);
      res.end();
    }).listen(0, "127.0.0.1");
    await new Promise((r) => (server.listening ? r(null) : server.once("listening", r)));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch();
    try {
      const context = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const left: string[] = [];
      const faults: string[] = [];
      page.on("request", (r) => { if (!r.url().startsWith(`${origin}/shell/`)) left.push(r.url()); });
      page.on("pageerror", (e) => faults.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") faults.push(m.text()); });
      await page.addInitScript(nativeDouble, { config: CONFIG });
      await page.goto(`${origin}/shell/door.html?epoch=e1`);
      type Seen = { __native: { asked: string[]; touched: string[] } };
      await page.waitForFunction(() => (window as unknown as Seen).__native.asked.includes("ready"));
      const seen = await page.evaluate(() => ({
        ...(window as unknown as Seen).__native,
        stage: document.querySelectorAll("#root > *").length,
        words: document.body.innerText.trim(),
        stamped: document.documentElement.hasAttribute("data-device") || document.documentElement.getAttributeNames().some((n) => n.startsWith("data-")),
      }));
      expect(seen.asked).toEqual(["config", "ready"]);
      expect(seen.touched).toEqual([]);
      expect(seen.stage).toBe(1);
      expect(seen.stamped).toBe(true);
      // Its first page is the ways in: the first screen says the app's one sentence (its full stop drawn as the dot).
      const { phoneDoor: first } = pageCatalogue(undefined, DOOR_NAMESPACES).en as typeof import("../../../packages/app/messages/phone.en.json");
      expect(seen.words).toContain(first.welcome.line.ohmail.replace(/\.$/, ""));
      const scan = page.getByRole("button", { name: first.welcome.scan, exact: true });
      const signIn = page.getByRole("button", { name: first.welcome.signIn, exact: true });
      const selfHosted = page.getByRole("button", { name: first.welcome.signInSelfHosted, exact: true });
      await selfHosted.waitFor();
      const [qr, cloud, own] = await Promise.all([scan.boundingBox(), signIn.boundingBox(), selfHosted.boundingBox()]);
      expect(own!.y).toBeGreaterThanOrEqual(Math.max(qr!.y + qr!.height, cloud!.y + cloud!.height));
      expect(own!.x + own!.width / 2).toBeCloseTo((qr!.x + cloud!.x + cloud!.width) / 2, 0);
      await selfHosted.focus({ timeout: 2_000 });
      await page.keyboard.press("Enter");
      await page.getByRole("textbox", { name: first.server.label }).waitFor();
      await page.getByRole("button", { name: first.back, exact: true }).click();
      await selfHosted.waitFor();
      expect(await page.evaluate(() => (window as unknown as Seen).__native)).toEqual({ asked: ["config", "ready"], touched: [] });
      expect(left).toEqual([]);
      expect(outside).toEqual([]);
      expect(faults).toEqual([]);
    } finally {
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  }, 180_000);

  it.each(["upgrade", "erasure"] as const)("prepares legacy queues through the local chooser during %s", async (kind) => {
    const calendarOut = join(out, "calendar");
    const manifest = await buildShell({ app: "ohcal", out: calendarOut });
    const server = createServer((req, res) => {
      const name = (req.url ?? "").split("?")[0]?.replace(/^\//, "") ?? "";
      if (!manifest.files[name]) { res.end("<html></html>"); return; }
      const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html";
      res.writeHead(200, { "content-type": type, "content-security-policy": manifest.csp });
      res.end(readFileSync(join(calendarOut, name)));
    }).listen(0, "127.0.0.1");
    await new Promise((done) => server.listening ? done(null) : server.once("listening", done));
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.goto(origin);
      const erased = "p" + "a".repeat(32);
      const other = "p" + "b".repeat(32);
      const seed = (owner: string, edit: string) => page.evaluate(async ({ owner, edit }) => {
        localStorage.setItem("ohmail.ui.reply:" + owner, "Private draft");
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open("ohmail-mirror:" + owner, 1);
          request.onupgradeneeded = () => {
            request.result.createObjectStore("entities");
            request.result.createObjectStore("meta");
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const tx = database.transaction("entities", "readwrite");
        const rows = tx.objectStore("entities");
        rows.put({ id: edit, type: "calendar_outbox", seq: 0, entity: { act: { kind: "calendar_event_delete" } } }, "calendar_outbox:" + edit);
        rows.put({ id: "calendar", type: "calendar", seq: 1, entity: { name: "Old calendar" } }, "calendar:calendar");
        rows.put({ id: "letter", type: "message", seq: 1, entity: { subject: "Private mail" } }, "message:letter");
        await new Promise<void>((resolve, reject) => {
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        database.close();
      }, { owner, edit });
      await seed(erased, "edit");
      if (kind === "erasure") await seed(other, "other-edit");
      const config = { ...CONFIG, app: "ohcal" as const, organizes: "withheld" as const,
        ...(kind === "erasure" ? { erasedCalendarScopes: [erased] } : {}) };
      await page.addInitScript(nativeDouble, { config, ...(kind === "erasure" ? { refuseScope: other } : {}) });
      await page.goto(`${origin}/door.html?epoch=calendar-door`);
      type Seen = { __native: { asked: string[]; imported: { type: string; id: string }[]; ready: unknown[] } };
      await page.waitForFunction(() => (window as unknown as Seen).__native.asked.includes("ready"));
      const { asked, imported, ready } = await page.evaluate(() => (window as unknown as Seen).__native);
      if (kind === "erasure") {
        expect(await page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name)))
          .toEqual(["ohmail-mirror:" + other]);
        expect(await page.evaluate((owner) => new Promise((resolve, reject) => {
          const open = indexedDB.open("ohmail-mirror:" + owner);
          open.onerror = () => reject(open.error);
          open.onsuccess = () => {
            const read = open.result.transaction("entities").objectStore("entities").get("calendar_outbox:other-edit");
            read.onsuccess = () => { open.result.close(); resolve(read.result); };
            read.onerror = () => { open.result.close(); reject(read.error); };
          };
        }), other)).toMatchObject({ id: "other-edit", type: "calendar_outbox" });
        expect(imported).toMatchObject([{ type: "calendar_outbox", id: "other-edit" }]);
        expect(imported).toHaveLength(1);
        expect(ready).toEqual([{ calendarPrepared: false }]);
        return;
      }
      expect(asked).toEqual(["config", "keepRows", "ready"]);
      expect(imported).toMatchObject([{ type: "calendar_outbox", id: "edit" }]);
      expect(imported).toHaveLength(1);
      expect(await page.evaluate(() => Object.values(localStorage).includes("Private draft"))).toBe(false);
    } finally {
      await browser.close();
      await new Promise((done) => server.close(done));
    }
  }, 120_000);

});

/** A native double for the page's bridge: reads each request through the door's own guard and answers with `reply`. */
function native(epoch: string, reply: (kind: string, ask: Record<string, unknown>) => object | null) {
  const toPage = new Set<(text: string) => void>();
  const seen: Record<string, unknown>[] = [];
  const send = (text: string) => queueMicrotask(() => toPage.forEach((take) => take(text)));
  const port: PagePort = {
    post(text) {
      const m = JSON.parse(text) as Record<string, unknown>;
      const req = readDoorRequest(m);
      if ("refused" in req) throw new Error(`the door's guard refused a page request: ${req.refused}`);
      seen.push(m);
      const answer = reply(req.kind, req.ask as Record<string, unknown>);
      if (answer !== null) send(JSON.stringify({ ...answer, id: m.id, epoch }));
    },
    listen(take) {
      toPage.add(take);
      return () => toPage.delete(take);
    },
  };
  return { port, seen, send };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe("the door page's side of its bridge", () => {
  it("posts a kind's fields nested, so a row's id and a press's ok are not the envelope's", async () => {
    const door = native("e1", (kind, ask) =>
      kind === "switch" ? { ok: true, answer: { ok: false, said: { code: "notPairedHere", args: [ask.id] } } } : { ok: true, answer: { k: "gone", after: null } });
    const bridge = createDoorBridge(door.port, "e1");
    expect(await bridge.request("switch", { id: "row-7" })).toEqual({ ok: false, said: { code: "notPairedHere", args: ["row-7"] } });
    expect(await bridge.request("forget", { id: "row-7", anyway: true })).toEqual({ k: "gone", after: null });
    expect(door.seen[0]).toMatchObject({ kind: "switch", ask: { id: "row-7" } });
    expect(typeof door.seen[0]!.id).toBe("number");
  });

  it("reads a refusal as a refusal, and an answer that carries no answer as one too", async () => {
    const refusing = createDoorBridge(native("e1", () => ({ ok: false, refused: "unknownKind" })).port, "e1");
    await expect(refusing.request("pair", { ticket: "0".repeat(32) })).rejects.toEqual(new BridgeRefused("unknownKind"));
    const empty = createDoorBridge(native("e1", () => ({ ok: true })).port, "e1");
    await expect(empty.request("pair", { ticket: "0".repeat(32) })).rejects.toEqual(new BridgeRefused("malformed"));
  });

  it("an answer whose ok is the string 'true' is a refusal", async () => {
    const stringly = createDoorBridge(native("e1", () => ({ ok: "true", answer: { ok: true } })).port, "e1");
    await expect(stringly.request("pair", { ticket: "0".repeat(32) })).rejects.toEqual(new BridgeRefused("malformed"));
  });

  it("draws the last state native told it and drops a state of a page that ended", async () => {
    const door = native("e2", (kind) => (kind === "config" ? { ok: true, answer: CONFIG } : { ok: true, answer: {} }));
    const bridge = createDoorBridge(door.port, "e2");
    const handle = doorHandle(bridge, await bridge.request("config", {}));
    const row = { id: "row-1", kind: "server", address: "https://mail.example.test", account: "account-1", open: true, needsPair: false };
    door.send(JSON.stringify({ type: "state", epoch: "e2", state: { ...STATE, session: "live", openId: "row-1", paired: [row] } }));
    await tick();
    expect(handle.state.read().paired).toEqual([row]);
    // The pairing was forgotten: the next state holds no row of it, and nothing of the last one is kept.
    door.send(JSON.stringify({ type: "state", epoch: "e2", state: STATE }));
    await tick();
    expect(handle.state.read()).toEqual(STATE);
    door.send(JSON.stringify({ type: "state", epoch: "e1", state: { ...STATE, session: "live", openId: "row-1", paired: [row] } }));
    await tick();
    expect(handle.state.read()).toEqual(STATE);
    expect(bridge.dropped()).toBe(1);
  });

  it("holds its route in memory, hands a scan to whoever listens, and answers back by its newest handler", async () => {
    const door = native("e3", (kind) => (kind === "config" ? { ok: true, answer: CONFIG } : { ok: true, answer: {} }));
    const bridge = createDoorBridge(door.port, "e3");
    const handle = doorHandle(bridge, await bridge.request("config", {}));
    expect(handle.route.read()).toBe("welcome");
    handle.go("servers");
    expect(handle.route.read()).toBe("servers");
    const scans: unknown[] = [];
    const off = handle.onScan((scan) => scans.push(scan));
    door.send(JSON.stringify({ type: "scan", epoch: "e3", scan: { k: "notACode" } }));
    await tick();
    off();
    door.send(JSON.stringify({ type: "scan", epoch: "e3", scan: { k: "notACode" } }));
    await tick();
    expect(scans).toEqual([{ k: "notACode" }]);
    door.send(JSON.stringify({ type: "ask", epoch: "e3", askId: 4, what: "back" }));
    await tick();
    expect(door.seen.at(-1)).toMatchObject({ kind: "answer", ask: { askId: 4, what: "back", took: false } });
    handle.back.subscribe(() => true);
    door.send(JSON.stringify({ type: "ask", epoch: "e3", askId: 5, what: "back" }));
    await tick();
    expect(door.seen.at(-1)).toMatchObject({ kind: "answer", ask: { askId: 5, took: true } });
  });

  it("gives back an offer the camera told after its step stopped listening: one dismiss, none for a step that hears it", async () => {
    const door = native("e4", (kind) => (kind === "config" ? { ok: true, answer: CONFIG } : { ok: true, answer: {} }));
    const bridge = createDoorBridge(door.port, "e4");
    const handle = doorHandle(bridge, await bridge.request("config", {}));
    const offer = (ticket: string) => JSON.stringify({
      type: "scan", epoch: "e4", scan: { k: "offers", ticket, facts: { what: "server", address: "https://mail.example.test", key: null } },
    });
    const dismissed = () => door.seen.filter((m) => m.kind === "dismiss").map((m) => m.ask);
    door.send(offer("a".repeat(32)));
    door.send(JSON.stringify({ type: "scan", epoch: "e4", scan: { k: "notACode" } }));
    await tick();
    expect(dismissed()).toEqual([{ ticket: "a".repeat(32) }]);
    const heard: unknown[] = [];
    handle.onScan((scan) => heard.push(scan));
    door.send(offer("b".repeat(32)));
    await tick();
    expect(heard).toHaveLength(1);
    expect(dismissed()).toEqual([{ ticket: "a".repeat(32) }]);
  });
});

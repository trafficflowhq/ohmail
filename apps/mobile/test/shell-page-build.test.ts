/**
 * THE SHELL'S PAGE AS THE BUILD WRITES IT. The page every phone build ships carries the policy that
 * keeps it off the network and out of every frame, states it once, runs no inline script, and its
 * manifest names every file it may be served with that file's own digest.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import type { WakePaneState } from "@ohmail/app-logic/phone/wake";
import type { ShellSession } from "../src/net/pairing";
import type { PhoneNameRow, ShellConfig } from "../src/shell/bridge-kinds";
import { HttpDoor } from "../src/shell/http-door";
import { BENCH_MARKER, buildShell, policyOf } from "../scripts/build-shell.mjs";
import { design } from "@ohmail/tokens/design";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium, expect: browserExpect } = require_("@playwright/test") as typeof import("@playwright/test");

const POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; " +
  "connect-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; manifest-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

const out = mkdtempSync(join(tmpdir(), "shell-page-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

describe("the shell's page", () => {
  it("is built with the stated policy, once, and no inline script", async () => {
    const manifest = await buildShell({ out });
    const html = readFileSync(join(out, "index.html"), "utf8");
    expect(manifest.csp).toBe(POLICY);
    expect(html.match(/http-equiv="Content-Security-Policy"/g)).toHaveLength(1);
    expect(html).toContain(`content="${POLICY}"`);
    for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)) {
      expect(m[1]).toMatch(/src="\.\/shell\.js"/);
      expect(m[2].trim()).toBe("");
    }
    // Its icon is in the page itself, so the web view asks the app for nothing but the listed files.
    expect(html.match(/<link rel="icon"[^>]*>/g)).toEqual(['<link rel="icon" href="data:,">']);
    const listed = Object.keys(manifest.files).sort();
    // Every file the build wrote, in its folders too (the font files the page's sheet names stand in `assets/`).
    const written = readdirSync(out, { recursive: true, withFileTypes: true }).filter((f) => f.isFile())
      .map((f) => relative(out, join(f.parentPath, f.name)).split("\\").join("/"));
    expect(listed).toEqual(written.filter((f) => f !== "shell.manifest.json").sort());
    for (const name of listed) {
      expect(manifest.files[name]).toBe(createHash("sha256").update(readFileSync(join(out, name))).digest("hex"));
    }
    expect(manifest.bench).toBe(false);
  }, 60_000);

  it("is the frame and its own files: nothing of today's shell or of the web app goes into it", async () => {
    const built = await buildShell({ out });
    expect(built.inputs.some((p: string) => p.startsWith("packages/app/src/frame/"))).toBe(true);
    expect(built.inputs.filter((p: string) => p.startsWith("apps/webapp/") || p.startsWith("apps/desktop/") || p.startsWith("apps/paired-page/"))).toEqual([]);
  }, 60_000);

  it("carries the bench's door only when built for the bench, and the app's build takes it only for the bench", async () => {
    const root = mkdtempSync(join(tmpdir(), "shell-bench-"));
    try {
      const page = join(root, "generated", "shell");
      const { shellPageOf } = require_("./apps/mobile/plugins/shell-assets.js") as { shellPageOf: (root: string, env: object) => string };
      expect((await buildShell({ out: page, bench: true })).bench).toBe(true);
      expect(readFileSync(join(page, "shell.js"), "utf8")).toContain(BENCH_MARKER);
      expect(() => shellPageOf(root, {})).toThrow(/emulator bench/);
      expect(shellPageOf(root, { OHMAIL_SHELL_BENCH: "1" })).toBe(page);
      expect((await buildShell({ out: page })).bench).toBe(false);
      expect(readFileSync(join(page, "shell.js"), "utf8")).not.toContain(BENCH_MARKER);
      expect(shellPageOf(root, {})).toBe(page);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("is built for one app, with that app's places, and the other app's build refuses it", async () => {
    const root = mkdtempSync(join(tmpdir(), "shell-app-"));
    try {
      const page = join(root, "generated", "shell");
      const { shellPageOf } = require_("./apps/mobile/plugins/shell-assets.js") as {
        shellPageOf: (root: string, env: object, app: string) => string;
      };
      const ohcal = await buildShell({ out: page, app: "ohcal" });
      expect(ohcal.app).toBe("ohcal");
      expect(ohcal.inputs).toContain("apps/mobile/web/src/mounted.ohcal.ts");
      expect(ohcal.inputs).not.toContain("apps/mobile/web/src/mounted.ohmail.ts");
      expect(shellPageOf(root, {}, "ohcal")).toBe(page);
      expect(() => shellPageOf(root, {}, "ohmail")).toThrow(/built for "ohcal".*--app ohmail/);
      const ohmail = await buildShell({ out: page });
      expect(ohmail.app).toBe("ohmail");
      expect(ohmail.inputs).toContain("apps/mobile/web/src/mounted.ohmail.ts");
      expect(() => shellPageOf(root, {}, "ohcal")).toThrow(/built for "ohmail"/);
      // A page left from before the build named its app is a stale page: refused, never guessed.
      const file = join(page, "shell.manifest.json");
      const { app: _named, ...unnamed } = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      writeFileSync(file, JSON.stringify(unnamed));
      expect(() => shellPageOf(root, {}, "ohmail")).toThrow(/no named app/);
      await expect(buildShell({ out: page, app: "ohcalendar" })).rejects.toThrow(/--app is "ohcalendar"/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it("refuses a page whose policy would let it reach out, run inline script or say it twice", () => {
    const page = (policy: string) => `<meta http-equiv="Content-Security-Policy" content="${policy}">`;
    expect(policyOf(page(POLICY))).toBe(POLICY);
    expect(() => policyOf(page(POLICY.replace("connect-src 'none'", "connect-src *")))).toThrow(/connect-src 'none'/);
    expect(() => policyOf(page(POLICY.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")))).toThrow(/script-src 'self'/);
    expect(() => policyOf(page(POLICY.replace("frame-src 'none'; ", "")))).toThrow(/frame-src 'none'/);
    expect(() => policyOf(page(POLICY) + page(POLICY))).toThrow(/2 times/);
    expect(() => policyOf("<html></html>")).toThrow(/0 times/);
  });
});

/**
 * One file of the template `expo prebuild` makes the native projects from (`expo/template.tgz`, carried by this tree's
 * Expo), named for an app as prebuild names it: `HelloWorld` becomes the app's project name.
 */
function templateFile(name: string, app: string): string {
  const tar = gunzipSync(readFileSync(require_.resolve("expo/template.tgz")));
  for (let at = 0; at + 512 <= tar.length && tar[at] !== 0;) {
    const text = (from: number, to: number) => tar.subarray(at + from, at + to).toString("utf8").replace(/\0[\s\S]*$/, "");
    const size = Number.parseInt(text(124, 136).trim(), 8);
    if ([text(345, 500), text(0, 100)].filter(Boolean).join("/") === `package/${name}`) {
      return tar.subarray(at + 512, at + 512 + size).toString("utf8").replace(/HelloWorld/g, app).replace(/helloworld/g, app);
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${name} is not in Expo's template`);
}

/**
 * THE PAGE IN THE iOS APP: the plugin's iOS mods run as `expo prebuild` runs them, over the project Expo's template makes.
 * The page's folder is copied beside the app's sources and referenced whole, as a folder, from the app's own group and
 * the app's resources, so the app carries it as `shell/`. A prebuild run again over the same project adds nothing twice.
 */
describe("the shell's page in the iOS app", () => {
  type Ref = { value: string; comment: string };
  type Pbx = {
    pbxGroupByName(name: string): { children: Ref[] };
    getPBXGroupByKey(key: string): { children: Ref[] } | undefined;
    getFirstProject(): { firstProject: { mainGroup: string } };
    pbxFileReferenceSection(): Record<string, { lastKnownFileType?: string; path?: string }>;
    pbxBuildFileSection(): Record<string, { fileRef?: string }>;
    pbxResourcesBuildPhaseObj(target: string): { files: Ref[] };
    getTarget(type: string): { uuid: string };
  };
  const plugins = require_("expo/config-plugins") as {
    compileModsAsync: (config: object, props: object) => Promise<object>;
    IOSConfig: { XcodeUtils: { getPbxproj(root: string): Pbx; unquote(value: string): string } };
  };
  const withShellAssets = require_("./apps/mobile/plugins/shell-assets.js") as (config: object) => object;

  for (const [app, id] of [["ohmail", "app.ohmail"], ["ohcal", "app.ohcal"]] as const) {
    it(`goes into ${app}'s own group and its resources, in the project Expo's template makes, once`, async () => {
      const root = mkdtempSync(join(tmpdir(), "shell-ios-"));
      try {
        mkdirSync(join(root, "ios", `${app}.xcodeproj`), { recursive: true });
        writeFileSync(join(root, "ios", `${app}.xcodeproj`, "project.pbxproj"), templateFile("ios/HelloWorld.xcodeproj/project.pbxproj", app));
        mkdirSync(join(root, "generated", "shell"), { recursive: true });
        writeFileSync(join(root, "generated", "shell", "shell.manifest.json"), JSON.stringify({ app, bench: false, files: {} }));
        for (let run = 0; run < 2; run += 1) {
          const config = withShellAssets({ name: app, slug: app, ios: { bundleIdentifier: id } });
          await plugins.compileModsAsync(config, { projectRoot: root, platforms: ["ios"] });
        }
        const { getPbxproj, unquote } = plugins.IOSConfig.XcodeUtils;
        const project = getPbxproj(root);
        const shell = project.pbxGroupByName(app).children.filter((child) => child.comment === "shell");
        expect(shell).toHaveLength(1);
        const ref = project.pbxFileReferenceSection()[shell[0]!.value]!;
        expect([ref.lastKnownFileType, unquote(ref.path!)]).toEqual(["folder", `${app}/shell`]);
        const resources = project.pbxResourcesBuildPhaseObj(project.getTarget("com.apple.product-type.application").uuid).files
          .map((file) => project.pbxBuildFileSection()[file.value]?.fileRef);
        expect(resources.filter((fileRef) => fileRef === shell[0]!.value)).toHaveLength(1);
        expect(existsSync(join(root, "ios", app, "shell", "shell.manifest.json"))).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }

  // `pod install` adds the group ExpoModulesProviders/<app> to the main group. In an ios folder made before the plugin,
  // and listed before the app's own group, it is the first group of the app's name, and no `shell` reference exists yet.
  for (const [app, id] of [["ohmail", "app.ohmail"], ["ohcal", "app.ohcal"]] as const) {
    it(`goes into ${app}'s own group when the group pod install adds, of the same name, is listed first`, async () => {
      const root = mkdtempSync(join(tmpdir(), "shell-ios-"));
      try {
        let pbx = templateFile("ios/HelloWorld.xcodeproj/project.pbxproj", app);
        const mainGroup = /mainGroup = ([0-9A-F]{24});/.exec(pbx)![1]!;
        const providers = [
          "\t\t0A0000000000000000000001 /* ExpoModulesProviders */ = {", "\t\t\tisa = PBXGroup;", "\t\t\tchildren = (",
          `\t\t\t\t0A0000000000000000000002 /* ${app} */,`, "\t\t\t);", "\t\t\tname = ExpoModulesProviders;",
          "\t\t\tsourceTree = \"<group>\";", "\t\t};",
          `\t\t0A0000000000000000000002 /* ${app} */ = {`, "\t\t\tisa = PBXGroup;", "\t\t\tchildren = (", "\t\t\t);",
          `\t\t\tname = ${app};`, "\t\t\tsourceTree = \"<group>\";", "\t\t};",
        ].join("\n");
        pbx = pbx.replace("/* Begin PBXGroup section */\n", `/* Begin PBXGroup section */\n${providers}\n`);
        pbx = pbx.replace(`\t\t${mainGroup} = {\n\t\t\tisa = PBXGroup;\n\t\t\tchildren = (\n`, (head) => `${head}\t\t\t\t0A0000000000000000000001 /* ExpoModulesProviders */,\n`);
        mkdirSync(join(root, "ios", `${app}.xcodeproj`), { recursive: true });
        writeFileSync(join(root, "ios", `${app}.xcodeproj`, "project.pbxproj"), pbx);
        mkdirSync(join(root, "generated", "shell"), { recursive: true });
        writeFileSync(join(root, "generated", "shell", "shell.manifest.json"), JSON.stringify({ app, bench: false, files: {} }));
        const { getPbxproj, unquote } = plugins.IOSConfig.XcodeUtils;
        const before = getPbxproj(root);
        const top = before.getPBXGroupByKey(before.getFirstProject().firstProject.mainGroup)!.children;
        expect(top.filter((child) => child.comment === "ExpoModulesProviders")).toHaveLength(1);
        expect(before.pbxGroupByName(app)).toBe(before.getPBXGroupByKey("0A0000000000000000000002"));
        for (let run = 0; run < 2; run += 1) {
          const config = withShellAssets({ name: app, slug: app, ios: { bundleIdentifier: id } });
          await plugins.compileModsAsync(config, { projectRoot: root, platforms: ["ios"] });
        }
        const project = getPbxproj(root);
        const own = top.find((child) => child.comment === app)!;
        const shell = project.getPBXGroupByKey(own.value)!.children.filter((child) => child.comment === "shell");
        expect(shell).toHaveLength(1);
        const ref = project.pbxFileReferenceSection()[shell[0]!.value]!;
        expect([ref.lastKnownFileType, unquote(ref.path!)]).toEqual(["folder", `${app}/shell`]);
        expect(project.getPBXGroupByKey("0A0000000000000000000002")!.children).toEqual([]);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }, 60_000);
  }
});

/**
 * THE BUILT PAGE IN A REAL BROWSER, over a double of the native side: served as the native door serves it (the listed
 * files under `/shell/`, the policy as a header, 403 for anything else), with the bridge object the platform injects.
 * The page reads its words and its setting, mounts the frame, says it has drawn, and asks nothing of any address.
 */
describe("the built page in a browser", () => {
  const CONFIG: Omit<ShellConfig, "language"> = {
    app: "ohmail", other: "here",
    scope: "p0123456789abcdef0123456789abcdef", accountId: "acct-1", setting: "managed", serverName: "mail.example",
    build: { version: "2.0.0", commit: "abc" }, place: null, oldCopy: "absent", notifications: "default",
    notices: ["ohbox", "screener", "pairing"],
    facts: { posture: { folds: [], hasFold: false }, insets: { top: 0, right: 0, bottom: 0, left: 0 }, keyboard: { height: 0 }, online: true },
  };

  /** What native's keeper reads for the live scope. */
  type KeptReading = { words: [string, string][]; refused: [string, string | null][] };
  type PhoneSettingsReading = {
    wake?: WakePaneState;
    names?: readonly PhoneNameRow[];
    refuseFirstNameRead?: boolean;
    refuseName?: string;
  };
  type MailCopy = { accountId: string; subject: string };
  type Feeds = { snapshot: MailCopy[]; updates?: MailCopy[] };

  /** The native side as the page sees it: answers by kind, records every kind and every http path asked. */
  function nativeDouble({ config, kept, settings, feeds, nativeHttp, replies }: {
    config: ShellConfig; kept: KeptReading; settings: PhoneSettingsReading; feeds?: Feeds; nativeHttp: boolean; replies: Readonly<Record<string, object>>;
  }) {
    const w = window as unknown as Record<string, unknown>;
    const asked: { kind: string; path?: string; method?: string; act?: string; place?: string; do?: string; distributor?: string; mailboxId?: string; name?: string | null; took?: unknown; askId?: number }[] = [];
    const listeners: ((e: { data: string }) => void)[] = [];
    let { wake, names, refuseFirstNameRead } = settings;
    const replyCounts = new Map<string, number>();
    const reply = (message: object) => {
      setTimeout(() => { for (const l of listeners) l({ data: JSON.stringify(message) }); }, 0);
    };
    const changesOf = (rows: MailCopy[], start: number) => rows.map(({ accountId, subject }, index) => {
      const seq = start + index;
      const id = `message-${seq}`;
      const date = new Date().toISOString();
      return { type: "message", op: "create", seq, id, updatedAt: date, entity: {
        id, accountId, mailboxId: "mailbox", threadId: null, messageIdHeader: null,
        from: { name: "Fixture sender", address: ["sender", "example.invalid"].join("@") },
        to: [], cc: [], date, subject, snippet: "Preview", folder: "INBOX", unread: true,
        hasAttachments: false, attachmentCount: 0, triage: null, labels: [], remoteContent: "none", updatedAt: date,
        sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      } };
    });
    const answers: Record<string, () => object> = {
      kept: () => kept, config: () => config, keptRows: () => ({ rows: [] }), keepRows: () => ({ kept: true }),
      keep: () => ({ kept: true }), http: () => ({ status: 503, headers: [["content-type", "application/json"]], body: { as: "text", text: "{\"error\":{\"code\":\"not_ready\"}}" } }),
    };
    const emit = (event: object) => {
      for (const receive of listeners) receive({ data: JSON.stringify(event) });
    };
    let holdAcknowledgement = false;
    let finishAcknowledgement: (() => void) | undefined;
    let finishExit: (() => void) | undefined;
    w.__native = {
      asked,
      back: (askId: number, delay = false) => {
        holdAcknowledgement = delay;
        emit({ type: "ask", epoch: "e1", askId, what: "back" });
      },
      finishAcknowledgement: () => finishAcknowledgement?.(),
      finishExit: () => finishExit?.(),
    };
    w.ohmailShell = {
      postMessage(text: string) {
        const m = JSON.parse(text) as (typeof asked)[number] & { id: number; epoch: string; act?: string };
        asked.push({ kind: m.kind, path: m.path, method: m.method, act: m.act, place: m.place, do: m.do, distributor: m.distributor, mailboxId: m.mailboxId, name: m.name, took: m.took, askId: m.askId });
        const envelope = { id: m.id, epoch: m.epoch, ok: true };
        if (m.kind === "http" && nativeHttp) {
          const ask = w.__askNativeHttp as (request: object) => Promise<object>;
          void ask(m).then((answer) => {
            reply({ ...envelope, ...answer, ok: !("refused" in answer) });
          });
          return;
        }
        if (m.kind === "http" && (names || feeds)) {
          const [path, query] = m.path?.split("?") ?? [];
          const body = { text: "The fixture letter body" };
          const response = path === "/sync/snapshot"
            ? { asOfSeq: 7, changes: changesOf(feeds?.snapshot ?? [], 1), nextCursor: null }
            : path === "/sync"
              ? { changes: { creates: changesOf(feeds?.updates ?? [], 8), updates: [], deletes: [], moves: [] }, cursor: "OA", hasMore: false, serverTime: new Date().toISOString() }
              : path === "/messages/bodies"
                ? { items: (new URLSearchParams(query).get("ids") ?? "").split(",").map((messageId) => ({ messageId, ...body })) }
                : path?.endsWith("/body") ? body : null;
          if (response) {
            reply({ ...envelope, status: 200, headers: [["content-type", "application/json"]], body: { as: "text", text: JSON.stringify(response) } });
            return;
          }
        }
        if (m.kind === "phone.wake" && wake) {
          if (m.do === "read") {
            reply({ ...envelope, wake });
            return;
          }
          wake = m.do === "choose"
            ? { ...wake, chosen: m.distributor!, state: { k: "on" } }
            : { ...wake, chosen: null, state: { k: "no_distributor" } };
          reply(envelope);
          reply({ epoch: m.epoch, type: "wakePane", wake });
          return;
        }
        if (m.kind === "phone.name" && names) {
          if (m.do === "read") {
            if (refuseFirstNameRead) {
              refuseFirstNameRead = false;
              reply({ ...envelope, ok: false, refused: "notReady" });
            } else {
              reply({ ...envelope, rows: names });
            }
          } else if (m.name === settings.refuseName) {
            reply({ ...envelope, ok: false, refused: "notReady" });
          } else {
            const name = m.name ?? null;
            names = names.map((row) => row.id === m.mailboxId ? { ...row, name } : row);
            reply({ ...envelope, name });
          }
          return;
        }
        const key = m.kind === "http" ? `http:${m.method} ${m.path}` : `${m.kind}:${m.do ?? m.act ?? ""}`;
        const choices = replies[key];
        const at = replyCounts.get(key) ?? 0;
        replyCounts.set(key, at + 1);
        const response = (Array.isArray(choices) ? choices[Math.min(at, choices.length - 1)] : choices) ?? answers[m.kind]?.() ?? {};
        const answer = { ...envelope, ...(m.kind === "answer" ? { accepted: true } : response) };
        if (m.kind === "answer" && m.took === "held" && holdAcknowledgement) {
          holdAcknowledgement = false;
          finishAcknowledgement = () => emit(answer);
        } else if (m.kind === "answer" && m.took === "discard") {
          finishExit = () => emit(answer);
        } else {
          reply(answer);
        }
      },
      addEventListener(_t: string, l: (e: { data: string }) => void) { listeners.push(l); },
      removeEventListener() {},
    };
  }

  /**
   * The built page served as the native door serves it, over the native double in a phone-sized browser, once it has
   * said it drew. `stored` is in the page's storage before the page runs, as another mailbox's page would leave it.
   */
  async function drawn(
    config: ShellConfig,
    stored: [string, string][] = [],
    kept: KeptReading = { words: [], refused: [] },
    viewport = { width: 412, height: 915 },
    settings: PhoneSettingsReading = {},
    feeds?: Feeds,
    http?: HttpDoor,
    replies: Readonly<Record<string, object>> = {},
  ) {
    const built = await buildShell({ out, app: config.app });
    const outside: string[] = [];
    const server: Server = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://door").pathname;
      const name = path.replace(/^\/shell\//, "");
      if (path.startsWith("/shell/") && built.files[name]) {
        // The native doors' types (AssetDoor.kt, SchemeDoor.swift) for what the page is built of.
        const type = name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : name.endsWith(".woff2") ? "font/woff2" : "text/html";
        res.writeHead(200, { "content-type": type, "content-security-policy": `${built.csp}; frame-ancestors 'none'` });
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
    const close = async () => {
      await browser.close();
      await new Promise((done) => server.close(done));
    };
    try {
      const context = await browser.newContext({ viewport, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const left: string[] = [];
      page.on("request", (r) => { if (!r.url().startsWith(`${origin}/shell/`)) left.push(r.url()); });
      if (http) {
        await page.exposeFunction("__askNativeHttp", (ask: Parameters<HttpDoor["request"]>[0]) =>
          http.request(ask, new AbortController().signal),
        );
      }
      await page.addInitScript(nativeDouble, { config, kept, settings, feeds, nativeHttp: http !== undefined, replies });
      await page.addInitScript((rows) => { if (window === window.top) for (const [k, v] of rows) localStorage.setItem(k, v); }, stored);
      await page.goto(`${origin}/shell/index.html?epoch=e1`);
      await page.waitForFunction(() => (window as unknown as { __native: { asked: { kind: string }[] } }).__native.asked.some((a) => a.kind === "ready"));
      return { page, left, outside, close };
    } catch (fault) {
      await close();
      throw fault;
    }
  }

  const mail = { accountId: CONFIG.accountId, subject: "A letter for this phone" };

  it("keeps a foreign From choice and letter out of the mounted mail page until the pairing is confirmed", async () => {
    const sent: string[] = [];
    let cleared = false;
    const session = {
      profile: { accountId: CONFIG.accountId },
      standalone: false,
      boundAccount: () => cleared ? CONFIG.accountId : null,
      leave: () => { cleared = false; },
      send: async (route: string) => {
        const path = route.split("?")[0]!;
        sent.push(path);
        const accountId = cleared ? CONFIG.accountId : "acct-2";
        if (path === "/mailboxes") {
          return Response.json({ items: [{
            accountId, id: "mailbox", status: "connected", address: cleared ? "Own From" : "Foreign From",
          }] });
        }
        if (path === "/sync/snapshot") {
          const date = new Date().toISOString();
          const subject = cleared ? mail.subject : "Foreign letter";
          return Response.json({ asOfSeq: 1, nextCursor: null, changes: [{
            type: "message", op: "create", id: "message", seq: 1, updatedAt: date,
            entity: {
              id: "message", mailboxId: "mailbox", accountId, date, updatedAt: date, folder: "INBOX", subject,
              snippet: "Preview", from: { name: "Fixture sender", address: ["sender", "example.invalid"].join("@") },
              to: [], cc: [], labels: [], unread: true,
            },
          }] });
        }
        if (path === "/sync") {
          return Response.json({ changes: { creates: [], updates: [], moves: [], deletes: [] }, cursor: "MQ", hasMore: false });
        }
        return Response.json({}, { status: 404 });
      },
    } as unknown as ShellSession;
    const http = new HttpDoor({ live: () => ({ session, scope: CONFIG.scope }), ready: () => true });
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/compose" }, [], undefined, undefined, {}, undefined, http);
    try {
      const subject = page.getByRole("textbox", { name: "Subject" });
      await browserExpect(subject).toBeVisible({ timeout: 5_000 });
      await page.waitForFunction(() => {
        const native = (window as unknown as { __native: { asked: { path?: string }[] } }).__native;
        return native.asked.some(({ path }) => path?.split("?")[0] === "/mailboxes");
      });
      await browserExpect(page.getByText("Foreign From", { exact: true })).toHaveCount(0);
      await page.evaluate(() => { window.location.hash = "#/ohbox"; });
      await browserExpect(page.getByRole("navigation", { name: "Places" })).toBeVisible();
      await browserExpect(page.getByText("Foreign letter", { exact: true })).toHaveCount(0);
      expect(sent).toEqual([]);

      cleared = true;
      await page.reload();
      await browserExpect(page.getByText("Own From", { exact: true })).toBeVisible({ timeout: 5_000 });
      await page.evaluate(() => { window.location.hash = "#/ohbox"; });
      await browserExpect(page.getByRole("option", { name: new RegExp(mail.subject) })).toBeVisible({ timeout: 5_000 });
      await browserExpect(page.getByText("Foreign letter", { exact: true })).toHaveCount(0);
    } finally {
      await close();
    }
  }, 120_000);

  it("lists Ohbox and Settings in the phone's navigation", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en" });
    try {
      const dock = page.getByRole("navigation", { name: "Places" });
      await browserExpect(dock.getByRole("button", { name: "Ohbox", exact: true })).toBeVisible({ timeout: 4_000 });
      await dock.getByRole("button", { name: "More", exact: true }).click();
      await browserExpect(page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings", exact: true })).toBeVisible();
    } finally {
      await close();
    }
  }, 120_000);

  it("shows the synced letters in the Ohbox and opens one with Reply", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/ohbox" }, [], undefined, undefined, {}, {
      snapshot: [mail, { ...mail, subject: "Another letter for this phone" }],
    });
    try {
      const row = page.getByRole("option", { name: `Fixture sender: ${mail.subject}`, exact: true });
      await browserExpect(row).toBeVisible({ timeout: 4_000 });
      await browserExpect(page.getByRole("option", { name: /Another letter for this phone/ })).toBeVisible();
      await row.click();
      await browserExpect(page.getByText("The fixture letter body", { exact: true })).toBeVisible();
      const actions = page.getByRole("toolbar", { name: "Actions", exact: true });
      await browserExpect(actions.getByRole("button", { name: "Reply", exact: true })).toBeVisible();
    } finally {
      await close();
    }
  }, 120_000);

  it("opens the Ohbox at an unknown place address without drawing another account's letter", async () => {
    const foreign = { accountId: "acct-2", subject: "A letter for the other phone" };
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/not-a-place" }, [], undefined, undefined, {}, {
      snapshot: [mail], updates: [foreign],
    });
    try {
      await page.waitForFunction(() => {
        const native = (window as unknown as { __native: { asked: { path?: string }[] } }).__native;
        return native.asked.some(({ path }) => path?.startsWith("/sync?"));
      }, undefined, { timeout: 4_000 });
      await browserExpect(page.getByRole("option", { name: new RegExp(mail.subject) })).toBeVisible({ timeout: 4_000 });
      await browserExpect(page.getByText(foreign.subject, { exact: true })).toHaveCount(0);
    } finally {
      await close();
    }
  }, 120_000);

  it("keeps the calendar app's page on its own frame", async () => {
    const { page, close } = await drawn({ ...CONFIG, app: "ohcal", language: "en" });
    try {
      const dock = page.getByRole("navigation", { name: "Calendar" });
      await browserExpect(dock).toBeVisible();
      await browserExpect(dock.getByRole("button", { name: "Ohbox", exact: true })).toHaveCount(0);
      await browserExpect(page.getByRole("button", { name: "Settings", exact: true })).toHaveCount(0);
      await browserExpect(page.locator("html")).toHaveAttribute("data-product", "cal");
      await browserExpect(page.locator("html")).toHaveAttribute("data-face", "paper");
      await browserExpect(page.locator("html")).toHaveAttribute("data-accent", "cobalt");
      await browserExpect(dock.getByRole("button", { name: "Agenda", exact: true })).toBeVisible();
      await dock.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("dialog", { name: "More", exact: true })
        .getByRole("button", { name: "Settings", exact: true }).click();
      await page.getByRole("button", { name: "General", exact: true }).click();
      await browserExpect(page.getByText("Appearance", { exact: true })).toBeVisible();
      await browserExpect(page.getByText("Messages", { exact: true })).toHaveCount(0);
    } finally {
      await close();
    }
  }, 120_000);

  it("keeps Calendar notification and widget titles private on the phone", async () => {
    const { page, close } = await drawn({
      ...CONFIG, app: "ohcal", language: "en", place: "#/cal/calendars/notifications", notifications: "granted",
    });
    try {
      await browserExpect(page.getByRole("switch", { name: "An alert", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("switch", { name: /show titles/i })).toHaveCount(0);
      await browserExpect(page.getByText("Reminders and widgets show no event details.", { exact: true })).toBeVisible();
    } finally { await close(); }
  }, 120_000);

  it("keeps device Calendar view choices when moving between Settings pages", async () => {
    const { page, close } = await drawn({ ...CONFIG, app: "ohcal", language: "en", place: "#/cal/calendars/calview" });
    try {
      const opener = page.getByRole("button", { name: "Opens in", exact: true });
      await opener.click({ timeout: 1400 });
      await page.getByRole("menu").getByText("Month", { exact: true }).click();
      await browserExpect(opener).toContainText("Month");
      const weekends = page.getByRole("switch", { name: "Weekends", exact: true });
      await weekends.click();
      await browserExpect(weekends).toHaveAttribute("aria-checked", "false");
      await page.evaluate(() => { location.hash = "#/cal/calendars"; });
      await page.evaluate(() => { location.hash = "#/cal/calendars/calview"; });
      await browserExpect(opener).toContainText("Month");
      await browserExpect(weekends).toHaveAttribute("aria-checked", "false");
    } finally { await close(); }
  }, 120_000);

  it("keeps calendar mail offer choices on this phone", async () => {
    const { page, close } = await drawn({ ...CONFIG, app: "ohcal", language: "en", place: "#/cal/calendars/calmail" },
      [], undefined, undefined, {}, undefined, undefined, { "http:GET /mailboxes": httpAnswer({ items: [
        { id: "fixture-mailbox", address: ["mailbox", "example.invalid"].join("@"), status: "connected" },
      ] }) });
    try {
      const calendar = page.getByRole("switch", { name: "Calendar invitations", exact: true });
      await browserExpect(calendar).toBeChecked({ timeout: 1300 });
      await calendar.click();
      await browserExpect(calendar).not.toBeChecked();
      await page.reload();
      await browserExpect(calendar).not.toBeChecked();
      await browserExpect(page.getByRole("switch", { name: "Dates in structured mail", exact: true })).toBeChecked();
    } finally { await close(); }
  }, 120_000);

  it("turns off Calendar reminders on this device without changing the alert choice", async () => {
    const { page, close } = await drawn({
      ...CONFIG, app: "ohcal", language: "en", place: "#/cal/calendars/notifications", notifications: "granted",
    });
    try {
      const master = page.getByRole("switch", { name: "On this device", exact: true });
      const alert = page.getByRole("switch", { name: "An alert", exact: true });
      await browserExpect(master).toBeChecked({ timeout: 1400 });
      await master.click();
      await browserExpect(master).not.toBeChecked();
      await browserExpect(alert).toBeDisabled();
      await master.click();
      await browserExpect(alert).toBeEnabled();
    } finally { await close(); }
  }, 120_000);

  it("changes Calendar week numbers using the existing settings call", async () => {
    const calendar = { enabledAt: "2026-11-12T08:00:00Z", weekNumbers: false, secondZone: null,
      dayFromMinute: null, dayToMinute: null, newEventsCalendarId: null };
    const { page, close } = await drawn({ ...CONFIG, app: "ohcal", language: "en", place: "#/cal/calendars/calview" },
      [], undefined, undefined, {}, undefined, undefined, {
        "http:GET /calendar/settings": httpAnswer(calendar),
        "http:PATCH /calendar/settings": httpAnswer({ ...calendar, weekNumbers: true }),
      });
    try {
      const numbers = page.getByRole("switch", { name: "Week numbers", exact: true });
      await browserExpect(numbers).toBeVisible({ timeout: 1300 });
      await numbers.click();
      await askedFor(page, "http", "PATCH /calendar/settings");
      await browserExpect(numbers).toHaveAttribute("aria-checked", "true");
    } finally { await close(); }
  }, 120_000);

  it("keeps Calendar Accounts open when turning off ohcal on the phone", async () => {
    const calendar = { enabledAt: "2026-11-12T08:00:00Z", weekNumbers: false, secondZone: null,
      dayFromMinute: null, dayToMinute: null, newEventsCalendarId: null };
    const { page, close } = await drawn({ ...CONFIG, app: "ohcal", language: "en", place: "#/cal/calendars/calaccounts" },
      [], undefined, undefined, {}, undefined, undefined, {
        "http:GET /calendar/settings": httpAnswer(calendar),
        "http:PATCH /calendar/settings": httpAnswer({ ...calendar, enabledAt: null }),
      });
    try {
      const enabled = page.getByRole("switch", { name: "Use ohcal", exact: true });
      await browserExpect(enabled).toBeChecked({ timeout: 1400 });
      await enabled.click();
      await askedFor(page, "http", "PATCH /calendar/settings");
      await browserExpect(enabled).not.toBeChecked({ timeout: 1400 });
      await browserExpect(enabled).toBeEnabled();
    } finally { await close(); }
  }, 120_000);

  it("opens the account Settings sections on a paired phone", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings" });
    try {
      for (const name of ["Account", "Devices", "AI", "Away responder", "Subscription", "Storage", "Invites", "Security"]) {
        await browserExpect(page.getByRole("button", { name, exact: true })).toBeAttached({ timeout: 600 });
      }
    } finally {
      await close();
    }
  }, 120_000);

  const httpAnswer = (value: object) => ({
    status: 200, headers: [["content-type", "application/json"]],
    body: { as: "text", text: JSON.stringify(value) },
  });
  const access = httpAnswer({
    metered: true, access: "open", lifecycle: { state: "active" },
    storage: { usedBytes: 200_000_000, limitBytes: 1_000_000_000, offer: { current: { plan: "plus" } },
      mailboxes: [{ id: "metered-mailbox", usedBytes: 200_000_000, letters: 2000, expectedBytes: 400_000_000 }] },
  });
  const awayRow = { enabled: true, body: "Back on Monday", startsAt: null, endsAt: null, audience: "everyone", throttle: "per_day" };
  const dataReplies = {
    "http:GET /account/access": access,
    "http:GET /mailboxes": httpAnswer({ items: [
      { id: "metered-mailbox", displayName: "Fixture mailbox", address: ["mailbox", "example.invalid"].join("@") },
    ] }),
    "http:GET /account/ai": httpAnswer({ aiEnabled: true }),
    "http:PATCH /account/ai": httpAnswer({ aiEnabled: false }),
    "http:GET /consent": httpAnswer({ draftReplies: true, dormancyDays: 28 }),
    "http:PATCH /consent/settings": httpAnswer({ draftReplies: false }),
    "http:GET /away-responder": httpAnswer(awayRow),
    "http:PUT /away-responder": httpAnswer({ ...awayRow, body: "Back on Tuesday" }),
  };

  it.each([
    { pane: "ai", value: "Use AI for suggestions and drafts" },
    { pane: "away", value: "Away responder" },
    { pane: "billing", value: "Plus" },
    { pane: "storage", value: "200 MB" },
  ])("draws $pane from the paired account without purchase controls", async ({ pane, value }) => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: `#/settings/${pane}` }, [], undefined, undefined, {}, undefined, undefined, dataReplies);
    try {
      await browserExpect(page.getByText(value, { exact: true }).last()).toBeVisible({ timeout: 1400 });
      await browserExpect(page.getByRole("link", { name: /plan|subscribe|payment|storage/i })).toHaveCount(0);
      await browserExpect(page.getByRole("button", { name: /change plan|subscribe|payment|add storage/i })).toHaveCount(0);
    } finally { await close(); }
  }, 120_000);

  it.each([
    { label: "Use AI for suggestions and drafts", method: "PATCH", path: "/account/ai" },
    { label: "Draft reply", method: "PATCH", path: "/consent/settings" },
  ])("saves $label on the paired account", async ({ label, method, path }) => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/ai" }, [], undefined, undefined, {}, undefined, undefined, dataReplies);
    try {
      const toggle = page.getByRole("switch", { name: label, exact: true });
      await browserExpect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 1400 });
      await toggle.click();
      await browserExpect.poll(() => page.evaluate(({ method, path }) => {
        const { asked } = (window as unknown as { __native: { asked: { method?: string; path?: string }[] } }).__native;
        return asked.filter((ask) => ask.method === method && ask.path === path).length;
      }, { method, path })).toBe(1);
      await browserExpect(toggle).toHaveAttribute("aria-checked", "false");
    } finally { await close(); }
  }, 120_000);

  it("saves an Away message after the person confirms the edit", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/away" }, [], undefined, undefined, {}, undefined, undefined, dataReplies);
    try {
      const message = page.getByRole("textbox", { name: "Message", exact: true });
      await browserExpect(message).toHaveValue("Back on Monday", { timeout: 1400 });
      await message.fill("Back on Tuesday");
      await page.getByRole("button", { name: "Save", exact: true }).last().click();
      await browserExpect.poll(() => page.evaluate(() => {
        const { asked } = (window as unknown as { __native: { asked: { method?: string; path?: string }[] } }).__native;
        return asked.filter((ask) => ask.method === "PUT" && ask.path === "/away-responder").length;
      })).toBe(1);
      await browserExpect(message).toHaveValue("Back on Tuesday");
    } finally { await close(); }
  }, 120_000);

  const fixtureIdentity = { scope: "full", user: {
    accountId: CONFIG.accountId, email: ["person", "example.invalid"].join("@"), displayName: "Fixture Person",
    twofaEnrolled: { totp: true, webauthn: true, recoveryCodes: true },
  } };
  const pairRow = { id: "paired-elsewhere", label: "Spare device", grant: "device-pair", status: "live", createdAt: "2026-11-04T10:00:00Z", expiresAt: "2026-11-04T10:05:00Z" };
  const accountReplies = {
    "http:GET /auth/session": httpAnswer(fixtureIdentity),
    "http:POST /auth/password": httpAnswer({ revoked: 2 }),
    "http:GET /devices": httpAnswer({ items: [
      { id: "remote-device", kind: "mobile-android", label: "Travel phone", current: false, createdAt: pairRow.createdAt, lastSeenAt: pairRow.createdAt },
      { id: "remote-browser", kind: "web", label: "", named: false, current: false, createdAt: pairRow.createdAt, lastSeenAt: pairRow.createdAt },
    ] }),
    "http:DELETE /devices/remote-device": httpAnswer({}),
    "http:POST /devices/revoke-web-sessions": httpAnswer({ revoked: 1 }),
    "http:POST /auth/2fa/recovery-codes": httpAnswer({ codes: ["fixture-code"] }),
    "http:POST /auth/2fa/totp/enroll": httpAnswer({
      ...enrollmentFixture(),
    }),
    "http:DELETE /auth/2fa/totp": httpAnswer({}),
    "phone.account:pairs": { result: httpAnswer({ items: [pairRow, { ...pairRow, id: "other-invite", grant: "invite", label: "Spare invitation" }] }) },
    "phone.account:mint": { result: httpAnswer({ id: "new-link", label: "Fixture link", expiresAt: pairRow.expiresAt, link: "https://example.invalid/pair#fixture" }) },
    "phone.account:revoke": { result: httpAnswer({}) },
    "phone.account:activate": { result: httpAnswer({}) },
    "phone.account:deletePage": {},
  };
  const openedAccount = (pane: string, setting: ShellConfig["setting"] = "selfHosted") =>
    drawn({ ...CONFIG, setting, language: "en", place: `#/settings/${pane}` }, [], undefined, undefined, {}, undefined, undefined, accountReplies);

  it.each([
    { pane: "account", words: "Fixture Person" },
    { pane: "devices", words: "Travel phone" },
    { pane: "invites", words: "Spare invitation" },
    { pane: "security", words: "Authenticator app" },
  ])("reads $pane for the current server account", async ({ pane, words }) => {
    const { page, close } = await openedAccount(pane);
    try {
      await browserExpect(page.getByText(words, { exact: true }).first()).toBeVisible({ timeout: 1400 });
    } finally { await close(); }
  }, 120_000);

  function askedFor(page: import("@playwright/test").Page, kind: string, verb: string) {
    return browserExpect.poll(() => page.evaluate(({ kind, verb }) => {
      const { asked } = (window as unknown as { __native: { asked: { kind: string; method?: string; path?: string; do?: string; act?: string }[] } }).__native;
      return asked.filter((ask) => ask.kind === kind && (ask.do ?? ask.act ?? `${ask.method} ${ask.path}`) === verb).length;
    }, { kind, verb }), { timeout: 1400 }).toBe(1);
  }

  it("changes the server password using the same form as the web", async () => {
    const { page, close } = await openedAccount("account");
    try {
      await page.getByRole("button", { name: "Change password", exact: true }).click({ timeout: 1400 });
      await page.getByLabel("Current password", { exact: true }).fill("fixture-original");
      await page.getByLabel("New password", { exact: true }).fill("fixture-replacement");
      await page.getByLabel("New password, once more", { exact: true }).fill("fixture-replacement");
      await page.getByRole("button", { name: "Change password", exact: true }).click();
      await askedFor(page, "http", "POST /auth/password");
      await browserExpect(page.getByText(/2 other sessions were signed out/)).toBeVisible();
    } finally { await close(); }
  }, 120_000);

  it.each([
    { pane: "account", button: "Delete my account", kind: "phone.account", verb: "deletePage" },
    { pane: "account", button: "Sign out", kind: "act", verb: "signOut" },
    { pane: "devices", button: "Servers", kind: "act", verb: "openServers" },
    { pane: "devices", button: "Add a device", kind: "phone.account", verb: "mint" },
    { pane: "devices", button: "Revoke", kind: "phone.account", verb: "revoke" },
    { pane: "devices", button: "Sign out", confirm: "Sign out", kind: "http", verb: "DELETE /devices/remote-device" },
    { pane: "devices", button: "Sign out all", confirm: "Sign out all", kind: "http", verb: "POST /devices/revoke-web-sessions" },
    { pane: "invites", button: "Make an invite link", kind: "phone.account", verb: "mint" },
    { pane: "invites", button: "Revoke", kind: "phone.account", verb: "revoke" },
    { pane: "security", button: "Replace recovery codes", confirm: "Replace them", kind: "http", verb: "POST /auth/2fa/recovery-codes" },
    { pane: "security", button: "Remove authenticator", kind: "http", verb: "DELETE /auth/2fa/totp" },
  ])("runs $button from $pane on the signed-in phone", async ({ pane, button, confirm, kind, verb }) => {
    const { page, close } = await openedAccount(pane);
    try {
      await page.getByRole("button", { name: button, exact: true }).first().click({ timeout: 1400 });
      if (confirm) await page.getByRole("dialog").getByRole("button", { name: confirm, exact: true }).click({ timeout: 1400 });
      await askedFor(page, kind, verb);
    } finally { await close(); }
  }, 120_000);

  it("enrols an authenticator only after the entered code is confirmed", async () => {
    const { page, close } = await openedAccount("security");
    try {
      await page.getByRole("button", { name: "Replace authenticator", exact: true }).click({ timeout: 1400 });
      await askedFor(page, "http", "POST /auth/2fa/totp/enroll");
      await browserExpect(page.getByRole("img", { name: "Authenticator setup QR code" })).toBeVisible({ timeout: 1400 });
      await page.getByLabel("6-digit code", { exact: true }).fill("123456");
      await page.getByRole("button", { name: "Turn it on", exact: true }).click();
      await askedFor(page, "phone.account", "activate");
    } finally { await close(); }
  }, 120_000);

  const stepRequired = {
    ...httpAnswer({ error: { code: "step_up_required" } }), status: 403,
  };
  const futureLink = accountReplies["phone.account:mint"];

  it("offers the browser when a paired account can confirm only with a passkey", async () => {
    const passkeyOnly = { ...fixtureIdentity, user: { ...fixtureIdentity.user, twofaEnrolled: { webauthn: true } } };
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/devices" }, [], undefined, undefined, {}, undefined, undefined, {
      ...accountReplies, "phone.account:mint": { result: stepRequired },
      "http:GET /auth/session": httpAnswer(passkeyOnly), "phone.account:settingsPage": {},
    });
    try {
      await page.getByRole("button", { name: "Add a device", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Open in browser", exact: true }).click({ timeout: 1500 });
      await askedFor(page, "phone.account", "settingsPage");
      await askedFor(page, "phone.account", "mint");
      await browserExpect(dialog).toHaveCount(0);
    } finally { await close(); }
  }, 120_000);

  it.each([
    { label: "Six-digit code from your authenticator app", path: "/auth/step-up/totp", choice: null },
    { label: "One of the recovery codes you saved", path: "/auth/step-up/recovery-code", choice: "Use a recovery code instead" },
  ])("retries issuing the device link once after $label verifies", async ({ label, path, choice }) => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/devices" }, [], undefined, undefined, {}, undefined, undefined, {
      ...accountReplies, "phone.account:mint": [{ result: stepRequired }, futureLink],
      [`http:POST ${path}`]: httpAnswer({}),
    });
    try {
      await page.getByRole("button", { name: "Add a device", exact: true }).click();
      const dialog = page.getByRole("dialog");
      if (choice) await dialog.getByRole("button", { name: choice, exact: true }).click();
      await dialog.getByLabel(label, { exact: true }).fill("123456");
      await dialog.getByRole("button", { name: "Verify code", exact: true }).click();
      await askedFor(page, "http", `POST ${path}`);
      await browserExpect(page.getByRole("img", { name: /pairing link as a QR code/ })).toBeVisible();
      await browserExpect.poll(() => page.evaluate(() => {
        const { asked } = (window as unknown as { __native: { asked: { kind: string; do?: string }[] } }).__native;
        return asked.filter((ask) => ask.kind === "phone.account" && ask.do === "mint").length;
      })).toBe(2);
    } finally { await close(); }
  }, 120_000);

  it("shows mailbox use and the account total in phone Storage", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/storage" }, [], undefined, undefined, {}, undefined, undefined, dataReplies);
    try {
      const table = page.getByRole("table", { name: "Mailboxes", exact: true });
      await browserExpect(table.getByRole("row", { name: /Fixture mailbox/ })).toContainText("400 MB", { timeout: 1400 });
      await browserExpect(table.getByRole("row", { name: /Total/ })).toContainText("200 MB");
      await browserExpect(page.getByText("Storage mails", { exact: true })).toHaveCount(0);
    } finally { await close(); }
  }, 120_000);

  it("keeps account-only panes empty on a standalone phone and leaves the local responder available", async () => {
    const { page, close } = await drawn({ ...CONFIG, setting: "standalone", language: "en", place: "#/settings/devices" }, [], undefined, undefined, {}, undefined, undefined, dataReplies);
    try {
      await browserExpect(page.getByRole("button", { name: "Servers", exact: true })).toBeVisible();
      await browserExpect(page.getByRole("switch", { name: "Use AI for suggestions and drafts" })).toHaveCount(0);
      const next = await page.evaluate(() => {
        const { asked } = (window as unknown as { __native: { asked: { kind: string; path?: string }[] } }).__native;
        return asked.some((ask) => ask.kind === "phone.account" || ask.path?.startsWith("/account/"));
      });
      expect(next).toBe(false);
      const back = page.getByRole("button", { name: "Back to Settings", exact: true });
      await browserExpect(back).toBeVisible({ timeout: 1400 });
      await browserExpect(page.getByRole("heading", { name: "Devices", exact: true })).toBeVisible();
      await back.click();
      await page.getByRole("button", { name: "Away responder", exact: true }).click();

      await browserExpect(page.getByRole("textbox", { name: "Message", exact: true })).toHaveValue("Back on Monday");
      await browserExpect(page.getByText("Replies are sent while ohmail is open on this phone.", { exact: true })).toBeVisible();
    } finally { await close(); }
  }, 120_000);

  it.each([
    { setting: "standalone", name: "Fixture phone", note: "Replies are sent while ohmail is open on this phone." },
    { setting: "desktopHost", name: "Fixture desktop", note: "Replies are sent while ohmail is open on Fixture desktop." },
  ] as const)("names the running organizer for Away on $setting", async ({ setting, name, note }) => {
    const { page, close } = await drawn({ ...CONFIG, serverName: name, setting, language: "en", place: "#/settings/away" },
      [], undefined, undefined, {}, undefined, undefined, {
        ...dataReplies, "phone.organize:read": { rows: [{
          id: "fixture-mailbox", tag: "reader", notes: ["A different install organizes this mailbox."], warnings: [],
        }] },
      });
    try {
      await browserExpect(page.getByText(note, { exact: true })).toBeVisible({ timeout: 1200 });
      if (setting === "standalone") {
        await browserExpect(page.getByText("A different install organizes this mailbox.", { exact: true })).toBeVisible();
      }
    } finally { await close(); }
  }, 120_000);

  it("only offers to save a changed phone Away responder", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/away" },
      [], undefined, undefined, {}, undefined, undefined, dataReplies);
    try {
      await browserExpect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Back on Monday");
      await browserExpect(page.getByText("At most once a day", { exact: true })).toBeVisible();
      const save = page.getByRole("button", { name: "Save", exact: true });
      await browserExpect(save).toHaveCount(0);
      await page.getByRole("textbox", { name: "Message" }).fill("Back on Tuesday");
      await browserExpect(save).toBeVisible();
      await page.getByRole("button", { name: "Discard changes", exact: true }).click();
      await browserExpect(page.getByRole("textbox", { name: "Message" })).toHaveValue("Back on Monday");
      await browserExpect(save).toHaveCount(0);
      await page.getByRole("textbox", { name: "Message" }).fill("Back on Tuesday");
      await save.click();
      await askedFor(page, "http", "PUT /away-responder");
      await browserExpect(save).toHaveCount(0);
    } finally { await close(); }
  }, 120_000);

  it("lists only applicable Settings on the standalone phone", async () => {
    const { page, close } = await drawn({ ...CONFIG, setting: "standalone", language: "en", place: "#/settings" });
    try {
      await browserExpect(page.getByRole("button", { name: "Away responder", exact: true })).toBeVisible();
      for (const name of ["Account", "AI", "Subscription", "Storage", "Invites", "Security"]) {
        await browserExpect(page.getByRole("button", { name, exact: true })).toHaveCount(0);
      }
    } finally { await close(); }
  }, 120_000);

  it.each([
    { state: "active", date: null },
    { state: "trialing", date: "Wed 18 Nov" },
  ])("shows only dates the subscription reports for $state", async ({ state, date }) => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/billing" },
      [], undefined, undefined, {}, undefined, undefined, {
        "http:GET /account/access": httpAnswer({ metered: true, lifecycle: { state, trialEndsAt: "2026-11-18T12:00:00Z" }, trialProgress: state === "trialing" ? { day: 8, total: 14 } : undefined }),
      });
    try {
      await browserExpect(page.getByText(state === "active" ? "Active" : "Trial", { exact: true })).toBeVisible();
      await browserExpect(page.getByText("Renewal date", { exact: true })).toHaveCount(0);
      if (date) {
        await browserExpect(page.getByText(date, { exact: true })).toBeVisible({ timeout: 1300 });
        await browserExpect(page.getByText("8 of 14", { exact: true })).toBeVisible();
      }
    } finally { await close(); }
  }, 120_000);

  it("explains what counts against phone Storage without opening a plan", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/storage" },
      [], undefined, undefined, {}, undefined, undefined, dataReplies);
    try {
      await browserExpect(page.getByText("Attachments", { exact: true })).toBeVisible({ timeout: 1400 });
      await page.getByRole("button", { name: "What counts", exact: true }).click();
      await browserExpect(page.getByText("The text of your messages counts, and attachments never do.")).toBeVisible();
    } finally { await close(); }
  }, 120_000);

  it("opens the legal pages from phone About", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", place: "#/settings/about" },
      [], undefined, undefined, {}, undefined, undefined, {
        ...dataReplies, "http:GET /mailboxes": httpAnswer({ items: [
          { id: "mailbox", address: ["here", "example.invalid"].join("@"), status: "connected" },
        ] }),
      });
    try {
      await browserExpect(page.getByRole("group", { name: "Mailboxes", exact: true }).getByText("1", { exact: true })).toBeVisible({ timeout: 1400 });
      for (const name of ["Privacy", "Subprocessors", "Imprint"]) {
        await page.getByRole("button", { name, exact: true }).click({ timeout: 1300 });
      }
      await browserExpect.poll(() => page.evaluate(() => {
        const { asked } = (window as unknown as { __native: { asked: { act?: string }[] } }).__native;
        return asked.filter((ask) => ask.act === "about.page").length;
      })).toBe(3);
    } finally { await close(); }
  }, 120_000);

  it("lets someone cancel native sign-out and return to an active Account pane", async () => {
    const { page, close } = await openedAccount("account");
    try {
      const signOut = page.getByRole("button", { name: "Sign out", exact: true });
      await signOut.click();
      await askedFor(page, "act", "signOut");
      await browserExpect(signOut).toBeEnabled({ timeout: 1400 });
    } finally { await close(); }
  }, 120_000);

  it("opens New mail from phone Settings and shows the device's answer to each choice", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en" }, [], undefined, undefined, {
      wake: {
        os: "android", state: { k: "no_distributor" },
        choices: [{ id: "fixture.helper", name: "Wake helper" }], chosen: null, busy: false,
      },
    });
    try {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings", exact: true }).click({ timeout: 4_000 });
      const notifications = page.getByRole("button", { name: "Notifications", exact: true });
      await notifications.click();
      const choice = page.getByRole("radio", { name: "Wake helper" });
      const off = page.getByRole("radio", { name: "None" });
      await browserExpect(page.getByText("New mail", { exact: true })).toBeVisible();
      await browserExpect(off).toBeChecked();
      await choice.click();
      await browserExpect(choice).toBeChecked();
      await off.click();
      await browserExpect(off).toBeChecked();
      await browserExpect(page.getByText(/No push distributor is chosen on this phone/)).toBeVisible();
      await page.getByRole("button", { name: "Back to Settings" }).click();
      await browserExpect(notifications).toBeVisible();
      const wakeRequests = await page.evaluate(() => {
        const native = (window as unknown as { __native: { asked: { kind: string; do?: string; distributor?: string }[] } }).__native;
        return native.asked.filter((a) => a.kind === "phone.wake").map((a) => [a.do, a.distributor]);
      });
      expect(wakeRequests).toEqual([["read", undefined], ["choose", "fixture.helper"], ["off", undefined]]);
    } finally {
      await close();
    }
  }, 120_000);

  it("opens General on this phone and writes only the sender name it edits", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en", setting: "standalone" }, [], undefined, undefined, {
      names: [
        { id: "first", address: "First mailbox", name: "First name" },
        { id: "second", address: "Second mailbox", name: "Second name" },
      ],
      refuseFirstNameRead: true,
      refuseName: "Refused name",
    });
    try {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings", exact: true }).click();
      const general = page.getByRole("button", { name: "General", exact: true });
      await general.click({ timeout: 4_000 });
      const first = page.getByRole("textbox", { name: "First mailbox" });
      const second = page.getByRole("textbox", { name: "Second mailbox" });
      await browserExpect(page.getByText("Your name", { exact: true })).toBeVisible();
      await browserExpect(page.getByRole("status").filter({ hasText: "This part of ohmail couldn't load." })).toBeVisible();
      await page.getByRole("button", { name: "Try again", exact: true }).click();
      await browserExpect(first).toHaveValue("First name");
      await browserExpect(second).toHaveValue("Second name");
      await second.fill("n".repeat(101));
      await second.press("Enter");
      await browserExpect(page.getByText("Your name can hold up to 100 characters, on one line.")).toBeVisible();
      await second.fill("Refused name");
      await second.press("Enter");
      await browserExpect(page.getByText("That did not save, so try again.")).toBeVisible();
      await browserExpect(second).toHaveValue("Refused name");
      await second.fill("Updated sender name");
      await second.press("Enter");
      await browserExpect(page.getByText("Saved", { exact: true })).toBeVisible();
      await browserExpect.poll(() => page.evaluate(() => {
        const native = (window as unknown as { __native: { asked: { kind: string; path?: string; name?: string }[] } }).__native;
        const saved = native.asked.findIndex((entry) => entry.kind === "phone.name" && entry.name === "Updated sender name");
        return saved < 0 ? 0 : native.asked.slice(saved + 1).filter((entry) => entry.kind === "http" && entry.path?.split("?")[0] === "/sync").length;
      }), { timeout: 4_000 }).toBe(1);
      await browserExpect(first).toHaveValue("First name");
      await page.getByRole("button", { name: "Back to Settings" }).click();
      await general.click();
      await browserExpect(second).toHaveValue("Updated sender name");
      const writes = await page.evaluate(() => {
        const native = (window as unknown as { __native: { asked: { kind: string; do?: string; mailboxId?: string; name?: string }[] } }).__native;
        return native.asked.filter((a) => a.kind === "phone.name" && a.do === "save").map((a) => [a.mailboxId, a.name]);
      });
      expect(writes).toEqual([["second", "Refused name"], ["second", "Updated sender name"]]);
    } finally {
      await close();
    }
  }, 120_000);

  it("keeps a paired phone from asking for standalone sender names", async () => {
    const { page, close } = await drawn({ ...CONFIG, language: "en" }, [], undefined, undefined, {}, undefined, undefined, {
      "act:language.set": { language: "de" },
    });
    try {
      await page.getByRole("button", { name: "More", exact: true }).click();
      await page.getByRole("dialog", { name: "More" }).getByRole("button", { name: "Settings", exact: true }).click();
      await browserExpect(page.getByRole("button", { name: "Notifications", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "General", exact: true }).click();
      await browserExpect(page.getByText("Appearance", { exact: true })).toBeVisible();
      await browserExpect(page.getByText("Your name", { exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "Dark", exact: true }).click();
      await browserExpect(page.locator("html")).toHaveAttribute("data-scheme", "dark");
      await page.getByRole("button", { name: "Deutsch", exact: true }).click();
      await browserExpect(page.getByRole("heading", { name: "Allgemein", exact: true })).toBeVisible();
      expect(new URL(page.url()).hash).toBe("#/settings/general");
      const askedForName = await page.evaluate(() => {
        const native = (window as unknown as { __native: { asked: { kind: string }[] } }).__native;
        return native.asked.some((entry) => entry.kind === "phone.name");
      });
      expect(askedForName).toBe(false);
    } finally {
      await close();
    }
  }, 120_000);

  for (const [language, places] of [["en", "Places"], ["de", "Orte"]] as const) {
    it(`draws the frame in its ${language} words, says it drew, and asks nothing of any address`, async () => {
      const { page, left, outside, close } = await drawn({ ...CONFIG, language });
      try {
        const dock = page.getByRole("navigation", { name: places });
        await expect(dock.count()).resolves.toBe(1);
        const asked = await page.evaluate(() => (window as unknown as { __native: { asked: { kind: string; path?: string }[] } }).__native.asked);
        // Words first, then the setting, then the copy's queue from the keeper, before any request of the engine's.
        expect(asked.slice(0, 2).map((a) => a.kind)).toEqual(["kept", "config"]);
        expect(asked.filter((a) => a.kind === "http").every((a) => a.path!.startsWith("/") && !a.path!.startsWith("//"))).toBe(true);
        expect(asked.filter((a) => a.kind === "ready")).toHaveLength(1);
        expect(left).toEqual([]);
        expect(outside).toEqual([]);
      } finally {
        await close();
      }
    }, 120_000);
  }

  it("reads the measured backup state and shares only after a second press", async () => {
    const { page, left, outside, close } = await drawn(
      { ...CONFIG, language: "en", os: "ios", place: "#/settings/about" }, [], undefined, undefined,
      undefined, undefined, undefined, {
        "act:backup.read": { backup: "included" },
        "phone.diagnostics:write": { fileName: "diagnostic.json" },
        "phone.diagnostics:share": { shared: false },
      },
    );
    try {
      await page.getByText("The copied mail is in a backup.", { exact: false }).waitFor();
      await page.getByText("On an iPhone the pairing stays", { exact: false }).waitFor();
      const share = page.getByRole("button", { name: "Share file" });
      expect(await share.count()).toBe(0);
      await page.getByRole("button", { name: "Write file" }).click();
      await page.getByText("Written to diagnostic.json", { exact: false }).waitFor();
      const diagnosticPresses = () => page.evaluate(() => {
        const native = (window as unknown as { __native: { asked: { kind: string; do?: string }[] } }).__native;
        return native.asked.filter((a) => a.kind === "phone.diagnostics").map((a) => a.do);
      });
      expect(await diagnosticPresses()).toEqual(["write"]);
      await share.click();
      await page.getByText("This phone could not open the share sheet.", { exact: false }).waitFor();
      expect(await diagnosticPresses()).toEqual(["write", "share"]);
      expect(await share.isEnabled()).toBe(true);
      expect(left).toEqual([]);
      expect(outside).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);

  it("asks before handing back the mailbox shown in Settings", async () => {
    const row = {
      id: "mailbox", address: "Current mailbox", tag: "organizing", notes: [], warnings: [],
      start: false, stop: true, explainBackground: false, notifications: false,
    };
    const { page, close } = await drawn(
      { ...CONFIG, setting: "standalone", language: "en", place: "#/settings/mailboxes" }, [], undefined, undefined,
      undefined, undefined, undefined, { "phone.organize:read": { rows: [row] }, "phone.organize:stop": { rows: [] }, "phone.mailbox:list": { rows: [] } },
    );
    try {
      const stop = page.getByRole("button", { name: "Stop organizing here" });
      const dialog = page.getByRole("dialog");
      const stops = () => page.evaluate(() => {
        const native = (window as unknown as { __native: { asked: { kind: string; do?: string }[] } }).__native;
        return native.asked.filter((a) => a.kind === "phone.organize" && a.do === "stop").length;
      });
      await stop.click();
      await dialog.getByRole("button", { name: "Keep organizing" }).click();
      expect(await stops()).toBe(0);
      await stop.click();
      await dialog.getByRole("button", { name: "Hand the mailbox back" }).click();
      expect(await stops()).toBe(1);
    } finally {
      await close();
    }
  }, 120_000);

  it("uses the shared mailbox editor on the standalone phone", async () => {
    const row = {
      id: "mailbox", address: "Current mailbox", status: "active", provider: "other", authKind: "password",
      errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null,
    };
    const { page, close } = await drawn(
      { ...CONFIG, setting: "standalone", language: "en", place: "#/settings/mailboxes" }, [], undefined, undefined,
      undefined, undefined, undefined, {
        "phone.organize:read": { rows: [] },
        "phone.mailbox:list": { rows: [row] },
        "phone.mailbox:edit": { edited: { ok: true, value: null } },
      },
    );
    try {
      await page.getByRole("button", { name: /Current mailbox/ }).click();
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await page.getByLabel("App password for this mailbox", { exact: true }).fill("fixture password");
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await page.getByLabel("App password for this mailbox", { exact: true }).waitFor({ state: "hidden" });
      const operations = await page.evaluate(() => {
        const native = (window as unknown as { __native: { asked: { kind: string; do?: string }[] } }).__native;
        return native.asked.filter((a) => a.kind === "phone.mailbox").map((a) => a.do);
      });
      expect(operations.filter((action) => action === "edit")).toHaveLength(1);
      expect(await page.getByRole("button", { name: "Add a mailbox" }).count()).toBe(0);
      expect(await page.getByRole("button", { name: "Remove" }).count()).toBe(0);
    } finally {
      await close();
    }
  }, 120_000);

  for (const [label, draft] of [
    ["IMAP host", "fixture-server"],
    ["App password for this mailbox", "fixture password"],
  ] as const) {
    it(`keeps or discards the inline mailbox edit after Back with unsaved ${label}`, async () => {
      const row = {
        id: "mailbox", address: "Current mailbox", status: "active", provider: "other", authKind: "password",
        errorCode: null, disabledReason: null, syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null,
      };
      const { page, close } = await drawn(
        { ...CONFIG, setting: "standalone", language: "en", place: "#/settings/mailboxes" }, [], undefined, undefined,
        undefined, undefined, undefined, { "phone.organize:read": { rows: [] }, "phone.mailbox:list": { rows: [row] } },
      );
      try {
        await page.getByRole("button", { name: /Current mailbox/ }).click();
        await page.getByRole("button", { name: "Edit", exact: true }).click();
        const field = page.getByLabel(label, { exact: true });
        const back = (askId: number, delay = false) => page.evaluate(([id, wait]) => {
          (window as unknown as { __native: { back(id: number, delay: boolean): void } }).__native.back(id, wait);
        }, [askId, delay] as const);
        const dialog = page.getByRole("alertdialog");
        expect(await field.inputValue()).toBe("");
        await back(1, true);
        await field.fill(draft);
        await page.evaluate(() => {
          (window as unknown as { __native: { finishAcknowledgement(): void } }).__native.finishAcknowledgement();
        });
        await dialog.getByRole("button", { name: "Keep editing" }).click({ timeout: 2500 });
        expect(await field.inputValue()).toBe(draft);

        await back(2);
        await dialog.getByRole("button", { name: "Discard changes" }).click();
        await page.waitForFunction(() => {
          const native = (window as unknown as { __native: { asked: { askId?: number; took?: unknown }[] } }).__native;
          return native.asked.some((a) => a.askId === 2 && a.took === "discard");
        });
        expect(await field.inputValue()).toBe(draft);
        const edits = await page.evaluate(() => {
          const native = (window as unknown as { __native: { asked: { kind: string; do?: string }[] } }).__native;
          return native.asked.filter((a) => a.kind === "phone.mailbox" && a.do === "edit").length;
        });
        expect(edits).toBe(0);
        await page.evaluate(() => {
          (window as unknown as { __native: { finishExit(): void } }).__native.finishExit();
        });
        await field.waitFor({ state: "detached" });
        expect(await page.getByRole("button", { name: "Edit", exact: true }).count()).toBe(1);
      } finally {
        await close();
      }
    }, 120_000);
  }

  /*
   * The page's words stand in the design's face, from the page's own files: the face the dock is set in is the first
   * a look of the design asks for, and asked for, a face of it loads from the files the page is served with. Without
   * the faces the browser draws a fallback face and `document.fonts` holds none.
   */
  it("draws its words in the design's face, loaded from the page's own files", async () => {
    const { page, left, outside, close } = await drawn({ ...CONFIG, language: "en" });
    try {
      const seen = await page.getByRole("navigation", { name: "Places" }).evaluate(async (dock) => {
        const unquoted = (family: string) => family.trim().replace(/^["']|["']$/g, "");
        const face = unquoted(getComputedStyle(dock).fontFamily.split(",")[0]!);
        // The page in this state shows no words yet (the dock is its icons), so it asks for its face as a word would.
        await document.fonts.load(`16px "${face}"`, "Ohbox Später");
        await document.fonts.ready;
        return { face, loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => unquoted(f.family)) };
      });
      const asked = Object.values(design.faces).flatMap((face) => Object.values(face))
        .flatMap((look) => [look["f-text"], look["f-display"]].map((stack) => stack.split(",")[0]!.replaceAll('"', "")));
      expect(asked).toContain(seen.face);
      expect(seen.loaded).toContain(seen.face);
      expect(left).toEqual([]);
      expect(outside).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);

  /*
   * The frame stands #root at its parent's height, and the page's own document is that parent's parent: it hands html
   * and body the window's box. Without it the frame has no height at all, and the dock at its foot stands above the
   * window. The phone held upright, then turned.
   */
  for (const size of [{ width: 390, height: 844 }, { width: 844, height: 390 }]) {
    it(`stands the frame at the window's box at ${size.width} by ${size.height}, its dock inside it, and the document does not scroll`, async () => {
      const { page, close } = await drawn({ ...CONFIG, language: "en" }, [], undefined, size);
      try {
        const seen = await page.getByRole("navigation", { name: "Places" }).evaluate((dock) => {
          const frame = dock.closest("#root > *")!.getBoundingClientRect();
          window.scrollTo(0, 10_000);
          const foot = dock.getBoundingClientRect();
          return {
            frame: { x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) },
            dockInside: foot.top >= 0 && foot.bottom <= window.innerHeight,
            scrolled: window.scrollY,
          };
        });
        expect(seen).toEqual({ frame: { x: 0, y: 0, ...size }, dockInside: true, scrolled: 0 });
      } finally {
        await close();
      }
    }, 120_000);
  }

  it("judges its storage at the start by the scope native names: this mailbox's word comes back, another mailbox's letter stays", async () => {
    const mine = `ohmail.ui.compose.${CONFIG.scope}.phone`;
    const session = `ohmail.compose.session.${CONFIG.scope}.phone`;
    const theirs = `ohmail.ui.compose.p${"b".repeat(32)}.c1`;
    // Another mailbox's page left its refused letter and a reply under no owner's name; this mailbox's keeper holds a
    // letter the storage lacks. No key in the storage names this mailbox: its scope can only come from native.
    const stored: [string, string][] = [[theirs, "the other mailbox's refused letter"], ["ohmail.ui.reply:m1", "a reply under no owner's name"]];
    const { page, close } = await drawn({ ...CONFIG, language: "en" }, stored, {
      words: [[mine, "this mailbox's kept letter"], [session, "this mailbox's compose session"]],
      refused: [],
    });
    try {
      const now = await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), [mine, theirs, "ohmail.ui.reply:m1"]);
      expect(now).toEqual(["this mailbox's kept letter", "the other mailbox's refused letter", null]);
      await expect(page.evaluate((key) => localStorage.getItem(key), session)).resolves.toBe("this mailbox's compose session");
      const asked = await page.evaluate(() => (window as unknown as { __native: { asked: { kind: string }[] } }).__native.asked);
      expect(asked.filter((a) => a.kind === "keep")).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);
});

function enrollmentFixture() {
  const value = "JBSW".repeat(4);
  const link = new URL("otpauth://totp/Fixture");
  link.searchParams.set("secret", value);
  return { secret: value, otpauthUrl: link.href };
}

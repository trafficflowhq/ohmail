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
import type { ShellConfig } from "../src/shell/bridge-kinds";
import { BENCH_MARKER, buildShell, policyOf } from "../scripts/build-shell.mjs";
import { design } from "@ohmail/tokens/design";

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");

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

  /** The native side as the page sees it: answers by kind, records every kind and every http path asked. */
  function nativeDouble({ config, kept }: { config: ShellConfig; kept: KeptReading }) {
    const w = window as unknown as Record<string, unknown>;
    const asked: { kind: string; path?: string; place?: string }[] = [];
    const listeners: ((e: { data: string }) => void)[] = [];
    const answers: Record<string, () => object> = {
      kept: () => kept, config: () => config, keptRows: () => ({ rows: [] }), keepRows: () => ({ kept: true }),
      keep: () => ({ kept: true }), http: () => ({ status: 503, headers: [["content-type", "application/json"]], body: { as: "text", text: "{\"error\":{\"code\":\"not_ready\"}}" } }),
    };
    w.__native = { asked };
    w.ohmailShell = {
      postMessage(text: string) {
        const m = JSON.parse(text) as { id: number; epoch: string; kind: string; path?: string; place?: string };
        asked.push({ kind: m.kind, path: m.path, place: m.place });
        const answer = { ...(answers[m.kind]?.() ?? {}), id: m.id, epoch: m.epoch, ok: true };
        setTimeout(() => { for (const l of listeners) l({ data: JSON.stringify(answer) }); }, 0);
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
  ) {
    const built = await buildShell({ out });
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
      await page.addInitScript(nativeDouble, { config, kept });
      await page.addInitScript((rows) => { if (window === window.top) for (const [k, v] of rows) localStorage.setItem(k, v); }, stored);
      await page.goto(`${origin}/shell/index.html?epoch=e1`);
      await page.waitForFunction(() => (window as unknown as { __native: { asked: { kind: string }[] } }).__native.asked.some((a) => a.kind === "ready"));
      return { page, left, outside, close };
    } catch (fault) {
      await close();
      throw fault;
    }
  }

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
    const mine = `ohmail.ui.compose.${CONFIG.scope}.c1`;
    const theirs = `ohmail.ui.compose.p${"b".repeat(32)}.c1`;
    // Another mailbox's page left its refused letter and a reply under no owner's name; this mailbox's keeper holds a
    // letter the storage lacks. No key in the storage names this mailbox: its scope can only come from native.
    const stored: [string, string][] = [[theirs, "the other mailbox's refused letter"], ["ohmail.ui.reply:m1", "a reply under no owner's name"]];
    const { page, close } = await drawn({ ...CONFIG, language: "en" }, stored, { words: [[mine, "this mailbox's kept letter"]], refused: [] });
    try {
      const now = await page.evaluate((keys) => keys.map((key) => localStorage.getItem(key)), [mine, theirs, "ohmail.ui.reply:m1"]);
      expect(now).toEqual(["this mailbox's kept letter", "the other mailbox's refused letter", null]);
      const asked = await page.evaluate(() => (window as unknown as { __native: { asked: { kind: string }[] } }).__native.asked);
      expect(asked.filter((a) => a.kind === "keep")).toEqual([]);
    } finally {
      await close();
    }
  }, 120_000);
});

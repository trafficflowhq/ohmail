import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The Tauri shell's security posture, asserted.
 *
 * Everything ohmail Desktop promises — no network, no filesystem, no commands,
 * no remote origin — lives in four declarative files that nothing else in the
 * repository reads. A silent edit to any of them would keep every other test
 * green while the app quietly grew a capability, so they are checked here in
 * the suite that runs on every push.
 *
 * These are content assertions on config, not behaviour tests. The behaviour
 * lives in two places, and neither of them is here: `scripts/smoke.mjs` runs the
 * built bundle, and `cargo test --features local-engine` starts real processes
 * to prove the engine's lifecycle. What this file adds is the thing neither of
 * those can see — that the shipped build is compiled without any of it.
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");
const readJson = (rel: string) => JSON.parse(read(rel)) as Record<string, never>;

/** "a b; c d" → { a: ["b"], c: ["d"] } */
function directives(csp: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const part of csp.split(";")) {
    const [name, ...values] = part.trim().split(/\s+/);
    if (name) out[name] = values;
  }
  return out;
}

describe("tauri.conf.json", () => {
  const conf = readJson("src-tauri/tauri.conf.json") as never as {
    productName: string;
    version: string;
    identifier: string;
    build: { frontendDist: string };
    app: {
      withGlobalTauri: boolean;
      windows: { label: string; minWidth: number; dragDropEnabled?: boolean }[];
      security: {
        csp: string;
        freezePrototype: boolean;
        dangerousDisableAssetCspModification: boolean;
        assetProtocol: { enable: boolean; scope: string[] };
      };
    };
    bundle: {
      icon: string[];
      windows: { webviewInstallMode: { type: string }; nsis: { installMode: string } };
    };
  };

  it("is ohmail, at the release version, under its own identifier", () => {
    expect(conf.productName).toBe("ohmail");
    // Bare — and now bare EVERYWHERE, not only here. The `-preview` suffix used
    // to hang off package.json and Info.plist to mark "this build cannot update
    // itself yet"; this build ships the auto-updater, so the suffix is retired
    // and the whole product is `0.5.0`. "Beta" is the channel name, never a
    // semver suffix. The MSI bundler rejects a pre-release identifier anyway,
    // and this number reaches the installer filenames (`ohmail_0.5.0_amd64.deb`).
    //
    // 0.5.0 rather than another 0.4.0: 0.4.0 shipped as an interface-only
    // preview, and reusing the number would leave the two sets of checksums
    // ambiguous about which artifact they describe. A version is how a
    // downloader names what they have.
    expect(conf.version).toBe("0.12.0");
    expect(conf.identifier).toBe("io.ohmail.desktop");
  });

  // The version is written in five places and, now that `-preview` is retired,
  // in ONE spelling: bare in tauri.conf.json, Cargo.toml, Cargo.lock,
  // package.json, and Info.plist's CFBundleShortVersionString. A release bumps
  // them together by hand; bumping four of five is the easy mistake, and it
  // ships an installer whose filename disagrees with the tag it was cut from. So
  // the NUMBER is asserted to be one number, whatever it is — this test does not
  // care which version, only that nothing was left behind.
  it("carries one version number, one spelling, everywhere", () => {
    const pkg = JSON.parse(fs.readFileSync(path.resolve(APP, "package.json"), "utf8")) as {
      version: string;
    };
    const cargo = fs.readFileSync(path.resolve(APP, "src-tauri/Cargo.toml"), "utf8");
    const lock = fs.readFileSync(path.resolve(APP, "src-tauri/Cargo.lock"), "utf8");
    const plist = fs.readFileSync(
      path.resolve(APP, "../../public/ohmail/Resources/Info.plist"),
      "utf8",
    );
    const shortVersion = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(
      plist,
    )?.[1];

    /* THE RETIRED `-preview` SUFFIX IS A CLAIM, NOT DECORATION. It used to mark
     * "this build cannot update itself"; the auto-updater now ships, so the
     * suffix is gone and every place carries the bare number. Re-adding
     * `-preview` to any of these — or dropping the bare number out of step —
     * has to fail here and be argued, exactly as dropping the suffix did. */
    expect(pkg.version).toBe(conf.version);
    // Info.plist belongs to the macOS packaging, but the two apps ship one
    // release: its short-version string must be the same bare number.
    expect(shortVersion).toBe(conf.version);
    // The crate the installers are built from, and the lockfile the mirror
    // publishes so a stranger can reproduce them.
    expect(cargo).toContain(`\nversion = "${conf.version}"\n`);
    expect(lock).toContain(`name = "ohmail"\nversion = "${conf.version}"\n`);
  });

  /**
   * THE DESKTOP MAY LAG THE WEB, BUT ONLY WITHIN THE SAME FEATURE RELEASE.
   *
   * The web app deploys continuously and the installers are cut by hand, so the two numbers are
   * genuinely allowed to differ for a while: the workspace can be at `0.7.1` while the shipped
   * `.dmg` is still `0.7.0`, and forcing them equal would mean re-cutting five files and three
   * installers for every web fix.
   *
   * What is NOT allowed is either of the two ways that freedom turns into a lie:
   *
   *  · **The desktop ahead of the workspace.** An installer whose version is a release the
   *    source tree has not reached names something that does not exist.
   *  · **A different feature release.** `0.7.x` against `0.8.x` means the two are no longer the
   *    same product at different patch levels, and a bug report citing "0.7.0" could be about
   *    either. The patch component is where the drift is allowed to live and nowhere else.
   *
   * The comparison is on the ROOT manifest, which is the one place the release number is stated
   * for the whole workspace — the same file the web build inlines for its About pane, so the
   * number a person reads there and the number this test compares against cannot diverge.
   */
  it("is at or behind the workspace release, within the same feature version", () => {
    const root = JSON.parse(
      fs.readFileSync(path.resolve(APP, "../../package.json"), "utf8"),
    ) as { version?: string };
    expect(root.version, "the root package.json states no release version").toBeTruthy();

    const parse = (v: string): [number, number, number] => {
      const parts = v.split(".").map((n) => Number(n));
      expect(parts, `unparseable version ${v}`).toHaveLength(3);
      for (const n of parts) expect(Number.isInteger(n), `unparseable version ${v}`).toBe(true);
      return parts as [number, number, number];
    };

    const [wMajor, wMinor, wPatch] = parse(root.version!);
    const [dMajor, dMinor, dPatch] = parse(conf.version);

    expect(`${dMajor}.${dMinor}`, "desktop and workspace are on different feature releases")
      .toBe(`${wMajor}.${wMinor}`);
    expect(dPatch, "the desktop is ahead of the workspace release").toBeLessThanOrEqual(wPatch);
  });

  /**
   * ONE IDENTIFIER FOR ONE APP, AND IT USED TO BE TWO.
   *
   * This config carried `io.ohmail.desktop.tauri` — a suffix that existed to keep two builds of
   * one product distinguishable to LaunchServices while both could be installed. The cost of that
   * suffix turned out to be larger than the problem it solved, because the identifier is not only
   * a name:
   *
   *  · it is where the app's data directory goes. `app_data_dir()` resolves through it, so the
   *    suffixed build addressed a DIFFERENT directory from the macOS client's — meaning a user
   *    with mail in one would find an empty mailbox in the other, and closing that gap would need
   *    a migration written, tested and kept for ever;
   *  · it is what an update replaces. An installer that hands over to another build of the same
   *    app has to be the same app, and two identifiers are two apps.
   *
   * So the two agree, deliberately. They are one product with one install, and the local checks
   * that used to depend on running both at once are not worth a permanent fork in every path the
   * app touches.
   */
  it("keeps the previous client's bundle identifier, because it is the same install", () => {
    const plist = fs.readFileSync(
      path.resolve(APP, "../../public/ohmail/Resources/Info.plist"),
      "utf8",
    );
    const macOsId = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1];
    expect(macOsId).toBe("io.ohmail.desktop");
    expect(conf.identifier).toBe(macOsId);
    // …and specifically not the suffixed form, so re-adding the fork has to be argued here.
    expect(conf.identifier).not.toMatch(/\.tauri$/);
  });

  it("embeds a local bundle — never a URL", () => {
    expect(conf.build.frontendDist).toBe("../dist");
    expect(JSON.stringify(conf.build)).not.toMatch(/https?:\/\/(?!localhost)/);
  });

  it("locks the CSP down to the bundle, with no connections at all", () => {
    const d = directives(conf.app.security.csp);
    expect(d["default-src"]).toEqual(["'self'"]);
    expect(d["script-src"]).toEqual(["'self'"]);
    expect(d["connect-src"]).toEqual(["'none'"]);
    expect(d["object-src"]).toEqual(["'none'"]);
    expect(d["frame-src"]).toEqual(["'none'"]);
    expect(d["worker-src"]).toEqual(["'none'"]);
    expect(d["base-uri"]).toEqual(["'none'"]);
    expect(d["form-action"]).toEqual(["'none'"]);
    expect(d["frame-ancestors"]).toEqual(["'none'"]);
    // img-src allows data: for the inline SVG/avatar art and blob: for the attachment
    // preview; nothing remote. The blob: entry is the named consumer, not a loosening:
    // `AttachmentPreview` renders a ready image as `<img src={objectUrl}>`, where the URL is
    // minted (engine.ts) from the engine's own retained, type-downgraded Blob — and without
    // blob: here the webview refused the render, so a PNG preview on the desktop was the
    // overlay's header over an empty stage (owner-reported). The widening admits pixels the
    // app already holds and nothing else: a blob: URL is this document's own memory (no
    // request leaves — connect-src stays 'none'), an <img> executes nothing (SVG script does
    // not run in one, and the engine types an SVG blob as octet-stream regardless), and the
    // browser client has shipped the same three sources from day one
    // (security-headers.ts: "img-src 'self' data: blob:"), as does the host door
    // (host-static.ts HOST_CLIENT_CSP). The desktop window was the one surface that lagged.
    expect(d["img-src"]).toEqual(["'self'", "data:", "blob:"]);
    expect(conf.app.security.csp).not.toMatch(/https?:/);
    expect(conf.app.security.csp).not.toMatch(/\*/);
  });

  it("admits blob: for images and for NOTHING else — the preview's widening stays minimal", () => {
    // The regression this pins is directional: the fix for the blank image preview must never
    // creep into a directive where blob: means a document, a script or a worker — those are
    // the execution shapes `AttachmentPreview`'s header forbids, and `frame-src 'none'` /
    // `object-src 'none'` / `worker-src 'none'` above are load-bearing for it.
    const d = directives(conf.app.security.csp);
    for (const [directive, sources] of Object.entries(d)) {
      if (directive === "img-src") continue;
      expect(sources, `${directive} admits blob:`).not.toContain("blob:");
    }
  });

  it("keeps the escape hatches shut", () => {
    expect(conf.app.withGlobalTauri).toBe(false);
    expect(conf.app.security.freezePrototype).toBe(true);
    expect(conf.app.security.dangerousDisableAssetCspModification).toBe(false);
    expect(conf.app.security.assetProtocol.enable).toBe(false);
    expect(conf.app.security.assetProtocol.scope).toEqual([]);
  });

  it("declares one window that stays clean to 390px", () => {
    expect(conf.app.windows).toHaveLength(1);
    expect(conf.app.windows[0]!.label).toBe("main");
    expect(conf.app.windows[0]!.minWidth).toBe(390);
  });

  it("hands drag-and-drop to the web page, not to Tauri's native handler", () => {
    // ABSENT KEY ⇒ DANGEROUS DEFAULT. `dragDropEnabled` defaults to TRUE
    // (tauri-utils config.rs: `#[serde(default = "default_true")] pub
    // drag_drop_enabled`), and true is the setting that BREAKS the app. With it
    // on, Tauri installs a native drag handler whose callback returns `true`
    // unconditionally (tauri-runtime-wry lib.rs, in `with_drag_drop_handler`),
    // and that return value is "I consumed this drag":
    //
    //   · macOS/WKWebView — wry's `draggingEntered:`/`performDragOperation:`
    //     overrides only fall through to `super` when the callback returns
    //     false. Returning true means the OS default never runs, so the page
    //     never receives `dragenter`/`dragover`/`drop`.
    //   · Windows/WebView2 — wry installs an IDropTarget and calls
    //     `SetAllowExternalDrop(false)`, which blocks HTML5 file drops outright.
    //     Tauri's own doc comment on the field says as much: "Disabling it is
    //     required to use HTML5 drag and drop on the frontend on Windows."
    //
    // Two shipping gestures are plain HTML5 drag-and-drop and die with it:
    // dropping a file from the desktop onto an open compose, and dragging a
    // recipient chip between the To/Cc/Bcc rows. (Dragging a list row onto the
    // rail survives either way — it is built on pointer events for exactly this
    // reason.) Nothing in this app listens for Tauri's drag events, so there is
    // no second consumer to lose by turning the native handler off.
    //
    // The key is therefore asserted PRESENT and false. Deleting the line is not
    // a no-op that a diff makes obvious; it is a silent return to the broken
    // default, which is why absence fails here rather than being tolerated.
    expect(conf.app.windows[0]!.dragDropEnabled).toBe(false);
  });

  it("builds Windows installers that never download the WebView2 runtime", () => {
    // Tauri's DEFAULT is downloadBootstrapper: a WiX custom action running
    // `powershell … Invoke-WebRequest https://go.microsoft.com/fwlink/…` in the
    // .msi, and NSISdl::download in the -setup.exe. Both fire at install time
    // on a machine without WebView2 — which would make "it cannot reach the
    // network" false of the thing a stranger actually downloads. The key is
    // easy to lose in a config merge and impossible to see in a diff of the
    // built installer, so it is asserted here as well as in the mirror's CI.
    expect(conf.bundle.windows.webviewInstallMode).toEqual({ type: "skip" });
    // The one bundled mode that also does not download is offlineInstaller,
    // and it costs 127 MB. If someone ever wants it, this line is the
    // conversation.
    expect(conf.bundle.windows.nsis.installMode).toBe("currentUser");
  });

  it("ships the oh. icon family", () => {
    expect(conf.bundle.icon).toContain("icons/icon.ico");
    expect(conf.bundle.icon).toContain("icons/icon.icns");
    for (const rel of conf.bundle.icon) {
      expect(fs.existsSync(path.join(APP, "src-tauri", rel))).toBe(true);
    }
  });
});

describe("capabilities", () => {
  /**
   * TWO FILES NOW, AND THE POINT IS WHAT EACH ONE MAY DO — ASSERTED TOGETHER.
   *
   * A file in `capabilities/` is compiled into EVERY build, so anything written here is carried by
   * the published preview too. There used to be exactly one, `main.json`, granting nothing. The
   * auto-updater adds a SECOND, `updater.json`, and this test would have gone red on
   * `toEqual(["main.json"])` — a deliberate break, rewritten here rather than made to pass:
   *
   *  · `main.json` still grants the MAIN window nothing. `"permissions": []`. This is the empty-grant
   *    lock, and it is the first thing checked — the whole updater design exists to keep it true.
   *  · `updater.json` grants the transient `updater` window EXACTLY one permission,
   *    `core:event:allow-listen`, so it can HEAR the `updater://progress` event and do nothing else.
   *    No `allow-emit` (it cannot make the shell hear anything), no other `core:` permission, no
   *    command. It is scoped to the `updater` window and touches no other.
   *
   * The engine build's runtime grant (`LOCAL_ENGINE_CAPABILITY` in `engine.rs`) is separate and
   * unchanged — it lives in a module the preview does not compile.
   */
  it("grant the main window nothing and the updater window only event-listen", () => {
    const files = fs.readdirSync(path.join(APP, "src-tauri/capabilities")).sort();
    // Exactly these two — a THIRD capability file appearing must fail here until someone decides
    // which window it is for and what it may do.
    expect(files).toEqual(["main.json", "updater.json"]);

    // The main window: still empty. The lock the whole Rust-side updater exists to preserve.
    const main = readJson("src-tauri/capabilities/main.json") as never as {
      windows: string[];
      permissions: unknown[];
    };
    expect(main.windows).toEqual(["main"]);
    expect(main.permissions).toEqual([]);

    // The updater window: exactly one receive-only event permission, and nothing else.
    const updater = readJson("src-tauri/capabilities/updater.json") as never as {
      windows: string[];
      permissions: string[];
    };
    expect(updater.windows).toEqual(["updater"]);
    expect(updater.permissions).toEqual(["core:event:allow-listen"]);
    // Spelled out as well as compared, so a reworded set still has to face each claim: it may
    // listen, it may NOT emit, and it gains no other core API (filesystem, shell, window, updater).
    expect(updater.permissions).toContain("core:event:allow-listen");
    expect(updater.permissions).not.toContain("core:event:allow-emit");
    for (const p of updater.permissions) {
      expect(p).toBe("core:event:allow-listen");
    }
  });
});

describe("the Rust side", () => {
  const main = read("src-tauri/src/main.rs");
  const cargo = read("src-tauri/Cargo.toml");

  it("hand-rolls no command, no socket, no process in the always-compiled file", () => {
    // main.rs is compiled into every build, so what it does NOT contain is a
    // property of the shipped binary. It registers no webview command, and it
    // opens no socket and no process itself — the updater's one network request
    // goes through `tauri-plugin-updater` (see "the auto-updater" below), not
    // through a client hand-rolled here.
    expect(main).not.toMatch(/invoke_handler/);
    expect(main).not.toMatch(/std::(fs|net|process)/);
    expect(main).not.toMatch(/reqwest|hyper|tokio::net/);
  });

  it("depends on tauri plus exactly six plugins, only two of which ship, defaults minus compression", () => {
    expect(cargo).toMatch(/^tauri = \{ version = "2", default-features = false, features = \[$/m);
    // Uncompressed embedding is what makes `strings <installer> | grep http`
    // a real audit rather than a look at a brotli blob.
    expect(cargo).not.toMatch(/"compression"/);
    // The plugins are an ALLOW-LIST, not "none": a SIXTH `tauri-plugin-` appearing must fail
    // this until someone decides it belongs. Scanned over the runtime `[dependencies]` only —
    // `[dev-dependencies]` never ship in the binary.
    const depsStart = cargo.indexOf("[dependencies]");
    const devStart = cargo.indexOf("[dev-dependencies]");
    const runtime = cargo.slice(depsStart, devStart >= 0 ? devStart : undefined);
    const plugins = [...runtime.matchAll(/^(tauri-plugin-[a-z-]+)\b/gm)].map((m) => m[1]).sort();
    expect(plugins).toEqual([
      // Start-at-login, for host mode's always-on role — reached only through the shell's own
      // autostart commands, and enabled only by `local-engine`, like the keystore.
      "tauri-plugin-autostart",
      // `ohmail://`, and the two halves it needs: one registers the scheme and delivers an
      // activation, the other makes that activation reach the copy of the app that is already
      // running instead of launching a second one holding the link.
      "tauri-plugin-deep-link",
      "tauri-plugin-dialog",
      "tauri-plugin-notification",
      "tauri-plugin-single-instance",
      "tauri-plugin-updater",
    ]);
    /* AND FOUR OF THEM ARE NOT IN THE PUBLISHED PREVIEW. The notification centre is reached only
       from the engine build's `notify` command, the two scheme plugins only from a sign-in the
       preview does not have, and the autostart registration only from host mode — all four are
       optional and enabled by `local-engine`. Asserting the plugin list alone would have let an
       unconditional dependency in under a name that looks the same in a diff, which for the
       scheme plugins would mean the preview REGISTERING `ohmail://` on a machine and then
       answering nothing on it — and for autostart, the preview being able to register itself to
       start with somebody's computer. */
    expect(cargo).toMatch(/^tauri-plugin-notification = \{ version = "2", optional = true \}$/m);
    expect(cargo).toMatch(/^tauri-plugin-deep-link = \{ version = "2", optional = true \}$/m);
    expect(cargo).toMatch(/^tauri-plugin-autostart = \{ version = "2", optional = true \}$/m);
    expect(cargo).toMatch(
      /^tauri-plugin-single-instance = \{ version = "2", features = \["deep-link"\], optional = true \}$/m,
    );
    for (const shipped of ["tauri-plugin-dialog", "tauri-plugin-updater"]) {
      expect(runtime, `${shipped} must stay unconditional — it ships in every build`)
        .toMatch(new RegExp(`^${shipped} = "2"$`, "m"));
    }
    // No HAND-ROLLED HTTP client is declared. `tauri-plugin-updater` pulls
    // `reqwest` in transitively — that is the one HTTP client in the binary, and
    // it is reached only from `updater.rs` — but nothing here declares one.
    // Line-anchored so the header comment naming reqwest/hyper does not trip it.
    expect(cargo).not.toMatch(/^(reqwest|hyper|ureq|curl)\b/m);
  });

  /**
   * EVERY .rs FILE IS NAMED HERE, AND THAT IS THE POINT.
   *
   * The rules below are per-file, so a rule is only worth what the file list is worth: a
   * `src/spawn.rs` added tomorrow would be governed by nothing, and every assertion in this
   * describe would stay green while the shell grew a capability. Adding a file therefore fails
   * this test until somebody decides which rules it lives under.
   */
  it("is these thirteen files and no others", () => {
    const files = fs.readdirSync(path.join(APP, "src-tauri/src")).sort();
    expect(files).toEqual([
      // Which door this install came in by, and the environment each one composes. Compiled only
      // under `local-engine`, like `engine.rs` — asserted below, because a feature-off shell
      // configures nothing and must carry no way to.
      "config.rs",
      "config_tests.rs",
      // The OS's default mail app: a read of the current handler and a request that takes each
      // platform's own sanctioned path (macOS consent dialog, the Windows Settings page, Linux
      // xdg-settings) — never a registry write; the module states the rule and its tests pin
      // the argv tables and the closed vocabulary. Compiled only under `local-engine`.
      "default_mail.rs",
      "default_mail_tests.rs",
      "engine.rs",
      "engine_tests.rs",
      // Host mode: publishing the engine's loopback door to the user's own tailnet — the
      // setting, the tailscale invocations (serve, never funnel — mutation-pinned in its own
      // tests), the tray and close-to-hide lifecycle, start-at-login. Compiled only under
      // `local-engine`, asserted below; its own boundary rules are the "host mode's reach"
      // test in this file.
      "host.rs",
      "host_tests.rs",
      "main.rs",
      // The menu bar — the one piece of interface this process draws, and the ONLY file that may
      // install one: a menu goes in through `Builder::setup`, and a second `setup` on the same
      // builder replaces the first with nothing failing to say so. It is always compiled; its
      // navigation submenu is not, because only the engine build's window may hear the event.
      "menu.rs",
      "menu_tests.rs",
      "updater.rs",
      "updater_tests.rs",
    ]);
  });

  /**
   * ONE OWNER FOR THE MENU BAR, AND ONE FOR THE COMMAND TABLE.
   *
   * Both `Builder::setup` and `Builder::invoke_handler` REPLACE what was there rather than adding
   * to it, so a second caller of either silently deletes the first — a menu that never appears, or
   * every command in the app failing to resolve. Neither shows up as a compile error and neither
   * shows up in a diff of the file that lost. `on_menu_event` is the one that genuinely appends,
   * which is why the updater still handles its own item from its own module.
   */
  it("installs one menu and registers one command table", () => {
    const files = ["main.rs", "menu.rs", "updater.rs", "engine.rs"].map((f) =>
      read(`src-tauri/src/${f}`),
    );
    const count = (needle: RegExp) =>
      files.reduce((n, src) => n + [...src.matchAll(needle)].length, 0);
    expect(count(/\.setup\(/g), "more than one Builder::setup — one of them is being discarded")
      .toBe(1);
    expect(count(/\.invoke_handler\(/g), "more than one invoke_handler — one table is being discarded")
      .toBe(1);
    expect(count(/app\.set_menu\(/g), "more than one file installs a menu bar").toBe(1);
    // …and the ones that survive are the ones intended to.
    expect(read("src-tauri/src/menu.rs")).toMatch(/app\.set_menu\(/);
    expect(read("src-tauri/src/engine.rs")).toMatch(/\.invoke_handler\(/);
  });

  /**
   * The published shell has no engine to spawn, so it carries no way to spawn one.
   *
   * `local-engine` is what compiles `engine.rs` into the binary, and it is off. That is the
   * difference between an artifact that cannot start a process and one that merely does not —
   * and it is what keeps the README's "Verify it yourself" section true of the executable a
   * stranger downloads rather than of a branch that happened not to be taken.
   */
  it("compiles the engine's lifecycle out of the default build", () => {
    expect(main).toMatch(/#\[cfg\(feature = "local-engine"\)\]\s*\nmod engine;/);
    // `config.rs` is behind the same gate and for the same reason: the preview configures nothing,
    // so it must carry no way to compose an engine's environment or write a settings file.
    expect(main).toMatch(/#\[cfg\(feature = "local-engine"\)\]\s*\nmod config;/);
    // `host.rs` too: the preview has no engine to publish, so it must carry no tailscale
    // invocation, no tray, and no start-at-login registration — a capability compiled out, not
    // a branch not taken.
    expect(main).toMatch(/#\[cfg\(feature = "local-engine"\)\]\s*\nmod host;/);
    // `default` exists and is empty. A missing `[features]` block would also match "not
    // enabled", and would be a different fact.
    expect(cargo).toMatch(/^default = \[\]$/m);
    // serde_json dropped OUT of the feature: `tauri::generate_context!` embeds the
    // updater's `plugins` config as a `serde_json::Value`, so the crate references
    // serde_json in every build now and it is a direct, non-optional dependency.
    // It compiles nothing new — tauri already pulls it — so the graph is unchanged.
    /* THE FEATURE LIST IS READ OFF THE `local-engine = [...]` LITERAL RATHER THAN MATCHED AS ONE
       LINE. It outgrew a readable line when the URL scheme landed, and a whole-literal regex has
       to be retyped from the diff every time an entry moves. What matters is the SET: an optional
       dependency added to `[dependencies]` and not enabled here is a crate the local build cannot
       use, and one added here without `optional = true` is a crate the PREVIEW links against. */
    const feature = /^local-engine = \[([\s\S]*?)^\]$/m.exec(cargo)?.[1] ?? "";
    const enabled = [...feature.matchAll(/"([^"]+)"/g)].map((m) => m[1]!).sort();
    expect(enabled, "the local-engine feature list has stopped matching this reader").toEqual([
      "dep:getrandom",
      "dep:keyring",
      // Start-at-login, driven only from host mode's arming ceremony and the shell's own
      // autostart commands. Optional for the reason the keystore is: the preview must carry no
      // way to register itself to start with anybody's computer.
      "dep:tauri-plugin-autostart",
      // The `ohmail://` scheme handler, and the "one copy of this app" rule that makes an
      // activation reach the copy already running rather than launching a second one. Optional for
      // the reason the keystore is: the preview has no account to sign in to, so a build that
      // registered the scheme would be claiming a machine-wide namespace it cannot answer.
      "dep:tauri-plugin-deep-link",
      "dep:tauri-plugin-notification",
      "dep:tauri-plugin-single-instance",
      // The tray icon — host mode's window into an app whose window is closed. A TAURI feature
      // rather than a dependency, listed here so the preview neither draws a tray nor carries
      // the capability to.
      "tauri/tray-icon",
    ]);
    expect(cargo).toMatch(/^serde_json = "1"$/m);
    // The keystore dependencies stay optional: the preview has no business being
    // linked against the OS keystore at all — it stores nothing, so it needs
    // nowhere to store it. Enabled only by `local-engine`, which is off.
    expect(cargo).toMatch(/^keyring = \{ version = "4", optional = true \}$/m);
    expect(cargo).toMatch(/^getrandom = \{ version = "0.3", optional = true \}$/m);
  });

  /**
   * THE WINDOW'S GRANT IS A PROPERTY OF THE BUILD, NOT OF A PERMISSION LIST.
   *
   * The local build gives the webview four commands — that is the bridge and the door picker, and
   * it is the point of the feature. What must stay true of the PUBLISHED build is that it has
   * none of them: no command is registered, and nothing exists for a capability to reference. Both
   * halves are checked, because either one alone can be true while the other is not.
   *
   * `build.rs` is the harder half and the more important one: a command that is not declared there
   * has no `allow-…` permission for any capability to name, so it is not possible to grant what was
   * never declared. It is conditional on the same feature.
   *
   * ── AND THE HALF THAT ONLY FAILS AT RUNTIME ─────────────────────────────────────────────────
   *
   * The two lists have to hold the SAME four names. A command registered by `generate_handler!`
   * but absent from `build.rs` compiles perfectly and then panics on launch, because the capability
   * naming its `allow-…` permission cannot be resolved — so neither `cargo check` nor `cargo test`
   * can see it. The set equality below is the only thing that does.
   */
  it("declares and registers its nineteen commands only in the local build", () => {
    const build = read("src-tauri/build.rs");
    const engine = read("src-tauri/src/engine.rs");
    // Host mode's and the default-mail commands are DEFINED in their own modules; registration
    // and the grant stay in engine.rs (the one invoke_handler, the one capability), so the
    // per-command sweep below reads all three.
    const hostModule = read("src-tauri/src/host.rs");
    const defaultMailModule = read("src-tauri/src/default_mail.rs");
    const COMMANDS = [
      "engine_status",
      "engine_request",
      "engine_configure",
      "engine_logout",
      // The two the WINDOW drives rather than the shell — a notice in the operating system's
      // notification centre, and the count on the dock icon.
      "notify",
      "set_badge",
      // The one place the window may reach the web, and it may not name it: the command takes a
      // KEY and the shell's own table decides which ohmail.app page that is. A URL argument would
      // mean anything that got a string into the page could open an arbitrary address in the
      // user's real browser.
      "open_link",
      // The one place the window DOES hand this process an address of its own: an http/https link
      // a person pressed inside a message, opened in their browser and never in the webview.
      // `engine.rs` validates the URL. These two were granted to the window without being declared
      // here, which resolved to nothing at window creation and aborted the process on launch —
      // 0.9.7 shipped that way, so the set equality below is the guard that was missing, not a
      // hypothetical one.
      "open_external",
      // The bytes of one attachment and a display name, written under the shell's own directory
      // and opened in the platform's usual viewer.
      "open_attachment",
      // HOST MODE — all of it through the shell's own commands, none of it through a plugin's
      // permissions. The window reads a typed state, probes the tailnet, arms and disarms (the
      // serve invocation is composed from constants in host.rs and pinned by its tests to
      // serve-never-funnel), toggles start-at-login, and opens Tailscale's download page — one
      // more CONSTANT address the shell owns, still no URL argument anywhere.
      "host_state",
      "tailscale_status",
      "tailscale_serve_arm",
      "tailscale_serve_disarm",
      "autostart_get",
      "autostart_set",
      "open_tailscale_download",
      // A mailto: activation, TAKEN rather than pushed — the shell holds the link and the window
      // claims it exactly once, which is what makes the click that STARTS the app deliverable
      // (an event emitted before the page's scripts run is an event nobody hears).
      "mailto_claim",
      // The OS's default mail app: a read in a closed three-word vocabulary, and a request that
      // takes each platform's own sanctioned path — macOS's consent dialog, the Windows Settings
      // page (one more CONSTANT address the shell owns), xdg-settings on Linux — and never a
      // registry write. `default_mail.rs` states the rule; its tests pin the argv tables.
      "default_mail_status",
      "default_mail_request",
    ];

    expect(build).toMatch(/CARGO_FEATURE_LOCAL_ENGINE/);
    /* THE NAMES ARE READ OFF THE `WINDOW_COMMANDS` CONST, NOT MATCHED BY SHAPE.
       This used to scan build.rs for `"engine_…"` literals, which is a filter and not a census:
       the two commands added with the native chrome are not named `engine_*`, so a pattern like
       that would have declared the set equal while silently ignoring both — and a command missing
       from build.rs has no `allow-…` permission for the capability to reference, which panics on
       launch and is invisible to `cargo check` and `cargo test` alike.

       The list moved out of the `.commands(&[…])` call into a const, because the RUNTIME half now
       reads it too: build.rs bakes it in as `OHMAIL_WINDOW_COMMANDS` so `engine.rs` can compare a
       grant against what was actually declared before tauri is handed it. So the census reads the
       const — and asserts BOTH of its consumers still take it, or this test would go on reading a
       list the build had stopped using. */
    expect(build, "build.rs no longer declares its commands from WINDOW_COMMANDS")
      .toMatch(/\.commands\(WINDOW_COMMANDS\)/);
    expect(build, "WINDOW_COMMANDS is no longer baked in for the runtime check")
      .toMatch(/OHMAIL_WINDOW_COMMANDS=/);
    const list = /const WINDOW_COMMANDS: &\[&str\] = &\[([^\]]*)\]/s.exec(build)?.[1] ?? "";
    const declared = [...list.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(declared.length, "build.rs declares no commands at all — the harness found nothing")
      .toBe(COMMANDS.length);
    expect(declared.sort(), "build.rs declares a different set from the one below").toEqual(
      [...COMMANDS].sort(),
    );

    for (const command of COMMANDS) {
      // Defined, registered, and granted — the three places a name has to appear, and the ones a
      // half-added command is missing from. Definitions live in engine.rs, host.rs or
      // default_mail.rs; the registration and the grant are engine.rs's alone (one
      // invoke_handler, one capability).
      // `[<(]` because several are generic over the runtime: a command taking an `AppHandle`
      // has to name the runtime it belongs to, or the handler cannot be built for one.
      expect(engine + hostModule + defaultMailModule, `${command} is not defined`).toMatch(
        new RegExp(`fn ${command}[<(]`),
      );
      expect(engine, `${command} is not registered`).toMatch(
        new RegExp(`generate_handler!\\[[^\\]]*${command}`, "s"),
      );
      expect(engine, `${command} is not granted`).toContain(
        `allow-${command.replace(/_/g, "-")}`,
      );
    }

    /* AND `open_link` TAKES A KEY. The parameter's type is the whole of the safety argument —
       a `url: String` here would be a way out of the webview into the user's browser with an
       address the page chose. The table it resolves against lives in Rust, which is also what
       keeps the bundle free of any host name at all.

       THE SECOND PARAMETER IS NAMED HERE RATHER THAN THE ASSERTION BEING LOOSENED. `challenge`
       is 43 characters of base64url the sign-in page needs and the shell validates
       (`link_url_for`, `is_challenge`) before it appends a parameter it spells itself. It is the
       ONLY value the window may contribute to an address, it reaches ONE key, and a malformed one
       is a refusal rather than a page opened without it — all four properties are asserted in
       `engine_tests.rs`. A THIRD parameter, or a rename that let something else through, still
       fails here. */
    expect(engine).toMatch(/fn open_link\(key: String, challenge: Option<String>\)/);
    expect(engine).not.toMatch(/fn open_link\([^)]*url/);
    // The window's value never becomes the address: `open_link` resolves through the table.
    expect(engine).toMatch(/fn link_url_for\(key: &str, challenge: Option<&str>\)/);

    /* THE ONE RUNTIME PERMISSION, AND ONLY THE ONE. The window may HEAR the shell's events —
       which is how a chosen menu item reaches the frontend's navigation — and has no matching
       `allow-emit`, so it cannot make the shell hear anything. Granting the pair is the easy
       thing to write and would have handed the page a way to fire the app's own events. */
    expect(engine).toContain("core:event:allow-listen");
    expect(engine).not.toContain("core:event:allow-emit");
    /* And no OTHER core permission crept in beside it. A capability is a list somebody edits,
       and `core:` is the prefix that grants the runtime's own APIs — the filesystem, the shell,
       the window, the updater — none of which this window has any business reaching. */
    const core = [...engine.matchAll(/"(core:[a-z-]+:[a-z-]+)"/g)].map((m) => m[1]!);
    expect(core).toEqual(["core:event:allow-listen"]);

    // Nothing in `main.rs`, still. The registration is a call into `engine.rs`, which the default
    // build does not compile — so "the published shell registers no commands" stays a fact about a
    // file that is ALWAYS compiled rather than about a branch inside one.
    expect(main).not.toMatch(/invoke_handler/);
    expect(main).not.toMatch(/#\[tauri::command/);

    // Everything that reaches the webview or the keystore lives in `engine.rs` (with the settings
    // it composes from in `config.rs`), and both are modules the default build does not compile —
    // `#[cfg(feature = "local-engine")]` on each is asserted just below, and that is the whole
    // gate. Naming the files this way is what makes the check meaningful: it is a statement about
    // WHERE the capability lives, and the file list test above fails if another .rs file appears
    // to hold it instead.
    expect(engine).toMatch(/keyring::Entry::new/);
    expect(main).not.toMatch(/keyring|getrandom/);
    // The settings module reaches neither the keystore nor the webview: it composes an environment
    // and reads and writes one file, which is the whole of it.
    const config = read("src-tauri/src/config.rs");
    expect(config).not.toMatch(/keyring|getrandom|tauri::command|std::process/);
  });

  /**
   * THE TWO HALVES OF THE NAMED-PLACE TABLE SAY THE SAME THING.
   *
   * `open_link` is safe because the window names a KEY and the SHELL owns the addresses. That
   * splits one list across two languages, and the two ways it can drift are both invisible to the
   * checks that exist:
   *
   *  · a key in `WEB_PLACES` with no row in `LINKS` compiles on both sides and is a button that
   *    does nothing — `open_link` answers "not a place this app opens" and the caller shows its
   *    fallback sentence about a browser that would not open, which is a wrong explanation;
   *  · `const LINKS: [(&str, &str); N]` with the wrong N is a Rust compile error, and this repo
   *    has no Rust toolchain outside CI — so it would be found by a release build rather than by
   *    the person who added the row.
   *
   * `engine_tests.rs` asserts what the table MEANS (ours, TLS, no query it did not choose); this
   * asserts that the table and the window agree on what is in it. Source-level for the reason the
   * command census above is: the wiring between two languages has no single place to run.
   */
  it("every place the window can name has a row in the shell's link table", () => {
    const engine = read("src-tauri/src/engine.rs");
    const native = read("src/native.ts");

    const places = [
      ...(/export const WEB_PLACES = \[([\s\S]*?)\] as const;/.exec(native)?.[1] ?? "")
        .matchAll(/"([a-z-]+)"/g),
    ].map((m) => m[1]!);
    const table = /const LINKS: \[\(&str, &str\); (\d+)\] = \[([\s\S]*?)\n\];/.exec(engine);
    expect(table, "the LINKS declaration has stopped matching — this check is looking at nothing")
      .not.toBeNull();
    const rows = [...table![2]!.matchAll(/\(\s*"([a-z-]+)",\s*"([^"]+)"\)/g)].map((m) => ({
      key: m[1]!,
      url: m[2]!,
    }));

    // The harness looked at something. Both sides derive from source, and both derivations are
    // empty-safe — two empty lists agree with each other.
    expect(places.length).toBeGreaterThan(4);
    expect(rows.length).toBe(places.length);
    expect(rows.map((r) => r.key).sort()).toEqual([...places].sort());

    // The declared array length IS the number of rows. Wrong here, and the Rust half does not
    // compile — which nothing local would tell whoever wrote it.
    expect(Number(table![1]), "LINKS declares a length its rows do not fill").toBe(rows.length);

    // And the window still names no address itself: that is the claim the artifact scan rests on.
    expect(native).not.toMatch(/https?:\/\//);
    for (const r of rows) expect(r.url.startsWith("https://ohmail.app/"), r.key).toBe(true);
  });

  /**
   * THE URL SCHEMES BELONG TO THE ENGINE BUILD AND TO NOTHING ELSE.
   *
   * Registering a URL scheme is a claim on a machine-wide namespace: from that moment every
   * `ohmail://…` on the computer — from a mail body, a chat message, a web page — is delivered to
   * whichever program registered it. A feature-off shell has no account, no sign-in and no
   * engine, so a binary built that way must take no name and answer nothing on one, on machines
   * that may also have the real app installed.
   *
   * TWO schemes now, and the second is not ours: `mailto` is the shared, standard name every mail
   * client claims — claiming it is what makes this app a CANDIDATE for the OS's default-mail
   * choice (macOS's picker, the Windows Default-apps page via the installer's Capabilities keys,
   * the .desktop MimeType on Linux), and the deep-link config is ALSO the runtime delivery filter:
   * the plugin only forwards activations whose scheme is configured, so a mailto absent from this
   * list is a mailto the window never hears about.
   *
   * The split is DECLARATIVE and therefore checkable without a Rust toolchain: the schemes are in
   * the engine build's config overlay and must not be in the base config, and both plugins that
   * implement them are compiled only under `local-engine`.
   */
  it("registers its URL schemes in the engine build only", () => {
    const base = readJson("src-tauri/tauri.conf.json") as never as {
      plugins?: Record<string, unknown>;
    };
    const overlay = readJson("src-tauri/tauri.engine.conf.json") as never as {
      plugins?: { "deep-link"?: { desktop?: { schemes?: string[] } } };
    };

    // The base config claims nothing. Asserted on the KEY rather than on the whole `plugins`
    // object, because the updater's entry legitimately lives there and must stay.
    expect(Object.keys(base.plugins ?? {})).toEqual(["updater"]);

    // The engine build claims exactly two schemes: the product's own name, and the mail scheme
    // it is a candidate handler for.
    expect(overlay.plugins?.["deep-link"]?.desktop?.schemes).toEqual(["ohmail", "mailto"]);

    /* AND THE HANDLING IS BEHIND THE SAME FEATURE. `engine.rs` is a module the feature-off shell
       does not compile, so both plugin registrations being in it is what makes the split a
       property of the binary rather than of a config file somebody could copy. `main.rs` is
       compiled into every build and must name neither. */
    const engine = read("src-tauri/src/engine.rs");
    expect(engine).toMatch(/tauri_plugin_deep_link::init\(\)/);
    expect(engine).toMatch(/tauri_plugin_single_instance::init\(/);
    expect(main).not.toMatch(/deep_link|single_instance/);

    /* SINGLE INSTANCE FIRST, and this is an ordering the compiler cannot check. That plugin is
       what decides a second copy of the app should hand over its arguments and exit; registered
       after another plugin, the exit happens after that plugin has already set something up — a
       second copy of a mail client briefly touching the engine's data directory on its way out. */
    expect(
      engine.indexOf("tauri_plugin_single_instance::init("),
      "the single-instance plugin must be registered before every other plugin",
    ).toBeLessThan(engine.indexOf("tauri_plugin_deep_link::init()"));
    expect(engine.indexOf("tauri_plugin_single_instance::init("))
      .toBeLessThan(engine.indexOf("tauri_plugin_notification::init()"));
  });

  /**
   * THE EVENT NAME IS WRITTEN DOWN IN TWO LANGUAGES, like the menu's two and the link table.
   *
   * A Rust binary and a TypeScript bundle share no artifact to import a constant from, so the name
   * of the channel a handoff code arrives on exists twice. Drift is silent in the worst possible
   * way: the shell emits, nothing is listening, and the app simply never comes forward signed in —
   * which is indistinguishable from a scheme that was never registered, from a browser that did
   * not fire the link, and from a code the account refused.
   */
  it("the shell and the window agree on the channel a handoff code arrives on", () => {
    const engine = read("src-tauri/src/engine.rs");
    const native = read("src/native.ts");
    const rust = /pub const LINK_CODE_EVENT: &str = "([^"]+)";/.exec(engine)?.[1];
    const js = /export const LINK_CODE_EVENT = "([^"]+)";/.exec(native)?.[1];
    expect(rust, "LINK_CODE_EVENT has stopped matching in engine.rs").toBeDefined();
    expect(js, "LINK_CODE_EVENT has stopped matching in native.ts").toBeDefined();
    expect(js).toBe(rust);

    // It is a THIRD channel, not one of the menu's two. A code and a route name are different
    // kinds of value, and the frontend validates each on its own terms.
    const menuEvents = [
      /export const MENU_NAVIGATE_EVENT = "([^"]+)";/.exec(native)?.[1],
      /export const MENU_COMMAND_EVENT = "([^"]+)";/.exec(native)?.[1],
    ];
    expect(menuEvents).not.toContain(js);

    /* THE CODE IS NEVER LOGGED BY THE SHELL. It is worth a session for two minutes and a log file
       outlives that by a great deal, so the line that records an activation says only that one
       happened. Asserted as "no `log_line` in this module interpolates the code binding". */
    expect(engine).not.toMatch(/log_line\(format_args!\([^)]*\{code\}/);
  });

  /**
   * THE MAILTO CHANNEL'S TWO LANGUAGES AGREE, the rule the test above states for the handoff code
   * — with the extra half the claim model adds: the event is a POKE and the LINK travels over the
   * claiming command, so the command name has to agree too, or the window is poked toward a claim
   * that resolves to nothing.
   */
  it("the shell and the window agree on the mailto channel, and the shell never logs the link", () => {
    const engine = read("src-tauri/src/engine.rs");
    const native = read("src/native.ts");
    const rust = /pub const MAILTO_EVENT: &str = "([^"]+)";/.exec(engine)?.[1];
    const js = /export const MAILTO_EVENT = "([^"]+)";/.exec(native)?.[1];
    expect(rust, "MAILTO_EVENT has stopped matching in engine.rs").toBeDefined();
    expect(js, "MAILTO_EVENT has stopped matching in native.ts").toBeDefined();
    expect(js).toBe(rust);
    // A fourth channel: not the menu's two, not the handoff code's.
    for (const other of ["MENU_NAVIGATE_EVENT", "MENU_COMMAND_EVENT", "LINK_CODE_EVENT"]) {
      expect(new RegExp(`export const ${other} = "([^"]+)";`).exec(native)?.[1]).not.toBe(js);
    }
    // The claiming command exists under the same name on both sides.
    expect(engine).toMatch(/fn mailto_claim[<(]/);
    expect(native).toContain('const MAILTO_CLAIM_COMMAND = "mailto_claim";');
    // And the shell never logs the link: who somebody writes to is theirs. The handler binds the
    // held link as `link`; no log line may interpolate it.
    expect(engine).not.toMatch(/log_line\(format_args!\([^)]*\{link\}/);
  });

  /**
   * THE DEFAULT-MAIL IDENTITIES ARE THE REGISTERED ONES — the three spellings the OS knows this
   * app by, held together across the four files that state them, because each pair drifting is a
   * detector that answers "not default" forever with nothing on screen able to say why.
   *
   * And the WINDOWS RULE, as bytes: the request arm may open the Settings page and may not write
   * the choice. `UserChoice` is hashed against programmatic defaulting; an app that fought that
   * would deserve the distrust. The installer hook REGISTERS (ProgId + Capabilities +
   * RegisteredApplications — the capability model, in HKCU) and equally never touches UserChoice.
   */
  it("detects default-mail against the identities the installers register, and never writes the choice", () => {
    const defaultMail = read("src-tauri/src/default_mail.rs");
    const hooks = read("src-tauri/windows/hooks.nsh");
    const conf = readJson("src-tauri/tauri.conf.json") as never as { identifier: string };
    const overlay = readJson("src-tauri/tauri.engine.conf.json") as never as {
      bundle?: { windows?: { nsis?: { installerHooks?: string } } };
    };

    // macOS: the bundle id Launch Services answers with is the one tauri.conf.json declares.
    const bundleId = /const MACOS_BUNDLE_ID: &str = "([^"]+)";/.exec(defaultMail)?.[1];
    expect(bundleId, "MACOS_BUNDLE_ID has stopped matching").toBe(conf.identifier);

    // Windows: the ProgId the detector compares against is the one the installer hook registers,
    // and the hook is actually wired into the NSIS build.
    const progId = /const WINDOWS_PROG_ID: &str = "([^"]+)";/.exec(defaultMail)?.[1];
    expect(progId, "WINDOWS_PROG_ID has stopped matching").toBeDefined();
    expect(hooks).toContain(`Software\\Classes\\${progId}`);
    expect(hooks).toContain(`"mailto" "${progId}"`);
    expect(hooks).toContain("Software\\RegisteredApplications");
    expect(overlay.bundle?.windows?.nsis?.installerHooks).toBe("./windows/hooks.nsh");

    // Neither the module nor the hook touches UserChoice's value: the module's ONE reg.exe argv
    // table is the query (asserted as "exactly one reg args function, and it is the query"), no
    // registry API is called directly, and the hook never names UserChoice at all. (`"set"` does
    // appear in the module — it is Linux's `xdg-settings set`, the platform's own sanctioned
    // write, which is exactly the boundary the module states.)
    const regArgFns = [...defaultMail.matchAll(/fn (reg_[a-z_]*args)\(/g)].map((m) => m[1]);
    expect(regArgFns).toEqual(["reg_query_args"]);
    expect(defaultMail).toContain('"query".into()');
    expect(defaultMail).not.toMatch(/RegSetValue|RegCreateKey|windows_registry/);
    // Mentions in prose are fine (the header EXPLAINS UserChoice); a registry VERB naming it is not.
    expect(hooks).not.toMatch(/(WriteRegStr|WriteRegDWORD|DeleteRegKey|DeleteRegValue)[^\n]*UserChoice/);

    // Linux: the desktop entry the detector and the setter name is the bundler's own
    // `{product_name}.desktop`.
    const desktopId = /const LINUX_DESKTOP_ID: &str = "([^"]+)";/.exec(defaultMail)?.[1];
    expect(desktopId).toBe("ohmail.desktop");
  });

  /**
   * THE KEY AN EARLIER VERSION STORED IS COPIED, NEVER MOVED.
   *
   * A machine that has run the previous macOS client already has this install's key, under that
   * client's own coordinates. The shell adopts it rather than minting a fresh one — a fresh key
   * would leave the mailbox password sealed months ago unreadable, with nothing on screen able to
   * say why.
   *
   * The DELETE is the half that has to be asserted rather than reasoned about: the older app may
   * still be installed and still needs that item, so a migration that tidied up after itself would
   * break an app somebody may open five minutes later. The ordering and the fallbacks are proven in
   * Rust (`cargo test --features local-engine`); what this adds is that no delete exists to be
   * called in the first place.
   */
  it("adopts an earlier version's key and never removes it", () => {
    /*
     * THE COORDINATES ARE LITERALS HERE BECAUSE THE SOURCE THEY WERE READ FROM IS GONE.
     *
     * This used to read `defaultService` and `defaultAccount` out of the macOS client's own
     * `KeychainKeyStore.swift`, so the two sides could not drift. That client is retired and its
     * directory is deleted, which changes what "the other side" means: the coordinates are no
     * longer a shared constant between two live programs, they are the fixed, historical address
     * of an item sitting in the Keychain of every machine that ever ran the old app.
     *
     * A fixed address is exactly what must NOT be re-derived. `io.ohmail.desktop` / `kek.v1` are
     * spelled out below, and the point of asserting them is that they can never be "tidied up" to
     * match a newer naming scheme: change either string and the shell mints a fresh key, leaving
     * every mailbox password sealed by the old one unreadable, with nothing on screen able to say
     * why. The literals ARE the contract now; the Swift file was only ever a copy of it.
     */
    const engine = read("src-tauri/src/engine.rs");
    expect(engine).toMatch(/LEGACY_KEYSTORE_SERVICE: &str = "io\.ohmail\.desktop"/);
    expect(engine).toMatch(/LEGACY_KEYSTORE_ENTRY: &str = "kek\.v1"/);
    // Nothing in this module can delete a keystore item.
    expect(engine).not.toMatch(/delete_credential|delete_password/);
  });

  /**
   * The engine's lifecycle owns a child process on a private pipe, one item in the keystore, one
   * file it writes, and two paths it reads the existence of.
   *
   * It opens no socket. `std::fs` USED TO BE FORBIDDEN OUTRIGHT HERE, and the allow-list below is
   * what replaced that; a ban that has to be relaxed is worth nothing, so each entry names the
   * capability it stands for and anything else fails — a `read_to_string`, a `remove_file`, a
   * `copy` appearing in this module is new and has to be argued rather than absorbed.
   *
   * ── `fs::metadata` IS THE NEWEST ENTRY, AND IT RETIRED A CLAIM THIS TEST USED TO MAKE ──────
   *
   * The claim was that the module does not PROBE the filesystem at all: whether the engine existed
   * was answered by trying to start it and reading `NotFound` back, which is one syscall instead of
   * two and cannot go stale between the check and the spawn.
   *
   * **That answer stopped being available when the spawn stopped being the engine.** The engine is
   * a Node program, and the shell now resolves a Node runtime and spawns `<node> <engine>` — the
   * only launch shape that works on Windows, which has no shebang mechanism. So what gets spawned
   * is the runtime, and the runtime is there; a missing engine would come back as a module error
   * and a non-zero exit, i.e. as a crash loop against a build that is behaving exactly as intended.
   * Choosing a runtime has the same shape: "runnable, not merely present" is not a question a spawn
   * can answer, because a file without the execute bit fails with a permission error rather than
   * `NotFound` — a different sentence for the same absence.
   *
   * So the probe is real, and it is bounded rather than hidden: ONE call, in one function
   * (`look`), which reports whether a path is a regular file and whether it is executable, and
   * which every branch of `plan_with` is driven through in the Rust suite. It reads no contents and
   * it opens nothing.
   */
  it("touches the filesystem to write its log, its key file, and to look at two paths", () => {
    const engine = read("src-tauri/src/engine.rs");
    const allowed = new Set([
      "fs::create_dir_all", // the log directory, on first run — and the data directory, for the key file
      "fs::rename", // rotation: one generation kept
      "fs::metadata", // `look`: is the engine there, and is the runtime runnable
      "fs::Metadata", // …and its type, in the one helper that reads the mode
      "fs::PermissionsExt", // the execute bit, on Unix — and the key file's own mode
      /* ── THE KEY FILE'S FIVE, AND THE CONSUMER THEY WERE ADDED FOR ─────────────────────────
       * The per-install key is mirrored to a file beside the app's data, because an ad-hoc
       * signed build is refused its own keystore item as soon as its binary changes and the
       * stored mailbox password would be orphaned on every update. That mirror is the ONLY new
       * consumer of the filesystem in this module, and these are the calls it needs:
       * one open that creates the file with its mode already set, one write, one re-tightening
       * of an existing file's mode, and one read back. Anything beyond them still fails. */
      "fs::OpenOptions", // create the key file
      "fs::OpenOptionsExt", // …with `0600` at creation, never write-then-chmod
      "fs::set_permissions", // re-tighten a file an earlier run or a backup tool widened
      "fs::Permissions", // …the mode handed to it
      "fs::read_to_string", // read the key back — the one read in this module
      /* ── THE OPENED-ATTACHMENT DIRECTORY'S FOUR, AND THE CONSUMER THEY WERE ADDED FOR ──────
       * An attachment could not be opened in this window at all: the web client delivers a file
       * by clicking a hidden `<a download>`, and a webview whose host registered no download
       * handler CANCELS that navigation — silently, which is why every attachment press did
       * nothing. `open_attachment` is the answer, and it is the only reason this module now
       * writes a file it did not write before: the bytes go into a directory under the app's own
       * data directory, each in a holder of its own, and the path is handed to the platform's
       * opener so the file lands in the program this computer already uses for that kind.
       *
       * Four calls, and each is bounded by an assertion further down rather than by this comment:
       * one `create_dir` for the holder (never `create_dir_all`, so a repeated random name is an
       * error rather than a write into somebody else's directory), one `read_dir` and two removals
       * for the sweep that keeps the directory from growing without bound. The removals are the
       * entries this list would have been most wrong to absorb quietly, so what they may reach is
       * asserted below. */
      "fs::create_dir", // the unique holder one opened attachment is written into
      "fs::read_dir", // the sweep, over that directory and nothing else
      "fs::remove_file", // …a swept file
      "fs::remove_dir_all", // …or the holder it sat in
    ]);
    const used = [...engine.matchAll(/\bfs::(\w+)/g)].map((m) => `fs::${m[1]}`);
    // The harness bites only if it found something to classify.
    expect(used.length).toBeGreaterThan(0);
    for (const call of used) {
      expect(allowed, `engine.rs reaches the filesystem through ${call}`).toContain(call);
    }
    // The path is the platform's, not this file's invention — and it is a LOG directory, so
    // nothing here can be pointed at the mail mirror or the user's home by editing a string.
    expect(engine).toMatch(/app_log_dir\(\)/);
    // The one file it opens, and the cap that bounds it.
    expect(engine).toMatch(/LOG_FILE_NAME: &str = "engine\.log"/);
    expect(engine).toMatch(/LOG_MAX_BYTES: u64 = 5 \* 1024 \* 1024/);

    // THE PROBE IS ONE FUNCTION AND IT ONLY ASKS ABOUT THE PATH ITSELF. `metadata` appears exactly
    // once; a second call site is a second place the module could learn something about the disk,
    // which is the widening this entry exists to make visible rather than the one call it permits.
    expect(engine.match(/fs::metadata/g)).toHaveLength(1);
    expect(engine).toMatch(/pub fn look\(path: &Path\) -> Found/);
    // `look` classifies and never reads. The module's ONE read is the key file's own read-back,
    // so the ban is narrowed to a count rather than dropped: a second `read_to_string`, a
    // `File::open` or a directory listing is a new capability and fails here as it always did.
    expect(engine.match(/fs::read_to_string/g)).toHaveLength(1);
    expect(engine).not.toMatch(/fs::File::open/);

    /* ── THE DIRECTORY LISTING AND THE TWO REMOVALS ARE COUNTED, NOT BANNED ────────────────
     * `read_dir` used to be forbidden outright on this line, beside `File::open`. It is here now
     * because opened attachments accumulate and something has to take them away, and the ban is
     * NARROWED TO A COUNT rather than dropped — the same move this file already made for
     * `read_to_string`. One listing and one of each removal: a second listing is a second place
     * this module can learn what is on the disk, and a second removal is a second place it can
     * take something off it.
     *
     * WHAT THEY MAY REACH IS THE POINT, and a count alone would not say it, so the sweep's own
     * signature is asserted: it takes the root it is given and iterates that one directory's
     * entries. Its only caller passes `attachment_root(...)`, which is composed from the app's own
     * data directory and a constant — so there is no path from a value in the window to a file
     * this module can delete. Change the sweep to take a caller-supplied path, or point it
     * anywhere but `attachment_root`, and this goes red. */
    expect(engine.match(/fs::read_dir/g)).toHaveLength(1);
    expect(engine.match(/fs::remove_file/g)).toHaveLength(1);
    expect(engine.match(/fs::remove_dir_all/g)).toHaveLength(1);
    expect(engine).toMatch(/fn sweep_attachments\(root: &Path, keep: Duration\)/);
    expect(engine).toMatch(/let Ok\(entries\) = fs::read_dir\(root\)/);
    expect(engine.match(/sweep_attachments\(&root, ATTACHMENT_KEEP\)/g)).toHaveLength(1);
    expect(engine).toMatch(/const ATTACHMENT_DIR: &str = "opened"/);
    expect(engine).toMatch(/let root = dir\.join\(ATTACHMENT_DIR\)/);

    /* ── AND THE HOLDER IS `create_dir`, WHICH IS THE LINE THAT CANNOT BE RELAXED ──────────
     * The unique component is 16 random bytes, so the directory has never existed. `create_dir_all`
     * would succeed on one that somehow did, writing this attachment's bytes into a holder another
     * one is being read from; `create_dir` fails instead, which is the correct answer to a random
     * source that repeated itself. */
    expect(engine.match(/fs::create_dir\(&holder\)/g)).toHaveLength(1);

    /* The opened attachment is somebody's mail: private at creation on the file, and on the two
     * directories above it, for the same reason the key file is. */
    expect(engine).toMatch(/Permissions::from_mode\(0o700\)/);

    /* ── THE KEY FILE IS PRIVATE AT CREATION, NOT PRIVATE SHORTLY AFTERWARDS ───────────────
     * A key written world-readable and chmoded a moment later has already leaked to anything
     * watching the directory, and the window is exactly as long as a backup daemon needs. The
     * mode is asserted at BOTH places it is set: on the open that creates the file, and on the
     * re-tightening that covers a file an earlier run left behind. Losing either one is a
     * silent downgrade of the only thing protecting the key once the keystore has refused. */
    expect(engine).toMatch(/options\.mode\(0o600\)/);
    expect(engine).toMatch(/Permissions::from_mode\(0o600\)/);
    // …and the key file is the only path this module composes under the data directory.
    expect(engine).toMatch(/KEYSTORE_FILE: &str = /);
  });

  /**
   * THE SETTINGS MODULE IS THE ONLY OTHER FILE THAT TOUCHES DISK, AND ITS LIST IS ITS OWN.
   *
   * The same guard, applied where the second filesystem capability actually landed rather than
   * relaxed where the first one lives. `config.rs` writes and removes exactly two things — the
   * settings file, and the cloud door's sealed session on a sign-out — and every call it uses is
   * named here. A `copy`, a `read_dir` or a `remove_dir_all` appearing in it is a new capability
   * and has to be argued rather than absorbed; `remove_dir_all` in particular is the one that would
   * delete somebody's frozen mirror, which this app's door-switch rule says never happens.
   */
  it("keeps the settings module's filesystem reach to the two files it owns", () => {
    const config = read("src-tauri/src/config.rs");
    const allowed = new Set([
      "fs::create_dir_all", // the app's data directory, on first run
      "fs::read_to_string", // the settings file
      "fs::write", // the settings file
      "fs::set_permissions", // 0600 on it
      "fs::Permissions", // the mode it is set to
      "fs::PermissionsExt", // and the Unix trait that spells the mode
      "fs::remove_file", // the settings file, and the cloud door's sealed session
    ]);
    const used = [...config.matchAll(/\bfs::(\w+)/g)].map((m) => `fs::${m[1]}`);
    expect(used.length).toBeGreaterThan(0);
    for (const call of used) {
      expect(allowed, `config.rs reaches the filesystem through ${call}`).toContain(call);
    }
    // The mirror is frozen on a door switch, never deleted — no recursive removal exists to do it.
    expect(config).not.toMatch(/remove_dir/);
  });

  /**
   * HOST MODE'S REACH IS THE TAILSCALE CLI AND NOTHING ELSE.
   *
   * `host.rs` is the second file in this shell that starts a foreign process, so its boundary is
   * written down the way the filesystem ones are. What it may do: run ONE binary — the Tailscale
   * CLI it discovered — with arguments composed from constants (`serve_arm_args` and friends,
   * whose serve-never-funnel and loopback-literal pins are cargo tests, shown red by mutation).
   * What it may not do: touch the filesystem (its one setting goes through `config.rs`, the
   * settings module, which keeps that guard meaningful), open a socket, or compose a URL from
   * anything the window sent — its one opener call is a constant this test pins.
   */
  it("keeps host mode's reach to one spawned CLI and one constant download page", () => {
    const hostModule = read("src-tauri/src/host.rs");
    // One spawn site. The tests' fake runner is injected, so it does not appear here.
    expect(hostModule.match(/Command::new/g)).toHaveLength(1);
    // No disk and no sockets of its own.
    expect(hostModule).not.toMatch(/\bfs::/);
    expect(hostModule).not.toMatch(/std::net|TcpStream|TcpListener|reqwest|hyper/);
    // The one address it can open is the vendor's download page, spelled once as a constant and
    // passed to the same opener every external link goes through.
    expect(hostModule).toContain(
      'pub const TAILSCALE_DOWNLOAD_URL: &str = "https://tailscale.com/download";',
    );
    expect(hostModule).toMatch(/spawn_opener\(TAILSCALE_DOWNLOAD_URL\)/);
    // And the module is compiled only where the engine is — asserted with the other cfg gates —
    // so none of this exists in the artifact the preview README describes.
  });

  /**
   * The engine's lifecycle owns a child process on a private pipe.
   *
   * It opens no socket. That absence is the whole of what the shell claims about itself, and it
   * has to hold in the file that does the most.
   *
   * `invoke_handler` USED TO BE ON THIS LIST and is deliberately not any more. It was a true
   * statement about a shell that had no engine to talk to; the local build now registers exactly
   * two commands, and pretending otherwise would mean either a false comment or a guard nobody can
   * satisfy. What replaced it is stricter about the thing that actually matters — see
   * "declares and registers its two commands only in the local build", which checks that every
   * command, every capability grant and every keystore call sits behind the feature gate, so the
   * PUBLISHED binary still contains none of them.
   */
  it("spawns a child and nothing else — no sockets", () => {
    const engine = read("src-tauri/src/engine.rs");
    expect(engine).not.toMatch(/std::net/);
    expect(engine).not.toMatch(/reqwest|hyper|ureq|curl|TcpStream|TcpListener|UnixStream/);
    // All three streams are pipes. stdin above all: the write end must belong to this process
    // alone, because closing it is how the engine is asked to leave — and because the kernel
    // closing it when this process dies is what stops an orphaned engine holding an IMAP
    // connection open. An inherited or null stdin silently removes both.
    expect(engine).toMatch(/\.stdin\(Stdio::piped\(\)\)/);
    expect(engine).toMatch(/\.stdout\(Stdio::piped\(\)\)/);
    expect(engine).toMatch(/\.stderr\(Stdio::piped\(\)\)/);
  });
});

describe("the auto-updater", () => {
  const conf = readJson("src-tauri/tauri.conf.json") as never as {
    version: string;
    plugins?: {
      updater?: { endpoints?: string[]; pubkey?: string; windows?: { installMode?: string } };
    };
  };
  const updater = read("src-tauri/src/updater.rs");

  it("points at exactly one pinned HTTPS feed — the project's own releases", () => {
    const endpoints = conf.plugins?.updater?.endpoints ?? [];
    expect(endpoints).toHaveLength(1);
    const url = endpoints[0]!;
    expect(url.startsWith("https://")).toBe(true);
    expect(url).toBe(
      "https://github.com/trafficflowhq/ohmail/releases/latest/download/latest.json",
    );
    // One literal endpoint — no template host, no wildcard.
    expect(url).not.toMatch(/\{\{|\*/);
  });

  /**
   * THE PUBKEY IS THE WHOLE SECURITY OF THE UPDATER, so its presence is asserted
   * two ways: here (a valid, decodable minisign public key ships in the config)
   * and in build.rs (an empty pubkey fails the build — the packaging gate). The
   * negative control below drives the SAME predicate over an emptied and an
   * absent pubkey, so "a build that trusts an unsigned feed" cannot pass.
   */
  const pubkeyIsValid = (c: typeof conf): boolean => {
    const key = c.plugins?.updater?.pubkey;
    if (typeof key !== "string" || key.length < 40) return false;
    let text: string;
    try {
      text = Buffer.from(key, "base64").toString("utf8");
    } catch {
      return false;
    }
    // tauri wraps the minisign public-key FILE as base64; the inner text names
    // it and carries the `RW…` key line.
    return /minisign public key/.test(text) && /\nRW/.test(text);
  };

  it("ships a valid minisign public key to verify every payload against", () => {
    expect(pubkeyIsValid(conf)).toBe(true);
  });

  it("rejects a missing or empty pubkey — the negative control for the packaging gate", () => {
    const emptied = {
      ...conf,
      plugins: { updater: { ...conf.plugins!.updater!, pubkey: "" } },
    };
    expect(pubkeyIsValid(emptied)).toBe(false);

    const absent = { ...conf, plugins: { updater: { ...conf.plugins!.updater! } } };
    delete (absent.plugins.updater as { pubkey?: string }).pubkey;
    expect(pubkeyIsValid(absent)).toBe(false);
  });

  /**
   * INSTALLING IS WHAT CONSENT GATES, AND THE DOWNLOAD IS NOT THE INSTALL.
   *
   * The old flow asked twice — once before the download and again before the restart — with a
   * progress window between them, so one update was three modal interruptions. It now asks ONCE,
   * at the end, and the split that makes that safe is the one asserted here: `Update::download`
   * streams the payload and minisign-verifies it (that verification is the plugin's and is
   * untouched), and `Update::install` is a SEPARATE call that only ever runs from the branch the
   * user pressed. `download_and_install` — the convenience that fused the two — is gone, and a
   * regression back to it would put an install behind a fetch again.
   *
   * The dialog is non-blocking (`show`, not `blocking_show`): the answer arrives on a callback
   * instead of a parked thread, so the app stays usable with the question on screen.
   */
  it("consent gates the INSTALL, is asked once, and never blocks", () => {
    // The two calls are separate, and the fused one is not used.
    expect(updater).toMatch(/\.download\(/);
    expect(updater).toMatch(/\.install\(&payload\.bytes\)/);
    expect(updater).not.toMatch(/download_and_install/);

    // Non-blocking, both for the question and for every notice. Matched as a CALL, so the
    // module's own note about why it does not use the blocking form does not stand in for the
    // fact — a comment is the claim under test, never evidence for it.
    expect(updater).not.toMatch(/\.blocking_show\(/);
    expect(updater).toMatch(/\.show\(move \|now\| \{/);

    /* ASKED ONCE. `prompt_ready` returns early unless the flow still owes the question, and
       `Flow::should_prompt` is false the moment "Later" is answered. Both halves are named,
       because either alone can be true while the other is not — a gate nothing calls, or a call
       with no gate. The boundary table lives in Rust (`updater_tests.rs`), where the transitions
       are driven and each one has been watched go red under a mutated implementation. */
    expect(updater).toMatch(/if !lock\(&state\.flow\)\.should_prompt\(\) \{\s*return;/);
    expect(updater).toMatch(/Signal::Deferred\)? =>? \{?\s*self\.deferred = true;/);

    // And the payload is held in memory, never written down: an update nobody consented to must
    // leave nothing on the machine when the app quits.
    expect(updater).toMatch(/bytes: Vec<u8>/);
    expect(updater).not.toMatch(/write|File::create|tempfile/);
  });

  /**
   * THE MENU ITEM IS THE WHOLE AFFORDANCE, AND ITS TEXT MOVES.
   *
   * There is no update banner in the mail window and there cannot be one: a banner needs a button,
   * a button needs a command, and a command is the exact permission the webview is refused. So the
   * item reports the flow — "Checking for Updates…", "Downloading ohmail 0.9.2…", "Restart to
   * Install 0.9.2" — and `updater.rs` owns every one of those sentences while `menu.rs` owns only
   * where the item sits.
   */
  it("triggers from the native menu and the launch check, never the webview", () => {
    expect(updater).toMatch(/CHECK_FOR_UPDATES_ID/);
    expect(updater).toMatch(/on_menu_event/);
    // The ITEM is built by `menu.rs`, which owns the whole bar; this module owns its id, its text
    // and the handler. All three halves are asserted, because any one alone can be true while the
    // others are not — an id nothing builds a menu item for is a command with no trigger at all.
    const menu = read("src-tauri/src/menu.rs");
    expect(menu).toMatch(/updater::CHECK_FOR_UPDATES_ID/);
    expect(menu).toMatch(/updater::MENU_LABEL_IDLE/);
    expect(menu).toMatch(/updater::adopt_menu_item\(app, check_item/);
    expect(updater).toMatch(/MENU_LABEL_IDLE: &str = "Check for Updates…"/);
    // The item says what is happening rather than one fixed word, which is the only quiet surface
    // this design leaves for "an update is waiting".
    expect(updater).toMatch(/"Checking for Updates…"/);
    expect(updater).toMatch(/format!\("Downloading ohmail \{version\}…"\)/);
    expect(updater).toMatch(/format!\("Restart to Install \{version\}"\)/);

    /* THE SECOND TRIGGER, and it is not the webview either: one check shortly after launch, from
       `main.rs`. An updater whose only trigger is a menu item is an updater nobody runs. It is the
       same code path with `user_initiated = false`, which is the whole of the difference — it
       opens no window and says nothing unless it finds something. */
    expect(updater).toMatch(/pub fn on_launch/);
    expect(updater).toMatch(/check\(app\.clone\(\), false\)/);
    expect(read("src-tauri/src/main.rs")).toMatch(/updater::on_launch\(app\.handle\(\)\)/);

    /* The webview gains no updater permission and no way to ask for a check: the runtime
       capability lists the engine's commands and `core:event:allow-listen`, and nothing else.

       COMMENTS ARE STRIPPED FIRST, and that is a narrowing rather than a softening. The claim is
       about what engine.rs COMPILES — no updater import, no updater call, no `allow-updater-…` in
       the capability — and a raw text match cannot tell that from a sentence. It stopped being able
       to when the launch-abort fix documented why a failed grant must not be fatal, which cannot be
       explained without the words "before `updater::on_launch` ever ran": the file whose CODE may
       not name the updater is exactly the file whose PROSE has to. Matching source only keeps the
       assertion pointed at the thing it protects. */
    const engineCode = read("src-tauri/src/engine.rs")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(engineCode).not.toMatch(/updater/);
  });

  /**
   * NO DEAD ENDS, AND NO DEVELOPER SENTENCES IN A USER'S DIALOG.
   *
   * Every failure used to be a single-button alert carrying the library's own error text —
   * "The update check failed: error sending request for url (…)" — which is a string a person can
   * neither read nor act on, behind a button that does nothing. A failure now says one plain
   * sentence, offers "Try again", and only appears at all when the user asked for the check.
   */
  it("answers a failure with a plain sentence and a retry, not an alert", () => {
    expect(updater).toMatch(/"Try again"\.into\(\)/);
    expect(updater).toMatch(/check\(retry, true\)/);
    // The sentences are the module's own, and no formatted error is interpolated into any of them.
    expect(updater).toMatch(/ohmail could not fetch the update\./);
    expect(updater).not.toMatch(/\{e\}/);
    // A check nobody asked for fails silently — an unrequested error box over somebody's mail is
    // the interruption this flow exists to remove.
    expect(updater).toMatch(/fn failed<R: Runtime>\(app: &AppHandle<R>, user_initiated: bool\)/);
    expect(updater).toMatch(/if user_initiated \{\s*say_it_failed/);
  });

  it("reaches the network only through the plugin — no hand-rolled socket", () => {
    // updater.rs is ALLOWED to reach the network (that is its job), but only via
    // tauri-plugin-updater; it must not open a raw socket or a second HTTP client.
    expect(updater).toMatch(/tauri_plugin_updater/);
    expect(updater).not.toMatch(/reqwest|hyper|ureq|curl|TcpStream|TcpListener|UnixStream/);
    expect(updater).not.toMatch(/std::(fs|net|process)/);
  });

  /**
   * THE FEED CONTRACT IS FROZEN, AND THE UX REWRITE DID NOT TOUCH IT.
   *
   * Every already-installed copy of the app parses the same `latest.json` and applies the same
   * two refusals, so the shape of the feed, the signature check and the downgrade gate are not
   * this module's to reinterpret — a client in the field cannot be updated out of a mistake made
   * in any of the three. What changed above is the ORDER and the NUMBER of the things a person is
   * shown. What is asserted here is that the three load-bearing parts are the same as they were:
   *
   *  · one pinned HTTPS endpoint and tauri's own feed schema (asserted at the top of this block);
   *  · verification, which happens inside `Update::download` and is the plugin's — this module
   *    never sees an unverified byte, because `download` returns bytes or an error and nothing
   *    else, and `install` is only ever handed what `download` returned;
   *  · `should_offer`, byte for byte the strictly-newer comparison it has always been, applied to
   *    the exact version about to be installed, with an unparseable version on either side failing
   *    CLOSED rather than falling through.
   */
  it("refuses a downgrade in the version gate the install path calls", () => {
    // should_offer is strictly-newer; the gate returns early when it is false. The exhaustive
    // boundary table lives in updater_tests.rs (Rust).
    expect(updater).toMatch(/pub fn should_offer\(/);
    expect(updater).toMatch(/candidate > installed/);

    /* FAILS CLOSED. The gate is one `matches!` requiring BOTH versions to parse and `should_offer`
       to hold; every other shape — an unparseable candidate, an unparseable installed version, a
       downgrade — falls to the `!offer` return. A refactor that turned this into an `if let` with
       an `else` that installed would be the whole updater's security gone, so the closed shape is
       pinned rather than described. */
    expect(updater).toMatch(/\(Ok\(installed\), Ok\(candidate\)\) if should_offer\(&installed, &candidate\)/);
    expect(updater).toMatch(/if !offer \{\s*return nothing_to_offer\(&app, user_initiated\);/);

    // Verification is the plugin's and is reached the same way it always was: the ONLY bytes this
    // module can install are the ones `download` returned.
    expect(updater).toMatch(/let bytes = match fetched \{/);
    expect(updater).toMatch(/Some\(payload\) => payload\.update\.install\(&payload\.bytes\)/);

    /* AND A REFUSED VERSION IS NOT AN ERROR REPORT. It used to raise a dialog reading "Ignoring
       offered version 0.9.0: it is not newer than the installed 0.9.1", which is a sentence about
       the release pipeline shown to somebody who cannot do anything about it — and which fired on
       every check for as long as a feed stayed wrong. The refusal itself is unchanged; only who
       hears about it is. */
    expect(updater).not.toMatch(/Ignoring offered version/);
  });

  /**
   * DOWNLOAD PROGRESS RENDERS IN ITS OWN WINDOW, GRANTED ONLY EVENT-LISTEN.
   *
   * The plugin hands `on_chunk` the size of each chunk and the total; the old code discarded both
   * (`|_downloaded, _total| {}`), so a download looked like a hang. It now ACCUMULATES the running
   * total and emits `updater://progress { downloaded, total }`, which a tiny bundled page renders in
   * a dedicated `updater` window. The main webview is never told and gains no permission — that is
   * the whole reason the progress is a separate window rather than a call into the page.
   *
   * The event name and the window label are written in two languages (Rust here, the page in
   * `src/updater-window.ts`) because a binary and a static page share no artifact to import one
   * from — the same reason the menu's events are, and held together the same way.
   *
   * ── AND IT OPENS ONLY FOR A CHECK SOMEBODY ASKED FOR ────────────────────────────────────────
   *
   * A window that appears by itself, centred and focused, over the mail you are reading is the
   * interruption this flow was rewritten to remove. So the launch check opens nothing at all — its
   * download is silent and the menu item is the only sign of it — and the window a menu press does
   * open is built `focused(false)`: it reports, it does not take the keyboard.
   */
  it("renders download progress in a dedicated window, hearing one event and nothing else", () => {
    // The Rust side accumulates and emits — not the discarded callbacks it used to have.
    expect(updater).toMatch(/PROGRESS_EVENT: &str = "updater:\/\/progress"/);
    expect(updater).toMatch(/PROGRESS_WINDOW_LABEL: &str = "updater"/);
    expect(updater).toMatch(/\.emit\(\s*PROGRESS_EVENT/);
    expect(updater).toMatch(/downloaded \+= chunk_len as u64/);
    // The callbacks are no longer thrown away.
    expect(updater).not.toMatch(/download_and_install\(\|_downloaded, _total\| \{\}/);
    // The window loads the bundled page, and there is exactly one — no second webview window
    // is opened anywhere in this module.
    expect(updater).toMatch(/WebviewUrl::App\("updater\.html"\.into\(\)\)/);
    expect(updater.match(/WebviewWindowBuilder::new/g)).toHaveLength(1);
    // Opened for a user-initiated check and for nothing else, and never with the keyboard.
    expect(updater).toMatch(
      /let progress = if user_initiated \{ show_progress_window\(&app\) \} else \{ None \};/,
    );
    expect(updater).toMatch(/\.focused\(false\)/);

    // The page listens for the SAME event by name, over the runtime's own event plugin, and never
    // emits — the asymmetry the capability grant enforces. (That the page reaches nothing — no
    // network API, no URL, an external same-origin script, `connect-src 'none'` — is asserted
    // against the emitted strings themselves in `updater-window.test.ts`.)
    const page = read("src/updater-window.ts");
    expect(page).toMatch(/PROGRESS_EVENT = "updater:\/\/progress"/);
    expect(page).toMatch(/PROGRESS_WINDOW_LABEL = "updater"/);
    expect(page).toMatch(/plugin:event\|listen/);

    // The two files are emitted into the bundle by vite, not left in a `public/` folder the publish
    // payload would never ship.
    const viteConfig = read("vite.config.ts");
    expect(viteConfig).toMatch(/emitFile\(\{ type: "asset", fileName: "updater\.html"/);
    expect(viteConfig).toMatch(/emitFile\(\{ type: "asset", fileName: "updater\.js"/);
  });
});

describe("the menu bar", () => {
  /**
   * THE MENU NAVIGATES BY EMITTING, NOT BY DRIVING THE PAGE.
   *
   * A chosen item emits one event carrying a view id, and the frontend calls the same navigation
   * function its rail and its keyboard call. The alternative — the shell setting the window's
   * location — would be a second implementation of routing, written in a language that cannot see
   * the client's own rules about where a view lives, and it would go wrong silently the first
   * time a route changed shape.
   */
  it("navigates by emitting a view id, and grants the window no way to emit back", () => {
    const menu = read("src-tauri/src/menu.rs");
    expect(menu).toMatch(/MENU_NAVIGATE_EVENT: &str = "menu:navigate"/);
    expect(menu).toMatch(/app\.emit\(MENU_NAVIGATE_EVENT, view\)/);
    // No script evaluation and no window location: the shell says where, never how.
    expect(menu).not.toMatch(/eval_script|set_url|window\.location/);

    // The frontend listens for the SAME name and refuses a payload it does not recognise.
    const native = read("src/native.ts");
    expect(native).toMatch(/MENU_NAVIGATE_EVENT = "menu:navigate"/);
    expect(native).toMatch(/plugin:event\|listen/);
    expect(native).not.toMatch(/plugin:event\|emit/);

    /* THE FIVE VIEWS, THE SAME FIVE, IN THE SAME ORDER, IN BOTH LANGUAGES. There is no artifact a
       Rust binary and a TypeScript bundle can share one list from, so the two are written down
       twice and compared here — the only place that can see both. Drift is otherwise silent:
       the item emits a name the window does not recognise and simply does nothing. */
    const inRust = [...menu.matchAll(/\("([a-z]+)", "[^"]*", "CmdOrCtrl\+\d"\)/g)].map((m) => m[1]);
    const inTs = /MENU_VIEWS = \[([^\]]*)\]/.exec(native)?.[1] ?? "";
    const listed = [...inTs.matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(inRust.length, "no view rows found in menu.rs — the harness matched nothing").toBe(5);
    expect(listed).toEqual(inRust);
  });

  /**
   * THE NAVIGATION SUBMENU IS IN THE ENGINE BUILD ONLY, AND THE EDIT MENU IS IN BOTH.
   *
   * They are gated differently on purpose. A View item is only useful to a window that is allowed
   * to hear the event, and the preview's window is allowed nothing — five items that do nothing is
   * worse than no menu. The Edit items are the platform's own and reach the webview through the
   * operating system rather than through a permission, so the preview gets them too; without them
   * ⌘C does not work on a Mac, in either build.
   */
  it("gates the View submenu on the feature and never the Edit one", () => {
    const menu = read("src-tauri/src/menu.rs");
    const views = menu.indexOf("pub const VIEWS");
    expect(views).toBeGreaterThan(0);
    expect(menu.slice(0, views)).toMatch(/#\[cfg\(feature = "local-engine"\)\]\s*$/m);
    // The platform's editing items are built unconditionally.
    const edit = /SubmenuBuilder::new\(app, "Edit"\)([\s\S]*?)\.build\(\)\?/.exec(menu)?.[1] ?? "";
    for (const item of ["undo", "redo", "cut", "copy", "paste", "select_all"]) {
      expect(edit, `the Edit menu has no ${item}`).toContain(`.${item}()`);
    }
    expect(edit).not.toMatch(/cfg\(feature/);
  });
});

describe("the UI bundle's build config", () => {
  const vite = read("vite.config.ts");

  /**
   * THE SAMPLE WORLD IS ALIASED OUT OF BOTH ARTIFACTS — the no-demo rule, at the module graph.
   *
   * The shared shell keeps a demo arm for the landing page, so `engine-config.ts` names
   * `FixturesAdapter` in a branch a desktop build can never take — and a branch never taken
   * still puts its import in the bundle, which is the whole fixtures corpus. So the module
   * resolves to a refusing stub, unconditionally: the window bundle and the served host client
   * alike. The SYNC client, by contrast, is aliased in NEITHER — both remaining artifacts are
   * engine-bearing and construct the real `HttpAdapter` (a stub once stood in for it in the
   * published tree and blanked the window the moment a mailbox served; `scan-artifact.mjs`
   * still asserts its refusal sentence absent from every bundle).
   */
  it("aliases the sample world out of the module graph, and the sync client out of nothing", () => {
    expect(vite).toMatch(/adapters\\\/fixtures-adapter\\\.js\$\/,\s*replacement: r\("\.\/src\/no-fixtures-adapter\.ts"\)/);
    // Unconditional: not inside any spread, so neither artifact can re-grow the corpus.
    expect(vite).not.toMatch(/\?\s*\[\][\s\S]{0,120}fixtures-adapter/);
    // …and the stub it points at refuses rather than degrades.
    expect(read("src/no-fixtures-adapter.ts")).toMatch(/constructor\(\) \{\s*\n\s*throw new Error\(/);
    // The sync client resolves REAL, everywhere: no alias ENTRY touches its path (prose may
    // still explain the history), and the retired stub file is gone rather than dormant.
    expect(vite).not.toMatch(/find:[^\n]*http-adapter/);
    expect(fs.existsSync(path.join(APP, "src/no-http-adapter.ts"))).toBe(false);
  });

  /**
   * THE ALIAS THAT MAKES THIS DIRECTORY BUILD WHAT THE INSTALLER SHIPS.
   *
   * Every released binary is built against the stub: this alias replaces the Cloud API client
   * in BOTH artifacts, so no installer carries a way to reach a server it has no account on.
   * (The real module publishes beside this repository's web application — what the alias
   * decides is what the BINARIES contain, not what the source tree shows.) The two modules
   * stopped agreeing once, the moment the real one reached for `app/session-refresh.ts`, whose
   * `POST /auth/refresh` put an `X-CSRF-Token` into a preview that nobody can install.
   * `scan-artifact.mjs` read that header correctly and failed on bytes that ship nowhere.
   *
   * TWO THINGS ARE ASSERTED AND THE SECOND IS THE ONE THAT WILL BE GOT WRONG. The alias has to
   * exist, and it has to be UNCONDITIONAL — a conditional spread around it would re-diverge one
   * artifact in silence. The alias list holds NO conditional spread at all any more (the one
   * that existed carried the retired preview's sync-client stub), and that absence is asserted
   * too, so a future arm cannot quietly reintroduce a per-artifact module identity.
   */
  it("aliases the Cloud API client out of BOTH artifacts, unconditionally", () => {
    const ALIAS = /\{ find: \/\^\(\?:\.\*\\\/\)\?api-client\$\/, replacement: r\("\.\/src\/no-api-client\.ts"\) \}/;
    expect(vite, "the api-client alias is missing from vite.config.ts").toMatch(ALIAS);

    // No conditional spread anywhere in the alias list: every module resolves to the same file
    // in every artifact, which is what makes the scans' identity questions answerable at all.
    const aliasList = /alias: \[([\s\S]*?)\n    \],/.exec(vite)?.[1] ?? "";
    expect(aliasList, "the alias list was not found — this guard is not reading it").toContain("no-api-client");
    expect(aliasList, "a conditional spread is back in the alias list — a module now has a " +
      "per-artifact identity, which is the shape that shipped a blank window").not.toMatch(/\.\.\.\(/);

    // The stub refuses rather than degrades, and answers the question every caller asks first.
    const stub = read("src/no-api-client.ts");
    expect(stub).toMatch(/throw new Error\(UNAVAILABLE\)/);
    expect(stub).toMatch(/export const apiConfigured/);
  });

  /**
   * TWO ARTIFACTS FROM ONE DIRECTORY, AND ONE FLAG THAT DECIDES WHICH.
   *
   * The WINDOW bundle is the default arm — the app, over the bridge — and the HOST CLIENT is the
   * served phone bundle. A third arm used to be the default (the fixtures-only preview, retired
   * under the no-demo rule) and must not quietly return: `build-ui.mjs` refuses a bare
   * invocation, the config derives the window arm from the ONE remaining variable, and the
   * `__OHMAIL_LOCAL_ENGINE__` define is gone with its last consumer — a window entry that no
   * longer branches, because there is nothing to branch to.
   */
  it("builds its two artifacts from one flag", () => {
    expect(vite).toMatch(/const LOCAL_ENGINE = process\.env\.OHMAIL_HOST_CLIENT !== "1"/);
    // The retired define stays retired: a knob nothing reads looks load-bearing and is not.
    // (Prose may name it; a DEFINE key may not.)
    expect(vite).not.toMatch(/__OHMAIL_LOCAL_ENGINE__:/);

    const main = read("src/main.tsx");
    expect(main).not.toMatch(/__OHMAIL_LOCAL_ENGINE__/);
    // The window entry installs the offline guard unconditionally: `invoke` is not `fetch`, so
    // the bridge does not need the network APIs back.
    expect(main).toMatch(/installOfflineGuard\(\)/);
    // …and the boot check runs only where there is a shell to check against, `readShell`'s rule.
    expect(main).toMatch(/if \(!bridgeAvailable\(\)\) return null;/);

    // A bare build names no artifact and is refused — the retired preview was the default, and a
    // stale caller should learn that rather than get the window bundle under an old name.
    const buildUi = read("scripts/build-ui.mjs");
    expect(buildUi).toMatch(/if \(!engine && !hostClient\) \{/);
    expect(buildUi).toMatch(/retired/);
  });

  /**
   * THE BRIDGE REACHES THE SHELL AND NOTHING ELSE.
   *
   * One command, one direction, and no address anywhere in it: a URL in this file would be the
   * first thing in either artifact capable of naming a host. The window's whole reach is the two
   * commands the shell registers, so what this asserts is that the file that uses them uses
   * nothing else.
   */
  it("talks to the shell's commands and opens nothing", () => {
    /* THE HOSTED SESSION'S LIVE TRUTH REACHES THE WINDOW. The engine flips /health to
       signedIn:false when the hosted API definitively refuses to renew the session; a window
       that never re-asked kept serving week-old mail with no sentence anywhere — measured live
       on a paired desktop whose refresh family was revoked. The gate must hold the probe, the
       latch, and the honest sentence with its way back. */
    const gate = read("src/DesktopGate.tsx");
    expect(gate).toMatch(/HOSTED_SESSION_PROBE_MS/);
    // The latch is the engine's own expiry verdict — NEVER bare signedIn:false, which an
    // ordinary pre-auth engine also answers and which is not "you were signed out".
    expect(gate).toMatch(/health\.sessionExpired === true/);
    expect(gate).not.toMatch(/health\.signedIn === false\) setHostedSessionGone/);
    expect(gate).toMatch(/signed out of your hosted account/);
    expect(gate).toMatch(/actionLabel="Sign in"/);
    // The way back is the IN-PLACE cloud sign-in, not a door re-pick that reconfigures the
    // engine over the mirror it already has.
    expect(gate).toMatch(/start="cloud"\s+cloudAction="signIn"/);

    const bridge = read("src/bridge-fetch.ts");
    expect(bridge).toMatch(/const REQUEST_COMMAND = "engine_request"/);
    expect(bridge).toMatch(/const STATUS_COMMAND = "engine_status"/);
    // No transport of its own — not a socket, not an events stream, and not `fetch`.
    expect(bridge).not.toMatch(/\bnew WebSocket\b|\bnew EventSource\b|\bXMLHttpRequest\b/);
    expect(bridge).not.toMatch(/https?:\/\//);
    // `fetch` appears only as the NAME of the option it satisfies, never as a call.
    expect(bridge).not.toMatch(/(?<![\w.])fetch\s*\(/);
    // The adapter it builds is addressed relative to the engine, so no base URL is composed here.
    expect(bridge).toMatch(/new HttpAdapter\(\{ baseUrl: "", fetch: bridgeFetch \}\)/);
  });

  it("the no-fixtures stub declares every SYMBOL the barrel re-exports from fixtures-adapter", () => {
    /**
     * A STUB THAT STANDS AT A MODULE'S PATH MUST EXPORT THAT MODULE'S NAMES — the lesson two
     * retired sync-client stub tests carried, kept alive on the stub that remains.
     *
     * The client-engine barrel re-exports named symbols from `./adapters/fixtures-adapter.js`,
     * and in both desktop artifacts that path resolves to `src/no-fixtures-adapter.ts`. A name
     * the barrel takes and the stub lacks is a `vite build` failure in this directory alone —
     * `tsc` reads no Vite aliases and resolves the real file, so the typecheck stays green while
     * the bundle cannot be built. That exact shape shipped a red public CI once, on the retired
     * stub (`TS2305: Module … has no exported member`), which is why the oracle here is the
     * barrel's own re-export list rather than a remembered set of names.
     *
     * Comments are stripped from the WHOLE block before the split, the ordering the retired test
     * paid to learn: a comma inside a documenting comment once cut the list mid-sentence and
     * dropped a name the loop then never checked.
     */
    const barrel = fs.readFileSync(
      path.resolve(APP, "../../packages/client-engine/src/index.ts"),
      "utf8",
    );
    const block = /export\s*\{([^}]*)\}\s*from\s*"\.\/adapters\/fixtures-adapter\.js";/.exec(barrel);
    expect(block, "could not find the barrel's fixtures-adapter re-export block").not.toBeNull();
    const names = block![1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => !/^type\s/.test(x)) // type-only re-exports are erased by the bundler
      .filter((x) => /^[A-Za-z_$][\w$]*$/.test(x));
    // The harness bites only if it found something to compare.
    expect(names.length).toBeGreaterThanOrEqual(3);
    expect(names).toContain("FixturesAdapter");

    const stub = read("src/no-fixtures-adapter.ts");
    for (const name of names) {
      expect(stub, `no-fixtures-adapter.ts does not export ${name}, which the barrel re-exports`)
        .toMatch(new RegExp(`^export (?:type |const |class |interface |function )?${name}\\b`, "m"));
    }
    // And the class REFUSES at construction: a future arm that somehow reaches the demo branch
    // must fail on its first frame rather than quietly show invented mail as somebody's own.
    expect(stub).toMatch(/export class FixturesAdapter \{\s*\n\s*constructor\(\) \{\s*\n\s*throw new Error\(/);
  });

  it("emits origin-agnostic relative URLs", () => {
    expect(vite).toMatch(/base: "\.\/"/);
  });

  /**
   * THE DESKTOP BUILD SETS THE FLAG THAT KEEPS SYNC RUNNING WHILE THE WINDOW IS HIDDEN.
   *
   * `apps/webapp/app/shell/engine-config.ts`'s `syncsWhileHidden()` reads `NEXT_PUBLIC_DESKTOP`,
   * and this is where a desktop build turns it on. Both artifacts set it — a mail client is a
   * desktop app whether or not it carries the engine — so it is defined at the top level rather
   * than under the `LOCAL_ENGINE` branch. The web build never defines it, which is what keeps a
   * browser tab's hidden-tab-zero-syncs behaviour; the positive gate against a leak lives in the
   * web app's own test suite (grep `syncsWhileHidden`), and this is its desktop half.
   */
  it("declares itself a desktop build, so the shared shell syncs while occluded", () => {
    // The literal define, "1" for both WINDOW artifacts and `undefined` for the HOST CLIENT —
    // which IS a browser tab (a phone page in the background dropping to the slow cadence is
    // the battery-correct behaviour this define exists to disable in a window).
    expect(vite).toMatch(/"process\.env\.NEXT_PUBLIC_DESKTOP": HOST_CLIENT \? "undefined" : JSON\.stringify\("1"\)/);
    // It sits in the `define` block, before `resolve:` — i.e. a build-time constant folded into
    // every module, both window artifacts. It is NOT gated on the LOCAL_ENGINE flag: the preview
    // is a desktop app too, and only the WEB build (which sets this var nowhere) must miss it.
    const defineStart = vite.indexOf("define: {");
    const resolveStart = vite.indexOf("resolve: {");
    expect(defineStart).toBeGreaterThan(0);
    expect(resolveStart).toBeGreaterThan(defineStart);
    const defineBlock = vite.slice(defineStart, resolveStart);
    expect(defineBlock).toMatch(/NEXT_PUBLIC_DESKTOP/);
    expect(defineBlock).not.toMatch(/LOCAL_ENGINE\s*\?/);
  });

  it("renders the same shell the web client does — no desktop fork, and no demo mount", () => {
    const main = read("src/main.tsx");
    // ONE mount: the gate, which asks the shell what the engine is doing and shows the chooser,
    // a notice, or the mail client. There used to be a second — `<AppShell demo />`, the retired
    // preview's — and its absence is the no-demo rule at the entry point: the app opens EMPTY
    // and one connects; the only demo lives on ohmail.app's landing page.
    expect(main).toMatch(/<DesktopGate \/>/);
    expect(main).not.toMatch(/<AppShell/);
    expect(main).not.toMatch(/demo=/);
    /* …AND THE WHOLE MOUNT IS INSIDE THE BOUNDARY. Not decoration: `DesktopGate` builds the
       client engine during a render, and a released build shipped with a constructor that threw
       there — which unmounted the tree and drew an empty window, on machines that had signed in
       successfully. A boundary cannot catch its own render, so this has to be OUTSIDE the gate,
       which means here. See `GateBoundary.tsx`. */
    expect(main).toMatch(/<GateBoundary>/);
    // The gate mounts the SHARED shell rather than a screen of its own — that is the no-fork
    // claim — and hands it `demo={false}` structurally: the line is only reached with a real
    // engine behind the window.
    const gate = read("src/DesktopGate.tsx");
    expect(gate).toMatch(/from "\.\.\/\.\.\/webapp\/app\/shell\/AppShell"/);
    expect(gate).toMatch(/demo=\{false\}/);
    expect(gate).not.toMatch(/demo=\{engine === null\}/);
  });

  /**
   * THE DESKTOP'S SETTINGS PANE IS A NODE THE SHELL HANDS IN, NOT A FLAG THE SHELL READS.
   *
   * `SettingsView` is compiled into a browser tab as well as into this app, and every control in
   * that pane is a call to a native shell the browser tab does not have. So the shared view takes
   * a node and this app supplies one — the same seam the hosted client uses for its Account and
   * Security panes. The consequence worth asserting is the structural one: on the web there is no
   * pane because there is nothing to render, not because a boolean is false.
   */
  it("hands the desktop pane in as a node, and names none of it in the shared view", () => {
    const settings = fs.readFileSync(
      path.resolve(APP, "../webapp/app/views/SettingsView.tsx"),
      "utf8",
    );
    // The nav entry and the pane are both conditional on the node being supplied.
    expect(settings).toMatch(/desktopSection \? \[\["desktop", desktopSection\.label\]/);
    expect(settings).toMatch(/shown === "desktop" \? desktopSection\?\.node : null/);
    // And the shared file knows nothing about how any of it works.
    expect(settings).not.toMatch(/engine_logout|engineLogout|invoke\(|__TAURI/);

    // The node itself lives here, where the shell is.
    const pane = read("src/DesktopSettings.tsx");
    expect(pane).toMatch(/engineLogout/);
  });

  /**
   * THE OHBOX BAR IS EDITED BY THE SHARED CONTROL, WITH THIS TIER'S TRANSPORT HANDED IN.
   *
   * The sentence somebody writes about what deserves their Ohbox has always been READ on this tier: it
   * travels in the user turn of the screening question a model on this machine is asked, which the
   * engine's own end-to-end checks assert on the wire. It could not be WRITTEN, because
   * `GET/PATCH /account/screening` was mounted in the hosted route table alone. It is in the local
   * engine's table now, and this pane is what addresses it.
   *
   * Two claims, and both are structural rather than visual:
   *
   *  · ONE EDITOR OVER ONE COLUMN. The control is `OhboxWords` from the shared shell, the same file
   *    the hosted client renders. A second copy here would be free to drift on the rule that
   *    actually matters — an emptied box saves `null`, which REVERTS to the product default, where
   *    a copy that drifted to saving `""` would store an empty bar that silently overrides it.
   *  · IT GOES DOWN THE BRIDGE, not through the sync client. The engine's route-coverage check
   *    derives the client's call list from that client's source and holds it against BOTH surfaces
   *    the engine serves; a settings call routed through it would join the list and land in the
   *    hosted-mirror half, where this route has no local handler. A preference is not sync traffic.
   *
   * The scan marker is asserted from both ends for the reason `ai-gate.ts` taught this repository:
   * a guard that points at a string nothing contains passes for ever while checking nothing.
   */
  /**
   * THE SETTINGS SCREEN IS THE SHARED ONE, WITH THE PANES A DESKTOP INSTALL CAN ANSWER FOR.
   *
   * Four panes were absent or blank here and each for the same shape of reason: the shared shell
   * builds them out of a hosted API client that is not part of this build, so they were either
   * withheld or rendered nothing. Mailboxes was the worst of them — present in the nav, and empty
   * on every real install, because its fallback list draws entities the change feed never carries.
   *
   * Source-level, like the suggest control below and for the same reason: the WIRING between two
   * files in two applications has no single place to render, and deleting it left every suite in
   * both of them green.
   */
  it("hands the shared settings screen the panes only this shell can fill", () => {
    const gate = read("src/DesktopGate.tsx");
    expect(gate).toMatch(/mailboxSection: <DesktopMailboxes door=\{status\?\.mode \?\? null\} \/>/);
    expect(gate).toMatch(/aboutSection: <DesktopAbout status=/);
    expect(gate).toMatch(/mailboxFacts: readMailboxFacts/);

    // The mailbox list is read from the ENGINE, over the pipe — never from the mirror, which has
    // no such entity and is what made the shared fallback empty. The read is a factory over the
    // transport now (`readMailboxFactsVia`), because the served host-client asks the identical
    // question over its bearer socket; the WINDOW's instance still rides the bridge, asserted
    // in both halves so neither can drift.
    const mailboxes = read("src/DesktopMailboxes.tsx");
    expect(mailboxes).toMatch(/readMailboxFactsVia\(bridgeFetch\)/);
    expect(mailboxes).toMatch(/fetchImpl\("\/mailboxes"\)/);
    // A FAILED read is not an empty account. The ladder renders "No mailbox connected" for the
    // second, so collapsing the first into it would say that to somebody whose mailbox works.
    expect(mailboxes).toMatch(/throw new Error/);

    // The pane names a THING, like every other entry beside it in that list.
    expect(read("src/DesktopSettings.tsx")).toMatch(/DESKTOP_PANE_LABEL = "Desktop"/);
    // …and the copy that sends somebody to it says the same word. A pointer at a pane that no
    // longer has that name is a wrong instruction, not a stale comment.
    expect(read("src/local-suggest.tsx")).toMatch(/Settings, Desktop/);
  });

  it("edits the Ohbox bar with the SHARED control, over the bridge and not through the sync client", () => {
    /* IT MOVED, from the install pane to Settings → Screener, where the rest of the screening
       controls now live. The assertion follows it rather than being relaxed: what is being pinned
       is that the editor is REACHABLE from a pane the shell renders, and naming which pane is what
       makes that a check instead of a search. */
    const pane = read("src/DesktopScreening.tsx");
    expect(pane).toMatch(/<DesktopScreeningWords door=/);
    expect(read("src/DesktopGate.tsx")).toMatch(/screeningSection: <DesktopScreening door=/);

    /* AND THE SHARED SHELL HAS TO PREFER IT. Handing a node in is half a wiring; the other half
       is the shell choosing it over its own, and that half fails silently — the pane still
       renders, from a section that reaches an API client this build does not have, and draws
       nothing. Both ends, for the reason this file states about the suggest control below. */
    const shell = fs.readFileSync(path.resolve(APP, "../webapp/app/shell/AppShell.tsx"), "utf8");
    expect(shell).toMatch(/screeningSection=\{demo \? undefined : \(screeningSection \?\? <ScreeningSection \/>\)\}/);

    const words = read("src/DesktopScreeningWords.tsx");
    expect(words).toMatch(/from "\.\.\/\.\.\/webapp\/app\/shell\/OhboxWords"/);
    // No control of its own: a textarea here is the second editor this asserts does not exist.
    expect(words).not.toMatch(/<textarea/);

    const wire = read("src/local-screening.ts");
    expect(wire).toMatch(/bridgeFetch/);
    expect(wire).toMatch(/"\/account\/screening"/);
    expect(wire).toMatch(/method: "PATCH"/);
    // Asserted over what it IMPORTS, not over its prose — the header names both of these modules
    // to say it is not one of them, and a bare substring check would fail on the explanation.
    expect(wire).not.toMatch(/from "[^"]*(http-adapter|api-client)[^"]*"/);

    // The shared control names no transport at all, which is what lets a browser tab compile it
    // and this window compile it too.
    const shared = fs.readFileSync(
      path.resolve(APP, "../webapp/app/shell/OhboxWords.tsx"),
      "utf8",
    );
    // Comments say what the code should do; only the code decides what it does — the same
    // stripping `one-pipeline.test.ts` does, and needed for the same reason: this file's header
    // names the route and both clients precisely in order to say that it is none of them.
    const sharedCode = shared
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
    expect(sharedCode).not.toMatch(/bridgeFetch|__TAURI|api-client|account\/screening/);
    // Not vacuous: the stripper leaves real code alone.
    expect(sharedCode).toMatch(/useTranslations\("settings"\)/);

    // The artifact scan's marker for this surface must be a sentence this file really contains.
    // Compared with runs of whitespace collapsed, because the sentence is JSX text wrapped across
    // source lines and JSX collapses exactly that to single spaces — which is the form the marker
    // has to match in the emitted bundle, and the form a re-wrap of this paragraph must not break.
    const marker = "judges them against your sentence";
    expect(read("scripts/scan-artifact.mjs")).toContain(marker);
    expect(words.replace(/\s+/g, " ")).toContain(marker);
  });

  /**
   * THE SCREENER'S SUGGEST CONTROL IS HANDED IN TOO, AND THE OLD ONE IS GATED ON A SERVER.
   *
   * The shared control prices a set of senders on a server before it offers a button, because a
   * hosted account spends an allowance. This build has no server at all, and for the whole life of
   * the local-engine artifact that control rendered anyway: it drew a button, and every press came
   * back "that did not work". A control with nothing behind it, on somebody's real mail.
   *
   * Two halves, and both are asserted because either alone is satisfiable while the app is broken.
   * The shared shell must WITHHOLD its own control where there is no server, and it must render a
   * host's node when one is handed in — and it must still know nothing about how that node works,
   * exactly as it knows nothing about the Settings pane's commands.
   *
   * Source-level on purpose. The behaviour is driven where it can be driven — the control's own
   * suite here, and the shared client's own suite over the view that chooses between the two — but
   * the WIRING between two files in two applications has no single place to render, and deleting it
   * left every suite in both of them green.
   */
  it("hands the Screener's suggest control in, and withholds the hosted one where there is no server", () => {
    const shell = fs.readFileSync(path.resolve(APP, "../webapp/app/shell/AppShell.tsx"), "utf8");
    // The hosted control is withheld on the demo, on a host with no API, and on a host that
    // brought its own. `autoOptIn.supported` is `apiConfigured()`, which is false in this build.
    expect(shell).toMatch(/demo \|\| !autoOptIn\.supported \|\| screenerSuggest/);
    // …and the host's node is bound to the same queue and the same overlay.
    expect(shell).toMatch(/suggestNode=\{/);
    expect(shell).toMatch(/absorb: suggestions\.absorb/);

    const view = fs.readFileSync(path.resolve(APP, "../webapp/app/views/ScreenerView.tsx"), "utf8");
    expect(view).toMatch(/suggestNode \?\? \(suggest \? <SuggestControl control=\{suggest\} \/> : null\)/);

    // The shared files name none of it. No bridge, no provider, no local route — the same rule the
    // Settings pane follows, and the reason a browser tab can compile these files at all.
    for (const shared of [shell, view]) {
      expect(shared).not.toMatch(/local\/ai|bridgeFetch|__TAURI|anthropic|ollama/i);
    }

    // The control itself lives here, where the engine is.
    expect(read("src/local-suggest.tsx")).toMatch(/runSuggest/);
    expect(read("src/local-suggest-run.ts")).toMatch(/\/screener\/suggest/);
  });

  it("keeps the document CSP in step with the webview CSP", () => {
    const conf = readJson("src-tauri/tauri.conf.json") as never as {
      app: { security: { csp: string } };
    };
    const meta = /content="([^"]+)"/.exec(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(read("index.html"))![0],
    )![1]!;
    const inDoc = directives(meta);
    const inApp = directives(conf.app.security.csp);

    // Every directive the document declares must say exactly what the header
    // says — a drifted copy is worse than no copy.
    for (const [key, value] of Object.entries(inDoc)) {
      expect([key, value]).toEqual([key, inApp[key]]);
    }
    // …and the header must be at least as strict: `frame-ancestors` is ignored
    // in <meta> by spec, so it lives only there.
    expect(inDoc["frame-ancestors"]).toBeUndefined();
    expect(inApp["frame-ancestors"]).toEqual(["'none'"]);
  });
});

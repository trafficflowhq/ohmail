import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_MESSAGE_NAMESPACES } from "../vite.config.js";

/**
 * ═══ THE HOST-CLIENT ARM — the build facts that make the SERVED artifact the right one ════════
 *
 * The desktop dist CANNOT be served: its entry replaces `fetch` before anything mounts, its asset
 * URLs are relative (dead under `/pair`'s index fallback), and its transport is a Tauri command
 * channel no browser has. The third vite arm exists because every one of those facts has to
 * flip — and each flip is a one-line edit whose loss would produce a bundle that builds green
 * and serves a blank page. So the facts are pinned here, over the SOURCES (the arm is exercised
 * for real by `pnpm -F @ohmail/desktop ui:build:host`, which CI and the engine-app build run;
 * this file is what fails FAST when a refactor unpicks one line of it).
 */

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPO = path.resolve(APP, "../..");
const read = (rel: string) => fs.readFileSync(path.join(APP, rel), "utf8");

describe("the vite arm", () => {
  const config = read("vite.config.ts");

  it("selects dist-host, absolute base and the host.html input under OHMAIL_HOST_CLIENT", () => {
    expect(config).toContain('process.env.OHMAIL_HOST_CLIENT === "1"');
    expect(config).toContain('HOST_CLIENT ? "dist-host" : "dist"');
    // Absolute, because the door serves `/pair` and deep links by INDEX FALLBACK — a relative
    // asset URL resolved against `/pair/` addresses nothing.
    expect(config).toContain('HOST_CLIENT ? "/" : "./"');
    expect(config).toContain('input: r("./host.html")');
  });

  it("resolves the REAL http-adapter — the stub is aliased in neither engine-bearing artifact", () => {
    expect(config).toContain("...(LOCAL_ENGINE || HOST_CLIENT");
  });

  it("does NOT declare itself a desktop window: NEXT_PUBLIC_DESKTOP stays undefined, so a hidden phone tab keeps the slow sync cadence", () => {
    expect(config).toContain('HOST_CLIENT ? "undefined" : JSON.stringify("1")');
  });

  it("the two artifact flags are mutually exclusive, in the config and in the build script", () => {
    expect(config).toContain("HOST_CLIENT && LOCAL_ENGINE");
    const build = read("scripts/build-ui.mjs");
    expect(build).toContain("engine && hostClient");
  });

  it("the pairing landing's namespace is in the message filter — a raw `pairLanding.title` must never render", () => {
    expect(SHELL_MESSAGE_NAMESPACES).toContain("pairLanding");
  });
});

describe("the served document", () => {
  const html = read("host.html");

  it("carries not a single inline script — the CSP's script-src 'self' is the fragment credential's guard, and this is the artifact's half of it", () => {
    expect(html).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(html).toContain("script-src 'self'");
    // connect-src 'self': the page may talk to the origin that served it and to nothing else.
    expect(html).toContain("connect-src 'self'");
  });

  it("enters through the host-client entry, never the window's", () => {
    expect(html).toContain("/src/host-client/main.tsx");
    expect(html).not.toContain('"/src/main.tsx"');
  });
});

describe("the entry keeps the window's guard OUT and the window keeps it IN", () => {
  it("no host-client source IMPORTS the offline guard or the Tauri bridge — its transport IS fetch", () => {
    // Imports, not mentions: the sources legitimately EXPLAIN their relationship to both modules
    // in comments, and a census that fails over a sentence teaches people to stop writing them.
    const dir = path.join(APP, "src/host-client");
    for (const file of fs.readdirSync(dir)) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      expect(src, `${file} imports the offline guard`).not.toMatch(/from ["'][^"']*offline-guard/);
      expect(src, `${file} imports the Tauri bridge`).not.toMatch(/from ["'][^"']*bridge-fetch/);
      expect(src, `${file} reaches the Tauri channel`).not.toContain("__TAURI_INTERNALS__");
    }
  });

  it("the WINDOW entry still installs it first — the LOCAL arm is untouched by this slice", () => {
    const main = read("src/main.tsx");
    expect(main).toContain('import { installOfflineGuard } from "./offline-guard.js"');
    expect(main).toContain("installOfflineGuard();");
    // …and installation precedes the mount CALL (not the import line), which is the property
    // that makes it a guard.
    expect(main.indexOf("installOfflineGuard();")).toBeLessThan(main.indexOf("createRoot(root)"));
  });
});

describe("the send-surface twin", () => {
  it("the client's compose ceiling IS the door's declared surface — held as arithmetic across the two packages", () => {
    const gate = read("src/host-client/HostGate.tsx");
    const clientCap = gate.match(/HOST_CLIENT_SEND_MAX_TOTAL_BYTES = ([0-9 *]+);/);
    expect(clientCap, "the client constant moved or lost its literal").not.toBeNull();
    const listener = fs.readFileSync(path.join(REPO, "apps/sidecar/src/host-listener.ts"), "utf8");
    const doorCap = listener.match(/HOST_SEND_MAX_TOTAL_BYTES = ([0-9 *]+);/);
    expect(doorCap, "the door constant moved or lost its literal").not.toBeNull();
    // eslint-disable-next-line no-eval
    expect(eval(clientCap![1]!)).toBe(eval(doorCap![1]!));
  });
});

describe("what the bundle is packaged AS", () => {
  it("the engine app packages dist-host as the host-client resource, and builds it in the same script that selects the other halves", () => {
    const conf = read("src-tauri/tauri.engine.conf.json");
    expect(JSON.parse(conf).bundle.resources["../dist-host"]).toBe("host-client");
    const build = read("scripts/build-engine-app.mjs");
    expect(build).toContain('"--host-client"');
    expect(build).toContain('join(APP, "dist-host", "index.html")');
  });

  it("the shell hands the packaged path at spawn as OHMAIL_HOST_ASSETS, and the engine reads exactly that name", () => {
    const rust = read("src-tauri/src/host.rs");
    expect(rust).toContain('HOST_ASSETS_VAR: &str = "OHMAIL_HOST_ASSETS"');
    expect(rust).toContain('join("host-client")');
    const engineMain = fs.readFileSync(path.join(REPO, "apps/sidecar/src/main.ts"), "utf8");
    expect(engineMain).toContain("OHMAIL_HOST_ASSETS");
  });
});

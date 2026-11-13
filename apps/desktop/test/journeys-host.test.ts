import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import type { MailboxAdapter } from "@trafficflow/core/adapters/imap";
import { createSidecar, type Sidecar } from "../../sidecar/src/engine.js";
import { startHostListener, type HostListener } from "../../sidecar/src/host-listener.js";
import { fenced, HOST, type Person } from "../../../test/journeys/bench/web.js";
import { say } from "../../../test/journeys/vocabulary/catalogue.js";
import { HOST_PANES } from "../../../test/journeys/vocabulary/panes.js";
import { PLACES } from "../../../test/journeys/vocabulary/places.js";

/**
 * THE PAGE A DESKTOP SERVES TO A PHONE'S BROWSER, as a journey: the built host-client bundle
 * (`npm run ui:build:host`, vite's `configFile: "vite.config.ts"`), served by a real engine in host
 * mode over a real socket, opened in Chromium and paired with a code the engine minted.
 *
 *     TF_JOURNEYS=host npx vitest run apps/desktop/test/journeys-host.test.ts
 *
 * Skipped unless `TF_JOURNEYS=host`; with it, a missing bundle, browser or engine fails.
 * `TF_JOURNEYS_RECORD=<dir>` keeps what was seen and what the engine was asked.
 */
const ENABLED = process.env.TF_JOURNEYS === HOST;
const DESKTOP = fileURLToPath(new URL("..", import.meta.url));

/** The engine's log of what the page asked: the method and the path, ids masked. */
const asked: string[] = [];
const pattern = (path: string): string =>
  path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id").replace(/\/assets\/.*/, "/assets/*");

let dir = "";
let sidecar: Sidecar;
let listener: HostListener;
let browser: Browser;
let origin = "";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** A phone's browser, paired: it opens the pairing address with a code this engine just minted. */
async function paired(): Promise<Person> {
  const minted = await sidecar.handle(new Request("http://sidecar/pair", {
    method: "POST", headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({ grant: "device-pair" }),
  }));
  expect(minted.status).toBe(200);
  const { token } = await minted.json() as { token: string };
  const person = await fenced(browser, { origin, base: "/", lang: "en" });
  await person.page.goto(`${origin}/pair#${token}`, { waitUntil: "commit" });
  return person;
}

describe.skipIf(!ENABLED)("journeys · the paired page · H", () => {
  beforeAll(async () => {
    await new Promise<void>((resolve, reject) => {
      const p = spawn(process.execPath, ["scripts/build-ui.mjs", "--host-client"], { cwd: DESKTOP, stdio: "ignore" });
      p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`the host-client build exited ${code}`))));
    });
    expect(existsSync(join(DESKTOP, "dist-host/index.html"))).toBe(true);
    dir = mkdtempSync(join(tmpdir(), "ohmail-journeys-host-"));
    const port = await freePort();
    origin = `http://127.0.0.1:${port}`;
    sidecar = await createSidecar({
      dataDir: join(dir, "data"),
      imap: { host: "imap.invalid", port: 993, secure: true, auth: { user: "mila@lichtgrat.example", pass: ["app", "word", "9f3a"].join("-") } },
      adapterFactory: () => ({ close: async () => undefined }) as unknown as MailboxAdapter,
      log: () => undefined, dkimKeys: null,
      hostMode: true, hostOrigin: origin, hostPort: port, hostAssetsDir: join(DESKTOP, "dist-host"),
    });
    listener = await startHostListener({
      port,
      handle: (req) => {
        const url = new URL(req.url);
        asked.push(`${req.method} ${pattern(url.pathname)}`);
        return sidecar.handleHost!(req);
      },
    });
    browser = await chromium.launch();
  }, 240_000);

  afterAll(async () => {
    await browser?.close();
    await listener?.close();
    await sidecar?.stop().catch(() => undefined);
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("a paired browser reaches the app, and its Settings menu lists the page's own sections", { timeout: 120_000 }, async () => {
    const person = await paired();
    await person.see("rail", {}, 60_000);
    await person.arrive("settings");
    await person.see("menu-settings-general");
    const menu = await person.listed("settings-menu", "button");
    const record = process.env.TF_JOURNEYS_RECORD;
    if (record) {
      mkdirSync(join(record, "H"), { recursive: true });
      const panes: Record<string, string> = {};
      for (const name of menu) {
        await person.page.getByRole("navigation", { name: say("settings.navAria"), exact: true }).getByRole("button", { name, exact: true }).click();
        panes[name] = await person.page.getByRole("region", { name: say("settings.title"), exact: true }).ariaSnapshot();
      }
      await person.arrive("trash");
      const trash = await person.text("list-trash");
      await person.arrive("ohbox");
      writeFileSync(join(record, "H", "settings.json"), JSON.stringify({
        how: "Chromium · the built host-client bundle · a real engine in host mode", menu, panes, trash, rail: await person.listed("rail", "button"),
      }, null, 1));
      writeFileSync(join(record, "H", "settings.calls.json"), JSON.stringify([...new Set(asked)].sort(), null, 1));
    }
    expect([...menu].sort()).toEqual(HOST_PANES.map((id) => say(PLACES[`settings-${id}`].landmark.key)).sort());
    expect(person.problems([/status of 40[14]/])).toEqual([]);
    await person.context.close();
  });
});

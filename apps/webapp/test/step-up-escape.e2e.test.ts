import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import messages from "../messages/en.json";

/**
 * ESC WHILE THE SECOND FACTOR IS ON ITS WAY — a production build of the web app in front of a stand-in API that
 * holds each factor's answer, driven in Chromium, on the four pages that park an act behind the step-up dialog:
 * the delete page (the erase), the approval (the desktop's confirm), the app's sign-in (the native authorization) and
 * the desktop's code (the mint). A person who typed the factor, pressed the dialog's button and then pressed Esc
 * must never have the act run: the dialog goes at Esc, the factor that lands afterwards runs nothing, and the page
 * says so. The same after a refused code.
 *
 * Opt-in like `proxy.e2e.test.ts`: `next build` takes about a minute and two ports are bound.
 *
 *     TF_STEPUP_E2E=1 npx vitest run apps/webapp/test/step-up-escape.e2e.test.ts
 */
const ENABLED = process.env.TF_STEPUP_E2E === "1";
const WEBAPP = fileURLToPath(new URL("..", import.meta.url));
function nextCli(): string {
  try {
    return join(dirname(createRequire(`${WEBAPP}package.json`).resolve("next/package.json")), "dist/bin/next");
  } catch {
    return `${WEBAPP}node_modules/next/dist/bin/next`;
  }
}
const NEXT_CLI = nextCli();
const W = messages as unknown as Record<string, Record<string, string>>;
const S = W.stepUp!;
const ACCOUNT = "7a0c3f9e-5d61-4f7a-9d2e-2b1f8c4e6a10";
const EMAIL = "person@example.test";
/** The one code the stand-in takes; any other is refused. Made at run time, never a literal credential. */
const GOOD = String(100_000 + (randomBytes(2).readUInt16BE(0) % 900_000));
const BAD = GOOD === "999999" ? "999998" : "999999";

/** The stand-in API's state for one case: the session it knows, its step-up window, the held factors, the counts. */
interface World {
  session: string;
  csrf: string;
  windowOpen: boolean;
  hold: boolean;
  held: (() => void)[];
  counts: Record<string, number>;
}
const fresh = (): World => ({
  session: randomBytes(24).toString("base64url"),
  csrf: randomBytes(18).toString("base64url"),
  windowOpen: false,
  hold: false,
  held: [],
  counts: {},
});
let world = fresh();

let api: Server | null = null;
let web: ChildProcess | null = null;
let browser: Browser | null = null;
let webLog = "";
let APP = "";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

const jarOf = (req: IncomingMessage): Record<string, string> =>
  Object.fromEntries(
    String(req.headers.cookie ?? "")
      .split(";")
      .map((c) => c.trim())
      .filter(Boolean)
      .map((c) => [c.slice(0, c.indexOf("=")), c.slice(c.indexOf("=") + 1)]),
  );

/** The stand-in: one account, one session, a step-up window a good code opens, and the four gated acts. */
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = (() => {
    try {
      return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as { code?: string };
    } catch {
      return {};
    }
  })();
  const path = new URL(req.url ?? "/", "http://stand-in").pathname;
  const method = req.method ?? "GET";
  const key = `${method} ${path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/, ":id")}`;
  world.counts[key] = (world.counts[key] ?? 0) + 1;
  const named = { "X-Ohmail-Account": ACCOUNT };
  const json = (status: number, answer: unknown): void => {
    res.writeHead(status, { "content-type": "application/json", ...named });
    res.end(JSON.stringify(answer));
  };
  const stepUp = (): void => json(403, { error: { code: "step_up_required", message: "recent two-factor authentication required" } });
  const jar = jarOf(req);
  if (path === "/hello") return json(200, { product: "ohmail", needsSetup: false });
  if (path.startsWith("/auth/refresh")) return json(401, { error: { code: "refresh_missing", message: "missing refresh token" } });
  if (jar.tf_session !== world.session) return json(401, { error: { code: "unauthorized", message: "authentication required" } });
  if (method !== "GET" && (req.headers["x-csrf-token"] !== world.csrf || jar.tf_csrf !== world.csrf))
    return json(403, { error: { code: "csrf_failed", message: "csrf" } });
  if (path === "/auth/session")
    return json(200, {
      user: {
        userId: "u-1", accountId: ACCOUNT, email: EMAIL, displayName: "Person", emailVerified: true,
        twofaEnrolled: { webauthn: false, totp: true, recoveryCodes: true },
      },
      scope: "full",
    });
  if (path === "/account/access") return json(200, { metered: false, access: "open" });
  if (path === "/auth/step-up/totp" || path === "/auth/step-up/recovery-code") {
    if (world.hold) await new Promise<void>((r) => world.held.push(r));
    if (body.code !== GOOD) return json(401, { error: { code: "invalid_credentials", message: "two-factor verification failed" } });
    world.windowOpen = true;
    return json(200, path.endsWith("totp") ? { ok: true } : { ok: true, remainingCodes: 7 });
  }
  if (path === "/account" && method === "DELETE")
    return world.windowOpen ? json(200, { erased: true, usersErased: 1, tables: {}, retained: "", subscription: "none" }) : stepUp();
  if (/^\/auth\/desktop-approval\/[0-9a-f-]{36}$/.test(path))
    return json(200, {
      label: "Lichtgrat laptop", platform: "Linux", requestedAt: new Date().toISOString(), ipClass: "home broadband",
      network: "same", expiresIn: 300, approved: false,
    });
  if (/^\/auth\/desktop-approval\/[0-9a-f-]{36}\/confirm$/.test(path)) return world.windowOpen ? json(200, { approved: true }) : stepUp();
  if (path === "/auth/desktop-link") return world.windowOpen ? json(200, { code: ["K7", "QM42XD"].join(""), expiresIn: 120 }) : stepUp();
  if (path === "/oauth/authorize/request")
    return json(200, { clientId: "tf-macos", redirectUri: "ohmail://callback", scope: "mail", address: EMAIL, expiresIn: 300 });
  if (path === "/oauth/authorize" && method === "POST") return world.windowOpen ? json(200, { redirect: "ohmail://callback?code=X" }) : stepUp();
  return json(404, { error: { code: "not_found", message: "not found" } });
}

function run(cmd: string, args: string[], env: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: WEBAPP, env: { ...process.env, ...env }, stdio: "pipe" });
    let out = "";
    p.stdout?.on("data", (d) => { out += String(d); });
    p.stderr?.on("data", (d) => { out += String(d); });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${out.slice(-4000)}`))));
  });
}

async function waitFor(url: string, timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await fetch(url, { redirect: "manual" });
      return;
    } catch {
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}\n${webLog.slice(-2000)}`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/** A browser signed in to the stand-in's one session, on `path`. */
async function signedInAt(path: string): Promise<{ context: BrowserContext; page: Page }> {
  world = fresh();
  const context = await browser!.newContext({ locale: "en-US" });
  await context.addCookies([
    { name: "tf_session", value: world.session, url: APP, httpOnly: true, sameSite: "Strict" },
    { name: "tf_csrf", value: world.csrf, url: APP, sameSite: "Strict" },
    { name: "tf_owner", value: ACCOUNT, url: APP, sameSite: "Strict" },
  ]);
  const page = await context.newPage();
  await page.goto(`${APP}${path}`);
  return { context, page };
}

/**
 * The dialog is up: the code typed, its button pressed by the mouse, the answer held at the server; Esc. The dialog
 * goes, and then the factor lands (it verifies: the server's window is open from here on).
 */
async function escapeTheHeldFactor(page: Page): Promise<void> {
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: S.codeLabel }).waitFor({ timeout: 20_000 });
  world.hold = true;
  await dialog.getByRole("textbox", { name: S.codeLabel }).fill(GOOD);
  await dialog.getByRole("button", { name: new RegExp(S.verify!) }).click();
  await expect.poll(() => world.held.length, { timeout: 10_000 }).toBe(1);
  await page.keyboard.press("Escape");
  await expect.poll(() => dialog.count(), { timeout: 5_000 }).toBe(0);
  world.hold = false;
  for (const land of world.held.splice(0)) land();
  await expect.poll(() => world.windowOpen, { timeout: 5_000 }).toBe(true);
}

describe.skipIf(!ENABLED)("Esc while the second factor is on its way — a production build over a stand-in API", () => {
  beforeAll(async () => {
    expect(existsSync(NEXT_CLI), `next's CLI missing at ${NEXT_CLI}`).toBe(true);
    const apiPort = await freePort();
    const webPort = await freePort();
    api = createServer((req, res) => {
      void serve(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); });
    });
    api.listen(apiPort, "127.0.0.1");
    await once(api, "listening");
    const origin = `http://127.0.0.1:${apiPort}`;
    delete process.env.NEXT_PUBLIC_DEMO;
    delete process.env.NEXT_PUBLIC_API_BASE;
    await run(process.execPath, [NEXT_CLI, "build"], { TF_API_ORIGIN: origin });
    web = spawn(process.execPath, [NEXT_CLI, "start", "-p", String(webPort), "-H", "127.0.0.1"], {
      cwd: WEBAPP, env: { ...process.env, TF_API_ORIGIN: origin }, stdio: "pipe",
    });
    web.stdout?.on("data", (d) => { webLog += String(d); });
    web.stderr?.on("data", (d) => { webLog += String(d); });
    APP = `http://127.0.0.1:${webPort}`;
    await waitFor(`${APP}/login`);
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    web?.kill("SIGTERM");
    await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
  });

  it("/account/delete: nothing is erased, and the page says so", async () => {
    const { context, page } = await signedInAt("/account/delete");
    try {
      await page.getByLabel(W.deleteAccount!.typeLabel!.replace("{email}", EMAIL)).fill(EMAIL, { timeout: 20_000 });
      await page.getByRole("button", { name: new RegExp(`^${W.deleteAccount!.begin}`) }).click();
      await escapeTheHeldFactor(page);
      await page.getByText(W.deleteAccount!.cancelledNothingErased!).waitFor({ timeout: 10_000 });
      expect(world.counts["DELETE /account"] ?? 0).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("/account/delete after a refused code: Esc still closes the dialog, and nothing is erased", async () => {
    const { context, page } = await signedInAt("/account/delete");
    try {
      await page.getByLabel(W.deleteAccount!.typeLabel!.replace("{email}", EMAIL)).fill(EMAIL, { timeout: 20_000 });
      await page.getByRole("button", { name: new RegExp(`^${W.deleteAccount!.begin}`) }).click();
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("textbox", { name: S.codeLabel }).fill(BAD, { timeout: 20_000 });
      await dialog.getByRole("button", { name: new RegExp(S.verify!) }).click();
      await dialog.getByText(S.badCode!).waitFor({ timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count(), { timeout: 5_000 }).toBe(0);
      expect(world.counts["DELETE /account"] ?? 0).toBe(0);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("/approve: the parked confirm does not run, and the page says nothing was confirmed", async () => {
    const { context, page } = await signedInAt(`/approve?request=${randomUUID()}`);
    try {
      await page.getByRole("button", { name: new RegExp(`^${W.approve!.confirm}`) }).click({ timeout: 20_000 });
      await escapeTheHeldFactor(page);
      await page.getByText(W.approve!.stepUpDiscarded!).waitFor({ timeout: 10_000 });
      expect(world.counts["POST /auth/desktop-approval/:id/confirm"]).toBe(1);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("/authorize-desktop: the app is not signed in, and the page says nothing ran", async () => {
    const { context, page } = await signedInAt(`/authorize-desktop?request=${randomBytes(32).toString("base64url")}`);
    try {
      await page.getByRole("button", { name: new RegExp(`^${W.authorizeDesktop!.confirm}`) }).click({ timeout: 20_000 });
      await escapeTheHeldFactor(page);
      await page.getByText(W.devices!.stepUpCancelledNothingRan!).waitFor({ timeout: 10_000 });
      expect(world.counts["POST /oauth/authorize"]).toBe(1);
    } finally {
      await context.close();
    }
  }, 120_000);

  it("/link-desktop: no code is made, and the page says so", async () => {
    const { context, page } = await signedInAt(`/link-desktop?challenge=${"A".repeat(43)}`);
    try {
      await page.getByRole("button", { name: new RegExp(`^${W.linkDesktop!.mint}`) }).click({ timeout: 20_000 });
      await escapeTheHeldFactor(page);
      await page.getByText(W.linkDesktop!.cancelledNothingMinted!).waitFor({ timeout: 10_000 });
      expect(world.counts["POST /auth/desktop-link"]).toBe(1);
    } finally {
      await context.close();
    }
  }, 120_000);
});

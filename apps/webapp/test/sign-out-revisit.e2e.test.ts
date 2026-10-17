import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { refreshTokens, sessions } from "@trafficflow/db";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession } from "../../../packages/api/test/helpers.js";

/**
 * SIGN OUT, THEN COME BACK — a production build of the web app in front of the real API routes
 * (`createApp(apiRoutes)` over PGlite), driven in Chromium. The jars are the ones measured on
 * ohmail.app: a sign-out whose server half went unconfirmed leaves `tf_owner=signed_out_pending`
 * beside the session, and every later visit to `/` reloaded the resume splash until the platform's
 * firewall challenged the browser. Here each visit must end on a page that stays put, the unfinished
 * sign-out must be finished at the door, and a press whose door never answers must end.
 *
 * Opt-in like `proxy.e2e.test.ts`: `next build` takes about a minute and two ports are bound.
 *
 *     TF_SIGNOUT_E2E=1 npx vitest run apps/webapp/test/sign-out-revisit.e2e.test.ts
 */
const ENABLED = process.env.TF_SIGNOUT_E2E === "1";
const WEBAPP = fileURLToPath(new URL("..", import.meta.url));
function nextCli(): string {
  try {
    return join(dirname(createRequire(`${WEBAPP}package.json`).resolve("next/package.json")), "dist/bin/next");
  } catch {
    return `${WEBAPP}node_modules/next/dist/bin/next`;
  }
}
const NEXT_CLI = nextCli();
const PENDING = "signed_out_pending";

/** What the sign-out door does with the next request: answer it, hold it for ever, or drop its answer. */
let signOutDoor: "answer" | "hang" | "lost" = "answer";
/** Every request the API saw: method, path, status ("held" / "dropped" for the faults), a refusal's code. */
let heard: Array<{ method: string; path: string; status: number | "held" | "dropped"; code?: string }> = [];

let world: { db: Db; deps: ApiDeps; now: Date };
const app = createApp(apiRoutes);
let api: Server | null = null;
let apiPort = 0;
let web: ChildProcess | null = null;
let webPort = 0;
let browser: Browser | null = null;
let webLog = "";

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** The real route table behind a socket, the way the web's rewrites reach the hosted API. */
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${apiPort}`);
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  const body = method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks);
  if (url.pathname === "/auth/refresh/logout" && signOutDoor === "hang") {
    heard.push({ method, path: url.pathname, status: "held" });
    return;
  }
  const answer = await app.handle(new Request(url, { method, headers, body }), { ...world.deps, session: null, idempotency: null });
  if (url.pathname === "/auth/refresh/logout" && signOutDoor === "lost") {
    heard.push({ method, path: url.pathname, status: "dropped" });
    req.socket.destroy();
    return;
  }
  const code = answer.status >= 400
    ? await answer.clone().json().then((b: { error?: { code?: string } }) => b?.error?.code, () => undefined)
    : undefined;
  heard.push({ method, path: url.pathname, status: answer.status, ...(code ? { code } : {}) });
  res.statusCode = answer.status;
  answer.headers.forEach((v, k) => { if (k !== "set-cookie") res.setHeader(k, v); });
  const cookies = answer.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  if (answer.body) Readable.fromWeb(answer.body as never).pipe(res);
  else res.end();
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

/** A full session with a refresh token in its own family, as the sign-in ceremony leaves it. */
async function signedIn(): Promise<{ access: string; refresh: string; accountId: string; familyId: string }> {
  const s = await seedSession(world.db, { now: world.now, lastTwofaAt: world.now });
  const [row] = await world.db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
  const refresh = generateToken();
  await world.db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
    tokenHash: hashToken(refresh), expiresAt: new Date(world.now.getTime() + 2 * 60 * 60 * 1000), createdAt: world.now,
  });
  return { access: s.token, refresh, accountId: s.accountId, familyId: row!.familyId };
}

/** Is the family still able to mint? (the sign-out door revokes its tokens) */
async function familyLive(familyId: string): Promise<boolean> {
  const rows = await world.db.select({ revokedAt: refreshTokens.revokedAt }).from(refreshTokens)
    .where(eq(refreshTokens.familyId, familyId));
  return rows.some((r) => r.revokedAt === null);
}

/** Plant the jar each cookie at the path the server sets it on; `owner` is the marker's raw value. */
async function plant(ctx: BrowserContext, j: { access: string; refresh: string }, o: { owner: string; access: boolean }): Promise<void> {
  const host = "localhost";
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const base = { domain: host, secure: true, expires } as const;
  await ctx.addCookies([
    ...(o.access ? [
      { ...base, name: "tf_session", value: j.access, path: "/", httpOnly: true, sameSite: "Strict" as const },
      { ...base, name: "tf_csrf", value: csrfTokenFor(j.access), path: "/", httpOnly: false, sameSite: "Strict" as const },
    ] : []),
    { ...base, name: "tf_refresh", value: j.refresh, path: "/auth/refresh", httpOnly: true, sameSite: "Strict" as const },
    { ...base, name: "tf_resume", value: "1", path: "/", httpOnly: true, sameSite: "Lax" as const },
    { ...base, name: "tf_owner", value: o.owner, path: "/", httpOnly: false, sameSite: "Strict" as const },
  ]);
}

/** The session cookies still in the jar, by name. */
async function jarNames(ctx: BrowserContext): Promise<string[]> {
  const all = await ctx.cookies([`http://localhost:${webPort}/`, `http://localhost:${webPort}/auth/refresh`]);
  return all.filter((c) => c.name.startsWith("tf_") && c.value !== "").map((c) => c.name).sort();
}

/**
 * The browser a stuck sign-out leaves: the app ran in it (its mirror and the mirror registry's anchor
 * exist), then a sign-out went unconfirmed. `markSignedOutPending` is the client's own write; the access
 * cookie and `tf_csrf` lapse together. `revoked` is the lost answer: the door ended the family.
 */
async function stuckBrowser(ctx: BrowserContext, j: { access: string; refresh: string; accountId: string; familyId: string },
  o: { revoked: boolean; lapsed: boolean }): Promise<void> {
  await plant(ctx, j, { owner: j.accountId, access: true });
  const app = await ctx.newPage();
  await app.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
  await app.getByRole("button", { name: /^Sign out$/ }).waitFor({ state: "visible", timeout: 60_000 });
  await app.waitForTimeout(2_000);
  await app.evaluate(() => { document.cookie = "tf_owner=signed_out_pending; Path=/; Max-Age=7776000; SameSite=Strict"; });
  await app.close();
  if (o.lapsed) {
    await ctx.clearCookies({ name: "tf_session" });
    await ctx.clearCookies({ name: "tf_csrf" });
  }
  if (o.revoked) {
    await world.db.update(sessions).set({ revokedAt: world.now }).where(eq(sessions.familyId, j.familyId));
    await world.db.update(refreshTokens).set({ revokedAt: world.now }).where(eq(refreshTokens.familyId, j.familyId));
  }
}

/** What the page said and what the API heard, for a failing case's message. */
async function said(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 300) ?? "").catch(() => "?");
  return `${new URL(page.url()).pathname} · ${JSON.stringify(text)} · ${JSON.stringify(heard.map((h) => `${h.method} ${h.path} ${h.status}${h.code ? ` ${h.code}` : ""}`))}`;
}

/** Main-frame DOCUMENT loads from now on (a reload is one; a history change is none), and the path. */
function watch(page: Page): { loads: () => number; path: () => string } {
  let loads = 0;
  page.on("request", (r) => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) loads += 1; });
  return { loads: () => loads, path: () => new URL(page.url()).pathname };
}

/** Nothing the visit did minted a session, and nothing asked the refresh door before the sign-out door. */
function neverResumed(): { minted: number; refreshedBeforeTheDoor: number } {
  const door = heard.findIndex((h) => h.path === "/auth/refresh/logout");
  return {
    minted: heard.filter((h) => h.path === "/auth/refresh" && h.status === 204).length,
    refreshedBeforeTheDoor: heard.slice(0, door < 0 ? heard.length : door).filter((h) => h.path === "/auth/refresh").length,
  };
}

describe.skipIf(!ENABLED)("sign out, then come back — a production build over the real routes", () => {
  beforeAll(async () => {
    expect(existsSync(NEXT_CLI), `next's CLI missing at ${NEXT_CLI}`).toBe(true);
    apiPort = await freePort();
    webPort = await freePort();
    // The browser's Origin is the web's own name, and the cross-site guard admits configured origins only.
    const made = await makeDeps(new Date(), { origin: [`http://localhost:${webPort}`] });
    world = { db: made.db, deps: made.deps, now: made.clock.now() };
    api = createServer((req, res) => { void serve(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
    api.listen(apiPort, "127.0.0.1");
    await once(api, "listening");
    const origin = `http://127.0.0.1:${apiPort}`;
    delete process.env.NEXT_PUBLIC_DEMO;
    delete process.env.NEXT_PUBLIC_API_BASE;
    await run(process.execPath, [NEXT_CLI, "build"], { TF_API_ORIGIN: origin });
    web = spawn(process.execPath, [NEXT_CLI, "start", "-p", String(webPort), "-H", "localhost"], {
      cwd: WEBAPP, env: { ...process.env, TF_API_ORIGIN: origin }, stdio: "pipe",
    });
    web.stdout?.on("data", (d) => { webLog += String(d); });
    web.stderr?.on("data", (d) => { webLog += String(d); });
    await waitFor(`http://localhost:${webPort}/login`);
    browser = await chromium.launch();
  }, 300_000);

  afterAll(async () => {
    await browser?.close();
    web?.kill("SIGTERM");
    await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
  });

  it("THE STUCK JAR — pending marker, live family, lapsed access: one pass, the door, /login", async () => {
    signOutDoor = "answer";
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await stuckBrowser(ctx, j, { revoked: false, lapsed: true });
    heard = [];
    const page = await ctx.newPage();
    const seen = watch(page);
    await page.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    await page.waitForTimeout(8_000);
    expect(seen.loads(), `the front door reloaded itself — the loop measured on ohmail.app: ${await said(page)}`).toBeLessThanOrEqual(3);
    expect(seen.path(), `the visit did not end on the sign-in page: ${await said(page)}`).toBe("/login");
    expect(neverResumed(), `a browser that asked to sign out was resumed: ${await said(page)}`)
      .toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
    expect(heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status), "the unfinished sign-out was not finished at the door")
      .toEqual([204]);
    expect(await familyLive(j.familyId), "the family the browser signed out of can still mint").toBe(false);
    expect(await jarNames(ctx), "the jar still holds session cookies").toEqual([]);
    await ctx.close();
  }, 60_000);

  it("the family already ended, the access cookie still in the jar: /login, no loop", async () => {
    signOutDoor = "answer";
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await stuckBrowser(ctx, j, { revoked: true, lapsed: false });
    heard = [];
    const page = await ctx.newPage();
    const seen = watch(page);
    await page.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    await page.waitForTimeout(8_000);
    expect(seen.loads(), `the front door reloaded itself: ${await said(page)}`).toBeLessThanOrEqual(3);
    expect(seen.path(), `the visit did not end on the sign-in page: ${await said(page)}`).toBe("/login");
    expect(neverResumed()).toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
    expect(await jarNames(ctx)).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("a sign-out door that never answers: the press ends, and the next visit finishes it", async () => {
    signOutDoor = "hang";
    heard = [];
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await plant(ctx, j, { owner: j.accountId, access: true });
    const page = await ctx.newPage();
    const seen = watch(page);
    await page.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
    const button = page.getByRole("button", { name: /^Sign out$/ });
    await button.waitFor({ state: "visible", timeout: 60_000 });
    await button.click();
    // The door holds the first press; from here on it answers, as a server that came back would.
    const until = Date.now() + 10_000;
    while (!heard.some((h) => h.path === "/auth/refresh/logout") && Date.now() < until) await page.waitForTimeout(100);
    expect(heard.some((h) => h.path === "/auth/refresh/logout" && h.status === "held"), "the press never reached the door").toBe(true);
    signOutDoor = "answer";
    // Judged inside the 30 s after which `next start`'s rewrite proxy would give up on the
    // held request by itself: the press has to end on its own deadline, not on the platform's.
    await page.waitForTimeout(20_000);
    expect(await page.getByText("Signing out…").count(), "Signing out… for 20 s: the press has no end of its own").toBe(0);
    await page.waitForTimeout(20_000);
    expect(seen.path(), "the unfinished sign-out was not finished on the next page").toBe("/login");
    expect(await familyLive(j.familyId), "the session is still live on the server").toBe(false);
    expect(await jarNames(ctx)).toEqual([]);
    await ctx.close();
  }, 150_000);

  it("THE CONTROL — a plain sign-out ends the family and leaves no session behind", async () => {
    signOutDoor = "answer";
    heard = [];
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await plant(ctx, j, { owner: j.accountId, access: true });
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
    const button = page.getByRole("button", { name: /^Sign out$/ });
    await button.waitFor({ state: "visible", timeout: 60_000 });
    await button.click();
    await page.waitForTimeout(8_000);
    expect(heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status)).toEqual([204]);
    expect(await familyLive(j.familyId)).toBe(false);
    expect(await jarNames(ctx)).toEqual([]);
    const again = await ctx.newPage();
    const seen = watch(again);
    await again.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    await again.waitForTimeout(5_000);
    expect(seen.loads(), "the revisit after a clean sign-out navigated more than once").toBeLessThanOrEqual(2);
    await ctx.close();
  }, 90_000);
});

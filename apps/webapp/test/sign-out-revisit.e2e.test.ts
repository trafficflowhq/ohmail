import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { createApp, apiRoutes, csrfTokenFor, type ApiDeps } from "@trafficflow/api";
import { accountSettings, refreshTokens, sessions } from "@trafficflow/db";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession } from "../../../packages/api/test/helpers.js";
import messages from "../messages/en.json";

/**
 * SIGN OUT, THEN COME BACK — a production build of the web app in front of the real API routes
 * (`createApp(apiRoutes)` over PGlite), driven in Chromium. The jars are the ones measured on
 * ohmail.app: a sign-out whose server half went unconfirmed leaves `tf_owner=signed_out_pending`
 * beside the session, and every later visit to `/` reloaded the resume splash until the platform's
 * firewall challenged the browser. Here each visit must end on a page that stays put, the unfinished
 * sign-out must be finished at the door, and a press whose door never answers must end.
 *
 * Every visit is also READ while it waits, every 100 ms: a front door that paints nothing while a
 * door is slow is the 20 s blank page reported on ohmail.app. Each case prints its timings
 * (`e2e timing`).
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
const R = messages.resume as Record<string, string>;
const A = messages.account as Record<string, string>;
/** The server-refused sentence up to its reason, which is the client's own words for a door that never answered. */
const REFUSED_LEAD = A.signOutServerRefused!.split("{reason}")[0]!.trim();

/** What the sign-out door does with the next request: answer it, hold it for ever, or drop its answer. */
let signOutDoor: "answer" | "hang" | "lost" = "answer";
/** How many requests the faulty door spoils before it answers again, as a server that came back would. */
let doorFaultsLeft = Number.POSITIVE_INFINITY;
/** The refresh door answers at once, or holds every request {@link SLOW_REFRESH_MS} and then answers. */
let refreshDoor: "answer" | "slow" = "answer";
/** A wake row's DELETE is answered at once, or held until {@link releaseWakeDelete} lets it through. */
let wakeDeleteDoor: "answer" | "hold" = "answer";
let releaseWakeDelete: () => void = () => {};
/** `hold`: the browser's next session read (cookies, not the edge's bearer probe), held once answered. */
let sessionDoor: "answer" | "hold" = "answer";
let releaseSession: () => void = () => {};
const SLOW_REFRESH_MS = 20_000;
/** Every request the API saw: method, path, status ("held" / "dropped" for the faults), a refusal's code. */
let heard: Array<{ method: string; path: string; status: number | "held" | "dropped"; code?: string }> = [];
/** The path {@link heard} files a cache purge under (`x-ohmail-clear: cache` on the refresh path). */
const PURGE_PATH = "/auth/refresh (purge)";
/** When each request below the refresh path ARRIVED (ms since `receivedFrom`) and which cookies it carried, by name. */
let received: Array<{ ms: number; path: string; cookies: string[] }> = [];
let receivedFrom = Date.now();

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
  // The cache purge after a confirmed sign-out presents nothing: logged apart, never as a renewal.
  const path = headers.get("x-ohmail-clear") === "cache" ? PURGE_PATH : url.pathname;
  if (url.pathname.startsWith("/auth/refresh")) {
    const names = (headers.get("cookie") ?? "").split(";").map((c) => c.split("=")[0]!.trim()).filter((n) => n.startsWith("tf_"));
    received.push({ ms: Date.now() - receivedFrom, path, cookies: names.sort() });
  }
  const fault = url.pathname === "/auth/refresh/logout" && signOutDoor !== "answer" && doorFaultsLeft > 0;
  if (fault) doorFaultsLeft -= 1;
  if (fault && signOutDoor === "hang") {
    heard.push({ method, path: url.pathname, status: "held" });
    return;
  }
  if (url.pathname === "/auth/refresh" && refreshDoor === "slow") await new Promise((r) => setTimeout(r, SLOW_REFRESH_MS));
  if (method === "DELETE" && url.pathname.startsWith("/push/subscriptions/") && wakeDeleteDoor === "hold") {
    heard.push({ method, path: url.pathname, status: "held" });
    await new Promise<void>((r) => { releaseWakeDelete = r; });
  }
  const answer = await app.handle(new Request(url, { method, headers, body }), { ...world.deps, session: null, idempotency: null });
  if (url.pathname === "/auth/session" && sessionDoor === "hold" && /(^|;\s*)tf_session=/.test(headers.get("cookie") ?? "")) {
    sessionDoor = "answer";
    heard.push({ method, path: url.pathname, status: "held" });
    await new Promise<void>((r) => { releaseSession = r; });
  }
  if (fault && signOutDoor === "lost") {
    heard.push({ method, path: url.pathname, status: "dropped" });
    req.socket.destroy();
    return;
  }
  const code = answer.status >= 400
    ? await answer.clone().json().then((b: { error?: { code?: string } }) => b?.error?.code, () => undefined)
    : undefined;
  heard.push({ method, path, status: answer.status, ...(code ? { code } : {}) });
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

/** The previous person's account, read or acted on: the session, its renewal, and what `/join` went on to ask. */
const ACCOUNT_PATHS = ["/auth/session", "/auth/refresh", "/auth/2fa/recovery-codes", "/mailboxes", "/account/access", "/account/manage-link"];
const accountAsked = (): string[] =>
  heard.filter((h) => ACCOUNT_PATHS.includes(h.path)).map((h) => `${h.method} ${h.path} ${h.status}`);
const doorAnswers = (): Array<number | "held" | "dropped"> =>
  heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status);

/** One reading of the page: where it is, whether it has parsed, what it says, which card shows, and the mailbox shell. */
interface Sample { ms: number; path: string; ready: string; text: string; loginCard: boolean; gateMark: boolean; shell: boolean }

/**
 * Read the page every 100 ms from `t0` until `done` holds or `maxMs` passes. A reading that falls
 * between two documents is skipped; one taken while the document is still parsing is kept and
 * marked, so a caller can tell "not parsed yet" from "parsed and empty".
 */
async function sampleUntil(
  page: Page, t0: number, maxMs: number, done: (s: Sample) => boolean | Promise<boolean>,
): Promise<Sample[]> {
  const out: Sample[] = [];
  while (Date.now() - t0 < maxMs) {
    const s = await page.evaluate(() => {
      const shown = (sel: string): boolean => {
        const el = document.querySelector<HTMLElement>(sel);
        if (!el) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (el.innerText ?? "").trim() !== "";
      };
      return {
        path: location.pathname, ready: document.readyState, text: document.body?.innerText ?? "",
        loginCard: shown(".login-card"), gateMark: shown(".gate-card .wordmark"),
        shell: document.querySelector(".app-root, .row[data-id]") !== null,
      };
    }).catch(() => null);
    if (s !== null) {
      const sample = { ms: Date.now() - t0, ...s };
      out.push(sample);
      if (await done(sample)) break;
    }
    await page.waitForTimeout(100);
  }
  return out;
}

/** The readings of a parsed document that showed nothing at all. */
const blankAt = (samples: Sample[]): number[] =>
  samples.filter((s) => s.ready !== "loading" && s.text.trim() === "").map((s) => s.ms);

/** Main-frame document answers, in order: the path asked, the status, where a redirect pointed. */
function documents(page: Page): Array<{ path: string; status: number; location: string | null }> {
  const docs: Array<{ path: string; status: number; location: string | null }> = [];
  const pathOf = (u: URL): string => `${u.pathname}${u.search}`;
  page.on("response", (r) => {
    if (!r.request().isNavigationRequest() || r.frame() !== page.mainFrame()) return;
    const to = r.headers()["location"];
    docs.push({ path: pathOf(new URL(r.url())), status: r.status(), location: to ? pathOf(new URL(to, r.url())) : null });
  });
  return docs;
}

/**
 * Follow a link to `url` from a page of no site (opaque origin): a cross-site navigation, so the
 * edge gets the `Lax` resume marker and none of the `Strict` cookies, `tf_owner` included.
 */
async function arriveFromElsewhere(page: Page, url: string): Promise<void> {
  await page.setContent(`<a id="elsewhere" href="${url}">a link from another site</a>`);
  await page.click("#elsewhere");
}

/** Console errors and uncaught page errors from now on. */
function errorsOf(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => { errors.push(String(e)); });
  return errors;
}

/** The jar is empty and the family can no longer mint. */
async function finished(ctx: BrowserContext, familyId: string): Promise<boolean> {
  return (await jarNames(ctx)).length === 0 && !(await familyLive(familyId));
}

/** One record of a real tab: an event it heard, a document it started, or a frame it drew, and the shell then. */
interface TabEvent {
  tab: string; type: string; at: number; vis: string; shell: boolean; path: string;
  persisted?: boolean; nav?: string | null; notRestored?: string[] | null;
}

/**
 * Runs in every document from its first script: each lifecycle event (before the app's own listeners),
 * the document's start (how it was reached, why a back was not restored) and the first frame after any of
 * those, or after the shell came or went. Sent out at once, so the record outlives the tab's navigations.
 */
function recordTab(): void {
  const w = window as unknown as { __soRec?: (r: Record<string, unknown>) => Promise<void> };
  const queue: Array<Record<string, unknown>> = [];
  const shell = (): boolean => document.querySelector(".app-root, .row[data-id]") !== null;
  const send = (type: string, x: Record<string, unknown> = {}): void => {
    queue.push({ at: Date.now(), type, vis: document.visibilityState, shell: shell(), path: location.pathname, ...x });
    if (typeof w.__soRec === "function") for (const r of queue.splice(0)) void w.__soRec(r).catch(() => {});
  };
  let owed = true;
  let drawn: boolean | null = null;
  const event = (type: string, x: Record<string, unknown> = {}): void => { owed = true; send(type, x); };
  for (const t of ["visibilitychange", "resume", "freeze"]) document.addEventListener(t, () => event(t), true);
  for (const t of ["pageshow", "pagehide"]) {
    window.addEventListener(t, (e) => event(t, { persisted: (e as PageTransitionEvent).persisted }), true);
  }
  for (const t of ["focus", "blur"]) window.addEventListener(t, (e) => { if (e.target === window) event(t); }, true);
  const frame = (): void => {
    const now = shell();
    if (owed || now !== drawn) {
      owed = false;
      drawn = now;
      send("frame");
    }
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  type Reasons = { reasons?: Array<{ reason: string }> | null; children?: Reasons[] | null };
  const flat = (r: Reasons | null | undefined): string[] =>
    r ? [...(r.reasons ?? []).map((x) => x.reason), ...(r.children ?? []).flatMap(flat)] : [];
  const nav = performance.getEntriesByType("navigation")[0] as (PerformanceEntry & { type?: string; notRestoredReasons?: Reasons | null }) | undefined;
  event("boot", { nav: nav?.type ?? null, notRestored: nav?.notRestoredReasons ? flat(nav.notRestoredReasons) : null });
}

interface RealTabs {
  ctx: BrowserContext;
  log: TabEvent[];
  /** Name `page` in the log. */
  tab: (page: Page, name: string) => Page;
  /** A page in a window of its own, beside the others. */
  newWindow: () => Promise<Page>;
  close: () => Promise<void>;
}

/**
 * A headful Chromium started here, on a fresh profile, on this run's display, attached with `noDefaults`: no
 * focus emulation keeps a background tab visible and no launch flag turns bfcache off.
 */
async function realTabs(o: { channel: boolean } = { channel: true }): Promise<RealTabs> {
  const profile = mkdtempSync(join(tmpdir(), "ohmail-real-tabs-"));
  // Its own process group, so every helper process it starts goes with it before the profile is removed.
  const proc = spawn(chromium.executablePath(), [
    `--user-data-dir=${profile}`, "--remote-debugging-port=0", "--no-first-run", "--no-default-browser-check",
    "--disable-background-networking", "--disable-component-update", "--disable-sync", "--password-store=basic",
    "--use-mock-keychain", "--window-size=1200,800", "about:blank",
  ], { stdio: "ignore", detached: true });
  const exited = once(proc, "exit");
  let port = "";
  for (let i = 0; i < 300 && port === ""; i += 1) {
    await new Promise((r) => setTimeout(r, 100));
    try { port = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0] ?? ""; } catch { /* not written yet */ }
  }
  const stop = async (): Promise<void> => {
    try { process.kill(-proc.pid!, "SIGTERM"); } catch { /* already gone */ }
    await exited;
    rmSync(profile, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  };
  if (port === "") {
    await stop();
    throw new Error("the browser never opened its debugging port");
  }
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
  const ctx = browser.contexts()[0]!;
  const names = new Map<Page, string>();
  const log: TabEvent[] = [];
  await ctx.exposeBinding("__soRec", ({ page }: { page: Page }, r: Omit<TabEvent, "tab">) => {
    log.push({ tab: names.get(page) ?? "?", ...r });
  });
  await ctx.addInitScript(recordTab);
  // A browser with no `BroadcastChannel`: the post goes by the storage event alone.
  if (!o.channel) await ctx.addInitScript(() => { delete (window as { BroadcastChannel?: unknown }).BroadcastChannel; });
  const cdp = await browser.newBrowserCDPSession();
  return {
    ctx,
    log,
    tab: (page, name) => { names.set(page, name); return page; },
    newWindow: async () => {
      const [page] = await Promise.all([ctx.waitForEvent("page"), cdp.send("Target.createTarget", { url: "about:blank", newWindow: true })]);
      return page;
    },
    close: async () => {
      await browser.close().catch(() => {});
      await stop();
    },
  };
}

/** A tab's records from `from` on, one line: ms after `from`, the record, the visibility, SHELL when drawn. */
function storyOf(log: TabEvent[], tab: string, from: number): string {
  return log.filter((e) => e.tab === tab && e.at >= from).map((e) => {
    const extra = e.type === "boot" ? `(${e.nav}${e.notRestored ? ` ${e.notRestored.join(",")}` : ""})`
      : e.persisted !== undefined ? `(persisted=${e.persisted})` : "";
    return `${e.at - from} ${e.type}${extra} ${e.vis} ${e.shell ? "SHELL" : "-"} ${e.path}`;
  }).join(" | ");
}

/** The frames `tab` drew from `from` on: whether each showed the shell. */
const framesOf = (log: TabEvent[], tab: string, from: number): boolean[] =>
  log.filter((e) => e.tab === tab && e.type === "frame" && e.at >= from).map((e) => e.shell);

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

  beforeEach(() => {
    doorFaultsLeft = Number.POSITIVE_INFINITY;
    refreshDoor = "answer";
    wakeDeleteDoor = "answer";
    sessionDoor = "answer";
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
    // The door's 204 no longer carries the cache clear: the browser asked for it once, after it.
    expect(heard.filter((h) => h.path === PURGE_PATH).map((h) => h.status), "the cache clear after the sign-out").toEqual([202]);
    expect(await familyLive(j.familyId)).toBe(false);
    expect(await jarNames(ctx)).toEqual([]);
    const again = await ctx.newPage();
    const seen = watch(again);
    await again.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    await again.waitForTimeout(5_000);
    expect(seen.loads(), "the revisit after a clean sign-out navigated more than once").toBeLessThanOrEqual(2);
    await ctx.close();
  }, 90_000);

  it("THE EDGE — a pending jar's `/` is a 307 to /login, query dropped, no-store, nothing asked of the API", async () => {
    const j = await signedIn();
    heard = [];
    for (const [jar, cookie] of [
      ["access cookie", `tf_session=${j.access}; tf_resume=1; tf_owner=${PENDING}`],
      ["lapsed access", `tf_resume=1; tf_owner=${PENDING}`],
    ] as const) {
      const res = await fetch(`http://localhost:${webPort}/?from=mail`, { redirect: "manual", headers: { cookie } });
      const to = new URL(res.headers.get("location") ?? "", `http://localhost:${webPort}`);
      expect(`${jar}: ${res.status} ${to.pathname}${to.search}`).toBe(`${jar}: 307 /login`);
      expect(res.headers.get("cache-control"), jar).toBe("private, no-store");
    }
    expect(heard, "the edge asked the API about a browser that asked to sign out").toEqual([]);
    // THE CONTROL — the same jar naming an account is the splash: a rewrite, never a redirect.
    const splash = await fetch(`http://localhost:${webPort}/`, { redirect: "manual", headers: { cookie: `tf_resume=1; tf_owner=${j.accountId}` } });
    expect(splash.status).toBe(200);
  }, 30_000);

  /*
   * A TAB OPENED DURING THE SIGN-OUT (measured on Cloud 0.30.30: a tab opened ~0.2 s after the press drew the
   * Ohbox for the rest of the request). Two windows: the press's wake row DELETE, which used to run before the
   * jar was marked, and a page the edge served before the press whose script runs after it.
   */
  it("A TAB OPENED WHILE THE PRESS'S WAKE ROW DELETE IS OUT: a 307 to /login, never the shell, no account read", async () => {
    signOutDoor = "answer";
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await plant(ctx, j, { owner: j.accountId, access: true });
    const a = await ctx.newPage();
    await a.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
    const button = a.getByRole("button", { name: /^Sign out$/ });
    await button.waitFor({ state: "visible", timeout: 60_000 });
    // After the boot's own wake reconcile (it registers the worker, then turns any stored row off): a stored
    // row id, as a browser that registered for wakes holds one.
    const registered = (): Promise<boolean> => a.evaluate(async () => (await navigator.serviceWorker.getRegistration()) !== undefined);
    for (let i = 0; i < 100 && !(await registered()); i += 1) await a.waitForTimeout(100);
    await a.waitForTimeout(1_000);
    await a.evaluate(() => { localStorage.setItem("ohmail.notifications.subscriptionId", "row-e2e"); });
    heard = [];
    wakeDeleteDoor = "hold";
    await button.click();
    const until = Date.now() + 10_000;
    while (!heard.some((h) => h.method === "DELETE") && Date.now() < until) await a.waitForTimeout(50);
    expect(heard.filter((h) => h.method === "DELETE").map((h) => h.status), `the press's wake row DELETE never left: ${await said(a)}`)
      .toEqual(["held"]);
    const before = heard.length;
    const b = await ctx.newPage();
    const docs = documents(b);
    const errors = errorsOf(b);
    const t0 = Date.now();
    await b.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    const samples = await sampleUntil(b, t0, 10_000, (s) => s.path === "/login" && s.loginCard);
    const read = heard.slice(before).filter((h) => ACCOUNT_PATHS.includes(h.path)).map((h) => `${h.method} ${h.path} ${h.status}`);
    console.log(`e2e timing wake-delete-held docs=${JSON.stringify(docs)} shell_ms=${JSON.stringify(samples.filter((s) => s.shell).map((s) => s.ms))} `
      + `read=${JSON.stringify(read)} errors=${JSON.stringify(errors)}`);
    expect(docs[0], `the new tab was served the app while the sign-out was out: ${await said(b)}`)
      .toEqual({ path: "/", status: 307, location: "/login" });
    expect(samples.filter((s) => s.shell).map((s) => s.ms), "the new tab drew the mailbox").toEqual([]);
    expect(read, "the new tab read the account").toEqual([]);
    expect(samples.at(-1)?.path).toBe("/login");
    releaseWakeDelete();
    await ctx.close();
  }, 120_000);

  it("A TAB SERVED BEFORE THE PRESS, ITS SCRIPT RUN AFTER IT, the request held: never the shell, and /login", async () => {
    signOutDoor = "hang";
    doorFaultsLeft = 1;
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await plant(ctx, j, { owner: j.accountId, access: true });
    const a = await ctx.newPage();
    await a.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
    const button = a.getByRole("button", { name: /^Sign out$/ });
    await button.waitFor({ state: "visible", timeout: 60_000 });
    await a.waitForTimeout(2_000);
    // B's document is served while the jar still names the account; its scripts wait for the press.
    const b = await ctx.newPage();
    const held: Route[] = [];
    let scripts = false;
    await b.route("**/_next/static/chunks/**", (route) => { if (scripts) void route.continue(); else held.push(route); });
    const docs = documents(b);
    const errors = errorsOf(b);
    await b.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    expect(docs[0], "the new tab was not served the app before the press").toEqual({ path: "/", status: 200, location: null });
    heard = [];
    await button.click();
    const until = Date.now() + 10_000;
    while (!heard.some((h) => h.path === "/auth/refresh/logout") && Date.now() < until) await a.waitForTimeout(50);
    expect(heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status), "the press never reached the door").toEqual(["held"]);
    const before = heard.length;
    const t0 = Date.now();
    scripts = true;
    for (const route of held.splice(0)) await route.continue();
    const samples = await sampleUntil(b, t0, 15_000, (s) => s.path === "/login" && s.loginCard);
    const asked = heard.slice(before).filter((h) => h.path === "/auth/session").map((h) => h.status);
    console.log(`e2e timing served-before-press docs=${JSON.stringify(docs)} shell_ms=${JSON.stringify(samples.filter((s) => s.shell).map((s) => s.ms))} `
      + `session=${JSON.stringify(asked)} last=${samples.at(-1)?.path} errors=${JSON.stringify(errors)}`);
    expect(samples.filter((s) => s.shell).map((s) => s.ms), `the tab drew the mailbox under the pending sign-out: ${await said(b)}`).toEqual([]);
    expect(asked, "the tab asked the session door under the pending sign-out").toEqual([]);
    expect(samples.at(-1)?.path, `the tab did not end on the sign-in page: ${await said(b)}`).toBe("/login");
    expect(errors, "console errors on the way out").toEqual([]);
    await ctx.close();
  }, 120_000);

  it("A COLD TAB WHOSE SESSION CHECK CROSSES THE PRESS: never the shell, /login, and the jar never names the account", async () => {
    signOutDoor = "hang";
    doorFaultsLeft = 1;
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await plant(ctx, j, { owner: j.accountId, access: true });
    const a = await ctx.newPage();
    await a.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
    const button = a.getByRole("button", { name: /^Sign out$/ });
    await button.waitFor({ state: "visible", timeout: 60_000 });
    await a.waitForTimeout(2_000);
    // The marker went (a browser restart): B boots cold, and only its own session check names the account.
    await ctx.clearCookies({ name: "tf_owner" });
    heard = [];
    sessionDoor = "hold";
    const b = await ctx.newPage();
    const t0 = Date.now();
    await b.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    const until = Date.now() + 20_000;
    while (!heard.some((h) => h.status === "held") && Date.now() < until) await b.waitForTimeout(50);
    expect(heard.filter((h) => h.status === "held").map((h) => h.path), `B's session check never left: ${await said(b)}`).toEqual(["/auth/session"]);
    await button.click();
    while (!heard.some((h) => h.path === "/auth/refresh/logout") && Date.now() < until + 10_000) await a.waitForTimeout(50);
    releaseSession();
    const named: string[] = [];
    const samples = await sampleUntil(b, t0, 25_000, async (s) => {
      const owner = (await ctx.cookies(`http://localhost:${webPort}/`)).find((c) => c.name === "tf_owner")?.value;
      if (owner !== undefined) named.push(owner);
      return s.path === "/login" && s.loginCard;
    });
    console.log(`e2e timing cold-tab-check shell_ms=${JSON.stringify(samples.filter((s) => s.shell).map((s) => s.ms))} `
      + `owner=${JSON.stringify([...new Set(named.map((v) => (v === j.accountId ? "account" : v)))])} last=${samples.at(-1)?.path}`);
    expect(samples.filter((s) => s.shell).map((s) => s.ms), `the cold tab drew the mailbox: ${await said(b)}`).toEqual([]);
    expect(named.filter((v) => v === j.accountId), "the jar named the account after the press").toEqual([]);
    expect(samples.at(-1)?.path, `the cold tab did not end on the sign-in page: ${await said(b)}`).toBe("/login");
    await ctx.close();
  }, 120_000);

  for (const [door, lapsed] of [["answer", true], ["hang", false], ["lost", false]] as const) {
    it(`A PENDING SIGN-OUT, the door ${door === "answer" ? "answering" : door === "hang" ? "holding its first ask" : "losing its first answer"}: the sign-in card at once, the sign-out finished behind it`, async () => {
      signOutDoor = door;
      doorFaultsLeft = 1;
      const j = await signedIn();
      const ctx = await browser!.newContext();
      await stuckBrowser(ctx, j, { revoked: false, lapsed });
      heard = [];
      const page = await ctx.newPage();
      const seen = watch(page);
      const docs = documents(page);
      const errors = errorsOf(page);
      const t0 = Date.now();
      received = [];
      receivedFrom = t0;
      await page.goto(`http://localhost:${webPort}/?from=mail`, { waitUntil: "commit" });
      // Read until the sign-out is finished behind the card (the ladder's bound is ~16 s for a held
      // first ask: 4 s of wake revoke, the door's 10 s deadline, one backoff), every reading checked.
      const samples = await sampleUntil(page, t0, 40_000,
        async (s) => s.path === "/login" && s.loginCard && await finished(ctx, j.familyId));
      const cardAt = samples.find((s) => s.path === "/login" && s.loginCard)?.ms ?? null;
      const blank = blankAt(samples);
      const last = samples.at(-1);
      const done = last !== undefined && last.path === "/login" && last.loginCard && await finished(ctx, j.familyId) ? last.ms : null;
      const text = await page.evaluate(() => document.querySelector<HTMLElement>(".login-card")?.innerText ?? "").catch(() => "");
      console.log(`e2e timing pending door=${door} lapsed=${lapsed} card_ms=${cardAt} blank_ms=${JSON.stringify(blank)} `
        + `finished_ms=${done} docs=${JSON.stringify(docs)} door_asks=${JSON.stringify(heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status))} `
        + `received=${JSON.stringify(received)} loads=${seen.loads()} errors=${JSON.stringify(errors)}`);
      expect(docs[0], `the front door did not send the browser to the sign-in page: ${await said(page)}`)
        .toEqual({ path: "/?from=mail", status: 307, location: "/login" });
      expect(neverResumed(), `a browser that asked to sign out was resumed: ${await said(page)}`)
        .toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
      expect(heard.filter((h) => h.path === "/auth/session"), "the session was read under a pending sign-out").toEqual([]);
      expect(cardAt, `the sign-in card was not on screen: ${await said(page)}`).not.toBeNull();
      expect(cardAt!, "the sign-in card took longer than the bound").toBeLessThanOrEqual(1_500);
      expect(blank, `a blank page while the sign-out was finished: ${await said(page)}`).toEqual([]);
      expect(text, "the sign-in card does not say why it is showing").toContain(R.pendingBody);
      expect(done, `the sign-out was not finished within the ladder: ${await said(page)}`).not.toBeNull();
      expect(await familyLive(j.familyId)).toBe(false);
      expect(await jarNames(ctx)).toEqual([]);
      expect(seen.loads(), "the front door navigated more than the redirect").toBeLessThanOrEqual(2);
      expect(seen.path()).toBe("/login");
      if (door === "answer") expect(errors, "console errors on the way to the sign-in page").toEqual([]);
      await ctx.close();
    }, 150_000);
  }

  it("A PENDING SIGN-OUT, the door never answering: the sign-in card at once, the ladder bounded, never resumed, and said", async () => {
    signOutDoor = "hang";
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await stuckBrowser(ctx, j, { revoked: false, lapsed: false });
    heard = [];
    const page = await ctx.newPage();
    const docs = documents(page);
    const t0 = Date.now();
    received = [];
    receivedFrom = t0;
    await page.goto(`http://localhost:${webPort}/?from=mail`, { waitUntil: "commit" });
    // Four asks, each given up at the door's 10 s deadline, with the backoffs between: under 50 s.
    const samples = await sampleUntil(page, t0, 60_000, () => false);
    await page.waitForTimeout(10_000);
    const cardAt = samples.find((s) => s.path === "/login" && s.loginCard)?.ms ?? null;
    const blank = blankAt(samples);
    const asks = received.filter((r) => r.path === "/auth/refresh/logout");
    const text = await page.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    const alert = await page.evaluate(() => document.querySelector<HTMLElement>('.login-card [role="alert"]')?.innerText ?? "")
      .catch(() => "");
    const pendingSaidAt = samples.find((s) => s.path === "/login" && s.text.includes(R.pendingBody!))?.ms ?? null;
    const refusalSaidAt = samples.find((s) => s.text.includes(REFUSED_LEAD))?.ms ?? null;
    console.log(`e2e timing pending door=never card_ms=${cardAt} blank_samples=${blank.length} `
      + `blank_first_last_ms=${JSON.stringify([blank[0] ?? null, blank.at(-1) ?? null])} docs=${JSON.stringify(docs)} `
      + `door_asks_ms=${JSON.stringify(asks.map((a) => a.ms))} pending_said_ms=${pendingSaidAt} refusal_said_ms=${refusalSaidAt} `
      + `last_path=${samples.at(-1)?.path} text=${JSON.stringify(text.slice(0, 160))} alert=${JSON.stringify(alert.slice(0, 200))}`);
    expect(docs[0]).toEqual({ path: "/?from=mail", status: 307, location: "/login" });
    expect(neverResumed()).toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
    expect(heard.filter((h) => h.path === "/auth/session" || h.path === "/auth/refresh")).toEqual([]);
    expect(cardAt, `the sign-in card was not on screen: ${await said(page)}`).not.toBeNull();
    expect(cardAt!).toBeLessThanOrEqual(1_500);
    expect(blank, "a blank page while the door held every ask").toEqual([]);
    expect(text).toContain(R.pendingBody);
    expect(heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status), "the ladder is not bounded")
      .toEqual(["held", "held", "held", "held"]);
    // Unconfirmed: the marker stays and the next visit asks again; nothing claims the family ended.
    expect((await ctx.cookies(`http://localhost:${webPort}/`)).find((c) => c.name === "tf_owner")?.value).toBe(PENDING);
    expect(await familyLive(j.familyId)).toBe(true);
    // …and the page SAYS it, once the ladder has ended: the session could not be ended on the server,
    // with the two remedies, and Sign out to ask again. Before it ends, only why the page is showing.
    expect(pendingSaidAt, "the card never said why it is showing").not.toBeNull();
    expect(refusalSaidAt, `a sign-out the server never confirmed ended in silence: ${await said(page)}`).not.toBeNull();
    expect(refusalSaidAt!, "the refusal was said before the ladder ended").toBeGreaterThan(asks.at(-1)!.ms);
    expect(alert).toContain(REFUSED_LEAD);
    expect(alert).toContain("Devices list");
    expect(await page.getByRole("button", { name: /^Sign out$/ }).count(), "nothing offers to ask again").toBe(1);
    await ctx.close();
  }, 150_000);

  it("ANOTHER TAB SIGNS IN while the door holds the pending sign-out's ask: that session and its jar are kept", async () => {
    // The first ask is held; a second would be answered, and would end whatever family the jar names by then.
    signOutDoor = "hang";
    doorFaultsLeft = 1;
    const a = await signedIn();
    const ctx = await browser!.newContext();
    await stuckBrowser(ctx, a, { revoked: false, lapsed: false });
    heard = [];
    received = [];
    receivedFrom = Date.now();
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    const until = Date.now() + 20_000;
    while (!heard.some((h) => h.path === "/auth/refresh/logout") && Date.now() < until) await page.waitForTimeout(100);
    expect(heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status), "the ladder's first ask never left")
      .toEqual(["held"]);
    // Another tab of this browser signs in as B; its answer lands in the jar while A's ask is out.
    const b = await signedIn();
    await plant(ctx, b, { owner: b.accountId, access: true });
    // A's ask is given up at the client's deadline. A ladder that still took the jar for its own would
    // mark it pending, wipe it and ask again — with B's cookies.
    await page.waitForTimeout(20_000);
    const asks = heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status);
    const owner = (await ctx.cookies(`http://localhost:${webPort}/`)).find((c) => c.name === "tf_owner")?.value;
    console.log(`e2e timing another-tab door_asks=${JSON.stringify(asks)} received=${JSON.stringify(received)} `
      + `owner_is_b=${owner === b.accountId} b_live=${await familyLive(b.familyId)} jar=${JSON.stringify(await jarNames(ctx))}`);
    expect(asks, "the ladder asked the door again, with the new session's cookies").toEqual(["held"]);
    expect(await familyLive(b.familyId), "the session another tab signed in was ended").toBe(true);
    expect(owner, "the new session's marker was overwritten").toBe(b.accountId);
    expect(await jarNames(ctx), "the new session's cookies were cleared")
      .toEqual(["tf_csrf", "tf_owner", "tf_refresh", "tf_resume", "tf_session"]);
    expect(neverResumed()).toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
    await ctx.close();
  }, 90_000);

  it("A CROSS-SITE ARRIVAL with a pending sign-out: the splash never resumes it, the sign-in page finishes it", async () => {
    // The edge sees the `Lax` resume marker and not the `Strict` pending one, so it serves the
    // splash; the splash reads the marker off the jar and leaves for /login without asking a door.
    signOutDoor = "answer";
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await stuckBrowser(ctx, j, { revoked: false, lapsed: false });
    heard = [];
    received = [];
    const page = await ctx.newPage();
    const docs = documents(page);
    const t0 = Date.now();
    receivedFrom = t0;
    await arriveFromElsewhere(page, `http://localhost:${webPort}/`);
    const samples = await sampleUntil(page, t0, 20_000,
      async (s) => s.path === "/login" && s.loginCard && await finished(ctx, j.familyId));
    const shown = samples.filter((s) => s.path === "/" || s.path === "/login");
    const cardAt = samples.find((s) => s.path === "/login" && s.loginCard)?.ms ?? null;
    const text = await page.evaluate(() => document.querySelector<HTMLElement>(".login-card")?.innerText ?? "").catch(() => "");
    console.log(`e2e timing cross-site-pending card_ms=${cardAt} blank_ms=${JSON.stringify(blankAt(shown))} docs=${JSON.stringify(docs)} `
      + `heard=${JSON.stringify(heard.map((h) => `${h.method} ${h.path} ${h.status}`))} received=${JSON.stringify(received)}`);
    expect(docs[0], "the edge saw the pending marker: the arrival was not cross-site").toEqual({ path: "/", status: 200, location: null });
    expect(neverResumed(), `a browser that asked to sign out was resumed: ${await said(page)}`)
      .toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
    expect(heard.filter((h) => h.path === "/auth/session" || h.path === "/auth/refresh")).toEqual([]);
    expect(blankAt(shown), "a blank page on the way").toEqual([]);
    expect(cardAt, `the sign-in card was not on screen: ${await said(page)}`).not.toBeNull();
    expect(text).toContain(R.pendingBody);
    expect(heard.filter((h) => h.path === "/auth/refresh/logout").map((h) => h.status)).toEqual([204]);
    expect(await familyLive(j.familyId)).toBe(false);
    expect(await jarNames(ctx)).toEqual([]);
    await ctx.close();
  }, 60_000);

  it("A SLOW REFRESH DOOR — the splash shows its card the whole time, then /login says why", async () => {
    signOutDoor = "answer";
    refreshDoor = "slow";
    const j = await signedIn();
    // The family ended elsewhere: a sign-out from another browser, or a late renewal that planted
    // an ended family in this jar. The marker names the account, so this is a resume, not a sign-out.
    await world.db.update(sessions).set({ revokedAt: world.now }).where(eq(sessions.familyId, j.familyId));
    await world.db.update(refreshTokens).set({ revokedAt: world.now }).where(eq(refreshTokens.familyId, j.familyId));
    const ctx = await browser!.newContext();
    await plant(ctx, j, { owner: j.accountId, access: false });
    heard = [];
    received = [];
    const page = await ctx.newPage();
    const seen = watch(page);
    const errors = errorsOf(page);
    const t0 = Date.now();
    receivedFrom = t0;
    // The reported path: a link from another site, so the edge sees no `tf_owner` and the splash
    // compares nothing; its refusal then names why on /login. (A same-site visit reloads to `/`
    // once the refusal has cleared the jar.)
    await arriveFromElsewhere(page, `http://localhost:${webPort}/`);
    // Until the sentence: /login says why from its mount effect, a moment after its card paints.
    const samples = await sampleUntil(page, t0, SLOW_REFRESH_MS + 15_000,
      (s) => s.path === "/login" && s.loginCard && s.text.includes(R.revokedBody!));
    const splash = samples.filter((s) => s.path === "/" && s.ready !== "loading");
    const markAt = splash.find((s) => s.gateMark)?.ms ?? null;
    const lineAt = splash.find((s) => R.workingBody !== undefined && s.text.includes(R.workingBody))?.ms ?? null;
    const loginAt = samples.find((s) => s.path === "/login" && s.loginCard)?.ms ?? null;
    const text = await page.evaluate(() => document.querySelector<HTMLElement>(".login-card")?.innerText ?? "").catch(() => "");
    console.log(`e2e timing slow-refresh mark_ms=${markAt} working_line_ms=${lineAt} login_ms=${loginAt} `
      + `splash_samples=${splash.length} unmarked_ms=${JSON.stringify(splash.filter((s) => !s.gateMark).map((s) => s.ms))} `
      + `refresh=${JSON.stringify(heard.filter((h) => h.path === "/auth/refresh").map((h) => `${h.status} ${h.code ?? ""}`.trim()))} `
      + `received=${JSON.stringify(received)} loads=${seen.loads()} errors=${JSON.stringify(errors)}`);
    expect(seen.loads(), "the splash reloaded").toBeLessThanOrEqual(2);
    expect(splash.length, "the splash was never read").toBeGreaterThan(50);
    expect(splash.filter((s) => !s.gateMark || s.text.trim() === "").map((s) => s.ms), "the splash painted nothing while it waited")
      .toEqual([]);
    expect(lineAt, "the splash never said what it is waiting for").not.toBeNull();
    expect(loginAt, `the splash never handed over to the sign-in page: ${await said(page)}`).not.toBeNull();
    expect(loginAt!).toBeGreaterThanOrEqual(SLOW_REFRESH_MS - 1_000);
    expect(text).toContain(R.revokedBody);
    expect(heard.filter((h) => h.path === "/auth/refresh").map((h) => `${h.status} ${h.code}`)).toEqual(["401 refresh_revoked"]);
    // Nothing that names or resumes the session is left. The splash's refusal leaves the reason's word
    // for a tab opened next (`shareSignedOutNote`): `tf_signed_out`, which lapses within 15 s.
    const left = await ctx.cookies([`http://localhost:${webPort}/`, `http://localhost:${webPort}/auth/refresh`]);
    expect(left.filter((c) => ["tf_session", "tf_refresh", "tf_csrf", "tf_resume", "tf_owner"].includes(c.name) && c.value !== "")
      .map((c) => c.name)).toEqual([]);
    for (const c of left.filter((c) => c.name === "tf_signed_out")) {
      expect(c.value).toBe("revoked");
      expect(c.expires, "the reason outlives its 15 s").toBeGreaterThan(0);
      expect(c.expires - Date.now() / 1000, "the reason outlives its 15 s").toBeLessThanOrEqual(15);
    }
    await ctx.close();
  }, 120_000);

  it("AN INVITE LINK FROM ANOTHER SITE to /join over a pending sign-out: never resumed, the account never read, finished there", async () => {
    // The edge serves /join without reading cookies, and the wizard used to ask the session first:
    // a lapsed access cookie was renewed from the jar's refresh cookie and the account read with it.
    signOutDoor = "answer";
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await stuckBrowser(ctx, j, { revoked: false, lapsed: true });
    heard = [];
    received = [];
    const page = await ctx.newPage();
    const docs = documents(page);
    const errors = errorsOf(page);
    const t0 = Date.now();
    receivedFrom = t0;
    await arriveFromElsewhere(page, `http://localhost:${webPort}/join?code=INVITE-OK`);
    const samples = await sampleUntil(page, t0, 30_000,
      async (s) => s.path === "/join" && s.loginCard && await finished(ctx, j.familyId));
    const cardAt = samples.find((s) => s.path === "/join" && s.loginCard)?.ms ?? null;
    const last = samples.at(-1);
    const done = last !== undefined && last.path === "/join" && await finished(ctx, j.familyId) ? last.ms : null;
    console.log(`e2e timing join-cross-site card_ms=${cardAt} finished_ms=${done} blank_ms=${JSON.stringify(blankAt(samples))} `
      + `docs=${JSON.stringify(docs)} heard=${JSON.stringify(heard.map((h) => `${h.method} ${h.path} ${h.status}`))} `
      + `errors=${JSON.stringify(errors)}`);
    expect(docs[0], "the arrival was not the sign-up page").toEqual({ path: "/join?code=INVITE-OK", status: 200, location: null });
    expect(neverResumed(), `a browser that asked to sign out was resumed: ${await said(page)}`)
      .toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
    expect(accountAsked(), `the previous person's account was read on the sign-up page: ${await said(page)}`).toEqual([]);
    expect(doorAnswers(), "the unfinished sign-out was not finished at the door").toEqual([204]);
    expect(done, `the sign-out was not finished on the sign-up page: ${await said(page)}`).not.toBeNull();
    expect(await familyLive(j.familyId)).toBe(false);
    expect(await jarNames(ctx)).toEqual([]);
    expect(await page.locator("#join-email").count(), "the sign-up form is not on the page").toBe(1);
    expect(blankAt(samples)).toEqual([]);
    await ctx.close();
  }, 90_000);

  it("THE SIGN-IN PAGE'S /join LINK while the door holds the first ask, access live: never resumed, nothing read, /join finishes it", async () => {
    // Measured before: the wizard read the live session and generated the previous person's recovery
    // codes on screen, and leaving /login stopped its ladder with the family still live.
    signOutDoor = "hang";
    doorFaultsLeft = 1;
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await stuckBrowser(ctx, j, { revoked: false, lapsed: false });
    heard = [];
    received = [];
    const page = await ctx.newPage();
    const errors = errorsOf(page);
    const t0 = Date.now();
    receivedFrom = t0;
    await page.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
    await page.locator(".login-card").waitFor({ state: "visible", timeout: 10_000 });
    const until = Date.now() + 10_000;
    while (doorAnswers().length === 0 && Date.now() < until) await page.waitForTimeout(100);
    expect(doorAnswers(), "the sign-in page's first ask never left").toEqual(["held"]);
    const clickedAt = Date.now() - t0;
    await page.click('a[href="/join"]');
    const samples = await sampleUntil(page, t0, 60_000,
      async (s) => s.path === "/join" && s.loginCard && await finished(ctx, j.familyId));
    const last = samples.at(-1);
    const done = last !== undefined && last.path === "/join" && await finished(ctx, j.familyId) ? last.ms : null;
    const text = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "").catch(() => "");
    console.log(`e2e timing join-from-login clicked_ms=${clickedAt} finished_ms=${done} door=${JSON.stringify(doorAnswers())} `
      + `received=${JSON.stringify(received)} heard=${JSON.stringify(heard.map((h) => `${h.method} ${h.path} ${h.status}`))} `
      + `errors=${JSON.stringify(errors)}`);
    expect(neverResumed(), `a browser that asked to sign out was resumed: ${await said(page)}`)
      .toEqual({ minted: 0, refreshedBeforeTheDoor: 0 });
    expect(accountAsked(), `the previous person's account was read on the sign-up page: ${await said(page)}`).toEqual([]);
    expect(text, "the previous person's recovery codes are on screen").not.toContain(messages.join.step_codes_title);
    expect(doorAnswers(), "/join did not finish the sign-out the sign-in page left").toEqual(["held", 204]);
    expect(done, `the sign-out was not finished: ${await said(page)}`).not.toBeNull();
    expect(await familyLive(j.familyId)).toBe(false);
    expect(await jarNames(ctx)).toEqual([]);
    expect(new URL(page.url()).pathname).toBe("/join");
    await ctx.close();
  }, 120_000);

  it("THE CONTROL — no pending sign-out: /join reads the live session as before, and the app opens over it", async () => {
    signOutDoor = "answer";
    const j = await signedIn();
    const ctx = await browser!.newContext();
    await plant(ctx, j, { owner: j.accountId, access: true });
    heard = [];
    const page = await ctx.newPage();
    await page.goto(`http://localhost:${webPort}/join`, { waitUntil: "commit" });
    const until = Date.now() + 20_000;
    while (!heard.some((h) => h.path === "/auth/session") && Date.now() < until) await page.waitForTimeout(100);
    await page.waitForTimeout(2_000);
    console.log(`e2e control join heard=${JSON.stringify(heard.map((h) => `${h.method} ${h.path} ${h.status}`))}`);
    expect(heard.filter((h) => h.path === "/auth/session").map((h) => h.status)[0], `the wizard did not read its session: ${await said(page)}`)
      .toBe(200);
    expect(doorAnswers()).toEqual([]);
    const app = await ctx.newPage();
    await app.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
    await app.getByRole("button", { name: /^Sign out$/ }).waitFor({ state: "visible", timeout: 60_000 });
    expect(doorAnswers()).toEqual([]);
    expect(await familyLive(j.familyId)).toBe(true);
    await ctx.close();
  }, 120_000);

  it("the sign-in card is centred in a 2000 px window and inside a 390 px phone, at 100% and 125% text", async () => {
    for (const [width, height] of [[2000, 1100], [390, 844]] as const) {
      for (const size of ["100", "125"]) {
        const ctx = await browser!.newContext({ viewport: { width, height } });
        await ctx.addInitScript((s) => {
          try { localStorage.setItem("ohmail.face", "paper"); localStorage.setItem("ohmail.textSize", s); } catch { /* none */ }
        }, size);
        const page = await ctx.newPage();
        await page.goto(`http://localhost:${webPort}/login`, { waitUntil: "load" });
        await page.waitForTimeout(600);
        const box = (await page.locator(".login-card").boundingBox())!;
        const off = box.x + box.width / 2 - width / 2;
        console.log(`e2e geometry /login ${width}x${height} text=${size}% card=${JSON.stringify(box)} centre_offset=${off.toFixed(1)}`);
        expect(Math.abs(off), `${width} px at ${size}%: the card is off centre`).toBeLessThanOrEqual(8);
        expect(box.x, `${width} px at ${size}%`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${width} px at ${size}%`).toBeLessThanOrEqual(width);
        await ctx.close();
      }
    }
  }, 60_000);

  /*
   * REAL TABS: a tab that missed the sign-out post, in the browser's own lifecycle. Playwright's launch
   * cannot show it: its focus emulation keeps every page visible, its flags turn bfcache off, and CDP's
   * freeze does nothing to a visible page. So a headful Chromium of this run's own, on this run's display
   * (a private Xvfb, never a desktop):
   *
   *     TF_SIGNOUT_E2E=1 XDG_RUNTIME_DIR=<own dir> DBUS_SESSION_BUS_ADDRESS=unix:path=/nonexistent \
   *       xvfb-run -a npx vitest run apps/webapp/test/sign-out-revisit.e2e.test.ts -t "real tabs"
   *
   * B holds the mailbox; A signs out. Each case reads every frame B drew once it was looked at again, and
   * whether it asked the session door.
   */
  describe.skipIf(!process.env.DISPLAY)("real tabs: a tab that missed the post", () => {
    let rig: RealTabs | null = null;
    afterEach(async () => {
      await rig?.close();
      rig = null;
    });

    /** Whether `page` shows the mailbox now; null between two documents. */
    const shellOn = (page: Page): Promise<boolean | null> =>
      page.evaluate(() => document.querySelector(".app-root, .row[data-id]") !== null).catch(() => null);

    /**
     * B on the mailbox, drawn, in the browser's first tab; its session reads from now on. The account has
     * left its first run, so nothing sends B on to `/join`. `deaf`: B gets no storage event either.
     */
    async function mailboxTab(r: RealTabs, j: { access: string; refresh: string; accountId: string }, o: { deaf?: boolean } = {}):
      Promise<{ b: Page; asked: number[] }> {
      await world.db.insert(accountSettings).values({ accountId: j.accountId, onboardingCompletedAt: world.now });
      await plant(r.ctx, j, { owner: j.accountId, access: true });
      const b = r.tab(r.ctx.pages()[0] ?? await r.ctx.newPage(), "B");
      if (o.deaf) await b.addInitScript(() => { window.addEventListener("storage", (e) => e.stopImmediatePropagation(), true); });
      const asked: number[] = [];
      b.on("request", (q) => { if (new URL(q.url()).pathname.endsWith("/auth/session")) asked.push(Date.now()); });
      await b.goto(`http://localhost:${webPort}/`, { waitUntil: "commit" });
      await b.locator(".app-root").waitFor({ state: "attached", timeout: 60_000 });
      await b.waitForTimeout(3_000);
      expect(`${new URL(b.url()).pathname} ${await shellOn(b)}`, "B did not stay on its mailbox").toBe("/ true");
      return { b, asked };
    }

    /** A opens its account pane, Sign out on screen. */
    async function accountPane(a: Page): Promise<void> {
      await a.goto(`http://localhost:${webPort}/#/settings/account`, { waitUntil: "commit" });
      await a.getByRole("button", { name: /^Sign out$/ }).waitFor({ state: "visible", timeout: 60_000 });
      await a.waitForTimeout(1_000);
    }

    /** A presses Sign out; resolves once the door answered (or holds) the request. */
    async function pressSignOut(a: Page, door: "answer" | "hang"): Promise<number> {
      signOutDoor = door;
      doorFaultsLeft = 1;
      heard = [];
      const pressedAt = Date.now();
      await a.getByRole("button", { name: /^Sign out$/ }).click();
      const want = door === "answer" ? 204 : "held";
      const until = Date.now() + 15_000;
      while (!doorAnswers().includes(want) && Date.now() < until) await a.waitForTimeout(50);
      expect(doorAnswers(), "the press never reached the door").toContain(want);
      return pressedAt;
    }

    async function signOutOn(a: Page, door: "answer" | "hang"): Promise<number> {
      await accountPane(a);
      return pressSignOut(a, door);
    }

    /** B in the background, frozen, while A signs out (or only opens the app, `door` null); resumed hidden, then shown. */
    async function frozenThrough(r: RealTabs, b: Page, door: "answer" | "hang" | null): Promise<{ pressedAt: number; shownAt: number }> {
      const a = r.tab(await r.ctx.newPage(), "A");
      await a.waitForTimeout(500);
      expect(await b.evaluate(() => document.visibilityState), "B is not in the background").toBe("hidden");
      const lifecycle = await r.ctx.newCDPSession(b);
      await lifecycle.send("Page.setWebLifecycleState", { state: "frozen" });
      let pressedAt = Date.now();
      if (door !== null) pressedAt = await signOutOn(a, door);
      else await accountPane(a);
      await a.waitForTimeout(1_500);
      await lifecycle.send("Page.setWebLifecycleState", { state: "active" });
      await a.waitForTimeout(500);
      const shownAt = Date.now();
      await b.bringToFront();
      await b.waitForTimeout(3_000);
      return { pressedAt, shownAt };
    }

    it("E1 · a frozen tab, the sign-out answered: no frame of mail once it is shown, nothing asked", async () => {
      const r = rig = await realTabs();
      const { b, asked } = await mailboxTab(r, await signedIn());
      const { pressedAt, shownAt } = await frozenThrough(r, b, "answer");
      const frames = framesOf(r.log, "B", shownAt);
      console.log(`e2e real-tabs E1 frozen-204 B: ${storyOf(r.log, "B", pressedAt)} · asked=${asked.filter((t) => t >= pressedAt).length} last=${new URL(b.url()).pathname}`);
      expect(frames.length, "B drew no frame once shown, so this proves nothing").toBeGreaterThan(0);
      expect(frames, "B drew the mailbox once it was shown").not.toContain(true);
      expect(asked.filter((t) => t >= pressedAt), "B asked the session door").toEqual([]);
      expect(new URL(b.url()).pathname).toBe("/");
    }, 180_000);

    it("E2 · a frozen tab, the sign-out request held: no frame of mail once shown, and the sign-in page", async () => {
      const r = rig = await realTabs();
      const { b, asked } = await mailboxTab(r, await signedIn());
      const { pressedAt, shownAt } = await frozenThrough(r, b, "hang");
      const frames = framesOf(r.log, "B", shownAt);
      console.log(`e2e real-tabs E2 frozen-held B: ${storyOf(r.log, "B", pressedAt)} · asked=${asked.filter((t) => t >= pressedAt).length} last=${new URL(b.url()).pathname}`);
      expect(frames.length, "B drew no frame once shown, so this proves nothing").toBeGreaterThan(0);
      expect(frames, "B drew the mailbox once it was shown").not.toContain(true);
      expect(asked.filter((t) => t >= pressedAt), "B asked the session door").toEqual([]);
      expect(new URL(b.url()).pathname).toBe("/login");
    }, 180_000);

    it("E3 · CONTROL: a frozen tab nobody signed out draws its mailbox in every frame once shown", async () => {
      const r = rig = await realTabs();
      const { b } = await mailboxTab(r, await signedIn());
      const { pressedAt, shownAt } = await frozenThrough(r, b, null);
      const frames = framesOf(r.log, "B", shownAt);
      console.log(`e2e real-tabs E3 frozen-control B: ${storyOf(r.log, "B", pressedAt)} · last=${new URL(b.url()).pathname}`);
      expect(frames.length, "B drew no frame once shown, so this proves nothing").toBeGreaterThan(0);
      expect(frames, "a signed-in tab dropped its mailbox when shown").not.toContain(false);
      expect(new URL(b.url()).pathname).toBe("/");
    }, 180_000);

    it("E4 · back to the mailbox after a sign-out: the browser does not restore it, no frame of mail", async () => {
      const r = rig = await realTabs();
      const { b, asked } = await mailboxTab(r, await signedIn());
      await b.goto(`http://localhost:${webPort}/no-such-page`, { waitUntil: "commit" });
      await b.waitForTimeout(1_000);
      const a = r.tab(await r.ctx.newPage(), "A");
      const pressedAt = await signOutOn(a, "answer");
      await a.waitForTimeout(1_000);
      await b.bringToFront();
      await b.waitForTimeout(500);
      const backAt = Date.now();
      await b.goBack({ waitUntil: "commit" });
      await b.waitForTimeout(3_000);
      const frames = framesOf(r.log, "B", backAt);
      const boot = r.log.find((e) => e.tab === "B" && e.type === "boot" && e.at >= backAt);
      console.log(`e2e real-tabs E4 back B: ${storyOf(r.log, "B", backAt)} · asked=${asked.filter((t) => t >= pressedAt).length} last=${new URL(b.url()).pathname}`);
      expect(boot?.nav, "the back restored the mailbox from the browser's cache").toBe("back_forward");
      expect(frames.length, "B drew no frame after the back, so this proves nothing").toBeGreaterThan(0);
      expect(frames, "the back drew the mailbox").not.toContain(true);
      expect(asked.filter((t) => t >= pressedAt), "B asked the session door").toEqual([]);
    }, 180_000);

    it("E5 · a discarded tab, reloaded unseen after the sign-out: no frame of mail once shown", async () => {
      const r = rig = await realTabs();
      const { b, asked } = await mailboxTab(r, await signedIn());
      const a = r.tab(await r.ctx.newPage(), "A");
      await a.waitForTimeout(500);
      const lifecycle = await r.ctx.newCDPSession(b);
      await lifecycle.send("Page.setWebLifecycleState", { state: "frozen" });
      const pressedAt = await signOutOn(a, "answer");
      await a.waitForTimeout(1_000);
      // A discarded tab loads its address again; here the reload runs while it is still in the background.
      await lifecycle.send("Page.setWebLifecycleState", { state: "active" });
      const reloadAt = Date.now();
      await b.reload({ waitUntil: "commit" });
      await a.waitForTimeout(2_000);
      await b.bringToFront();
      await b.waitForTimeout(3_000);
      const frames = framesOf(r.log, "B", reloadAt);
      console.log(`e2e real-tabs E5 discard B: ${storyOf(r.log, "B", pressedAt)} · asked=${asked.filter((t) => t >= pressedAt).length} last=${new URL(b.url()).pathname}`);
      expect(frames.length, "B drew no frame once shown, so this proves nothing").toBeGreaterThan(0);
      expect(frames, "the reloaded tab drew the mailbox").not.toContain(true);
      expect(asked.filter((t) => t >= pressedAt), "B asked the session door").toEqual([]);
    }, 180_000);

    it("E6 · no channel and no storage event, a background tab: shown, it draws no mail and asks nothing", async () => {
      const r = rig = await realTabs({ channel: false });
      const { b, asked } = await mailboxTab(r, await signedIn(), { deaf: true });
      const a = r.tab(await r.ctx.newPage(), "A");
      const pressedAt = await signOutOn(a, "answer");
      await a.waitForTimeout(1_500);
      expect(await shellOn(b), "sanity: B heard the post, so the return is not what is measured").toBe(true);
      const shownAt = Date.now();
      await b.bringToFront();
      await b.waitForTimeout(3_000);
      const frames = framesOf(r.log, "B", shownAt);
      console.log(`e2e real-tabs E6 no-channel-background B: ${storyOf(r.log, "B", pressedAt)} · asked=${asked.filter((t) => t >= pressedAt).length} last=${new URL(b.url()).pathname}`);
      expect(frames.length, "B drew no frame once shown, so this proves nothing").toBeGreaterThan(0);
      expect(frames, "B drew the mailbox once it was shown").not.toContain(true);
      expect(asked.filter((t) => t >= pressedAt), "B asked the session door").toEqual([]);
    }, 180_000);

    /** `b`'s shell read every 100 ms until it is gone or `ms` passes: the ms it went after `from`, or null. */
    async function shellGoneWithin(b: Page, from: number, ms: number): Promise<number | null> {
      while (Date.now() - from < ms) {
        if (await shellOn(b) === false) return Date.now() - from;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return null;
    }

    /** The events that wake a tab's return check, heard by `tab` from `from` until its document went (or the next began). */
    const returnsBeforeLeaving = (log: TabEvent[], tab: string, from: number): string[] => {
      const mine = log.filter((e) => e.tab === tab && e.at >= from);
      const end = mine.findIndex((e) => e.type === "pagehide" || e.type === "boot");
      return mine.slice(0, end < 0 ? mine.length : end)
        .filter((e) => ["visibilitychange", "focus", "pageshow", "resume"].includes(e.type)).map((e) => e.type);
    };

    it("E7 · no channel and no storage event, a tab visible the whole time beside the one that signs out: it leaves, asking nothing", async () => {
      const r = rig = await realTabs({ channel: false });
      const { b, asked } = await mailboxTab(r, await signedIn(), { deaf: true });
      const a = r.tab(await r.newWindow(), "A");
      await accountPane(a);
      expect(`${await b.evaluate(() => document.visibilityState)} ${await shellOn(b)}`, "B is not on screen with its mailbox beside A")
        .toBe("visible true");
      const pressedAt = await pressSignOut(a, "answer");
      const goneMs = await shellGoneWithin(b, pressedAt, 5_000);
      await b.waitForTimeout(1_500);
      console.log(`e2e real-tabs E7 no-channel-visible B: ${storyOf(r.log, "B", pressedAt)} · gone_ms=${goneMs} asked=${asked.filter((t) => t >= pressedAt).length} last=${new URL(b.url()).pathname}`);
      expect(returnsBeforeLeaving(r.log, "B", pressedAt), "something woke B's return check, so the watch is not what is measured").toEqual([]);
      expect(goneMs, "B kept the mailbox on screen 5 s after another tab signed out").not.toBeNull();
      expect(framesOf(r.log, "B", pressedAt + goneMs! + 1_000), "B drew the mailbox again").not.toContain(true);
      expect(asked.filter((t) => t >= pressedAt), "B asked the session door").toEqual([]);
    }, 180_000);

    it("E8 · CONTROL: nobody signs out: the tab visible beside the other keeps its mailbox and asks nothing", async () => {
      const r = rig = await realTabs({ channel: false });
      const { b, asked } = await mailboxTab(r, await signedIn(), { deaf: true });
      const a = r.tab(await r.newWindow(), "A");
      await accountPane(a);
      expect(await b.evaluate(() => document.visibilityState), "B is not visible beside A's window").toBe("visible");
      const from = Date.now();
      await a.waitForTimeout(5_000);
      const shown = await shellOn(b);
      console.log(`e2e real-tabs E8 control-visible B: ${storyOf(r.log, "B", from)} · asked=${asked.filter((t) => t >= from).length} last=${new URL(b.url()).pathname}`);
      expect(shown, "a signed-in tab dropped its mailbox").toBe(true);
      expect(framesOf(r.log, "B", from), "a signed-in tab drew a frame without its mailbox").not.toContain(false);
      expect(r.log.filter((e) => e.tab === "B" && e.at >= from && e.type === "pagehide"), "a signed-in tab left").toEqual([]);
      expect(asked.filter((t) => t >= from), "B asked the session door").toEqual([]);
    }, 180_000);
  });
});

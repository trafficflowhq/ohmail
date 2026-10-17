import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { createHmac } from "node:crypto";
import { dirname, join } from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { createApp, apiRoutes, makeProbeHostGuard, type ApiDeps } from "@trafficflow/api";
import type { AccessLifecycle, AccessVerdict, EntitlementsPort, PlanHint } from "@trafficflow/db";
import { makeDeps } from "../../../packages/api/test/helpers.js";
import de from "../messages/de.json";

type SpyMailer = Awaited<ReturnType<typeof makeDeps>>["mailer"];

/**
 * THE SIGNUP, AS A STRANGER WALKS IT — a production build of the web app in front of the real API routes
 * (`createApp(apiRoutes)` over PGlite), driven in Chromium: the open-signup form, the mailed link, the
 * password check, an authenticator, the recovery codes, then the mailbox step with Cloud's own host
 * guard over a test resolver and the IMAP dial stubbed. The server's clock is the test's, so the
 * five-minute step-up window closes on purpose while the person is "off making an app password".
 *
 * Opt-in like `sign-out-revisit.e2e.test.ts`: `next build` takes about a minute and two ports are bound.
 *
 *     TF_SIGNUP_E2E=1 npx vitest run apps/webapp/test/signup-journey.e2e.test.ts
 */
const ENABLED = process.env.TF_SIGNUP_E2E === "1";
const WEBAPP = fileURLToPath(new URL("..", import.meta.url));
function nextCli(): string {
  try {
    return join(dirname(createRequire(`${WEBAPP}package.json`).resolve("next/package.json")), "dist/bin/next");
  } catch {
    return `${WEBAPP}node_modules/next/dist/bin/next`;
  }
}
const NEXT_CLI = nextCli();

/** The hosts the mailbox step is tried with: one on the person's own network, one on the internet. */
const OWN_NETWORK_HOST = "mail.home.lan";
const PUBLIC_IMAP = "mail.family.example";
const PUBLIC_SMTP = "smtp.family.example";
const RESOLVES: Record<string, string[]> = {
  [OWN_NETWORK_HOST]: ["192.168.1.20"],
  [PUBLIC_IMAP]: ["93.184.216.34"],
  [PUBLIC_SMTP]: ["93.184.216.34"],
};

/** Every request the API saw: method, path, status, a refusal's code, and a mailbox create's body. */
let heard: Array<{ method: string; path: string; status: number; code?: string; body?: unknown }> = [];

let world: { deps: ApiDeps; mailer: SpyMailer; clock: { now: () => Date; advance: (ms: number) => void } };
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

/** The real route table behind a socket, with the one header the hosted edge writes (the client's address). */
async function serve(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${apiPort}`);
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.startsWith("x-vercel-")) continue;
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v !== undefined) headers.set(k, v);
  }
  headers.set("x-vercel-forwarded-for", "203.0.113.7");
  const body = method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks);
  const answer = await app.handle(new Request(url, { method, headers, body }), { ...world.deps, session: null, idempotency: null });
  const code = answer.status >= 400
    ? await answer.clone().json().then((b: { error?: { code?: string } }) => b?.error?.code, () => undefined)
    : undefined;
  const sent = url.pathname === "/mailboxes" && method === "POST" && body ? JSON.parse(body.toString("utf8")) : undefined;
  heard.push({ method, path: url.pathname, status: answer.status, ...(code ? { code } : {}), ...(sent ? { body: sent } : {}) });
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

/** RFC 6238 (SHA-1, 30 s, 6 digits) at the SERVER's clock, which is the test's and does not tick on its own. */
function totpAt(secret: string, at: Date): string {
  const A = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secret.replace(/=+$/, "").replace(/\s+/g, "").toUpperCase()) bits += A.indexOf(ch).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at.getTime() / 30_000)));
  const h = createHmac("sha1", key).update(counter).digest();
  const off = h[h.length - 1]! & 0xf;
  return ((h.readUInt32BE(off) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

/** What the page said and what the API heard, for a failing step's message. */
async function said(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 400) ?? "").catch(() => "?");
  return `${new URL(page.url()).pathname} · ${JSON.stringify(text)} · ${JSON.stringify(heard.slice(-8).map((h) => `${h.method} ${h.path} ${h.status}${h.code ? ` ${h.code}` : ""}`))}`;
}

const h1 = async (page: Page): Promise<string> => (await page.locator("h1").first().textContent())?.trim() ?? "";

/** The person's run: one browser, one account, carried through every case below in order. */
const person = { email: "mila@family.example", password: "a-long-signup-password", totpSecret: "" };
let ctx: BrowserContext | null = null;
let page: Page;

/** A fresh world on the same API server: the server reads `world` per request. */
async function newWorld(entitlementsPort?: EntitlementsPort): Promise<void> {
  const made = await makeDeps(new Date(), { origin: [`http://localhost:${webPort}`], publicSignup: true });
  // CLOUD'S HOST GUARD, over a resolver this test answers for: the mailbox step meets the same refusal a
  // mail server on someone's own network meets on ohmail.app. The dial itself is stubbed by `makeDeps`.
  made.deps.services!.probeHostGuard = makeProbeHostGuard({
    async resolve(hostname: string) { return RESOLVES[hostname] ?? []; },
  });
  if (entitlementsPort) made.deps.services!.entitlementsPort = entitlementsPort;
  world = { deps: made.deps, mailer: made.mailer, clock: made.clock };
}

/** The account, the mailed link, an authenticator and the codes: everything before the plan step. */
async function signUp(
  p: Page, who: { email: string; password: string; totpSecret: string }, start = "/join",
): Promise<void> {
  await p.goto(`http://localhost:${webPort}${start}`);
  await p.locator("#join-email").waitFor({ timeout: 30_000 });
  await p.fill("#join-email", who.email);
  await p.fill("#join-name", "Mila Reyes");
  await p.fill("#join-pw", who.password);
  await p.getByRole("button", { name: "Create account" }).click();
  await p.getByRole("heading", { name: "Check your email" }).waitFor({ timeout: 30_000 });

  const mail = world.mailer.sent.find((m) => m.to === who.email && m.template === "email_verification");
  expect(mail, `no verification mail: ${await said(p)}`).toBeTruthy();
  const token = new URL((mail!.data as { verifyUrl: string }).verifyUrl).searchParams.get("token");
  await p.goto(`http://localhost:${webPort}/verify-email?token=${encodeURIComponent(token!)}`);
  await p.fill("#verify-pw", who.password);
  await p.getByRole("button", { name: "Confirm my email" }).click();
  await p.getByRole("heading", { name: "Add your second factor" }).waitFor({ timeout: 30_000 });

  await p.getByRole("button", { name: "Use an authenticator app instead" }).click();
  who.totpSecret = ((await p.locator(".join-secret code").textContent()) ?? "").trim();
  await p.fill("#join-totp", totpAt(who.totpSecret, world.clock.now()));
  await p.getByRole("button", { name: "Activate" }).click();
  await p.locator(".join-codes li").first().waitFor({ timeout: 30_000 });
  await p.locator(".join-check input[type=checkbox]").check();
  await p.getByRole("button", { name: "Continue" }).click();
}

/**
 * THE PLANE, AS A NEVER-STARTED ACCOUNT MEETS IT: refused for payment, closed with no reason, no closing
 * date, no erasure clock and nothing ever paid — the state an account is in between signing up and
 * starting the trial. The mint answers a page address and records what it was asked.
 */
function neverStartedPlane(): { port: EntitlementsPort; mints: Array<{ lang?: string; hint?: PlanHint }> } {
  const mints: Array<{ lang?: string; hint?: PlanHint }> = [];
  const lifecycle: AccessLifecycle = {
    state: "closed", closedReason: null, trialEndsAt: null, graceUntil: null, closedAt: null,
    erasureAt: null, erasedAt: null, formerlyPaid: false,
  };
  // `manageUrl` as the program's refusal carries it: the fact that it serves an account page.
  const verdict: AccessVerdict = { ok: false, reason: "payment_required", manageUrl: "https://plane.example/manage", lifecycle };
  const access = async (): Promise<AccessVerdict> => verdict;
  return {
    mints,
    port: {
      access,
      accessOrFault: access,
      spend: async (_a, _b, key) => ({ verdict: "ok", charged: true, attempt: key }),
      release: async () => "settled" as const,
      manageLink: async (_accountId, lang, hint) => {
        mints.push({ ...(lang ? { lang } : {}), ...(hint ? { hint } : {}) });
        return { url: "https://plane.example/manage?token=t" };
      },
      releaseAccount: async () => "none",
    },
  };
}

describe.skipIf(!ENABLED)("the signup, from /join to a connected mailbox — a production build over the real routes", () => {
  beforeAll(async () => {
    expect(existsSync(NEXT_CLI), `next's CLI missing at ${NEXT_CLI}`).toBe(true);
    apiPort = await freePort();
    webPort = await freePort();
    // Open signup, and the browser's Origin admitted by the cross-site guard; no entitlements program.
    await newWorld();
    api = createServer((req, res) => { void serve(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
    api.listen(apiPort, "127.0.0.1");
    await once(api, "listening");
    const origin = `http://127.0.0.1:${apiPort}`;
    delete process.env.NEXT_PUBLIC_DEMO;
    delete process.env.NEXT_PUBLIC_API_BASE;
    await run(process.execPath, [NEXT_CLI, "build"], { TF_API_ORIGIN: origin, TF_PUBLIC_SIGNUP: "1" });
    web = spawn(process.execPath, [NEXT_CLI, "start", "-p", String(webPort), "-H", "localhost"], {
      cwd: WEBAPP, env: { ...process.env, TF_API_ORIGIN: origin, TF_PUBLIC_SIGNUP: "1" }, stdio: "pipe",
    });
    web.stdout?.on("data", (d) => { webLog += String(d); });
    web.stderr?.on("data", (d) => { webLog += String(d); });
    await waitFor(`http://localhost:${webPort}/login`);
    browser = await chromium.launch();
    ctx = await browser.newContext();
    page = await ctx.newPage();
  }, 300_000);

  afterAll(async () => {
    await ctx?.close();
    await browser?.close();
    web?.kill("SIGTERM");
    await new Promise<void>((r) => (api ? api.close(() => r()) : r()));
  });

  it("the account, the mailed link, an authenticator and the codes bring a stranger to the mailbox step", async () => {
    await signUp(page, person);
    // This host operates no entitlements program, so the plan step answers "entitled" and moves on.
    await page.getByRole("heading", { name: "Connect a mailbox" }).waitFor({ timeout: 30_000 });
  }, 120_000);

  it("a mail server on the person's own network is refused ON the mailbox step, with everything typed kept", async () => {
    await page.getByRole("radio", { name: /Any other IMAP mailbox/ }).click();
    await page.fill("#join-mb-address", person.email);
    await page.fill("#join-imap", OWN_NETWORK_HOST);
    await page.fill("#join-smtp", PUBLIC_SMTP);
    await page.fill("#join-mb-pass", "app-password-fixture");
    await page.getByRole("button", { name: "Connect mailbox" }).click();
    await page.locator(".join-error").first().waitFor({ timeout: 30_000 });
    expect(await h1(page), `the refusal left the mailbox step: ${await said(page)}`).toBe("Connect a mailbox");
    // The host guard's own sentence for a name that resolves to a private address.
    expect(await page.locator(".join-error").first().textContent()).toMatch(/points inside a private network/);
    expect(await page.inputValue("#join-imap")).toBe(OWN_NETWORK_HOST);
    expect(await page.inputValue("#join-mb-pass")).toBe("app-password-fixture");
  }, 60_000);

  it("after six minutes making an app password, the second factor is asked in place and the same connect goes through", async () => {
    // Where the last case left the person; if it did not, start from the wizard's own resume.
    if (await page.locator("#join-imap").count() === 0) {
      await page.goto(`http://localhost:${webPort}/join`);
      await page.getByRole("radio", { name: /Any other IMAP mailbox/ }).click();
      await page.fill("#join-mb-address", person.email);
      await page.fill("#join-mb-pass", "app-password-fixture");
    }
    await page.fill("#join-imap", PUBLIC_IMAP);
    await page.fill("#join-smtp", PUBLIC_SMTP);
    world.clock.advance(6 * 60_000);
    heard = [];
    await page.getByRole("button", { name: "Connect mailbox" }).click();
    await page.locator("[data-testid=step-up-prompt]").waitFor({ timeout: 30_000 }).catch(() => {});
    expect(await page.locator("[data-testid=step-up-prompt]").count(), `no step-up prompt: ${await said(page)}`).toBe(1);
    expect(await h1(page)).toBe("Connect a mailbox");

    await page.fill("#stepup-code", totpAt(person.totpSecret, world.clock.now()));
    await page.locator("[data-testid=step-up-prompt]").getByRole("button", { name: "Verify code" }).click();
    await page.getByRole("heading", { name: "Your mailbox is connected" }).waitFor({ timeout: 30_000 }).catch(() => {});
    expect(await h1(page), `the connect did not finish: ${await said(page)}`).toBe("Your mailbox is connected");
    const creates = heard.filter((h) => h.method === "POST" && h.path === "/mailboxes");
    expect(creates.map((c) => c.status), "one refusal for the window, then the same connect once").toEqual([403, 201]);
    expect(creates[1]!.body).toEqual(creates[0]!.body);
  }, 60_000);

  it("on Cloud, Not now on the plan step leads to a front door that offers the trial, not a closed account", async () => {
    const plane = neverStartedPlane();
    await newWorld(plane.port);
    const fresh = await browser!.newContext();
    try {
      const p = await fresh.newPage();
      const who = { email: "noor@family.example", password: "another-long-signup-password", totpSecret: "" };
      await signUp(p, who);
      await p.getByRole("heading", { name: "Choose your plan" }).waitFor({ timeout: 30_000 });
      const out = p.locator('a.join-alt[href="/"]');
      await out.waitFor({ timeout: 30_000 });
      const label = ((await out.textContent()) ?? "").trim();
      await out.click();
      await p.getByRole("heading", { name: "Start your free trial" }).waitFor({ timeout: 30_000 }).catch(() => {});
      const wall = await p.evaluate(() => document.body?.innerText ?? "");
      expect(wall, `the front door: ${await said(p)}`).toContain("Start your free trial");
      expect(wall).toContain("14 days free, no card.");
      expect(await p.getByRole("button", { name: "Start your trial" }).count()).toBe(1);
      expect(await p.getByRole("button", { name: "Sign out" }).count()).toBe(1);
      // Nothing a closed account is told: not inactive, not stopped, no erasure clock, no move to self-hosting.
      expect(wall).not.toMatch(/not active|stopped organizing|will be (erased|deleted)|self-host/i);
      expect(label, "the plan step's way out says what it does").toBe("Not now");
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it("a tier button's plan outlives the mail round trip: named on the plan step, sent to the account page", async () => {
    const plane = neverStartedPlane();
    await newWorld(plane.port);
    const fresh = await browser!.newContext();
    try {
      const p = await fresh.newPage();
      const who = { email: "ines@family.example", password: "a-third-long-signup-password", totpSecret: "" };
      // The site's Pro button with the yearly toggle; the verification link comes back without the query.
      await signUp(p, who, "/join?plan=pro&interval=year");
      await p.getByRole("heading", { name: "Choose your plan" }).waitFor({ timeout: 30_000 });
      const trial = p.locator('[data-testid="join-plan-trial"]');
      await trial.waitFor({ timeout: 30_000 }).catch(() => {});
      expect(await trial.count(), `no trial line: ${await said(p)}`).toBe(1);
      expect(((await trial.textContent()) ?? "").trim()).toBe("You chose Pro, billed yearly. 14 days free, no card.");
      await p.locator('a.btn.primary[href^="https://plane.example/"]').waitFor({ timeout: 30_000 });
      expect(plane.mints, "the plan step's mint carries the language and the site's choice")
        .toContainEqual({ lang: "en", hint: { plan: "pro", interval: "year" } });
    } finally {
      await fresh.close();
    }
  }, 120_000);

  it("a German signup is answered in German: the mail, a wrong password, a wrong code, the provider note", async () => {
    await newWorld();
    const fresh = await browser!.newContext();
    await fresh.addCookies([{ name: "ohmail.locale", value: "de", domain: "localhost", path: "/" }]);
    try {
      const p = await fresh.newPage();
      const who = { email: "lena@family.example", password: "ein-langes-passwort-fuer-ohmail", totpSecret: "" };
      await p.goto(`http://localhost:${webPort}/join`);
      await p.locator("#join-email").waitFor({ timeout: 30_000 });
      await p.fill("#join-email", who.email);
      await p.fill("#join-name", "Lena Graf");
      await p.fill("#join-pw", who.password);
      await p.getByRole("button", { name: de.join.createAccount }).click();
      await p.getByRole("heading", { name: de.join.step_sent_title }).waitFor({ timeout: 30_000 });

      const mail = world.mailer.sent.find((m) => m.to === who.email && m.template === "email_verification");
      expect(mail, `no verification mail: ${await said(p)}`).toBeTruthy();
      expect(mail!.rendered.subject).toBe("Bestätige deine E-Mail-Adresse für ohmail");
      expect(mail!.rendered.html).toContain('<html lang="de">');

      const token = new URL((mail!.data as { verifyUrl: string }).verifyUrl).searchParams.get("token");
      await p.goto(`http://localhost:${webPort}/verify-email?token=${encodeURIComponent(token!)}`);
      await p.fill("#verify-pw", "nicht-das-richtige-passwort");
      await p.getByRole("button", { name: de.verify.confirm }).click();
      await p.locator(".join-error").first().waitFor({ timeout: 30_000 });
      expect(await p.locator(".join-error").first().textContent()).toBe(de.verify.refusedPassword);
      await p.fill("#verify-pw", who.password);
      await p.getByRole("button", { name: de.verify.confirm }).click();
      await p.getByRole("heading", { name: de.join.step_factor_title }).waitFor({ timeout: 30_000 });

      await p.getByRole("button", { name: de.join.useTotp }).click();
      who.totpSecret = ((await p.locator(".join-secret code").textContent()) ?? "").trim();
      const right = totpAt(who.totpSecret, world.clock.now());
      await p.fill("#join-totp", right === "000000" ? "111111" : "000000");
      await p.getByRole("button", { name: de.join.activate }).click();
      await p.locator(".join-error").first().waitFor({ timeout: 30_000 });
      expect(await p.locator(".join-error").first().textContent()).toBe(de.join.refusedTotpCode);
      await p.fill("#join-totp", right);
      await p.getByRole("button", { name: de.join.activate }).click();
      await p.locator(".join-codes li").first().waitFor({ timeout: 30_000 });
      await p.locator(".join-check input[type=checkbox]").check();
      await p.getByRole("button", { name: de.join.continue }).click();
      await p.getByRole("heading", { name: de.join.step_mailbox_title }).waitFor({ timeout: 30_000 });

      await p.getByRole("radio", { name: /GMX/ }).click();
      expect(await p.locator(".pvp-note p").first().textContent()).toBe(de.providerPicker.note_gmx);
      const text = await p.evaluate(() => document.body?.innerText ?? "");
      expect(text, "English left on the German mailbox step").not.toMatch(/GMX ships with IMAP|enabling IMAP/);
    } finally {
      await fresh.close();
    }
  }, 120_000);
});

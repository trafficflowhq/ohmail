import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join, relative } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { expect } from "vitest";
import { chromium } from "@playwright/test";
import { apiRoutes, createApp, csrfTokenFor, matchRoute, normalizePathname, type ApiDeps } from "@trafficflow/api";
import { calendarRoutes } from "@trafficflow/api/calendar";
import { calSettings } from "@trafficflow/db/mail";
import { calendarFeed } from "@trafficflow/services/calendar";
import { refreshTokens, sessions, users } from "@trafficflow/db";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession, seedSessionFor } from "../../../packages/api/test/helpers.js";
import { language } from "../vocabulary/catalogue.js";
import { apiPlanter, fixturesPlanter } from "../vocabulary/world.js";
import { fenced, PlaywrightPerson, shown } from "./dom-playwright.js";
import { benchOf, type Account, type Bench, type DoorFault, type Heard, type Setting, type Size } from "./seam.js";

/** The jar as a completed sign-in leaves it for `a` on this bench's own name: its five cookies. */
function signedIn(a: Account) {
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const jar = { domain: "localhost", secure: true, expires } as const;
  return [
    { ...jar, name: "tf_session", value: a.access, path: "/", httpOnly: true, sameSite: "Strict" as const },
    { ...jar, name: "tf_csrf", value: csrfTokenFor(a.access), path: "/", httpOnly: false, sameSite: "Strict" as const },
    { ...jar, name: "tf_refresh", value: a.refresh, path: "/auth/refresh", httpOnly: true, sameSite: "Strict" as const },
    { ...jar, name: "tf_resume", value: "1", path: "/", httpOnly: true, sameSite: "Lax" as const },
    { ...jar, name: "tf_owner", value: a.accountId, path: "/", httpOnly: false, sameSite: "Strict" as const },
  ];
}

export { firstCachedOhboxPaint, resetOhboxPaint, sharedBrowserPaint, signInPaintWhileLeaving } from "../../support/first-list-paint.js";
export { journey, journeysOf, personWith, signedIn } from "./journey.js";
export { HOST } from "./seam.js";
export type { Account, Bench, DoorFault, Found, Guard, Heard, Need, Setting, Spoken } from "./seam.js";

/**
 * THE WEB BENCH. The built web app, started as it is served (`next build`, `next start`), in front
 * of the real route table behind a socket, driven in Chromium. One build per run: the first journeys
 * file builds, the others start what it built.
 *
 *     TF_JOURNEYS=selfhost npx vitest run test/journeys/journeys/
 *
 * `TF_JOURNEYS` names the setting: `managed` (W-m), `selfhost` (W-s) or `demo` (W-d); `host` (H) runs
 * `apps/desktop/test/journeys-host.test.ts` alone. Unset, every journeys file is skipped; any other
 * word is refused. `TF_JOURNEYS_LANG=de` runs the same journeys
 * over the German catalogue. `TF_JOURNEYS_BUILT=1` trusts the build that is already in
 * `apps/webapp/.next` (a job that built it itself).
 *
 * Three promises hold for every journey, whatever it is about: no request leaves the machine, the
 * page logs no error, and nothing is retried.
 */
export type Flavour = "managed" | "selfhost" | "demo";
export const SETTING_OF: Record<Flavour, Setting> = { managed: "W-m", selfhost: "W-s", demo: "W-d" };
export const WEB: Setting[] = ["W-m", "W-s"];
export const EVERY_WEB: Setting[] = ["W-m", "W-s", "W-d"];

/** The web bench's flavour `TF_JOURNEYS` names; null when it names no setting of the web bench. */
export function flavour(env: NodeJS.ProcessEnv = process.env): Flavour | null {
  const named = benchOf(env);
  if (named === null || named.id !== "web") return null;
  return named.word as Flavour;
}


const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEBAPP = join(ROOT, "apps/webapp");
const STATE = join(ROOT, "build/journeys");

function nextCli(): string {
  return join(dirname(createRequire(join(WEBAPP, "package.json")).resolve("next/package.json")), "dist/bin/next");
}

async function freePort(): Promise<number> {
  const s = createServer();
  s.listen(0, "127.0.0.1");
  await once(s, "listening");
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

/** What the build was made from: the web app's and the packages' trees, and every uncommitted change under them. */
export function fingerprint(root: string = ROOT): string {
  try {
    const git = (...args: string[]): string => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // The trees the build reads, not the commit: a commit that changes only tests rebuilds nothing.
    const head = git("rev-parse", "HEAD:apps/webapp", "HEAD:packages").trim().split("\n").map((t) => t.slice(0, 12)).join("-");
    const dirty = git("status", "--porcelain", "--", "apps/webapp", "packages") + git("diff", "HEAD", "--", "apps/webapp", "packages");
    return `${head}-${createHash("sha256").update(dirty).digest("hex").slice(0, 12)}`;
  } catch {
    // No git (an unpacked archive): the files themselves, so a tree changed after a build is built again.
    const hash = createHash("sha256");
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true }).sort((x, y) => (x.name < y.name ? -1 : 1))) {
        if (e.isDirectory()) {
          if (!NOT_BUILT_FROM.test(e.name)) walk(join(dir, e.name));
        } else if (e.isFile()) {
          hash.update(`${relative(root, join(dir, e.name))}\0`).update(readFileSync(join(dir, e.name))).update("\0");
        }
      }
    };
    for (const part of ["apps/webapp", "packages"]) if (existsSync(join(root, part))) walk(join(root, part));
    return `files-${hash.digest("hex").slice(0, 24)}`;
  }
}

/** Folders a build is not made from: what is installed, what is built, and the tests. */
const NOT_BUILT_FROM = /^(?:node_modules|\.next|dist|test|__snapshots__)$/;

interface Built { flavour: "managed" | "selfhost"; from: string; apiPort: number | null }

/** One build at a time. The files of a run start together; each would build, and two builds in one folder spoil both. */
export async function oneAtATime(dir: string): Promise<() => void> {
  mkdirSync(dir, { recursive: true });
  const lock = join(dir, "building");
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      writeFileSync(lock, String(process.pid), { flag: "wx" });
      return () => rmSync(lock, { force: true });
    } catch {
      let holder = 0;
      try { holder = Number(readFileSync(lock, "utf8")); } catch { continue; }
      let alive = holder > 0;
      try { if (alive) process.kill(holder, 0); } catch { alive = false; }
      if (!alive) rmSync(lock, { force: true });
      else if (Date.now() > deadline) throw new Error(`process ${holder} has been building the web app for fifteen minutes`);
      else await new Promise((r) => setTimeout(r, 250));
    }
  }
}

function run(cmd: string, args: string[], env: Record<string, string | undefined>): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { cwd: WEBAPP, env: { ...process.env, ...env }, stdio: "pipe" });
    let out = "";
    p.stdout?.on("data", (d) => { out += String(d); });
    p.stderr?.on("data", (d) => { out += String(d); });
    p.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}\n${out.slice(-4000)}`))));
  });
}

/**
 * The build for `want`, made once. A managed build compiles its API's address into the rewrite, so
 * its port is chosen here and kept beside the build; a self-host build compiles none.
 */
async function ensureBuilt(want: "managed" | "selfhost" | null): Promise<Built> {
  const done = await oneAtATime(STATE);
  try {
    return await builtUnderLock(want);
  } finally {
    done();
  }
}

async function builtUnderLock(want: "managed" | "selfhost" | null): Promise<Built> {
  const record = join(STATE, "current.json");
  const from = fingerprint();
  const have: Built | null = existsSync(record) ? JSON.parse(readFileSync(record, "utf8")) as Built : null;
  const built = existsSync(join(WEBAPP, ".next/BUILD_ID"));
  if (process.env.TF_JOURNEYS_BUILT === "1") {
    if (!built) throw new Error("TF_JOURNEYS_BUILT=1, and apps/webapp/.next holds no build");
    if (have) return have;
    if (want === "managed") throw new Error("TF_JOURNEYS_BUILT=1 with a managed build needs build/journeys/current.json for its API port");
    return { flavour: "selfhost", from, apiPort: null };
  }
  if (built && have && have.from === from && (want === null || have.flavour === want)) return have;
  const made: Built = { flavour: want ?? "selfhost", from, apiPort: want === "managed" ? await freePort() : null };
  expect(existsSync(nextCli()), `next's CLI is missing: install the workspace's dependencies`).toBe(true);
  const env: Record<string, string | undefined> = {
    NEXT_PUBLIC_DEMO: undefined, NEXT_PUBLIC_API_BASE: undefined, NEXT_PUBLIC_GITHUB_STARS: "1",
    OHMAIL_FLAVOR: made.flavour === "selfhost" ? "selfhost" : undefined,
    TF_API_ORIGIN: made.flavour === "managed" ? `http://127.0.0.1:${made.apiPort}` : undefined,
  };
  await run(process.execPath, [nextCli(), "build"], env);
  mkdirSync(join(STATE, made.flavour), { recursive: true });
  writeFileSync(join(STATE, made.flavour, `.built-${from}`), "");
  writeFileSync(record, JSON.stringify(made));
  return made;
}

interface HeldRequest { asked: string; go: () => void }

interface Api {
  db: Db;
  deps: ApiDeps;
  now: () => Date;
  heard: Heard[];
  faults: DoorFault[];
  held: Set<HeldRequest>;
  serve: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

interface ApiFeatures {
  pairing?: boolean;
  remoteImages?: boolean;
  calendar?: boolean;
}

async function makeApi(f: "managed" | "selfhost", origin: () => string, features: ApiFeatures): Promise<Api> {
  const made = await makeDeps(new Date(), { origin: [origin()] });
  made.deps.hello = {
    flavor: f, needsSetup: false,
    auth: { password: true, totp: true, webauthn: true, publicSignup: f === "managed" },
    features: {
      sse: false, staging: false, ai: false,
      pairing: features.pairing ?? true, remoteImages: features.remoteImages ?? true, scheduleFiles: false,
      ...(features.calendar ? { calendar: true } : {}),
    },
  };
  if (features.calendar) made.deps.services = { ...made.deps.services, calendar: calendarFeed };
  const routes = features.calendar ? [...apiRoutes, ...calendarRoutes] : apiRoutes;
  const app = createApp(routes);
  const heard: Heard[] = [];
  const faults: DoorFault[] = [];
  const held = new Set<HeldRequest>();
  const serve = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const part of req) chunks.push(part as Buffer);
    const url = new URL(req.url ?? "/", origin());
    url.pathname = normalizePathname(url.pathname);
    const method = req.method ?? "GET";
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) for (const x of v) headers.append(k, x);
      else if (v !== undefined) headers.set(k, v);
    }
    const m = matchRoute(routes, method === "HEAD" ? "GET" : method, url.pathname);
    const pattern = m.matched ? m.route.pattern : `(no route) ${url.pathname}`;
    const door = faults.map((fault) => fault(method, pattern));
    let request: HeldRequest | undefined;
    try {
      if (door.includes("hold")) {
        // A request its browser gave up on while it was held never reached the route.
        let gone = false;
        res.on("close", () => { gone = true; });
        await new Promise<void>((go) => {
          request = { asked: `${method} ${pattern}`, go };
          held.add(request);
        });
        if (gone) return;
      } else if (door.includes("refuse")) {
        heard.push({ method, pattern, status: 503 });
        res.statusCode = 503;
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: { code: "unavailable", message: "refused at the wire" } }));
        return;
      }
      const body = method === "GET" || method === "HEAD" || chunks.length === 0 ? undefined : Buffer.concat(chunks);
      const answer = await app.handle(new Request(url, { method, headers, body }), { ...made.deps, session: null, idempotency: null });
      heard.push({ method, pattern, status: answer.status });
      res.statusCode = answer.status;
      answer.headers.forEach((v, k) => { if (k !== "set-cookie") res.setHeader(k, v); });
      const cookies = answer.headers.getSetCookie();
      if (cookies.length > 0) res.setHeader("set-cookie", cookies);
      if (answer.body) Readable.fromWeb(answer.body as never).pipe(res);
      else res.end();
    } finally {
      if (request) held.delete(request);
    }
  };
  return { db: made.db, deps: made.deps, now: () => made.clock.now(), heard, faults, held, serve };
}

/** The paths a self-hosted install's proxy hands to the API (`deploy/selfhost/proxy/routes.caddy`). */
const TO_API = /^\/(?:api|auth|pair|internal)(?:\/|$)|^\/(?:events|health|hello)$/;

async function waitFor(url: string, log: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  for (;;) {
    const up = await fetch(url, { redirect: "manual" }).then(() => true, () => false);
    if (up) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}\n${log().slice(-2000)}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

export async function startBench(f: Flavour, recordAs = "bench", features: ApiFeatures = {}, size: Size = "expanded"): Promise<Bench> {
  const built = await ensureBuilt(f === "demo" ? null : f);
  const withApi = f !== "demo";
  const apiFlavour = built.flavour;
  const selfhost = withApi && apiFlavour === "selfhost";
  const servers: Server[] = [];
  // The bench's own servers take the port the system gives them. Only `next start` must be told one,
  // and a managed build's API has the port its build compiled into the rewrite.
  let served: Api | null = null;
  let webPort = 0;
  let frontPort: number;
  if (selfhost) {
    // The self-hosted install's proxy: the API's paths to the API, everything else to the web app.
    const front = createServer((req, res) => {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (TO_API.test(path) && served) {
        void served.serve(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); });
        return;
      }
      const onward = httpRequest({ host: "localhost", port: webPort, path: req.url, method: req.method, headers: req.headers }, (answer) => {
        res.writeHead(answer.statusCode ?? 502, answer.headers);
        answer.pipe(res);
      });
      onward.on("error", () => { res.statusCode = 502; res.end(); });
      req.pipe(onward);
    });
    front.listen(0, "localhost");
    await once(front, "listening");
    servers.push(front);
    frontPort = (front.address() as AddressInfo).port;
  } else {
    webPort = await freePort();
    frontPort = webPort;
  }
  const origin = `http://localhost:${frontPort}`;
  const api = withApi ? await makeApi(apiFlavour, () => origin, features) : null;
  served = api;
  let apiPort: number | null = null;
  if (api) {
    const s = createServer((req, res) => { void api.serve(req, res).catch((e) => { res.statusCode = 500; res.end(String(e)); }); });
    s.listen(apiFlavour === "managed" ? built.apiPort! : 0, "127.0.0.1");
    await once(s, "listening");
    servers.push(s);
    apiPort = (s.address() as AddressInfo).port;
  }
  if (selfhost) webPort = await freePort();
  let webLog = "";
  const env: Record<string, string | undefined> = {
    ...process.env, NEXT_PUBLIC_DEMO: undefined, NEXT_PUBLIC_API_BASE: undefined,
    TF_API_ORIGIN: apiFlavour === "managed" && apiPort !== null ? `http://127.0.0.1:${apiPort}` : undefined,
    OHMAIL_INTERNAL_API_ORIGIN: apiFlavour === "selfhost" && apiPort !== null ? `http://127.0.0.1:${apiPort}` : undefined,
  };
  const web: ChildProcess = spawn(process.execPath, [nextCli(), "start", "-p", String(webPort), "-H", "localhost"], { cwd: WEBAPP, env, stdio: "pipe" });
  web.stdout?.on("data", (d) => { webLog += String(d); });
  web.stderr?.on("data", (d) => { webLog += String(d); });
  await waitFor(`http://localhost:${webPort}/version`, () => webLog);
  const browser = await chromium.launch();
  const people: PlaywrightPerson[] = [];
  const lang = language();
  // eslint-disable-next-line no-console
  console.log(`journeys bench: ${SETTING_OF[f]} ${size} at ${origin} · build ${built.flavour} ${built.from} · ${api ? "API in process over PGlite" : "no server"} · ${lang}`);

  const bench: Bench = {
    id: "web", setting: SETTING_OF[f], size, flavour: f, origin, stack: null,
    heard: api?.heard ?? [], faults: api?.faults ?? [],
    fixtures: f === "demo" ? fixturesPlanter() : null,
    has: () => false,
    held: () => Array.from(api?.held ?? [], (h) => h.asked),
    release() {
      if (!api) return;
      api.faults.length = 0;
      for (const h of api.held) h.go();
    },
    async account() {
      if (!api) throw new Error("the demo has no account");
      const s = await seedSession(api.db, { now: api.now(), lastTwofaAt: api.now() });
      if (features.calendar) await api.db.insert(calSettings).values({ accountId: s.accountId, enabledAt: api.now() });
      const [row] = await api.db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
      const refresh = generateToken();
      await api.db.insert(refreshTokens).values({
        accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
        tokenHash: hashToken(refresh), expiresAt: new Date(api.now().getTime() + 2 * 60 * 60 * 1000), createdAt: api.now(),
      });
      const [user] = await api.db.select({ email: users.email }).from(users).where(eq(users.id, s.userId));
      return { accountId: s.accountId, userId: s.userId, email: user!.email, access: s.token, refresh, familyId: row!.familyId, planter: apiPlanter(api.db, s, api.now) };
    },
    async ask(a, method, path, o = {}) {
      if (o.session === "fresh" && !api) throw new Error("a session made for one request needs the API in process");
      const access = o.session === "fresh"
        ? (await seedSessionFor(api!.db, { accountId: a.accountId, userId: a.userId, now: api!.now(), lastTwofaAt: api!.now() })).token
        : a.access;
      const res = await fetch(`${origin}/api${path}`, {
        method, headers: { cookie: `tf_session=${access}; tf_csrf=${csrfTokenFor(access)}`, "x-csrf-token": csrfTokenFor(access), origin },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async signedInElsewhere(p, a) {
      if (!people.includes(p as PlaywrightPerson)) throw new Error("signedInElsewhere: a window this bench did not open");
      await (p as PlaywrightPerson).jarNames(signedIn(a));
    },
    async person(o = {}) {
      if (o.host !== undefined) throw new Error("the web bench serves one name: a foreign host is the stack's");
      const base = f === "demo" ? o.door ?? "/demo" : "/";
      // Everybody starts in English; a person who can reach Settings then chooses the run's language.
      const person = await fenced(browser, { origin, base, lang: "en", size });
      /* A driven clock is installed before the first page loads, so every timer the app sets is the clock's. */
      if (o.clock === "driven") {
        await person.page.clock.install();
        person.driven = true;
      }
      if (o.account) await person.jarNames(signedIn(o.account));
      people.push(person);
      const want = o.lang ?? lang;
      // Behind `/?demo=1` the choice does not take today (the page holds no account to write it to),
      // so a visitor through that door stays in English.
      if (want !== "en" && (f === "demo" ? base === "/demo" : o.account !== undefined)) await person.speak(want);
      return person;
    },
    async sessionLive(a) {
      if (!api) return false;
      const rows = await api.db.select({ revokedAt: refreshTokens.revokedAt }).from(refreshTokens).where(eq(refreshTokens.familyId, a.familyId));
      return rows.some((r) => r.revokedAt === null);
    },
    problems: (tolerated = []) => people.flatMap((p) => p.problems(tolerated)),
    async story() {
      const pages: string[] = [];
      for (const p of people) {
        const tree = await p.page.getByRole("document").or(p.page.getByRole("main")).first().ariaSnapshot().catch((e) => String(e));
        pages.push(`${shown(p.page.url())}\n${tree}\n${p.problems().join("\n")}`);
      }
      return `${pages.join("\n---\n")}\nheard: ${JSON.stringify((api?.heard ?? []).map((h) => `${h.method} ${h.pattern} ${h.status}`))}`;
    },
    async closePeople() {
      for (const p of people.splice(0)) await p.context.close().catch(() => {});
      bench.release();
    },
    async stop() {
      const dir = process.env.TF_JOURNEYS_RECORD;
      if (dir && api) {
        mkdirSync(join(dir, SETTING_OF[f]), { recursive: true });
        const calls = [...new Set(api.heard.map((h) => `${h.method} ${h.pattern}`))].sort();
        writeFileSync(join(dir, SETTING_OF[f], `${recordAs}.calls.json`), JSON.stringify(calls, null, 1));
      }
      await browser.close().catch(() => {});
      web.kill("SIGTERM");
      for (const s of servers) {
        s.closeAllConnections();
        await new Promise<void>((r) => s.close(() => r()));
      }
    },
  };
  return bench;
}

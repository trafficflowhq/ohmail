import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { apiRoutes, createApp, csrfTokenFor, matchRoute, normalizePathname, type ApiDeps } from "@trafficflow/api";
import { refreshTokens, sessions, users } from "@trafficflow/db";
import { generateToken, hashToken, type Db } from "@trafficflow/services";
import { makeDeps, seedSession } from "../../../packages/api/test/helpers.js";
import { ACTS, type ActId } from "../vocabulary/acts.js";
import { language, say, type Language } from "../vocabulary/catalogue.js";
import { control, type ControlId } from "../vocabulary/controls.js";
import { PLACES, type PlaceId } from "../vocabulary/places.js";
import { apiPlanter, fixturesPlanter, PEOPLE, type ConversationSpec, type Planted } from "../vocabulary/world.js";

/**
 * THE WEB BENCH. The built web app, started as it is served (`next build`, `next start`), in front
 * of the real route table behind a socket, driven in Chromium. One build per run: the first journeys
 * file builds, the others start what it built.
 *
 *     TF_JOURNEYS=selfhost npx vitest run test/journeys
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
export type Setting = "W-m" | "W-s" | "W-d" | "D-l" | "D-m" | "D-s" | "D-p" | "H";
export type Flavour = "managed" | "selfhost" | "demo";
/** `host` is the page a desktop serves to a phone's browser: its bench lives beside the desktop app. */
export const HOST = "host";
export type Need = "pg" | "mail";
export const SETTING_OF: Record<Flavour, Setting> = { managed: "W-m", selfhost: "W-s", demo: "W-d" };
export const WEB: Setting[] = ["W-m", "W-s"];
export const EVERY_WEB: Setting[] = ["W-m", "W-s", "W-d"];

export interface Guard {
  title: string;
  /** The fault index's rows this journey stands for. */
  rows: string[];
  surfaces: Setting[];
  needs: Need[];
  /** An open row: the fault stands today, so the journey is expected to fail. */
  open?: boolean;
  /** Console lines this journey expects, as patterns (a refused door logs its status). */
  tolerates?: RegExp[];
}

export function flavour(env: NodeJS.ProcessEnv = process.env): Flavour | null {
  const raw = (env.TF_JOURNEYS ?? "").trim();
  if (raw === "" || raw === HOST) return null;
  if (raw === "managed" || raw === "selfhost" || raw === "demo") return raw;
  throw new Error(`TF_JOURNEYS must be "managed", "selfhost", "demo" or "host", not ${JSON.stringify(raw)}`);
}

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const WEBAPP = join(ROOT, "apps/webapp");
const STATE = join(ROOT, "build/journeys");
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

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

/** One request the API answered: the route's own pattern, never the address that reached it. */
export interface Heard { method: string; pattern: string; status: number }

/**
 * What a door does with a request: answer as the route does, refuse it at the wire, or hold it,
 * asked and unanswered, until the bench lets go (`release`).
 */
export type DoorFault = (method: string, pattern: string) => "refuse" | "hold" | null;

interface Api {
  db: Db;
  deps: ApiDeps;
  now: () => Date;
  heard: Heard[];
  faults: DoorFault[];
  held: Array<{ asked: string; go: () => void }>;
  serve: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
}

async function makeApi(f: "managed" | "selfhost", origin: () => string, features: { pairing: boolean; remoteImages: boolean }): Promise<Api> {
  const made = await makeDeps(new Date(), { origin: [origin()] });
  made.deps.hello = {
    flavor: f, needsSetup: false,
    auth: { password: true, totp: true, webauthn: true, publicSignup: f === "managed" },
    features: { sse: false, staging: false, ai: false, pairing: features.pairing, remoteImages: features.remoteImages, scheduleFiles: false },
  };
  const app = createApp(apiRoutes);
  const heard: Heard[] = [];
  const faults: DoorFault[] = [];
  const held: Api["held"] = [];
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
    const m = matchRoute(apiRoutes, method === "HEAD" ? "GET" : method, url.pathname);
    const pattern = m.matched ? m.route.pattern : `(no route) ${url.pathname}`;
    const door = faults.map((fault) => fault(method, pattern));
    if (door.includes("hold")) {
      // A request its browser gave up on while it was held never reached the route.
      let gone = false;
      res.on("close", () => { gone = true; });
      await new Promise<void>((go) => { held.push({ asked: `${method} ${pattern}`, go }); });
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

/** A person's session, as the sign-in ceremony leaves it. */
export interface Account { accountId: string; userId: string; email: string; access: string; refresh: string; familyId: string; planter: ReturnType<typeof apiPlanter> }

export interface Found { named?: string; args?: Record<string, string | number> }

/** What a control says of itself to a screen reader. */
export interface Spoken {
  description: string; pressed: string | null; selected: string | null; current: string | null;
  expanded: string | null; disabled: boolean;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** One person at one browser. Everything they do and see goes through the vocabulary. */
export class Person {
  private readonly errors: string[] = [];
  private readonly outside: string[] = [];
  private readonly asked: string[] = [];
  private readonly tabs: Person[] = [];
  /** The language the app speaks to this person; English until they choose another (`speak`). */
  lang: Language;
  constructor(readonly page: Page, readonly context: BrowserContext, private readonly origin: string, private readonly base: string, lang: Language) {
    this.lang = lang;
    page.on("pageerror", (e) => { this.errors.push(`page error: ${String(e)}`); });
    page.on("console", (m) => { if (m.type() === "error") this.errors.push(`console: ${m.text()}`); });
  }

  /** Choose the app's language as a person does: Settings, General, the language's own button. */
  async speak(lang: Language): Promise<void> {
    if (lang === this.lang) return;
    await this.arrive("settings-general");
    await this.act("press", `language-${lang}`);
    this.lang = lang;
    await this.here("settings-general");
  }

  /** A second tab of the same browser: the same cookies and storage, its own page. */
  async tab(): Promise<Person> {
    const other = new Person(await this.context.newPage(), this.context, this.origin, this.base, this.lang);
    this.tabs.push(other);
    return other;
  }

  /** Called by the fence for every request of this person's browser. */
  note(url: string, allowed: boolean): void {
    this.asked.push(url);
    if (!allowed) this.outside.push(`request left the machine: ${url}`);
  }

  /** Every address this browser asked for, the refused ones included. */
  requests(): string[] { return [...this.asked]; }

  /** What breaks the bench's promises: page errors, console errors, requests that tried to leave. */
  problems(tolerated: RegExp[] = []): string[] {
    return [
      ...this.errors.filter((e) => !tolerated.some((t) => t.test(e))), ...this.outside,
      ...this.tabs.flatMap((t) => t.problems(tolerated)),
    ];
  }

  private name(id: ControlId, found: Found): string | RegExp | null {
    const c = control(id);
    const from = c.nameFrom ?? "key";
    if (from === "none") return null;
    const text = from === "visible" ? found.named : say(c.key!, found.args ?? {}, this.lang);
    if (text === undefined) throw new Error(`the control ${id} is named by the world: say which one`);
    return c.counted ? new RegExp(`^${escapeRe(text)}(?: [0-9][0-9.,'’]*\\+?)?$`) : text;
  }

  /** The control, by role and whole name, inside what the vocabulary says it is inside. */
  find(id: ControlId, found: Found = {}): Locator {
    const c = control(id);
    const scope = c.within === undefined ? this.page
      : c.within in PLACES ? this.page.getByRole("main") : this.find(c.within);
    const name = this.name(id, found);
    const all = name === null ? scope.getByRole(c.role) : scope.getByRole(c.role, { name, exact: true });
    return c.outer || c.either ? all.first() : all;
  }

  /** Wait until the control is on screen. */
  async see(id: ControlId, found: Found = {}, ms = 20_000): Promise<Locator> {
    const target = this.find(id, found);
    await target.waitFor({ state: "visible", timeout: ms }).catch((e) => {
      throw new Error(`never saw ${id}${found.named ? ` (${found.named})` : ""} on ${new URL(this.page.url()).pathname}${new URL(this.page.url()).hash}: ${String(e).split("\n")[0]}`);
    });
    return target;
  }

  /** Wait until the control is not on screen. */
  async gone(id: ControlId, found: Found = {}, ms = 20_000): Promise<void> {
    await this.find(id, found).waitFor({ state: "hidden", timeout: ms }).catch(() => {
      throw new Error(`${id}${found.named ? ` (${found.named})` : ""} stayed on screen`);
    });
  }

  /** Is the control on screen now? No waiting: for "it is not offered here". */
  async offered(id: ControlId, found: Found = {}): Promise<boolean> {
    return (await this.find(id, found).count()) > 0 && this.find(id, found).isVisible();
  }

  async act(act: ActId, id: ControlId, found: Found & { value?: string } = {}): Promise<void> {
    await ACTS[act].web(await this.see(id, found), this.page, found.value);
  }

  async spoken(id: ControlId, found: Found = {}): Promise<Spoken> {
    const target = await this.see(id, found);
    const attr = (n: string): Promise<string | null> => target.getAttribute(n);
    return {
      description: (await attr("aria-description")) ?? "", pressed: await attr("aria-pressed"),
      selected: await attr("aria-selected"), current: await attr("aria-current"),
      expanded: await attr("aria-expanded"), disabled: await target.isDisabled(),
    };
  }

  /** The words a box holds now. */
  async holds(id: ControlId, found: Found = {}): Promise<string> {
    return (await this.see(id, found)).inputValue();
  }

  /** The words inside the control, as a person reads them. */
  async text(id: ControlId, found: Found = {}): Promise<string> {
    return (await (await this.see(id, found)).innerText()).trim();
  }

  /** The names of the controls of `role` inside `id`, as a screen reader lists them. */
  async listed(id: ControlId, role: Parameters<Locator["getByRole"]>[0]): Promise<string[]> {
    const all = await (await this.see(id)).getByRole(role).all();
    const names: string[] = [];
    for (const one of all) names.push(((await one.getAttribute("aria-label")) ?? (await one.innerText())).trim());
    return names;
  }

  /** Go to a place and wait for the thing that says you are there. */
  async arrive(place: PlaceId): Promise<void> {
    const p = PLACES[place];
    const url = p.route.startsWith("#") ? `${this.origin}${this.base}${p.route}` : `${this.origin}${p.route}`;
    await this.page.goto(url, { waitUntil: "commit" });
    await this.here(place);
  }

  /** Wait for a place's landmark without going anywhere. */
  async here(place: PlaceId, ms = 60_000): Promise<void> {
    const p = PLACES[place];
    const name = say(p.landmark.key, {}, this.lang);
    if (place.startsWith("settings-")) {
      const entry = this.find(`menu-${place}`);
      await entry.waitFor({ state: "visible", timeout: ms }).catch(() => { throw new Error(`the Settings menu never listed ${name}`); });
      await this.until(async () => (await entry.getAttribute("aria-current")) === "page", `${name} to be the current section`);
      return;
    }
    const mark = p.landmark.role === "heading"
      ? this.page.getByRole("heading", { name, exact: true, level: 1 })
      : this.page.getByRole(p.landmark.role, { name, exact: true });
    await mark.waitFor({ state: "visible", timeout: ms }).catch(() => { throw new Error(`never arrived at ${place}: no ${p.landmark.role} named ${JSON.stringify(name)}`); });
  }

  /** Wait until the page says the catalogue's sentence for `key`. For a sentence that is itself the promise. */
  async reads(key: string, args: Record<string, string | number> = {}, ms = 20_000): Promise<void> {
    const sentence = say(key, args, this.lang);
    await this.page.getByText(sentence, { exact: true }).first().waitFor({ state: "visible", timeout: ms }).catch(() => {
      throw new Error(`the page never said ${key}: ${JSON.stringify(sentence)}`);
    });
  }

  /** Wait for a sight. Never for time: `sight` is asked until it holds. */
  async until(sight: () => Promise<boolean>, what: string, ms = 20_000): Promise<void> {
    const deadline = Date.now() + ms;
    for (;;) {
      if (await sight().catch(() => false)) return;
      if (Date.now() > deadline) throw new Error(`waited for ${what}, and it never came`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

export interface Bench {
  setting: Setting;
  flavour: Flavour;
  origin: string;
  /** The API's own log of what it answered; empty on the demo, which has no server. */
  heard: Heard[];
  faults: DoorFault[];
  /** The requests a door is holding now, as `METHOD pattern`. */
  held(): string[];
  /** Let every held request through to its route, and hold and refuse no more. */
  release(): void;
  /** The demo's read-only world; null where the world is planted per account. */
  fixtures: ReturnType<typeof fixturesPlanter> | null;
  has(need: Need): boolean;
  /** One request to the API as the account's own browser would make it; the far end of a journey. */
  ask(a: Account, method: string, path: string): Promise<{ status: number; body: unknown }>;
  /** A new account with a live session. Not on the demo. */
  account(): Promise<Account>;
  /** A new browser for a person; signed in when an account is given. `door` is the demo's second way in. */
  person(o?: { account?: Account; door?: "/demo" | "/?demo=1"; lang?: Language }): Promise<Person>;
  /** Is the account's session still able to renew? (the far end of a sign-out) */
  sessionLive(a: Account): Promise<boolean>;
  problems(tolerated?: RegExp[]): string[];
  /** What every open page shows and what the API heard, for a failing journey's log. */
  story(): Promise<string>;
  closePeople(): Promise<void>;
  stop(): Promise<void>;
}

/** A browser context that cannot leave the machine, and the page that tells on itself. */
export async function fenced(browser: Browser, o: { origin: string; base: string; lang: Language }): Promise<Person> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "en-US" });
  const page = await context.newPage();
  const person = new Person(page, context, o.origin, o.base, o.lang);
  await context.route("**/*", (route) => {
    const url = route.request().url();
    const host = url.startsWith("data:") || url.startsWith("blob:") || url.startsWith("about:") ? "localhost" : new URL(url).hostname;
    const allowed = LOOPBACK.has(host);
    person.note(url, allowed);
    return allowed ? route.continue() : route.abort();
  });
  return person;
}

export async function startBench(f: Flavour, recordAs = "bench", features = { pairing: true, remoteImages: true }): Promise<Bench> {
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
  const people: Person[] = [];
  const lang = language();
  // eslint-disable-next-line no-console
  console.log(`journeys bench: ${SETTING_OF[f]} at ${origin} · build ${built.flavour} ${built.from} · ${api ? "API in process over PGlite" : "no server"} · ${lang}`);

  const bench: Bench = {
    setting: SETTING_OF[f], flavour: f, origin,
    heard: api?.heard ?? [], faults: api?.faults ?? [],
    fixtures: f === "demo" ? fixturesPlanter() : null,
    has: () => false,
    held: () => (api?.held ?? []).map((h) => h.asked),
    release() {
      if (!api) return;
      api.faults.length = 0;
      for (const h of api.held.splice(0)) h.go();
    },
    async account() {
      if (!api) throw new Error("the demo has no account");
      const s = await seedSession(api.db, { now: api.now(), lastTwofaAt: api.now() });
      const [row] = await api.db.select({ familyId: sessions.familyId }).from(sessions).where(eq(sessions.id, s.sessionId));
      const refresh = generateToken();
      await api.db.insert(refreshTokens).values({
        accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: row!.familyId,
        tokenHash: hashToken(refresh), expiresAt: new Date(api.now().getTime() + 2 * 60 * 60 * 1000), createdAt: api.now(),
      });
      const [user] = await api.db.select({ email: users.email }).from(users).where(eq(users.id, s.userId));
      return { accountId: s.accountId, userId: s.userId, email: user!.email, access: s.token, refresh, familyId: row!.familyId, planter: apiPlanter(api.db, s, api.now) };
    },
    async ask(a, method, path) {
      const res = await fetch(`${origin}/api${path}`, {
        method, headers: { cookie: `tf_session=${a.access}; tf_csrf=${csrfTokenFor(a.access)}`, "x-csrf-token": csrfTokenFor(a.access), origin },
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    },
    async person(o = {}) {
      const base = f === "demo" ? o.door ?? "/demo" : "/";
      // Everybody starts in English; a person who can reach Settings then chooses the run's language.
      const person = await fenced(browser, { origin, base, lang: "en" });
      if (o.account) {
        const expires = Math.floor(Date.now() / 1000) + 3600;
        const jar = { domain: "localhost", secure: true, expires } as const;
        await person.context.addCookies([
          { ...jar, name: "tf_session", value: o.account.access, path: "/", httpOnly: true, sameSite: "Strict" },
          { ...jar, name: "tf_csrf", value: csrfTokenFor(o.account.access), path: "/", httpOnly: false, sameSite: "Strict" },
          { ...jar, name: "tf_refresh", value: o.account.refresh, path: "/auth/refresh", httpOnly: true, sameSite: "Strict" },
          { ...jar, name: "tf_resume", value: "1", path: "/", httpOnly: true, sameSite: "Lax" },
          { ...jar, name: "tf_owner", value: o.account.accountId, path: "/", httpOnly: false, sameSite: "Strict" },
        ]);
      }
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
        pages.push(`${p.page.url()}\n${tree}\n${p.problems().join("\n")}`);
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

let bench: Bench | null = null;

/** One place's journeys: skipped unless `TF_JOURNEYS` names a setting; with it, a missing build or browser fails. */
export function journeysOf(place: PlaceId, body: () => void): void {
  // The guards read each file's GUARDS; they do not run its journeys a second time.
  if ((globalThis as { __journeysNamesOnly?: boolean }).__journeysNamesOnly) return;
  const f = flavour();
  describe.skipIf(f === null)(`journeys · ${place}${f ? ` · ${SETTING_OF[f]}` : ""}`, () => {
    beforeAll(async () => { bench = await startBench(f!, place); }, 900_000);
    afterAll(async () => {
      await bench?.stop();
      bench = null;
    });
    body();
  });
}

/**
 * One journey: one promise. It runs where its guard says it exists, fails where the guard names a
 * need this bench does not have, and is expected to fail while its row is open.
 */
export function journey(guard: Guard, walk: (b: Bench) => Promise<void>): void {
  const f = flavour();
  if (f !== null && !guard.surfaces.includes(SETTING_OF[f])) {
    it.skip(`${guard.title} (not in ${SETTING_OF[f]})`, () => {});
    return;
  }
  (guard.open ? it.fails : it)(guard.title, { timeout: 180_000, retry: 0 }, async () => {
    const b = bench;
    if (!b) throw new Error("the bench did not start");
    try {
      for (const need of guard.needs) {
        if (!b.has(need)) throw new Error(`this journey needs ${need === "pg" ? "a real Postgres" : "a mail server"}, and this bench has none`);
      }
      await walk(b);
      expect(b.problems(guard.tolerates), "the page logged an error or tried to leave the machine").toEqual([]);
    } catch (e) {
      if (process.env.TF_JOURNEYS_DEBUG === "1") console.log(await b.story());
      throw e;
    } finally {
      await b.closePeople();
    }
  });
}

/**
 * A person looking at one conversation's row: the demo's own conversation of that kind, or one
 * planted for a fresh account. Where the world is planted, `account` is whose it is.
 */
export async function personWith(b: Bench, want: ConversationSpec): Promise<{ person: Person; row: Planted; named: string; account: Account | null }> {
  if (b.fixtures) {
    const row = b.fixtures.find({ pile: want.pile, unread: want.unread });
    return { person: await b.person(), row, named: `${row.from}: ${row.subject}`, account: null };
  }
  const account = await b.account();
  const [row] = await account.planter.plant({ conversations: [want] });
  return { person: await b.person({ account }), row: row!, named: `${row!.from}: ${row!.subject}`, account };
}

/** A person signed in to an account that has a mailbox and one letter; on the demo, the demo's visitor. */
export async function signedIn(b: Bench): Promise<{ person: Person; account: Account | null }> {
  if (b.fixtures) return { person: await b.person(), account: null };
  const account = await b.account();
  await account.planter.plant({ conversations: [{ from: PEOPLE.ben, subject: "Kiln is fixed", pile: "ohbox", unread: false }] });
  return { person: await b.person({ account }), account };
}

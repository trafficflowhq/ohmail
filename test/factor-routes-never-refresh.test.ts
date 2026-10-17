import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { apiRoutes } from "@trafficflow/api";
import { CREDENTIAL_REFUSED as SERVER_CREDENTIAL_REFUSED } from "@trafficflow/services";
import { localRoutes } from "@trafficflow/api/local";
import { selfHostRoutes } from "@trafficflow/api/self-host";
import { desktopHostRoutes } from "@trafficflow/api/desktop-host";
import { mayRelay, RELAY_ALLOWLIST } from "@trafficflow/api/relay-allowlist";
import { isRecoverable, mayRefreshFor } from "../apps/webapp/app/session-refresh.js";
import { CREDENTIAL_REFUSED } from "@ohmail/client-engine";
import { BearerManagerRN } from "../apps/mobile/src/net/bearer.js";
import { BearerManager, REFRESH_STORAGE_KEY } from "../apps/desktop/src/host-client/bearer.js";
import { createCloudAuth } from "../apps/sidecar/src/cloud-auth.js";
import { withoutComments } from "../scripts/lib/source-scan.mjs";

/**
 * THE ROUTES WHOSE 401 IS AN ANSWER, DERIVED FROM THE SERVER (STEP-UP-WRONG-CODE-IS-SENT-TWICE).
 * The web refreshes and re-sends a request refused 401 unless its path is in `NEVER_REFRESH`. On a
 * route that checks a factor or a single-use credential the 401 is the verdict, and the re-send is
 * a second attempt against the sign-in throttle. This file reads every route the four server
 * compositions mount, derives which of them check such a credential, and refuses one the web
 * would refresh, unless ALLOW names it with a reason this file also checks.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = ["packages/api/src", "packages/services/src"];
const ROUTES_ROOT = "packages/api/src/routes/";
const WEB_ROOT = "apps/webapp/app";

/**
 * What checks a credential: the attempt throttle every guessable secret sits behind, the TOTP and
 * passkey verifiers, and the single-use login token, challenge and recovery code. A route checks
 * one when its handler reaches a name here through the call graph of the API and services source.
 * The graph is keyed by NAME, so two functions sharing one are one node: that can only widen the
 * set. What it cannot see is a single-use token checked behind neither the throttle nor a session
 * mint, and the mint is the second arm: `credentialSubject`, held to its handlers by
 * `packages/api/test/account-header-census.test.ts`.
 */
const PRIMITIVES = [
  "throttleReserve", "verifyTotp", "verifyAssertion", "consumeLoginToken", "peekLoginToken", "consumeChallenge",
  "spendRecoveryCode",
];

/**
 * The sentences a session's own refusal says. A credential route may construct `unauthorized` with
 * these and no other: its verdicts (a wrong code, a spent token) are `credential_refused`, the code a
 * client reads before its path list, so one built as `unauthorized` would be renewed and sent again.
 */
const SESSION_SENTENCES: ReadonlySet<string> = new Set([
  "no active session", "authentication required", "nothing to sign out", "no such user",
]);

/**
 * Credential routes the web never presses, matched as `NEVER_REFRESH` matches: a path prefix. The
 * reason is checked, not trusted: no file under `apps/webapp/app` may name one of these paths in
 * code (comments are blanked first), and an entry that covers no credential route is refused.
 */
const ALLOW: ReadonlyArray<{ prefix: string; reason: string }> = [
  { prefix: "/admin/staff/", reason: "the staff console's proxy alone; it reads every 401 as a verdict and never refreshes" },
  { prefix: "/auth/desktop-claim", reason: "the desktop app's sign-in, over a bare fetch" },
  { prefix: "/auth/desktop-approval/claim", reason: "the desktop app's sign-in, over a bare fetch" },
  { prefix: "/oauth/token", reason: "third-party OAuth clients" },
];

interface Source { rel: string; text: string }
interface RuntimeRoute { method: string; pattern: string; options?: { credentialSubject?: boolean } }
interface Refusal { code: string; sentence: string }
interface Scan {
  literals: Map<string, Set<string>>; opaque: string[]; graph: Map<string, Set<string>>;
  /** Per function name (and per route key, for a handler's own body): the 401s it constructs. */
  refusals: Map<string, Refusal[]>;
}

function walk(rel: string, exts: readonly string[]): Source[] {
  const abs = join(ROOT, rel);
  if (statSync(abs).isFile()) return [{ rel, text: readFileSync(abs, "utf8") }];
  return readdirSync(abs).sort().flatMap((name) => {
    const child = `${rel}/${name}`;
    if (statSync(join(ROOT, child)).isDirectory()) return walk(child, exts);
    return exts.some((e) => name.endsWith(e)) && !name.endsWith(".d.ts") ? walk(child, exts) : [];
  });
}

const unwrap = (n: ts.Expression): ts.Expression =>
  ts.isAsExpression(n) || ts.isParenthesizedExpression(n) || ts.isSatisfiesExpression(n) ? unwrap(n.expression) : n;

/** The names a node CALLS, and the identifiers it hands on as arguments (`staffRoute("x", signIn)`). */
function refsOf(node: ts.Node): Set<string> {
  const out = new Set<string>();
  if (ts.isIdentifier(node)) out.add(node.text);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) {
      const callee = unwrap(n.expression);
      if (ts.isIdentifier(callee)) out.add(callee.text);
      else if (ts.isPropertyAccessExpression(callee)) out.add(callee.name.text);
      for (const a of n.arguments ?? []) if (ts.isIdentifier(unwrap(a))) out.add((unwrap(a) as ts.Identifier).text);
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

/** The `new ServiceError(<code>, 401, <sentence>)` a node constructs, code and sentence read as literals. */
function refusalsIn(node: ts.Node, text: (e: ts.Expression | undefined) => string | null): Refusal[] {
  const out: Refusal[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isNewExpression(n) && ts.isIdentifier(unwrap(n.expression)) && (unwrap(n.expression) as ts.Identifier).text === "ServiceError") {
      const [code, status, sentence] = n.arguments ?? [];
      const s = status ? unwrap(status) : undefined;
      if (s && ts.isNumericLiteral(s) && s.text === "401") {
        out.push({ code: text(code) ?? "<computed>", sentence: text(sentence) ?? "<computed>" });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return out;
}

function scan(files: readonly Source[]): Scan {
  const parsed = files.map((f) => ({ f, sf: ts.createSourceFile(f.rel, f.text, ts.ScriptTarget.Latest, true) }));
  const constants = new Map<string, string>();
  const graph = new Map<string, Set<string>>();
  const literals = new Map<string, Set<string>>();
  const refusals = new Map<string, Refusal[]>();
  const opaque: string[] = [];
  const link = (name: string, refs: Set<string>): void => {
    const into = graph.get(name) ?? new Set<string>();
    for (const r of refs) into.add(r);
    graph.set(name, into);
  };
  for (const { sf } of parsed) {
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isStringLiteral(unwrap(n.initializer))) {
        constants.set(n.name.text, (unwrap(n.initializer) as ts.StringLiteral).text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  const text = (e: ts.Expression | undefined): string | null => {
    const u = e ? unwrap(e) : undefined;
    if (u && (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u))) return u.text;
    return u && ts.isIdentifier(u) ? (constants.get(u.text) ?? null) : null;
  };
  const record = (name: string, node: ts.Node): void => {
    const found = refusalsIn(node, text);
    if (found.length > 0) refusals.set(name, [...(refusals.get(name) ?? []), ...found]);
  };
  for (const { f, sf } of parsed) {
    const visit = (n: ts.Node): void => {
      if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) && n.name && n.body) {
        link(n.name.getText(sf), refsOf(n.body));
        record(n.name.getText(sf), n.body);
      }
      // A route's own `handler:` is read through its literal below, never as a node every
      // `route.handler(` call would reach.
      if ((ts.isVariableDeclaration(n) || ts.isPropertyAssignment(n)) && n.initializer && n.name.getText(sf) !== "handler"
        && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
        link(n.name.getText(sf), refsOf(n.initializer));
        record(n.name.getText(sf), n.initializer);
      }
      if (ts.isObjectLiteralExpression(n) && f.rel.startsWith(ROUTES_ROOT)) {
        const prop = (k: string) => n.properties.find((p) => p.name?.getText(sf) === k);
        const handler = prop("handler");
        if (prop("pattern") && handler) {
          const m = prop("method"), p = prop("pattern");
          const method = m && ts.isPropertyAssignment(m) ? text(m.initializer) : null;
          const pattern = p && ts.isPropertyAssignment(p) ? text(p.initializer) : null;
          const where = `${f.rel}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;
          if (method === null || pattern === null || !ts.isPropertyAssignment(handler)) opaque.push(where);
          else {
            const key = `${method} ${pattern}`;
            const into = literals.get(key) ?? new Set<string>();
            for (const r of refsOf(handler.initializer)) into.add(r);
            literals.set(key, into);
            record(key, handler.initializer);
          }
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return { literals, opaque, graph, refusals };
}

/** Every name a set of names reaches, through the graph, the set itself included. */
function closure(graph: Map<string, Set<string>>, from: Iterable<string>): Set<string> {
  const seen = new Set<string>(from);
  const queue = [...seen];
  while (queue.length > 0) {
    for (const next of graph.get(queue.pop()!) ?? []) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  return seen;
}

/** The primitives a set of names reaches, through the graph. */
function reached(graph: Map<string, Set<string>>, from: Iterable<string>): string[] {
  const seen = closure(graph, from);
  return PRIMITIVES.filter((p) => seen.has(p));
}

/** A path the client would send for a pattern: every `:param` as one id-shaped segment. */
const pathOf = (pattern: string): string => pattern.replace(/:[A-Za-z_]+/g, "00000000-0000-4000-8000-000000000000");
const allowed = (pattern: string) => ALLOW.find((a) => pathOf(pattern).startsWith(a.prefix));

interface Verdict { credential: Map<string, string>; refusals: string[]; unscanned: string[] }

function census(runtime: readonly RuntimeRoute[], s: Scan, mayRefresh: (path: string) => boolean): Verdict {
  const credential = new Map<string, string>();
  const unscanned: string[] = [];
  for (const r of runtime) {
    const key = `${r.method} ${r.pattern}`;
    const refs = s.literals.get(key);
    if (!refs) { unscanned.push(key); continue; }
    const why = [...(r.options?.credentialSubject === true ? ["credentialSubject"] : []), ...reached(s.graph, refs)];
    if (why.length > 0) credential.set(key, why.join(" "));
  }
  const refusals = [...credential].filter(([key]) => {
    const pattern = key.slice(key.indexOf(" ") + 1);
    return mayRefresh(pathOf(pattern)) && allowed(pattern) === undefined;
  }).map(([key, why]) => `${key} (${why})`);
  return { credential, refusals: refusals.sort(), unscanned: [...new Set(unscanned)].sort() };
}

/** Files under `apps/webapp/app` that name an ALLOW prefix in code, comments blanked. */
function webPresses(web: readonly Source[]): string[] {
  const hits: string[] = [];
  for (const f of web) {
    const code = withoutComments(f.text);
    for (const a of ALLOW) if (new RegExp(`["'\`]${a.prefix.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}`).test(code)) hits.push(`${f.rel} names ${a.prefix}`);
  }
  return hits;
}

/**
 * The `unauthorized` 401s every credential route outside ALLOW can construct, through the graph: a
 * refusal names the route, the function and the sentence; a session's sentence is admitted and
 * counted apart, so the reading of the filter is never zero.
 */
function verdictsAsSession(runtime: readonly RuntimeRoute[], s: Scan): { refusals: string[]; sessionHits: string[] } {
  const keys = [...census(runtime, s, () => true).credential.keys()].filter((k) => allowed(k.slice(k.indexOf(" ") + 1)) === undefined);
  const refusals = new Set<string>();
  const sessionHits = new Set<string>();
  for (const key of keys) {
    for (const fn of [key, ...closure(s.graph, s.literals.get(key) ?? [])]) {
      for (const r of s.refusals.get(fn) ?? []) {
        if (r.code !== "unauthorized") continue;
        const line = `${key} → ${fn === key ? "<handler>" : fn}: unauthorized "${r.sentence}"`;
        if (SESSION_SENTENCES.has(r.sentence)) sessionHits.add(line);
        else refusals.add(line);
      }
    }
  }
  return { refusals: [...refusals].sort(), sessionHits: [...sessionHits].sort() };
}

const RUNTIME: RuntimeRoute[] = [...apiRoutes, ...localRoutes, ...selfHostRoutes, ...desktopHostRoutes];
const SOURCES = SCAN_ROOTS.flatMap((r) => walk(r, [".ts"]));
const WEB = walk(WEB_ROOT, [".ts", ".tsx"]);
const SCAN = scan(SOURCES);

describe("every route that checks a factor or a single-use credential is never refreshed by the web", () => {
  it("the web refreshes none of them, and the scan read every mounted route", () => {
    const v = census(RUNTIME, SCAN, mayRefreshFor);
    expect(SCAN.opaque, "a route literal whose method, pattern or handler the scan cannot read").toEqual([]);
    expect(v.unscanned, "a mounted route the source scan never saw: its credential check is unread").toEqual([]);
    expect(v.refusals, "a credential route the web would refresh and re-send: add it to NEVER_REFRESH").toEqual([]);
  });

  it("the derivation reads non-zero, and the routes beside it stay refreshable", () => {
    const v = census(RUNTIME, SCAN, mayRefreshFor);
    for (const key of ["POST /auth/login", "POST /auth/step-up/totp", "POST /auth/step-up/webauthn/verify", "POST /pair/redeem",
      "POST /auth/2fa/totp/verify", "POST /auth/2fa/recovery-codes/verify", "POST /auth/refresh"]) {
      expect(v.credential.has(key), `${key} is not derived as a credential route`).toBe(true);
    }
    // Lapsed sessions on these must still recover: a mint, a step-up gated confirm, a read.
    for (const key of ["POST /pair", "POST /auth/desktop-link", "POST /auth/desktop-approval/:id/confirm", "GET /mailboxes"]) {
      expect(v.credential.has(key), `${key} checks no credential and was derived as one`).toBe(false);
      expect(mayRefreshFor(pathOf(key.slice(key.indexOf(" ") + 1))), `${key} no longer refreshes`).toBe(true);
    }
    for (const p of PRIMITIVES) {
      expect([...v.credential.values()].some((why) => why.split(" ").includes(p)), `no mounted route reaches ${p}`).toBe(true);
    }
  });

  it("ALLOW's reasons hold: each entry covers a credential route and the web names none of them", () => {
    const v = census(RUNTIME, SCAN, mayRefreshFor);
    for (const a of ALLOW) {
      expect([...v.credential.keys()].some((k) => allowed(k.slice(k.indexOf(" ") + 1)) === a), `${a.prefix} covers nothing`).toBe(true);
    }
    expect(webPresses(WEB), "the web presses a path ALLOW says it never presses").toEqual([]);
  });

  it("POSITIVE CONTROLS: a planted credential route is refused by each arm, and so is ALLOW's reason", () => {
    const plantSource: Source = {
      rel: `${ROUTES_ROOT}planted.ts`,
      text: `export const planted = [{ method: "POST", pattern: "/auth/confirm-by-code", relay: true, cost: "ceremony",
        handler: async (req, deps) => json(await auth(deps).stepUpTotp(serviceContext(deps, req), await readBody(req)), 200) },
        { method: "POST", pattern: "/auth/claim-by-link", relay: false, cost: "ceremony", handler: async () => json({}, 200) }];`,
    };
    const planted = scan([...SOURCES, plantSource]);
    const runtime: RuntimeRoute[] = [...RUNTIME, { method: "POST", pattern: "/auth/confirm-by-code" },
      { method: "POST", pattern: "/auth/claim-by-link", options: { credentialSubject: true } }];
    const real = new Set(census(RUNTIME, SCAN, mayRefreshFor).refusals);
    expect(census(runtime, planted, mayRefreshFor).refusals.filter((r) => !real.has(r))).toEqual([
      "POST /auth/claim-by-link (credentialSubject)",
      "POST /auth/confirm-by-code (throttleReserve verifyTotp)",
    ]);
    const everything = census(RUNTIME, SCAN, () => true);
    const covered = [...everything.credential.keys()].filter((k) => allowed(k.slice(k.indexOf(" ") + 1)) === undefined);
    expect(everything.refusals.length, "a client that refreshes everything read zero").toBe(covered.length);
    expect(covered.length).toBeGreaterThan(10);
    expect(census([...RUNTIME, { method: "POST", pattern: "/auth/unread" }], SCAN, mayRefreshFor).unscanned)
      .toEqual(["POST /auth/unread"]);
    const computed: Source = { rel: `${ROUTES_ROOT}computed.ts`, text: `export const c = [{ method: "POST", pattern: pathFor("x"), handler: h }];` };
    expect(scan([computed]).opaque).toEqual([`${ROUTES_ROOT}computed.ts:1`]);
    const pressing: Source = { rel: `${WEB_ROOT}/planted.ts`, text: `// "/oauth/token" in a comment is not a press\nexport const t = () => api("/oauth/token");` };
    expect(webPresses([pressing])).toEqual([`${WEB_ROOT}/planted.ts names /oauth/token`]);
    expect(webPresses([{ rel: `${WEB_ROOT}/quiet.ts`, text: `// api("/oauth/token")\nexport {};` }])).toEqual([]);
  });

  it("a credential route builds `unauthorized` only with a session's sentence: its verdicts are credential_refused", () => {
    const v = verdictsAsSession(RUNTIME, SCAN);
    expect(v.refusals, "a verdict built as `unauthorized` reads to every client as a lapsed session, and is renewed").toEqual([]);
    expect(v.sessionHits.some((h) => h.startsWith("POST /auth/step-up/totp → ")), "the session sentences read nothing").toBe(true);
    expect(CREDENTIAL_REFUSED, "the clients' code is the server's").toBe(SERVER_CREDENTIAL_REFUSED);
    expect(CREDENTIAL_REFUSED).not.toBe("unauthorized");
    // The login token's door is a credential route now that its peek is a primitive.
    expect(census(RUNTIME, SCAN, mayRefreshFor).credential.get("POST /auth/2fa/webauthn/assert/options")).toBe("peekLoginToken");
  });

  it("POSITIVE CONTROL: a planted verdict built as `unauthorized` is refused by route, function and sentence", () => {
    const plant: Source = {
      rel: `${ROUTES_ROOT}planted-verdict.ts`,
      text: `async function plantedVerify(b) { await throttleReserve(b); throw new ServiceError("unauthorized", 401, "two-factor verification failed"); }
async function plantedGate(b) { await throttleReserve(b); throw new ServiceError("unauthorized", 401, "no active session"); }
export const planted = [
  { method: "POST", pattern: "/auth/confirm-by-code", handler: async (req) => json(await plantedVerify(await readBody(req)), 200) },
  { method: "POST", pattern: "/auth/gate-by-code", handler: async (req) => json(await plantedGate(await readBody(req)), 200) },
];`,
    };
    const runtime: RuntimeRoute[] = [...RUNTIME, { method: "POST", pattern: "/auth/confirm-by-code" }, { method: "POST", pattern: "/auth/gate-by-code" }];
    const real = new Set(verdictsAsSession(RUNTIME, SCAN).refusals);
    expect(verdictsAsSession(runtime, scan([...SOURCES, plant])).refusals.filter((r) => !real.has(r)))
      .toEqual(['POST /auth/confirm-by-code → plantedVerify: unauthorized "two-factor verification failed"']);
  });
});

/**
 * THE SAME RULE IN EVERY CLIENT TRANSPORT. The phone, the paired browser and the desktop's Cloud
 * relay each renew and re-send on a 401, and each keeps its own list of routes where it must not.
 * The lists are not asked: each transport is DRIVEN over every derived credential route it can
 * reach, the route answering 401 and the refresh door minting, and a renewal means the credential
 * went out twice. The relay reaches what `RELAY_ALLOWLIST` forwards, and every ordinary route there
 * must still renew, two-step settings among them.
 */
const DOOR = "http://door.test";
const answer = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
type FetchFn = (url: string | URL | Request, init?: unknown) => Promise<Response>;
const pathIn = (url: string | URL | Request): string => String(url).split("?")[0]!.replace(DOOR, "");

/**
 * The first request is the route under test and is refused 401 with `code` in our envelope; a later
 * refresh mints. `code` is REQUIRED: with a default, the branch the default picks is the only one any
 * caller measures, and a client that renews on the other one reads as green.
 */
function door(code: string): { fetch: FetchFn; renewals: () => number } {
  let asked = 0;
  let renewals = 0;
  return {
    fetch: async (url) => {
      asked += 1;
      if (asked > 1 && pathIn(url).endsWith("/auth/refresh")) {
        renewals += 1;
        return answer(200, { tokens: { accessToken: `access-${renewals + 1}`, refreshToken: `refresh-${renewals + 1}`, expiresIn: 900 } });
      }
      return answer(401, { error: { code, message: "two-factor verification failed" } });
    },
    renewals: () => renewals,
  };
}

/** Every `/auth/refresh` mints; everything else is an older server's wrong-code answer. The order is kept. */
function pressDoor(): { fetch: FetchFn; paths: () => string[] } {
  const paths: string[] = [];
  return {
    fetch: async (url) => {
      paths.push(pathIn(url));
      if (pathIn(url).endsWith("/auth/refresh")) {
        return answer(200, { tokens: { accessToken: `access-${paths.length}`, refreshToken: `refresh-${paths.length}`, expiresIn: 900 } });
      }
      return answer(401, { error: { code: "unauthorized", message: "two-factor verification failed" } });
    },
    paths: () => [...paths],
  };
}

function jar(): Storage {
  const map = new Map<string, string>();
  return {
    get length() { return map.size; },
    clear: () => map.clear(),
    getItem: (k: string) => map.get(k) ?? null,
    key: (i: number) => [...map.keys()][i] ?? null,
    removeItem: (k: string) => void map.delete(k),
    setItem: (k: string, v: string) => void map.set(k, v),
  } as Storage;
}

const vault = () => ({ save: async () => "landed" as const, clear: async () => "landed" as const, armAttempt: async () => "landed" as const });

interface Transport {
  name: string;
  reaches: (method: string, path: string) => boolean;
  /** Drive one 401 carrying `code` at this route: did the transport renew and send it again? */
  renews: (method: string, path: string, code: string) => Promise<boolean>;
}

const TRANSPORTS: readonly Transport[] = [
  {
    name: "phone",
    reaches: () => true,
    renews: async (method, path, code) => {
      const d = door(code);
      const phone = new BearerManagerRN({ origin: DOOR, accessToken: "access-1", refreshToken: "refresh-1", vault: vault(), fetchImpl: d.fetch });
      await phone.fetch(`${DOOR}${path}`, { method });
      return d.renewals() > 0;
    },
  },
  {
    name: "host-client",
    reaches: () => true,
    renews: async (method, path, code) => {
      const d = door(code);
      const host = new BearerManager({ storage: jar(), fetchImpl: d.fetch });
      host.adopt({ accessToken: "access-1", refreshToken: "refresh-1" }, { fresh: true });
      await host.fetch(path, { method });
      return d.renewals() > 0;
    },
  },
  {
    name: "sidecar",
    reaches: (method, path) => mayRelay(method, path),
    renews: async (method, path, code) => {
      const d = door(code);
      const auth = createCloudAuth({ baseUrl: DOOR, tokens: { accessToken: "access-1", refreshToken: "refresh-1" }, fetchImpl: d.fetch as typeof fetch });
      try {
        await auth.authedFetch(path, { method });
      } finally {
        auth.stop();
      }
      return d.renewals() > 0;
    },
  },
];

/**
 * THE TWO MANAGERS THAT RENEW NOTHING AHEAD, pressed on a listed route: a cold one (no access token
 * held), one whose STATED window ran out, and one inside it. Every request is answered as an older
 * server answers a wrong code, so only a rotation BEFORE the press can make a correct code land.
 */
type Window = "cold" | "lapsed" | "fresh";
const T = Date.parse("2026-10-05T10:00:00.000Z");
const at = (ms: number): void => { vi.setSystemTime(T + ms); };

const PRESSERS: ReadonlyArray<{ name: string; press: (method: string, path: string, w: Window) => Promise<string[]> }> = [
  {
    name: "phone",
    press: async (method, path, w) => {
      const d = pressDoor();
      at(0);
      const phone = new BearerManagerRN({
        origin: DOOR, accessToken: w === "cold" ? null : "access-1", refreshToken: "refresh-1", vault: vault(), fetchImpl: d.fetch,
      });
      if (w !== "cold") await phone.adopt({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 });
      at(w === "lapsed" ? 16 * 60_000 : 60_000);
      await phone.fetch(`${DOOR}${path}`, { method });
      return d.paths();
    },
  },
  {
    name: "host-client",
    press: async (method, path, w) => {
      const d = pressDoor();
      at(0);
      const storage = jar();
      storage.setItem(REFRESH_STORAGE_KEY, "refresh-1");
      const host = new BearerManager({ storage, fetchImpl: d.fetch });
      if (w !== "cold") host.adopt({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 });
      at(w === "lapsed" ? 16 * 60_000 : 60_000);
      await host.fetch(path, { method });
      return d.paths();
    },
  },
];

const split = (key: string): [string, string] => [key.slice(0, key.indexOf(" ")), pathOf(key.slice(key.indexOf(" ") + 1))];

/**
 * ORDINARY ROUTES A LIST STILL TAKES, pinned and allowed only to shrink: the phone's and the paired
 * browser's prefixes cover these too, so a lapsed session's 401 there is handed back unrenewed. None
 * is pressed today. A route that starts renewing is refused as stale here; one that stops is refused
 * as a list grown over an ordinary route.
 */
const LIST_TAKES: readonly string[] = [
  // Two-step settings and the step-up options: the `/auth/2fa/` and `/auth/step-up/` prefixes.
  "DELETE /auth/2fa/totp", "POST /auth/2fa/recovery-codes", "POST /auth/2fa/totp/enroll",
  "POST /auth/2fa/webauthn/register/options", "POST /auth/step-up/webauthn/options",
  // The address-verification resend, under `/auth/verify-email`.
  "POST /auth/verify-email/resend",
  // The staff console's own routes, under `/admin/staff/`: its proxy alone presses them.
  "POST /admin/staff/sign-out", "POST /admin/staff/totp/begin", "POST /admin/staff/totp/reset", "POST /admin/staff/whoami",
  "POST /admin/staff/list",
  // The web's cookie sign-out door, under `/auth/refresh`.
  "POST /auth/refresh/logout",
];
const OVER_COVERED: Readonly<Record<string, readonly string[]>> = {
  "phone": [...LIST_TAKES].sort(),
  "host-client": [...LIST_TAKES].sort(),
  "sidecar": [],
};

/** Every mounted route, once per method and pattern. */
const MOUNTED: readonly string[] = [...new Set(RUNTIME.map((r) => `${r.method} ${r.pattern}`))].sort();

describe("no client transport renews and re-sends a route whose 401 is an answer", () => {
  it("the phone, the paired browser and the Cloud relay renew none they can reach: by the code, and by the list for an older server", async () => {
    const keys = [...census(RUNTIME, SCAN, mayRefreshFor).credential.keys()].sort();
    // `credential_refused` is the code read first; `unauthorized` is the OLD-SERVER BELT CONTROL, a
    // server that names no verdict, where only the transport's path list stops the second send.
    for (const code of [CREDENTIAL_REFUSED, "unauthorized"]) {
      const renewed: Record<string, string[]> = {};
      for (const t of TRANSPORTS) {
        const reached = keys.filter((k) => t.reaches(...split(k)));
        expect(reached.length, `${t.name} reaches no credential route: its arm reads nothing`).toBeGreaterThan(0);
        renewed[t.name] = [];
        for (const k of reached) if (await t.renews(...split(k), code)) renewed[t.name]!.push(k);
      }
      expect(renewed, `${code}: a transport renews a credential route's 401 and sends it again`)
        .toEqual(Object.fromEntries(TRANSPORTS.map((t) => [t.name, []])));
    }
  });

  it("THE CODE IS READ FIRST: credential_refused is renewed nowhere, even on a route no list names; a session's 401 still renews", async () => {
    for (const t of TRANSPORTS) {
      for (const [method, path] of [["POST", "/auth/confirm-by-code"], ["GET", "/mailboxes"]] as const) {
        expect(await t.renews(method, path, CREDENTIAL_REFUSED), `${t.name}: ${method} ${path} renewed a credential verdict`).toBe(false);
        expect(await t.renews(method, path, "unauthorized"), `${t.name}: ${method} ${path} no longer renews a lapsed session`).toBe(true);
      }
      expect(await t.renews("POST", "/auth/step-up/totp", "unauthorized"), `${t.name}: the listed route renewed`).toBe(false);
    }
    expect(isRecoverable(401, CREDENTIAL_REFUSED), "the web retries a credential verdict").toBe(false);
    expect(isRecoverable(401, "unauthorized")).toBe(true);
    expect(isRecoverable(401)).toBe(true);
  });

  it("a press on a listed route with a lapsed window rotates FIRST and sends ONCE; inside the window it rotates nothing", async () => {
    const listed = [...census(RUNTIME, SCAN, mayRefreshFor).credential.keys()].sort();
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      for (const p of PRESSERS) {
        for (const key of listed) {
          const [method, path] = split(key);
          for (const w of ["cold", "lapsed"] as const) {
            expect(await p.press(method, path, w), `${p.name} ${w}: ${key}`).toEqual(["/auth/refresh", path]);
          }
          expect(await p.press(method, path, "fresh"), `${p.name} fresh: ${key}`).toEqual([path]);
        }
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("POSITIVE CONTROLS: every ordinary route each transport reaches still renews, but the pinned few; a credential route no list names is read", async () => {
    const credential = new Set(census(RUNTIME, SCAN, mayRefreshFor).credential.keys());
    const ordinary = MOUNTED.filter((k) => !credential.has(k));
    expect(ordinary.length).toBeGreaterThan(100);
    const stuck: Record<string, string[]> = {};
    for (const t of TRANSPORTS) {
      const reached = ordinary.filter((k) => t.reaches(...split(k)));
      expect(reached.length, `${t.name} reaches no ordinary route`).toBeGreaterThan(t.name === "sidecar" ? 100 : 200);
      stuck[t.name] = [];
      for (const k of reached) if (!(await t.renews(...split(k), "unauthorized"))) stuck[t.name]!.push(k);
      expect(await t.renews("POST", "/auth/confirm-by-code", "unauthorized"), `${t.name}: an unlisted credential route reads as not renewed`).toBe(true);
    }
    expect(stuck, "an ordinary route a transport no longer renews (or a pinned one that renews again)").toEqual(OVER_COVERED);
    // The phone's sign-out rides the renewal on purpose: a cold launch sends it with no access token.
    expect(await TRANSPORTS[0]!.renews("POST", "/auth/logout", "unauthorized"), "the phone's sign-out no longer renews").toBe(true);
    const relay = TRANSPORTS.find((t) => t.name === "sidecar")!;
    expect(RELAY_ALLOWLIST.filter((r) => !credential.has(`${r.method} ${r.pattern}`)).every((r) => relay.reaches(r.method, pathOf(r.pattern))))
      .toBe(true);
  });
});

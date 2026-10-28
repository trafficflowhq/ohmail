import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, csrfTokenFor, ERASED_ANSWER_HEADER, type ApiDeps } from "@trafficflow/api";
import { refreshTokens } from "@trafficflow/db";
import { generateToken, hashToken } from "@trafficflow/services";
import * as scan from "../../../scripts/lib/source-scan.mjs";
import {
  makeDeps, seedSession, seedSessionFor, seedMessage, seedBody, req, setCookieMap, cookieMaxAge, FIXED_NOW,
} from "./helpers.js";
import { PNG_2X3 } from "../../core/test/fixtures/images.js";

/* @reads: packages/api/src/
   The census walks the package's source by a path built at runtime. */

/**
 * A RESPONSE THAT ENDS A BROWSER SESSION EMPTIES THE JAR AND NEVER CARRIES `Clear-Site-Data`.
 * Chrome holds an answer carrying it, cookie clears included, until it has walked its whole disk
 * cache: the resume splash waited on the refresh door's refusal, the sign-out press on its door's
 * answer, the erase on its receipt. The HTTP cache still goes, a proxied picture is kept a day in
 * it (`routes/privacy.ts`): the browser asks for the clear on its own (`x-ohmail-clear: cache`)
 * once it holds the answer, and nothing waits for that. Driven over the real route table; the
 * census below holds every jar-emptying call to one of the two helpers.
 */

const app = createApp(apiRoutes);
const H = (r: Request, d: ApiDeps): Promise<Response> => app.handle(r, { ...d, session: null, idempotency: null });
const CLEARS = "clear-site-data";
const PURGE = { "x-ohmail-clear": "cache" };
const SESSION_COOKIES = ["tf_session", "tf_refresh", "tf_csrf", "tf_resume", "tf_owner"];

/** The cookie jar a signed-in browser presents, CSRF header included. */
function browser(token: string): { cookie: string; headers: Record<string, string> } {
  return { cookie: `tf_session=${token}; tf_csrf=${csrfTokenFor(token)}`, headers: { "x-csrf-token": csrfTokenFor(token) } };
}

async function seedRefresh(
  db: Awaited<ReturnType<typeof makeDeps>>["db"],
  s: { accountId: string; userId: string; sessionId: string },
): Promise<string> {
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: randomUUID(),
    tokenHash: hashToken(refresh), expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
  });
  return refresh;
}

/** The whole jar cleared, and nothing a browser would hold the answer for. */
function expectSessionEnded(res: Response, what: string): void {
  for (const name of SESSION_COOKIES) expect(cookieMaxAge(res, name), `${what}: ${name} is cleared`).toBe(0);
  expect(res.headers.get(CLEARS), `${what}: a cache clear holds this answer in Chrome`).toBeNull();
}

/** The clear asked for alone: 202, the header, no body, no cookie. */
async function expectPurged(res: Response, what: string): Promise<void> {
  expect(res.status, what).toBe(202);
  expect(res.headers.get(CLEARS), what).toBe('"cache"');
  expect(res.headers.get("cache-control"), what).toBe("no-store");
  expect(res.headers.getSetCookie(), `${what}: the purge sets no cookie`).toEqual([]);
  expect(await res.text(), what).toBe("");
}

describe("every response that ends a browser session empties the jar, and none is held for a cache walk", () => {
  it("the sign-out", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const res = await H(req("POST", "/auth/logout", browser(s.token)), deps);
    expect(res.status).toBe(204);
    expectSessionEnded(res, "POST /auth/logout");
  });

  it("the web's sign-out door, its 204 and its own 401 alike; the cache goes at the purge after them", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const jar = browser(s.token);
    const ended = await H(req("POST", "/auth/refresh/logout", { ...jar, cookie: `${jar.cookie}; tf_refresh=${refresh}` }), deps);
    expect(ended.status).toBe(204);
    expectSessionEnded(ended, "the door's 204");
    const named = await H(req("POST", "/auth/refresh/logout"), deps);
    expect(named.status).toBe(401);
    expectSessionEnded(named, "the door's 401");
    await expectPurged(await H(req("POST", "/auth/refresh", { headers: PURGE }), deps), "the purge after the sign-out");
  });

  it("the erase", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const res = await H(req("DELETE", "/account", browser(s.token)), deps);
    expect(res.status).toBe(200);
    expectSessionEnded(res, "DELETE /account");
  });

  /**
   * SIGNED OUT ELSEWHERE. Another session signs every device out; this browser's next request
   * answers 401 with the cache kept — that 401 also answers a live session whose access token
   * another tab just rotated — and its refresh, refused, is where the session is found gone. The
   * refusal clears the jar at once; the cache goes at the purge the browser sends after it.
   */
  it("a session revoked from another device is told at its refused refresh, and its cache goes at the purge", async () => {
    const { db, deps } = await makeDeps();
    const here = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, here);
    const elsewhere = await seedSessionFor(db, {
      accountId: here.accountId, userId: here.userId, now: FIXED_NOW, lastTwofaAt: FIXED_NOW,
    });
    const all = await H(req("POST", "/auth/logout", { bearer: elsewhere.token, body: JSON.stringify({ allDevices: true }) }), deps);
    expect(all.status).toBe(204);
    expectSessionEnded(all, "the device that signed everybody out, its own session included");

    const next = await H(req("GET", "/auth/session", { cookie: `tf_session=${here.token}` }), deps);
    expect(next.status).toBe(401);
    expect(next.headers.get(CLEARS), "a 401 the client may still recover from keeps the cache").toBeNull();

    const refused = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }), deps);
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: { code: string } }).error.code).toBe("refresh_revoked");
    expectSessionEnded(refused, "the refused refresh");
    await expectPurged(await H(req("POST", "/auth/refresh", { headers: PURGE }), deps), "the purge after it");
  });

  it("an erased account's refresh is told so at once, with no cache clear on the answer", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW, lastTwofaAt: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    expect((await H(req("DELETE", "/account", { bearer: s.token }), deps)).status).toBe(200);
    const erased = await H(req("POST", "/auth/refresh", {
      cookie: `tf_refresh=${refresh}`, headers: { [ERASED_ANSWER_HEADER]: "account_erased" }, body: "{}",
    }), deps);
    expect(erased.status).toBe(410);
    expect(((await erased.json()) as { error: { code: string } }).error.code).toBe("account_erased");
    expectSessionEnded(erased, "the erased account's refresh");
  });

  it("the purge reads no jar: a live session is neither rotated nor ended, and no cookie is set", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const jar = browser(s.token);
    await expectPurged(await H(req("POST", "/auth/refresh", {
      cookie: `${jar.cookie}; tf_refresh=${refresh}`, headers: { ...jar.headers, ...PURGE },
    }), deps), "a purge with a live jar");
    const [row] = await db.select({ consumedAt: refreshTokens.consumedAt, revokedAt: refreshTokens.revokedAt })
      .from(refreshTokens).where(eq(refreshTokens.tokenHash, hashToken(refresh)));
    expect(row?.consumedAt, "the purge rotated the refresh token").toBeNull();
    expect(row?.revokedAt, "the purge ended the family").toBeNull();
    // The same jar still renews: nothing the purge did reached the session.
    expect((await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }), deps)).status).toBe(204);
  });

  it("a bearer-only host has no browser cache to clear: the purge is the door's own refusal there", async () => {
    const { deps } = await makeDeps();
    const res = await H(req("POST", "/auth/refresh", { headers: PURGE }), { ...deps, allowCookieAuth: false });
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("refresh_missing");
    expect(res.headers.get(CLEARS)).toBeNull();
    expect(res.headers.getSetCookie()).toEqual([]);
  });

  it("a response that keeps the session keeps the cache (positive controls)", async () => {
    const { db, deps } = await makeDeps();
    const rotating = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, rotating);
    const rotated = await H(req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }), deps);
    expect(rotated.status).toBe(204);
    expect(setCookieMap(rotated).tf_session, "the rotation sets a session").toBeTruthy();
    expect(rotated.headers.get(CLEARS)).toBeNull();
    const s = await seedSession(db, { now: FIXED_NOW });
    const session = await H(req("GET", "/auth/session", { cookie: `tf_session=${s.token}` }), deps);
    expect(session.status).toBe(200);
    expect(session.headers.get(CLEARS)).toBeNull();
    // A host that takes no cookies ends a bearer's session with nothing to clear.
    const bearerOnly = { ...deps, allowCookieAuth: false };
    const out = await H(req("POST", "/auth/logout", { bearer: s.token }), bearerOnly);
    expect(out.status).toBe(204);
    expect(out.headers.getSetCookie()).toEqual([]);
    expect(out.headers.get(CLEARS)).toBeNull();
  });

  it("a proxied picture carries no validator a stale copy could be revalidated by", async () => {
    const remote = { async fetch() { return { status: 200, contentType: "image/png", body: PNG_2X3 }; } };
    const { db, deps } = await makeDeps(FIXED_NOW, {}, { remote });
    const s = await seedSession(db, { now: FIXED_NOW });
    const { id } = await seedMessage(db, { accountId: s.accountId, folder: "INBOX" });
    await seedBody(db, { messageId: id, html: "<img>", loadedRemoteContent: true });
    const u = encodeURIComponent("https://images.acme-cdn.com/hero.png");
    const res = await H(req("GET", `/img?mid=${id}&u=${u}`, { bearer: s.token }), deps);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(res.headers.get("etag")).toBeNull();
    expect(res.headers.get("last-modified")).toBeNull();
    // `Vary: Cookie`, by ruling (IMG-CACHE-KEPT-WHERE-CLEAR-SITE-DATA-IS-IGNORED): the jar changes at
    // every refresh, so the day becomes fifteen minutes, and a browser that ignores Clear-Site-Data
    // can no longer hand the next session a picture it was shown in this one.
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get(CLEARS)).toBeNull();
  });
});

describe("neither helper ever carries the clear", () => {
  it("sessionEnded never carries the clear, whatever the cookies; status, body and cookies kept", async () => {
    const { sessionEnded } = await import("../src/session-end.js");
    const with_ = (...cookies: string[]): Response => {
      const h = new Headers();
      for (const c of cookies) h.append("Set-Cookie", c);
      return new Response(null, { status: 204, headers: h });
    };
    const stamped = (r: Response) => sessionEnded(r).headers.get(CLEARS);
    expect(stamped(with_("tf_session=; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=0"))).toBeNull();
    expect(stamped(with_("tf_session=abc; HttpOnly; Path=/; Max-Age=900"))).toBeNull();
    expect(stamped(with_("tf_csrf=; Path=/; Max-Age=0"))).toBeNull();
    expect(stamped(with_("tf_session=; Path=/; Max-Age=00"))).toBeNull();
    expect(stamped(with_())).toBeNull();
    const h = new Headers({ "Content-Type": "application/json", "Clear-Site-Data": '"cache"' });
    h.append("Set-Cookie", "tf_session=; Path=/; Max-Age=0");
    h.append("Set-Cookie", "tf_csrf=; Path=/; Max-Age=0");
    const kept = sessionEnded(new Response('{"erased":true}', { status: 200, headers: h }));
    expect(kept.status).toBe(200);
    expect(kept.headers.get(CLEARS), "a clear the answer already carried").toBeNull();
    expect(kept.headers.getSetCookie(), "the cookies ride through unchanged")
      .toEqual(["tf_session=; Path=/; Max-Age=0", "tf_csrf=; Path=/; Max-Age=0"]);
    expect(await kept.text()).toBe('{"erased":true}');
  });

  it("a refusal keeps its cookies, status and body, and never carries the clear", async () => {
    const { sessionRefused } = await import("../src/session-end.js");
    const h = new Headers({ "Content-Type": "application/json", "Clear-Site-Data": '"cache"' });
    h.append("Set-Cookie", "tf_session=; Path=/; Max-Age=0");
    h.append("Set-Cookie", "tf_csrf=; Path=/; Max-Age=0");
    const refused = sessionRefused(new Response('{"error":{"code":"refresh_revoked"}}', { status: 401, headers: h }));
    expect(refused.status).toBe(401);
    expect(refused.headers.get(CLEARS)).toBeNull();
    expect(refused.headers.getSetCookie()).toEqual(["tf_session=; Path=/; Max-Age=0", "tf_csrf=; Path=/; Max-Age=0"]);
    expect(await refused.text()).toBe('{"error":{"code":"refresh_revoked"}}');
  });
});

/* ── THE CENSUS: the jar is emptied only inside `sessionEnded(` or `sessionRefused(` ─────────── */

const SRC = join(import.meta.dirname, "..", "src");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

type Helper = "sessionEnded" | "sessionRefused";

/** Every `clearSessionCookies(` call outside its definition, and which helper encloses it, if any. */
function clearingCalls(files: Array<{ path: string; text: string }>): Array<{ at: string; wrapped: Helper | null }> {
  const out: Array<{ at: string; wrapped: Helper | null }> = [];
  for (const f of files) {
    const code = scan.withoutCommentsAndLiterals(f.text);
    const spans = [...code.matchAll(/\b(sessionEnded|sessionRefused)\s*\(/g)]
      .map((m) => ({ helper: m[1] as Helper, span: scan.bracketSpan(code, m.index! + m[0].length - 1) }))
      .filter((s) => s.span.closed);
    for (const m of code.matchAll(/\bclearSessionCookies\s*\(/g)) {
      if (/function\s+$/.test(code.slice(Math.max(0, m.index! - 16), m.index!))) continue;
      out.push({
        at: `${relative(SRC, f.path)}:${scan.lineOf(code, m.index!)}`,
        wrapped: spans.find((s) => s.span.start <= m.index! && m.index! < s.span.end)?.helper ?? null,
      });
    }
  }
  return out;
}

describe("census — every response that empties the jar goes through a helper", () => {
  const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("the six jar-emptying calls: four end a session, the refresh door's two refuse one", () => {
    const calls = clearingCalls(files);
    const by = (helper: Helper | null): string[] => calls.filter((c) => c.wrapped === helper).map((c) => c.at.replace(/:\d+$/, "")).sort();
    // Sign-out, the erase, and the web's sign-out door (its 204 and its own 401): the browser purges
    // once it holds the answer.
    expect(by("sessionEnded")).toEqual([
      "routes/account.ts", "routes/session-lifecycle.ts", "routes/session-lifecycle.ts", "routes/session-lifecycle.ts",
    ]);
    // The refused refresh and the erased account's refresh (its 410): the browser purges on its own too.
    expect(by("sessionRefused")).toEqual(["routes/session-lifecycle.ts", "routes/session-lifecycle.ts"]);
    expect(by(null), "a response that empties the jar through neither helper").toEqual([]);
  });

  it("…and a planted route that empties the jar without either reads red (control)", () => {
    const bare = { path: join(SRC, "routes", "planted.ts"), text: "export const h = () => noContent(clearSessionCookies());\n" };
    const wrapped = { path: join(SRC, "routes", "planted2.ts"), text: "export const h = () => sessionEnded(noContent(clearSessionCookies()));\n" };
    const refused = { path: join(SRC, "routes", "planted3.ts"), text: "export const h = () => sessionRefused(noContent(clearSessionCookies()));\n" };
    const calls = clearingCalls([bare, wrapped, refused]);
    expect(calls.filter((c) => c.wrapped === null).map((c) => c.at)).toEqual(["routes/planted.ts:1"]);
    expect(calls.find((c) => c.at === "routes/planted2.ts:1")?.wrapped).toBe("sessionEnded");
    expect(calls.find((c) => c.at === "routes/planted3.ts:1")?.wrapped).toBe("sessionRefused");
  });
});

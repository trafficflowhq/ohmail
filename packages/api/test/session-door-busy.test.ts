import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { createApp, apiRoutes, withSessionAcquireCeiling } from "@trafficflow/api";
import { DbAcquireTimeoutError } from "@trafficflow/db/cloud";
import { refreshTokens } from "@trafficflow/db";
import { generateToken, hashToken } from "@trafficflow/services";
// ONE scanner, left to right over strings, templates and both comment forms.
import * as scan from "../../../scripts/lib/source-scan.mjs";
import { makeDeps, req, seedSession, FIXED_NOW } from "./helpers.js";

/* @reads: packages/api/src/
   Walks the package's source by a path built at runtime, so no landing pass selects this file when
   a door there moves; the shape `reads-list.mjs` exists for. */

/**
 * A BUSY DATABASE IS A RETRY, NEVER A SIGN-OUT. The session doors answer a starved pool with
 * 503 `db_busy`, `Retry-After` and no `Set-Cookie`, on the host's shorter-ceiling handle; and no
 * fault arm in this package can reach a path that clears the jar. The sign-out door joined them: on
 * the write ceiling a starved pool held it past the client's 10 s deadline, the sign-out went
 * unconfirmed and the browser was left marked pending. The behaviour is driven through the real
 * route table; the census below it reads the source, with a planted control for each half so a
 * census that stopped seeing anything would say so.
 */

/** A handle whose every access throws the pool's refusal — the shape a saturated pool presents. */
const busyHandle = (): never => new Proxy({}, {
  get() { throw new DbAcquireTimeoutError(5_000); },
}) as never;

async function seedRefresh(
  db: Awaited<ReturnType<typeof makeDeps>>["db"],
  s: { accountId: string; userId: string; sessionId: string },
): Promise<string> {
  const refresh = generateToken();
  await db.insert(refreshTokens).values({
    accountId: s.accountId, userId: s.userId, sessionId: s.sessionId, familyId: randomUUID(),
    tokenHash: hashToken(refresh),
    expiresAt: new Date(FIXED_NOW.getTime() + 2 * 60 * 60 * 1000),
  });
  return refresh;
}

const app = createApp(apiRoutes);

describe("the session doors under a busy pool", () => {
  it("exactly the three session doors carry the shorter ceiling, the sign-out door among them", () => {
    const carrying = apiRoutes
      .filter((r) => (r.options?.middleware ?? []).includes(withSessionAcquireCeiling))
      .map((r) => `${r.method} ${r.pattern}`)
      .sort();
    expect(carrying).toEqual(["GET /auth/session", "POST /auth/refresh", "POST /auth/refresh/logout"]);
  });

  it("the sign-out door answers 503 db_busy, Retry-After, sets no cookie, and ends the family on the next ask", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    let asked = 0;
    const busy = await app.handle(
      req("POST", "/auth/refresh/logout", { cookie: `tf_refresh=${refresh}` }),
      { ...deps, sessionDb: () => { asked++; return busyHandle(); } },
    );
    expect(asked, "the sign-out door must ask the host for its session handle").toBe(1);
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("5");
    expect(busy.headers.getSetCookie(), "a fault must never clear the token the retry presents").toEqual([]);
    expect(((await busy.json()) as { error: { code: string } }).error.code).toBe("db_busy");
    const [row] = await db.select({ revokedAt: refreshTokens.revokedAt }).from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, hashToken(refresh)));
    expect(row?.revokedAt, "a refused door ended the family anyway").toBeNull();
    // The pool frees: the same jar's next ask ends it and clears the jar.
    const done = await app.handle(req("POST", "/auth/refresh/logout", { cookie: `tf_refresh=${refresh}` }), deps);
    expect(done.status).toBe(204);
    expect(done.headers.getSetCookie().some((c) => /^tf_refresh=;/.test(c))).toBe(true);
  });

  it("GET /auth/session answers 503 db_busy, Retry-After, retryable, and sets no cookie", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    let asked = 0;
    const res = await app.handle(
      req("GET", "/auth/session", { bearer: s.token }),
      { ...deps, sessionDb: () => { asked++; return busyHandle(); } },
    );
    expect(asked, "the door must ask the host for its session handle").toBe(1);
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.getSetCookie()).toEqual([]);
    const body = await res.json() as { error: { code: string; retryable?: boolean } };
    expect(body.error).toMatchObject({ code: "db_busy", retryable: true });
  });

  it("the cookie refresh answers 503 db_busy with the jar untouched", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const res = await app.handle(
      req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }),
      { ...deps, sessionDb: busyHandle },
    );
    expect(res.status).toBe(503);
    expect(res.headers.get("Retry-After")).toBe("5");
    expect(res.headers.getSetCookie(), "a fault must never clear the browser's only token").toEqual([]);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("db_busy");
    // The token the server still honours rotates on the next attempt, once the pool frees.
    const retry = await app.handle(
      req("POST", "/auth/refresh", { cookie: `tf_refresh=${refresh}`, body: "{}" }), deps,
    );
    expect(retry.status).toBe(204);
  });

  it("the native refresh answers 503 db_busy too, and the token still rotates afterwards", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    const refresh = await seedRefresh(db, s);
    const body = JSON.stringify({ refreshToken: refresh, attemptId: randomUUID() });
    const busy = await app.handle(req("POST", "/auth/refresh", { body }), { ...deps, sessionDb: busyHandle });
    expect(busy.status).toBe(503);
    expect(busy.headers.get("Retry-After")).toBe("5");
    const ok = await app.handle(req("POST", "/auth/refresh", { body }), deps);
    expect(ok.status).toBe(200);
  });

  it("a host without the port keeps its handle — the door answers from `db`", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    expect(deps.sessionDb).toBeUndefined();
    const res = await app.handle(req("GET", "/auth/session", { bearer: s.token }), deps);
    expect(res.status).toBe(200);
  });

  it("no other route asks for the session handle", async () => {
    const { db, deps } = await makeDeps();
    const s = await seedSession(db, { now: FIXED_NOW });
    let asked = 0;
    const res = await app.handle(
      req("GET", "/mailboxes", { bearer: s.token }),
      { ...deps, sessionDb: () => { asked++; return busyHandle(); } },
    );
    expect(res.status).toBe(200);
    expect(asked).toBe(0);
  });
});

/* ── THE CENSUS: no fault arm reaches a session-clearing path ─────────────────────────────── */

const SRC = join(import.meta.dirname, "..", "src");
const CLEARING = /\b(?:clearSessionCookies|clearResumeCookie|sessionCookies|enrollmentCookies)\s*\(|set-cookie/i;

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : p.endsWith(".ts") ? [p] : [];
  });
}

/** The text of `export const <name>` up to the next top-level `export`, comments blanked. */
function exportedBody(src: string, name: string): string {
  const text = scan.withoutComments(src);
  const at = text.indexOf(`export const ${name}`);
  if (at === -1) return "";
  const next = text.indexOf("\nexport ", at + 1);
  return text.slice(at, next === -1 ? text.length : next);
}

/** Every jar-clearing CALL in `packages/api/src`, as `file:line` and its line's text. */
function clearingCalls(files: Array<{ path: string; text: string }>): Array<{ at: string; line: string }> {
  const out: Array<{ at: string; line: string }> = [];
  for (const f of files) {
    const text = scan.withoutComments(f.text);
    for (const m of text.matchAll(/\b(?:clearSessionCookies|clearResumeCookie)\s*\(/g)) {
      const before = text.slice(Math.max(0, m.index! - 16), m.index!);
      if (/function\s+$/.test(before)) continue;            // the definition in cookies.ts
      const n = scan.lineOf(text, m.index!);
      out.push({ at: `${relative(SRC, f.path)}:${n}`, line: f.text.split("\n")[n - 1]!.trim() });
    }
  }
  return out;
}

describe("census — a fault never reaches a session-clearing path", () => {
  const files = sources(SRC).map((path) => ({ path, text: readFileSync(path, "utf8") }));
  const middleware = readFileSync(join(SRC, "middleware.ts"), "utf8");

  it("the error envelope's fault arms answer without a cookie", () => {
    const envelope = exportedBody(middleware, "withErrorEnvelope");
    expect(envelope.length, "the envelope must be found, or this reads nothing").toBeGreaterThan(500);
    expect(envelope).toMatch(/isDbBusy\(err\)/);
    expect(CLEARING.test(envelope)).toBe(false);
  });

  it("…and the check reads RED on an envelope that clears the jar (positive control)", () => {
    const planted = middleware.replace(
      "return dbBusyResponse(req, {", "clearSessionCookies(); return dbBusyResponse(req, {",
    );
    expect(planted).not.toBe(middleware);
    expect(CLEARING.test(exportedBody(planted, "withErrorEnvelope"))).toBe(true);
  });

  it("the jar is cleared in these places only, none of them a fault", () => {
    const calls = clearingCalls(files);
    // Logout and the account erase clear after the service call returned; a throw skips them.
    // The refresh door clears only on the coded 401 its classifier names `session_refused` — and
    // on the erased account's 410, which is that same refusal told apart (the case below) — and
    // the resume marker alone on the coded 401 `refresh_missing`. The sign-out door clears on its
    // 204 after the call returned and on that same refusal, every other failure rethrown first
    // (driven in `sign-out-door.test.ts`). `cookies.ts` is the composition: the whole clear, and
    // the enrollment mint's expiry of an earlier family, which only a minted session answers with.
    expect(calls.map((c) => c.at.replace(/:\d+$/, "")).sort()).toEqual([
      "cookies.ts", "cookies.ts", "routes/account.ts", "routes/session-lifecycle.ts",
      "routes/session-lifecycle.ts", "routes/session-lifecycle.ts", "routes/session-lifecycle.ts",
      "routes/session-lifecycle.ts", "routes/session-lifecycle.ts",
    ]);
    const refresh = calls.filter((c) => c.line.includes("failure"));
    expect(refresh.map((c) => c.line)).toEqual([
      'failure === "session_refused" ? clearSessionCookies() : [],',
    ]);
  });

  it("…and a fourth call anywhere is counted (positive control)", () => {
    const planted = [...files, { path: join(SRC, "planted.ts"), text: "export const x = () => clearSessionCookies();\n" }];
    expect(clearingCalls(planted).map((c) => c.at)).toContain("planted.ts:1");
  });

  it("the refresh door rethrows a fault BEFORE its refusal arm can clear anything", () => {
    const text = scan.withoutComments(readFileSync(join(SRC, "routes", "session-lifecycle.ts"), "utf8"));
    const rethrow = text.indexOf('if (failure === "fault") throw err;');
    const clear = text.indexOf('failure === "session_refused" ? clearSessionCookies()');
    expect(rethrow).toBeGreaterThan(-1);
    expect(clear).toBeGreaterThan(rethrow);
    // The erased account's arm is the same refusal, asked after the same rethrow.
    const erased = text.indexOf('if (failure === "session_refused" && await erasedAccountBearer(req, deps, cookieRefresh))');
    expect(erased).toBeGreaterThan(rethrow);
    expect(text.indexOf("clearSessionCookies()", erased)).toBeLessThan(clear);
    const marker = text.indexOf("clearResumeCookie()");
    expect(text.slice(Math.max(0, marker - 220), marker), "the marker clear is not gated on the coded refusal")
      .toMatch(/err\.code === "refresh_missing"/);
  });
});

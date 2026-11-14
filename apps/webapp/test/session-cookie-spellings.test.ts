/** @vitest-environment jsdom */
/**
 * EVERY WEB READER OF A SESSION COOKIE TAKES BOTH SPELLINGS. The server still writes the bare names;
 * a later release writes `__Host-` names, which the browser accepts only from this host without
 * `Domain=`, so no sibling host can plant them. Readers learn both first, the prefixed one winning.
 * One reader (`shell/cookie-jar.ts`), a real route through it, and a census for the rest.
 */
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

process.env.NEXT_PUBLIC_API_BASE = "/api";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const A = "0b7e3a52-5d2b-4c7e-9a41-2f1d6c8e9a01";
const B = "7c1d9e40-3b6a-4f2e-8d15-9e0a4b7c2d33";

function stubCookie(value: string): void {
  Object.defineProperty(document, "cookie", { configurable: true, get: () => value, set: () => {} });
}
afterEach(() => { Reflect.deleteProperty(document, "cookie"); });

describe("the one reader", () => {
  it("prefers __Host-, falls back to the bare name, and answers null for neither", async () => {
    const { cookieFromJar, cookieFromStore } = await import("@ohmail/app-logic/storage/cookie-jar");
    expect(cookieFromJar(`tf_session=old; __Host-tf_session=new`, "tf_session")).toBe("new");
    expect(cookieFromJar(`__Host-tf_session=new; tf_session=old`, "tf_session")).toBe("new");
    expect(cookieFromJar(`x=1; tf_session=old`, "tf_session")).toBe("old");
    expect(cookieFromJar(`tf_sessionx=no`, "tf_session")).toBeNull();
    const store = new Map([["tf_owner", { value: "bare" }], ["__Host-tf_owner", { value: "hosted" }]]);
    expect(cookieFromStore(store, "tf_owner")).toBe("hosted");
    expect(cookieFromStore(new Map([["tf_owner", { value: "bare" }]]), "tf_owner")).toBe("bare");
  });

  it("the CSRF echo and the storage-owner marker read the __Host- spelling", async () => {
    stubCookie(`tf_csrf=bare; __Host-tf_csrf=hosted`);
    const { csrfToken } = await import("../app/csrf.js");
    expect(csrfToken()).toBe("hosted");
    const { readOwner } = await import("@ohmail/app-logic/storage/owner-cookie");
    expect(readOwner(`tf_owner=${B}; __Host-tf_owner=${A}`)).toBe(A);
    expect(readOwner(`tf_owner=${B}`), "control: the bare marker still reads").toBe(B);
  });

  it("the account-page door sees a __Host- session: a prefetch answers 204, not the sign-in redirect", async () => {
    const { GET } = await import("../app/(product)/account/manage/route.js");
    const ask = (cookie?: string) => GET(new Request("https://ohmail.test/account/manage", {
      headers: { "sec-purpose": "prefetch", ...(cookie ? { cookie } : {}) },
    }));
    expect((await ask("__Host-tf_session=tok")).status).toBe(204);
    expect((await ask()).status, "control: no session at all is sent to sign in").toBe(307);
  });
});

/* ── THE CENSUS: no web code reads a session cookie by hand ─────────────────────────────────── */

const ROOTS = [path.join(HERE, "../app"), path.join(HERE, "../middleware.ts"), path.join(HERE, "../../../packages/app-logic/src")];
const NAME = String.raw`(?:"tf_(?:session|refresh|csrf|resume|owner)"|SESSION_COOKIE|RESUME_COOKIE|OWNER_COOKIE)`;
const HAND_READ = new RegExp(String.raw`[!=]==\s*${NAME}|${NAME}\s*[!=]==|\bcookies(?:\(\))?\.(?:get|has)\(`, "g");

function sources(p: string): Array<{ file: string; text: string }> {
  if (fs.statSync(p).isFile()) return /\.tsx?$/.test(p) ? [{ file: path.relative(HERE, p), text: fs.readFileSync(p, "utf8") }] : [];
  return fs.readdirSync(p).flatMap((n) => sources(path.join(p, n)));
}
const handReads = (files: Array<{ file: string; text: string }>): string[] =>
  files.filter((f) => !f.file.endsWith("cookie-jar.ts"))
    .flatMap((f) => [...withoutComments(f.text).matchAll(HAND_READ)].map(() => f.file));

describe("census — the session cookies are read through the one reader", () => {
  const files = ROOTS.flatMap(sources);
  it("no hand-rolled read remains", () => {
    expect(files.length, "the census read no files").toBeGreaterThan(100);
    expect(handReads(files)).toEqual([]);
  });
  it("…and a planted one is counted (positive control)", () => {
    const planted = [{ file: "planted.ts", text: 'if (k === "tf_csrf") x(); const t = request.cookies.get(SESSION_COOKIE);\n' }];
    expect(handReads(planted)).toEqual(["planted.ts", "planted.ts"]);
  });
});

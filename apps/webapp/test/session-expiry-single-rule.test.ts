/**
 * ONE RULE FOR WHEN A WEB SESSION ENDS (SESSIONS-023).
 *
 * A session ends when the person signs out, when the server names a refusal, or when the idle
 * window closes — never on a fault. In this app that is two writers: `markSessionDead()` on a
 * CODED 401 from the refresh door, and the resume splash's refusal arm, which sends the browser to
 * `/login` with the refusal's sentence. Everything else that meets `/auth/session` or
 * `/auth/refresh` failing resolves to "unknown" or "unavailable". This census parses for CALLS
 * (comments and strings blanked) and drives planted fixtures red.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as scan from "../../../scripts/lib/source-scan.mjs";

const APP = resolve("apps/webapp/app");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

interface Site { file: string; line: number; guard: string }

/** Every CALL of `name(` — never its declaration, an import, or a mention in prose. */
function callSites(src: string, name: string): number[] {
  const code = scan.withoutCommentsAndLiterals(src);
  const at: number[] = [];
  for (const m of code.matchAll(new RegExp(`\\b${name}\\s*\\(`, "g"))) {
    if (/\bfunction\s+$/.test(code.slice(Math.max(0, m.index! - 24), m.index!))) continue;
    at.push(m.index!);
  }
  return at;
}

/** Every navigation to `/login`: `location.replace|assign("/login")`, `location.href =`, the router. */
function loginNavigations(src: string): number[] {
  const kept = scan.withoutComments(src);
  const re = /\b(?:location\.(?:replace|assign)\s*\(\s*["'`]\/login["'`]|location\.href\s*=\s*["'`]\/login["'`]|router\.(?:replace|push)\s*\(\s*["'`]\/login["'`])/g;
  return [...kept.matchAll(re)].map((m) => m.index!);
}

/** The condition of the innermost `if (…) {` block holding `at`, or "" when there is none. */
function guardOf(src: string, at: number): string {
  const code = scan.withoutCommentsAndLiterals(src);
  const kept = scan.withoutComments(src);
  let depth = 0;
  for (let i = at; i >= 0; i -= 1) {
    if (code[i] === "}") depth += 1;
    else if (code[i] === "{") {
      if (depth === 0) {
        const head = kept.slice(Math.max(0, i - 200), i);
        const m = /\bif\s*\(([^{}]*)\)\s*$/.exec(head);
        return m ? m[1]!.replace(/\s+/g, " ").trim() : "";
      }
      depth -= 1;
    }
  }
  return "";
}

/** The bodies of every `catch (…) {…}` and `.catch(…)`, strings intact, comments blanked. */
function catchBodies(src: string): string[] {
  const code = scan.withoutCommentsAndLiterals(src);
  const kept = scan.withoutComments(src);
  const out: string[] = [];
  for (const m of code.matchAll(/\bcatch\b\s*(?:\([^)]*\))?\s*\{/g)) {
    const open = m.index! + m[0].length - 1;
    const s = scan.bracketSpan(code, open, "{", "}");
    out.push(kept.slice(s.start, s.end));
  }
  for (const m of code.matchAll(/\.catch\s*\(/g)) {
    const open = m.index! + m[0].length - 1;
    const s = scan.bracketSpan(code, open, "(", ")");
    out.push(kept.slice(s.start, s.end));
  }
  return out;
}

/** A verdict written from inside a `catch`: the death latch, a sign-in navigation, the note. */
function verdictsInCatches(src: string): number {
  const writers = /\bmarkSessionDead\s*\(|\bleaveSignedOutNote\s*\(|status:\s*["']unauthenticated["']/;
  return catchBodies(src).filter((b) => writers.test(b) || loginNavigations(b).length > 0).length;
}

/** Does this file ask the session door or the refresh door? */
const ASKS = /\b(?:resumeSession|lastRefreshReport|lastRefreshOutcome|resolveOwnerOutcome|REFRESH_ENDPOINT|SESSION_ENDPOINT)\b|auth\.session\s*\(/;

const FILES = walk(APP).map((p) => ({ rel: relative(resolve("."), p), src: readFileSync(p, "utf8") }));

function sites(find: (src: string) => number[]): Site[] {
  return FILES.flatMap(({ rel, src }) => find(src).map((at) => ({
    file: rel, line: scan.lineOf(src, at), guard: guardOf(src, at),
  })));
}

describe("the census reads the tree it claims to", () => {
  it("found the app and the files that ask the session door", () => {
    expect(FILES.length).toBeGreaterThan(100);
    const asking = FILES.filter((f) => ASKS.test(scan.withoutComments(f.src))).map((f) => f.rel);
    expect(asking).toContain("apps/webapp/app/session-refresh.ts");
    expect(asking).toContain("apps/webapp/app/(product)/resume/ResumeScreen.tsx");
    expect(asking.length).toBeGreaterThan(5);
  });
});

describe("the two writers of a sign-in verdict, and only those", () => {
  it("markSessionDead() is CALLED once — on the refresh door's named refusal", () => {
    const found = sites((src) => callSites(src, "markSessionDead"));
    expect(found.map((s) => `${s.file} [${s.guard}]`)).toEqual([
      "apps/webapp/app/session-refresh.ts [isSessionRefusal(res.status, code)]",
    ]);
    // …and `code` is the refusal's code read only off a 401.
    const src = readFileSync(resolve("apps/webapp/app/session-refresh.ts"), "utf8");
    expect(scan.withoutComments(src)).toMatch(/const code = res\.status === 401 \? await refusalCode\(res\) : null;/);
  });

  it("the splash sends a browser to /login only from its refusal arm; sign-out is the other door", () => {
    const found = sites(loginNavigations).map((s) => `${s.file} [${s.guard}]`);
    expect(found).toEqual([
      // The desktop approval's "sign in first", read off the refresh door's confirmed verdict.
      "apps/webapp/app/(product)/approve/ApproveScreen.tsx [sessionIsDead()]",
      // …and before its first read, off the front-door classifier's `none` (`approve/settle-owner.ts`).
      'apps/webapp/app/(product)/approve/ApproveScreen.tsx [settled.kind === "none"]',
      // After the person's own sign-out succeeded — the invariant's first door, not a verdict.
      'apps/webapp/app/(product)/error.tsx []',
      // …and the lock screen's, the same door past the same one reader.
      'apps/webapp/app/(product)/mailbox/AccessLock.tsx []',
      // A jar holding this browser's own unfinished sign-out, met by the splash: no door asked, the
      // sign-in page finishes it (`resume-never-loops`, `login-finishes-sign-out`). Not a verdict.
      "apps/webapp/app/(product)/resume/ResumeScreen.tsx [signOutPending()]",
      // The jar lost the account the edge saw while the splash waited: another tab heard the door's
      // refusal (or signed out), and only a server answer or a sign-out takes `tf_owner`. Not a fault.
      "apps/webapp/app/(product)/resume/ResumeScreen.tsx [initialOwner !== null && readOwnerCookie() === null]",
      'apps/webapp/app/(product)/resume/ResumeScreen.tsx [answer !== "unavailable"]',
    ]);
    for (const file of ["apps/webapp/app/(product)/error.tsx", "apps/webapp/app/(product)/mailbox/AccessLock.tsx"]) {
      const src = scan.withoutComments(readFileSync(resolve(file), "utf8"));
      expect(src.slice(0, src.indexOf('window.location.assign("/login")')), file).toMatch(/await signOut\(/);
    }
  });

  it("the sign-out note is left only beside those navigations", () => {
    expect(sites((src) => callSites(src, "leaveSignedOutNote")).map((s) => `${s.file} [${s.guard}]`)).toEqual([
      // The sentence the other tab heard, copied for this tab's `/login`.
      "apps/webapp/app/(product)/resume/ResumeScreen.tsx [initialOwner !== null && readOwnerCookie() === null]",
      'apps/webapp/app/(product)/resume/ResumeScreen.tsx [answer !== "unavailable"]',
    ]);
  });

  it("no catch in a file that asks the session door writes a verdict", () => {
    const offenders = FILES
      .filter((f) => ASKS.test(scan.withoutComments(f.src)))
      .filter((f) => verdictsInCatches(f.src) > 0)
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  it("there is one refresh request in the app — resumeSession's — beside the cache purge, which presents nothing", () => {
    const fetches = FILES.flatMap(({ rel, src }) => {
      const code = scan.withoutComments(src);
      return [...code.matchAll(/\bfetch\s*\(\s*(?:REFRESH_ENDPOINT|["'`][^"'`]*\/auth\/refresh)/g)].map((m) => {
        const call = scan.bracketSpan(scan.withoutCommentsAndLiterals(src), m.index! + m[0].indexOf("("));
        return /\bCACHE_PURGE_HEADER\b/.test(code.slice(call.start, call.end)) ? `${rel} (purge)` : rel;
      });
    });
    expect(fetches).toEqual(["apps/webapp/app/session-refresh.ts", "apps/webapp/app/session-refresh.ts (purge)"]);
  });
});

describe("POSITIVE CONTROLS — each rule reads RED on the shape it exists to refuse", () => {
  it("a catch that writes the death latch is found", () => {
    const planted = "async function f() {\n  try { await resumeSession(); } catch {\n    markSessionDead();\n  }\n}\n";
    expect(verdictsInCatches(planted)).toBe(1);
    expect(verdictsInCatches("p.catch(() => { window.location.replace(\"/login\"); });")).toBe(1);
  });

  it("a death latch written on a FAULT is not the coded-401 arm", () => {
    const planted = "if (res.status === 503) {\n  markSessionDead();\n}\n";
    const [at] = callSites(planted, "markSessionDead");
    expect(guardOf(planted, at!)).toBe("res.status === 503");
  });

  it("a splash that signs a fault out is not the refusal arm", () => {
    const planted = 'if (answer === "unavailable") {\n  window.location.replace("/login");\n}\n';
    const [at] = loginNavigations(planted);
    expect(guardOf(planted, at!)).toBe('answer === "unavailable"');
  });

  it("a mention is not a call — prose and strings are blanked, declarations skipped", () => {
    const prose = '// markSessionDead() is the latch\nconst s = "markSessionDead()";\nexport function markSessionDead(): void {}\n';
    expect(callSites(prose, "markSessionDead")).toEqual([]);
  });
});

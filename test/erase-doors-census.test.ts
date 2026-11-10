import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { bracketSpan, withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";

/**
 * EVERY ERASE DOOR TAKES ITS OWNER BEFORE THE SESSION ENDS AND WIPES WHAT SIGN-OUT WIPES.
 *
 * An erase that read the account after `DELETE /account` had expired the session found nobody,
 * refused its own answer, and left the whole mirror in the browser with no receipt. The client
 * doors are counted here by their CALLS: one, the web's Settings → Account, because the desktop
 * and the phone send the person to the web (a paired bearer cannot pass step-up). The server
 * doors all run `deleteAccount`, whose mailbox lock is measured in the services pg suite.
 */
const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** The client roots, and the directories a walk skips: build output and installed packages. */
const CLIENT_ROOTS = ["apps/webapp/app", "apps/desktop/src", "apps/mobile/src", "apps/mobile/app", "packages/client-engine/src"];
const SKIPPED = new Set(["node_modules", "dist", "build", ".next"]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIPPED.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** `file:line` of every match of `re` in comment-free source under the client roots. */
function callsIn(roots: readonly string[], re: RegExp): string[] {
  const hits: string[] = [];
  for (const r of roots) {
    const abs = join(ROOT, r);
    if (!existsSync(abs)) continue;
    for (const f of walk(abs)) {
      const code = withoutComments(readFileSync(f, "utf8"));
      for (const m of code.matchAll(re)) {
        hits.push(`${relative(ROOT, f)}:${code.slice(0, m.index).split("\n").length}`);
      }
    }
  }
  return hits.sort();
}

const ERASE_CALL = /\baccount\s*\.\s*erase\s*\(/g;
const ACCOUNT_DELETE = /["'`]\/account["'`]\s*,\s*\{\s*method\s*:\s*["']DELETE["']/g;
const SECTION = "apps/webapp/app/(product)/mailbox/AccountSection.tsx";

describe("erase doors", () => {
  it("the walk reads every client root it names", () => {
    for (const r of CLIENT_ROOTS.filter((x) => x !== "apps/mobile/app")) {
      expect(existsSync(join(ROOT, r)), `${r} is gone; the census would read nothing there`).toBe(true);
      expect(walk(join(ROOT, r)).length, `${r} holds no source`).toBeGreaterThan(0);
    }
  });

  it("the client has ONE erase door, the web's, and one request behind it", () => {
    const calls = callsIn(CLIENT_ROOTS, ERASE_CALL);
    expect(calls.map((c) => c.replace(/:\d+$/, "")), "a new erase door must take its owner first and call forgetThisBrowser").toEqual([SECTION]);
    expect(callsIn(CLIENT_ROOTS, ACCOUNT_DELETE).map((c) => c.replace(/:\d+$/, ""))).toEqual(["apps/webapp/app/api-client.ts"]);
  });

  it("the web door erases with the account owner it was handed, then wipes this browser's copy of that account", () => {
    const raw = readFileSync(join(ROOT, SECTION), "utf8");
    const code = withoutComments(raw);
    const blank = withoutCommentsAndLiterals(raw);
    const open = code.indexOf("const erase = useCallback(async (owner: string");
    expect(open, "the erase callback, by its signature").toBeGreaterThan(-1);
    const s = bracketSpan(blank, blank.indexOf("{", open), "{", "}");
    expect(s.closed, "the callback's body did not close").toBe(true);
    const body = code.slice(s.start, s.end);
    const request = body.indexOf("await account.erase()");
    // `only`: the erased door's scope — this account's copy, never another account's in the browser.
    const wipe = body.indexOf("forgetThisBrowser(owner, { only: true, erased: true })");
    expect(request).toBeGreaterThan(-1);
    expect(wipe, "the wipe runs after the answer, with the account owner captured before it").toBeGreaterThan(request);
    // After the answer nobody is left to ask: no owner read between the request and the wipe.
    for (const read of ["readOwner(", "readOwnerMarker(", "auth.session(", "boundApiOwner(", "document.cookie"]) {
      expect(body.slice(request, wipe).includes(read), `${read} read after the session ended`).toBe(false);
    }
    expect(body.slice(wipe, wipe + 80), "the erase keeps its own wake revoke").not.toContain("revokeWake");
  });

  it("the server doors all run the one erasure", () => {
    const callers = callsIn(["packages/api/src", "packages/services/src"], /\bdeleteAccount\s*\(/g)
      .map((c) => c.replace(/:\d+$/, ""))
      .filter((f) => f !== "packages/services/src/account-deletion-service.ts");
    expect([...new Set(callers)].sort()).toEqual([
      "packages/api/src/routes/account.ts",
      "packages/services/src/account-lifecycle-pass.ts",
    ]);
  });
});

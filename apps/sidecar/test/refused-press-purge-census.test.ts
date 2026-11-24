import { describe, expect, it } from "vitest";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { readEngineAsOneText } from "../../../test/support/engine-unit.js";

/**
 * A REFUSED PRESS PURGES THROUGH THE RUNTIME — rows, plaintext, login, timers — never a bare DELETE,
 * which left the plaintext dialled by the next poll; and WITHOUT the sign-out's epoch bump, which on
 * the seed (its epoch read once at attach) refuses every later dial for the process's life. Counted
 * by parse over blanked source, as the CALL: the bare delete keeps exactly the two writes a sign-out
 * overtook (the seal route's and the boot seal's, the second before any login exists). The fixture
 * at the foot proves the counter and the region matcher discriminate.
 */

const ENGINE = readEngineAsOneText();
const CODE = withoutCommentsAndLiterals(ENGINE);

/** The block the brace at or after `opener`'s end opens, brace-matched over blanked source. */
function blockAfter(code: string, opener: string, from = 0): { text: string; at: number } {
  const at = code.indexOf(opener, from);
  if (at === -1) throw new Error(`anchor not found: ${opener}`);
  const open = code.indexOf("{", at + opener.length - 1);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return { text: code.slice(open, i + 1), at: open };
    }
  }
  throw new Error(`unterminated block: ${opener}`);
}

/** An arrow function's body: the first `=> {` after its declaration. */
function arrowBody(code: string, decl: string): { text: string; at: number } {
  const at = code.indexOf(decl);
  if (at === -1) throw new Error(`declaration not found: ${decl}`);
  return blockAfter(code, "=> {", at);
}

/** Every CALL of `name` — `name(`, never `name =` or a property of that name. */
function callSites(code: string, name: string): number[] {
  const re = new RegExp(`(?<![.\\w$])${name}\\s*\\(`, "g");
  const out: number[] = [];
  for (let m = re.exec(code); m !== null; m = re.exec(code)) out.push(m.index);
  return out;
}

const calls = (region: string, pattern: RegExp): boolean => pattern.test(region);

/** The two writes a sign-out overtook: the only places the bare delete may run. */
const STALE_ARMS = ["if (sealWrite.stale()) {", "if (bootSeal.stale()) {"] as const;

describe("a refused press purges through the runtime", () => {
  it("the bare delete is called only from the two writes a sign-out overtook", () => {
    const sites = callSites(CODE, "discardCredentialsFor");
    const arms = STALE_ARMS.map((a) => blockAfter(CODE, a));
    const outside = sites.filter((i) => !arms.some((b) => i >= b.at && i < b.at + b.text.length));
    expect(outside.map((i) => `line ${CODE.slice(0, i).split("\n").length}`), "a bare delete outside a stale arm")
      .toEqual([]);
    expect(sites.length, "each stale arm keeps its one discard").toBe(STALE_ARMS.length);
    for (const b of arms) expect(callSites(b.text, "discardCredentialsFor").length).toBe(1);
  });

  it("the press's refusal purges through the runtime it launched, and never bumps the epoch", () => {
    const press = arrowBody(CODE, "const answerPressLaunch = async (").text;
    expect(calls(press, /\brt\.purgeCredential\s*\(/)).toBe(true);
    expect(callSites(press, "discardCredentialsFor")).toEqual([]);
    expect(calls(press, /\.bump\s*\(/), "a bump fences the seed's every later dial").toBe(false);
  });

  it("the purge drops the plaintext, closes the login and leaves the epoch alone", () => {
    const purge = blockAfter(
      CODE, "const purgeCredential = async (opts?: { keepCoordinates?: boolean }): Promise<boolean> => {",
    ).text;
    for (const needed of [
      /\bdb\.transaction\s*\(/, /\btx\.delete\(mailboxCredentials\)/, /\buseDialledPassword\s*\(\s*""\s*\)/,
      /\bcloseDialAfterSignOut\s*\(/, /\bclearSignInRefusal\s*\(/, /\blaunchSkipped\s*=\s*true\b/,
      /\bneedsCredential\s*=\s*true\b/, /\bclearTimeout\s*\(\s*timer\s*\)/,
    ]) {
      expect(calls(purge, needed), `the purge lacks ${needed}`).toBe(true);
    }
    expect(calls(purge, /\.bump\s*\(/)).toBe(false);
  });

  it("the sign-out's forget is the purge plus the epoch", () => {
    const forget = blockAfter(
      CODE, "const forgetStoredLogin = async (opts?: { keepCoordinates?: boolean }): Promise<boolean> => {",
    ).text;
    expect(calls(forget, /\bawait purgeCredential\s*\(/)).toBe(true);
    expect(calls(forget, /\bfence\.bump\s*\(/)).toBe(true);
    expect(forget.indexOf("purgeCredential"), "the epoch moves after the row is proven gone")
      .toBeLessThan(forget.indexOf("fence.bump"));
  });

  /* THE COUNTER AND THE MATCHER DISCRIMINATE: a third caller outside the arms is seen, and a
     mention (a property, a declaration) is not a call. */
  it("reads a stray call as stray and a mention as no call", () => {
    const fixture = withoutCommentsAndLiterals([
      "const discardCredentialsFor = async (id: string): Promise<void> => {};",
      "if (sealWrite.stale()) {\n  await discardCredentialsFor(a);\n}",
      "if (bootSeal.stale()) {\n  await discardCredentialsFor(b);\n}",
      "const answerPressLaunch = async (x: string): Promise<void> => {\n  await discardCredentialsFor(x);\n};",
      "rt.discardCredentialsFor;",
    ].join("\n"));
    const sites = callSites(fixture, "discardCredentialsFor");
    expect(sites.length).toBe(3);
    const arms = STALE_ARMS.map((a) => blockAfter(fixture, a));
    const outside = sites.filter((i) => !arms.some((b) => i >= b.at && i < b.at + b.text.length));
    expect(outside.length).toBe(1);
    expect(callSites(arrowBody(fixture, "const answerPressLaunch = async (").text, "discardCredentialsFor").length)
      .toBe(1);
  });
});

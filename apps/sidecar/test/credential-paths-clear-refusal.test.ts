import { describe, expect, it } from "vitest";
import { withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { readEngineAsOneText } from "../../../test/support/engine-unit.js";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY CREDENTIAL PATH REACHES THE ACT THAT CLEARS A REFUSED SIGN-IN
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * A refused sign-in suspends the automatic re-dial — four LOGIN attempts a minute is how a
 * wrong password becomes a locked account — so the flag has to be cleared by whatever replaces
 * or removes the password. `engine.ts` stated that as already true and it was not: the seal
 * route re-points every mailbox but the SEED by detaching it, and a one-mailbox install is the
 * seed, so its new password was stored while its runtime went on dialling the old one with the
 * re-dial suspended for ever. This file is the check that statement now names.
 *
 * ── WHAT IS COUNTED ───────────────────────────────────────────────────────────────────────
 *
 * Every `insert`/`update`/`delete` of `mailboxCredentials` in the standalone engine, found by
 * parse over source with comments and string literals blanked, and each one has to fall inside
 * a region declared below with how a stale refusal is prevented on it. A write outside them all
 * is the new path nobody classified, and it reads red with its line.
 *
 * ── THE CONTROLS ──────────────────────────────────────────────────────────────────────────
 *
 * The regions are proved to BOUND: `discardCredentialsFor` is a bare delete and must NOT hold
 * the clearing call, so a matcher that returned the whole file cannot pass. The fixture at the
 * foot holds the gated and ungated shapes. Measured red by deleting `live.credentialReplaced()`
 * from the seal route and by deleting `clearSignInRefusal` from the purge the sign-out calls.
 */

const ENGINE = readEngineAsOneText();

/** The body of the block `opener` introduces, brace-matched forward over blanked source. */
function regionAfter(code: string, opener: string): string {
  const at = code.indexOf(opener);
  if (at === -1) throw new Error(`anchor not found: ${opener}`);
  const open = code.indexOf("{", at + opener.length - 1);
  let depth = 0;
  for (let i = open; i < code.length; i += 1) {
    if (code[i] === "{") depth += 1;
    else if (code[i] === "}") {
      depth -= 1;
      if (depth === 0) return code.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated block: ${opener}`);
}

/** Whether `name` is CALLED in this region — the call, never the mention. */
function calls(region: string, name: string): boolean {
  return new RegExp(`\\b${name}\\s*\\(`).test(region);
}

/**
 * The regions a credential write may live in, and what keeps a refusal from surviving it.
 * `clearsHere` is whether the clearing call is in THIS region's own text — false is not "no
 * mechanism": the seal route reaches it through `credentialReplaced`, measured by the two cases
 * above this table's own, and the boot paths run before a runtime can hold a refusal at all.
 */
const REGIONS = [
  {
    anchor: "const discardCredentialsFor = async (mailboxId: string): Promise<void> => {",
    clearsHere: false,
    why: "a bare delete, reached only from the two writes a sign-out overtook, which has cleared the refusal",
  },
  {
    anchor: "const purgeCredential = async (opts?: { keepCoordinates?: boolean }): Promise<boolean> => {",
    clearsHere: true,
    why: "the sign-out's forget and a refused press both purge without detaching, so it clears the flag itself",
  },
  {
    anchor: "if (durableKey && envPass && !(await storedLogin())) {",
    clearsHere: false,
    why: "the boot seal runs before this runtime has dialled anything",
  },
  {
    anchor: "if (seedRow) {",
    clearsHere: false,
    why: "the seed repairs run at boot, and neither writes a password a launch did not hold",
  },
  {
    anchor: "if (localSealMatch) {",
    clearsHere: false,
    why: "the seal route reaches it through `credentialReplaced`, and detaches every other row",
  },
] as const;

const CODE = withoutCommentsAndLiterals(ENGINE);

describe("every credential path clears a refused sign-in", () => {
  it("every credential write in the engine sits in a classified region", () => {
    const spans = REGIONS.map((r) => {
      const body = regionAfter(CODE, r.anchor);
      const at = CODE.indexOf(body);
      return { anchor: r.anchor, from: at, to: at + body.length };
    });
    const writes = /\.(?:insert|update|delete)\(mailboxCredentials\)/g;
    const unclassified: string[] = [];
    for (let m = writes.exec(CODE); m !== null; m = writes.exec(CODE)) {
      const inside = spans.some((s) => m!.index >= s.from && m!.index < s.to);
      if (!inside) unclassified.push(`line ${CODE.slice(0, m.index).split("\n").length}`);
    }
    expect(unclassified).toEqual([]);
  });

  it("the seal route re-points the runtime the detach excludes", () => {
    const seal = regionAfter(CODE, "if (localSealMatch) {");
    // BOTH: the detach for every other mailbox, and the weaker re-point for the seed.
    expect(calls(seal, "detach")).toBe(true);
    expect(calls(seal, "credentialReplaced")).toBe(true);
  });

  it("the runtime's re-point re-reads the row and clears the refusal", () => {
    const verb = regionAfter(CODE, "async credentialReplaced(opts) {");
    expect(calls(verb, "rereadCredential")).toBe(true);
    expect(calls(verb, "clearSignInRefusal")).toBe(true);
    expect(calls(verb, "redialIfDead")).toBe(true);
  });

  it("the clearing call is in the regions that claim it and in no other", () => {
    const read = REGIONS.map((r) => ({
      anchor: r.anchor,
      clearsHere: calls(regionAfter(CODE, r.anchor), "clearSignInRefusal"),
    }));
    expect(read).toEqual(REGIONS.map((r) => ({ anchor: r.anchor, clearsHere: r.clearsHere })));
  });

  /* THE DETECTOR DISCRIMINATES — both shapes through the same two functions, so a green above
     is a reading and not a matcher that says yes to everything it is handed. */
  it("reads a gated fixture as gated and an ungated one as ungated", () => {
    const gated = "const f = async () => {\n  await db.insert(mailboxCredentials).values({});\n"
      + "  clearSignInRefusal(\"x\");\n};\n";
    const ungated = "const f = async () => {\n  await db.insert(mailboxCredentials).values({});\n};\n";
    const anchor = "const f = async () => {";
    expect(calls(regionAfter(withoutCommentsAndLiterals(gated), anchor), "clearSignInRefusal"))
      .toBe(true);
    expect(calls(regionAfter(withoutCommentsAndLiterals(ungated), anchor), "clearSignInRefusal"))
      .toBe(false);
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * ═══ THE REFUSING API CLIENT MUST MIRROR THE REAL ONE'S EXPORT SURFACE ═════════════════════
 *
 * `vite.config.ts` aliases `apps/webapp/app/api-client.ts` to `apps/desktop/src/no-api-client.ts`
 * in BOTH desktop artifacts, so no released binary carries a Cloud client. Shared `shell/` code
 * imports from that module by name, unconditionally. An export the stub is missing is therefore
 * not a missing feature — it is an unresolved import, and the desktop bundle fails to build on
 * every platform.
 *
 * ── WHY NO TYPECHECK CAN CATCH IT, WHICH IS THE WHOLE REASON THIS FILE EXISTS ───────────────
 *
 * The alias is the BUNDLER's, not the compiler's. `tsc` resolves the real module, finds the
 * export, and is green — while the artifact cannot be produced at all. The stub's own header
 * already carried the rule ("when the real module's surface changes, change this one in the same
 * commit") and named the desktop typecheck as its enforcement, which is precisely the thing that
 * is structurally unable to notice. It was missing `push` until a build failed and said so; a
 * later sweep found `devices` and `pair` waiting to do it again.
 *
 * So the rule gets a check that can actually fail: both files are parsed for their top-level
 * export names and compared. Source text rather than an import, because importing the stub
 * EVALUATES it — every value export is a Proxy that throws on property access — and because the
 * question is about the module's surface, which is a fact about the text.
 */

/* `async function` too. Without it the census read `api`, `createPasskey` and
   `assertPasskey` as stub-only extras — a parse gap that would have masked a real
   one-directional drift in exactly the names the shell calls most. */
const NAMES =
  /^export (?:async function|const|class|function|interface|type)\s+([A-Za-z0-9_]+)/gm;

function exportsOf(rel: string): Set<string> {
  const src = readFileSync(new URL(rel, import.meta.url), "utf8");
  return new Set([...src.matchAll(NAMES)].map((m) => m[1]!));
}

describe("the desktop's refusing api-client stub", () => {
  it("exports every name the real client does", () => {
    const real = exportsOf("../../webapp/app/api-client.ts");
    const stub = exportsOf("../src/no-api-client.ts");

    // The census is worthless if either parse found nothing; pin the shape it must have found.
    expect(real.size).toBeGreaterThan(20);
    expect(real.has("consent")).toBe(true);
    expect(real.has("push")).toBe(true);

    const missing = [...real].filter((n) => !stub.has(n)).sort();
    expect(
      missing,
      "no-api-client.ts is missing these exports — the desktop bundle will not build",
    ).toEqual([]);
  });

  /**
   * The stub may hold MORE than the real module (a shape it needs locally), so the census is
   * one-directional by design. This records that as a decision rather than an oversight, and
   * keeps the drift visible if it ever grows large.
   */
  it("is allowed to hold names the real client does not, and currently holds none", () => {
    const real = exportsOf("../../webapp/app/api-client.ts");
    const stub = exportsOf("../src/no-api-client.ts");
    expect([...stub].filter((n) => !real.has(n)).sort()).toEqual([]);
  });

  /**
   * ═══ AND THE MEMBERS, NOT ONLY THE NAMES ══════════════════════════════════════════════════
   *
   * A name census is blind to the way this file actually rots: `AwayResponderWire` kept a
   * `subject` the real wire dropped and never gained `throttle` or `piles`, so the stub's type
   * described a responder two releases old while every name matched. Nothing noticed, because
   * the shipped desktop reads the wire's fields through the shared control's own types and the
   * bundler needs only the NAMES to resolve.
   *
   * So the interfaces both files export are compared MEMBER BY MEMBER, and the four that differ
   * today are pinned BY NAME with what they are missing. A ratchet, like every count in this
   * repository: an entry may leave this list, and a fifth interface joining it is red.
   */
  const KNOWN_MEMBER_DRIFT: Readonly<Record<string, readonly string[]>> = {
    /* The desktop stub predates these members; each was added to the real wire by a later lane
       and none is read by the shared shell on this tier. They are listed so the away wire's
       parity — the one this case was written for — is a checked claim rather than a hope. */
    MailboxDTO: ["organizedByThisInstall", "releaseRequestedAt", "takeoverAuthorizedAt"],
    SubscriptionStatus: ["addons", "setupCredits", "storageUsedBytes"],
    ConsentStateWire: [
      "folderMailboxesOff", "foldersEnabledAt", "loadTrackingPixelsAt", "onboardingCompletedAt",
      "screeningScope", "signatures", "signaturesHtml", "themeFace",
    ],
    ScreenerWirePage: ["pendingDecisions"],
  };

  /** Every exported interface's member names, per file, read with the compiler's own parser. */
  function interfaceMembers(rel: string): Map<string, string[]> {
    const file = fileURLToPath(new URL(rel, import.meta.url));
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const out = new Map<string, string[]>();
    for (const st of sf.statements) {
      if (!ts.isInterfaceDeclaration(st)) continue;
      if (!st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
      out.set(st.name.text, st.members
        .map((m) => (m.name && ts.isIdentifier(m.name) ? m.name.text : m.name?.getText(sf) ?? "?"))
        .sort());
    }
    return out;
  }

  it("mirrors the MEMBERS of every interface it shares, but for the four pinned drifts", () => {
    const real = interfaceMembers("../../webapp/app/api-client.ts");
    const stub = interfaceMembers("../src/no-api-client.ts");
    // ANTI-VACUITY: a parse that found nothing would agree about everything.
    expect(real.size).toBeGreaterThan(20);
    expect(real.get("AwayResponderWire")).toBeDefined();

    const drift: string[] = [];
    for (const [name, members] of real) {
      const mine = stub.get(name);
      if (mine === undefined) continue;      // the NAME census above owns an absent interface
      const missing = members.filter((m) => !mine.includes(m));
      const pinned = KNOWN_MEMBER_DRIFT[name] ?? [];
      const unpinned = missing.filter((m) => !pinned.includes(m));
      const healed = pinned.filter((m) => mine.includes(m));
      if (unpinned.length > 0) drift.push(`${name} is missing ${unpinned.join(", ")}`);
      if (healed.length > 0) drift.push(`${name} no longer drifts on ${healed.join(", ")} — drop it from the pin`);
    }
    expect(drift, "the stub's type surface drifted from the real client's").toEqual([]);
  });

  /** The away wire by name, because it is the one this case exists for. */
  it("carries the away wire's own members exactly", () => {
    const real = interfaceMembers("../../webapp/app/api-client.ts");
    const stub = interfaceMembers("../src/no-api-client.ts");
    expect(stub.get("AwayResponderWire")).toEqual(real.get("AwayResponderWire"));
    expect(real.get("AwayResponderWire")).toContain("piles");
    expect(real.get("AwayResponderWire")).toContain("endsAt");
    expect(real.get("AwayResponderWire")).not.toContain("subject");
  });
});

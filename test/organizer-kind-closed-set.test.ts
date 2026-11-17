import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ORGANIZER_KIND_WORDS, isMalformed, isOrganizerKindWord, parseClaim, type OrganizerClaim,
} from "@trafficflow/core/adapters/organizer-lease";
import { holderKind } from "../apps/mobile/src/ui/standalone-form.js";

/*
 * ONE CLOSED SET, AND EVERY WRITER ASKS IT.
 *
 * The device rig's laptop twin wrote `X-Ohmail-Organizer-Kind: desktop`. No build writes that
 * word: the sidecar writes `organizerKind ?? "local"`, the worker `cloud`, the phone `mobile`. So
 * every reader parsed the twin's claim as `unknown`, the phone stood down fail-closed — correctly —
 * and run 6 recorded a product row that was the rig's own word (2026-09-12). A worker fixture
 * spelled the same word at `packages/organizer/test/profile-failure-latch.test.ts:146`, where nothing
 * typechecks it: `apps/worker` has no typecheck script.
 *
 * The word list is a VALUE in core now, the two parser doors ask one predicate, and the rig tool
 * derives its set from that line rather than carrying one.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEASE = "packages/core/src/adapters/organizer-lease.ts";


describe("the organizer kind is one closed set", () => {
  it("core declares the words once and both doors read them", () => {
    expect([...ORGANIZER_KIND_WORDS]).toEqual(["local", "cloud", "mobile"]);
    for (const w of ORGANIZER_KIND_WORDS) expect(isOrganizerKindWord(w)).toBe(true);
    expect(isOrganizerKindWord("desktop")).toBe(false);

    /* The set is not spelled a second time inside the module the predicate lives in — that is how
       the request door and the claim door drifted apart before. */
    const src = readFileSync(join(ROOT, LEASE), "utf8");
    const triples = src.match(/=== "(?:local|cloud|mobile)" \|\|/g) ?? [];
    expect(triples, "a hand-spelled kind comparison is back in organizer-lease.ts").toEqual([]);
  });

  it("a claim carrying `desktop` parses as unknown, and one carrying a member does not", () => {
    const claim = (kind: string) => [
      "X-Ohmail-Lease: 1",
      `X-Ohmail-Organizer-Kind: ${kind}`,
      "X-Ohmail-Install-Id: TWIN",
      "X-Ohmail-Protocol: 1",
      "X-Ohmail-Heartbeat: 2026-09-12T20:00:00.000Z",
      "X-Ohmail-Claimed-At: 2026-09-12T20:00:00.000Z",
      "X-Ohmail-Nonce: n1",
      "X-Ohmail-Display-Name: a laptop",
      "", "",
    ].join("\r\n");
    const kindOf = (kind: string, ref: string): string => {
      const c = parseClaim(claim(kind), ref);
      expect(c, `${kind} did not parse at all`).not.toBe(null);
      expect(isMalformed(c!), `${kind} parsed as malformed`).toBe(false);
      return (c as OrganizerClaim).kind;
    };
    expect(kindOf("desktop", "r1")).toBe("unknown");
    expect(kindOf("local", "r2")).toBe("local");
    expect(kindOf("MOBILE", "r3")).toBe("mobile");
  });

  it("the phone's own reader carries the same members", () => {
    /* `HolderKind` is declared in the app on purpose (a core subpath for four strings is six
       registration points). Declared apart, reconciled here: a member added to core and not to
       the phone is a kind the panel calls unknown. */
    for (const w of ORGANIZER_KIND_WORDS) expect(holderKind(w)).toBe(w);
    expect(holderKind("desktop")).toBe("unknown");
  });
});

describe("no fixture spells a kind no build writes", () => {
  it("every `self: { … kind: … }` in the tree is a member of the set", () => {
    /* The census the worker fixture needed: `apps/worker` typechecks no test, so `desktop` sat in
       a lease identity for a month and the suite stayed green. */
    const files = execFileSync("git", ["ls-files", "*.ts", "*.tsx"], { cwd: ROOT, encoding: "utf8" })
      .trim().split("\n").filter(Boolean);
    const found: string[] = [];
    const strangers: string[] = [];
    for (const f of files) {
      const src = readFileSync(join(ROOT, f), "utf8");
      for (const m of src.matchAll(/self:\s*\{([^{}]*)\}/g)) {
        const k = m[1].match(/\bkind:\s*"([^"]*)"/);
        if (!k) continue;
        const line = src.slice(0, m.index ?? 0).split("\n").length;
        found.push(`${f}:${line}`);
        if (!isOrganizerKindWord(k[1])) strangers.push(`${f}:${line} kind: "${k[1]}"`);
      }
    }
    expect(found.length, "the census matched nothing — its shape stopped reading the tree").toBeGreaterThanOrEqual(20);
    expect(strangers).toEqual([]);
  });
});

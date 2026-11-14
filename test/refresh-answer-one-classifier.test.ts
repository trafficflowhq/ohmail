import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withoutComments, withoutCommentsAndLiterals } from "../scripts/lib/source-scan.mjs";
import { CREDENTIAL_REFUSED, SESSION_REFUSAL_CODES } from "../packages/client-engine/src/refresh-answer.js";

/**
 * ONE READING OF A REFRESH ANSWER. The phone and the paired browser client each judged
 * `/auth/refresh` by status, so any 401 or 403 — a Wi-Fi sign-in page, a firewall — signed them
 * out. Both now call `readRefreshAnswer`. This holds them to the call, refuses a status judgement
 * or a refusal code of their own, and holds the sidecar's set (it may not link the client engine)
 * equal to the shared one.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLIENTS = ["apps/mobile/src/net/bearer.ts", "apps/paired-page/src/bearer.ts"];
const SIDECAR = "apps/sidecar/src/cloud-auth.ts";
const WEB = "apps/webapp/app/session-refresh.ts";

/** What a file does with a refresh answer, read from its code with comments blanked. */
function reading(src: string) {
  const code = withoutComments(src);
  const bare = withoutCommentsAndLiterals(src);
  return {
    imports: /import\s*\{[^}]*\breadRefreshAnswer\b[^}]*\}\s*from\s*"@ohmail\/client-engine"/.test(code),
    calls: (bare.match(/\breadRefreshAnswer\s*\(/g) ?? []).length,
    names403: /\b403\b/.test(bare),
    ownCodes: [...SESSION_REFUSAL_CODES].filter((c) => code.includes(`"${c}"`)),
  };
}

/** The string members of `const REFUSAL_CODES … = new Set([…])` in the sidecar's code. */
function sidecarCodes(src: string): string[] {
  const m = /const REFUSAL_CODES\b[^=]*=\s*new Set\(\[([^\]]*)\]\)/.exec(withoutComments(src));
  return m ? [...m[1]!.matchAll(/"([a-z_]+)"/g)].map((x) => x[1]!).sort() : [];
}

/** The sidecar's `const CREDENTIAL_REFUSED = "…"`, or null where it spells none. */
function sidecarCredentialCode(src: string): string | null {
  return /\bconst CREDENTIAL_REFUSED\s*=\s*"([a-z_]+)"/.exec(withoutComments(src))?.[1] ?? null;
}

/** The base's shape: a status judgement and a code of its own, the call named only in a comment. */
const JUDGED_BY_STATUS = `
export class M {
  async rotate(res: Response): Promise<string | null> {
    // readRefreshAnswer(res) is named here and never called
    if (res.status === 401 || res.status === 403) return "refresh_revoked";
    return null;
  }
}`;

/** The web's cookie refresh answers 204 with no body, so it takes the deciding line alone. */
function webReading(src: string) {
  const code = withoutComments(src);
  return {
    imports: /import\s*\{[^}]*\bisSessionRefusal\b[^}]*\}\s*from\s*"@ohmail\/client-engine"/.test(code),
    calls: (withoutCommentsAndLiterals(src).match(/\bisSessionRefusal\s*\(/g) ?? []).length,
    ownCodes: [...SESSION_REFUSAL_CODES].filter((c) => code.includes(`"${c}"`)),
  };
}

/** The web's base shape: any code in our envelope is a refusal, the classifier named in a comment. */
const ANY_CODE_IS_A_REFUSAL = `
// isSessionRefusal(res.status, code) is named here and never called
const code = res.status === 401 ? await refusalCode(res) : null;
if (code !== null || code === "refresh_revoked") markSessionDead();`;

describe("the phone and the paired browser read a refresh answer one way", () => {
  it.each(CLIENTS)("%s imports readRefreshAnswer, calls it once, and judges nothing itself", (file) => {
    const r = reading(fs.readFileSync(path.join(ROOT, file), "utf8"));
    expect(r).toEqual({ imports: true, calls: 1, names403: false, ownCodes: [] });
  });

  it("the reader sees each violation in the base's shape (positive control)", () => {
    expect(reading(JUDGED_BY_STATUS)).toEqual({
      imports: false, calls: 0, names403: true, ownCodes: ["refresh_revoked"],
    });
  });

  it("the browser's cookie refresh judges a 401 by isSessionRefusal and spells no code of its own", () => {
    expect(webReading(fs.readFileSync(path.join(ROOT, WEB), "utf8"))).toEqual({ imports: true, calls: 1, ownCodes: [] });
    expect(webReading(ANY_CODE_IS_A_REFUSAL), "positive control").toEqual({
      imports: false, calls: 0, ownCodes: ["refresh_revoked"],
    });
  });

  it("the sidecar's refusal set equals the shared one", () => {
    const codes = sidecarCodes(fs.readFileSync(path.join(ROOT, SIDECAR), "utf8"));
    expect(codes.length, "the sidecar's set was not found").toBeGreaterThan(0);
    expect(codes).toEqual([...SESSION_REFUSAL_CODES].sort());
  });

  it("the sidecar's credential-verdict code equals the shared one, and a spelling only in a comment reads as none", () => {
    expect(sidecarCredentialCode(fs.readFileSync(path.join(ROOT, SIDECAR), "utf8"))).toBe(CREDENTIAL_REFUSED);
    expect(sidecarCredentialCode('// const CREDENTIAL_REFUSED = "credential_refused";\nexport {};'), "positive control").toBeNull();
  });
});

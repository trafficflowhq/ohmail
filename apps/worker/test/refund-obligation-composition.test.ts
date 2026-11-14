import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";

/**
 * THE MEMORY IS COMPOSED WHEREVER THE MONEY IS — the census that makes "a metered host with no
 * obligation store" unreachable rather than merely refused.
 *
 * Both hosted compositions are the subject: the API, which charges for a draft, and the worker,
 * which charges for automatic advice. Each derives its refund-obligation store from the SAME
 * condition as its spend half, so the two cannot drift. The drafting service refuses a metered
 * press that arrives without one — that refusal is the belt; this is the braces, and it is the
 * half that fails at build time rather than at somebody's first press.
 *
 * SOURCE, read through the one-pass comment stripper, because every line here is quoted in the
 * prose beside it. A scanner that silently matches nothing is green precisely when it is useless,
 * so each needle has a control below that feeds it a negative.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const read = (p: string): string => withoutComments(readFileSync(`${REPO}/${p}`, "utf8"));

describe("a host that can charge can remember what it owes", () => {
  it("the worker derives the store from `spend` itself, so the pair cannot drift", () => {
    const src = read("apps/worker/src/index.ts");
    expect(src).toContain("refundObligationsOn(");
    // DERIVED FROM `spend`, not from `config` a second time: two independent reads of the same
    // configuration are two chances to disagree, and the disagreement is silent.
    expect(src).toMatch(/const obligations\s*=\s*spend\s*\?\s*refundObligationsOn\(/);
  });

  it("the worker hands the store to the one pass that spends without a press", () => {
    const src = read("apps/worker/src/index.ts");
    expect(src).toMatch(/\.\.\.\(obligations \? \{ obligations \} : \{\}\)/);
    expect(src).toContain("refundObligationDrainPass(");
  });

  it("the API composes the store on exactly the entitlements condition", () => {
    const src = read("apps/server/src/deps.ts");
    expect(src).toMatch(/cfg\.entitlements[\s\S]{0,120}refundObligationsOn\(/);
  });

  it("the draft route threads the store into the service", () => {
    const src = read("packages/api/src/routes/messages.ts");
    expect(src).toContain("refundObligationsOf(deps)");
  });

  it("the Screener's suggest route threads the store into its purchase", () => {
    // The pressed purchase refunds a declined sender and a sender whose store faulted; the debt is
    // written first only if the route hands the store over, per request, as the draft route does.
    const src = read("packages/api/src/routes/screener.ts");
    expect(src).toMatch(/\.suggest\([\s\S]{0,200}refundObligationsOf\(deps\)/);
  });

  /**
   * THE SCANNER'S OWN CONTROL. Each needle is fed a string that must NOT match, because a regex
   * that matches everything and a regex that matches nothing are both green above.
   */
  it("the needles do not match a composition that is missing the store", () => {
    const withoutIt = withoutComments("const obligations = undefined;\nconst spend = e;\n");
    expect(withoutIt).not.toMatch(/const obligations\s*=\s*spend\s*\?\s*refundObligationsOn\(/);
    expect(withoutComments("credits: spend,\n")).not.toMatch(/\.\.\.\(obligations \? \{ obligations \} : \{\}\)/);
    expect(withoutComments("const port = spendOf(deps);\n")).not.toContain("refundObligationsOf(deps)");
    expect(withoutComments("await screener(deps).suggest(ctx, body, { idempotency: null });\n"))
      .not.toMatch(/\.suggest\([\s\S]{0,200}refundObligationsOf\(deps\)/);
  });
});

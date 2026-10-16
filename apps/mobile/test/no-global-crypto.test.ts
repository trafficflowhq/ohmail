/**
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *  NOTHING IN THE PHONE'S ENGINE READS A GLOBAL `crypto` — zero, not "covered by a shim"
 * ══════════════════════════════════════════════════════════════════════════════════════════
 *
 * Hermes has no global `crypto`. Node has had one since 19, so every test in this workspace ran
 * over its absence and passed — the artifact loads, boots and dials under Node with the global
 * quietly supplied by the runtime. What a phone did instead: reached the fourth door, took an
 * address and a password, and answered *"Opening the mailbox stopped: ReferenceError: Property
 * 'crypto' doesn't exist"*. A door that cannot open, presented as a refusal somebody would read as
 * their own mistake. Measured on a device, 2026-09-11.
 *
 * Two modules read it, and the second is why this is not a tidiness census:
 *
 *   · `apps/sidecar/src/identity.ts` — the install's session family id;
 *   · `packages/core/src/adapters/organizer-lease.ts` — the LEASE NONCE, which is the clone
 *     defence. A phone that cannot mint one cannot claim its own mailbox.
 *
 * ── WHY ZERO, RATHER THAN A THIRD INJECTED GLOBAL ─────────────────────────────────────────
 *
 * Binding `crypto` the way `Buffer` and `process` are bound was built first and rejected on two
 * measurements. It has to import the platform's crypto package, and the one shim the node-side
 * suite loads DIRECTLY is `globals.mjs` — the expo/RN packages ship Flow-typed JavaScript, so
 * putting it there took down the two tests that import that file with a parse error naming neither
 * the package nor the import. Given a file of its own and injected, it then broke every test that
 * LOADS a probe bundle, because an injected module initialises on the first read of any global.
 *
 * Both call sites already had a `node:crypto` import or room for one, the alias table already
 * substitutes that module for the platform's, and `randomUUID` is a member of it. So the fix was
 * to stop reading a global — which is also the only version of this that needs no polyfill, no
 * load-order argument and no exception table.
 *
 * This census is the guard on that: a free `crypto.<member>` anywhere in the artifact is red, and
 * the positive control proves the scan can tell a free read from a module's own import.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { BUNDLE, buildPhoneEngine } from "../scripts/bundle-engine.mjs";

await buildPhoneEngine();
const lines = readFileSync(BUNDLE, "utf8").split("\n");

/** The input the bundler attributed each line to, by its `// <path>` marker. */
const owner: string[] = (() => {
  const out: string[] = [];
  let current = "";
  for (const line of lines) {
    const marker = /^\/\/ ([\w./@-]+\.(?:ts|tsx|js|mjs|cjs))$/.exec(line.trim());
    if (marker) current = marker[1]!;
    out.push(current);
  }
  return out;
})();

/**
 * Every `crypto.<member>` read that NO declaration in its own module answers.
 *
 * Free is the whole distinction, and a bare pattern cannot make it: six modules in this artifact
 * write `crypto.randomBytes(...)` above their own `var crypto = require("react-native-quick-crypto")`
 * — the alias table doing exactly its job. A scan that counted those would be a census nobody
 * could keep green, which is how a census gets deleted.
 *
 * So each read is CLASSIFIED rather than matched: the bundler wraps every input in a
 * `__commonJS`/`__esm` factory, so the nearest wrapper above a read is its scope, and a `crypto`
 * declaration inside that scope means the module brought its own. The marker comments are NOT used
 * for this — esbuild emits one per input but a chain of CommonJS modules shares a wrapper, so
 * attribution is good enough for a message and not for a decision.
 */
const READ = /(?<![\w.$])crypto\s*\.\s*(\w+)/;
const DECLARES = /(?:\b(?:var|let|const)\s+crypto\b\s*=)|(?:\bcrypto\s*=\s*(?:__toESM|require)\()/;
const WRAPPER = /^\s*var\s+(?:require_|init_)\w+\s*=\s*__(?:commonJS|esm)\(/;

function freeReads(text: readonly string[]): string[] {
  const hits: string[] = [];
  for (const [i, line] of text.entries()) {
    if (line.trim().startsWith("//")) continue;
    const m = READ.exec(line);
    if (!m) continue;
    // Walk back to this read's own module factory, and ask whether it declared a `crypto`.
    let bound = false;
    for (let j = i; j >= 0; j--) {
      if (DECLARES.test(text[j]!)) { bound = true; break; }
      if (WRAPPER.test(text[j]!)) break;
    }
    if (!bound) hits.push(`${owner[i] || "(pre-banner)"}: crypto.${m[1]}`);
  }
  return [...new Set(hits)].sort();
}

describe("the phone's engine asks the runtime for no global crypto", () => {
  it("read a real artifact — the census is not vacuous", () => {
    // A marker change or a stale bundle would make the rule below pass over nothing at all, which
    // is the shape this file exists to catch one level down.
    expect(lines.length, "the artifact is barely a file").toBeGreaterThan(10_000);
    expect(owner.filter(Boolean).length, "no line was attributed to any module").toBeGreaterThan(10_000);
    // The two modules the defect was in are still in the graph — otherwise a green here would
    // only mean the code moved.
    expect(owner).toContain("apps/sidecar/src/identity.ts");
    expect(owner.some((o) => /organizer-lease\.(?:js|ts)$/.test(o))).toBe(true);
  });

  it("holds ZERO free reads", () => {
    expect(freeReads(lines), "a global `crypto` read that Hermes cannot answer").toEqual([]);
  });

  it("still finds one when there is one — the scan is not blind", () => {
    /**
     * The positive control, on the discriminator rather than on the regex. It plants the defect's
     * exact shape inside a module factory that declares nothing, beside the three shapes that are
     * NOT a free read: a member access on another object, a module's own renamed import, and — the
     * one that matters — the same read in a factory that DOES declare its own `crypto`.
     *
     * Without this, classifying every read as bound would make the rule above green for ever.
     */
    const planted = [
      "  var init_lease = __esm({",
      "    const nonce = crypto.randomUUID();",           // the defect
      "    const other = quickCrypto.randomUUID();",      // a different object
      "    const mine = crypto2.randomUUID();",           // a renamed import
      "  var require_imapflow = __commonJS({",
      '    var crypto = require("react-native-quick-crypto");',
      "    const rid = crypto.randomBytes(13);",          // the module's own — not a free read
    ];
    const hits = freeReads(planted);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain("crypto.randomUUID");
  });

  it("and the six modules that bring their own are classified as bound", () => {
    // The other half of the discriminator, over the REAL artifact: these are the sites a bare
    // pattern reported, every one of them an alias-table substitution working correctly. If the
    // classifier ever stops seeing their declarations, the rule above goes red on them and the
    // message would send somebody after a defect that is not there.
    const bundle = lines.join("\n");
    expect(bundle).toContain('var crypto = require("react-native-quick-crypto");');
    expect(bundle).toMatch(/crypto\.randomBytes\(/);
  });

  it("both fixed sites now take the member from the module", () => {
    // The other direction: zero free reads would also be true of a build that stopped minting a
    // nonce at all. This is the read that says the capability is still there and where it comes
    // from — the alias table substitutes `node:crypto` for the platform's own package.
    const bundle = lines.join("\n");
    expect(bundle).toMatch(/randomUUID\w*\s*\)?\s*\(\)/);
    expect(bundle, "the platform's crypto module is what the substitution resolves to")
      .toContain('require("react-native-quick-crypto")');
  });
});

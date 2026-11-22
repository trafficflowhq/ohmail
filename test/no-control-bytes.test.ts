import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { offenderIn, TEXT, walk } from "./support/control-bytes.js";

/**
 * NO CONTROL BYTES IN A PUBLISHED TEXT FILE, OR IN A DOCUMENT THE PROJECT IS RUN FROM.
 *
 * A single stray NUL (or any control byte other than tab, newline, carriage return) turns a
 * source file into "data" for `file`, after which every binary-skipping `grep` silently skips
 * the whole file and exits 1 — indistinguishable from "the string is not there". That has
 * produced false conclusions three times: a claim that a file had zero occurrences of a word it
 * used 85 times, a usage recorder nobody could grep, and a design pass whose primitive git read
 * as binary. The publish gate refuses such a file at publish time; this guard refuses it at the
 * tree tip, where the lane that introduced it can still see its own diff.
 *
 * Every control byte in this file is written as an escape and built with `String.fromCharCode`.
 * A fixture that plants a literal one puts the byte in the guard's own source, where it stops the
 * greps this guard exists to protect — measured while writing this pass, on the first attempt.
 *
 * ── THE BYTE SET NOW MATCHES THIS SENTENCE, WHICH IT DID NOT ─────────────────────────────────
 *
 * The set read `[\x00-\x08\x0e-\x1f]` while the paragraph above claimed every byte but tab,
 * newline and carriage return: 0x0b (VT) and 0x0c (FF) were admitted, and both of them make `file`
 * answer `data` exactly as a NUL does. Measured when this was fixed (2026-09-09): widening the set
 * to the sentence finds nothing new in the payload roots — every root and file, the same hits either way
 * — so this is a claim brought into line with itself rather than a rule tightened on the tree.
 *
 * ── AND THE SCOPE, STATED TRUTHFULLY ────────────────────────────────────────────────────────
 *
 * Two scopes, because two different things are at stake and the first one used to be the whole of
 * it:
 *
 *   1. THE PUBLISHED PAYLOAD — every root the publish script copies, filtered to the text kinds it
 *      treats as text. Anything else (images, fonts, archives) is binary by nature.
 *   2. THE ROOT DOCUMENTS the project is run from: `AGENTS.md`, `README.md`, and every `.md` under
 *      the project's design notes and handoff documents. These are outside every payload root, and the cost of a
 *      control byte in them is exactly the cost this guard exists for: `AGENTS.md` is the file
 *      everybody greps. Measured 2026-09-09 by planting a NUL in the root assistant guide (then
 *      `CLAUDE.md`) — the guard stayed
 *      GREEN, one test passing, because the file is in no payload root. 443 `.md` files, 0 hits.
 *
 * What this still does NOT cover, said out loud so the next reader does not assume it: the kit's own
 * shell scripts and `.mjs` tools of the workspace's own kit (scope 2 is `.md` only), and anything else
 * outside a payload root. Control bytes in those are refused by nothing.
 *
 * The offender line names the byte, its line AND its byte offset, because the offset is what a
 * fixer needs — a control byte has no width on screen and the line alone points at nothing
 * visible.
 */
/* Scopes 1 and 2 — the publisher's payload roots and the project's documents — are the process
 * project's, in `no-control-bytes.docs.test.ts`; this file keeps scope 3. */
const ROOT = resolve(__dirname, "..");

/**
 * Scope 3: the ROOT `test/` directory — the landing gate's own exact-path selection.
 *
 * It is not a payload root and not a document, so neither scope above reached it, and three
 * literal NUL bytes sat in `test/perf-smoke-check.test.ts` reading as a clean scan: `grep` skips
 * a file holding a NUL in silence and exits 1, so the guards that run here were answering about
 * files they never read. The landing runs this directory by exact path; a byte in it is a gate
 * that cannot be searched.
 */
function censusRootTests(root: string): { offenders: string[]; scanned: number } {
  const offenders: string[] = [];
  let scanned = 0;
  for (const file of walk(resolve(root, "test"))) {
    const ext = extname(file);
    if (!TEXT.has(ext)) continue;
    scanned++;
    const o = offenderIn(file, root);
    if (o) offenders.push(o);
  }
  return { offenders, scanned };
}
describe("published text files carry no control bytes", () => {
  it("and so is every file of the root test/ directory the landing runs by exact path", () => {
    const { offenders, scanned } = censusRootTests(ROOT);
    expect(scanned, "the root test/ directory resolved to no text files — the scope is wrong").toBeGreaterThan(100);
    expect(offenders, "control byte(s) in a root test file — grep skips the file in silence, so "
      + "every guard that reads it is answering about nothing").toEqual([]);
  });

  it("scope 3 finds a planted NUL in a root test file, and admits the tree without it", () => {
    const NUL = String.fromCharCode(0x00);
    const T = mkdtempSync(join(tmpdir(), "nocb-tests-"));
    mkdirSync(join(T, "test"), { recursive: true });
    const clean = "import { it } from \"vitest\";\nit(\"x\", () => {});\n";
    const write = (rel: string, body: string) => writeFileSync(join(T, rel), body, "latin1");
    write("test/a.test.ts", clean);
    write("test/b.test.ts", clean);
    expect(censusRootTests(T).offenders, "a clean test tree must be admitted").toEqual([]);
    expect(censusRootTests(T).scanned).toBe(2);
    write("test/b.test.ts", `const s = "a${NUL}b";\n`);
    expect(censusRootTests(T).offenders, "the planted NUL must be found").toEqual([
      "test/b.test.ts:1 byte 0x00 at offset 12",
    ]);
    write("test/b.test.ts", clean);
    expect(censusRootTests(T).offenders, "and the tree is admitted again once it is gone").toEqual([]);
  });
});

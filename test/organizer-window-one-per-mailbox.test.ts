import { join } from "node:path";
import { describe, expect, it } from "vitest";
import ts from "typescript";
import { readSource } from "../apps/worker/test/_start-function.js";

/**
 * ═══ ONE STALENESS WINDOW PER MAILBOX, AND EVERY READER OF THAT MAILBOX USES IT ═══════════════
 *
 * `decideLease` and `peekLease` both take `staleAfterMs`, and both DEFAULT it to ten minutes when
 * it is absent. That default is right for a caller with no configuration and wrong for a caller
 * that has one, because the two functions are meant to describe the same folder: the gate answers
 * "may I organize", the preview answers "who holds this", and a process that asks them under two
 * different windows gets two different worlds.
 *
 * ══ WHAT WENT WRONG, MEASURED ═════════════════════════════════════════════════════════════════
 *
 * `apps/worker/src/index.ts` passed its configured `organizer.staleAfterMs` to the GATE and
 * omitted it from both `readLeasePeek` calls, so both previews silently used ten minutes. With a
 * 24-hour configured window and two installs each carrying a record 14–15 minutes old:
 *
 *   · the preview reported `stopped`, with every holder `fresh: false`;
 *   · the gate reported `stand_down` — held, per the configuration;
 *   · and the release arm, which certifies a release only when NO holder is fresh, therefore
 *     stamped the mailbox RELEASED while another install was inside its own lease.
 *
 * The other preview call had the same omission and refreshed the row that names the organizer to
 * say nobody organizes a mailbox the same pass had just stood down from. Nothing failed: both
 * calls are valid, the parameter is optional, and the default is a plausible number.
 *
 * The sidecar had it right all along, which is what made the difference legible rather than a
 * matter of opinion — it forwards its own configured window to every peek.
 *
 * ══ WHY A CENSUS AND NOT A CASE ═══════════════════════════════════════════════════════════════
 *
 * The behaviour lives inside `startWorker`, whose seams reach a real Postgres and a real mail
 * server, so a case that drives it belongs to the box suites and cannot run here. What this file
 * can do is refuse the SHAPE, and the shape is exactly what was wrong: a call that omits the
 * window. So every `readLeasePeek` call in the worker must forward one, and the check is on the
 * call's own argument rather than on a spelling anywhere in the file — a `grep` for
 * `staleAfterMs` would have passed the broken version, because the gate's forwarding is in the
 * same file.
 *
 * An UNRECOGNISED call shape is refused rather than skipped. A call whose argument is not an
 * object literal cannot be read by this census, and quietly passing it is how a census stops
 * covering the thing it was written for.
 */

const ROOT = join(__dirname, "..");

/**
 * Every file that reads the lease preview and HAS a configured window to forward. The sidecar's
 * own call moved behind `answerLeasePeek` when the phone's consent door started asking the engine
 * to look, so the core module is the reader now and the sidecar's window reaches the read through
 * it. `packages/api/src/organizer-peek.ts` calls the preview too and is deliberately NOT here: it
 * carries no configured window at all, so there is nothing for it to forward — filed as
 * ORGANIZER-PEEK-API-HAS-NO-CONFIGURED-WINDOW rather than covered by a list that would then be
 * asserting about a caller this rule has no answer for.
 */
const READERS = [
  "apps/worker/src/index.ts",
  "packages/core/src/adapters/organizer-lease.ts",
] as const;

interface Call { file: string; line: number; forwards: boolean; shape: string }

function peekCalls(rel: string): Call[] {
  const text = readSource(join(ROOT, rel));
  const src = ts.createSourceFile(rel, text, ts.ScriptTarget.ES2022, true);
  const out: Call[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isIdentifier(node.expression)
      && node.expression.text === "readLeasePeek") {
      const line = src.getLineAndCharacterOfPosition(node.getStart(src)).line + 1;
      const arg = node.arguments[0];
      if (arg === undefined || !ts.isObjectLiteralExpression(arg)) {
        out.push({ file: rel, line, forwards: false, shape: "not an object literal" });
      } else {
        /* The window may arrive as a plain property (`staleAfterMs: x`), a shorthand
           (`staleAfterMs`), or — the form a caller uses when the value is optional — inside a
           conditional spread. All three are the same statement about the call, so all three
           count, and anything else is reported as unrecognised rather than as absent. */
        const forwards = arg.properties.some((prop) => {
          if ((ts.isPropertyAssignment(prop) || ts.isShorthandPropertyAssignment(prop))
            && prop.name !== undefined
            && prop.name.getText(src) === "staleAfterMs") return true;
          return ts.isSpreadAssignment(prop) && prop.getText(src).includes("staleAfterMs");
        });
        out.push({ file: rel, line, forwards, shape: "object literal" });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(src);
  return out;
}

describe("one staleness window per mailbox", () => {
  it("finds the preview calls at all — the anti-vacuity case", () => {
    // Every assertion below is a loop over this list, and a loop over an empty list passes. If
    // the worker stops calling `readLeasePeek` by that name, this goes red first and says so
    // rather than the census silently becoming an assertion about nothing.
    // TWO since the sidecar's own call moved behind `answerLeasePeek` (2026-09-12): the worker's
    // release arm and the core module's, re-derived from the call sites rather than left at the
    // three the two original files carried.
    const all = READERS.flatMap(peekCalls);
    expect(all.length, `readLeasePeek calls found in ${READERS.join(", ")}`).toBeGreaterThanOrEqual(2);
  });

  it("refuses a call whose argument this census cannot read", () => {
    const unreadable = READERS.flatMap(peekCalls).filter((c) => c.shape !== "object literal");
    expect(
      unreadable.map((c) => `${c.file}:${c.line} — ${c.shape}`),
      "a readLeasePeek call this census cannot inspect: teach it the shape rather than leaving it uncovered",
    ).toEqual([]);
  });

  it("forwards the configured window from every reader of the preview", () => {
    const omitting = READERS.flatMap(peekCalls).filter((c) => !c.forwards);
    expect(
      omitting.map((c) => `${c.file}:${c.line}`),
      "this readLeasePeek call defaults to ten minutes while its own gate uses the configured "
      + "window, so the preview and the gate describe different worlds for one folder",
    ).toEqual([]);
  });
});

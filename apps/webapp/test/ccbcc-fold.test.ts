/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { ccBccOpen } from "../app/shell/RecipientField";
import { formatRecipientChips } from "@ohmail/app-logic/writing/compose-from";

/**
 * CC/BCC WAIT BEHIND THE TOGGLE — one rule, every composer instance.
 *
 * Editing To is the main act, so the Cc and Bcc rows collapse behind the "Kopie/Blindkopie"
 * affordance while BOTH are empty, and open THEMSELVES the moment either carries text — a
 * reply-all whose Cc holds real people must never hide recipients the user cannot see they
 * have. The rule lived twice (Compose's `ccBccOpen` expression and `ReplyRecipients`' `open`),
 * which is two copies one edit apart from folding differently; it is ONE exported derivation
 * now (`RecipientField.ccBccOpen`) and the source guard below is what keeps every instance —
 * fresh compose, the mailto-seeded compose, reply, reply-all, the inline forward — reading it
 * rather than growing a flag of its own.
 *
 * The behavioral halves are pinned where the surfaces live: the plain reply's collapsed rows
 * and the toggle's reveal in `reply-recipients.test.tsx`, the compose form's in
 * `compose-composition.test.ts`, the inline forward's in `thread-inline-forward.test.tsx`.
 */

describe("the one derivation", () => {
  it("both empty ⇒ collapsed; the toggle reveals; values force open — never closed", () => {
    expect(ccBccOpen("", "", false)).toBe(false);
    expect(ccBccOpen("  ", "\n", false), "whitespace is not a recipient").toBe(false);
    expect(ccBccOpen("", "", true), "the toggle press").toBe(true);
    expect(ccBccOpen("cc@x.test, ", "", false), "a Cc forces the rows open").toBe(true);
    expect(ccBccOpen("", "blind@x.test, ", false), "…and so does a Bcc").toBe(true);
  });

  it("a reply-all's prefilled Cc auto-expands: the chip prefill is non-empty by construction", () => {
    // `InlineReply.expand` seeds `cc: formatRecipientChips(all.cc)`; a surviving reply-all Cc
    // therefore always opens the rows, and an EMPTY list stays "" — collapsed.
    expect(ccBccOpen(formatRecipientChips([{ name: null, address: "cc@x.test" }]), "", false)).toBe(true);
    expect(ccBccOpen(formatRecipientChips([]), "", false)).toBe(false);
  });
});

function readSource(rel: string): string {
  const fromRoot = `apps/webapp/${rel}`;
  return readFileSync(existsSync(fromRoot) ? fromRoot : rel, "utf8");
}
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[^\n]*?\/\/.*$/gm, "");

describe("one derivation, every consumer — no instance folds by a rule of its own", () => {
  it("Compose CALLS ccBccOpen(; the reply stack does NOT fold at all", () => {
    // The failure mode this guards is quiet: a surface that re-derives the fold inline keeps
    // working today and drifts the first time the rule moves. Comments are stripped because
    // the prose here quotes the code it describes.
    expect(stripComments(readSource("app/views/ComposeView.tsx"))).toContain("ccBccOpen(");
    // THE REPLY/FORWARD STACK STOPPED FOLDING, DELIBERATELY (2026-08-27): opening it IS the
    // "change recipients" act, so Cc and Bcc show at once — no second click. The fold rule is
    // the compose form's alone now, and InlineReply may neither call it nor re-derive it: a
    // toggle reappearing there is the two-clicks-for-one-decision defect coming back.
    expect(
      stripComments(readSource("app/shell/InlineReply.tsx")),
      "the reply stack folds Cc/Bcc again — opening it must reveal all three rows at once",
    ).not.toContain("ccBccOpen(");
    // …and nobody re-derives it: the expression's shape appears nowhere but the one export.
    for (const rel of ["app/views/ComposeView.tsx", "app/shell/InlineReply.tsx"]) {
      expect(
        stripComments(readSource(rel)),
        `${rel} re-derives the fold inline`,
      ).not.toMatch(/\.trim\(\) !== ""\s*\|\|.*\.trim\(\) !== ""/);
    }
  });
});

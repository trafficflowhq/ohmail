/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { within } from "@testing-library/react";
import { formatRecipientChips } from "@ohmail/app-logic/writing/compose-from";
import { resetComposerForTest } from "@ohmail/app-logic/writing/compose";
import { mountWriting, rounds, unmountWritings, type WritingWorld } from "./_write-1-writing.js";
import { act } from "./_draft-shell.js";

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

/*
 * THE ONE DERIVATION, read over Write's new letter (the older tests' sorting): today's export
 * (`RecipientField.ccBccOpen`) leaves with the switch; the fold is Write's people line's now
 * (`packages/app/src/write/head/People.tsx`), drawn by the kit's Recipients. The rows a person sees are read by role
 * and name (the combobox "Cc", "Bcc"), the toggle pressed by its name ("Cc Bcc"), the lines handed as the composition
 * holds them (`_write-1-writing.tsx`).
 */
afterEach(async () => {
  await unmountWritings();
  resetComposerForTest();
});
/** Whether the Cc and Bcc rows stand on the letter whose lines hold `cc` and `bcc`; `press` presses the toggle first. */
async function ccBccOpen(cc: string, bcc: string, press: boolean): Promise<boolean> {
  await unmountWritings();
  resetComposerForTest();
  const w: WritingWorld = await mountWriting({ view: true });
  await act(async () => w.now().onComposeFields({ ...w.now().compose, cc, bcc }));
  await rounds(2);
  if (press) {
    const toggle = within(w.el).getByRole("button", { name: "Cc Bcc" });
    await act(async () => toggle.click());
    await rounds(2);
  }
  const row = (name: string): boolean => within(w.el).queryByRole("combobox", { name }) !== null;
  return row("Cc") && row("Bcc");
}

describe("the one derivation", () => {
  it("both empty ⇒ collapsed; the toggle reveals; values force open — never closed", async () => {
    expect(await ccBccOpen("", "", false)).toBe(false);
    expect(await ccBccOpen("  ", "\n", false), "whitespace is not a recipient").toBe(false);
    expect(await ccBccOpen("", "", true), "the toggle press").toBe(true);
    expect(await ccBccOpen("cc@x.test, ", "", false), "a Cc forces the rows open").toBe(true);
    expect(await ccBccOpen("", "blind@x.test, ", false), "…and so does a Bcc").toBe(true);
  });

  it("a reply-all's prefilled Cc auto-expands: the chip prefill is non-empty by construction", async () => {
    // A reply-all seeds `cc: formatRecipientChips(all.cc)`; a surviving reply-all Cc
    // therefore always opens the rows, and an EMPTY list stays "" — collapsed.
    expect(await ccBccOpen(formatRecipientChips([{ name: null, address: "cc@x.test" }]), "", false)).toBe(true);
    expect(await ccBccOpen(formatRecipientChips([]), "", false)).toBe(false);
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
    const write = "../../packages/app/src/write/";
    const head = stripComments(readSource(write + "head/People.tsx"));
    const letter = stripComments(readSource(write + "Letter.tsx"));
    const reply = stripComments(readSource(write + "Reply.tsx"));
    const readsBoth = /rows\.cc\.trim\(\) !== "" \|\| rows\.bcc\.trim\(\) !== ""/g;
    expect(head.match(readsBoth)).toHaveLength(1);
    expect(head).toMatch(/allOpen === true \|\| opened \|\| rows\.cc/);
    expect(letter).toMatch(/<People\b/);
    expect(reply).toMatch(/<People[\s\S]*?\ballOpen\b/);
    for (const source of [letter, reply]) {
      expect(source).not.toMatch(/\.trim\(\) !== ""\s*\|\|.*\.trim\(\) !== ""/);
    }
  });
});

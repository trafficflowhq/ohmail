/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act } from "react";
import { settleEditor } from "./_first-paint.js";
import { publicPath } from "../../../test/support/public-root.mjs";
import { readChangelogText } from "../../../scripts/changelog-fold.mjs";
import { fireEvent, screen } from "@testing-library/react";
import writeEn from "../../../packages/app/messages/write.en.json";
import { mountWriting, rounds, unmountWritings } from "./_write-1-writing.js";

/**
 * ═══ A SIGNATURE WITH FORMATTING IN IT — the pane that writes it, the block that shows it ════
 *
 * Settings → Signatures now mounts the COMPOSE EDITOR, so the value it saves may be markup, and
 * the store keeps two shapes of one value (the markup is authoritative; the server derives the
 * text). This file owns the two client surfaces that shape reaches, and the property that ties
 * them together is a SHIPPED CLAIM rather than a preference:
 *
 *   "What you see is what ships" — the released notes say this about signatures, in those words.
 *
 * So a pane that stores bold while the block below the message renders plain text would make a
 * published sentence false, which this repository treats as a defect in the same class as a
 * broken feature. The block therefore renders the markup whenever it is showing what the mailbox
 * stores, and the moment somebody edits the block their words are plain text in both halves of
 * the message — a visible transition, not a silent divergence.
 *
 * ── WHAT IS DELIBERATELY NOT HERE ────────────────────────────────────────────────────────────
 *
 * The block's grammar is not re-tested: it is the compose editor's own component, and
 * `rich-editor.test.tsx` owns what that editor offers and refuses. Testing it again here would
 * pin the same decision in two places, which is how two allow-lists come to disagree.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const TEXT = { "mb-one": "Anna\nohmail", "mb-two": "— Team Two" } as const;
const HTML = { "mb-one": "<p><strong>Anna</strong><br />ohmail</p>" } as const;
/** A markup map that names another sender only: the letter's own sender stores none. */
const W_HTML_OTHER = { "mb-other": HTML["mb-one"] } as const;

afterEach(() => { vi.restoreAllMocks(); });

/* ══ the block — what it shows for each of the two shapes ══════════════════════════════════ */


/*
 * OVER WRITE (the older tests' sorting): today's `SignatureBlock` leaves with the switch. The block is
 * Write's (`packages/app/src/write/text/Signature.ts` in the kit's `Composer`), drawn under Write's new letter as the
 * composition stands it (`_write-1-writing.tsx`), the letter's sender the roster's `mb1`: a stored signature for it
 * is the case's mailbox, a map without it the case's other sender. Found by role and name: a plain block is the
 * field named for the signature, a formatted one the group of that name holding the shell's editor, read-only; its
 * presses are "Edit as text" and Remove by their names. What the block reports is the letter's signature state.
 */
const SIG = writeEn.write.signature;
const W_TEXT = { mb1: TEXT["mb-one"] } as const;
const W_HTML = { mb1: HTML["mb-one"] } as const;
const plainField = (): HTMLElement | null => screen.queryByRole("textbox", { name: SIG.label });
const formattedBlock = (): HTMLElement | null => screen.queryByRole("group", { name: SIG.label });

describe("SignatureBlock — the block shows whichever shape the send will carry", () => {
  afterEach(unmountWritings);

  it("renders the stored MARKUP as formatting, not as tags, while following", async () => {
    await mountWriting({ view: true, signatures: W_TEXT, signaturesHtml: W_HTML });
    await settleEditor();
    const block = formattedBlock()!;
    expect(block, "no block for a sender with a stored signature").not.toBeNull();

    // The formatting is real elements. A `<strong>` in the DOM is the whole point: the tags must
    // not reach the reader as characters, which is what a textarea holding markup would do.
    expect(block.querySelector("strong")?.textContent).toBe("Anna");
    expect(block.textContent).not.toContain("<strong>");
    // And the plain textarea is NOT the surface for this shape — a signature with formatting is
    // never shown as its own source.
    expect(plainField()).toBeNull();
  });

  it("keeps today's textarea, byte for byte, for a signature with NO markup", async () => {
    await mountWriting({ view: true, signatures: { mb1: TEXT["mb-two"] }, signaturesHtml: W_HTML_OTHER });
    const text = plainField()!;
    expect(text, "a plain signature lost its textarea").not.toBeNull();
    expect(text.textContent).toBe("— Team Two");
  });

  /**
   * A SHELL THAT SUPPLIES NO MARKUP MAP AT ALL IS ITS OWN STATE, and it must not be confused
   * with "this mailbox has no markup". The desktop window and the demo hand this component no
   * markup map; an absent prop therefore means "nothing here can carry formatting", and the
   * answer is today's textarea — the fail-safe direction, because the plain half is always
   * present and always the same words.
   * (Over Write: the composition hands Write an empty markup map where its host hands none.)
   */
  it("falls back to the textarea when the shell supplies no markup map", async () => {
    await mountWriting({ view: true, signatures: W_TEXT, signaturesHtml: {} });
    const text = plainField()!;
    expect(text, "no markup map should mean the plain block, not an empty one").not.toBeNull();
    expect(text.textContent).toBe("Anna\nohmail");
  });

  it("the strike still strikes, on the formatted shape too", async () => {
    const w = await mountWriting({ view: true, signatures: W_TEXT, signaturesHtml: W_HTML });
    await settleEditor();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: SIG.remove })); });
    await rounds(2);
    expect(w.now().compose.sig).toEqual({ kind: "removed" });
  });

  /**
   * THE TRANSITION IS THE HONEST PART. Editing a formatted block cannot keep the formatting —
   * `edited` holds a string, because that is what both halves of the message will carry — so the
   * control says what it does, and after it the block IS the plain textarea holding the derived
   * words. What is shown is what ships, in both states and across the step between them.
   */
  it("edit-as-text reports the derived words and hands over to the plain textarea", async () => {
    const w = await mountWriting({ view: true, signatures: W_TEXT, signaturesHtml: W_HTML });
    await settleEditor();
    const edit = screen.queryByRole("button", { name: SIG.editAsTextHint });
    expect(edit, "a formatted block offers no way to edit it").not.toBeNull();
    await act(async () => { fireEvent.click(edit!); });
    await rounds(2);
    // The DERIVED text — the same words the message's plain part carries, not the markup.
    expect(w.now().compose.sig).toEqual({ kind: "edited", text: "Anna\nohmail" });
  });

  it("renders the plain textarea once the block is edited, whatever the mailbox stores", async () => {
    await mountWriting({ view: true, signatures: W_TEXT, signaturesHtml: W_HTML });
    await settleEditor();
    // The block edited: through its own press, then written over (Write's letter takes its state from the person).
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: SIG.editAsTextHint })); });
    await rounds(2);
    const typed = plainField()!;
    await act(async () => {
      typed.focus();
      typed.textContent = "my own sign-off";
      fireEvent.input(typed);
      fireEvent.blur(typed);
    });
    await rounds(2);
    const text = plainField()!;
    expect(text.textContent).toBe("my own sign-off");
    expect(formattedBlock(), "an edited block still rendered markup").toBeNull();
    expect(text.querySelector("strong"), "an edited block still rendered markup").toBeNull();
  });
});

describe("the copy does not claim a signature is plain text", () => {
  const read = (p: string): string => readFileSync(resolve(process.cwd(), p), "utf8");

  /**
   * A STANDING GUARD, not a one-off. Nothing claims plain-text-only today — the pane's copy
   * describes where a signature appears and never what it may contain — and this keeps it that
   * way: the sentence would be false the moment the editor shipped, and site and product copy
   * are judged against the code here.
   */
  it("no signature copy in either locale says the value is plain text", () => {
    for (const locale of ["en", "de"]) {
      const json = JSON.parse(read(`apps/webapp/messages/${locale}.json`)) as {
        settings: { signatures: Record<string, string> };
        compose: Record<string, string>;
      };
      const copy = [
        ...Object.values(json.settings.signatures),
        ...Object.entries(json.compose)
          .filter(([k]) => /^signature/i.test(k)).map(([, v]) => v),
      ].join(" ");
      // "plain text" / "plain-text" / "nur Text" — a claim about what the value may contain.
      expect(copy, `${locale} signature copy claims plain text`)
        .not.toMatch(/plain[ -]?text|nur\s+Text|reiner\s+Text/i);
    }
  });

  /**
   * THE PUBLISHED SENTENCE IS THE REASON THE BLOCK RENDERS MARKUP. It is quoted here so that a
   * change which stops the block rendering formatting fails beside the claim it breaks, rather
   * than silently making a released note untrue.
   */
  it("the released note's what-you-see-is-what-ships sentence is still backed by the block", () => {
    // Through readChangelogText: a pinned sentence sits in changelog.d/ until the release folds it.
    const changelog = readChangelogText(dirname(publicPath("CHANGELOG.md")));
    expect(changelog, "the claim this guard exists for is gone — re-read it before deleting me")
      .toContain("What you see is what ships");
    /* OVER WRITE (the older tests' sorting): today's block file leaves with the switch. Write's block
       (`write/text/Signature.ts`) asks its signature of Write's model (`beside.signature`), and the model answers it
       with the call below (`writing-of.ts`, `writeBesideOf`'s `signature`): the guard reads both, the call's form kept. */
    expect(read("packages/app/src/write/text/Signature.ts")).toContain("beside.signature(letter.state ?? FOLLOWING, letter.mailboxId, w.signatures)");
    const block = read("packages/app-logic/src/writing/writing-of.ts");
    /**
     * THE CALL, not the identifier — found by a mutation of this very guard.
     *
     * Replacing the call with `null` left the IMPORT in place, so a grep for the bare name
     * stayed green while the block rendered plain text for every shape. An identifier is
     * satisfied by an import, a type position or a comment; only the call form says the block
     * asks the question. The same trap as reading "no caller" off a `grep "fn("`, from the
     * other side.
     */
    expect(block).toContain("effectiveSignatureHtml(state, stored.html, mailboxId)");
  });
});

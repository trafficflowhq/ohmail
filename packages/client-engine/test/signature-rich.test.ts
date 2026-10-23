import { describe, it, expect } from "vitest";
import {
  SIG_FOLLOWING, effectiveSignature, effectiveSignatureHtml, signatureHtml, withSignature,
  type SignatureState,
} from "../src/signature.js";

/**
 * ═══ A FORMATTED SIGNATURE, AND THE HALF A PLAINTEXT READER GETS (0.16, item 11) ═════════════
 *
 * The stored signature grew a SECOND half: `mailboxes.signature_html` is the markup the Settings
 * editor wrote, and `mailboxes.signature` is the text the SERVER derived from it. This file pins
 * the client half of that — which of the two halves each surface reads, and the one property the
 * whole change is worthless without: a mailbox that stores NO markup produces the same bytes it
 * produced before this existed.
 *
 * ── THE STATE MODEL DOES NOT MOVE, AND THAT IS THE DESIGN ────────────────────────────────────
 *
 * `effectiveSignature` still answers the TEXT and is untouched. The markup is a SECOND
 * derivation, {@link effectiveSignatureHtml}, and it answers markup only in the `following`
 * state — the one state in which the block is showing the mailbox's stored value. The moment
 * the reader types in the block their words are plain text (`edited` holds a string, as it
 * always has), so the markup is dropped and BOTH halves of the send carry what they typed.
 * That is what keeps the published sentence "what you see is what ships" true: before a
 * keystroke the block renders the markup and the markup ships; after one it renders their text
 * and their text ships. A third state where the block showed bold and the wire carried
 * something else is the state this split exists to make unrepresentable.
 */

const TEXT: Readonly<Record<string, string>> = {
  "mb-one": "Best regards\nAnna",
  "mb-two": "— Team Two",
};
const HTML: Readonly<Record<string, string>> = {
  "mb-one": "<p><strong>Best regards</strong><br>Anna</p>",
};

describe("effectiveSignatureHtml — the stored markup, and only while nothing was said", () => {
  it("answers the resolved mailbox's markup while following", () => {
    expect(effectiveSignatureHtml(SIG_FOLLOWING, HTML, "mb-one"))
      .toBe("<p><strong>Best regards</strong><br>Anna</p>");
  });

  it("answers null for a mailbox that stores text but no markup", () => {
    // `mb-two` HAS a signature — it just has no formatting in it. The text half carries it.
    expect(effectiveSignature(SIG_FOLLOWING, TEXT, "mb-two")).toBe("— Team Two");
    expect(effectiveSignatureHtml(SIG_FOLLOWING, HTML, "mb-two")).toBeNull();
  });

  it("answers null once the reader has EDITED the block — their plain words win both halves", () => {
    const edited: SignatureState = { kind: "edited", text: "my own sign-off" };
    expect(effectiveSignature(edited, TEXT, "mb-one")).toBe("my own sign-off");
    expect(effectiveSignatureHtml(edited, HTML, "mb-one")).toBeNull();
  });

  it("answers null for a struck block, and for a sender nothing can name", () => {
    expect(effectiveSignatureHtml({ kind: "removed" }, HTML, "mb-one")).toBeNull();
    expect(effectiveSignatureHtml(SIG_FOLLOWING, HTML, null)).toBeNull();
  });

  it("answers null for markup that is blank after trimming", () => {
    expect(effectiveSignatureHtml(SIG_FOLLOWING, { "mb-one": "   \n " }, "mb-one")).toBeNull();
  });
});

describe("withSignature — the markup half rides beside the derived text", () => {
  const rich = { body: "hello", html: "<p>hello</p>" } as const;
  const plain = { body: "hello" } as const;

  it("appends the STORED markup to html and the DERIVED text to body", () => {
    const out = withSignature({ ...rich }, "Best regards\nAnna", HTML["mb-one"]!);
    // The plain half is the text the server derived from that markup — what a client reading
    // only `text/plain` sees, and the same words.
    expect(out.body).toBe("hello\n\nBest regards\nAnna");
    expect(out.html).toBe("<p>hello</p><p><strong>Best regards</strong><br>Anna</p>");
  });

  it("leaves a PLAIN mutation plain — a formatted signature never mints an html half", () => {
    // `html` absent is what makes the send a single `text/plain` part (`compose.ts`). A
    // signature must not turn somebody's plain note into a `multipart/alternative`.
    const out = withSignature({ ...plain }, "Best regards\nAnna", HTML["mb-one"]!);
    expect(out.body).toBe("hello\n\nBest regards\nAnna");
    expect("html" in out).toBe(false);
  });

  /* `html: null` is an editor whose formatting was removed. Appending to it gave
     "null<p>…", and the server derives the plain text from the markup, so the words were lost. */
  it("keeps html: null and an empty html as given — the text signature rides the body", () => {
    for (const html of [null, ""]) {
      const out = withSignature({ body: "hello", html }, "Best regards\nAnna", HTML["mb-one"]!);
      expect(out.body).toBe("hello\n\nBest regards\nAnna");
      expect(out.html).toBe(html);
    }
  });

  it("falls back to escaping the text when there is NO stored markup", () => {
    const out = withSignature({ ...rich }, "a <b> & c", null);
    expect(out.html).toBe(`<p>hello</p>${signatureHtml("a <b> & c")}`);
  });

  /**
   * THE REGRESSION GUARD, AND IT IS A BYTE COMPARE ON PURPOSE.
   *
   * Every mailbox on every account today stores text and no markup. The two-argument call is
   * what every caller that has not been taught the third argument still makes — the phone's two
   * send arms among them (`apps/mobile/src/state/live.ts`), which carry no `html` at all. If
   * this pair ever diverges, the change stopped being a feature and became a change to
   * everybody's mail.
   */
  it("is byte-identical to the two-argument call for a signature with no markup", () => {
    for (const sig of ["Best regards\nAnna", "  indented", "a\tb", '<img src=x onerror="x">']) {
      expect(JSON.stringify(withSignature({ ...rich }, sig, null)))
        .toBe(JSON.stringify(withSignature({ ...rich }, sig)));
      expect(JSON.stringify(withSignature({ ...plain }, sig, null)))
        .toBe(JSON.stringify(withSignature({ ...plain }, sig)));
    }
  });

  it("returns the mutation UNCHANGED when there is no block at all", () => {
    const m = { ...rich };
    expect(withSignature(m, null, HTML["mb-one"]!)).toBe(m);
  });
});

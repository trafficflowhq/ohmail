/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement as h } from "react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { settleEditor } from "./_first-paint.js";
import { SIG_FOLLOWING, type SignatureState } from "../app/shell/signature";
import { publicPath } from "../../../test/support/public-root.mjs";

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

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const mount = async (node: React.ReactNode): Promise<void> => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", children: node,
    }));
  });
};

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

/* ══ the block — what it shows for each of the two shapes ══════════════════════════════════ */

async function mountBlock(props: {
  sig: SignatureState;
  onSig: (next: SignatureState) => void;
  signatures: Readonly<Record<string, string>>;
  signaturesHtml?: Readonly<Record<string, string>>;
  mailboxId: string | null;
}): Promise<void> {
  const { SignatureBlock } = await import("../app/shell/SignatureBlock.js");
  await mount(h(SignatureBlock, { disabled: false, ...props }));
  // The block renders its editor behind `RichEditorLazy` — one seam, one helper.
  await settleEditor();
}

describe("SignatureBlock — the block shows whichever shape the send will carry", () => {
  it("renders the stored MARKUP as formatting, not as tags, while following", async () => {
    await mountBlock({
      sig: SIG_FOLLOWING, onSig: () => {},
      signatures: TEXT, signaturesHtml: HTML, mailboxId: "mb-one",
    });
    const block = host!.querySelector<HTMLElement>(".sig-block")!;
    expect(block, "no block for a sender with a stored signature").not.toBeNull();

    // The formatting is real elements. A `<strong>` in the DOM is the whole point: the tags must
    // not reach the reader as characters, which is what a textarea holding markup would do.
    expect(block.querySelector("strong")?.textContent).toBe("Anna");
    expect(block.textContent).not.toContain("<strong>");
    // And the plain textarea is NOT the surface for this shape — a signature with formatting is
    // never shown as its own source.
    expect(block.querySelector(".sig-text")).toBeNull();
  });

  it("keeps today's textarea, byte for byte, for a signature with NO markup", async () => {
    await mountBlock({
      sig: SIG_FOLLOWING, onSig: () => {},
      signatures: TEXT, signaturesHtml: HTML, mailboxId: "mb-two",
    });
    const text = host!.querySelector<HTMLTextAreaElement>(".sig-text")!;
    expect(text, "a plain signature lost its textarea").not.toBeNull();
    expect(text.value).toBe("— Team Two");
  });

  /**
   * A SHELL THAT SUPPLIES NO MARKUP MAP AT ALL IS ITS OWN STATE, and it must not be confused
   * with "this mailbox has no markup". The desktop window and the demo hand this component no
   * markup map; an absent prop therefore means "nothing here can carry formatting", and the
   * answer is today's textarea — the fail-safe direction, because the plain half is always
   * present and always the same words.
   */
  it("falls back to the textarea when the shell supplies no markup map", async () => {
    await mountBlock({
      sig: SIG_FOLLOWING, onSig: () => {}, signatures: TEXT, mailboxId: "mb-one",
    });
    const text = host!.querySelector<HTMLTextAreaElement>(".sig-text")!;
    expect(text, "no markup map should mean the plain block, not an empty one").not.toBeNull();
    expect(text.value).toBe("Anna\nohmail");
  });

  it("the strike still strikes, on the formatted shape too", async () => {
    const seen: SignatureState[] = [];
    await mountBlock({
      sig: SIG_FOLLOWING, onSig: (n) => seen.push(n),
      signatures: TEXT, signaturesHtml: HTML, mailboxId: "mb-one",
    });
    host!.querySelector<HTMLButtonElement>(".sig-remove")!.click();
    expect(seen).toEqual([{ kind: "removed" }]);
  });

  /**
   * THE TRANSITION IS THE HONEST PART. Editing a formatted block cannot keep the formatting —
   * `edited` holds a string, because that is what both halves of the message will carry — so the
   * control says what it does, and after it the block IS the plain textarea holding the derived
   * words. What is shown is what ships, in both states and across the step between them.
   */
  it("edit-as-text reports the derived words and hands over to the plain textarea", async () => {
    const seen: SignatureState[] = [];
    await mountBlock({
      sig: SIG_FOLLOWING, onSig: (n) => seen.push(n),
      signatures: TEXT, signaturesHtml: HTML, mailboxId: "mb-one",
    });
    const edit = host!.querySelector<HTMLButtonElement>(".sig-edit-text")!;
    expect(edit, "a formatted block offers no way to edit it").not.toBeNull();
    edit.click();
    // The DERIVED text — the same words the message's plain part carries, not the markup.
    expect(seen).toEqual([{ kind: "edited", text: "Anna\nohmail" }]);
  });

  it("renders the plain textarea once the block is edited, whatever the mailbox stores", async () => {
    await mountBlock({
      sig: { kind: "edited", text: "my own sign-off" }, onSig: () => {},
      signatures: TEXT, signaturesHtml: HTML, mailboxId: "mb-one",
    });
    const text = host!.querySelector<HTMLTextAreaElement>(".sig-text")!;
    expect(text.value).toBe("my own sign-off");
    expect(host!.querySelector("strong"), "an edited block still rendered markup").toBeNull();
  });
});

/* ══ the pane — the editor it mounts, and the shape it saves ═══════════════════════════════ */

describe("SignaturesRow — the compose editor, and one of two save shapes", () => {
  const MAILBOXES = [{ id: "mb-one", address: "one@example.test" }] as const;

  async function mountRow(
    signatures: Record<string, string>,
    signaturesHtml: Record<string, string>,
    save: (id: string, text: string | null, html?: string | null) => Promise<void>,
  ): Promise<void> {
    const { SignaturesRow } = await import("../app/shell/SignaturesRow.js");
    await mount(h(SignaturesRow, {
      mailboxes: MAILBOXES as unknown as ReadonlyArray<{ id: string; address: string }>,
      signatures,
      signaturesHtml,
      signatureSources: {},
      setMailboxSignature: (async (id: string, t: string | null, ht?: string | null) => {
        await save(id, t, ht);
        return { signatures, signaturesHtml };
      }) as never,
    }));
  }

  it("mounts the compose editor rather than a bare textarea", async () => {
    await mountRow({}, {}, async () => {});
    // The compose editor is a ProseMirror surface; a plain `<textarea>` is what this replaces.
    expect(host!.querySelector(".ProseMirror"), "the pane is still a plain textarea").not.toBeNull();
  });

  it("shows the stored formatting as formatting, in the editor and in the preview", async () => {
    await mountRow({ "mb-one": "Anna\nohmail" }, { "mb-one": HTML["mb-one"] }, async () => {});
    // Both surfaces render real elements. The preview exists to show the block as a message will
    // carry it, so it must speak the same grammar the editor does — it is the same component.
    expect(host!.querySelectorAll("strong").length).toBeGreaterThanOrEqual(2);
    expect(host!.querySelector(".sig-settings-preview")).not.toBeNull();
    expect(host!.textContent).not.toContain("<strong>");
  });

  /* ── A MAILBOX THIS INSTALL ONLY READS — the editor is a report ──────────────────────────── */

  async function mountRole(
    role: string | null | undefined, signatures: Record<string, string>,
    /* WHOSE signature the row is showing. A case that does not say leaves it ABSENT, which is
       the wire of a server too old to answer and must read as local. */
    signatureSources: Record<string, "organizer" | "local"> = {},
  ): Promise<void> {
    const { SignaturesRow } = await import("../app/shell/SignaturesRow.js");
    await mount(h(SignaturesRow, {
      mailboxes: [{ id: "mb-one", address: "one@example.test", organizerRole: role }] as never,
      signatures, signaturesHtml: {}, signatureSources,
      setMailboxSignature: (async () => ({ signatures, signaturesHtml: {} })) as never,
    }));
  }

  /**
   * The signature in force on a mailbox somebody else organizes is THEIRS, and this install's row
   * is inert. So the pane shows their text and offers no way to change it: a Save here would
   * write a value no message will ever carry, and an editor that takes words and drops them is
   * the exact false state the rest of this work exists to remove.
   */
  it("a reader mailbox shows the organizer's text and offers no Save", async () => {
    await mountRole("reader", { "mb-one": "-- \nfrom the organizer" }, { "mb-one": "organizer" });
    expect(host!.textContent, "the organizer's sign-off is not on screen")
      .toContain("from the organizer");
    expect(host!.textContent).toContain(messages.settings.signatures.mailboxRead);
    expect(host!.querySelector(".sig-settings-actions"), "a reader was offered a Save button")
      .toBeNull();
    const editor = host!.querySelector<HTMLElement>(".sig-settings-editor .ProseMirror");
    expect(editor, "the reader's editor did not mount at all").not.toBeNull();
    expect(editor!.getAttribute("contenteditable"), "the reader's editor takes typing")
      .not.toBe("true");
  });

  /**
   * THE OTHER READER, and the one this row got wrong: an install that only reads a mailbox whose
   * organizer has PUBLISHED NOTHING. There is no organizer signature to show, so the value on
   * screen is this install's own row — the one its sends actually carry — and reporting it as
   * somebody else's while removing Save leaves a person unable to change the sign-off going out.
   */
  it("a reader whose organizer has published nothing keeps its own editor and its Save", async () => {
    await mountRole("reader", { "mb-one": "-- \nmine" }, { "mb-one": "local" });
    expect(host!.textContent, "a local signature was reported as the organizer's")
      .not.toContain(messages.settings.signatures.mailboxRead);
    expect(host!.textContent).toContain(messages.settings.signatures.mailboxOn);
    expect(host!.querySelector(".sig-settings-actions"), "the reader lost the Save button")
      .not.toBeNull();
    const editor = host!.querySelector<HTMLElement>(".sig-settings-editor .ProseMirror");
    expect(editor!.getAttribute("contenteditable"), "the reader's own editor refuses typing")
      .toBe("true");
  });

  /* AN ABSENT MAP IS NOT A POSITIVE FACT. A server too old to answer `signatureSources` omits it,
     and the row must then behave as it did before the field existed rather than lock every reader
     out of a signature nobody else has published. */
  it("a reader with no sources map at all is not locked out", async () => {
    await mountRole("reader", { "mb-one": "-- \nmine" });
    expect(host!.textContent).not.toContain(messages.settings.signatures.mailboxRead);
    expect(host!.querySelector(".sig-settings-actions")).not.toBeNull();
  });

  /* THE OTHER HALF, and the one a merge is most likely to lose: an install that OWNS its mailbox
     must keep every control it had. Absent is tested beside "organizer" on purpose — a roster too
     old to carry the field must not lock the editors on an account that organizes its own mail. */
  for (const role of ["organizer", null, undefined] as const) {
    it(`an organizer mailbox (role ${String(role)}) keeps its editor and its Save`, async () => {
      await mountRole(role, { "mb-one": "-- \nmine" });
      expect(host!.textContent).not.toContain(messages.settings.signatures.mailboxRead);
      expect(host!.querySelector(".sig-settings-actions"), "the account holder lost the Save button")
        .not.toBeNull();
      const editor = host!.querySelector<HTMLElement>(".sig-settings-editor .ProseMirror");
      expect(editor!.getAttribute("contenteditable"), "the account holder's editor became read-only")
        .toBe("true");
    });
  }
});

/* ══ claims — the published sentence, and the copy that describes the pane ═════════════════ */

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
    const changelog = readFileSync(publicPath("CHANGELOG.md"), "utf8");
    expect(changelog, "the claim this guard exists for is gone — re-read it before deleting me")
      .toContain("What you see is what ships");
    const block = read("apps/webapp/app/shell/SignatureBlock.tsx");
    /**
     * THE CALL, not the identifier — found by a mutation of this very guard.
     *
     * Replacing the call with `null` left the IMPORT in place, so a grep for the bare name
     * stayed green while the block rendered plain text for every shape. An identifier is
     * satisfied by an import, a type position or a comment; only the call form says the block
     * asks the question. The same trap as reading "no caller" off a `grep "fn("`, from the
     * other side.
     */
    expect(block).toContain("effectiveSignatureHtml(sig, signaturesHtml ?? {}, mailboxId)");
  });
});

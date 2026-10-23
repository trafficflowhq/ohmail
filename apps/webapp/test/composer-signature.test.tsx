/** @vitest-environment jsdom */
import { describe, expect, it, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement as h } from "react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import {
  SIG_FOLLOWING,
  effectiveSignature,
  signatureHtml,
  withSignature,
  type SignatureState,
} from "../app/shell/signature";
import { readReplyMeta, writeReplyMeta } from "../app/shell/mail-send";
import { composePlan, type ComposeFields } from "../app/shell/compose";

/**
 * ═══ THE SIGNATURE ON AN OUTGOING MESSAGE — the model, the serialization, the block ═════════
 *
 * The rules under test are the slice's two prime mutation targets, named as such:
 *
 *  · FOLLOWS-FROM-UNLESS-EDITED. The block follows the From selector — switching the sending
 *    mailbox swaps to that mailbox's signature — UNLESS the user removed or hand-edited it,
 *    and then their choice wins on every From. (`effectiveSignature`)
 *  · SERIALIZES-EXACTLY-AS-SHOWN. What the block shows is what the send appends: one
 *    derivation feeds both, the plain body gains the text after one blank line, and a rich
 *    body gains the SAME text as escaped markup — both halves or neither. A `null` leaves the
 *    mutation object IDENTICAL, so the no-signature request stays byte-for-byte what it was.
 *    (`withSignature`)
 *
 * The send-mid-edit rule ("ship what is shown") is these two composed: the block renders
 * `effectiveSignature(state, map, from)` and the shell seals `withSignature(mutation,
 * effectiveSignature(state, map, from))` from the SAME state at press time — the source guard
 * at the bottom pins that both send paths go through the pair.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MAP = { "mb-one": "Best regards\nAnna", "mb-two": "— Team Two" } as const;

describe("effectiveSignature — follows the From, unless the user spoke", () => {
  it("following: the resolved sender's stored text, swapping when the sender does", () => {
    expect(effectiveSignature(SIG_FOLLOWING, MAP, "mb-one")).toBe("Best regards\nAnna");
    // The From switch IS the swap — same state, different resolved sender, other text.
    expect(effectiveSignature(SIG_FOLLOWING, MAP, "mb-two")).toBe("— Team Two");
    // A sender that stores nothing shows nothing; so does a sender nothing can name.
    expect(effectiveSignature(SIG_FOLLOWING, MAP, "mb-three")).toBeNull();
    expect(effectiveSignature(SIG_FOLLOWING, MAP, null)).toBeNull();
    // Stored whitespace is not a signature.
    expect(effectiveSignature(SIG_FOLLOWING, { "mb-one": "  \n " }, "mb-one")).toBeNull();
  });

  it("edited: the user's text stands on EVERY From — no swap surprises", () => {
    const edited: SignatureState = { kind: "edited", text: "my own sign-off" };
    expect(effectiveSignature(edited, MAP, "mb-one")).toBe("my own sign-off");
    // Switching the sender must NOT overwrite a hand-edit — their choice wins.
    expect(effectiveSignature(edited, MAP, "mb-two")).toBe("my own sign-off");
    expect(effectiveSignature(edited, MAP, null)).toBe("my own sign-off");
  });

  it("removed: struck for this message, on EVERY From — a swap must not resurrect it", () => {
    const removed: SignatureState = { kind: "removed" };
    expect(effectiveSignature(removed, MAP, "mb-one")).toBeNull();
    expect(effectiveSignature(removed, MAP, "mb-two")).toBeNull();
  });

  it("edited down to blank is the removal gesture performed with the keyboard", () => {
    expect(effectiveSignature({ kind: "edited", text: "" }, MAP, "mb-one")).toBeNull();
    expect(effectiveSignature({ kind: "edited", text: " \n\t" }, MAP, "mb-one")).toBeNull();
  });
});

describe("withSignature — serializes exactly as shown, or not at all", () => {
  const plain = { body: "the message", subject: "s" };
  const rich = { body: "the message", html: "<p>the message</p>", subject: "s" };

  it("null returns the SAME object — the no-signature mutation is byte-identical", () => {
    expect(withSignature(plain, null)).toBe(plain);
    expect(withSignature(rich, null)).toBe(rich);
  });

  it("plain send: the body gains the text after ONE blank line, nothing else moves", () => {
    const out = withSignature(plain, "Best regards\nAnna");
    expect(out.body).toBe("the message\n\nBest regards\nAnna");
    expect("html" in out).toBe(false);
    expect(out.subject).toBe("s");
  });

  it("rich send: BOTH halves carry it — the server derives the delivered plaintext from the markup", () => {
    const out = withSignature(rich, "Best regards\nAnna");
    expect(out.body).toBe("the message\n\nBest regards\nAnna");
    expect(out.html).toBe("<p>the message</p><p>Best regards<br>Anna</p>");
  });

  it("whitespace ships at the width the block showed — indentation and runs survive the markup", () => {
    // Ordinary paragraph text collapses leading/repeated spaces, and the server derives the
    // delivered plaintext from this markup — so without character-level preservation an
    // aligned signature ships narrower than the block and the preview showed it (review
    // round 1). Leading spaces and the second of every pair become no-break spaces; single
    // interior spaces stay real so long lines still wrap; a tab is four columns.
    expect(signatureHtml("  indented")).toBe("<p>\u00a0\u00a0indented</p>");
    expect(signatureHtml("a  b")).toBe("<p>a \u00a0b</p>");
    expect(signatureHtml("a b")).toBe("<p>a b</p>");
    // Tabs expand COLUMN-AWARE to the next 4-column stop — the same stops every surface that
    // shows the text declares (`tab-size: 4`) — not a fixed run of four.
    expect(signatureHtml("\tcol")).toBe("<p>\u00a0\u00a0 \u00a0col</p>");
    expect(signatureHtml("ab\tc")).toBe("<p>ab \u00a0c</p>");
  });

  it("signature text can never become markup — every character is escaped", () => {
    expect(signatureHtml('<b>&"\'</b>')).toBe("<p>&lt;b&gt;&amp;&quot;&#39;&lt;/b&gt;</p>");
    const out = withSignature(rich, '<img src=x onerror="x">');
    expect(out.html).not.toContain("<img");
    expect(out.html).toContain("&lt;img");
  });

  it("the compose mutation itself round-trips: plan → seal carries both halves", () => {
    const fields: ComposeFields = {
      to: "a@example.test, ", cc: "", bcc: "", subject: "hi",
      body: "typed text", html: "<p>typed text</p>", fromMailboxId: null,
    };
    const sealed = withSignature(composePlan(fields, "mb-one").mutation, "— sig");
    expect(sealed.body).toBe("typed text\n\n— sig");
    expect(sealed.html).toBe("<p>typed text</p><p>— sig</p>");
    // The seal happens AFTER the plan, so `canSend`'s empty-body refusal judges the TYPED
    // body — a signature alone must never light Send up (the shell's ordering, pinned by the
    // source guard below).
    expect(composePlan({ ...fields, body: "", html: "" }, "mb-one").mutation.body).toBe("");
  });
});

describe("the per-message editor meta — the reopen scratch the subject and the block live in", () => {
  it("round-trips subject and sig; `following` and no subject store NOTHING; junk reads as rest", () => {
    writeReplyMeta("msg-1", { subject: "Re: kept", sig: { kind: "removed" } });
    expect(readReplyMeta("msg-1")).toEqual({ subject: "Re: kept", sig: { kind: "removed" } });
    writeReplyMeta("msg-1", { subject: "Re: kept", sig: { kind: "edited", text: "mine" } });
    expect(readReplyMeta("msg-1").sig).toEqual({ kind: "edited", text: "mine" });
    // Absence IS the resting state — a meta with neither field stores nothing at all.
    writeReplyMeta("msg-1", {});
    expect(window.localStorage.getItem("ohmail.ui.replymeta:msg-1")).toBeNull();
    // A value some other version wrote reads back as rest, never a throw.
    window.localStorage.setItem("ohmail.ui.replymeta:msg-2", '{"sig":{"kind":"???"},"subject":7}');
    expect(readReplyMeta("msg-2")).toEqual({});
  });
});

/* ══ the block — rendered state, the strike, the inline edit ═══════════════════════════════ */

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mountBlock(props: {
  sig: SignatureState;
  onSig: (next: SignatureState) => void;
  signatures: Readonly<Record<string, string>>;
  mailboxId: string | null;
  disabled?: boolean;
}): Promise<void> {
  const { SignatureBlock } = await import("../app/shell/SignatureBlock.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(SignatureBlock, { disabled: false, ...props }),
      }),
    );
  });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
  vi.restoreAllMocks();
});

describe("SignatureBlock — a distinct, removable, editable block", () => {
  it("shows the resolved sender's text; × reports the strike; typing reports the edit", async () => {
    const seen: SignatureState[] = [];
    await mountBlock({
      sig: SIG_FOLLOWING, onSig: (n) => seen.push(n), signatures: MAP, mailboxId: "mb-one",
    });
    const block = host!.querySelector<HTMLElement>(".sig-block")!;
    expect(block, "no block for a sender with a stored signature").not.toBeNull();
    const text = block.querySelector<HTMLTextAreaElement>(".sig-text")!;
    expect(text.value).toBe("Best regards\nAnna");

    // The strike — one press, `removed` reported, nothing else invented.
    block.querySelector<HTMLButtonElement>(".sig-remove")!.click();
    expect(seen).toEqual([{ kind: "removed" }]);

    // The inline edit — the user's text, reported verbatim.
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLTextAreaElement.prototype, "value",
      )!.set!;
      setter.call(text, "Best regards\nAnna B.");
      text.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(seen[1]).toEqual({ kind: "edited", text: "Best regards\nAnna B." });
  });

  it("renders NOTHING when struck, when the sender stores nothing, and when nothing can name one", async () => {
    await mountBlock({ sig: { kind: "removed" }, onSig: () => {}, signatures: MAP, mailboxId: "mb-one" });
    expect(host!.querySelector(".sig-block")).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; host?.remove();

    await mountBlock({ sig: SIG_FOLLOWING, onSig: () => {}, signatures: MAP, mailboxId: "mb-none" });
    expect(host!.querySelector(".sig-block")).toBeNull();
    await act(async () => { root!.unmount(); }); root = null; host?.remove();

    await mountBlock({ sig: SIG_FOLLOWING, onSig: () => {}, signatures: MAP, mailboxId: null });
    expect(host!.querySelector(".sig-block")).toBeNull();
  });
});

/* ══ the send paths go through the pair — the ship-what-is-shown guard ═════════════════════ */

const shellSrc = (): string => {
  const p = resolve(process.cwd(), "apps/webapp/app/shell/shell-compose.ts");
  return readFileSync(p, "utf8");
};

describe("both send paths derive with effectiveSignature and seal with withSignature", () => {
  /**
   * The mid-edit rule ("a send must ship what is shown") is structural: the block renders
   * `effectiveSignature(state, map, from)` and the send seals the SAME call's answer at press
   * time. A send path that stopped going through the pair — or serialized the block's text a
   * second way — re-opens the torn-mix door, so the calls themselves are pinned.
   */
  it("sendCompose and sendReply both call the pair; the compose plan is sealed AFTER canSend's judgment", () => {
    const src = shellSrc();
    // `withWhen` (Send later, mail 0077) wraps OUTSIDE the seal: it only adds `sendAt` to the
    // already-sealed mutation, so the signature text still comes from the one derivation the
    // block renders — the torn-mix door stays closed on the scheduled path too.
    // The THIRD argument is the markup half (mail 0098) — the same derivation, one question
    // over. Pinned in the call because a send that dropped it would ship the escaped text where
    // the block rendered a document, which is the torn mix wearing the other shape's clothes.
    // The send's options (the hand-off) follow the sealed mutation and never wrap it.
    expect(src).toContain(
      "mailSend.send(withWhen(withSignature(plan.mutation, sigText, sigHtml)),",
    );
    // The fresh-send branch is GONE by ruling: after an unverified send nothing may re-send under
    // a new key, so that second sealed call site no longer exists. Its absence is the assertion.
    expect(
      src,
      "the unverified fresh-send branch is back — it mints a new key for a message that may "
        + "already have gone",
    ).not.toContain("withSignature(fresh, sigText)");
    // The reply arm: seal wraps the mutation literal; the forward arm seals the same text.
    expect(src).toContain("mailSend.send(withSignature({");
    expect(src).toContain("withSignature(forwardSend(parent, {");
    // Both derive through effectiveSignature over the server-confirmed map. Counted on the
    // exact name so `effectiveSignatureHtml` cannot pad the total — they are two derivations
    // and each is asserted on its own.
    const derivations = src.split("effectiveSignature(").length - 1;
    expect(derivations, "a send path stopped deriving the signature where the block does")
      .toBeGreaterThanOrEqual(2);
    const markupDerivations = src.split("effectiveSignatureHtml(").length - 1;
    expect(markupDerivations, "a send path stopped deriving the signature's MARKUP half")
      .toBeGreaterThanOrEqual(2);
    expect(src).toContain("consent.signaturesKnown ? consent.signatures : {}");
    expect(src).toContain("consent.signaturesKnown ? consent.signaturesHtml : {}");
  });

  it("live signature state outranks a possibly-stale stored value for the row autosave still holds", () => {
    // Review round 5: storage can hold an OLDER value than the screen when a later write was
    // refused (quota exhaustion, the measured case) — `stored ?? live` would then serve the
    // stale value. `live ?? stored` (in-memory first, storage only for a row this session does
    // not hold) is the fix; pinned as the exact expression so a reorder is caught immediately.
    const src = shellSrc();
    expect(src).toContain(
      "const sig = autosave.draftId === d.id ? compose.sig : readReplyMeta(`draft:${d.id}`).sig;",
    );
  });

  it("reopening an autosaved draft reads the block state by the ROW's id — the reload-proof handle", () => {
    // Review rounds 2–3 killed both weaker keys: the in-memory autosave id (empty after a
    // reload) and a content key (a rich draft's local text and server-derived text
    // legitimately differ). The meta lane `draft:<rowId>` is the one handle that survives.
    const src = shellSrc();
    expect(src).toContain("readReplyMeta(`draft:${d.id}`).sig");
    expect(src, "the sync effect that mirrors the block state to the row's lane is gone")
      .toContain("writeReplyMeta(\n      `draft:${autosave.draftId}`,");
  });
});

/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import type { Editor } from "@tiptap/react";
import { NodeSelection } from "@tiptap/pm/state";
import { RichEditor } from "../app/shell/RichEditor";
import { EMPTY_RICH, escapeAsParagraphs, type RichValue } from "../app/shell/rich-text";

/**
 * THE EDITOR, MOUNTED — what it offers, and what it refuses to offer.
 *
 * ProseMirror runs in jsdom: the document model, the commands and the serializers are all
 * plain JavaScript, and only the parts that need layout (`getClientRects`, real caret
 * movement) do not. So this drives the editor the way a keyboard would — through commands and
 * through the toolbar's own buttons — and reads back the two things the rest of the product
 * consumes, `html` and `text`. What it deliberately does NOT do is simulate typing through
 * synthetic DOM events: jsdom produces no ProseMirror transaction from those, so a test built
 * that way would pass while asserting nothing.
 *
 * The refusals are asserted as loudly as the features. An editor that offers a heading the
 * server strips on the way out is a control that silently does nothing, and the whole
 * argument for a small grammar is that the two ends agree — so "the toolbar has eight buttons
 * and heading is not one of them" is a claim under test, not a comment.
 */

/**
 * jsdom HAS NO LAYOUT, and ProseMirror asks for some.
 *
 * `focus()` scrolls the selection into view, which walks a Range and asks it for rectangles.
 * jsdom implements neither `getClientRects` nor `getBoundingClientRect` on Range, and the
 * throw happens INSIDE a transaction dispatch — after the assertion that triggered it has
 * already passed. So the suite reports every test green and one uncaught exception, which is
 * the shape of a failure nobody attributes. Empty rectangles are the honest answer for a
 * document that was never laid out: scrolling becomes a no-op instead of a crash.
 */
beforeAll(() => {
  const emptyList = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  const zeroRect = () => new DOMRect(0, 0, 0, 0);
  for (const proto of [Range.prototype, Element.prototype] as Array<{ getClientRects?: unknown; getBoundingClientRect?: unknown }>) {
    if (typeof proto.getClientRects !== "function") proto.getClientRects = emptyList;
    if (typeof proto.getBoundingClientRect !== "function") proto.getBoundingClientRect = zeroRect;
  }
});

let host: HTMLElement | null = null;
let root: Root | null = null;

interface Mounted {
  emitted: RichValue[];
  readonly value: RichValue;
  editor: () => Editor;
  surface: () => HTMLElement;
  buttons: () => HTMLButtonElement[];
  button: (label: string) => HTMLButtonElement;
  /** Flips the mid-send lock, the way Compose does while a send is in flight. */
  setEditable: (editable: boolean) => void;
}

/** Mounts the editor and hands back a live view of the last value it emitted. */
function mount(initial: RichValue = EMPTY_RICH): Mounted {
  host = document.createElement("div");
  document.body.appendChild(host);
  const emitted: RichValue[] = [];
  let current = initial;
  let instance: Editor | null = null;
  let lock: ((editable: boolean) => void) | null = null;

  function Harness() {
    const [v, setV] = React.useState<RichValue>(initial);
    const [editable, setEditable] = React.useState(true);
    current = v;
    lock = setEditable;
    return (
      <NextIntlClientProvider locale="en" messages={messages as never}>
        <RichEditor
          value={v}
          onChange={(next) => { emitted.push(next); setV(next); }}
          ariaLabel="Reply"
          editable={editable}
          editorRef={(e) => { if (e) instance = e; }}
        />
      </NextIntlClientProvider>
    );
  }

  root = createRoot(host);
  act(() => { root!.render(<Harness />); });
  return {
    emitted,
    get value() { return current; },
    setEditable: (editable: boolean) => act(() => lock?.(editable)),
    editor: () => {
      if (!instance) throw new Error("the editor never reported itself through editorRef");
      return instance;
    },
    surface: () => host!.querySelector<HTMLElement>(".rte-surface")!,
    buttons: () => [...host!.querySelectorAll<HTMLButtonElement>(".rte-b")],
    button: (label: string) =>
      host!.querySelector<HTMLButtonElement>(`.rte-b[aria-label="${label}"]`)!,
  };
}

afterEach(() => {
  act(() => { root?.unmount(); });
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

describe("the editor mounts and reports both halves", () => {
  it("renders a labelled editing surface and a toolbar", () => {
    const ed = mount();
    const surface = ed.surface();
    expect(surface).not.toBeNull();
    expect(surface.getAttribute("aria-label")).toBe("Reply");
    expect(surface.getAttribute("contenteditable")).toBe("true");
    expect(host!.querySelector('[role="toolbar"]')).not.toBeNull();
  });

  it("shows the value it was given", () => {
    const ed = mount({ text: "hello", html: "<p>hello</p>" });
    expect(ed.surface().textContent).toContain("hello");
  });

  it("renders a PLAIN starting value as paragraphs, escaping what it contains", () => {
    // A scratch buffer written before this editor existed is a bare string. `setContent`
    // parses HTML, so somebody who typed `<b>` into the old textarea must get their
    // characters back — not formatting they never applied.
    const ed = mount({ text: "a <b>literal</b> tag", html: "" });
    expect(ed.surface().textContent).toContain("a <b>literal</b> tag");
    expect(ed.surface().querySelector("b")).toBeNull();
  });
});

/**
 * A ROLE QUERY, written here because this app is not a `@testing-library` consumer.
 *
 * It resolves the role the way a platform does — the explicit `role` attribute, else the implicit
 * role of the two native text controls — and the name the way the accessible-name calculation
 * does for these elements: `aria-labelledby` followed to the node it names, else `aria-label`.
 *
 * WHAT IT SHARES WITH THE CODE UNDER TEST, stated because a query that agrees with an attribute
 * by construction is not evidence: it reads the same two attributes the component writes. What it
 * ADDS is the search — it asks "which element in this tree is the text box called Reply", so a
 * role written onto the wrong node, a name that does not resolve, or a role spelled onto a second
 * element as well all answer differently from a `getAttribute` on the node the test already holds.
 * The mutation control is the other half: deleting `role` from the editor's attributes reddens
 * every case below, and deleting `aria-multiline` reddens exactly the two that name it.
 */
const byRole = (root: HTMLElement, role: string, name: string): HTMLElement => {
  const nameOf = (el: HTMLElement): string => {
    const by = el.getAttribute("aria-labelledby");
    if (by) return (document.getElementById(by)?.textContent ?? "").trim();
    return (el.getAttribute("aria-label") ?? "").trim();
  };
  const roleOf = (el: HTMLElement): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    if (el.tagName === "TEXTAREA") return "textbox";
    if (el.tagName === "INPUT" && (el.getAttribute("type") ?? "text") === "text") return "textbox";
    return "";
  };
  const hits = [...root.querySelectorAll<HTMLElement>("*")].filter(
    (el) => roleOf(el) === role && nameOf(el) === name,
  );
  if (hits.length !== 1) {
    throw new Error(
      `expected exactly one ${role} named "${name}", found ${hits.length}` +
        ` (${hits.map((el) => `${el.tagName}.${el.className}`).join(", ") || "none"})`,
    );
  }
  return hits[0]!;
};

describe("the body says WHAT IT IS, not only what it is called", () => {
  /**
   * ── A `contenteditable` IS NOT A TEXT BOX UNTIL IT SAYS SO ──────────────────────────────────
   *
   * ProseMirror's surface is a `<div contenteditable="true">`. `contenteditable` appears in no
   * implicit role mapping, so the element reached the accessibility tree as a plain group with a
   * name: a reader landing on the compose body was told what it is CALLED and not that it can be
   * typed into, and nothing said that Return inserts a line rather than sending.
   *
   * Both facts are attributes. `role="textbox"` plus `aria-multiline="true"` is the pair the
   * platforms read — UIA reports an Edit control with the multiline pattern, AT-SPI an editable
   * text object — and the reason to assert them by ROLE QUERY rather than by attribute is that
   * the query is the reader's own question: "give me the text box called Reply". An attribute
   * assertion passes for a role spelled onto an element the query would never return.
   */
  it("is a TEXT BOX to a reader, found by role and named by the caller's label", () => {
    mount();
    const body = byRole(host!, "textbox", "Reply");
    expect(body.classList.contains("rte-surface")).toBe(true);
    expect(body.getAttribute("contenteditable")).toBe("true");
  });

  it("says it is MULTI-LINE — the Return key inserts, it does not submit", () => {
    mount();
    expect(byRole(host!, "textbox", "Reply").getAttribute("aria-multiline")).toBe("true");
  });

  it("keeps saying so while a send is in flight — a locked body is still a body", () => {
    /* `editable: false` is the mid-send lock. The document must not take input, but taking the
       ROLE away as well would make the surface vanish from a reader's tree exactly while the
       text it holds is the thing they are waiting on. */
    const ed = mount({ text: "on the wire", html: "<p>on the wire</p>" });
    ed.setEditable(false);
    const body = byRole(host!, "textbox", "Reply");
    expect(body.getAttribute("aria-multiline")).toBe("true");
    expect(body.textContent).toContain("on the wire");
  });

  it("EVERY call site names its body, and both catalogues carry the sentence", () => {
    /**
     * The name is a required prop, so a call site with none does not compile — but a call site
     * passing an empty string, or a key that exists in one catalogue only, compiles and ships a
     * body that announces nothing. This is the half the type cannot hold.
     *
     * Read from the sources rather than listed here: a new surface that mounts the editor is
     * covered the day it lands, which a hand-kept list is not.
     */
    const roots = ["app/views/ComposeView.tsx", "app/shell/InlineReply.tsx", "app/shell/AppShell.tsx",
      "app/shell/SignatureBlock.tsx", "app/shell/SignaturesRow.tsx"];
    const sites: string[] = [];
    for (const rel of roots) {
      const src = readFileSync(resolve(__dirname, "..", rel), "utf8");
      for (const m of src.matchAll(/<RichEditor\b([\s\S]*?)\/?>/g)) {
        const props = m[1];
        const label = /ariaLabel=\{([^}]*)\}/.exec(props);
        expect(label, `${rel}: a <RichEditor> with no ariaLabel`).not.toBeNull();
        expect(label![1].trim(), `${rel}: an empty ariaLabel`).not.toBe('""');
        sites.push(`${rel}: ${label![1].trim()}`);
      }
    }
    expect(sites.length, "no call site was found at all — the census read nothing").toBeGreaterThanOrEqual(6);

    /* The two the composer surfaces use, in both catalogues, non-empty and not each other: the
       compose body and the inline reply are different bodies and a reader hearing the same name
       for both cannot tell which one the caret is in. */
    const de = JSON.parse(readFileSync(resolve(__dirname, "..", "messages", "de.json"), "utf8")) as
      Record<string, Record<string, string>>;
    const en = messages as unknown as Record<string, Record<string, string>>;
    for (const cat of [en, de]) {
      expect(cat.compose.editorAria?.trim()).toBeTruthy();
      expect(cat.reply.editorAria?.trim()).toBeTruthy();
      expect(cat.compose.editorAria).not.toBe(cat.reply.editorAria);
    }
  });
});

describe("the toolbar is the grammar, and the grammar is small", () => {
  it("offers exactly eight controls, in a fixed order", () => {
    const ed = mount();
    expect(ed.buttons().map((b) => b.getAttribute("aria-label"))).toEqual([
      "Bold", "Italic", "Strikethrough", "Code", "Link", "Bulleted list", "Numbered list", "Quote",
    ]);
  });

  it("offers no heading, no colour, no font and no image control", () => {
    // The refusal, asserted rather than assumed. Each of these round-trips through TipTap and
    // is then dropped by `outbound-html.ts`, so offering one would be a button that does
    // nothing a recipient can see.
    const labels = mount().buttons().map((b) => (b.getAttribute("aria-label") ?? "").toLowerCase());
    for (const absent of ["heading", "colour", "color", "font", "size", "image", "table", "align"]) {
      expect(labels.some((l) => l.includes(absent)), `a "${absent}" control is offered`).toBe(false);
    }
  });

  it("REFUSES the node types it does not offer, even when they are pasted in", () => {
    // The toolbar test above says the controls are absent. This says the EDITOR is, which is
    // the claim that matters for a paste from a word processor: a heading that survived here
    // would look like formatting on screen and then be flattened by the server on the way
    // out, so the user would see one message and the recipient another.
    const ed = mount();
    act(() => {
      ed.editor().commands.setContent("<h1>Title</h1><hr><p>kept</p>");
    });
    const html = ed.editor().getHTML();
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<hr");
    // …and the WORDS are kept. Refusing a node type must not silently delete somebody's text.
    expect(ed.editor().getText()).toContain("Title");
    expect(ed.editor().getText()).toContain("kept");
  });

  it("ACCEPTS a pasted code block, which it used to flatten", () => {
    // The other side of the same claim, and it moved: `codeBlock` was refused for as long as
    // `outbound-html.ts` had no `pre` in its allowlist. Both changed together, so a pasted
    // snippet now survives as a snippet — with its line breaks and its indentation, which is
    // the only property that makes a code block worth having.
    const ed = mount();
    act(() => {
      ed.editor().commands.setContent("<pre><code>if (a) {\n  b();\n}</code></pre>");
    });
    const html = ed.editor().getHTML();
    expect(html).toContain("<pre");
    expect(ed.editor().getText()).toContain("if (a) {\n  b();\n}");
  });

  it("bold marks the selection and reports itself pressed", () => {
    const ed = mount({ text: "words", html: "<p>words</p>" });
    const bold = ed.button("Bold");
    expect(bold.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      bold.click();
    });
    expect(ed.value.html).toContain("<strong>words</strong>");
    // …and the CONTROL says so. This one passes whether or not the toolbar subscribes to the
    // editor, because the edit itself re-renders the parent — the guard that actually forces
    // the subscription is the caret test below, and it is marked as such.
    expect(ed.button("Bold").getAttribute("aria-pressed")).toBe("true");
  });

  it("follows the CARET, not just the last edit — moving into bold text lights the button", () => {
    /**
     * THE ASSERTION THAT FORCES THE SUBSCRIPTION, and it is the only one that does.
     *
     * Every other toolbar test changes the document, which fires `onChange`, which sets the
     * parent's state, which re-renders the toolbar for free — so they all pass whether the
     * toolbar subscribes to the editor or reads `isActive()` during render. Measured: with
     * `useEditorState` removed and the flags computed in the render body, thirteen of the
     * fourteen tests in this file still passed.
     *
     * A pure SELECTION change is the case with no re-render behind it. Nothing about the
     * document changes, so `onUpdate` never fires and React has no reason to paint again — and
     * "put the cursor in a bold word and see whether the B is lit" is the ordinary thing a
     * person does before typing. Without the subscription the button stays as it was.
     */
    const ed = mount({ text: "plain bold", html: "<p>plain <strong>bold</strong></p>" });
    act(() => { ed.editor().commands.setTextSelection(2); });
    expect(ed.button("Bold").getAttribute("aria-pressed")).toBe("false");

    // …now into the bold word. No edit, no onChange — only a caret move.
    const inBold = ed.editor().state.doc.textContent.indexOf("bold") + 2;
    act(() => { ed.editor().commands.setTextSelection(inBold + 1) });
    expect(ed.button("Bold").getAttribute("aria-pressed")).toBe("true");
  });

  it("a list button produces list markup, and the plain half loses the tags", () => {
    const ed = mount({ text: "one", html: "<p>one</p>" });
    act(() => { ed.button("Bulleted list").click(); });
    expect(ed.value.html).toContain("<ul>");
    expect(ed.value.html).toContain("<li>");
    expect(ed.value.text).toContain("one");
    expect(ed.value.text).not.toContain("<");
  });

  it("quote produces a blockquote", () => {
    const ed = mount({ text: "one", html: "<p>one</p>" });
    act(() => { ed.button("Quote").click(); });
    expect(ed.value.html).toContain("<blockquote>");
  });
});

describe("links — select, make, edit, unlink (the popover)", () => {
  /**
   * The popover replaced `window.prompt`, and these drive it the way a person does: open it
   * from the button or from ⌘K, type a destination, Apply / Remove / Escape. The input is
   * UNCONTROLLED (read on Apply), so a test writes `.value` directly — no synthetic change
   * events, which jsdom + React would need the native-setter dance for.
   */
  const pop = () => host!.querySelector<HTMLElement>(".rte-linkpop");
  const urlInput = () => host!.querySelector<HTMLInputElement>(".rte-linkpop-url")!;
  const applyBtn = () => host!.querySelector<HTMLButtonElement>(".rte-linkpop-apply")!;
  const removeBtn = () => host!.querySelector<HTMLButtonElement>(".rte-linkpop-remove");
  const applyValue = (v: string) => act(() => { urlInput().value = v; applyBtn().click(); });

  it("the Link button opens the popover, and Apply links the selection", () => {
    const ed = mount({ text: "the quote", html: "<p>the quote</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Link").click();
    });
    expect(pop(), "the Link button opened no popover").not.toBeNull();
    applyValue("https://a.example/q");
    expect(ed.value.html).toContain('href="https://a.example/q"');
    expect(pop(), "the popover stayed open after Apply").toBeNull();
  });

  it("⌘K opens the same popover — the shortcut survived the prompt's replacement", () => {
    const ed = mount({ text: "x", html: "<p>x</p>" });
    act(() => {
      ed.surface().dispatchEvent(
        new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }),
      );
    });
    expect(pop(), "⌘K no longer reaches the link affordance").not.toBeNull();
  });

  it("prefills the existing destination, and Apply rewrites the WHOLE link", () => {
    // The caret is INSIDE the link, with nothing selected — the way a person edits one. The
    // `extendMarkRange` in the apply path is what makes the new href cover the whole anchor
    // rather than a zero-width slice of it.
    const ed = mount({ text: "word", html: '<p><a href="https://a.example/old">word</a></p>' });
    act(() => {
      ed.editor().commands.setTextSelection(3);
      ed.button("Link").click();
    });
    expect(urlInput().value).toBe("https://a.example/old");
    applyValue("https://b.example/new");
    expect(ed.value.html).toMatch(/<a [^>]*href="https:\/\/b\.example\/new"[^>]*>word<\/a>/);
    expect(ed.value.html).not.toContain("a.example/old");
  });

  it("Remove link strips the mark and keeps the words", () => {
    const ed = mount({ text: "word", html: '<p><a href="https://a.example">word</a></p>' });
    act(() => {
      ed.editor().commands.setTextSelection(3);
      ed.button("Link").click();
    });
    const remove = removeBtn();
    expect(remove, "no Remove control while standing in a link").not.toBeNull();
    act(() => { remove!.click(); });
    // Unlinked, the note is plain again — so `html` is EMPTY by the escapeAsParagraphs
    // identity, not merely anchor-free. The words survive.
    expect(ed.value.html).toBe("");
    expect(ed.editor().getText()).toContain("word");
    expect(pop()).toBeNull();
  });

  it("offers no Remove control when the caret is not in a link", () => {
    // A Remove button with nothing to remove is the inert-affordance class this app keeps
    // closing — it would read as "this text is a link" about text that is not.
    const ed = mount({ text: "plain", html: "<p>plain</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Link").click();
    });
    expect(pop()).not.toBeNull();
    expect(removeBtn()).toBeNull();
  });

  it("Escape closes the popover and touches nothing", () => {
    const ed = mount({ text: "x", html: '<p><a href="https://a.example">x</a></p>' });
    act(() => {
      ed.editor().commands.setTextSelection(2);
      ed.button("Link").click();
    });
    act(() => {
      urlInput().dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(pop()).toBeNull();
    expect(ed.editor().getHTML()).toContain('href="https://a.example"');
  });

  it("applying an EMPTY address unlinks — the old prompt's semantics, kept", () => {
    const ed = mount({ text: "x", html: '<p><a href="https://a.example">x</a></p>' });
    act(() => {
      ed.editor().commands.setTextSelection(2);
      ed.button("Link").click();
    });
    applyValue("   ");
    expect(ed.editor().getHTML()).not.toContain("<a");
    expect(ed.editor().getText()).toContain("x");
    expect(pop()).toBeNull();
  });

  it("normalises a bare domain to https and a bare address to mailto", () => {
    // People type what they mean, not a scheme. A scheme-less href would survive the editor
    // AND the server (both allow relative URLs) and then dangle in the recipient's client —
    // so the popover is where "a.example/docs" becomes a destination a mail client can open.
    const ed = mount({ text: "docs", html: "<p>docs</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Link").click();
    });
    applyValue("a.example/docs");
    expect(ed.value.html).toContain('href="https://a.example/docs"');

    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Link").click();
    });
    applyValue("person@a.example");
    expect(ed.value.html).toContain('href="mailto:person@a.example"');
  });

  it("REFUSES a javascript: destination — an error, not a link", () => {
    // The server strips it on the way out (`outbound-html.test.ts`), but a control that
    // accepts what the server will refuse is a button that silently does nothing. The popover
    // says so instead, and the document never holds the mark.
    const ed = mount({ text: "x", html: "<p>x</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Link").click();
    });
    applyValue("javascript:alert(1)");
    expect(pop(), "the popover closed around a refused destination").not.toBeNull();
    expect(host!.querySelector(".rte-linkpop-err"), "no visible refusal").not.toBeNull();
    expect(ed.editor().getHTML()).not.toContain("<a");
    expect(ed.editor().getHTML()).not.toContain("javascript");
  });

  it("refuses ftp — a scheme the EDITOR'S validator allows and the server strips", () => {
    /**
     * The javascript: case above cannot watch the popover's own allow-list fail, and this was
     * measured rather than reasoned: with the popover's scheme check deleted, that test STAYED
     * GREEN, because TipTap's `setLink` validator also refuses javascript: and feeds the same
     * error path. TipTap's default list is wider than the server's — ftp, ftps, tel, sms and
     * others pass it — so ftp is the input where the popover's list is the ONLY thing standing
     * between the author and a link the server will strip on send. Deleting the
     * `ALLOWED_LINK_SCHEMES` check in `LinkPopover.tsx` turns exactly this test red.
     */
    const ed = mount({ text: "x", html: "<p>x</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Link").click();
    });
    applyValue("ftp://a.example/file");
    expect(pop(), "the popover closed around a refused destination").not.toBeNull();
    expect(host!.querySelector(".rte-linkpop-err"), "no visible refusal").not.toBeNull();
    expect(ed.editor().getHTML()).not.toContain("<a");
  });

  it("closes when the editor locks mid-send", () => {
    // A popover that outlived the lock could rewrite a document whose bytes were already
    // handed to the send — the same reason the toolbar disables.
    const ed = mount({ text: "x", html: "<p>x</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Link").click();
    });
    expect(pop()).not.toBeNull();
    ed.setEditable(false);
    expect(pop(), "the popover survived the mid-send lock").toBeNull();
  });

  it("autolinks a URL typed into a sentence", () => {
    const ed = mount();
    act(() => { typeInto(ed, "see https://a.example/x now"); });
    expect(ed.value.html).toContain('href="https://a.example/x"');
  });
});

describe("the Link control wears the chain-link glyph (owner-specified)", () => {
  it("is an inline SVG of two interlocking halves, drawn in the button's own ink", () => {
    const btn = mount().button("Link");
    const svg = btn.querySelector("svg");
    expect(svg, "the Link control lost its glyph").not.toBeNull();
    // `currentColor` is the both-themes claim: the glyph takes whatever ink the button has,
    // in light, dark, hover and pressed alike. A literal colour would be right in exactly one.
    expect(svg!.getAttribute("stroke")).toBe("currentColor");
    expect(svg!.getAttribute("fill")).toBe("none");
    expect(svg!.outerHTML).not.toMatch(/#[0-9a-fA-F]{3}/);
    // Two paths — the two interlocking link halves. One consistent link affordance: the
    // arrow this replaces must be gone.
    expect(svg!.querySelectorAll("path").length, "the chain-link is two halves").toBe(2);
    expect(btn.textContent).not.toContain("↗");
  });
});

describe("the link popover is themed by tokens, positioned under the bar", () => {
  // Read the way the flex-chain suite reads its geometry: the stylesheet is the claim.
  const appCss = readFileSync(resolve(process.cwd(), "apps/webapp/app/app.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");
  const ruleBody = (sel: string): string | null => {
    const m = new RegExp(`(?:^|[};])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m").exec(appCss);
    return m ? m[1] : null;
  };

  it("hangs off the bar's own box", () => {
    const bar = ruleBody("\\.rte-bar");
    expect(bar, "no bare .rte-bar rule").not.toBeNull();
    expect(bar, "the popover has nothing to anchor to").toMatch(/position:\s*relative/);
    const popRule = ruleBody("\\.rte-linkpop");
    expect(popRule, "no .rte-linkpop rule").not.toBeNull();
    expect(popRule).toMatch(/position:\s*absolute/);
    expect(popRule).toMatch(/z-index:\s*var\(--z-pal\)/);
  });

  it("is painted with theme tokens, no literal colours — both themes from one rule", () => {
    const popRule = ruleBody("\\.rte-linkpop")!;
    expect(popRule).toMatch(/background:\s*var\(--float\)/);
    expect(popRule).not.toMatch(/#[0-9a-fA-F]{3}/);
    /* The URL field is the shared text field (`TextField`, `packages/ui`): its ink, ground and
       edge come from `text-field.css`, and the rule left here only places it in the popover's
       row. So the token claim is made against the file that now paints it. */
    const input = ruleBody("\\.rte-linkpop-url");
    expect(input, "no .rte-linkpop-url rule").not.toBeNull();
    expect(input).not.toMatch(/#[0-9a-fA-F]{3}/);
    const field = readFileSync(
      resolve(__dirname, "..", "..", "..", "packages", "ui", "src", "primitives", "text-field.css"), "utf8");
    const tf = /\n\.tf\{[^}]*\}/.exec(field.replace(/\/\*[\s\S]*?\*\//g, ""))?.[0] ?? "";
    expect(tf, "no .tf rule — the field is painted by nothing").not.toBe("");
    expect(tf).toMatch(/color:var\(--ink\)/);
    expect(tf).not.toMatch(/#[0-9a-fA-F]{3}/);
  });
});

describe("markdown input rules are why there is almost no toolbar", () => {
  it("turns **bold** into bold as it is typed", () => {
    const ed = mount();
    // `insertContent` replays the characters through ProseMirror's input rules, which is the
    // path a keystroke takes. Asserting on the RULE rather than on a command is the point:
    // somebody who writes mail in Markdown never touches the toolbar.
    act(() => { typeInto(ed, "**bold** "); });
    expect(ed.value.html).toContain("<strong>bold</strong>");
  });

  it("turns a leading dash into a bullet list, and a leading > into a quote", () => {
    const list = mount();
    act(() => { typeInto(list, "- first"); });
    expect(list.value.html).toContain("<ul>");

    const quote = mount();
    act(() => { typeInto(quote, "> quoted"); });
    expect(quote.value.html).toContain("<blockquote>");
  });
});

describe("Enter is a single line break, not a paragraph gap", () => {
  /** Drive the keymap the way a keystroke does: through the view's `handleKeyDown` prop. */
  function pressEnter(ed: Mounted): void {
    const { view } = ed.editor();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    view.someProp("handleKeyDown", (fn) => fn(view, event));
  }

  it("inserts a hard break inside the paragraph rather than splitting it", () => {
    // StarterKit's default Enter splits the paragraph, and a `<p>` per line arrives at the
    // recipient double-spaced because a `<p>` carries a margin no allow-list will let us zero
    // out. A hard break is single-spaced. Mutating `EnterAsHardBreak` back to the default (or
    // dropping it from EXTENSIONS) makes this `<p>one</p><p>two</p>` and the assertion red.
    const ed = mount({ text: "one", html: "<p>one</p>" });
    act(() => {
      ed.editor().commands.focus("end");
      pressEnter(ed);
      ed.editor().commands.insertContent("two");
    });
    // Read the DOCUMENT, not the emitted value: a single-break note is plain, so `onChange`
    // correctly reports `html: ""` (asserted in the next test). What matters here is the shape
    // of the markup the editor built.
    const html = ed.editor().getHTML();
    expect(html).toContain("<br");
    expect(html).not.toContain("</p><p>");
  });

  it("keeps a single-break note PLAIN — html stays empty, so it sends as text/plain", () => {
    // The break must not cost the byte-identical plain send. `getText` renders the hard break as
    // one newline, `escapeAsParagraphs` turns that back into exactly the `<p>one<br>two</p>` the
    // editor holds, and the emptiness round trip therefore reports no markup.
    const ed = mount({ text: "one", html: "<p>one</p>" });
    act(() => {
      ed.editor().commands.focus("end");
      pressEnter(ed);
      ed.editor().commands.insertContent("two");
    });
    expect(ed.value.text).toBe("one\ntwo");
    expect(ed.value.html).toBe("");
  });

  it("still starts a new list item when Enter is pressed inside a list", () => {
    // The handler DEFERS inside a list — Enter there means "next item", and a hard break would
    // break the list. Toggle the list from the caret (not `focus("end")`, which lands in the
    // trailing paragraph a doc keeps after a list), confirm the caret really is in the item, then
    // press Enter: two items, not one item with a `<br>`.
    const ed = mount({ text: "first", html: "<p>first</p>" });
    act(() => { ed.editor().chain().focus("end").toggleBulletList().run(); });
    expect(ed.editor().isActive("listItem")).toBe(true);
    act(() => {
      pressEnter(ed);
      ed.editor().commands.insertContent("second");
    });
    const html = ed.editor().getHTML();
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
    expect(html).not.toContain("<br");
  });
});

describe("Code means the inline mark on one line and a code BLOCK across lines (R10-2)", () => {
  /** How many times a tag opens in the markup — `<pre` matches `<pre>` and `<pre class=…>`. */
  const count = (html: string, tag: string): number =>
    (html.match(new RegExp(`<${tag}[ >]`, "g")) ?? []).length;

  it("marks a selection INSIDE one line as inline code, and builds no block", () => {
    // The case the inline mark is for: a filename or a command inside a sentence.
    const ed = mount({ text: "run npm test now", html: "<p>run npm test now</p>" });
    const start = "<p>run ".length - "<p>".length + 1; // "run " → text starts at pos 1
    act(() => {
      ed.editor().commands.setTextSelection({ from: start, to: start + "npm test".length });
      ed.button("Code").click();
    });
    expect(ed.value.html).toContain("<code>npm test</code>");
    expect(ed.value.html).not.toContain("<pre");
  });

  it("turns a HARD-BREAK selection into ONE block — not a shaded box per line with gaps", () => {
    /**
     * THE REPORTED DEFECT, and the shape of it matters. Enter here inserts a `<br>`
     * (`EnterAsHardBreak`), so a message typed line by line is ONE paragraph with breaks in it.
     * `toggleCode()` is an inline mark and a mark applies to text RUNS: it shaded each line
     * separately, left the breaks between them bare, and put nothing at all on a blank line —
     * "with spaces in between, only for lines that have text".
     *
     * MUTATION WATCH: put `editor.chain().focus().toggleCode().run()` back on the Code button
     * and this goes red with three `<code>` runs and no `<pre>`, which is the defect itself.
     */
    const ed = mount({ text: "", html: "<p>one<br>two<br>three</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Code").click();
    });
    const html = ed.editor().getHTML();
    expect(count(html, "pre"), "not exactly one code block").toBe(1);
    // ONE `<code>`, the block's own. Three would be the per-run marking this replaces.
    expect(count(html, "code"), "the lines were marked separately").toBe(1);
    expect(ed.editor().state.doc.textContent).toContain("one\ntwo\nthree");
  });

  it("keeps a BLANK line inside the block, which an inline mark could not carry at all", () => {
    // A blank line has no text run to hold a mark, so the old command skipped it and the gap
    // read as the format breaking. Inside a block it is just a newline like any other.
    const ed = mount({ text: "", html: "<p>head<br><br>tail</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Code").click();
    });
    expect(ed.editor().state.doc.textContent).toContain("head\n\ntail");
  });

  it("turns a MULTI-PARAGRAPH selection into ONE block, not one per paragraph", () => {
    // `setCodeBlock()` is `setBlockType`, which retypes each textblock it finds — three
    // paragraphs would give three `<pre>` elements and bring the gaps back in a new costume.
    // The command builds a single node from the selection's text instead.
    const ed = mount({ text: "", html: "<p>alpha</p><p>beta</p><p>gamma</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Code").click();
    });
    const html = ed.editor().getHTML();
    expect(count(html, "pre")).toBe(1);
    expect(ed.editor().state.doc.textContent).toContain("alpha\nbeta\ngamma");
  });

  it("reports itself pressed inside a block, and pressing it again lifts the block out", () => {
    // One button, two constructs: a caret in a code block with an unlit Code button would be a
    // control claiming the text is not code while the text is code.
    const ed = mount({ text: "", html: "<p>one<br>two</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Code").click();
    });
    expect(ed.editor().isActive("codeBlock")).toBe(true);
    expect(ed.button("Code").getAttribute("aria-pressed")).toBe("true");

    act(() => { ed.button("Code").click(); });
    expect(ed.editor().getHTML()).not.toContain("<pre");
    // …and the lines the author typed all came back. `HardBreak` is the schema's
    // `linebreakReplacement`, so the block's newlines become `<br>`s again rather than running
    // the message together.
    // Read through the same hard-break serializer `emit` uses: a `hardBreak` is a leaf node
    // with no text of its own, so `doc.textContent` would report `onetwo` for both the right
    // answer and for the message run together — the one reading that cannot tell them apart.
    expect(ed.editor().getText({ textSerializers: { hardBreak: () => "\n" } }).trim())
      .toBe("one\ntwo");
    expect(ed.editor().getHTML()).toContain("<br");
  });

  it("still sets a stored inline mark when there is no selection at all", () => {
    const ed = mount({ text: "x", html: "<p>x</p>" });
    act(() => {
      ed.editor().commands.focus("end");
      ed.button("Code").click();
      ed.editor().commands.insertContent("y");
    });
    expect(ed.editor().getHTML()).toContain("<code>y</code>");
    expect(ed.editor().getHTML()).not.toContain("<pre");
  });
});

describe("block formats take LINES, not the whole message (owner-reported)", () => {
  /**
   * THE REPORTED DEFECT: "list or code formats always mark the full text and not the current
   * line". Enter here is a hard break (`EnterAsHardBreak`), so a message typed line by line is
   * ONE paragraph with `<br>`s — and TipTap's block toggles resolve their target as "the
   * textblocks the selection touches", which in this editor was the whole message. The fix
   * (`splitTargetLines` + the `applyList`/`applyQuote` wrappers, and `applyCode`'s expansion)
   * rewrites the hard breaks at the target's edges into real splits first, so the stock toggle
   * wraps exactly the lines the user meant.
   *
   * MUTATION WATCH — each was run, watched red, and restored:
   *  · wire the bullet button back to `toggleBulletList()` directly → the caret cases go red
   *    with the whole message inside one `<li>`, which is the defect verbatim;
   *  · same for the quote button → the quote cases go red;
   *  · pass `splitInner: false` from `applyList` → "one item per line" goes red with one item;
   *  · drop the `TextSelection.between` normalisation → the select-all case goes red;
   *  · drop `splitTargetLines` from `applyCode`'s block branch → the mid-line code case goes
   *    red with a dangling `<br>` left in the neighbour (`<p>one<br></p>`).
   */
  const DOC = { text: "", html: "<p>one<br>two<br>three</p>" };
  // Positions in that document: "one" 1–4, break 4–5, "two" 5–8, break 8–9, "three" 9–14.

  it("caret in a line + bullet list converts THAT line, and the caret stays a caret", () => {
    const ed = mount(DOC);
    act(() => { ed.editor().commands.setTextSelection(6); });
    act(() => { ed.button("Bulleted list").click(); });
    expect(ed.editor().getHTML()).toBe("<p>one</p><ul><li><p>two</p></li></ul><p>three</p>");
    // The command's target is the line; nothing was selected, so nothing reads as selected.
    expect(ed.editor().state.selection.empty).toBe(true);
  });

  it("caret in a line + numbered list converts that line only", () => {
    const ed = mount(DOC);
    act(() => { ed.editor().commands.setTextSelection(6); });
    act(() => { ed.button("Numbered list").click(); });
    expect(ed.editor().getHTML()).toBe("<p>one</p><ol><li><p>two</p></li></ol><p>three</p>");
  });

  it("caret in a line + quote quotes that line only", () => {
    const ed = mount(DOC);
    act(() => { ed.editor().commands.setTextSelection(6); });
    act(() => { ed.button("Quote").click(); });
    expect(ed.editor().getHTML()).toBe(
      "<p>one</p><blockquote><p>two</p></blockquote><p>three</p>",
    );
  });

  it("a mid-line to mid-line selection + list takes exactly those lines, ONE ITEM PER LINE", () => {
    const ed = mount(DOC);
    // From inside "two" to inside "three" — nobody selects a line to its exact ends.
    act(() => { ed.editor().commands.setTextSelection({ from: 6, to: 11 }); });
    act(() => { ed.button("Bulleted list").click(); });
    const html = ed.editor().getHTML();
    expect(html).toContain("<p>one</p><ul><li><p>two</p></li><li><p>three</p></li></ul>");
    // Two items — a single item holding both lines would be the defect at selection size.
    expect((html.match(/<li>/g) ?? []).length).toBe(2);
  });

  it("a multi-line selection + quote is ONE quotation with its lines kept as lines", () => {
    const ed = mount(DOC);
    act(() => { ed.editor().commands.setTextSelection({ from: 6, to: 11 }); });
    act(() => { ed.button("Quote").click(); });
    const html = ed.editor().getHTML();
    // One blockquote, the break inside it intact — quoting prose is not itemising it.
    expect(html).toContain("<p>one</p><blockquote><p>two<br>three</p></blockquote>");
    expect((html.match(/<blockquote>/g) ?? []).length).toBe(1);
  });

  it("a mid-line code selection expands to whole lines and leaves no dangling break", () => {
    const ed = mount({ text: "", html: "<p>one<br>two<br>three<br>four</p>" });
    act(() => { ed.editor().commands.setTextSelection({ from: 6, to: 11 }); });
    act(() => { ed.button("Code").click(); });
    // The neighbours come out CLEAN — the pre-fix command left `<p>one<br></p>`, a dangling
    // break that rendered (and sent) as a stray blank line under "one".
    expect(ed.editor().getHTML()).toBe(
      "<p>one</p><pre><code>two\nthree</code></pre><p>four</p>",
    );
  });

  it("select-all + list converts EVERYTHING — deliberately — as one item per line", () => {
    const ed = mount(DOC);
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Bulleted list").click();
    });
    const html = ed.editor().getHTML();
    expect(html).toContain(
      "<ul><li><p>one</p></li><li><p>two</p></li><li><p>three</p></li></ul>",
    );
  });

  it("the multi-paragraph case stays as it was: the caret's own paragraph only", () => {
    // This was already right before the fix — pinned so the line layer cannot regress it.
    const ed = mount({ text: "", html: "<p>alpha</p><p>beta</p><p>gamma</p>" });
    act(() => { ed.editor().commands.setTextSelection(9); });
    act(() => { ed.button("Bulleted list").click(); });
    expect(ed.editor().getHTML()).toBe(
      "<p>alpha</p><ul><li><p>beta</p></li></ul><p>gamma</p>",
    );
  });

  it("inline marks survive the isolation — bold inside a listed line stays bold", () => {
    const ed = mount({ text: "", html: "<p>one<br><strong>two</strong><br>three</p>" });
    act(() => { ed.editor().commands.setTextSelection(6); });
    act(() => { ed.button("Bulleted list").click(); });
    expect(ed.editor().getHTML()).toContain("<li><p><strong>two</strong></p></li>");
  });

  it("pressing the list button again lifts the line back out, words intact", () => {
    const ed = mount(DOC);
    act(() => { ed.editor().commands.setTextSelection(6); });
    act(() => { ed.button("Bulleted list").click(); });
    act(() => { ed.button("Bulleted list").click(); });
    const html = ed.editor().getHTML();
    expect(html).not.toContain("<ul>");
    for (const word of ["one", "two", "three"]) expect(html).toContain(word);
  });

  it("the caret on an EMPTY hard-break line targets THAT line, not the one above", () => {
    /**
     * Review-caught, then measured: `<p>intro<br>│</p>` — the caret on the empty line a
     * trailing Enter leaves. The line is ZERO-WIDTH (lineStart === lineEnd), and mapping one
     * position with opposite biases put `start` after the split and `end` before it — an
     * inverted range whose clamp landed the caret at the end of "intro", so the button
     * formatted the line ABOVE the one the caret stood in. The zero-width special case in
     * `splitTargetLines` (both ends take the inward-mapped start) turns this red when removed.
     */
    const ed = mount({ text: "", html: "<p>intro<br></p>" });
    act(() => { ed.editor().commands.setTextSelection(7); }); // after the break: the empty line
    act(() => { ed.button("Bulleted list").click(); });
    const html = ed.editor().getHTML();
    // The list holds the EMPTY line; "intro" stays a plain paragraph above it.
    expect(html).toContain("<p>intro</p><ul><li><p></p></li></ul>");
    expect(html).not.toMatch(/<li><p>intro/);
    // …and the caret is standing in the new item, ready to type the first entry.
    expect(ed.editor().isActive("listItem")).toBe(true);
  });

  it("quoting from an empty line BETWEEN lines quotes the empty line only", () => {
    // The same zero-width shape in the middle: `a<br>│<br>b`. Both neighbours stay plain.
    const ed = mount({ text: "", html: "<p>a<br><br>b</p>" });
    act(() => { ed.editor().commands.setTextSelection(3); }); // between the two breaks
    act(() => { ed.button("Quote").click(); });
    expect(ed.editor().getHTML()).toBe("<p>a</p><blockquote><p></p></blockquote><p>b</p>");
  });

  it("unquoting one line of a multi-line quotation takes only that line out", () => {
    /**
     * The OFF direction (review-caught): three lines quoted as ONE paragraph, caret on the
     * middle line, Quote pressed again. A bare `toggleBlockquote` lifts the whole paragraph —
     * all three lines unquoted by a press aimed at one. The isolation step now runs on the
     * active branch too, so the lift takes the caret's line and splits the quotation around it.
     */
    const ed = mount(DOC);
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Quote").click();
    });
    expect(ed.editor().getHTML()).toContain("<blockquote><p>one<br>two<br>three</p></blockquote>");
    // Caret into "two" INSIDE the quote: bq(0) p(1) "one"(2–5) br(5–6) "two"(6–9).
    act(() => { ed.editor().commands.setTextSelection(7); });
    expect(ed.editor().isActive("blockquote")).toBe(true);
    act(() => { ed.button("Quote").click(); });
    const html = ed.editor().getHTML();
    // "two" is out; "one" and "three" are still quoted, in the split halves.
    expect(html).toContain("<blockquote><p>one</p></blockquote><p>two</p><blockquote><p>three</p></blockquote>");
  });

  it("a NODE selection is left alone — unquoting a selected list lifts THE LIST", () => {
    /**
     * Review-caught: line isolation is a TEXT-selection concept. A whole `<ul>` picked as a
     * node (ProseMirror's NodeSelection) is not a run of lines, and narrowing it to the text
     * inside would change which node the toggle acts on — the unquote then lifted nothing.
     * `splitTargetLines` bails on node selections; deleting that bail turns this red with the
     * quotation unchanged.
     */
    const ed = mount({
      text: "",
      html: "<blockquote><ul><li><p>one</p></li><li><p>two</p></li></ul><p>after</p></blockquote>",
    });
    act(() => {
      const { state, view } = ed.editor();
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, 1)));
    });
    expect(ed.editor().state.selection.toJSON()).toMatchObject({ type: "node" });
    act(() => { ed.button("Quote").click(); });
    const html = ed.editor().getHTML();
    // The LIST left the quotation; the trailing paragraph stayed quoted.
    expect(html).toContain("</ul><blockquote><p>after</p></blockquote>");
    expect(html).not.toMatch(/<blockquote><ul>/);
  });

  it("a node-selected QUOTATION still unwraps — the bail spares the wrapper being toggled", () => {
    /**
     * The counter-case to the bail above (review-caught one round later): with the WHOLE
     * blockquote picked as a node, TipTap's toggle cannot derive a liftable range from the
     * node selection itself, so an unconditional bail left the Quote press doing nothing.
     * A selected quotation IS its run of lines for this button; the bail exempts it, the
     * normalisation narrows to its contents, and the press unwraps. Making the bail
     * unconditional again turns this red with the quotation intact.
     */
    const ed = mount({ text: "", html: "<blockquote><p>one<br>two</p></blockquote>" });
    act(() => {
      const { state, view } = ed.editor();
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, 0)));
    });
    expect(ed.editor().state.selection.toJSON()).toMatchObject({ type: "node" });
    act(() => { ed.button("Quote").click(); });
    const html = ed.editor().getHTML();
    expect(html).not.toContain("<blockquote>");
    expect(ed.editor().getText({ textSerializers: { hardBreak: () => "\n" } }).trim())
      .toBe("one\ntwo");
  });

  it("a node-selected quotation holding ONLY a list unwraps and keeps the list whole", () => {
    /**
     * The third round of the same corner (review-caught): with the quotation's sole child a
     * LIST, narrowing to the text inside descends into the item paragraphs, and the toggle
     * either refuses (several items) or dismantles the list and leaves the quote standing
     * (one item). The structural unwrap in `applyQuote` — replace the node with its own
     * children — has no range to derive, so the list comes out whole.
     */
    const ed = mount({
      text: "",
      html: "<blockquote><ul><li><p>one</p></li><li><p>two</p></li></ul></blockquote>",
    });
    act(() => {
      const { state, view } = ed.editor();
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, 0)));
    });
    act(() => { ed.button("Quote").click(); });
    const html = ed.editor().getHTML();
    expect(html).not.toContain("<blockquote>");
    expect(html).toContain("<ul><li><p>one</p></li><li><p>two</p></li></ul>");
  });

  it("listing a node-selected quotation lists its lines INSIDE the quote", () => {
    /**
     * The list buttons share the isolation with the quote button, and an unconditional
     * node-selection bail regressed them (review-caught): Bullet on a node-selected
     * quotation wrapped only the first line and dropped the quote. For the LIST commands a
     * selected quotation is its run of lines, so the normalisation narrows to the contents
     * and the toggle lists them where they stand — the quotation survives around the list.
     */
    const ed = mount({ text: "", html: "<blockquote><p>one</p><p>two</p></blockquote>" });
    act(() => {
      const { state, view } = ed.editor();
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, 0)));
    });
    act(() => { ed.button("Bulleted list").click(); });
    const html = ed.editor().getHTML();
    expect(html).toContain("<blockquote><ul><li><p>one</p></li><li><p>two</p></li></ul></blockquote>");
  });

  it("Code on a node-selected quotation makes ONE block — no list shell left behind", () => {
    /**
     * The quotation-as-lines reading is the LIST buttons' alone (review-caught): shared with
     * the Code path, the normalisation descended into a nested list's item paragraphs and the
     * replacement left the list shell standing with an empty bullet before the block. With
     * the bail kept for Code, the node selection reaches the replacement intact and the whole
     * quotation becomes one code block.
     */
    const ed = mount({
      text: "",
      html: "<blockquote><ul><li><p>one</p></li><li><p>two</p></li></ul></blockquote>",
    });
    act(() => {
      const { state, view } = ed.editor();
      view.dispatch(state.tr.setSelection(NodeSelection.create(state.doc, 0)));
    });
    act(() => { ed.button("Code").click(); });
    const html = ed.editor().getHTML();
    expect((html.match(/<pre[ >]/g) ?? []).length).toBe(1);
    expect(html).not.toContain("<ul>");
    expect(html).not.toContain("<blockquote>");
    expect(ed.editor().state.doc.textContent).toContain("one\ntwo");
  });

  it("mixed nesting does not corrupt: quoting across an existing list keeps every word", () => {
    const ed = mount(DOC);
    act(() => { ed.editor().commands.setTextSelection(6); });
    act(() => { ed.button("Bulleted list").click(); });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Quote").click();
    });
    const html = ed.editor().getHTML();
    expect((html.match(/<blockquote>/g) ?? []).length).toBe(1);
    // The list survives inside the quote, and no line was dropped or duplicated.
    expect(html).toContain("<ul>");
    for (const word of ["one", "two", "three"]) {
      expect((ed.editor().state.doc.textContent.match(new RegExp(word, "g")) ?? []).length)
        .toBe(1);
    }
  });
});

describe("Enter leaves a block the way every editor leaves one", () => {
  /** Drive the keymap the way a keystroke does — same helper as the suite. */
  function pressEnter(ed: Mounted): void {
    const { view } = ed.editor();
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
    view.someProp("handleKeyDown", (fn) => fn(view, event));
  }

  it("Enter on an EMPTY last list item exits the list", () => {
    const ed = mount({ text: "item", html: "<p>item</p>" });
    act(() => { ed.editor().chain().focus("end").toggleBulletList().run(); });
    act(() => { pressEnter(ed); });
    expect(ed.editor().isActive("listItem"), "the first Enter should open an empty item").toBe(true);
    act(() => { pressEnter(ed); });
    expect(ed.editor().isActive("listItem"), "Enter on an empty item must leave the list").toBe(false);
    expect(ed.editor().getHTML()).toContain("<li><p>item</p></li>");
  });

  it("Enter on an EMPTY line inside a quote exits the quote", () => {
    const ed = mount({ text: "quoted", html: "<p>quoted</p>" });
    act(() => { ed.editor().commands.setTextSelection(3); });
    act(() => { ed.button("Quote").click(); });
    // To the end of "quoted", INSIDE the blockquote (bq opens at 0, p at 1, text 2–8).
    act(() => { ed.editor().commands.setTextSelection(8); });
    expect(ed.editor().isActive("blockquote")).toBe(true);
    act(() => { pressEnter(ed); });
    expect(ed.editor().isActive("blockquote"), "the first Enter stays in the quote").toBe(true);
    act(() => { pressEnter(ed); });
    expect(ed.editor().isActive("blockquote"), "Enter on the empty line must leave the quote").toBe(false);
    expect(ed.editor().getHTML()).toContain("<blockquote><p>quoted</p></blockquote>");
  });

  it("a third Enter at the end of a code block exits it (`exitOnTripleEnter`)", () => {
    const ed = mount({ text: "", html: "<p>one<br>two</p>" });
    act(() => {
      ed.editor().chain().focus().selectAll().run();
      ed.button("Code").click();
    });
    // To the end of "one\ntwo" INSIDE the block (pre opens at 0, text 1–8) — `focus("end")`
    // would land in the trailing paragraph the replacement keeps after the block.
    act(() => { ed.editor().commands.setTextSelection(8); });
    expect(ed.editor().isActive("codeBlock")).toBe(true);
    act(() => { pressEnter(ed); pressEnter(ed); pressEnter(ed); });
    expect(ed.editor().isActive("codeBlock"), "three Enters must leave the block").toBe(false);
    // …and the block kept the lines; the exits did not eat them.
    expect(ed.editor().getHTML()).toContain("<pre><code>one\ntwo</code></pre>");
  });
});

describe("the editable surface FILLS its frame — the compose click dead zone (R10-2)", () => {
  /**
   * THE HALF A DOM CAN ANSWER, AND THE HALF IT CANNOT — said plainly because the difference is
   * the whole value of this block.
   *
   * jsdom lays nothing out, so "a click 180px below the last line puts the caret in the
   * message" is not assertable here and is verified in a browser. What IS assertable is the
   * thing that was broken: the CHAIN. `EditorContent` renders a wrapper div and appends
   * ProseMirror's contenteditable inside it; that wrapper was unclassed and had no flex, so the
   * surface stayed one line tall inside a 220px box and everything below it was inert. So this
   * pins the two facts the fix consists of — the class is on the wrapper (DOM), and the three
   * rules that pass the height down exist (stylesheet).
   *
   * MUTATION WATCH: drop `className="rte-body"` from `EditorContent` and the first case goes
   * red; delete the `.rte-body` rule or either flex declaration from `.rte-surface` and the
   * others do.
   */
  const appCss = readFileSync(resolve(process.cwd(), "apps/webapp/app/app.css"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "");

  /** Body of the first top-level rule whose selector list starts with `sel`. */
  const ruleBody = (sel: string): string | null => {
    const m = new RegExp(`(?:^|[};])\\s*${sel}\\s*\\{([^{}]*)\\}`, "m").exec(appCss);
    return m ? m[1] : null;
  };

  it("puts the surface inside a CLASSED wrapper, so the stylesheet has something to name", () => {
    const ed = mount();
    const surface = ed.surface();
    const body = surface.parentElement;
    expect(body, "the surface has no wrapper at all").not.toBeNull();
    expect(body!.className.split(/\s+/)).toContain("rte-body");
    // …and that wrapper really is the flex child of `.rte`, not some deeper node — the whole
    // defect was a link in the middle of the chain that nothing styled.
    expect(body!.parentElement!.className.split(/\s+/)).toContain("rte");
  });

  it("declares the flex column on all three links of the chain", () => {
    for (const [sel, name] of [["\\.rte", ".rte"], ["\\.rte-body", ".rte-body"]] as const) {
      const rule = ruleBody(sel);
      expect(rule, `no bare ${name} rule in app.css`).not.toBeNull();
      expect(rule, `${name} stopped being a flex column`).toMatch(/display:\s*flex/);
      expect(rule).toMatch(/flex-direction:\s*column/);
    }
    const body = ruleBody("\\.rte-body")!;
    expect(body, ".rte-body no longer takes the box's slack").toMatch(/flex:\s*1 1 auto/);
    expect(body, ".rte-body's auto min-height would force the column open").toMatch(/min-height:\s*0/);
  });

  it("makes the surface itself take the wrapper's height, with no floor of its own", () => {
    const surface = ruleBody("\\.rte-surface");
    expect(surface, "no bare `.rte-surface` rule in app.css").not.toBeNull();
    expect(surface, "the surface stopped filling its wrapper").toMatch(/flex:\s*1 1 auto/);
    /**
     * AND NO `min-height` — the half that was measured rather than reasoned about.
     *
     * A `min-height: 0` here looks free: every surface declares its own floor in a more
     * specific rule, and specificity decides it in a browser. jsdom's `getComputedStyle` takes
     * the LAST declaration instead, and `reply-ergonomics.test.ts` reads that floor through it —
     * so adding this line put `expected '0' to be '240px'` on somebody else's guard while the
     * shipped page was fine. It was never needed: `flex-grow` is what fills the wrapper.
     */
    expect(surface, "a floor on the shared rule outranks a surface's own in jsdom's cascade")
      .not.toMatch(/min-height:/);
  });

  it("keeps compose's 220px floor, which is what the dead zone was 200px of", () => {
    const compose = ruleBody("\\.compose-editor");
    expect(compose, "no `.compose-editor` rule in app.css").not.toBeNull();
    expect(compose).toMatch(/min-height:\s*220px/);
    expect(compose).toMatch(/flex:\s*1 1 auto/);
  });
});

describe("what leaves the editor", () => {
  it("keeps the ESCAPEASPARAGRAPHS IDENTITY — an unformatted note still has no markup", () => {
    /**
     * THE ROUND TRIP THAT DECIDES WHETHER A MESSAGE IS `text/plain`, asserted directly against
     * the helper rather than only through its consequences.
     *
     * `emit` reports `html: ""` exactly when the document serialises to what `richToHtml` would
     * have built from the plain text alone. Everything downstream reads a non-empty `html` as a
     * DECISION — `compose.ts` puts markup on the wire instead of `body`, `serializeRichValue`
     * stores an envelope — so a change that made an ordinary note report markup would quietly
     * turn every plain send into a `multipart/alternative`.
     *
     * It is pinned here because admitting the code block widened what the editor can hold, and
     * the identity is the thing that must NOT have widened with it: a message with no code in it
     * is byte-identical to what the editor sent before the node existed.
     */
    for (const plain of ["just a line", "one\ntwo", "one\ntwo\nthree"]) {
      const ed = mount({ text: plain, html: "" });
      expect(ed.editor().getHTML()).toBe(escapeAsParagraphs(plain));
      act(() => { ed.editor().commands.insertContent("!"); });
      expect(ed.value.html, `a plain note reported markup: ${JSON.stringify(plain)}`).toBe("");
      expect(ed.value.text).toContain(plain.split("\n")[0]);
      act(() => { root?.unmount(); });
      root = null;
    }
  });

  it("reports an EMPTY editor as an empty html string, not as <p></p>", () => {
    // `serializeRichValue` judges emptiness on the text, but the html half must not carry a
    // phantom paragraph into a draft either — a stored `<p></p>` would send an html part that
    // some clients render as a blank message.
    const ed = mount({ text: "x", html: "<p>x</p>" });
    act(() => { selectAllAndDelete(ed); });
    expect(ed.value.html).toBe("");
    expect(ed.value.text.trim()).toBe("");
  });
});

/* ── driving the editor the way a keyboard does ────────────────────────────────────────── */

/**
 * Replays characters through ProseMirror's INPUT RULES, which is the path a keystroke takes.
 *
 * jsdom delivers no `beforeinput` a ProseMirror view can turn into a transaction, so a test
 * built on synthetic DOM events would pass while asserting nothing. Inserting character by
 * character through the editor's own command runs the same input rules a real keyboard does,
 * which is what makes the Markdown assertions below mean something.
 */
function typeInto(ed: Mounted, text: string): void {
  const editor = ed.editor();
  editor.commands.focus("end");
  for (const ch of text) {
    const { view } = editor;
    const { from, to } = view.state.selection;
    // `handleTextInput` is the prop the input-rule plugin registers, and offering each
    // character to it is what a real keystroke does. `insertContent` alone dispatches a
    // transaction and never consults the rules, which is why an earlier version of this
    // helper reported `<p>**bold** </p>` — the editor was working and the test was not typing.
    // The fifth argument is ProseMirror's own "what would have happened anyway" transaction,
    // which an input rule consults when it declines. Passing the real replacement keeps a
    // declining rule from producing a different document than a keystroke would.
    const deflt = () => view.state.tr.insertText(ch, from, to);
    const handled = view.someProp("handleTextInput", (f) => f(view, from, to, ch, deflt));
    if (!handled) editor.commands.insertContent(ch);
  }
}

function selectAllAndDelete(ed: Mounted): void {
  ed.editor().chain().focus().selectAll().deleteSelection().run();
}

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * THE MESSAGE BODY AS PROSE, AND THE ANCHOR CONTRACT.
 *
 * The report was about how a message LOOKS — "a wall of raw query string", overflowing
 * the panel, no paragraph rhythm. The fix turns sender-supplied text into `<p>` blocks and real
 * `<a>` elements, which means a component that renders untrusted bytes now decides what a link
 * points at. That is the part worth guarding, and it is guarded HERE rather than by reading the
 * component: every assertion below was watched go red against a named mutation of `BodyText.tsx`
 * and then restored — the mutations are written out on each `it`, so the next person can repeat
 * the experiment instead of trusting this sentence.
 *
 * Two claims elsewhere in the repo rest on this file:
 *   • `security-headers.ts` — no untrusted markup string reaches a DOM sink; sender bytes
 *     enter the app document only as text nodes and constructed attributes. `BodyText`
 *     returns React elements only, never an HTML string, and the last case here is what says
 *     so for the plain-text path (`message-body-prose.test.ts` holds the rich path to it).
 *   • The anchor's visible text is DERIVED FROM THE HREF. `htmlToText` has already flattened
 *     every anchor to `text [url]`, so the sender's own anchor text is just prose by the time it
 *     reaches us; linkifying only the URL substring is what makes label ≡ href by construction.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global — and why the
// component is reached by dynamic import below rather than a hoisted static one.
(globalThis as unknown as { React: unknown }).React = React;

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** Render a body and hand back the container — the `.msg-body` div `MessagePane` wraps it in. */
async function render(text: string): Promise<HTMLDivElement> {
  await unmount();
  const { BodyText } = await import("../app/shell/BodyText.js");
  host = document.createElement("div");
  host.className = "msg-body";
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(BodyText, { text }));
  });
  return host;
}

const anchors = (): HTMLAnchorElement[] => [...host!.querySelectorAll<HTMLAnchorElement>("a")];

/** Expand the folded trailing history, when the body has one. A no-op on a body with no fold. */
async function expandHistory(el: HTMLElement): Promise<void> {
  const btn = el.querySelector<HTMLButtonElement>(".msg-history-toggle");
  if (btn) await act(async () => { btn.click(); });
}

afterEach(async () => {
  await unmount();
});

describe("BodyText renders mail text as paragraphs", () => {
  it("splits on blank lines and keeps the sender's own line breaks inside a paragraph", async () => {
    // THE GUARD for the rhythm half of the slice. Delete the `.split(PARAGRAPH_BREAK)` step
    // (render one block) and this drops to a single `<p>` — which is the defect verbatim: one
    // `<p>` of newline-separated text, the shape the report called a plain text code editor.
    const el = await render("First line.\nStill the first paragraph.\n\nSecond.\n\n\nThird.");
    const paras = [...el.querySelectorAll<HTMLElement>("p.msg-p")];
    expect(paras).toHaveLength(3);
    // A SINGLE newline is the sender's line break and stays inside its paragraph; `pre-line`
    // renders it. Only a blank line starts a new block.
    expect(paras[0]!.textContent).toBe("First line.\nStill the first paragraph.");
    expect(paras[1]!.textContent).toBe("Second.");
    expect(paras[2]!.textContent).toBe("Third.");
  });

  it("normalises CRLF, which is what an IMAP body actually carries", async () => {
    // Without the `\r\n` → `\n` normalisation the paragraph break is `\r\n\r\n`, the split
    // matches nothing, and the fix is invisible on every real message while every test written
    // with `\n` stays green. Delete the `.replace(/\r\n?/g, "\n")` and this goes red.
    const el = await render("One.\r\n\r\nTwo.");
    expect(el.querySelectorAll("p.msg-p")).toHaveLength(2);
  });

  it("POSITIVE CONTROL — an ordinary https URL does become an anchor", async () => {
    // Every "no anchor was rendered" assertion below would pass vacuously if linkification were
    // simply broken. This is the case that says it is not.
    const el = await render("The invoice is at https://billing.example/inv/7 — due Friday.");
    const a = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    expect(a).toHaveLength(1);
    expect(a[0]!.getAttribute("href")).toBe("https://billing.example/inv/7");
  });
});

describe("the anchor contract", () => {
  it("CASE 1 — javascript: and data: are never anchors, and stay visible as inert text", async () => {
    /* THE GUARD. Mutation: delete the allow-list line in `anchorFor`
     *     if (!SAFE_PROTOCOLS.includes(url.protocol)) return null;
     * and both of these parse cleanly under `new URL` and render as live anchors.
     *
     * `SAFE_PROTOCOLS` is deliberately the ONLY gate — there is no second "must have a host"
     * check that would also reject these, because two overlapping guards mean deleting either
     * one leaves the suite green and neither is ever proven to do anything.
     */
    const el = await render(
      "Tap javascript:alert(1) or data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg== to win",
    );
    expect(anchors(), "an unsafe scheme became a live link").toHaveLength(0);
    // Rejected means PLAIN TEXT, not deleted: the reader still sees exactly what the sender
    // wrote. The safe branch is the default branch, and the default branch renders text.
    expect(el.textContent).toContain("javascript:alert(1)");
    expect(el.textContent).toContain("data:text/html;base64,");
  });

  it("CASE 1b — mailto: and other schemes are text too, not half-links", async () => {
    // Same gate, the benign side of it. `mailto:` is not dangerous; it is simply not something
    // this slice shipped, and the allow-list is an allow-list rather than a deny-list precisely
    // so the next scheme nobody thought of is inert by default.
    const el = await render("Write to mailto:sales@example.invalid or call.");
    expect(anchors()).toHaveLength(0);
    expect(el.textContent).toContain("mailto:sales@example.invalid");
  });

  it("CASE 2 — the visible text starts with the TRUE host, not with the destination in the query", async () => {
    /* THE GUARD, and the reason a real anchor is safe to ship at all. Mutation: make `labelOf`
     * take the tail of the path —
     *     const rest = tail === "/" ? "" : tail;
     *     return rest.split("/").pop() || url.host;
     * — and the label becomes `bank.example`, so a tracker renders wearing its target's name.
     * Anchored `toMatch(/^…/)` rather than `toContain`: the host has to be FIRST, and
     * `toContain` would pass on a label that merely mentions it somewhere. (`startsWith(…)`
     * would also be correct and reads worse when it fails — it reports "expected false to be
     * true" instead of printing the label that was actually rendered.)
     */
    const el = await render("Reset it here: https://click.trk.example/r?url=https://bank.example");
    const a = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    expect(a).toHaveLength(1);
    expect(a[0]!.textContent!).toMatch(/^click\.trk\.example/);
    // …and the href is the real destination, unaltered. Label and href describe the same place.
    expect(a[0]!.getAttribute("href")).toBe("https://click.trk.example/r?url=https://bank.example");
  });

  it("CASE 2b — userinfo cannot impersonate a host either", async () => {
    // `https://bank.example@evil.example/pay` reads as the bank to a human and resolves to
    // `evil.example`. `url.host` is the host; `bank.example` is a username. Same guard as CASE 2
    // — the label is built from `url.host` first — asked of the one trick `new URL` un-hides.
    const el = await render("Pay at https://bank.example@evil.example/pay now");
    const a = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    expect(a).toHaveLength(1);
    expect(a[0]!.textContent!).toMatch(/^evil\.example/);
    expect(a[0]!.textContent!).not.toMatch(/^bank\.example/);
  });

  it("CASE 2c — a `label [url]` pair is NOT reconstituted into a labelled anchor", async () => {
    // This is the shape `htmlToText` emits for every anchor in an HTML mail. Turning the pair
    // back into `<a href=url>label</a>` would hand the sender control of the visible text again
    // — the exact masquerade CASE 2 exists to stop — so the words stay outside the anchor and
    // only the URL substring is linkified. The `]` is punctuation, never part of the href.
    const el = await render("Confirm your account [https://click.trk.example/c/9f2]");
    const a = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    expect(a).toHaveLength(1);
    expect(a[0]!.getAttribute("href")).toBe("https://click.trk.example/c/9f2");
    expect(a[0]!.textContent!).not.toContain("Confirm your account");
    expect(a[0]!.textContent!).toMatch(/^click\.trk\.example/);
    // The label is still on screen — as prose, where the sender put it.
    expect(el.textContent).toContain("Confirm your account [");
  });

  it("CASE 2d — a long tracking URL becomes a SHORT label, which is the reported complaint", async () => {
    // "A wall of raw query string" was the report. Truncation is what removes the wall, so it
    // gets an assertion rather than being an unexercised constant: raise `MAX_TAIL` past the
    // query's length and the label goes back to being the whole URL — the defect, restored.
    // The href is NOT truncated; only what the reader is shown is.
    const long =
      "https://click.trk.example/e/c?u=98a12f&sig=4b2c9d8e7f10a3b5c6d7e8f9&utm_source=newsletter&utm_campaign=q3";
    const el = await render(`Details: ${long}`);
    const a = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    expect(a).toHaveLength(1);
    expect(a[0]!.getAttribute("href"), "the destination must survive intact").toBe(long);
    expect(a[0]!.textContent!).toMatch(/^click\.trk\.example/);
    expect(a[0]!.textContent!.length, "the label is still a wall of query string")
      .toBeLessThan(long.length / 2);
    expect(a[0]!.textContent!.endsWith("…")).toBe(true);
  });

  it("CASE 3 — every anchor opens in a new tab, severed from this document", async () => {
    // THE GUARD. Mutation: drop `rel="noopener noreferrer"` from the `<a>` in `BodyText`. With
    // `target="_blank"` and no `rel`, the opened page gets `window.opener` — a handle back onto
    // the mail client — and a Referer carrying whatever is in this URL.
    const el = await render("See https://news.example/a/1 and https://news.example/a/2.");
    const a = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    expect(a).toHaveLength(2);
    for (const link of a) {
      expect(link.getAttribute("rel")).toBe("noopener noreferrer");
      expect(link.getAttribute("target")).toBe("_blank");
      // No `ping`: an anchor in a mail body must fire zero requests, on render AND on click.
      expect(link.hasAttribute("ping")).toBe(false);
    }
  });

  it("CASE 4 — the body renders NO HTML, whatever the sender put in it", async () => {
    // The `security-headers.ts` claim, asserted rather than assumed. `BodyText` returns React
    // elements and never an HTML string; swap the paragraph for a
    // `dangerouslySetInnerHTML={{ __html: block }}` and both of these go red at once.
    const el = await render("<script>alert(1)</script> and <b>not bold</b> and <img src=x onerror=y>");
    expect(el.querySelector("script"), "a <script> element was constructed from mail").toBeNull();
    expect(el.querySelector("b")).toBeNull();
    expect(el.querySelector("img")).toBeNull();
    // The angle brackets are the sender's characters and the reader sees them, as text.
    expect(el.textContent).toContain("<script>alert(1)</script>");
    expect(el.textContent).toContain("<b>not bold</b>");
  });
});

describe("a quoted reply chain reads as a thread, not a wall (item 3)", () => {
  it("distinguishes quote depth and sets the attribution line apart", async () => {
    // THE GUARD for the thread-formatting slice. Mutation: have `classifyLine` return
    // `depth: 0` for every line (drop the `QUOTE_PREFIX` read) and both `.msg-quote` queries
    // go null; drop `isAttribution` and the attribution assertion goes red.
    // (This body's quote run is TRAILING history, folded by default since the history fold —
    // expanded here first; the collapsed state has its own describe below.)
    const el = await render(
      "Sounds good — Friday works.\n\n" +
        "On Mon, Jan 5, 2026 at 10:00, Alice <alice@example.com> wrote:\n" +
        "> Are we still on for Friday?\n" +
        ">> The original question was here.",
    );
    await expandHistory(el);
    // The two quote levels exist and are distinct.
    expect(el.querySelector('.msg-quote[data-quote-depth="1"]')).not.toBeNull();
    expect(el.querySelector('.msg-quote[data-quote-depth="2"]')).not.toBeNull();
    // The attribution line is set apart from the prose, and the `>` markers are gone from it.
    const attr = el.querySelector(".msg-attribution");
    expect(attr).not.toBeNull();
    expect(attr!.textContent).toMatch(/wrote:$/);
    expect(attr!.closest(".msg-quote")).toBeNull(); // depth-0 "On … wrote:"
    // The reader's own new line is ordinary prose, NOT inside a quote.
    const top = [...el.querySelectorAll<HTMLElement>("p.msg-p")]
      .find((p) => p.textContent === "Sounds good — Friday works.");
    expect(top, "the fresh reply is prose").toBeTruthy();
    expect(top!.closest(".msg-quote")).toBeNull();
    // The quoted content lost its ">" markers and reads as words.
    const q1 = el.querySelector('.msg-quote[data-quote-depth="1"]');
    expect(q1!.textContent).toContain("Are we still on for Friday?");
    expect(q1!.textContent).not.toContain(">");
  });

  it("recognises a forwarded German header block as attribution", async () => {
    // The reported "Von: … Betreff: …" case. Consecutive header lines with no blank
    // between them collapse into ONE attribution block, not four prose paragraphs.
    const el = await render(
      "Von: Alice <alice@example.com>\n" +
        "Gesendet: Montag, 5. Januar 2026 10:00\n" +
        "An: Bob\n" +
        "Betreff: Re: AW: AW: Webshop",
    );
    const attrs = el.querySelectorAll(".msg-attribution");
    expect(attrs.length).toBe(1);
    expect(el.querySelectorAll("p.msg-p").length).toBe(0);
    expect(attrs[0]!.textContent).toContain("Betreff: Re: AW: AW: Webshop");
  });

  it("preserves the sender's line breaks inside a quoted block", async () => {
    // pre-line renders the `\n`; the text node carries them, unmerged — the contract, held
    // through the quote wrapper. Mutation: `.join(" ")` instead of `.join("\n")` in `toBlocks`.
    // No `expandHistory` here, and that is an assertion too: a body that is NOTHING BUT quote
    // has no fresh words to leave on screen, so it never folds (see the history describe).
    const el = await render("> line one\n> line two\n> line three");
    expect(el.querySelector(".msg-history-toggle")).toBeNull();
    const q = el.querySelector('.msg-quote[data-quote-depth="1"] .msg-p');
    expect(q).not.toBeNull();
    expect(q!.textContent).toBe("line one\nline two\nline three");
  });

  /**
   * ── THE QUOTED HISTORY IS ONE OBJECT, NOT A PICKET FENCE OF BARS ──────────────────────
   *
   * The report, with a screenshot: an Exchange thread — plain-text Outlook-style
   * reply chain, German business prose, `>`-quoting three levels deep — rendered "weirdly
   * with alternating vertical quote lines". The mechanism: every quoted PARAGRAPH became its
   * own `.msg-quote` (a `>`-blank line flushes the block, and each block got its own
   * wrapper), so one coherent quoted message fragmented into disconnected bar-marked chunks
   * with 14px gaps between the bars, and a depth change opened yet another sibling instead
   * of nesting.
   *
   * The contract now: contiguous quoted lines share ONE container per level, and a deeper
   * run nests INSIDE the shallower one, the way a native mail client draws a chain — one
   * quiet rule per level, running unbroken down everything quoted at that level.
   *
   * The fixture is the reported shape verbatim: "Am <date> schrieb <name>:" hops, umlauts,
   * and angle-bracket URLs (`<office.com>`, `<https://…>`), which is how Outlook's
   * plain-text part writes links.
   */
  const EXCHANGE_THREAD =
  "Hallo Herr Brändli, kurz zum Stand,\n" +
  "\n" +
  "Machen wir so — danke für die Hinweise.\n" +
  "\n" +
  "Am 05.08.2026 um 14:32 schrieb Nadja Lehner:\n" +
  "> Hallo Jürg,\n" +
  ">\n" +
  "> die Lizenz für <office.com> endet bald.\n" +
  "> Sollen wir sie verlängern?\n" +
  ">\n" +
  "> Grüße\n" +
  "> Nadja\n" +
  ">\n" +
  "> Am 04.08.2026 um 09:15 schrieb Jürg Brändli:\n" +
  ">> Weisst du, wann die Lizenz für das Studio abläuft?\n" +
  ">>\n" +
  ">> Danke und Grüße\n" +
  ">> Jürg\n" +
  ">>\n" +
  ">> Am 03.08.2026 um 16:40 schrieb Nadja Lehner:\n" +
  ">>> Die Verlängerung geht bis Ende August.\n" +
  ">>>\n" +
  ">>> Hier verlängern <https://office.com/renew>.";

  it("merges contiguous same-depth quoted paragraphs into ONE container per level", async () => {
    /* THE GUARD for the fragmentation defect itself. Mutation: in `toTree`, empty the whole
     * stack before every block (`while (stack.length > 0) stack.pop()`) — every paragraph
     * reopens its own container, the counts below read 4/3/2 instead of 1/1/1, and this is
     * the screenshot restored. Watched red against exactly that before the fix landed. */
    const el = await render(EXCHANGE_THREAD);
    await expandHistory(el); // the whole chain is trailing history now — folded until asked for
    expect(el.querySelectorAll('.msg-quote[data-quote-depth="1"]'),
      "the depth-1 history fragmented into one bar per paragraph").toHaveLength(1);
    expect(el.querySelectorAll('.msg-quote[data-quote-depth="2"]')).toHaveLength(1);
    expect(el.querySelectorAll('.msg-quote[data-quote-depth="3"]')).toHaveLength(1);
    // Every quoted paragraph is still there — merging containers must not merge or drop text.
    const q1 = el.querySelector('.msg-quote[data-quote-depth="1"]')!;
    expect(q1.textContent).toContain("Hallo Jürg,");
    expect(q1.textContent).toContain("die Lizenz für <office.com> endet bald.");
    expect(q1.textContent).toContain("Grüße\nNadja");
    // The umlauts are the sender's characters, untouched.
    expect(el.textContent).toContain("Jürg Brändli");
    expect(el.textContent).toContain("abläuft");
  });

  it("a deeper quote NESTS inside the shallower one — levels are not siblings", async () => {
    // Nesting is what makes each level contribute exactly one rule: a depth-3 paragraph sits
    // under three bars because it sits inside three containers. Mutation: render the tree
    // flat (append every container to the top level) and both containments go red.
    const el = await render(EXCHANGE_THREAD);
    await expandHistory(el);
    const q1 = el.querySelector('.msg-quote[data-quote-depth="1"]')!;
    const q2 = el.querySelector('.msg-quote[data-quote-depth="2"]')!;
    const q3 = el.querySelector('.msg-quote[data-quote-depth="3"]')!;
    expect(q1.contains(q2), "depth 2 must nest inside depth 1").toBe(true);
    expect(q2.contains(q3), "depth 3 must nest inside depth 2").toBe(true);
    // The fresh reply stays prose, outside any container.
    const fresh = [...el.querySelectorAll<HTMLElement>("p.msg-p")]
      .find((p) => p.textContent!.includes("Machen wir so"));
    expect(fresh).toBeTruthy();
    expect(fresh!.closest(".msg-quote")).toBeNull();
    // The in-quote attribution keeps its role, inside the level it belongs to.
    const hop = [...q1.querySelectorAll<HTMLElement>(".msg-attribution")]
      .find((a) => a.textContent!.includes("Jürg Brändli"));
    expect(hop, "the hop attribution renders as attribution inside the quote").toBeTruthy();
  });

  it("angle-bracket URLs — Outlook's plain-text link shape — linkify without eating the brackets", async () => {
    const el = await render(EXCHANGE_THREAD);
    await expandHistory(el); // both URLs live in the quoted history
    const a = [...el.querySelectorAll<HTMLAnchorElement>("a")];
    // `<office.com>` has no scheme: text, not a link. `<https://office.com/renew>` is one.
    expect(a).toHaveLength(1);
    expect(a[0]!.getAttribute("href")).toBe("https://office.com/renew");
    expect(el.textContent).toContain("<office.com>");
  });

  it("an inline reply between two quoted runs still splits the container", async () => {
    // The merge must not overshoot: depth-0 prose BETWEEN quoted runs is an inline reply, and
    // the two runs are two objects. Mutation: never close containers on a depth-0 block and
    // the second run folds into the first — this count goes to 1 and the reply lands inside.
    const el = await render("> erster Teil\n\nMein Einwand dazu.\n\n> zweiter Teil");
    // Collapsed, the MID-MESSAGE run is already on screen — prose follows it, so it is part of
    // the letter, not trailing history. Only the second, trailing run is behind the fold.
    expect(el.querySelectorAll('.msg-quote[data-quote-depth="1"]')).toHaveLength(1);
    expect(el.textContent).toContain("erster Teil");
    expect(el.textContent).not.toContain("zweiter Teil");
    await expandHistory(el);
    expect(el.querySelectorAll('.msg-quote[data-quote-depth="1"]')).toHaveLength(2);
    const reply = [...el.querySelectorAll<HTMLElement>("p.msg-p")]
      .find((p) => p.textContent === "Mein Einwand dazu.");
    expect(reply!.closest(".msg-quote")).toBeNull();
  });

  it("a pathological '>>>>>' chain is clamped — bounded nesting, nothing dropped", async () => {
    // The flat rendering's virtue was that a ">".repeat(N) line cost N nothing; nesting must
    // not turn it into N wrappers. The depth is clamped and the words still render.
    const el = await render(`${">".repeat(40)} ganz unten`);
    const quotes = [...el.querySelectorAll<HTMLElement>(".msg-quote")];
    expect(quotes.length).toBeGreaterThan(0);
    expect(quotes.length).toBeLessThanOrEqual(8);
    for (const q of quotes) {
      expect(Number(q.getAttribute("data-quote-depth"))).toBeLessThanOrEqual(8);
    }
    expect(el.textContent).toContain("ganz unten");
  });

  it("plants html INSIDE a quoted thread and constructs ZERO element nodes from it", async () => {
    // The srcdoc sandbox is the XSS boundary; this native path must never build DOM from mail,
    // quoted or not. `BodyText` returns text nodes plus the <p>/<div.msg-quote>/<a> it builds,
    // so an <img>/<script>/<b> from the sender is impossible here.
    const el = await render(
      "> <img src=x onerror=steal()>\n> <script>steal()</script>\n> <b>bold</b>",
    );
    expect(el.querySelectorAll("img, script, b").length).toBe(0);
    // The sender's angle-bracket text is still visible, as text, inside the quote.
    expect(el.textContent).toContain("<script>steal()</script>");
    expect(el.querySelector('.msg-quote[data-quote-depth="1"]')).not.toBeNull();
  });
});

describe("the trailing quoted history folds behind a toggle", () => {
  /**
   * ── THE HISTORY IS THERE WHEN ASKED FOR, NOT BEFORE ────────────────────────────────────
   *
   * A reply carries the whole chain under it, and the chain is usually the part the reader has
   * already read. So the TRAILING top-level quote run — and the attribution line that introduces
   * it — is collapsed behind a quiet chip by default. Only the trailing run: a quote the writer
   * answered inline (prose after it) is part of the letter and stays on screen, and a body that
   * is nothing but quote never folds, because collapsing it would empty the pane.
   *
   * Every assertion below was watched red before the fold landed (the history rendered inline),
   * and each names the mutation that sends it red again.
   */
  const REPLY =
    "Sounds good — Friday works.\n\n" +
    "On Mon, Jan 5, 2026 at 10:00, Alice <alice@example.com> wrote:\n" +
    "> Are we still on for Friday?\n" +
    ">> The original question was here.";

  it("is collapsed by DEFAULT — the history is not in the DOM until asked for", async () => {
    /* THE GUARD for the fold existing at all. Mutation: render the history arm unconditionally
     * (drop the `open ?` in front of it) — the quoted words are on screen at mount and the
     * `toBeNull`/`not.toContain` half of this goes red. */
    const el = await render(REPLY);
    // The writer's own words are on screen, untouched…
    expect(el.textContent).toContain("Sounds good — Friday works.");
    // …the history is not — not hidden by style, NOT IN THE DOM.
    expect(el.querySelector(".msg-quote"), "the quoted run rendered while collapsed").toBeNull();
    expect(el.textContent).not.toContain("Are we still on for Friday?");
    // The attribution introduces the history, so it folds with it.
    expect(el.querySelector(".msg-attribution")).toBeNull();
    const btn = el.querySelector<HTMLButtonElement>(".msg-history-toggle");
    expect(btn, "no toggle — the history would be unreachable").not.toBeNull();
    expect(btn!.getAttribute("aria-expanded")).toBe("false");
    expect(btn!.textContent).toBe("Show history");
  });

  it("expanding restores the EXACT quoted text; collapsing removes it again", async () => {
    /* THE GUARD for the fold not eating mail. Mutation: `slice(start + 1)` where the history is
     * split off (drop its first node) — the attribution never comes back and the byte-exact
     * assertions here go red. Likewise a fold that renders the history from anything other than
     * the same node tree the inline path uses. */
    const el = await render(REPLY);
    const btn = el.querySelector<HTMLButtonElement>(".msg-history-toggle")!;
    await act(async () => { btn.click(); });
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    expect(btn.textContent).toBe("Hide history");
    const attr = el.querySelector(".msg-attribution");
    expect(attr, "the attribution must come back with the history").not.toBeNull();
    expect(attr!.textContent).toBe(
      "On Mon, Jan 5, 2026 at 10:00, Alice <alice@example.com> wrote:",
    );
    // Byte-exact: the depth-1 container holds its own paragraph plus the nested depth-2 one.
    const q1 = el.querySelector('.msg-quote[data-quote-depth="1"]');
    expect(q1).not.toBeNull();
    expect(q1!.textContent).toBe("Are we still on for Friday?The original question was here.");
    expect(el.querySelector('.msg-quote[data-quote-depth="2"]')!.textContent)
      .toBe("The original question was here.");
    // And it is a TOGGLE: collapsing puts the pane back exactly as it mounted.
    await act(async () => { btn.click(); });
    expect(btn.getAttribute("aria-expanded")).toBe("false");
    expect(btn.textContent).toBe("Show history");
    expect(el.querySelector(".msg-quote")).toBeNull();
  });

  it("the toggle is a real <button type=button> — keyboard operation comes with the element", async () => {
    // Enter and Space activate a native button; nothing re-implements that here, so the guard
    // is the element itself. Mutation: render a `<span onClick>` instead — both lines go red.
    const el = await render(REPLY);
    const btn = el.querySelector<HTMLElement>(".msg-history-toggle")!;
    expect(btn.tagName).toBe("BUTTON");
    expect(btn.getAttribute("type")).toBe("button");
  });

  it("a body that is nothing but quote never folds — collapsing it would empty the pane", async () => {
    // A forward whose text part arrives fully `>`-quoted, with or without its header block:
    // there are no fresh words to leave on screen, so the fold does not apply.
    const el = await render("Von: Alice <alice@example.com>\nBetreff: FYI\n\n> der ganze Text\n> zweite Zeile");
    expect(el.querySelector(".msg-history-toggle")).toBeNull();
    expect(el.querySelector('.msg-quote[data-quote-depth="1"]')).not.toBeNull();
    expect(el.textContent).toContain("der ganze Text");
  });

  it("expansion does not leak onto the NEXT message rendered in the same slot", async () => {
    /* The state keys on the message text, not on the component instance. Mutation: plain
     * `useState(false)` with no text key — the second message below mounts EXPANDED because the
     * pane reused the component, and the `not.toContain` goes red. */
    const el = await render(REPLY);
    await expandHistory(el);
    expect(el.textContent).toContain("Are we still on for Friday?");
    const { BodyText } = await import("../app/shell/BodyText.js");
    const OTHER =
      "Fine by me.\n\nOn Tue, Bob wrote:\n> completely different history";
    await act(async () => {
      root!.render(h(BodyText, { text: OTHER }));
    });
    expect(el.textContent).toContain("Fine by me.");
    expect(el.textContent).not.toContain("completely different history");
    expect(el.querySelector(".msg-history-toggle")!.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("the links it draws are the links it reports", () => {
  /**
   * The desktop shell opens an address only when a renderer reported it as a link on screen
   * (`rendered-links.ts`), so what this component reports must be exactly what its anchors carry:
   * a link drawn and not reported is a link that will not open, one reported and not drawn widens
   * the list. Mutations: drop the collector from `linkify` → the plain rows go red; from the
   * `link` case of `renderInline` → the rich rows go red; collect the history before it is open →
   * the fold row goes red.
   */
  type Mod = typeof import("../app/shell/rendered-links.js");
  let links: Mod;
  /** Every report, in order; `onScreen` folds them into what the shell would hold now. */
  const reports: Array<{ surface: string; hrefs: string[] }> = [];
  const onScreen = (): Map<string, string[]> => {
    const held = new Map<string, string[]>();
    for (const r of reports) {
      if (r.hrefs.length === 0) held.delete(r.surface);
      else held.set(r.surface, r.hrefs);
    }
    return held;
  };
  const reported = (): string[] => [...onScreen().values()].flat().sort();
  const drawn = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLAnchorElement>("a")].map((a) => a.getAttribute("href")!).sort();

  beforeEach(async () => {
    reports.length = 0;
    links = await import("../app/shell/rendered-links.js");
    links.setRenderedLinksSink((surface, hrefs) => reports.push({ surface, hrefs: [...hrefs] }));
  });
  afterEach(() => links.setRenderedLinksSink(null));

  it("the plain path reports exactly the hrefs its anchors carry, and takes them back at unmount", async () => {
    const el = await render(
      "Read https://example.test/a?b=1&c=2. Not javascript:alert(1) though.\n\n" +
        "Also <https://bücher.example/ü> and https://example.test/a?b=1&c=2 again.",
    );
    expect(drawn(el).length).toBe(3);
    expect(reported()).toEqual([...new Set(drawn(el))].sort());
    expect(reported()).toContain("https://xn--bcher-kva.example/%C3%BC");
    expect(onScreen().size, "one surface per mounted body").toBe(1);
    await unmount();
    expect(onScreen().size, "the unmount left its links on the list").toBe(0);
  });

  it("the rich path reports the hrefs of its link runs", async () => {
    const { BodyText } = await import("../app/shell/BodyText.js");
    const link = (href: string, text: string) => ({
      kind: "link" as const, href, host: new URL(href).host, elsewhere: false,
      children: [{ kind: "text" as const, text }],
    });
    const rich = [
      { kind: "rich" as const, attribution: false, spacing: "paragraph" as const,
        children: [link("https://example.test/one", "one"), { kind: "text" as const, text: " and " },
          link("https://elsewhere.test/two?x=1", "two")] },
      { kind: "list" as const, ordered: false, items: [[
        { kind: "rich" as const, attribution: false, spacing: "line" as const, children: [link("http://example.test/three", "three")] },
      ]] },
    ];
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(h(BodyText, { text: "fallback", rich })); });
    expect(drawn(host)).toEqual(["http://example.test/three", "https://elsewhere.test/two?x=1", "https://example.test/one"]);
    expect(reported()).toEqual(drawn(host));
  });

  it("a folded history's links are reported once it is open, and taken back when it folds", async () => {
    const el = await render(
      "See https://example.test/lead.\n\nOn Mon, Alice wrote:\n> the old link https://example.test/history",
    );
    expect(reported()).toEqual(["https://example.test/lead"]);
    await expandHistory(el);
    expect(reported()).toEqual(["https://example.test/history", "https://example.test/lead"]);
    await expandHistory(el);
    expect(reported()).toEqual(["https://example.test/lead"]);
  });

  it("a long body reports a page's links when the page is drawn", async () => {
    const lines = Array.from({ length: 2100 }, (_, i) => `line ${i}`);
    lines[0] = "first https://example.test/page-one";
    lines[2099] = "last https://example.test/page-two";
    const el = await render(lines.join("\n"));
    expect(reported()).toEqual(["https://example.test/page-one"]);
    const more = el.querySelector<HTMLButtonElement>("button.msg-page-more");
    expect(more, "the body did not page").not.toBeNull();
    await act(async () => { more!.click(); });
    expect(reported()).toEqual(["https://example.test/page-one", "https://example.test/page-two"]);
  });

  it("with no sink there is nowhere to report, and nothing breaks", async () => {
    links.setRenderedLinksSink(null);
    const el = await render("https://example.test/x");
    expect(drawn(el)).toEqual(["https://example.test/x"]);
    expect(reports).toEqual([]);
  });
});

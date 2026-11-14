/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";

/**
 * ── DESIGNED HTML MAIL KEEPS ITS FRAME; A LETTER KEEPS THE APP'S TYPE ─────────────────────
 *
 * The ruling (2026-08-25, from a real marketing message rendered with a drawn border
 * around every nesting level of its borderless layout tables): *"it should rather show us the
 * original html mail directly, because it's not a text-based but an html mail."*
 *
 * The defect's mechanism, established against the real message: the template is the modern
 * responsive hybrid — `width="100%"` wrapper tables capped by `style="max-width:580px"`, with
 * the fixed `width="580"` twins living ONLY inside `<!--[if mso]>` conditional comments, which
 * the sanitizer strips as comments. So the sanitized document declares its canvas exclusively
 * as `max-width`, which `isRigidLayout` deliberately refuses (a cap is not a fixed canvas for
 * SCALING purposes) — and the mail fell to the prose walker, whose table rendering draws the
 * app's own borders on every cell.
 *
 * The fix is `isDesignedLayout`: a responsive canvas (max-width in the rigid band) or a nested
 * layout table classifies the mail as DESIGNED — framed, reflowed at the column, zero reader
 * CSS anywhere near it (an iframe's document inherits nothing by cascade). `reflow` is
 * untouched: designed-but-not-rigid mail is laid out at the column, never scale-to-fit.
 *
 * Both halves are pinned: the designed shapes get a frame and no `.msg-table`; the letter
 * shapes KEEP the prose path — `.msg-p` typography, and a genuine data table still rendered in
 * the app's own table style. Mutations proven red (see each guard's note).
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(el: React.ReactElement): Promise<void> {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
  // MessageBody classifies only after mount (hydration guard) — one more paint.
  await act(async () => {});
}
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
});

/**
 * THE ACCEPTANCE SHAPE — the real message's structure with none of its content: nested
 * borderless layout tables (`cellpadding/cellspacing 0`, no `border`), `width="100%"` wrappers,
 * a `max-width:580px` card, pictures, a CTA. No fixed `width` in the rigid band anywhere —
 * that twin lives in the MSO conditional below, exactly as the real template ships it, and the
 * sanitizer removes it with the comment.
 */
const NESTED_LAYOUT_HTML = `<!DOCTYPE html><html><head>
<style>@media only screen and (max-width: 605px){.wrapper{width:100%!important}}</style>
</head><body>
<!--[if (gte mso 9)|(IE)]><table width="580" align="center"><tr><td><![endif]-->
<table cellpadding="0" cellspacing="0" width="100%"><tr><td align="center">
  <table class="wrapper" cellpadding="0" cellspacing="0" width="100%" border="0" style="max-width:580px"><tr><td>
    <table width="100%" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding:16px">
      <p>Hallo,</p>
      <table width="100%" border="0" cellspacing="0" cellpadding="0"><tr>
        <td><a href="https://shop.example/item/1">A designed offer</a></td>
        <td align="right">1'899.-</td>
      </tr></table>
    </td></tr></table>
  </td></tr></table>
</td></tr></table>
<!--[if (gte mso 9)|(IE)]></td></tr></table><![endif]-->
</body></html>`;

/** The same class declared by max-width ALONE — one wrapper, no nesting. */
const MAXWIDTH_ONLY_HTML = `<div style="max-width:600px;margin:0 auto">
<p>A single-card template with a responsive canvas and no nested grid.</p></div>`;

/** And by nesting ALONE — the old-school full-width grid that declares no cap at all. */
const NESTED_ONLY_HTML = `<table width="100%" cellpadding="0" cellspacing="0"><tr><td>
<table width="100%" cellpadding="0" cellspacing="0"><tr><td><p>Grid content</p></td></tr></table>
</td></tr></table>`;

/**
 * THE SIBLING — an ordinary business letter. Paragraphs, a quoted thread, a signature, a
 * media query in a client-emitted style block (the near-miss `declaresResponsiveCanvas` must
 * refuse: `max-width:620px` inside `@media (…)` is a viewport QUERY, not a canvas), and ONE
 * non-nested data table (an order summary — header row, short cells). This must KEEP the
 * prose rendering: the app's own paragraph type, and the data table in the app's own table
 * style. That is the typography half of the acceptance, pinned so the designed class cannot
 * quietly swallow the letters.
 */
const LETTER_HTML = `<html><head>
<style>p{margin:0 0 10px} @media only screen and (max-width:620px){.x{padding:4px}}</style>
</head><body>
<p>Hi Mila,</p>
<p>the order shipped this morning — summary below.</p>
<table border="1"><tr><th>Item</th><th>Qty</th></tr><tr><td>Felgen</td><td>4</td></tr></table>
<blockquote><p>Could you confirm the quantity?</p></blockquote>
<p>Best, A.</p>
</body></html>`;

const TEXT_PART = "Hi Mila,\nthe order shipped this morning.\nBest, A.";

describe("designed html mail keeps its frame (item: the reading pane renders html mail as sent)", () => {
  it("classifies the acceptance shape designed: framed AND reflowed, never prose", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(NESTED_LAYOUT_HTML);
    expect(out.prose).toBe(false);   // MUTATION-PROVEN: isDesignedLayout → false turns this red.
    expect(out.reflow).toBe(true);   // designed ≠ rigid — laid out at the column, not shrunk.
    expect(out.rich).toBeNull();     // no walker output for a mail the frame renders.
  });

  it("classifies a max-width canvas designed on its own", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(MAXWIDTH_ONLY_HTML);
    expect(out.prose).toBe(false);
    expect(out.reflow).toBe(true);
  });

  it("classifies a nested layout grid designed on its own", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(NESTED_ONLY_HTML);
    expect(out.prose).toBe(false);
    expect(out.reflow).toBe(true);
  });

  it("renders the acceptance shape in a frame with ZERO reader-drawn table styling", async () => {
    const { MessageBody } = await mod();
    await mount(h(MessageBody, { text: TEXT_PART, html: NESTED_LAYOUT_HTML }));
    // The frame is the isolation mechanism: reader CSS cannot cascade into an iframe's own
    // document, so "zero reader-drawn borders" is structural the moment the frame exists.
    const frame = host!.querySelector("iframe.mb-frame");
    expect(frame).not.toBeNull();
    // And the prose table rendering — the element the borders are drawn on — must be ABSENT.
    expect(host!.querySelector(".msg-table")).toBeNull();
    expect(host!.querySelector(".msg-p")).toBeNull();
    // The frame's document carries the reflow attribute: at the column, not scale-to-fit.
    expect(frame!.getAttribute("srcdoc") ?? "").toContain("data-ohmail-reflow");
  });

  it("keeps the letter on the prose path: app typography, data table in app style", async () => {
    const { sanitizeMailHtml, MessageBody } = await mod();
    const out = sanitizeMailHtml(LETTER_HTML);
    // MUTATION-PROVEN both ways: isDesignedLayout → true turns this red (the letter loses the
    // reader's typography), and dropping the declaration-boundary anchor from
    // declaresResponsiveCanvas turns it red too (the media query's 620px would classify it).
    expect(out.prose).toBe(true);
    await mount(h(MessageBody, { text: TEXT_PART, html: LETTER_HTML }));
    expect(host!.querySelector("iframe")).toBeNull();
    expect(host!.querySelector(".msg-p")).not.toBeNull();      // the app's paragraph type
    expect(host!.querySelector(".msg-table")).not.toBeNull();  // the data table, app-styled
  });

  it("still classifies a fixed canvas rigid — the scale-to-fit class is untouched", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(`<table width="600"><tr><td><p>fixed newsletter</p></td></tr></table>`);
    expect(out.prose).toBe(false);
    expect(out.reflow).toBe(false); // rigid: the one class the fit transform exists for.
  });

  /**
   * THE STYLESHEET ARM IS RULE-WISE — an image-size cap is not a canvas. A letter that carries
   * `img.hero { max-width:600px }` is capping a PICTURE (the reflow `CANVAS_TAGS` excludes images
   * for), and a flat-string read of the sheet classified it designed on the strength of that one
   * rule. MUTATION-PROVEN: replace `sheetsDeclare(styleText, declaresResponsiveCanvas)` with the flat
   * `declaresResponsiveCanvas(styleText)` in `isDesignedLayout` and the first assertion goes red.
   * The second pins the arm still WORKS — a `.card` rule in the band is the sheet spelling of a
   * designed canvas, and a scan that skipped every rule would leave it a letter.
   */
  it("an image-only max-width rule does not classify a letter designed; a card rule does", async () => {
    const { sanitizeMailHtml } = await mod();
    const letter = sanitizeMailHtml(
      `<html><head><style>img.hero { max-width:600px }</style></head>` +
        `<body><p>Just a note with a big pasted photo.</p></body></html>`,
    );
    expect(letter.prose).toBe(true);

    const card = sanitizeMailHtml(
      `<html><head><style>.card { max-width:600px }</style></head>` +
        `<body><div class="card"><p>A designed single-card template.</p></div></body></html>`,
    );
    expect(card.prose).toBe(false);
  });

  /**
   * A CSS COMMENT MUST NOT POISON THE SELECTOR TEST. `/* img defaults ... .card{max-width:600px}`
   * would put the token `img` into the captured selector text and skip a genuine canvas rule —
   * and a brace inside a comment would misalign every rule after it. Comments are stripped
   * before rules are read. MUTATION-PROVEN: drop the comment strip in
   * `oneSheetDeclares` and both assertions go red.
   */
  it("a comment naming img (or holding a brace) does not hide a canvas rule", async () => {
    const { sanitizeMailHtml } = await mod();
    const commented = sanitizeMailHtml(
      `<html><head><style>/* img defaults */ .card { max-width:600px }</style></head>` +
        `<body><div class="card"><p>Designed, behind a chatty comment.</p></div></body></html>`,
    );
    expect(commented.prose).toBe(false);

    const braced = sanitizeMailHtml(
      `<html><head><style>/* { */ .card { max-width:600px }</style></head>` +
        `<body><div class="card"><p>Designed, behind a brace in a comment.</p></div></body></html>`,
    );
    expect(braced.prose).toBe(false);
  });

  /**
   * COMMENT DELIMITERS INSIDE STRINGS ARE TEXT, NOT COMMENTS. A `content` property whose quoted
   * value is a comment-open, then a real canvas rule, then another whose value is a comment-close
   * (the fixture below — the delimiters cannot be written in this comment without ending it,
   * which is its own demonstration of the trap) is all live CSS to a browser; a stripper that
   * cannot see strings deletes the genuine canvas rule between the two and the designed message
   * drops to prose. MUTATION-PROVEN: replace `stripCssComments` with the flat lazy-regex
   * replace and this goes red.
   */
  it("comment delimiters inside CSS strings do not swallow the rules between them", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.a{content:"/*"} .card{max-width:600px} .b{content:"*/"}</style></head>` +
        `<body><div class="card"><p>Designed, between two quoted delimiters.</p></div></body></html>`,
    );
    expect(out.prose).toBe(false);
  });

  /**
   * AND THE STRIPPER IS LINEAR, NOT A LAZY REGEX. A stylesheet of repeated `/*` starts that
   * never close makes `/\/\*[\s\S]*?\*\//g` re-scan the remainder from every start — quadratic
   * on the thread that paints the app, reachable within the 512 KiB cap. The forward scan
   * treats the first unterminated comment as running to EOF (CSS Syntax's own rule) in one
   * pass. The fixture is big enough that the quadratic form blows the timeout while the scan
   * finishes in milliseconds — the same discrimination the `url(` scanner's history used.
   */
  it("a stylesheet of unterminated comment starts classifies in linear time", { timeout: 3000 }, async () => {
    const { sanitizeMailHtml } = await mod();
    const hostile = `<html><head><style>${"/*a{}".repeat(60_000)}</style></head>` +
      `<body><p>letter</p></body></html>`;
    const out = sanitizeMailHtml(hostile);
    // Everything after the first unterminated start is comment to CSS — nothing here is a canvas.
    expect(out.prose).toBe(true);
  });

  /**
   * AND THE RULE SCAN IS LINEAR TOO. A long quoted token with no braces — which the comment
   * stripper rightly PRESERVES, delimiters and all — fed the old rule regex a span it re-scanned
   * from every offset hunting a `{` that is not there. The brace walk visits each character
   * once, whatever the sheet holds.
   */
  it("a long brace-free quoted token classifies in linear time", { timeout: 3000 }, async () => {
    const { sanitizeMailHtml } = await mod();
    const hostile = `<html><head><style>"/*${"a".repeat(200_000)}*/"</style></head>` +
      `<body><p>letter</p></body></html>`;
    const out = sanitizeMailHtml(hostile);
    expect(out.prose).toBe(true);
  });

  /**
   * CSS TOKEN BOUNDARIES HOLD: an ESCAPED quote is an ident character, not a string opener.
   * A stray `.\\'x{}` selector followed by a real comment used to open a "string" at the
   * apostrophe, run to EOF, and leave the comment's contents live for the rule scan — an
   * ordinary letter classified designed on the strength of a rule its sender commented OUT.
   * MUTATION-PROVEN: drop the top-level backslash skip in `stripCssComments` and this is red.
   */
  it("an escaped quote does not open a string, so a commented-out canvas stays commented", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.\\'x{} /* .card{max-width:600px} */</style></head>` +
        `<body><p>Just a letter.</p></body></html>`,
    );
    expect(out.prose).toBe(true);
  });

  /**
   * AN UNQUOTED URL TOKEN IS DATA from its open paren to its close — a comment-open inside one
   * is part of the url, and a stripper that read it as a comment ate every live rule up to the
   * next close-lookalike in a later url, dropping a designed message to prose. MUTATION-PROVEN:
   * remove the url-token skip in `stripCssComments` and this goes red.
   */
  it("a comment-open inside an unquoted url does not swallow the live rules after it", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.x{background:url(foo\\'bar/*baz)} .card{max-width:600px} ` +
        `.y{background:url(x*/y)}</style></head>` +
        `<body><div class="card"><p>Designed, between two url tokens.</p></div></body></html>`,
    );
    expect(out.prose).toBe(false);
  });

  /**
   * A RULE NEEDS A SELECTOR. Adjacent open braces inside quoted string data — which the brace
   * walk deliberately reads exactly as the old rule regex did — produce an empty selector slice,
   * and the old regex refused those; accepting one would launder quoted text into a live
   * declaration and frame an ordinary letter. MUTATION-PROVEN: drop the `sel.trim() !== ""`
   * term and this goes red.
   */
  it("string data with adjacent braces does not become a rule with an empty selector", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.a{content:"{{max-width:600px}"}</style></head>` +
        `<body><p>Just a letter with odd string content.</p></body></html>`,
    );
    expect(out.prose).toBe(true);
  });

  /**
   * A QUOTED url argument may hold a literal close-paren; the url skip must scan the string
   * first or it stops inside it, reads the string's comment-open as live, and eats the real
   * canvas rule after it. MUTATION-PROVEN: drop the quoted-argument scan inside the url skip
   * and the first assertion goes red.
   */
  it("a quoted url argument holding a close-paren does not derail the stripper", async () => {
    const { sanitizeMailHtml } = await mod();
    const designed = sanitizeMailHtml(
      `<html><head><style>.x{background:url("foo)/*")} .card{max-width:600px} ` +
        `.y{content:"*/"}</style></head>` +
        `<body><div class="card"><p>Designed, after a parenthesised string.</p></div></body></html>`,
    );
    expect(designed.prose).toBe(false);

    // And an at-keyword is NOT a url token: its parenthesised text is ordinary CSS, so the
    // comment inside it stays a comment and the letter stays a letter.
    const letter = sanitizeMailHtml(
      `<html><head><style>@url(/* { max-width:600px } */); p { color: red }</style></head>` +
        `<body><p>Just a letter.</p></body></html>`,
    );
    expect(letter.prose).toBe(true);

    // After a QUOTED argument the outer scanner resumes: a genuine comment between the
    // argument and the function's close-paren is still a comment, so its braces never reach
    // the rule walk and the letter is not framed on the strength of commented-out text.
    const resumed = sanitizeMailHtml(
      `<html><head><style>.x{background:url("foo)"\n/* { max-width:600px } */\n)}</style></head>` +
        `<body><p>Just a letter.</p></body></html>`,
    );
    expect(resumed.prose).toBe(true);
  });

  /**
   * A HEX ESCAPE CONSUMES ITS WHITESPACE TERMINATOR. In a quoted url argument, an escape like
   * a two-digit hex code ended by a line feed keeps that line feed INSIDE the escape — a
   * scanner that skipped one character surfaced the line feed, read it as a bad-string end,
   * and resumed the outer scan from the middle of the string, where the string's comment-open
   * then ate the live canvas rule after it. MUTATION-PROVEN: revert the quoted-argument loop's
   * escape handling to a single-character skip and this goes red.
   */
  it("a hex escape's newline terminator stays inside the escape", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.x{background:url("foo\\61\n/*")} .card{max-width:600px} ` +
        `.y{content:"*/"}</style></head>` +
        `<body><div class="card"><p>Designed, behind an escaped terminator.</p></div></body></html>`,
    );
    expect(out.prose).toBe(false);
  });

  /**
   * THE BRACE WALK HONOURS STRINGS ITSELF. A preserved string can hold rule-shaped text —
   * braces, a max-width declaration, comment delimiters — and none of it is structure. Relying
   * on comment removal alone left one road in: an escape-continued string whose contents look
   * like a rule. The walk now skips quoted tokens with the same escape and bad-string rules the
   * stripper uses. MUTATION-PROVEN: remove the walk's string skip and this goes red.
   */
  it("rule-shaped text inside a string never reaches the brace walk", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.a{content:"foo\\61\n/* .card{max-width:600px} */"}</style></head>` +
        `<body><p>Just a letter with a chatty string.</p></body></html>`,
    );
    expect(out.prose).toBe(true);
  });

  /**
   * CSS WHITESPACE INCLUDES NEWLINES — a template may break the line after the url function's
   * open paren before a quoted argument, and a skip that only knew space/tab read the quoted
   * form as unquoted data, stopped at the `)` INSIDE the string, and the blanker then ate the
   * live canvas rule after it. MUTATION-PROVEN: drop the newline set from the whitespace skip
   * and this goes red.
   */
  it("a line break before a quoted url argument does not derail the blanker", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.x{background:url(\n"foo)")} .card{max-width:600px}</style></head>` +
        `<body><div class="card"><p>Designed, after a line-broken url.</p></div></body></html>`,
    );
    expect(out.prose).toBe(false);
  });

  /**
   * EACH STYLE ELEMENT ENDS AT ITS OWN EOF. A first sheet ending with a backslash inside an
   * unterminated string must not eat the second sheet — the browser tokenizes them separately,
   * and the second sheet's canvas is live in the frame. MUTATION-PROVEN: join the sheets into
   * one classifier input and this goes red.
   */
  it("an unterminated string in one style element does not blank the next element's canvas", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style>.a{content:"abc\\</style><style>.card{max-width:600px}</style></head>` +
        `<body><div class="card"><p>Designed, in the second sheet.</p></div></body></html>`,
    );
    expect(out.prose).toBe(false);
  });

  /**
   * THE SHEETS ARE READ OFF THE SANITIZED DOCUMENT. DOMPurify drops a `<style>` whose text
   * smells of markup (its own mutation-XSS rule), and a canvas living only in that dropped
   * sheet is a canvas the rendered document has not got — classifying from a pre-sanitization
   * snapshot framed a letter for a rule the frame never receives. MUTATION-PROVEN: collect the
   * sheets from the parsed (pre-DOMPurify) document instead and this goes red.
   */
  it("a canvas in a sheet DOMPurify drops does not classify the message designed", async () => {
    const { sanitizeMailHtml } = await mod();
    const out = sanitizeMailHtml(
      `<html><head><style><img>{color:red}.card{max-width:600px}</style></head>` +
        `<body><p>Just a letter; the sheet above never reaches the frame.</p></body></html>`,
    );
    expect(out.prose).toBe(true);

    // And the FIXED-WIDTH spelling of the same trap: a dropped sheet's width:600px must not
    // classify the message rigid either — the rendered document has no canvas to scale.
    // MUTATION-PROVEN: feed isRigidLayout the pre-sanitize aggregate again and this goes red.
    const fixed = sanitizeMailHtml(
      `<html><head><style><img>{color:red}.card{width:600px}</style></head>` +
        `<body><p>Just a letter; the sheet above never reaches the frame.</p></body></html>`,
    );
    expect(fixed.prose).toBe(true);
    expect(fixed.reflow).toBe(true);
  });

  /**
   * THE RIGID SHEET SCAN IS THE SAME RULE-WISE WALK. Four review rounds circled one seam — the
   * fixed-width scan read the sheets as one flat string — and each of these shapes made canvas
   * evidence out of text no browser applies:
   *   · JOINED SHEETS: `.a{` ending one element and `width:600px` opening the next read as a
   *     declaration inside a rule, though neither surviving sheet holds one (the middle,
   *     markup-smelling sheet is DOMPurify's to drop);
   *   · A RULELESS FRAGMENT: `width:600px` alone at a sheet's top level is a prelude a browser
   *     discards, never a declaration — and a per-sheet FLAT read still matches it at offset
   *     zero, so per-sheet alone was not the fix;
   *   · COMMENT TEXT and STRING DATA: live to a flat regex, absent from the browser's model.
   * MUTATION-PROVEN, each shape separately: join the sheets for the rigid scan and the
   * join-kill fixture goes red; swap the walk for the flat `declaresCanvas` per sheet and the
   * other three go red (the fragment via its second sheet, the others via comment/string
   * text).
   */
  it("sheet fragments, joins, comments and strings are not fixed-canvas evidence", async () => {
    const { sanitizeMailHtml } = await mod();
    // The review's own repro: the survivors are `.a{` and `width:600px` — no rule anywhere.
    const joined = sanitizeMailHtml(
      `<html><head><style>.a{</style><style><img>{color:red}</style><style>width:600px</style></head>` +
        `<body><p>Just a letter; no surviving sheet holds a rule.</p></body></html>`,
    );
    expect(joined.prose).toBe(true);
    expect(joined.reflow).toBe(true);

    // The join-kill shape: a RULE that exists only across the join. `.a{` parses as an empty
    // rule at its own EOF and `width:600px}` parses as nothing at all — but joined they read
    // as `.a{width:600px}`, a canvas in a rule neither sheet holds.
    const joinedRule = sanitizeMailHtml(
      `<html><head><style>.a{</style><style>width:600px}</style></head>` +
        `<body><p>Still a letter; the rule only exists across the join.</p></body></html>`,
    );
    expect(joinedRule.prose).toBe(true);
    expect(joinedRule.reflow).toBe(true);

    const commented = sanitizeMailHtml(
      `<html><head><style>/* .card{width:600px} */ p{color:#333}</style></head>` +
        `<body><p>A letter whose sheet reminisces about a canvas.</p></body></html>`,
    );
    expect(commented.prose).toBe(true);
    expect(commented.reflow).toBe(true);

    const quoted = sanitizeMailHtml(
      `<html><head><style>.a{content:"{width:600px}"}</style></head>` +
        `<body><p>A letter whose sheet QUOTES a canvas.</p></body></html>`,
    );
    expect(quoted.prose).toBe(true);
    expect(quoted.reflow).toBe(true);
  });

  /**
   * AND THE RIGID WALK KEEPS THE ELEMENT LOOP'S OWN IMAGE RULE. `<img width="700">` has never
   * been a canvas (see `CANVAS_TAGS` — an oversized picture caps to the column and keeps its
   * aspect ratio), and `img{width:600px}` is the sheet spelling of the same picture-sizing;
   * the flat read called that mail rigid — scale-to-fit for a canvas that is one photo. The
   * second fixture pins the direction that must survive the move: a genuine `.card` rule in
   * the band stays rigid. MUTATION-PROVEN with the same two mutations as above: the flat
   * per-sheet read turns the first fixture red; dropping the walk's rigid arm entirely
   * (`sheetsDeclare(...) === false` for the rigid predicate) turns the second red.
   */
  it("an image width rule is not a canvas; a card width rule still is", async () => {
    const { sanitizeMailHtml } = await mod();
    const photo = sanitizeMailHtml(
      `<html><head><style>img{width:600px}</style></head>` +
        `<body><p>A note with one wide photo.</p></body></html>`,
    );
    expect(photo.prose).toBe(true);
    expect(photo.reflow).toBe(true);

    const card = sanitizeMailHtml(
      `<html><head><style>.card{width:600px}</style></head>` +
        `<body><div class="card"><p>A fixed-canvas template.</p></div></body></html>`,
    );
    expect(card.reflow).toBe(false); // rigid: scale-to-fit, exactly as before the walk moved.
    expect(card.prose).toBe(false);
  });

  /**
   * BLOCKS THE BROWSER RECOVERS ARE CANVASES. Three shapes a naive balanced-brace read drops
   * while the browser applies the width, each verified against the browser by the review that
   * found them: an open block at the sheet's EOF is closed there and applied; an escaped brace
   * is data, not structure; and under CSS nesting the outer rule's own declarations stand even
   * with an inner block beside them. MUTATION-PROVEN one arm each: remove the EOF unwind and
   * the first goes red; read braces without consuming escapes and the second goes red; evaluate
   * only the text since the last boundary (dropping the accumulated declaration text) and the
   * third goes red.
   */
  it("blocks the browser recovers are canvases: EOF close, escaped brace, nesting", async () => {
    const { sanitizeMailHtml } = await mod();
    const eof = sanitizeMailHtml(
      `<html><head><style>.card{width:600px</style></head>` +
        `<body><div class="card"><p>The sheet ends inside the block.</p></div></body></html>`,
    );
    expect(eof.reflow).toBe(false);
    expect(eof.prose).toBe(false);

    const escaped = sanitizeMailHtml(
      `<html><head><style>.card{--x:\\};width:600px}</style></head>` +
        `<body><div class="card"><p>The first close brace is escape data.</p></div></body></html>`,
    );
    expect(escaped.reflow).toBe(false);

    const nested = sanitizeMailHtml(
      `<html><head><style>.card{width:600px;.child{color:red}}</style></head>` +
        `<body><div class="card"><p>The width belongs to the outer rule.</p></div></body></html>`,
    );
    expect(nested.reflow).toBe(false);
  });

  /**
   * DECLARATIONS ARE ATTRIBUTED THE WAY THE BROWSER ATTRIBUTES THEM. Four directions of the
   * same rule, all pinned because each is one mutation away from the walk over- or
   * under-claiming:
   *   · a rule nested under an img rule applies to nothing an image can contain — dead
   *     scope, no canvas;
   *   · a declaration directly inside a top-level at-rule block has no style rule to belong
   *     to, and the browser drops it;
   *   · the same declaration inside an at-rule NESTED IN a style rule belongs to that rule
   *     (CSS conditional nesting) and is a canvas;
   *   · a whole rule inside a media query has always counted, and still does.
   */
  it("declarations are attributed the way the browser attributes them", async () => {
    const { sanitizeMailHtml } = await mod();
    const underImg = sanitizeMailHtml(
      `<html><head><style>img{.card{width:600px}}</style></head>` +
        `<body><p>A letter; the nested rule can never match.</p></body></html>`,
    );
    expect(underImg.prose).toBe(true);
    expect(underImg.reflow).toBe(true);

    const topLevelMedia = sanitizeMailHtml(
      `<html><head><style>@media screen{width:600px}</style></head>` +
        `<body><p>A letter; the declaration has no rule to live in.</p></body></html>`,
    );
    expect(topLevelMedia.prose).toBe(true);
    expect(topLevelMedia.reflow).toBe(true);

    const conditional = sanitizeMailHtml(
      `<html><head><style>.card{@media (min-width:400px){width:600px}}</style></head>` +
        `<body><div class="card"><p>The conditional width is the card's.</p></div></body></html>`,
    );
    expect(conditional.reflow).toBe(false);

    const ruleInMedia = sanitizeMailHtml(
      `<html><head><style>@media screen{.card{width:600px}}</style></head>` +
        `<body><div class="card"><p>A canvas behind a media query is a canvas.</p></div></body></html>`,
    );
    expect(ruleInMedia.reflow).toBe(false);
  });

  /**
   * TWO KINDS OF DEAD, NOT ONE — a review finding, because the walk conflated them. An img
   * rule is real CSS whose declarations are just not canvas evidence, and a rule NESTED in it
   * can step back out beside the image: `img{& + .card{width:600px}}` resolves to
   * `img + .card`, a live sibling canvas the browser applies. An empty selector is a PARSE
   * error — the browser drops the rule whole — so nothing nested inside it comes back, escape
   * or no escape; and an escape whose subject is still the image stays a picture rule.
   * MUTATION-PROVEN one arm each: drop the escape and the first fixture goes red; let the
   * escape resurrect parse-dead scopes and the second goes red.
   */
  it("a nested sibling escape is a canvas; nothing escapes a parse-dead rule", async () => {
    const { sanitizeMailHtml } = await mod();
    const sibling = sanitizeMailHtml(
      `<html><head><style>img{& + .card{width:600px}}</style></head>` +
        `<body><div class="card"><p>The card beside the photo is the canvas.</p></div></body></html>`,
    );
    expect(sibling.reflow).toBe(false);
    expect(sibling.prose).toBe(false);

    const parseDead = sanitizeMailHtml(
      `<html><head><style>{& + .card{width:600px}}</style></head>` +
        `<body><p>A letter; the outer rule never parsed.</p></body></html>`,
    );
    expect(parseDead.prose).toBe(true);
    expect(parseDead.reflow).toBe(true);

    const subjectIsImage = sanitizeMailHtml(
      `<html><head><style>img{.card &{width:600px}}</style></head>` +
        `<body><p>A letter; the escaped rule still styles the image.</p></body></html>`,
    );
    expect(subjectIsImage.prose).toBe(true);
    expect(subjectIsImage.reflow).toBe(true);
  });

  /**
   * THE ESCAPE IS DECIDED BY THE RESOLVED SUBJECT, NOT A SUBSTRING — two review findings in
   * opposite directions at once. `img{+ .card{width:600px}}` is relative nesting: the browser
   * resolves it to `img + .card`, the same live sibling canvas as the explicit-ampersand
   * spelling, so it counts. `img{& + .card &{width:600px}}` resolves its LAST ampersand back
   * to the image — a picture rule after all, whatever the substring suggests — and
   * `img{& + img.hero{width:600px}}` names an image as its subject outright; neither is a
   * canvas. MUTATION-PROVEN one arm each — see the slice note: dropping the implicit-parent
   * resolution turns the first red; dropping the subject checks turns the second and third
   * red; dropping the reachability rule turns the pinned `img{.card{…}}` fixture above red.
   */
  it("the nested escape reads the resolved subject, not the ampersand", async () => {
    const { sanitizeMailHtml } = await mod();
    const relative = sanitizeMailHtml(
      `<html><head><style>img{+ .card{width:600px}}</style></head>` +
        `<body><div class="card"><p>Relative nesting, same sibling canvas.</p></div></body></html>`,
    );
    expect(relative.reflow).toBe(false);
    expect(relative.prose).toBe(false);

    const subjectBackToImage = sanitizeMailHtml(
      `<html><head><style>img{& + .card &{width:600px}}</style></head>` +
        `<body><p>A letter; the trailing ampersand is the image again.</p></body></html>`,
    );
    expect(subjectBackToImage.prose).toBe(true);
    expect(subjectBackToImage.reflow).toBe(true);

    const subjectNamesImage = sanitizeMailHtml(
      `<html><head><style>img{& + img.hero{width:600px}}</style></head>` +
        `<body><p>A letter; the sibling is another picture.</p></body></html>`,
    );
    expect(subjectNamesImage.prose).toBe(true);
    expect(subjectNamesImage.reflow).toBe(true);
  });

  /**
   * A GONE SCOPE STAYS GONE; AN IMAGE SCOPE STAYS ESCAPABLE — a review finding: with a boolean
   * for evidence, a rule nested under an UNMATCHABLE descendant read its parent as "the image"
   * and escaped beside an element that does not exist (`img{.child{+ .card{width:600px}}}`
   * resolves to `img .child + .card` — nothing). The escapable image state is the pinned
   * counterpart: `img{&:hover{& + .card{…}}}` resolves to `img:hover + .card`, a live canvas
   * two levels down. MUTATION-PROVEN: collapse gone into image and the first goes red; treat
   * image as gone and the second goes red.
   */
  it("a gone scope stays gone; an image scope stays escapable", async () => {
    const { sanitizeMailHtml } = await mod();
    const goneStaysGone = sanitizeMailHtml(
      `<html><head><style>img{.child{+ .card{width:600px}}}</style></head>` +
        `<body><p>A letter; the middle rule matches nothing, so nothing beside it exists.</p></body></html>`,
    );
    expect(goneStaysGone.prose).toBe(true);
    expect(goneStaysGone.reflow).toBe(true);

    const imageStaysEscapable = sanitizeMailHtml(
      `<html><head><style>img{&:hover{& + .card{width:600px}}}</style></head>` +
        `<body><div class="card"><p>The card beside the hovered photo is a canvas.</p></div></body></html>`,
    );
    expect(imageStaysEscapable.reflow).toBe(false);
    expect(imageStaysEscapable.prose).toBe(false);
  });

  /**
   * ESCAPES ARE READ AS CSS READS THEM — the same review round's pair: \& is identifier data,
   * not a nesting token, so `.foo\&bar + .card` has an IMPLICIT parent and resolves to the
   * unmatchable `img .foo\&bar + .card`; and `i\6dg` decodes to the `img` tag, so a rule on
   * it is picture sizing wherever it appears — as a relative sibling under an image, and at
   * the top level of the sheet. MUTATION-PROVEN: read the raw ampersand and the first goes
   * red; skip the decode before the image test and the other two go red.
   */
  it("an escaped ampersand is data; an escaped img spelling is an image", async () => {
    const { sanitizeMailHtml } = await mod();
    const escapedAmp = sanitizeMailHtml(
      `<html><head><style>img{.foo\\&bar + .card{width:600px}}</style></head>` +
        `<body><p>A letter; the ampersand is part of a class name.</p></body></html>`,
    );
    expect(escapedAmp.prose).toBe(true);
    expect(escapedAmp.reflow).toBe(true);

    const escapedImgNested = sanitizeMailHtml(
      `<html><head><style>img{+ i\\6dg{width:600px}}</style></head>` +
        `<body><p>A letter; the sibling spells img in escapes.</p></body></html>`,
    );
    expect(escapedImgNested.prose).toBe(true);
    expect(escapedImgNested.reflow).toBe(true);

    const escapedImgTop = sanitizeMailHtml(
      `<html><head><style>i\\6dg{width:600px}</style></head>` +
        `<body><p>A letter; the top-level rule spells img in escapes.</p></body></html>`,
    );
    expect(escapedImgTop.prose).toBe(true);
    expect(escapedImgTop.reflow).toBe(true);

    // And the decode must not CREATE boundaries — the review's counter-case: `.foo\+img` is
    // a class named foo+img on a non-image, and a plain decode hands the image regex a `+`
    // boundary with an img tag behind it. A canvas on that class is a canvas.
    // MUTATION-PROVEN: decode the selector plainly before the image test and this goes red.
    const escapedCombinator = sanitizeMailHtml(
      `<html><head><style>.foo\\+img{width:600px}</style></head>` +
        `<body><div class="foo+img"><p>A fixed canvas on an oddly named class.</p></div></body></html>`,
    );
    expect(escapedCombinator.reflow).toBe(false);
    expect(escapedCombinator.prose).toBe(false);
  });
});

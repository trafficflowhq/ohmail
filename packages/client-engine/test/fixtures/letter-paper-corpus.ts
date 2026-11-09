/**
 * ONE CORPUS OF LETTERS, BOTH READERS, THREE WIDTHS. Each letter pins what the shared gate
 * (`letterPaperOf`, at the frame's own width) must answer at a phone's 343 px, the web column's
 * 572 px and a wide 730 px pane: whether it is light (inverted in a dark theme) and whether the frame
 * paints the letter's own page or its own light sheet. The web and the phone tests both meet these
 * verdicts and judge the frame they draw in a real engine (`letter-paper-judge.ts`), so the pins are
 * the parity check between them. Original fictional copy; nothing here is fetched.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const CORPUS_WIDTHS = [343, 572, 730] as const;
export type CorpusWidth = (typeof CORPUS_WIDTHS)[number];

/** `letter`: the frame paints the letter's own page; `sheet`: its own light sheet. */
export interface CorpusVerdict { light: boolean; page: "letter" | "sheet" }

export interface CorpusLetter {
  name: string;
  html: string;
  /** Words the letter draws, read for their contrast on screen. */
  words: string;
  expect: Record<CorpusWidth, CorpusVerdict>;
  /** The letter names the colour scheme: judged on a dark OS as well. */
  scheme?: true;
  /** Its words read at 4.5:1 or better at every width, in every theme and look, however it read as sent. */
  reads?: true;
}

const every = (light: boolean, page: CorpusVerdict["page"]): Record<CorpusWidth, CorpusVerdict> =>
  ({ 343: { light, page }, 572: { light, page }, 730: { light, page } });
/** One verdict up to the 600-px phone threshold (343, 572), another past it (730). */
const by = (narrow: CorpusVerdict, wide: CorpusVerdict): Record<CorpusWidth, CorpusVerdict> => ({ 343: narrow, 572: narrow, 730: wide });
const DARK_LETTER: CorpusVerdict = { light: false, page: "letter" };
const LIGHT_SHEET: CorpusVerdict = { light: true, page: "sheet" };
const DARK_ON_SHEET: CorpusVerdict = { light: false, page: "sheet" };

const PIXEL = '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="64" height="64" alt="">';

/** White cards with no ink of their own on a page read as dark. */
const CARD = (attrs: string, head = "") =>
  `<html><head>${head}</head><body bgcolor="#000000"><table ${attrs}><tr><td>Your order has shipped</td></tr></table>${PIXEL}</body></html>`;

/** The web's newsletter fixtures, read from the repository root the suite runs in. */
const newsletter = (file: string): string => readFileSync(resolve(process.cwd(), "apps/webapp/test/fixtures/newsletters", file), "utf8");

export const LETTER_PAPER_CORPUS: readonly CorpusLetter[] = [
  // The row this corpus was written for: a dark page said only for phones, naming no ink. Where it is
  // dark and no element paints a background of its own, its words are set in ohmail's light ink.
  {
    name: "a dark page for phones only, no ink",
    html: `<html><head><style>@media only screen and (max-width:600px){body{background-color:#000000 !important}}</style></head><body><p>Wide words</p>${PIXEL}</body></html>`,
    words: "Wide words", expect: by(DARK_LETTER, LIGHT_SHEET), reads: true,
  },
  {
    name: "a 600 px canvas on a page dark for phones only, no ink, no element background",
    html: '<html><head><style>@media only screen and (max-width:600px){body{background-color:#000000 !important}}</style></head><body>'
      + `<table width="600" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="padding:24px;font-size:16px">Canvas words</td></tr></table>${PIXEL}</body></html>`,
    words: "Canvas words", expect: by(DARK_LETTER, LIGHT_SHEET), reads: true,
  },
  {
    // Its twin with a white card: an element paints a background, so the letter is drawn as written.
    name: "a white card on a page dark for phones only, no ink",
    html: '<html><head><style>@media only screen and (max-width:600px){body{background-color:#000000 !important}}</style></head><body>'
      + `<table width="600" bgcolor="#ffffff" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td style="padding:24px;font-size:16px">Card words</td></tr></table>${PIXEL}</body></html>`,
    words: "Card words", expect: by(DARK_LETTER, LIGHT_SHEET), reads: true,
  },
  {
    name: "a light page for phones over a dark body with light ink",
    html: `<html><head><style>@media (max-width:600px){body{background:#ffffff !important}}</style></head><body style="background:#000000;color:#ffffff"><p>Page words</p>${PIXEL}</body></html>`,
    words: "Page words", expect: by(LIGHT_SHEET, DARK_LETTER),
  },
  {
    name: "a dark page with its own ink for phones only",
    html: `<html><head><style>@media (max-width:480px){body{background:#111111 !important;color:#eeeeee !important}}</style></head><body><p>Night words</p>${PIXEL}</body></html>`,
    words: "Night words", expect: { 343: DARK_LETTER, 572: LIGHT_SHEET, 730: LIGHT_SHEET },
  },
  {
    name: "a dark page with its own ink for wide screens only",
    html: `<html><head><style>@media (min-width:700px){body{background:#101010;color:#eeeeee}}</style></head><body><p>Desk words</p>${PIXEL}</body></html>`,
    words: "Desk words", expect: by(LIGHT_SHEET, DARK_LETTER),
  },
  {
    name: "a range query",
    html: `<html><head><style>@media (width <= 600px){body{background:#0b0b0b;color:#eeeeee}}</style></head><body><p>Range words</p>${PIXEL}</body></html>`,
    words: "Range words", expect: by(DARK_LETTER, LIGHT_SHEET),
  },
  {
    name: "an em query",
    html: `<html><head><style>@media screen and (max-width:37.5em){body{background:#0b0b0b;color:#eeeeee}}</style></head><body><p>Em words</p>${PIXEL}</body></html>`,
    words: "Em words", expect: by(DARK_LETTER, LIGHT_SHEET),
  },
  {
    name: "a device-width query",
    html: `<html><head><style>@media only screen and (max-device-width:480px){body{background:#0b0b0b;color:#eeeeee}}</style></head><body><p>Device words</p>${PIXEL}</body></html>`,
    words: "Device words", expect: { 343: DARK_LETTER, 572: LIGHT_SHEET, 730: LIGHT_SHEET },
  },
  {
    name: "an orientation query",
    html: `<html><head><style>@media (orientation:landscape){body{background:#0b0b0b;color:#eeeeee}}</style></head><body><p>Turned words</p>${PIXEL}</body></html>`,
    words: "Turned words", expect: by(LIGHT_SHEET, DARK_LETTER),
  },
  {
    name: "a sheet only for print",
    html: `<html><head><style media="print">body{background:#000000;color:#ffffff}</style><style>@media print{p{color:#ffffff}}</style></head><body><p>Print words</p>${PIXEL}</body></html>`,
    words: "Print words", expect: every(true, "sheet"),
  },
  {
    // Interactive mail for one engine: its panel opens from an input no reader draws, so the fallback must show.
    name: "an interactive panel for one engine over a fallback",
    html: '<html><head><style>.interactive{display:none}@supports (-webkit-overflow-scrolling:touch){.interactive{display:block!important}'
      + '.fallback{display:none!important}}</style></head><body><div class="interactive"><input type="radio" id="t1" name="t"><label for="t1">Tab</label>'
      + `<div class="panel">Sale panel</div></div><div class="fallback"><p>Fallback sale details</p></div>${PIXEL}</body></html>`,
    words: "Fallback sale details", expect: every(true, "sheet"),
  },
  {
    name: "two body rules, the last one painted",
    html: `<html><head><style>body{background:#ffffff} body{background:#0b0b0b;color:#eeeeee}</style></head><body><p>Last rule words</p>${PIXEL}</body></html>`,
    words: "Last rule words", expect: every(false, "letter"),
  },
  {
    name: "a brace in a comment inside a dropped block",
    html: `<html><head><style>@media print{ /* { */ body{background:#ffffff} } body{background:#0b0b0b;color:#eeeeee}</style></head><body><p>Comment words</p>${PIXEL}</body></html>`,
    words: "Comment words", expect: every(false, "letter"),
  },
  {
    name: "a receipt darkened only in its dark-scheme block",
    html: '<html><head><style>@media (prefers-color-scheme: dark){ .logo{display:none} body{background-color:#1e1e1e !important} }</style></head>'
      + `<body><table><tr><td style="color:#333333">Your receipt</td></tr></table>${PIXEL}</body></html>`,
    words: "Your receipt", expect: every(true, "sheet"), scheme: true,
  },
  {
    name: "a dark-adapted letter with two logos",
    html: '<html><head><style>.logo-dark{display:none}@media (prefers-color-scheme: dark){ body,.bg{background-color:#1e1e1e !important} .tx{color:#f2f2f2 !important}'
      + ' .logo-light{display:none !important} .logo-dark{display:block !important} }</style></head><body><table class="bg"><tr><td>'
      + '<img class="logo-light" alt="Brand" src="data:image/png;base64,AAAA"><img class="logo-dark" alt="Brand" src="data:image/png;base64,AAAA"></td></tr>'
      + '<tr><td class="tx" style="color:#333333">Adapted receipt</td></tr></table></body></html>',
    words: "Adapted receipt", expect: every(true, "sheet"), scheme: true,
  },
  {
    name: "a dark newsletter whose page rule sits in a screen block",
    html: `<html><head><style>@media screen{ .a{margin:0} body{background:#000000;color:#ffffff} }</style></head><body><p>Dark newsletter words</p>${PIXEL}</body></html>`,
    words: "Dark newsletter words", expect: every(false, "letter"),
  },
  ...["", "@media screen", "@supports (display:grid)"].map((wrap): CorpusLetter => ({
    name: `a nightly edition${wrap ? ` in ${wrap}` : ""}`,
    html: `<html><head><style>${wrap ? `${wrap}{ body{background:#0b0b0b} }` : "body{background:#0b0b0b}"}</style></head><body><p style="color:#eeeeee">Night edition</p>${PIXEL}</body></html>`,
    words: "Night edition", expect: every(false, "letter"),
  })),
  {
    name: "a dark body without ink",
    html: `<html><body bgcolor="#111111"><p style="color:#eeeeee">Dark by design</p>${PIXEL}</body></html>`,
    words: "Dark by design", expect: every(false, "letter"),
  },
  ...[
    ["in its style", '<body style="background-color:#121212;color:#f5f5f5">'],
    ["as attributes", '<body bgcolor="#000000" text="#ffffff">'],
    ["as spaced rgb() colours", '<body style="background-color: rgb(18, 18, 18); color: rgb(245, 245, 245)">'],
  ].map(([how, body]): CorpusLetter => ({
    name: `a dark body naming its light ink ${how}`,
    html: `<html>${body}<p>Dark page, light words</p>${PIXEL}</body></html>`,
    words: "Dark page, light words", expect: every(false, "letter"),
  })),
  {
    name: "a light ink and no page",
    html: `<html><body text="#ffffff"><p>White ink, no page</p>${PIXEL}</body></html>`,
    words: "White ink, no page", expect: every(true, "sheet"),
  },
  {
    name: "a mid-grey page with white ink",
    html: `<html><body bgcolor="#767676" text="#ffffff"><p>Grey page, white words</p>${PIXEL}</body></html>`,
    words: "Grey page, white words", expect: every(true, "sheet"),
  },
  {
    name: "a head rule paints white over a black body's white ink",
    html: `<html><head><style>body{background:#ffffff}</style></head><body style="background:#000;color:#fff"><p>Sheet page words</p>${PIXEL}</body></html>`,
    words: "Sheet page words", expect: every(true, "sheet"),
  },
  {
    name: "a sheet before the body paints black under a white body",
    html: `<style>body{background:#000000;color:#eeeeee}</style><body style="background:#fff;color:#111"><p>Early sheet words</p>${PIXEL}</body>`,
    words: "Early sheet words", expect: every(false, "letter"),
  },
  {
    name: "a dark header bar over unpainted text",
    html: '<html><body><table width="100%"><tr><td bgcolor="#111111" style="color:#ffffff">Brand</td></tr>'
      + `<tr><td style="color:#333333">Your parcel has shipped.</td></tr></table>${PIXEL}</body></html>`,
    words: "Your parcel has shipped.", expect: every(false, "sheet"),
  },
  {
    name: "a dark wrapper holding the whole letter",
    html: `<html><body><div style="background-color:#1a1a2e;color:#eeeeee"><p>Wrapped dark words</p>${PIXEL}</div></body></html>`,
    words: "Wrapped dark words", expect: every(false, "letter"),
  },
  {
    name: "a dark newsletter behind a hidden preheader",
    html: '<html><body><div style="display:none">Preheader words</div><table bgcolor="#111111" width="100%"><tr><td style="color:#eeeeee">'
      + `News of the week</td></tr></table>${PIXEL}</body></html>`,
    words: "News of the week", expect: every(false, "letter"),
  },
  {
    name: "a reply quoting a dark letter, folded",
    html: `<html><body><p style="color:#333333">Thanks, see below.</p>${PIXEL}<div><div>On Thu, 22 Oct 2026 at 09:14, A wrote:</div><blockquote type="cite">`
      + '<style>body{background:#000000}</style><p style="color:#ffffff">Old dark letter</p></blockquote></div></body></html>',
    words: "Thanks, see below.", expect: every(true, "sheet"),
  },
  ...[
    ["a dark header table", `<html><body><table bgcolor="#222222"><tr><td style="color:#ffffff">Brand</td></tr></table><table bgcolor="#ffffff"><tr><td>Your order has shipped</td></tr></table>${PIXEL}</body></html>`, DARK_ON_SHEET],
    ["a dark header div", `<html><body><div style="background:#222222;color:#ffffff">Brand</div><div style="background:#ffffff">Your order has shipped</div>${PIXEL}</body></html>`, DARK_ON_SHEET],
    ["bgcolor", CARD('bgcolor="#ffffff"'), DARK_LETTER],
    ["an rgb() style with spaces", CARD('style="background-color: rgb(255, 255, 255)"'), DARK_LETTER],
    ["a class rule", CARD('class="card"', "<style>.card{background-color: rgb(255, 255, 255)}</style>"), DARK_LETTER],
    ["an hsl() style", CARD('style="background-color: hsl(0, 0%, 100%)"'), DARK_LETTER],
    ["a gradient", CARD('style="background: linear-gradient(to bottom, #ffffff, #ffffff)"'), DARK_LETTER],
    ["a variable", CARD('class="card"', "<style>.card{--card: #ffffff; background-color: var(--card)}</style>"), DARK_LETTER],
  ].map(([how, html, v]): CorpusLetter => ({
    name: `a white card under ${how as string}`, html: html as string, words: "Your order has shipped", expect: every((v as CorpusVerdict).light, (v as CorpusVerdict).page),
  })),
  ...([
    ["announcement.html", "Marrowdene Hall reopens", every(false, "letter")],
    ["callout-button.html", "Reserve a seat", every(true, "sheet")],
    ["container-rows.html", "Quintavell Bulletin", every(true, "sheet")],
    ["digest-list.html", "Kestrelby Digest — Tuesday edition", every(true, "sheet")],
    ["fluid-single-column.html", "Vellumbrook Weekly", every(true, "sheet")],
    ["hero-section.html", "Larkmoor Dispatch", every(false, "sheet")],
    ["hybrid-ghost-table.html", "Thimblecote Review", every(true, "sheet")],
    ["main-and-sidebar.html", "In this issue", every(true, "sheet")],
    ["receipt-invoice.html", "Brindlecove — Order 4821", every(true, "sheet")],
    ["responsive-two-column.html", "Ottermere Field Notes", every(true, "sheet")],
    ["three-up-gallery.html", "Pellcombe Gallery", every(true, "sheet")],
    ["two-column-cards.html", "lo6word lo7word", every(true, "sheet")],
  ] as const).map(([file, words, expect]): CorpusLetter => ({ name: `the ${file} newsletter`, html: newsletter(file), words, expect })),
];

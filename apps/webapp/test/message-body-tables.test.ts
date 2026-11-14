/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ── A NUMBER IN A TABLE IS NEVER BROKEN IN HALF ─────────────────────────────────────────
 *
 * Walked on a live install at 390×844: a four-column invoice table was laid out at the column's
 * 290px and its cells were force-broken ANYWHERE — an amount was split across two lines,
 * which is a different amount to anyone skimming a bill. The mechanism is one property doing
 * two opposite jobs:
 *
 *   `overflow-wrap: anywhere` reduces an element's MIN-CONTENT width to almost nothing. For
 *   running text that is the fix this codebase wants everywhere — one long tracked link stops
 *   forcing a whole letter wide. For a table of VALUES it is the defect: auto table layout
 *   sizes columns from min-content, so `anywhere` lets the table crush to any width and then
 *   pays for it by splitting the values themselves.
 *
 *   `overflow-wrap: break-word` wraps between words exactly like `anywhere` but keeps the
 *   min-content width of the longest unbreakable token — so a column can never get narrower
 *   than the longest amount, and the token therefore never splits. What it costs is width: a table of
 *   values may now be wider than the column, and it must SCROLL there instead of clipping.
 *
 * Both surfaces that draw tables get the same treatment:
 *
 *   NATIVE (`BodyText`'s TableNode → `.msg-table`): the scrolling container already exists
 *   (`.msg-table-wrap`, built for exactly this) but never engaged, because `anywhere` —
 *   inherited from `.msg-body`/`.pm-body` — made every table fit by force. The cells now
 *   declare `break-word`, which is what lets a wide table reach the wrapper's scrollbar.
 *
 *   FRAMED (the reflow class): CSS inside the frame cannot tell an invoice from the layout
 *   grid a newsletter is built out of — and a layout cell holding a long tracked link NEEDS
 *   `anywhere`, or the link's min-content forces the whole letter into a sideways scroll.
 *   So the sanitizer's post-pass classifies: a table shaped like DATA (headers, a visible
 *   border grid, or a multi-column grid of short text-only cells) is stamped
 *   `data-ohmail-datatable`, an ATTRIBUTE — the only kind of write the post-pass is allowed
 *   (see `sanitizeMailHtml`'s header for why that line exists) — and the reflow sheet scopes
 *   `break-word` to stamped tables only. A sender's own copy of the stamp cannot survive:
 *   `ALLOW_DATA_ATTR: false` strips it, the same single gate every `data-ohmail-*` marker
 *   relies on.
 *
 * Every assertion below was watched go red against the pre-fix implementation (the fix
 * landed after this file) — the classifier absent, the reflow sheet carrying no cell rule,
 * `.msg-table` cells inheriting `anywhere`.
 */

const SHEET_PATH = "apps/webapp/app/letter-body/message-body.css";
const SHEET = readFileSync(resolve(process.cwd(), SHEET_PATH), "utf8");
const bare = (css: string): string => css.replace(/\/\*[\s\S]*?\*\//g, "");
const MSG_CSS = bare(SHEET);

/** The declarations of one rule, by exact selector (comments already stripped). */
const ruleOf = (css: string, selector: string): string => {
  const re = new RegExp(`(^|[{}])\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^{}]*)\\}`);
  const m = re.exec(css);
  return m ? m[2]! : "";
};
const decl = (rule: string, prop: string): string | null => {
  const m = new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule);
  return m ? m[1]!.trim() : null;
};

type Mod = typeof import("../app/letter-body/MessageBody.js");
const mod = async (): Promise<Mod> => import("../app/letter-body/MessageBody.js");

/** The sanitized document, as a queryable element — what the frame will render. */
async function sanitizedDom(html: string): Promise<HTMLElement> {
  const { sanitizeMailHtml } = await mod();
  const out = sanitizeMailHtml(html);
  const el = document.createElement("div");
  el.innerHTML = out.html;
  return el;
}

/** The invoice shape from the live walk: four columns, a header row, currency values. */
const INVOICE =
  `<p>Your receipt.</p>` +
  `<table><tr><th>Item</th><th>Qty</th><th>Unit</th><th>Amount</th></tr>` +
  `<tr><td>Pro plan (annual)</td><td>1</td><td>3,528.00</td><td>3,528.00</td></tr>` +
  `<tr><td>Support</td><td>2</td><td>72.50</td><td>145.00</td></tr></table>`;

/** The same grid without headers, declaring the border grid bulk invoices actually use. */
const BORDERED =
  `<table border="1"><tr><td>Total</td><td>145.00</td></tr>` +
  `<tr><td>VAT 8.1%</td><td>11.75</td></tr></table>`;

/** No th, no border — but a multi-column grid of short, text-only cells is a grid of values. */
const PLAIN_GRID =
  `<table><tr><td>Betrag</td><td>145.00 CHF</td></tr>` +
  `<tr><td>Datum</td><td>12.08.2026</td></tr></table>`;

/** The single-column wrapper every table-based letter is built from. Layout, not data. */
const WRAPPER =
  `<table width="100%"><tr><td>` +
  `<p>Guten Tag, vielen Dank für Ihre Nachricht.</p>` +
  `<a href="https://tracking.example.invalid/ls/click?upn=u001.Vq7pZr2LkTw3nHqQyZ2fVbNqAq9zXcMw7RtLpKdGhY4vTnBxSeUiOl">Ansehen</a>` +
  `</td></tr></table>`;

/** Two columns, but the cells hold BLOCKS — a two-column footer is layout too. */
const TWO_COL_LAYOUT =
  `<table><tr><td><div><p>Left column prose, long enough to be a letter's own paragraph.</p></div></td>` +
  `<td><div><img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="40" height="40"></div></td></tr></table>`;

describe("the framed path stamps tables that hold data, and only those", () => {
  it("an invoice with a header row is stamped", async () => {
    const dom = await sanitizedDom(INVOICE);
    const table = dom.querySelector("table");
    expect(table, "the fixture lost its table in sanitizing — nothing below tests anything").not.toBeNull();
    expect(table!.hasAttribute("data-ohmail-datatable"),
      "the invoice was not classified as data — its currency can be split mid-number again").toBe(true);
  });

  it("a bordered grid and a plain label/value grid are stamped without a header row", async () => {
    for (const [name, html] of [["bordered", BORDERED], ["plain grid", PLAIN_GRID]] as const) {
      const table = (await sanitizedDom(html)).querySelector("table")!;
      expect(table.hasAttribute("data-ohmail-datatable"),
        `${name}: a value grid without <th> went unstamped — its numbers can split`).toBe(true);
    }
  });

  it("layout tables are NOT stamped — their cells keep `anywhere`, which is what keeps a letter narrow", async () => {
    for (const [name, html] of [["wrapper", WRAPPER], ["two-column blocks", TWO_COL_LAYOUT]] as const) {
      const table = (await sanitizedDom(html)).querySelector("table")!;
      expect(table.hasAttribute("data-ohmail-datatable"),
        `${name}: a layout table was stamped as data — one long link now scrolls the whole letter sideways`,
      ).toBe(false);
    }
  });

  it("a table that NESTS another table is layout, whatever else it looks like", async () => {
    const dom = await sanitizedDom(
      `<table><tr><td>a</td><td>${PLAIN_GRID}</td></tr><tr><td>1.00</td><td>2.00</td></tr></table>`,
    );
    const outer = dom.querySelector("table")!;
    expect(outer.hasAttribute("data-ohmail-datatable"), "a nesting wrapper was stamped as data").toBe(false);
    // …while the inner grid still earns its own stamp: the classification is per table.
    const inner = outer.querySelector("table table") ?? dom.querySelectorAll("table")[1]!;
    expect(inner.hasAttribute("data-ohmail-datatable"), "the nested value grid lost its stamp").toBe(true);
  });

  it("a sender's own stamp does not survive — same gate as every data-ohmail-* marker", async () => {
    // ALLOW_DATA_ATTR: false strips the forged attribute; the classifier then re-decides from
    // the table's own shape, and a wrapper full of blocks is not data however it is labelled.
    const dom = await sanitizedDom(
      `<table data-ohmail-datatable="1"><tr><td><div><p>layout prose in a block</p></div>` +
        `<a href="https://tracking.example.invalid/ls/click?upn=u001.Vq7pZr2LkTw3nHqQyZ2fVbNqAq9zXcMw7RtLpKdGhY4vTnBx">x</a></td></tr></table>`,
    );
    expect(dom.querySelector("table")!.hasAttribute("data-ohmail-datatable"),
      "a sender labelled a layout table as data and the label survived").toBe(false);
  });
});

describe("the reflow sheet gives stamped cells their min-content back", () => {
  it("the dormant rules carry break-word for data cells, scoped to the stamp", async () => {
    const { buildMailDocument } = await mod();
    const doc = buildMailDocument("<p>x</p>");
    // The cell rule: break-word, not anywhere — min-content is the whole point (see header).
    expect(doc).toContain(
      ":root[data-ohmail-reflow] table[data-ohmail-datatable] td,:root[data-ohmail-reflow] table[data-ohmail-datatable] th{overflow-wrap:break-word !important}",
    );
    // And the general reflow ground keeps `anywhere` — the letter case must stay fixed.
    expect(doc).toContain("overflow-wrap:anywhere");
  });
});

describe("the native table keeps its values whole and scrolls instead", () => {
  it(".msg-table cells declare break-word — the declaration, because the harm is inherited", () => {
    // `anywhere` arrives by INHERITANCE (`.msg-body`/`.pm-body` declare it for running text),
    // so only an explicit declaration on the cells can refuse it. jsdom computes inheritance
    // but performs no layout, so the declaration is the thing under test.
    const rule = ruleOf(MSG_CSS, ".msg-table th,\n.msg-table td") || ruleOf(MSG_CSS, ".msg-table th, .msg-table td");
    expect(rule, "the .msg-table cell rule is gone from message-body.css").not.toBe("");
    expect(decl(rule, "overflow-wrap"),
      "table cells inherit `anywhere` — currency splits mid-number the moment a table is narrow",
    ).toBe("break-word");
  });

  it("the wrapper that absorbs the regained width still scrolls", () => {
    // break-word makes a crowded table WIDER than its column; `.msg-table-wrap` is what turns
    // that width into a scrollbar instead of a clipped edge. Deleting it now costs more than
    // it did when tables could crush.
    expect(decl(ruleOf(MSG_CSS, ".msg-table-wrap"), "overflow-x")).toBe("auto");
    expect(decl(ruleOf(MSG_CSS, ".msg-table-wrap"), "max-width")).toBe("100%");
  });
});

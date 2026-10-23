import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * NO SHELL QUERY MAY LAND IN A HIDDEN PILE (`visible-dom.ts`). News and Receipts stay mounted while
 * the reader is elsewhere, so a document-wide query for a row, a card, a split or a verb strip can
 * match one nobody can see — the `d` confirm once clicked the first delete strip in the document.
 * Every such query goes through `queryVisible`; a query scoped by a view's own class
 * (`.view-reads …`) names one pile and stays as it is. This census refuses a new raw one.
 */
const APP = join(__dirname, "..", "app");
/* A literal that opens on a pile-naming class. A template that opens on an interpolation names its
   own scope (a view's class, or a scope its caller queries through `queryVisible`). */
const PILE_NAMING = /^\s*["'`](?:\.view(?![-\w])|\.row\b|\.scast\b|\.split\b|\.list-col\b|\.abar-)/;
const RAW_QUERY = /document\.querySelector(?:All)?(?:<[^>]*>)?\(\s*([^\n]*)/g;

/** Why this raw query's selector may name a pile, or null. A selector that is not a literal (a
    parameter, a `??` default, a field) is refused unless it is a file constant naming no pile. */
function refusal(src: string, arg: string): string | null {
  if (/^\s*["'`]/.test(arg)) return PILE_NAMING.test(arg) ? "names a pile" : null;
  const name = /^\s*([A-Za-z_$][\w$]*)\s*\)/.exec(arg)?.[1];
  const value = name ? new RegExp(`^const ${name} = (["'\`][^\\n]*);`, "m").exec(src)?.[1] : undefined;
  if (value === undefined) return "selector is not a literal";
  return PILE_NAMING.test(value) ? "names a pile" : null;
}

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sources(p));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

describe("the shell's document queries skip hidden piles", () => {
  it("no raw document query names a row, a card, a split or a strip", () => {
    const raw: string[] = [];
    for (const file of sources(APP)) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(RAW_QUERY)) {
        const why = refusal(src, m[1]!);
        if (why) raw.push(`${relative(APP, file)}: ${m[0].trim()} (${why})`);
      }
    }
    expect(raw, "query these through queryVisible (shell/visible-dom.ts)").toEqual([]);
  });

  it("the census bites: the queries it moved are still spelled the way it reads", () => {
    /* Positive control on the reader itself, so a rewrite that stops matching cannot pass empty. */
    const sample = 'document.querySelector<HTMLButtonElement>(".abar-delete .abar-danger")?.click();';
    const m = /document\.querySelector(?:All)?(?:<[^>]*>)?\(([^\n]*)/.exec(sample);
    expect(m && PILE_NAMING.test(m[1]!)).toBe(true);
    expect(PILE_NAMING.test('`${scope} .row[data-id="x"]`')).toBe(false);
    expect(PILE_NAMING.test('`.view .row[data-id="x"]`')).toBe(true);
    expect(PILE_NAMING.test('".view-reads .scast"')).toBe(false);
    /* A selector handed in (zone-nav's `?? ".view .row.sel"` default) is read as not a literal. */
    const src = 'const RAIL = ".rail";\nconst ROW = ".row.sel";\n';
    expect(refusal(src, "selector);")).toBe("selector is not a literal");
    expect(refusal(src, "r.selector);")).toBe("selector is not a literal");
    expect(refusal(src, "ROW);")).toBe("names a pile");
    expect(refusal(src, "RAIL);")).toBeNull();
    for (const [file, needle] of [
      ["shell/shell-keys.tsx", 'queryVisible<HTMLButtonElement>(".abar-delete .abar-danger")'],
      ["shell/message-verbs.ts", 'queryVisible<HTMLButtonElement>(".abar-delete .abar-danger")'],
      ["shell/cursor-placer.ts", "queryVisible<HTMLElement>(\n    `${host.scope} .row"],
      ["shell/message-verbs.ts", "return queryVisible<HTMLElement>(`${scope} .row"],
      ["shell/zone-nav.tsx", "const sel = queryVisible<HTMLElement>(selector);"],
      ["shell/zone-nav.tsx", "if (tryFocus(queryVisible<HTMLElement>(sel))) return;"],
    ] as const) {
      expect(readFileSync(join(APP, file), "utf8"), `${file} no longer asks queryVisible`).toContain(needle);
    }
  });
});

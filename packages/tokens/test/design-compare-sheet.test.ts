/**
 * scripts/compare-sheet.mjs: the comparison of what ships with a design sheet. The sheet is not in
 * this repository, so these cases hand it small sheets, or what ships as if it were the sheet. What
 * they hold is that the script cannot come out green by having nothing to read, and that a value the
 * sheet carries only on its stylesheets is read there.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { compare, declarations, main, readDeclared, same, toTsv } from "../scripts/compare-sheet.mjs";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const json = (rel: string) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const text = (rel: string) => readFileSync(join(root, rel), "utf8");
const shippedCss = () => ({
  "tokens.css": text("packages/tokens/src/design/tokens.css"),
  "motion.css": text("packages/tokens/src/design/motion.css"),
});
const shipped = () => ({
  product: json("packages/tokens/src/design/tokens.json"),
  productIcons: json("packages/ui/src/icons/icons.json"),
  productCss: Object.values(shippedCss()).flatMap(declarations),
  declared: readDeclared(text("packages/tokens/source/declared.tsv")),
});
const said = (rows: { where: string; token: string; kind: string }[]) => rows.map((r) => `${r.where} ${r.token} ${r.kind}`);

/** A product of two tokens and one icon, and the sheet that says the same. */
const small = () => {
  const perFace = <T,>(v: T) => ({ paper: structuredClone(v), ohmarchy: structuredClone(v) });
  const face = { light: { ink: "#12100E", row: "calc(72px + 16px)", "ico-w": "1.8", "ico-cap": "round", "ico-join": "round" } };
  const stroke = { width: 1.8, cap: "round", join: "round" };
  return {
    product: {
      design: {
        faces: perFace(face), calendar: { ...perFace({}), ring: [], accents: {} }, accents: {}, readSquare: {},
        avatarHues: [8, 40], tagHues: { red: 25 },
      },
      motion: { "m-time": "1", slick: { "d-move": "calc(260ms * 1)" }, reduced: {}, calendar: { slick: {}, reduced: {} } },
    },
    productIcons: { grid: 24, sizes: [16], icons: { send: { words: "send", svg: '<path d="M 4 4h16"/>' } } },
    productCss: declarations(
      ':root{\n  --ink: #12100E;\n  --row: calc(72px + 16px);\n  --flush: calc(var(--a) + var(--b));\n}\n' +
        ':root{\n  --d-move: calc(260ms * var(--m-time));\n}\n:root[data-rm="1"],\n[data-rm="1"]{\n  --d-move: 0ms;\n}\n' +
        '@media (prefers-reduced-motion: reduce){\n:root{\n  --d-move: 0ms;\n}\n}\n',
    ),
    sheetCss: {
      "tokens.css": declarations(":root{ --ink:#12100e; --row:calc(72px + 16px); /* a note; with: marks */ }\n:root{--flush:calc(var(--a) + var(--b))}"),
      "motion.css": declarations('.fs{--d-move:calc(260ms * var(--m-time))}\n.fs[data-rm="1"],.fs [data-rm="1"]{\n  --d-move:0ms;\n}'),
    },
    sheet: {
      faces: perFace({ light: { ...face.light, ink: "#12100e", row: { value: "88px", as: "calc(var(--a) + var(--b))" }, "ico-w": 1.8 } }),
      calendar: { tokens: perFace({}), ring: [], accents: {}, motion: { slick: {} } }, accents: {},
      avatarHues: [8, 40], tagHues: { red: 25 },
      motion: { slick: { tokens: { "m-time": "1", "d-move": { value: "260ms", as: "calc(260ms * var(--m-time))" } } } },
    },
    sheetIcons: { grid: 24, sizes: [16], stroke: perFace(stroke), icons: [{ name: "send", svg: '<path class="i" d="M4 4h16"/>' }] },
    declared: readDeclared(""),
  };
};

describe("one value against the sheet's", () => {
  it.each([
    ["#F8431A", "#f8431a"],
    ["0px", "0"],
    ["0.5", ".5"],
    ["calc(72px + 16px)", "88px"],
    ["calc(260ms * 1)", { value: "260ms", as: "calc(260ms * var(--m-time))" }],
    ["calc(8px + 4px)", { value: "12px", as: "calc(8px + 4px)" }],
    ["color-mix(in srgb,#205EA6 12%,#FFFCF0)", "#e4e9e7"],
  ])("%s is %j", (product, sheet) => expect(same(product, sheet)).toBe(true));

  it.each([
    ["#F8431A", "#f8431b"],
    ["16px", "16"],
    ["calc(72px + 16px)", "89px"],
    ["calc(8px + 4ms)", "12px"],
  ])("%s is not %j", (product, sheet) => expect(same(product, sheet)).toBe(false));
});

describe("the comparison", () => {
  it("is green on a sheet that says what ships", () => {
    const { rows, open, compared } = compare(small());
    expect(open).toEqual([]);
    expect(compared).toBeGreaterThan(15);
    expect(rows).toEqual([]);
  });

  it("reports a value that differs, a token only one side has, and an icon redrawn", () => {
    const inputs = small();
    inputs.sheet.faces.paper.light.ink = "#000000";
    (inputs.sheet.faces.ohmarchy.light as Record<string, unknown>).fresh = "1px";
    inputs.sheet.motion.slick.tokens["d-move"] = { value: "300ms", as: "calc(300ms * var(--m-time))" };
    inputs.sheetIcons.icons[0].svg = '<path d="M4 4h12"/>';
    inputs.sheetIcons.icons.push({ name: "reply", svg: '<path d="M1 1"/>' });
    expect(said(compare(inputs).open)).toEqual([
      "faces.paper.light ink differs",
      "faces.ohmarchy.light fresh sheet-only",
      "motion.slick d-move differs",
      "icons send differs",
      "icons reply sheet-only",
    ]);
  });

  it("reads on the sheet's stylesheets what its data does not carry: a reduced time, a token beside the components", () => {
    const wrong = small();
    wrong.productCss = wrong.productCss.map((d) => (d.token === "d-move" && d.value === "0ms" ? { ...d, value: "260ms" } : d));
    expect(said(compare(wrong).open)).toEqual([
      'css :root[data-rm="1"] d-move differs',
      'css [data-rm="1"] d-move differs',
      'css :root[data-rm="1"] d-move differs',
    ]);
    const moved = small();
    moved.sheetCss["tokens.css"] = declarations(":root{--ink:#12100e;--row:calc(72px + 16px);--flush:calc(var(--a) + var(--a));--fresh:1px}");
    const rows = compare(moved).open;
    expect(said(rows)).toEqual(["css :root flush differs", "css :root fresh sheet-only"]);
    expect([rows[0].product, rows[0].sheet]).toEqual(["calc(var(--a) + var(--b))", "calc(var(--a) + var(--a)) (tokens.css)"]);
  });

  it("reports a rule only one side has, and a token of the product no sheet of either kind names", () => {
    const inputs = small();
    inputs.sheetCss["tokens.css"].push(...declarations('.fs[data-motion="snap"],.fs [data-motion="snap"]{--d-move:60ms}'));
    inputs.productCss.push(...declarations(':root[data-device="watch"]{\n  --row: 40px;\n}\n:root{\n  --own: 1px;\n}\n@media print{\n:root{\n  --ink: #000000;\n}\n}'));
    (inputs.product.design.faces.paper.light as Record<string, string>).own = "1px";
    (inputs.product.design.faces.paper.light as Record<string, string>).flush = "calc(8px + 8px)";
    expect(said(compare(inputs).open)).toEqual([
      "faces.paper.light own product-only",
      "css :root own product-only",
      'css :root[data-device="watch"] * product-only',
      "css @media print :root * product-only",
      'css :root[data-motion="snap"] * sheet-only',
      'css [data-motion="snap"] * sheet-only',
    ]);
  });

  it("reads every shipped rule, the twins of the dark and the reduced blocks with them", () => {
    /* What ships, as a sheet would write it: a sheet has no second copy of a block for an unstamped page. */
    const itself = () =>
      Object.fromEntries(Object.entries(shippedCss()).map(([name, css]) => [name, declarations(css).filter((d) => d.media === "")]));
    const css = (inputs: Parameters<typeof compare>[0]) => compare(inputs).rows.filter((r) => r.where.startsWith("css "));
    expect(css({ ...shipped(), declared: [], sheet: {}, sheetIcons: {}, sheetCss: itself() })).toEqual([]);
    /* The faults a hand could slip into the source, each in a block the sheet's data does not carry. */
    const planted = shipped();
    const plant = (token: string, from: string, to: string) => {
      const hits = planted.productCss.filter((d) => d.token === token && d.value === from);
      expect(hits.length, token).toBeGreaterThan(0);
      for (const d of hits) d.value = to;
    };
    plant("d-move", "0ms", "260ms");
    plant("d-span", "150ms", "900ms");
    plant("flush", "calc(var(--s1) + var(--s1) + var(--s2))", "calc(var(--s8) + var(--s8))");
    plant("on-row-open", "var(--on-solid)", "var(--hot)");
    expect(said(css({ ...planted, declared: [], sheet: {}, sheetIcons: {}, sheetCss: itself() })).sort()).toEqual([
      'css :root[data-device="phone"] flush differs',
      'css :root[data-product="cal"] on-row-open differs',
      'css :root[data-rm="1"] d-move differs',
      'css :root[data-rm="1"] d-move differs',
      'css :root[data-rm="1"] d-span differs',
      'css :root[data-rm="1"] d-span differs',
      'css [data-rm="1"] d-move differs',
      'css [data-rm="1"] d-span differs',
    ]);
  });

  it("is never green on an empty sheet: every shipped value is reported", () => {
    const { open, rows } = compare({ ...shipped(), sheet: {}, sheetIcons: {}, sheetCss: { "tokens.css": [], "motion.css": [] } });
    const { design } = shipped().product;
    expect(open.length).toBeGreaterThan(Object.keys(design.faces.paper.light).length);
    expect(open.some((r) => r.where === "faces.paper.light" && r.token === "ink" && r.kind === "product-only")).toBe(true);
    expect(said(open)).toEqual(expect.arrayContaining(["css :root * product-only", 'css :root[data-rm="1"] * product-only', 'css :root[data-product="cal"] * product-only']));
    expect(open.filter((r) => r.where === "icons" && r.kind === "product-only")).toHaveLength(82);
    expect(toTsv(rows).split("\n")[0]).toBe("where\ttoken\tkind\tproduct\tsheet\tdeclared");
  });

  it("reports a part of the sheet it does not read, and a declared row that matched nothing", () => {
    const inputs = small();
    (inputs.sheet as Record<string, unknown>).spacing = {};
    inputs.declared.push(...readDeclared("faces.paper.light\tgone\tproduct-only\tleft over"));
    expect(said(compare(inputs).open)).toEqual(["sheet spacing sheet-only", "faces.paper.light gone stale-declared"]);
  });

  it("takes a declared difference with its reason, and refuses a row without one", () => {
    const inputs = small();
    inputs.sheet.faces.paper.light.ink = "#000000";
    inputs.declared.push(...readDeclared("# a comment\nfaces.paper.*\tink\tdiffers\tthe sheet moved on"));
    const { open, rows } = compare(inputs);
    expect(open).toEqual([]);
    expect(rows.find((r) => r.token === "ink")?.declared).toBe("the sheet moved on");
    expect(() => readDeclared("faces.paper.light\tink\tdiffers\t")).toThrow(/a reason/);
  });

  it("takes a declared whole part for that part alone, never for a token of a part both have", () => {
    const inputs = small();
    (inputs.sheet as Record<string, unknown>).accents = { plum: {} };
    (inputs.sheet.faces.ohmarchy.light as Record<string, unknown>).fresh = "1px";
    inputs.declared.push(...readDeclared(["accents.*", "readSquare.*", "faces.*"].map((where) => `${where}\t*\tsheet-only\tleft out`).join("\n")));
    expect(said(compare(inputs).open)).toEqual(["faces.ohmarchy.light fresh sheet-only", "faces.* * stale-declared"]);
  });
});

describe("a stylesheet's declarations", () => {
  it("are its custom properties, one per selector, with the sheet's two ways of naming the root read as one", () => {
    const css = `/* a note { with: braces; } */
      .fs,.fs [data-motion="slick"]{ --d-in:calc(220ms * var(--m-time)); --e-out:cubic-bezier(.16,1,.3,1); color:red }
      :root [data-rm="1"]{--wash:color-mix(in srgb,var(--hot) 12%,var(--sheet));--f:"A B",serif}
      .fs .sel path{fill:var(--row-open)}
      @keyframes spin{ from{ --turn:0 } to{ --turn:1 } }
      @media (prefers-color-scheme: dark){ :root:not([data-scheme]){ --ink: #F6F1E9; } }`;
    expect(declarations(css)).toEqual([
      { media: "", selector: ":root", token: "d-in", value: "calc(220ms * var(--m-time))" },
      { media: "", selector: '[data-motion="slick"]', token: "d-in", value: "calc(220ms * var(--m-time))" },
      { media: "", selector: ":root", token: "e-out", value: "cubic-bezier(.16,1,.3,1)" },
      { media: "", selector: '[data-motion="slick"]', token: "e-out", value: "cubic-bezier(.16,1,.3,1)" },
      { media: "", selector: '[data-rm="1"]', token: "wash", value: "color-mix(in srgb,var(--hot) 12%,var(--sheet))" },
      { media: "", selector: '[data-rm="1"]', token: "f", value: '"A B",serif' },
      { media: "@media (prefers-color-scheme: dark)", selector: ":root:not([data-scheme])", token: "ink", value: "#F6F1E9" },
    ]);
  });
});

describe("the command", () => {
  const quiet = () => vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const dir = () => mkdtempSync(join(tmpdir(), "compare-sheet-"));

  it("has no default sheet", () => {
    const said = quiet();
    expect(main(["--product", root])).toBe(2);
    expect(String(said.mock.calls[0][0])).toContain("--sheet <dir> is required");
    said.mockRestore();
  });

  it("exits 2 on a sheet without its icons or without a stylesheet, and on one it cannot read", () => {
    const said = quiet();
    const sheet = dir();
    writeFileSync(join(sheet, "tokens.json"), "{}");
    expect(main(["--sheet", sheet, "--product", root])).toBe(2);
    expect(String(said.mock.calls[0][0])).toContain("missing:");
    writeFileSync(join(sheet, "icons.json"), "{ not json");
    expect(main(["--sheet", sheet, "--product", root])).toBe(2);
    expect(String(said.mock.calls[1][0])).toContain("unreadable:");
    writeFileSync(join(sheet, "icons.json"), "{}");
    writeFileSync(join(sheet, "tokens.css"), "");
    expect(main(["--sheet", sheet, "--product", root])).toBe(2);
    expect(String(said.mock.calls[2][0])).toMatch(/missing: .*motion\.css/);
    said.mockRestore();
  });

  it("exits 1 on a sheet that differs and writes every finding to --out", () => {
    const said = quiet();
    const sheet = dir();
    mkdirSync(sheet, { recursive: true });
    for (const name of ["tokens.json", "icons.json"]) writeFileSync(join(sheet, name), "{}");
    for (const name of ["tokens.css", "motion.css"]) writeFileSync(join(sheet, name), "");
    const out = join(sheet, "findings.tsv");
    expect(main(["--sheet", sheet, "--product", root, "--out", out])).toBe(1);
    expect(readFileSync(out, "utf8").split("\n").length).toBeGreaterThan(500);
    said.mockRestore();
  });
});

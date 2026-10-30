import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * HTMLPARSER2'S OPEN-ELEMENT STACK IS LINEAR IN EVERY COPY A READER LOADS (`patches/htmlparser2@*.patch`).
 *
 * Upstream keeps the stack innermost-first with `unshift` and looks closes up with `indexOf`, so a deep
 * nest, closes that match nothing, a `<form>` over a deep stack and a deep `<svg>`/`<math>` nest each cost
 * quadratic time: seconds of the shared worker for one crafted letter at mailparser's 1 MiB html cap. Each
 * copy is loaded the way its reader loads it: ours (core, the phone), sanitize-html's, and the 10.1.0 copy
 * under mailparser's html-to-text in both of its builds. The reference is upstream's own Parser, recovered
 * by applying the shipped patch in reverse beside the installed Tokenizer.
 */
const ROOT = resolve(__dirname, "..");
const SCRATCH = mkdtempSync(join(tmpdir(), "ohmail-htmlparser2-"));
afterAll(() => rmSync(SCRATCH, { recursive: true, force: true }));

type Parser = new (cbs: Record<string, unknown>, options?: Record<string, unknown>) => {
  write(chunk: string): void;
  end(chunk?: string): void;
  reset(): void;
  startIndex: number;
  endIndex: number;
};
type Copy = { label: string; version: string; dir: string; build: "esm" | "cjs"; entry: string };

/** The package directory holding a resolved htmlparser2 entry. */
function packageDir(entry: string): string {
  for (let d = dirname(entry); d !== dirname(d); d = dirname(d)) {
    const pj = join(d, "package.json");
    if (existsSync(pj) && JSON.parse(readFileSync(pj, "utf8")).name === "htmlparser2") return d;
  }
  throw new Error(`no htmlparser2 package above ${entry}`);
}
const from = (path: string) => createRequire(path);
const coreReq = from(join(ROOT, "packages", "core", "package.json"));
const htmlToTextReq = from(from(coreReq.resolve("mailparser")).resolve("html-to-text"));
const sanitizeReq = from(coreReq.resolve("sanitize-html"));

function copies(): Copy[] {
  const ours = coreReq.resolve("htmlparser2");
  const theirs = sanitizeReq.resolve("htmlparser2");
  const cjs = htmlToTextReq.resolve("htmlparser2");
  const nested = packageDir(cjs);
  const esm = join(nested, JSON.parse(readFileSync(join(nested, "package.json"), "utf8")).exports["."].import.default);
  const version = (entry: string) => JSON.parse(readFileSync(join(packageDir(entry), "package.json"), "utf8")).version as string;
  return [
    { label: "ours", version: version(ours), dir: packageDir(ours), build: "esm", entry: ours },
    { label: "sanitize-html's", version: version(theirs), dir: packageDir(theirs), build: "esm", entry: theirs },
    { label: "html-to-text's (CommonJS)", version: version(cjs), dir: nested, build: "cjs", entry: cjs },
    { label: "html-to-text's (ESM)", version: version(cjs), dir: nested, build: "esm", entry: esm },
  ];
}

async function load(file: string, build: "esm" | "cjs"): Promise<Parser> {
  const mod = build === "cjs" ? createRequire(file)(file) : await import(/* @vite-ignore */ pathToFileURL(file).href);
  return mod.Parser as Parser;
}

/** The patch's Parser file for one build of a copy. */
const patchFile = (c: Copy) => join(ROOT, "patches", `htmlparser2@${c.version}.patch`);
const parserPath = (c: Copy) =>
  [...readFileSync(patchFile(c), "utf8").matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!)
    .find((p) => c.version.startsWith("12.") || p.includes(c.build === "cjs" ? "/commonjs/" : "/esm/"))!;

let seq = 0;
/** Upstream's Parser for this copy: the shipped patch reversed in a scratch copy, its imports pointed at the installed modules. */
async function upstream(c: Copy): Promise<Parser> {
  const base = join(SCRATCH, `u${++seq}`);
  const text = readFileSync(patchFile(c), "utf8");
  const paths = [...text.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);
  for (const p of paths) cpSync(join(c.dir, p), join(base, p));
  const back = spawnSync("git", ["-c", "core.autocrlf=false", "apply", "--reverse", "-"], {
    cwd: base, input: text, encoding: "utf8", env: { ...process.env, GIT_CEILING_DIRECTORIES: dirname(base) },
  });
  expect(back.status, `the installed ${c.label} copy does not carry the shipped patch: ${back.stderr}`).toBe(0);
  const rel = parserPath(c);
  const installed = join(c.dir, rel);
  const target = (spec: string) => {
    if (spec.startsWith("./")) return join(dirname(installed), spec);
    const r = from(installed).resolve(spec);
    // The ESM build's own entities: the same package's import condition.
    if (c.build === "cjs" || !r.includes("/commonjs/")) return r;
    const esmTwin = r.replace("/commonjs/", "/esm/");
    expect(existsSync(esmTwin), esmTwin).toBe(true);
    return esmTwin;
  };
  const src = readFileSync(join(base, rel), "utf8")
    .replace(/require\("([^"]+)"\)/g, (_m, s: string) => `require(${JSON.stringify(target(s))})`)
    .replace(/from "([^"]+)"/g, (_m, s: string) => `from ${JSON.stringify(pathToFileURL(target(s)).href)}`);
  const out = join(base, rel.replace(/\.js$/, c.build === "cjs" ? ".ref.cjs" : ".ref.mjs"));
  writeFileSync(out, src);
  return load(out, c.build);
}

const SHAPES: Record<string, (n: number) => string> = {
  deepB: (n) => "<p>" + "x<b>".repeat(n),
  deepDiv: (n) => "<div>".repeat(n),
  unmatchedCloses: (n) => "<b>".repeat(n) + "</i>".repeat(n),
  matchedCloses: (n) => "<b>".repeat(n) + "</b>".repeat(n),
  formsOverDeep: (n) => "<div>".repeat(n) + "<form></form>".repeat(n),
  svgIntegrationAdjust: (n) => "<svg><foreignObject>" + "<div>".repeat(n) + "<clippath>".repeat(n),
  deepSvg: (n) => "<svg>".repeat(n),
  deepMi: (n) => "<math>" + "<mi>".repeat(n),
};

let loaded: Array<Copy & { patched: Parser }> = [];
beforeAll(async () => {
  loaded = await Promise.all(copies().map(async (c) => ({ ...c, patched: await load(c.entry, c.build) })));
});

describe("every copy a reader loads", () => {
  it("is 12.0.0 for ours and sanitize-html's, 10.1.0 for html-to-text's, each carrying the linear stack", () => {
    expect(loaded.map((c) => [c.label, c.version])).toEqual([
      ["ours", "12.0.0"], ["sanitize-html's", "12.0.0"], ["html-to-text's (CommonJS)", "10.1.0"], ["html-to-text's (ESM)", "10.1.0"],
    ]);
    for (const c of loaded) {
      expect((c.patched as unknown as { stackOrder?: string }).stackOrder, c.label).toBe("ohmail-htmlparser2-linear-stack");
    }
  });
});

describe("the parser's time is linear in nesting (best of 3, 200 ms a shape; upstream takes 0.5 to 2.8 s)", () => {
  const SIZES: Array<[string, number, boolean]> = [
    ["deepB", 120_000, false], ["deepDiv", 100_000, false], ["unmatchedCloses", 50_000, false], ["matchedCloses", 150_000, false],
    ["deepSvg", 100_000, false], ["deepMi", 100_000, false],
    // 10.1.0 has no `includes` lookup on these two, so they are cheap there.
    ["formsOverDeep", 30_000, true], ["svgIntegrationAdjust", 40_000, true],
  ];
  it.each(SIZES)("%s at %i", (name, n, only12) => {
    const html = SHAPES[name]!(n);
    const timed = new Set<string>();
    const slow: string[] = [];
    for (const c of loaded) {
      const key = `${c.dir}:${c.build}`;
      if ((only12 && !c.version.startsWith("12.")) || timed.has(key)) continue;
      timed.add(key);
      let best = Infinity;
      let closes = 0;
      for (let run = 0; run < 3 && best >= 200; run++) {
        closes = 0;
        const t = performance.now();
        const p = new c.patched({ onclosetag: () => void (closes += 1) });
        p.end(html);
        best = Math.min(best, performance.now() - t);
      }
      expect(closes, `${c.label}: every open element closes`).toBeGreaterThan(0);
      if (best >= 200) slow.push(`${c.label}: ${Math.round(best)} ms`);
    }
    expect(timed.size).toBeGreaterThan(0);
    expect(slow).toEqual([]);
  }, 120_000);
});

describe("the event stream is upstream's, byte for byte", () => {
  const OPTIONS = [{}, { xmlMode: true }, { recognizeSelfClosing: true }, { lowerCaseTags: false }, { xmlMode: true, lowerCaseTags: true }, { recognizeCDATA: true }];
  const KINDS = ["onopentagname", "onopentag", "onattribute", "onclosetag", "ontext", "oncomment", "oncommentend", "oncdatastart",
    "oncdataend", "onprocessinginstruction", "onend", "onerror"];
  /** Every event with the parser's indices, the html written whole or in the given chunks, then a reset and a second document. */
  function events(P: Parser, html: string, options: Record<string, unknown>, chunks: number[] | null): string {
    const out: unknown[] = [];
    let p!: InstanceType<Parser>;
    const cbs: Record<string, unknown> = {};
    for (const k of KINDS) {
      cbs[k] = (...args: unknown[]) => out.push([k, p.startIndex, p.endIndex, ...args.map((a) => (a && typeof a === "object" ? JSON.stringify(a) : a))]);
    }
    p = new P(cbs, options);
    try {
      if (chunks) {
        let i = 0;
        for (const n of chunks) { p.write(html.slice(i, i + n)); i += n; }
        p.end();
      } else p.end(html);
    } catch (e) {
      out.push(["threw", String((e as Error).message)]);
    }
    try {
      p.reset();
      p.end(html.slice(0, Math.floor(html.length / 2)));
    } catch (e) {
      out.push(["threw after reset", String((e as Error).message)]);
    }
    return JSON.stringify(out);
  }

  let seed = 0x5eed;
  const rnd = () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const pick = <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)]!;
  const TAGS = ["p", "P", "b", "i", "div", "li", "ul", "ol", "a", "form", "FORM", "input", "select", "option", "optgroup", "button",
    "textarea", "table", "tr", "td", "th", "tbody", "thead", "tfoot", "dd", "dt", "rt", "rp", "h1", "h2", "br", "img", "image", "hr",
    "body", "head", "script", "svg", "SVG", "math", "mi", "mo", "mtext", "annotation-xml", "foreignObject", "foreignobject", "desc",
    "title", "clippath", "clipPath", "lineargradient", "textPath", "pre", "section", "span", "font", "x-y", "a:b"];
  const piece = () => {
    const r = rnd();
    const t = pick(TAGS);
    if (r < 0.38) return `<${t}${rnd() < 0.2 ? ` id="${Math.floor(rnd() * 9)}" class=c` : ""}>`;
    if (r < 0.66) return `</${t}>`;
    if (r < 0.72) return `<${t}/>`;
    if (r < 0.86) return pick(["x", " ", "text", "&amp;", "&lt;", "\n"]);
    if (r < 0.9) return "<![CDATA[c]]>";
    if (r < 0.93) return "<!-- m -->";
    if (r < 0.95) return "<!doctype html>";
    if (r < 0.97) return "<?xml v?>";
    return pick(["<", ">", "</", "<x", "'", '"']);
  };
  const chunking = (length: number) => {
    const out: number[] = [];
    for (let i = 0; i < length; ) { const n = 1 + Math.floor(rnd() * 7); out.push(n); i += n; }
    return out;
  };
  const fixtures = [join(ROOT, "apps", "webapp", "test", "fixtures", "newsletters"), join(ROOT, "packages", "client-engine", "test", "fixtures", "quoted-history")]
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".html")).map((f) => readFileSync(join(d, f), "utf8")));

  it.each([0, 1, 2, 3])("copy %i: the depth shapes, the html fixtures and 2,000 random documents under six option sets", async (i) => {
    const c = loaded[i]!;
    const reference = await upstream(c);
    const docs: string[] = [];
    for (const n of [0, 1, 2, 3, 7, 50]) docs.push(...Object.values(SHAPES).map((s) => s(n)));
    expect(fixtures.length).toBeGreaterThan(20);
    docs.push(...fixtures);
    for (let k = 0; k < 2_000; k++) {
      let html = "";
      for (let j = 0, len = 1 + Math.floor(rnd() * (k % 50 === 0 ? 600 : 40)); j < len; j++) html += piece();
      docs.push(html);
    }
    let compared = 0;
    for (const [d, html] of docs.entries()) {
      for (const options of d < 48 + fixtures.length ? OPTIONS : [pick(OPTIONS)]) {
        const cut = chunking(html.length);
        for (const chunks of [null, cut]) {
          const want = events(reference, html, options, chunks);
          expect(events(c.patched, html, options, chunks), `${c.label} ${JSON.stringify(options)} ${chunks ? "chunked" : "whole"}: ${html.slice(0, 200)}`).toBe(want);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(4_000);
  }, 120_000);
});

/* Upstream's control for the time guard above: the reference is quadratic where the patched copy is not. */
describe("the reference is upstream's quadratic parser", () => {
  it("takes more than 4 times the patched copy's time on 30,000 closes that match nothing", async () => {
    const c = loaded[0]!;
    const reference = await upstream(c);
    const html = SHAPES.unmatchedCloses!(30_000);
    const time = (P: Parser) => { const t = performance.now(); new P({}).end(html); return performance.now() - t; };
    const ref = Math.min(time(reference), time(reference));
    const ours = Math.min(time(c.patched), time(c.patched), time(c.patched));
    expect(ref).toBeGreaterThan(ours * 4);
  }, 60_000);
});


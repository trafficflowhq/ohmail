/**
 * THE PHONE ENGINE CARRIES NO SOURCE COMMENTS — only esbuild's module markers, its pure
 * annotations and the license block.
 *
 * esbuild keeps leading comments on class members, object properties, array elements and call
 * arguments, under any `legalComments` setting. In this artifact that was 5,798 comments, about
 * 913 KB, counted against the size ceiling and read by nothing. The build strips them after esbuild
 * and proves the code unchanged (`stripSourceComments`, `assertSameCode`). This census reads every
 * comment acorn finds in the built artifact and lists, by module, any that is not one of the three
 * kinds the artifact keeps on purpose.
 */
import { parse } from "acorn";
import { beforeAll, describe, expect, it } from "vitest";

import { createRequire } from "node:module";

import { assertSameCode, buildPhoneEngine, stripSourceComments } from "../scripts/bundle-engine.mjs";

const esbuild = createRequire(import.meta.url)("esbuild");
const strip = stripSourceComments as (text: string) => string;
const same = assertSameCode as (before: string, after: string, esbuild: unknown) => Promise<void>;

type Metafile = { outputs: Record<string, { inputs: Record<string, { bytesInOutput: number }> }> };
type Census = { listed: string[]; markers: Set<string>; pure: number; license: number; lines: number };

const PURE = " @__PURE__ ";
const LICENSE = "! Bundled license information:";

/** Every input the build put bytes of into the artifact: what a module marker may name. */
function inputsWithBytes(metafile: Metafile): Set<string> {
  const out = new Set<string>();
  for (const output of Object.values(metafile.outputs)) {
    for (const [path, input] of Object.entries(output.inputs)) if (input.bytesInOutput > 0) out.add(path);
  }
  return out;
}

function census(text: string, withBytes: Set<string>): Census {
  const comments: { block: boolean; value: string; start: number; end: number }[] = [];
  parse(text, {
    ecmaVersion: "latest", sourceType: "script", allowHashBang: true,
    onComment: (block, value, start, end) => { comments.push({ block, value, start, end }); },
  });
  const out: Census = { listed: [], markers: new Set(), pure: 0, license: 0, lines: text.split("\n").length };
  let module = "(prelude)";
  for (const c of comments) {
    const aloneOnLine = (c.start === 0 || text[c.start - 1] === "\n") && (c.end === text.length || text[c.end] === "\n");
    if (!c.block && aloneOnLine && withBytes.has(c.value.slice(1))) {
      module = c.value.slice(1);
      out.markers.add(module);
    } else if (c.block && c.value === PURE) {
      out.pure++;
    } else if (c.block && c.value.startsWith(LICENSE) && text.slice(c.end).trim() === "") {
      out.license++;
    } else {
      out.listed.push(`${module}: ${text.slice(c.start, Math.min(c.end, c.start + 80))}`);
    }
  }
  return out;
}

let text = "";
let withBytes = new Set<string>();

beforeAll(async () => {
  const built = (await buildPhoneEngine({ write: false })) as { text: string; metafile: Metafile };
  text = built.text;
  withBytes = inputsWithBytes(built.metafile);
}, 180_000);

describe("the phone engine artifact", () => {
  it("carries no comment but module markers, pure annotations and the license block", () => {
    const found = census(text, withBytes);
    expect(found.lines, "a real artifact, not an empty one").toBeGreaterThan(10_000);
    expect([...found.markers].sort(), "one marker per input with bytes").toEqual([...withBytes].sort());
    expect(found.pure, "pure annotations kept").toBeGreaterThan(0);
    expect(found.license, "the license block, once").toBe(1);
    expect({ count: found.listed.length, first: found.listed.slice(0, 10) }).toEqual({ count: 0, first: [] });
  });

  it("lists a comment planted before a property, under its module", () => {
    const m = /\n[ ]+(?=env: \{\},)/.exec(text);
    expect(m, "the process stand-in's first member").not.toBeNull();
    const at = m!.index + m![0].length;
    const planted = `${text.slice(0, at)}/** x */ ${text.slice(at)}`;
    const owner = [...text.slice(0, at).matchAll(/^\/\/ (.+)$/gm)].at(-1)![1]!;
    const found = census(planted, withBytes);
    expect(found.listed.filter((l) => l.includes("/** x */"))).toEqual([`${owner}: /** x */`]);
  });

  it("lists a column-0 comment that names no input", () => {
    const at = text.indexOf("\n// apps/") + 1;
    const planted = `${text.slice(0, at)}// not/an/input.ts\n${text.slice(at)}`;
    const found = census(planted, withBytes);
    expect(found.listed.filter((l) => l.includes("not/an/input.ts"))).toHaveLength(1);
  });
});

describe("stripSourceComments", () => {
  it("leaves comment-like text in strings, templates and regexes alone", () => {
    const src = [
      'const a = "/* not a comment */ // nor this";',
      "const b = `x ${`/* y */ ${'// z'}`} /* w */`;",
      "const c = /\\/\\*/.test(a) && /https?:\\/\\//.test(b); // gone",
      "",
    ].join("\n");
    expect(strip(src)).toBe([
      'const a = "/* not a comment */ // nor this";',
      "const b = `x ${`/* y */ ${'// z'}`} /* w */`;",
      "const c = /\\/\\*/.test(a) && /https?:\\/\\//.test(b);",
      "",
    ].join("\n"));
  });

  it("keeps tokens apart and line breaks where ASI reads them", () => {
    const run = (body: string) => new Function(`return ${strip(`(() => {\n${body}\n})()`)}`)();
    expect(strip("b -/* c */-d")).toBe("b - -d");
    expect(run("const b = 5, d = 2;\nreturn b -/* c */-d;")).toBe(7);
    expect(run("return /*\n*/ 1;")).toBeUndefined();
  });

  it("drops a comment alone on its lines with them, and a trailing one with its blanks", () => {
    expect(strip("a();\n  /**\n   * doc\n   */\n  b(); // x\nc();\n")).toBe("a();\n  b();\nc();\n");
  });

  it("keeps module markers, pure annotations and the license block", () => {
    const src = "// apps/x.ts\nvar a = /* @__PURE__ */ f(/* arg */ 1);\n/*! Bundled license information:\n\nx:\n  (*! y *)\n*/\n";
    expect(strip(src)).toBe("// apps/x.ts\nvar a = /* @__PURE__ */ f(  1);\n/*! Bundled license information:\n\nx:\n  (*! y *)\n*/\n");
  });
});

describe("assertSameCode", () => {
  const before = "// apps/x.ts\nvar a = /* @__PURE__ */ f(/* arg */ \"s\");\n/*! Bundled license information:\n*/\n";

  it("admits a pair that differs only in comments", async () => {
    await expect(same(before, strip(before), esbuild)).resolves.toBeUndefined();
  });

  it.each([
    ["a changed string literal", before.replace('"s"', '"t"'), /code/],
    ["a dropped module marker", before.replace("// apps/x.ts\n", ""), /module markers/],
    ["a dropped pure annotation", before.replace("/* @__PURE__ */ ", ""), /pure annotations/],
    ["a dropped license block", before.slice(0, before.indexOf("/*!")), /license block/],
  ])("refuses %s", async (_, after, reason) => {
    await expect(same(before, after, esbuild)).rejects.toThrow(reason);
  });
});

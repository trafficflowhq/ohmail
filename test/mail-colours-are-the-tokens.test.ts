import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAIL_COLOURS, MAIL_MEASURES } from "../packages/services/src/mail/frame.js";

/**
 * A mail cannot read a stylesheet, so the mail frame carries the paper face's colours and measures as
 * literals. They are the tokens' values: where the kit and the tokens differ, the tokens win.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tokens = JSON.parse(fs.readFileSync(path.join(ROOT, "packages/tokens/src/design/tokens.json"), "utf8")) as {
  design: { faces: { paper: Record<"light" | "dark", Record<string, string>> } };
};
const paper = tokens.design.faces.paper;

describe("the mail's colours and measures are the tokens'", () => {
  for (const scheme of ["light", "dark"] as const) {
    it(`${scheme}: every colour equals the paper face's token of the same name`, () => {
      const names = Object.keys(MAIL_COLOURS[scheme]);
      expect(names.sort()).toEqual(["ground", "hot", "ink", "ink2", "on-solid", "sheet", "soft-sheet", "solid"]);
      for (const name of names) {
        expect(MAIL_COLOURS[scheme][name as keyof (typeof MAIL_COLOURS)[typeof scheme]], `${scheme}.${name}`)
          .toBe(paper[scheme][name]);
      }
    });
  }

  it("every measure equals the paper face's token, in px", () => {
    for (const [name, px] of Object.entries(MAIL_MEASURES)) {
      expect(`${px}px`, name).toBe(paper.light[name]);
    }
  });
});

/**
 * The server's own pages (the self-host proxy's 421, the Umbrel launcher's starting page and its setup
 * steps) carry the same paper colours as literals: light ones inline, dark ones in their one dark block.
 */
describe("the server pages' colours are the tokens'", () => {
  const PAGE_FILES = ["deploy/selfhost/proxy/Caddyfile", "deploy/umbrel/ohmail/data/caddy/etc/Caddyfile", "deploy/umbrel/ohmail/hooks/pre-start"];
  const NAMES = ["ground", "sheet", "ink", "ink2", "soft-sheet"];
  const HEX = /#[0-9A-Fa-f]{6}\b/g;
  const DARK = /@media \(prefers-color-scheme:dark\)\{([\s\S]*?)\n\s*\}\n/g;

  for (const rel of PAGE_FILES) {
    it(`${rel}: every light colour and every colour of its dark block is the paper face's`, () => {
      const text = fs.readFileSync(path.join(ROOT, rel), "utf8");
      const dark = [...text.matchAll(DARK)].flatMap((m) => m[1]!.match(HEX) ?? []);
      const light = text.replace(DARK, "").match(HEX) ?? [];
      expect(dark.length, "no dark block read").toBeGreaterThan(0);
      expect(light.length, "no light colour read").toBeGreaterThan(0);
      const of = (scheme: "light" | "dark") => new Set(NAMES.map((n) => paper[scheme][n]!.toUpperCase()));
      for (const c of light) expect(of("light").has(c.toUpperCase()), `light ${c}`).toBe(true);
      for (const c of dark) expect(of("dark").has(c.toUpperCase()), `dark ${c}`).toBe(true);
    });
  }
});

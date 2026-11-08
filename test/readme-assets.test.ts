import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { OHMAIL_FOLDERS } from "@trafficflow/core/adapters/imap-types";
import { META_FOLDER } from "@trafficflow/core/adapters/organizer-lease";
import { canonicalizeProfilePayload } from "@trafficflow/core/adapters/organizer-profile";
import { publicPath, ROOT } from "./support/public-root.mjs";

/**
 * ══ THE TWO README FACES SHOW FILES THAT EXIST, AND ONLY THOSE ═══════════════════════════════════
 *
 * README.md (paper) and README.ohmarchy.md (its twin in the ohmarchy face) show screenshots and
 * recordings from `docs/assets/readme/`. A `<picture>` whose file is missing fails nothing: GitHub
 * draws the alt text, and a stranger finds the hole on the project's front page.
 *
 * So: every path either page names exists, is a real file of its kind and not a stub; every file in
 * the directory is named by one of the pages (no orphans); the twin is README.md with the face
 * swapped and nothing else, so the two pages cannot drift apart; and the ohmarchy light captures
 * show the unread wash the apps ship.
 */
const at = (rel: string): string => publicPath(rel);
const DIR = "docs/assets/readme";

const paper = readFileSync(at("README.md"), "utf8");
const twin = readFileSync(at("README.ohmarchy.md"), "utf8");

const named = (md: string): string[] =>
  [...md.matchAll(/(?:src|srcset|href)="(docs\/assets\/readme\/[^"]+)"/g)].map((m) => m[1]!);

/** README.ohmarchy.md back into README.md: the switch's lit half, the twin link, the tile paths. */
function toPaper(md: string): string {
  return md
    .replace(/toggle-paper-off-(light|dark)\.svg/g, "toggle-paper-on-$1.svg")
    .replace(/toggle-ohmarchy-on-(light|dark)\.svg/g, "toggle-ohmarchy-off-$1.svg")
    .replace('alt="paper: open this README in the paper face"', 'alt="paper, the face shown"')
    .replace('alt="ohmarchy, the face shown"', 'alt="ohmarchy: open this README in the ohmarchy face"')
    .replace("[twin in the other face](README.md)", "[twin in the other face](README.ohmarchy.md)")
    .replace(/(docs\/assets\/readme\/)ohmarchy-([a-z0-9-]+\.(?:gif|webp))/g, "$1$2");
}

const headings = (md: string): string[] => md.split("\n").filter((l) => /^#{2,3} /.test(l));

describe("the README's two faces", () => {
  const all = [...new Set([...named(paper), ...named(twin)])];

  it("name their pictures — and the list is not empty", () => {
    // Anti-vacuity: a regex that stopped matching would make every assertion below pass.
    expect(named(paper).length).toBeGreaterThanOrEqual(30);
    expect(named(twin).length).toBe(named(paper).length);
    expect(named(twin).some((p) => p.includes("/ohmarchy-")), "the twin shows no ohmarchy tile").toBe(true);
  });

  it("every named file exists, is the kind its name says, and is not a stub", () => {
    for (const rel of all) {
      const file = at(rel);
      expect(existsSync(file), `${rel} is missing`).toBe(true);
      const size = statSync(file).size;
      expect(size, `${rel} is over 5 MB`).toBeLessThan(5 * 1024 * 1024);
      const head = readFileSync(file).subarray(0, 12).toString("latin1");
      if (rel.endsWith(".svg")) {
        expect(head, `${rel} is not an SVG`).toMatch(/^(<svg|<\?xml)/);
        continue;
      }
      expect(size, `${rel} is a stub`).toBeGreaterThan(10_000);
      if (rel.endsWith(".gif")) expect(head, `${rel} is not a GIF`).toMatch(/^GIF8[79]a/);
      else if (rel.endsWith(".webp")) expect(head, `${rel} is not a WebP`).toMatch(/^RIFF.{4}WEBP$/s);
      else throw new Error(`${rel}: an image kind this test does not know`);
    }
  });

  it("every file in the directory is named by one of the pages — no orphans", () => {
    for (const f of readdirSync(at(DIR))) {
      expect(all, `${DIR}/${f} is in the tree but neither page shows it`).toContain(`${DIR}/${f}`);
    }
  });

  it("the twin is README.md in the other face, and nothing else", () => {
    expect(twin).not.toBe(paper);
    expect(toPaper(twin)).toBe(paper);
    expect(headings(twin)).toEqual(headings(paper));
    expect(headings(paper).length).toBeGreaterThanOrEqual(10);
  });

  it("the ohmarchy light captures show the unread wash the apps ship", () => {
    // The ohmarchy light pictures were taken with the unread panel at #ece9de. Should the token move
    // again, the pictures are re-shot with it; until then this says they are stale.
    const css = readFileSync(join(ROOT, "packages/tokens/src/ohmarchy.css"), "utf8");
    const phone = readFileSync(join(ROOT, "apps/mobile/src/theme/ohmarchy.ts"), "utf8");
    expect(css).toMatch(/--unread-wash:\s*#ece9de;/i);
    expect(phone).toMatch(/unreadWash:\s*"#ece9de"/i);
    expect(css).not.toMatch(/#e7f1ff/i);
    expect(phone).not.toMatch(/#e7f1ff/i);
  });
});

describe("the face switch", () => {
  // GitHub has no image maps, so each half is its own link and picture, and the two must touch.
  const block = (md: string): string => /<sub>Choose a face<\/sub><br\/>\s*([\s\S]*?)\s*<\/p>/.exec(md)?.[1] ?? "";
  const halves = (md: string) =>
    [...block(md).matchAll(/<a\s+href="([^"]+)">([\s\S]*?)<\/a>/g)].map((m) => {
      const light = /<img [^>]*src="(docs\/assets\/readme\/toggle-([a-z]+)-(on|off)-light\.svg)"[^>]*width="(\d+)" height="40"/.exec(m[2]!);
      const dark = /srcset="docs\/assets\/readme\/(toggle-[a-z]+-(?:on|off))-dark\.svg"/.exec(m[2]!)?.[1];
      return { href: m[1], face: light?.[2], state: light?.[3], dark, width: Number(light?.[4]), file: light?.[1] ?? "" };
    });
  const svgBox = (rel: string, theme: "light" | "dark") => {
    const svg = readFileSync(at(rel.replace("-light.svg", `-${theme}.svg`)), "utf8");
    const box = /viewBox="(\d+) 0 (\d+) 40" width="(\d+)" height="40"/.exec(svg);
    return { x: Number(box?.[1]), w: Number(box?.[2]), width: Number(box?.[3]) };
  };

  for (const [page, md, shown] of [["README.md", paper, "paper"], ["README.ohmarchy.md", twin, "ohmarchy"]] as const) {
    it(`${page}: paper opens README.md, ohmarchy opens README.ohmarchy.md, the shown face is the lit half`, () => {
      const [left, right, ...rest] = halves(md);
      expect(rest).toEqual([]);
      const lit = (face: string) => (face === shown ? "on" : "off");
      expect(left).toMatchObject({ href: "README.md", face: "paper", state: lit("paper"), dark: `toggle-paper-${lit("paper")}` });
      expect(right).toMatchObject({ href: "README.ohmarchy.md", face: "ohmarchy", state: lit("ohmarchy"), dark: `toggle-ohmarchy-${lit("ohmarchy")}` });
    });

    it(`${page}: the halves touch — no text between or inside the links, and their pictures tile the 178 px switch`, () => {
      expect(block(md).replace(/<[^>]*>/g, "")).toBe("");
      const [left, right] = halves(md);
      for (const theme of ["light", "dark"] as const) {
        const [l, r] = [svgBox(left!.file, theme), svgBox(right!.file, theme)];
        expect([l.x, l.w, l.width], `${left!.file} ${theme}`).toEqual([0, left!.width, left!.width]);
        expect([r.x, r.w, r.width], `${right!.file} ${theme}`).toEqual([l.w, right!.width, right!.width]);
        expect(l.w + r.w).toBe(178);
      }
    });
  }
});

describe("what ohmail.app links to and quotes from the README", () => {
  // The landing links #how-ohmail-organizes-inside-your-mailbox and quotes the folder tree, the
  // self-host heading and the Microsoft footnote; a rewrite that drops one leaves it citing nothing.
  const fence = /The folders ohmail creates are a small, frozen set:\s*```\n([\s\S]*?)```/.exec(paper)?.[1] ?? "";
  const names = fence.split("\n").map((l) => l.replace(/^[├└│─\s]+/, "").split(/\s{2,}/)[0]!).filter(Boolean);

  it("the organizing section draws exactly the folders ohmail creates, and none called Spam", () => {
    expect(headings(paper)).toContain("## How ohmail organizes inside your mailbox");
    expect(names.slice(0, 4)).toEqual(["Inbox", "Junk", "Sent", "ohmail/"]);
    const own = [...OHMAIL_FOLDERS, META_FOLDER].map((f) => f.replace(/^ohmail\//, ""));
    expect(names.slice(4).sort()).toEqual([...own].sort());
    expect(names.some((n) => /^spam$/i.test(n))).toBe(false);
  });

  it("the self-host heading and the Microsoft footnote the landing quotes", () => {
    expect(headings(paper)).toContain("### Run the server yourself");
    const note = paper.split("\n").find((l) => l.startsWith("\\* Microsoft 365")) ?? "";
    expect(note).toContain("Microsoft sign-in on ohmail Cloud and on self-hosted servers set up for it");
  });
});

describe("what the docs say travels and what is not in this repository", () => {
  const flat = (rel: string): string => readFileSync(at(rel), "utf8").replace(/\s+/g, " ");
  // Each field the organizer profile carries, as the docs name it; a new field fails until named.
  const PHRASE: Record<string, string> = {
    screener: "screened in", rules: "rules", notifyRules: "notification choices",
    awayResponder: "away reply", tagNames: "tag names", signature: "signature", signatureHtml: "signature",
  };
  const fields = Object.keys(canonicalizeProfilePayload({
    screener: [], rules: [], notifyRules: [], awayResponder: null, tagNames: [],
    signature: "Ada", signatureHtml: "<p>Ada</p>",
  }));

  it("the README and how-it-works name every setting the profile carries", () => {
    expect(fields).toContain("signature");
    const lists = [
      /your settings \(([^)]*)\)/.exec(paper.replace(/\s+/g, " "))?.[1] ?? "",
      /holds your ohmail settings for this mailbox — ([^—]*) —/.exec(flat("docs/how-it-works.md"))?.[1] ?? "",
    ];
    for (const list of lists) for (const f of fields) expect(list, f).toContain(PHRASE[f] ?? `<unnamed ${f}>`);
  });

  it("install.md does not call billing the only code outside this repository", () => {
    const install = flat("docs/install.md");
    expect(/only code that is not here is the machinery for billing/i.test(install)).toBe(false);
    expect(install.includes(
      "The code that is not here runs only our hosted service: its billing, the staff console and the Cloud deploy kit.",
    )).toBe(true);
  });
});

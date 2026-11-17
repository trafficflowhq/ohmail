import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LANGS, ROOT, check, write } from "../scripts/catalogue.mjs";

/**
 * The two catalogues are assembled from one file per place and language. What the web app and the desktop import
 * by path is what the place files assemble to, byte for byte; every namespace has one home.
 */

const MESSAGES = "packages/app/messages";
const AGGREGATE = (lang: string) => `apps/webapp/messages/${lang}.json`;
const read = (root: string, rel: string) => readFileSync(join(root, rel), "utf8");
const places = (root: string) =>
  JSON.parse(read(root, `${MESSAGES}/places.json`)) as Record<string, string[]>;

const made: string[] = [];
/** A copy of the place files and the two aggregates, to change without touching the tree. */
function copy(): string {
  const root = mkdtempSync(join(tmpdir(), "catalogue-"));
  made.push(root);
  cpSync(join(ROOT, MESSAGES), join(root, MESSAGES), { recursive: true });
  mkdirSync(join(root, "apps/webapp/messages"), { recursive: true });
  for (const lang of LANGS) cpSync(join(ROOT, AGGREGATE(lang)), join(root, AGGREGATE(lang)));
  return root;
}

afterEach(() => {
  for (const root of made.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the catalogues, one file per place", () => {
  it("assemble to the committed aggregates, byte for byte", () => {
    expect(check()).toEqual([]);
  });

  it("give every namespace one home, and each place file holds exactly its row", () => {
    const table = places(ROOT);
    const order = JSON.parse(read(ROOT, `${MESSAGES}/order.json`)) as string[];
    const homes = Object.values(table).flat();
    expect(new Set(homes).size).toBe(homes.length);
    expect([...homes].sort()).toEqual([...order].sort());
    for (const [place, names] of Object.entries(table)) {
      for (const lang of LANGS) {
        const held = Object.keys(JSON.parse(read(ROOT, `${MESSAGES}/${place}.${lang}.json`)) as object);
        expect([...held].sort(), `${place}.${lang}.json`).toEqual([...names].sort());
      }
    }
    expect(readdirSync(join(ROOT, MESSAGES)).filter((f) => /\.(en|de)\.json$/.test(f))).toHaveLength(
      Object.keys(table).length * LANGS.length,
    );
  });

  it("refuse an aggregate edited by hand, naming the namespace", () => {
    const root = copy();
    const de = read(root, AGGREGATE("de"));
    writeFileSync(
      join(root, AGGREGATE("de")),
      de.replace(/("relativeTime": \{\n\s+"justNow": ")[^"]*/, "$1gerade"),
    );
    const problems = check(root);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/apps\/webapp\/messages\/de\.json .* first at relativeTime: run --write/);
  });

  it("refuse a namespace written in two places", () => {
    const root = copy();
    const table = places(root);
    table.ohbox = [...table.ohbox!, "place"];
    writeFileSync(join(root, `${MESSAGES}/places.json`), JSON.stringify(table));
    expect(check(root).join("\n")).toMatch(/place is in two places: shared and ohbox/);
  });

  it("refuse a place file that holds a namespace its row does not name", () => {
    const root = copy();
    const file = join(root, `${MESSAGES}/receipts.en.json`);
    writeFileSync(
      file,
      read(root, `${MESSAGES}/receipts.en.json`).replace(
        /\n\}\n$/,
        ',\n  "stray": {\n    "a": "A"\n  }\n}\n',
      ),
    );
    expect(check(root).join("\n")).toMatch(
      /receipts\.en\.json holds receipts, stray; places\.json says receipts/,
    );
  });

  it("write the aggregates without changing a byte of what was there, escapes included", () => {
    const root = copy();
    const before = LANGS.map((lang) => read(root, AGGREGATE(lang)));
    expect(before[0]).toContain("\\u2026");
    for (const lang of LANGS) writeFileSync(join(root, AGGREGATE(lang)), "{}\n");
    expect(write(root)).toEqual([]);
    expect(LANGS.map((lang) => read(root, AGGREGATE(lang)))).toEqual(before);
  });

  it("append a new place's namespace at the end, in both languages and in the order", () => {
    const root = copy();
    const table = places(root);
    writeFileSync(join(root, `${MESSAGES}/places.json`), JSON.stringify({ ...table, almanac: ["almanac"] }));
    writeFileSync(
      join(root, `${MESSAGES}/almanac.en.json`),
      '{\n  "almanac": {\n    "today": "Today"\n  }\n}\n',
    );
    writeFileSync(
      join(root, `${MESSAGES}/almanac.de.json`),
      '{\n  "almanac": {\n    "today": "Heute"\n  }\n}\n',
    );
    expect(write(root)).toEqual([]);
    expect(check(root)).toEqual([]);
    const en = JSON.parse(read(root, AGGREGATE("en"))) as Record<string, unknown>;
    const de = JSON.parse(read(root, AGGREGATE("de"))) as Record<string, unknown>;
    expect(Object.keys(en).at(-1)).toBe("almanac");
    expect(de.almanac).toEqual({ today: "Heute" });
    expect((JSON.parse(read(root, `${MESSAGES}/order.json`)) as string[]).at(-1)).toBe("almanac");
  });
});

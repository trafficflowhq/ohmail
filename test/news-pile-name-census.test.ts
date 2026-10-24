import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { publicRel } from "./support/public-root.mjs";

/**
 * THE READS PILE IS CALLED NEWS (owner, 2026-09-19), AND SINCE 0.22 SO IS ITS FOLDER: the rename
 * reached the mailbox, so `ohmail/News` is what is created and filed into and `ohmail/Reads` is
 * only the pre-0.22 name the organizer renames on its next pass. That closes the one home this
 * census used to allow — a catalogue string naming the server folder now names `News` like every
 * other surface — so in a user-facing catalogue the word may survive ONLY as the VERB. The
 * allow-list is exact and RATCHETED both ways: a new "Reads" outside it refuses, and an allowed
 * home that stops carrying the word refuses too, so the list cannot go stale.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORD = /\bReads\b/;

/** key path → why the word is allowed to stand there. */
const ALLOWED_CATALOG_HOMES: Record<string, Record<string, string>> = {
  "apps/webapp/messages/en.json": {
    "aiProvider.modelDraftHint": 'the VERB — "Reads the thread" — not the pile',
  },
  // The German catalogue has no home for the word at all: it carries no such verb, and the
  // three strings that used to name the server folder name News now that the folder does.
  "apps/webapp/messages/de.json": {},
};

function leaves(o: unknown, p: string[] = [], out: Array<[string, string]> = []): Array<[string, string]> {
  if (typeof o === "string") out.push([p.join("."), o]);
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) leaves(v, [...p, k], out);
  return out;
}

describe("the pile is News in every user-facing catalogue", () => {
  for (const [file, allowed] of Object.entries(ALLOWED_CATALOG_HOMES)) {
    it(`${file}: "Reads" survives only in its named folder/verb homes`, () => {
      const all = leaves(JSON.parse(fs.readFileSync(path.join(ROOT, file), "utf8")));
      const carrying = all.filter(([, v]) => WORD.test(v)).map(([k]) => k);
      const strays = carrying.filter((k) => !(k in allowed));
      expect(strays, `"Reads" outside the allowed homes in ${file}:\n  ${strays.join("\n  ")}`).toEqual([]);
      // The ratchet's other direction: an allowed home that no longer carries the word is stale.
      const stale = Object.keys(allowed).filter((k) => !carrying.includes(k));
      expect(stale, `allow-list entries no longer carrying "Reads" in ${file} — remove them:\n  ${stale.join("\n  ")}`).toEqual([]);
      // Anti-vacuity: the rename actually happened — the place label is News.
      const place = all.find(([k]) => k === "place.reads");
      expect(place?.[1]).toBe("News");
    });
  }

  for (const file of ["apps/mobile/src/copy.en.ts", "apps/mobile/src/copy.de.ts"]) {
    it(`${file}: no standalone "Reads" outside the ohmail/Reads folder path`, () => {
      const raw = fs.readFileSync(path.join(ROOT, file), "utf8");
      const strays = raw
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => WORD.test(line));
      expect(
        strays.map(([n, l]) => `${n}: ${l.trim()}`),
        `"Reads" as a standalone word in ${file}`,
      ).toEqual([]);
      // Anti-vacuity: the deck names the pile News.
      expect(raw).toContain('reads: "News"');
    });
  }

  // the desktop's View menu is an English table in Rust, outside every catalogue, and
  // kept "Reads" through the rename. Each label the client's place catalogue names must match it.
  it("apps/desktop/src-tauri/src/menu.rs: the View menu names each place as the client does", () => {
    const raw = fs.readFileSync(path.join(ROOT, "apps/desktop/src-tauri/src/menu.rs"), "utf8");
    const table = raw.slice(raw.indexOf("pub const VIEWS"), raw.indexOf("];", raw.indexOf("pub const VIEWS")));
    const rows = [...table.matchAll(/\("([a-z]+)", "([^"]+)", "CmdOrCtrl\+\d"\)/g)].map((m) => [m[1]!, m[2]!] as const);
    expect(rows.map(([id]) => id)).toEqual(["ohbox", "reads", "receipts", "screener", "triage"]);
    const place = (JSON.parse(fs.readFileSync(path.join(ROOT, "apps/webapp/messages/en.json"), "utf8")) as {
      place: Record<string, string>;
    }).place;
    const named = rows.filter(([id]) => id in place);
    expect(named.map(([id]) => id), "no menu row the place catalogue names").toContain("reads");
    for (const [id, label] of named) expect(label, `the View menu's ${id} label`).toBe(place[id]);
  });

  it("the README, its twin and docs/how-it-works.md: the word is gone — the tree names the folder the product makes", () => {
    const read = (rel: string) => fs.readFileSync(path.join(ROOT, publicRel(rel)), "utf8");
    for (const rel of ["README.md", "README.ohmarchy.md", "docs/how-it-works.md"]) {
      const strays = read(rel)
        .split("\n")
        .map((line, i) => [i + 1, line] as const)
        .filter(([, line]) => WORD.test(line));
      expect(strays.map(([n, l]) => `${n}: ${l.trim()}`), `"Reads" in ${rel}`).toEqual([]);
    }
    // Anti-vacuity: the tree line is there under the new name, and the README's row says News.
    expect(read("docs/how-it-works.md")).toContain("├── News");
    expect(read("README.md")).toContain("### News and Receipts");
  });
});

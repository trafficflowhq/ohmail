import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  compareState,
  describeVerdict,
  type Declared,
  type StateVerdict,
} from "../../../../test/compare/compare.js";
import { launch, TOLERANCE } from "../../../../test/compare/render.mjs";
import { folded, PLAIN_ROLE } from "./cut.mjs";
import type { Scene } from "../../../../test/compare/scene.d.mts";
import {
  draw,
  ENTRIES,
  looksOf,
  referenceKey,
  stateKey,
  type Entry,
  type KitReference,
  type KitSubject,
  type StateRow,
} from "./harness.js";

/**
 * Every state of the kit against the sheet's specimen of the same state
 * (`node packages/ui/test/compare/fetch-kit.mjs --from <the pictures>`, then
 * `npx vitest run --config vitest.compare.config.ts packages/ui/test/compare`).
 *
 * `test/reference/<entry>/states.json` is the one list. Each row is drawn from props by its subject in
 * `subjects/<entry>` and held against its data file (names, boxes, drawn values) and its picture. A
 * missing data file, a missing picture or a missing typeface fails: nothing here is skipped. The picture
 * binds from the first day, so a difference that stays is a row of `declared.json` with its reason:
 * for the whole state, for the nodes it names, with `"question": "picture"` for the picture alone, or
 * with `alike` for a role or a name the reference says otherwise (the node's box and drawing still bind).
 * What a state that is not green drew is written to build/compare/kit/.
 */

const HERE = resolve(process.cwd(), "packages/ui/test");
const PICTURES = resolve(process.cwd(), "build/reference");
const OUT = resolve(process.cwd(), "build/compare/kit");
const only = process.env.KIT_ONLY?.split(",");
/** The folder a capture wrote its pictures into (`capture-sheet.mjs --out`), read in place of the fetched archive. */
const TAKEN = process.env.KIT_PICTURES ? resolve(process.env.KIT_PICTURES) : null;
/** An entry's subjects are loaded only when that entry is compared (`KIT_ENTRY` names one). */
const SUBJECTS: Record<Entry, () => Promise<{ subjects: KitSubject[] }>> = {
  base: () => import("./subjects/base.js"),
  mail: () => import("./subjects/mail.js"),
  calendar: () => import("./subjects/calendar.js"),
};

interface KitDeclared extends Declared {
  /**
   * Left out: every question. `picture`: the picture alone, the first three questions still bind.
   * `names`, `drawn` or `boxes`: that question alone, the other three still bind.
   */
  question?: "picture" | "names" | "drawn" | "boxes";
  /**
   * Roles, names and states the reference says otherwise, read as the same node so that its box, its
   * words and its drawn values still bind: `as` reads a role as another, `unnamed` leaves the name of
   * that role unread, `unstated` the states named (`collapsed`, `invalid`) that the reference's node
   * does not say.
   */
  alike?: { role: string; as?: string; unnamed?: true; unstated?: string[] }[];
  /**
   * Nodes of the part, by selector inside the stage, that the reference draws as plain boxes: no role, a
   * paragraph, bold words. They are read without their role, so their words and surfaces stand where the
   * reference's stand and every question still binds them; only the role and name are not read.
   */
  plain?: string[];
  /**
   * Nodes of the reference, by role and name, that the part draws as plain boxes: the reference's are
   * read so, their words and surfaces folded into what holds them, and every question but the role binds.
   */
  plainThere?: { role: string; name: string }[];
}

/** The reference with the nodes a row names as plain boxes read so. */
function plainThere<S extends Scene>(scene: S, rows: KitDeclared[]): S {
  const named = rows.flatMap((d) => d.plainThere ?? []);
  if (!named.length) return scene;
  const nodes = scene.nodes.map((n) =>
    named.some((d) => d.role === n.role && d.name === n.name) ? { ...n, role: PLAIN_ROLE } : n,
  );
  return folded({ ...scene, nodes }) as S;
}

/** A scene with the declared likenesses applied: to the reference and to what was drawn alike. */
function likened<S extends Scene>(scene: S, rows: KitDeclared[]): S {
  const rules = rows.flatMap((d) => d.alike ?? []);
  if (!rules.length) return scene;
  const nodes = scene.nodes.map((n) => {
    const own = rules.filter((r) => r.role === n.role);
    if (!own.length) return n;
    const off = new Set(own.flatMap((r) => r.unstated ?? []));
    const state = n.state?.filter((s) => !off.has(s));
    return {
      ...n,
      role: own.find((r) => r.as)?.as ?? n.role,
      name: own.some((r) => r.unnamed) ? "" : n.name,
      state: state?.length ? state : undefined,
    };
  });
  return { ...scene, nodes };
}
interface Manifest {
  shard: { id: string } | null;
  rows: { key: string; file: string; png: { sha256: string }; scene: { sha256: string } }[];
}

const sha256 = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");
const json = <T>(entry: Entry, name: string): T =>
  JSON.parse(readFileSync(join(HERE, "reference", entry, name), "utf8")) as T;

/** The reference of one state in one look: its data file from this repository, its picture from the archive. */
function referenceOf(entry: Entry, manifest: Manifest, key: string): { data: KitReference; png: Buffer } {
  const row = manifest.rows.find((r) => r.key === key);
  if (!row)
    throw new Error(
      `${key} has no reference (test/reference/${entry}/manifest.json); take it with capture-sheet.mjs`,
    );
  const dataFile = join(HERE, "reference", entry, `${key}.json`);
  if (!existsSync(dataFile)) throw new Error(`${key}: its data file is missing`);
  const text = readFileSync(dataFile);
  if (sha256(text) !== row.scene.sha256)
    throw new Error(`${key}: the data file is not the one the manifest names`);
  const picture = TAKEN
    ? join(TAKEN, entry, "pictures", `${key}.png`)
    : join(PICTURES, `kit-${entry}`, `${row.file}.png`);
  if (!existsSync(picture))
    throw new Error(
      `${key}: its picture is not in ${TAKEN ?? "build/reference"}; run packages/ui/test/compare/fetch-kit.mjs`,
    );
  const png = readFileSync(picture);
  if (sha256(png) !== row.png.sha256)
    throw new Error(`${key}: the picture is not the one the manifest names`);
  return { data: JSON.parse(text.toString("utf8")) as KitReference, png };
}

function keep(
  key: string,
  verdict: StateVerdict,
  drew: { png: Buffer; scene: unknown },
  reference: Buffer,
): void {
  mkdirSync(OUT, { recursive: true });
  const at = join(OUT, key.replace(/[^A-Za-z0-9._@-]+/g, "_"));
  writeFileSync(`${at}.actual.png`, drew.png);
  writeFileSync(`${at}.reference.png`, reference);
  writeFileSync(`${at}.actual.json`, JSON.stringify(drew.scene));
  if (verdict.picture.diff) writeFileSync(`${at}.diff.png`, verdict.picture.diff);
}

const require_ = createRequire(resolve(process.cwd(), "package.json"));
const { chromium } = require_("@playwright/test") as typeof import("@playwright/test");
let browser: Awaited<ReturnType<typeof launch>> | null = null;
beforeAll(async () => {
  browser = await launch(chromium);
});
afterAll(async () => {
  await browser?.close();
});

for (const entry of ENTRIES.filter((e) => !process.env.KIT_ENTRY || process.env.KIT_ENTRY === e)) {
  const { subjects } = await SUBJECTS[entry]();
  describe(`${entry}: each state against the sheet's specimen`, () => {
    const states = json<{ rows: StateRow[] }>(entry, "states.json").rows;
    const manifest = json<Manifest>(entry, "manifest.json");
    const declared = json<KitDeclared[]>(entry, "declared.json");
    const subjectOf = new Map(subjects.map((s) => [s.key, s]));

    it("has one subject for every state, and no subject without a state", () => {
      const listed = states.map(stateKey);
      expect(new Set(listed).size, "a state is listed twice").toBe(listed.length);
      expect(subjects.length, "a subject is written twice").toBe(subjectOf.size);
      expect(
        listed.filter((k) => !subjectOf.has(k)),
        "states no subject draws",
      ).toEqual([]);
      expect(
        [...subjectOf.keys()].filter((k) => !listed.includes(k)),
        "subjects of no listed state",
      ).toEqual([]);
    });

    const cases = states
      .flatMap((row) => looksOf(row).map((look) => referenceKey(row, look)))
      .filter((key) => !only || only.some((o) => key.startsWith(o)));
    if (!cases.length) return;
    it.each(cases)("%s", async (key) => {
      const name = key.slice(0, key.indexOf("@"));
      const subject = subjectOf.get(name);
      if (!subject) throw new Error(`${name} has no subject in subjects/${entry}`);
      const reference = referenceOf(entry, manifest, key);
      const rows = declared.filter(
        (d) => d.key === key || d.key === name || d.key === name.slice(0, name.indexOf("/")),
      );
      const drew = await draw(
        browser!,
        entry,
        subject,
        reference.data,
        rows.flatMap((d) => d.plain ?? []),
      );
      const verdict = compareState({
        key,
        reference: { scene: likened(plainThere(reference.data, rows), rows), png: reference.png },
        actual: { ...drew, scene: likened(drew.scene, rows) },
        tolerance: TOLERANCE,
        declared: rows.find((d) => !d.question && !d.alike && !d.plain && !d.plainThere),
        accepted: true,
      });
      /* A picture declared on its own reports; a picture of another size never does. So do names, drawn values or boxes declared on their own. */
      if (
        verdict.picture.verdict === "red" &&
        verdict.picture.sized &&
        rows.some((d) => d.question === "picture")
      )
        verdict.picture.verdict = "reported";
      for (const q of ["names", "drawn", "boxes"] as const)
        if (verdict[q].verdict === "red" && rows.some((d) => d.question === q))
          verdict[q] = { ...verdict[q], verdict: "reported" };
      verdict.green = [verdict.names, verdict.boxes, verdict.drawn, verdict.picture].every(
        (r) => r.verdict !== "red",
      );
      console.log(describeVerdict(verdict));
      if (!verdict.green || verdict.picture.verdict !== "green") keep(key, verdict, drew, reference.png);
      expect(verdict.green, describeVerdict(verdict, 40)).toBe(true);
    });
  });
}

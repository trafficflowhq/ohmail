// @vitest-environment jsdom
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PLACES } from "../../journeys/vocabulary/places.js";
import { keyOf } from "../registry.mjs";
import { markElement } from "./page.mjs";
import { mailChanges, type World } from "./matched.js";
import { asDeclared, COMPARED, differ, isPhone, LOOKS, verdict, type Declared, type Element, type Reading, type Row } from "./rows.js";
import { SUBJECTS } from "./subjects.js";

/**
 * The real-app measure's own rules on made-up readings (`rows.ts`), and its answer where no design reference is
 * given. The measure itself draws in a browser against the reference and runs on a workstation (README.md).
 */

const AT = { look: "1440-paper-light", subject: "frame" };
const LABEL: Element = { name: "Ohbox.label", kind: "text", app: "a", reference: "r" };
const reading = (more: Reading = {}): Reading => ({
  text: "Ohbox", x: 12, y: 40, w: 120, h: 24, visible: true, face: "Hanken Grotesk (web font)",
  fontFamily: "Hanken Grotesk", fontWeight: "700", fontSize: "16px", lineHeight: "24px", letterSpacing: "normal",
  fontVariation: "normal", color: "rgb(1, 2, 3)", background: "rgba(0, 0, 0, 0)", padding: "0px 0px 0px 0px",
  ...more,
});

describe("the same mailbox inputs", () => {
  it("syncs filed mail, stream flags and drafts into their own real entity types", () => {
    const at = "2026-01-01T12:00:00Z";
    const world: World = {
      tagCatalog: [{ id: "label", name: "Receipts", hue: "moss" }, { id: "older-id", name: "Travel", hue: "moss" }], tagged: { b: ["label"] },
      calendar: null,
      now: at, zone: "Europe/Zurich", account: { displayName: "Reader", signIn: "reader" }, mailboxes: [], waiting: [], unread: 0,
      threads: [
        { section: "news", letter: { id: "a", mailbox: "work", at, subject: "News", preview: "", pile: null },
          members: [{ name: "Writer", address: "writer", at, me: false, unread: true }] },
        { section: "receipts", letter: { id: "b", mailbox: "work", at, subject: "Receipt", preview: "", pile: "parked" },
          members: [{ name: "Shop", address: "shop", at, me: false, unread: false }] },
      ],
      upcoming: [{ id: "later", title: "A reminder", from: { name: "Writer", address: "writer" }, mailbox: "work", due: "Tue 6 Jan, 08:00" }],
      drafts: [{ id: "c", mailboxId: "work", subject: "A draft", to: [], body: "Draft body", at }],
    };
    expect(mailChanges(world, "person").changes.creates).toMatchObject([
      { type: "message", entity: { accountId: "person", mailboxId: "work", folder: "ohmail/News", unread: true } },
      { type: "message", entity: { mailboxId: "work", folder: "ohmail/Receipts", unread: false, labels: ["label"], triage: { state: "set_aside" } } },
      { type: "message", entity: { mailboxId: "work", subject: "A reminder", triage: { state: "bubbled_up", bubbleUpAt: "2026-01-06T07:00:00.000Z" } } },
      { type: "draft", entity: { mailboxId: "work", subject: "A draft", body: "Draft body" } },
      { type: "tag", entity: { id: "label", name: "Receipts", createdAt: "2026-01-01T11:59:58.000Z" } },
      { type: "tag", entity: { id: "older-id", name: "Travel", createdAt: "2026-01-01T11:59:59.000Z" } },
    ]);
  });
});

describe("the differ", () => {
  it("writes a changed weight as one row with both values", () => {
    const rows = differ(AT, [LABEL], { [LABEL.name]: reading({ fontWeight: "400" }) }, { [LABEL.name]: reading() }, 1);
    expect(rows).toEqual([{ ...AT, element: "Ohbox.label", property: "fontWeight", app: "400", reference: "700" }]);
  });

  it("writes no row where every value is equal", () => {
    expect(differ(AT, [LABEL], { [LABEL.name]: reading() }, { [LABEL.name]: reading() }, 1)).toEqual([]);
  });

  it("holds a box to the comparison's tolerance and a drawn value to its string", () => {
    const rows = differ(AT, [LABEL], { [LABEL.name]: reading({ x: 13, w: 122, fontSize: "16.5px" }) }, { [LABEL.name]: reading() }, 1);
    expect(rows.map((r) => r.property)).toEqual(["w", "fontSize"]);
  });

  it("compares the count and all its dimensions when both entries hold the same mail", () => {
    const badge: Element = { ...LABEL, name: "Ohbox.count", count: true };
    const app = { [badge.name]: reading({ text: "11", w: 24 }) };
    const reference = { [badge.name]: reading({ text: "5", w: 16 }) };
    expect(differ(AT, [badge], app, reference, 1)).toEqual([]);
    expect(differ(AT, [badge], app, reference, 1, true).map((r) => r.property)).toEqual(["text", "w"]);
  });

  it("says an element one side draws and the other has not, once", () => {
    const rows = differ(AT, [LABEL], {}, { [LABEL.name]: reading() }, 1);
    expect(rows).toEqual([{ ...AT, element: "Ohbox.label", property: "present", app: "no", reference: "yes" }]);
  });
});

const ROW: Row = { ...AT, element: "Ohbox.label", property: "face", app: "Arimo (system)", reference: "Hanken Grotesk (web font)" };
const FACES: Declared = {
  subject: "frame", reason: "No shell loads the font files yet.", since: "2026-11-17", removedBy: "r2-fonts",
  rows: [{ element: "Ohbox.label", property: "face", looks: ["1440-paper-light"] }],
};
const MEASURED = [{ subject: "frame", look: "1440-paper-light" }];

describe("the declared list", () => {
  it("is green where every row is declared and every declared row occurs", () => {
    const v = verdict([ROW], [FACES], MEASURED);
    expect(v.green).toBe(true);
    expect(v.declared.map((r) => r.removedBy)).toEqual(["r2-fonts"]);
  });

  it("is red on a row it does not declare", () => {
    const v = verdict([ROW, { ...ROW, property: "fontWeight", app: "400", reference: "700" }], [FACES], MEASURED);
    expect(v.green).toBe(false);
    expect(v.undeclared.map((r) => r.property)).toEqual(["fontWeight"]);
  });

  it("is red on a declared row that no longer occurs, and only where that look was read", () => {
    const v = verdict([], [FACES], MEASURED);
    expect(v.green).toBe(false);
    expect(v.gone).toEqual([{ look: "1440-paper-light", subject: "frame", element: "Ohbox.label", property: "face", removedBy: "r2-fonts" }]);
    expect(verdict([], [FACES], [{ subject: "frame", look: "390-paper-dark" }]).green).toBe(true);
  });

  it("holds a declared row to the app's value it names: a second change to that property is undeclared", () => {
    const held = (app: string): Declared => ({ ...FACES, rows: [{ ...FACES.rows[0]!, app }] });
    expect(verdict([ROW], [held("Arimo (system)")], MEASURED).green).toBe(true);
    const moved = verdict([ROW], [held("DejaVu Sans (system)")], MEASURED);
    expect([moved.green, moved.undeclared, moved.gone]).toEqual([false, [ROW], []]);
  });

  it("hands the rows not declared yet with the app's value, one row a value", () => {
    const at = (look: string, app: string): Row => ({ ...ROW, look, app });
    expect(asDeclared([at("1440-paper-light", "Arimo (system)"), at("2000-paper-light", "Arimo (system)"), at("1440-ohmarchy-dark", "DejaVu Sans Mono (system)")], "2026-11-17")).toEqual([
      {
        subject: "frame", reason: "", since: "2026-11-17", removedBy: "",
        rows: [
          { element: "Ohbox.label", property: "face", looks: ["1440-paper-light", "2000-paper-light"], app: "Arimo (system)" },
          { element: "Ohbox.label", property: "face", looks: ["1440-ohmarchy-dark"], app: "DejaVu Sans Mono (system)" },
        ],
      },
    ]);
  });

  it("is red on an entry that names no task to remove it", () => {
    expect(verdict([ROW], [{ ...FACES, removedBy: "" }], MEASURED).faults).toEqual(["declared.json entry 0: no removedBy"]);
  });

  it("is red on a row that names a look or a property the measure never reads: such a row could never go", () => {
    const typos: Declared = {
      ...FACES,
      rows: [
        { element: "Ohbox.label", property: "face", looks: ["1440-paper-ligth"] },
        { element: "Ohbox.label", property: "fontweight", looks: ["1440-paper-light"] },
      ],
    };
    expect(verdict([], [typos], MEASURED).faults).toEqual([
      "declared.json: 1440-paper-ligth frame Ohbox.label face: no such look",
      "declared.json: frame Ohbox.label fontweight: no element is compared on that property",
    ]);
  });

  it("as the tree holds it, gives every entry its reason, its day and the task that removes it, and no row twice", () => {
    const tree = JSON.parse(readFileSync("test/compare/real/declared.json", "utf8")) as Declared[];
    expect(verdict([], tree, []).faults).toEqual([]);
    const subjects = new Set(SUBJECTS.map((s) => s.id));
    for (const entry of tree) expect(subjects, entry.reason).toContain(entry.subject);
  });

  it("as the tree holds it, names on each row an element its subject reads at that look, and a property that element is compared on", () => {
    const tree = JSON.parse(readFileSync("test/compare/real/declared.json", "utf8")) as Declared[];
    for (const entry of tree) {
      const s = SUBJECTS.find((x) => x.id === entry.subject);
      for (const r of entry.rows) {
        for (const l of r.looks) {
          const look = LOOKS.find((x) => x.name === l);
          const el = (look && isPhone(look) ? s?.phone : s?.desk)?.find((e) => e.name === r.element);
          const at = `${l} ${entry.subject} ${r.element} ${r.property}`;
          expect(el, at).toBeDefined();
          expect(["present", "visible", ...(el ? COMPARED[el.kind] : [])], at).toContain(r.property);
        }
      }
    }
  });
});

/** The measure as a person runs it, with only the reference's variables `more` names. */
const measure = (more: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of ["REAL_MEASURE_STUDIO", "REAL_MEASURE_REF", "COMPARE_REQUIRE_REFERENCE"]) delete env[name];
  return spawnSync(process.execPath, ["--import", "tsx", "test/compare/real/measure.mts"], { encoding: "utf8", env: { ...env, ...more } });
};

describe("without a design reference", () => {
  it("says so in one line and ends SKIPPED, exit 0", () => {
    const run = measure();
    expect(run.status).toBe(0);
    expect(run.stdout.trim().split("\n")).toEqual([expect.stringMatching(/^real-measure: SKIPPED: no design reference given/)]);
  }, 60_000);

  it("fails instead where the comparison's switch asks for the reference", () => {
    const run = measure({ COMPARE_REQUIRE_REFERENCE: "1" });
    expect(run.status).toBe(1);
    expect(run.stdout.trim().split("\n")).toEqual([expect.stringMatching(/^real-measure: RED: no design reference given/)]);
  }, 60_000);
});

describe("the reference", () => {
  const pin = (): string => (JSON.parse(readFileSync("test/compare/real/reference.json", "utf8")) as { studioCommit: string }).studioCommit;

  it("is pinned in the tree: one commit of the studio, its 40 hex", () => {
    expect(Object.keys(JSON.parse(readFileSync("test/compare/real/reference.json", "utf8")) as object)).toEqual(["studioCommit"]);
    expect(pin()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("named, and another commit than the pin, gives no verdict: one line, RED", () => {
    const studio = mkdtempSync(join(tmpdir(), "real-measure-studio-"));
    const git = (...args: string[]): string =>
      execFileSync("git", ["-c", "user.name=measure", "-c", "user.email=", "-c", "commit.gpgsign=false", ...args], { cwd: studio, encoding: "utf8" });
    try {
      git("init", "-q");
      git("commit", "-q", "--allow-empty", "-m", "one");
      const head = git("rev-parse", "HEAD").trim();
      const run = measure({ REAL_MEASURE_STUDIO: studio, REAL_MEASURE_REF: "HEAD" });
      expect(run.status).toBe(1);
      expect(run.stdout.trim().split("\n")).toEqual([`real-measure: reference ${head} is not the pinned ${pin()}: not a verdict`]);
    } finally {
      rmSync(studio, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("the subjects' table", () => {
  it("names each place by the journeys' vocabulary and each reference state by a key the registry holds", () => {
    const registry = JSON.parse(readFileSync("test/compare/registry.json", "utf8")) as { states: { key?: string }[] };
    for (const s of SUBJECTS) {
      expect(s.id === "frame" || s.id === "frame-web" || s.id in PLACES, s.id).toBe(true);
      expect(keyOf(s.reference), s.id).toBe(s.reference);
      expect(registry.states.map((st) => st.key ?? st), s.id).toContain(s.reference);
      for (const look of s.looks ?? []) expect(LOOKS.map((l) => l.name), s.id).toContain(look);
    }
  });

  it("names every element once within a subject, and reads each place from an element of the same subject", () => {
    for (const s of SUBJECTS) {
      for (const list of [s.desk, s.phone]) {
        const names = list.map((e) => e.name);
        expect(new Set(names).size, s.id).toBe(names.length);
        for (const e of list) if (e.in) expect(names, `${s.id} ${e.name}`).toContain(e.in);
      }
    }
  });
});

describe("a finder", () => {
  it("that throws is said so, never read as an element that is absent", () => {
    document.body.innerHTML = `<nav class="oh-rail"></nav>`;
    expect(markElement(["nothing()", "e0"])).toBe("threw");
    expect(markElement([`q("aside")`, "e0"])).toBe(false);
    expect(markElement([`q("nav.oh-rail")`, "e0"])).toBe(true);
  });
});

describe("the looks", () => {
  it("are the ruling's eight: 390, 1440 and 2000 wide in paper light and dark, ohmarchy dark at 1440 and 2000", () => {
    expect(LOOKS.map((l) => l.name).sort()).toEqual([
      "1440-ohmarchy-dark", "1440-paper-dark", "1440-paper-light", "2000-ohmarchy-dark",
      "2000-paper-dark", "2000-paper-light", "390-paper-dark", "390-paper-light",
    ]);
  });
});

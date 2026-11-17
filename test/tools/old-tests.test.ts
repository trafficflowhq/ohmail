import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { NEVER_RED_HEADER, OLD_TESTS_HEADER } from "../../tools/lib/old-tests.mjs";

// The folder's name is spelled apart here, so that this file names no part of today's shell itself.
const APP = "app";
const SHELL = `apps/webapp/${APP}/shell`;
const VIEWS = `apps/webapp/${APP}/views`;
const CHECK = path.join(__dirname, "..", "..", "tools", "check.mjs");
const HISTORY = "apps/webapp/test/history.test.tsx";

/** A tree with today's shell, one view, a held place's list, the web's entry, and two older tests. */
const BASE: Record<string, string> = {
  "packages/app/src/frame/contract.ts":
    'export const PLACE_IDS = ["ohbox", "history", "trash", "write", "settings"] as const;\nexport const STAGE_IDS = ["firstRun"] as const;\n',
  "packages/app/src/settings/contract.ts": 'export const PANE_IDS = ["general", "account"] as const;\n',
  "packages/app/src/history/HistoryList.tsx": "export const HistoryList = () => null;\n",
  [`${SHELL}/AppShell.tsx`]:
    'import { HistoryView } from "../views/HistoryView";\nexport const AppShell = () => HistoryView;\n',
  [`${SHELL}/locale.ts`]: 'export const locale = "en";\n',
  [`${VIEWS}/HistoryView.tsx`]: "export const HistoryView = () => null;\n",
  "apps/webapp/app/(product)/mailbox/page.tsx":
    'import { AppShell } from "../../shell/AppShell";\nimport { locale } from "../../shell/locale";\nexport default function Page() {\n  return [AppShell, locale];\n}\n',
  [HISTORY]: `import { HistoryView } from "../${APP}/views/HistoryView";\ndescribe("History", () => {\n  it("lists the kept letters", () => {});\n  it("draws its rows", () => {});\n});\n`,
  "apps/webapp/test/quiet.test.ts": 'it("adds", () => {});\n',
};
const row = (file: string, klass: string, holder: string, state: string, share = "21") =>
  [file, klass, holder, share, state].join("\t");
const HISTORY_WAITS = row(HISTORY, "behaviour", "mount-lists", "WAITS:history");
const table = (header: string, rows: string[]) => [header, ...rows].join("\n") + "\n";

const made: string[] = [];
afterAll(() => made.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** The two lists as a base commit holds them: the mode is then run with --base, against that commit. */
interface Base {
  rows: string[];
  neverRed: string[];
}

/** Runs --old-tests over the base tree with `over` written on it (null leaves a file out). */
function run(
  over: Record<string, string | null>,
  rows = [HISTORY_WAITS],
  neverRed: string[] = [],
  base?: Base,
) {
  const root = mkdtempSync(path.join(os.tmpdir(), "ohmail-old-tests-"));
  made.push(root);
  const write = (files: Record<string, string | null>) => {
    for (const [rel, text] of Object.entries(files)) {
      if (text === null) rmSync(path.join(root, rel), { force: true });
      else {
        mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        writeFileSync(path.join(root, rel), text);
      }
    }
  };
  const lists = (r: string[], red: string[]) => ({
    "tools/old-tests.tsv": table(OLD_TESTS_HEADER, r),
    "tools/never-red.tsv": table(NEVER_RED_HEADER, red),
  });
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (base) {
    write({ ...BASE, ...lists(base.rows, base.neverRed) });
    const quiet = ["-c", "user.name=t", "-c", "user.email=t", "-c", "commit.gpgsign=false"];
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync("git", [...quiet, "-c", "core.hooksPath=/dev/null", "commit", "-q", "-m", "base"], {
      cwd: root,
    });
  }
  write({ ...BASE, ...lists(rows, neverRed), ...over });
  const flags = base ? ["--old-tests", "--base", "HEAD"] : ["--old-tests"];
  const result = spawnSync(process.execPath, [CHECK, "--root", root, ...flags], { encoding: "utf8" });
  const refused = result.stderr.split("\n").filter((line) => line.startsWith("REFUSED "));
  return { status: result.status, stdout: result.stdout, refused, stderr: result.stderr };
}

describe("the older tests' checklist, read against a tree of its own", () => {
  it("passes a tree whose every file in scope has its rows, and says in one line each what is not mounted", () => {
    const result = run({});
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("no packages/app/src/mail/places.ts: no place is seated");
    expect(result.stdout).toContain("the mail entry holds no FrameStages record: no stage is handed");
    expect(result.stdout).toContain("1 rows (WAITS 1), 1 files in scope, 0 never red; mounted: nothing");
  });

  it("refuses a file in scope without a row: one that names today's shell, one that mounts through a test door", () => {
    const result = run({
      "apps/webapp/test/_door.tsx": `export { AppShell } from "../${APP}/shell/AppShell";\n`,
      "apps/webapp/test/through-door.test.tsx":
        'import { AppShell } from "./_door";\nit("mounts", () => AppShell);\n',
      "apps/webapp/test/census.test.ts": `const dir = join(root, "${APP}", "views");\nit("reads", () => dir);\n`,
      "apps/webapp/test/said-only.test.ts": `// once lived in ${APP}/shell/x\nit("adds", () => {});\n`,
    });
    expect(result.refused.sort()).toEqual([
      expect.stringMatching(/old tests: apps\/webapp\/test\/census\.test\.ts is in scope .* has no row/),
      expect.stringMatching(
        /old tests: apps\/webapp\/test\/through-door\.test\.tsx is in scope .* has no row/,
      ),
    ]);
    expect(result.status).toBe(1);
    expect(result.refused[0], "the refusal says where the row goes").toContain(
      'add its row to tools/old-tests.tsv (tools/README.md, "The older tests")',
    );
  });

  it("refuses a deleted file's row unless it is RETIRED, its holder a case that stands, its proof in the retirement table", () => {
    const gone = "apps/webapp/test/gone.test.tsx";
    const holder = `${HISTORY}#History > lists the kept letters`;
    const rows = (state: string, by: string) => [row(gone, "markup", by, state), HISTORY_WAITS];
    expect(run({}, rows("WAITS:history", "mount-lists")).refused).toEqual([
      expect.stringContaining(`${gone}: the file is not in the tree, so its row is RETIRED`),
      expect.stringContaining(`${gone}: a deleted test leaves by its row in tools/retirement.tsv`),
    ]);
    const proof = {
      "tools/retirement.tsv": `file\tkind\tholds\thome\ttask\tverdict\n${gone}\tbehaviour\tdraws\tlayer 1\tframe\theld:${HISTORY}#lists the kept letters\n`,
    };
    expect(run(proof, rows("RETIRED", `${HISTORY}#History > draws no rows`)).refused).toEqual([
      expect.stringContaining(`${gone}: its holder: ${HISTORY} holds no case "History > draws no rows"`),
    ]);
    expect(run({}, rows("RETIRED", holder)).refused).toEqual([
      expect.stringContaining(`${gone}: a deleted test leaves by its row in tools/retirement.tsv`),
    ]);
    expect(run(proof, rows("RETIRED", holder)).status).toBe(0);
  });

  it("refuses WAITS for a place the mail seats, a stage and a pane it hands, and the reader its supplies hand", () => {
    const seated = {
      "packages/app/src/mail/places.ts": "const SEATED: MailPlaces = {\n  history: historyPlace,\n};\n",
    };
    expect(run(seated).refused).toEqual([
      expect.stringContaining(`${HISTORY}: WAITS for history, which a host's entry mounts`),
    ]);
    const commented = {
      "packages/app/src/mail/places.ts":
        "const SEATED: MailPlaces = {\n  // the lists' place, from their mount\n  history: historyPlace, // seated\n  /* none yet */ trash: NONE,\n};\n",
    };
    expect(run(commented).refused, "a comment above or beside an entry is no part of its key").toEqual([
      expect.stringContaining(`${HISTORY}: WAITS for history, which a host's entry mounts`),
    ]);
    const waiting = (target: string, by: string) => [row(HISTORY, "behaviour", by, `WAITS:${target}`)];
    const stages = {
      "packages/app/src/mail/stages.ts":
        "export function mailStages(parts: Parts): FrameStages {\n  return { firstRun: firstRunStage(parts) };\n}\n",
    };
    expect(run(stages, waiting("stage:firstRun", "mount-first-run")).refused).toEqual([
      expect.stringContaining("WAITS for stage:firstRun, which a host's entry mounts"),
    ]);
    const panes = {
      "packages/app/src/mail/supplies.ts":
        "const PANES: SettingsPanes = {\n  general: NONE,\n  account: accountPane,\n};\nexport const s = () => ({ reader: own.reader, above: MailGround, calendar: NONE });\n",
    };
    expect(run(panes, waiting("pane:general", "mount-settings")).status).toBe(0);
    expect(run(panes, waiting("pane:account", "switch-way-out")).refused).toEqual([
      expect.stringContaining("WAITS for pane:account, which a host's entry mounts"),
    ]);
    expect(run(panes, waiting("reader", "switch-reader")).refused).toEqual([
      expect.stringContaining("WAITS for reader, which a host's entry mounts"),
    ]);
    expect(run(panes, waiting("calendar", "mount-calendar")).status).toBe(0);
  });

  it("refuses KEPT over what leaves with the switch, and over a part no host's entry reaches; passes a kept unit", () => {
    const kept = (file: string) => [HISTORY_WAITS, row(file, "behaviour", file, "KEPT")].sort();
    const overList = "apps/webapp/test/history-list.test.tsx";
    const overLocale = "apps/webapp/test/locale.test.ts";
    const tests = {
      [overList]:
        'import { HistoryList } from "../../../packages/app/src/history/HistoryList";\nit("lists", () => HistoryList);\n',
      [overLocale]: `import { locale } from "../${APP}/shell/locale";\nit("speaks", () => locale);\n`,
    };
    expect(
      run(tests, [...kept(overList), row(overLocale, "behaviour", "mount-settings", "WAITS:pane:general")])
        .refused,
    ).toEqual([
      expect.stringContaining(
        `${overList}: KEPT over a part no host's entry reaches (packages/app/src/history/HistoryList.tsx)`,
      ),
    ]);
    const keptRows = [
      row(HISTORY, "behaviour", HISTORY, "KEPT"),
      row(overList, "behaviour", "mount-lists", "WAITS:history"),
      row(overLocale, "behaviour", overLocale, "KEPT"),
    ];
    expect(run(tests, keptRows.sort()).refused).toEqual([
      expect.stringContaining(`${HISTORY}: KEPT over today's shell (${VIEWS}/HistoryView.tsx)`),
    ]);
  });

  it("refuses a never-red case that is WAITS or GAP at a mounted place, or that is not sorted case by case", () => {
    const at = (name: string) => `${HISTORY}#History > ${name}`;
    const byCase = [
      row(at("draws its rows"), "markup", "mount-lists", "WAITS:history"),
      row(at("lists the kept letters"), "gap", "the kept letters, listed", "GAP:mount-lists"),
    ];
    const red = (holder: string) => [
      [at("lists the kept letters"), "FILE", "history", holder, "the kept letters are listed"].join("\t"),
    ];
    expect(run({}, byCase, red("mount-lists")).status).toBe(0);
    expect(run({}, [HISTORY_WAITS], red("mount-lists")).refused).toEqual([
      expect.stringContaining(
        "a never-red case is sorted case by case in tools/old-tests.tsv (D, point b): its case has no row of its own",
      ),
    ]);
    const seated = {
      "packages/app/src/mail/places.ts": "const SEATED: MailPlaces = { history: historyPlace };\n",
    };
    expect(run(seated, byCase, red("mount-lists")).refused).toEqual([
      expect.stringContaining(`${at("draws its rows")}: WAITS for history, which a host's entry mounts`),
      expect.stringContaining(
        "history is mounted, so its holder is a case at the new part: mount-lists is not a test file in the tree",
      ),
      expect.stringContaining(
        "history is mounted and its row is GAP:mount-lists: green over the real entry, never WAITS or GAP",
      ),
    ]);
  });

  it("refuses a file sorted case by case with a case left out, a case it does not hold, and both kinds of row", () => {
    const one = row(
      `${HISTORY}#History > lists the kept letters`,
      "behaviour",
      "mount-lists",
      "WAITS:history",
    );
    expect(run({}, [one]).refused).toEqual([
      expect.stringContaining(
        `${HISTORY}: it is sorted case by case and 1 of its cases have no row: "History > draws its rows"`,
      ),
    ]);
    const stray = row(`${HISTORY}#History > draws rows`, "markup", "mount-lists", "WAITS:history");
    expect(run({}, [one, stray].sort()).refused).toEqual([
      expect.stringContaining(`${HISTORY}#History > draws rows: ${HISTORY} holds no case of that name`),
      expect.stringContaining("1 of its cases have no row"),
    ]);
    expect(run({}, [HISTORY_WAITS, one]).refused).toEqual([
      expect.stringContaining(`${HISTORY}: a file is one row, or one row a case; it has both`),
    ]);
  });

  it("refuses a class, a state, a share or a holder out of its forms", () => {
    const refusedFor = (r: string) =>
      run({}, [r]).refused.map((line) => line.replace(/^REFUSED old tests: \S+: /, ""));
    expect(refusedFor(row(HISTORY, "markup", HISTORY, "KEPT"))).toEqual([
      "markup leaves with its view: WAITS until its mount, then RETIRED, never KEPT",
      expect.stringContaining("KEPT over today's shell"),
    ]);
    expect(refusedFor(row(HISTORY, "behaviour", "mount-trash", "WAITS:history"))).toEqual([
      'the holder "mount-trash" is no mount nor a commit of the switch that mounts history',
    ]);
    expect(refusedFor(row(HISTORY, "behaviour", "the rows, drawn", "GAP:mount-lists"))).toEqual([
      "a gap's row is GAP:<owner>, and a GAP row is of the class gap",
    ]);
    expect(refusedFor(row(HISTORY, "gap", "the rows, drawn", "GAP:someone", "1"))).toEqual([
      'the share "1" is not the census\'s share by its two digits',
      "GAP:someone names no owner: a mount, the switch or one of its commits, kit, or dispatcher",
    ]);
    expect(refusedFor(row(HISTORY, "stale", "mount-lists", "WAITS:history"))).toEqual([
      expect.stringContaining('the class "stale" is not one of behaviour, markup, census, gap'),
    ]);
  });

  it("reads a waiting row's mount before what it is handed, and the mount must mount the place", () => {
    const refusedFor = (holder: string) =>
      run({}, [row(HISTORY, "behaviour", holder, "WAITS:history")]).refused.map((line) =>
        line.replace(/^REFUSED old tests: \S+: /, ""),
      );
    expect(refusedFor("mount-lists: kept: the arriving letter stands first, the open one holds")).toEqual([]);
    expect(refusedFor("mount-trash: kept: the arriving letter stands first")).toEqual([
      'the holder "mount-trash: kept: the arriving letter stands first" is no mount nor a commit of the switch that mounts history',
    ]);
    expect(refusedFor("mount-lists:kept")).toEqual([
      'the holder "mount-lists:kept" is no mount nor a commit of the switch that mounts history',
    ]);
    expect(refusedFor("mount-lists:  ")).toEqual([
      'the holder "mount-lists:  " says nothing after its mount: write the mount alone, or what it is handed',
    ]);
  });

  it("refuses, against its base, an act file deleted with all its rows and its never-red row", () => {
    const at = (name: string) => `${HISTORY}#History > ${name}`;
    const byCase = [
      row(at("draws its rows"), "markup", "mount-lists", "WAITS:history"),
      row(at("lists the kept letters"), "behaviour", "mount-lists", "WAITS:history"),
    ];
    const red = [
      [at("lists the kept letters"), "FILE", "history", "mount-lists", "the kept letters are listed"].join(
        "\t",
      ),
    ];
    const result = run({ [HISTORY]: null }, [], [], { rows: byCase, neverRed: red });
    expect(result.refused).toEqual([
      `REFUSED old tests: ${at("draws its rows")}: a row never leaves the checklist; a file or case that leaves is RETIRED by its row (D)`,
      `REFUSED old tests: ${at("lists the kept letters")}: a row never leaves the checklist; a file or case that leaves is RETIRED by its row (D)`,
      "REFUSED never red: the kept letters are listed: a never-red row never leaves (Q-6)",
    ]);
    expect(run({}, byCase, red).refused, "with no base, nothing is compared").toEqual([]);
  });

  it("refuses, against its base, one never-red row deleted alone", () => {
    const at = (name: string) => `${HISTORY}#History > ${name}`;
    const byCase = [
      row(at("draws its rows"), "behaviour", "mount-lists", "WAITS:history"),
      row(at("lists the kept letters"), "behaviour", "mount-lists", "WAITS:history"),
    ];
    const red = (name: string, act: string) =>
      [at(name), act, "history", "mount-lists", `${name}, promised`].join("\t");
    const both = [red("draws its rows", "SCOPE"), red("lists the kept letters", "FILE")];
    expect(run({}, byCase, [both[1]], { rows: byCase, neverRed: both }).refused).toEqual([
      "REFUSED never red: draws its rows, promised: a never-red row never leaves (Q-6)",
    ]);
    expect(run({}, byCase, both, { rows: byCase, neverRed: both }).status).toBe(0);
  });

  it("passes, against its base, a whole file now sorted case by case, and a deleted file's rows RETIRED", () => {
    const at = (name: string) => `${HISTORY}#History > ${name}`;
    const byCase = [
      row(at("draws its rows"), "behaviour", "mount-lists", "WAITS:history"),
      row(at("lists the kept letters"), "behaviour", "mount-lists", "WAITS:history"),
    ];
    expect(run({}, byCase, [], { rows: [HISTORY_WAITS], neverRed: [] }).status).toBe(0);
    const quiet = "apps/webapp/test/quiet.test.ts";
    const kept = [HISTORY_WAITS, row(quiet, "behaviour", quiet, "KEPT")];
    const gone = [
      HISTORY_WAITS,
      row(quiet, "behaviour", `${HISTORY}#History > lists the kept letters`, "RETIRED"),
    ];
    const proof = {
      [quiet]: null,
      "tools/retirement.tsv": `file\tkind\tholds\thome\ttask\tverdict\n${quiet}\tbehaviour\tadds\tnone\tframe\tgone:${quiet}\n`,
    };
    expect(run(proof, gone, [], { rows: kept, neverRed: [] }).refused).toEqual([]);
    expect(run(proof, [HISTORY_WAITS], [], { rows: kept, neverRed: [] }).refused).toEqual([
      `REFUSED old tests: ${quiet}: a row never leaves the checklist; a file or case that leaves is RETIRED by its row (D)`,
    ]);
  });

  it("takes a ruling as the holder of a behaviour it dropped: 'dropped: <ruling>', with no case, and its never-red row leaves", () => {
    const at = (name: string) => `${HISTORY}#History > ${name}`;
    const red = [at("draws its rows"), "SCOPE", "history", "mount-lists", "its rows, drawn"].join("\t");
    const base = {
      rows: [
        row(at("draws its rows"), "behaviour", "mount-lists", "WAITS:history"),
        row(at("lists the kept letters"), "behaviour", "mount-lists", "WAITS:history"),
      ],
      neverRed: [red],
    };
    const waiting = [
      row(
        at("draws its rows"),
        "behaviour",
        "mount-lists: retires with HistoryView: dropped: Z70",
        "WAITS:history",
      ),
      base.rows[1],
    ];
    expect(run({}, waiting, [red], base).refused, "waiting at its mount, the ruling named").toEqual([]);
    const dropped = {
      [HISTORY]: `import { HistoryView } from "../${APP}/views/HistoryView";\ndescribe("History", () => {\n  it("lists the kept letters", () => {});\n});\n`,
    };
    const retired = [row(at("draws its rows"), "behaviour", "dropped: Z70", "RETIRED"), base.rows[1]];
    expect(run(dropped, retired, [], base).refused, "retired at its mount, by the ruling").toEqual([]);
    expect(run(dropped, retired, [red], base).refused, "its never-red row may also stay").toEqual([]);
  });

  it("refuses 'dropped: <ruling>' on a census row, and where the word after it is no ruling's name", () => {
    const at = (name: string) => `${HISTORY}#History > ${name}`;
    const dropped = {
      [HISTORY]: `import { HistoryView } from "../${APP}/views/HistoryView";\ndescribe("History", () => {\n  it("lists the kept letters", () => {});\n});\n`,
    };
    const kept = row(at("lists the kept letters"), "behaviour", "mount-lists", "WAITS:history");
    const refusedFor = (r: string) =>
      run(dropped, [r, kept]).refused.map((line) => line.replace(/^REFUSED old tests: [^:]+: /, ""));
    expect(refusedFor(row(at("draws its rows"), "census", "dropped: Z70", "RETIRED"))).toEqual([
      'the holder "dropped: Z70": a ruling drops a behaviour or a look, never a census: its subject moves, or the census is said void',
    ]);
    expect(refusedFor(row(at("draws its rows"), "behaviour", "dropped: the sweep", "RETIRED"))).toEqual([
      'the holder "dropped: the sweep": the word after "dropped:" is no ruling\'s name',
    ]);
    const waits = (klass: string, holder: string) =>
      run({}, [row(at("draws its rows"), klass, holder, "WAITS:history"), kept]).refused.map((line) =>
        line.replace(/^REFUSED old tests: [^:]+: /, ""),
      );
    expect(waits("census", "mount-lists: retires with HistoryView: dropped: Z70")).toEqual([
      'the holder "mount-lists: retires with HistoryView: dropped: Z70": a ruling drops a behaviour or a look, never a census: its subject moves, or the census is said void',
    ]);
    expect(waits("markup", "mount-lists: retires with HistoryView: dropped: z70")).toEqual([
      'the holder "mount-lists: retires with HistoryView: dropped: z70": the word after "dropped:" is no ruling\'s name',
    ]);
    const red = [at("draws its rows"), "SCOPE", "history", "mount-lists", "its rows, drawn"].join("\t");
    const base = {
      rows: [row(at("draws its rows"), "behaviour", "mount-lists", "WAITS:history"), kept],
      neverRed: [red],
    };
    expect(
      run(
        {},
        [row(at("draws its rows"), "behaviour", "mount-lists: dropped: Z70", "WAITS:history"), kept],
        [],
        base,
      ).refused,
      "a never-red row leaves only with its case's row RETIRED",
    ).toEqual(["REFUSED never red: its rows, drawn: a never-red row never leaves (Q-6)"]);
  });

  it("refuses a holder written as it.todo, it.skip or it.fails, or under a skipped describe: no case that stands", () => {
    const gone = "apps/webapp/test/gone.test.tsx";
    const proof = `file\tkind\tholds\thome\ttask\tverdict\n${gone}\tbehaviour\tdraws\tlayer 1\tframe\tgone:${gone}\n`;
    const holding = (call: string, name: string) =>
      run(
        {
          [HISTORY]: `import { HistoryView } from "../${APP}/views/HistoryView";\ndescribe("History", () => {\n  it("lists the kept letters", () => {});\n  ${call};\n});\n`,
          "tools/retirement.tsv": proof,
        },
        [row(gone, "markup", `${HISTORY}#History > ${name}`, "RETIRED"), HISTORY_WAITS],
      ).refused;
    expect(holding('it("waits", () => {})', "waits"), "a case that stands").toEqual([]);
    expect(
      holding('describe.skipIf(!process.env.PG)("later", () => { it("waits", () => {}); })', "later > waits"),
      "a case run where its service is, as CI runs it, stands",
    ).toEqual([]);
    for (const [written, call, name] of [
      ["it.todo", 'it.todo("waits")', "waits"],
      ["it.skip", 'it.skip("waits", () => {})', "waits"],
      ["it.fails", 'it.fails("waits", () => {})', "waits"],
      ["test.fixme", 'test.fixme("waits", () => {})', "waits"],
      ["describe.skip", 'describe.skip("later", () => { it("waits", () => {}); })', "later > waits"],
    ])
      expect(holding(call, name), written).toEqual([
        `REFUSED old tests: ${gone}: its holder: ${HISTORY} holds "History > ${name}" only as ${written}: no case that stands`,
      ]);
  });

  it("refuses rows out of order and a row that is not five columns", () => {
    const quiet = row("apps/webapp/test/a.test.ts", "behaviour", "mount-lists", "WAITS:history");
    const result = run({ "apps/webapp/test/a.test.ts": 'it("a", () => {});\n' }, [
      HISTORY_WAITS,
      quiet,
      `${HISTORY_WAITS}\textra`,
    ]);
    expect(result.refused).toContain(
      "REFUSED old tests: the rows are not sorted by file and case, each once",
    );
    expect(result.refused).toContain(`REFUSED old tests: ${HISTORY}: a row has 5 columns`);
  });
});

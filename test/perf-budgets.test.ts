import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ONE TABLE OF CEILINGS, AND EVERY READER READS IT.
 *
 * Six readers have spelled a budget of their own. Three disagreed about the renderer at 0.17.0 and
 * none could know it; a candidate was read RED against one gate and well inside the contract the app
 * shipped with. The rules here hold `test/contracts/perf-budgets.json` to being the one place: the
 * SHAPE of a ceiling and of a latency budget, the DRIVE AND LOAD every renderer figure names, and the
 * SHELL declaring no ceiling of its own. The rules over the private readers — the documents, the
 * generated kit copy and the literal census — are `perf-budgets.docs.test.ts`.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TABLE = join(ROOT, "test/contracts/perf-budgets.json");

type Reading = { value: string; document: string; date: string; via?: string };
type Budget = {
  ceilingKb: number | null;
  state?: string;
  proposedKb?: number;
  retiredKb?: number;
  retiredBy?: string;
  excludedFrom?: string;
  why?: string;
  reading?: Reading | "unread";
  readings?: Reading[];
  drive?: string;
  load?: string;
  namedDrive?: boolean;
  unit?: string;
  goalKb?: number | null;
  goalState?: string;
  ruledBy?: string;
};
type Latency = {
  what?: string;
  state?: string;
  arm?: string;
  origin?: string | null;
  why?: string;
  ceilingMs?: number | null;
  goalMs?: number | null;
  p95Ms?: number;
  p99Ms?: number;
  maxCount?: number;
  readings?: Reading[];
  goalReading?: Reading;
};
type Table = {
  version: number;
  sizeClasses: Record<string, { messages: number; note?: string }>;
  surfaces: Record<string, { what: string; budgets: Record<string, Budget> }>;
  latency: Record<string, Latency | string[]>;
  contested: { reader: string; symbol: string; valueKb?: number; declaredKb?: number; spelling: string; state?: string; note?: string }[];
};

const table: Table = JSON.parse(readFileSync(TABLE, "utf8"));

const entries = (): [string, string, Budget][] =>
  Object.entries(table.surfaces).flatMap(([surface, s]) =>
    Object.entries(s.budgets).map(([cls, b]) => [surface, cls, b] as [string, string, Budget]),
  );

describe("the performance budgets are one table", () => {
  it("the largest size class is a property: one significant figure, and no class size in the contest's prose", () => {
    /* The large class sits beside a real corpus's size, so the table states it to one significant figure
       and names the classes in words where it reasons about them; the kit's class-for arms still hold. */
    const sizes = Object.values(table.sizeClasses).map((c) => c.messages).sort((a, b) => a - b);
    expect(String(sizes[sizes.length - 1]), "the largest class").toMatch(/^[1-9]0+$/);
    const contest = JSON.stringify((table.surfaces.engine as unknown as { contest?: unknown }).contest);
    /* A count of messages, not a size: a grouped number with no unit after it. */
    const large = [...contest.matchAll(/\b\d{1,3}(?:[ \u00a0]\d{3})+\b(?!\s?(?:kB|KB|MB|GB|ms|s)\b)/g)]
      .map((m) => Number(m[0].replace(/\D/g, ""))).filter((v) => v > 2 * sizes[sizes.length - 2]);
    expect(large.length, "the contest states the large class as a figure").toBe(0);
    expect(contest).toMatch(/the large corpus class/);
  });

  it("every stated ceiling cites the measurement it rests on, by document and date", () => {
    for (const [surface, cls, b] of entries()) {
      if (b.ceilingKb === null) continue;
      const where = `${surface}/${cls}`;
      expect(b.ceilingKb, `${where}: a ceiling of 0 or less`).toBeGreaterThan(0);
      const readings = b.readings ?? (b.reading && b.reading !== "unread" ? [b.reading] : []);
      expect(readings.length, `${where}: a ceiling with no reading is not a ceiling`).toBeGreaterThan(0);
      for (const r of readings) {
        expect(r.document, `${where}: a reading with no document`).toBeTruthy();
        expect(r.date, `${where}: a reading with no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(r.value, `${where}: a reading with no value`).toBeTruthy();
      }
    }
  });

  it("a ceiling nobody has measured is null, and says why in one of four words", () => {
    /* `owed` — the measurement does not exist yet. `proposed` — a number is on the table and the
       dispatcher has not ruled it. `retired` — it was a ceiling, it is history now, and the number
       is kept so a reader of an older run can still see what it was judged against. `excluded` — a
       class that is stated beside the figures and taken out of every comparison, and can never
       become a ceiling. Anything else is a state nobody can act on.

       THE READINGS RULE IS RELAXED FOR ONE NAMED CONSUMER and for no other: a row for a state of
       use that has NEVER been measured on that rig — a macOS floor, a Windows undriven reading —
       has no readings to state, and before this it could not be expressed at all, so the table was
       silent about the holes instead of naming them. Such a row says `"reading": "unread"` and
       still owes its `why`. Every other null ceiling still owes real readings. */
    let nulls = 0;
    let unreadRows = 0;
    for (const [surface, cls, b] of entries()) {
      if (b.ceilingKb !== null) continue;
      const where = `${surface}/${cls}`;
      expect(["owed", "proposed", "retired", "excluded"], `${where}: state '${b.state}'`).toContain(b.state);
      nulls += 1;
      expect(b.why, `${where}: a null ceiling with no reason`).toBeTruthy();
      if (b.reading === "unread") {
        unreadRows += 1;
        expect(b.state, `${where}: only an OWED row can be unread — the others have a number`).toBe("owed");
        expect(b.why!.length, `${where}: 'unread' with no reason is a guess wearing a word`).toBeGreaterThan(40);
      } else {
        expect((b.readings ?? []).length, `${where}: a null ceiling states no readings at all`).toBeGreaterThan(0);
      }
      if (b.state === "proposed") {
        expect(b.proposedKb, `${where}: proposed with no number`).toBeGreaterThan(0);
      }
      if (b.state === "retired") {
        expect(b.retiredKb, `${where}: retired with no number — the history is the point`).toBeGreaterThan(0);
        expect(b.retiredBy, `${where}: retired by nobody`).toBeTruthy();
      }
      if (b.state === "excluded") {
        expect(b.excludedFrom, `${where}: excluded from what?`).toBeTruthy();
        expect((b.readings ?? []).length, `${where}: excluded with nothing measured to exclude`).toBeGreaterThan(0);
      }
    }
    /* Each rule needs a subject, or it passes for a table where nobody would notice the day a bad
       row arrives. The engine's large class is owed by name; the renderer's retired steady pair and
       its unread platform rows are the others. */
    expect(nulls, "no null ceiling in the table — this rule has nothing to measure").toBeGreaterThan(0);
    expect(unreadRows, "no unread row — the relaxation above has nothing to measure").toBeGreaterThan(0);
  });

  it("a ruled ceiling carries its goal and who ruled it", () => {
    /* A ruled entry states the ceiling (what reddens a run), the goal (what a run is trying to get
       under — a different number, and a gate that read the goal would redden a build that is
       behaving as measured), and who ruled it, so a reader can go back to the decision rather than
       to the number.

       A goal is a RULING, not a reading, so a row may honestly have none yet: `goalState: "owed"`
       says so and `goalKb` stays null. The rule that bites is that a row may not carry a number
       under `goalKb` while claiming not to have one, or borrow a retired line's goal in silence. */
    const r = table.surfaces.renderer.budgets;
    for (const [cls, b] of Object.entries(r)) {
      if (b.state !== "ruled") continue;
      expect(b.ceilingKb, `renderer/${cls}: no ceiling`).toBeGreaterThan(0);
      expect(b.ruledBy, `renderer/${cls}: ruled by nobody`).toBeTruthy();
      const gs = b.goalState ?? "ruled";
      expect(["ruled", "owed"], `renderer/${cls}: goalState '${gs}'`).toContain(gs);
      if (gs === "owed") {
        expect(b.goalKb ?? null, `renderer/${cls}: a goal owed and a number under goalKb anyway`).toBeNull();
      } else {
        expect(b.goalKb, `renderer/${cls}: no goal`).toBeGreaterThan(0);
        expect(b.goalKb!, `renderer/${cls}: a goal above its own ceiling`).toBeLessThanOrEqual(b.ceilingKb!);
      }
    }
    expect(r["peak-first-sync"].ceilingKb).toBe(1433600);
    expect(r["peak-first-sync"].goalKb).toBe(1048576);

    /* THE RETIRED PAIR, PINNED AS HISTORY. The one-number steady line was retired on 2026-09-15:
       keyed on the MAILBOX, it passed or failed on how far the install had been driven and no row
       said. The numbers stay here so a reader of an older run still knows what it was judged
       against, and so a later lane cannot quietly revive one as a ceiling. */
    for (const cls of ["steady-75k", "steady-5k"]) {
      const b = r[cls];
      expect(b.state, `renderer/${cls}`).toBe("retired");
      expect(b.ceilingKb, `renderer/${cls}: a retired line still readable as a ceiling`).toBeNull();
      expect(b.goalKb ?? null, `renderer/${cls}: a retired line still readable as a goal`).toBeNull();
    }
    expect(r["steady-75k"].retiredKb).toBe(716800);
    expect(r["steady-5k"].retiredKb).toBe(665600);
  });

  it("every renderer row names its DRIVE and its LOAD", () => {
    /* MEASURED 2026-09-15, and the reason this rule exists at all: on ONE binary, ONE machine and
       ONE large corpus the renderer read far less resumed and driven through nothing than
       after thirty folder switches, and more again after thirty switches and twenty
       searches. Two honest instruments then read the same binary 367 MB apart, and the driving was
       the largest term in that gap — larger than the two distributions' Mesa and glibc put
       together. A renderer figure that does not say how far the app had been driven passes and
       fails the same install, so it is not a figure.

       The load is here for the same kind of reason: two arms of ONE configuration read tens of megabytes
       apart at 1-minute loads of 6.47 and 13.18, because the kernel reclaims clean pages from every
       resident process under memory pressure. `unread` is an honest answer where the reading
       predates the rule — with the reason, never the bare word. */
    for (const [cls, b] of Object.entries(table.surfaces.renderer.budgets)) {
      const where = `renderer/${cls}`;
      const stated = typeof b.ceilingKb === "number";
      const byDrive = /^(floor|loaded-undriven|driven)-/.test(cls);
      if (!stated && !byDrive) continue; /* the retired pair states no drive: that is why it is retired */
      for (const field of ["drive", "load"] as const) {
        const v = b[field];
        expect(typeof v, `${where}: no ${field}`).toBe("string");
        expect(v!.trim().length, `${where}: an empty ${field}`).toBeGreaterThan(0);
        /* A bare `unread` is a guess wearing a word. It carries what is unread and why. */
        expect(v!.trim().toLowerCase(), `${where}: ${field} is the bare word 'unread'`).not.toBe("unread");
        if (/unread|not applicable/i.test(v!)) {
          expect(v!.length, `${where}: '${field}' says unread with no reason`).toBeGreaterThan(30);
        }
      }
      if (stated) {
        expect(b.unit, `${where}: a number in no stated unit`).toBeTruthy();
      }
    }
  });

  it("a driven row says whether it is the NAMED drive, and the rasteriser class is stated apart", () => {
    /* The named drive is thirty folder switches then twenty searches. A driven row measured at some
       other drive is still a figure — it names what it was — but it is not comparable to the rows
       that used the named one, and a freeze that compared them would be reading two different
       states of use as a regression. So the row declares which it is, and a row that is not the
       named drive owes the reason. */
    let named = 0;
    let unnamed = 0;
    for (const [cls, b] of Object.entries(table.surfaces.renderer.budgets)) {
      if (!cls.startsWith("driven-")) continue;
      expect(typeof b.namedDrive, `renderer/${cls}: a driven row that does not say which drive`).toBe("boolean");
      if (b.namedDrive) named += 1;
      else {
        unnamed += 1;
        expect(b.why, `renderer/${cls}: a drive that is not the named one, with no reason`).toBeTruthy();
        expect(b.why!, `renderer/${cls}: the reason does not say it is not the named drive`).toMatch(/NOT the named/i);
      }
    }
    expect(named, "no row at the named drive — the rule has nothing to measure").toBeGreaterThan(0);
    expect(unnamed, "no row at another drive — the refusal has nothing to measure").toBeGreaterThan(0);

    /* Much of the difference between two honest readings was Mesa's VERSION, so the software
       rasteriser is stated beside the figures and excluded from every comparison between rigs. It
       lives as its own row and can never be read as a ceiling. */
    const ras = table.surfaces.renderer.budgets["rasteriser-class-linux"];
    expect(ras, "the rasteriser class has no row").toBeTruthy();
    expect(ras.state).toBe("excluded");
    expect(ras.ceilingKb).toBeNull();
    expect(ras.readings?.[0]?.value, "the rasteriser row states neither rig's figure").toMatch(/libLLVM/);
  });

  it("a proposed number is not a ceiling — no gate can read one by accident", () => {
    /* The whole failure this file exists for is a gate reading a number nobody ruled. A proposal
       lives under `proposedKb`, never under `ceilingKb`, so a reader that asks for the ceiling
       gets null and has to refuse. */
    for (const [surface, cls, b] of entries()) {
      if (b.state !== "proposed") continue;
      expect(b.ceilingKb, `${surface}/${cls}: a proposal wearing a ceiling`).toBeNull();
    }
  });

  it("the engine's contest states both cases with their origins, and picks neither", () => {
    /* THE OWNER READS THIS ONE. The plan asked for 400 MB flat; DESKTOP-MEMORY.md measured 450 MB
       settled at two levels, and every reading on record is above the plan. A lane that
       picked would be ruling, so the table carries both sides with what each rests on, and the test
       holds it to that: two cases, each with an origin, a document and a date, and a state that
       says out loud that nobody has picked. Row ENGINE-STEADY-CEILING-CONTESTED-400-VS-450-MB. */
    const c = (table.surfaces.engine as unknown as { contest?: Record<string, unknown> }).contest as
      | { state?: string; sides?: { case?: string; origin?: string; document?: string; date?: string; against?: string }[] }
      | undefined;
    expect(c, "the engine surface states no contest").toBeTruthy();
    expect(c!.state, "the contest does not say it is open and unpicked").toMatch(/open/i);
    expect(c!.sides?.length, "a contest with fewer than two sides is a decision").toBe(2);
    for (const side of c!.sides!) {
      expect(side.case, "a side with no case").toBeTruthy();
      expect(side.origin, `${side.case}: a side with no origin`).toBeTruthy();
      expect(side.document, `${side.case}: a side with no document`).toBeTruthy();
      expect(side.date, `${side.case}: a side with no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(side.against, `${side.case}: a side with nothing said against it is not a side`).toBeTruthy();
    }
  });

  it("every latency budget carries its shape, and an arm with no origin RECORDS", () => {
    /* THE LATENCY BLOCK HAD NO SHAPE TEST. It lives outside `surfaces`, which every rule above
       iterates, so a millisecond budget could ship with no state, no arm and no origin and nothing
       would say — which is how seven of them came to be quoted with no measurement behind any
       (SEVEN-LATENCY-BUDGETS-HAVE-NO-MEASUREMENT-BEHIND-THEM, PERF-BUDGETS-LATENCY-BLOCK-HAS-NO-SHAPE-TEST).

       The rule that bites is the last one: a `no-origin-yet` entry may only RECORD. An arm that
       reddens a build against a number nobody measured is the whole failure this table exists to
       remove, and it is the one a lane under time pressure would write. */
    let noOrigin = 0;
    let percentilePairs = 0;
    let noLineAtAll = 0;
    for (const [name, raw] of Object.entries(table.latency)) {
      if (name === "$comment") continue;
      const b = raw as Latency;
      const where = `latency/${name}`;
      expect(b.what, `${where}: a number with no subject`).toBeTruthy();
      expect(["measured", "no-origin-yet"], `${where}: state '${b.state}'`).toContain(b.state);
      expect(["decides", "records"], `${where}: arm '${b.arm}'`).toContain(b.arm);
      expect("origin" in b, `${where}: no origin field at all — absent is not null`).toBe(true);

      const numbers = (["ceilingMs", "goalMs", "p95Ms", "p99Ms"] as const)
        .map((k) => b[k])
        .filter((v): v is number => typeof v === "number");
      for (const v of numbers) expect(v, `${where}: a duration of 0 or less`).toBeGreaterThan(0);
      /* A row may honestly have NO LINE AT ALL — nothing pins how long a schema upgrade may take,
         and a number invented for it would be exactly what this block is being cleaned of. That
         state is `ceilingMs: null` under `no-origin-yet`, stated rather than left absent: an absent
         field and a null one are different answers ("never supplied" against "no line yet"), and a
         rule that accepted absence would accept a row somebody forgot to finish. */
      const numberless = numbers.length === 0 && typeof b.maxCount !== "number";
      if (numberless) {
        expect("ceilingMs" in b, `${where}: no numbers and no ceilingMs field — absent is not null`).toBe(true);
        expect(b.ceilingMs, `${where}: no numbers, and ceilingMs is not null`).toBeNull();
        expect(b.state, `${where}: a row with no line at all that claims to be measured`).toBe("no-origin-yet");
        noLineAtAll += 1;
      }
      if (typeof b.p95Ms === "number" && typeof b.p99Ms === "number") {
        percentilePairs += 1;
        expect(b.p99Ms, `${where}: a p99 below its own p95`).toBeGreaterThanOrEqual(b.p95Ms);
      }

      if (b.state === "no-origin-yet") {
        noOrigin += 1;
        expect(b.origin ?? null, `${where}: no-origin-yet with an origin anyway`).toBeNull();
        expect(b.arm, `${where}: no origin, and the arm DECIDES — it may only record`).toBe("records");
        expect((b.why ?? "").length, `${where}: no-origin-yet with no reason a person can check`).toBeGreaterThan(40);
      } else {
        expect(typeof b.origin, `${where}: measured, and the origin is not a named run`).toBe("string");
        expect((b.origin as string).trim().length, `${where}: measured with an empty origin`).toBeGreaterThan(0);
        expect((b.readings ?? []).length, `${where}: measured with nothing measured`).toBeGreaterThan(0);
      }
      /* A reading of how long something takes is not a measurement of what it is ALLOWED to take,
         so readings never promote a row — but a reading with no document is still not a reading. */
      for (const r of b.readings ?? []) {
        expect(r.value, `${where}: a reading with no value`).toBeTruthy();
        expect(r.document, `${where}: a reading with no document`).toBeTruthy();
        expect(r.date, `${where}: a reading with no date`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    }
    /* Each rule needs a subject. The seven plan-line budgets are the no-origin ones; `open-message`
       is the percentile pair. Without these the rules above would pass for an empty block. */
    expect(noOrigin, "no entry without an origin — that rule has nothing to measure").toBeGreaterThan(0);
    expect(percentilePairs, "no p95/p99 pair — that rule has nothing to measure").toBeGreaterThan(0);
    expect(noLineAtAll, "no row without a line at all — that relaxation has nothing to measure").toBeGreaterThan(0);
  });

  it("the view-switch row names its harness and fixture, and every reading its engine and presses", () => {
    /* THE SWITCH IS MEASURED BY A HARNESS IN THE REPOSITORY (`scripts/perf/view-switch.mjs`), PER
       ENGINE, AND A READING WITHOUT ITS ENGINE, ITS PRESS COUNT OR ITS FIXTURE IS A NUMBER NOBODY CAN
       RUN AGAIN. The lines are medians; each reading carries its median and p90, and a p90 below its
       median is a typo the row would otherwise publish. Counts (frames at entry, sanitize passes,
       link batches, requests) are not durations and are held by tests, not here. */
    type Line = Partial<Record<"webkit" | "chromium" | "desktop", { medianMs?: number; p50Ms?: number; p95Ms?: number }>>;
    type SwitchReading = Reading & { line?: string; engine?: string; presses?: number; arm?: string; medianMs?: number; p90Ms?: number };
    const b = table.latency["view-switch"] as Latency & {
      harness?: string; fixture?: string; lines?: Record<string, Line & { what?: string }>;
      readings?: SwitchReading[];
    };
    expect(b.harness, "the row does not name the harness that reads it").toBe("scripts/perf/view-switch.mjs");
    expect(readFileSync(join(ROOT, b.harness!), "utf8")).toMatch(/export async function runArm/);
    expect(b.fixture ?? "", "the row does not name its fixture").toMatch(/3000.*2000.*1000/);
    const lines = Object.entries(b.lines ?? {});
    expect(lines.length, "no lines — the rules below would pass for an empty row").toBeGreaterThan(4);
    for (const [name, line] of lines) {
      expect(line.what, `view-switch/${name}: a line with no subject`).toBeTruthy();
      const engines = Object.keys(line).filter((k) => k !== "what");
      expect(engines.length, `view-switch/${name}: a line with no engine`).toBeGreaterThan(0);
      for (const e of engines) {
        expect(["webkit", "chromium", "desktop"], `view-switch/${name}: engine '${e}'`).toContain(e);
        const v = line[e as "webkit"]!;
        const nums = [v.medianMs, v.p50Ms, v.p95Ms].filter((x): x is number => typeof x === "number");
        expect(nums.length, `view-switch/${name}/${e}: no number`).toBeGreaterThan(0);
        for (const x of nums) expect(x, `view-switch/${name}/${e}: a duration of 0 or less`).toBeGreaterThan(0);
      }
    }
    const measured = (b.readings ?? []).filter((r) => r.line !== undefined);
    expect(measured.length, "no harness reading at all").toBeGreaterThan(0);
    for (const r of measured) {
      const where = `view-switch reading ${r.line}/${r.engine}/${r.arm}`;
      expect(b.lines?.[r.line!], `${where}: names a line the row does not have`).toBeDefined();
      expect(["webkit", "chromium", "desktop"], `${where}: engine`).toContain(r.engine);
      expect(["base", "head"], `${where}: arm`).toContain(r.arm);
      expect(r.presses ?? 0, `${where}: fewer than ten presses`).toBeGreaterThanOrEqual(r.engine === "desktop" ? 40 : 10);
      expect(typeof r.medianMs, `${where}: no median`).toBe("number");
      expect(typeof r.p90Ms, `${where}: no p90`).toBe("number");
      expect(r.medianMs!, `${where}: a median above its own p90`).toBeLessThanOrEqual(r.p90Ms!);
    }
    /* Each harness line is read on both arms, for each engine it states: the before beside the after. */
    for (const [name, line] of lines) {
      for (const e of Object.keys(line).filter((k) => k !== "what" && k !== "desktop")) {
        for (const arm of ["base", "head"]) {
          expect(measured.some((r) => r.line === name && r.engine === e && r.arm === arm), `view-switch/${name}/${e}: no ${arm} reading`)
            .toBe(true);
        }
      }
    }
  });

  it("the desktop shell reads the ceiling and spells none of its own", () => {
    /* THE FOURTH READER, and the one a person actually sees: `vitals.rs` declared a ceiling of its own to
       itself in every `renderer_vitals` line while two gates read another. It re-exports the
       generated constant now, so the number in the log is the number this table states.

       Read as TEXT because this host has no Rust toolchain. The needle is the line that DECIDES —
       the declaration — never a comment, so a reworded docblock cannot redden it and a literal put
       back cannot pass it. */
    const vitals = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/vitals.rs"), "utf8");
    const main = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/main.rs"), "utf8");
    const generated = readFileSync(join(ROOT, "apps/desktop/src-tauri/src/perf_budgets.rs"), "utf8");

    expect(vitals, "vitals.rs no longer re-exports the generated ceiling").toContain(
      "pub use crate::perf_budgets::RENDERER_BUDGET_KB;",
    );
    const code = vitals
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("//"))
      .join("\n");
    expect(code, "vitals.rs declares a renderer ceiling of its own again").not.toMatch(
      /const\s+RENDERER_BUDGET_KB/,
    );
    expect(main, "main.rs does not compile the generated module — vitals.rs would not build").toMatch(
      /mod perf_budgets;/,
    );

    const ruled = table.surfaces.renderer.budgets["peak-first-sync"].ceilingKb!;
    const declared = /RENDERER_BUDGET_KB: u64 = ([0-9_]+);/.exec(generated)?.[1]?.replace(/_/g, "");
    expect(Number(declared), "the shell declares a ceiling this table does not state").toBe(ruled);
  });
});

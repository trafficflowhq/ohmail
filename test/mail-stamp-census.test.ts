import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * ═══ THE MAIL STAMP IS DECIDED IN ONE PLACE, AND THIS IS WHAT MAKES THAT A FACT ═══════════
 *
 * "When did this arrive" is answered on six surfaces that share no renderer: the browser's list
 * rows and its open message, the desktop's (the same shell), the phone's rows, its open message,
 * and the earlier messages inside a thread. The rule they answer with — today shows a clock, the
 * last six days show a weekday and a clock, beyond that a date — lives in exactly one module,
 * `packages/client-engine/src/stamp.ts`.
 *
 * IT DID NOT USED TO. A time of day was composed in seven places across three packages and the
 * copies had already drifted: two asked `Intl` for `hour12: false`, which is not a synonym for a
 * 24-hour clock and renders midnight as "24:10" on some ICU builds; six carried a hand-written
 * repair for that and the seventh did not, and that same seventh read the BROWSER's zone rather
 * than the reader's — so it was the one stamp in the product that could disagree with the stamps
 * directly beside it about what time it was. Consolidating them was a whole slice of work.
 *
 * Nothing kept them consolidated. That is this file.
 *
 * ── TWO HALVES, AND THE SECOND IS THE ONE THAT CATCHES THE NEXT COPY ────────────────────────
 *
 * **Half A** asserts the doors REACH for the shared rule — each one imports it and renders what
 * it returns. That half can only ever be satisfied by a door that already behaves; it cannot see
 * a door that ALSO formats a date of its own on the side.
 *
 * **Half B** is the census proper: every date-formatting call in the three trees a mail stamp
 * could hide in, counted per file and pinned below with a reason. Adding one turns this red and
 * the author has to come here and say which kind it is, rather than quietly shipping an eighth
 * copy. Removing one turns it red too — a pin that only ever grows is a pin nobody trims.
 *
 * The pinned entries are all NON-mail dates, and that is the whole point: after the consolidation
 * there is no mail-date formatter outside `stamp.ts`, so the correct count for that kind is zero
 * and any new one is the regression. A calendar invitation's event time, a billing period's end,
 * a date picker's month names and the send-later day rows are different questions about different
 * instants, and they are allowed to answer them themselves.
 *
 * ── TWO DEFENCES AGAINST FIRING ON INNOCENT CONTENT, AND THEY COVER DIFFERENT CASES ─────────
 *
 * A guard that fires on innocent content is the same failure as one that cannot fire, and dearer,
 * because it discards real work. Several files here DISCUSS these APIs: `locale.ts` explains why
 * account dates go through `toLocaleDateString` while mail stamps do not, `RulesView` says its
 * date is "deliberately not `toLocaleDateString`", and `MessageActions` names `toDateString()`
 * with its parentheses as the fallback it uses.
 *
 * Which defence actually catches what was MEASURED rather than assumed, and the first guess was
 * wrong — so, precisely:
 *
 *  1. **Call-shape anchoring** carries all three of those. Every pattern requires a receiver (`.`
 *     or `Intl.`) and an opening paren, and prose writes these names in backticks with neither.
 *     Counted raw, `RulesView` yields nothing and `MessageActions` yields exactly its two real
 *     calls — the `toDateString()` in its comment does not match, because a backtick is not a dot.
 *  2. **{@link stripComments}** carries the case anchoring cannot see: real code that has been
 *     COMMENTED OUT. `// return d.toLocaleDateString(locale);` is a perfect call shape, and a
 *     line like it is one keystroke away in any file here. It also keeps Half A's delegation
 *     regex honest — a doc comment between `{` and `return` would otherwise break the match and
 *     fail a door that behaves.
 *
 * `locale.ts` is carried by NEITHER: its two hits are real `Intl.DateTimeFormat()` calls, and what
 * exempts them is {@link PLATFORM_QUERY} — they ask the platform for its zone and format nothing.
 *
 * Each of the three has its own control below, from both sides.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** The one module that decides a mail stamp. */
const RULE_FILE = "packages/client-engine/src/stamp.ts";
/** The name the doors reach for — `stamp.ts#messageStamp`, re-exported by `selectors.ts`. */
const RULE_EXPORT = "messageDisplayTime";

/* ── HALF A: THE DOORS REACH FOR THE RULE ─────────────────────────────────────────────────── */

describe("every door renders the shared mail stamp", () => {
  it("the rule lives in one module, and it is the module this census names", () => {
    const src = read(RULE_FILE);
    expect(src).toContain("export function messageStamp(");
    // The three bands, as the code spells them. A cutoff edited here without the tests in
    // `packages/client-engine/test/display-time.test.ts` moving is the change this pins.
    expect(src).toContain("if (ago === 0) return clock(d, zone);");
    expect(src).toContain("if (ago >= 1 && ago <= 6) return weekdayClock(d, zone, locale);");
  });

  it("`messageDisplayTime` is that function and not a second one", () => {
    const src = read("packages/client-engine/src/selectors.ts");
    /* A memo per entity over the rule: its body computes nothing but the rule's answer, keyed on
       the reader's day, zone and language. A second implementation here would format itself. */
    const at = src.indexOf(`export function ${RULE_EXPORT}(`);
    expect(at, "the door's name is gone from selectors.ts").toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toContain("const out = messageStamp(m, now, zone, locale);");
    expect(formattersIn(stripComments(body)), "the memo formats a date itself").toEqual([]);
  });

  it("THE BROWSER AND DESKTOP SHELL delegates its row stamp to the rule", () => {
    const src = stripComments(read("apps/webapp/app/shell/format.ts"));
    expect(src).toContain(RULE_EXPORT);
    // Not merely imported: `displayTime` is the app-side name every view calls, and it must be a
    // delegation rather than a reimplementation that happens to sit next to the import.
    expect(src).toMatch(
      /export function displayTime\([^)]*\)[^{]*\{\s*return messageDisplayTime\(/,
    );
  });

  it("THE READING HEADER in the shell renders that same stamp", () => {
    // The open message and the row it was opened from must agree; they do so by calling one
    // function, not by two functions that currently produce the same string.
    const src = stripComments(read("apps/webapp/app/shell/MessageCard.tsx"));
    expect(src).toContain("displayTime(message, now)");
  });

  it("THE PHONE's rows, open message and thread history all render that stamp", () => {
    const src = stripComments(read("apps/mobile/src/state/live.ts"));
    expect(src).toContain(RULE_EXPORT);
    /* Four call sites, and the count is the assertion: the row projection, the thread's earlier
       messages, the Trash page's deleted-at stamp and the draft's last-edited stamp. The Screener
       row for a sender the store names and the mirror cannot back is minted by the shared selector
       now, which reads the same function (asserted below). The resurface stamp is a SET TIME and
       reads `setTimeLabel`. A screen that formats a date itself leaves this at four while the
       phone shows a shape nothing else in the product can produce. */
    expect(countOf(src, `${RULE_EXPORT}(`)).toBe(4);
    const selector = stripComments(read("packages/client-engine/src/selectors.ts"));
    expect(selector).toMatch(/function storeRow\([\s\S]*?\{[\s\S]*?messageDisplayTime\(/);
  });

  it("the phone's SCREENS hold no date formatting of their own — they render what the state gave them", () => {
    // `MailRow` and the message screen print `m.time`/`h.time` verbatim. If either ever formats an
    // instant itself, that is a second rule on a surface that shares no code with the first.
    for (const f of ["apps/mobile/src/ui/MailRow.tsx", "apps/mobile/app/message/[id].tsx"]) {
      expect(formattersIn(stripComments(read(f))), `${f} must not format a date itself`).toEqual([]);
    }
  });
});

/* ── HALF B: THE CENSUS ───────────────────────────────────────────────────────────────────── */

/** The trees a mail stamp could hide in — every surface that renders a message. */
const TREES = ["apps/webapp/app", "packages/ui/src", "apps/mobile/src", "apps/mobile/app"];

/**
 * EVERY date-formatting call in those trees, by file, with the kind it is.
 *
 * A file absent from here must contain none. `why` is not decoration: it is the sentence the next
 * author has to be able to write about their new formatter before this file lets them add one, and
 * writing it is the moment they discover a mail stamp belongs in `stamp.ts` instead.
 */
const PINNED: Record<string, { calls: number; why: string }> = {
  "packages/ui/src/format/file-size.ts": {
    calls: 1,
    why: "Not a date at all: `toLocaleString` on a NUMBER, which is how a file size reaches a "
      + "German sentence without its decimal point reading as a thousands separator. The census "
      + "keys on the method name, and this is the one caller that formats a size with it.",
  },
  "apps/mobile/src/state/live.ts": {
    calls: 2,
    why: "`calendarDayLabel` and its no-ICU fallback — a WEEKDAY AND MONTH label for the two "
      + "surfaces that name days, the resurface chooser and the away responder's end date. The "
      + "phone's own zone read uses the same constructor and formats nothing. Every message stamp "
      + "in this file goes through the rule; neither of these is a message's date.",
  },
  "apps/mobile/src/ui/day-stamp.ts": {
    calls: 2,
    why: "The phone twin of `format.ts`'s `dayStamp`, and pinned for the same reason: the day a "
      + "standing fact became true — a closure's date on the wall and its strips — with no clock "
      + "on it. Its second call is the reduced-ICU fallback on a runtime that refuses the locale.",
  },
  "apps/webapp/app/shell/format.ts": {
    calls: 2,
    why: "`agoStamp`'s absolute tooltip (when a MAILBOX last synced) and `dayStamp` (the day a "
      + "standing fact became true, deliberately with no clock on it). Neither is a message's date.",
  },
  "apps/webapp/app/shell/AppShell.tsx": {
    calls: 1,
    why: "`holderSince` — the day an install became a mailbox's organizer. An account date.",
  },
  "apps/webapp/app/(product)/mailbox/AboutSection.tsx": {
    calls: 1,
    why: "A build/version date in the About pane. An account-and-app date, not mail.",
  },
  "packages/ui/src/primitives/DatePicker.tsx": {
    calls: 3,
    why: "The picker's own month and weekday NAMES for a calendar grid — a date being chosen, "
      + "never a date being reported.",
  },

  /* `toLocaleString` ON A NUMBER. It cannot be told from the date form without types, and it is
     kept in the detector rather than excluded BECAUSE of that: pinning the count here means the
     day one of these files formats an instant instead of a byte count, the number moves and this
     census asks why. Both are thousands separators. */
  "apps/webapp/app/shell/storage-state.ts": {
    calls: 1,
    why: "A NUMBER, not a date — a byte figure in the reader's digit grouping. No pane calls it "
      + "now; the file's own header says why it stays.",
  },
};

describe("nothing outside the rule formats a mail date", () => {
  it("the census is complete and current — every formatter in the three trees is pinned", () => {
    const found = new Map<string, string[]>();
    for (const tree of TREES) {
      for (const file of walk(tree)) {
        const hits = formattersIn(stripComments(readFileSync(join(ROOT, file), "utf8")));
        if (hits.length > 0) found.set(file, hits);
      }
    }

    /* Reported as sorted name lists rather than one boolean, so a failure NAMES the file and the
       call instead of saying a number changed. */
    const unpinned = [...found.keys()].filter((f) => !(f in PINNED)).sort();
    expect(unpinned, "new date formatting outside `stamp.ts` — classify it in PINNED above, and if "
      + "it is a MAIL stamp it belongs in the rule instead").toEqual([]);

    const gone = Object.keys(PINNED).filter((f) => !found.has(f)).sort();
    expect(gone, "PINNED names files that no longer format a date — trim the entry").toEqual([]);

    const miscounted = [...found].filter(([f, hits]) => hits.length !== PINNED[f]!.calls)
      .map(([f, hits]) => `${f}: pinned ${PINNED[f]!.calls}, found ${hits.length} (${hits.join(", ")})`)
      .sort();
    expect(miscounted, "a formatter was added or removed in a file already pinned").toEqual([]);
  });

  it("every pinned entry says WHY, in a sentence", () => {
    // A pin with an empty reason is the pin growing without anybody deciding anything.
    for (const [file, entry] of Object.entries(PINNED)) {
      expect(entry.calls, `${file} pins a non-positive count`).toBeGreaterThan(0);
      expect(entry.why.length, `${file} needs a reason`).toBeGreaterThan(40);
    }
  });

  /**
   * THE POSITIVE CONTROL. A census whose every assertion is "found nothing" has no evidence it can
   * find anything — the detector could have been broken by a rename and would report the same
   * clean sweep for ever.
   */
  it("the detector FINDS a mail-date formatter when there is one", () => {
    // The planted import line is joined when the case runs, so an import scanner reading this file finds no package.
    const importLine = (spec: string) => `import { x } from ${JSON.stringify(spec)};`;
    const planted = `
      ${importLine("y")}
      function rowTime(m: { date: string }): string {
        return new Date(m.date).toLocaleTimeString("en", { hour: "2-digit" });
      }
    `;
    expect(formattersIn(stripComments(planted))).toEqual(["toLocaleTimeString"]);

    // And each spelling it is responsible for, so a partial rename cannot pass.
    expect(formattersIn("a.toLocaleDateString(l)")).toEqual(["toLocaleDateString"]);
    expect(formattersIn("new Intl.DateTimeFormat(l)")).toEqual(["Intl.DateTimeFormat"]);
    expect(formattersIn("d.toDateString()")).toEqual(["toDateString"]);
    expect(formattersIn("d.toLocaleString(l, o)")).toEqual(["toLocaleString"]);
  });

  /**
   * NEGATIVE CONTROL 1 — an API NAMED in prose. Carried by the call-shape anchoring, so this is
   * asserted on the RAW text: it must hold whether or not comments were stripped first.
   */
  it("the detector does NOT fire on an API named in prose, stripped or not", () => {
    const prose = "/** deliberately not `toLocaleDateString`; `toDateString()` is the last resort */\n"
      + "const a = 1;\n";
    expect(formattersIn(prose), "raw — the anchoring alone must carry this").toEqual([]);
    expect(formattersIn(stripComments(prose))).toEqual([]);

    // The real file that provoked it, read as it is on disk, with comments intact.
    const rules = read("apps/webapp/app/views/RulesView.tsx");
    expect(formattersIn(rules), "RulesView only MENTIONS a formatter").toEqual([]);
    /* A FILE THAT BOTH MENTIONS AND USES THEM, AND WHOSE MENTION HAS PARENTHESES. This was
       `MessageActions` until 0.22 moved its stamps behind the shared rule and left it with no
       formatter at all — a control whose subject lost the property under test, which is the one
       way a control goes quiet without failing. Built here instead, so no lane's cleanup can
       hollow it out: raw and stripped must agree at the USED count, or the mention is being
       counted. */
    const both = "/** deliberately not `toLocaleDateString()` — see the rule */\n"
      + "const a = d.toLocaleDateString();\nconst b = d.toLocaleTimeString();\n";
    expect(formattersIn(both).length, "the mention is being counted").toBe(2);
    expect(formattersIn(stripComments(both)).length, "a real use was lost with the comment").toBe(2);
  });

  /**
   * NEGATIVE CONTROL 2 — real code COMMENTED OUT, which is the case the anchoring cannot see and
   * the only reason {@link stripComments} is here. Without it this census would refuse a file for
   * a line that never runs.
   */
  it("a commented-OUT formatter is not a formatter, and only stripping can tell", () => {
    const dead = "// return d.toLocaleDateString(locale);\nconst x = 1;\n";
    expect(formattersIn(dead), "raw — the anchoring matches it, which is why stripping exists")
      .toEqual(["toLocaleDateString"]);
    expect(formattersIn(stripComments(dead)), "stripped — it does not run, so it does not count")
      .toEqual([]);

    const deadBlock = "/* const s = new Intl.DateTimeFormat(l).format(d); */\nconst y = 2;\n";
    expect(formattersIn(deadBlock)).toEqual(["Intl.DateTimeFormat"]);
    expect(formattersIn(stripComments(deadBlock))).toEqual([]);
  });

  /**
   * The exclusion above, driven from BOTH sides — the shape that must be ignored and the shape
   * that must not. Without the second half the exclusion could swallow every construction and the
   * census would report a clean sweep for ever.
   */
  it("asking the platform for its zone is not formatting, but constructing a formatter is", () => {
    expect(formattersIn("const z = Intl.DateTimeFormat().resolvedOptions().timeZone;")).toEqual([]);
    expect(formattersIn("normalizeLocale(Intl.DateTimeFormat().resolvedOptions().locale)")).toEqual([]);
    expect(formattersIn("new Intl.DateTimeFormat(l, o).format(d)")).toEqual(["Intl.DateTimeFormat"]);
    // A query beside a real formatter still leaves the real one visible.
    expect(formattersIn(
      "const z = Intl.DateTimeFormat().resolvedOptions().timeZone;\n"
      + "const s = new Intl.DateTimeFormat(l, { timeZone: z }).format(d);",
    )).toEqual(["Intl.DateTimeFormat"]);
  });

  /**
   * The two files that FEED the shared rule hold no formatter of their own. This is the assertion
   * the `resolvedOptions` exclusion exists for: both were on the census's first failing run, and a
   * census that lists its own zone seams as bypassers is worse than no census.
   */
  it("the zone and locale seams resolve a setting — they format nothing", () => {
    for (const f of ["apps/webapp/app/shell/locale.ts", "apps/mobile/src/i18n/locale.ts"]) {
      expect(formattersIn(stripComments(read(f))), `${f} resolves, never formats`).toEqual([]);
    }
  });

  it("stripComments keeps code and drops comments, including a `//` inside a URL", () => {
    expect(stripComments("const u = \"https://a.example/b\"; // note\nconst v = 2;"))
      .toContain("https://a.example/b");
    expect(stripComments("const u = \"https://a.example/b\"; // note\nconst v = 2;"))
      .not.toContain("note");
    expect(stripComments("/* a */ const x = 1; /* b */")).not.toContain("a");
    expect(stripComments("/* a */ const x = 1; /* b */")).toContain("const x = 1;");
  });
});

/* ── THE DETECTOR ─────────────────────────────────────────────────────────────────────────── */

/**
 * The spellings that turn an instant into text for a reader, each anchored at a CALL — the `(` is
 * what separates using one from naming one. `Intl.RelativeTimeFormat` is deliberately absent: it
 * says "2 minutes ago" about a sync, never a mail stamp, and `stamp.ts` does not produce one.
 */
const FORMATTERS: ReadonlyArray<readonly [string, RegExp]> = [
  ["Intl.DateTimeFormat", /\bIntl\s*\.\s*DateTimeFormat\s*\(/g],
  ["toLocaleDateString", /\.\s*toLocaleDateString\s*\(/g],
  ["toLocaleTimeString", /\.\s*toLocaleTimeString\s*\(/g],
  ["toLocaleString", /\.\s*toLocaleString\s*\(/g],
  ["toDateString", /\.\s*toDateString\s*\(/g],
  ["toTimeString", /\.\s*toTimeString\s*\(/g],
];

/**
 * ASKING THE PLATFORM WHERE IT IS, which formats nothing and must not be counted.
 *
 * `Intl.DateTimeFormat().resolvedOptions().timeZone` is how both doors discover the reader's zone
 * — `apps/webapp/app/shell/locale.ts#activeFormatZone` and `apps/mobile/src/state/live.ts` — and
 * `.resolvedOptions().locale` is how the phone reads the platform language. They construct a
 * formatter and never format with it. Counting them would have put the two files that FEED the
 * shared rule on a list of files that bypass it, which is the census saying the opposite of the
 * truth about its own most important callers.
 *
 * Matched by the `.resolvedOptions()` that immediately follows, so a formatter that is constructed
 * and later used is untouched. The argument list is `[^()]*` because every real query passes none;
 * a query with a nested call in its arguments would simply be counted, which is the safe direction.
 */
const PLATFORM_QUERY = /\bIntl\s*\.\s*DateTimeFormat\s*\([^()]*\)\s*\.\s*resolvedOptions\s*\(/g;

/** Every formatting call in `src`, one entry per call, in the order the names are listed. */
function formattersIn(src: string): string[] {
  const code = src.replace(PLATFORM_QUERY, "");
  const out: string[] = [];
  for (const [name, re] of FORMATTERS) {
    const n = countOf(code, re);
    for (let i = 0; i < n; i += 1) out.push(name);
  }
  return out;
}

function countOf(src: string, needle: string | RegExp): number {
  if (typeof needle === "string") return src.split(needle).length - 1;
  return (src.match(needle) ?? []).length;
}

/**
 * Code with comments blanked out. Not a parser: it tracks strings and template literals so a `//`
 * inside one survives, which is the only case that matters here (URLs, and the message catalogue's
 * own text). Regex literals are not tracked — a `//` cannot appear in one, and a `/* ` inside one
 * would be a division followed by a comment to any reader too.
 */
function stripComments(src: string): string {
  let out = "";
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    const next = src[i + 1];
    if (c === "/" && next === "/") {
      while (i < src.length && src[i] !== "\n") i += 1;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (c === "\"" || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i += 1;
      while (i < src.length) {
        const s = src[i]!;
        out += s;
        i += 1;
        if (s === "\\") { out += src[i] ?? ""; i += 1; continue; }
        if (s === quote) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** Every `.ts`/`.tsx` file under `rel`, repo-relative, excluding generated and vendored trees. */
function walk(rel: string): string[] {
  const skip = new Set(["node_modules", "dist", ".next", "build", ".git", "coverage", "__snapshots__"]);
  const out: string[] = [];
  const visit = (dir: string): void => {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (skip.has(name)) continue;
      const child = join(dir, name);
      if (statSync(join(ROOT, child)).isDirectory()) { visit(child); continue; }
      if (/\.tsx?$/.test(name) && !/\.d\.ts$/.test(name)) out.push(relative(".", child));
    }
  };
  visit(rel);
  return out.sort();
}

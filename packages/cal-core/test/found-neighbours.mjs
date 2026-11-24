// The found events' neighbourhood, read on two heads: every letter whose reading differs is listed, and
// beside it every letter whose reading is wrong whatever the head before read.
//
//   node packages/cal-core/test/found-neighbours.mjs <before> [<after>] [--wide] [--out <file>]
//   node packages/cal-core/test/found-neighbours.mjs --alone [<head>] [--wide] [--out <file>]
//
// <before> and <after> are each a commit (read from this repository with `git archive`, no network)
// or a folder that holds cal-core's `src`; <after> is this worktree's own `src` when left out. With
// `--alone` one head is read (the worktree's when none is named) and only the absolute lines are listed.
//
// The letters are generated, not picked. The quick form (under a minute): every clock form below (a
// lone hour, minutes by colon and by stop, am and pm, Uhr, noon; a range by each dash, spaced and not,
// by each range word, after "from" and "between", with each end form), alone, behind a number and a
// dash ("Raum 5 – 14–16 Uhr") and behind "to" / "bis" ("up to 5pm"), placed after every table of
// lexicon.ts (the first and the last word of each, and no word), in a sentence with a whole date and in
// one with a weekday, with and without a later clock, in both languages; and the same clocks behind a
// word the lexicon does not hold and a place word, behind "14 – ", "5 – ", "5-" and "1–2 – ", with the
// clock before the day too. The wide form (`--wide`, minutes) adds every word of every table, words the
// lexicon does not hold, fourteen number prefixes and pairs ("5: ", "12 – ", "5 to ", "1-2 - " …), eight
// sentence shapes (the clock before the day, tomorrow, a short date, two sentences, a line break …) and
// an unlabelled later clock and an earlier one.
//
// Both forms also stand the day between two clocks: the clock before the day and a tail after it
// ("Workshop 9 - 11am on Saturday, 21 November 2026, drinks at 8pm."), with a whole date, a weekday
// and a relative day.
//
// The absolute lines: the generator knows what it placed, so a letter whose offered start is its END
// face, or the number it placed after a place word or a word the lexicon does not hold, or a tail's
// clock while it placed a start of its own beside the day (no tail between them; a clock that reads as
// one, after no word, a word the lexicon does not hold or a place word, behind no end word: "another
// clock as the start"; a tail labelled as the start, "start 6pm" or "Beginn 18 Uhr", is the event's
// start by its word and is not counted), is listed on the head after (or the one head) whatever the
// head before read.
//
// Every difference is judged by what the head BEFORE read: each reading is classed by its offered start
// against what was placed (the placed start, the placed end, a placed number, another clock of the
// sentence, a clock not placed, no clock), and a difference that gains a clock, moves the start to the
// placed end or a placed number, or moves it from the placed start to another clock is a FAULT; one
// whose start is a clock not placed is a LOOK. A builder runs both forms before a push and judges every
// FAULT, every LOOK and every absolute line; it is no test.
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, writeSync } from "node:fs";
import { register } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The sources import "./x.js" for "./x.ts": node strips the types, this hook finds the file.
register(
  "data:text/javascript," +
    encodeURIComponent(`
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
export async function resolve(spec, ctx, next) {
  if ((spec.startsWith("./") || spec.startsWith("../")) && spec.endsWith(".js") && ctx.parentURL?.startsWith("file:")) {
    const ts = new URL(spec.slice(0, -3) + ".ts", ctx.parentURL);
    if (!existsSync(fileURLToPath(new URL(spec, ctx.parentURL))) && existsSync(fileURLToPath(ts))) return next(ts.href, ctx);
  }
  return next(spec, ctx);
}`),
);

const here = dirname(fileURLToPath(import.meta.url));
const pkg = resolve(here, "..");
const args = process.argv.slice(2);
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? args[outAt + 1] : null;
const wide = args.includes("--wide");
const alone = args.includes("--alone");
const heads = args.filter((a, i) => !a.startsWith("--") && (outAt < 0 || i !== outAt + 1));
if (alone ? heads.length > 1 : heads.length < 1 || heads.length > 2) {
  console.error(
    "usage: node packages/cal-core/test/found-neighbours.mjs <before> [<after>] [--wide] [--out <file>]\n" +
      "       node packages/cal-core/test/found-neighbours.mjs --alone [<head>] [--wide] [--out <file>]",
  );
  process.exit(2);
}

/** A head's `src` folder: a folder as given, or a commit unpacked once under the system's temp folder. */
function srcOf(head) {
  if (existsSync(join(head, "found", "rules.ts"))) return resolve(head);
  if (existsSync(join(head, "src", "found", "rules.ts"))) return resolve(head, "src");
  if (existsSync(join(head, "packages", "cal-core", "src", "found", "rules.ts")))
    return resolve(head, "packages", "cal-core", "src");
  const rev = execFileSync("git", ["-C", pkg, "rev-parse", "--verify", `${head}^{commit}`], {
    encoding: "utf8",
  }).trim();
  const root = join(tmpdir(), `found-neighbours-${rev}`);
  if (!existsSync(join(root, "packages", "cal-core", "src", "found", "rules.ts"))) {
    mkdirSync(root, { recursive: true });
    const tar = execFileSync("git", ["-C", pkg, "archive", rev, "--", "src"], { maxBuffer: 1 << 28 });
    execFileSync("tar", ["-x", "-C", root], { input: tar });
    mkdirSync(join(root, "packages", "cal-core"), { recursive: true });
    execFileSync("mv", [join(root, "src"), join(root, "packages", "cal-core", "src")]);
  }
  return join(root, "packages", "cal-core", "src");
}

async function readerOf(src) {
  const url = (p) => pathToFileURL(join(src, p)).href;
  const { readFound } = await import(url("found/rules.ts"));
  const { intlZones } = await import(url("time/zones.ts"));
  const lexicon = await import(url("found/lexicon.ts"));
  const zones = intlZones();
  const two = (n) => String(n).padStart(2, "0");
  const sentAt = { kind: "instant", epochMs: Date.parse("2026-11-10T08:00:00Z") };
  const context = {
    zone: "Europe/Zurich",
    now: { kind: "instant", epochMs: Date.parse("2026-11-10T09:00:00Z") },
    zones,
  };
  // A reading in the words of corpus/tried.ts.
  const read = (language, body) => {
    const r = readFound({ subject: "", body, sentAt, language, place: "ohbox" }, context);
    const words = [];
    for (const f of r.findings) {
      const end = f.event.endGiven && f.event.end?.kind === "zoned" ? f.event.end.wall : null;
      words.push(`${f.level} ${f.key}${end === null ? "" : `-${two(end.hour)}:${two(end.minute)}`}`);
    }
    for (const n of r.notOffered) words.push(`not ${n.why}`);
    if (r.askable.length > 0) words.push(`asked ${r.askable.length}`);
    return words.length > 0 ? words.join(" | ") : "nothing";
  };
  return { read, lexicon };
}

/** Every word of every table of a lexicon module (`all`), or the first and last of each: per language, and the shared ones. */
function wordsOf(lexicon, language, all) {
  const found = new Map();
  const take = (table, value) => {
    const words = [];
    if (typeof value === "string") words.push(value);
    else if (Array.isArray(value))
      for (const v of value) words.push(...(typeof v === "string" ? [v] : Array.isArray(v) ? [v[0]] : []));
    else if (value instanceof Set) words.push(...value);
    // A word that names the word after it ("postponed" → "to") is placed with it.
    else if (value instanceof Map)
      words.push(...[...value].map(([k, v]) => (typeof v === "string" ? `${k} ${v}` : k)));
    const named = words.filter((w) => typeof w === "string" && w.length > 0);
    const chosen = all || named.length === 0 ? named : [named[0], named.at(-1)];
    for (const w of new Set(chosen)) if (!found.has(w)) found.set(w, table);
  };
  for (const [table, value] of Object.entries(lexicon.lexiconOf(language)))
    if (table !== "language") take(table, value);
  for (const [table, value] of Object.entries(lexicon)) if (table === table.toUpperCase()) take(table, value);
  return found;
}

/** Words the lexicon does not hold, before a number of their own: "Teil 2", "Court 14", "table for 4". */
const PLAIN = {
  en: ["court", "session", "part", "day", "round", "option", "lane", "slot", "bus", "lesson", "for"],
  de: ["kurs", "teil", "tag", "platz", "runde", "klasse", "variante", "bus", "frühstück", "linie"],
};

const FACES = {
  en: {
    start: ["7", "7:30", "7.30", "07:30", "19:30", "13", "7am", "7 pm", "7 p.m.", "7:30pm", "12pm", "noon"],
    end: ["9", "9:30", "9.30", "21:30", "9pm", "9 am", "11pm", "12:00"],
  },
  de: {
    start: ["7", "19", "7 Uhr", "19 Uhr", "7.30", "19.30", "19:30", "19.30 Uhr", "07:30", "13"],
    end: ["9", "21", "21 Uhr", "21.30 Uhr", "21:30", "9.45 Uhr"],
  },
};
/** The wide form's own clocks, fewer faces in more places. */
const WIDE_FACES = {
  en: {
    start: ["7", "7:30", "19:30", "13", "7pm", "noon", "2"],
    end: ["9", "9:30", "21:30", "9pm", "4pm", "11pm"],
  },
  de: {
    start: ["7", "19", "19 Uhr", "19.30", "14"],
    end: ["9", "21", "21 Uhr", "21.30 Uhr", "21:30", "16 Uhr"],
  },
};
const JOINS = {
  en: ["-", " - ", "–", " – ", "—", " to ", " until ", " till "],
  de: ["-", " - ", "–", " – ", "—", " bis "],
};
const WIDE_JOINS = { en: ["-", " - ", " – ", " to "], de: ["-", " – ", " bis "] };
const AROUND = {
  en: [
    ["from ", " to "],
    ["between ", " and "],
  ],
  de: [
    ["von ", " bis "],
    ["zwischen ", " und "],
  ],
};
const SENTENCES = {
  en: {
    date: (x) => `Meeting on Saturday, 21 November 2026 ${x}.`,
    weekday: (x) => `Meeting on Friday ${x}.`,
    first: (x) => `${x} on Saturday, 21 November 2026.`,
    relative: (x) => `Meeting tomorrow ${x}.`,
    numeric: (x) => `Meeting on 21.11.2026 ${x}.`,
    two: (x) => `Meeting on Saturday, 21 November 2026. ${x}.`,
    line: (x) => `Meeting on Saturday, 21 November 2026\n${x}`,
    comma: (x) => `Meeting on Saturday, 21 November 2026, ${x}.`,
  },
  de: {
    date: (x) => `Treffen am Samstag, 21. November 2026 ${x}.`,
    weekday: (x) => `Treffen am Freitag ${x}.`,
    first: (x) => `${x} am Samstag, 21. November 2026.`,
    relative: (x) => `Treffen morgen ${x}.`,
    numeric: (x) => `Treffen am 21.11.2026 ${x}.`,
    two: (x) => `Treffen am Samstag, 21. November 2026. ${x}.`,
    line: (x) => `Treffen am Samstag, 21. November 2026\n${x}`,
    comma: (x) => `Treffen am Samstag, 21. November 2026, ${x}.`,
  },
};
/**
 * The day between two clocks: the clock before the day, a tail AFTER it ("Workshop 9 - 11am on Saturday,
 * 21 November 2026, drinks at 5pm."), with a whole date, a weekday and a relative day.
 */
const BETWEEN = {
  en: {
    first: (x, t) => `${x} on Saturday, 21 November 2026${t}.`,
    weekday_first: (x, t) => `${x} on Friday${t}.`,
    relative_first: (x, t) => `${x} tomorrow${t}.`,
  },
  de: {
    first: (x, t) => `${x} am Samstag, 21. November 2026${t}.`,
    weekday_first: (x, t) => `${x} am Freitag${t}.`,
    relative_first: (x, t) => `${x} morgen${t}.`,
  },
};
/** The tails after the day: a labelled start, and a clock of something else. */
const AFTER_DAY = {
  en: [", start 6pm", ", drinks at 8pm"],
  de: [", Beginn 18 Uhr", ", Apéro 20 Uhr"],
};
/** A later labelled clock (the quick form's), and the wide form's tails: before the clock, or after it. */
const LATER = { en: ", start 6pm", de: ", Beginn 18 Uhr" };
const TAILS = {
  en: [
    ["", ""],
    ["", ", start 6pm"],
    ["", ", dinner at 8pm"],
    ["", " and 8pm after"],
    ["3pm, ", ""],
  ],
  de: [
    ["", ""],
    ["", ", Beginn 18 Uhr"],
    ["", ", Essen um 20 Uhr"],
    ["", " und 20 Uhr danach"],
    ["15 Uhr, ", ""],
  ],
};
const TO = { en: "to ", de: "bis " };
const QUICK_NUMBERS = ["14 – ", "5 – ", "5-", "1–2 – "];
const WIDE_NUMBERS = {
  en: [
    "",
    "5 – ",
    "5 - ",
    "5-",
    "5–",
    "5, ",
    "5: ",
    "12 – ",
    "3 - ",
    "14 – ",
    "1–2 – ",
    "1-2 - ",
    "5 to ",
    "to ",
    "5 (",
    "5 at ",
  ],
  de: [
    "",
    "5 – ",
    "5 - ",
    "5-",
    "5–",
    "5, ",
    "5: ",
    "12 – ",
    "3 - ",
    "14 – ",
    "1–2 – ",
    "1-2 - ",
    "5 bis ",
    "bis ",
    "5 (",
    "5 um ",
  ],
};
const WIDE_WORDS = {
  en: [
    "",
    "at ",
    "room ",
    "hall ",
    "gate ",
    "platform ",
    "floor ",
    "level ",
    "no ",
    "no. ",
    "group ",
    "table ",
    "up ",
    "through ",
    "open ",
    "until ",
    "till ",
    "postponed ",
    "moved ",
    "from ",
  ],
  de: [
    "",
    "um ",
    "raum ",
    "zimmer ",
    "saal ",
    "halle ",
    "gleis ",
    "tor ",
    "stock ",
    "nr ",
    "nr. ",
    "gruppe ",
    "tisch ",
    "bis ",
    "ab ",
    "von ",
    "verschoben auf ",
  ],
};

/** Every clock form of a language: its text, the name of its shape, its start face and its end face. */
function clocksOf(language, faces, joins) {
  const { start, end } = faces[language];
  const clocks = start.map((s) => ({ shape: "lone", clock: s, s, e: null }));
  for (const s of start)
    for (const e of end) {
      for (const j of joins[language])
        clocks.push({
          shape: `range "${j.trim()}"${j.startsWith(" ") ? " spaced" : ""}`,
          clock: `${s}${j}${e}`,
          s,
          e,
        });
      for (const [a, b] of AROUND[language])
        clocks.push({ shape: `"${a.trim()} … ${b.trim()}"`, clock: `${a}${s}${b}${e}`, s, e });
    }
  return clocks;
}

/** The numbers a prefix places: "1–2 – " places 1 and 2; "to " none. */
function numbersOf(prefix) {
  const found = [];
  let digits = "";
  for (const ch of prefix) {
    if (ch >= "0" && ch <= "9") digits += ch;
    else if (digits !== "") {
      found.push(digits);
      digits = "";
    }
  }
  if (digits !== "") found.push(digits);
  return found;
}

/** A clock that reads as one: a mark (Uhr, am, pm), minutes by colon, noon; never a bare number. */
function marked(clock) {
  const low = clock.toLowerCase();
  return (
    low.includes("uhr") ||
    low.includes("am") ||
    low.includes("pm") ||
    low.includes("a.m.") ||
    low.includes("p.m.") ||
    low.includes(":") ||
    low.includes("noon")
  );
}

/** A tail that labels its clock as the start: "start 6pm", "Beginn 18 Uhr". */
function labelled(tail) {
  const low = tail.toLowerCase();
  return low.includes("start ") || low.includes("beginn ");
}

/** A number prefix that ends in an end word ("to ", "5 bis "): what follows is an end, not a start. */
function numberEnds(prefix) {
  const words = prefix.trim().split(" ");
  const last = words.at(-1);
  return last === "to" || last === "bis";
}

/** A word's class: a place word (a number of its own), a word no table holds, a word of a table, none. */
function classOf(language, w, tables) {
  const low = w.trim().replace(/\.$/, "");
  if (low === "") return "none";
  if (tables.noHour.has(low)) return "place";
  if (PLAIN[language].includes(low) && !tables.all.has(low)) return "plain";
  return "table";
}

/**
 * A letter: its body, its form, and what the generator placed (start and end faces, numbers, the word's
 * class, the tails' clocks). A sentence of `BETWEEN` takes the later tail after the day.
 */
function letter(language, kind, sentence, early, w, wc, table, number, c, later) {
  const between = sentence.length === 2;
  return {
    language,
    body: between
      ? sentence(`${early}${w}${number}${c.clock}`, later)
      : sentence(`${early}${w}${number}${c.clock}${later}`),
    form: `${language} ${kind} | ${table} | ${number === "" ? "" : `${JSON.stringify(number)} `}${c.shape}${early === "" ? "" : " | earlier clock"}${later === "" ? "" : ` | ${JSON.stringify(later)}${between ? " after the day" : ""}`}`,
    // What was placed, for a judge that reads the plain clock in the same sentence.
    placed: { kind, early, w, number, clock: c.clock, later, ...(between ? { afterDay: true } : {}) },
    // A start of the letter's own beside the day: a clock that reads as one (a mark, minutes by colon,
    // noon), after no word, a word no table holds or a place word, behind no end word.
    // Beside the day means no tail stands between the clock and the day: a tail before the day's own
    // clock ("Meeting on Saturday, … 3pm, room 5 – 7pm") or before the day ("…, dinner at 8pm on
    // Saturday, …") is the clock beside it.
    own:
      (wc === "none" || wc === "plain" || wc === "place") &&
      kind !== "two" &&
      (between || (kind === "first" ? later === "" : early === "")) &&
      marked(c.clock) &&
      !numberEnds(number),
    s: c.s,
    e: c.e,
    numbers: numbersOf(number),
    wc,
    // The word itself may be a clock ("noon"): a reading may rightly offer it.
    tails: [early, later, w.trim()].filter((x) => x !== ""),
  };
}

function* quickLetters(language, words, tables) {
  const sentence = SENTENCES[language];
  const ws = [["no word", ""], ...[...words].map(([w, table]) => [table, `${w} `])];
  for (const c of clocksOf(language, FACES, JOINS))
    for (const [table, w] of ws)
      for (const number of ["", "5 – ", TO[language]])
        for (const kind of ["date", "weekday"])
          for (const later of ["", LATER[language]])
            yield letter(
              language,
              kind,
              sentence[kind],
              "",
              w,
              classOf(language, w, tables),
              table,
              number,
              c,
              later,
            );
  // Behind a word no table holds and a place word, behind a number above twelve and a pair, the clock before the day too.
  const extra = [
    ["no word", ""],
    ["plain", `${PLAIN[language][0]} `],
    ["noHourAfter", `${[...tables.noHour][0]} `],
  ];
  for (const c of clocksOf(language, FACES, JOINS))
    for (const [table, w] of extra)
      for (const number of QUICK_NUMBERS)
        for (const kind of ["first", "date", "weekday"])
          for (const later of ["", LATER[language]])
            yield letter(
              language,
              kind,
              sentence[kind],
              "",
              w,
              classOf(language, w, tables),
              table,
              number,
              c,
              later,
            );
  // The day between two clocks: the same words and numbers, no number too, the clock before the day and a tail after it.
  for (const c of clocksOf(language, FACES, JOINS))
    for (const [table, w] of extra)
      for (const number of ["", ...QUICK_NUMBERS])
        for (const [kind, s] of Object.entries(BETWEEN[language]))
          for (const later of AFTER_DAY[language])
            yield letter(language, kind, s, "", w, classOf(language, w, tables), table, number, c, later);
}

function* wideLetters(language, words, tables) {
  const sentence = SENTENCES[language];
  // Every word of every table, and words no table holds, in the quick form's places.
  const ws = [
    ["no word", ""],
    ...[...words].map(([w, table]) => [table, `${w} `]),
    ...PLAIN[language].filter((w) => !tables.all.has(w)).map((w) => ["plain", `${w} `]),
  ];
  for (const c of clocksOf(language, FACES, JOINS))
    for (const [table, w] of ws)
      for (const number of ["", "5 – ", TO[language]])
        for (const kind of ["date", "weekday"])
          for (const later of ["", LATER[language]])
            yield letter(
              language,
              kind,
              sentence[kind],
              "",
              w,
              classOf(language, w, tables),
              table,
              number,
              c,
              later,
            );
  // More numbers, sentence shapes and tails, after the place words, the range and time words and words no table holds.
  const more = [
    ...WIDE_WORDS[language].map((w) => ["word", w]),
    ...PLAIN[language].filter((w) => !tables.all.has(w)).map((w) => ["plain", `${w} `]),
  ];
  for (const c of clocksOf(language, WIDE_FACES, WIDE_JOINS))
    for (const [table, w] of more)
      for (const number of WIDE_NUMBERS[language])
        for (const [kind, s] of Object.entries(sentence))
          for (const [early, later] of TAILS[language])
            yield letter(language, kind, s, early, w, classOf(language, w, tables), table, number, c, later);
  // The day between two clocks: each tail of a later clock placed after the day.
  const afterDay = TAILS[language].map(([, later]) => later).filter((later) => later !== "");
  for (const c of clocksOf(language, WIDE_FACES, WIDE_JOINS))
    for (const [table, w] of more)
      for (const number of WIDE_NUMBERS[language])
        for (const [kind, s] of Object.entries(BETWEEN[language]))
          for (const later of afterDay)
            yield letter(language, kind, s, "", w, classOf(language, w, tables), table, number, c, later);
}

/** The clock times a face may stand for, in minutes: "7" is 07:00 or 19:00, "12pm" 12:00 or 00:00. */
function times(face) {
  if (face === "noon") return [720];
  let i = 0;
  while (i < face.length && (face[i] < "0" || face[i] > "9")) i += 1;
  let h = 0;
  for (; i < face.length && face[i] >= "0" && face[i] <= "9"; i += 1) h = h * 10 + Number(face[i]);
  let m = 0;
  if (face[i] === ":" || face[i] === ".") m = Number(face.slice(i + 1, i + 3)) || 0;
  const all = new Set([h * 60 + m]);
  if (h <= 12) all.add(((h % 12) + 12) * 60 + m);
  if (h === 12) all.add(m);
  return [...all];
}

/** The first start a reading offers, in minutes, or `null`. */
function startOf(reading) {
  const t = reading.indexOf("T");
  if (t < 0 || reading[t + 3] !== ":") return null;
  return Number(reading.slice(t + 1, t + 3)) * 60 + Number(reading.slice(t + 4, t + 6));
}

/** The tails' clocks ("start 6pm", "3pm, ") and a word that is one ("noon"), which a reading may rightly offer. */
function tailTimes(tails) {
  const found = [];
  for (const tail of tails) {
    if (tail === "noon" || tail === "midday") found.push(720);
    for (let i = 0; i < tail.length; i += 1)
      if (tail[i] >= "0" && tail[i] <= "9" && (i === 0 || tail[i - 1] < "0" || tail[i - 1] > "9"))
        found.push(...times(tail.slice(i)));
  }
  return found;
}

/** What is wrong with a reading whatever any head read: its start is the letter's end, or a number it placed. */
function absoluteOf(l, reading) {
  const at = startOf(reading);
  if (at === null) return null;
  const right = new Set([...times(l.s), ...tailTimes(l.tails)]);
  if (l.e !== null && times(l.e).some((t) => t === at && !right.has(t))) return "end as start";
  if (l.wc === "place" || l.wc === "plain") {
    if (l.e !== null) for (const t of times(l.e)) right.add(t);
    if (l.numbers.some((n) => times(n).some((t) => t === at && !right.has(t))))
      return `number as start after a ${l.wc === "place" ? "place word" : "word no table holds"}`;
  }
  // The letter placed a start of its own beside the day, and the reading offers a tail's clock instead.
  if (l.own) {
    const placed = new Set([...times(l.s), ...(l.e === null ? [] : times(l.e)), ...l.numbers.flatMap(times)]);
    const tails = tailTimes(
      [l.placed.early, labelled(l.placed.later) ? "" : l.placed.later].filter((x) => x !== ""),
    );
    if (tails.includes(at) && !placed.has(at)) return "another clock as the start";
  }
  return null;
}

/** A reading classed by its offered start against what the letter placed. */
function startClass(l, reading) {
  const at = startOf(reading);
  if (at === null) return "no clock";
  const s = times(l.s);
  const e = l.e === null ? [] : times(l.e);
  const n = l.numbers.flatMap(times);
  const t = tailTimes(l.tails);
  const label = labelled(l.placed.later) ? tailTimes([l.placed.later]) : [];
  if (s.includes(at) && !t.includes(at) && !n.includes(at)) return "the placed start";
  if (label.includes(at) && !s.includes(at)) return "a labelled start";
  if (t.includes(at) && !s.includes(at)) return "another clock";
  if (n.includes(at) && !s.includes(at)) return "a placed number";
  if (e.includes(at) && !s.includes(at)) return "the placed end";
  if (s.includes(at)) return "the placed start or another";
  return "a clock not placed";
}

/**
 * A difference judged by what the head before read, not only by what the head after reads: a FAULT when
 * the after head gains a clock the before head did not give, moves the start to the placed end or a
 * placed number, or moves it from the placed start to another clock; LOOK when the start is a clock the
 * generator did not place (a person reads those); else none.
 */
function judgeOf(l, before, after) {
  const b = startClass(l, before);
  const a = startClass(l, after);
  let verdict = "none";
  if (b === "no clock" && a !== "no clock") verdict = "FAULT: gains a clock";
  else if ((a === "the placed end" || a === "a placed number") && a !== b)
    verdict = `FAULT: the start to ${a}`;
  else if (b === "the placed start" && a === "another clock")
    verdict = "FAULT: the placed start to another clock";
  else if (a === "a clock not placed" && a !== b) verdict = "LOOK";
  return { b, a, verdict };
}

const t0 = Date.now();
const after = await readerOf(
  alone ? srcOf(heads[0] ?? pkg) : heads.length === 2 ? srcOf(heads[1]) : resolve(pkg, "src"),
);
const before = alone ? null : await readerOf(srcOf(heads[0]));
let total = 0;
const differs = [];
const absolute = [];
for (const language of ["en", "de"]) {
  const lexicons = before === null ? [after.lexicon] : [before.lexicon, after.lexicon];
  const words = new Map(lexicons.flatMap((lx) => [...wordsOf(lx, language, wide)]));
  const all = new Set(lexicons.flatMap((lx) => [...wordsOf(lx, language, true).keys()]));
  const tables = { noHour: after.lexicon.lexiconOf(language).noHourAfter, all };
  for (const l of (wide ? wideLetters : quickLetters)(language, words, tables)) {
    total += 1;
    const b = after.read(language, l.body);
    const a = before === null ? b : before.read(language, l.body);
    const why = absoluteOf(l, b);
    if (why !== null) absolute.push({ ...l, why, before: a, after: b });
    if (a !== b) differs.push({ ...l, before: a, after: b, judged: judgeOf(l, a, b) });
  }
}

// Grouped by the letter's form and the change, so that one judgment covers a group.
const shapeOf = (r) =>
  r
    .replace(/\d{4}-\d\d-\d\d/g, "D")
    .replace(/T\d\d:\d\d(-\d\d:\d\d)?/g, (m) => (m.length > 6 ? "T-range" : "T"));
const formOf = (d) => d.form.replace(/^(en|de) (\w+) \| [^|]+\| /, "$1 $2 | ");
function grouped(list, keyOf) {
  const groups = new Map();
  for (const d of list) {
    const key = keyOf(d);
    const g = groups.get(key) ?? { n: 0, sample: d };
    g.n += 1;
    groups.set(key, g);
  }
  return [...groups.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
}
const groups = grouped(differs, (d) => `${formOf(d)}  ::  ${shapeOf(d.before)} → ${shapeOf(d.after)}`);
const absGroups = grouped(
  absolute,
  (d) => `${d.why} [${d.before === d.after ? "on both heads" : "new"}] | ${d.wc} | ${formOf(d)}`,
);
const judged = grouped(
  differs,
  (d) => `${d.judged.verdict} | ${d.judged.b} → ${d.judged.a} | ${d.language} ${d.placed.kind}`,
);
const faults = differs.filter((d) => d.judged.verdict.startsWith("FAULT")).length;
const looks = differs.filter((d) => d.judged.verdict === "LOOK").length;
const head = `FOUND NEIGHBOURS ${wide ? "wide" : "quick"} ${alone ? `alone=${heads[0] ?? "worktree"}` : `before=${heads[0]} after=${heads[1] ?? "worktree"}`} letters=${total} differ=${differs.length} groups=${groups.length} faults=${faults} look=${looks} absolute=${absolute.length} (new ${absolute.filter((d) => d.before !== d.after).length}) ms=${Date.now() - t0}`;
const fd = out === null ? 1 : openSync(out, "w");
const put = (line) => writeSync(fd, line + "\n");
put(head);
put("");
put(
  "-- absolute lines, grouped (why [new or on both heads] | word class | form without the word's table): count, one letter",
);
for (const [k, g] of absGroups)
  put(
    `${String(g.n).padStart(6)}  ${k}\n        ${JSON.stringify(g.sample.body)}  ${g.sample.before === g.sample.after ? "" : `${g.sample.before} → `}${g.sample.after}`,
  );
if (!alone) {
  put("");
  put(
    "-- judged (verdict | what the head before offered → what the head after offers, each by its start against what was placed | sentence): count, one letter",
  );
  for (const [k, g] of judged)
    put(
      `${String(g.n).padStart(8)}  ${k}\n        ${JSON.stringify(g.sample.body)}  ${g.sample.before} → ${g.sample.after}`,
    );
  put("");
  put("-- groups (form without the word's table :: before → after): count, one letter");
  for (const [k, g] of groups)
    put(
      `${String(g.n).padStart(6)}  ${k}\n        ${JSON.stringify(g.sample.body)}  ${g.sample.before} → ${g.sample.after}`,
    );
}
if (out !== null) {
  put("");
  put(
    "-- every absolute line: why, the word's class, the form, the start and end faces placed, before, after, the letter",
  );
  for (const d of absolute)
    put(
      `ABS\t${d.why}\t${d.wc}\t${d.form}\t${d.s}\t${d.e ?? ""}\t${d.before}\t${d.after}\t[${d.language}] ${JSON.stringify(d.body)}`,
    );
  if (!alone) {
    put("");
    put("-- every letter that differs: the form, before, after, the letter, what was placed, the verdict");
    for (const d of differs)
      put(
        `DIFF\t${d.form}\t${d.before}\t${d.after}\t[${d.language}] ${JSON.stringify(d.body)}\t${JSON.stringify(d.placed)}\t${d.judged.verdict}`,
      );
  }
  closeSync(fd);
  console.log(head);
}

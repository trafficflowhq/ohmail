import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { MAIL_MIGRATIONS_DIR, SQLITE_MIGRATIONS_DIR } from "@ohmail/db-mail";
import { CLOUD_MIGRATIONS_DIR, MAIL_JOURNAL } from "../src/journal-specs.js";
import { journalThrough } from "../src/testing-journal.js";
import {
  LINE_2_0_START, OLD_HEADS, TRANSITION_WINDOW, entryNumber, inTransitionWindow, windowEntries,
  type ServerJournal,
} from "../src/journal-heads.js";

/**
 * THE 1.0 LINE ENDS WHERE `OLD_HEADS` SAYS, AND 2.0 BEGINS ABOVE IT. Three readings of the journals
 * as they stand, each also taken on a copy with one planted entry, through the same reader: a
 * zero over the real journals is a reading only beside those arms being red.
 *
 * (a) the heads: the highest entry numbered below the 2.0 start is the one the constant names.
 *     The 1.0 line ships only below the start, so that is its highest released entry. Never read
 *     from the lock: a 1.0 fix reaches this tree before its release pins it.
 * (b) the line: an entry at or above the start is stamped above the old head, strictly rising,
 *     never in the future; an entry below the start is at or below the head; a device file the
 *     lock does not pin sorts at or above the start, or is a `.noop`.
 * (c) the window: the entries the transition applies are contiguous from the start through
 *     `TRANSITION_WINDOW`'s last, six in each journal.
 */

interface Entry { idx: number; when: number; tag: string }
const DIRS: Record<ServerJournal, string> = { mail: MAIL_MIGRATIONS_DIR, cloud: CLOUD_MIGRATIONS_DIR };
const JOURNAL_NAMES = ["mail", "cloud"] as const;
const DEVICE_START = `${String(LINE_2_0_START.device).padStart(4, "0")}_`;
const DEVICE_PREFIX = "packages/db-mail/drizzle-sqlite/";
const LOCK = JSON.parse(readFileSync(
  fileURLToPath(new URL("../released-migrations.lock.json", import.meta.url)), "utf8")) as { files: Record<string, string> };
const PINNED_DEVICE = new Set(Object.keys(LOCK.files).filter((p) => p.startsWith(DEVICE_PREFIX)).map((p) => p.slice(DEVICE_PREFIX.length)));

const readEntries = (dir: string): Entry[] =>
  (JSON.parse(readFileSync(join(dir, "meta", "_journal.json"), "utf8")) as { entries: Entry[] }).entries;
const numbered = (e: Entry): number => entryNumber(e.tag) ?? -1;

/** (a) for a server journal. */
function headFaults(journal: ServerJournal, dir: string): string[] {
  const below = readEntries(dir).filter((e) => numbered(e) < LINE_2_0_START[journal]);
  const head = below.reduce((a, b) => (b.when > a.when ? b : a));
  const want = OLD_HEADS[journal];
  return head.tag === want.tag && head.when === want.when ? [] : [
    `${journal}: the highest entry below ${LINE_2_0_START[journal]} is ${head.tag} at ${head.when}; OLD_HEADS names ${want.tag} at ${want.when}`,
  ];
}

/** (a) for the device journal, which is known by file name. */
function deviceHeadFaults(dir: string): string[] {
  const head = readdirSync(dir).filter((f) => f.endsWith(".sql") && f < DEVICE_START).sort().pop();
  return head === OLD_HEADS.device.name ? [] : [
    `device: the highest file below ${DEVICE_START} is ${String(head)}; OLD_HEADS names ${OLD_HEADS.device.name}`,
  ];
}

/** (b) for a server journal. */
function lineFaults(journal: ServerJournal, dir: string, now: number): string[] {
  const out: string[] = [];
  const head = OLD_HEADS[journal].when;
  let last: Entry | null = null;
  for (const e of readEntries(dir)) {
    if (entryNumber(e.tag) === null) out.push(`${journal}: ${e.tag} carries no number`);
    if (last !== null && e.when <= last.when) out.push(`${journal}: ${e.tag} is stamped at or below ${last.tag}, which stands before it`);
    if (numbered(e) < LINE_2_0_START[journal]) {
      if (e.when > head) out.push(`${journal}: ${e.tag} is numbered below the 2.0 start and stamped above the old head`);
    } else {
      if (e.when <= head) out.push(`${journal}: ${e.tag} is a 2.0 entry stamped at or below the old head: a store at 1.0 would skip it for ever`);
      if (e.when > now) out.push(`${journal}: ${e.tag} is stamped in the future: every entry stamped by the clock until then would be skipped`);
      if (last !== null && numbered(e) <= numbered(last)) out.push(`${journal}: ${e.tag} is not numbered above ${last.tag}`);
    }
    last = e;
  }
  return out;
}

/** (b) for the device journal. */
function deviceLineFaults(dir: string, pinned: ReadonlySet<string>): string[] {
  return readdirSync(dir)
    .filter((f) => !pinned.has(f) && f < DEVICE_START && !/^\d{4}\.noop$/.test(f) && f !== "README.md")
    .map((f) => `device: ${f} is not a released file and sorts below ${DEVICE_START}: a phone past the old head would run it after 2.0's entries`);
}

/** Once the lock pins 2.0's first device entry, every device file below the start is a pinned one. */
function frozenDeviceFaults(dir: string, pinned: ReadonlySet<string>): string[] {
  if (!pinned.has("0200_search_one_generation.sql")) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".sql") && f < DEVICE_START && !pinned.has(f))
    .map((f) => `device: ${f} sorts below ${DEVICE_START} and the lock, which pins 2.0's entries, does not pin it`);
}

/** (c): the window is contiguous from the start; complete, it is six entries ending on `last`. */
function windowFaults(journal: ServerJournal, dir: string): string[] {
  const out: string[] = [];
  const start = LINE_2_0_START[journal];
  const last = TRANSITION_WINDOW[journal].last;
  const all = readEntries(dir);
  const window = windowEntries(journal, all);
  window.forEach((e, i) => {
    if (numbered(e) !== start + i) out.push(`${journal}: the window's entry ${i + 1} is ${e.tag}, not number ${start + i}`);
  });
  const complete = all.some((e) => numbered(e) >= entryNumber(last)!);
  if (!complete) return out;
  if (window.length !== 6) out.push(`${journal}: the window holds ${window.length} entries, not six`);
  if (window.at(-1)?.tag !== last) out.push(`${journal}: the window ends on ${String(window.at(-1)?.tag)}, not ${last}`);
  return out;
}

describe("the old heads and the 2.0 line", () => {
  const tmp = mkdtempSync(join(tmpdir(), "journal-heads-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  let copies = 0;
  /** A copy of a server journal's entry list with `planted` appended; the readers need no file. */
  const planted = (journal: ServerJournal, ...extra: Array<{ tag: string; when: number }>): string => {
    const dir = join(tmp, `${journal}-${copies++}`);
    mkdirSync(join(dir, "meta"), { recursive: true });
    const entries = readEntries(DIRS[journal]);
    extra.forEach((e, i) => entries.push({ idx: entries.length + i, ...e }));
    writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ entries }));
    return dir;
  };
  /** A copy of the device journal's file names with `names` beside them. */
  const plantedDevice = (...names: string[]): string => {
    const dir = join(tmp, `device-${copies++}`);
    mkdirSync(dir, { recursive: true });
    for (const f of [...readdirSync(SQLITE_MIGRATIONS_DIR), ...names]) writeFileSync(join(dir, f), "");
    return dir;
  };
  const NOW = Date.now();

  it("(a) the highest released entry of each journal is the one OLD_HEADS names", () => {
    for (const j of JOURNAL_NAMES) expect(headFaults(j, DIRS[j])).toEqual([]);
    expect(deviceHeadFaults(SQLITE_MIGRATIONS_DIR)).toEqual([]);
  });

  it("(a) a 1.0 fix that adds a migration moves the head, and that is red", () => {
    expect(headFaults("mail", planted("mail", { tag: "0186_x", when: OLD_HEADS.mail.when + 1 }))).toHaveLength(1);
    expect(headFaults("cloud", planted("cloud", { tag: "0060_x", when: OLD_HEADS.cloud.when + 1 }))).toHaveLength(1);
    expect(deviceHeadFaults(plantedDevice("0186_x.sql"))).toHaveLength(1);
    // A 2.0 entry is not a head: the constant names the 1.0 line's end, whatever stands above it.
    expect(headFaults("mail", planted("mail", { tag: "0206_x", when: NOW }))).toEqual([]);
    expect(deviceHeadFaults(plantedDevice("0207_x.sql", "0186.noop"))).toEqual([]);
  });

  it("(b) a migration exists only in the 2.0 range and above its head", () => {
    for (const j of JOURNAL_NAMES) {
      expect(readEntries(DIRS[j]).length, `${j}: the journal was read`).toBeGreaterThan(40);
      expect(lineFaults(j, DIRS[j], Date.now())).toEqual([]);
    }
    expect(PINNED_DEVICE.size, "the lock pins the device journal").toBeGreaterThan(70);
    expect(deviceLineFaults(SQLITE_MIGRATIONS_DIR, PINNED_DEVICE)).toEqual([]);
  });

  it("(b) an entry planted in the 1.0 range, below the head or in the future is red", () => {
    const above = OLD_HEADS.mail.when + 1;
    const top = Math.max(...readEntries(DIRS.mail).map((e) => e.when)) + 1;
    expect(lineFaults("mail", planted("mail", { tag: "0199_x", when: top }), NOW + 10), "0199, stamped by the clock").not.toEqual([]);
    expect(lineFaults("mail", planted("mail", { tag: "0186_x", when: above }), NOW), "0186 above the head").not.toEqual([]);
    expect(lineFaults("mail", planted("mail", { tag: "0199_x", when: OLD_HEADS.mail.when - 1 }), NOW),
      "0199 slipped in below the head: recorded as applied nowhere, skipped everywhere").not.toEqual([]);
    expect(lineFaults("mail", planted("mail", { tag: "0206_x", when: NOW + 60_000 }), NOW), "a future stamp").not.toEqual([]);
    expect(lineFaults("cloud", planted("cloud", { tag: "0106_x", when: OLD_HEADS.cloud.when }), NOW), "a 2.0 entry at the head's stamp").not.toEqual([]);
    expect(lineFaults("cloud", planted("cloud", { tag: "0107_x", when: top + 5 }, { tag: "0106_x", when: top + 6 }), NOW + 10),
      "numbers that fall").not.toEqual([]);
    expect(deviceLineFaults(plantedDevice("0199_x.sql"), PINNED_DEVICE), "an unpinned device file below the start").toHaveLength(1);
    // The admitted shapes, through the same readers.
    expect(lineFaults("mail", planted("mail", { tag: "0206_x", when: top }, { tag: "0207_y", when: top + 1 }), top + 1)).toEqual([]);
    expect(deviceLineFaults(plantedDevice("0207_x.sql", "0186.noop"), PINNED_DEVICE)).toEqual([]);
  });

  it("once the lock pins 2.0's device entries, every device file below the start is pinned", () => {
    expect(frozenDeviceFaults(SQLITE_MIGRATIONS_DIR, PINNED_DEVICE)).toEqual([]);
    const frozen = new Set([...PINNED_DEVICE, "0200_search_one_generation.sql"]);
    const dir = plantedDevice("0186_x.sql", "0200_search_one_generation.sql");
    expect(frozenDeviceFaults(dir, frozen), "a late 1.0 device entry after the freeze").toHaveLength(1);
    expect(frozenDeviceFaults(dir, PINNED_DEVICE), "before the freeze the head's own test speaks, not this one").toEqual([]);
  });

  it("(c) the window is contiguous from the start and, complete, six entries in each journal", () => {
    for (const j of JOURNAL_NAMES) expect(windowFaults(j, DIRS[j])).toEqual([]);
    expect(inTransitionWindow("mail", "0200_search_one_generation")).toBe(true);
    expect(inTransitionWindow("mail", TRANSITION_WINDOW.mail.last)).toBe(true);
    expect(inTransitionWindow("mail", "0206_x"), "past the window: an ordinary migration").toBe(false);
    expect(inTransitionWindow("mail", OLD_HEADS.mail.tag), "the old road is not the window").toBe(false);
    expect(inTransitionWindow("cloud", "0100_account_on_sign_in_tables")).toBe(true);
    expect(inTransitionWindow("cloud", "0106_x")).toBe(false);
  });

  it("(c) a gap, a seventh entry or another last entry is red", () => {
    const old = (j: ServerJournal): Entry[] => readEntries(DIRS[j]).filter((e) => numbered(e) < LINE_2_0_START[j]);
    let stamp = NOW - 1000;
    const journalOf = (j: ServerJournal, tags: string[]): string => {
      const dir = join(tmp, `window-${copies++}`);
      mkdirSync(join(dir, "meta"), { recursive: true });
      const entries = old(j);
      for (const tag of tags) entries.push({ idx: entries.length, tag, when: stamp++ });
      writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ entries }));
      return dir;
    };
    const six = ["0200_a", "0201_b", "0202_c", "0203_d", "0204_e", TRANSITION_WINDOW.mail.last];
    expect(windowFaults("mail", journalOf("mail", six)), "the shape the rule admits").toEqual([]);
    expect(windowFaults("mail", journalOf("mail", [...six, "0206_later"])), "an entry past the window is no part of it").toEqual([]);
    expect(windowFaults("mail", journalOf("mail", six.slice(0, 3))), "a window still being built").toEqual([]);
    expect(windowFaults("mail", journalOf("mail", ["0200_a", "0202_c"])), "a gap").not.toEqual([]);
    expect(windowFaults("mail", journalOf("mail", [...six.slice(0, 5), "0205_other"])), "another last entry").not.toEqual([]);
    expect(windowFaults("mail", journalOf("mail", [...six.slice(0, 4), TRANSITION_WINDOW.mail.last])), "five").not.toEqual([]);
    expect(windowFaults("cloud", journalOf("cloud", ["0100_a", "0100_b", "0101_c", "0102_d", "0103_e", "0104_f", TRANSITION_WINDOW.cloud.last])),
      "a seventh").not.toEqual([]);
  });
});

describe("a journal as it stood at one entry", () => {
  it("holds the entries at or below the stamp and exactly their files, byte for byte", () => {
    const all = readEntries(MAIL_MIGRATIONS_DIR);
    const at = all[99]!;
    const cut = journalThrough(MAIL_JOURNAL, at.when);
    try {
      const kept = readEntries(cut.spec.dir);
      expect(kept.map((e) => e.tag)).toEqual(all.slice(0, 100).map((e) => e.tag));
      expect(readdirSync(cut.spec.dir).filter((f) => f.endsWith(".sql")).sort()).toEqual(kept.map((e) => `${e.tag}.sql`).sort());
      for (const e of [kept[0]!, kept.at(-1)!]) {
        expect(readFileSync(join(cut.spec.dir, `${e.tag}.sql`))).toEqual(readFileSync(join(MAIL_MIGRATIONS_DIR, `${e.tag}.sql`)));
      }
      expect([cut.spec.name, cut.spec.migrationsSchema]).toEqual([MAIL_JOURNAL.name, MAIL_JOURNAL.migrationsSchema]);
      expect(cut.spec.dir).not.toBe(MAIL_JOURNAL.dir);
    } finally {
      cut.dispose();
    }
    expect(existsSync(cut.spec.dir), "dispose removes the folder").toBe(false);
  });

  it("cut at the old head, it is the 1.0 road whole and nothing of 2.0", () => {
    const cut = journalThrough(MAIL_JOURNAL, OLD_HEADS.mail.when);
    try {
      const kept = readEntries(cut.spec.dir);
      expect(kept.at(-1)?.tag).toBe(OLD_HEADS.mail.tag);
      expect(kept.filter((e) => numbered(e) >= LINE_2_0_START.mail)).toEqual([]);
    } finally {
      cut.dispose();
    }
  });

  it("refuses a stamp below the journal's first entry", () => {
    expect(() => journalThrough(MAIL_JOURNAL, 1)).toThrow(/no entry at or below/);
  });
});

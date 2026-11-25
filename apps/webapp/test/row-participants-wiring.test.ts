import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sliceOfDeclaration } from "./source-anchor.js";

/**
 * THE CIRCLES ARE AN APP-WIDE ROW LANGUAGE, NOT AN OHBOX FEATURE.
 *
 * `MessageRow` draws a conversation's people wherever their data reaches it — which means the
 * question this file answers is not "does the component work" (`packages/ui` owns that) but
 * "does every list HAND IT THE DATA". That is a wiring fact spread over seven files, and the
 * failure mode is silent: a list that forgets the prop looks completely normal, it just quietly
 * describes a five-person thread as one person, and no render test that nobody wrote will say so.
 *
 * So this is a CENSUS. Every view that renders a mail `MessageRow` is named here, and each one
 * has to (a) accept the shell's binding and (b) pass it on the row; the shell has to hand the
 * binding to every one of them. Adding a new mail list means adding it to this list — which is
 * the point: the next surface should have to say out loud that it does not draw them.
 *
 * ScreenerView is deliberately absent and is the one real exception. Its rows are a decision
 * about a SENDER — "do I want mail from this person at all" — and its circle is that sender's
 * face, the subject of the judgement. A stack of the people in some thread they wrote in would
 * replace the one face the row exists to show.
 */

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

/** The new tree's models and seats: where a place's rows are read from the mirror. */
const NEW_TREE = {
  index: repo("packages/app-logic/src/ohbox/live-mirror.ts"),
  files(): string[] {
    const out: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
    };
    walk(repo("packages/app-logic/src"));
    walk(repo("packages/app/src"));
    return out;
  },
};

/**
 * The compatibility views still pass their participants input. The mounted lists are checked against their
 * frame registration and the row each registration draws.
 */
const MAIL_LISTS = [
  "ReadsView",
  "ReceiptsView",
  "HistoryView",
  "TagView",
  "TriageView",
] as const;

const MOUNTED_LISTS = [
  ["news", "StreamList", "stream/StreamList.tsx"],
  ["receipts", "StreamList", "stream/StreamList.tsx"],
  ["history", "HistoryList", "history/HistoryList.tsx", "<LetterRows"],
  ["tags", "TagsList", "tags/TagsList.tsx", "<LetterRows"],
  ["piles", "PilesList", "piles/PilesList.tsx"],
  ["ohbox", "OhboxList", "ohbox/OhboxList.tsx", "<OhboxGroup"],
] as const;
const MOUNTED_ROWS = [
  ["stream/StreamList.tsx", "ItemRow", "rowPeople(m, recipient ?? who)", "rowPeople={rowPeople}"],
  ["piles/PilesList.tsx", "PileItem", "rowPeople(m, who)", "rowPeople={rowPeople}"],
  ["place-list/LetterRows.tsx", "LetterRows", "rowPeople(m,", "useRowPeople()"],
] as const;
const app = (file: string) => readFileSync(repo(`packages/app/src/${file}`), "utf8");

describe("thread circles are wired into every mail list", () => {
  it.each(MAIL_LISTS)("%s takes the shell's participants binding and passes it on its row", (view) => {
    if (view === "TriageView") {
      expect(app("piles/place.ts")).toMatch(/\bList: PilesList\b/);
      const piles = app("piles/PilesList.tsx");
      expect(piles).toContain("const rowPeople = useRowPeople()");
      expect(piles).toMatch(/<PileItem[\s\S]*?rowPeople=\{rowPeople\}/);
      expect(sliceOfDeclaration(piles, "PileItem")).toContain("rowPeople(m, who)");
      return;
    }
    if (view === "TagView" || view === "HistoryView") {
      const [place, list, file] = view === "TagView" ? MOUNTED_LISTS[3] : MOUNTED_LISTS[2];
      expect(app(`${place}/place.ts`)).toMatch(new RegExp(`\\bList: ${list}\\b`));
      expect(app(file)).toMatch(/<LetterRows\b/);
      const rows = app("place-list/LetterRows.tsx");
      expect(rows).toContain("const rowPeople = useRowPeople()");
      expect(sliceOfDeclaration(rows, "LetterRows")).toMatch(/<Row[\s\S]*?\{\.\.\.rowPeople\(m,/);
      return;
    }
    const place = view === "ReadsView" ? "news" : "receipts";
    expect(app(`${place}/place.ts`)).toMatch(/\bList: StreamList\b/);
    const stream = app("stream/StreamList.tsx");
    expect(stream).toContain("const rowPeople = useRowPeople()");
    expect(stream).toMatch(/<ItemRow[\s\S]*?rowPeople=\{rowPeople\}/);
    expect(sliceOfDeclaration(stream, "ItemRow")).toMatch(/<MailRow[\s\S]*?\{\.\.\.rowPeople\(m, recipient \?\? who\)\}/);
  });

  it("the shell hands its indexed binding to every one of them", () => {
    for (const [place, list, file, child] of MOUNTED_LISTS) {
      expect(app(`${place}/place.ts`), `${place} no longer mounts ${list}`).toMatch(new RegExp(`\\bList: ${list}\\b`));
      if (child) expect(app(file)).toContain(child);
    }
    for (const [file, declaration, people, bind] of MOUNTED_ROWS) {
      const source = app(file);
      expect(source).toContain("const rowPeople = useRowPeople()");
      expect(source).toContain(bind);
      expect(sliceOfDeclaration(source, declaration)).toContain(people);
    }
    expect(app("ohbox/OhboxGroup.tsx")).toContain("model.groupPeople(row)");
    expect(app("ohbox/OhboxGroup.tsx")).toContain("people={people}");
    expect(app("place-list/people.ts")).toContain("useOtherThreadPeople()");
    const presented = readFileSync(repo("packages/app-logic/src/reading/presented-mirror.ts"), "utf8");
    expect(sliceOfDeclaration(presented, "readThreadIndex")).toContain("threadParticipantsIndex(presented)");
  });

  /**
   * ONE PASS PER VERSION, NOT ONE SCAN PER ROW. `threadParticipants(reader, id)` walks the whole
   * mirror to answer about one thread — fine for a handful of rows, and O(mirror × rows) now that
   * six lists ask per row. The shell indexes instead; this keeps the per-thread scan from
   * creeping back into it.
   */
  it("the shell reads a per-version index, never the per-thread scan", () => {
    /* RE-POINTED TO THE NEW SHELL (RULING-NEW-SHELL-FIRST D (3)): a seat's rows read the conversation's people from
       its live model, which indexes them once a mirror version (`useThreadFacts` of `ohbox/live-mirror.ts`, the
       model the later list seats copy); the scan is refused in EVERY file of the new tree's models and seats, so it
       cannot creep back through a seat that copies the model. */
    expect(sliceOfDeclaration(readFileSync(NEW_TREE.index, "utf8"), "useThreadFacts"))
      .toContain("threadParticipantsIndex(presented)");
    for (const file of NEW_TREE.files()) {
      expect(readFileSync(file, "utf8"), `${file} scans per thread again`)
        .not.toContain("threadParticipants(presented");
    }
  });
});

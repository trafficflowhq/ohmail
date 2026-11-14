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

const at = (p: string) => fileURLToPath(new URL(`../app/${p}`, import.meta.url));
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
const read = (p: string) => readFileSync(at(p), "utf8");

/**
 * Every list surface that renders a mail row, and therefore draws thread circles. The Ohbox is no view here any
 * more: its rows are the kit's, and their circles are everybody in the conversation, asked of the shell's
 * conversation asker (`SHELL_BINDINGS` below; drawn and named by `packages/app/test/ohbox/row-words.test.tsx`).
 */
const MAIL_LISTS = [
  "ReadsView",
  "ReceiptsView",
  "HistoryView",
  "TagView",
  "TriageView",
] as const;

/** What the shell hands each list for its circles: the participants index, and the Ohbox its conversation asker. */
const SHELL_BINDINGS: ReadonlyArray<readonly [string, string]> = [
  ...MAIL_LISTS.map((view) => [view, "threadParticipants={participantsOf}"] as const),
  ["TodaysOhbox", "conversationOf={ohboxConversationOf}"],
];

describe("thread circles are wired into every mail list", () => {
  it.each(MAIL_LISTS)("%s takes the shell's participants binding and passes it on its row", (view) => {
    const src = read(`views/${view}.tsx`);
    // (a) the prop exists, with the shape the shell binds…
    expect(src).toContain(
      "threadParticipants?: (threadId: string) => { initials: string; hue: number }[];",
    );
    // …and is destructured rather than left on an unread props object.
    expect(src).toMatch(/^\s*threadParticipants,$/m);
    // (b) and a row is actually given participants. `MessageRow` decides whether to draw them.
    expect(src).toMatch(/participants=\{/);
  });

  it("the shell hands its indexed binding to every one of them", () => {
    const shell = read("shell/AppShell.tsx");
    for (const [view, binding] of SHELL_BINDINGS) {
      const open = shell.indexOf(`<${view}`);
      expect(open, `${view} is not rendered by the shell`).toBeGreaterThan(-1);
      /* The prop has to be inside THIS element, not merely somewhere in a file thousands of lines long —
         and getting that bound wrong is how this guard would pass over a view mounted without
         it (measured: a mis-indented terminator ran the slice on into the NEXT view's props
         and found the string there). The opening tag ends at the first `/>` sitting at the
         element's own indentation, so the bound is derived from the tag, never hard-coded. */
      const indent = " ".repeat(open - shell.lastIndexOf("\n", open) - 1);
      const close = shell.indexOf(`\n${indent}/>`, open);
      expect(close, `${view}'s opening tag does not terminate at its own indentation`).toBeGreaterThan(open);
      expect(shell.slice(open, close), `${view} is mounted without ${binding}`).toContain(binding);
    }
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

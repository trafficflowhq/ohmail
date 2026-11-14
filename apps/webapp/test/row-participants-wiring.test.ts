import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { shellFrameOf, shellFramePaths } from "./source-anchor.js";

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
    // The index is in whichever shell frame declares it (`shell-derivations.ts` since ARCH-022);
    // the scan is refused in EVERY frame, so it cannot creep back through the file that moved.
    expect(shellFrameOf("participantIndex").source).toContain("threadParticipantsIndex(presented)");
    for (const frame of shellFramePaths(process.cwd())) {
      expect(readFileSync(frame, "utf8"), `${frame} scans per thread again`)
        .not.toContain("threadParticipants(presented");
    }
  });
});

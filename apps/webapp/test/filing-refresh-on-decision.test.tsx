/**
 * ═══ THE PERSON'S OWN DECISION DID NOT RE-READ THE FACTS THE STRIP RENDERS ══════════════════
 *
 * `MailStateProvider` reads `GET /mailboxes` every 30 s while the tab is visible and on nothing
 * else — not on a mutation, and not on the decision that CREATED the outstanding filing the strip
 * is about. So the sentence a person sees immediately after filing something is derived from facts
 * read up to thirty seconds before they pressed anything, and the strip runs a clock over that
 * figure, which makes a stale number look live.
 *
 * ── THE HAZARD THIS FIX WOULD OTHERWISE CREATE LIVES NEXT DOOR ──────────────────────────────
 *
 * `refresh` was rebuilt by the binding's `useMemo` on every poll (deps `[state, facts, mirrored,
 * freshness, read]`), so handing it to the shell's memoized action handlers — which is what the
 * fix requires — would rebuild those handlers 120 times an hour and on every change to any mailbox
 * fact. That is the retained-scope shape this repository has already paid for: a memoized callback
 * rebuilt per render pins the render that made it. `mail-state-identity.test.tsx` owns that
 * property, has the harness for it, and gained the case, because it exists for precisely this —
 * a `pendingMoves`-only change must not rebuild the shell's partition.
 *
 * ── EVERY FILING DISPATCH GOES THROUGH ONE PLACE ────────────────────────────────────────────
 *
 * There was no convergence point. Five separate handlers reach `engine.mutate` with a filing verb
 * (`onMessageAction`'s move and delete, `onBulkAction`'s move, `onBulkScreen`'s plan loop, and
 * the Screener's own deferred dispatch), each with its own shape, and none calling the others. A
 * refresh added at four of the five is the "fix the path you are looking at and not the one beside
 * it" defect by construction, and a fifth door would arrive without one — so the fix is a single
 * helper the census below pins every dispatch to.
 *
 * ── MUTATIONS WATCHED ──────────────────────────────────────────────────────────────────────
 *
 *  · drop the helper from any one dispatch ⇒ the census red, naming that line;
 *  · rename either mutation kind ⇒ the positive control red, because a census that matches
 *    nothing is silently green.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { sliceOfDeclaration } from "./source-anchor";

/** The press model, routing and folder paths used by the registered mail shell. */
const PRESS = "packages/app-logic/src/press/";
const DISPATCH = PRESS + "shell-dispatch.ts";
const ROUTING = [PRESS + "message-verbs.ts", PRESS + "selection-verbs.ts"];
const DOORS = [
  DISPATCH, ...ROUTING, PRESS + "move-to-place.ts", PRESS + "delete-undo.ts",
  "packages/app-logic/src/folder/move.ts",
];
const PLANNERS = [PRESS + "sender-screening.ts"];
const readSource = (rel: string): string => withoutComments(readFileSync(resolve(process.cwd(), rel), "utf8"));
const dispatchSlice = (name: string): string => sliceOfDeclaration(readSource(DISPATCH), name);

function shellFrames(): { rel: string; src: string }[] {
  const frames = [...DOORS, ...PLANNERS].map((rel) => ({ rel, src: readSource(rel) }));
  for (const f of frames) {
    expect(f.src.length, `${f.rel} is implausibly short`).toBeGreaterThan(5_000);
  }
  expect(
    frames.reduce((n, f) => n + f.src.length, 0),
    "the shell frames together are implausibly short — a wrong cwd reads like a small file",
  ).toBeGreaterThan(100_000);
  return frames;
}

describe("every filing dispatch in the shell goes through one place", () => {
  /**
   * A SOURCE CENSUS, and the honest reason it is one: the five handlers are DOM-driven and each
   * needs its own mounted shell and its own gesture to reach, so a per-handler behavioural control
   * is five mounts of a component thousands of lines long. What actually has to hold is narrower and is a
   * property of the text: no filing verb is dispatched except through the helper. Delete the
   * helper from one line and this names that line.
   *
   * The verbs are the ones that write `folder_state` with our attribution — the two the strip's
   * arm reports on. `mail_send` and the flag verbs are deliberately not here: a send has its own
   * doorbell and its own surface, and a `\Seen` push is not a filing.
   */
  const FILING_VERBS = ["move", "message_delete"] as const;

  it("no filing mutation is dispatched without the refresh helper", () => {
    const offenders: string[] = [];
    let replayed = 0;
    for (const { rel, src } of shellFrames()) {
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        for (const verb of FILING_VERBS) {
          if (!line.includes(`kind: "${verb}"`)) continue;
          // The dispatch and its helper may sit on one line or the helper may wrap a multi-line
          // call, so the window is the statement's neighbourhood rather than the line alone.
          const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
          /**
           * A DISPATCH, NOT EVERY LITERAL. `engine.mutate(` in the same window is what makes this
           * line a dispatch; a `kind: "move"` MINTED into a plan is not one, and its dispatch is
           * `dispatchScreeningChange`'s injected `mutate`, asserted on its own below. Without this
           * the census read the Move arms' minted moves as unrefreshed dispatches — a literal is
           * not a wire call, and judging one as the other names a line that sends nothing.
           */
          if (!window.includes("engine.mutate(")) continue;
          if (!window.includes("fileAndRefresh")) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
        }
      });
      /**
       * AND THE ONE FILING DISPATCH THAT CARRIES NO `kind:` LITERAL. `engine.replayDelete` names
       * its verb inside the engine, so the loop above cannot reach it — the same blindness the
       * replay's own comment records, one door along. Scanned by the call instead, and asserted to
       * match SOMETHING: a second arm that finds nothing is the vacuous shape this file refuses.
       */
      const replays = lines
        .map((line, i) => ({ line, i }))
        .filter(({ line }) => line.includes("engine.replayDelete("));
      replayed += replays.length;
      for (const { line, i } of replays) {
        const window = lines.slice(Math.max(0, i - 3), i + 4).join("\n");
        if (!window.includes("fileAndRefresh")) offenders.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    }
    expect(replayed, "no replayed-delete dispatch in the shell — this arm matches nothing")
      .toBeGreaterThan(0);
    expect(offenders, "a filing dispatch that does not re-read the facts behind the strip")
      .toEqual([]);
  });

  it("the census can SEE a dispatch at all — a guard that matches nothing is not a guard", () => {
    // The positive control. A rename of the mutation kinds would make the census above vacuous
    // and silently green, which is the failure mode it shares with every source census.
    // AND THE TWO DOORS THAT LEFT THIS FILE. The dep is the whole coverage for those verbs, and
    // nothing conflicts on it, so it is asserted verbatim: an unwrapped dispatcher reads exactly
    // like a correct file to every other guard here.
    //
    // THE SPELLING MOVED WITH THE HELD WINDOW'S SIGNATURE (mail 0099). `createDeleteUndo` used
    // to know one dispatch and took the whole mutation object; it now takes an ID and the caller
    // supplies the verb, because the RESTORE cannot be an `EngineMutation` at all (the engine
    // rejects a mutation whose local effects are empty, which a tombstoned row's always are) and
    // a second window would have been a second copy of the timer and the journal. So the
    // assertion names the new spelling — the property is unchanged and is the same property: the
    // dispatcher the window is handed goes through `fileAndRefresh`.
    expect(dispatchSlice("deleting"), "the injected delete dispatcher does not re-read the facts")
      .toMatch(/mutate: \(messageId, pressId\) => fileAndRefresh\(\s*engine\.mutate\(\{ kind: "message_delete", messageId \}, \{ key: deleteIntentKey\(pressId, messageId\) \}\),\s*\)/);
    /* AND THE RESTORE'S, which is the second door on the same helper. It is a `restoreDispatch`
       rather than an `engine.mutate` for the reason above, so it cannot be covered by the
       offender census's `engine.mutate({ kind:` scan — asserted here instead, verbatim. */
    expect(dispatchSlice("restoring"), "the injected restore dispatcher does not re-read the facts")
      .toMatch(/mutate: \(messageId, pressId\) => fileAndRefresh\(\s*restoreDispatch\(/);
    /* `sliceOfDeclaration`, not a `toContain` on the hook spelling — `anchor-census.test.ts`
       refuses that shape across this whole directory, and correctly: a literal naming a
       declaration by the hook it is declared with goes green against an EMPTY slice the moment
       the declaration is reworded, and every assertion downstream passes over nothing. The
       slice THROWS `anchor not found: restoring` instead. (Two anchors of the refused shape
       already stood in this file before this slice and are converted below in the same pass:
       same shape, same file, one line each, and the census's red was the whole tree's.) */
    expect(dispatchSlice("restoring"), "the held restore window is not wired here any more")
      .toContain("verb: \"restore\"");
    expect(dispatchSlice("deleting"), "the delete window is not wired here any more")
      .toContain("useDeleteUndo({");
    /* EVERY SCREENING DISPATCH RE-READS THE FACTS, and this is the half the per-line census
       cannot see: the plan's moves leave through `dispatchScreeningChange`'s injected `mutate`,
       so a call that hands it a bare `engine.mutate` files mail and leaves the strip's count
       stale with nothing in this file naming a verb. Both Move arms go through it. */
    for (const path of ROUTING) {
      const calls = readSource(path).split("dispatchScreeningChange(").slice(1);
      expect(calls.length, `no screening dispatch in ${path}`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call.slice(0, 220), `screening in ${path} must refresh after the mutation`)
          .toMatch(/=>\s*cx\.press\.fileAndRefresh\(engine\.mutate\(mu\)\)/);
      }
    }
    /* AND THE MOVE INTO A FOLDER, a door outside the shell's frames (`folder/move.ts`): its press reaches the seam's
       `dispatchPress` handed in, never `engine.mutate`, so the offender census cannot see it. Asserted verbatim, as
       the injected delete and restore dispatchers are. */
    const move = readFileSync(resolve(process.cwd(), "packages/app-logic/src/folder/move.ts"), "utf8");
    expect(move, "the move into a folder does not re-read the facts")
      .toContain("seam.fileAndRefresh(seam.dispatchPress(mutation))");
    // Every filing verb is dispatched SOMEWHERE across the doors, so a rename cannot make the
    // offender census above vacuous by moving a verb out of this file.
    const across = [...DOORS, ...PLANNERS]
      .map((p) => readFileSync(resolve(process.cwd(), p), "utf8")).join("\n");
    for (const verb of FILING_VERBS) {
      expect(across, `no dispatch of kind "${verb}" across ${DOORS.join(", ")}`)
        .toContain(`kind: "${verb}"`);
    }
    // The helper's own definition, found by the NAME the census is about. Anchoring it on the hook
    // it happens to be declared with is what `anchor-census.test.ts` refuses across this
    // directory, and for a measured reason: this very literal named `useCallback` while the shell
    // had been converted to `useStableCallback`, so the anchor was one rename from an empty slice
    // every assertion passes over. `sliceOfDeclaration` throws `anchor not found: fileAndRefresh`
    // instead, which names the stale anchor rather than describing an absence.
    expect(
      dispatchSlice("fileAndRefresh"),
      "the helper the census keys on does not chain the re-read onto the dispatch",
    ).toContain("dispatch.then(refreshFacts, refreshFacts)");
  });
});

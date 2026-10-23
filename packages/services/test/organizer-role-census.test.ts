import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORGANIZER_ROLES, ORGANIZER_KINDS, ORGANIZER_STATES } from "@trafficflow/db";

/**
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *  EVERY WRITE DOOR ASKS THE ROLE — the exact set, not "at least these" (mail 0083)
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A reader is another mail client on somebody's mailbox: it may read, search, mark mail read and
 * send, and it may not move, file, delete, screen, rule, tag, triage, schedule, unsubscribe,
 * sweep, resync or import a profile. `assertOrganizerRole` (per mailbox) and
 * `assertAccountOrganizes` (per account, for configuration) are the one refusal both halves
 * share, and every refused door calls one of them.
 *
 * ── WHAT THIS CENSUS CANNOT DO, AND IT COST TWO CRITICAL FINDINGS ───────────────────────────
 *
 * It discovers GUARD CALLS. It does not discover WRITE DOORS. So a door that never calls the
 * refusal is invisible to it — the census is green, and the door is open. Two were found that way
 * by a max-effort review rather than by this file: the folder verbs (`folder-ops-service.ts`) and
 * the screening reset (`consent-reset.ts`), both now listed.
 *
 * The gap is structural and is not closed by editing the needle: the honest complement is a census
 * over the ROUTE TABLE — every mutating route, each classified as reader-permitted or refused —
 * which is a different file and a different question. Recorded here so the next person reads this
 * list as "every guard is called" and not as "every door is guarded".
 *
 * ── WHY A CENSUS AND NOT ELEVEN UNIT TESTS ──────────────────────────────────────────────────
 *
 * Eleven unit tests say eleven doors refuse. They say NOTHING about the twelfth, and the twelfth
 * is the whole risk: the failure this guards is not a door that stopped refusing, it is a door
 * somebody ADDS without having asked the question. `stand-down-sends-census.test.ts` was written
 * for the identical shape one feature over ("the appointment was orphaned not because a rule was
 * broken but because a gate existed that nobody had asked this question about"), and this file
 * is that file's argument applied to the reader.
 *
 * ── EXACT-SET EQUALITY, IN BOTH DIRECTIONS ──────────────────────────────────────────────────
 *
 * `flag-intent-census.test.ts`'s reason verbatim: a scanner that finds nothing is green, and a
 * broken scanner finds nothing. Asserting the found set EQUALS the list below means a regression
 * in the walk or in the needle goes red on the files that are known to contain them — so this
 * cannot be vacuously green — and it means REMOVING a refusal is as loud as adding a door.
 *
 * ── COMMENTS ARE STRIPPED BEFORE MATCHING ───────────────────────────────────────────────────
 *
 * Learned next door, the useful way: a file that MENTIONS a guard in prose was counted as a call
 * site. That direction is the dangerous one — a door certified as refusing by a sentence — so the
 * needle runs over source with comments removed.
 *
 * ── WHAT IS DELIBERATELY *NOT* ON THIS LIST ─────────────────────────────────────────────────
 *
 *  · `send-service.ts`. A reader MAY send: a send is an APPEND to the mailbox's own Sent folder
 *    that completes inside the request, which is what every mail client does. Its existing
 *    refusal is on `status = 'disabled'`, and a reader is `connected`, so it needs no change —
 *    and adding one would remove a capability the reader mode exists to keep.
 *  · `drafting-service.ts`. Drafting with AI is this install's own door spending this install's
 *    own model on text the person is writing. Nothing about it touches the mailbox.
 *  · the read services (`search`, `thread`, `sync`, `contacts`, `snippets`, `kb`). Reading is the
 *    reader's whole point.
 *  · `PATCH /messages` read-state. `\Seen` is the reader's ONE IMAP write verb, executed by
 *    `reconcileFlags`, which a reader cycle deliberately still runs.
 *  · `PATCH /messages` read-state, again: `\Seen` is the reader's one write verb.
 *
 * ── `consent-seed.ts` WAS ON THIS LIST AND IS NOW A MEMBER (mail 0094) ─────────────────────
 *
 * The exemption said: the window, the seed and the switches are account SETTINGS, the ceremony
 * that writes them at consent time is the gated door, and gating the settings writer as well
 * would refuse a person choosing a window during onboarding — precisely the moment nothing is
 * organized yet — making the flow unfinishable.
 *
 * **The onboarding half of that was right and is KEPT. The conclusion drawn from it was wrong.**
 * A setting is not inert: `dormancy_days` is the cutline the screening pass does arithmetic on and
 * `mailboxes.signature` is appended to outgoing mail, both by the install that ORGANIZES. Written
 * where nothing organizes, they are dials wired to nothing, and the pane reported them as saved —
 * ruling 6's Critical, and the reason it is a Critical rather than a rough edge is that nothing
 * failed. So the door is not exempt; it DISPATCHES. A reader's edit becomes a request the holder
 * applies, which is the answer the old exemption could not reach because a refusal was the only
 * alternative it had.
 *
 * What survives verbatim is the onboarding case, and it is now enforced rather than argued:
 * `planAccountFanOut` ADMITS the local write when 0 mailboxes are held and 0 organized, with a
 * named positive case in `rules-fan-out.test.ts` and `profile-fan-out.test.ts`. Refusing there
 * would still make the flow unfinishable; the fix was never to refuse, it was to have somewhere
 * for the edit to go when there IS a holder.
 *
 *    **The line between it and `consent-reset.ts` still holds, and is worth restating because a
 *    reviewer will reach for consistency.** A setting is a value the organizer reads when it next
 *    runs, so it can TRAVEL as a request. A RESET is a bulk destruction of decisions the organizer
 *    has already acted on; it is gated outright rather than dispatched, because there is no
 *    partial, replaceable state to send — the request would be "delete everything", and no door
 *    offers that across a handover.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * HOW A DOOR ASKS "does this install organize this mailbox" — now FOUR spellings, not two.
 *
 * `(` so a re-export or an import line is not a call site.
 *
 * ── WHY THE DISPATCH JOINED THE NEEDLES (mail 0094) ────────────────────────────────────────
 *
 * The two `assert*` functions REFUSE. Ruling 6 adds two that DISPATCH — `routeMailboxWrite` for a
 * per-mailbox door and `planAccountFanOut` for an account-scoped one — and a dispatching door asks
 * the same question and acts on a wider set of answers: organizer ⇒ write here, held-and-capable ⇒
 * a request the holder applies, otherwise ⇒ refuse.
 *
 * Keying this census on the refusals alone would have made every converted door LEAVE the list,
 * which reads as "these doors stopped checking" when the truth is the opposite. Worse, it would
 * have made the list SHRINK as the feature landed, so the guard would have weakened exactly as the
 * surface it guards grew.
 *
 * The needles are the QUESTION, not one answer to it.
 */
const REFUSAL_NEEDLES = [
  /assertOrganizerRole\(/, /assertAccountOrganizes\(/,
  /routeMailboxWrite\(/, /planAccountFanOut\(/,
  /planBulkMoveOnReader\(/,
];

/**
 * Where the refusal is REACHED FROM, plus the module that defines it.
 *
 * Every entry is a door that writes on somebody's mailbox or on the configuration that arranges
 * it. Adding a file here without adding the call is not possible — the second assertion opens
 * each file and asks.
 */
const REFUSAL_SITES = new Set([
  // The definition itself. Named rather than excluded, so deleting the module is red here.
  ["packages", "db", "src", "organizer-role.ts"].join(sep),
  // …and the DISPATCH's definition, on the same argument (mail 0094): `reader-request.ts` is where
  // "organizer, or a request, or a refusal" is decided for every family, so deleting it is red.
  ["packages", "services", "src", "reader-request.ts"].join(sep),
  // Per-mailbox doors — the ones that move mail or promise to.
  ["packages", "services", "src", "message-service.ts"].join(sep),       // move, delete
  ["packages", "services", "src", "schedule-service.ts"].join(sep),      // schedule
  ["packages", "services", "src", "triage-service.ts"].join(sep),        // setState
  ["packages", "services", "src", "tags-service.ts"].join(sep),          // assign (+ the defs)
  ["packages", "services", "src", "unsubscribe-service.ts"].join(sep),   // both arms
  ["packages", "services", "src", "profile-import-service.ts"].join(sep), // apply, replace
  ["packages", "services", "src", "mailbox-service.ts"].join(sep),       // requestResync
  ["packages", "services", "src", "mailbox-filings.ts"].join(sep),       // Try again now, Leave them where they are
  ["packages", "api", "src", "junk-window.ts"].join(sep),                // sweep press, rescue
  // …and the FOLDER VERBS, which this census could not see and a max-effort review could. Its own
  // gate tested `status = 'disabled'` for exactly the right reason — *"a command Cloud's worker
  // will never execute is a lie in a table"* — and `disabled` stopped being how a demotion is
  // recorded. It is the worst door on this list: a folder command is not an intent that waits, it
  // is recorded and rung through to a pass that CREATES, RENAMES or DELETES a real folder on the
  // person's server, a delete taking the subtree's mail to Trash with it.
  ["packages", "services", "src", "folder-ops-service.ts"].join(sep),    // create, rename, remove
  // Account-scoped configuration doors.
  //
  // `screener-service.ts` left this list at 0.14.1 (decide stopped REFUSING a reader and began
  // branching per mailbox) and RETURNS at 0.20 through the dispatch needle: a decision is about
  // the SENDER and applies account-wide, so `decide` now plans with `planAccountFanOut` — write
  // where this install organizes, one request per capable holder, refuse only when nothing
  // anywhere could take it. The write half's own fence is `applyScreenerDecision`'s per-mailbox
  // `FOR SHARE` role lock (`readOrganizerRole`, packages/db — not a needle; the QUESTION here is
  // asked by the dispatch).
  ["packages", "services", "src", "screener-service.ts"].join(sep),      // decide → account fan-out
  // `rules-service.ts` — create, update, remove. It no longer calls `assertAccountOrganizes`: mail
  // 0094 replaced that account-wide yes/no with `planAccountFanOut`, because the single answer was
  // wrong in BOTH directions. On a MIXED account it PERMITTED the write and nothing travelled, so
  // the install actually organizing the other mailbox never heard about the rule while the person
  // was told it was saved; on an all-reader account it REFUSED where a request could have gone.
  // The file stays on this list through the dispatch needle, which is the point of adding it.
  ["packages", "services", "src", "rules-service.ts"].join(sep),
  // …and the screening RESET, which a max-effort review found and this list did not. It reads
  // like a local clear and is the largest organizing act in the product: it deletes every rule,
  // drops the learning signals and graduations, and clears the screening baseline. Rules TRAVEL
  // in the profile document, so a reader wiping them hands the actual organizer an empty rule set
  // at its next read — every decided sender back in the Screener, on the machine that IS
  // organizing the mail, from a button pressed on one that is not.
  ["packages", "services", "src", "consent-reset.ts"].join(sep),         // resetScreeningState
  // …and the settings doors that TRAVEL (mail 0094). See the header for why `consent-seed.ts`
  // stopped being exempt: setDormancyDays and setMailboxSignature reach the install that
  // organizes, and the onboarding case they were exempted for is now enforced by the dispatch
  // rather than argued in a comment.
  ["packages", "services", "src", "consent-seed.ts"].join(sep),          // window, signature
  ["packages", "services", "src", "away-responder-service.ts"].join(sep), // put
  ["packages", "services", "src", "screening-preference.ts"].join(sep),  // setScreeningPreference
  /* …and the THREE MOVE DOORS the pattern sweep found, which nothing had guarded. All three
     TRAVEL now; the shapes differ, not the answers. `approval-service.ts` moves ONE message, so
     one `message.move` — and its gate covers the PHYSICAL move too, which runs after the
     transaction from values captured before it. `workflows-service.ts` and `hey-migration.ts`
     move MANY from one press and take the SET shape: `planBulkMoveOnReader` splits organized from
     travelling, one record each under the press's own key. The bound is asked inside that plan,
     over the total that would travel, which is what still refuses the flood case. */
  ["packages", "services", "src", "approval-service.ts"].join(sep),      // decide → one message.move
  ["packages", "services", "src", "workflows-service.ts"].join(sep),     // undoRun → N message.move
  // …and note what this entry does NOT say: the migration's guard covers its MOVE half only. The
  // same function writes `rules` rows directly (two lines of `hey-migration.ts`) with no fan-out, so an
  // import run on a reader still leaves rules the organizing install never sees. That is a rules
  // door, not a move door, and it is filed rather than claimed closed here.
  ["packages", "services", "src", "hey-migration.ts"].join(sep),         // reroute → N message.move
]);


const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".next", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.tsx")) continue;
      yield p;
    }
  }
}

function rootsOf(): string[] {
  const roots: string[] = [];
  for (const bucket of ["packages", "apps"]) {
    for (const name of readdirSync(join(REPO, bucket))) {
      for (const sub of ["src", "app"]) {
        const p = join(REPO, bucket, name, sub);
        try {
          if (statSync(p).isDirectory()) roots.push(p);
        } catch { /* no such subdir — fine */ }
      }
    }
  }
  return roots;
}

/** See the header: prose is not a call site. */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}

function filesContaining(needles: readonly RegExp[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of rootsOf()) {
    for (const file of walk(root)) {
      const src = readFileSync(file, "utf8");
      if (needles.some((n) => n.test(withoutComments(src)))) found.set(relative(REPO, file), src);
    }
  }
  return found;
}

describe("every write door asks whether this install organizes the mailbox", () => {
  it("the refusal sites are exactly the known ones", () => {
    const found = filesContaining(REFUSAL_NEEDLES);
    expect([...found.keys()].sort()).toEqual([...REFUSAL_SITES].sort());
  });

  it("the walk found something — a scanner that stopped working is red, not green", () => {
    // The half that makes the equality above mean anything. Without it a walk that returned
    // nothing would only fail if the allowlist were also empty.
    expect(filesContaining(REFUSAL_NEEDLES).size).toBe(REFUSAL_SITES.size);
    expect(REFUSAL_SITES.size).toBeGreaterThan(5);
  });

  it("every site actually CALLS it — a file that only imports the name is not a refusal", () => {
    // The hole an allowlist leaves: a file keeps its place while losing the call. `import {
    // assertOrganizerRole }` matches a bare-name needle and refuses nothing, which is why the
    // needles carry `(` and why each file is opened and asked again here.
    /* The two DEFINITION modules declare these functions and do not call them, which is what
       makes them definitions. Named here rather than dropped from the list above, so deleting
       either module is still red at the equality assertion. */
    const DEFINITIONS = [
      ["packages", "db", "src", "organizer-role.ts"].join(sep),
      ["packages", "services", "src", "reader-request.ts"].join(sep),
    ];
    for (const [file, src] of filesContaining(REFUSAL_NEEDLES)) {
      if (DEFINITIONS.some((d) => file.endsWith(d))) continue;
      const body = withoutComments(src);
      expect(
        /await (assert(OrganizerRole|AccountOrganizes)|routeMailboxWrite|planAccountFanOut|planBulkMoveOnReader)\(/.test(body),
        `${file} names the question but never awaits it — a check whose promise is dropped is not a check`,
      ).toBe(true);
    }
  });

  /**
   * HOW MANY DOORS A FILE GUARDS — the half the allowlist above structurally cannot see. That one
   * asks whether a FILE performs the refusal, and `message-service.ts` satisfied it with a THIRD
   * door in the same file unguarded. So the call sites are pinned per file, and BOTH numbers are:
   * a routed door dispatches `routeMailboxWrite` AND holds `assertOrganizerRole` as the locked
   * re-check the routing read cannot be, so `routed <= locked` is the invariant and the two exact
   * pins catch drift in either direction. Only the file this was found in is pinned — an
   * unverified sweep of the other ten would read as evidence.
   */
  const REFUSAL_CALL_SITES: ReadonlyMap<string, { locked: number; routed: number }> = new Map([
    // `patch`'s `folder` half, `move` and `delete`: each one `routeMailboxWrite` dispatch and one
    // `assertOrganizerRole` as the locked re-check inside its organizer arm. `restore` (mail 0099)
    // is a FOURTH door onto the same row — it writes `desired_folder` with `last_set_by = 'us'`
    // and the reconciler turns that into a real IMAP move — and it is locked WITHOUT a route: a
    // reader is refused with the roster sentence rather than filing a request, because there is
    // no pile a restore could be requested into.
    [["packages", "services", "src", "message-service.ts"].join(sep), { locked: 4, routed: 3 }],
  ]);

  it("each pinned file performs the refusal at every door it has", () => {
    const found = filesContaining(REFUSAL_NEEDLES);
    for (const [file, expected] of REFUSAL_CALL_SITES) {
      const src = [...found].find(([f]) => f.endsWith(file))?.[1];
      expect(src, `${file} is pinned for ${expected.locked} call sites but is not a refusal site at all`)
        .toBeDefined();
      const body = withoutComments(src!);
      /* THE CALL, NOT A CALLER'S SPELLING: the `await` in front is today's caller, and a call that
       * moves inside a wrapper leaves a census like this reading zero and passing. */
      const calls = body.match(/\bassert(?:OrganizerRole|AccountOrganizes)\s*\(/g) ?? [];
      const routed = body.match(/\brouteMailboxWrite\s*\(/g) ?? [];
      expect(
        calls.length,
        `${file}: pinned at ${expected.locked} locked re-checks, found ${calls.length}. `
        + "A door added without one, a check removed, or a door added WITH one — all three want "
        + "this number changed in the same edit.",
      ).toBe(expected.locked);
      expect(
        routed.length,
        `${file}: pinned at ${expected.routed} routed dispatches, found ${routed.length}.`,
      ).toBe(expected.routed);
      /* THE INVARIANT IS `routed ⊆ locked`, AND IT USED TO BE SPELLED AS AN EQUALITY.
         Equal was true while every guarded door routed. `restore` (mail 0099) is locked and NOT
         routed — a reader restoring is refused, not queued — so equality now refuses a correct
         file. The invariant it protected survives unchanged: a routed door must also hold the
         re-check, because the routing read takes no lock and a demotion can commit between the
         two. The two exact pins above are what catch drift in either direction; this states the
         relation, so a routed door that outran its re-checks is named here rather than inferred. */
      expect(
        routed.length,
        `${file}: ${routed.length} door(s) route a reader's press and only ${calls.length} hold the `
        + "locked re-check. Every routed door needs one: the routing read takes no lock, so a "
        + "demotion committing between the two would let the organizer arm write on a mailbox "
        + "this install no longer organizes.",
      ).toBeLessThanOrEqual(calls.length);
    }
  });
  it("the closed sets are the ones the migration's CHECKs carry", () => {
    // The vocabulary and the constraints are reconciled against real Postgres elsewhere; this is
    // the cheap half that keeps the TS side from drifting on its own.
    expect([...ORGANIZER_ROLES]).toEqual(["organizer", "reader"]);
    expect([...ORGANIZER_KINDS]).toEqual(["cloud", "local", "mobile", "unknown"]);
    expect([...ORGANIZER_STATES]).toEqual(["held", "stopped"]);
  });
});

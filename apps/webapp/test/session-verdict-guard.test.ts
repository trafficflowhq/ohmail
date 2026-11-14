/**
 * ═══ THE VERDICT HAS FOUR WRITERS AND NONE OF THEM IS A `catch` ════════════════════════════
 *
 * A source guard, because the defect it prevents is not a behaviour a test can reach: it is a
 * LINE. `setBinding({ status: "unauthenticated" })` inside a `.catch(` compiles, passes every
 * behavioural suite whose failures happen to be classified, and puts "You are signed out." in
 * front of somebody whose session is fine — which is exactly what shipped, for the whole life
 * of the build, until a `503 db_busy` was caught in the act
 * (the project's design notes).
 *
 * The behavioural guards in `session-confirm-retries.test.ts` cover the failures we thought
 * of. This covers the next one: a `catch` added a year from now for a reason nobody here
 * anticipated, reaching for the nearest terminal binding.
 *
 * ── AND IT PINS THE ONE CLASSIFIER ─────────────────────────────────────────────────────────
 *
 * Two screens ask "is there a session?" — the shell's confirm and `/login`'s bootstrap — and
 * before this slice each held its own `catch` and its own answer, which is why the reported
 * defect had two contradictory halves inside ten seconds. Neither file may call
 * `auth.session()` directly again; both go through `resolveOwnerOutcome`.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// ONE scanner, so a `//` inside a string is never read as a comment — the quoted glob in
// packages/services/src/mailbox-service.ts opened one, and a bracket walk ran off the file.
import * as scan from "../../../scripts/lib/source-scan.mjs";

const readRaw = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

/**
 * The file with its COMMENTS REMOVED — which is the difference between a guard and a
 * spell-checker.
 *
 * These files document the defect they close, so the prose legitimately contains the very
 * strings the assertions forbid: `session-outcome.ts` has a whole section headed "WHY NOT
 * `sessionIsDead()`", and `engine.tsx` quotes the `catch` it replaced. A guard that read those
 * as code would be red on a correct file — which trains the next reader to weaken it, and a
 * weakened guard is worse than none.
 *
 * String and template literals are skipped so that a `//` inside one (a URL) does not swallow
 * the rest of a line.
 */
function code(rel: string): string {
  const src = readRaw(rel);
  let out = "";
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === "//") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    const ch = src[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < src.length) {
        out += src[i];
        if (src[i] === "\\") { out += src[i + 1] ?? ""; i += 2; continue; }
        if (src[i] === quote) { i += 1; break; }
        i += 1;
      }
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}


const ENGINE = "../app/shell/engine.tsx";
const CLOUD_SHELL = "../app/(product)/mailbox/CloudShell.tsx";
const LOGIN = "../app/(product)/login/LoginScreen.tsx";

/**
 * The bodies of every `.catch(` in a source file, by brace matching from the first `{` after
 * the opener. Crude on purpose: a regex cannot find the end of a block, and the alternative —
 * parsing — would make this guard depend on a parser's opinion of TSX. The count assertion
 * below is what keeps the crudeness honest: if this ever finds no `catch` at all, the test
 * fails rather than passing vacuously.
 */
function catchBodies(src: string): string[] {
  const bodies: string[] = [];
  for (let i = src.indexOf(".catch("); i !== -1; i = src.indexOf(".catch(", i + 1)) {
    const open = src.indexOf("{", i);
    if (open === -1) continue;
    let depth = 0;
    let end = open;
    for (let j = open; j < src.length; j += 1) {
      if (src[j] === "{") depth += 1;
      else if (src[j] === "}") {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    bodies.push(src.slice(open, end + 1));
  }
  return bodies;
}

describe("engine.tsx: the verdict is written in four places and only four", () => {
  const src = code(ENGINE);

  it("names `unauthenticated` exactly four times", () => {
    /*
     * The four, and what each one is:
     *   1. the `Binding` union's own arm — the declaration;
     *   2. no `resolveOwner` at all, so this build cannot ask (the desktop's path);
     *   3. the `none` outcome: the SERVER answered that there is no full session;
     *   4. a confirmed owner that is not the account whose mirror is on screen.
     *
     * A fifth is a claim somebody has to argue for in a diff. `unknown`, a thrown
     * `createEngine`, a rejected classifier: none of those may be here.
     */
    const hits = src.match(/status: "unauthenticated"/g) ?? [];
    expect(hits, "a writer of the signed-out verdict was added or removed").toHaveLength(4);
  });

  it("writes it in NO `.catch(` block", () => {
    const bodies = catchBodies(src);
    // Vacuity check first: this file HAS catch blocks, so finding none means the matcher
    // broke and the assertion below would be worthless.
    expect(bodies.length, "the catch-block matcher found nothing — the guard is not guarding")
      .toBeGreaterThan(0);
    const offenders = bodies.filter((b) => b.includes('status: "unauthenticated"'));
    expect(
      offenders,
      "a failure was turned into a signed-out verdict inside a catch — the original defect",
    ).toEqual([]);
  });

  it("still carries the two states that are not verdicts", () => {
    // The other half of the same claim: removing `checking`/`unconfirmed` and going back to
    // one terminal state would satisfy the count above.
    expect(src).toContain('status: "checking"');
    expect(src).toContain('status: "unconfirmed"');
    expect(src, "the ladder no longer reports an exhausted check").toContain("unconfirmedTitle");
  });
});

describe("one classifier, two callers", () => {
  it("neither the shell nor /login asks the server itself", () => {
    for (const rel of [CLOUD_SHELL, LOGIN]) {
      expect(code(rel), `${rel} went back to its own session read`).not.toContain("auth.session(");
    }
  });

  it("both import resolveOwnerOutcome", () => {
    for (const rel of [CLOUD_SHELL, LOGIN]) {
      expect(code(rel), `${rel} does not use the shared classifier`)
        .toContain("resolveOwnerOutcome");
    }
  });

  it("the classifier's verdict arm is exactly two facts wide", () => {
    const src = code("../app/(product)/session-outcome.ts");
    const verdicts = src.match(/return \{ kind: "none" \}/g) ?? [];
    expect(verdicts, "an arm was added to the verdict — or removed from it").toHaveLength(2);
    // The coded-401 arm must keep BOTH of its conditions. Either one alone is a defect this
    // repository has already measured: `wire.coded` alone lets a platform 401 speak for our
    // server, and the status alone lets a transient one speak for a revocation.
    expect(src).toContain('err.status === 401 && err.wire.coded && lastRefreshOutcome() === "revoked"');
    // And it must not key on the sticky latch — see `session-outcome.ts`'s own header.
    expect(src, "the classifier read the sticky death latch").not.toContain("sessionIsDead");

    /*
     * THE TOKEN-PRESENCE FORM OF THIS ASSERTION IS SATISFIABLE BY WRONG CODE, so it is not the
     * whole guard. `err.status === 401 && err.wire.coded && lastRefreshOutcome() === "revoked"
     * || err.wire.retryable === false` contains the required substring, still returns
     * `{ kind: "none" }` exactly twice, and still never says `sessionIsDead` — and it
     * reintroduces the one predicate the ruling forbids by name.
     *
     * So the classifier may not mention `retryable` AT ALL. It is carried on `ApiWire` for
     * backoff and reporting, and this module is the one place it must never be read. The
     * behavioural half is in `session-confirm-retries.test.ts` ("a 5xx declaring
     * retryable:false is still retried").
     */
    expect(src, "the classifier reads `retryable` — it may be carried, never consulted here")
      .not.toContain("retryable");

    // The verdict arm is a conjunction and stays one: an `||` anywhere in it is a second arm
    // wearing the first one's clothes.
    const arm = src.split("\n").find((l) => l.includes('lastRefreshOutcome() === "revoked"'));
    expect(arm, "the coded-401 verdict arm is gone").toBeTruthy();
    expect(arm, "the verdict arm grew an alternative").not.toContain("||");

    /*
     * AND NO STATUS ARM ANYWHERE IN THE CATCH, HOWEVER IT IS SPELLED.
     *
     * The line-scoped check above is evadable: `err.status === 418 ||` on the line BEFORE the
     * conjunction leaves that line free of `||`, keeps exactly two `none` returns, and
     * reintroduces a status-based verdict. A behavioural table cannot cover every status
     * somebody might add, so the structural claim has to be the strong one: inside the catch,
     * `err.status` may be compared to exactly two values — `0` (the unarmed-build rethrow) and
     * `401` (the one refusal that is a verdict).
     *
     * ── THIS USED TO BE AN EQUALITY SCAN, AND AN EQUALITY SCAN IS NOT THE CLAIM ─────────────
     *
     * It read every `err.status === <digits>` and required the set to be exactly `{0, 401}`,
     * plus a separate refusal of `<`/`>`. Review found the hole in one line:
     *
     *     if ([418].includes(err.status) || (err.status === 401 && …)) return { kind: "none" };
     *
     * No new `===`, no inequality, two `none` returns, the required 401 substring intact —
     * green, with a transient status reinstated as a verdict. `switch (err.status)`, a
     * `Set.has`, an `indexOf` and an `in` all evade it the same way. The scan was checking one
     * SPELLING of the rule rather than the rule.
     *
     * Two claims replace it, and they close different halves:
     *
     *   1. EVERY use of `err.status` in the catch is immediately one of the two permitted
     *      equalities. Not "no forbidden comparison exists" but "no other use exists at all",
     *      which is the difference between a list of spellings and a rule. `.includes(…)`,
     *      `switch (…)`, `has(…)` and an inequality all fail it by construction.
     *
     *   2. No HTTP-status-shaped literal appears in the module beyond the ones the file
     *      genuinely needs. That closes the copy-it-into-a-variable route — `const s =
     *      err.status; if (s === 418)` satisfies (1) — because a new status arm has to name
     *      its status somewhere, and prose in comments is stripped before the scan so the
     *      header may keep explaining why 419, 429 and 503 are NOT verdicts.
     */
    const body = src.slice(src.indexOf("} catch (err)"));
    const uses = [...body.matchAll(/err\.status/g)];
    expect(uses.length, "the catch stopped reading `err.status` at all").toBeGreaterThan(0);
    const spellings = uses.map((u) => {
      const after = body.slice((u.index ?? 0) + "err.status".length, (u.index ?? 0) + 40);
      return /^\s*===\s*(0|401)\b/.exec(after)?.[1] ?? `OTHER:${after.trim().slice(0, 24)}`;
    });
    expect([...spellings].sort(), "the catch reads `err.status` somewhere other than the two permitted equalities")
      .toEqual(["0", "401"]);

    /* Comments out first: the header's whole job is to name the statuses that are NOT verdicts,
       and a scan that could not tell prose from code would forbid it from saying so. */
    const codeOnly = scan.withoutComments(src);
    const literals = [...codeOnly.matchAll(/(?<![\w.$])(\d{3})(?![\w.$])/g)].map((m) => m[1]);
    expect([...new Set(literals)].sort(), "an HTTP status literal appeared in the classifier's code")
      .toEqual(["401"]);
  });
});

describe("the sync gate is built closed, and opened in exactly two places", () => {
  it("createSyncGate takes the mirror's name with no default", () => {
    /*
     * A DEFAULTED owner would make the permissive branch the one every caller gets by
     * omission — the shipped path becomes the one no test drives, which is the failure this
     * repository keeps paying for. `engine-config.ts` must hand it the name that also names
     * the IndexedDB database, so the gate can ask whether the session belongs to this mirror.
     */
    const src = code("../app/shell/engine-config.ts");
    expect(src, "the live engine's gate no longer knows which mirror it guards")
      .toMatch(/createSyncGate\(owner\s*\?\?\s*null\)/);
    const sched = code("../../../packages/app-logic/src/session/sync-scheduler.ts");
    expect(sched, "createSyncGate grew a default — the closed-by-default property is gone")
      .not.toMatch(/createSyncGate\(\s*\w+\s*:\s*[^)]*=\s*/);
    // And no permissive escape hatch on the options: a `mayMerge` with a default is the same
    // defect wearing a different name.
    expect(sched, "an option was added that can re-open the gate by omission")
      .not.toMatch(/mayMerge/);
  });

  it("confirmSyncOwner is called exactly twice, and never from a catch", () => {
    const src = code(ENGINE);
    const calls = src.match(/confirmSyncOwner\(/g) ?? [];
    // Twice: the warm engine once the comparison passes, and the cold-built engine. The
    // MISMATCH arm calls nothing — that is the defence in depth behind that change.
    expect(calls, "a gate is opened somewhere new, or one of the two stopped opening")
      .toHaveLength(2);
    const bodies = catchBodies(src);
    expect(bodies.length).toBeGreaterThan(0);
    expect(
      bodies.filter((b) => b.includes("confirmSyncOwner(")),
      "a sync gate is opened from inside a catch — a failure would grant a merge",
    ).toEqual([]);
  });
});

describe("the schedule is not configurable", () => {
  it("EngineProvider takes no schedule prop", () => {
    // A `schedule` override with defaults means the shipped numbers are the ones no test
    // drives — `confirm-schedule.ts` carries the argument. This is the structural half.
    const src = code(ENGINE);
    expect(src).not.toMatch(/schedule\??:/);
    expect(src, "the schedule is no longer read from the pinned module")
      .toContain('from "@ohmail/app-logic/session/confirm-schedule"');
  });
});

describe("the copy on the unconfirmed surface is not a verdict", () => {
  it("says the check did not finish, in both languages, and never 'signed out'", () => {
    for (const locale of ["en", "de"]) {
      const messages = JSON.parse(readRaw(`../messages/${locale}.json`)) as {
        session: Record<string, string>;
      };
      const keys = ["unconfirmedTitle", "unconfirmedBody", "unconfirmedBodyWarm", "tryAgain"];
      for (const key of keys) {
        expect(messages.session[key], `${locale}.session.${key} is missing`).toBeTruthy();
      }
      for (const key of ["unconfirmedTitle", "unconfirmedBody", "unconfirmedBodyWarm"]) {
        const text = messages.session[key]!.toLowerCase();
        expect(text, `${locale}.session.${key} claims a sign-out`).not.toContain("signed out");
        expect(text, `${locale}.session.${key} claims a sign-out`).not.toContain("abgemeldet");
      }
      // And the two body strings must say what actually happened rather than only what did
      // not: a title alone would let the bodies drift back into verdict language.
      expect(messages.session.unconfirmedBody).toBeTruthy();
      expect(messages.session.unconfirmedBodyWarm, `${locale} warm body does not mention the device`)
        .toMatch(locale === "en" ? /device/i : /Gerät/i);
    }
  });
});

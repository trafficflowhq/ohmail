import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  STAND_DOWN_SEND_SENTENCES, REMOVED_MAILBOX_SEND_SENTENCE,
} from "../src/stand-down-sends.js";
import { readSource as readStartFunction } from "../../../apps/worker/test/_start-function.js";
import { isEnginePart, readingTheUnit } from "../../../test/support/engine-unit.js";

/** The worker's start function and the desktop's engine each read as one text. */
const readSource = readingTheUnit(readStartFunction);

/**
 * EVERY STAND-DOWN CLOSES THE APPOINTMENTS IT ORPHANS — the structural half of
 * `QAO-SCHEDULED-SEND-ORPHANED-BY-MIGRATION`.
 *
 * The behavioural halves live where the behaviour is: the engine's gate and its launch catch-up in
 * `apps/sidecar/test/scheduled-send-stand-down.test.ts`, the mechanism and the double-send
 * boundary in `packages/services/test/scheduled-send-stand-down.pg.test.ts`. Neither can say
 * anything about a stand-down path somebody adds NEXT, and that is the whole shape of the original
 * defect: the appointment was orphaned not because a rule was broken but because a gate existed
 * that nobody had asked this question about.
 *
 * So this is a census, and the invariant it pins is one sentence: **a file that stands a mailbox
 * down must also close that mailbox's appointments.** A new organizer gate, a new roster sweep, a
 * new cron that writes `disabled` + `disabled_reason` — each of them fails here until it does.
 *
 * ── WHY EXACT-SET EQUALITY, NOT "NOTHING OUTSIDE THE ALLOWLIST" ─────────────────────────────
 *
 * `flag-intent-census.test.ts`'s reason verbatim: a scanner that finds nothing is green, and a
 * broken scanner finds nothing. Asserting the found set EQUALS the allowlist means a regression in
 * the walk or in either needle goes red on the files that are known to contain them, so this
 * cannot be vacuously green.
 *
 * Scope: `packages/*\/src` and `apps/*\/src` plus `apps/*\/app` — product source only. Tests write
 * `disabled` rows to stage fixtures constantly; they are not writers of record.
 */

const REPO = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * A STAND-DOWN WRITE, in the two spellings that exist.
 *
 * Cloud goes through the fenced lifecycle helper; the desktop writes its own row inline, because
 * its store has no shard, no leader and therefore no fence to apply. `markMailboxStoodDown(db,`
 * and not the bare name, so the helper's own DEFINITION in `apps/worker/src/mailboxes.ts` is not
 * counted as a stand-down — it is the write, not a decision to stand down, and it has no mailbox
 * whose appointments it could close.
 *
 * ── THE SECOND NEEDLE MOVED WITH MAIL 0083, AND THE OLD ONE WOULD NOW MATCH NOTHING ─────────
 *
 * It read `status: "disabled", disabledReason: (?!null)` — the pair that WAS a stand-down while
 * the loser stopped entirely. A loser is now a READER: `organizer_role = 'reader'` plus the four
 * holder columns, with `status` untouched and `disabled_reason` gaining no writer at all. So the
 * old needle matches nothing any current build writes, and a census whose needle matches nothing
 * is vacuously green — which is the exact failure the exact-set assertion below exists to make
 * impossible, and it would have been reached silently by leaving this line alone.
 *
 * The excluded case it used to carry is now excluded BY CONSTRUCTION rather than by a lookahead.
 * `apps/sidecar/src/cloud-mirror.ts` writes `{status: "disabled", disabledReason: null}` — a
 * RETIREMENT TOMBSTONE, a mailbox the hosted account no longer names — and it does not write a
 * ROLE, because a removal demotes nothing: it retires the row. Closing appointments there would
 * be closing them on a row the same transaction is replacing, and `closeRemovedMailboxAppointments`
 * is the function that serves it, with its own precondition and its own sentence.
 *
 * ── COMMENTS ARE STRIPPED BEFORE MATCHING, AND THAT IS A STRENGTHENING ──────────────────────
 *
 * It was not, and mail 0083 found the hole the useful way: `apps/worker/src/mailboxes.ts` gained
 * a comment MENTIONING `closeStoodDownAppointments` (to say the close now keys on the role), and
 * the census read the file as a call site. The direction that matters is the other one — a file
 * whose only occurrence of the close is in PROSE would have satisfied the needle and been counted
 * as "the close is reached from here", which is a stand-down site certified by a sentence. So
 * both needle sets now run over source with comments removed.
 */
const STAND_DOWN_NEEDLES = [
  // The call with the handle it writes on as its first argument: `db`, or a handle read off one
  // account's view (`scope.forAccount(mb.accountId).db` in the worker's start file, read here as
  // `forAccount(mb.accountId).db`), since every statement of the worker rides the account it is for.
  /markMailboxStoodDown\([\w.()]*\bdb,/,
  // The INLINE demotion — the role AND the holder it names, adjacent. Both terms are needed and
  // the second is what makes it a demotion: `MailboxService.create` writes `organizerRole:
  // "reader"` too, because a NEW mailbox is a consent-less reader (mail 0083), and that is a
  // BIRTH with nobody holding it and no appointment to orphan. A demotion always names who took
  // the mailbox, because that is what the banner renders.
  /organizerRole: "reader",\s*organizedByKind:/,
];

/**
 * WHERE THE WRITE IS DEFINED, as opposed to where a stand-down is DECIDED.
 *
 * `apps/worker/src/mailboxes.ts` holds `markMailboxStoodDown` itself, so it necessarily contains
 * the inline spelling the second needle looks for. It is the same carve-out the FIRST needle
 * makes with `(db,` rather than the bare name, and for the same stated reason: it is the write,
 * not a decision to stand down, and it has no mailbox whose appointments it could close.
 *
 * A path exclusion rather than a cleverer regex, because the alternative is a needle that has to
 * stay one step ahead of how the helper happens to be written — and a census whose needle stops
 * matching is vacuously green, which is the failure this whole file is shaped to prevent.
 */
const STAND_DOWN_DEFINITION_SITES = new Set([
  ["apps", "worker", "src", "mailboxes.ts"].join(sep),
]);

/**
 * THE CLOSE, in either spelling: the shared function, or a local wrapper named for it. The
 * sidecar wraps it (`standDownAppointments`) so that its two call sites — the gate and the launch
 * catch-up — share one non-throwing log convention; the worker does the same for its gate.
 */
const CLOSE_NEEDLES = [/closeStoodDownAppointments/, /standDownAppointments\(/];

/** Where a stand-down is DECIDED today. Add a file here only by adding the close to it. */
const STAND_DOWN_SITES = new Set([
  ["apps", "sidecar", "src", "engine.ts"].join(sep),
  ["apps", "worker", "src", "index.ts"].join(sep),
  ["apps", "worker", "src", "reconcile-cron.ts"].join(sep),
  /* THE FOURTH, and it is here because it closes: `identity.ts#endLegacyOrganizerPauses` writes
     the reader shape for a row a build older than mail 0083 left `disabled` with a reason, which
     is the same demotion in the same columns and carries the same orphan — a send scheduled
     before the handover, on a row this rewrite makes `connected` again while the scheduled-send
     pass stays inside a drain a reader never runs. `closeRemovedMailboxAppointments`' own docblock
     already names this file as the one that resurrects a paused mailbox. */
  ["apps", "sidecar", "src", "identity.ts"].join(sep),
]);

/**
 * Where the close is reached from. The three stand-down sites plus the module that defines it and
 * the barrel that names it — and nothing else, so a fourth consumer is a deliberate decision
 * rather than an accident.
 */
const CLOSE_SITES = new Set([
  ["apps", "sidecar", "src", "engine.ts"].join(sep),
  /* The boot repair calls the shared function directly rather than through the sidecar's own
     wrapper: that wrapper lives inside the per-mailbox closure in `engine.ts` (it names `mb.id`
     and the world's account), and this write happens before any runtime exists. */
  ["apps", "sidecar", "src", "identity.ts"].join(sep),
  ["apps", "worker", "src", "index.ts"].join(sep),
  ["apps", "worker", "src", "reconcile-cron.ts"].join(sep),
  ["packages", "db", "src", "index.ts"].join(sep),
  ["packages", "db", "src", "stand-down-sends.ts"].join(sep),
]);

const SKIP_DIRS = new Set(["node_modules", "dist", "test", "tests", "__tests__", ".next", "coverage"]);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (name.endsWith(".ts") || name.endsWith(".tsx")) {
      if (name.endsWith(".test.ts") || name.endsWith(".test.tsx") || isEnginePart(p)) continue;
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
        } catch {
          /* no such subdir — fine */
        }
      }
    }
  }
  return roots;
}

/**
 * Source with COMMENTS REMOVED — line, block and doc. See the needle block above: a file that
 * merely names the close in prose is not a call site, and counting one as a call site is a
 * stand-down certified by a sentence.
 *
 * Crude on purpose (it does not respect strings or regex literals), which is safe here because
 * the only thing done with the result is a needle test: the worst a mis-stripped string literal
 * can do is hide a needle, and a hidden needle fails the exact-set assertion loudly rather than
 * passing quietly.
 */
function withoutComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/[^\n]*$/gm, "");
}

function filesContaining(
  needles: readonly RegExp[], exclude: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const found = new Map<string, string>();
  for (const root of rootsOf()) {
    for (const file of walk(root)) {
      const rel = relative(REPO, file);
      if (exclude.has(rel)) continue;
      const src = readSource(file);
      if (needles.some((n) => n.test(withoutComments(src)))) found.set(rel, src);
    }
  }
  return found;
}

describe("a stand-down closes the appointments it orphans", () => {
  it("the stand-down sites are exactly the three known ones", () => {
    const found = filesContaining(STAND_DOWN_NEEDLES, STAND_DOWN_DEFINITION_SITES);
    expect([...found.keys()].sort()).toEqual([...STAND_DOWN_SITES].sort());
  });

  it("every stand-down site also closes that mailbox's scheduled sends", () => {
    const found = filesContaining(STAND_DOWN_NEEDLES, STAND_DOWN_DEFINITION_SITES);
    // Not merely "the allowlist is unchanged": each file is opened and asked. A site that keeps
    // its place in the list above while losing the call is the exact regression this guards.
    for (const [file, src] of found) {
      expect(CLOSE_NEEDLES.some((n) => n.test(src)),
        `${file} stands a mailbox down and never closes its pending scheduled sends — a pending `
        + "appointment on a mailbox this process no longer organizes is never delivered and never "
        + "reported as failed").toBe(true);
    }
    // And the walk found something, so a scanner that stopped working is red rather than green.
    expect(found.size).toBe(STAND_DOWN_SITES.size);
  });

  it("the close is reached from exactly the expected files", () => {
    const found = filesContaining(CLOSE_NEEDLES);
    expect([...found.keys()].sort()).toEqual([...CLOSE_SITES].sort());
  });

  /**
   * ── THE COPY PARITY, ENFORCED FROM THE SIDE THAT OWNS THE WORDS ─────────────────────────
   *
   * `send_error` is a STORED sentence: the server writes it once and both clients quote it
   * verbatim, months later, inside their own frame. So the two client tests that assert what a
   * reader actually sees have to name the words — and neither `apps/webapp` nor `apps/mobile`
   * depends on this package, nor should either start to for a test (a browser bundle and a phone
   * bundle have no business naming the server's schema package, and both apps typecheck their own
   * test directories, where the import would not resolve).
   *
   * Reading their files from here is the honest resolution: the words live in exactly one place,
   * and a change to them is red until the surfaces that render them are updated too. Without
   * this, editing a sentence leaves two green client tests asserting copy the product no longer
   * has.
   */
  it("the client tests quote the sentences this module actually stores", () => {
    const quoting: Array<[string, string]> = [
      [join("apps", "webapp", "test", "drafts-stand-down.test.tsx"),
        STAND_DOWN_SEND_SENTENCES["organized_elsewhere:cloud"]],
      [join("apps", "mobile", "test", "scheduled-stand-down.test.ts"),
        STAND_DOWN_SEND_SENTENCES["organized_elsewhere:local"]],
    ];
    for (const [rel, sentence] of quoting) {
      const src = readSource(join(REPO, rel));
      // The test files wrap the sentence across source lines, so the comparison is over the
      // whitespace-collapsed text rather than the literal — a `+`-joined string in TypeScript is
      // one sentence to a reader and two lines to a scanner.
      const flat = src.replace(/"\s*\+\s*"/g, "").replace(/\s+/g, " ");
      expect(flat, `${rel} quotes a stand-down sentence this module no longer stores`)
        .toContain(sentence.replace(/\s+/g, " "));
    }
  });

  /**
   * A `send_error` OUTLIVES ITS OWN OCCASION — it is read whenever the person next opens Drafts,
   * which can be after the mailbox has come back to this install ("Organize from this machine").
   * So the cause is past tense and the action names no destination. Asserted over all three
   * rather than over the two the client tests happen to render.
   */
  it("every sentence stays true after the mailbox moves again", () => {
    for (const sentence of Object.values(STAND_DOWN_SEND_SENTENCES)) {
      expect(sentence, "an action clause naming a destination is standing advice to go somewhere "
        + "the mailbox may no longer be").toContain(
        "Schedule it again where the mailbox is organized now.",
      );
      expect(sentence, "the cause must be past tense").toMatch(/took over/);
      expect(sentence, "the frame already says it was not sent; the sentence says why")
        .not.toMatch(/wasn't sent|was not sent at/);
    }
  });

  /**
   * ── THE REMOVAL ARM, CENSUSED ON THE SAME ARGUMENT ────────────────────────────────────────
   *
   * A removal orphans appointments exactly as a stand-down does, and for the whole life of this
   * module the stand-down's close REFUSED it by construction: the precondition requires a
   * `disabled_reason`, and `MailboxService.delete` clears that column in the same statement that
   * writes the tombstone. So the one event a user triggers deliberately was the one event whose
   * appointments were never closed.
   *
   * The set is small and deliberately pinned: the definition, the barrel, and the ONE service
   * that removes a mailbox. A second caller is a decision somebody has to make here first —
   * which is the same rule `CLOSE_SITES` states for the stand-down.
   */
  const REMOVAL_CLOSE_NEEDLES = [/closeRemovedMailboxAppointments/];
  const REMOVAL_CLOSE_SITES = new Set([
    ["packages", "db", "src", "index.ts"].join(sep),
    ["packages", "db", "src", "stand-down-sends.ts"].join(sep),
    ["packages", "services", "src", "mailbox-service.ts"].join(sep),
  ]);

  it("the removal close is reached from exactly the expected files", () => {
    const found = filesContaining(REMOVAL_CLOSE_NEEDLES);
    expect([...found.keys()].sort()).toEqual([...REMOVAL_CLOSE_SITES].sort());
  });

  /**
   * THE ONE SERVICE THAT REMOVES A MAILBOX MUST CLOSE ITS APPOINTMENTS — asked of the file
   * rather than of the allowlist, the same way the stand-down sites are asked, so a
   * `MailboxService.delete` that keeps its place in the list while losing the call is red.
   */
  it("MailboxService.delete closes the appointments its removal orphans", () => {
    const src = readFileSync(
      join(REPO, "packages", "services", "src", "mailbox-service.ts"), "utf8",
    );
    expect(/closeRemovedMailboxAppointments\(/.test(src),
      "packages/services/src/mailbox-service.ts removes a mailbox and never closes its pending "
      + "scheduled sends — a pending appointment on a mailbox whose credentials have just been "
      + "deleted is never delivered and never reported as failed").toBe(true);
  });

  /**
   * THE REMOVAL SENTENCE SAYS SOMETHING THE STAND-DOWN SENTENCES MUST NOT, AND VICE VERSA.
   *
   * A removal has no successor organizer, so the stand-down's action clause would be advice to
   * go nowhere. And a removal raises one question a handover does not — "is my mail gone?" —
   * whose answer is the product's central promise and is false nowhere in the code: nothing on
   * this path touches the IMAP mailbox.
   */
  it("the removal sentence names no other organizer and says the mail is untouched", () => {
    expect(REMOVED_MAILBOX_SEND_SENTENCE, "the cause must be past tense and stay true after the "
      + "mailbox is connected again").toMatch(/was removed/);
    expect(REMOVED_MAILBOX_SEND_SENTENCE, "there is no other organizer to send the reader to")
      .not.toContain("organized now");
    expect(REMOVED_MAILBOX_SEND_SENTENCE, "the question a removal raises is whether the mail is "
      + "gone, and the answer belongs in the sentence that reports the failure")
      .toContain("Nothing was deleted from the mail server.");
  });
});

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * ═══ THE ENGAGEMENT CENSUS — EVERY SITE THAT READS AN OWN-ADDRESS REPLY AS "THEY ENGAGED" ═══
 *
 * One rule: **an automatic reply by the away responder is not the person's engagement.** The rule
 * has a single executable home (`packages/db/src/auto-reply-by-us.ts#autoReplyByUsWhere`) and a
 * shrinking number of places that ask it, and the risk this file exists for is not that the home
 * is wrong — it is that a SIXTH place gets written which asks the old question and nobody notices,
 * because a query that reads an own-address message in a thread as "hands off" is a perfectly
 * coherent query that returns rows.
 *
 * The pattern is a known copy-paste family in this tree: four passes carry byte-identical
 * `not exists (… lower(sent.from_address) in (…))` subqueries, and `sensitive-rescreen.ts` already
 * carries a docblock enumerating the sibling sites of a DIFFERENT predicate for the same reason.
 * A census is the instrument that fits.
 *
 * `readFileSync`, never `grep`: a single NUL byte anywhere in a source file makes `file` report it
 * as data, after which grep silently skips the whole file and exits 1 — indistinguishable from
 * "the string is not there". This census would then pass by finding nothing.
 */

const ROOT = join(import.meta.dirname, "..");

/** Every `.ts` under the `src` of every app and package. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try { entries = readdirSync(dir); } catch { return; }
    for (const e of entries) {
      if (e === "node_modules" || e === "dist" || e === "build") continue;
      const p = join(dir, e);
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (e.endsWith(".ts") || e.endsWith(".tsx")) out.push(p);
    }
  };
  for (const group of ["apps", "packages"]) {
    let pkgs: string[];
    try { pkgs = readdirSync(join(ROOT, group)); } catch { continue; }
    for (const pkg of pkgs) walk(join(ROOT, group, pkg, "src"));
  }
  return out;
}

const rel = (p: string) => p.slice(ROOT.length + 1);
const FILES = sourceFiles().map((p) => ({ path: rel(p), text: readFileSync(p, "utf8") }));

/** THE PREDICATE'S OWN HOME — excluded from the caller census, it is the definition. */
const HOME = "packages/db/src/auto-reply-by-us.ts";
/** The barrel that re-exports it. Not a consumer. */
const BARREL = "packages/db/src/index.ts";
/** "Did the person answer THIS SENDER" — the one home of the three passes' own question. */
const ENGAGEMENT_HOME = "packages/db/src/we-answered.ts";

/**
 * THE SITES that ask "is there an own-address message in this thread", in TWO classes.
 *
 * It was four until the census regex was made case-insensitive. The lowercase-only `in` missed
 * `away-responder-pass.ts`, which writes its SQL in uppercase — and that site is the one place the
 * answer must NOT change, so the blind spot was hiding the most consequential row of the three
 * classes. Found by review as a GUARD row; the regex now carries `i` and the shape is asserted
 * over the whole list.
 */
const CONSULTS = [
  // The contact-only held set (`contact-only-held.ts`), the one spelling 0.19.0's gate release and
  // the held-release offer's sender lines share. It selects held rows directly, so it carries
  // `rule-retro`'s own five user-intent exclusions including this one — an automatic reply the
  // responder sent while somebody was away is not that person deciding to keep a message at the gate.
  "packages/db/src/contact-only-held.ts",
  // The three passes' own copies COLLAPSED into this one fragment (LEARN-023). It applies the
  // predicate on their behalf, and the arm below asserts each of them reaches it.
  ENGAGEMENT_HOME,
];

/**
 * THE READERS — the three passes, the Ohbox's screen and the re-screen — spell no subquery; they
 * import one.
 *
 * Their copies asked thread MEMBERSHIP: any own-address message anywhere in the thread, so being
 * copied on a conversation nobody answered read as the person having dealt with it. The question
 * now has one executable home and these are its readers; a FOURTH pass that writes the old shape
 * reds in the census above, which names the file and makes whoever wrote it choose a class.
 */
const ENGAGEMENT_READERS = [
  "apps/worker/src/ohbox-tidy.ts",
  "apps/worker/src/rule-retro.ts",
  // the undecided-sender screen asked thread membership in the class it copied from
  // `ohbox-tidy.ts` until FIX-025 put it on the one question its three siblings ask.
  "packages/core/src/unscreened-set.ts",
  // The sensitive re-screen was the last KNOWN_UNFIXED site: its exclusion 5 read the away
  // responder's reply, and a reply to somebody else, as the person having answered this sender.
  "packages/services/src/sensitive-rescreen.ts",
];
/**
 * THE INTENTIONAL EXCEPTION — the site that must go on counting an auto-reply as a reply.
 *
 * `away-responder-pass.ts`'s `alreadyReplied` asks whether this correspondent has ALREADY heard
 * from this mailbox about this thread, and hands that to `awayEligibility` as the suppression it
 * is. Here an earlier automatic reply is exactly what should stop a second one: the field's own
 * docblock says so ("a manual reply the person typed themselves and an earlier automatic reply
 * from any install both land as a message in the thread whose author is us … it covers the case
 * the ledger cannot"), and the ledger is per-install, so this is the only thing that sees a reply
 * another install sent.
 *
 * Applying `autoReplyByUsWhere` there would make the responder answer a thread it has already
 * answered — the duplicate the ledger exists to prevent, and at worst the unbounded exchange
 * between two mail systems that `Auto-Submitted` exists to stop. So this entry is asserted to
 * NOT consult the predicate, and a well-meaning future sweep that "finishes the job" reds here.
 */
const INTENTIONAL = [
  "packages/services/src/away-responder-pass.ts",
];
/**
 * The shape all five share — alias-agnostic so a new site with a new alias still matches, and
 * CASE-INSENSITIVE because SQL is. The missing `i` was the GUARD finding: `away-responder-pass.ts`
 * writes `IN` and was invisible to this census.
 */
const OWN_ADDRESS_IN_THREAD = /\.from_?address\)\s*in\b/i;

describe("the engagement census: an auto-reply is not the person's engagement", () => {
  it("finds the own-address-in-thread subquery in EXACTLY the known sites", () => {
    const found = FILES.filter((f) => OWN_ADDRESS_IN_THREAD.test(f.text)).map((f) => f.path).sort();
    // A NEW site reds here. That is the whole point of the file: the failure message names the
    // new path, and whoever wrote it has to decide which of the classes it is in. The arm below
    // plants one and drives it through this same matcher, so the pin is evidence.
    expect(found).toEqual([...CONSULTS, ...INTENTIONAL].sort());
  });

  /**
   * THE REGEX ITSELF, asserted — the GUARD finding was a blind spot in this line, so the line is
   * now under test rather than trusted. A lowercase-only pattern passes every other case in this
   * file and silently covers four sites out of five.
   */
  it("matches the shape whatever case the SQL is written in", () => {
    expect(OWN_ADDRESS_IN_THREAD.test("and lower(sent.from_address) in (…)")).toBe(true);
    expect(OWN_ADDRESS_IN_THREAD.test("AND lower(m2.from_address) IN (")).toBe(true);
    expect(OWN_ADDRESS_IN_THREAD.test("AND LOWER(x.FROM_ADDRESS) IN (")).toBe(true);
    expect(OWN_ADDRESS_IN_THREAD.test("and lower(sent.fromAddress) in (")).toBe(true);
    // And it does not fire on an unrelated `in`.
    expect(OWN_ADDRESS_IN_THREAD.test("where sent.subject in ('a')")).toBe(false);
  });

  it("the INTENTIONAL exception does NOT consult the predicate, and must not start", () => {
    for (const path of INTENTIONAL) {
      const f = FILES.find((x) => x.path === path);
      expect(f, `${path} is on INTENTIONAL but is not a source file`).toBeDefined();
      // Reds if somebody applies the predicate here. See INTENTIONAL for why that is a defect
      // and not a completion.
      expect(f!.text, `${path} now consults the predicate — the responder would answer twice`)
        .not.toMatch(/autoReplyByUsWhere/);
      // And it really is the site the census thinks it is.
      expect(f!.text).toMatch(/alreadyReplied/);
    }
  });

  it("every site on the CONSULTS list actually applies the predicate", () => {
    for (const path of CONSULTS) {
      const f = FILES.find((x) => x.path === path);
      expect(f, `${path} is on the CONSULTS list but is not a source file`).toBeDefined();
      // `and not ${autoReplyByUsWhere(` — the applied form, not a mention in a comment.
      expect(f!.text, `${path} names the predicate but does not apply it`)
        .toMatch(/and not \$\{autoReplyByUsWhere\(/);
    }
  });

  /**
   * THE THREE PASSES REACH THE ONE QUESTION — and reach it as a REFUSAL, `not ${…}`.
   *
   * A pass that imported the fragment and forgot the `not` would exclude exactly the mail it
   * ought to keep, which is a coherent query returning rows: the same failure shape the whole
   * file exists for. Both halves are asserted per pass.
   */
  it("the three passes ask the ONE engagement question, and ask it as an exclusion", () => {
    for (const path of ENGAGEMENT_READERS) {
      const f = FILES.find((x) => x.path === path);
      expect(f, `${path} is an engagement reader but is not a source file`).toBeDefined();
      expect(f!.text, `${path} no longer asks whether the person answered this sender`)
        .toMatch(/\bweAnsweredThisSenderWhere\(/);
      expect(f!.text, `${path} asks the question but does not exclude on it`)
        .toMatch(/not \$\{weAnsweredThisSenderWhere\(/);
    }
  });

  it("the engagement question has exactly ONE executable home", () => {
    const definers = FILES
      .filter((f) => /export function weAnsweredThisSenderWhere/.test(f.text)).map((f) => f.path);
    expect(definers).toEqual([ENGAGEMENT_HOME]);
  });

  /**
   * THE CENSUS CAN FIRE — a planted FOURTH reader, driven through the real matcher.
   *
   * The equality above is only evidence if the regex would actually catch a new pass writing the
   * old subquery. A pin that has never been shown matching a plausible new site is a pin on the
   * files that happen to exist.
   */
  it("a planted fourth reader of the old shape is caught by the same matcher", () => {
    const planted = [
      "const filters = [eq(messages.accountId, opts.accountId)];",
      "filters.push(sql`not exists (",
      "  select 1 from ${messages} sent",
      "   where sent.account_id = ${messages.accountId}",
      "     and sent.thread_id = ${messages.threadId}",
      "     and lower(sent.from_address) in ${own}",
      ")`);",
    ].join("\n");
    expect(OWN_ADDRESS_IN_THREAD.test(planted), "a fourth pass would go unseen").toBe(true);
    // And the reader arm's own matcher does NOT admit it: the planted pass asks nothing.
    expect(/not \$\{weAnsweredThisSenderWhere\(/.test(planted)).toBe(false);
  });

  it("the predicate has exactly ONE executable home", () => {
    const definers = FILES.filter((f) => /export function autoReplyByUsWhere/.test(f.text)).map((f) => f.path);
    expect(definers).toEqual([HOME]);
    // And the SQL half of the header belt lives there too — a second copy is the drift.
    const belts = FILES.filter((f) => /function machineSentHeadersWhere/.test(f.text)).map((f) => f.path);
    expect(belts).toEqual([HOME]);
  });

  /**
   * THE FRAGMENT CONSUMERS, by path. It was three until the re-delivery pass landed, four until
   * the gate release did, five until the undecided-sender screen, and five again once the three
   * passes' own copies collapsed into `we-answered.ts`; this assertion is what made each lane
   * declare it: every one consults the same fragment to decide WHICH rows it acts on, so a site
   * that disagreed with the flag would act on the wrong rows and leave the right ones behind.
   * One fragment, one answer.
   */
  it("the fragment consumers are exactly the ones named, by path", () => {
    const consumers = FILES
      .filter((f) => f.path !== HOME && f.path !== BARREL && /\bautoReplyByUsWhere\s*\(/.test(f.text))
      .map((f) => f.path).sort();
    expect(consumers).toEqual([
      "apps/worker/src/away-reply-flag-redeliver.ts",
      // The correspondent predicate (FIX-023): an automatic reply in the Sent folder is not the
      // person writing to anybody, so it makes nobody a correspondent.
      "packages/core/src/correspondent.ts",
      // The contact-only held set, which the gate release and the held-release offer share.
      "packages/db/src/contact-only-held.ts",
      // `ohbox-tidy` and `rule-retro` reached it directly until LEARN-023; they now reach it
      // through the one engagement question, which applies it for all three passes.
      "packages/db/src/we-answered.ts",
      "packages/services/src/dto/materialize.ts",
    ]);
  });

  /**
   * THE DELIVERY ARM EXISTS AT ALL — the HIGH this pass answers.
   *
   * `autoReplyByUs` is computed at materialize time, so without something that re-emits a change
   * for the rows written before the flag shipped, the client filter reads `undefined` on every
   * reply already sitting in an Ohbox and the fix is invisible on exactly the mailboxes that
   * reported the bug. Deleting the pass leaves every other test in this file green.
   */
  it("a pass exists that re-delivers the flag to rows written before it", () => {
    const pass = FILES.find((f) => f.path === "apps/worker/src/away-reply-flag-redeliver.ts");
    expect(pass, "the re-delivery pass is gone — warm mirrors would never see the flag").toBeDefined();
    // It emits a change_log row and NOTHING else: no message write, no folder_state write.
    expect(pass!.text).toMatch(/recordChanges\(/);
    expect(pass!.text).not.toMatch(/\.update\(messages\)|\.update\(folderState\)/);
    // THE WALK REACHES THE END. The page budget it shipped with left everything past the first
    // thousand rows permanently stale, so the exhaustion contract is asserted here too: the result
    // carries `exhausted`, and the safety bound is a bound rather than a budget.
    expect(pass!.text).toMatch(/result\.exhausted = true/);
    expect(pass!.text).toMatch(/AWAY_REPLY_REDELIVER_MAX_PAGES = 5_000/);

    /**
     * THE SWEEP LIVES IN ITS OWN FILE, and that is a property rather than a preference.
     *
     * While `makeAwayReplySweep` sat beside the pass, the pass's only caller was inside the pass's
     * own file — and `every-pass-has-a-producer.test.ts` reports exactly that as `entry-only`, a
     * pass with no producer, because a caller in the defining file cannot answer "who runs this".
     * Re-inlining the sweep would put that census back to red, so the split is asserted here too:
     * the file that reds is not the file somebody would be editing.
     */
    const sweep = FILES.find((f) => f.path === "apps/worker/src/away-reply-sweep.ts");
    expect(sweep, "the sweep's own file is gone — the pass would read as producerless").toBeDefined();
    expect(sweep!.text).toMatch(/awayReplyFlagRedeliverPass\(/);
    // The DEFINITION, not the name: the pass's docblock legitimately cross-references the sweep,
    // and an assertion on the bare name fires on that comment — the same fire-on-innocent-content
    // mistake this file already corrected once, in its own subject-arm check below.
    expect(pass!.text, "the sweep moved back in beside the pass")
      .not.toMatch(/export function makeAwayReplySweep/);

    // And the cycle actually runs it, through the sweep that owns the gate — which a pass nobody
    // runs would not. The gate closes after its loop and only on a clean pass; `makeAwayReplySweep`
    // is where that is asserted (`away-reply-warm-mirror.test.ts`), and this is the wiring.
    const cycle = FILES.find((f) => f.path === "apps/worker/src/index.ts")!;
    expect(cycle.text).toMatch(/makeAwayReplySweep\(\)/);
    expect(cycle.text).toMatch(/awayReplySweep\.runOnce\(/);
    // The gate is the sweep's own, never a boolean the cycle sets before walking the accounts —
    // that shape retired the whole fleet's sweep on one account's failure.
    expect(cycle.text).not.toMatch(/awayReplyRedeliverDone/);
  });

  it("the ONE flag consumer is the Ohbox view, and it reads the flag the compatible way", () => {
    // The READ-AS-A-DECISION form, and only that. `materialize.ts` carries
    // `autoReplyByUs === undefined` in its spread guard — that is the PRODUCER deciding whether to
    // emit the key, not a consumer deciding what a row means, and a regex loose enough to catch it
    // would make this census fire on the code that sets the field.
    const consumers = FILES
      .filter((f) => /autoReplyByUs\s*!==\s*true/.test(f.text))
      .map((f) => f.path).sort();
    // The server's New for you fold reads the flag the Ohbox's own way (`isFromSomeone`), so a
    // resurfaced conversation folds on both sides by one answer.
    expect(consumers).toEqual(["packages/client-engine/src/selectors.ts", "packages/services/src/resurfaced-fold.ts"]);
    // Nowhere reads it the incompatible way.
    expect(FILES.filter((f) => /autoReplyByUs\s*===\s*false/.test(f.text)).map((f) => f.path)).toEqual([]);

    const sel = FILES.find((f) => f.path === "packages/client-engine/src/selectors.ts")!;
    // `!== true` and NEVER `=== false`: absent means "the person's", which is the behaviour every
    // mirror had before the field existed. `=== false` would empty the Sent half of Earlier on any
    // client or server older than this change.
    expect(sel.text).toMatch(/isOwnSent\(m\) && m\.autoReplyByUs !== true/);
    expect(sel.text).not.toMatch(/autoReplyByUs === false/);
  });

  it("the wire and the mirror both declare the field, and both as OPTIONAL", () => {
    const dto = FILES.find((f) => f.path === "packages/services/src/dto/types.ts")!;
    const engine = FILES.find((f) => f.path === "packages/client-engine/src/types.ts")!;
    // Optional on both sides: a required field would be a claim about stored mirror rows and about
    // older servers that neither type can make.
    expect(dto.text).toMatch(/^ {2}autoReplyByUs\?: boolean;$/m);
    expect(engine.text).toMatch(/^ {2}autoReplyByUs\?: boolean;$/m);
  });

  /**
   * THE SUBJECT ARM MUST NOT REACH THE OHBOX RULE.
   *
   * `isMachineSent` = headers ∪ an out-of-office SUBJECT match. The subject half is right for the
   * consent seed (a false positive costs one un-harvested contact) and wrong for the Ohbox (a
   * false positive hides a message the person wrote — two such messages existed on the reporting
   * account). So the Ohbox rule shares `hasMachineSentHeaders` and never `isMachineSent`.
   */
  it("the Ohbox rule shares the HEADER half only — isMachineSent never reaches it", () => {
    const home = FILES.find((f) => f.path === HOME)!;
    /**
     * ASSERTED ON CODE, NEVER ON PROSE. The first version of this test matched
     * `/out of|automatic reply|abwesenheit/i` against the whole file and failed on the DOCBLOCK,
     * which explains the very rule it was checking — a guard that fires on innocent content is
     * the same defect as one that cannot fire, and more expensive, because it discards real work.
     *
     * So: the header names the SQL actually asks for, extracted from the function body, must be
     * exactly the three. A subject arm would have to appear here to have any effect.
     */
    const belt = home.text.slice(home.text.indexOf("function machineSentHeadersWhere"));
    expect(belt.length, "the belt function was not found").toBeGreaterThan(0);
    const asked = [...belt.matchAll(/members\("([^"]+)"\)/g)].map((m) => m[1]).sort();
    expect(asked).toEqual(["auto-submitted", "precedence", "x-auto-response-suppress"]);
    // And the TS subject arm's symbol is not reachable from here at all.
    expect(home.text).not.toMatch(/\bOUT_OF_OFFICE\b/);
    expect(home.text).not.toMatch(/\bisMachineSent\s*\(/);

    const seed = FILES.find((f) => f.path === "packages/services/src/consent-seed.ts")!;
    // The seed keeps the whole question, and it keeps it by COMPOSING the header half — so the
    // two can never disagree about the headers.
    expect(seed.text).toMatch(/return hasMachineSentHeaders\(headers\) \|\| OUT_OF_OFFICE\.test\(subject\);/);
  });
});

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CUTLINE_ALLOW_DESTINATIONS, CUTLINE_DECIDED_DESTINATIONS, CUTLINE_GATE_FOLDER, CUTLINE_PERSON_WRITTEN_PROVENANCE,
  SCREENER_FOLDER, destinationIsDecision, resolveCutline,
} from "@trafficflow/db";
import { DESTINATIONS, LEGACY_NEWS_FOLDER, effectForDestination } from "@trafficflow/core";
import { PERSON_WRITTEN_PROVENANCE } from "@trafficflow/core/rule-order";

/**
 * ═══ ONE CUTLINE, ONE OWNER, THREE READERS ════════════════════════════════════════════════
 *
 * ── WHAT THIS EXISTS FOR ──────────────────────────────────────────────────────────────────
 *
 * `GET /consent` counted the WAITING senders through the cutline while `GET /screener` listed
 * every sender whose mail sits in the Screener folder. On a mailbox with years of history those
 * are different questions by an order of magnitude, and the queue answered the wrong one: it
 * offered first-contact senders whose newest mail was years old, beside a much smaller count.
 * The auto-suggest pass shared the list's blindness, so it could spend an account's credits on
 * advice about a sender no surface shows.
 *
 * The rule was spelled inside `cutlineCounts` and nowhere else. It now lives in
 * `@trafficflow/db#screener-cutline` — in `db` because the worker's pass is one of the three
 * readers and its deployment closure cannot reach `@trafficflow/services`.
 *
 * ── WHY A SOURCE CENSUS AND NOT ONLY THE BEHAVIOURAL CONTROLS ──────────────────────────────
 *
 * The controls beside this file prove the three readers agree TODAY. They cannot refuse a fourth
 * reader, or a lane that re-spells the active test locally because the shared one was awkward to
 * reach — which is exactly how the split happened in the first place.
 *
 * ── MUTATIONS WATCHED (each restored, `cmp`-proven) ────────────────────────────────────────
 *
 *  · drop the `senderIsActiveSql` call from `heldSenderPage`   ⇒ "the LIST reader" RED.
 *  · drop it from `selectCandidates`                            ⇒ "the SUGGEST reader" RED.
 *  · re-spell the unread choice inside a reader                 ⇒ "no second spelling" RED.
 *  · put a `bool_or(` back in any reader                        ⇒ "store-neutral" RED.
 *  · `max(m.date)` back in the COUNT reader                     ⇒ "one spelling of the instant" RED.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

/** The three server-side readers of the cutline, and the call each one must make. */
const READERS: ReadonlyArray<{ what: string; file: string; call: string }> = [
  {
    what: "the COUNT reader — GET /consent",
    file: "packages/services/src/consent-cutline.ts",
    call: "activeSenderExpr(",
  },
  {
    what: "the LIST reader — GET /screener",
    file: "packages/services/src/screener-service.ts",
    call: "senderIsActiveSql(",
  },
  {
    what: "the SUGGEST reader — the auto-suggest candidate set",
    file: "packages/organizer/src/screener-auto-suggest.ts",
    call: "senderIsActiveSql(",
  },
];

const OWNER = "packages/db/src/screener-cutline.ts";

/**
 * The file's CODE, with comments removed.
 *
 * Written because the first draft of the store-neutrality case scanned raw text and went red on
 * `screener-service.ts`, which discusses `::timestamptz` in a docblock and speaks it nowhere —
 * a checker that fires on prose is the same defect as one that cannot fire, and dearer, because
 * the only way to make it green is to stop explaining the thing. The dialect census draws this
 * distinction too. Crude on purpose: no string-literal awareness is needed, because a cast INSIDE
 * a SQL template literal is exactly what must be found.
 */
function code(body: string): string {
  return body.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}


describe("the cutline has one owner and every server reader calls it", () => {
  for (const r of READERS) {
    it(`${r.what} calls the shared owner`, () => {
      expect(read(r.file), `${r.file} must call ${r.call}`).toContain(r.call);
    });
  }

  it("every reader resolves the stored answers through `resolveCutline`", () => {
    /* Directly, or through the per-mailbox resolver (RULING-026), which is the one door from the
       organizers' windows to a cutline and itself resolves through `resolveCutline`. */
    expect(read("packages/services/src/screening-window.ts")).toContain("resolveCutline(");
    for (const r of READERS) expect(read(r.file), r.file).toMatch(/resolveCutline\(|cutlinesOf\(/);
  });

  it("NO SECOND SPELLING of the unread term in any reader", () => {
    // The rule's discriminating half: baselined ⇒ unread counts only inside the window. A reader
    // that picks between the two aggregates itself is a second implementation, whatever it calls
    // the variable.
    for (const r of READERS) {
      expect(/baselined\s*\?[\s\S]{0,80}any_?[uU]nread_?[iI]n_?[wW]indow/.test(read(r.file)),
        `${r.file} re-spells the unread term`).toBe(false);
    }
    // …and the owning module DOES carry it, so the assertion above is about location, not absence.
    expect(/baselined\s*\?[\s\S]{0,120}anyUnreadInWindow/.test(read(OWNER))).toBe(true);
  });

  it("the owning module and every reader are STORE-NEUTRAL — the phone runs this engine too", () => {
    // `cutlineCounts` was made neutral before this module existed; a Postgres-only spelling at
    // the call site would reintroduce exactly what that change removed, and every cutline test
    // other than `packages/db/test/sqlite-cutline.test.ts` is a Postgres twin that cannot see it.
    for (const f of [OWNER, ...READERS.map((r) => r.file)]) {
      const body = code(read(f));
      expect(/\bbool_or\s*\(/.test(body), `${f} speaks bool_or(`).toBe(false);
      expect(/::timestamptz/.test(body), `${f} speaks ::timestamptz`).toBe(false);
      expect(/::uuid/.test(body), `${f} speaks ::uuid`).toBe(false);
    }
  });

  it("ONE SPELLING OF THE INSTANT — the Date header, else the arrival", () => {
    // `Date:` is sender-written and nullable. A reader that dates a message by that column alone
    // retires a sender whose mail the mailbox recorded a minute ago — measured on a device, where
    // the count said active and the client said dormant one sender apart. `cutlineInstant` owns
    // the coalesce; the two bare spellings that existed are named so restoring either reddens.
    expect(code(read(OWNER))).toContain("cutlineInstant(");
    expect(code(read("packages/services/src/consent-cutline.ts"))).toContain("cutlineInstant(");
    for (const f of [OWNER, ...READERS.map((r) => r.file)]) {
      const body = code(read(f));
      for (const bare of ["max(m.date)", "max(mc.date)", "max(i.date)"]) {
        expect(body.includes(bare), `${f} dates a message by ${bare}`).toBe(false);
      }
    }
  });

  /**
   * THE DECIDED PREDICATE HAS THE SAME TWO PROPERTIES — one owner, and every reader calls it.
   *
   * `cutlineCounts` spelled the rule half of "has this account already answered for this sender"
   * inside its own statement and `GET /screener` asked nothing, which is how a correspondent of a
   * decade came to be listed as a first-time sender. ALL THREE readers, the suggest pass
   * included: it builds its OWN candidate set, so a sender the queue stops listing is one it
   * would go on buying advice about — the money leak arm (4) of that query already names.
   */
  it("the DECIDED predicate has one owner and every reader calls it", () => {
    expect(code(read(OWNER))).toContain("export function senderIsDecidedSql(");
    for (const r of READERS) {
      expect(code(read(r.file)), `${r.file} must call senderIsDecidedSql(`)
        .toContain("senderIsDecidedSql(");
    }
  });

  /**
   * THE OWN PREDICATE, the same two properties (ruling 2026-09-25): the account's own mail is
   * never a decision. The count spelled its own `own` CTE and the queue's page asked nothing, so
   * the phone's Cloud and paired doors listed the account in its own queue.
   */
  it("the OWN predicate has one owner and every reader calls it", () => {
    expect(code(read(OWNER))).toContain("export function senderIsOwnSql(");
    for (const r of READERS) {
      expect(code(read(r.file)), `${r.file} must call senderIsOwnSql(`).toContain("senderIsOwnSql(");
      // …and none keeps a list of its own: a `from mailboxes` in a reader is a second spelling.
      expect(/from\s+mailboxes/.test(code(read(r.file))), `${r.file} reads mailboxes itself`).toBe(false);
    }
  });

  it("NO SECOND SPELLING of the allow side in any reader", () => {
    // The destinations that say yes live in `CUTLINE_ALLOW_DESTINATIONS` and nowhere else here.
    // A reader that lists `ohmail/News` beside `ohmail/Receipts` in its own SQL is a second
    // table, and the two would drift the first time a seventh folder changed sides.
    for (const r of READERS) {
      expect(/'ohmail\/News'[\s\S]{0,40}'ohmail\/Receipts'/.test(code(read(r.file))),
        `${r.file} re-spells the allow side`).toBe(false);
    }
    expect(code(read(OWNER))).toContain("CUTLINE_ALLOW_DESTINATIONS");
  });

  it("the owning module takes the dialect on every exported SQL builder", () => {
    const body = read(OWNER);
    for (const fn of [
      "export function activeSenderExpr(", "export function senderIsActiveSql(",
      "export function senderIsDecidedSql(", "export function senderIsOwnSql(",
    ]) {
      const at = body.indexOf(fn);
      expect(at, fn).toBeGreaterThan(-1);
      expect(body.slice(at, at + 200), `${fn} must take the dialect`).toMatch(/d:\s*Dialect/);
    }
  });
});

describe("ONE DEFINITION OF DECIDED — the queue and the release screen ask one expression", () => {
  /**
   * Two definitions shipped in one product until 0.19.2. The Screener queue counted only the
   * ALLOW destinations, so a sender sent to Spam stayed in it as first-time; the held-release
   * screen counted "any destination that is not the gate", so the same sender was listed as
   * already decided. Three senders on one live account were in both lists at once and the two
   * screens printed different counts of one mailbox. The behavioural half is the six-destination
   * table in `packages/db/test/sqlite-cutline.test.ts`; this is the half that refuses a THIRD
   * spelling appearing beside them.
   */
  it("both readers call the shared predicate and neither re-spells it", () => {
    const owner = code(read(OWNER));
    expect(owner).toContain("export function destinationIsDecisionSql(");
    for (const file of [OWNER, "packages/services/src/held-release-service.ts"]) {
      expect(code(read(file)), `${file} must call destinationIsDecisionSql(`)
        .toContain("destinationIsDecisionSql(");
    }
    // The old spelling, by name: a `<> 'ohmail/Screener'` on a destination column is the second
    // definition coming back, and it is what the release screen read for two releases.
    expect(/destination[\s\S]{0,30}<>[\s\S]{0,30}SCREENER_FOLDER/
      .test(code(read("packages/services/src/held-release-service.ts"))),
    "held-release re-spells the decided side").toBe(false);
  });

  it("the decided table is the presented six minus the gate, and the gate is the Screener", () => {
    expect(CUTLINE_GATE_FOLDER).toBe(SCREENER_FOLDER);
    // Plus the News pile's pre-0.22 spelling: the cutline reads STORED rows, and a row filed
    // before the folder rename still says `ohmail/Reads` — one pile, two spellings, both decided.
    const derived = [...DESTINATIONS.filter((d) => d !== CUTLINE_GATE_FOLDER), LEGACY_NEWS_FOLDER];
    expect([...CUTLINE_DECIDED_DESTINATIONS].sort()).toEqual([...derived].sort());
    // …and it is WIDER than the allow side, or the ruling did not land: every allow destination
    // decides, and at least one deny destination decides too.
    for (const a of CUTLINE_ALLOW_DESTINATIONS) expect(destinationIsDecision(a)).toBe(true);
    expect(DESTINATIONS.filter((d) => effectForDestination(d) === "deny" && destinationIsDecision(d)).length)
      .toBeGreaterThan(0);
    // A folder nobody classified is nobody's answer, on both sides.
    expect(destinationIsDecision("ohmail/NobodyClassifiedThis")).toBe(false);
  });
});

describe("the allow table is `effectForDestination`, DERIVED", () => {
  /**
   * `db` may not depend on `@trafficflow/core`, so the destinations that say yes are re-declared
   * there — the same arrangement `CUTLINE_DEFAULT_DORMANCY_DAYS` has, and the same risk. This is
   * the pin: the list is DERIVED here from the function that owns the yes/no reading of a folder,
   * so a seventh folder, or a sixth one changing sides, reddens instead of quietly widening what
   * the Screener counts as a decision already made.
   */
  it("names exactly the destinations `effectForDestination` calls allow", () => {
    // The legacy News spelling is allow-side too: stored rows carry it, and `isOrganizedFolder`/
    // `admitsDestination` both admit it — the derivation names it or the list quietly narrows.
    const derived = [...DESTINATIONS.filter((d) => effectForDestination(d) === "allow"), LEGACY_NEWS_FOLDER];
    expect([...CUTLINE_ALLOW_DESTINATIONS].sort()).toEqual([...derived].sort());
    // …and the complement is not empty, or the assertion above is satisfied by a list of all six.
    expect(DESTINATIONS.filter((d) => effectForDestination(d) === "deny").length).toBeGreaterThan(0);
  });
});

describe("the person-written provenances are core's", () => {
  /**
   * The queue's person-consent half (`senderHasPersonConsentSql`) re-declares the provenances the
   * gate's `addressLevelConsent` yields to. A fourth one in core, or one leaving, reddens here rather
   * than letting the queue list a sender the gate admits, or skip one it holds.
   */
  it("names exactly core's set, and `promoted` is not in it", () => {
    expect([...CUTLINE_PERSON_WRITTEN_PROVENANCE].sort()).toEqual([...PERSON_WRITTEN_PROVENANCE].sort());
    expect(PERSON_WRITTEN_PROVENANCE.has("promoted")).toBe(false);
  });
});

describe("resolveCutline — the three facts, and which one the baseline decides", () => {
  const NOW = new Date("2026-09-11T00:00:00.000Z");
  const iso = (d: Date) => d.toISOString();

  it("a baseline fixes the cutoff and turns the window term on", () => {
    const c = resolveCutline({ baselineAt: new Date("2026-08-12T00:00:00.000Z"), dormancyDays: 365, now: NOW });
    expect(c.baselined).toBe(true);
    expect(c.allTime).toBe(false);
    expect(iso(c.cutoff)).toBe("2025-08-12T00:00:00.000Z");
  });

  it("no baseline measures back from now and leaves unread outranking age", () => {
    const c = resolveCutline({ baselineAt: null, dormancyDays: 60, now: NOW });
    expect(c.baselined).toBe(false);
    expect(iso(c.cutoff)).toBe("2026-07-13T00:00:00.000Z");
  });

  it("`all_time` is a MODE — every undecided sender is active whatever the dates say", () => {
    const c = resolveCutline({ baselineAt: new Date("2026-08-12T00:00:00.000Z"), scope: "all_time", now: NOW });
    expect(c.allTime).toBe(true);
  });

  it("an unparseable baseline reads as ABSENT, never as epoch 0", () => {
    // A 1970 cutoff would put every message after it and pin every sender in the queue for ever.
    const c = resolveCutline({ baselineAt: new Date("nope"), dormancyDays: 60, now: NOW });
    expect(c.baselined).toBe(false);
    expect(iso(c.cutoff)).toBe("2026-07-13T00:00:00.000Z");
  });

  it("a dormancy of 0, a negative, or NaN takes the product default", () => {
    for (const bad of [0, -5, Number.NaN, null, undefined]) {
      const c = resolveCutline({ baselineAt: null, dormancyDays: bad as number | null, now: NOW });
      expect(iso(c.cutoff), String(bad)).toBe("2026-07-13T00:00:00.000Z");
    }
  });
});

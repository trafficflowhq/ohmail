import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { readMailboxFactsVia } from "../src/DesktopMailboxes.js";

/**
 * ═══ THE SEAM BETWEEN THE LOCAL ENGINE AND THE SHARED SHELL MAY NOT DROP A FIELD ═══════════
 *
 * `readMailboxFactsVia` narrows `GET /mailboxes` into `MailboxFacts` with a HAND-WRITTEN field
 * list, and the wire it narrows keeps growing. That arrangement has now lost a field three
 * times, silently, and each loss disabled a surface rather than breaking a build:
 *
 *  · `smtpMaxSizeBytes` — the compose surface fell back to the hosted constant instead of the
 *    user's own server's announced ceiling. Recorded in the map's own comment.
 *  · `serverMessageCount` — driven against a live local engine, which answers this field on
 *    every mailbox row while the shell received nothing at all. `pullRemaining` therefore had
 *    no denominator, the first-run pull stage rendered no remaining counter, no progress bar
 *    and never an ETA, and NOTHING on the standalone door could tell "the walk reached the
 *    end" from "the walk is still going" — the terminal condition the import sentence needs.
 *  · `displayName`, `organizeConsentedAt`, `pendingMoves` — declared on `MailboxFacts`, served
 *    by the engine, absent from the narrowing, found in the same sweep.
 *
 * A type cannot catch this. Every field on `MailboxFacts` that could be lost is OPTIONAL —
 * necessarily so, because an engine older than a column must reach the ladder as `undefined`
 * rather than as a false `null` — and an object literal that omits an optional property is a
 * valid value of the type. So the compiler is structurally unable to notice, and this file is
 * the thing that does.
 *
 * ── HOW THE REQUIRED SET IS DERIVED, AND WHY NOT FROM A LIST HERE ───────────────────────────
 *
 * The keys are read out of `mail-state.ts`'s own `MailboxFacts` declaration at run time. A
 * second hand-written list in this file would be the very defect under test wearing a test's
 * name: it would drift from the interface exactly as the map did, and go green while doing it.
 * Interfaces are erased before run time, so the source is the only place the truth exists.
 */

/** Top-level property names of `MailboxFacts`, read from the declaration itself. */
function mailboxFactsKeys(): string[] {
  const src = readFileSync(
    new URL("../../webapp/app/shell/mail-state.ts", import.meta.url), "utf8",
  );
  const start = src.indexOf("export interface MailboxFacts {");
  expect(start, "MailboxFacts must still be declared in mail-state.ts").toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf("\n}", start));
  // Two-space indent only — top-level members. Nested object members (`organizedBy`'s three)
  // are indented deeper and must not be mistaken for fields of their own.
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map((m) => m[1]!);
}

/**
 * The one key the seam DERIVES instead of forwarding, with the reason it may.
 *
 * `legacyStandDown` has no wire field of its own: it is the answer to "did the engine omit
 * `organizerRole` altogether", which the map must compute at the last point that distinction
 * still exists (one line later `organizerRole` has been coerced to `organizer`). Asserted as an
 * EXACT set below, so exempting a second key is a visible edit to this file rather than a quiet
 * widening — the mechanism that failed three times was precisely a quiet widening.
 */
const DERIVED_NOT_FORWARDED = ["legacyStandDown"];

describe("the desktop mailbox-facts seam", () => {
  it("forwards every field MailboxFacts declares", async () => {
    const keys = mailboxFactsKeys();
    // The census is worthless if the parse found nothing; pin the shape it must have found.
    expect(keys).toContain("serverMessageCount");
    expect(keys.length).toBeGreaterThan(15);
    expect(keys).not.toContain("kind"); // `organizedBy`'s nested members are not fields

    /* ONE WIRE ROW CARRYING EVERY KEY, each with a value distinguishable from a default. The
       engine really does answer all of these — the SHAPE is the local door's; the figures are
       synthetic, so nothing here has to be read as a measurement. */
    const wire: Record<string, unknown> = {
      id: "mb-1",
      address: "someone@example.invalid",
      displayName: "Someone",
      status: "connected",
      errorCode: null,
      disabledReason: null,
      syncBlockedReason: null,
      syncBlockedSince: null,
      lastSyncAt: "2026-09-02T10:46:27.719Z",
      initialImportCompletedAt: "2026-09-02T10:40:36.058Z",
      organizerRole: "reader",
      organizedBy: { kind: "local", name: "a-machine", since: "2026-09-02T10:00:00.000Z" },
      organizerState: "held",
      organizeConsentedAt: "2026-09-02T09:00:00.000Z",
      pendingMoves: 4,
      serverMessageCount: 4242,
      smtpMaxSizeBytes: 26_214_400,
      hostedMessageCount: 4200,
      inboundQuietSince: "2026-08-20T00:00:00.000Z",
      inboundQuietDismissedAt: null,
      createdAt: "2026-09-02T10:39:31.446Z",
    };
    // Every declared key must be answerable by the engine, or the census is testing a fiction.
    const undeclared = keys.filter((k) => !(k in wire) && !DERIVED_NOT_FORWARDED.includes(k));
    expect(undeclared, "extend this row when MailboxFacts grows a field").toEqual([]);

    const [got] = await readMailboxFactsVia(async () =>
      new Response(JSON.stringify({ items: [wire] }), {
        status: 200, headers: { "content-type": "application/json" },
      }) as never);

    const dropped = keys.filter((k) =>
      !DERIVED_NOT_FORWARDED.includes(k) && !(k in (got as object)));
    expect(dropped, "readMailboxFactsVia dropped a field MailboxFacts declares").toEqual([]);
    // Forwarded UNTOUCHED, not merely present: a `?? 0` on the two counts would assert an empty
    // account, which is the failure `hostedMessageCount`'s comment names.
    expect(got!.serverMessageCount).toBe(4242);
    expect(got!.hostedMessageCount).toBe(4200);
    expect(got!.pendingMoves).toBe(4);
    expect(got!.displayName).toBe("Someone");
    expect(got!.organizeConsentedAt).toBe("2026-09-02T09:00:00.000Z");
  });

  it("exempts exactly one derived key, and it is the one with a reason", () => {
    expect(DERIVED_NOT_FORWARDED).toEqual(["legacyStandDown"]);
  });

  /**
   * ── AN ABSENT FIELD MUST ARRIVE ABSENT, NEVER AS A VALUE ────────────────────────────────
   *
   * The distinction the whole map is built on: `undefined` is "this engine predates the column"
   * and `null` is "the column is empty". Collapsing the first into the second is how the import
   * floor was once broken, and collapsing it into `0` would assert an empty account.
   */
  it("does not invent values for fields the engine did not send", async () => {
    const [got] = await readMailboxFactsVia(async () =>
      new Response(JSON.stringify({
        items: [{ id: "mb-2", address: "x@example.invalid", status: "connected", lastSyncAt: null }],
      }), { status: 200, headers: { "content-type": "application/json" } }) as never);

    expect("serverMessageCount" in (got as object)).toBe(false);
    expect("hostedMessageCount" in (got as object)).toBe(false);
    expect("initialImportCompletedAt" in (got as object)).toBe(false);
    expect("pendingMoves" in (got as object)).toBe(false);
    expect("displayName" in (got as object)).toBe(false);
  });

  /**
   * ── `createdAt` MUST NOT BE DEFAULTED TO NOW ─────────────────────────────────────────────
   *
   * `importFloorSpeaks` obeys the import floor ABSOLUTELY for `IMPORT_FLOOR_MAX_MS` (24 h)
   * measured from `createdAt`, and only past that window does it require the client to
   * corroborate before repeating a claim the server never made. A `?? new Date()` re-based that
   * window on every poll — `now - connectedAt` was always ~0 — so the bound could never elapse
   * and the strip announced "Syncing your mail" for ever over a finished mirror.
   *
   * The replacement must be a stamp that reads as UNKNOWN, which every consumer already handles
   * via a NaN guard. Asserted as "not a parseable time", not as a literal, so the empty string
   * is an implementation choice rather than a second contract.
   */
  it("never substitutes the current time for a createdAt the engine did not send", async () => {
    const before = Date.now();
    const [got] = await readMailboxFactsVia(async () =>
      new Response(JSON.stringify({
        items: [{ id: "mb-3", address: "y@example.invalid", status: "connected", lastSyncAt: null }],
      }), { status: 200, headers: { "content-type": "application/json" } }) as never);

    const t = new Date(got!.createdAt).getTime();
    expect(Number.isFinite(t)).toBe(false);
    // The defect stated as the thing it must not be: a stamp inside the run's own instant.
    expect(t >= before && t <= Date.now()).toBe(false);
  });

  it("forwards a createdAt the engine did send, untouched", async () => {
    const [got] = await readMailboxFactsVia(async () =>
      new Response(JSON.stringify({
        items: [{
          id: "mb-4", address: "z@example.invalid", status: "connected", lastSyncAt: null,
          createdAt: "2026-09-02T10:39:31.446Z",
        }],
      }), { status: 200, headers: { "content-type": "application/json" } }) as never);
    expect(got!.createdAt).toBe("2026-09-02T10:39:31.446Z");
  });
});

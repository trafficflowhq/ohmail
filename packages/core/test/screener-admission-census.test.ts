import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { screenerAdmits } from "../src/rules.js";

/**
 * ═══ EVERY WRITER OF A SCREENER HOLD, AND WHICH CLOCK IT HAS ══════════════════════════════
 *
 * ── THE MEASUREMENT THIS FILE COMES FROM (managed plane, 2026-09-10, read-only) ────────────
 *
 * A great many messages were held at the consent gate whose own header date was more than a year
 * older than our ingest of them — most on one account, the rest on another, some very old.
 * Every one was written by the ordinary gate at CONNECT, while
 * `account_settings.screening_baseline_at` was still NULL: NULL resolves to "no cutoff", and
 * with no cutoff the gate holds every unruled sender's mail whatever its age. Nothing
 * re-ingested them and no folder was renumbered — `folder_state.updated_at` for that batch has
 * not moved since the connect day.
 *
 * The test that decides an old message is backlog was spelled INLINE in `planChange` while the
 * gate was the only writer. It is `screenerAdmits` now, because it is not: `sensitive-rescreen`
 * moves already-filed mail INTO the gate and consults no cutoff at all.
 *
 * ── WHY THIS IS A CLASSIFICATION AND NOT "EVERY WRITER CALLS THE PREDICATE" ────────────────
 *
 * The predicate's clock is the SERVER's receive time (`Change.internalDate`) and nothing else —
 * the sender's `Date:` header is theirs to choose, and a security review has already closed that
 * door once. That clock reaches `planChange` on the wire and is NOT STORED: `messages` has no
 * `internal_date` column. So a writer working from stored rows has no truthful clock to pass,
 * and a call it could only make with `arrivedAt: null` is a call that cannot change an answer —
 * a condition whose contrary state is unreachable, which the next reader would read as a
 * guarantee.
 *
 * This census therefore pins the SET of hold writers and what each one is. A new writer fails
 * it until it is classified, which is the point: the release measured above happened because a
 * cutoff enforced at one door was taken for a cutoff.
 */

/** A writer of `desired_folder = 'ohmail/Screener'`, and its classification. */
const HOLD_WRITERS: ReadonlyArray<{
  file: string;
  /** `"gated"` — consults {@link screenerAdmits}. `"no-clock"` — see the header. */
  clock: "gated" | "no-clock";
  why: string;
}> = [
  {
    file: "packages/core/src/pipeline.ts",
    clock: "gated",
    why: "the gate itself; carries the server's INTERNALDATE on the change",
  },
  {
    file: "packages/services/src/sensitive-rescreen.ts",
    clock: "no-clock",
    why: "an operator one-shot over STORED rows; no server receive clock survives on a "
      + "`messages` row, so it holds unconditionally — fail-closed to the gate",
  },
  {
    file: "packages/core/src/unscreened-set.ts",
    clock: "gated",
    why: "the Screener's offer and the organize decision's sweep, over STORED rows; the offer is a "
      + "person's press by sender with no window; the agree reads only letters with a recorded "
      + "`messages.arrived_at` (the server's INTERNALDATE, mail 0119) and holds what `screenerAdmits` "
      + "admits on it, so a letter stored before that column stays outside every agree window",
  },
];

const ROOT = join(import.meta.dirname, "..", "..", "..");
const SCAN: readonly string[] = [
  "packages/core/src", "packages/services/src", "packages/db/src",
  "apps/worker/src", "packages/organizer/src", "apps/sidecar/src",
];

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(join(ROOT, dir))) {
    const rel = `${dir}/${name}`;
    if (statSync(join(ROOT, rel)).isDirectory()) sources(rel, out);
    else if (name.endsWith(".ts")) out.push(rel);
  }
  return out;
}

/** `desiredFolder: <something that is the Screener>` — a WRITE, not a read of the column. */
function writesAHold(text: string): boolean {
  return /desiredFolder:\s*(SCREENER|SCREENER_FOLDER|"ohmail\/Screener")/.test(text);
}

describe("screener admission — the writers of a hold are enumerated", () => {
  it("no source file writes a Screener hold without being classified here", () => {
    const declared = new Set(HOLD_WRITERS.map((w) => w.file));
    const found = SCAN.flatMap((d) => sources(d))
      .filter((f) => writesAHold(readFileSync(join(ROOT, f), "utf8")));
    expect(found.length).toBeGreaterThan(0);            // the scan itself must find something
    expect(found.filter((f) => !declared.has(f))).toEqual([]);
  });

  it("every writer classified `gated` names the predicate in its own source", () => {
    for (const w of HOLD_WRITERS.filter((x) => x.clock === "gated")) {
      expect(readFileSync(join(ROOT, w.file), "utf8"), w.file).toContain("screenerAdmits(");
    }
  });

  it("every classification carries a reason", () => {
    for (const w of HOLD_WRITERS) expect(w.why.length, w.file).toBeGreaterThan(20);
  });
});

describe("screenerAdmits — the four refusals to over-reach", () => {
  const CUTOFF = new Date("2026-01-01T00:00:00Z");
  const OLD = new Date("2023-06-23T00:00:00Z");
  const NEW = new Date("2026-06-23T00:00:00Z");
  const base = { source: "screener" as const, authFailed: false };

  it("holds a message that arrived after the cutoff", () => {
    expect(screenerAdmits({ ...base, arrivedAt: NEW, cutoff: CUTOFF })).toBe(true);
  });

  it("does NOT hold a message that arrived before the cutoff", () => {
    expect(screenerAdmits({ ...base, arrivedAt: OLD, cutoff: CUTOFF })).toBe(false);
  });

  it("holds everything when there is no cutoff — the pre-baseline account, measured", () => {
    expect(screenerAdmits({ ...base, arrivedAt: OLD, cutoff: undefined })).toBe(true);
  });

  it("never subordinates the USER's own rule", () => {
    expect(screenerAdmits({ ...base, source: "rule", arrivedAt: OLD, cutoff: CUTOFF })).toBe(true);
  });

  it("never lets an old date excuse a failed authentication", () => {
    expect(screenerAdmits({ ...base, authFailed: true, arrivedAt: OLD, cutoff: CUTOFF })).toBe(true);
  });

  it("an unknown arrival is not an ancient one — no server clock ⇒ the gate", () => {
    expect(screenerAdmits({ ...base, arrivedAt: null, cutoff: CUTOFF })).toBe(true);
  });

  it("the boundary instant itself is held, not released", () => {
    expect(screenerAdmits({ ...base, arrivedAt: CUTOFF, cutoff: CUTOFF })).toBe(true);
    expect(screenerAdmits({ ...base, arrivedAt: new Date(CUTOFF.getTime() - 1), cutoff: CUTOFF }))
      .toBe(false);
  });
});

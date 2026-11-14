import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { withoutComments, withoutCommentsAndLiterals } from "../../../scripts/lib/source-scan.mjs";
import { readSource } from "./_start-function.js";

/**
 * ═══ EVERY OPERATOR RUNNER THAT WRITES ASKS THE SAME QUESTION FIRST ════════════════════════
 *
 * "Stop organizing this mailbox" is a refusal for the one-off tools too (mail 0088): a pending
 * release leaves the row `organizer` on purpose, so every lease-shaped check passes and a runner
 * that only asks the lease would renew the very claim the person asked removed and move their
 * mail. Two runners carried their own copy of that read and its sentence; a third would have been
 * written by copying one of them, and a fix to one copy would have left the other writing.
 *
 * So the read has ONE home — `run-cli.ts`, the scaffold — and this census refuses a runner that
 * takes the lease without going through it, by the CALL, parsed from source with comments and
 * literals stripped, never by the symbol merely appearing. The door is not one of its own
 * subjects: it holds the read and the sentence, and it is where the lease is taken from. A
 * runner reaches the lease through `takeRunnerLease`, but reaching past it to
 * `acquireLeasePermit` is the same intent to write and is measured the same way.
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const SRC = join(HERE, "../src");

/** The scaffold itself — the home of the read, the sentence and the lease call. */
const DOOR = "run-cli.ts";

const RUNNERS = readdirSync(SRC)
  .filter((f) => f.startsWith("run-") && f.endsWith(".ts") && f !== DOOR)
  .map((f) => ({ name: f, raw: readFileSync(join(SRC, f), "utf8") }))
  .map((r) => ({ ...r, code: withoutCommentsAndLiterals(r.raw), noComments: withoutComments(r.raw) }));

/** A runner that takes the organizer's lease is a runner that intends to WRITE. */
const WRITERS = RUNNERS.filter((r) => /\b(takeRunnerLease|acquireLeasePermit)\s*\(/.test(r.code));

describe("the operator runners share one release refusal", () => {
  it("there is at least one writing runner to measure — the census is not vacuous", () => {
    expect(WRITERS.map((w) => w.name)).not.toHaveLength(0);
  });

  it("the door it measures against is really the door", () => {
    // Without this the exclusion above could hide an empty file and every arm would pass.
    const door = withoutCommentsAndLiterals(readFileSync(join(SRC, DOOR), "utf8"));
    expect(/export async function readRunnerMailbox\s*\(/.test(door), `${DOOR} holds the read`).toBe(true);
    expect(/\bacquireLeasePermit\s*\(/.test(door), `${DOOR} is where the lease is taken`).toBe(true);
    expect(withoutComments(readFileSync(join(SRC, DOOR), "utf8")))
      .toContain("has been asked to stop being organized here");
  });

  for (const w of WRITERS) {
    it(`${w.name} reads its mailbox through the one door`, () => {
      expect(/\breadRunnerMailbox\s*\(/.test(w.code), `${w.name} does not call readRunnerMailbox`).toBe(true);
    });

    it(`${w.name} handles the answer that is no mailbox at all`, () => {
      // The read answers `null` for an id that is not a mailbox — no `refusal` to print and no
      // `mailbox` to use. A runner that tested only for a refusal would walk on into `.mailbox`
      // on nothing, so the arm is handled explicitly and the runner says so in its own voice.
      expect(/\bfound\s*===\s*null\b/.test(w.code), `${w.name} does not handle the null answer`).toBe(true);
      expect(w.noComments, `${w.name} says nothing when the mailbox is not one`).toContain("no mailbox");
    });

    it(`${w.name} does not spell the release refusal itself`, () => {
      // The SENTENCE, read from source with comments stripped but literals kept: the copy this
      // census exists to refuse is a second sentence, and a sentence lives in a string literal.
      expect(w.noComments).not.toContain("has been asked to stop being organized here");
    });
  }

  it("the refusal sentence is written in exactly one file under apps/worker/src", () => {
    const holders = readdirSync(SRC)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => withoutComments(readSource(join(SRC, f)))
        .includes("has been asked to stop being organized here"));
    expect(holders, `written in: ${holders.join(", ") || "(nowhere)"}`).toHaveLength(1);
  });
});

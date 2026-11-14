/** @vitest-environment jsdom */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { composePlan } from "@ohmail/app-logic/writing/compose";
import { canSend } from "@ohmail/app-logic/writing/mail-send";

/**
 * AN ENTRY BEING TYPED IS UNFINISHED, NOT WRONG.
 *
 * Reported from the live build: typing "no" into To put a red "Not an address" bar under the
 * field WHILE the suggestion popover for that same prefix was open above it. `composePlan`
 * re-parses the whole field on every keystroke, so the first letter of every name was an
 * error until the last one arrived.
 *
 * ── THE PART THAT MATTERS IS WHAT WAS *NOT* CHANGED ────────────────────────────────────
 *
 * The gate is on the SENTENCE only. `canSend` reads `plan.mutation.to`, which `composePlan`
 * empties whenever any entry is unparseable — so a genuinely bad address still cannot be
 * sent, whether or not the line is on screen. These assertions exist to keep those two facts
 * separate, because the tempting version of this fix is to relax the parse.
 */

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

const fields = (to: string) => ({ to, cc: "", bcc: "", subject: "s", body: "b", html: "", fromMailboxId: "mb-1" });

describe("the send guard is untouched by the display gate", () => {
  it("a half-typed entry still yields NO recipients on the wire", () => {
    const plan = composePlan(fields("no"), "mb-1");
    expect(plan.invalid).toEqual(["no"]);
    // The mutation carries nothing, so the send is refused at the only place that matters.
    expect(plan.mutation.to).toEqual([]);
    expect(canSend({ phase: "idle" }, plan.mutation)).toBe(false);
  });

  it("a bad address mixed with a good one still refuses — not 'send the valid ones'", () => {
    const plan = composePlan(fields("lena@x.invalid, nope"), "mb-1");
    expect(plan.invalid).toEqual(["nope"]);
    expect(plan.mutation.to).toEqual([]);
    expect(canSend({ phase: "idle" }, plan.mutation)).toBe(false);
  });

  it("a finished, valid field sends", () => {
    const plan = composePlan(fields("lena@x.invalid"), "mb-1");
    expect(plan.invalid).toEqual([]);
    expect(canSend({ phase: "idle" }, plan.mutation)).toBe(true);
  });
});

/*
 * OVER WRITE (the older tests' sorting): today's `ComposeView` leaves with the switch, and the display
 * gate with it. Write's people lines draw what does not parse through ONE gate, `gatedInvalid` of
 * `packages/app-logic/src/writing/recipient-lines.ts` (Write's model hands it as `lines.refused`), which People
 * (`packages/app/src/write/head/People.tsx`) asks once per line for both the refused people and the line's sentence.
 * The census reads those files by path; each claim is today's.
 */
describe("the display gate withholds exactly one entry, and only while focused", () => {
  const gate = read("../../../packages/app-logic/src/writing/recipient-lines.ts");
  const people = read("../../../packages/app/src/write/head/People.tsx");
  const model = read("../../../packages/app-logic/src/writing/writing-of.ts");

  it("suppresses only the LAST entry, and only while the field has focus", () => {
    // Not "hide errors while typing" — that would hide a committed entry's error too. The
    // predicate names the last segment and requires focus.
    expect(gate).toContain("focused && !/[,;]\\s*$/.test(raw)");
    expect(gate).toContain("raw.split(/[,;]/).pop()");
    expect(gate).toMatch(/invalid\.filter\(\(entry\) => entry !== stillTyping\)/);
  });

  it("a trailing comma means the entry IS committed, so its error shows", () => {
    // `"nope, "` ends in a comma: the user has finished with `nope` and moved on, so the
    // regex refuses to treat it as still-being-typed.
    expect(/,\s*$/.test("nope, ")).toBe(true);
    expect(/,\s*$/.test("nope")).toBe(false);
  });

  it("the error line and the field's aria-invalid read the SAME list", () => {
    // Two sources here would let the red bar disappear while the field still announced itself
    // as invalid to a screen reader. (Write: each refused person is marked from the line's gated list, and the
    // sentence under the lines is the same lists joined.)
    expect(people).toMatch(/const refusedOf = \(row: RecipientRow\): string\[\] => beside\.lines\.refused\(/);
    expect(people).toMatch(/const refused = ROWS\.flatMap\(refusedOf\);/);
    expect(people).toMatch(/const bad = new Set\(refusedOf\(row\)\);/);
    expect(people).toMatch(/refusal=\{refused\.length > 0 \? t\("refused", \{ list: refused\.join/);
  });

  it("canSend is NOT computed from the gated list", () => {
    // The mutation is what the send is judged on, and it is built by `composePlan` from the
    // ungated parse. If the gated list ever reaches the send path, this is what says so. (Write: the gate is read
    // only as the lines' `refused` member of the model; People draws, and sends nothing.)
    const uses = model.split("gatedInvalid").length - 1;
    expect(uses, "the model names the gate beyond its import and its lines' member").toBe(2);
    expect(model).toMatch(/refused: gatedInvalid,/);
    expect(people).not.toMatch(/canSend|sendRefusal|mutation/);
  });
});

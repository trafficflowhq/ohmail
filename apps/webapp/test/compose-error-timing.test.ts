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

describe("the display gate withholds exactly one entry, and only while focused", () => {
  const view = read("../app/views/ComposeView.tsx");

  it("suppresses only the LAST entry, and only while the field has focus", () => {
    // Not "hide errors while typing" — that would hide a committed entry's error too. The
    // predicate names the last segment and requires focus.
    expect(view).toContain("toFocused && !/,\\s*$/.test(fields.to)");
    expect(view).toContain('fields.to.split(",").pop()');
    expect(view).toMatch(/plan\.invalid\.filter\(\(entry\) => entry !== stillTyping\)/);
  });

  it("a trailing comma means the entry IS committed, so its error shows", () => {
    // `"nope, "` ends in a comma: the user has finished with `nope` and moved on, so the
    // regex refuses to treat it as still-being-typed.
    expect(/,\s*$/.test("nope, ")).toBe(true);
    expect(/,\s*$/.test("nope")).toBe(false);
  });

  it("the error line and the field's aria-invalid read the SAME list", () => {
    // Two sources here would let the red bar disappear while the field still announced itself
    // as invalid to a screen reader.
    expect(view).toMatch(/invalid=\{shownInvalid\.length > 0\}/);
    expect(view).toMatch(/\{shownInvalid\.length > 0 \? \(/);
    expect(view).toMatch(/entries: shownInvalid\.join/);
  });

  it("canSend is NOT computed from the gated list", () => {
    // The mutation is what the send is judged on, and it is built by `composePlan` from the
    // ungated parse. If `shownInvalid` ever reaches the send path, this is what says so.
    const send = view.slice(view.indexOf("const canSendNow"), view.indexOf("return ("));
    expect(send).not.toMatch(/shownInvalid/);
  });
});

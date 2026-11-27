import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withoutComments } from "../../../scripts/lib/source-scan.mjs";
import { heldWhileHidden } from "../src/state/held-while-hidden";

/**
 * THE OHBOX UNDER A PUSHED READER DERIVES NOTHING. The screen stays mounted while the reader
 * covers it, and every change the reader makes (the read, the hold's release) re-rendered it into
 * a whole-mailbox Ohbox and Screener derivation nobody saw. While hidden it keeps what it showed.
 * The rule is driven here; the screen is read for taking both lists through it, keyed on focus.
 */

const SCREEN = withoutComments(readFileSync(fileURLToPath(new URL("../app/(tabs)/index.tsx", import.meta.url)), "utf8"));

describe("a hidden list keeps what it showed", () => {
  it("shown, it reads; hidden with a last answer, it reads nothing; never drawn, it reads once", () => {
    let reads = 0;
    const read = () => { reads += 1; return { n: reads }; };
    const first = heldWhileHidden(false, null, read);
    expect(reads, "a screen never drawn must read").toBe(1);
    expect(heldWhileHidden(false, first, read)).toBe(first);
    expect(reads, "hidden, it re-derived").toBe(1);
    expect(heldWhileHidden(true, first, read)).not.toBe(first);
    expect(reads).toBe(2);
  });

  it("the Ohbox screen takes its lists through it, keyed on its focus", () => {
    expect(SCREEN).toContain("const focused = useIsFocused();");
    const read = `() => ({
    worldKey: w.worldKey, ohbox: w.ohbox, doorbell: w.doorbell,
  })`;
    expect(SCREEN).toContain(`heldWhileHidden(focused, kept.current?.worldKey === w.worldKey ? kept.current : null, ${read})`);
    // Every other read of the two lists goes through what the rule answered.
    const rest = SCREEN.replace(read, "");
    expect(rest.match(/\bw\.(ohbox|doorbell)\b/g) ?? [], "a list read around the rule").toEqual([]);
  });
});

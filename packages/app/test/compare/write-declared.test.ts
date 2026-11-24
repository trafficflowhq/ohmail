/**
 * WRITE'S REGISTERED STATES, read with no picture: every state the reference registers for the screen `compose` is
 * drawn by write's states page (its subject, `test/compare/subjects/compose.ts`) or stands in `write-declared.json`
 * whole, by a named class with its reason; a state the page draws is compared, never declared whole; each row is of
 * a named class, names only the screen's own keys and names what it leaves out. The pictures themselves are held by
 * `write-parts.compare.ts`, run with the comparison.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Registry } from "../../../../test/compare/registry.d.mts";
import { subjects } from "../../../../test/compare/subjects/compose.js";
import { WRITE_CLASSES, WRITE_PARTS, type WriteDeclaredRow } from "./write-classes.js";

const ROOT = resolve(__dirname, "../../../..");
const json = <T>(path: string): T => JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
const registry = json<Registry>("test/compare/registry.json");
const declared = json<WriteDeclaredRow[]>("packages/app/test/compare/write-declared.json");
const registered = registry.states.filter((s) => s.screen === "compose").map((s) => s.key);
const drawn = subjects.map((s) => s.key);
const whole = new Set(declared.filter((d) => d.notDrawn === "state").flatMap((d) => d.keys));

describe("write's registered states", () => {
  it("draws each state once, and only states of the screen compose", () => {
    expect(drawn.length).toBe(new Set(drawn).size);
    expect(drawn.filter((k) => !registered.includes(k))).toEqual([]);
  });

  it("draws every registered state of compose, or declares it whole with its reason", () => {
    expect(registered.length).toBe(144);
    expect(registered.filter((k) => !drawn.includes(k) && !whole.has(k))).toEqual([]);
  });

  it("never declares whole a state the page draws", () => {
    expect(drawn.filter((k) => whole.has(k))).toEqual([]);
  });

  it("declares by a named class, by node, by a pair of names or by a part not drawn, and only its own keys", () => {
    for (const d of declared) {
      expect(Object.keys(WRITE_CLASSES), d.reason).toContain(d.class);
      expect(d.keys.length, d.reason).toBeGreaterThan(0);
      expect(
        d.keys.filter((k) => !registered.includes(k)),
        d.reason,
      ).toEqual([]);
      expect(
        [d.out, d.unnamed, d.pairs].some((list) => Boolean(list?.length)) ||
          d.notDrawn === "state" ||
          (Array.isArray(d.notDrawn) && d.notDrawn.length > 0),
        `${d.reason}: names no node, no pair and no part`,
      ).toBe(true);
      if (Array.isArray(d.notDrawn))
        expect(
          d.notDrawn.filter((p) => !(WRITE_PARTS as readonly string[]).includes(p)),
          d.reason,
        ).toEqual([]);
      expect(
        [d.reason, d.removedBy].every((s) => typeof s === "string" && s.length > 20),
        d.reason,
      ).toBe(true);
      expect(d.since, d.reason).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});

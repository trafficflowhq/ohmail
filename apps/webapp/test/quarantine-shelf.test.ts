import { describe, expect, it } from "vitest";
import type { ScreenerSenderDTO } from "@ohmail/client-engine";
import type { SpamRow } from "../app/shell/screener-state";
import { quarantineShelf, shelfRowMatches } from "../app/shell/quarantine-shelf";

/** The shelf's two rules: a row keeps only its held letters, and the filter reads what is drawn. */

const row = (address: string, held: Array<[string, string]>, over: { pinned?: boolean; name?: string | null } = {}): SpamRow => ({
  pinned: over.pinned ?? false,
  sender: {
    id: held.at(-1)?.[0] ?? address, from: { name: over.name ?? null, address },
    held: held.map(([id, subject]) => ({ id, subject, time: "", body: "" })),
  } as unknown as ScreenerSenderDTO,
});

describe("quarantineShelf", () => {
  it("keeps only the held letters, drops rows left empty, and keeps order and the pin", () => {
    const a = row("a@x.invalid", [["a1", "first"], ["a2", "second"]]);
    const b = row("b@x.invalid", [["b1", "filed to Junk"]]);
    const c = row("c@x.invalid", [["c1", "pinned one"]], { pinned: true });
    const shelf = quarantineShelf([a, b, c], new Set(["a2", "c1"]));
    expect(shelf.map((r) => r.sender.from.address)).toEqual(["a@x.invalid", "c@x.invalid"]);
    expect(shelf[0]!.sender.held.map((m) => m.id)).toEqual(["a2"]);
    expect(shelf[1]!.pinned).toBe(true);
    // The source rows are not touched.
    expect(a.sender.held).toHaveLength(2);
  });

  it("an empty held set is an empty shelf; a row wholly held is the same row", () => {
    const a = row("a@x.invalid", [["a1", "first"]]);
    expect(quarantineShelf([a], new Set())).toEqual([]);
    expect(quarantineShelf([a], new Set(["a1"]))[0]).toBe(a);
  });
});

describe("shelfRowMatches", () => {
  const a = row("Promo@Shop.invalid", [["a1", "Huge SALE today"]], { name: "Mega Shop" });
  it("case-folds a substring over the name, the address and the held subjects", () => {
    expect(shelfRowMatches(a, "")).toBe(true);
    expect(shelfRowMatches(a, "  ")).toBe(true);
    expect(shelfRowMatches(a, "mega")).toBe(true);
    expect(shelfRowMatches(a, "promo@shop")).toBe(true);
    expect(shelfRowMatches(a, "sale")).toBe(true);
    expect(shelfRowMatches(a, "invoice")).toBe(false);
  });
});

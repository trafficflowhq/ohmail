/**
 * `#/address/<addr>` — THE ONE ADDRESS WHOSE WORD A STRANGER CHOSE, over the frame's one reader and writer of the
 * fragment (`../../src/frame/route.ts`): today's cases (`apps/webapp/test/address-route.test.ts`, over today's shell's
 * router), by their names, the same claims. A tag's id and a folder's are strings this product minted; an address is
 * what somebody put in a `From:` header, and `/`, `#` and `%` in it would break a raw segment. What makes them safe is
 * the round trip: what the frame writes, it reads back as the same address, and writes again the same.
 */
import { describe, expect, it } from "vitest";
import type { Route } from "../../src/frame/contract.js";
import { fragmentOf, routeOf } from "../../src/frame/route.js";

const at = (address: string, open: string | null = null): Route => ({
  place: "address",
  sub: address,
  open,
  stage: null,
  words: {},
});

/** What the frame writes for an address, read back: the same place, the same address, written again the same. */
function roundTrip(address: string): string | null {
  const href = fragmentOf(at(address));
  const route = routeOf(href);
  expect(route.place).toBe("address");
  expect(fragmentOf(route)).toBe(href);
  return route.sub;
}

describe("#/address/<addr> — parse, canonicalize, round-trip", () => {
  it("parses an ordinary address and carries it decoded", () => {
    const route = routeOf("#/address/anna%40acme.test");
    expect(route.place).toBe("address");
    expect(route.sub).toBe("anna@acme.test");
    expect(route.open).toBeNull();
  });

  it("round-trips every address shape a header can legally carry", () => {
    for (const address of [
      "anna@acme.test",
      "Anna@ACME.test",
      "anna+newsletter@acme.test",
      "anna.b.c@sub.domain.acme.test",
      "a/b@acme.test",
      "a#b@acme.test",
      "a%b@acme.test",
      "a b@acme.test",
      "a?b@acme.test",
      "a&b=c@acme.test",
      "üñí@äcme.test",
      "a'b@acme.test",
    ]) {
      expect(roundTrip(address)).toBe(address);
    }
  });

  it("carries an open message — `#/address/<addr>/m/<id>`", () => {
    const route = routeOf("#/address/anna%40acme.test/m/msg-1");
    expect(route.place).toBe("address");
    expect(route.sub).toBe("anna@acme.test");
    expect(route.open).toBe("msg-1");
    expect(fragmentOf(route)).toBe("#/address/anna%40acme.test/m/msg-1");
  });

  it("an address CONTAINING `/m/` keeps its tail-split honest", () => {
    const address = "a/m/b@acme.test";
    expect(roundTrip(address)).toBe(address);
    expect(routeOf(fragmentOf(at(address))).open).toBeNull();
    /* Spelled raw, the tail is read as the open letter and the address cut: the defect the encoding prevents. */
    const raw = routeOf("#/address/a/m/b@acme.test");
    expect(raw.sub).toBe("a");
    expect(raw.open).toBe("b@acme.test");
  });

  it("a MALFORMED escape opens the view instead of throwing", () => {
    for (const bad of ["#/address/%", "#/address/%zz", "#/address/a%2"]) {
      const route = routeOf(bad);
      expect(route.place).toBe("address");
      expect(typeof route.sub).toBe("string");
      expect(route.sub).not.toBe("");
    }
  });

  it("a bare `#/address` with no address falls back rather than opening an empty view", () => {
    for (const bare of ["#/address", "#/address/"]) {
      const route = routeOf(bare);
      expect(route.place).toBe("ohbox");
      expect(route.sub).toBeNull();
      expect(fragmentOf(route)).toBe("#/ohbox");
    }
  });

  it("does not disturb the sibling parameterized routes", () => {
    const tag = routeOf("#/tag/pottery/m/x");
    expect([tag.place, tag.sub, tag.open]).toEqual(["tags", "pottery", "x"]);
    const folder = routeOf("#/folder/f-1/m/x");
    expect([folder.place, folder.sub, folder.open]).toEqual(["folder", "f-1", "x"]);
    const settings = routeOf("#/settings/devices");
    expect([settings.place, settings.sub]).toEqual(["settings", "devices"]);
  });
});

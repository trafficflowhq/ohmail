import { describe, expect, it } from "vitest";

import { originNeedsPin, pairLink, parsePairLink } from "../src/pair-link.js";

/**
 * ═══ WHAT A HOST LINK CARRIES, AND WHAT DECIDES IT ═══════════════════════════════════════════
 *
 * A link names an ORIGIN and, where that origin's identity IS the pin, the pin. Never an address.
 * WHICH origins need one is `originNeedsPin`, asked by the desktop door, the phone and the engine.
 * The TRANSPORT is why: a same-network address is served with a key no CA vouches for, so the
 * ceremony carries the fingerprint; a tailnet origin is served by Tailscale with a real certificate
 * that ROTATES, so a pin there breaks the pairing at renewal, or — as the desktop's own key —
 * never matches and accuses the host. Three controls, one predicate.
 */
describe("a host link carries an origin, a pin where the origin needs one, and no address", () => {
  /* 43 base64url characters — the shape `isPairPin` admits, and a hash of nothing. */
  const PIN = "A2Z_abcdefghijklmnopqrstuvwxyz0123456789-xy";
  const LAN = "https://192.168.1.24";
  const TAILNET = "https://desk.tail1234.ts.net";

  it("refuses a pin-less link whose origin needs a pin, and admits it with one", () => {
    // The refusal is the door's to NAME — `hostLinkProblem` answers `no_pin` and the engine's
    // probe answers `details.kind: "no_pin"` — and both of them ask this predicate rather than
    // re-deciding. What is asserted here is the predicate and the round trip it governs.
    expect(originNeedsPin(LAN)).toBe(true);

    const unpinned = parsePairLink(`${LAN}/pair#tok-xyz`);
    expect(unpinned).not.toBeNull();
    expect(unpinned!.pin).toBeNull();
    /* Parsed, and refused BY THE PREDICATE — the grammar's job is the shape, the predicate's is
       whether this shape is safe here. A parser that refused it would have no name to refuse by. */
    expect(originNeedsPin(unpinned!.origin)).toBe(true);

    const pinned = parsePairLink(pairLink(LAN, "tok-xyz", PIN));
    expect(pinned).toEqual({ origin: LAN, token: "tok-xyz", pin: PIN });
  });

  it("admits a pin-less tailnet link — that is the normal host link, not a degraded one", () => {
    // THE CONTROL THAT KEEPS THE TRANSPORT HONEST. Tailscale terminates TLS for this origin with
    // a certificate a platform trust store verifies, so there is nothing for a pin to add and a
    // great deal for it to break. A rule that demanded one here would refuse every tailnet
    // pairing the Devices pane has ever printed.
    expect(originNeedsPin(TAILNET)).toBe(false);
    expect(parsePairLink(`${TAILNET}/pair#tok-xyz`)).toEqual({
      origin: TAILNET,
      token: "tok-xyz",
      pin: null,
    });
  });

  it("refuses an address in a link, wherever it is put", () => {
    // Userinfo inside the host is the one place an address fits in this grammar, and it PARSED:
    // the origin came back as `https://someone@desk…`, which the engine's `normalizeOrigin`
    // refuses as carrying credentials — so the door would accept a link the dial could not use.
    for (const bad of [
      `https://someone@desk.tail1234.ts.net/pair#tok-xyz`,
      `https://someone%40ohmail.app@192.168.1.24/pair#k1.${PIN}.tok-xyz`,
      `https://someone:secret@192.168.1.24/pair#k1.${PIN}.tok-xyz`,
    ]) {
      expect(parsePairLink(bad), bad).toBeNull();
    }
    /* And the ordinary forms of both origins still parse — a refusal keyed on `@` that also took
       the links this pane prints would be a worse failure than the one it fixes. */
    expect(parsePairLink(`${TAILNET}/pair#tok-xyz`)).not.toBeNull();
    expect(parsePairLink(`${LAN}:6245/pair#k1.${PIN}.tok-xyz`)).not.toBeNull();
  });

  it("names its host as it is dialled: ASCII letters, digits, dots and hyphens, or a bracketed IPv6 literal", () => {
    // What a request to an origin reaches: a URL's own reading of it, which spells a name as the network does.
    const dialled = (origin: string) => new URL(origin).origin;
    for (const bad of [
      `https://dеsk.tail1234.ts.net/pair#tok-xyz`, // a Cyrillic "е": drawn as desk, dialled as xn--dsk-…
      `https://deſk.tail1234.ts.net/pair#tok-xyz`, // a long s: dialled as desk
      `https://desk．tail1234.ts.net/pair#tok-xyz`, // a full-width stop: dialled as a dot
      `https://desk%2Etail1234.ts.net/pair#tok-xyz`, // an escaped dot: dialled as a dot
    ]) {
      expect(parsePairLink(bad), bad).toBeNull();
    }
    for (const good of [
      `${TAILNET}/pair#tok-xyz`,
      `${LAN}:6245/pair#k1.${PIN}.tok-xyz`,
      `https://[fd7a:115c:a1e0::5]:6245/pair#k1.${PIN}.tok-xyz`,
      "HTTPS://Desk.Tail1234.TS.net/pair#tok-xyz",
    ]) {
      const origin = parsePairLink(good)?.origin;
      expect(origin, good).toBeDefined();
      expect(dialled(origin!), good).toBe(origin);
    }
  });
});

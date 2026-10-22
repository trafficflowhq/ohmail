// @services: none — the box's port is a value under test, never dialed
import { describe, expect, it } from "vitest";
import { seedConsentFor } from "../src/credential-host.js";
import { seedDial } from "../src/engine.js";

/**
 * THE SEED'S PLAINTEXT CONSENT IS ITS ROW'S, FOR EXACTLY ITS SETTINGS' ENDPOINT. The desktop seed
 * dialled its settings file, which carries no consent, so a consented seal was stored and never
 * dialled (the first-run door and Sign in again alike). Each term below is watched alone: the
 * host (this file's one normalisation, no other), the port, and `secure: false` on both sides.
 */

const DIAL = { host: "mail.home.arpa", port: 143, secure: false };
const ROW = { host: "mail.home.arpa", port: 143, secure: false, user: "box2@home.arpa", insecureConsent: true };

describe("the seed's consent", () => {
  it("is the row's for the endpoint the settings name", () => {
    expect(seedConsentFor(ROW, DIAL)).toBe(true);
    // The one normalisation the host comparison makes: surrounding space and case.
    expect(seedConsentFor({ ...ROW, host: " MAIL.Home.ARPA " }, DIAL)).toBe(true);
  });

  it("is refused on each disagreement, one term at a time", () => {
    expect(seedConsentFor({ ...ROW, host: "mail.other.arpa" }, DIAL), "another host").toBe(false);
    expect(seedConsentFor({ ...ROW, port: 3143 }, DIAL), "another port").toBe(false);
    expect(seedConsentFor({ ...ROW, secure: true }, DIAL), "a row that proved TLS").toBe(false);
    expect(seedConsentFor(ROW, { ...DIAL, secure: true }), "settings that ask for TLS").toBe(false);
  });

  it("is refused without the row's own flag, and without a row", () => {
    expect(seedConsentFor({ ...ROW, insecureConsent: false }, DIAL)).toBe(false);
    const { insecureConsent: _gone, ...unflagged } = ROW;
    expect(seedConsentFor(unflagged, DIAL)).toBe(false);
    expect(seedConsentFor({ ...ROW, insecureConsent: "true" }, DIAL), "the exact boolean").toBe(false);
    expect(seedConsentFor(null, DIAL)).toBe(false);
    expect(seedConsentFor({ ...ROW, host: undefined }, DIAL), "a row that names no host").toBe(false);
  });

  it("composes onto the seed's dial, and keeps a consent the settings already carry", () => {
    const configured = { ...DIAL, auth: { user: "box2@home.arpa" } };
    expect(seedDial(configured, ROW)).toEqual({ ...configured, allowInsecure: true });
    expect(seedDial(configured, { ...ROW, insecureConsent: false })).toBe(configured);
    const seam = { ...configured, allowInsecure: true as const };
    expect(seedDial(seam, null)).toBe(seam);
  });
});

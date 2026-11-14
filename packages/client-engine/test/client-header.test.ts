import { describe, expect, it } from "vitest";
import { CLIENT_HEADER, CLIENT_KINDS, clientHeaders, clientHeaderValue } from "@ohmail/client-engine";

/**
 * THE HEADER A CLIENT NAMES ITSELF IN carries a kind from a closed set and a release, and nothing
 * else: no install, no account, no free text. The server counts what it can read and calls the rest
 * unknown, so a client sends only what it can state in this grammar, `dev` where it has no release.
 */
describe("x-ohmail-client", () => {
  it("is one header, named once", () => {
    expect(CLIENT_HEADER).toBe("x-ohmail-client");
    expect(clientHeaders("web", "1.0.12")).toEqual({ "x-ohmail-client": "web/1.0.12" });
  });

  it("the kinds are exactly the five clients", () => {
    expect([...CLIENT_KINDS]).toEqual(["web", "desktop-window", "desktop-engine", "phone", "paired-page"]);
  });

  it("every kind and every release shape states itself in the grammar, under 40 bytes", () => {
    for (const kind of CLIENT_KINDS) {
      for (const release of ["1.0.12", "0.9.0", "12.345.6789", " 1.0.12 "]) {
        const value = clientHeaderValue(kind, release);
        expect(value, `${kind} ${release}`).toMatch(/^[a-z][a-z-]{0,23}\/(?:\d{1,4}\.\d{1,4}\.\d{1,4}|dev)$/);
        expect(value.length).toBeLessThanOrEqual(40);
        expect(value).toBe(`${kind}/${release.trim()}`);
      }
    }
  });

  it("a release that is not three numbers reads `dev`, and its text never travels", () => {
    for (const release of [undefined, null, "", "dev", "1.0", "1.0.12-beta", "1.0.12+abc", "v1.0.12", "1.0.12\nx-evil: 1", "99999.0.0", "a".repeat(500)]) {
      expect(clientHeaderValue("phone", release as string | null | undefined), String(release)).toBe("phone/dev");
    }
  });
});

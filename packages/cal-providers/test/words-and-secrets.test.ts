/**
 * The words a reader may refuse with, the holder of a secret, the stored form of a credential and
 * the package's numbers.
 */
import { inspect } from "node:util";
import { MAX_CALENDAR_TEXT_CHARS, MAX_COMPONENTS } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { MAX_CREDENTIAL_CHARS, parseCredential, serializeCredential, toCredential, type StoredCredential } from "../src/credentials.js";
import * as limits from "../src/limits.js";
import { PROVIDER_REFUSALS, asProviderRefusal } from "../src/refusals.js";
import { Secret } from "../src/secret.js";

// Invented, and put together here so that no line of this file is shaped like a real one.
const PLANTED = ["kiln", "glaze", "wheel", "slip"].join("-");
const FEED = `https://feeds.example.test/private-${PLANTED}/basic.ics`;

describe("the refusal words", () => {
  it("are a closed list of lower-case words with `unknown` among them, none twice", () => {
    expect(PROVIDER_REFUSALS.filter((w) => !/^[a-z]+(_[a-z]+)*$/.test(w))).toEqual([]);
    expect(new Set(PROVIDER_REFUSALS).size).toBe(PROVIDER_REFUSALS.length);
    expect(PROVIDER_REFUSALS).toContain("unknown");
  });

  it("tell apart every refusal the address gate makes before a socket opens", () => {
    for (const word of ["address_invalid", "address_not_allowed", "port_not_allowed", "host_unresolved", "host_changed", "too_many_redirects", "redirect_invalid", "page_link_refused"]) {
      expect(PROVIDER_REFUSALS).toContain(word);
    }
  });

  it("read a word nobody listed as `unknown`, and a listed one as itself", () => {
    expect(asProviderRefusal("token_gone")).toBe("token_gone");
    expect(asProviderRefusal("a word from a later version")).toBe("unknown");
    expect(asProviderRefusal("")).toBe("unknown");
  });
});

describe("a secret", () => {
  const secret = new Secret(PLANTED);

  it("hands its value out by `reveal` alone", () => {
    expect(secret.reveal()).toBe(PLANTED);
  });

  it("prints as [secret] as a string, as JSON, inspected, and inside what holds it", () => {
    const shown = [String(secret), `${secret}`, JSON.stringify(secret), JSON.stringify({ connection: 7, secret }), inspect(secret), inspect({ deep: [secret] }, { depth: 5 }), Object.keys(secret).join(","), JSON.stringify(Object.entries(secret))];
    expect(shown.filter((text) => text.includes(PLANTED))).toEqual([]);
    expect(String(secret)).toBe("[secret]");
    expect(inspect(secret)).toBe("[secret]");
  });
});

describe("a stored credential", () => {
  const all: StoredCredential[] = [
    { kind: "address", url: new Secret(FEED) },
    { kind: "basic", user: "mila@example.test", password: new Secret(PLANTED) },
    { kind: "oauth", provider: "google", refreshToken: new Secret(PLANTED) },
    { kind: "oauth", provider: "microsoft", refreshToken: new Secret(PLANTED) },
  ];

  it("comes back from its sealed form as it went in, each kind", () => {
    for (const stored of all) {
      const back = parseCredential(serializeCredential(stored)!);
      expect(back?.kind).toBe(stored.kind);
      expect(serializeCredential(back!)).toBe(serializeCredential(stored));
    }
    const basic = parseCredential(serializeCredential(all[1]!)!);
    expect(basic?.kind === "basic" && basic.user === "mila@example.test" && basic.password.reveal() === PLANTED).toBe(true);
  });

  it("names its version, and holds the value only in the text that is sealed", () => {
    expect(JSON.parse(serializeCredential(all[0]!)!)).toEqual({ v: 1, kind: "address", url: FEED });
    expect(all.map((c) => JSON.stringify(c) + inspect(c)).filter((text) => text.includes(PLANTED))).toEqual([]);
  });

  it("is nothing when the text is another version's, another kind's, short of a field, no JSON, or too long", () => {
    const refused = [
      "", "not json", "null", "[]", `"${PLANTED}"`,
      JSON.stringify({ v: 2, kind: "address", url: FEED }),
      JSON.stringify({ kind: "address", url: FEED }),
      JSON.stringify({ v: 1, kind: "password", password: PLANTED }),
      JSON.stringify({ v: 1, kind: "address" }),
      JSON.stringify({ v: 1, kind: "address", url: "" }),
      JSON.stringify({ v: 1, kind: "basic", user: 7, password: PLANTED }),
      JSON.stringify({ v: 1, kind: "basic", user: "mila" }),
      JSON.stringify({ v: 1, kind: "oauth", provider: "another", refreshToken: PLANTED }),
      JSON.stringify({ v: 1, kind: "oauth", provider: "google" }),
      JSON.stringify({ v: 1, kind: "address", url: `https://feeds.example.test/${"a".repeat(MAX_CREDENTIAL_CHARS)}` }),
    ];
    expect(refused.map(parseCredential).filter((c) => c !== null)).toEqual([]);
  });

  it("is not written when it could not be read back: a value that is empty, or a text past the ceiling", () => {
    const long = "a".repeat(MAX_CREDENTIAL_CHARS);
    const unreadable: StoredCredential[] = [
      { kind: "basic", user: "mila", password: new Secret(long) },
      { kind: "oauth", provider: "microsoft", refreshToken: new Secret(long) },
      { kind: "address", url: new Secret(`https://feeds.example.test/${long}`) },
      { kind: "basic", user: "", password: new Secret(PLANTED) },
      { kind: "basic", user: "mila", password: new Secret("") },
      { kind: "address", url: new Secret("") },
    ];
    expect(unreadable.map(serializeCredential)).toEqual(unreadable.map(() => null));
    // The longest that is read back is still written.
    const fits = serializeCredential({ kind: "address", url: new Secret(`https://feeds.example.test/${"a".repeat(MAX_CREDENTIAL_CHARS - 80)}`) });
    expect(fits !== null && fits.length <= MAX_CREDENTIAL_CHARS && parseCredential(fits)?.kind).toBe("address");
  });

  it("becomes the port's credential for an address and for a password, revealed only when asked", () => {
    const address = toCredential({ kind: "address", url: new Secret(FEED) });
    const basic = toCredential({ kind: "basic", user: "mila", password: new Secret(PLANTED) });
    expect(address.kind === "address" && address.url()).toBe(FEED);
    expect(basic.kind === "basic" && [basic.user, basic.password()]).toEqual(["mila", PLANTED]);
    expect([JSON.stringify(address), JSON.stringify(basic), inspect(address), inspect(basic)].filter((text) => text.includes(PLANTED))).toEqual([]);
  });
});

describe("the package's numbers", () => {
  it("fetch no more than the calendar reader takes, and count no more answers than it counts components", () => {
    expect(limits.FETCH_BODY_MAX_BYTES).toBe(MAX_CALENDAR_TEXT_CHARS);
    expect(limits.MAX_MULTISTATUS_RESPONSES).toBe(MAX_COMPONENTS);
  });

  it("are the ones decided: ten seconds to an answer's head, thirty for the whole, five redirects, six hours between asks", () => {
    expect([limits.CONNECT_TIMEOUT_MS, limits.ANSWER_TIMEOUT_MS, limits.MAX_REDIRECTS, limits.MAX_URL_CHARS]).toEqual([10_000, 30_000, 5, 8192]);
    expect([limits.SUBSCRIPTION_INTERVAL_FLOOR_MS, limits.SUBSCRIPTION_INTERVAL_MS, limits.SUBSCRIPTION_INTERVAL_CEILING_MS].map((ms) => ms / 3_600_000)).toEqual([1, 6, 168]);
    expect([limits.TOKEN_MAX_CHARS, limits.MAX_PAGE_LIMIT, limits.MAX_MASTERS_PER_ROUND, limits.MAX_PAGES_PER_CALL, limits.MAX_RETRY_AFTER_MS]).toEqual([4096, 250, 500, 20, 86_400_000]);
  });
});

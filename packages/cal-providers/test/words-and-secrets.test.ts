/**
 * The words a reader may refuse with, the holder of a secret, the stored form of a credential and
 * the package's numbers.
 */
import { inspect } from "node:util";
import { MAX_CALENDAR_TEXT_CHARS, MAX_COMPONENTS } from "@ohmail/cal-core";
import { describe, expect, it } from "vitest";
import { MAX_CREDENTIAL_CHARS, parseCredential, serializeCredential, toCredential, type CredentialPlace, type StoredCredential } from "../src/credentials.js";
import * as limits from "../src/limits.js";
import { PROVIDER_REFUSALS, asProviderRefusal } from "../src/refusals.js";
import { Secret } from "../src/secret.js";

// Invented, and put together here so that no line of this file is shaped like a real one.
const PLANTED = ["kiln", "glaze", "wheel", "slip"].join("-");
const FEED = `https://feeds.example.test/private-${PLANTED}/basic.ics`;
const DAV = "https://dav.example.test/remote.php/dav";

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
    { kind: "basic", server: DAV, user: "mila@example.test", password: new Secret(PLANTED) },
    { kind: "oauth", provider: "google", refreshToken: new Secret(PLANTED) },
    { kind: "oauth", provider: "microsoft", refreshToken: new Secret(PLANTED) },
  ];
  // The row a text is sealed for, and three rows it is not: another connection of the account, the same
  // connection id under another account, and another account's connection.
  const HERE: CredentialPlace = { accountId: "0e5b1f6a-58a7-4b7e-9a45-0d1f6b6c2a11", connectionId: "7c0d4f0e-3b1a-4a55-8f1c-2f6a9a3b1c22" };
  const BESIDE: CredentialPlace = { ...HERE, connectionId: "a41c7d2b-90f4-4e0b-b5a3-6f0c1d2e3f44" };
  const OTHERS: readonly CredentialPlace[] = [
    BESIDE,
    { ...HERE, accountId: "5d9a2c1e-7f30-4c8d-a6b2-9e8f7a6b5c33" },
    { accountId: "5d9a2c1e-7f30-4c8d-a6b2-9e8f7a6b5c33", connectionId: BESIDE.connectionId },
  ];

  it("comes back from its sealed form as it went in, each kind", () => {
    for (const stored of all) {
      const back = parseCredential(serializeCredential(stored, HERE)!, HERE);
      expect(back?.kind).toBe(stored.kind);
      expect(serializeCredential(back!, HERE)).toBe(serializeCredential(stored, HERE));
    }
    const basic = parseCredential(serializeCredential(all[1]!, HERE)!, HERE);
    expect(basic?.kind === "basic" && [basic.server, basic.user, basic.password.reveal()]).toEqual([DAV, "mila@example.test", PLANTED]);
  });

  it("a server's sign-in names the server it was typed for: a text that names none is nothing, and none is written without one", () => {
    const serverless = { v: 2, account: HERE.accountId, connection: HERE.connectionId, kind: "basic", user: "mila", password: PLANTED };
    const whole = { ...serverless, server: DAV };
    expect(JSON.parse(serializeCredential({ kind: "basic", server: DAV, user: "mila", password: new Secret(PLANTED) }, HERE)!)).toEqual(whole);
    // A password with no server beside it in the sealed text would be sent wherever its row says: it is nobody's sign-in.
    const nothing = [serverless, { ...whole, server: "" }, { ...whole, server: null }, { ...whole, server: 7 }, { ...whole, server: [DAV] }];
    expect(nothing.map((text) => parseCredential(JSON.stringify(text), HERE)).filter((c) => c !== null)).toEqual([]);
    expect(serializeCredential({ kind: "basic", server: "", user: "mila", password: new Secret(PLANTED) }, HERE)).toBeNull();
    // The control: the same text with its server in place is read, and hands the server back as it was written.
    const read = parseCredential(JSON.stringify(whole), HERE);
    expect(read?.kind === "basic" && read.server).toBe(DAV);
  });

  it("names its version and the row it was sealed for, and holds the value only in the text that is sealed", () => {
    expect(JSON.parse(serializeCredential(all[0]!, HERE)!)).toEqual({ v: 2, account: HERE.accountId, connection: HERE.connectionId, kind: "address", url: FEED });
    expect(all.map((c) => JSON.stringify(c) + inspect(c)).filter((text) => text.includes(PLANTED))).toEqual([]);
  });

  it("is nothing at any row but the one it was sealed for: another connection of the account, another account, a row that is not named", () => {
    for (const stored of all) {
      const text = serializeCredential(stored, HERE)!;
      expect(parseCredential(text, HERE)?.kind).toBe(stored.kind);
      const nowhere = [...OTHERS, { ...HERE, connectionId: "" }, { ...HERE, accountId: "" }, { accountId: "", connectionId: "" }];
      expect(nowhere.map((at) => parseCredential(text, at)).filter((c) => c !== null)).toEqual([]);
      // Neither does one id pass for the other, nor a spelling of an id for the id.
      expect(parseCredential(text, { accountId: HERE.connectionId, connectionId: HERE.accountId })).toBeNull();
      expect(parseCredential(text, { ...HERE, connectionId: HERE.connectionId.toUpperCase() })).toBeNull();
    }
    // A text that names no row, or half of one, is nobody's: there is none to find it on.
    for (const at of [{ ...HERE, connectionId: "" }, { ...HERE, accountId: "" }]) expect(all.map((c) => serializeCredential(c, at))).toEqual(all.map(() => null));
    const halves = [{ account: HERE.accountId }, { connection: HERE.connectionId }, { account: HERE.accountId, connection: 7 }, { account: null, connection: HERE.connectionId }];
    expect(halves.map((h) => parseCredential(JSON.stringify({ v: 2, ...h, kind: "address", url: FEED }), HERE)).filter((c) => c !== null)).toEqual([]);
  });

  it("is nothing when the text is another version's, another kind's, short of a field, no JSON, or too long", () => {
    const here = { account: HERE.accountId, connection: HERE.connectionId };
    const refused = [
      "", "not json", "null", "[]", `"${PLANTED}"`,
      // The version before this one named no row: with or without one written into it, it is read by nobody.
      JSON.stringify({ v: 1, kind: "address", url: FEED }),
      JSON.stringify({ v: 1, kind: "basic", user: "mila", password: PLANTED }),
      JSON.stringify({ v: 1, ...here, kind: "address", url: FEED }),
      JSON.stringify({ v: 3, ...here, kind: "address", url: FEED }),
      JSON.stringify({ ...here, kind: "address", url: FEED }),
      JSON.stringify({ v: 2, ...here, kind: "password", password: PLANTED }),
      JSON.stringify({ v: 2, ...here, kind: "address" }),
      JSON.stringify({ v: 2, ...here, kind: "address", url: "" }),
      JSON.stringify({ v: 2, ...here, kind: "basic", server: DAV, user: 7, password: PLANTED }),
      JSON.stringify({ v: 2, ...here, kind: "basic", server: DAV, user: "mila" }),
      JSON.stringify({ v: 2, ...here, kind: "oauth", provider: "another", refreshToken: PLANTED }),
      JSON.stringify({ v: 2, ...here, kind: "oauth", provider: "google" }),
      JSON.stringify({ v: 2, ...here, kind: "address", url: `https://feeds.example.test/${"a".repeat(MAX_CREDENTIAL_CHARS)}` }),
    ];
    expect(refused.map((text) => parseCredential(text, HERE)).filter((c) => c !== null)).toEqual([]);
    // The control: the same shape with every field in place is read.
    expect(parseCredential(JSON.stringify({ v: 2, ...here, kind: "address", url: FEED }), HERE)?.kind).toBe("address");
  });

  it("is not written when it could not be read back: a value that is empty, or a text past the ceiling", () => {
    const long = "a".repeat(MAX_CREDENTIAL_CHARS);
    const unreadable: StoredCredential[] = [
      { kind: "basic", server: DAV, user: "mila", password: new Secret(long) },
      { kind: "oauth", provider: "microsoft", refreshToken: new Secret(long) },
      { kind: "address", url: new Secret(`https://feeds.example.test/${long}`) },
      { kind: "basic", server: DAV, user: "", password: new Secret(PLANTED) },
      { kind: "basic", server: DAV, user: "mila", password: new Secret("") },
      { kind: "address", url: new Secret("") },
    ];
    expect(unreadable.map((c) => serializeCredential(c, HERE))).toEqual(unreadable.map(() => null));
    // The longest that is read back is still written: a text exactly at the ceiling, and not one a character past it.
    const start = "https://feeds.example.test/";
    const around = JSON.stringify({ v: 2, account: HERE.accountId, connection: HERE.connectionId, kind: "address", url: start }).length;
    const sealedAt = (chars: number): string | null => serializeCredential({ kind: "address", url: new Secret(start + "a".repeat(chars - around)) }, HERE);
    const fits = sealedAt(MAX_CREDENTIAL_CHARS);
    expect(fits !== null && fits.length === MAX_CREDENTIAL_CHARS && parseCredential(fits, HERE)?.kind).toBe("address");
    expect(sealedAt(MAX_CREDENTIAL_CHARS + 1)).toBeNull();
    // An address at its own ceiling fits beside the row's two ids: what a door takes can be kept.
    const longest = serializeCredential({ kind: "address", url: new Secret(start + "a".repeat(limits.MAX_URL_CHARS - start.length)) }, HERE);
    expect(longest !== null && parseCredential(longest, HERE)?.kind).toBe("address");
  });

  it("becomes the port's credential for an address and for a password, revealed only when asked", () => {
    const address = toCredential({ kind: "address", url: new Secret(FEED) });
    const basic = toCredential({ kind: "basic", server: DAV, user: "mila", password: new Secret(PLANTED) });
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

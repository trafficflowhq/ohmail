import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  FIXTURE_SHAPES, anthropicKey, base32Seed, fixturePassword, hex64, managedAddress, managedDomain, opaqueRun,
  openAiKey, pemHeader, personalAt, resendKey, stripeTestKey,
} from "../../../test/support/fixture-credentials.js";
import { SECRET_VALUE_PATTERNS } from "../src/log.js";
import { ANTHROPIC_KEY_PREFIX } from "../src/ai/anthropic-client.js";

/**
 * The published test set's fixture helper: each assembler yields the shape it is for, read by the
 * product's own readers where one exists (the log's secret-value patterns, the Anthropic prefix), two
 * tags never share a value, and no export has a default — a call without its argument is refused by
 * the compiler and at run time.
 */
const redacted = (v: string): boolean => SECRET_VALUE_PATTERNS.some((re) => re.test(v));

describe("the assemblers yield the shape they are for", () => {
  it("the vendor keys match their shapes, and the log's own patterns read the ones it redacts", () => {
    expect(anthropicKey("helper")).toMatch(FIXTURE_SHAPES.anthropic);
    expect(anthropicKey("helper").startsWith(ANTHROPIC_KEY_PREFIX)).toBe(true);
    expect(redacted(anthropicKey("helper"))).toBe(true);
    expect(openAiKey("helper")).toMatch(FIXTURE_SHAPES.openai);
    expect(stripeTestKey("helper")).toMatch(FIXTURE_SHAPES.stripeTest);
    expect(redacted(stripeTestKey("helper"))).toBe(true);
    expect(resendKey("helper")).toMatch(FIXTURE_SHAPES.resend);
  });

  it("the PEM header is the line a real PKCS#8 key opens with", () => {
    const pem = generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey
      .export({ type: "pkcs8", format: "pem" }).toString();
    expect(pem.split("\n")[0]).toBe(pemHeader("PRIVATE KEY"));
    expect(pemHeader("RSA PRIVATE KEY")).toMatch(FIXTURE_SHAPES.pemHeader);
    expect(redacted(pemHeader("PRIVATE KEY"))).toBe(true);
  });

  it("a 64-hex key is 32 bytes and a TOTP seed is 16 base32 characters", () => {
    expect(hex64("helper")).toMatch(FIXTURE_SHAPES.hex64);
    expect(Buffer.from(hex64("helper"), "hex")).toHaveLength(32);
    expect(base32Seed("helper")).toMatch(FIXTURE_SHAPES.base32);
  });

  it("an opaque run is letters and digits of the length asked, the same for its tag on every call", () => {
    expect(opaqueRun("helper", 24)).toMatch(/^[A-Za-z0-9]{24}$/);
    expect(opaqueRun("helper", 150)).toMatch(/^[A-Za-z0-9]{150}$/);
    expect(opaqueRun("helper", 150).startsWith(opaqueRun("helper", 24))).toBe(true);
    expect(opaqueRun("helper", 60)).toMatch(/[a-z]/);
    expect(opaqueRun("helper", 60)).toMatch(/[A-Z]/);
    expect(opaqueRun("helper", 60)).toMatch(/[0-9]/);
    for (const n of [0, -1, 1.5, Number.NaN]) expect(() => opaqueRun("helper", n), String(n)).toThrow(TypeError);
  });

  it("two tags never share a value", () => {
    for (const make of [anthropicKey, openAiKey, stripeTestKey, resendKey, hex64, base32Seed, fixturePassword]) {
      expect(make("helper-one"), make.name).not.toBe(make("helper-two"));
    }
    expect(opaqueRun("helper-one", 24)).not.toBe(opaqueRun("helper-two", 24));
  });
});

describe("addresses and passwords", () => {
  it("a fixture local at the managed domain or at a named provider, and nothing else", () => {
    const managed = managedAddress("fixture.mila");
    expect(managed.split("@")).toEqual(["fixture.mila", managedDomain()]);
    expect(personalAt("fixture.mila", "gmail.com").split("@")).toEqual(["fixture.mila", "gmail.com"]);
    // One segment after the prefix: a first and last name behind it would be a person's local part.
    for (const local of ["mila", "fixture.mila+news", "Fixture.Mila", "fixture.", "fixture.mila@x",
      "fixture.mila.brunner", "fixture.mila-brunner", "fixture.mila_brunner"]) {
      expect(() => managedAddress(local), local).toThrow(TypeError);
      expect(() => personalAt(local, "gmail.com"), local).toThrow(TypeError);
    }
    for (const domain of ["gmail", "Gmail.com", "x@example.com"]) {
      expect(() => personalAt("fixture.mila", domain), domain).toThrow(TypeError);
    }
  });

  it("a password names itself and is long enough for a sign-in", () => {
    expect(fixturePassword("mila")).toBe("mila-password");
    expect(fixturePassword("mila").length).toBeGreaterThanOrEqual(12);
    expect(() => fixturePassword("ab")).toThrow(TypeError);
    expect(() => anthropicKey("Has Spaces")).toThrow(TypeError);
  });
});

describe("no export has a default", () => {
  it("a call without its argument does not compile and throws", () => {
    // @ts-expect-error the tag is required
    expect(() => anthropicKey()).toThrow(TypeError);
    // @ts-expect-error the tag is required
    expect(() => openAiKey()).toThrow(TypeError);
    // @ts-expect-error the tag is required
    expect(() => stripeTestKey()).toThrow(TypeError);
    // @ts-expect-error the tag is required
    expect(() => resendKey()).toThrow(TypeError);
    // @ts-expect-error the kind is required
    expect(() => pemHeader()).toThrow(TypeError);
    // @ts-expect-error the tag is required
    expect(() => hex64()).toThrow(TypeError);
    // @ts-expect-error the tag is required
    expect(() => base32Seed()).toThrow(TypeError);
    // @ts-expect-error the length is required
    expect(() => opaqueRun("helper")).toThrow(TypeError);
    // @ts-expect-error the local part is required
    expect(() => managedAddress()).toThrow(TypeError);
    // @ts-expect-error the domain is required
    expect(() => personalAt("fixture.mila")).toThrow(TypeError);
    // @ts-expect-error the tag is required
    expect(() => fixturePassword()).toThrow(TypeError);
  });
});

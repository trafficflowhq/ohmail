import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { Secret, echoes, reveal, secretIsEmpty, secretOf } from "../../../src/mailboxes/connect/secret.js";

/** A value no sentence of the product holds, so finding it anywhere is finding the typed password. */
const MARKER = "zq-MARKER-pass-7Kd!\"<b>'\n‮";

/** What a seal prints as. */
const SHOWN = "[secret]";

describe("a sealed password", () => {
  it("is opened by `reveal` alone, and gives the value as it was typed", () => {
    const secret = secretOf(MARKER);
    expect(reveal(secret)).toBe(MARKER);
    expect(secretIsEmpty(secret)).toBe(false);
    expect(secretIsEmpty(secretOf(""))).toBe(true);
  });

  it("printed, joined into a sentence or inspected, says `[secret]` and never the value", () => {
    const secret = secretOf(MARKER);
    for (const shown of [
      String(secret),
      `${secret}`,
      "" + secret,
      inspect(secret),
      inspect({ body: { pass: secret } }, { depth: 9 }),
    ])
      expect(shown).not.toContain("MARKER");
    expect(String(secret)).toBe(SHOWN);
  });

  it("serialised, alone or inside a body, gives `[secret]`", () => {
    const secret = secretOf(MARKER);
    const body = Object.freeze({
      address: "a@example.org",
      imap: Object.freeze({ host: "mail.example.org", pass: secret }),
    });
    expect(JSON.stringify(secret)).toBe(JSON.stringify(SHOWN));
    expect(JSON.parse(JSON.stringify(body))).toEqual({
      address: "a@example.org",
      imap: { host: "mail.example.org", pass: SHOWN },
    });
  });

  it("holds no field: its keys, its entries and a spread of it are empty", () => {
    const secret = secretOf(MARKER);
    expect(Object.keys(secret)).toEqual([]);
    expect(Object.getOwnPropertyNames(secret)).toEqual([]);
    expect(Object.getOwnPropertySymbols(secret)).toEqual([]);
    expect({ ...secret }).toEqual({});
    expect(Object.isFrozen(secret)).toBe(true);
  });

  it("cloned or copied, the copy holds nothing and opens nothing", () => {
    const secret = secretOf(MARKER);
    const clone = structuredClone(secret) as unknown;
    expect(JSON.stringify(clone)).toBe("{}");
    expect(() => reveal(clone as Secret)).toThrow(TypeError);
    expect(() => reveal(Object.create(Secret.prototype) as Secret)).toThrow(TypeError);
    expect(() => reveal(JSON.parse(JSON.stringify(secret)) as Secret)).toThrow(TypeError);
  });

  it("says whether a text repeats it, without opening it, for every length a form accepts; nothing typed is never found", () => {
    const secret = secretOf(MARKER);
    expect(echoes(secret, `The server said: login ${MARKER} refused`)).toBe(true);
    expect(echoes(secret, "That mail server refused the password.")).toBe(false);
    // A short password is found too: a sentence that holds it is not drawn, though it may hold it by chance.
    expect(echoes(secretOf("abc"), "abc is everywhere")).toBe(true);
    expect(echoes(secretOf("a"), "That mail server refused the password.")).toBe(true);
    expect(echoes(secretOf("abc"), "That mail server refused the login.")).toBe(false);
    expect(echoes(secretOf(""), "anything")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { sayRefusal, type SaidRefusal, type SaidText } from "../../src/phone/said.js";

/*
 * A REFUSAL THE PHONE'S NATIVE SIDE SAID, IN WORDS: a code and its arguments in, the catalogue's sentence out, read
 * in the language the reader holds now. A refusal inside a refusal is worded in the same read.
 */

/** A reader over a small namespace, recording every key it is asked for. */
function reader(sentences: Record<string, string>): SaidText & { asked: string[] } {
  const asked: string[] = [];
  const t = ((key: string, values?: Record<string, unknown>) => {
    asked.push(key);
    const sentence = sentences[key];
    if (sentence === undefined) throw new Error(`asked for a key it does not hold: ${key}`);
    return sentence.replace(/\{(\d+)\}/g, (_, i: string) => String(values?.[i] ?? `<hole ${i}>`));
  }) as SaidText & { asked: string[] };
  t.has = (key: string) => Object.hasOwn(sentences, key);
  t.asked = asked;
  return t;
}

const said = (code: string, ...args: (string | SaidRefusal)[]): SaidRefusal => ({ code, args });

const WORDS = {
  unknown: "That did not work.",
  plain: "This phone has no network.",
  two: "{1} said no to {0}.",
  outer: "Opening the mailbox stopped: {0}",
  inner: "the server answered {0}",
};

describe("a refusal the phone said, in words", () => {
  it("says a known code's sentence with its arguments in their places", () => {
    const t = reader(WORDS);
    expect(sayRefusal(t, said("plain"))).toBe("This phone has no network.");
    expect(sayRefusal(t, said("two", "Gmail", "Google"))).toBe("Google said no to Gmail.");
  });

  it("words a refusal inside a refusal in the same read", () => {
    const t = reader(WORDS);
    expect(sayRefusal(t, said("outer", said("inner", "503")))).toBe(
      "Opening the mailbox stopped: the server answered 503",
    );
    expect(t.asked).toEqual(["inner", "outer"]);
  });

  it("says the unknown sentence for a code the catalogue does not hold", () => {
    const t = reader(WORDS);
    expect(sayRefusal(t, said("newerThanThisPage", "x"))).toBe("That did not work.");
    expect(t.asked).toEqual(["unknown"]);
  });

  it("never reads a code that is not one plain key as a path into the catalogue", () => {
    const t = reader({ ...WORDS, "a.b": "a nested sentence", constructor: "an object's own name" });
    for (const code of ["a.b", "", "two ", "__proto__", "constructor", "x{0}", "../two"]) {
      expect(sayRefusal(t, said(code)), code).toBe("That did not work.");
    }
    expect(t.asked.every((key) => key === "unknown")).toBe(true);
  });

  it("says the unknown sentence in place of a refusal nested deeper than three", () => {
    const t = reader({ ...WORDS, wrap: "[{0}]" });
    const three = said("wrap", said("wrap", said("plain")));
    expect(sayRefusal(t, three)).toBe("[[This phone has no network.]]");
    const four = said("wrap", said("wrap", said("wrap", said("plain"))));
    expect(sayRefusal(t, four)).toBe("[[[That did not work.]]]");
  });

  it("hands over exactly the arguments it was given, each under its place", () => {
    const seen: Record<string, unknown>[] = [];
    const t = Object.assign(
      (key: string, values?: Record<string, unknown>) => {
        seen.push({ key, ...values });
        return key;
      },
      { has: () => true },
    ) as SaidText;
    sayRefusal(t, said("two", "a", "b"));
    sayRefusal(t, said("plain"));
    expect(seen).toEqual([{ key: "two", 0: "a", 1: "b" }, { key: "plain" }]);
  });
});

/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { createElement as h, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sayRefusal, type SaidRefusal } from "@ohmail/app-logic/phone/said";
import { TextProvider, useText, type Locale, type Messages, type Text } from "../../src/text/index.js";
import en from "../../messages/phone.en.json" with { type: "json" };
import de from "../../messages/phone.de.json" with { type: "json" };

/*
 * A REFUSAL THE PHONE SAID, IN ITS CATALOGUE'S WORDS, BY THE PAGE'S OWN READER: every sentence of `phoneRefusal`
 * is said whole in English and German with the values it is handed, a refusal inside one in the same language, and
 * a code the catalogue does not hold says the unknown sentence.
 */

const CATALOGUE: Record<Locale, Messages> = { en: en as Messages, de: de as Messages };
const KEYS = Object.keys(en.phoneRefusal).filter((key) => key !== "unknown");
const marker = (i: number) => `«value-${i}»`;
const said = (code: string, ...args: (string | SaidRefusal)[]): SaidRefusal => ({ code, args });

/** A page's reader of one namespace (`phoneRefusal` unless named) in this language. */
function readerIn(locale: Locale, namespace = "phoneRefusal"): Text {
  let held: Text | null = null;
  const Take = (): ReactNode => {
    held = useText(namespace);
    return null;
  };
  render(
    h(TextProvider, { locale, messages: CATALOGUE[locale], timeZone: "Europe/Zurich", children: h(Take) }),
  );
  if (held === null) throw new Error("no reader");
  return held;
}

/** Each place a sentence fills, with whether it is a choice (`{0, select, …}`) or quoted (`{0}`). */
function placesOf(sentence: string): Map<number, "choice" | "quoted"> {
  const out = new Map<number, "choice" | "quoted">();
  for (const m of sentence.matchAll(/\{(\d+)([},])/g)) {
    const i = Number(m[1]);
    if (m[2] === "," || !out.has(i)) out.set(i, m[2] === "," ? "choice" : "quoted");
  }
  return out;
}

let errors: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  cleanup();
  errors.mockRestore();
});

describe("the phone's refusals, said by the page's reader", () => {
  it("says every sentence whole in both languages, each quoted value in its place", () => {
    expect(KEYS.length).toBeGreaterThan(250);
    for (const locale of ["en", "de"] as const) {
      const t = readerIn(locale);
      for (const key of KEYS) {
        const places = placesOf((CATALOGUE[locale].phoneRefusal as Record<string, string>)[key]!);
        const count = places.size === 0 ? 0 : Math.max(...places.keys()) + 1;
        const both = ["1", "7"].map((choice) => {
          const args = Array.from({ length: count }, (_, i) =>
            places.get(i) === "choice" ? choice : marker(i),
          );
          const words = sayRefusal(t, said(key, ...args));
          expect(words.trim(), `${locale} ${key}`).not.toBe("");
          expect(words, `${locale} ${key}`).not.toMatch(/[{}]/);
          expect(words, `${locale} ${key}`).not.toBe(sayRefusal(t, said("unknown")));
          return words;
        });
        /* A value quoted inside one branch of a choice stands in that branch's words only. */
        for (const [i, kind] of places) {
          if (kind === "quoted") expect(both.join(" "), `${locale} ${key}`).toContain(marker(i));
        }
      }
    }
    expect(errors).not.toHaveBeenCalled();
  });

  it("says a choice's own branch for one and for many", () => {
    const t = readerIn("en");
    expect(sayRefusal(t, said("lettersKept", "1"))).toBe(
      "A letter you were writing when ohmail stopped is in Drafts.",
    );
    expect(sayRefusal(t, said("lettersKept", "3"))).toBe(
      "3 letters you were writing when ohmail stopped are in Drafts.",
    );
  });

  it("says a refusal inside a refusal in the same language", () => {
    for (const locale of ["en", "de"] as const) {
      const t = readerIn(locale);
      const inner = sayRefusal(t, said("standaloneOffline"));
      expect(sayRefusal(t, said("standaloneRefused", said("standaloneOffline")))).toContain(inner);
    }
    expect(sayRefusal(readerIn("de"), said("standaloneOffline"))).not.toBe(
      sayRefusal(readerIn("en"), said("standaloneOffline")),
    );
  });

  it("is never handed a rejected ask's reason: the bridge's `unreachable` is not the deck's", () => {
    /* The reasons a door ask is rejected with (BridgeRefused): the door's closed table, and the page channel's own. A
       page says `phoneRefusal.unknown` for every one of them. One is also a key here, and it means a server could not
       be reached: handed to sayRefusal, a native throw would say a server's state. A second key named like a reason
       turns this red, and the handover's rule names it too. */
    const REJECTED = [
      "unknownKind",
      "malformed",
      "foreignEpoch",
      "foreignScope",
      "notReady",
      "notRelayed",
      "tooLarge",
      "tooMany",
      "cancelled",
      "unreachable",
      "notKept",
      "deadline",
      "aborted",
    ];
    expect(REJECTED.filter((reason) => Object.hasOwn(en.phoneRefusal, reason))).toEqual(["unreachable"]);
    const t = readerIn("en");
    expect(sayRefusal(t, said("unreachable"))).toContain("could not reach that address");
    expect(sayRefusal(t, said("unreachable"))).not.toBe(en.phoneRefusal.unknown);
  });

  it("says the unknown sentence for a code the catalogue does not hold", () => {
    for (const locale of ["en", "de"] as const) {
      const t = readerIn(locale);
      expect(sayRefusal(t, said("aCodeFromANewerBuild", "x"))).toBe(
        (CATALOGUE[locale].phoneRefusal as Record<string, string>).unknown,
      );
    }
    expect(errors).not.toHaveBeenCalled();
  });
});

describe("the door's words, filled from the door's answer", () => {
  it("names the address it reached and where its mail API is, as the studio draws them, in both languages", () => {
    const answer = {
      k: "reached",
      address: "https://oh.lichtgrat.example",
      flavor: "server",
      apiUnder: "https://oh.lichtgrat.example/api",
    };
    for (const locale of ["en", "de"] as const) {
      const t = readerIn(locale, "phoneDoor");
      expect(t("server.reached", { address: answer.address }), locale).toContain(answer.address);
      expect(t("server.reachedApi", { apiUnder: answer.apiUnder }), locale).toContain(answer.apiUnder);
    }
    expect(readerIn("en", "phoneDoor")("server.reached", { address: "oh.lichtgrat.example" })).toBe(
      "Reached oh.lichtgrat.example, an ohmail server.",
    );
    expect(errors).not.toHaveBeenCalled();
  });
});

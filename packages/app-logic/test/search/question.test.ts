import { describe, expect, it } from "vitest";
import type { AddressBookEntry } from "@ohmail/client-engine";
import { justFinished, parseOperators, withoutOperator } from "../../src/search/operators.js";
import { onePersonMeant, peopleFor, sharesName } from "../../src/search/people.js";
import { dayBounds, filtersOf, NO_NARROWING } from "../../src/search/question.js";

/**
 * THE QUESTION BESIDE THE WORDS: what is typed as an operator, the people a text means, and the filters a question
 * sends, only to a server that said it takes them.
 */
describe("operators as typed", () => {
  it("takes a finished operator out of the words, and leaves the one still being typed open", () => {
    const typed = parseOperators("kiln from:ben@lichtgrat.example in:news to:be");
    expect(typed.words).toBe("kiln");
    expect(typed.done.map((o) => [o.key, o.value])).toEqual([
      ["from", "ben@lichtgrat.example"],
      ["in", "news"],
    ]);
    expect(typed.open).toMatchObject({ key: "to", value: "be" });
  });

  it("reads a word with a colon that names no operator, and an operator with nothing after it, as words", () => {
    const typed = parseOperators("re:invoice from: 10:30 ");
    expect(typed.words).toBe("re:invoice from: 10:30");
    expect(typed.done).toEqual([]);
    expect(typed.open).toBeNull();
  });

  it("an operator's name is read in any case, its value as typed", () => {
    expect(parseOperators("IS:Unread ").done.map((o) => [o.key, o.value])).toEqual([["is", "Unread"]]);
  });

  it("an operator taken out leaves the words around it as typed, and a space for the next word at the end", () => {
    const text = "kiln from:ben quote";
    const [op] = parseOperators(text).done;
    expect(withoutOperator(text, op!)).toBe("kiln quote");
    const end = "kiln is:unread ";
    expect(withoutOperator(end, parseOperators(end).done[0]!)).toBe("kiln ");
    expect(withoutOperator("is:unread ", parseOperators("is:unread ").done[0]!)).toBe("");
  });

  it("reads a long line once through: ten thousand words in one pass", () => {
    const text = `${"glaze ".repeat(10_000)}from:x`;
    const typed = parseOperators(text);
    expect(typed.open?.key).toBe("from");
    expect(typed.words.split(" ")).toHaveLength(10_000);
  });

  it("costs time in proportion to the line: ten times the line, about ten times the time", () => {
    const best = (text: string): number => {
      let least = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        parseOperators(text);
        least = Math.min(least, performance.now() - t0);
      }
      return least;
    };
    const line = (n: number): string => `${"glaze from:x ".repeat(n / 13)}is:`;
    best(line(20_000));
    const short = best(line(20_000));
    const long = best(line(200_000));
    /* Linear reads about ten times; a reader that rescans what it read reads about a hundred. */
    expect(long).toBeLessThan(Math.max(30 * short, 50));
  });

  it("the operator a space has just finished is the token before that space alone", () => {
    expect(justFinished("kiln from:ben ")).toMatchObject({ key: "from", value: "ben", at: 5, end: 13 });
    expect(justFinished("from:ben kiln ")).toBeNull();
    expect(justFinished("from:ben  ")).toBeNull();
    expect(justFinished("from: ")).toBeNull();
    expect(justFinished("from:ben")).toBeNull();
  });
});

describe("the people a text means", () => {
  const book: AddressBookEntry[] = [
    { address: "ben@lichtgrat.example", name: "Ben Arnold", count: 4, lastSeen: 0 },
    { address: "nadja@erdton-atelier.example", name: "Nadja Lehner", count: 9, lastSeen: 0 },
    { address: "info@bench-tools.example", name: "Bench Tools", count: 1, lastSeen: 0 },
    { address: "giulia@terracotta-milano.example", name: "Giulia Rossi", count: 2, lastSeen: 0 },
  ] as unknown as AddressBookEntry[];

  it("nearest first: a name that starts with it, a later word of a name, an address or its domain", () => {
    expect(peopleFor("ben", book).map((p) => p.name)).toEqual(["Ben Arnold", "Bench Tools"]);
    expect(peopleFor("rossi", book).map((p) => p.name)).toEqual(["Giulia Rossi"]);
    expect(peopleFor("erdton", book).map((p) => p.name)).toEqual(["Nadja Lehner"]);
  });

  it("one person is meant only by a whole address, or alone at the nearest rank with no namesake", () => {
    expect(onePersonMeant("ben", book)).toBeNull();
    expect(onePersonMeant("nadja", book)?.address).toBe("nadja@erdton-atelier.example");
    expect(onePersonMeant("BEN@lichtgrat.example", book)?.name).toBe("Ben Arnold");
    const twins = [
      ...book,
      { address: "ben@other.example", name: "Ben Arnold", count: 1, lastSeen: 0 },
    ] as unknown as AddressBookEntry[];
    expect(onePersonMeant("arnold", twins)).toBeNull();
    expect(onePersonMeant("ben@other.example", twins)?.address).toBe("ben@other.example");
    expect(sharesName({ address: "ben@other.example", name: "Ben Arnold" }, twins)).toBe(true);
  });

  it("from three letters on, one that holds it anywhere; nothing typed, everybody by how much mail", () => {
    expect(peopleFor("icht", book).map((p) => p.name)).toEqual(["Ben Arnold"]);
    expect(peopleFor("ic", book)).toEqual([]);
    expect(peopleFor("", book).map((p) => p.name)).toEqual([
      "Nadja Lehner",
      "Ben Arnold",
      "Giulia Rossi",
      "Bench Tools",
    ]);
  });
});

describe("the filters a question sends", () => {
  const ben = { address: "ben@lichtgrat.example", name: "Ben Arnold" };

  it("a person is sender, to or party by their side; unread is sent as it is set", () => {
    expect(filtersOf({ ...NO_NARROWING, person: { ...ben, dir: "from" } }, "people")).toEqual({
      sender: ben.address,
    });
    expect(filtersOf({ ...NO_NARROWING, person: { ...ben, dir: "to" } }, "people")).toEqual({
      to: ben.address,
    });
    expect(filtersOf({ ...NO_NARROWING, person: { ...ben, dir: "any" }, unread: true }, "people")).toEqual({
      party: ben.address,
      unread: true,
    });
  });

  it("nothing of it goes to a server that did not say it takes them", () => {
    expect(
      filtersOf(
        { person: { ...ben, dir: "to" }, unread: true, date: { from: "2026-11-01", to: "2026-11-10" } },
        "words",
      ),
    ).toEqual({});
  });

  it("the days go as the first and the last millisecond of the days picked, both ends inclusive", () => {
    const first = dayBounds("2026-11-01")!;
    const last = dayBounds("2026-11-10")!;
    expect(new Date(first.first).getDate()).toBe(1);
    expect(new Date(last.last).getDate()).toBe(10);
    expect(new Date(last.last).getHours()).toBe(23);
    expect(new Date(new Date(last.last).getTime() + 1).getDate()).toBe(11);
    expect(filtersOf({ ...NO_NARROWING, date: { from: "2026-11-01", to: "2026-11-10" } }, "people")).toEqual({
      dateFrom: first.first,
      dateTo: last.last,
    });
    expect(dayBounds("2026-02-30")).toBeNull();
    expect(filtersOf({ ...NO_NARROWING, date: { from: null, to: "2026-11-10" } }, "people")).toEqual({
      dateTo: last.last,
    });
  });
});

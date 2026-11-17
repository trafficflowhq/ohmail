import { describe, expect, it } from "vitest";
import { liveCopyOver } from "../../src/text/live-copy.js";
import type { Translator } from "../../src/text/translator.js";

const ENGLISH = {
  title: "Show images",
  count: (n: number, host: string) => `${n} pictures from ${host}`,
};
const PARAMS = { count: ["count", "host"] } as const;

describe("liveCopyOver", () => {
  it("answers English while there is no translator", () => {
    const copy = liveCopyOver(() => null, ENGLISH, PARAMS);
    expect(copy.title).toBe("Show images");
    expect(copy.count(3, "a.example")).toBe("3 pictures from a.example");
  });

  it("answers the translator's sentence, read again on every access", () => {
    let t: Translator | null = null;
    const copy = liveCopyOver(() => t, ENGLISH, PARAMS);
    expect(copy.title).toBe("Show images");
    t = (key) => (key === "title" ? "Bilder anzeigen" : "");
    expect(copy.title).toBe("Bilder anzeigen");
    t = null;
    expect(copy.title).toBe("Show images");
  });

  it("falls back to English where the translator answers empty", () => {
    const copy = liveCopyOver(() => () => "", ENGLISH, PARAMS);
    expect(copy.title).toBe("Show images");
    expect(copy.count(1, "b.example")).toBe("1 pictures from b.example");
  });

  it("hands positional arguments to the translator by name", () => {
    const heard: Array<Record<string, unknown> | undefined> = [];
    const t: Translator = (key, values) => {
      heard.push(values);
      return key === "count" ? `${String(values?.count)} Bilder von ${String(values?.host)}` : "";
    };
    const copy = liveCopyOver(() => t, ENGLISH, PARAMS);
    expect(copy.count(2, "c.example")).toBe("2 Bilder von c.example");
    expect(heard).toEqual([{ count: 2, host: "c.example" }]);
  });

  it("keeps the table's keys enumerable", () => {
    expect(Object.keys(liveCopyOver(() => null, ENGLISH, PARAMS)).sort()).toEqual(["count", "title"]);
  });
});

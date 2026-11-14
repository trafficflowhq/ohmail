/**
 * THE FRAME'S WORDS ON ITS FIRST FRAME. The web inlines a cut of the catalogue in the document; the frame's sentences at
 * rest are in it (in both languages), so its landmarks and its dock are named on the first frame and not one commit
 * later. And a German reader's file is asked beside the English one, not after it: on a slow line the German first
 * frame waited for both files in a row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FRAME_AT_REST } from "@ohmail/app/frame/namespaces";
import en from "../../messages/en.json";
import de from "../../messages/de.json";
import { firstScreenCatalog } from "../../i18n/first-screen";

const read = (tree: unknown, path: string): unknown => path.split(".").reduce<unknown>((at, k) => (at as Record<string, unknown> | undefined)?.[k], tree);
const leaves = (tree: unknown, at = ""): string[] =>
  typeof tree === "string" ? [at] : Object.entries(tree as Record<string, unknown>).flatMap(([k, v]) => leaves(v, at ? `${at}.${k}` : k));

describe("the first screen's cut", () => {
  for (const [lang, all] of [["en", en], ["de", de]] as const) {
    it(`carries the frame's words at rest in ${lang}, and no other of its words`, () => {
      const cut = firstScreenCatalog(all as never) as Record<string, unknown>;
      for (const key of FRAME_AT_REST) expect(read(cut.frame, key), key).toBe(read((all as Record<string, unknown>).frame, key));
      expect(leaves(cut.frame).sort()).toEqual([...FRAME_AT_REST].sort());
    });
  }
});

describe("a German reader's catalogue", () => {
  afterEach(() => {
    vi.doUnmock("../../messages/en.json");
    vi.doUnmock("../../messages/de.json");
    vi.resetModules();
  });

  it("is asked beside the English one, while English is still on its way", async () => {
    const asked: string[] = [];
    let landEnglish: () => void = () => undefined;
    const english = new Promise<void>((resolve) => { landEnglish = resolve; });
    vi.resetModules();
    vi.doMock("../../messages/en.json", async () => {
      asked.push("en");
      await english;
      return { default: { a: "A" } };
    });
    vi.doMock("../../messages/de.json", async () => {
      asked.push("de");
      return { default: { a: "Ä" } };
    });
    const { loadWholeCatalog } = await import("../../i18n/catalog");
    const loading = loadWholeCatalog("de");
    await vi.waitFor(() => expect(asked).toContain("en"));
    await new Promise((r) => setTimeout(r, 20));
    expect(asked, "German waited for English").toContain("de");
    landEnglish();
    expect(await loading).toEqual({ a: "Ä" });
  });
});

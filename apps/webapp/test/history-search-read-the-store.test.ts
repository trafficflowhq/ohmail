import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * NO HISTORY OR SEARCH PATH READS THE MIRROR'S WINDOW (ARCHIVE-024) — on the browser and on the
 * phone. History and Search are paged reads of the store; the mirror only paints first. A census
 * over the files that make up both surfaces: none asks what the window is, none lists the
 * consent partition's `history`, and each is bound to the store's doors. The behavioural half —
 * paging the whole store leaves the mirror's message count where it was — is
 * `packages/client-engine/test/store-pages.test.ts`'s census.
 */

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/** Every file of the two surfaces, and the door each must use. */
const SURFACES: Array<{ file: string; door: RegExp }> = [
  { file: "../../../packages/app-logic/src/history/live.ts", door: /useStoreTimeline\(/ },
  { file: "../../../packages/app-logic/src/session/store-timeline.ts", door: /StoreTimelineWalker/ },
  { file: "../../../packages/client-engine/src/store-timeline.ts", door: /engine\.pageStore\("all"[\s\S]*engine\.pageSearch\(/ },
  { file: "../../../packages/app-logic/src/search/store-pass.ts", door: /new StoreSearchWalker\(/ },
  { file: "../../../packages/app-logic/src/search/search-list.ts", door: /useResultSlots\(/ },
  { file: "../../../packages/app-logic/src/search/slots.ts", door: /useStorePass\(/ },
  { file: "../../mobile/app/history.tsx", door: /useStoreHistory\(\)/ },
  { file: "../../mobile/app/search.tsx", door: /useStoreSearch\(/ },
  { file: "../../mobile/src/state/store-views.ts", door: /walker\.(start|want)\(/ },
];

/** What reading the window, or the device's partition as a list, looks like in source. */
/** History gives its view the list window made from the store timeline. */
const STORE_LIST_WINDOW = /windowed: \{ scroller: own\.scroller, window, total: tl\.length, slots, jump: tl\.jump \}/;
const WINDOW_READS = /storeWindow\s*\(|windowedMirror|\bwindowed\b|storePolicy|liveHistory\(|consentView\?*\.history|w\.history\b/;

describe("History and Search read the store, never the mirror's window", () => {
  for (const { file, door } of SURFACES) {
    it(`${file.replace(/^(\.\.\/)+/, "")}: uses the store's door, reads no window`, () => {
      const src = read(file);
      expect(src, "the surface is bound to the store's door").toMatch(door);
      const checked = file.endsWith("/history/live.ts") ? src.replace(STORE_LIST_WINDOW, "") : src;
      expect(checked.match(WINDOW_READS)?.[0] ?? null, "a read of the mirror's window").toBeNull();
    });
  }

  it("the shell hands History no mirror list and no window flag", () => {
    const seat = read("../../../packages/app/src/history/Seat.tsx");
    const live = read("../../../packages/app-logic/src/history/live.ts");
    expect(seat).toContain("const args = usePlaceLiveArgs()");
    expect(seat).toContain("useHistoryLive(args, { ...usePlaceListOwn(), scroller })");
    expect(seat).toMatch(/<HistoryAbove model=\{model\}>/);
    expect(seat).not.toMatch(/\bmessages=|\bwindowed=/);
    expect(live).toContain("useStoreTimeline(engine, derived, mirrorRows)");
    expect(live).toContain("useListWindow({ scrollerRef: own.scroller, count: tl.length, inserted: tl.shifted })");
    expect(live).toMatch(STORE_LIST_WINDOW);
  });

  /**
   * ONE LIST MECHANISM: Search pages through the walker History
   * walks, so neither Search surface asks the store for a page or keeps a page array of its own.
   */
  const OWN_PAGING = /\.searchServer\(|\bnextCursor\b|\bloadMore\s*=|\.outcome\.items\b/;
  for (const file of [
    "../../../packages/app-logic/src/search/search-list.ts",
    "../../../packages/app-logic/src/search/slots.ts",
    "../../../packages/app-logic/src/search/store-pass.ts",
    "../../mobile/src/state/store-views.ts",
  ]) {
    it(`${file.replace(/^(\.\.\/)+/, "")}: holds no page array of its own`, () => {
      expect(read(file).match(OWN_PAGING)?.[0] ?? null, "a surface paging the store itself").toBeNull();
    });
  }

  it("the paging census can see a surface that pages — its own positive control", () => {
    expect("engine.searchServer(q, { cursor: cur.nextCursor })").toMatch(OWN_PAGING);
    expect("items: [...prev.outcome.items, ...added]").toMatch(OWN_PAGING);
    expect("items: [...folders.entries()]", "a facet list is not a page array").not.toMatch(OWN_PAGING);
  });

  it("the census can see a window read — its own positive control", () => {
    expect("engine.storeWindow() !== null").toMatch(WINDOW_READS);
    expect("messages={history} windowed={windowedMirror}").toMatch(WINDOW_READS);
  });
});

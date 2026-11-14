/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { message, mountMailFrame, unmountAll, waitFor } from "./_registered-mail-frame.js";
import { expectHeard, indexOfKey, walk } from "./_windowed-list-hearing.js";

afterEach(unmountAll);

it("Search, 600 hits from the store", async () => {
  const total = 600;
  const hits = Array.from({ length: total }, (_, i) => message(`m${i}`, { subject: `AXA letter ${i}` }));
  const { el } = await mountMailFrame("#/search", [], {
    prepareEngine(engine) {
      engine.serverSearchAvailable = () => true;
      engine.searchServer = async (_query, opts) => ({
        state: "ready", items: opts?.parts === "summary" ? [] : hits, total,
        totalExact: true, totalEstimate: null, tier: "exact", nextCursor: null,
        bounded: false, ms: 5, indexed: null, facets: null,
      });
    },
  });
  fireEvent.change(within(el).getByRole("textbox", { name: "Search" }), { target: { value: "axa" } });
  await waitFor(() => within(el).queryAllByRole("listitem").some((item) => item.hasAttribute("aria-setsize")), "store result rows");
  const list = within(el).getByRole("list", { name: "Search" });
  const scroller = list.closest<HTMLElement>(".sr-scroll")!;
  expect(scroller).not.toBeNull();
  expectHeard(await walk(list.parentElement!, scroller, total), { Search: total }, (_, key) => indexOfKey(key) + 1);
});

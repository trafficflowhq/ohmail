/** @vitest-environment jsdom */
import { act, fireEvent, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { OhmailEngine } from "@ohmail/client-engine";
import { message, mountMailFrame, unmountAll, waitFor } from "./_registered-mail-frame.js";

afterEach(unmountAll);

async function pressArchiveHit(fetch: OhmailEngine["fetchMessage"]) {
  const hit = message("archive-1", { subject: "An archive result" });
  const other = message("other-9", { subject: "A different letter" });
  const fetchMessage = vi.fn(fetch);
  const { el, address } = await mountMailFrame("#/search", [other], {
    prepareEngine(engine) {
      const search = engine.search.bind(engine);
      engine.search = (query, options) => ({
        ...search(query, options), items: [{ message: hit, score: 10, matches: [] }],
        similar: [], tier: "exact", indexing: false,
      });
      engine.fetchMessage = fetchMessage;
    },
  });
  fireEvent.change(within(el).getByRole("textbox", { name: "Search" }), { target: { value: hit.subject } });
  await waitFor(() => within(el).queryByText(hit.subject!) !== null, "the archive hit");
  await act(async () => {
    fireEvent.click(within(el).getByText(hit.subject!));
  });
  await waitFor(() => fetchMessage.mock.calls.some(([id]) => id === hit.id), "individual store lookup");
  const open = () => within(el).queryByRole("region", { name: "Open message" });
  return { address, hit, open };
}

it("shows the row the opener carried in when the individual store lookup is unavailable", async () => {
  const { address, hit, open } = await pressArchiveHit(async () => ({ state: "unavailable" }));
  await waitFor(() => open()?.textContent?.includes(hit.subject!) ?? false, "the carried letter");

  await act(async () => {
    address.visit("#/search");
  });
  await waitFor(() => open() === null, "the reader closes");
  await act(async () => {
    address.visit("#/search/m/archive-1");
  });
  await waitFor(() => address.read() === "#/search", "a later address does not reuse the carried letter");
  expect(open()).toBeNull();
});

it("keeps the pressed Search hit when the individual lookup returns a different letter", async () => {
  const wrong = message("unexpected", { subject: "An unrelated archive letter" });
  const { address, hit, open } = await pressArchiveHit(async () => ({ state: "ready", message: wrong }));
  expect(open()?.textContent).toContain(hit.subject);
  expect(open()?.textContent).not.toContain(wrong.subject);
  expect(address.read()).toBe(`#/search/m/${hit.id}`);
});

it("closes the pressed Search hit when the individual lookup confirms it is missing", async () => {
  const { address, open } = await pressArchiveHit(async () => ({ state: "missing" }));
  expect(open()).toBeNull();
  expect(address.read()).toBe("#/search");
});

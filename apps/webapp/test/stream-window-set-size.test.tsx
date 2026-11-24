/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { waterlineIdOf } from "@ohmail/client-engine";
import { ESTIMATED_ROW_PX } from "@ohmail/app-logic/lists/list-window";
import { NOW, message, mountShell, storeWith, stubDom, unmountAll } from "./_draft-shell.js";

import { CONTAINERS, expectHeard, indexOfKey, scrollTo, walk } from "./_windowed-list-hearing.js";

const N = 600;

beforeEach(() => stubDom());
afterEach(unmountAll);

async function stream(view: "reads" | "receipts", split?: number) {
  const name = view === "reads" ? "News" : "Receipts";
  const letters = Array.from({ length: N }, (_, i) => message(`m${i}`, {
    folder: view === "reads" ? "ohmail/News" : "ohmail/Receipts",
    date: new Date(NOW.getTime() - (i + 1) * 60_000).toISOString(),
  }));
  const store = await storeWith(letters, []);
  if (split !== undefined) {
    await store.putLocal("view_meta", waterlineIdOf(view), {
      newestSeenId: letters[split]!.id,
      at: NOW.toISOString(),
    });
  }
  const { el } = await mountShell(`#/${view}`, letters, [], { store });
  const host = within(el).getByRole("region", { name });
  const scroller = host.querySelector<HTMLElement>(".pl-scroll")!;
  expect(scroller).not.toBeNull();
  return { host, scroller };
}

describe("a windowed list announces its true size and every row's true position", () => {
  it("News, 600 above no line", async () => {
    const { host, scroller } = await stream("reads");
    expectHeard(await walk(host, scroller, N), { News: N }, (_, k) => indexOfKey(k) + 1);
  }, 20_000);

  it("Receipts, 600 above no line", async () => {
    const { host, scroller } = await stream("receipts");
    expectHeard(await walk(host, scroller, N), { Receipts: N }, (_, k) => indexOfKey(k) + 1);
  }, 20_000);

  it("Receipts with the line: the rows on each side counted, the line not", async () => {
    const { host, scroller } = await stream("receipts", 40);
    expectHeard(await walk(host, scroller, N + 1), { Receipts: 40, "Seen up to here": N - 40 },
      (label, k) => (label === "Receipts" ? indexOfKey(k) + 1 : indexOfKey(k) - 40 + 1));
    await scrollTo(scroller, 38 * ESTIMATED_ROW_PX);
    const line = within(host).getByRole("heading", { name: /^Seen up to here/ });
    expect(line.closest(CONTAINERS)).toBeNull();
  }, 20_000);

  it("News announces each group at its own size when the reading line is visible", async () => {
    const { host, scroller } = await stream("reads", 100);
    expectHeard(await walk(host, scroller, N + 1), { News: 100, "Seen up to here": N - 100 },
      (label, k) => (label === "News" ? indexOfKey(k) + 1 : indexOfKey(k) - 100 + 1));
    await scrollTo(scroller, 98 * ESTIMATED_ROW_PX);
    expect(within(host).getByRole("heading", { name: /^Seen up to here/ }).closest(CONTAINERS)).toBeNull();
  }, 20_000);
});

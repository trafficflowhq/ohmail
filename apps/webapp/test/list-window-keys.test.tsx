/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ESTIMATED_ROW_PX, MEASURED_FULL_RANGE_MAX_ROWS } from "@ohmail/app-logic/lists/list-window";
import { Frame } from "@ohmail/app/frame";
import { TextProvider } from "@ohmail/app/text";
import { FOLDERS_ON, LIST_WORDS, listFrame } from "../../../packages/app/test/places/list-seat.js";
import { letter } from "../../../packages/app/test/reader/support/mail.js";
import trashWords from "../../../packages/app/messages/trash.en.json";

afterEach(cleanup);

const COUNT = 120;
const folder = "Projects" as ReturnType<typeof letter>["folder"];
const rows = Array.from({ length: COUNT }, (_, i) => letter(`m${i}`, {
  subject: `Subject ${i}`,
  date: new Date(Date.UTC(2026, 7, 1, 9, -i)).toISOString(),
  folder,
  unread: false,
}));

async function walkPastTheSlice(place: "folder" | "trash") {
  const inFolder = place === "folder";
  const { host } = listFrame({
    letters: inFolder ? rows : [],
    first: inFolder ? "#/folder/fd1" : "#/trash",
    consent: FOLDERS_ON,
    more: { "folder:fd1": { id: "fd1", name: folder, mailboxId: rows[0]!.mailboxId } },
    engine: () => ({
      fetchMessage: async () => ({ state: "failed", errorClass: "network" }),
      trashAvailable: () => true,
      listTrash: async () => ({ state: "ready", items: rows, nextCursor: null }),
    }),
  });
  render(
    <TextProvider locale="en" messages={{ ...LIST_WORDS, ...trashWords }} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  const first = { name: /Subject 0$/ };
  const next = { name: /Subject 1$/ };
  fireEvent.click(await screen.findByRole("option", first));
  const row = await screen.findByRole("option", { ...first, selected: true });
  expect(row.dataset.id).toBe("m0");
  const scroller = row.closest<HTMLElement>('[tabindex="-1"]')!;
  act(() => { scroller.focus(); });
  scroller.scrollTop = 90 * ESTIMATED_ROW_PX;
  fireEvent.scroll(scroller);
  await waitFor(() => expect(screen.queryByRole("option", next), "the window did not move off the selection").toBeNull());
  fireEvent.keyDown(scroller, { key: "ArrowDown" });
  const moved = await screen.findByRole("option", { ...next, selected: true });
  expect(moved.dataset.id).toBe("m1");
}

describe("↓ reaches the next row through its slot", () => {
  it(`in a folder of ${COUNT} rows — past the measured floor, a window`, async () => {
    expect(COUNT).toBeGreaterThan(MEASURED_FULL_RANGE_MAX_ROWS);
    await walkPastTheSlice("folder");
  });

  it(`in a Trash of ${COUNT} rows`, async () => {
    await walkPastTheSlice("trash");
  });
});

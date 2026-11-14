/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { FOLDERS_ON, LIST_WORDS, listFrame, listSeat } from "../places/list-seat.js";
import { ESTIMATED_ROW_PX } from "@ohmail/app-logic/lists/list-window";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import trashEn from "../../messages/trash.en.json" with { type: "json" };
import { letter } from "../reader/support/mail.js";

afterEach(cleanup);

const path = "Projects" as ReturnType<typeof letter>["folder"];
const mail = Array.from({ length: 120 }, (_, i) =>
  letter(`letter-${i}`, {
    subject: `Project note ${i}`,
    date: new Date(Date.UTC(2026, 10, 20, 8, -i)).toISOString(),
    folder: path,
    unread: false,
  }),
);
const selected = { name: /Project note 119$/, selected: true } as const;

it("renders a window over a large folder and reveals a linked letter when it arrives", async () => {
  const { mail: mirror } = listSeat({
    engine: () => ({ fetchMessage: async () => ({ state: "failed", errorClass: "network" }) }),
    letters: mail.slice(0, -1),
    first: "#/folder/projects/m/letter-119",
    consent: FOLDERS_ON,
    more: { "folder:projects": { id: "projects", name: path, mailboxId: mail[0]!.mailboxId } },
  });
  const list = await screen.findByRole("listbox", { name: "Earlier" });
  expect(within(list).getAllByRole("option").length).toBeLessThan(119);
  expect(within(list).queryByRole("option", selected)).toBeNull();
  act(() => mirror.add(mail.at(-1)!));
  await waitFor(() => expect(screen.getByRole("option", selected)).toBeTruthy());
  expect(screen.getAllByRole("option").length).toBeLessThan(120);
});

it.each(["folder", "trash"] as const)("ArrowDown reaches the next row off the %s window", async (place) => {
  const inFolder = place === "folder";
  const { host } = listFrame({
    letters: inFolder ? mail : [],
    first: inFolder ? "#/folder/projects/m/letter-0" : "#/trash/m/letter-0",
    consent: FOLDERS_ON,
    more: { "folder:projects": { id: "projects", name: path, mailboxId: mail[0]!.mailboxId } },
    engine: () => ({
      fetchMessage: async () => ({ state: "failed", errorClass: "network" }),
      trashAvailable: () => true,
      listTrash: async () => ({ state: "ready", items: mail, nextCursor: null }),
    }),
  });
  render(
    <TextProvider locale="en" messages={{ ...LIST_WORDS, ...trashEn }} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );

  const row = await screen.findByRole("option", { name: /Project note 0$/, selected: true });
  const next = { name: /Project note 1$/ };
  const scroller = row.parentElement!.closest<HTMLElement>('[tabindex="-1"]')!;
  act(() => {
    scroller.focus();
  });
  scroller.scrollTop = 90 * ESTIMATED_ROW_PX;
  fireEvent.scroll(scroller);
  await waitFor(() => expect(screen.queryByRole("option", next)).toBeNull());
  fireEvent.keyDown(scroller, { key: "ArrowDown" });
  expect(await screen.findByRole("option", { ...next, selected: true })).toBeTruthy();
});

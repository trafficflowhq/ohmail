/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { keySheetOver, sheetColumns } from "../../src/keys/sheet/index.js";
import { TextProvider } from "../../src/text/index.js";
import searchEn from "../../messages/search.en.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };
import { LIST_WORDS, listFrame } from "../places/list-seat.js";

afterEach(cleanup);

it("the key sheet says why Delete is disabled in Trash", async () => {
  const { host } = listFrame({
    first: "#/trash",
    letters: [],
    engine: () => ({
      trashAvailable: () => true,
      listTrash: async () => ({ state: "ready", items: [], nextCursor: null }),
    }),
  });
  render(
    <TextProvider locale="en" messages={{ ...LIST_WORDS, ...searchEn, ...trashEn }} timeZone="Europe/Zurich">
      <Frame
        host={{
          ...host,
          features: { ...host.features, overs: { ...host.features.overs, keys: keySheetOver } },
        }}
      />
    </TextProvider>,
  );
  fireEvent.keyDown(document.body, { key: "?" });
  const sheet = await screen.findByRole("dialog", { name: /Keyboard shortcuts/ });
  const row = within(sheet).getByTitle(trashEn.trash.noErase);
  expect(within(row).getByText(searchEn.shortcuts.deleteKey)).toBeTruthy();
  expect(row.getAttribute("aria-disabled")).toBe("true");
});

it("a live chord on the same row keeps that row free of disabled reasons", () => {
  const columns = sheetColumns(
    [
      { chord: "Backspace", group: "message", label: "Delete", disabled: true, disabledReason: "no_erase" },
      { chord: "Delete", group: "message", label: "Delete" },
    ],
    "Ctrl",
    (key) => key,
    trashEn.trash.noErase,
  );
  expect(columns[0]?.[0]?.rows).toEqual([{ label: "Delete", keys: [["⌫"], ["⌦"]] }]);
});

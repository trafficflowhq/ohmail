/** @vitest-environment jsdom */
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { Frame } from "../../src/frame/Frame.js";
import { TextProvider } from "../../src/text/index.js";
import trashDe from "../../messages/trash.de.json" with { type: "json" };
import trashEn from "../../messages/trash.en.json" with { type: "json" };
import { LIST_WORDS, listFrame } from "../places/list-seat.js";

afterEach(cleanup);

it.each([
  ["en", trashEn],
  ["de", trashDe],
] as const)("explains what can be restored from the settled empty Trash in %s", async (locale, messages) => {
  const { host } = listFrame({
    first: "#/trash",
    letters: [],
    engine: () => ({
      trashAvailable: () => true,
      listTrash: async () => ({ state: "ready", items: [], nextCursor: null }),
    }),
  });
  render(
    <TextProvider locale={locale} messages={{ ...LIST_WORDS, ...messages }} timeZone="Europe/Zurich">
      <Frame host={host} />
    </TextProvider>,
  );
  expect(await screen.findByText(messages.trash.empty)).toBeTruthy();
});

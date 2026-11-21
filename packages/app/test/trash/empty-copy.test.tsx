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
  ["en", trashEn, "What you delete in ohmail lands here and can be put back."],
  ["de", trashDe, "Was du in ohmail löschst, landet hier und lässt sich zurücklegen."],
] as const)("shows the concise empty Trash in %s", async (locale, messages, oldCopy) => {
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
  await screen.findByText(
    (_, node) =>
      node?.classList.contains("oh-empty-label") === true && node.textContent === messages.trash.emptyTitle,
  );
  expect(screen.queryByText(oldCopy)).toBeNull();
  expect(screen.queryByText(messages.trash.foot)).toBeNull();
  expect(screen.getAllByRole("paragraph").map((paragraph) => paragraph.textContent)).toContain(
    messages.trash.emptyTitle,
  );
});

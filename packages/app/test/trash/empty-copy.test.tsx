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
  [
    "en",
    trashEn,
    "What you delete in ohmail lands here and can be put back.",
    "Mail you deleted in ohmail — the only deleted mail ohmail can put back. Mail trashed in other apps stays in your mail server's Trash, and your mail server decides how long Trash keeps it.",
  ],
  [
    "de",
    trashDe,
    "Was du in ohmail löschst, landet hier und lässt sich zurücklegen.",
    "Mails, die du in ohmail gelöscht hast — die einzigen gelöschten Mails, die ohmail zurücklegen kann. In anderen Apps gelöschte Mails bleiben im Papierkorb deines Mailservers — und dein Mailserver entscheidet, wie lange er sie behält.",
  ],
] as const)("shows the concise empty Trash in %s", async (locale, messages, oldCopy, formerFooter) => {
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
  expect(screen.queryByText(formerFooter)).toBeNull();
  expect(screen.getAllByRole("paragraph").map((paragraph) => paragraph.textContent)).toContain(
    messages.trash.emptyTitle,
  );
});

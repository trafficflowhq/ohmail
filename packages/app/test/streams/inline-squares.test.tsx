/** @vitest-environment jsdom */
import type { EngineMessage } from "@ohmail/wire";
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { issue, mountStreamFrame, receipt } from "./registered-world.js";

afterEach(cleanup);

it.each([
  ["reads", "News", issue],
  ["receipts", "Receipts", receipt],
] as const)(
  "%s shows the conversation's shared squares when replying in place",
  async (route, name, make) => {
    const first = make("first", 13, { threadId: "thread", unread: false });
    const sent = make("sent", 12, {
      threadId: "thread",
      local: true,
      folder: "Sent" as EngineMessage["folder"],
      unread: false,
    });
    const next = make("next", 11);
    mountStreamFrame({ at: `#/${route}`, letters: [first, sent, next], withReply: true });
    const region = screen.getByRole("region", { name: `${name} stream` });
    region.querySelector<HTMLElement>(".oh-sheet-scroll")!.scrollTo = () => {};
    fireEvent.click(within(region).getByRole("heading", { name: first.subject }));
    expect(within(region).getAllByRole("group", { name: "2 messages, all read" })).toHaveLength(1);
    fireEvent.click(
      within(screen.getByRole("toolbar", { name: "Actions" })).getByRole("button", { name: "Reply" }),
    );
    expect(await within(region).findByRole("textbox", { name: "Reply body" })).toBeTruthy();
    expect(within(region).getAllByRole("group", { name: "2 messages, all read" })).toHaveLength(1);
    expect(within(region).getByRole("heading", { name: next.subject })).toBeTruthy();
  },
);

/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import type { EngineMessage } from "@ohmail/wire";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubStreamDom } from "./stream-check-frame.js";

const one = issue("one", 20, { threadId: "thread-one" });
const two = issue("two", 19);
const read = () => screen.getByRole("region", { name: "News stream" });
const card = (day: number) => read().querySelector<HTMLElement>(
  `[data-stream-item="${day === 20 ? "one" : "two"}"]`,
)!;
const panel = () => within(read()).queryByRole("toolbar", { name: "Actions" });

beforeAll(async () => {
  const { prepareWriting } = await import("@ohmail/app/mail");
  await prepareWriting();
});

beforeEach(stubStreamDom);
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seat(letters: EngineMessage[] = [one, two]) {
  return mountStreamFrame({ at: "#/reads", withReply: true, letters });
}


async function openReply() {
  const list = within(screen.getByRole("region", { name: "News" }));
  await act(async () => { fireEvent.click(list.getByRole("option", { name: /Issue 20/ })); });
  await act(async () => { fireEvent.click(within(panel()!).getByRole("button", { name: "Reply" })); });
  return within(card(20).parentElement!).getByRole("textbox", { name: "Reply body" });
}

it("Later while answering files only the letter being answered", async () => {
  const { mail } = seat();
  await openReply();
  await act(async () => { fireEvent.click(within(panel()!).getByRole("button", { name: "Later" })); });
  expect(mail.mutations.filter((m) => m.kind === "triage_set")).toEqual([
    expect.objectContaining({ kind: "triage_set", messageId: "one", state: "reply_later" }),
  ]);
});

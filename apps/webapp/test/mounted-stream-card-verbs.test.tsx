/** @vitest-environment jsdom */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Frame } from "@ohmail/app/frame";
import { readerEntry } from "../../../packages/app/src/reader/index.js";
import type { ReaderEntry } from "../../../packages/app/src/host/index.js";
import { MailGround, mailPlaces } from "@ohmail/app/mail";
import { TextProvider, type Messages } from "@ohmail/app/text";
import type { EngineMessage } from "@ohmail/wire";
import newsEn from "../../../packages/app/messages/news.en.json";
import { fakeHost } from "../../../packages/app/test/support/fake-host.js";
import { fakeAddress, fakeWindow } from "../../../packages/app/test/support/fake-window.js";
import { bodyDouble, fakeMail, WORDS } from "../../../packages/app/test/reader/support/mail.js";
import { issue, mountStreamFrame } from "../../../packages/app/test/streams/registered-world.js";
import { stubDom } from "./_draft-shell.js";

const one = issue("one", 20, { threadId: "thread-one" });
const two = issue("two", 19);
const older = issue("sent-earlier", 18, { threadId: one.threadId, folder: "Sent" as EngineMessage["folder"], local: true });
const read = () => screen.getByRole("region", { name: "News stream" });
const card = (day: number) => read().querySelector<HTMLElement>(
  `[data-stream-item="${day === 20 ? "one" : "two"}"]`,
)!;
const panel = () => within(read()).queryByRole("toolbar", { name: "Actions" });

beforeEach(() => stubDom());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function seat(letters: EngineMessage[] = [one, two]) {
  return mountStreamFrame({ at: "#/reads", withReply: true, letters });
}

function mountWithReader(reader?: ReaderEntry) {
  const { engine } = fakeMail([one, two]);
  const { host } = fakeHost({
    engine, service: "self", scope: "acct-1", places: mailPlaces(), above: MailGround,
    address: fakeAddress("#/reads"), window: fakeWindow("desktop"),
    ...(reader ? { reader } : {}),
  });
  const tree = () => (
    <TextProvider locale="en" messages={{ ...WORDS.en, ...newsEn } as Messages} timeZone="UTC">
      <Frame host={host} />
    </TextProvider>
  );
  const page = render(tree());
  return () => act(async () => { page.rerender(tree()); });
}

async function clickLetter() {
  await act(async () => { fireEvent.click(within(card(20)).getByRole("heading", { name: "Issue 20" })); });
}

async function openReply() {
  const list = within(screen.getByRole("region", { name: "News" }));
  await act(async () => { fireEvent.click(list.getByRole("option", { name: /Issue 20/ })); });
  await act(async () => { fireEvent.click(within(panel()!).getByRole("button", { name: "Reply" })); });
  return within(card(20).parentElement!).getByRole("textbox", { name: "Reply body" });
}

describe("the mounted stream's verbs", () => {
  it("reading by scroll alone leaves the action panel closed", async () => {
    seat();
    const scroll = read().querySelector<HTMLElement>("[data-reading-scroll]")!;
    Object.defineProperty(scroll, "clientHeight", { value: 300 });
    Object.defineProperty(scroll, "scrollHeight", { value: 900 });
    scroll.getBoundingClientRect = () => ({ top: 0, bottom: 300, height: 300 } as DOMRect);
    for (const [day, top] of [[20, 0], [19, 400]] as const) {
      card(day).getBoundingClientRect = () => ({
        top: top - scroll.scrollTop, bottom: top + 400 - scroll.scrollTop, height: 400,
      } as DOMRect);
    }
    expect(panel()).toBeNull();
    await act(async () => {
      fireEvent.wheel(scroll, { deltaY: 400 });
      scroll.scrollTop = 400;
      fireEvent.scroll(scroll);
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    expect(card(19).hasAttribute("data-open")).toBe(true);
    expect(panel()).toBeNull();
  });

  it("the clicked letter opens and gets the stream's only action panel", async () => {
    const { address } = seat();
    await clickLetter();
    expect(address.read()).toBe("#/reads/m/one");
    expect(within(card(20)).getByRole("button", { name: "Collapse" })).toBeTruthy();
    expect(within(card(19)).getByRole("button", { name: "Expand" })).toBeTruthy();
    const bars = within(read()).getAllByRole("toolbar", { name: "Actions" });
    expect(bars).toHaveLength(1);
    expect(within(bars[0]!).getByRole("button", { name: "Reply" })).toBeTruthy();
    expect(within(bars[0]!).getByRole("button", { name: "Later" })).toBeTruthy();
  });

  it("a host without a reader offers no actions even on an open card", async () => {
    mountWithReader();
    await clickLetter();
    expect(within(card(20)).getByRole("button", { name: "Collapse" })).toBeTruthy();
    expect(panel()).toBeNull();
  });

  it("a subject or body click opens the letter without a sender sheet", async () => {
    const { address } = seat();
    await clickLetter();
    expect(address.read()).toBe("#/reads/m/one");
    expect(screen.queryByRole("dialog")).toBeNull();
    await act(async () => { fireEvent.click(within(card(19)).getByText(String(two.body))); });
    expect(address.read()).toBe("#/reads/m/two");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("answering in the mounted stream", () => {
  it("the card stays in place through a handed-off reply and returns on failure", async () => {
    const answer: { target: string | null; phase: "idle" | "sending" | "failed" } = { target: null, phase: "idle" };
    const redraw = mountWithReader(readerEntry({
      body: bodyDouble().body, files: "none", pictures: "none", look: "none", sentCopy: "none",
      invitation: "none",
      reply: {
        Sheet: () => <textarea aria-label="Reply body" />,
        useOpen: () => () => {},
        useTarget: () => answer.target,
        useSendPhase: () => () => answer.phase,
        useVerbs: () => null,
      },
    }));
    const original = card(20);
    expect(within(original).getByRole("button", { name: "Expand" })).toBeTruthy();
    answer.target = "one";
    await redraw();
    expect(within(original.parentElement!).getByRole("textbox", { name: "Reply body" })).toBeTruthy();
    answer.target = null;
    answer.phase = "sending";
    await redraw();
    expect(card(20)).toBe(original);
    expect(within(original.parentElement!).queryByRole("textbox", { name: "Reply body" })).toBeNull();
    expect(within(original).queryByRole("button", { name: "Expand" })).toBeNull();
    answer.phase = "failed";
    await redraw();
    expect(card(20)).toBe(original);
    expect(within(original).getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("Reply opens within the same letter's card and leaves its neighbor alone", async () => {
    seat();
    const original = card(20);
    expect(within(read()).queryByRole("textbox", { name: "Reply body" })).toBeNull();
    const editor = await openReply();
    expect(card(20)).toBe(original);
    expect(within(original).getAllByRole("article")).toHaveLength(1);
    expect(original.parentElement!.contains(editor)).toBe(true);
    expect(within(original.parentElement!).queryByRole("button", { name: /Tag/ })).toBeNull();
    expect(within(card(19)).getByRole("button", { name: "Expand" })).toBeTruthy();
  });

  it("Escape restores the preview if nothing was sent in this visit", async () => {
    for (const letters of [[one, two], [one, two, older]]) {
      seat(letters);
      const original = card(20);
      const editor = await openReply();
      expect(within(original).getAllByRole("article")).toHaveLength(letters.includes(older) ? 2 : 1);
      await act(async () => { fireEvent.keyDown(editor, { key: "Escape" }); });
      expect(card(20)).toBe(original);
      expect(within(read()).queryByRole("textbox", { name: "Reply body" })).toBeNull();
      expect(within(original).getByRole("button", { name: "Expand" })).toBeTruthy();
      expect(within(original).getAllByRole("article")).toHaveLength(1);
      cleanup();
    }
  });

  it("Later while answering files only the letter being answered", async () => {
    const { mail } = seat();
    await openReply();
    await act(async () => { fireEvent.click(within(panel()!).getByRole("button", { name: "Later" })); });
    expect(mail.mutations.filter((m) => m.kind === "triage_set")).toEqual([
      expect.objectContaining({ kind: "triage_set", messageId: "one", state: "reply_later" }),
    ]);
  });
});

/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { DRAFT_REPLY_COST_CREDITS } from "@ohmail/app-logic/writing/draft-reply";
import { Copy } from "../src/copy";
import type { PhoneDrafterProps } from "../src/ui/PhoneDrafter";
import { mount, rnDom } from "./_rendered-dom";

const device = vi.hoisted(() => {
  const session = (ownerKey = "mailbox", standalone = false) => ({
    ownerKey, standalone,
    profile: { origin: "https://draft.test", flavor: "managed" },
    fetch: vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ draftId: "proposal" }, { status: 202 })
      : Response.json({ body: "Drafted words" })),
  });
  return { session, current: session() };
});
vi.mock("react-native", () => rnDom);
vi.mock("../src/state/world", () => ({ useLiveSession: () => device.current }));
vi.mock("../src/theme", () => ({ useTheme: () => ({ c: {}, radius: { pill: 18 } }) }));
vi.mock("../src/ui/base", () => ({
  Button: ({ label, disabled, onPress }: { label: string; disabled?: boolean; onPress: () => void }) =>
    <button disabled={disabled} onClick={onPress}>{label}</button>,
  Txt: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}));

const { PhoneDrafter } = await import("../src/ui/PhoneDrafter.native");
const onChange = vi.fn();
const tree = (changes: Partial<PhoneDrafterProps> = {}) => {
  const props = {
    body: "", subject: "Re: A letter", mailboxId: null, messageId: "current", allowed: true,
    offerDraftReply: true as const,
    blocked: false, onChange, ...changes,
  };
  return <PhoneDrafter {...props}>{(switcher, tool, notice, _draftSelected, fullTool) =>
    <>{switcher}{tool}{fullTool}{notice}</>
  }</PhoneDrafter>;
};

const button = (view: ReturnType<typeof mount>, text: string) =>
  [...view.el.querySelectorAll("button")].find((element) => element.textContent === text);

const pricedReply = `${Copy.draftAiReply} · ${DRAFT_REPLY_COST_CREDITS} credits`;

afterEach(() => {
  device.current = device.session();
  onChange.mockClear();
});

it("uses the compact priced web offer without an ordinary sharing paragraph", () => {
  const view = mount(tree());
  try {
    expect(view.el.textContent).not.toContain("configured AI provider");
    expect(view.el.textContent).not.toContain(Copy.draftAiOffer);
    expect(button(view, pricedReply)).toBeDefined();
    expect(device.current.fetch).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("starts exactly one reply draft after the explicit priced press", async () => {
  const view = mount(tree());
  try {
    expect(device.current.fetch).not.toHaveBeenCalled();

    await act(async () => {
      button(view, pricedReply)!.click();
      button(view, pricedReply)!.click();
    });
    expect(device.current.fetch.mock.calls.map(([url]) => new URL(url).pathname))
      .toEqual(["/messages/current/draft", "/drafts/proposal"]);
    expect(device.current.fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST", headers: { "Idempotency-Key": expect.any(String) },
    });
    expect(device.current.fetch.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Drafted words");
  } finally {
    view.unmount();
  }
});

it("can cancel the offer and still use Draft from text", async () => {
  const view = mount(tree({ body: "My own notes" }));
  try {
    act(() => { button(view, Copy.moveCancel)!.click(); });
    expect(button(view, pricedReply)).toBeUndefined();
    expect(device.current.fetch).not.toHaveBeenCalled();
    act(() => { button(view, Copy.draftAiFromText)!.click(); });
    await act(async () => { button(view, Copy.draftAiConfirm)!.click(); });
    expect(new URL(device.current.fetch.mock.calls[0]![0]).pathname).toBe("/drafts/from-text");
    expect(JSON.parse(String(device.current.fetch.mock.calls[0]![1]?.body))).toEqual({
      text: "My own notes", inReplyToMessageId: "current",
    });
  } finally {
    view.unmount();
  }
});

it("discloses full conversation sharing separately and waits for that explicit purchase", async () => {
  const view = mount(tree({ body: "My own notes" }));
  try {
    act(() => { button(view, Copy.draftAiFullTitle)!.click(); });
    expect(view.el.textContent).toContain(Copy.draftAiFullDisclosure);
    expect(device.current.fetch).not.toHaveBeenCalled();
    await act(async () => { button(view, Copy.draftAiFullConfirm)!.click(); });
    expect(new URL(device.current.fetch.mock.calls[0]![0]).pathname).toBe("/drafts/from-text");
    expect(JSON.parse(String(device.current.fetch.mock.calls[0]![1]?.body))).toEqual({
      text: "My own notes", inReplyToMessageId: "current", fullConversation: true,
    });
  } finally {
    view.unmount();
  }
});

it("keeps typed words in the editor while making an explicitly requested draft available", async () => {
  const view = mount(tree({ body: "Keep this reply" }));
  try {
    await act(async () => { button(view, pricedReply)!.click(); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { button(view, Copy.draftAiGenerated)!.click(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Drafted words");
  } finally {
    view.unmount();
  }
});

it("abandons an offer on account change and ignores a completed reply from the old session", async () => {
  const old = device.current;
  let finish!: (answer: Response) => void;
  old.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = mount(tree());
  try {
    act(() => { button(view, pricedReply)!.click(); });
    device.current = device.session("new-mailbox");
    view.render(tree());
    expect(button(view, pricedReply)).toBeUndefined();
    await act(async () => { finish(Response.json({ draftId: "proposal" }, { status: 202 })); });
    expect(device.current.fetch).not.toHaveBeenCalled();
    expect(button(view, Copy.draftAiGenerated)).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("keeps the letters typed while the suggestion is still in flight", async () => {
  let finish!: (answer: Response) => void;
  device.current.fetch.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
  const view = mount(tree());
  try {
    act(() => { button(view, pricedReply)!.click(); });
    view.render(tree({ body: "Typed while waiting" }));
    await act(async () => { finish(Response.json({ draftId: "proposal" }, { status: 202 })); });
    expect(onChange).not.toHaveBeenCalled();
    act(() => { button(view, Copy.draftAiGenerated)!.click(); });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("Drafted words");
  } finally {
    view.unmount();
  }
});

it("keeps the admitted request's protection when another action is tapped before render", async () => {
  device.current.profile.flavor = "self";
  const view = mount(tree({ body: "Keep my own words" }));
  try {
    await act(async () => {
      button(view, Copy.draftAiReply)!.click();
      button(view, Copy.draftAiFromText)!.click();
    });
    expect(device.current.fetch.mock.calls.map(([url]) => new URL(url).pathname))
      .toEqual(["/messages/current/draft", "/drafts/proposal"]);
    expect(onChange).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("restores the authored formatting when switching back from the suggestion", async () => {
  const bodyRuns: NonNullable<PhoneDrafterProps["bodyRuns"]> = [
    { text: "Formatted", marks: ["strong"] }, { text: " reply", marks: [] },
  ];
  const view = mount(tree({ body: "Formatted reply", bodyRuns }));
  try {
    await act(async () => { button(view, pricedReply)!.click(); });
    act(() => { button(view, Copy.draftAiGenerated)!.click(); });
    view.render(tree({ body: "Drafted words" }));
    act(() => { button(view, Copy.draftAiYourText)!.click(); });
    expect(onChange).toHaveBeenLastCalledWith("Formatted reply", bodyRuns);
  } finally {
    view.unmount();
  }
});

it.each([{ allowed: false, standalone: false }, { allowed: true, standalone: true }])(
  "draws no context offer for unavailable drafting",
  ({ allowed, standalone }) => {
    device.current = device.session("phone", standalone);
    const view = mount(tree({ allowed }));
    try {
      expect(button(view, pricedReply)).toBeUndefined();
      expect(device.current.fetch).not.toHaveBeenCalled();
    } finally {
      view.unmount();
    }
  },
);

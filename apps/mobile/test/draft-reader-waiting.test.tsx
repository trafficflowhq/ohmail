/** @vitest-environment jsdom */
/**
 * A SEND WAITING TO GO, OPENED FROM DRAFTS: the card says it waits, offers Cancel send and no Edit,
 * asks before a Discard that cancels it, and says a Cancel that came too late or went unanswered in
 * the row. Rendered through React DOM with the world and the screen primitives stood in.
 */
import { act, createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorldDraft } from "../src/state/live";

vi.mock("react-native", async () => ({
  ...(await import("./_rendered-dom")).rnDom,
  AccessibilityInfo: { announceForAccessibility: () => undefined },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
}));
vi.mock("../src/ui/base", () => {
  const box = (p: { children?: ReactNode }) => createElement("div", null, p.children);
  return {
    Screen: box, Scroller: box, Panel: box, Rule: () => null,
    Txt: (p: { children?: ReactNode }) => createElement("span", { "data-txt": "" }, p.children),
    Button: (p: { label: string; disabled?: boolean; onPress: () => void }) =>
      createElement("div", { "data-button": p.label, onClick: p.disabled ? undefined : p.onPress }),
  };
});
vi.mock("../src/ui/chrome", () => ({ DetailBar: () => null }));
vi.mock("../src/ui/BodyPages", () => ({ BodyPages: (p: { text: string }) => createElement("span", null, p.text) }));
vi.mock("expo-router", () => ({ router: { push: () => undefined } }));
vi.mock("../src/net/network-door", () => ({ useNetworkNow: () => "offline" }));

const said: string[] = [];
const world = {
  drafts: [] as WorldDraft[],
  standalone: true,
  sendSettlement: () => ({ accepted: false, rearmed: false, draftId: null, failure: null }),
  sendOutcome: () => "pending",
  actions: {
    cancelWaitingSend: vi.fn(async (_key: string) => ({ said: "withdrawn", kept: null as string | null })),
    draftDiscard: vi.fn(async (_id: string) => "discarded" as string),
  },
};
vi.mock("../src/state/world", () => ({
  useWorld: () => world,
  useWorldToast: () => ({ say: (r: { say: string }) => said.push(r.say) }),
}));

const { mount } = await import("./_rendered-dom");
const { DraftReader } = await import("../src/ui/DraftReader");
const { Copy } = await import("../src/copy");

const waitingRow = (rowless = false): WorldDraft => ({
  id: rowless ? "q-1" : "d-1", subject: "Offline", to: "Bo", preview: "Written on a train.", when: "09:00",
  state: "waiting", heldSays: null, bodyKnown: true, body: "Written on a train.", repliesHere: false,
  inReplyToMessageId: null, failure: null, edit: null, waiting: { key: "k-1", wire: false, rowless },
});

const settle = async () => { for (let i = 0; i < 10; i++) await act(async () => { await Promise.resolve(); }); };
const texts = (el: HTMLElement) => [...el.querySelectorAll("[data-txt]")].map((n) => n.textContent);
const press = async (el: HTMLElement, label: string) => {
  const b = el.querySelector<HTMLElement>(`[data-button="${label}"]`);
  if (b === null) throw new Error(`no ${label} button`);
  act(() => b.click());
  await settle();
};

afterEach(() => { said.length = 0; vi.clearAllMocks(); });

describe("DraftReader over a waiting send", () => {
  it("says it waits for the network, offers Cancel send, and no Edit", () => {
    world.drafts = [waitingRow()];
    const { el, unmount } = mount(createElement(DraftReader, { id: "d-1" }));
    expect(texts(el)).toEqual(expect.arrayContaining([Copy.draftsWaiting, Copy.replyQueuedOffline]));
    expect(el.querySelector(`[data-button="${Copy.cancelSend}"]`), "no Cancel send on a waiting send").not.toBeNull();
    expect(el.querySelector(`[data-button="${Copy.draftsEdit}"]`), "a waiting send offered Edit").toBeNull();
    expect(texts(el), "a waiting send was called a draft this phone cannot edit").not.toContain(Copy.draftsEditNote);
    unmount();
  });

  it("Discard asks about the send it cancels", async () => {
    world.drafts = [waitingRow()];
    const { el, unmount } = mount(createElement(DraftReader, { id: "d-1" }));
    await press(el, Copy.draftsDiscard);
    expect(texts(el)).toContain(Copy.draftsDiscardWaitingWhat);
    unmount();
  });

  it("Cancel send withdraws it and says the message is in Drafts; a send with no row closes the card", async () => {
    world.drafts = [waitingRow(true)];
    const onClose = vi.fn();
    const { el, unmount } = mount(createElement(DraftReader, { id: "q-1", onClose }));
    world.actions.cancelWaitingSend.mockResolvedValueOnce({ said: "withdrawn", kept: "kept" });
    await press(el, Copy.cancelSend);
    expect(world.actions.cancelWaitingSend).toHaveBeenCalledWith("k-1");
    expect(said).toEqual(["sendCancelledInDrafts"]);
    expect(onClose, "the card stayed over a row that is gone").toHaveBeenCalledTimes(1);
    unmount();
  });

  it("a Cancel too late, or a Discard nobody answered, is said in the row", async () => {
    world.drafts = [waitingRow()];
    const onClose = vi.fn();
    const { el, unmount } = mount(createElement(DraftReader, { id: "d-1", onClose }));
    world.actions.cancelWaitingSend.mockResolvedValueOnce({ said: "on_the_wire", kept: null });
    await press(el, Copy.cancelSend);
    expect(texts(el)).toContain(Copy.replyAlreadySent);
    world.actions.draftDiscard.mockResolvedValueOnce("cancelUnknown");
    await press(el, Copy.draftsDiscard);
    await press(el, Copy.draftsDiscardConfirm);
    expect(texts(el)).toContain(Copy.replyCancelUnreachable);
    expect([said, onClose.mock.calls.length], "a refusal was toasted or closed the card").toEqual([[], 0]);
    unmount();
  });

  it("a send with no row whose Cancel went unanswered closes the card and says so, with the words kept or not", async () => {
    for (const [kept, say] of [["kept", "replyCancelUnreachableKept"], ["notKept", null]] as const) {
      world.drafts = [waitingRow(true)];
      const onClose = vi.fn();
      const { el, unmount } = mount(createElement(DraftReader, { id: "q-1", onClose }));
      world.actions.cancelWaitingSend.mockResolvedValueOnce({ said: "unknown", kept });
      await press(el, Copy.cancelSend);
      // A refused keep is said by the action itself; the card adds nothing.
      expect([said.splice(0), onClose.mock.calls.length]).toEqual([say === null ? [] : [say], 1]);
      unmount();
    }
  });

  it("a withdrawn send whose words were not kept never says they are in Drafts", async () => {
    world.drafts = [waitingRow(true)];
    const onClose = vi.fn();
    const { el, unmount } = mount(createElement(DraftReader, { id: "q-1", onClose }));
    world.actions.cancelWaitingSend.mockResolvedValueOnce({ said: "withdrawn", kept: "notKept" });
    await press(el, Copy.cancelSend);
    expect([said, onClose.mock.calls.length]).toEqual([[], 1]);
    unmount();
  });

  it("a Discard nobody answered over a send with no row closes the card and says the Cancel is owed", async () => {
    world.drafts = [waitingRow(true)];
    const onClose = vi.fn();
    const { el, unmount } = mount(createElement(DraftReader, { id: "q-1", onClose }));
    world.actions.draftDiscard.mockResolvedValueOnce("cancelUnknown");
    await press(el, Copy.draftsDiscard);
    await press(el, Copy.draftsDiscardConfirm);
    expect([said, onClose.mock.calls.length]).toEqual([["replyCancelUnreachable"], 1]);
    unmount();
  });
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { sendPendingInDurableOutbox } from "../app/shell/mail-send";
import {
  act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";
import {
  composeLine, composeSend, composeSubject, composerOn, footLine, holdTheWire, letter, navigate, rounds,
  sends, toasts,
} from "./_handoff-steps.js";

/**
 * A HANDED-OFF SEND'S ENDING IS SAID ABOUT ITS OWN MESSAGE, NEVER OVER ANOTHER (PR #198 review,
 * MEDIUM). There is one compose lane, and the hand-off leaves the composer at the press, so the next
 * message can be open in it while the first is still out. The composer used to show the first send's
 * state over the second message ("Sending your message.", "Not sent…", "We're not sure this was
 * sent", "Sent") with Send locked, the foot line yielded to it, and the first send's ending was said
 * nowhere. Now the foot line says it, about that message, and the composer says only that the
 * previous message is still on its way while the lane's one lock holds.
 */

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => { await unmountAll(); });

const A = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
const B = letter("d-b", "Budget review", "The numbers for the fourth quarter.", { name: "Noah", address: "noah@example.invalid" });

const rowMark = (el: HTMLElement, id: string): string =>
  [...el.querySelectorAll(`.draft-row[data-id='${id}'] .draft-state`)].map((n) => n.textContent ?? "").join(" | ");
const sendButtonText = (el: HTMLElement): string => (composeSend(el)?.textContent ?? "").trim();

/** A sent to Mila and handed off, the wire held; then B opened in the composer from Drafts. */
async function sendAThenOpenB(s: DraftShell): Promise<() => void> {
  await composerOn(s, "d-a", "Plans for Friday");
  const release = holdTheWire(s);
  await press(composeSend(s.el)!, "Send A");
  await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
  await waitFor(() => footLine().includes("Sending to Mila…"), "the foot line on A");
  await navigate("#/drafts");
  await composerOn(s, "d-b", "Budget review");
  await rounds(4);
  return release;
}

describe("a compose send handed off, then another message opened in the composer", () => {
  it("during the flight: the foot keeps saying A, and B says only that the last message is still sending", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendAThenOpenB(s);
    expect(footLine(), "the foot line yielded to a composer showing another message").toContain("Sending to Mila…");
    expect(composeLine(s.el), "A's state said over B").not.toContain(en.compose.statusSending);
    expect(composeLine(s.el)).toContain(en.compose.statusPreviousSending);
    expect(sendButtonText(s.el), "B's button claims a send B never had").not.toMatch(/^Sending/);
    expect(composeSend(s.el)?.disabled, "B can be sent while A holds the one compose lane").toBe(true);
    // Its first save would be refused while A sends: words typed here would live nowhere but this tab.
    expect(s.el.querySelector<HTMLInputElement>("#compose-subject")?.readOnly, "B can be edited while A holds the lane").toBe(true);
    await act(async () => { release(); });
  }, 60_000);

  it("a new message written to a contact while A is out waits for A, then keeps its words", async () => {
    const m1 = message("m1", { to: [{ address: "me@example.invalid", name: "Me" }, { address: "kim@example.invalid", name: "Kim Lee" }] } as never);
    const s = await mountShell("#/drafts", [m1], [A, B], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    const release = holdTheWire(s);
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
    // Write on a contact in the reader: a door to a new message that the rail's Compose is not.
    const click = async (node: Element | undefined): Promise<void> => {
      await act(async () => { node?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    };
    await navigate("#/ohbox");
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row m1");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row m1");
    const kim = (): Element | undefined => [...s.el.querySelectorAll(".rcpt-chip")].find((c) => (c.textContent ?? "").includes("Kim"));
    await waitFor(() => kim() !== undefined, "Kim's chip");
    await click(kim());
    await waitFor(() => s.el.querySelector(".cpop") != null, "the contact popover");
    await click([...s.el.querySelectorAll('.cpop [role="menuitem"]')].find((i) => (i.textContent ?? "").includes("Write")));
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer on a new message");
    await settleEditor();
    const subject = (): HTMLInputElement => s.el.querySelector<HTMLInputElement>("#compose-subject")!;
    expect(subject().readOnly, "the new message can be written while A holds the lane").toBe(true);
    expect(s.el.querySelector(".view-compose .rte-surface")?.getAttribute("contenteditable")).toBe("false");
    expect(composeLine(s.el)).toContain(en.compose.statusPreviousSending);
    await act(async () => { release(); });
    await waitFor(() => !subject().readOnly, "the new message free once A has gone");
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(subject(), "Lunch on Tuesday");
      subject().dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")!, "Are you free on Tuesday?"); });
    const lunch = (): EngineDraft | undefined => s.engine.read().list<EngineDraft>("draft").find((d) => d.subject === "Lunch on Tuesday");
    await waitFor(() => lunch() !== undefined, "the new message's own row", 240);
    await navigate("#/drafts");
    await composerOn(s, "d-b", "Budget review");
    await rounds(10);
    expect(lunch()?.body ?? "", "the new message's words").toContain("Are you free on Tuesday?");
  }, 60_000);

  it("A refused: the foot says it about Mila and marks A's row; B is left alone and free to send", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    const release = await sendAThenOpenB(s);
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.compose.statusUnreachable), "A's refusal on the foot line");
    s.refuseSend.on = false;
    await rounds(6);
    expect(footLine(), "the foot names whom the refused message was for").toContain("Mila");
    expect(composeLine(s.el), "A's refusal said over B").not.toContain(en.compose.statusUnreachable);
    expect(composeSend(s.el)?.disabled, "B's Send").toBe(false);
    expect(toasts(), "the refusal said twice").not.toContain(en.compose.statusUnreachable);
    expect(sends(s)).toHaveLength(1);
    await navigate("#/drafts");
    await waitFor(() => s.el.querySelector(".view-drafts") != null, "Drafts");
    await rounds(4);
    expect(rowMark(s.el, "d-a"), "A's Drafts row says it was not sent").toContain(en.compose.statusUnreachable);
    expect(rowMark(s.el, "d-b"), "B's row carries A's ending").toBe("");
  }, 60_000);

  it("A unverified: the foot says it; B carries no warning and no lock of A's", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    Object.assign(s.refuseSend, { on: true, unverified: true });
    const release = await sendAThenOpenB(s);
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.compose.statusUnverified), "A's unverified ending on the foot line");
    s.refuseSend.on = false;
    await rounds(6);
    expect(composeLine(s.el), "A's unverified warning said over B").not.toContain(en.compose.statusUnverified);
    expect(s.el.querySelectorAll(".view-compose .draft-resolve").length, "A's resolve verbs offered under B").toBe(0);
    expect(composeSend(s.el)?.disabled, "B locked by A's unverified send").toBe(false);
  }, 60_000);

  it("A delivered: B's button never says Sent; the foot says it, with no toast", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    const release = await sendAThenOpenB(s);
    await act(async () => { release(); });
    const labels = new Set<string>();
    for (let i = 0; i < 30; i++) {
      labels.add(sendButtonText(s.el));
      await rounds(1);
    }
    expect([...labels].filter((l) => /^Sen(t|ding)/.test(l)), "B's button spoke for A").toEqual([]);
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent on the foot line");
    expect(toasts()).not.toContain(en.compose.toastSent);
    expect(composeSubject(s.el)).toBe("Budget review");
  }, 60_000);

  it("control: A refused with nothing opened, the foot says it and A's row is marked", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    const release = holdTheWire(s);
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.compose.statusUnreachable), "A's refusal on the foot line");
    await navigate("#/drafts");
    await waitFor(() => rowMark(s.el, "d-a").includes(en.compose.statusUnreachable), "A's row marked");
  }, 60_000);

  it("the composer reopened during the flight shows the message in flight, then empties after Sent and stays", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    const release = holdTheWire(s);
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
    await navigate("#/compose");
    await waitFor(() => composeSubject(s.el) === "Plans for Friday", "the composer back on A");
    await waitFor(() => composeLine(s.el).includes(en.compose.statusSending), "A's own sending line");
    expect(footLine(), "said twice: under the composer and on the foot").toBe("");
    await act(async () => { release(); });
    await waitFor(() => composeSubject(s.el) === "", "the composer empties after Sent", 120);
    await rounds(10);
    expect(window.location.hash, "a late confirmation moved the person").toBe("#/compose");
  }, 60_000);

  it("Cancel on B while A waits on the outbox withdraws nothing of A's", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    // A server that answers a Cancel, so a withdraw of A would land.
    s.withdrawAnswer.outcome = "withdrawn";
    await composerOn(s, "d-a", "Plans for Friday");
    Object.assign(s.refuseSend, { on: true, retryableFirst: 1, code: "send_failed", status: 503 });
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
    await waitFor(() => footLine().includes(en.compose.statusQueued), "A waiting on the outbox");
    s.refuseSend.on = false;
    await navigate("#/drafts");
    await composerOn(s, "d-b", "Budget review");
    await press(s.el.querySelector(".view-compose .compose-cancel"), "B's Cancel");
    const confirm = [...s.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button")]
      .find((b) => b.textContent === en.compose.cancelConfirm);
    await press(confirm ?? null, "discard B");
    await rounds(6);
    expect(sendPendingInDurableOutbox(s.engine, "compose"), "B's Cancel withdrew A's send").toBe(true);
  }, 60_000);
});

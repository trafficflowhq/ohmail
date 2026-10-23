/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EmailAddress, EngineDraft, EngineMutation } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import {
  act, message, mountShell, press, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";

/**
 * SEND LEAVES ITS EDITOR AT ONCE WHEN THE CONNECTION IS HEALTHY (owner, 2026-10-23: "move the
 * sending to the bottom left and complete the sending visually there"). The compose and the reply
 * dock close the moment the send is on disk; the sidebar's foot says "Sending to Mila…", then
 * "Sent", then nothing; no toast says it twice. A refusal stands there with Open, which brings
 * the words back. Unhealthy, the editor stays and says why, as before.
 */

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  setOnline(true);
});
afterEach(async () => {
  setOnline(true);
  await unmountAll();
});

function setOnline(on: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
}

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const footLine = (): string => document.querySelector(".rail-sync.sending-line")?.textContent ?? "";
const toasts = (): string => [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
const composeSend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".view-compose .send-row button")]
    .find((b) => (b.textContent ?? "").trim().startsWith("Send") && !/later/i.test(b.textContent ?? ""));
const replySend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));
const gate = (s: DraftShell): (() => void) => {
  let release!: () => void;
  s.sendGate.wait = new Promise<void>((r) => { release = r; });
  return () => { s.sendGate.wait = null; release(); };
};
const navigate = async (hash: string): Promise<void> => {
  await act(async () => { window.location.hash = hash; window.dispatchEvent(new HashChangeEvent("hashchange")); });
};

async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}
async function replyOpen(s: DraftShell, words: string): Promise<void> {
  await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
  await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
  await key("r");
  await waitFor(() => replySurface(s.el) != null, "the reply editor");
  await act(async () => { typeInto(replySurface(s.el)!, words); });
}

const letter: EngineDraft = {
  id: "d-letter", mailboxId: "mb1", threadId: null, inReplyToMessageId: null,
  subject: "Plans for Friday", body: "Shall we meet at noon?",
  to: [{ name: "Mila", address: "mila@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
} as unknown as EngineDraft;

async function composerWith(s: DraftShell): Promise<void> {
  await waitFor(() => s.el.querySelector(".draft-row[data-id='d-letter'] .draft-open") != null, "the letter in Drafts");
  await press(s.el.querySelector(".draft-row[data-id='d-letter'] .draft-open"), "open the letter");
  await waitFor(() => s.el.querySelector<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the composer");
}

describe("a healthy send leaves its editor and finishes in the sidebar's foot", () => {
  it("1 — the composer leaves before the answer; the foot says Sending to Mila…, then Sent, then nothing; no toast", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    const release = gate(s);
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer gone before the answer");
    expect(sends(s), "the send is on the wire").toHaveLength(1);
    await waitFor(() => footLine().includes("Sending to Mila…"), "the foot line sending");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "the foot line Sent");
    expect(toasts(), "a toast said the send twice").not.toContain(en.compose.toastSent);
    await waitFor(() => footLine() === "", "the foot line settles away", 200);
  }, 40_000);

  it("2 — the reply dock closes at once and the foot finishes it", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [], { handOff: true });
    await replyOpen(s, "See you on Thursday");
    const release = gate(s);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySurface(s.el) == null, "the dock closed before the answer");
    await waitFor(() => /Sending to The colleague…/.test(footLine()), "the foot line names the recipient");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent");
    expect(sends(s)).toHaveLength(1);
    expect(toasts()).not.toContain(en.reply.toastSent);
  }, 40_000);

  it("3 — a refusal after the hand-off stands in the foot with Open, no toast, and Open brings the words back", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await replyOpen(s, "Thursday works for me");
    const release = gate(s);
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySurface(s.el) == null, "the dock closed");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.reply.statusUnreachable), "the refusal in the foot");
    expect(toasts(), "a toast said the refusal too").not.toContain(en.reply.statusUnreachable);
    s.refuseSend.on = false;
    const open = [...document.querySelectorAll<HTMLButtonElement>(".rail-sync.sending-line .sl-act")]
      .find((b) => b.textContent === en.sendingLine.open);
    await press(open ?? null, "Open");
    await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("Thursday works for me"), "the words back");
    expect(footLine(), "the ending stayed after Open").toBe("");
  }, 40_000);

  it("4 — a confirmation after the person moved on leaves them where they are", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter], { handOff: true });
    await composerWith(s);
    const release = gate(s);
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer gone");
    await navigate("#/drafts");
    await waitFor(() => s.el.querySelector(".view-drafts") != null, "Drafts");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "Sent");
    // Past the sent beat (600 ms), where the settled compose is cleared.
    for (let i = 0; i < 48; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(window.location.hash, "a late confirmation moved the person").toBe("#/drafts");
  }, 40_000);
});

type Addressed = EngineMutation & { to?: EmailAddress[]; cc?: EmailAddress[]; bcc?: EmailAddress[] };
const audience = (m: EngineMutation | undefined): string => {
  const a = m as Addressed | undefined;
  const who = (xs: EmailAddress[] | undefined): string => (xs ?? []).map((x) => x.address).join(",");
  return a === undefined ? "(none)" : `to=${who(a.to)} cc=${who(a.cc)} bcc=${who(a.bcc)}`;
};
const dock = (el: HTMLElement): HTMLElement => el.querySelector<HTMLElement>(".read-col .reply, .reader .reply")!;
async function typeRecipient(el: HTMLElement, label: string, text: string): Promise<void> {
  const l = [...dock(el).querySelectorAll<HTMLLabelElement>(".reply-rcpt label")].find((x) => x.textContent === label)!;
  const input = document.getElementById(l.htmlFor) as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}
async function openOn(s: DraftShell, k: string, shiftKey = false): Promise<void> {
  await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
  await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
  await key(k, shiftKey ? { shiftKey: true } : {});
  await waitFor(() => replySurface(s.el) != null, "the editor");
}
/** Refused after the hand-off, Open from the foot, Send again: both presses' audiences. */
async function refuseOpenResend(s: DraftShell, words: string): Promise<[string, string]> {
  await act(async () => { typeInto(replySurface(s.el)!, words); });
  const release = gate(s);
  Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
  await act(async () => { replySend(s.el)!.click(); });
  await waitFor(() => replySurface(s.el) == null, "the dock closed");
  await act(async () => { release(); });
  await waitFor(() => footLine().includes(en.reply.statusUnreachable), "the refusal in the foot");
  s.refuseSend.on = false;
  const open = [...document.querySelectorAll<HTMLButtonElement>(".rail-sync.sending-line .sl-act")]
    .find((b) => b.textContent === en.sendingLine.open);
  await press(open ?? null, "Open");
  await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes(words), "the words back");
  for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  const again = replySend(s.el);
  expect(again?.disabled, "Send is ready again").toBe(false);
  await act(async () => { again!.click(); });
  await waitFor(() => sends(s).length >= 2, "the second press");
  return [audience(sends(s)[0]), audience(sends(s)[1])];
}

describe("Open after a handed-off refusal brings the audience back", () => {
  it("3b — a readdressed reply goes to whom the press named, not the computed sender", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await openOn(s, "r");
    await act(async () => { dock(s.el).querySelector<HTMLButtonElement>(".reply-head-btn")!.click(); });
    await act(async () => { dock(s.el).querySelector<HTMLElement>(".reply-rcpt .rcp-chip .rcp-chip-x")!.click(); });
    await typeRecipient(s.el, "To", "teammate@example.invalid");
    const [first, second] = await refuseOpenResend(s, "Between us: I would not take this offer");
    expect(first).toBe("to=teammate@example.invalid cc= bcc=");
    expect(second).toBe(first);
  }, 60_000);

  it("3c — a reply-all keeps everyone it was sent to", async () => {
    const m1 = message("m1", {
      to: [{ address: "me@example.invalid", name: "Me" }, { address: "pat@example.invalid", name: "Pat" }],
      cc: [{ address: "kim@example.invalid", name: "Kim" }],
    } as never);
    const s = await mountShell("#/ohbox", [m1], [], { handOff: true });
    await openOn(s, "R", true);
    const [first, second] = await refuseOpenResend(s, "Agreed, let us go ahead");
    expect(first).toContain("kim@example.invalid");
    expect(second).toBe(first);
  }, 60_000);

  it("3d — a forward keeps its recipient", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await openOn(s, "F", true);
    await typeRecipient(s.el, "To", "friend@example.invalid");
    const [first, second] = await refuseOpenResend(s, "Have a look at this");
    expect(first).toBe("to=friend@example.invalid cc= bcc=");
    expect(second).toBe(first);
  }, 60_000);
});

describe("under 1024px the Reader sheet covers the foot's pill: the toast says it", () => {
  async function sheetReply(s: DraftShell, words: string): Promise<void> {
    await replyOpen(s, words);
    expect(document.body.classList.contains("reading"), "the reply is in the sheet").toBe(true);
  }

  it("6a — a refusal after the hand-off is said over the sheet", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await sheetReply(s, "Thursday works for me");
    const release = gate(s);
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => replySurface(s.el) == null, "the dock closed in the sheet");
    await act(async () => { release(); });
    await waitFor(() => toasts().includes(en.reply.statusUnreachable), "the refusal said over the sheet");
  }, 40_000);

  it("6b — a delivery is said over the sheet", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await sheetReply(s, "See you on Thursday");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => toasts().includes(en.reply.toastSent), "Reply sent. over the sheet");
  }, 40_000);
});

describe("CONTROLS: an unhealthy send keeps its editor and says why", () => {
  it("5a — the outbox held: the dock stays, its line says it, and the foot says nothing", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await replyOpen(s, "Held words");
    const release = gate(s);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => s.el.querySelector(".reply .send-status") != null, "the line under the editor");
    expect(replySurface(s.el), "the dock closed with the outbox held").not.toBeNull();
    expect(footLine()).toBe("");
    await act(async () => { release(); });
    await waitFor(() => toasts().includes(en.reply.toastSent), "today's sent toast");
  }, 40_000);

  it("5 — offline: the dock stays and its own line says it", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await replyOpen(s, "Offline words");
    setOnline(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); });
    s.offline.on = true;
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => s.el.querySelector(".reply .send-status") != null, "the line under the editor");
    for (let i = 0; i < 10; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
    expect(replySurface(s.el), "the dock closed while offline").not.toBeNull();
    expect(footLine(), "the foot spoke for a send its editor shows").toBe("");
  }, 40_000);
});

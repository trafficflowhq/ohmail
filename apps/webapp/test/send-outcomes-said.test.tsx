/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { EngineDraft, EngineMutation, SyncChange } from "@ohmail/client-engine";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import en from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { readComposeDraft } from "../app/shell/compose";
import {
  act, message, mountShell, NOW, press, replyDraft, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";

/**
 * EVERY ENDING OF A SEND IS SAID, TRUTHFULLY, through the whole shell.
 * A send that ends Not sent while no editor shows its lane is a toast with Open; one on screen is
 * the line under its editor, and only that. A body past the draft limit is refused before the wire,
 * and a 413 names the limit instead of claiming a kept draft and a retry.
 * Mutations: the unshown arm in `onSendOutcome` removed → case 1 red; `sendRefusal`'s `too_long`
 * arm removed → case 4 red on the wire; the 413 arms in `sendLine` removed → case 3 red.
 * Review round 1: `lineSeen` always true → case 5 red; the Ohbox arm's direct `setReaderFor`
 * removed → case 6 red; `openNotSent` back to `openDraft(row)` → cases 7 and 8 red; its
 * composer guard removed → case 9 red; one held slot and no Drafts mark → cases 10–12 red;
 * the notice span kept past an Open → case 13 red; the mark kept past an Open → case 1 red.
 * Review round 2: every unshown ending counted (`keptNotSent` dropped) → cases 14–17 red; the
 * `too_long` phase in `useMailSend.send` removed → cases 18–20 red; the Reply Run's toast off
 * `sendLine` → cases 20 and 21 red.
 */

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(unmountAll);

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const replySend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".reply .reply-actions button")]
    .find((b) => (b.textContent ?? "").startsWith("Send"));
const composeSend = (el: HTMLElement): HTMLButtonElement | undefined =>
  [...el.querySelectorAll<HTMLButtonElement>(".view-compose .send-row button")]
    .find((b) => (b.textContent ?? "").trim().startsWith("Send") && !/later/i.test(b.textContent ?? ""));
const held = (): HTMLElement | null => document.querySelector<HTMLElement>(".toast-held");
const notSentToast = (): boolean => /Not sent/.test(held()?.textContent ?? "");
const toasts = (): string => [...document.querySelectorAll(".toast, .toast-held")].map((n) => n.textContent ?? "").join(" | ");
const online = async (): Promise<void> => { await act(async () => { window.dispatchEvent(new Event("online")); }); };
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};

async function key(k: string): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
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
  to: [{ name: null, address: "lena@example.invalid" }], cc: [], bcc: [],
  rationale: null, status: "draft",
  createdAt: "2026-09-27T08:40:00.000Z", updatedAt: "2026-09-27T08:40:00.000Z",
} as unknown as EngineDraft;

describe("a send that ends Not sent", () => {
  it("1 — a letter whose composer was left says so, and Open brings the composer back", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [letter]);
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d-letter'] .draft-open") != null, "the letter in Drafts");
    await press(s.el.querySelector(".draft-row[data-id='d-letter'] .draft-open"), "open the letter");
    await waitFor(() => s.el.querySelector<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the composer");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424, retryableFirst: 1 });
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => sends(s).length === 1, "the send on the wire");

    await act(async () => { window.location.hash = "#/ohbox"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer off screen");
    await online();
    await waitFor(() => (held()?.textContent ?? "").includes(en.compose.statusUnreachable), "the Not sent toast");

    s.refuseSend.on = false;
    await press(held()!.querySelector(".toast-act"), "Open");
    await waitFor(() => s.el.querySelector<HTMLInputElement>("#compose-subject")?.value === "Plans for Friday", "the composer back");
    expect(composeSend(s.el)?.disabled, "Send is not live").toBe(false);
    // Opened, so acted on: its Drafts row no longer carries the line.
    await toDrafts();
    await waitFor(() => s.el.querySelector(".draft-row[data-id='d-letter']") != null, "the letter in Drafts");
    expect(draftNotes(s)).not.toContain(en.compose.statusUnreachable);
  }, 30_000);

  it("2 — control: a confirmed send says only that it went, wherever the reader is", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await replyOpen(s, "See you on Thursday");
    await act(async () => { replySend(s.el)!.click(); });
    await press(s.el.querySelector(".view-ohbox .row[data-id='m2']"), "the next row");
    await waitFor(() => toasts().includes(en.reply.toastSent), "the sent toast");
    expect(notSentToast(), "a delivered send was said as Not sent").toBe(false);
  }, 30_000);
});

describe("a send past the draft limit", () => {
  it("3 — a 413 on the press names the limit, and claims neither a kept draft nor a retry", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await replyOpen(s, "See you on Thursday");
    Object.assign(s.refuseSend, { on: true, code: "draft_too_large", status: 413 });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => s.el.querySelector(".reply .send-status.error") != null, "the refusal under the editor");
    const line = s.el.querySelector(".reply .send-status.error")!.textContent ?? "";
    expect(line).toMatch(/^Not sent\. It's too long to send — the limit is /);
    expect(line).not.toMatch(/kept|Try again/);
  }, 30_000);

  it("4 — the reply editor says the limit while typing, and a press sends nothing", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await replyOpen(s, "a".repeat(DRAFT_BODY_MAX_BYTES + 1));
    await waitFor(() => (s.el.querySelector(".reply")?.textContent ?? "").includes("Too long to save"), "the limit while typing");
    const button = replySend(s.el)!;
    expect({ disabled: button.disabled, dimmed: button.getAttribute("aria-disabled") }).toEqual({ disabled: false, dimmed: "true" });
    await act(async () => { button.click(); });
    await rounds(6);
    expect(sends(s), "an over-limit press reached the wire").toHaveLength(0);
    expect(s.el.querySelector(".reply")?.textContent ?? "").toContain("Too long to send");

    // Control: shortened, it goes.
    await act(async () => { typeInto(replySurface(s.el)!, "Short now"); });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the shortened send on the wire");
  }, 30_000);
});

/* ── review round 1 (PR #185): what the notice's Open brings back, at every width ─────────── */

const sheetEditor = (): string | null => document.querySelector(".reader .msg .rte-surface")?.textContent ?? null;
const forwardDock = (s: DraftShell): HTMLElement | null => s.el.querySelector<HTMLElement>(".reply[data-reply-for]");
async function setInput(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
function setHidden(hidden: boolean): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => (hidden ? "hidden" : "visible") });
}
const visibility = async (hidden: boolean): Promise<void> => {
  setHidden(hidden);
  await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
};
const draftNotes = (s: DraftShell): string[] =>
  [...s.el.querySelectorAll(".draft-row .draft-state")].map((n) => n.textContent ?? "");
const toDrafts = async (): Promise<void> => {
  await act(async () => { window.location.hash = "#/drafts"; window.dispatchEvent(new HashChangeEvent("hashchange")); });
};

/** At a phone width: tap the row (the sheet opens over the hidden column), reply there. */
async function sheetReply(s: DraftShell, id: string, words: string): Promise<void> {
  await waitFor(() => s.el.querySelector(`.view-ohbox .row[data-id='${id}']`) != null, "the row");
  await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), "tap the row");
  await waitFor(() => document.querySelector(".reader .msg-subject") != null, "the sheet");
  await key("r");
  await waitFor(() => replySurface(s.el) != null, "the reply editor");
  await act(async () => { typeInto(replySurface(s.el)!, words); });
}

describe("at a phone width, where the reading column is hidden", () => {
  beforeEach(() => { stubDom({ narrow: true }); });

  it("5 — a reply sent from the sheet and the sheet closed: the ending is said, not left in the hidden column", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await sheetReply(s, "m1", "See you on Thursday");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424, retryableFirst: 1 });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await press(document.querySelector(".reader .reader-close"), "the sheet's back control");
    await waitFor(() => document.querySelector(".reader") == null, "the sheet closed");
    await online();
    await waitFor(() => (held()?.textContent ?? "").includes(en.reply.statusUnreachable), "the Not sent toast");
  }, 30_000);

  it("6 — Open from another letter's sheet brings the reply and its words into the sheet", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")]);
    await sheetReply(s, "m1", "See you on Thursday");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424, retryableFirst: 1 });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await press(document.querySelector(".reader .reader-close"), "the sheet's back control");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m2']"), "tap the next letter");
    await waitFor(() => document.querySelector(".reader .msg-subject")?.textContent === "Subject m2", "the sheet on m2");
    await online();
    await waitFor(() => (held()?.textContent ?? "").includes(en.reply.statusUnreachable), "the Not sent toast");
    s.refuseSend.on = false;
    await press(held()!.querySelector(".toast-act"), "Open");
    await waitFor(() => (sheetEditor() ?? "").includes("See you on Thursday"), "the reply in the sheet");
    expect(document.querySelector(".reader .msg-subject")?.textContent).toBe("Subject m1");
    // Nothing of the open is left pending: the next view opens no sheet over itself.
    await toDrafts();
    await waitFor(() => s.el.querySelector(".view-drafts") != null, "Drafts");
    await rounds(6);
    expect(document.querySelector(".reader"), "a stale sheet over Drafts").toBeNull();
  }, 30_000);
});

/** A forward on m1 refused retryably once, then a letter past the limit written in the composer. */
async function forwardThenLetter(s: DraftShell): Promise<void> {
  await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the row");
  await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "the row");
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "F", shiftKey: true, bubbles: true, cancelable: true }));
  });
  await settleEditor();
  await waitFor(() => forwardDock(s) != null, "the forward dock");
  await setInput(forwardDock(s)!.querySelector<HTMLInputElement>(".rcp-input")!, "friend@example.invalid, ");
  await act(async () => { typeInto(forwardDock(s)!.querySelector<HTMLElement>(".rte-surface")! as never, "FORWARD NOTE"); });
  await settleEditor();
  Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424, retryableFirst: 1 });
  await act(async () => { replySend(s.el)!.click(); });
  await waitFor(() => sends(s).length === 1, "the forward on the wire");
  await key("c");
  await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
  await setInput(s.el.querySelector<HTMLInputElement>("#compose-to")!, "lena@example.invalid, ");
  await setInput(s.el.querySelector<HTMLInputElement>("#compose-subject")!, "LETTER B");
  await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "B".repeat(DRAFT_BODY_MAX_BYTES + 50)); });
  await settleEditor();
}

describe("Open never puts older words over the ones refused", () => {
  it("7 — a reply refused for its length while away: Open brings back the refused words, not the row's older ones", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2")], [replyDraft("d-reply", "m1", "older words")]);
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "row m1");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m1']"), "row m1");
    await key("r");
    await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("older words"), "the editor seeded from the row");
    let release!: () => void;
    s.sendGate.wait = new Promise<void>((r) => { release = r; });
    Object.assign(s.refuseSend, { on: true, code: "draft_too_large", status: 413 });
    await act(async () => { typeInto(replySurface(s.el)!, "my newer words"); });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m2']"), "row m2");
    await waitFor(() => replySurface(s.el) == null, "no reply editor on screen");
    await act(async () => { release(); });
    await waitFor(() => /Not sent/.test(held()?.textContent ?? ""), "the Not sent toast");
    s.refuseSend.on = false;
    s.sendGate.wait = null;
    await press(held()!.querySelector(".toast-act"), "Open");
    await waitFor(() => replySurface(s.el) != null, "the reply editor back");
    await rounds(6);
    expect(replySurface(s.el)!.textContent).toContain("my newer words");
  }, 30_000);

  it("8 — a forward's Open opens the forward and leaves the letter in the composer alone", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await forwardThenLetter(s);
    await online();
    await waitFor(() => (held()?.textContent ?? "").includes(en.reply.statusUnreachable), "the Not sent toast");
    s.refuseSend.on = false;
    await press(held()!.querySelector(".toast-act"), "Open");
    await waitFor(() => (forwardDock(s)?.textContent ?? "").includes("FORWARD NOTE"), "the forward's own dock");
    expect(readComposeDraft()?.subject, "the letter in the composer").toBe("LETTER B");
  }, 60_000);

  it("9 — a row that would open in the composer never replaces the letter being written there", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    await forwardThenLetter(s);
    await online();
    await waitFor(() => (held()?.textContent ?? "").includes(en.reply.statusUnreachable), "the Not sent toast");
    // The original leaves this device: the forward's row can only open in the composer now.
    s.remote.push({ type: "message", op: "delete", id: "m1", seq: 0, updatedAt: NOW.toISOString(), entity: null } as unknown as SyncChange);
    await act(async () => { await s.engine.syncOnce().catch(() => undefined); });
    s.refuseSend.on = false;
    await press(held()!.querySelector(".toast-act"), "Open");
    await waitFor(() => toasts().includes(en.compose.notSentOpenBlocked), "the refusal in words");
    expect(readComposeDraft()?.subject, "the letter in the composer").toBe("LETTER B");
    expect(s.el.querySelector<HTMLInputElement>("#compose-subject")?.value).toBe("LETTER B");
  }, 60_000);
});

describe("every ending stays reachable until it is acted on", () => {
  afterEach(() => { setHidden(false); });

  async function twoRepliesFailing(s: DraftShell): Promise<() => void> {
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    let release!: () => void;
    s.sendGate.wait = new Promise<void>((r) => { release = r; });
    for (const [id, words] of [["m1", "First reply"], ["m2", "Second reply"]] as const) {
      await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), `row ${id}`);
      await key("r");
      await waitFor(() => replySurface(s.el) != null, `the reply on ${id}`);
      await act(async () => { typeInto(replySurface(s.el)!, words); });
      await act(async () => { replySend(s.el)!.click(); });
      await rounds(4);
    }
    await press(s.el.querySelector(".view-ohbox .row[data-id='m3']"), "row m3");
    await waitFor(() => replySurface(s.el) == null, "no reply editor on screen");
    return release;
  }

  it("10 — two endings while the window is hidden: both are said on return, and Drafts marks both", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the rows");
    const release = await twoRepliesFailing(s);
    await visibility(true);
    await act(async () => { release(); });
    await rounds(20);
    expect(held(), "nothing is said to a hidden window").toBeNull();
    await visibility(false);
    await waitFor(() => /2 messages weren't sent/.test(held()?.textContent ?? ""), "one notice naming both");
    await press(held()!.querySelector(".toast-act"), "Open");
    await waitFor(() => window.location.hash === "#/drafts", "Drafts");
    await waitFor(() => draftNotes(s).filter((n) => n === en.reply.statusUnreachable).length === 2, "both rows say Not sent");
  }, 60_000);

  it("11 — two endings in a visible window: the second does not take the first away", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the rows");
    const release = await twoRepliesFailing(s);
    await act(async () => { release(); });
    await waitFor(() => /2 messages weren't sent/.test(held()?.textContent ?? ""), "one notice naming both");
  }, 60_000);

  it("13 — an ending already opened is not counted into the next one", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the rows");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    for (const [id, words] of [["m1", "First reply"], ["m2", "Second reply"]] as const) {
      await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), `row ${id}`);
      await key("r");
      await waitFor(() => replySurface(s.el) != null, `the reply on ${id}`);
      await act(async () => { typeInto(replySurface(s.el)!, words); });
      let release!: () => void;
      s.sendGate.wait = new Promise<void>((r) => { release = r; });
      await act(async () => { replySend(s.el)!.click(); });
      await rounds(4);
      await press(s.el.querySelector(".view-ohbox .row[data-id='m3']"), "row m3");
      await waitFor(() => replySurface(s.el) == null, "no reply editor on screen");
      await act(async () => { release(); });
      await waitFor(() => (held()?.textContent ?? "").includes(en.reply.statusUnreachable), `the Not sent toast for ${id}`);
      if (id === "m1") {
        await press(held()!.querySelector(".toast-act"), "Open");
        await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("First reply"), "the first reply back");
      }
    }
    expect(held()?.textContent ?? "").not.toMatch(/messages weren't sent/);
  }, 60_000);

  it("12 — an Undo toast over the ending: the Drafts row still says it was not sent", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the rows");
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    let release!: () => void;
    s.sendGate.wait = new Promise<void>((r) => { release = r; });
    await replyOpen(s, "First reply");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the send on the wire");
    await press(s.el.querySelector(".view-ohbox .row[data-id='m3']"), "row m3");
    await waitFor(() => replySurface(s.el) == null, "no reply editor on screen");
    await act(async () => { release(); });
    await waitFor(() => (held()?.textContent ?? "").includes(en.reply.statusUnreachable), "the Not sent toast");
    await key("e");
    await waitFor(() => !(held()?.textContent ?? "").includes(en.reply.statusUnreachable), "the toast replaced");
    await toDrafts();
    await waitFor(() => draftNotes(s).includes(en.reply.statusUnreachable), "the row says Not sent");
  }, 60_000);
});

/* ── review round 2 (PR #185): what the count may say, and a signature past the limit ────────── */

type Answer = Pick<DraftShell["refuseSend"], "unverified" | "code" | "status">;
const UNVERIFIED: Answer = { unverified: true };
const UNREACHABLE: Answer = { code: "send_unreachable", status: 424 };
const DUPLICATE: Answer = { code: "duplicate_send", status: 409 };
const answer = (s: DraftShell, a: Answer): void => {
  Object.assign(s.refuseSend, { on: true, unverified: false, code: undefined, status: undefined, retryableFirst: 0, ...a });
};
/** The notice standing in the action slot, once nothing new arrives for a few rounds. */
const settledNotice = async (): Promise<string> => { await rounds(8); return held()?.textContent ?? ""; };

/**
 * Two replies, on m1 and m2, pressed and left for m3, each held on its own gate: m1 is answered
 * `first`, then m2 `second`. Hidden: both end while the window is hidden, and it shows again after.
 */
async function twoEndings(s: DraftShell, first: Answer, second: Answer, hidden: boolean): Promise<void> {
  await waitFor(() => s.el.querySelector(".view-ohbox .row[data-id='m1']") != null, "the rows");
  const gates: Array<() => void> = [];
  for (const [id, words] of [["m1", "First reply"], ["m2", "Second reply"]] as const) {
    s.sendGate.wait = new Promise<void>((r) => { gates.push(r); });
    await press(s.el.querySelector(`.view-ohbox .row[data-id='${id}']`), `row ${id}`);
    await key("r");
    await waitFor(() => replySurface(s.el) != null, `the reply on ${id}`);
    await act(async () => { typeInto(replySurface(s.el)!, words); });
    await act(async () => { replySend(s.el)!.click(); });
    await rounds(4);
  }
  await press(s.el.querySelector(".view-ohbox .row[data-id='m3']"), "row m3");
  await waitFor(() => replySurface(s.el) == null, "no reply editor on screen");
  if (hidden) await visibility(true);
  answer(s, first);
  await act(async () => { gates[0]!(); });
  if (hidden) await rounds(12);
  else await waitFor(() => held() != null, "the first ending said");
  answer(s, second);
  await act(async () => { gates[1]!(); });
  await rounds(12);
  if (hidden) {
    expect(held(), "nothing is said to a hidden window").toBeNull();
    await visibility(false);
    await waitFor(() => held() != null, "the endings said on return");
  }
}

describe("an ending that may have gone is never counted as not sent", () => {
  afterEach(() => { setHidden(false); });
  const notSentCount = /weren't sent|kept in Drafts/;

  for (const hidden of [false, true]) {
    const where = hidden ? "hidden" : "visible";

    it(`14 — unverified, then unreachable (${where}): the unverified line stands, the other is marked in Drafts`, async () => {
      const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
      await twoEndings(s, UNVERIFIED, UNREACHABLE, hidden);
      const said = await settledNotice();
      expect(said).toContain(en.reply.statusUnverified);
      expect(said).not.toMatch(notSentCount);
      // Open goes to the reply that may have gone, with its words, never to a count of rows.
      await press(held()!.querySelector(".toast-act"), "Open");
      await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("First reply"), "the unverified reply opened");
      await toDrafts();
      await waitFor(() => draftNotes(s).includes(en.reply.statusUnreachable), "the unreachable one marked in Drafts");
      // Only the refusal that named its row says so there; nothing claims the unverified one was not sent.
      expect(draftNotes(s).filter((n) => /Not sent|weren't sent/.test(n))).toEqual([en.reply.statusUnreachable]);
    }, 60_000);

    it(`15 — both unverified (${where}): never "weren't sent", never "kept in Drafts"`, async () => {
      const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
      await twoEndings(s, UNVERIFIED, UNVERIFIED, hidden);
      const said = await settledNotice();
      expect(said).toContain(en.reply.statusUnverified);
      expect(said).not.toMatch(notSentCount);
    }, 60_000);

    it(`16 — a duplicate, then unreachable (${where}): the duplicate's line stands, not a count`, async () => {
      const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
      await twoEndings(s, DUPLICATE, UNREACHABLE, hidden);
      const said = await settledNotice();
      expect(said).toContain(en.reply.statusDuplicate);
      expect(said).not.toMatch(notSentCount);
      await toDrafts();
      await waitFor(() => draftNotes(s).includes(en.reply.statusUnreachable), "the unreachable one marked in Drafts");
    }, 60_000);
  }

  it("17 — unreachable, then unverified (visible): the unverified line takes the notice", async () => {
    const s = await mountShell("#/ohbox", [message("m1"), message("m2"), message("m3")]);
    await twoEndings(s, UNREACHABLE, UNVERIFIED, false);
    const said = await settledNotice();
    expect(said).toContain(en.reply.statusUnverified);
    expect(said).not.toMatch(notSentCount);
  }, 60_000);
});

/** A signature the send seals onto the typed text, which alone fits under the limit. */
const SIG = "Lena · the studio · a signature with ümlauts, sealed at the press";
const IN_BAND = DRAFT_BODY_MAX_BYTES - 10;
const chordSend = async (editor: HTMLElement): Promise<void> => {
  editor.focus();
  await act(async () => {
    editor.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true }));
  });
  await settleEditor();
};

describe("a signature that takes the text past the limit", () => {
  it("18 — the reply editor: the press and the chord name the limit in place, and nothing goes", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { signatures: { mb1: SIG } });
    await replyOpen(s, "a".repeat(IN_BAND));
    await waitFor(() => (s.el.querySelector(".reply")?.textContent ?? "").includes(SIG), "the signature block");
    const button = replySend(s.el)!;
    expect(button.getAttribute("aria-disabled"), "the typed text alone fits, so Send is live").toBeNull();
    await act(async () => { button.click(); });
    await waitFor(() => s.el.querySelector(".reply .send-status.error") != null, "the refusal under the editor");
    expect(s.el.querySelector(".reply .send-status.error")!.textContent).toMatch(/^Not sent\. It's too long to send — the limit is /);
    await chordSend(replySurface(s.el)!);
    await rounds(6);
    expect(sends(s), "a press past the limit reached the wire").toHaveLength(0);
    expect(s.el.querySelector(".reply .send-status.error")?.textContent ?? "").toMatch(/too long to send/);

    // Control: shortened out of the band, the next press sends, the signature on the wire.
    await act(async () => { typeInto(replySurface(s.el)!, "Short now"); });
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => sends(s).length === 1, "the shortened send on the wire");
    expect((sends(s)[0] as { body?: string }).body).toContain(SIG);
  }, 60_000);

  it("19 — the composer: the press and the chord name the limit in place, and nothing goes", async () => {
    const s = await mountShell("#/ohbox", [message("m1")], [], { signatures: { mb1: SIG } });
    await key("c");
    await waitFor(() => s.el.querySelector(".view-compose .rte-surface") != null, "the composer");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-to")!, "lena@example.invalid, ");
    await setInput(s.el.querySelector<HTMLInputElement>("#compose-subject")!, "LETTER IN THE BAND");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")! as never, "B".repeat(IN_BAND)); });
    await settleEditor();
    await waitFor(() => (s.el.querySelector(".view-compose")?.textContent ?? "").includes(SIG), "the signature block");
    const button = composeSend(s.el)!;
    expect(button.getAttribute("aria-disabled"), "the typed text alone fits, so Send is live").toBeNull();
    await act(async () => { button.click(); });
    await waitFor(() => s.el.querySelector(".view-compose .send-status.error") != null, "the refusal in the composer");
    expect(s.el.querySelector(".view-compose .send-status.error")!.textContent).toMatch(/^Not sent\. It's too long to send — the limit is /);
    await chordSend(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")!);
    await rounds(6);
    expect(sends(s), "a press past the limit reached the wire").toHaveLength(0);
    expect(s.el.querySelector(".view-compose")).not.toBeNull();
  }, 60_000);
});

/** Two messages in Answer Later, so a Reply Run opens over them. */
const answerLater = (id: string) => message(id, {
  triage: { messageId: id, state: "reply_later", bubbleUpAt: null, setAt: "2026-09-27T08:30:00.000Z", updatedAt: "2026-09-27T08:30:00.000Z" },
} as never);

/** The Reply Run's first step answered with `words` and Done, and every notice said meanwhile. */
async function runStep(s: DraftShell, words: string): Promise<string[]> {
  await waitFor(() => s.el.querySelectorAll(".view-triage .row").length > 0, "the Answer Later pile");
  await key("f");
  await waitFor(() => (s.el.querySelector(".fr-card h3")?.textContent ?? "") !== "", "the Reply Run");
  await act(async () => { typeInto(document.querySelector<HTMLElement>(".fr-card .rte-surface")! as never, words); });
  await settleEditor();
  await act(async () => { [...document.querySelectorAll<HTMLButtonElement>(".fr-foot button")][0]!.click(); });
  const said: string[] = [];
  for (let i = 0; i < 60; i++) {
    await rounds(1);
    const now = toasts();
    if (now !== "" && said[said.length - 1] !== now) said.push(now);
  }
  return said;
}

describe("the Reply Run says what the editor would", () => {
  it("20 — a step past the limit names the limit, claims neither a kept draft nor a retry, and nothing goes", async () => {
    const s = await mountShell("#/triage", [answerLater("m1"), answerLater("m2")]);
    const said = (await runStep(s, "x".repeat(DRAFT_BODY_MAX_BYTES + 5))).join(" | ");
    expect(sends(s), "a step past the limit reached the wire").toHaveLength(0);
    expect(said).toContain("Not sent. It's too long to send — the limit is ");
    expect(said).not.toMatch(/kept|Try again/);
  }, 60_000);

  it("21 — a step that went says only that it went, never that sending didn't work", async () => {
    const s = await mountShell("#/triage", [answerLater("m1"), answerLater("m2")]);
    const said = (await runStep(s, "A short reply from the run")).join(" | ");
    expect(sends(s)).toHaveLength(1);
    expect(said).toContain(en.reply.toastSent);
    expect(said).not.toContain(en.reply.statusFailed);
  }, 60_000);
});

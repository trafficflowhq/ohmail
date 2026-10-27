/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EngineDraft } from "@ohmail/client-engine";
import en from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import { sendPendingInDurableOutbox } from "../app/shell/mail-send";
import { COMPOSE_DRAFT_PREFIX, readComposeRow, resetComposerForTest } from "../app/shell/compose";
import {
  act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";
import {
  attach, composeLine, composeSend, composeSubject, composerOn, footButton, footLine, holdTheWire, letter, navigate, openDraftRow,
  rounds, sends, toasts,
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
const M1_KIM = message("m1", { to: [{ address: "me@example.invalid", name: "Me" }, { address: "kim@example.invalid", name: "Kim Lee" }] } as never);

async function setSubject(s: DraftShell, value: string): Promise<void> {
  const field = s.el.querySelector<HTMLInputElement>("#compose-subject")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
/** Write on Kim's chip in the reader: a door to a new message that the rail's Compose is not. */
async function writeToKim(s: DraftShell): Promise<void> {
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
}

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
    // B is its own letter: written at once, and its pause saves its own row while A is still out.
    expect(s.el.querySelector<HTMLInputElement>("#compose-subject")?.readOnly, "B frozen by A's send").toBe(false);
    await setSubject(s, "Budget review, the final numbers");
    await act(async () => { release(); });
    await waitFor(() => s.store.get<EngineDraft>("draft", "d-b")?.subject === "Budget review, the final numbers", "B's own row saved", 240);
    expect(s.store.get<EngineDraft>("draft", "d-a")?.subject, "B's words written into A's row").toBe("Plans for Friday");
  }, 60_000);

  it("a new message written to a contact while A is out is written at once, and waits for A to send", async () => {
    const s = await mountShell("#/drafts", [M1_KIM], [A, B], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    const release = holdTheWire(s);
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
    await writeToKim(s);
    const subject = (): HTMLInputElement => s.el.querySelector<HTMLInputElement>("#compose-subject")!;
    expect(subject().readOnly, "the new message frozen while A holds the lane").toBe(false);
    expect(s.el.querySelector(".view-compose .rte-surface")?.getAttribute("contenteditable")).toBe("true");
    expect(composeLine(s.el)).toContain(en.compose.statusPreviousSending);
    expect(composeSend(s.el)?.disabled, "the new message can be sent while A holds the lane").toBe(true);
    await setSubject(s, "Lunch on Tuesday");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")!, "Are you free on Tuesday?"); });
    const lunch = (): EngineDraft | undefined => s.engine.read().list<EngineDraft>("draft").find((d) => d.subject === "Lunch on Tuesday");
    await act(async () => { release(); });
    await waitFor(() => lunch() !== undefined, "the new message's own row", 240);
    await waitFor(() => composeSend(s.el)?.disabled === false, "Send free once A has gone");
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

describe("Compose while a letter's send waits", () => {
  const TYPED = "Plans for Friday, typed here";
  const field = (s: DraftShell): HTMLInputElement | null => s.el.querySelector<HTMLInputElement>("#compose-subject");
  const shown = (s: DraftShell): { subject: string | null; frozen: boolean | null } =>
    ({ subject: field(s)?.value ?? null, frozen: field(s)?.readOnly ?? null });
  const BLANK = { subject: "", frozen: false };
  const sendRow = (s: DraftShell): string => s.el.querySelector(".view-compose .send-row")?.textContent ?? "";
  const keydown = (init: KeyboardEventInit): Promise<void> => act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }));
  });
  const doors: Record<string, () => Promise<void>> = {
    "the rail's Compose": () => press(document.querySelector(".compose-cta"), "Compose"),
    "the c key": () => keydown({ key: "c" }),
    "the palette's New message": async () => {
      await keydown({ key: "k", ctrlKey: true });
      const row = [...document.querySelectorAll<HTMLElement>(".palette li[role=option]")]
        .find((li) => (li.textContent ?? "").trim().startsWith(en.palette.newMessage));
      await act(async () => { row?.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
    },
  };
  /** The mail server answers "try again", saving the press's words into its row first when `saveFirst`. */
  const keepWaiting = (s: DraftShell, saveFirst = false): void => {
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424, retryableFirst: 500, saveFirst });
  };
  async function composeBy(s: DraftShell, door: string): Promise<void> {
    await navigate("#/ohbox");
    await rounds(6);
    await doors[door]!();
    await waitFor(() => window.location.hash === "#/compose", "the composer");
    await rounds(10);
  }
  const lunch = (s: DraftShell): EngineDraft | undefined =>
    s.store.list<EngineDraft>("draft").find((d) => d.subject === "Lunch on Tuesday" && d.status === "draft");
  async function writeLunch(s: DraftShell): Promise<void> {
    await setSubject(s, "Lunch on Tuesday");
    await act(async () => { typeInto(s.el.querySelector<HTMLElement>(".view-compose .rte-surface")!, "Are you free on Tuesday?"); });
  }
  /** The page reloaded over the same browser: the store, the drafts and the storage stay. */
  async function reload(s: DraftShell, messages = [message("m1")], signatures?: Record<string, string>): Promise<DraftShell> {
    const drafts = s.store.list<EngineDraft>("draft");
    await unmountAll();
    resetComposerForTest();
    stubDom();
    const now = await mountShell("#/ohbox", messages, drafts, { store: s.store, handOff: true, ...(signatures ? { signatures } : {}) });
    keepWaiting(now, true);
    await rounds(30);
    return now;
  }
  /** A typed inside the pause and pressed; the send saves its words into A's row and says so. */
  async function pressTypedA(s: DraftShell): Promise<void> {
    await composerOn(s, "d-a", "Plans for Friday");
    keepWaiting(s, true);
    await setSubject(s, TYPED);
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.store.get<EngineDraft>("draft", "d-a")?.subject === TYPED, "A's send saved its words");
  }

  for (const door of Object.keys(doors)) {
    it(`${door}: A's row holds its words, so a new letter opens and saves its own row while A waits`, async () => {
      const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
      await composerOn(s, "d-a", "Plans for Friday");
      keepWaiting(s);
      await press(composeSend(s.el)!, "Send A");
      await waitFor(() => s.engine.waitingSends().length === 1, "A waits");
      await composeBy(s, door);
      expect(shown(s), "Compose showed the waiting letter").toEqual(BLANK);
      await writeLunch(s);
      await waitFor(() => lunch(s) !== undefined, "the new letter's own row", 240);
      expect(s.engine.waitingSends().map((w) => w.draftId), "A's one send").toEqual(["d-a"]);
      expect(s.store.get<EngineDraft>("draft", "d-a")?.subject, "the new letter written into A's row").toBe("Plans for Friday");
      await navigate("#/drafts");
      await waitFor(() => rowMark(s.el, "d-a").includes(en.drafts.waitingToSend), "A waiting in Drafts");
    }, 60_000);
  }

  it("A typed inside the pause, its send's save reported: Compose opens a new letter, Open on its foot line shows A, a reload too", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await pressTypedA(s);
    await composeBy(s, "the rail's Compose");
    expect(shown(s), "Compose kept the letter its send's save holds").toEqual(BLANK);
    await navigate("#/ohbox");
    await rounds(6);
    await waitFor(() => footButton("Open") !== null, "A waiting on the foot line");
    await press(footButton("Open"), "Open on A");
    await waitFor(() => window.location.hash === "#/compose", "the composer");
    await waitFor(() => shown(s).subject === TYPED, "Open on A's foot line shows A");
    expect(shown(s).frozen, "A editable while its send waits").toBe(true);
    const now = await reload(s);
    await composeBy(now, "the rail's Compose");
    expect(shown(now), "Compose after the reload").toEqual(BLANK);
    expect(now.engine.waitingSends().map((w) => w.draftId)).toEqual(["d-a"]);
  }, 90_000);

  it("A typed and pressed offline: Compose shows A read-only and says why; online, A goes once and Compose is blank", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    s.offline.on = true;
    await setSubject(s, TYPED);
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => sendPendingInDurableOutbox(s.engine, "compose"), "A waits on the outbox");
    await composeBy(s, "the rail's Compose");
    expect(shown(s), "Compose let go of words no row holds").toEqual({ subject: TYPED, frozen: true });
    expect(sendRow(s), "the locked letter says why").toContain(en.compose.waitingNotSaved);
    s.offline.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => !sendPendingInDurableOutbox(s.engine, "compose"), "A went", 240);
    await waitFor(() => composeSubject(s.el) === "", "the composer empties after Sent", 120);
    expect(sends(s), "A sent more than once").toHaveLength(1);
    expect(s.sent.filter((m) => m.kind === "draft_save" && m.draftId === null), "a create beside A").toEqual([]);
    await composeBy(s, "the rail's Compose");
    expect(shown(s)).toEqual(BLANK);
    expect(sendRow(s)).not.toContain(en.compose.waitingNotSaved);
  }, 90_000);

  it("after a reload, a letter let go never lends its saved row to the next: B sent offline stays with the sentence", async () => {
    const s = await mountShell("#/drafts", [M1_KIM], [A, B], { handOff: true });
    await pressTypedA(s);
    const now = await reload(s, [M1_KIM]);
    await writeToKim(now);
    expect(shown(now), "Write to Kim over A, whose send saved its words").toEqual(BLANK);
    now.offline.on = true;
    await writeLunch(now);
    await press(composeSend(now.el)!, "Send B");
    await rounds(10);
    await composeBy(now, "the rail's Compose");
    expect(shown(now), "B let go on A's saved row").toEqual({ subject: "Lunch on Tuesday", frozen: true });
    expect(sendRow(now)).toContain(en.compose.waitingNotSaved);
  }, 90_000);

  it("after a reload, A's row reopened from Drafts is read-only, says why, and nothing is written to it", async () => {
    const signatures = { mb1: "Mila from the office" };
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true, signatures });
    await pressTypedA(s);
    const now = await reload(s, [message("m1")], signatures);
    const before = now.sent.length;
    await navigate("#/drafts");
    await rounds(6);
    await openDraftRow(now, "d-a");
    await waitFor(() => shown(now).subject === TYPED, "A in the composer");
    await rounds(20);
    expect(shown(now), "A editable while its send waits").toEqual({ subject: TYPED, frozen: true });
    expect(sendRow(now)).toContain(en.compose.sendingFromLastSession);
    await rounds(100);
    expect(now.sent.slice(before).filter((m) => m.kind === "draft_save" && m.draftId === "d-a"), "a save to A's row").toEqual([]);
  }, 90_000);

  /* A press inside the first create's round trip carries no row; the create lands after it and the
     composer binds it. That row is no row the send names or made: a copy only this composer's
     ending drops, so the letter stays until its send has ended. */
  for (const [door, ending] of [["Compose", "delivered"], ["Compose", "unverified"], ["Write to", "delivered"], ["Write to", "unverified"]] as const) {
    it(`${door} while a letter pressed inside its first save's round trip waits, then ${ending}: no copy is left to send again`, async () => {
      const s = await mountShell("#/ohbox", [M1_KIM], [], { handOff: true });
      await writeToKim(s);
      await writeLunch(s);
      let releaseSave!: () => void;
      s.saveGate.wait = new Promise<void>((r) => { releaseSave = r; });
      await waitFor(() => s.sent.some((m) => m.kind === "draft_save" && m.draftId === null), "the create in the air", 240);
      const releaseSend = holdTheWire(s);
      await press(composeSend(s.el)!, "Send");
      await waitFor(() => s.el.querySelector(".view-compose") == null, "handed off", 240);
      s.saveGate.wait = null;
      await act(async () => { releaseSave(); });
      await waitFor(() => readComposeRow() !== null, "the create's row bound", 240);
      const copy = readComposeRow()!;
      if (door === "Compose") await composeBy(s, "the rail's Compose");
      else await writeToKim(s);
      expect(shown(s), "the letter let go of on a row its send does not use").toEqual({ subject: "Lunch on Tuesday", frozen: true });
      expect(sendRow(s)).toContain(en.compose.waitingUntilSent);
      if (ending === "unverified") Object.assign(s.refuseSend, { on: true, unverified: true });
      await act(async () => { releaseSend(); });
      await waitFor(() => !sendPendingInDurableOutbox(s.engine, "compose"), "the send ended", 240);
      s.refuseSend.on = false;
      await rounds(60);
      if (ending === "delivered") {
        expect(lunch(s), "a row holding the delivered letter's words").toBeUndefined();
        return;
      }
      await navigate("#/drafts");
      await rounds(10);
      await openDraftRow(s, copy);
      await rounds(20);
      if (composeSend(s.el)?.disabled === false) await press(composeSend(s.el)!, "Send the copy");
      await rounds(20);
      expect(sends(s), "the unconfirmed letter sent again under a new key").toHaveLength(1);
    }, 90_000);
  }

  it("a held row opened over a letter its press saved but named only by its session neither speaks for nor withdraws that send", async () => {
    const held = { ...letter("d-x", "Old letter", "Older words"), status: "unverified" } as unknown as EngineDraft;
    const s = await mountShell("#/ohbox", [M1_KIM], [held], { handOff: true });
    s.withdrawAnswer.outcome = "withdrawn";
    await writeToKim(s);
    keepWaiting(s, true);
    await writeLunch(s);
    await press(composeSend(s.el)!, "Send");
    await waitFor(() => lunch(s) !== undefined && s.engine.waitingSends().length === 1, "the press's own save, and the send waits", 240);
    await navigate("#/drafts");
    await rounds(6);
    await openDraftRow(s, "d-x");
    await waitFor(() => composeSubject(s.el) === "Old letter", "the held row in the composer");
    await rounds(20);
    expect(composeLine(s.el), "the waiting send's line over the held row").not.toContain(en.compose.statusQueued);
    await press(s.el.querySelector(".view-compose .compose-cancel"), "Cancel");
    const confirm = [...s.el.querySelectorAll<HTMLButtonElement>(".compose-confirm button")]
      .find((b) => b.textContent === en.compose.cancelConfirm);
    if (confirm !== undefined) await press(confirm, "confirm");
    await rounds(20);
    expect(sendPendingInDurableOutbox(s.engine, "compose"), "the held row's Cancel withdrew the waiting send").toBe(true);
  }, 90_000);

  for (const ending of ["refused", "delivered"] as const) {
    it(`a new letter opened by Compose while A flies, then A ${ending}: each keeps its own row`, async () => {
      const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
      if (ending === "delivered") s.spendSentRow.on = true;
      await composerOn(s, "d-a", "Plans for Friday");
      const release = holdTheWire(s);
      if (ending === "refused") Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
      await press(composeSend(s.el)!, "Send A");
      await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
      await composeBy(s, "the rail's Compose");
      expect(shown(s)).toEqual(BLANK);
      await writeLunch(s);
      await rounds(100);
      await act(async () => { release(); });
      await waitFor(() => lunch(s) !== undefined, "the new letter's own row", 240);
      await waitFor(() => footLine().includes(ending === "refused" ? en.compose.statusUnreachable : en.sendingLine.sent), "A's ending");
      s.refuseSend.on = false;
      await rounds(10);
      expect({ ...shown(s), body: lunch(s)?.body ?? "" }, "the new letter")
        .toEqual({ subject: "Lunch on Tuesday", frozen: false, body: expect.stringContaining("Are you free on Tuesday?") });
      const kept = s.store.list<EngineDraft>("draft").filter((d) => d.status === "draft" && d.subject === "Plans for Friday");
      if (ending === "delivered") {
        expect(kept, "a row holding the delivered letter's words").toEqual([]);
        return;
      }
      expect(kept.map((d) => [d.id, d.body]), "A's row").toEqual([["d-a", "Shall we meet at noon?"]]);
      await navigate("#/drafts");
      await waitFor(() => rowMark(s.el, "d-a").includes(en.compose.statusUnreachable), "A's row marked not sent");
    }, 60_000);
  }
});

/* A LETTER WHOSE SEND CAME BACK UNVERIFIED, WITH A SIGNATURE: the send's own save wrote its words
   with the signature folded in, so its row holds them though the row's body is not the screen's. */
describe("a door over a letter whose send came back unverified, with a signature on", () => {
  const SIG = { mb1: "Mila from the office" };
  const AT_ONE = "Plans for Friday, at one";
  const LINK = { to: ["lena@example.invalid"], cc: [], bcc: [], subject: "Hello from a link", body: "" };
  afterEach(() => { vi.restoreAllMocks(); });
  /** A's subject changed and Send pressed (inside the pause, or once it saved); the send saves A, then ends unverified. */
  async function parkA(s: DraftShell, savedFirst: boolean, withFile = false): Promise<void> {
    await composerOn(s, "d-a", "Plans for Friday");
    if (withFile) await attach(s.el.querySelector<HTMLElement>(".view-compose")!, "notes.txt");
    await setSubject(s, AT_ONE);
    if (savedFirst) {
      await waitFor(() => s.store.get<EngineDraft>("draft", "d-a")?.subject === AT_ONE, "the pause's save", 240);
      await rounds(20);
    }
    Object.assign(s.refuseSend, { on: true, saveFirst: true, retryableFirst: 1, unverified: true, code: "send_unreachable", status: 424 });
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.store.get<EngineDraft>("draft", "d-a")?.body?.endsWith(SIG.mb1) === true, "A's send saved its words");
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await waitFor(() => composeLine(s.el).includes(en.compose.statusUnverified), "A unverified", 400);
    s.refuseSend.on = false;
    await rounds(100);
  }
  /** The door's answer: its letter on screen, or the refusal said. */
  const answered = (s: DraftShell, shows: string): Promise<void> => waitFor(() => composeSubject(s.el) === shows
    || toasts().includes(en.drafts.reopenBlockedUnsaved), "an answer to the door", 400);
  const doors: Array<[string, (s: DraftShell) => Promise<void>, string]> = [
    ["a mail link", (s) => s.mailto.open(LINK), LINK.subject],
    ["Write to", writeToKim, ""],
    ["another draft from Drafts", async (s) => { await navigate("#/drafts"); await rounds(6); await openDraftRow(s, "d-b"); }, "Budget review"],
  ];
  for (const [door, open, shows] of doors) {
    it(`pressed inside the pause, ${door} lets it go: its row keeps the words, and no false "not saved"`, async () => {
      const s = await mountShell("#/drafts", [M1_KIM], [A, B], { signatures: SIG });
      await parkA(s, false);
      await open(s);
      await answered(s, shows);
      expect({ shown: composeSubject(s.el), refused: toasts().includes(en.drafts.reopenBlockedUnsaved) }).toEqual({ shown: shows, refused: false });
      const row = s.store.get<EngineDraft>("draft", "d-a");
      expect([row?.subject, row?.body], "A's row").toEqual([AT_ONE, `Shall we meet at noon?\n\n${SIG.mb1}`]);
    }, 90_000);
  }
  it("control: pressed once the pause's save held the words, a mail link lets it go", async () => {
    const s = await mountShell("#/drafts", [M1_KIM], [A, B], { signatures: SIG });
    await parkA(s, true);
    await s.mailto.open(LINK);
    await answered(s, LINK.subject);
    expect(composeSubject(s.el)).toBe(LINK.subject);
  }, 90_000);
  it("after a reload, a mail link lets it go too", async () => {
    const s = await mountShell("#/drafts", [M1_KIM], [A, B], { signatures: SIG });
    await parkA(s, false);
    const drafts = s.store.list<EngineDraft>("draft");
    await unmountAll();
    resetComposerForTest();
    stubDom();
    const now = await mountShell("#/ohbox", [M1_KIM], drafts, { store: s.store, signatures: SIG });
    await rounds(30);
    await navigate("#/compose");
    await waitFor(() => composeSubject(now.el) === AT_ONE, "A back in the composer");
    await now.mailto.open(LINK);
    await answered(now, LINK.subject);
    expect({ shown: composeSubject(now.el), refused: toasts().includes(en.drafts.reopenBlockedUnsaved) }).toEqual({ shown: LINK.subject, refused: false });
  }, 90_000);
  it("words typed since, while the browser stopped storing the letter, are not taken for the press's", async () => {
    const s = await mountShell("#/drafts", [M1_KIM], [A, B], { signatures: SIG });
    await parkA(s, false);
    const setItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, k: string, v: string) {
      if (k.startsWith(COMPOSE_DRAFT_PREFIX)) throw new Error("QuotaExceededError");
      setItem.call(this, k, v);
    });
    await setSubject(s, `${AT_ONE}, typed since`);
    await s.mailto.open(LINK);
    await answered(s, LINK.subject);
    expect({ shown: composeSubject(s.el), refused: toasts().includes(en.drafts.reopenBlockedUnsaved) })
      .toEqual({ shown: `${AT_ONE}, typed since`, refused: true });
  }, 90_000);
  it("a file on screen is on no row, so a mail link leaves the letter and says so", async () => {
    const s = await mountShell("#/drafts", [M1_KIM], [A, B], { signatures: SIG });
    await parkA(s, false, true);
    await s.mailto.open(LINK);
    await answered(s, LINK.subject);
    expect({ shown: composeSubject(s.el), refused: toasts().includes(en.drafts.reopenBlockedUnsaved) }).toEqual({ shown: AT_ONE, refused: true });
  }, 90_000);
});

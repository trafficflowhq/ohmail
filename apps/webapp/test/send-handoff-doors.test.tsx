/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { typeInto } from "./fixtures/rich-editor-driver";
import en from "../messages/en.json";
import {
  act, message, mountShell, press, replySurface, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";
import {
  attach, composeSend, composeSubject, composerOn, dock, dockOn, footButton, footLine, holdTheWire, key,
  letter, navigate, openDraftRow, pickFrom, replySend, rounds, sends, shape, toasts, typeRecipient,
} from "./_handoff-steps.js";

/**
 * EVERY DOOR BACK TO A HANDED-OFF MESSAGE BRINGS THE MESSAGE BACK WHOLE (PR #198 review, two
 * MEDIUM). The hand-off closes the reply dock at the press, and a reopened dock resets its audience,
 * files and From. Only the foot line's Open put them back, so a refusal reopened from the toast (the
 * only door under 1024px with the reader open), by pressing Reply again, or from its Drafts row went
 * a second time to the computed sender, from the default address, without its files: a private
 * reply to the person who had been taken off it. One restore now serves every door.
 */

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  setOnline(true);
});
afterEach(async () => {
  setOnline(true);
  await unmountAll();
});
function setOnline(on: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
}

const WORDS = "Between us: I would not take this offer";
/** Reply to m1, take the computed sender off, name a teammate, send from the second address, attach a file. */
async function editedReply(s: DraftShell): Promise<void> {
  await dockOn(s, "m1");
  await act(async () => { dock(s.el)!.querySelector<HTMLButtonElement>(".reply-head-btn")!.click(); });
  await act(async () => { dock(s.el)!.querySelector<HTMLElement>(".reply-rcpt .rcp-chip .rcp-chip-x")!.click(); });
  await typeRecipient(s.el, "To", "teammate@example.invalid");
  await pickFrom(s.el, "mb2");
  await attach(dock(s.el)!, "terms.txt");
  await act(async () => { typeInto(replySurface(s.el)!, WORDS); });
}
/** Press Send with the wire held and a refusal for good armed. */
async function pressRefused(s: DraftShell, handOff: boolean): Promise<() => void> {
  const release = holdTheWire(s);
  Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
  await act(async () => { replySend(s.el)!.click(); });
  if (handOff) await waitFor(() => replySurface(s.el) == null, "the dock closed at the hand-off");
  return release;
}
/** The words are back in a dock: press Send again, healthy, and return both presses. */
async function sendAgain(s: DraftShell, words = WORDS): Promise<[string, string]> {
  s.refuseSend.on = false;
  await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes(words), "the words back");
  await rounds(10, 20);
  const again = replySend(s.el);
  expect(again?.disabled, "Send is ready again").toBe(false);
  await act(async () => { again!.click(); });
  await waitFor(() => sends(s).length >= 2, "the second press");
  return [shape(sends(s)[0]), shape(sends(s)[1])];
}
const FIRST = "to=teammate@example.invalid cc= bcc= from=mb2 files=terms.txt";

describe("a refused handed-off reply, by every door back", () => {
  it("control: from 1024px, the foot line's Open", async () => {
    stubDom();
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true, secondMailbox: true });
    await editedReply(s);
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.reply.statusUnreachable), "the refusal in the foot");
    await press(footButton(en.sendingLine.open), "the foot line's Open");
    const [first, second] = await sendAgain(s);
    expect(first).toBe(FIRST);
    expect(second).toBe(first);
  }, 60_000);

  it("under 1024px in the reader sheet, the toast's Open", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true, secondMailbox: true });
    await editedReply(s);
    expect(document.body.classList.contains("reading"), "the reply is in the sheet").toBe(true);
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => toasts().includes(en.reply.statusUnreachable), "the refusal in the toast");
    await press(document.querySelector(".toast-held .toast-act"), "the toast's Open");
    const [first, second] = await sendAgain(s);
    expect(first).toBe(FIRST);
    expect(second).toBe(first);
  }, 60_000);

  it("control: under 1024px with no hand-off, the dock stays", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: false, secondMailbox: true });
    await editedReply(s);
    const release = await pressRefused(s, false);
    await act(async () => { release(); });
    await waitFor(() => (dock(s.el)?.textContent ?? "").includes(en.reply.statusUnreachable), "the refusal in the dock");
    const [first, second] = await sendAgain(s);
    expect(first).toBe(FIRST);
    expect(second).toBe(first);
  }, 60_000);

  it("from 1024px, Reply pressed again while the handed-off send is on the wire", async () => {
    stubDom();
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true, secondMailbox: true });
    await editedReply(s);
    const release = await pressRefused(s, true);
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the dock back on its lane");
    await act(async () => { release(); });
    await waitFor(() => (dock(s.el)?.textContent ?? "").includes(en.reply.statusUnreachable), "the refusal in the dock");
    const [first, second] = await sendAgain(s);
    expect(first).toBe(FIRST);
    expect(second).toBe(first);
  }, 60_000);

  it("from 1024px, the refusal stands in the foot and the person presses Reply instead of Open", async () => {
    stubDom();
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true, secondMailbox: true });
    await editedReply(s);
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.reply.statusUnreachable), "the refusal in the foot");
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "the dock back on its lane");
    const [first, second] = await sendAgain(s);
    expect(first).toBe(FIRST);
    expect(second).toBe(first);
  }, 60_000);

  it("from 1024px, the refused row opened from Drafts", async () => {
    stubDom();
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true, secondMailbox: true });
    await editedReply(s);
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.reply.statusUnreachable), "the refusal in the foot");
    await navigate("#/drafts");
    await waitFor(() => s.el.querySelector(".view-drafts .draft-row .draft-open") != null, "the refused row in Drafts");
    await press(s.el.querySelector(".view-drafts .draft-row .draft-open"), "open the refused row");
    const [first, second] = await sendAgain(s);
    expect(first).toBe(FIRST);
    expect(second).toBe(first);
  }, 60_000);

  it("under 1024px, a reply-all reopened from the toast keeps everyone", async () => {
    stubDom({ narrow: true });
    const m1 = message("m1", {
      to: [{ address: "me@example.invalid", name: "Me" }, { address: "pat@example.invalid", name: "Pat" }],
      cc: [{ address: "kim@example.invalid", name: "Kim" }],
    } as never);
    const s = await mountShell("#/ohbox", [m1], [], { handOff: true });
    await dockOn(s, "m1", "R", true);
    await act(async () => { typeInto(replySurface(s.el)!, "Agreed, let us go ahead"); });
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => toasts().includes(en.reply.statusUnreachable), "the refusal in the toast");
    await press(document.querySelector(".toast-held .toast-act"), "the toast's Open");
    const [first, second] = await sendAgain(s, "Agreed, let us go ahead");
    expect(first).toContain("kim@example.invalid");
    expect(second).toBe(first);
  }, 60_000);

  it("a forward reopened from the toast keeps its recipient and its files", async () => {
    stubDom({ narrow: true });
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await dockOn(s, "m1", "F", true);
    await typeRecipient(s.el, "To", "friend@example.invalid");
    await attach(dock(s.el)!, "notes.txt");
    await act(async () => { typeInto(replySurface(s.el)!, "Have a look at this"); });
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => toasts().includes(en.reply.statusUnreachable), "the refusal in the toast");
    await press(document.querySelector(".toast-held .toast-act"), "the toast's Open");
    const [first, second] = await sendAgain(s, "Have a look at this");
    expect(first).toContain("to=friend@example.invalid");
    expect(first).toContain("files=notes.txt");
    expect(second).toBe(first);
  }, 60_000);

  it("a delivered reply is spent: the next reply to that message starts from the computed audience", async () => {
    stubDom();
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true, secondMailbox: true });
    await editedReply(s);
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => footLine().includes(en.sendingLine.sent), "the first reply sent");
    await rounds(30);
    await key("r");
    await waitFor(() => replySurface(s.el) != null, "a new reply");
    await rounds(6, 20);
    const d = dock(s.el)!;
    expect(d.querySelector(".reply-head")?.textContent ?? "", "the next reply is addressed as the last one was").toContain("Reply to The colleague");
    expect(d.textContent ?? "").not.toContain("teammate@example.invalid");
    expect(d.querySelectorAll(".compose-attach-item").length, "the next reply carries the last one's file").toBe(0);
    const from = [...d.querySelectorAll<HTMLSelectElement>("select")].find((x) => [...x.options].some((o) => o.value === "mb2"));
    expect(from?.value, "the next reply sends from the last one's address").toBe("mb1");
  }, 60_000);
});

describe("a refused handed-off compose whose composer moved on", () => {
  it("its refused row opened from Drafts brings its file back", async () => {
    stubDom();
    const A = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
    const B = letter("d-b", "Quarterly notes", "Three paragraphs", { name: "Noor", address: "noor@example.invalid" });
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await composerOn(s, "d-a", "Plans for Friday");
    await attach(s.el.querySelector<HTMLElement>(".view-compose")!, "agenda.txt");
    const release = holdTheWire(s);
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => s.el.querySelector(".view-compose") == null, "the composer let go of A");
    await navigate("#/drafts");
    await composerOn(s, "d-b", "Quarterly notes");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.compose.statusUnreachable), "A's refusal in the foot");
    s.refuseSend.on = false;
    await navigate("#/drafts");
    await openDraftRow(s, "d-a");
    await waitFor(() => composeSubject(s.el) === "Plans for Friday", "the composer on A again");
    await rounds(6, 20);
    await press(composeSend(s.el)!, "Send A again");
    await waitFor(() => sends(s).length >= 2, "the second press");
    expect(shape(sends(s)[0])).toContain("files=agenda.txt");
    expect(shape(sends(s)[1]), "the file A was sent with").toContain("files=agenda.txt");
  }, 60_000);
});

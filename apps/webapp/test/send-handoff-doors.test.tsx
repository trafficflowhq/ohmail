/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { typeInto } from "./fixtures/rich-editor-driver";
import en from "../messages/en.json";
import {
  act, message, mountShell, press, ROSTER, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";
import {
  attach, composeSend, composeSubject, composerOn, holdTheWire, letter, navigate, openDraftRow, rounds, sends, shape,
} from "./_handoff-steps.js";
import { settleEditor } from "./_first-paint.js";

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
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 1024 });
  await unmountAll();
});
function setOnline(on: boolean): void {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
}

/*
 * THE NEW SHELL's PARTS, by role and name (as `send-handoff.test.tsx` reads them). The sidebar's foot line is the
 * frame's one notice slot (the rail's foot from a desk's width, the bar over the columns on a phone's), each line of
 * a send one notice there, its acts by name; under 1024px today's sheet covered the foot and its toast said the
 * refusal with Open: on a phone's width the new frame says it in the notice bar at its top, over the letter, with
 * its Open (the toast's door is that bar's act). The open letter is the region "Open message": the reply is the
 * composer section named "Reply to <name>", its words the textbox "Reply body" (a forward's "Forward body"), its
 * verbs the toolbar "Actions", its people the groups "To", "Cc" and "Bcc", its From the button "From <address>:
 * choose another address" with its menu "From", its files the kit's tiles with Attach's file input beside them.
 */
const slotNotices = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.fr-railnotice [role="status"], .fr-noticebar [role="status"]')];
const slotBehind = (): string[] => {
  const more = document.querySelector<HTMLButtonElement>('.fr-railnotice button[aria-haspopup="menu"], .fr-noticebar button[aria-haspopup="menu"]');
  if (more === null) return [];
  const name = more.getAttribute("aria-label") ?? "";
  return [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${name}"] [role="menuitem"]`)].map((n) => n.textContent ?? "");
};
/** What the foot's slot says, every notice. */
const footLine = (): string => [...slotNotices().map((n) => n.textContent ?? ""), ...slotBehind()].join(" | ");
/** A notice's act by its name. */
const footButton = (label: string): HTMLButtonElement | null =>
  slotNotices().flatMap((n) => [...n.querySelectorAll<HTMLButtonElement>("button")]).find((b) => (b.textContent ?? "").trim() === label) ?? null;
/** On a phone's width: what the notice bar over the sheet says, and its Open (today's toast and its Open). */
const barNotices = (): HTMLElement[] => [...document.querySelectorAll<HTMLElement>('.fr-frame[data-rail="dock"] > .fr-noticebar [role="status"]')];
const overSheet = (): string => barNotices().map((n) => n.textContent ?? "").join(" | ");
const barOpen = (): HTMLButtonElement | null =>
  barNotices().flatMap((n) => [...n.querySelectorAll<HTMLButtonElement>("button")]).find((b) => (b.textContent ?? "").trim() === en.sendingLine.open) ?? null;
const openRegion = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
/** The reply standing on the open letter (today's dock). */
const dock = (_el?: HTMLElement): HTMLElement | null => replySurface()?.closest<HTMLElement>("section[aria-label]") ?? null;
const replySurface = (_el?: HTMLElement): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"], [role="textbox"][aria-label="Forward body"]') ?? null;
/** A control of the open letter by its name. */
const actionIn = (name: string): HTMLButtonElement | undefined =>
  [...(openRegion()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.getAttribute("aria-label") === name);
const replySend = (_el?: HTMLElement): HTMLButtonElement | undefined =>
  [...(openRegion()?.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Actions"] button') ?? [])]
    .find((b) => b.getAttribute("aria-label") === "Send");
const row = (el: HTMLElement, id: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='${id}']`);
/** The From line's choice: the button that names the address the reply goes from. */
const fromButton = (): HTMLButtonElement | undefined =>
  [...(dock()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => /^From .+: choose another address$/.test(b.getAttribute("aria-label") ?? ""));
/** The reply's own files, as its tiles. */
const replyFiles = (): HTMLElement[] => [...(dock()?.querySelectorAll<HTMLElement>(".oh-file") ?? [])];

async function key(k: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...init }));
  });
  await settleEditor();
}
/** Select a row in the Ohbox and open its reply with `k` (r, R, F). */
async function dockOn(s: DraftShell, id: string, k = "r", shiftKey = false): Promise<void> {
  await waitFor(() => row(s.el, id) != null, `the row ${id}`);
  await press(row(s.el, id), `the row ${id}`);
  await key(k, shiftKey ? { shiftKey: true } : {});
  await waitFor(() => replySurface(s.el) != null, `the dock on ${id}`);
}
async function typeRecipient(_el: HTMLElement, label: string, text: string): Promise<void> {
  const input = openRegion()!.querySelector<HTMLInputElement>(`[role="group"][aria-label="${label}"] input[aria-label="${label}"]`)!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.setSelectionRange(text.length, text.length);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}
/** Choose the address the reply goes from, in its From menu. */
async function pickFrom(_el: HTMLElement, address: string): Promise<void> {
  const from = fromButton();
  expect(from, "a From pick is offered").toBeDefined();
  await press(from!, "the From line");
  const item = [...document.querySelectorAll<HTMLElement>('[role="menu"][aria-label="From"] [role^="menuitem"]')]
    .find((x) => (x.textContent ?? "").trim() === address);
  await press(item ?? null, `From ${address}`);
}
/** Attach a small file through the reply's own Attach (the kit's file input beside its button). */
async function attachTo(name: string): Promise<void> {
  const input = dock()?.querySelector<HTMLInputElement>('.oh-attach input[type="file"]') ?? null;
  expect(input, "the reply offers Attach").not.toBeNull();
  const file = new File([new Uint8Array(512)], name, { type: "text/plain" });
  Object.defineProperty(input!, "files", { value: [file], configurable: true });
  await act(async () => { input!.dispatchEvent(new Event("change", { bubbles: true })); });
  await rounds(8, 20);
}
/** The frame's plan reads the window's own width, as a phone hands it. */
function phoneWidth(): void {
  stubDom({ narrow: true });
  Object.defineProperty(window, "innerWidth", { configurable: true, value: 390 });
}

const WORDS = "Between us: I would not take this offer";
/** Reply to m1, take the computed sender off, name a teammate, send from the second address, attach a file. */
async function editedReply(s: DraftShell): Promise<void> {
  await dockOn(s, "m1");
  await act(async () => { actionIn("Change recipients")!.click(); });
  await act(async () => { actionIn("Remove The colleague")!.click(); });
  await typeRecipient(s.el, "To", "teammate@example.invalid");
  await pickFrom(s.el, "me2@example.invalid");
  await attachTo("terms.txt");
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
    phoneWidth();
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true, secondMailbox: true });
    await editedReply(s);
    // The sheet: the letter stands over the list, on one column.
    expect(document.querySelector(".fr-frame[data-letter]") != null && openRegion() != null, "the reply is in the sheet").toBe(true);
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => overSheet().includes(en.reply.statusUnreachable), "the refusal in the toast");
    await press(barOpen(), "the toast's Open");
    const [first, second] = await sendAgain(s);
    expect(first).toBe(FIRST);
    expect(second).toBe(first);
  }, 60_000);

  it("control: under 1024px with no hand-off, the dock stays", async () => {
    phoneWidth();
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
    phoneWidth();
    const m1 = message("m1", {
      to: [{ address: "me@example.invalid", name: "Me" }, { address: "pat@example.invalid", name: "Pat" }],
      cc: [{ address: "kim@example.invalid", name: "Kim" }],
    } as never);
    const s = await mountShell("#/ohbox", [m1], [], { handOff: true });
    await dockOn(s, "m1", "R", true);
    await act(async () => { typeInto(replySurface(s.el)!, "Agreed, let us go ahead"); });
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => overSheet().includes(en.reply.statusUnreachable), "the refusal in the toast");
    await press(barOpen(), "the toast's Open");
    const [first, second] = await sendAgain(s, "Agreed, let us go ahead");
    expect(first).toContain("kim@example.invalid");
    expect(second).toBe(first);
  }, 60_000);

  it("a forward reopened from the toast keeps its recipient and its files", async () => {
    phoneWidth();
    const s = await mountShell("#/ohbox", [message("m1")], [], { handOff: true });
    await dockOn(s, "m1", "F", true);
    await typeRecipient(s.el, "To", "friend@example.invalid");
    await attachTo("notes.txt");
    await act(async () => { typeInto(replySurface(s.el)!, "Have a look at this"); });
    const release = await pressRefused(s, true);
    await act(async () => { release(); });
    await waitFor(() => overSheet().includes(en.reply.statusUnreachable), "the refusal in the toast");
    await press(barOpen(), "the toast's Open");
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
    expect(d.getAttribute("aria-label") ?? "", "the next reply is addressed as the last one was").toContain("Reply to The colleague");
    expect(d.textContent ?? "").not.toContain("teammate@example.invalid");
    expect(replyFiles().length, "the next reply carries the last one's file").toBe(0);
    // The From line names the address it goes from: the first mailbox's (`mb1`), not the last reply's (`mb2`).
    expect(fromButton()?.getAttribute("aria-label"), "the next reply sends from the last one's address")
      .toBe(`From ${ROSTER[0]!.address}: choose another address`);
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

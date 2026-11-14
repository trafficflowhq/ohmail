/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { NONE } from "@ohmail/app/host";
import en from "../messages/en.json";
import { typeInto } from "./fixtures/rich-editor-driver";
import { settleEditor } from "./_first-paint.js";
import {
  act, message, mountShell, press, stubDom, unmountAll, waitFor, type DraftShell,
} from "./_draft-shell.js";
import {
  attach, composeLine, composeSend, composeSubject, composerOn, holdTheWire, letter, navigate, rounds, sends, shape,
} from "./_handoff-steps.js";
import { letter as letterEditor, letterText } from "./_writing-shell.js";

/**
 * THE FOOT LINE SAYS WHICH MESSAGE EACH OUTCOME IS ABOUT, AND A STANDING ONE HIDES NOTHING (PR #198
 * review, MEDIUM). A refused reply used to stand on the line as an unnamed "Not sent… send it again"
 * that outranked everything: the next reply's "Sending to Jonas…" and its "Sent" never showed, and
 * the toast that would have said it was dropped because a line was seen. The person read the
 * standing sentence as being about the message they had just sent.
 */

/*
 * THE NEW SHELL's PARTS, by role and name (as `send-handoff.test.tsx` reads them). The sidebar's foot line is the
 * frame's one notice slot, each line of a send one notice there, read with the notices behind it ("N more") by their
 * titles; its acts by name. A toast is the frame's report. The open letter is the region "Open message": the reply's
 * words the textbox "Reply body", its verbs the toolbar "Actions". The letters are opened at the Ohbox.
 */
const slotNotices = (): HTMLElement[] =>
  [...document.querySelectorAll<HTMLElement>('.fr-railnotice [role="status"], .fr-noticebar [role="status"]')];
/**
 * What stands behind the slot's first notice, by title, as a person reads it: the slot's "N more" opened, its list
 * read, and closed again where it was closed (a glance). Each press is drawn before the read, as a person's is: a
 * synchronous `act` flushes it, so the reads stay synchronous.
 */
function slotBehind(): string[] {
  const more = document.querySelector<HTMLButtonElement>('.fr-railnotice button[aria-haspopup="menu"], .fr-noticebar button[aria-haspopup="menu"]');
  if (more === null) return [];
  const name = more.getAttribute("aria-label") ?? "";
  const items = (): string[] =>
    [...document.querySelectorAll<HTMLElement>(`[role="menu"][aria-label="${name}"] [role^="menuitem"]`)].map((n) => n.textContent ?? "");
  if (more.getAttribute("aria-expanded") === "true") return items();
  void act(() => { more.click(); });
  const read = items();
  void act(() => { more.click(); });
  return read;
}
/** What the foot's slot says, every notice: the first whole, those behind it by their titles. */
const footLine = (): string => [...slotNotices().map((n) => n.textContent ?? ""), ...slotBehind()].join(" | ");
const toasts = (): string => [...document.querySelectorAll('.fr-report [role="status"]')].map((n) => n.textContent ?? "").join(" | ");
/** A notice's act by its name. */
const footButton = (label: string): HTMLButtonElement | null =>
  slotNotices().flatMap((n) => [...n.querySelectorAll<HTMLButtonElement>("button")]).find((b) => (b.textContent ?? "").trim() === label) ?? null;
const openRegion = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="region"][aria-label="Open message"]');
const replySurface = (_el?: HTMLElement): HTMLElement | null =>
  openRegion()?.querySelector<HTMLElement>('[role="textbox"][aria-label="Reply body"], [role="textbox"][aria-label="Forward body"]') ?? null;
const replySend = (_el?: HTMLElement): HTMLButtonElement | undefined =>
  [...(openRegion()?.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Actions"] button') ?? [])]
    .find((b) => b.getAttribute("aria-label") === "Send");
const row = (el: HTMLElement, id: string): HTMLElement | null =>
  el.querySelector<HTMLElement>(`section[aria-label="Messages"] [role=option][data-id='${id}']`);
/** Select a row in the Ohbox, open its reply with `r`, and type `words`. */
async function replyOn(s: DraftShell, id: string, words: string): Promise<void> {
  await waitFor(() => row(s.el, id) != null, `the row ${id}`);
  await press(row(s.el, id), `the row ${id}`);
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
  });
  await settleEditor();
  await waitFor(() => replySurface(s.el) != null, `the dock on ${id}`);
  await act(async () => { typeInto(replySurface(s.el)!, words); });
}

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});
afterEach(async () => { await unmountAll(); });

const SENDER = "colleague@example.invalid";
const mila = message("m1", { from: { address: SENDER, name: "Mila" }, subject: "Thursday plans" } as never);
const jonas = message("m2", { from: { address: SENDER, name: "Jonas" }, subject: "Lunch" } as never);
const line = en.sendingLine as Record<string, string>;
const about = (name: string, subject: string): string =>
  (line.aboutBoth ?? "(no aboutBoth line)").replace("{name}", name).replace("{subject}", subject);
const sentTo = (name: string): string => (line.sentTo ?? "(no sentTo line)").replace("{name}", name);

/** Read the foot line and the toasts every 50 ms for `ms`; every distinct reading, in order. */
async function sample(ms: number): Promise<{ foot: string[]; toast: string[] }> {
  const foot: string[] = [];
  const toast: string[] = [];
  for (let t = 0; t < ms; t += 50) {
    const f = footLine();
    const o = toasts();
    if (foot[foot.length - 1] !== f) foot.push(f);
    if (toast[toast.length - 1] !== o) toast.push(o);
    await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
  }
  return { foot, toast };
}

/** Mila's reply handed off and ended as `arm` makes it; its ending stands when this returns. */
async function milaEnds(s: DraftShell, arm: () => void, standing: string): Promise<void> {
  await replyOn(s, "m1", "Thursday works for me");
  const release = holdTheWire(s);
  arm();
  await act(async () => { replySend(s.el)!.click(); });
  await waitFor(() => replySurface(s.el) == null, "Mila's dock closed at the hand-off");
  await act(async () => { release(); });
  await waitFor(() => footLine().includes(standing), "Mila's ending standing on the foot");
  s.refuseSend.on = false;
}

async function refuseReply(s: DraftShell, id: string, words: string): Promise<void> {
  await replyOn(s, id, words);
  const release = holdTheWire(s);
  Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
  await press(replySend(s.el) ?? null, "Send reply");
  await waitFor(() => replySurface(s.el) == null, "the reply handed off");
  await act(async () => { release(); });
  await waitFor(() => footLine().includes(en.reply.statusUnreachable) || footLine().includes("messages weren't sent"), "the send ended");
}
/** Jonas's reply, handed off and delivered; the line and the toasts while it is out and after. */
async function jonasGoes(s: DraftShell): Promise<{ during: string[]; after: { foot: string[]; toast: string[] } }> {
  await replyOn(s, "m2", "Yes, see you then");
  const release = holdTheWire(s);
  await act(async () => { replySend(s.el)!.click(); });
  await waitFor(() => replySurface(s.el) == null, "Jonas's dock closed at the hand-off");
  const during = (await sample(300)).foot;
  await act(async () => { release(); });
  await waitFor(() => sends(s).length >= 2, "Jonas's send on the wire");
  return { during, after: await sample(1_500) };
}
const saidSent = (after: { foot: string[]; toast: string[] }): boolean =>
  after.foot.some((f) => f.includes(en.sendingLine.sent)) || after.toast.some((t) => t.includes(en.reply.toastSent));

describe("a standing ending on the foot line, then another healthy send", () => {
  for (const code of ["send_unreachable", "send_failed"] as const) {
    it(`a refusal (${code}) names Mila and her subject, and Jonas's send is seen going and gone`, async () => {
      const s = await mountShell("#/ohbox", [mila, jonas], [], { handOff: true });
      const refusal = code === "send_unreachable" ? en.reply.statusUnreachable : en.reply.statusFailed;
      await milaEnds(s, () => Object.assign(s.refuseSend, { on: true, code, status: code === "send_unreachable" ? 424 : 409 }), refusal);
      expect.soft(footLine(), "the standing line says whose message it is").toContain(about("Mila", "Thursday plans"));
      const { during, after } = await jonasGoes(s);
      expect(during.some((f) => f.includes("Sending to Jonas…")), "Jonas's send was hidden while it went").toBe(true);
      expect(saidSent(after), "Jonas's delivery was said nowhere").toBe(true);
      expect(after.foot.every((f) => f.includes(refusal)), "Mila's ending stopped standing").toBe(true);
      await press(footButton(en.sendingLine.open), "Mila's Open");
      await waitFor(() => (replySurface(s.el)?.textContent ?? "").includes("Thursday works for me"), "Mila's words back");
    }, 60_000);
  }

  it("a send waiting on the outbox names Mila and hides nothing", async () => {
    const s = await mountShell("#/ohbox", [mila, jonas], [], { handOff: true });
    await milaEnds(s, () => Object.assign(s.refuseSend, { on: true, retryableFirst: 1, code: "send_failed", status: 503 }), en.reply.statusQueued);
    expect.soft(footLine()).toContain(about("Mila", "Thursday plans"));
    const { during, after } = await jonasGoes(s);
    expect(during.some((f) => f.includes("Sending to Jonas…"))).toBe(true);
    expect(saidSent(after)).toBe(true);
  }, 60_000);

  it("an unverified ending names Mila and hides nothing", async () => {
    const s = await mountShell("#/ohbox", [mila, jonas], [], { handOff: true });
    await milaEnds(s, () => Object.assign(s.refuseSend, { on: true, unverified: true }), en.reply.statusUnverified);
    expect.soft(footLine()).toContain(about("Mila", "Thursday plans"));
    const { during, after } = await jonasGoes(s);
    expect(during.some((f) => f.includes("Sending to Jonas…"))).toBe(true);
    expect(saidSent(after)).toBe(true);
  }, 60_000);

  it("a delivery says whom it went to", async () => {
    const s = await mountShell("#/ohbox", [mila, jonas], [], { handOff: true });
    await replyOn(s, "m1", "On my way");
    await act(async () => { replySend(s.el)!.click(); });
    await waitFor(() => footLine().includes(sentTo("Mila")), "Sent to Mila");
    expect(toasts()).not.toContain(en.reply.toastSent);
  }, 60_000);

  it("each failed reply can be opened from its own warning when Drafts is unavailable", async () => {
    const s = await mountShell("#/ohbox", [mila, jonas], [], { handOff: true, places: { drafts: NONE } });
    expect(screen.queryByRole("button", { name: /^Drafts\b/ })).toBeNull();
    await refuseReply(s, "m1", "Thursday works for me");
    await refuseReply(s, "m2", "Yes, see you then");
    await waitFor(() => sends(s).length === 2, "both replies tried to send");
    await waitFor(() => footLine().includes(about("Mila", "Thursday plans")) && footLine().includes(about("Jonas", "Lunch")), "both failed replies standing by name");

    const more = document.querySelector<HTMLButtonElement>('.fr-railnotice button[aria-haspopup="menu"], .fr-noticebar button[aria-haspopup="menu"]');
    await press(more, "more warnings");
    const jonasNotice = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((el) => el.textContent?.includes(about("Jonas", "Lunch")));
    await press(jonasNotice ?? null, "Jonas's warning");
    expect(slotNotices().some((n) => n.textContent?.includes(en.reply.statusUnreachable))).toBe(true);
    await press(footButton(en.sendingLine.open), "Jonas's Open");
    await waitFor(() => replySurface(s.el)?.textContent?.includes("Yes, see you then") === true, "Jonas's words back");
    expect(footLine()).toContain(about("Mila", "Thursday plans"));
    expect(footLine()).toContain(en.reply.statusUnreachable);

    await press(footButton(en.sendingLine.open), "Mila's Open");
    await waitFor(() => replySurface(s.el)?.textContent?.includes("Thursday works for me") === true, "Mila's words back");
    expect(sends(s)).toHaveLength(2);
    expect(window.location.hash).toMatch(/^#\/ohbox/);
  }, 60_000);
});

describe("one compose lane, two messages", () => {
  const A = letter("d-a", "Plans for Friday", "Shall we meet at noon?");
  const B = letter("d-b", "Budget review", "The numbers for the fourth quarter.", { name: "Noah", address: "noah@example.invalid" });
  const draftRow = (el: HTMLElement, id: string): HTMLElement | null =>
    el.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`);
  const rowMark = (el: HTMLElement, id: string): string => draftRow(el, id)?.getAttribute("aria-description") ?? "";
  /** A, with a file, handed off and refused while the composer still holds it; then B opened in the composer. */
  async function aRefusedThenB(s: DraftShell): Promise<void> {
    await composerOn(s, "d-a", "Plans for Friday");
    await attach(letterEditor(s.el)!, "agenda.txt");
    const release = holdTheWire(s);
    Object.assign(s.refuseSend, { on: true, code: "send_unreachable", status: 424 });
    await press(composeSend(s.el)!, "Send A");
    await waitFor(() => letterEditor(s.el) == null, "the composer let go of A");
    await act(async () => { release(); });
    await waitFor(() => footLine().includes(en.compose.statusUnreachable), "A's refusal standing");
    s.refuseSend.on = false;
    await navigate("#/drafts");
    await composerOn(s, "d-b", "Budget review");
  }

  it("the refused letter keeps standing, named, while the next letter goes", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await aRefusedThenB(s);
    const second = holdTheWire(s);
    await press(composeSend(s.el)!, "Send B");
    await waitFor(() => letterEditor(s.el) == null, "the composer let go of B");
    await rounds(4);
    expect(footLine(), "B's send hidden").toContain("Sending to Noah…");
    expect(footLine(), "A's refusal dropped by B's press").toContain(en.compose.statusUnreachable);
    expect.soft(footLine(), "A's refusal names its message").toContain(about("Mila", "Plans for Friday"));
    await act(async () => { second(); });
    await waitFor(() => footLine().includes(sentTo("Noah")), "Sent to Noah");
    expect(footLine(), "A's refusal dropped by B's delivery").toContain(en.compose.statusUnreachable);
  }, 60_000);

  it("once the next letter went, the refused letter's Open brings that letter back with its file; Drafts says it was not sent until it goes", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    s.spendSentRow.on = true;
    await aRefusedThenB(s);
    const second = holdTheWire(s);
    await press(composeSend(s.el)!, "Send B");
    await waitFor(() => letterEditor(s.el) == null, "the composer let go of B");
    await act(async () => { second(); });
    await waitFor(() => footLine().includes(sentTo("Noah")), "Sent to Noah");
    await press(footButton(en.sendingLine.open), "A's Open");
    await waitFor(() => composeSubject(s.el) === "Plans for Friday", "A's Open brought A back");
    expect(letterText(s.el)?.textContent ?? "").toContain("Shall we meet at noon?");
    expect(letterEditor(s.el)?.textContent ?? "", "A's file").toContain("agenda.txt");
    await navigate("#/drafts");
    await waitFor(() => draftRow(s.el, "d-a") != null, "A in Drafts");
    expect(rowMark(s.el, "d-a"), "A's row stopped saying it was not sent").toContain(en.compose.statusUnreachable);
    await navigate("#/compose");
    await waitFor(() => composeSubject(s.el) === "Plans for Friday", "the composer still on A");
    await press(composeSend(s.el)!, "Send A again");
    await waitFor(() => footLine().includes(sentTo("Mila")), "A sent");
    expect(shape(sends(s)[2]), "the file A went with").toContain("files=agenda.txt");
    await navigate("#/drafts");
    await rounds(6);
    expect(draftRow(s.el, "d-a"), "A sent and still in Drafts").toBeNull();
  }, 60_000);

  it("while the next letter is still on its way, the refused letter's Open brings that letter back to wait for it", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await aRefusedThenB(s);
    const second = holdTheWire(s);
    await press(composeSend(s.el)!, "Send B");
    await waitFor(() => letterEditor(s.el) == null, "the composer let go of B");
    await press(footButton(en.sendingLine.open), "A's Open");
    await waitFor(() => composeSubject(s.el) === "Plans for Friday", "A's Open brought A back");
    expect(composeLine(s.el)).toContain(en.compose.statusPreviousSending);
    await act(async () => { second(); });
    await waitFor(() => footLine().includes(sentTo("Noah")), "Sent to Noah");
    expect(composeSubject(s.el), "B's delivery cleared A").toBe("Plans for Friday");
  }, 60_000);

  it("while the next letter is being written, the refused letter's Open says why it waits, and A keeps its place", async () => {
    const s = await mountShell("#/drafts", [message("m1")], [A, B], { handOff: true });
    await aRefusedThenB(s);
    await press(footButton(en.sendingLine.open), "A's Open");
    await waitFor(() => toasts().includes(en.compose.notSentOpenBlocked), "why A's Open waits");
    expect(composeSubject(s.el), "A's Open replaced the letter being written").toBe("Budget review");
    expect(footLine(), "A's ending left the foot line unopened").toContain(en.compose.statusUnreachable);
    await navigate("#/drafts");
    await waitFor(() => draftRow(s.el, "d-a") != null, "A in Drafts");
    expect(rowMark(s.el, "d-a"), "A's row stopped saying it was not sent").toContain(en.compose.statusUnreachable);
  }, 60_000);
});

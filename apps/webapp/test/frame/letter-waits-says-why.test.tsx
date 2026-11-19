/** @vitest-environment jsdom */
/**
 * A LETTER WHOSE SEND WAITS SAYS WHY NO NEW LETTER OPENS, OVER THE NEW SHELL's DOOR (the switch's point 72). A letter
 * pressed while no signal reaches the server waits to be sent, and its words are in no row yet; asked for a new letter,
 * the place that writes keeps the waiting one on screen (the composition's rule, unchanged) and its note says the
 * composition's own sentence why, before the send line's words. Nothing is lost, and nothing is sent twice.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import { typeInto } from "../fixtures/rich-editor-driver";
import { settleEditor } from "../_first-paint.js";
import { act, message, mountShell, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";

beforeEach(() => {
  try {
    window.localStorage.clear();
    window.sessionStorage.clear();
  } catch {
    /* storage blocked */
  }
  stubDom();
  Element.prototype.animate ??= (() => ({ cancel() {}, finished: Promise.resolve() })) as unknown as Element["animate"];
});
afterEach(async () => {
  await unmountAll();
});

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
const pause = async (ms: number): Promise<void> => {
  await act(async () => { await new Promise((r) => setTimeout(r, ms)); });
};
const said = (): string[] => [...document.querySelectorAll('[role="status"]')].map((n) => (n.textContent ?? "").trim());
const sendVerb = (): HTMLButtonElement | undefined =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="toolbar"][aria-label="Send or discard"] button')].find(
    (b) => b.getAttribute("aria-label") === "Send",
  );
const letterText = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="textbox"][aria-label="Message"]');
const subjectField = (): HTMLTextAreaElement | HTMLInputElement | null =>
  document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Subject"], input[aria-label="Subject"]');

async function setInput(input: HTMLInputElement | HTMLTextAreaElement, value: string): Promise<void> {
  const proto = input instanceof window.HTMLTextAreaElement ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
/** The `c` key pressed where no box has the keys: the way to a new letter. */
async function pressC(): Promise<void> {
  await act(async () => {
    (document.activeElement as HTMLElement | null)?.blur?.();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true, cancelable: true }));
  });
  await settleEditor();
}

/** The rail's way to write, pressed: the other way to a new letter. */
async function railWrite(): Promise<void> {
  const entry = document.querySelector<HTMLElement>('[aria-keyshortcuts="c"]');
  expect(entry, "the rail's way to write").not.toBeNull();
  await act(async () => { entry!.click(); });
  await settleEditor();
}

describe("a letter whose send waits, and a new letter asked for", () => {
  it("pressed with no signal: a new letter does not open, and the waiting letter says why", async () => {
    const s = await mountShell("#/ohbox", [message("m1")]);
    s.offline.on = true;
    await pressC();
    await waitFor(() => letterText() != null, "the letter");
    await setInput(document.querySelector<HTMLInputElement>('[role="combobox"][aria-label="To"]')!, "mila@example.invalid, ");
    await setInput(subjectField()!, "Plans typed");
    await act(async () => { typeInto(letterText()! as never, "Shall we meet?"); });
    await settleEditor();
    await act(async () => { sendVerb()!.click(); });
    await pause(300);
    await railWrite();
    await pause(300);
    expect(subjectField()?.value, "the waiting letter left the screen, or a blank letter took its place").toBe("Plans typed");
    expect(said(), "the letter does not say why no new letter opened").toContain(en.compose.waitingNotSaved);
    expect(said().indexOf(en.compose.waitingNotSaved), "the wait sentence stands before the send line's words").toBeLessThan(
      said().findIndex((line) => line.includes(en.compose.statusQueued ?? "\u0000")) === -1
        ? Number.MAX_SAFE_INTEGER
        : said().findIndex((line) => line.includes(en.compose.statusQueued ?? "\u0000")),
    );
    s.offline.on = false;
    await act(async () => { window.dispatchEvent(new Event("online")); });
    await act(async () => { await s.engine.flushPending(); });
    await waitFor(() => sends(s).length >= 1, "the letter on its way once the signal is back");
    await pause(500);
    expect(sends(s).filter((m) => (m as { subject?: string }).subject === "Plans typed"), "the letter sent twice").toHaveLength(1);
  }, 60_000);
});

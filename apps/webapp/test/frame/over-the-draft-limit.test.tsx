/** @vitest-environment jsdom */
/**
 * PAST THE DRAFT LIMIT, SAID WHILE TYPING, OVER THE NEW SHELL's DOOR (the switch's point 65; by RULING-JOIN J-1 what
 * the act does is today's). Past the ceiling the autosave stops writing, so the line under the editor says at once
 * that the words are not being saved; Send stays pressable and dimmed (`aria-disabled`), and its press sends nothing
 * and says why it sent nothing. Shortened, the letter saves and goes again. The reply in the reading column and the
 * letter at the place that writes alike.
 */
import type { EngineMutation } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DRAFT_BODY_MAX_BYTES } from "@trafficflow/core/outbound-text";
import { typeInto } from "../fixtures/rich-editor-driver";
import { act, message, mountShell, stubDom, unmountAll, waitFor, type DraftShell } from "../_draft-shell.js";

const sends = (s: DraftShell): EngineMutation[] => s.sent.filter((m) => m.kind === "mail_send");
/** The editor's text, by its role: the one many-line text box of the reply or the letter. */
const surface = (): HTMLElement | null => document.querySelector<HTMLElement>('[role="textbox"][aria-multiline="true"]');
const said = (): string => document.body.textContent ?? "";
/** Send, the ink, wherever it stands: the reading sheet's panel for a reply, the sheet's foot for a letter. */
const send = (): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.getAttribute("aria-label") === "Send") ?? null;
const rounds = async (n: number): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 25)); });
};
const type = async (text: string): Promise<void> => {
  await act(async () => { typeInto(surface()!, text); });
  await rounds(2);
};

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(async () => {
  await unmountAll();
});

describe("a reply or a letter past the draft limit", () => {
  it("the reply says while typing that it is not saved; Send is dimmed and pressable, its press sends nothing and says why", async () => {
    const s = await mountShell("#/ohbox/m/m1", [message("m1")]);
    await waitFor(() => document.querySelector('[role="region"][aria-label="Open message"]') !== null, "the letter");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
    });
    await waitFor(() => surface() !== null, "the reply's editor");
    await type("a".repeat(DRAFT_BODY_MAX_BYTES + 1));
    await waitFor(() => said().includes("Too long to save"), "the limit while typing");
    expect(said(), "a send's refusal said before any press").not.toContain("Not sent");
    const button = send()!;
    expect({ disabled: button.disabled, dimmed: button.getAttribute("aria-disabled") }).toEqual({ disabled: false, dimmed: "true" });
    await act(async () => { button.click(); });
    await rounds(6);
    expect(sends(s), "an over-limit press reached the wire").toHaveLength(0);
    expect(said()).toContain("Too long to send");

    // Control: shortened, it goes.
    await type("Short now");
    await waitFor(() => !said().includes("Too long to"), "the limit's lines gone");
    expect(send()!.getAttribute("aria-disabled")).toBeNull();
    await act(async () => { send()!.click(); });
    await waitFor(() => sends(s).length === 1, "the shortened send on the wire");
  }, 60_000);

  it("the letter at the place write says it too, with its own words; its press sends nothing", async () => {
    const s = await mountShell("#/write", [message("m1")], [], {
      mailto: { to: ["lena@example.invalid"], cc: [], bcc: [], subject: "Plans for Friday", body: "" },
    });
    await waitFor(() => surface() !== null, "the letter's editor");
    await type("a".repeat(DRAFT_BODY_MAX_BYTES + 1));
    await waitFor(() => said().includes("Too long to save"), "the limit while typing");
    expect(said()).toContain("Shorten the message and it saves again");
    const button = send()!;
    expect({ disabled: button.disabled, dimmed: button.getAttribute("aria-disabled") }).toEqual({ disabled: false, dimmed: "true" });
    await act(async () => { button.click(); });
    await rounds(6);
    expect(sends(s), "an over-limit press reached the wire").toHaveLength(0);
    expect(said()).toContain("Too long to send");

    await type("Short now");
    await waitFor(() => !said().includes("Too long to"), "the limit's lines gone");
    expect(send()!.getAttribute("aria-disabled")).toBeNull();
  }, 60_000);
});

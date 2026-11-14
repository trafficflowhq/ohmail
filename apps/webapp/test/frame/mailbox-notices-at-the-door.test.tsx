/** @vitest-environment jsdom */
/**
 * THE TWO MAILBOX NOTICES TODAY's FEED SAID, OVER THE NEW SHELL's DOOR (the switch's point 65: both never red,
 * FILE). The Mailboxes entry says them in the frame's one slot as every host hands it (`MAILBOXES_NOTICES`): that
 * someone stopped organizing a mailbox, with Mailboxes and Dismiss, Dismiss sending the acknowledgement once; and the
 * letters a sync gap left behind, whose answer reaches the mailbox with both counts. Withheld where the wire is none.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { act, message, mountShell, ROSTER, stubDom, unmountAll, waitFor } from "../_draft-shell.js";

const AT = "2026-09-27T08:00:00.000Z";
const stopped: MailboxFacts = {
  ...ROSTER[0]!,
  organizerRole: "reader",
  organizedBy: { kind: "local", name: "Mila's MacBook", since: AT },
  organizeConsentedAt: null,
  organizerState: "stopped",
  organizerEventAt: AT,
  organizerEventSeenAt: null,
} as MailboxFacts;
const gapped: MailboxFacts = { ...ROSTER[0]!, gapLetters: 3, gapStrangers: 1 } as MailboxFacts;

const button = (name: string): HTMLButtonElement | null =>
  [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === name) ?? null;
const said = (text: RegExp): boolean => text.test(document.body.textContent ?? "");
const settle = async (n = 10): Promise<void> => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
};

beforeEach(() => {
  try { window.localStorage.clear(); window.sessionStorage.clear(); } catch { /* storage blocked */ }
  stubDom();
});
afterEach(async () => {
  await unmountAll();
});

describe("the mailbox notices over the new shell's door", () => {
  it("says who stopped organizing a mailbox, with Mailboxes and Dismiss; Dismiss sends the acknowledgement once", async () => {
    const acknowledged: string[] = [];
    await mountShell("#/ohbox", [message("m1")], [], {
      roster: [stopped],
      mailboxNotices: { organizerNotice: async (id) => void acknowledged.push(id) },
    });
    await waitFor(() => said(/Mila's MacBook stopped organizing me@example\.invalid/), "the organizer's notice");
    expect(button("Mailboxes"), "its way to the section").not.toBeNull();
    await act(async () => { button("Dismiss")!.click(); });
    await settle();
    expect(acknowledged).toEqual(["mb1"]);
    expect(said(/stopped organizing/)).toBe(false);
  }, 30_000);

  it("offers the letters a gap left behind; the answer reaches the mailbox with both counts", async () => {
    const offered: unknown[] = [];
    await mountShell("#/ohbox", [message("m1")], [], {
      roster: [gapped],
      mailboxNotices: { gapLetters: async (id, answer) => void offered.push([id, answer]) },
    });
    await waitFor(() => button("File them") !== null, "the gap's offer");
    await act(async () => { button("File them")!.click(); });
    await settle();
    expect(offered).toEqual([["mb1", { file: true, count: 3, strangers: 1 }]]);
  }, 30_000);

  it("withheld where the host hands no wire: the same facts say nothing", async () => {
    await mountShell("#/ohbox", [message("m1")], [], { roster: [stopped], mailboxNotices: {} });
    await settle(20);
    expect(said(/stopped organizing/)).toBe(false);
    expect(button("Dismiss")).toBeNull();
  }, 30_000);
});

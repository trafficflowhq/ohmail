/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup } from "@testing-library/react";
import type { FirstRunRow, FirstRunSender } from "@ohmail/app-logic/mailboxes/first-run/ground";
import type { FirstRunWire } from "../../../packages/app/src/host/index.js";
import { id } from "../../../packages/app/test/mailboxes/connect/support.js";
import { mountStage } from "./_first-run-stage.js";

/**
 * THE FIRST DECISION COUNTS THIS MAILBOX (R20-03). Setup for an added mailbox counted that
 * mailbox's own waiting senders on the window step (24) and then the whole install's on the
 * decide step ("37 senders are waiting"). On an install with several mailboxes the lead now reads
 * the host's per-mailbox count and the second sentence carries the rail's account number; a
 * single mailbox keeps its sentence and asks nothing.
 *
 * RE-POINTED (the switch's older tests, sorted once): the decide step is the new frame's first-run stage
 * (`_first-run-stage.tsx`); the sender the step is about is the ground's `about().sender`, the run's
 * mailbox the ground's row; the lead is the step's line, the sentence after the verbs the last line of the sender's
 * group; a new rail count is the ground read again. Every expectation is as it stood.
 */

/** Consented, imported, somebody waiting — `deriveOnboardingStep` row 8, "decide". */
const row = (mailboxId: string): FirstRunRow => ({
  id: id(mailboxId), address: "me@example.invalid",
  organizerRole: "organizer", organizedBy: null, organizerState: null,
  organizeConsentedAt: "2026-09-16T10:00:00.000Z", initialImportCompletedAt: "2026-09-16T11:00:00.000Z",
  importOver: true,
}) as FirstRunRow;

const subject = (over: Partial<FirstRunSender> = {}): FirstRunSender => ({
  name: "Lena Roth", address: "lena@stranger.example", held: 2, waiting: 37, many: false,
  since: "2 letters", decide: () => {}, ...over,
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

async function mount(o: {
  decide: FirstRunSender;
  countWaiting?: FirstRunWire["countWaiting"];
  mailboxId?: string;
}): Promise<{ el: HTMLElement; rerender: (d: FirstRunSender) => Promise<void> }> {
  let sender = o.decide;
  const rows = [row(o.mailboxId ?? "mb-2")];
  const st = await mountStage({
    rows,
    door: "local",
    about: { queuedSenders: 5, get sender() { return sender; } },
    verbs: {
      ai: "on",
      organize: async () => "stored",
      complete: async () => {},
      ...(o.countWaiting ? { countWaiting: o.countWaiting } : {}),
    },
  });
  /** The shell's render, again with the ground's newer sender (the rail's count moved). */
  const render = async (decide: FirstRunSender) => {
    sender = decide;
    await st.move([...rows]);
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { el: st.el, rerender: render };
}

const left = (el: HTMLElement): string | null =>
  [...el.querySelectorAll(".oh-tag")].find((tag) => /^\d+ left$/.test(tag.textContent ?? ""))?.textContent ?? null;

describe("the decide step on an install with several mailboxes", () => {
  it("shows the waiting count for the setup mailbox", async () => {
    const countWaiting = vi.fn(async () => ({ senders: 24 }));
    const { el } = await mount({ decide: subject({ many: true }), countWaiting });
    expect(left(el)).toBe("24 left");
    expect(el.textContent).not.toContain("37 left");
    expect(countWaiting).toHaveBeenCalledWith("mb-2");
  });

  it("asks with the run's own mailbox id", async () => {
    const countWaiting = vi.fn(async () => ({ senders: 24 }));
    await mount({ decide: subject({ many: true }), countWaiting, mailboxId: "mb-7" });
    expect(countWaiting).toHaveBeenCalledWith("mb-7");
  });

  it("a read that fails says no number in the lead", async () => {
    const { el } = await mount({ decide: subject({ many: true }), countWaiting: async () => { throw new Error("down"); } });
    expect(left(el)).toBeNull();
    expect(el.querySelector("[role=group][aria-label='Lena Roth']")).not.toBeNull();
  });

  it("a count above the rail's is clamped to the rail's", async () => {
    const { el } = await mount({ decide: subject({ many: true }), countWaiting: async () => ({ senders: 40 }) });
    expect(left(el)).toBe("37 left");
  });

  it("an answer for another mailbox is never shown", async () => {
    let release: (v: { senders: number }) => void = () => {};
    const slow = new Promise<{ senders: number }>((r) => { release = r; });
    const countWaiting = vi.fn(async (id: string) => (id === "mb-2" ? slow : { senders: 9 }));
    const { el } = await mount({ decide: subject({ many: true }), countWaiting, mailboxId: "mb-2" });
    // Still unanswered: no number.
    expect(left(el)).toBeNull();
    await act(async () => { release({ senders: 5 }); await Promise.resolve(); });
    expect(left(el)).toBe("5 left");
  });

  it("re-reads when the rail's count moves", async () => {
    const countWaiting = vi.fn(async () => ({ senders: 24 }));
    const { rerender } = await mount({ decide: subject({ many: true }), countWaiting });
    const n = countWaiting.mock.calls.length;
    await rerender(subject({ many: true, waiting: 36 }));
    expect(countWaiting.mock.calls.length).toBe(n + 1);
  });
});

describe("CONTROL: a single mailbox", () => {
  it("keeps its sentence and never asks", async () => {
    const countWaiting = vi.fn(async () => ({ senders: 24 }));
    const { el } = await mount({ decide: subject(), countWaiting });
    expect(left(el)).toBe("37 left");
    expect(el.querySelector("[role=group][aria-label='Lena Roth']")).not.toBeNull();
    expect(countWaiting).not.toHaveBeenCalled();
  });
});

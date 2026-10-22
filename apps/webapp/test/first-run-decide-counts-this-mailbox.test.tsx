/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import { FirstRun, type FirstRunDecideSubject } from "../app/shell/FirstRun";
import { KeymapProvider } from "../app/shell/keymap";
import type { FirstRunHost } from "../app/shell/first-run-host";
import type { OnboardingFacts } from "../app/shell/onboarding";

/**
 * THE FIRST DECISION COUNTS THIS MAILBOX (R20-03). Setup for an added mailbox counted that
 * mailbox's own waiting senders on the window step (24) and then the whole install's on the
 * decide step ("37 senders are waiting"). On an install with several mailboxes the lead now reads
 * the host's per-mailbox count and the second sentence carries the rail's account number; a
 * single mailbox keeps its sentence and asks nothing.
 */

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

/** Consented, imported, somebody waiting — `deriveOnboardingStep` row 8, "decide". */
const facts = (): OnboardingFacts => ({
  door: "local",
  mailbox: {
    organizerRole: "organizer", organizedBy: null, organizerState: null,
    organizeConsentedAt: "2026-09-16T10:00:00.000Z", initialImportCompletedAt: "2026-09-16T11:00:00.000Z",
  },
  account: { onboardingCompletedAt: null },
  ai: "on",
  queuedSenders: 5,
});

const subject = (over: Partial<FirstRunDecideSubject> = {}): FirstRunDecideSubject => ({
  name: "Lena Roth", address: "lena@stranger.example", held: 2, waiting: 37,
  since: "2 letters", onDecide: () => {}, ...over,
});

const roots: Root[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) r.unmount();
  document.body.innerHTML = "";
});

async function mount(o: {
  decide: FirstRunDecideSubject;
  countWaiting?: FirstRunHost["countWaiting"];
  mailboxId?: string;
}): Promise<{ el: HTMLElement; rerender: (d: FirstRunDecideSubject) => Promise<void> }> {
  const el = document.createElement("div");
  document.body.appendChild(el);
  const root = createRoot(el);
  roots.push(root);
  const host: FirstRunHost = {
    door: "local", ai: "on",
    probe: async () => ({ host: "h", user: "u", folders: 1 }),
    connect: async () => ({ id: "mb-2" }),
    organize: async () => "stored",
    complete: async () => {},
    probeReason: () => null,
    probeMessage: () => null,
    ...(o.countWaiting ? { countWaiting: o.countWaiting } : {}),
  };
  const render = async (decide: FirstRunDecideSubject) => {
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC",
        children: h(KeymapProvider, {
          children: h(FirstRun, {
            host, facts: facts(), onRefresh: () => {}, onLeave: () => {},
            pull: { screened: 0, history: 0, pulled: 0 }, decide, mailboxId: o.mailboxId ?? "mb-2",
          }),
        }),
      }));
    });
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  };
  await render(o.decide);
  return { el, rerender: render };
}

const lead = (el: HTMLElement) => (el.querySelector("p.sub")?.textContent ?? "").replace(/\s+/g, " ");
const after = (el: HTMLElement) => (el.querySelector("p.set-note-inline")?.textContent ?? "").replace(/\s+/g, " ");

describe("the decide step on an install with several mailboxes", () => {
  it("the lead counts this mailbox, the second sentence the account", async () => {
    const countWaiting = vi.fn(async () => ({ senders: 24 }));
    const { el } = await mount({ decide: subject({ many: true }), countWaiting });
    expect(lead(el)).toContain("24 senders who wrote to this mailbox are waiting");
    expect(lead(el)).not.toContain("37");
    expect(after(el)).toContain("all 37 senders waiting across your mailboxes");
  });

  it("asks with the run's own mailbox id", async () => {
    const countWaiting = vi.fn(async () => ({ senders: 24 }));
    await mount({ decide: subject({ many: true }), countWaiting, mailboxId: "mb-7" });
    expect(countWaiting).toHaveBeenCalledWith("mb-7");
  });

  it("a read that fails says no number in the lead", async () => {
    const { el } = await mount({ decide: subject({ many: true }), countWaiting: async () => { throw new Error("down"); } });
    expect(lead(el)).toContain("Senders who wrote to this mailbox are waiting");
    expect(lead(el)).not.toMatch(/\d/);
  });

  it("a count above the rail's is clamped to the rail's", async () => {
    const { el } = await mount({ decide: subject({ many: true }), countWaiting: async () => ({ senders: 40 }) });
    expect(lead(el)).toContain("37 senders who wrote to this mailbox are waiting");
  });

  it("an answer for another mailbox is never shown", async () => {
    let release: (v: { senders: number }) => void = () => {};
    const slow = new Promise<{ senders: number }>((r) => { release = r; });
    const countWaiting = vi.fn(async (id: string) => (id === "mb-2" ? slow : { senders: 9 }));
    const { el } = await mount({ decide: subject({ many: true }), countWaiting, mailboxId: "mb-2" });
    // Still unanswered: no number.
    expect(lead(el)).toContain("Senders who wrote to this mailbox are waiting");
    expect(lead(el)).not.toContain("9 senders");
    await act(async () => { release({ senders: 5 }); await Promise.resolve(); });
    expect(lead(el)).toContain("5 senders who wrote to this mailbox are waiting");
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
    expect(lead(el)).toContain("37 senders are waiting. Start with this one");
    expect(after(el)).toContain("every other waiting sender");
    expect(countWaiting).not.toHaveBeenCalled();
  });
});

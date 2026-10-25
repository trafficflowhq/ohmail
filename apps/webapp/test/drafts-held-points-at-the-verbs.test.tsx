/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import type { EngineDraft } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { DraftsView } from "../app/views/DraftsView";

/**
 * A HELD ROW SAYS WHAT IS KNOWN AND OFFERS THE TWO ACTS; A REFUSED DISCARD SAYS WHY, IN ITS ROW.
 *
 * The question "Did this message arrive?" is gone: the engine looks in the Sent folder itself
 * (`HELD_SEND_RECHECK_MS`), and the row says so while it does and says the message is not there
 * once it has stopped. What is left for a person is "Send again" and "It was sent — dismiss". A
 * Discard the shell refuses renders its sentence IN THAT ROW and focuses it — never a toast alone
 * pointing at a list of identical pairs (measured on the rig, 2026-09-16). A row held only by a
 * durable RECORD (mirror status still a plain draft) carries the same two acts.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const NOW = new Date("2026-09-16T09:00:00.000Z");

const draft = (over: Partial<EngineDraft> = {}): EngineDraft => ({
  id: "d1",
  mailboxId: "mb-1",
  threadId: null,
  inReplyToMessageId: null,
  subject: "Invoice for the paper order",
  body: "The only copy of this text lives in this row.",
  to: [{ name: null, address: "sam@customer.example" }],
  cc: [],
  bcc: [],
  rationale: null,
  status: "draft",
  createdAt: "2026-09-15T09:00:00.000Z",
  updatedAt: "2026-09-15T14:02:00.000Z",
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

const q = <T extends Element>(sel: string): T | null => host!.querySelector<T>(sel);
const qa = (sel: string): Element[] => Array.from(host!.querySelectorAll(sel));
const press = async (el: HTMLElement): Promise<void> => { await act(async () => { el.click(); }); };

async function unmount(): Promise<void> {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null;
  host = null;
}

/** The view on its own, with the shell's two answers passed as props. */
async function mountDrafts(
  drafts: EngineDraft[],
  over: {
    refusal?: { draftId: string; why: "still-sending" | "unknown-jar"; at: number } | null;
    heldHere?: ReadonlySet<string>;
    onSendAgain?: (d: EngineDraft) => void;
  } = {},
): Promise<void> {
  await unmount();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(DraftsView, {
          settled: true,
          owed: false,
          drafts, scheduled: [], now: NOW,
          onOpen: () => {}, onDiscard: () => {}, onResolve: () => {}, onSendAgain: () => {},
          onCancelSchedule: () => {}, onEditScheduled: () => {}, repliesHere: () => false,
          ...over,
        }),
      }),
    );
  });
}

beforeEach(() => {
  window.location.hash = "";
  try { window.localStorage.clear(); } catch { /* blocked storage; the in-memory half still runs */ }
  Object.defineProperty(window, "matchMedia", {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {},
      addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
    }),
  });
  (globalThis as Record<string, unknown>).CSS = { escape: (s: string) => s };
  const el = Element.prototype as unknown as Record<string, () => void>;
  el.scrollIntoView = () => {};
  el.scrollTo = () => {};
  (globalThis as Record<string, unknown>).IntersectionObserver = class {
    observe(): void {} unobserve(): void {} disconnect(): void {}
    takeRecords(): [] { return []; }
  };
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  await unmount();
  document.body.innerHTML = "";
  delete (globalThis as Record<string, unknown>).IntersectionObserver;
  delete (globalThis as Record<string, unknown>).CSS;
  vi.restoreAllMocks();
});

describe("a refused discard says why, in its own row", () => {
  /**
   * THE ADDRESS, not the instruction. Two held rows, so a guard that renders "the refusal" rather
   * than THIS row's cannot pass: the fixture has the property under test.
   *
   * Mutation: drop the `refusedAt`/`refusedFor` effect from `DraftsView`. Real failure text:
   *   AssertionError: the refused press left focus where it was …: expected null to be …
   */
  it("renders the sentence in the refused row and focuses it, not the other held one", async () => {
    await mountDrafts(
      [draft({ id: "u1", status: "unverified" }), draft({ id: "u2", status: "unverified", subject: "Other" })],
      { refusal: { draftId: "u2", why: "still-sending", at: 1 } },
    );
    const line = q<HTMLElement>('.draft-row[data-id="u2"] .draft-refusal');
    expect(line, "the refused row carries no sentence").not.toBeNull();
    expect(line!.getAttribute("role")).toBe("alert");
    expect(line!.textContent).toBe(messages.drafts.discardStillSending);
    expect(q('.draft-row[data-id="u1"] .draft-refusal'), "the OTHER held row says it was refused").toBeNull();
    expect(
      document.activeElement,
      "the refused press left focus where it was — a sentence nobody is told about is a silent refusal",
    ).toBe(line);
  });

  it("names the other refusal too — a jar this browser cannot read", async () => {
    await mountDrafts([draft({ id: "d1" })], { refusal: { draftId: "d1", why: "unknown-jar", at: 1 } });
    expect(q('.draft-row[data-id="d1"] .draft-refusal')!.textContent).toBe(messages.drafts.discardUnknownJar);
  });
});

describe("what a held row says, and the two acts it offers", () => {
  const acts = (id: string): string[] =>
    qa(`.draft-row[data-id="${id}"] .draft-resolve button`).map((b) => (b.textContent ?? "").trim());

  it("offers the two acts for a row held by a durable RECORD, whatever the mirror says", async () => {
    const held = new Date(NOW.getTime() - 5 * 60 * 1000).toISOString();
    await mountDrafts([draft({ id: "d1", updatedAt: held }), draft({ id: "d2", subject: "Other" })], { heldHere: new Set(["d1"]) });
    expect(acts("d1")).toEqual([messages.drafts.sendAgain, messages.drafts.itWasSent]);
    expect(acts("d2"), "an ordinary row offers the held row's acts").toEqual([]);
    const group = q<HTMLElement>('.draft-row[data-id="d1"] .draft-resolve')!;
    expect(group.getAttribute("role")).toBe("group");
    expect(group.getAttribute("aria-label")).toBe(messages.drafts.heldChecking);
  });

  /**
   * INSIDE THE WINDOW the engine is still looking; PAST IT the message is not in Sent. The two
   * acts do not change. Mutation: invert `heldStillChecking` → both sentences swap.
   */
  it("says the Sent folder is being checked while the engine still looks, and that the message is not there once it has stopped", async () => {
    // The engine looks for twenty minutes after the hold.
    const recent = new Date(NOW.getTime() - 19 * 60 * 1000).toISOString();
    const old = new Date(NOW.getTime() - 21 * 60 * 1000).toISOString();
    await mountDrafts([
      draft({ id: "u1", status: "unverified", updatedAt: recent }),
      draft({ id: "u2", status: "unverified", updatedAt: old, subject: "Old" }),
    ]);
    expect(q('.draft-row[data-id="u1"] .draft-state')!.textContent).toBe(messages.drafts.heldChecking);
    expect(q('.draft-row[data-id="u2"] .draft-state')!.textContent).toBe(messages.drafts.heldNotInSent);
    expect(acts("u1")).toEqual([messages.drafts.sendAgain, messages.drafts.itWasSent]);
    expect(acts("u2")).toEqual([messages.drafts.sendAgain, messages.drafts.itWasSent]);
    expect(host!.textContent, "the retired question is still on screen").not.toContain("Did this message arrive");
    expect(host!.textContent).not.toContain("over a week");
  });

  it("reads an unparseable stamp as past the window — the sentence that claims less", async () => {
    await mountDrafts([draft({ id: "u1", status: "unverified", updatedAt: "not a date" })]);
    expect(q('.draft-row[data-id="u1"] .draft-state')!.textContent).toBe(messages.drafts.heldNotInSent);
  });

  it("a stranded `sending` row says the send was interrupted", async () => {
    await mountDrafts([draft({ id: "s1", status: "sending" })]);
    expect(q('.draft-row[data-id="s1"] .draft-state')!.textContent).toBe(messages.drafts.heldInterrupted);
    expect(acts("s1")).toEqual([messages.drafts.sendAgain, messages.drafts.itWasSent]);
  });

  /**
   * "Send again" hands the ROW to the shell — which answers `not_arrived`, releases the record and
   * opens the message with Send live. The view dispatches nothing itself.
   * Mutation: wire `onSendAgain` to `onResolve(id, "not_arrived")` in the view → `again` stays [].
   */
  it("`Send again` hands the draft to the shell; `It was sent — dismiss` answers `arrived`", async () => {
    const again: string[] = [];
    const resolved: Array<[string, string]> = [];
    await mountDrafts([draft({ id: "u1", status: "unverified" })], { onSendAgain: (d) => { again.push(d.id); } });
    // `onResolve` is a mount default; re-mount with a recording one for the second act.
    await press(q<HTMLButtonElement>('.draft-row[data-id="u1"] .draft-send-again')!);
    expect(again).toEqual(["u1"]);
    await unmount();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages, timeZone: "UTC", now: NOW,
        children: h(DraftsView, {
          settled: true,
          owed: false,
          drafts: [draft({ id: "u1", status: "unverified" })], scheduled: [], now: NOW,
          onOpen: () => {}, onDiscard: () => {}, onSendAgain: () => {},
          onResolve: (id: string, outcome: string) => { resolved.push([id, outcome]); },
          onCancelSchedule: () => {}, onEditScheduled: () => {}, repliesHere: () => false,
        }),
      }));
    });
    await press(q<HTMLButtonElement>('.draft-row[data-id="u1"] .draft-it-was-sent')!);
    expect(resolved).toEqual([["u1", "arrived"]]);
  });

  it("a held row still has Discard, beside the two acts", async () => {
    await mountDrafts([draft({ id: "u1", status: "unverified" })]);
    const buttons = qa('.draft-row[data-id="u1"] .draft-actions button').map((b) => (b.textContent ?? "").trim());
    expect(buttons).toEqual([messages.drafts.sendAgain, messages.drafts.itWasSent, messages.drafts.discard]);
  });
});

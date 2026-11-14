/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import messages from "../messages/en.json";
import german from "../messages/de.json";
import { pinnedRows } from "./_resurfaced-rows.js";
import type { EngineMessage } from "@ohmail/client-engine";

/**
 * "DONE" ON A RESURFACED ROW — the release verb's row-level face.
 *
 * A resurfaced row stays pinned until it is answered or DELIBERATELY marked read
 * (`resurface-pin.r12.test.ts` holds the glance half), and the deliberate release existed the
 * whole time — as `⇧I`, as "Mark as read", as a bulk Read. What was reported is that nothing
 * NAMED it: standing at the pin, nothing on screen said how to end the resurface. The control
 * under guard here is that name — a "Done" in the row's action slot — and the guard is about
 * WHERE it renders and WHAT it dispatches:
 *
 *   · on every pinned row, and on NO ordinary row — a Done on plain mail would be a second
 *     "mark read" wearing a verb it has not earned;
 *   · dispatching `resurface_done` for THE ROW'S OWN message, never the selected one (which is
 *     why it must not press `⇧I` — the key acts on the cursor);
 *   · in the Resurface PILE, on scheduled rows, where the same verb honestly means
 *     "cancel the return and file it" (the shell's arm adds the `triage_set: none` half —
 *     `resurface-done-shell.test.ts` counts that at the adapter);
 *   · labelled for a screen reader, in both catalogues.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function setViewport(): void {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) =>
    ({
      matches: false, media: query, onchange: null,
      addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {},
      dispatchEvent() { return false; },
    }) as unknown as MediaQueryList;
}

interface Row { id: string; unread: boolean; pinned?: boolean; threadId?: string }

/** The message as the selector hands it over — pinned rows carry the `resurfaced` state. */
function msg(m: Row): EngineMessage {
  return {
    id: m.id, accountId: "a", mailboxId: "mb", threadId: m.threadId ?? null, messageIdHeader: null,
    subject: `subj-${m.id}`, from: { name: m.id, address: `${m.id}@ex.example` }, to: [], cc: [],
    date: "2026-08-02T09:00:00.000Z", folder: "INBOX", snippet: `snip-${m.id}`,
    unread: m.unread, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: m.pinned
      ? { messageId: m.id, state: "resurfaced", bubbleUpAt: null, setAt: "2026-08-02T09:00:00.000Z", updatedAt: "2026-08-02T09:00:00.000Z" }
      : null,
    labels: [], remoteContent: "none", updatedAt: "2026-08-02T09:00:00.000Z",
  } as unknown as EngineMessage;
}

let root: Root | null = null;
let host: HTMLDivElement | null = null;
/** What the view asked the shell to do — the `onAction` seam. */
let dispatched: Array<[string, string]> = [];
/** And the batched seam Done uses over a conversation — `bulk.run`. */
let bulkRuns: Array<[string, string[]]> = [];

async function mountOhbox(rows: Row[], locale: "en" | "de" = "en"): Promise<void> {
  setViewport();
  const { OhboxView } = await import("../app/views/OhboxView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const el = h(NextIntlClientProvider, {
    locale, messages: locale === "de" ? german : messages, timeZone: "UTC",
    now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(OhboxView as never, {
    owed: false,
      demo: false, settled: true,
      older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
      resurfacedRows: pinnedRows(rows.filter((r) => r.pinned).map(msg)),
      newForYou: rows.filter((r) => !r.pinned && r.unread).map(msg),
      previouslySeen: rows.filter((r) => !r.pinned && !r.unread).map(msg),
      replyDone: null,
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      selectedId: null,
      onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
      onMarkSeen: () => {},
      bulk: {
        run: (a: string, ids: string[]) => { bulkRuns.push([a, ids]); return true; },
        tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {},
      },
      doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {},
      onAction: (a: string, m: { id: string }) => { dispatched.push([a, m.id]); },
      onAddTag: () => {},
      onMarkAllRead: () => {},
    } as never) } as never),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
}

async function mountTriage(
  pile: "reply" | "aside" | "resurface",
  entries: Array<{ id: string; resurfaceAt?: string }>,
): Promise<void> {
  setViewport();
  const { TriageView } = await import("../app/views/TriageView.js");
  const { KeymapProvider } = await import("@ohmail/app/keys");
  const { WithListGone } = await import("./_list-gone.js");
  const byId = new Map(entries.map((e) => [e.id, msg({ id: e.id, unread: true })]));
  const list = entries.map((e) => ({
    messageId: e.id, title: e.id,
    ...(e.resurfaceAt ? { resurfaceAt: e.resurfaceAt } : {}),
  }));
  const piles = {
    replyLater: pile === "reply" ? list : [],
    setAside: pile === "aside" ? list : [],
    resurface: pile === "resurface" ? list : [],
  };
  const el = h(NextIntlClientProvider, {
    locale: "en", messages, timeZone: "UTC", now: new Date("2026-08-02T09:00:00.000Z"),
    children: h(KeymapProvider as never, { children: h(WithListGone, { children: h(TriageView as never, {
      piles, settled: true, owed: false, pile, onPile: () => {}, frDone: new Set<string>(), onStartFR: () => {},
      messageOf: (id: string) => byId.get(id) ?? null,
      tags: [], now: new Date("2026-08-02T09:00:00.000Z"),
      onOpen: () => {}, hydrateBody: () => {},
      onAction: (a: string, m: { id: string }) => { dispatched.push([a, m.id]); },
      onAddTag: () => {},
    } as never) }) } as never),
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root!.render(el); });
}

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  dispatched = [];
  bulkRuns = [];
});

/** The Done control standing beside the row that carries `id`, or null. */
function doneBeside(id: string): HTMLButtonElement | null {
  const rowEl = host!.querySelector<HTMLElement>(`.row[data-id="${id}"]`);
  if (!rowEl) return null;
  return rowEl.parentElement?.querySelector<HTMLButtonElement>(".rsf-done") ?? null;
}

const click = async (el: Element | null): Promise<void> => {
  expect(el, "nothing to click").toBeTruthy();
  await act(async () => {
    el!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

describe("the pinned row carries Done — and only the pinned row", () => {
  it("renders the control on every pinned row and on no ordinary row", async () => {
    await mountOhbox([
      { id: "pin-a", unread: true, pinned: true },
      { id: "pin-b", unread: true, pinned: true },
      { id: "fresh", unread: true },
      { id: "old", unread: false },
    ]);
    expect(doneBeside("pin-a"), "the first pinned row has no Done").toBeTruthy();
    expect(doneBeside("pin-b"), "the second pinned row has no Done").toBeTruthy();
    // Ordinary rows carry NO action slot at all — a Done on plain mail would be a second
    // "mark read" wearing a verb it has not earned.
    expect(doneBeside("fresh")).toBeNull();
    expect(doneBeside("old")).toBeNull();
  });

  /**
   * MOVED DELIBERATELY (FEAT-020): the Resurfaced block is one row per CONVERSATION, so Done is a
   * release over the row's pinned members and goes through the batched `bulk.run("done", ids)`
   * seam, not the per-message `onAction`. What the test defends is unchanged — the press acts on
   * THIS row and no other — and it now also says how many ids that is.
   */
  it("releases THIS row and no other — the second pin, not the first", async () => {
    await mountOhbox([
      { id: "pin-a", unread: true, pinned: true },
      { id: "pin-b", unread: true, pinned: true },
    ]);
    await click(doneBeside("pin-b"));
    // One call, the row's own ids. A control that pressed `⇧I` instead would act on the
    // SELECTED message — with nothing selected, on nothing at all.
    expect(bulkRuns).toEqual([["done", ["pin-b"]]]);
    expect(dispatched).toEqual([]);
  });

  /**
   * THE POINT OF THE FOLD, as data. MUTATION WATCHED: pass `[g.openTarget.id]` instead of the
   * row's pinned members in `doneForRow` and this reads one id — the conversation comes straight
   * back with two of its three pins still standing.
   */
  it("a conversation releases every member carrying a pin, in one press", async () => {
    await mountOhbox([
      { id: "c-1", unread: true, pinned: true, threadId: "T" },
      { id: "c-2", unread: true, pinned: true, threadId: "T" },
      { id: "c-3", unread: true, pinned: true, threadId: "T" },
    ]);
    const done = host!.querySelectorAll(".rsf-done");
    expect(done, "three pins in one conversation are ONE row").toHaveLength(1);
    await click(done[0]!);
    expect(bulkRuns).toHaveLength(1);
    expect(bulkRuns[0]![0]).toBe("done");
    expect([...bulkRuns[0]![1]].sort()).toEqual(["c-1", "c-2", "c-3"]);
  });

  it("is a labelled button — reachable and named for a screen reader", async () => {
    await mountOhbox([{ id: "pin-a", unread: true, pinned: true }]);
    const done = doneBeside("pin-a")!;
    expect(done.tagName).toBe("BUTTON");
    expect(done.getAttribute("aria-label")).toBe((messages as never as Record<string, Record<string, string>>).ohbox.rowDoneAria);
    // And it stands OUTSIDE the row button — a button may not contain a button, and the
    // `role="option"` rows forbid interactive descendants (see MessageRow.actions).
    expect(done.closest(".row")).toBeNull();
  });

  it("wears the German verb under the German catalogue", async () => {
    await mountOhbox([{ id: "pin-a", unread: true, pinned: true }], "de");
    const done = doneBeside("pin-a")!;
    expect(done.textContent).toContain("Erledigt");
    expect(done.getAttribute("aria-label")).toBe((german as never as Record<string, Record<string, string>>).ohbox.rowDoneAria);
  });
});

describe("the Resurface pile's rows carry the same verb, read for a scheduled row", () => {
  it("a scheduled row offers Done and dispatches `resurface_done` for its message", async () => {
    await mountTriage("resurface", [
      { id: "booked", resurfaceAt: "2026-08-09T09:00:00.000Z" },
    ]);
    const done = doneBeside("booked");
    expect(done, "the scheduled row has no Done").toBeTruthy();
    // The scheduled row's label says what Done means THERE: the return is cancelled too.
    expect(done!.getAttribute("aria-label")).toBe(
      (messages as never as Record<string, Record<string, string>>).ohbox.rowDoneScheduledAria,
    );
    await click(done);
    expect(dispatched).toEqual([["resurface_done", "booked"]]);
  });

  it("the other piles' rows do NOT carry it — done is a claim about a resurface", async () => {
    await mountTriage("reply", [{ id: "queued" }]);
    expect(doneBeside("queued")).toBeNull();
  });
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, within } from "@testing-library/react";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OHBOX_VISIT_ID, type MirrorStore, type OhmailEngine, type SyncChange } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { JunkWire } from "@ohmail/app-logic/screener/junk-window";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import { NOW, S, act, consentTransport, engineOver, msg, setup, storeWith, teardown, waitFor } from "./_view-shell";

/**
 * THE OHBOX LINE'S COUNTS OPEN VIEWS THAT LIST THOSE LETTERS — the whole shell, folders on and off
 * (row OHBOX-QUIET-READS-AS-STALLED, review round 3). With "Use folders" on and a server to read it
 * from, the Screener's third segment is the live Junk window: the provider's own Junk folder, not
 * the mirror's Spam pile the line counts. Letters ohmail's own patterns set aside, and all spam of
 * a mailbox with no Junk folder, never reach that window, so "N to Spam" opened a page titled Junk
 * that listed none of them. The shell hands the line the same gate it hands the Screener its Junk
 * window on (`junkReadable`), and the line leaves the spam count out while that window stands in.
 */

beforeEach(setup);
afterEach(teardown);

const h = React.createElement;
const MARK = new Date(NOW.getTime() - 60 * 60_000).toISOString();
const NEWS = { address: "letters@news.example.invalid", name: "A newsletter" };
const PEDLAR = { address: "offers@pedlar.example.invalid", name: "A pedlar" };

const ROSTER: MailboxFacts[] = [{
  id: "mb1", address: "me@example.invalid", status: "connected", errorCode: null,
  disabledReason: null, syncBlockedReason: null, syncBlockedSince: null,
  lastSyncAt: "2026-09-16T08:59:00.000Z", createdAt: "2026-09-01T00:00:00.000Z",
  organizerRole: "organizer" as const, organizedBy: null, organizeConsentedAt: "2026-09-01T00:00:00.000Z",
}];

const FOLDERS_OFF = {
  ...consentTransport,
  state: async () => ({ ...(await consentTransport.state()), foldersEnabledAt: null }),
};

/** The host wire the desktop hands in (`junkOverBridge`): the window is supported, its page empty. */
const JUNK_WIRE: JunkWire = {
  list: async () => ({ mailboxes: [{ id: "mb1", address: "me@example.invalid", window: "ok" }], items: [], nextCursor: null }),
  body: async () => ({ subject: "", text: "" }),
  rescue: async () => { throw new Error("no rescue in this test"); },
  dismissRescue: async () => ({}),
  search: async () => ({ mailboxes: [], items: [], truncated: false }),
  sweepPreview: async () => ({ mailboxes: [], movable: 0, pending: false }),
  sweepRequest: async () => ({ mailboxes: [], movable: 0, pending: false }),
  isGone: () => false,
  codeOf: () => null,
};

/** One letter to News and one set aside as spam, both after the visit mark. */
async function seeded(): Promise<{ s: MirrorStore; engine: OhmailEngine }> {
  const s = await storeWith([
    msg("n1", { folder: "ohmail/News", from: NEWS, date: "2026-09-16T08:20:00.000Z", updatedAt: "2026-09-16T08:20:00.000Z" }),
    msg("q1", { folder: "ohmail/Quarantine", from: PEDLAR, date: "2026-09-16T08:30:00.000Z", updatedAt: "2026-09-16T08:30:00.000Z" }),
  ]);
  await s.putLocal("view_meta", OHBOX_VISIT_ID, { at: MARK });
  return { s, engine: engineOver(s) };
}

async function mount(
  engine: OhmailEngine, o: { folders: boolean; junkWire?: JunkWire }, hash = "#/ohbox",
): Promise<HTMLElement> {
  const { AppShell } = await import("./_todays-shell.js");
  const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
  S.engine = engine;
  window.location.hash = hash;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  S.roots.push(root);
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale: "en", messages, timeZone: "UTC", now: NOW,
      children: h(ThemeProvider, { children: h(ToastHost, {
        children: h(AppShell as never, {
          demo: false, engine, consentTransport: o.folders ? consentTransport : FOLDERS_OFF,
          mailboxFacts: async () => ROSTER, junkWire: o.junkWire,
        } as never),
      }) }),
    }));
  });
  return container;
}

const junkButton = (el: HTMLElement) => within(el).queryByRole("button", { name: messages.screener.segJunk });
async function chooseJunk(el: HTMLElement): Promise<void> {
  const button = within(el).getByRole("button", { name: messages.screener.segJunk });
  await act(async () => {
    fireEvent.click(button);
    // Deliver the browser's fragment notification in this turn, before checking the first draw.
    window.dispatchEvent(new Event("hashchange"));
  });
  expect(button.getAttribute("aria-pressed")).toBe("true");
}

const junkRows = (el: HTMLElement) => within(el).getByRole("listbox", { name: messages.screener.segJunk });

describe("the Screener reads the Junk window before the Spam click", () => {
  it("opening the Screener asks the page and the preview; the click paints the cached page", async () => {
    const calls: string[] = [];
    const release: Array<() => void> = [];
    const later = <T,>(name: string, v: T): Promise<T> => {
      calls.push(name);
      return new Promise((r) => { release.push(() => r(v)); });
    };
    const wire: JunkWire = {
      ...JUNK_WIRE,
      list: () => later("list", {
        mailboxes: [{ id: "mb1", address: "me@example.invalid", window: "ok" as const }], nextCursor: null,
        items: [{
          mailboxId: "mb1", uid: 7, uidValidity: "1", subject: "A provider-filed offer",
          from: { name: "Provider junk", address: "junk@provider.example.invalid" },
          date: "2026-09-16T08:40:00.000Z", messageIdHeader: "<j7@x>", seen: false, origin: "provider" as const,
        }],
      }),
      sweepPreview: () => later("sweepPreview", { mailboxes: [], movable: 0, pending: false, held: { ids: ["q1"], truncated: false } }),
    };
    const { engine } = await seeded();
    const el = await mount(engine, { folders: true, junkWire: wire }, "#/screener");
    await waitFor(() => junkButton(el) !== null, "the Screener's Junk segment");
    expect(calls.sort(), "the Screener opened and the Junk window was not read").toEqual(["list", "sweepPreview"]);
    await act(async () => { for (const r of release) r(); });
    await chooseJunk(el);
    const pane = junkRows(el).textContent ?? "";
    expect(pane).toContain("A provider-filed offer");
    expect(within(el).queryByText(messages.screener.junkLoading)).toBeNull();
    expect(calls).toHaveLength(2);
  });
});

describe("the shell keeps the Junk page from its start", () => {
  const junkRow = (uid: number, subject: string) => ({
    mailboxId: "mb1", uid, uidValidity: "1", subject, from: { name: "Provider junk", address: "junk@provider.example.invalid" },
    date: "2026-09-16T08:40:00.000Z", messageIdHeader: `<j${uid}@x>`, seen: false, origin: "provider" as const,
  });
  const page = (...items: ReturnType<typeof junkRow>[]) =>
    ({ mailboxes: [{ id: "mb1", address: "me@example.invalid", window: "ok" as const }], nextCursor: null, items });

  it("opened on the Ohbox, the page is read at once; the Screener's Junk click paints the cached page and asks nothing", async () => {
    const calls: string[] = [];
    const wire: JunkWire = {
      ...JUNK_WIRE,
      list: async () => { calls.push("list"); return page(junkRow(7, "A provider-filed offer")); },
      sweepPreview: async () => { calls.push("sweepPreview"); return { mailboxes: [], movable: 0, pending: false, held: { ids: ["q1"], truncated: false } }; },
    };
    const { engine } = await seeded();
    const el = await mount(engine, { folders: true, junkWire: wire });
    await waitFor(() => calls.length === 2, "the Junk page read from the Ohbox");
    const { go } = await import("../app/shell/routing.js");
    await act(async () => { go("screener"); });
    await waitFor(() => junkButton(el) !== null, "the Screener's Junk segment");
    await chooseJunk(el);
    const pane = junkRows(el).textContent ?? "";
    expect(pane).toContain("A provider-filed offer");
    expect(within(el).queryByText(messages.screener.junkLoading)).toBeNull();
    expect(calls.sort()).toEqual(["list", "sweepPreview"]);
  });

  it("a letter set aside into the spam pile reads the page again after the settle; the Junk click paints it", async () => {
    const { JUNK_MOVE_SETTLE_MS } = await import("@ohmail/app-logic/screener/junk-window");
    const pages = [page(junkRow(7, "A provider-filed offer")), page(junkRow(8, "The letter just filed"), junkRow(7, "A provider-filed offer"))];
    let lists = 0;
    let releaseBackground!: () => void;
    const background = new Promise<void>((resolve) => { releaseBackground = resolve; });
    const wire: JunkWire = {
      ...JUNK_WIRE,
      list: async () => {
        const read = lists++;
        if (read >= pages.length) await background;
        return pages[Math.min(read, pages.length - 1)]!;
      },
    };
    const { engine } = await seeded();
    const el = await mount(engine, { folders: true, junkWire: wire });
    await waitFor(() => lists === 1, "the Junk page read from the Ohbox");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      S.pending = [{
        type: "message", op: "create", id: "q2", seq: ++S.seq, updatedAt: NOW.toISOString(),
        entity: msg("q2", { folder: "ohmail/Quarantine", from: PEDLAR, date: "2026-09-16T08:50:00.000Z", updatedAt: NOW.toISOString() }),
      } as unknown as SyncChange];
      await act(async () => { await engine.syncOnce(); });
      await act(async () => { vi.advanceTimersByTime(JUNK_MOVE_SETTLE_MS); });
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() => lists === 2, "the page read again after the pile changed");
    const { go } = await import("../app/shell/routing.js");
    await act(async () => { go("screener"); });
    await waitFor(() => junkButton(el) !== null, "the Screener's Junk segment");
    await chooseJunk(el);
    const pane = junkRows(el).textContent ?? "";
    expect(pane).toContain("The letter just filed");
    expect(within(el).queryByText(messages.screener.junkLoading)).toBeNull();
    await waitFor(() => lists === 3, "the entry after a move reads once behind the painted page");
    await act(async () => { releaseBackground(); });
    expect(lists).toBe(3);
  });
});

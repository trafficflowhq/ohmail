/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { OHBOX_VISIT_ID, type MirrorStore, type OhmailEngine } from "@ohmail/client-engine";
import messages from "../messages/en.json";
import type { JunkWire } from "../app/shell/junk-window";
import type { MailboxFacts } from "../app/shell/mail-state";
import { NOW, S, act, click, consentTransport, engineOver, msg, setup, storeWith, teardown, waitFor } from "./_view-shell";

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
  const { AppShell } = await import("../app/shell/AppShell.js");
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

const whereLine = (el: HTMLElement): HTMLElement | null => el.querySelector(".ohbox-where");
const segments = (el: HTMLElement): string =>
  [...el.querySelectorAll(".scn-seg [role=\"tab\"]")].map((b) => b.textContent ?? "").join(" | ");

describe("the where-line's spam count follows what the Screener's third segment lists", () => {
  it("folders on, the Junk window supported: no spam count, no link to it, the News count kept", async () => {
    const { engine } = await seeded();
    // The Screener's third segment first, as the fixture's own control: it IS the live Junk window
    // (consent read, folders on, a wire to read it from). A Screener visit moves no Ohbox mark.
    const el = await mount(engine, { folders: true, junkWire: JUNK_WIRE }, "#/screener/spam");
    await waitFor(() => segments(el).includes("Junk"), "the Screener's Junk segment");
    expect(segments(el)).not.toContain("Spam");
    const { go } = await import("../app/shell/routing.js");
    await act(async () => { go("ohbox"); });
    await waitFor(() => (whereLine(el)?.textContent ?? "").includes("1 to News"), "the line's News count");
    expect(whereLine(el)!.textContent).not.toContain("Spam");
    expect(el.querySelector('.ohbox-where a[href="#/screener/spam"]')).toBeNull();
  });

  it("positive control: folders off, the count is there, and its link opens the Spam pile that lists the letter", async () => {
    const { engine } = await seeded();
    const el = await mount(engine, { folders: false, junkWire: JUNK_WIRE });
    await waitFor(() => (whereLine(el)?.textContent ?? "").includes("1 to Spam"), "the line's Spam count");
    expect(whereLine(el)!.textContent).toContain("1 to News, 1 to Spam");
    await click(el.querySelector('.ohbox-where a[href="#/screener/spam"]'), "the Spam count's link");
    await waitFor(() => segments(el).includes("Spam"), "the Screener's Spam segment");
    await waitFor(() => (el.textContent ?? "").includes(PEDLAR.name), "the counted letter's sender on the Spam pile");
  });
});

describe("the Screener reads the Junk window before the Spam click", () => {
  it("opening the Screener asks the page and the preview; the click draws both in its own commit", async () => {
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
    await waitFor(() => segments(el).includes("Junk"), "the Screener's Junk segment");
    expect(calls.sort(), "the Screener opened and the Junk window was not read").toEqual(["list", "sweepPreview"]);
    await act(async () => { for (const r of release) r(); });
    const tab = [...el.querySelectorAll(".scn-seg [role=\"tab\"]")].find((b) => (b.textContent ?? "").includes("Junk"));
    await click(tab ?? null, "the Junk tab");
    const pane = el.querySelector(".view-screener")?.textContent ?? "";
    expect(pane).toContain("A provider-filed offer");
    expect(pane, "the Quarantine shelf waited on the click's own read").toContain(PEDLAR.name);
    expect(pane).not.toContain(messages.screener.junkLoading);
    expect(calls).toHaveLength(2);
  });
});

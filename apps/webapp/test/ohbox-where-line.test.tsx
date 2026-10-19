/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { FILED_SINCE_SCAN_MAX, type FiledSince } from "@ohmail/client-engine";
import type { MailState, MailboxFacts } from "../app/shell/mail-state";
import { BROWSER_WINDOW, DESKTOP_WINDOW } from "../app/shell/store-windows";
import { setActiveCatalog } from "../app/shell/locale";

/**
 * THE OHBOX SAYS WHEN MAIL WAS LAST CHECKED AND WHERE IT WENT (row OHBOX-QUIET-READS-AS-STALLED).
 * A quiet Ohbox over mail the sender rules filed elsewhere read as a stopped sync. One line under
 * the title: "Checked {when}" from the mailbox facts, the counts filed since the person was here,
 * each a link to its pile — or, while the sync is unhealthy, the strip's own sentence instead.
 */

(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const QUIET: MailState = {
  key: "quiet", clock: false, count: 0, total: null, reason: null, errorCode: null,
  asOf: null, address: null, minutes: null, slow: false, screenerCandidate: false,
  pending: 0, filing: null, continuesAtFolder: null, settled: true, owed: false,
};

const fact = (lastSyncAt: string | null, extra: Partial<MailboxFacts> = {}): MailboxFacts => ({
  id: "mb_1", address: "rig@example.invalid", status: "connected", errorCode: null, disabledReason: null,
  syncBlockedReason: null, syncBlockedSince: null, lastSyncAt, createdAt: "2026-01-01T00:00:00.000Z", ...extra,
});

let binding: { state: MailState; mailboxes: MailboxFacts[] | null; factsReadAt: () => number | null } = {
  state: QUIET, mailboxes: null, factsReadAt: () => null,
};
vi.mock("../app/shell/MailStateProvider", () => ({
  useMailState: () => ({ ...binding, refresh: () => {} }),
}));

const navigated: string[] = [];
vi.mock("../app/shell/routing", async (importActual) => ({
  ...(await importActual<typeof import("../app/shell/routing")>()),
  go: (view: string) => { navigated.push(`go:${view}`); },
  goScreener: (seg: string) => { navigated.push(`screener:${seg}`); },
}));

const FILED: FiledSince = {
  at: "2026-10-19T08:00:00.000Z",
  counts: [
    { pile: "reads", count: 12 },
    { pile: "receipts", count: 3 },
    { pile: "screened", count: 7 },
    { pile: "spam", count: 9 },
  ],
};
const NONE: FiledSince = { at: "2026-10-19T08:00:00.000Z", counts: [] };

const roots: Root[] = [];
afterEach(async () => {
  for (const r of roots) await act(async () => { r.unmount(); });
  roots.length = 0;
  document.body.innerHTML = "";
  navigated.length = 0;
  vi.useRealTimers();
  setActiveCatalog("en", null);
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
});

/** Healthy facts: one mailbox scanned two minutes ago, read just now. */
function healthy(state: MailState = QUIET): void {
  const readAt = Date.now();
  binding = { state, mailboxes: [fact(new Date(readAt - 120_000).toISOString())], factsReadAt: () => readAt };
}

async function render(
  props: { filed: FiledSince | null; demo?: boolean; hostOffline?: boolean; junkReadable?: boolean },
  opts: { locale?: "en" | "de"; withBar?: boolean } = {},
): Promise<HTMLElement> {
  const { OhboxWhereLine } = await import("../app/shell/OhboxWhereLine.js");
  const { SyncBar } = await import("../app/shell/SyncBar.js");
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const locale = opts.locale ?? "en";
  setActiveCatalog(locale, locale === "en" ? null : (de as never));
  await act(async () => {
    root.render(h(NextIntlClientProvider, {
      locale, messages: locale === "en" ? en : de, timeZone: "UTC",
      children: h(React.Fragment, null,
        opts.withBar ? h(SyncBar, { hostOffline: props.hostOffline ?? false }) : null,
        h(OhboxWhereLine, {
          filed: props.filed, demo: props.demo ?? false, hostOffline: props.hostOffline ?? false,
          junkReadable: props.junkReadable,
        }),
      ),
    } as never));
  });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
  return container;
}

const line = (c: HTMLElement): HTMLElement | null => c.querySelector(".ohbox-where");

describe("a healthy sync", () => {
  it("says when mail was checked and where it went, in English", async () => {
    healthy();
    const c = await render({ filed: FILED });
    expect(line(c)?.textContent).toBe(
      "Checked 2 minutes ago · since you were here: 12 to News, 3 to Receipts, 7 to Screened out, 9 to Spam",
    );
  });

  it("and in German", async () => {
    healthy();
    const c = await render({ filed: FILED }, { locale: "de" });
    expect(line(c)?.textContent).toBe(
      "Geprüft vor 2 Minuten · seit deinem letzten Besuch: 12 in News, 3 in Belege, 7 in Aussortiert, 9 in Spam",
    );
  });

  it("links each count to its pile, in order, through the routing verbs", async () => {
    healthy();
    const c = await render({ filed: FILED });
    const links = [...line(c)!.querySelectorAll("a")];
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["#/reads", "#/receipts", "#/screener/screened", "#/screener/spam"]);
    for (const a of links) await act(async () => { a.click(); });
    expect(navigated).toEqual(["go:reads", "go:receipts", "screener:screened", "screener:spam"]);
  });

  it("leads with the counts, capitalised, while no check can be stated", async () => {
    binding = { state: QUIET, mailboxes: [fact(null)], factsReadAt: () => Date.now() };
    const c = await render({ filed: { ...FILED, counts: FILED.counts.slice(0, 1) } });
    expect(line(c)?.textContent).toBe("Since you were here: 12 to News");
  });
});

/**
 * WITH "USE FOLDERS" ON, THE SCREENER'S THIRD SEGMENT IS THE LIVE JUNK WINDOW (`junkReadable`): the
 * provider's own Junk folder read from the server, not the mirror's Spam pile the count comes from.
 * What ohmail's own patterns set aside, and all spam of a mailbox with no Junk folder, stays in that
 * pile and never reaches the window, so "9 to Spam" opened a list that held none of the nine. Every
 * count the line shows must open a view that lists those letters; the spam count is left out there.
 */
describe("while the Screener's third segment is the live Junk window", () => {
  it("leaves the spam count and its link out, and keeps every other pile", async () => {
    healthy();
    const c = await render({ filed: FILED, junkReadable: true });
    expect(line(c)?.textContent).toBe(
      "Checked 2 minutes ago · since you were here: 12 to News, 3 to Receipts, 7 to Screened out",
    );
    expect([...line(c)!.querySelectorAll("a")].map((a) => a.getAttribute("href")))
      .toEqual(["#/reads", "#/receipts", "#/screener/screened"]);
    expect(c.querySelector('a[href="#/screener/spam"]')).toBeNull();
  });

  it("spam alone: no since clause, and no element at all once the check is withheld too", async () => {
    const spamOnly: FiledSince = { ...FILED, counts: [{ pile: "spam", count: 9 }] };
    healthy();
    const c = await render({ filed: spamOnly, junkReadable: true });
    expect(line(c)?.textContent).toBe("Checked 2 minutes ago");
    expect(line(c)?.querySelector("a")).toBeNull();
    binding = { state: QUIET, mailboxes: [fact(null)], factsReadAt: () => Date.now() };
    const bare = await render({ filed: spamOnly, junkReadable: true });
    expect(bare.innerHTML).toBe("");
  });

  it("positive control: folders off, the third segment is the Spam pile, counted and linked", async () => {
    healthy();
    const c = await render({ filed: FILED, junkReadable: false });
    expect(line(c)?.textContent).toContain("7 to Screened out, 9 to Spam");
    expect(c.querySelector('a[href="#/screener/spam"]')?.textContent).toBe("9 to Spam");
  });
});

describe("nothing filed", () => {
  it("says only when mail was checked", async () => {
    healthy();
    const c = await render({ filed: NONE });
    expect(line(c)?.textContent).toBe("Checked 2 minutes ago");
    expect(line(c)?.querySelector("a")).toBeNull();
  });

  it("draws no element at all when the check is withheld too", async () => {
    binding = { state: QUIET, mailboxes: [fact(null)], factsReadAt: () => Date.now() };
    for (const filed of [NONE, null]) {
      const c = await render({ filed });
      expect(c.innerHTML).toBe("");
    }
  });
});

describe("an unhealthy sync says the strip's sentence instead", () => {
  const STALE: MailState = { ...QUIET, key: "stale", clock: true, asOf: "2026-10-16T08:00:00.000Z" };
  const cases: MailState[] = [
    STALE,
    { ...QUIET, key: "failing" },
    { ...QUIET, key: "stopped" },
    { ...QUIET, key: "blocked", reason: "at_capacity", address: "rig@example.invalid" },
    { ...QUIET, key: "mailboxError", errorCode: "auth", address: "rig@example.invalid" },
    { ...QUIET, key: "catchingUp" },
    { ...QUIET, key: "ownerLost" },
  ];
  for (const state of cases) {
    it(`${state.key}: the strip's title, no check, no counts, no links`, async () => {
      healthy(state);
      const c = await render({ filed: FILED }, { withBar: true });
      const said = c.querySelector(".sync-bar b")?.textContent;
      expect(said).toBeTruthy();
      expect(line(c)?.textContent).toBe(said);
      expect(line(c)?.querySelector("a, time")).toBeNull();
    });
  }

  it("offline over a fetch-shaped state: the offline word, as the strip says it", async () => {
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    healthy(STALE);
    const c = await render({ filed: FILED }, { withBar: true });
    expect(line(c)?.textContent).toBe("Offline — showing what this device holds.");
    expect(line(c)?.textContent).toBe(c.querySelector(".sync-bar b")?.textContent);
  });

  it("a paired desktop whose host is off: stale says nothing, as the strip does", async () => {
    healthy(STALE);
    const c = await render({ filed: FILED, hostOffline: true }, { withBar: true });
    expect(c.innerHTML).toBe("");
  });

  it("positive control: the same fixture, quiet, shows the counts", async () => {
    healthy(QUIET);
    const c = await render({ filed: FILED }, { withBar: true });
    expect(line(c)?.querySelectorAll("a")).toHaveLength(4);
  });
});

describe("states the line leaves alone", () => {
  const silent: Array<[string, MailState, boolean]> = [
    ["importing", { ...QUIET, key: "importing", count: 40 }, false],
    ["awaiting", { ...QUIET, key: "awaiting" }, false],
    ["noMailbox", { ...QUIET, key: "noMailbox" }, false],
    ["the skeleton (not settled)", { ...QUIET, settled: false }, false],
    ["the pending state (owed)", { ...QUIET, owed: true }, false],
    ["the demo", QUIET, true],
  ];
  for (const [name, state, demo] of silent) {
    it(`${name}: nothing`, async () => {
      healthy(state);
      const c = await render({ filed: FILED, demo });
      expect(c.innerHTML).toBe("");
    });
  }
});

describe("for keyboards and screen readers", () => {
  it("is no live region, its links take the Tab and carry their own words, and the time is exact", async () => {
    healthy();
    const c = await render({ filed: FILED });
    const p = line(c)!;
    expect(p.getAttribute("role")).toBeNull();
    expect(p.getAttribute("aria-live")).toBeNull();
    expect(p.querySelector("[role], [aria-live]")).toBeNull();
    for (const a of p.querySelectorAll("a")) {
      expect(a.hasAttribute("href")).toBe(true);
      expect(a.getAttribute("tabindex")).toBeNull();
      expect(a.getAttribute("aria-label")).toBeNull();
      a.focus();
      expect(document.activeElement).toBe(a);
    }
    const time = p.querySelector("time")!;
    expect(time.getAttribute("dateTime")).toBe(binding.mailboxes![0]!.lastSyncAt);
    expect(time.getAttribute("title")).toMatch(/2026|20\d\d/);
  });
});

describe("the age of the facts", () => {
  it("drops the check after 90 seconds without a read, and keeps the counts", async () => {
    vi.useFakeTimers();
    healthy();
    const c = await render({ filed: FILED });
    expect(line(c)?.textContent).toContain("Checked");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(line(c)?.textContent, "within the bound").toContain("Checked");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(line(c)?.textContent).not.toContain("Checked");
    expect(line(c)?.textContent).toContain("Since you were here: 12 to News");
  });
});

describe("the list is not touched", () => {
  it("the scan bound sits inside every shipped web window", () => {
    expect(FILED_SINCE_SCAN_MAX).toBeLessThanOrEqual(BROWSER_WINDOW.minRows);
    expect(FILED_SINCE_SCAN_MAX).toBeLessThanOrEqual(DESKTOP_WINDOW.minRows);
  });

  it("the shell puts the line first in the header slot, before the offer, and withholds it with the strip", () => {
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    const slot = /noticeSection=\{([\s\S]*?)\n\s*resurfacedRows=\{/.exec(shell)?.[1] ?? "";
    expect(slot).toMatch(/<OhboxWhereLine[^>]*\/>\s*\)\}\s*\{offer\}/);
    // …and withheld where the strip is: a refused session's card says it, never "Retrying".
    expect(slot).toMatch(/\{sessionRefused \? null : \(\s*<OhboxWhereLine/);
  });

  it("OhboxView renders the same rows with and without the line; line, offer, doorbell in that order", async () => {
    healthy();
    const { OhboxView } = await import("../app/views/OhboxView.js");
    const { KeymapProvider } = await import("../app/shell/keymap.js");
    const { OhboxWhereLine } = await import("../app/shell/OhboxWhereLine.js");
    (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = ((query: string) => ({
      matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
      addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
    })) as never;
    const row = (id: string, unread: boolean) => ({
      id, accountId: "a", mailboxId: "mb", threadId: null, messageIdHeader: null,
      subject: `subj-${id}`, from: { name: id, address: `${id}@ex.example` }, to: [], cc: [],
      date: "2026-10-19T09:00:00.000Z", folder: "INBOX", snippet: `snip-${id}`, unread,
      hasAttachments: false, attachmentCount: 0,
      sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
      triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-19T09:00:00.000Z",
    });
    const view = (notice: React.ReactNode) => h(NextIntlClientProvider, {
      locale: "en", messages: en, timeZone: "UTC",
      children: h(KeymapProvider as never, { children: h(OhboxView as never, {
        owed: false, demo: false, settled: true,
        older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
        resurfacedRows: [], newForYou: [row("n1", true)], previouslySeen: [row("p1", false)],
        replyDone: null, tags: [], now: new Date("2026-10-19T10:00:00.000Z"), selectedId: null,
        onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
        onMarkSeen: () => {},
        bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
        doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
        onMarkAllRead: () => {}, noticeSection: notice,
      } as never) } as never),
    } as never);
    const draw = async (notice: React.ReactNode): Promise<HTMLElement> => {
      const host = document.createElement("div");
      document.body.appendChild(host);
      const root = createRoot(host);
      roots.push(root);
      await act(async () => { root.render(view(notice)); });
      return host;
    };
    const bare = await draw(undefined);
    const withLine = await draw(h(React.Fragment, null,
      h(OhboxWhereLine, { filed: FILED, demo: false }),
      h("div", { className: "ohx-notice" }, "offer"),
    ));
    expect(withLine.querySelector(".scroller")!.innerHTML).toBe(bare.querySelector(".scroller")!.innerHTML);
    const order = [...withLine.querySelectorAll(".ohbox-where, .ohx-notice, .doorbell")].map((e) => e.className.split(" ")[0]);
    expect(order).toEqual(["ohbox-where", "ohx-notice", "doorbell"]);
  });
});

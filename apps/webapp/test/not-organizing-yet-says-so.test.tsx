/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import en from "../messages/en.json";
import { settleFirstPaint } from "./_first-paint.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  nothingOrganizesOf, notOrganizingYetOf, readerStandDown, type MailboxFacts, type NotOrganizingYet, type ScreenerRole,
} from "@ohmail/app-logic/mail-state/mail-state";
import type { ScreenerState } from "../app/shell/screener-state";

/**
 * A MAILBOX NOBODY AGREED TO ORGANIZE IS NOT CALLED SCREENED (self-host 0.25.19): the first run left
 * before "Agree and start organizing", a never-seen sender landed in the Ohbox, and the Screener said "First-time
 * senders appear here before anything reaches the Ohbox". Where every mailbox is such a one, the Screener's empty
 * state, its header count and the Ohbox's doorbell say ohmail is not organizing it yet, with the press that opens the
 * organize decision. A mailbox another install holds, a consented one and an unread lease keep what they said.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollTo ??= function scrollTo() {};

const NOW = new Date("2026-10-09T11:00:00.000Z");
const ORGANIZES: ScreenerRole = { mode: "organizer", name: null, reason: null, oauthOnly: false };
const HINT = en.screener.empty.waiting.hint;
const NOT_YET_ONE = "ohmail is not organizing this mailbox yet.";

function fact(over: Partial<MailboxFacts> & { id: string }): MailboxFacts {
  return {
    address: `${over.id}@family.example`, status: "connected", errorCode: null, disabledReason: null,
    syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null, createdAt: "2026-10-09T10:00:00.000Z",
    organizerRole: "reader", organizedBy: null, organizerState: null, organizeConsentedAt: null,
    ...over,
  } as MailboxFacts;
}

describe("notOrganizingYetOf — the rows it names", () => {
  it("names a connected reader nobody agreed to and nothing holds, and says when it is every one", () => {
    expect(notOrganizingYetOf([fact({ id: "a" })])).toEqual({
      mailboxes: [{ id: "a", address: "a@family.example" }], every: true,
    });
  });

  it("CONTROL: a consented mailbox, an organizer, a live holder, an unread lease and absent consent name nothing", () => {
    expect(notOrganizingYetOf([fact({ id: "a", organizeConsentedAt: "2026-10-09T10:01:00.000Z" })])).toBeNull();
    expect(notOrganizingYetOf([fact({ id: "a", organizerRole: "organizer" })])).toBeNull();
    expect(notOrganizingYetOf([fact({
      id: "a", organizedBy: { kind: "desktop", name: "Laptop", since: null }, organizerState: "held",
    })])).toBeNull();
    expect(notOrganizingYetOf([fact({ id: "a", organizerChecked: false })])).toBeNull();
    const absent = fact({ id: "a" }) as Partial<MailboxFacts>;
    delete absent.organizeConsentedAt;
    expect(notOrganizingYetOf([absent as MailboxFacts])).toBeNull();
    expect(notOrganizingYetOf(null)).toBeNull();
  });

  it("a holder whose lease lapsed organizes nothing, so the mailbox is named", () => {
    expect(notOrganizingYetOf([fact({
      id: "a", organizedBy: { kind: "desktop", name: "Laptop", since: null }, organizerState: "stopped",
    })])?.every).toBe(true);
  });

  it("one roster, one answer: the shell asks in its render and the views keep a stable object", () => {
    const rows = [fact({ id: "a" })];
    expect(notOrganizingYetOf(rows)).toBe(notOrganizingYetOf(rows));
    expect(notOrganizingYetOf([fact({ id: "a" })])).not.toBe(notOrganizingYetOf(rows));
  });

  it("a mixed account names only the unorganized one, and is not every; a removed row is not counted", () => {
    const got = notOrganizingYetOf([
      fact({ id: "a" }), fact({ id: "b", organizeConsentedAt: "2026-10-09T10:01:00.000Z", organizerRole: "organizer" }),
      fact({ id: "gone", status: "disabled" }),
    ]);
    expect(got).toEqual({ mailboxes: [{ id: "a", address: "a@family.example" }], every: false });
  });
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function screenerState(): ScreenerState {
  return {
    waiting: [], waitingCount: 0, waitingSource: "store", queueAnswered: true,
    suggestedCount: 0, suggestedDests: [],
    waitingMore: { available: false, loading: false, failed: false, load: () => {} }, rereadWaiting: () => {},
    unsuggestedSenders: [], suggestedSenders: [], applying: null, screenedOut: [], spam: [],
    isExiting: () => false, refused: () => false, bodyStall: () => null,
    decide: () => {}, applyAll: () => {}, markAllSpam: () => {}, allowScreened: () => {},
    notSpamToWaiting: () => {}, notSpamToOhbox: () => {}, deleteSpam: () => {}, flush: () => {},
    role: ORGANIZES, pending: [], decided: [], notApplied: [],
  } as unknown as ScreenerState;
}

async function mount(node: React.ReactElement): Promise<HTMLElement> {
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale: "en", messages: en as never, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider as never, { children: node } as never),
    }));
  });
  await settleFirstPaint();
  return host;
}

async function screener(notOrganizingYet: NotOrganizingYet | null): Promise<HTMLElement> {
  const { ScreenerView } = await import("../app/views/ScreenerView.js");
  return mount(h(ScreenerView as never, {
    state: screenerState(), segment: "waiting", selection: { waiting: null, screened: null, spam: null },
    settled: true, owed: false, storeImportOpen: false,
    onSelect: () => {}, hydrateBody: () => {}, hydrateBodies: () => {}, full: false, onFull: () => {},
    notOrganizingYet,
  } as never));
}

/** A never-seen sender in the Ohbox — what a mailbox nothing screens looks like. */
const stranger = {
  id: "m1", accountId: "a", mailboxId: "mb-1", threadId: null, messageIdHeader: null, subject: "Hello",
  from: { name: "Ada Stranger", address: "ada@first-time.example" }, to: [], cc: [],
  date: "2026-10-09T10:50:00.000Z", folder: "INBOX", snippet: "s", unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: "2026-10-09T10:50:00.000Z",
};

async function ohbox(notOrganizingYet: NotOrganizingYet | null, more: Record<string, unknown> = {}): Promise<HTMLElement> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  return mount(h(OhboxView as never, {
    owed: false, demo: false, settled: true,
    older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
    // One row: an empty Ohbox renders the sync strip, which reads the shell's provider this harness does not mount.
    resurfacedRows: [], newForYou: [stranger], previouslySeen: [], replyDone: null, tags: [], now: NOW,
    selectedId: null, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
    onMarkSeen: () => {},
    bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
    doorbellInitials: [], doorbellCount: 0, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    notOrganizingYet, ...more,
  } as never));
}

const text = (el: HTMLElement) => el.textContent ?? "";
const pressNamed = (el: HTMLElement, name: string) => [...el.querySelectorAll("button")].filter((b) => b.textContent === name);

beforeEach(() => {
  (window as unknown as { matchMedia: (q: string) => MediaQueryList }).matchMedia = (query: string) => ({
    matches: false, media: query, onchange: null, addListener() {}, removeListener() {},
    addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; },
  }) as unknown as MediaQueryList;
  window.location.hash = "";
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = null;
  host?.remove();
  host = null;
  vi.restoreAllMocks();
});

const EVERY: NotOrganizingYet = { mailboxes: [{ id: "mb-1", address: "box@family.example" }], every: true };
const MIXED: NotOrganizingYet = { mailboxes: [{ id: "mb-2", address: "side@family.example" }], every: false };

describe("the Screener over a mailbox nothing organizes", () => {
  it("says it is not organizing yet, never the screening sentence, and its header is not 'all clear'", async () => {
    const el = await screener(EVERY);
    expect(text(el)).toContain(NOT_YET_ONE);
    expect(text(el)).toContain(en.screener.notYetWhy);
    expect(text(el), "the screening claim over a mailbox nothing screens").not.toContain(HINT);
    expect(text(el)).toContain(en.screener.metaNotYet);
    expect(text(el)).not.toContain("all clear");
  });

  it("its press opens the organize decision for that mailbox — the re-run, which opens on the consent statement", async () => {
    const el = await screener(EVERY);
    const press = pressNamed(el, en.screener.notYetPress);
    expect(press).toHaveLength(1);
    await act(async () => { press[0]!.click(); });
    expect(window.location.hash).toBe("#/first-run/again?mailbox=mb-1");
  });

  it("a mixed account keeps the screening sentence for the organized mailboxes and names the other, never 'all clear'", async () => {
    const el = await screener(MIXED);
    expect(text(el)).toContain(HINT);
    expect(text(el)).toContain("ohmail is not organizing side@family.example yet");
    expect(pressNamed(el, en.screener.notYetPress)).toHaveLength(1);
    expect(text(el), "'all clear' over a mailbox nothing organizes").not.toContain("all clear");
    expect(text(el)).toContain("not organizing side@family.example");
  });

  it("CONTROL: an organized account reads exactly as before", async () => {
    const el = await screener(null);
    expect(text(el)).toContain(HINT);
    expect(text(el)).toContain("all clear");
    expect(text(el)).not.toContain("not organizing");
    expect(pressNamed(el, en.screener.notYetPress)).toHaveLength(0);
  });
});

describe("the Ohbox doorbell over a mailbox nothing organizes", () => {
  const doorbell = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button.doorbell");

  it("is DRAWN, says not organizing yet, and opens the organize decision", async () => {
    const el = await ohbox(EVERY);
    const bell = doorbell(el)!;
    expect(bell.classList.contains("gone"), "collapsed, nobody reads it").toBe(false);
    expect(bell.textContent).toContain("Not organizing yet");
    expect(bell.textContent).not.toContain("All clear");
    expect(bell.getAttribute("aria-label")).toBe(en.ohbox.doorbellNotYetAria);
    await act(async () => { bell.click(); });
    expect(window.location.hash).toBe("#/first-run/again?mailbox=mb-1");
  });

  it("CONTROL: an organized account keeps the collapsed 'All clear' bell that opens the Screener", async () => {
    const el = await ohbox(null);
    const bell = doorbell(el)!;
    expect(bell.classList.contains("gone")).toBe(true);
    expect(bell.textContent).toContain("All clear");
  });

  it("draws no bell, not even 'All clear', while the Screener's queue is not read yet", async () => {
    const el = await ohbox(null, { doorbellSettled: false });
    expect(doorbell(el)).toBeNull();
    expect(text(el)).not.toContain("All clear");
  });

  it("a mixed account names the mailbox nothing organizes rather than 'All clear', and its press is that mailbox's", async () => {
    const el = await ohbox(MIXED);
    const bell = doorbell(el)!;
    expect(bell.textContent).not.toContain("All clear");
    expect(bell.textContent).toContain("Not organizing");
    expect(bell.textContent).toContain("side@family.example");
    await act(async () => { bell.click(); });
    expect(window.location.hash).toBe("#/first-run/again?mailbox=mb-2");
  });
});

/**
 * A MAILBOX HANDED BACK, OR WHOSE HOLDER STOPPED, IS NOT SCREENED EITHER. After "Hand the mailbox back" a stranger
 * landed in the Ohbox while the Screener said "all clear · First-time senders appear here before anything reaches the
 * Ohbox" and the Ohbox showed no line at all. Consent stands there, so the press is Organize here, in Mailboxes, and
 * the line is a standing state rather than a notice somebody can dismiss.
 */
const T = "2026-10-09T10:01:00.000Z";
const HANDED_BACK: NotOrganizingYet = { mailboxes: [{ id: "mb-1", address: "box@family.example", why: "handed_back" }], every: true };
const STOPPED: NotOrganizingYet = { mailboxes: [{ id: "mb-1", address: "box@family.example", why: "stopped" }], every: true };

describe("nothingOrganizesOf — every mailbox nothing organizes, and why", () => {
  it("names a handed-back mailbox and one whose holder stopped, beside the never-agreed one", () => {
    expect(nothingOrganizesOf([
      fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T }),
      fact({ id: "b", organizeConsentedAt: T, organizedBy: { kind: "mobile", name: "Pixel", since: T }, organizerState: "stopped" }),
      fact({ id: "c" }),
    ])).toEqual({
      mailboxes: [
        { id: "a", address: "a@family.example", why: "handed_back" },
        { id: "b", address: "b@family.example", why: "stopped" },
        { id: "c", address: "c@family.example", why: "never_agreed" },
      ],
      every: true,
    });
  });

  it("CONTROL: an organizer, a live holder, an unread lease, a removal and a pause name nothing", () => {
    expect(nothingOrganizesOf([fact({ id: "a", organizerRole: "organizer", organizeConsentedAt: T })])).toBeNull();
    expect(nothingOrganizesOf([fact({
      id: "a", organizeConsentedAt: T, organizedBy: { kind: "local", name: "Laptop", since: null }, organizerState: "held",
    })])).toBeNull();
    expect(nothingOrganizesOf([fact({ id: "a", organizeConsentedAt: T, organizerChecked: false })])).toBeNull();
    expect(nothingOrganizesOf([fact({ id: "a", status: "disabled", organizeConsentedAt: T, organizerReleasedAt: T })])).toBeNull();
    expect(nothingOrganizesOf([fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T, organizerParkedAt: T })])).toBeNull();
    // The decision reopen asks the never-agreed reading, which a hand-back is not.
    expect(notOrganizingYetOf([fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T })])).toBeNull();
  });

  it("the stand-down the Mailboxes row reads is unchanged for a hand-back, and a pending Organize here keeps it", () => {
    const back = fact({ id: "a", organizeConsentedAt: T, organizerReleasedAt: T });
    expect(readerStandDown(back)).toBe("released");
    expect(readerStandDown({ ...back, takeoverAuthorizedAt: T } as MailboxFacts)).toBe("released");
    expect(readerStandDown({ ...back, organizerChecked: false } as MailboxFacts)).toBe("released");
  });

  it("the shell hands the Ohbox and the Screener this set, not the never-agreed one", () => {
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    expect(shell.match(/notOrganizingYet=\{demo \? null : nothingOrganizesOf\(facts\)\}/g)).toHaveLength(2);
    expect(shell).not.toMatch(/notOrganizingYet=\{demo \? null : notOrganizingYetOf\(facts\)\}/);
  });
});

describe("the Screener over a mailbox handed back or whose holder stopped", () => {
  it("says it was handed back, never the screening sentence, and its header is not 'all clear'", async () => {
    const el = await screener(HANDED_BACK);
    expect(text(el)).toContain("You handed this mailbox back.");
    expect(text(el)).toContain(en.screener.notOrganizingWhy);
    expect(text(el), "the screening claim over a mailbox nothing screens").not.toContain(HINT);
    expect(text(el)).not.toContain(en.screener.empty.waiting.title);
    expect(text(el)).toContain(en.screener.metaHandedBack);
    expect(text(el)).not.toContain("all clear");
  });

  it("its press opens Mailboxes, where Organize here is, and never the consent statement", async () => {
    const el = await screener(HANDED_BACK);
    expect(pressNamed(el, en.screener.notYetPress)).toHaveLength(0);
    const press = pressNamed(el, en.screener.notOrganizingPress);
    expect(press).toHaveLength(1);
    await act(async () => { press[0]!.click(); });
    expect(window.location.hash).toBe("#/settings/mailboxes");
  });

  it("a holder that stopped says nothing organizes the mailbox", async () => {
    const el = await screener(STOPPED);
    expect(text(el)).toContain("Nothing organizes this mailbox.");
    expect(text(el)).toContain(en.screener.metaNotOrganizing);
    expect(text(el)).not.toContain("all clear");
  });

  it("a mixed account names the handed-back mailbox beside the screening sentence, never 'all clear'", async () => {
    const el = await screener({ mailboxes: [{ id: "mb-2", address: "side@family.example", why: "handed_back" }], every: false });
    expect(text(el)).toContain(HINT);
    expect(text(el)).toContain("You handed side@family.example back");
    expect(text(el)).not.toContain("all clear");
    expect(text(el)).toContain("not organizing side@family.example");
  });
});

describe("the Ohbox doorbell over a mailbox handed back or whose holder stopped", () => {
  const doorbell = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button.doorbell");

  it("is DRAWN, says handed back, never 'All clear', and opens Mailboxes", async () => {
    const el = await ohbox(HANDED_BACK);
    const bell = doorbell(el)!;
    expect(bell.classList.contains("gone"), "collapsed, nobody reads it").toBe(false);
    expect(bell.textContent).toContain("Handed back");
    expect(bell.textContent).not.toContain("All clear");
    expect(bell.getAttribute("aria-label")).toBe(en.ohbox.doorbellHandedBackAria);
    await act(async () => { bell.click(); });
    expect(window.location.hash).toBe("#/settings/mailboxes");
  });

  it("a mixed account with a handed-back mailbox names it, and opens Mailboxes", async () => {
    const el = await ohbox({ mailboxes: [{ id: "mb-2", address: "side@family.example", why: "handed_back" }], every: false });
    const bell = doorbell(el)!;
    expect(bell.textContent).not.toContain("All clear");
    expect(bell.textContent).toContain("side@family.example");
    await act(async () => { bell.click(); });
    expect(window.location.hash).toBe("#/settings/mailboxes");
  });

  it("a holder that stopped draws the not-organizing bell", async () => {
    const el = await ohbox(STOPPED);
    const bell = doorbell(el)!;
    expect(bell.textContent).toContain("Not organizing");
    expect(bell.textContent).not.toContain("All clear");
    expect(bell.getAttribute("aria-label")).toBe(en.ohbox.doorbellNotOrganizingAria);
  });
});

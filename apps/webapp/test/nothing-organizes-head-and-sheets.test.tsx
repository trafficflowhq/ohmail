/** @vitest-environment jsdom */
/* @reads: apps/webapp/app/shell/AppShell.tsx */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MemoryMirrorStore, consentPartition, type EngineMessage, type MirrorStore } from "@ohmail/client-engine";
import en from "../messages/en.json";
import de from "../messages/de.json";
import { settleFirstPaint } from "./_first-paint.js";
import { otherOrganizerOf, type MailboxFacts, type NotOrganizingYet } from "@ohmail/app-logic/mail-state/mail-state";
import { SenderMenu } from "../app/shell/SenderMenu";
import { SubjectRuleSheet } from "../app/shell/SubjectRuleSheet";
import { senderScreening } from "@ohmail/app-logic/press/sender-screening";
import { subjectRuleContext } from "@ohmail/app-logic/press/subject-rule";

/**
 * AFTER A HAND-BACK, THE OHBOX HEAD AND THE SENDER SHEETS SAY NOTHING ORGANIZES THE MAILBOX
 * (self-host 0.25.22). The head read "2 waiting · Screener" over a stranger that went
 * straight to the Ohbox, because its nothing-organizes arms stood only at zero waiting; the sender
 * sheet promised "Future mail … files there too", because `otherOrganizerOf` read a reader with no
 * recorded holder as this install organizing it. Both now map from `organizerSituation`.
 */

(globalThis as unknown as { React: unknown }).React = React;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
(globalThis as unknown as { CSS: { escape: (s: string) => string } }).CSS ??= {
  escape: (v: string) => String(v).replace(/["\\]/g, "\\$&"),
};
Element.prototype.scrollTo ??= function scrollTo() {};
process.env.NEXT_PUBLIC_API_BASE = "/api";

const NOW = new Date("2026-10-12T01:00:00.000Z");
const T = "2026-10-12T00:25:01.000Z";

function row(over: Partial<MailboxFacts>): MailboxFacts {
  return {
    id: "mb", address: "me@family.example", status: "connected", errorCode: null, disabledReason: null,
    syncBlockedReason: null, syncBlockedSince: null, lastSyncAt: null, createdAt: T,
    organizerRole: "reader", organizedBy: null, organizerState: null, organizeConsentedAt: T,
    ...over,
  } as MailboxFacts;
}
const HANDED_BACK = row({ organizerReleasedAt: T });
const STOPPED = row({ organizedBy: { kind: "mobile", name: "Pixel", since: T }, organizerState: "stopped" });
const NEVER = row({ organizeConsentedAt: null });
const LIVE = row({ organizedBy: { kind: "local", name: "Studio laptop", since: T }, organizerState: "held" });
const HERE = row({ organizerRole: "organizer" });
const UNREAD = row({ organizerChecked: false });
const PARKED = row({ organizerReleasedAt: T, organizerParkedAt: T });
const ONE = new Set(["mb"]);

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function mount(node: React.ReactElement, locale: "en" | "de" = "en"): Promise<HTMLElement> {
  const { KeymapProvider } = await import("../app/shell/keymap.js");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(NextIntlClientProvider, {
      locale, messages: (locale === "de" ? de : en) as never, timeZone: "UTC", now: NOW,
      children: h(KeymapProvider as never, { children: node } as never),
    }));
  });
  await settleFirstPaint();
  return host;
}

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

describe("otherOrganizerOf — the sheet's organizer, from the one derivation", () => {
  it("a hand-back, a holder that stopped and a mailbox nobody agreed to: nothing organizes it", () => {
    for (const r of [HANDED_BACK, STOPPED, NEVER]) expect(otherOrganizerOf([r], ONE)).toEqual({ name: null, nobody: true });
  });

  it("CONTROL: a live holder is named; this install, an unread lease and a pause claim nothing", () => {
    expect(otherOrganizerOf([LIVE], ONE)).toEqual({ name: "Studio laptop", nobody: false });
    for (const r of [HERE, UNREAD, PARKED]) expect(otherOrganizerOf([r], ONE)).toBeUndefined();
    expect(otherOrganizerOf([HANDED_BACK], new Set(["another"])), "a mailbox the subject is not in").toBeUndefined();
  });

  it("a live holder on one of the subject's mailboxes outranks one nothing organizes", () => {
    expect(otherOrganizerOf([HANDED_BACK, { ...LIVE, id: "mb2" }], new Set(["mb", "mb2"])))
      .toEqual({ name: "Studio laptop", nobody: false });
  });
});

async function freshStore(list: EngineMessage[]): Promise<MirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(list.map((m, i) => ({
    type: "message" as const, op: "create" as const, id: m.id, seq: i + 1, updatedAt: m.updatedAt, entity: m,
  })));
  return store;
}
const letter = (id: string, subject: string): EngineMessage => ({
  id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null, subject,
  from: { name: "Heron", address: "heron@rig.invalid" }, to: [], cc: [], date: T, folder: "INBOX", snippet: "s",
  unread: true, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: T,
});
const PROMISES = ["files there too", "applies the rule", "This moves the mail that is here"];

describe("the sender sheet over a mailbox nothing organizes", () => {
  async function sheet(facts: readonly MailboxFacts[], locale: "en" | "de" = "en"): Promise<HTMLElement> {
    const store = await freshStore([letter("m1", "Hello")]);
    const sender = senderScreening(store, "m1", undefined, consentPartition(store, { now: NOW }).placeOf)!;
    return mount(h(SenderMenu, {
      state: { messageId: "m1", x: 0, y: 0 }, sender, onChoose: () => {}, onOpenDetail: () => {},
      onClose: () => {}, organizer: otherOrganizerOf(facts, ONE),
    } as never), locale);
  }

  it("a hand-back says nothing organizes it in place of the filing promise, en and de", async () => {
    let el = await sheet([HANDED_BACK]);
    expect(el.querySelector(".sm-org")?.textContent).toBe(en.screening.orgNobody);
    expect(el.querySelector(".sm-foot"), "the foot promised filing nothing performs").toBeNull();
    for (const p of PROMISES) expect(el.textContent).not.toContain(p);
    await act(async () => { root!.unmount(); });
    root = null;
    el = await sheet([HANDED_BACK], "de");
    expect(el.querySelector(".sm-org")?.textContent).toBe(de.screening.orgNobody);
  });

  it("CONTROL: where this install organizes it the foot says what a press files", async () => {
    const el = await sheet([HERE]);
    expect(el.querySelector(".sm-org")).toBeNull();
    expect(el.querySelector(".sm-foot")?.textContent ?? "").not.toBe("");
  });
});

describe("the subject-rule sheet over a mailbox nothing organizes", () => {
  async function subjectSheet(nobody: boolean): Promise<HTMLElement> {
    const store = await freshStore([letter("m1", "Invoice 12"), letter("m2", "Invoice 13")]);
    return mount(h(SubjectRuleSheet, {
      state: { messageId: "m1", x: 0, y: 0 }, ctx: subjectRuleContext(store, "m1")!, nobody,
      onConfirm: () => {}, onClose: () => {},
    } as never));
  }
  const choose = async (el: HTMLElement) => {
    const option = el.querySelector<HTMLLIElement>("li[role=option]")!;
    await act(async () => { option.click(); });
  };

  it("says so beside the destinations and in the confirm, never what the rule would file", async () => {
    const el = await subjectSheet(true);
    expect(el.querySelector(".sm-org")?.textContent).toBe(en.screening.subjectOrgNobody);
    await choose(el);
    const confirm = el.querySelector(".sm-confirm")!;
    expect(confirm.textContent).toContain(en.screening.subjectOrgNobody);
    expect(confirm.textContent, "the confirm promised filing nothing performs").not.toContain("applies the rule");
  });

  it("CONTROL: an organized mailbox keeps the confirm's own sentence", async () => {
    const el = await subjectSheet(false);
    expect(el.querySelector(".sm-org")).toBeNull();
    await choose(el);
    expect(el.querySelector(".sm-confirm")!.textContent).not.toContain(en.screening.subjectOrgNobody);
  });

  it("the shell hands it the same answer the sender sheet reads", () => {
    const shell = readFileSync(resolve(process.cwd(), "apps/webapp/app/shell/AppShell.tsx"), "utf8");
    expect(shell).toMatch(/nobody=\{otherOrganizerOf\(facts, new Set\(subjectRuleFor\.messages\.map\(\(m\) => m\.mailboxId\)\)\)\?\.nobody === true\}/);
  });
});

/** A never-seen sender in the Ohbox — what a mailbox nothing screens looks like. */
const stranger = letter("s1", "ohmail-e2e r22 Heron1");

async function ohbox(notOrganizingYet: NotOrganizingYet | null, doorbellCount: number): Promise<HTMLElement> {
  const { OhboxView } = await import("../app/views/OhboxView.js");
  return mount(h(OhboxView as never, {
    owed: false, demo: false, settled: true,
    older: { available: false, items: [], loading: false, error: null, exhausted: false, loadMore: () => {} },
    resurfacedRows: [], newForYou: [stranger], previouslySeen: [], replyDone: null, tags: [], now: NOW,
    selectedId: null, onSelect: () => {}, onEnterReader: () => {}, readerId: null, readSetFor: (id: string) => [id],
    onMarkSeen: () => {},
    bulk: { run: () => {}, tag: () => {}, screenPreview: () => ({ senders: 0, messages: 0, rules: 0 }), screen: () => {} },
    doorbellInitials: ["W", "K"], doorbellCount, onDoorbell: () => {}, onAction: () => {}, onAddTag: () => {},
    notOrganizingYet,
  } as never));
}
const bell = (el: HTMLElement) => el.querySelector<HTMLButtonElement>("button.doorbell")!;
const EVERY_BACK: NotOrganizingYet = { mailboxes: [{ id: "mb", address: "me@family.example", why: "handed_back" }], every: true };

describe("the Ohbox head over a mailbox nothing organizes, with senders still waiting", () => {
  it("says handed back and opens Mailboxes, never 'N waiting · Screener'", async () => {
    const el = await ohbox(EVERY_BACK, 2);
    expect(bell(el).textContent).toContain("Handed back");
    expect(bell(el).textContent, "the waiting count took the state's place").not.toContain("waiting");
    expect(bell(el).getAttribute("aria-label")).toBe(en.ohbox.doorbellHandedBackAria);
    await act(async () => { bell(el).click(); });
    expect(window.location.hash).toBe("#/settings/mailboxes");
  });

  it("a holder that stopped says not organizing", async () => {
    const el = await ohbox({ mailboxes: [{ id: "mb", address: "me@family.example", why: "stopped" }], every: true }, 3);
    expect(bell(el).textContent).toContain("Not organizing");
    expect(bell(el).textContent).not.toContain("waiting");
  });

  it("CONTROL: an organized account keeps the knock, and a mixed one keeps it for the mailbox still screened", async () => {
    expect(bell(await ohbox(null, 2)).textContent).toContain("2 waiting");
    await act(async () => { root!.unmount(); });
    root = null;
    const mixed: NotOrganizingYet = { mailboxes: [{ id: "mb2", address: "side@family.example", why: "handed_back" }], every: false };
    expect(bell(await ohbox(mixed, 2)).textContent).toContain("2 waiting");
  });
});

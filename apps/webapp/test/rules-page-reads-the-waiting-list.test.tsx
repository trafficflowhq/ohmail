/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act, answerSyncWith, goTo, installShellEnv, ISO, liveAccountResponse, mailbox, mountShell, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import type { TodaysShellProps } from "./_mail-shell";
import en from "../messages/en.json";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { eq } from "drizzle-orm";
import { mailboxes, mailboxProfileMirror, organizerRequests, rules as rulesTbl } from "@trafficflow/db";
import { apiRoutes, createApp, type ApiDeps } from "@trafficflow/api";
import { HttpAdapter, MemoryMirrorStore, OhmailEngine, type FetchLike } from "@ohmail/client-engine";
import { FIXED_NOW, makeDeps, seedMailbox, seedSession } from "../../../packages/api/test/helpers.js";
import { withNodeBlobs } from "./fixtures/node-blobs";

const h = React.createElement;

const WHY = en.ohbox.whyRefused;

/**
 * THE RULES PAGE READS WHAT WAITS FROM THE ENGINE, through the shipped shell: the engine asks
 * `GET /organizer-requests` and the row of the rule a removal names says it waits on the holder.
 * Harness: `rules-refusal-says-why.test.tsx`'s (the wire stubbed, the shell and engine real).
 */
/** `GET /organizer-requests` answers `items`; `DELETE /rules/:id` answers 202; the rest is the harness's. */
let DOOR: { asks: () => number } = { asks: () => 0 };
function requestsDoor(items: unknown[]): { asks: () => number } {
  const base = globalThis.fetch;
  let asks = 0;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (String(input).endsWith("/organizer-requests")) {
      asks++;
      return liveAccountResponse(Response.json({ items }));
    }
    return (base as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  return { asks: () => asks };
}

async function press(el: HTMLElement, label: string): Promise<void> {
  const b = within(el).getAllByRole("button", { name: label });
  expect(b.length, `exactly one "${label}" button`).toBe(1);
  await act(async () => { b[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await tick(0);
}

const ruleList = (root: HTMLElement) => within(root).getByRole("list", { name: en.settings.rules });
const onlyRule = (root: HTMLElement) => within(ruleList(root)).getByRole("listitem");

function fileDestination(row: HTMLElement): string {
  return within(row).getByRole("button", { name: /^Files into / }).getAttribute("aria-label") ?? "";
}

/** The organizer's published copy of Lena's rule on mb_1, or none (`null`). Reset per case. */
let PUBLISHED: { destination: string } | null = null;
/** Every drain answers the same one rule, so the snapshot ask and the drains agree on it. */
const oneRule = (): Response => new Response(JSON.stringify({
  changes: {
    creates: [...(PUBLISHED === null ? [] : [{
      type: "mailbox_profile", op: "create", id: "mb_1", seq: 1, updatedAt: ISO,
      entity: {
        mailboxId: "mb_1", asOf: ISO, updatedAt: ISO, from: { kind: "local", name: "Studio laptop", since: ISO },
        rules: [{
          id: "profile:mb_1:0", kind: "sender", match: "lena@atelier.example", destination: PUBLISHED.destination,
          priority: 0, provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
          createdAt: ISO, updatedAt: ISO,
        }],
      },
    }]), {
      type: "rule", op: "create", id: "rule_lena", seq: 1, updatedAt: ISO,
      entity: {
        id: "rule_lena", kind: "sender", match: "lena@atelier.example", destination: "ohmail/News",
        priority: 0, provenance: "promoted", enabled: true,
        stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
      },
    }],
    updates: [], moves: [], deletes: [],
  },
  cursor: "c1", hasMore: false, serverTime: ISO,
}), { status: 200, headers: { "content-type": "application/json" } });

async function rulesPane(facts: MailboxFacts[], items: unknown[]): Promise<HTMLElement> {
  answerSyncWith(oneRule);
  DOOR = requestsDoor(items);
  const { WebRulesPane } = await import("../app/(product)/mailbox/WebRulesPane");
  const settings = mailSettings({ ...NO_PANE_PARTS, rules: WebRulesPane });
  const el = await mountShell(facts, {
    wrap: (shell) => React.cloneElement(shell as React.ReactElement<TodaysShellProps>, { places: { settings } }),
  });
  await tick(50);
  await goTo("settings");
  await tick(10);
  await press(el, "Rules");
  expect(textOf(el), "the premise: the rule is listed").toContain("lena@atelier.example");
  return el;
}

/** Studio laptop holds mb_1 and takes requests (posture `pending`); `over` moves it to another posture. */
const reader = (over: Partial<MailboxFacts> = {}): MailboxFacts[] => [mailbox({
  id: "mb_1", lastSyncAt: ISO, organizerRole: "reader",
  organizedBy: { kind: "local", name: "Studio laptop", since: ISO }, organizerState: "held",
  organizeConsentedAt: ISO, organizerReleasedAt: null, organizerAcceptsRequests: true, ...over,
} as Partial<MailboxFacts>)];

vi.setConfig({ testTimeout: 30_000 });

describe("the shell's Rules page lists what waits on the organizer", () => {
  beforeEach(() => { PUBLISHED = null; installShellEnv(); });
  afterEach(teardownShellEnv);

  it("a removal the server lists as waiting is said on its rule's row", async () => {
    const el = await rulesPane(reader(), [{
      id: "req-1", kind: "rule.delete", state: "sent", mailboxId: "mb_1", holder: { name: "Studio laptop" },
      decidedAt: ISO, resolvedAt: null, refusedReason: null,
      target: { rule: { kind: "sender", match: "lena@atelier.example", subjectContains: null, bodyContains: null } },
    }]);
    await tick(50);
    const row = onlyRule(el);
    expect(DOOR.asks(), "the shell never asked what waits").toBeGreaterThan(0);
    expect(textOf(row)).toContain("Removal waits on Studio laptop");
  });

  it("a reader-only account's row is the organizer's published rule, under the mirror's own id", async () => {
    // ARCH-RULES-PAGE-INVARIANT, AMENDED 2026-10-26 (#321): the page lists what files the mail. On a
    // reader-only install that is the organizer's published copy, this install's applied presses laid
    // over it (`rulesShown`); a press still names the mirror's own rule, so the row keeps its id.
    PUBLISHED = { destination: "ohmail/Receipts" };
    const el = await rulesPane(reader(), []);
    await tick(50);
    const row = onlyRule(el);
    expect(textOf(el)).toContain("Studio laptop");
    expect(textOf(el)).toContain("It organizes your mail, and these are the rules it files by. A change you make here goes to Studio laptop.");
    expect(fileDestination(row)).toContain("Files into Receipts");
    expect(fileDestination(row)).not.toContain("Files into News");
    const buttons = [
      within(row).getByRole<HTMLButtonElement>("button", { name: /^Files into / }),
      within(row).getByRole<HTMLButtonElement>("button", { name: "Revoke" }),
    ];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Receipts", "Revoke"]);
    expect(buttons.map((b) => b.disabled), "a holder that takes requests takes this change").toEqual([false, false]);
    expect(within(ruleList(el)).getAllByRole("listitem")).toHaveLength(1);
  });

  // Only a live holder that takes requests organizes the mail and takes a change from here. The
  // server sends organizerAcceptsRequests only for a held lease whose holder has the capability.
  const no = { organizerAcceptsRequests: false };
  const elsewhere: Array<[string, Partial<MailboxFacts>, string]> = [
    ["the holder's lease stopped", { ...no, organizerState: "stopped" }, WHY.nobody],
    ["the holder's version cannot take a change", no, WHY.outdated.replace("{name}", "Studio laptop")],
    ["Organize here is starting", { ...no, organizedBy: null, organizerState: null, takeoverAuthorizedAt: ISO }, WHY.starting],
  ];
  it.each(elsewhere)("%s: the page lists the copy and claims no holder takes the change", async (_, over, refusal) => {
    PUBLISHED = { destination: "ohmail/Receipts" };
    const el = await rulesPane(reader(over), []);
    await tick(50);
    expect(textOf(el)).not.toContain("organizes your mail");
    expect(textOf(el)).not.toContain("goes to Studio laptop");
    expect(textOf(el), "the refusal line left the page").toContain(refusal);
    expect(textOf(el)).toContain("Studio laptop");
    expect(textOf(el)).toContain("These are the rules it last published.");
    const row = onlyRule(el);
    expect(fileDestination(row)).toContain("Files into Receipts");
    expect([
      within(row).getByRole<HTMLButtonElement>("button", { name: /^Files into / }),
      within(row).getByRole<HTMLButtonElement>("button", { name: "Revoke" }),
    ].map((b) => b.disabled)).toEqual([true, true]);
  });

  it("an organizing install's row is the mirror's own rule, whatever a published copy says", async () => {
    // The invariant's standing half: where this install organizes, its own rows file the mail.
    PUBLISHED = { destination: "ohmail/Receipts" };
    const el = await rulesPane([mailbox({ id: "mb_1", lastSyncAt: ISO })], []);
    await tick(50);
    const row = onlyRule(el);
    expect(fileDestination(row)).toContain("Files into News");
    expect(within(ruleList(el)).getAllByRole("listitem")).toHaveLength(1);
  });

  it("CONTROL: an empty list says nothing on the row", async () => {
    const el = await rulesPane(reader(), []);
    await tick(50);
    expect(textOf(onlyRule(el))).not.toContain("waits on");
  });
});

describe("a rule made on the organizer is revoked from this page, through the real API", () => {
  const app = createApp(apiRoutes);
  let roots: Root[] = [];
  let container: HTMLElement;
  afterEach(() => {
    for (const r of roots) r.unmount();
    roots = [];
    container?.remove();
    vi.useRealTimers();
  });
  const waitFor = async (p: () => boolean | Promise<boolean>, what: string, timeout = 8000): Promise<void> => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await p()) return;
      await tick(40);
    }
    throw new Error(`timed out waiting for: ${what}`);
  };

  it("Revoke sends one rule.delete by its key, writes no rule row, and the row says the removal waits", async () => {
    const now = FIXED_NOW;
    const { db, deps } = await withNodeBlobs(() => makeDeps(now));
    const s = await seedSession(db, { now });
    const address = "me@lichtgrat.example";
    const mailboxId = await seedMailbox(db, { accountId: s.accountId, address });
    await db.update(mailboxes).set({
      organizerRole: "reader", organizerState: "held", organizedByKind: "local", organizedByName: "Studio laptop",
      organizedByCapabilities: "requests,rules",
    }).where(eq(mailboxes.id, mailboxId));
    await db.insert(mailboxProfileMirror).values({
      mailboxId, accountId: s.accountId, readAt: now,
      doc: { v: 2, rules: [{ kind: "sender", match: "lena@atelier.example", destination: "ohmail/Receipts", priority: 0, enabled: true }] },
    });
    const fetchImpl: FetchLike = async (url, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      headers.set("authorization", `Bearer ${s.token}`);
      return app.handle(new Request(url, { ...init, headers }), { ...(deps as ApiDeps), session: null, idempotency: null });
    };
    // The client measures how long the server’s request has been waiting.
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const store = new MemoryMirrorStore();
    await store.load();
    const engine = new OhmailEngine({ adapter: new HttpAdapter({ baseUrl: "http://localhost", fetch: fetchImpl }), store });
    const roster = [{
      ...mailbox({ id: mailboxId, address, lastSyncAt: ISO }), organizerRole: "reader",
      organizedBy: { kind: "local", name: "Studio laptop", since: ISO }, organizerState: "held",
      organizeConsentedAt: ISO, organizerReleasedAt: null, organizerAcceptsRequests: true,
    }] as MailboxFacts[];
    const [{ MailShell }, { WebRulesPane }] = await Promise.all([
      import("./_mail-shell.js"),
      import("../app/(product)/mailbox/WebRulesPane"),
    ]);
    const settings = mailSettings({ ...NO_PANE_PARTS, rules: WebRulesPane });
    const { ThemeProvider, ToastHost } = await import("@ohmail/ui");
    container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    window.location.hash = "#/settings";
    await act(async () => {
      root.render(h(NextIntlClientProvider, {
        locale: "en", messages: en, timeZone: "UTC",
        children: h(ThemeProvider, { storageKey: null, children: h(ToastHost, {
          children: h(MailShell, {
            demo: false, engine, scope: s.accountId, mailboxFacts: async () => roster, places: { settings },
          }),
        }) }),
      }));
    });
    const settingsNav = () => within(container).queryByRole("navigation", { name: en.settings.navAria });
    await waitFor(() => settingsNav() !== null, "the settings page");
    await act(async () => { within(settingsNav()!).getByRole("button", { name: en.settings.rules }).click(); });
    const row = (): HTMLElement | null => {
      const list = within(container).queryByRole("list", { name: en.settings.rules });
      return list ? within(list).queryByRole("listitem") : null;
    };
    await waitFor(() => row() !== null, "the organizer's rule on the page");
    expect(fileDestination(row()!)).toContain("Files into Receipts");
    await act(async () => { within(row()!).getByRole("button", { name: "Revoke" }).click(); });
    await act(async () => {
      within(within(document.body).getByRole("dialog", { name: "Revoke 1 rule" })).getByRole("button", { name: "Revoke" }).click();
    });
    await waitFor(async () => (await db.select().from(organizerRequests)).length > 0, "the request");
    expect((await db.select().from(organizerRequests)).map((r) => [r.kind, r.payload])).toEqual([["rule.delete", {
      key: { kind: "sender", match: "lena@atelier.example", subjectContains: null, bodyContains: null },
    }]]);
    expect(await db.select().from(rulesTbl)).toEqual([]);
    await waitFor(() => row() !== null && textOf(row()!).includes("Removal waits on Studio laptop"), "the waiting line on the row");
  });
});

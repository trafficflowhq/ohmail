/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act, answerSyncWith, goTo, installShellEnv, ISO, mailbox, mountShell, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import type { MailboxFacts } from "../app/shell/mail-state";
import en from "../messages/en.json";

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
      return new Response(JSON.stringify({ items }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return (base as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
  return { asks: () => asks };
}

async function press(el: HTMLElement, label: string): Promise<void> {
  const b = [...el.querySelectorAll<HTMLButtonElement>("button")].filter((x) => x.textContent?.trim() === label);
  expect(b.length, `exactly one "${label}" button`).toBe(1);
  await act(async () => { b[0]!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await tick(0);
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
  const el = await mountShell(facts);
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
    const row = el.querySelector<HTMLElement>('[data-rule-id="rule_lena"]')!;
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
    const row = el.querySelector<HTMLElement>('[data-rule-id="rule_lena"]')!;
    expect(textOf(el)).toContain("Studio laptop organizes your mail");
    expect(textOf(row)).toContain("Files into Receipts");
    expect(textOf(row)).not.toContain("Files into News");
    const buttons = [...row.querySelectorAll("button")];
    expect(buttons.map((b) => b.textContent?.trim())).toEqual(["Change", "Revoke"]);
    expect(buttons.map((b) => b.disabled), "a holder that takes requests takes this change").toEqual([false, false]);
    expect(el.querySelectorAll("[data-rule-id]")).toHaveLength(1);
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
    expect(textOf(el)).toContain("These are the rules Studio laptop last published.");
    const row = el.querySelector<HTMLElement>('[data-rule-id="rule_lena"]')!;
    expect(textOf(row)).toContain("Files into Receipts");
    expect([...row.querySelectorAll("button")].map((b) => b.disabled)).toEqual([true, true]);
  });

  it("an organizing install's row is the mirror's own rule, whatever a published copy says", async () => {
    // The invariant's standing half: where this install organizes, its own rows file the mail.
    PUBLISHED = { destination: "ohmail/Receipts" };
    const el = await rulesPane([mailbox({ id: "mb_1", lastSyncAt: ISO })], []);
    await tick(50);
    const row = el.querySelector<HTMLElement>('[data-rule-id="rule_lena"]')!;
    expect(textOf(row)).toContain("Files into News");
    expect(el.querySelectorAll("[data-rule-id]")).toHaveLength(1);
  });

  it("CONTROL: an empty list says nothing on the row", async () => {
    const el = await rulesPane(reader(), []);
    await tick(50);
    expect(textOf(el.querySelector<HTMLElement>('[data-rule-id="rule_lena"]')!)).not.toContain("waits on");
  });
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act, answerSyncWith, goTo, installShellEnv, ISO, mailbox, mountShell, teardownShellEnv, textOf, tick,
} from "./fixtures/live-walk-shell";
import type { MailboxFacts } from "@ohmail/app-logic/mail-state/mail-state";
import en from "../messages/en.json";

/**
 * A REFUSED REVOKE SAYS WHY. The shipped shell and its engine; only the wire is
 * stubbed, answering `DELETE /rules/:id` the way the API does on a reader nothing organizes:
 * 409 organized_elsewhere, `{ by, reason: "no_organizer" }`. Before the fix the refusal was a
 * toast gone in 2.6 s that named no reason, and the pane offered Revoke where it cannot land.
 */

const R = en.rules;
const WHY = en.ohbox.whyRefused;
type Door = "refuse" | "revoke";

/** Route `DELETE /rules/:id` to the named door; everything else goes to the harness. */
function rulesDoor(door: Door): void {
  const base = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    if (/\/rules\/[^/?]+$/.test(String(input)) && init?.method === "DELETE") {
      if (door === "revoke") return new Response(null, { status: 204 });
      return new Response(JSON.stringify({
        error: {
          code: "organized_elsewhere", message: "another install is organizing this mailbox",
          details: { by: { kind: null, name: null, since: null }, reason: "no_organizer" },
        },
      }), { status: 409, headers: { "content-type": "application/json" } });
    }
    return (base as (i: unknown, n?: RequestInit) => Promise<Response>)(input, init);
  }) as unknown as typeof globalThis.fetch;
}

function button(el: HTMLElement, label: string): HTMLButtonElement {
  const all = [...el.querySelectorAll<HTMLButtonElement>("button")].filter((b) => b.textContent?.trim() === label);
  expect(all.length, `exactly one "${label}" button`).toBe(1);
  return all[0]!;
}

async function press(el: HTMLElement, label: string): Promise<void> {
  await act(async () => { button(el, label).dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await tick(0);
}

/** Every drain answers the same one rule, so the snapshot ask and the drains agree on it. */
const oneRule = (): Response => new Response(JSON.stringify({
  changes: {
    creates: [{
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

async function rulesPane(facts: MailboxFacts[], door: Door): Promise<HTMLElement> {
  answerSyncWith(oneRule);
  rulesDoor(door);
  const el = await mountShell(facts);
  await tick(50);
  await goTo("settings");
  await tick(10);
  await press(el, "Rules");
  expect(textOf(el), "the premise: the rule is listed").toContain("lena@atelier.example");
  return el;
}

const released = (): MailboxFacts[] => [mailbox({
  id: "mb_1", lastSyncAt: ISO, organizerRole: "reader", organizedBy: null, organizerState: null,
  organizeConsentedAt: ISO, organizerReleasedAt: ISO,
} as Partial<MailboxFacts>)];

const starting = (): MailboxFacts[] => [mailbox({
  id: "mb_1", lastSyncAt: ISO, organizerRole: "reader", organizedBy: null, organizerState: null,
  organizeConsentedAt: ISO, organizerReleasedAt: null, takeoverAuthorizedAt: ISO,
} as Partial<MailboxFacts>)];

/** A holder whose lease lapsed: named, and no longer renewing. */
const lapsed = (): MailboxFacts[] => [mailbox({
  id: "mb_1", lastSyncAt: ISO, organizerRole: "reader",
  organizedBy: { kind: "local", name: "Studio laptop", since: ISO }, organizerState: "stopped",
  organizeConsentedAt: ISO, organizerReleasedAt: null,
} as Partial<MailboxFacts>)];

/** The roster a pass behind: it still reads as organized while the server already refuses. */
const organizer = (): MailboxFacts[] => [mailbox({ id: "mb_1", lastSyncAt: ISO, organizerRole: "organizer" } as Partial<MailboxFacts>)];

vi.setConfig({ testTimeout: 30_000 });

describe("the Rules pane on a reader says so before the press", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("handed back: the reason and the way out are on the pane, and Revoke is unavailable", async () => {
    const el = await rulesPane(released(), "refuse");
    expect(textOf(el)).toContain(WHY.nobody);
    expect(button(el, R.revoke).disabled, "Revoke offered where it cannot land").toBe(true);
    expect(button(el, R.change).disabled).toBe(true);
  });

  it("a holder that stopped organizing: the pane says nothing organizes it, not to update that machine", async () => {
    const el = await rulesPane(lapsed(), "refuse");
    expect(textOf(el)).toContain(WHY.nobody);
    expect(textOf(el)).not.toContain(WHY.outdated.replace("{name}", "Studio laptop"));
    expect(button(el, R.revoke).disabled).toBe(true);
  });

  it("Organize here pressed, claim not landed: the pane says it starts within a minute", async () => {
    const el = await rulesPane(starting(), "refuse");
    expect(textOf(el)).toContain(WHY.starting);
    expect(button(el, R.revoke).disabled).toBe(true);
  });
});

describe("a refused revoke renders its reason at the press, and it stays", () => {
  beforeEach(installShellEnv);
  afterEach(teardownShellEnv);

  it("409 no_organizer: the lead, the reason and the way out, still there after a toast would have gone", async () => {
    const el = await rulesPane(organizer(), "refuse");
    await press(el, R.revoke);
    await press(el, R.revokeConfirm);
    await tick(3_000);
    const alert = el.querySelector(".rules-refusal[role='alert']");
    expect(alert?.textContent ?? "", "the refusal said nothing that stayed").toContain(R.toastRevokeFailed);
    expect(alert?.textContent ?? "", "the refusal named no reason").toContain(WHY.nobody);
    expect(textOf(el), "the rule is still listed").toContain("lena@atelier.example");
  });

  it("control — the organizer's revoke: the rule is gone, no refusal on the pane", async () => {
    const el = await rulesPane(organizer(), "revoke");
    await press(el, R.revoke);
    await press(el, R.revokeConfirm);
    expect(textOf(el)).toContain(R.toastRevoked);
    expect(el.querySelector(".rules-refusal")).toBeNull();
    expect(el.querySelector(".rules-locked")).toBeNull();
  });
});

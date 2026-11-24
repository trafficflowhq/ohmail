/** @vitest-environment jsdom */
import type { RuleEntity as RuleDTO, SyncResponse } from "@ohmail/wire";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import messages from "../messages/en.json";
import {
  act, installConfirmEnv, ISO, mountCloudShell, refresh204, rememberOwner,
  scriptRefresh, scriptSession, scriptSync, sessionFull, teardownConfirmEnv, tick, warmCloudShell,
} from "./fixtures/cloud-confirm-shell";

const rule = (i: number): RuleDTO => ({
  id: `r${i}`, kind: "sender", match: `sender${String(i).padStart(3, "0")}@rules.invalid`, destination: "INBOX",
  priority: 0, provenance: "manual", enabled: true, subjectContains: null, bodyContains: null,
  stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: new Date(Date.parse(ISO) - (i + 1) * 60_000).toISOString(), updatedAt: ISO,
} as unknown as RuleDTO);

beforeAll(warmCloudShell);
beforeEach(() => {
  installConfirmEnv();
  rememberOwner();
  scriptRefresh(refresh204);
  scriptSession(sessionFull);
});
afterEach(async () => {
  await teardownConfirmEnv();
  vi.unstubAllGlobals();
});

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });

async function mountRules(width: number) {
  vi.stubGlobal("innerWidth", width);
  const items = Array.from({ length: 169 }, (_, i) => rule(i));
  scriptSync(() => json({
    changes: {
      creates: items.map((entity, index) => ({
        type: "rule", op: "create", id: entity.id, seq: index + 1, updatedAt: ISO, entity,
      })),
      updates: [], moves: [], deletes: [],
    },
    cursor: `c${items.length}`, hasMore: false, serverTime: ISO,
  } satisfies SyncResponse));
  const wire = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input), window.location.origin).pathname === "/api/mailboxes") {
      return json({ items: [{
        id: "mb", address: ["mailbox", "example.invalid"].join("@"), status: "connected",
        organizerRole: "organizer", initialImportCompletedAt: ISO, organizeConsentedAt: ISO, lastSyncAt: ISO, createdAt: ISO,
      }] });
    }
    return wire(input, init);
  };
  window.location.hash = "#/settings/rules";
  const frame = await mountCloudShell();
  await tick(3000);
  const scroller = within(frame).getByRole("region", { name: messages.settings.rules });
  const rules = within(scroller).getByRole("list", { name: messages.settings.rules });
  const hundredth = () => within(rules).queryByRole("group", { name: `Mail from ${items[100]!.match}` });
  return { frame, scroller, rules, hundredth };
}

async function scroll(el: HTMLElement, px: number): Promise<void> {
  el.scrollTop = px;
  await act(async () => { el.dispatchEvent(new Event("scroll")); });
  await tick(100);
}

describe("the Rules list and the scroll a thumb moves", () => {
  it("at phone width the page's own scroll brings the hundredth rule into the list", async () => {
    const { frame, scroller, rules, hundredth } = await mountRules(360);
    expect(within(frame).getByRole("button", { name: messages.settings.back })).toBeTruthy();
    expect(within(rules).getAllByRole("listitem")[0]!.getAttribute("aria-setsize")).toBe("169");
    expect(hundredth(), "premise: the list is a window").toBeNull();
    await scroll(scroller, 100 * 64);
    expect(hundredth(), "scrolling the page left the list where it was").toBeTruthy();
  });

  it("at wide width only the Settings column scrolls the Rules window", async () => {
    const { frame, scroller, hundredth } = await mountRules(1440);
    expect(within(frame).getByRole("navigation", { name: messages.settings.navAria })).toBeTruthy();
    expect(hundredth()).toBeNull();
    await scroll(frame, 100 * 64);
    expect(hundredth(), "an outer scroll moved the Rules window").toBeNull();
    await scroll(scroller, 100 * 64);
    expect(hundredth()).toBeTruthy();
  });
});

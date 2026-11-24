/** @vitest-environment jsdom */
import { within } from "@testing-library/react";
import { cloneElement, type ReactElement } from "react";
import { mailSettings, NO_PANE_PARTS } from "@ohmail/app/mail";
import type { TodaysShellProps } from "./_mail-shell";
import { answerSyncWith, goTo, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import en from "../messages/en.json";
import type { RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { placingRule, effectForDestination } from "@trafficflow/core/rule-order";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import { actingRules } from "@ohmail/app-logic/press/rules-standing";

// REVIEW-026 probe: which twin the Rules page shows as the sender's rule, against the twin the
// router files by. Two rows under one key; the disabled one outranks the enabled one.
const NOW = "2026-10-02T09:00:00.000Z";
const rule = (over: Partial<RuleDTO> & { id: string }): RuleDTO => ({
  kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: NOW, updatedAt: NOW, ...over,
} as RuleDTO);

async function mountedRule(rules: RuleDTO[]) {
  answerSyncWith(() => Response.json({
    changes: {
      creates: rules.map((entity, index) => ({
        type: "rule", op: "create", id: entity.id, seq: index + 1, entity, updatedAt: NOW,
      })),
      updates: [], deletes: [], moves: [],
    },
    cursor: "c2", hasMore: false, serverTime: NOW,
  }));
  const { WebRulesPane } = await import("../app/(product)/mailbox/WebRulesPane");
  const settings = mailSettings({ ...NO_PANE_PARTS, rules: WebRulesPane });
  const host = await mountShell([mailbox({ lastSyncAt: NOW, organizerRole: "organizer" })], {
    wrap: (shell) => cloneElement(shell as ReactElement<TodaysShellProps>, { places: { settings } }),
  });
  await goTo("settings/rules");
  await tick(50);
  const list = within(host).getByRole("list", { name: en.settings.rules });
  return within(within(list).getByRole("listitem"));
}

beforeEach(installShellEnv);
afterEach(teardownShellEnv);

describe("REVIEW-026 probe: the acting twin", () => {
  it("the page's one row and the router's rule are the same twin", async () => {
    const off = rule({ id: "a1", match: "Ann@Shop.example", destination: "ohmail/Receipts", priority: 5, enabled: false });
    const on = rule({ id: "b2", match: "ann@shop.example", destination: "ohmail/News", priority: 0, enabled: true });
    const { shown, copies } = actingRules([off, on]);
    const routed = placingRule(
      [off, on].map((r) => ({ ...r, effect: effectForDestination(canonicalDestination(r.destination)) })),
      { author: "ann@shop.example", subject: "hello", text: null, headers: null },
    ).rule;
    console.log("PROBE page shows", JSON.stringify(shown.map((r) => ({ id: r.id, dest: r.destination, enabled: r.enabled, copies: copies.get(r.id) ?? 0 }))));
    console.log("PROBE router files by", JSON.stringify(routed ? { id: routed.id, dest: routed.destination, enabled: routed.enabled } : null));
    expect(shown.map((r) => r.id)).toEqual([routed!.id]);
    const row = await mountedRule([off, on]);
    expect(row.getByRole("button", { name: "Files into News" })).toBeTruthy();
  });
  it("CONTROL: both enabled, the page shows the twin the router runs", async () => {
    const hi = rule({ id: "a1", match: "Ann@Shop.example", destination: "ohmail/Receipts", priority: 5, enabled: true });
    const lo = rule({ id: "b2", destination: "ohmail/News", priority: 0, enabled: true });
    const { shown } = actingRules([hi, lo]);
    const routed = placingRule(
      [hi, lo].map((r) => ({ ...r, effect: effectForDestination(canonicalDestination(r.destination)) })),
      { author: "ann@shop.example", subject: "hello", text: null, headers: null },
    ).rule;
    expect(shown.map((r) => r.id)).toEqual([routed!.id]);
    const row = await mountedRule([hi, lo]);
    expect(row.getByRole("button", { name: "Files into Receipts" })).toBeTruthy();
  });
});

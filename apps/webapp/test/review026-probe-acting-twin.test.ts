import { describe, expect, it } from "vitest";
import { placingRule, effectForDestination } from "@trafficflow/core/rule-order";
import { canonicalDestination } from "@trafficflow/core/folder-name";
import type { RuleDTO } from "@ohmail/client-engine";
import { actingRules } from "../app/views/rules-standing.js";

// REVIEW-026 probe: which twin the Rules page shows as the sender's rule, against the twin the
// router files by. Two rows under one key; the disabled one outranks the enabled one.
const NOW = "2026-10-02T09:00:00.000Z";
const rule = (over: Partial<RuleDTO> & { id: string }): RuleDTO => ({
  kind: "sender", match: "ann@shop.example", destination: "ohmail/News", priority: 0,
  provenance: "manual", enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 },
  createdAt: NOW, updatedAt: NOW, ...over,
} as RuleDTO);

describe("REVIEW-026 probe: the acting twin", () => {
  it("the page's one row and the router's rule are the same twin", () => {
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
  });
  it("CONTROL: both enabled, the page shows the twin the router runs", () => {
    const hi = rule({ id: "a1", match: "Ann@Shop.example", destination: "ohmail/Receipts", priority: 5, enabled: true });
    const lo = rule({ id: "b2", destination: "ohmail/News", priority: 0, enabled: true });
    const { shown } = actingRules([hi, lo]);
    const routed = placingRule(
      [hi, lo].map((r) => ({ ...r, effect: effectForDestination(canonicalDestination(r.destination)) })),
      { author: "ann@shop.example", subject: "hello", text: null, headers: null },
    ).rule;
    expect(shown.map((r) => r.id)).toEqual([routed!.id]);
  });
});

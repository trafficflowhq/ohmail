/** @vitest-environment jsdom */
import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import messages from "../messages/en.json";
import { SubjectRuleSheet } from "../app/shell/SubjectRuleSheet";
import { senderScreening, planScreeningChange } from "@ohmail/app-logic/press/sender-screening";
import { attributeMessages } from "@ohmail/app-logic/press/sender-audit";
import { RulesView, bodyTermOf, filterRules } from "../app/views/RulesView";
import { subjectRuleContext } from "@ohmail/app-logic/press/subject-rule";
import { CORPUS, SENDER, TOKEN, mirror, msg, ruleRow } from "./_ohbox-1-body-rule.js";

/**
 * SPLITTING ONE SENDER BY WHAT THE MESSAGE SAYS — the content term (mail 0052), through the same
 * sheet, planner and surfaces as the subject term.
 *
 * The case the subject slice cannot cover: a sender writes the SAME subject on every message —
 * "Notification" — and the `[NinjaFirewall]` tag that distinguishes the alert from the invoice is
 * in the body. `subject-rule.test.tsx` states the two disciplines this file inherits: render and
 * DRIVE the thing the user presses (built-tested-unreachable is the house failure), and put the
 * weight on the NEGATIVES, because every "the rule was written" assertion passes with the term
 * dropped on the way to the wire.
 *
 * One discipline is NEW and body-specific: the client's text is a FLOOR. The mirror holds the
 * full body only where it was mirrored or hydrated, a snippet otherwise, so every claim a surface
 * makes from it must be safe under under-knowledge — counts say "here", and the audit refuses to
 * name a rule whose conjunct it cannot verify. Both directions are pinned below.
 */

/* The letters, the rules and the mirror: `_ohbox-1-body-rule.ts`. The planner's cases (detection, what the client
   knows of the text, the sheet's world, the plan) moved to `body-rule-plan.test.ts`; this file keeps what is drawn. */

// ───────────────────────────── the sheet, rendered ─────────────────────────────

let root: Root | null = null;
let host: HTMLElement | null = null;

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

const click = async (node: Element | null | undefined) => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => {
    node!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
};

const byText = (el: HTMLElement, selector: string, text: string) =>
  [...el.querySelectorAll(selector)].find((n) => (n.textContent ?? "").includes(text));

async function renderSheet(
  list: EngineMessage[], seedId: string, rules: RuleDTO[] = [],
): Promise<{ onConfirm: ReturnType<typeof vi.fn>; el: HTMLElement }> {
  const store = await mirror(list, rules);
  const ctx = subjectRuleContext(store, seedId)!;
  const onConfirm = vi.fn();

  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(
      React.createElement(NextIntlClientProvider, {
        locale: "en",
        messages,
        children: React.createElement(SubjectRuleSheet, {
          state: { messageId: seedId, x: 0, y: 0 },
          ctx,
          onConfirm,
          onClose: () => {},
        }),
      }),
    );
  });
  return { onConfirm, el: host! };
}

describe("the sheet offers the content term", () => {
  it("renders the detected body token as a third choice, with its held-mail count", async () => {
    const { el } = await renderSheet(CORPUS(), "alert-1");
    const contentBtn = byText(el, ".sm-scope button", "in the message text");
    expect(contentBtn, "the content term is not offered").toBeTruthy();
    expect(contentBtn!.textContent).toContain(TOKEN);
    expect(contentBtn!.textContent).toContain("2");
    // The subject choices are untouched beside it — extension, not redesign.
    // The editable subject match is untouched beside it — extension, not replacement.
    expect(el.querySelector<HTMLInputElement>(".sm-edit-input")).toBeTruthy();
  });

  it("does not render the option when nothing repeats in the held text", async () => {
    const { el } = await renderSheet([
      msg("only", SENDER, "Notification", "INBOX", { body: `${TOKEN} once` }),
      msg("other", SENDER, "Notification", "INBOX", { body: "Rechnung" }),
    ], "only");
    expect(byText(el, ".sm-scope button", "in the message text")).toBeFalsy();
  });

  it("states the TEXT conjunction before writing, and dispatches with the body field", async () => {
    // The confirm is the one moment the conjunction can be read before the backlog is re-filed —
    // and for a content rule it must say "text", because "subject contains" would be a false
    // sentence about what is being written.
    const { onConfirm, el } = await renderSheet(CORPUS(), "alert-1");
    await click(byText(el, ".sm-scope button", "in the message text"));
    await click(byText(el, "li[role='option']", "News"));

    const confirm = el.querySelector(".sm-confirm p");
    expect(confirm, "pressing a destination did not open the confirm").toBeTruthy();
    const text = confirm!.textContent ?? "";
    expect(text).toContain(SENDER);
    expect(text).toContain(TOKEN);
    expect(text).toContain("News");
    expect(text).toContain("text contains");
    expect(text).not.toContain("subject contains");

    expect(onConfirm).not.toHaveBeenCalled();
    await click(byText(el, ".sm-confirm-row button.go", "News"));
    expect(onConfirm).toHaveBeenCalledWith(TOKEN, "reads", "body", true);
  });

  it("warns before writing a duplicate body rule", async () => {
    const { el } = await renderSheet(CORPUS(), "alert-1", [
      ruleRow({ destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    await click(byText(el, ".sm-scope button", "in the message text"));
    await click(byText(el, "li[role='option']", "News"));
    expect(el.querySelector(".sm-confirm")!.textContent).toContain("already have this rule");
  });
});

// ───────────────────── the sender sheet must not eat the body rule ─────────────────────

describe("the whole-sender sheet leaves a body rule alone", () => {
  it("does not retarget it — it writes the broad rule the user actually asked for", async () => {
    // Removing `(r.bodyContains ?? "").trim() === ""` from the twins filter (`ruleTwins`, which
    // `planScreeningChange` reads) makes this go red: the whole-address click would silently re-point the narrow rule.
    const store = await mirror(CORPUS(), [
      ruleRow({ id: "narrow", destination: "ohmail/Receipts", bodyContains: TOKEN }),
    ]);
    const plan = planScreeningChange(senderScreening(store, "invoice")!, "reads");

    expect(plan.ruleState).toBe("created");
    const wire = plan.ruleMutations as unknown as Array<Record<string, unknown>>;
    expect(wire).toEqual([expect.objectContaining({
      kind: "rule_create", ruleKind: "sender", match: SENDER, destination: "ohmail/News",
    })]);
    expect(wire.some((m) => m.kind === "rule_update")).toBe(false);
  });

  it("still retargets a BARE rule for the same address", async () => {
    const store = await mirror(CORPUS(), [
      ruleRow({ id: "bare", destination: "ohmail/Receipts" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    const plan = planScreeningChange(senderScreening(store, "invoice")!, "reads");
    expect(plan.ruleState).toBe("retargeted");
    expect(plan.ruleMutations as unknown as Array<Record<string, unknown>>)
      .toEqual([expect.objectContaining({ kind: "rule_update", ruleId: "bare" })]);
  });
});

// ───────────────────────────── the audit surface ─────────────────────────────

describe("the why-it-went-there panel", () => {
  it("names a body rule only where the held text VERIFIABLY satisfies it", async () => {
    const store = await mirror([
      msg("alert-1", SENDER, "Notification", "ohmail/News", { body: `${TOKEN} nightly` }),
      msg("invoice", SENDER, "Notification", "ohmail/News", { body: "Rechnung 2026-08" }),
      // The server may well have filed this one by the rule — the token could sit past the
      // snippet — but the mirror cannot SEE that, and this module never asserts what it cannot
      // check. "arrival" is the honest answer, not a guessed rule.
      msg("unhydrated", SENDER, "Notification", "ohmail/News", { snippet: "the top only" }),
    ], [ruleRow({ id: "narrow", destination: "ohmail/News", bodyContains: TOKEN })]);

    const rows = attributeMessages(store, store.list<EngineMessage>("message"));
    const byId = new Map(rows.map((r) => [r.message.id, r.attribution]));
    expect(byId.get("alert-1")).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "narrow" }) });
    expect(byId.get("invoice")).toEqual({ kind: "arrival" });
    expect(byId.get("unhydrated")).toEqual({ kind: "arrival" });
  });

  it("prefers the body rule over a bare one when both verifiably hold", async () => {
    const store = await mirror([
      msg("alert-1", SENDER, "Notification", "ohmail/News", { body: `${TOKEN} nightly` }),
    ], [
      ruleRow({ id: "bare", destination: "ohmail/News" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    const [row] = attributeMessages(store, store.list<EngineMessage>("message"));
    expect(row!.attribution).toEqual({
      kind: "rule", rule: expect.objectContaining({ id: "narrow" }),
    });
  });
});

// ───────────────────────────── the rules list ─────────────────────────────

describe("the rules surface tells a body rule apart", () => {
  it("reads a blank term as no term", () => {
    expect(bodyTermOf(ruleRow({ bodyContains: null }))).toBe("");
    expect(bodyTermOf(ruleRow({ bodyContains: "   " }))).toBe("");
    expect(bodyTermOf(ruleRow({ bodyContains: ` ${TOKEN} ` }))).toBe(TOKEN);
    // A DTO from an older server does not carry the field at all — same reading.
    const { bodyContains: _dropped, ...older } = ruleRow();
    expect(bodyTermOf(older as RuleDTO)).toBe("");
  });

  it("finds a rule by its body term, not only by its address", () => {
    const rules = [
      ruleRow({ id: "bare", destination: "INBOX" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", bodyContains: TOKEN }),
    ];
    expect(filterRules(rules, "ninjafirewall", "all").map((r) => r.id)).toEqual(["narrow"]);
    expect(filterRules(rules, "sichersatt", "all").map((r) => r.id)).toEqual(["bare", "narrow"]);
  });

  it("RENDERS the body term on the row, and both terms when a rule carries both", async () => {
    // Two rules for one address must not read as identical rows — and a two-term rule must name
    // BOTH conjuncts, because an unnamed one makes the row indistinguishable from a broader rule.
    const rules = [
      ruleRow({ id: "bare", destination: "INBOX" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", bodyContains: TOKEN }),
      ruleRow({
        id: "both", destination: "ohmail/News", subjectContains: "Alert", bodyContains: TOKEN,
      }),
    ];
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        React.createElement(NextIntlClientProvider, {
          locale: "en",
          messages,
          now: new Date("2026-08-10T12:00:00.000Z"),
          children: React.createElement(ThemeProvider, {
            children: React.createElement(ToastHost, {
              children: React.createElement(RulesView, {
                rules,
                onRevoke: async () => ({ status: "confirmed" as const }),
                onRetarget: async () => ({ status: "confirmed" as const }),
                pastMail: () => null,
              }),
            }),
          }),
        }),
      );
    });

    const rows = [...host!.querySelectorAll<HTMLElement>("[data-rule-id]")];
    expect(rows).toHaveLength(3);
    const whatOf = (id: string) =>
      rows.find((r) => r.dataset.ruleId === id)!.querySelector(".what")!.textContent ?? "";
    expect(whatOf("bare")).not.toContain(TOKEN);
    expect(whatOf("narrow")).toContain(TOKEN);
    expect(whatOf("narrow")).toContain("text");
    expect(whatOf("both")).toContain("Alert");
    expect(whatOf("both")).toContain(TOKEN);
    // …and the revoke confirm quotes the term, so "the wrong one" is visible before the press.
    const narrowRow = rows.find((r) => r.dataset.ruleId === "narrow")!;
    await click([...narrowRow.querySelectorAll("button")]
      .find((b) => (b.textContent ?? "").includes("Revoke")));
    const confirm = host!.querySelector(".rules-confirm .what");
    expect(confirm, "revoking did not open the confirm").toBeTruthy();
    expect(confirm!.textContent).toContain(TOKEN);
  });
});

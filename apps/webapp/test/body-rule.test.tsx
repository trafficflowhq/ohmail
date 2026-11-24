/** @vitest-environment jsdom */
import type { EngineMessage, RuleEntity as RuleDTO } from "@ohmail/wire";
import { afterEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { OhmailEngine } from "@ohmail/client-engine";
import { confirmSyncOwner, createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import messages from "../messages/en.json";
import { senderScreening, planScreeningChange } from "@ohmail/app-logic/press/sender-screening";
import { attributeMessages } from "@ohmail/app-logic/press/sender-audit";
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
   knows of the text, the sheet's world, the plan) moved to `body-rule-plan.test.ts`; the settings cases use the Web entry. */

// ───────────────────────────── the sheet, rendered ─────────────────────────────

afterEach(teardownShellEnv);

const click = async (node: Element | null | undefined) => {
  expect(node, "the control this test drives does not exist").toBeTruthy();
  await act(async () => { node!.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
};

const contentOption = (el: HTMLElement) =>
  within(el).queryByRole("radio", { name: /in the message text/ });
const chooseNews = (el: HTMLElement) =>
  click(within(el).getByRole("radio", { name: "News" }));

async function mountSender(list: EngineMessage[], seedId: string, rules: RuleDTO[] = []) {
  installShellEnv();
  const store = await mirror(list.map((message) => ({ ...message, accountId: "acct_live_1" })), rules);
  const wire = vi.fn(async () => ({ changes: [], seq: null }));
  const engine = new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: new Date().toISOString(),
      }),
      mutate: wire,
      fetchBody: async () => null,
      withdrawSend: async () => ({ outcome: "unsupported" }),
    },
  });
  registerSyncGate(engine, createSyncGate("acct_live_1"));
  confirmSyncOwner(engine, "acct_live_1");
  await engine.start();
  const mutate = vi.spyOn(engine, "mutate");
  window.location.hash = `#/ohbox/m/${seedId}`;
  const frame = within(await mountShell([
    mailbox({ id: "mb", organizerRole: "organizer", organizerChecked: true, lastSyncAt: new Date().toISOString() }),
  ], { engine, webContactScreening: true }));
  await tick(300);
  const reader = within(frame.getByRole("region", { name: messages.frame.landmark.reading }));
  await click(reader.getByRole("button", { name: (name) => name.startsWith(SENDER) }));
  const page = within(document.body);
  return {
    el: page.getByRole("dialog", { name: messages.screening.aria.replace("{sender}", SENDER) }),
    mutate,
    page,
  };
}

async function renderSheet(list: EngineMessage[], seedId: string, rules: RuleDTO[] = []) {
  const { el, mutate, page } = await mountSender(list, seedId, rules);
  await click(within(el).getByRole("menuitem", { name: messages.screening.cardSubject }));
  return {
    el: page.getByRole("dialog", { name: messages.screening.subjectAria.replace("{who}", SENDER) }),
    ruleWrites: () => mutate.mock.calls.map(([mutation]) => mutation).filter((mutation) => mutation.kind.startsWith("rule_")),
  };
}

describe("the sheet offers the content term", () => {
  it("renders the detected body token as a third choice, with its held-mail count", async () => {
    const { el } = await renderSheet(CORPUS(), "alert-1");
    const contentBtn = contentOption(el);
    expect(contentBtn, "the content term is not offered").toBeTruthy();
    expect(contentBtn!.textContent).toContain(TOKEN);
    expect(contentBtn!.textContent).toContain("2");
    // The subject choices are untouched beside it — extension, not redesign.
    // The editable subject match is untouched beside it — extension, not replacement.
    expect(within(el).getByRole("textbox", { name: messages.screening.subjectEditAria })).toBeTruthy();
  });

  it("does not render the option when nothing repeats in the held text", async () => {
    const { el } = await renderSheet([
      msg("only", SENDER, "Notification", "INBOX", { body: `${TOKEN} once` }),
      msg("other", SENDER, "Notification", "INBOX", { body: "Rechnung" }),
    ], "only");
    expect(contentOption(el)).toBeFalsy();
  });

  it("states the TEXT conjunction before writing, and dispatches with the body field", async () => {
    // The confirm is the one moment the conjunction can be read before the backlog is re-filed —
    // and for a content rule it must say "text", because "subject contains" would be a false
    // sentence about what is being written.
    const { ruleWrites, el } = await renderSheet(CORPUS(), "alert-1");
    await click(contentOption(el));
    await chooseNews(el);

    const form = within(el);
    expect(form.getByText(SENDER, { exact: true })).toBeTruthy();
    expect(contentOption(el)?.getAttribute("aria-checked")).toBe("true");
    expect(form.getByRole("radio", { name: "News", checked: true })).toBeTruthy();
    expect(form.getByText("2 of 3 match")).toBeTruthy();
    expect(form.queryByText(/AND the text contains/)).toBeNull();

    expect(ruleWrites()).toEqual([]);
    await click(within(el).getByRole("button", {
      name: messages.screening.subjectMakeRule,
    }));
    expect(ruleWrites()).toEqual([expect.objectContaining({
      kind: "rule_create", match: SENDER, destination: "ohmail/News", bodyContains: TOKEN, applyRetro: true,
    })]);
  });

  it("warns before writing a duplicate body rule", async () => {
    const { el } = await renderSheet(CORPUS(), "alert-1", [
      ruleRow({ destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    await click(contentOption(el));
    await chooseNews(el);
    expect(within(el).getByText(messages.screening.subjectConfirmAlready)).toBeTruthy();
  });
});

// ───────────────────── the sender sheet must not eat the body rule ─────────────────────

async function finishWholeSenderPress(page: ReturnType<typeof within>) {
  const keep = page.queryByRole("radio", { name: /Keep the split/ });
  if (keep) {
    await click(keep);
    await click(page.getByRole("button", { name: /^File to News$/ }));
  }
  await tick(8000);
}

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
    const mounted = await mountSender(CORPUS(), "invoice", [
      ruleRow({ id: "narrow", destination: "ohmail/Receipts", bodyContains: TOKEN }),
    ]);
    await click(within(mounted.el).getByRole("radio", { name: /^News/ }));
    await finishWholeSenderPress(mounted.page);
    expect(mounted.mutate.mock.calls.map(([mutation]) => mutation).filter(({ kind }) => kind.startsWith("rule_")))
      .toEqual([expect.objectContaining({ kind: "rule_create", ruleKind: "sender", match: SENDER, destination: "ohmail/News" })]);
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
    const mounted = await mountSender(CORPUS(), "invoice", [
      ruleRow({ id: "bare", destination: "ohmail/Receipts" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    await click(within(mounted.el).getByRole("radio", { name: /^News/ }));
    await finishWholeSenderPress(mounted.page);
    expect(mounted.mutate.mock.calls.map(([mutation]) => mutation).filter(({ kind }) => kind.startsWith("rule_")))
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

/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import {
  MemoryMirrorStore,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { SubjectRuleSheet } from "../app/shell/SubjectRuleSheet";
import { senderScreening, planScreeningChange } from "@ohmail/app-logic/press/sender-screening";
import { attributeMessages } from "@ohmail/app-logic/press/sender-audit";
import { RulesView, bodyTermOf, filterRules } from "../app/views/RulesView";
import {
  bodyMatchCount,
  bodyTextOf,
  detectBodyToken,
  MAX_BODY_SCAN,
  planSubjectRule,
  subjectRuleContext,
} from "@ohmail/app-logic/press/subject-rule";

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

let seq = 0;

function msg(
  id: string, from: string, subject: string, folder: Folder = "INBOX",
  text?: { body?: string; snippet?: string },
): EngineMessage {
  return {
    id,
    accountId: "acct",
    mailboxId: "mb",
    threadId: null,
    messageIdHeader: null,
    subject,
    from: { name: null, address: from },
    to: [],
    cc: [],
    date: `2026-08-0${(seq % 8) + 1}${"T"}09:00:00.000Z`,
    folder,
    snippet: text?.snippet ?? "s",
    ...(text?.body !== undefined ? { body: text.body } : {}),
    unread: false,
    hasAttachments: false,
    attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null,
    labels: [],
    remoteContent: "none",
    updatedAt: "2026-08-02T09:00:00.000Z",
  };
}

function ruleRow(over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id: `r-${++seq}`,
    kind: "sender",
    match: "info@sichersatt.example",
    destination: "INBOX",
    priority: 0,
    provenance: "manual",
    enabled: true,
    subjectContains: null,
    bodyContains: null,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T09:00:00.000Z",
    updatedAt: "2026-08-01T09:00:00.000Z",
    ...over,
  };
}

async function mirror(list: EngineMessage[], rules: RuleDTO[] = []): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...list.map((m): SyncChange => ({
      type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
    })),
    ...rules.map((r): SyncChange => ({
      type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r,
    })),
  ]);
  return store;
}

const SENDER = "info@sichersatt.example";
const TOKEN = "[NinjaFirewall]";

/** The corpus a subject term cannot split: one subject, three bodies, all in the Ohbox. */
const CORPUS = () => [
  msg("alert-1", SENDER, "Notification", "INBOX", { body: `${TOKEN} brute-force attempt blocked` }),
  msg("alert-2", SENDER, "Notification", "INBOX", { body: `Scan finished.\n${TOKEN}\nUnsubscribe.` }),
  msg("invoice", SENDER, "Notification", "INBOX", { body: "Rechnung 2026-08. Zahlbar in 30 Tagen." }),
];

// ───────────────────────────── detection ─────────────────────────────

describe("detecting the repeating token in the text", () => {
  it("finds the bracketed tag that repeats across the sender's other bodies", () => {
    expect(detectBodyToken(
      `${TOKEN} brute-force attempt blocked`,
      [`Scan finished.\n${TOKEN}\nUnsubscribe.`, "Rechnung 2026-08"],
    )).toBe(TOKEN);
  });

  it("answers null when nothing repeats — a tag seen once is this message's wording", () => {
    expect(detectBodyToken(`${TOKEN} one-off`, ["Rechnung", "Terminbestätigung"])).toBeNull();
  });

  it("refuses prose — there is deliberately NO leading-label class for bodies", () => {
    // A body's first colon is a greeting or a sentence, not a label. Only a bracketed run — the
    // sender's own deliberate tag — is offered, so repeating PROSE yields nothing.
    expect(detectBodyToken(
      "Hello: your weekly report is ready",
      ["Hello: your weekly report is ready"],
    )).toBeNull();
  });

  it("compares case-insensitively and keeps the sender's own capitalisation", () => {
    expect(detectBodyToken(
      `${TOKEN} nightly`, ["[ninjafirewall] weekly"],
    )).toBe(TOKEN);
  });

  it("scans only the head of the body — a tag buried past the bound is not offered", () => {
    // The bound is what makes running this over a stranger's multi-kilobyte text safe on every
    // render of an open sheet. A token AFTER it must not be found in the focus OR in the others.
    const deep = `${"x".repeat(MAX_BODY_SCAN)} ${TOKEN}`;
    expect(detectBodyToken(deep, [deep])).toBeNull();
  });

  it("prefers the longer bracketed run — the more specific tag", () => {
    const focus = `[NF] ${TOKEN} alert`;
    expect(detectBodyToken(focus, [`[NF] ${TOKEN} weekly`])).toBe(TOKEN);
  });
});

describe("what the client knows about a message's text", () => {
  it("reads the full body where the mirror holds one, the snippet otherwise", () => {
    expect(bodyTextOf(msg("a", SENDER, "s", "INBOX", { body: "full", snippet: "snip" }))).toBe("full");
    expect(bodyTextOf(msg("b", SENDER, "s", "INBOX", { snippet: "snip" }))).toBe("snip");
  });

  it("counts a match wherever the held text shows it, and nowhere else — the floor", () => {
    const list = [
      msg("hydrated", SENDER, "s", "INBOX", { body: `${TOKEN} deep in the body`, snippet: "top" }),
      msg("snippet-hit", SENDER, "s", "INBOX", { snippet: `${TOKEN} at the top` }),
      // The server WOULD match this one — the token sits past the snippet — but the client
      // cannot see it, and claiming it would be a number the surface cannot stand behind.
      msg("unhydrated", SENDER, "s", "INBOX", { snippet: "the top of a long message" }),
    ];
    expect(bodyMatchCount(list, TOKEN)).toBe(2);
  });
});

// ───────────────────────────── the context and the plan ─────────────────────────────

describe("the sheet's world, with a content token", () => {
  it("detects the body token from the mirror and lists body rules among the existing", async () => {
    const store = await mirror(CORPUS(), [
      ruleRow({ id: "body-rule", destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    const ctx = subjectRuleContext(store, "alert-1")!;
    expect(ctx.bodyToken).toBe(TOKEN);
    // No subject token — the subjects are all identical, which is this feature's whole case…
    expect(ctx.token).toBeNull();
    // …and a rule narrowed by BODY is "one of these" for the duplicate warning and the footer.
    expect(ctx.existing.map((r) => r.id)).toEqual(["body-rule"]);
  });
});

describe("the plan, field = body", () => {
  const wire = (m: EngineMutation[]) => m as unknown as Array<Record<string, unknown>>;

  it("writes ONE rule carrying bodyContains — not subjectContains — and counts only matching mail", async () => {
    const store = await mirror(CORPUS());
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "body");

    expect(wire(plan.ruleMutations)).toEqual([{
      kind: "rule_create",
      ruleKind: "sender",
      match: SENDER,
      destination: "ohmail/News",
      bodyContains: TOKEN,
      applyRetro: true,
    }]);
    expect(plan.field).toBe("body");

    // THE LOAD-BEARING NEGATIVE: the invoice's body has no token, so it is not counted — every
    // other assertion here would pass with the field mix-up this pins against. The press moves
    // none of it itself: a new rule's backlog is the server pass's (THE-CLIENTS-FIFTY).
    expect(plan.mutations.filter((m) => m.kind === "move")).toEqual([]);
    expect(plan.matched).toBe(2);
    expect(plan.outOfPlace).toBe(2);
  });

  it("a SUBJECT rule with the same token is NOT 'already this rule'", async () => {
    // Same token, different field — two different statements about two different slices. Folding
    // them into one "already" would silently refuse the rule the user actually asked for.
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: "ohmail/News", subjectContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "body");
    expect(plan.already).toBe(false);
    expect(plan.ruleMutations).toHaveLength(1);
  });

  it("an identical BODY rule is a duplicate, and nothing is written", async () => {
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: "ohmail/News", bodyContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "body");
    expect(plan.already).toBe(true);
    expect(plan.ruleMutations).toEqual([]);
  });
});

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

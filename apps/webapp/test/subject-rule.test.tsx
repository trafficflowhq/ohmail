/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { LEGACY_NEWS_FOLDER } from "@trafficflow/core/folder-name";
import messages from "../messages/en.json";
import { SenderMenu } from "../app/shell/SenderMenu";
import { SubjectRuleSheet } from "../app/shell/SubjectRuleSheet";
import { senderScreening, planScreeningChange } from "@ohmail/app-logic/press/sender-screening";
import { attributeMessages } from "@ohmail/app-logic/press/sender-audit";
import { RulesView, filterRules, subjectTermOf } from "../app/views/RulesView";
import {
  detectSubjectToken,
  planSubjectRule,
  stripReplyPrefixes,
  subjectCandidates,
  subjectRuleContext,
  subjectRuleToast,
} from "@ohmail/app-logic/press/subject-rule";

/**
 * SPLITTING ONE SENDER BY SUBJECT — the detection, the plan, and the sheet a person meets.
 *
 * The case, in the words it arrived in: one sender sends the invoice AND the nightly
 * `[NinjaFirewall]` alert. A sender rule has one lever for that address, so filing the alerts out
 * files the invoices with them.
 *
 * ── WHY THIS FILE RENDERS AND DOES NOT ONLY CALL ────────────────────────────────────────────
 *
 * This repository's recurring failure is *built, tested, unreachable* — a finished surface over a
 * verb that rejects, a toast fired on a refusal, a picker over an adapter that throws. Every one was
 * green in a suite that exercised the pure module and never rendered the thing the user presses. So
 * the detection and the plan are tested as functions AND the sheet is rendered and driven, including
 * the row that reaches it from the sender popover: a control that exists in a component nobody mounts
 * is the same defect as one that was never written.
 *
 * ── AND WHY THE NEGATIVES CARRY THE WEIGHT ──────────────────────────────────────────────────
 *
 * Every "the narrow rule was written" assertion here would pass if the subject term were dropped on
 * the way to the wire, because the rule still names the sender. The assertions that cannot are the
 * ones about mail the rule must NOT claim, and the ones about the rule the sender sheet must NOT
 * retarget. Those are marked where they appear.
 */

let seq = 0;

function msg(
  id: string, from: string, subject: string, folder: Folder = "INBOX",
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
    snippet: "s",
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

/** The measured corpus shape: two nightly alerts and one invoice, all in the Ohbox. */
const CORPUS = () => [
  msg("alert-1", SENDER, `${TOKEN} Alert: brute-force attempt blocked`),
  msg("alert-2", SENDER, `Re: ${TOKEN} nightly report`),
  msg("invoice", SENDER, "Rechnung 2026-08 / Invoice"),
];

// ───────────────────────────── detection ─────────────────────────────

describe("detecting the repeating token", () => {
  it("strips every reply and forward decoration, in several languages", () => {
    // `Re: [NinjaFirewall] Alert` and `[NinjaFirewall] Alert` must yield the SAME token, or a thread
    // the user has answered offers a different rule from the one beside it.
    expect(stripReplyPrefixes(`Re: ${TOKEN} x`)).toBe(`${TOKEN} x`);
    expect(stripReplyPrefixes(`AW: WG: ${TOKEN} x`)).toBe(`${TOKEN} x`);
    expect(stripReplyPrefixes(`Re[2]: Fwd: ${TOKEN} x`)).toBe(`${TOKEN} x`);
    expect(stripReplyPrefixes(`${TOKEN} x`)).toBe(`${TOKEN} x`);
  });

  it("offers the sender's bracketed tag AHEAD of a longer inferred label", () => {
    // THE ORDERING BUG THIS TEST FOUND, kept as the guard. Sorting purely by length puts the leading
    // label `[NinjaFirewall] Alert` first, because it CONTAINS the tag and is therefore longer — and
    // a rule keyed on it catches the `Alert:` flavour while `[NinjaFirewall] Notice:` and
    // `[NinjaFirewall] Weekly:` stay in the Ohbox. The user writes a rule, watches some of the mail
    // move, and has no way to see why the rest did not.
    const c = subjectCandidates("[NinjaFirewall] Alert: brute-force attempt blocked");
    expect(c[0]).toBe(TOKEN);
    // The bracket is PART of the token: `[NinjaFirewall]` is a far more specific test than
    // `NinjaFirewall`, which would also match a human writing about the plugin.
    expect(c[0]!.startsWith("[")).toBe(true);
    // The label is still OFFERED — it is a real candidate when nothing bracketed repeats — just not
    // first. Both are present, so the assertion is about the order and not about exclusion.
    expect(c).toContain("[NinjaFirewall] Alert");
    expect(c.indexOf(TOKEN)).toBeLessThan(c.indexOf("[NinjaFirewall] Alert"));
  });

  it("falls back to the leading label when nothing bracketed repeats", () => {
    // The label class earns its place: plenty of senders tag with a word and a colon rather than
    // brackets, and refusing to look would leave those senders unsplittable.
    expect(detectSubjectToken(
      "Rechnung 2026-08 / August",
      ["Rechnung 2026-07 / July", "Terminbestätigung"],
    )).toBe("Rechnung 2026");
  });

  it("finds the token that repeats across the sender's other subjects", () => {
    expect(detectSubjectToken(
      `${TOKEN} Alert: brute-force attempt blocked`,
      [`Re: ${TOKEN} nightly report`, "Rechnung 2026-08 / Invoice"],
    )).toBe(TOKEN);
  });

  it("answers null when nothing repeats — a token seen once is not a token", () => {
    // THE LOAD-BEARING NEGATIVE OF THE DETECTOR. A phrase that occurs in exactly one message would
    // produce a rule filing exactly one message, for ever, that the user will never find again to
    // revoke. Dropping the "appears in another subject" test makes this go red.
    expect(detectSubjectToken(
      "[OneOff] a thing that happened once",
      ["Rechnung 2026-08", "Terminbestätigung"],
    )).toBeNull();
  });

  it("refuses a candidate that IS the whole subject", () => {
    // Same objection as above, reached a different way: "this exact message" is not a rule.
    expect(detectSubjectToken("[Weekly]", ["[Weekly]", "[Weekly]"])).toBeNull();
  });

  it("prefers the specific token over the loose label", () => {
    // Between `[NinjaFirewall]` and `Alert`, the loose one would also catch
    // "Alert: your invoice is overdue" — mail from the same sender with nothing to do with the
    // plugin. Reversing the longest-first ordering makes this go red.
    const token = detectSubjectToken(
      `${TOKEN} Alert: something`,
      [`${TOKEN} Alert: other`, "Alert: your invoice is overdue"],
    );
    expect(token).toBe(TOKEN);
  });

  it("keeps the sender's own capitalisation while comparing case-insensitively", () => {
    // The user reads the token off their mail and must recognise it; the sender is under no
    // obligation to keep its capitalisation stable between messages.
    expect(detectSubjectToken("[NinjaFirewall] a", ["[ninjafirewall] b"])).toBe(TOKEN);
  });
});

// ───────────────────────────── the context and the plan ─────────────────────────────

describe("reading the sheet's world out of the mirror", () => {
  it("gathers the sender's mail from one message id and detects the token", async () => {
    const store = await mirror(CORPUS());
    const ctx = subjectRuleContext(store, "alert-1")!;
    expect(ctx.address).toBe(SENDER);
    expect(ctx.messages.map((m) => m.id).sort()).toEqual(["alert-1", "alert-2", "invoice"]);
    expect(ctx.token).toBe(TOKEN);
    expect(ctx.current).toBe("ohbox");
  });

  it("lists only the EXISTING rules that already carry a term for this address", async () => {
    // A BARE sender rule is deliberately absent: it is the rule this sheet exists to refine, not one
    // it collides with. Including it would make the sheet claim a duplicate on every sender the user
    // has ever ruled on.
    const store = await mirror(CORPUS(), [
      ruleRow({ id: "bare", destination: "INBOX" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", subjectContains: TOKEN }),
      ruleRow({ id: "elsewhere", match: "someone@else.example", subjectContains: TOKEN }),
    ]);
    const ctx = subjectRuleContext(store, "alert-1")!;
    expect(ctx.existing.map((r) => r.id)).toEqual(["narrow"]);
  });
});

describe("the plan", () => {
  const wire = (m: EngineMutation[]) => m as unknown as Array<Record<string, unknown>>;

  it("writes ONE rule with both terms, and leaves the matching mail already here to the pass", async () => {
    const store = await mirror(CORPUS());
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads");

    expect(wire(plan.ruleMutations)).toEqual([{
      kind: "rule_create",
      ruleKind: "sender",
      match: SENDER,
      destination: "ohmail/News",
      subjectContains: TOKEN,
      applyRetro: true,
    }]);

    // THE-CLIENTS-FIFTY: a new rule's backlog is the server pass's, so the press moves none of it.
    expect(plan.mutations.filter((m) => m.kind === "move")).toEqual([]);
    expect(plan.matched).toBe(2);
    expect(plan.outOfPlace).toBe(2);
    // THE LOAD-BEARING NEGATIVE OF THE PLANNER, on the press that still moves mail ("File these
    // to …" over the standing rule): the invoice is not moved.
    const standing = await mirror(CORPUS(), [ruleRow({ destination: "ohmail/News", subjectContains: TOKEN })]);
    const refile = planSubjectRule(subjectRuleContext(standing, "alert-1")!, TOKEN, "reads");
    const moves = wire(refile.mutations.filter((m) => m.kind === "move"));
    expect(moves.map((m) => m.messageId).sort()).toEqual(["alert-1", "alert-2"]);
  });

  /**
   * THE SAME NARROWING AS THE SENDER SHEET, BECAUSE IT IS THE SAME OPTIMISTIC HALF. These moves
   * are the head of the worker pass's own set (`retroPassWouldMove`), so mail in a folder the
   * person keeps themselves and mail they set aside are the pass's business and nobody else's —
   * on `folder !== wanted` this sheet moved both. `test/support/retro-candidates.ts` is where the
   * whole predicate is measured; this case is that it reaches HERE.
   */
  it("leaves a term match that is hand-filed or set aside to the pass", async () => {
    const own = msg("alert-own", SENDER, `${TOKEN} filed by hand`, "Archive" as Folder);
    const aside = msg("alert-aside", SENDER, `${TOKEN} set aside`);
    aside.triage = {
      messageId: aside.id, state: "set_aside", bubbleUpAt: null,
      setAt: aside.date!, updatedAt: aside.date!,
    };
    const store = await mirror([...CORPUS(), own, aside], [ruleRow({ destination: "ohmail/News", subjectContains: TOKEN })]);
    // The re-file press over the standing rule — the one press on this sheet that still moves.
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads");

    const moves = wire(plan.mutations.filter((m) => m.kind === "move"));
    expect(moves.map((m) => m.messageId).sort()).toEqual(["alert-1", "alert-2"]);
    // The rule still NAMES them — the count the sheet shows is what the press covers, and the
    // pass is what reaches the rest.
    expect(plan.matched, "the term matched four messages").toBe(4);
    expect(plan.outOfPlace, "the two the press itself may move").toBe(2);
  });

  it("writes NOTHING when an identical rule already exists", async () => {
    // A habit-press must not mint rows nobody can tell apart in the rules list.
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: "ohmail/News", subjectContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads");
    expect(plan.already).toBe(true);
    expect(plan.ruleMutations).toEqual([]);
    expect(subjectRuleToast(plan, "confirmed")).toBe("subjectAlready");
  });

  it("an identical rule stored before the News rename is the same rule — nothing is written", async () => {
    // `ohmail/Reads` is the pre-0.22 spelling of the News pile; the organizer files both into one folder.
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: LEGACY_NEWS_FOLDER as RuleDTO["destination"], subjectContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads");
    expect(plan.already, "a second, identical subject rule").toBe(true);
    expect(plan.ruleMutations).toEqual([]);
  });

  it("does write when the same term points somewhere ELSE", async () => {
    // The existing rule is about the same slice but a different destination, and the answer is a
    // second row rather than a silent rewrite: the specificity order leaves both standing, and the
    // rules surface is where a person resolves it with the full text of both in front of them.
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: "ohmail/Receipts", subjectContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads");
    expect(plan.already).toBe(false);
    expect(plan.ruleMutations).toHaveLength(1);
  });

  /**
   * THE SAME SWITCH, THE SAME SENTENCE, THE SECOND SHEET. "Also move the mail already in your
   * mailbox" is `retroToggle` in both, and here too the answer rode the rule and never the moves
   * — so a person who turned it off in the subject sheet had the matching mail refiled anyway.
   * The `already` arm is the one that must NOT be gated: there no rule is written, the sheet
   * withholds the switch for exactly that reason, and the press means "file these".
   */
  it("the past-mail switch off writes the rule and moves nothing", async () => {
    const store = await mirror(CORPUS());
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "subject", false);
    expect(wire(plan.ruleMutations)).toEqual([expect.objectContaining({ applyRetro: false })]);
    expect(plan.mutations.filter((m) => m.kind === "move"), "the switch said not to").toEqual([]);
    expect(plan.outOfPlace, "what the rule NAMES is unchanged").toBe(2);
  });

  it("an identical rule already standing still files the visible mail — no switch is offered", async () => {
    const store = await mirror(CORPUS(), [
      ruleRow({ destination: "ohmail/News", subjectContains: TOKEN }),
    ]);
    const plan = planSubjectRule(subjectRuleContext(store, "alert-1")!, TOKEN, "reads", "subject", false);
    expect(plan.already).toBe(true);
    expect(plan.ruleMutations).toEqual([]);
    expect(wire(plan.mutations.filter((m) => m.kind === "move")).map((m) => m.messageId).sort())
      .toEqual(["alert-1", "alert-2"]);
  });

  it("says only what the server confirmed", () => {
    // The three-outcome discipline. A toast fired on click would be green in every test — the
    // fixtures adapter never refuses — and wrong on a live account, which is how "Rule revoked" once
    // printed over a refusal.
    const plan = { already: false, ruleMutations: [{}] } as unknown as
      Parameters<typeof subjectRuleToast>[0];
    expect(subjectRuleToast(plan, "confirmed")).toBe("subjectRuled");
    expect(subjectRuleToast(plan, "queued", "queued")).toBe("subjectRuleQueued");
    // "Back online" only offline; a server failure is said as one; online and unanswered is the default.
    expect(subjectRuleToast(plan, "queued", "failing")).toBe("subjectRuleFailing");
    expect(subjectRuleToast(plan, "queued")).toBe("subjectRuleUnsent");
    expect(subjectRuleToast(plan, "rolled_back")).toBe("subjectRuleFailed");
  });
});

// ───────────────────── the sender sheet must not eat the subject rule ─────────────────────

describe("the whole-sender sheet leaves a subject rule alone", () => {
  it("does not retarget it — it writes the broad rule the user actually asked for", async () => {
    // THE ASSERTION THAT PROTECTS A DECISION THE USER ALREADY MADE. Before the exclusion, pressing
    // "Reads" on the sender popover found the `[NinjaFirewall]` rule as "a rule covering this
    // subject" and PATCHed it — so a click meaning *send this address's mail to Reads* silently
    // re-pointed the narrow rule, destroyed the split, and never recorded the broad decision at all.
    // Removing `(r.subjectContains ?? "").trim() === ""` from the twins filter (`ruleTwins`, which
    // `planScreeningChange` reads) makes this go red in both halves.
    const store = await mirror(CORPUS(), [
      ruleRow({ id: "narrow", destination: "ohmail/Receipts", subjectContains: TOKEN }),
    ]);
    const plan = planScreeningChange(senderScreening(store, "invoice")!, "reads");

    expect(plan.ruleState).toBe("created");
    const wire = plan.ruleMutations as unknown as Array<Record<string, unknown>>;
    expect(wire).toEqual([expect.objectContaining({
      kind: "rule_create", ruleKind: "sender", match: SENDER, destination: "ohmail/News",
    })]);
    // …and nothing PATCHes the narrow rule.
    expect(wire.some((m) => m.kind === "rule_update")).toBe(false);
  });

  it("still retargets a BARE rule for the same address", async () => {
    // The exclusion must be about the TERM and not about subject rules existing: the ladder's
    // original job — never two tied rules for one address — has to keep working.
    const store = await mirror(CORPUS(), [
      ruleRow({ id: "bare", destination: "ohmail/Receipts" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", subjectContains: TOKEN }),
    ]);
    const plan = planScreeningChange(senderScreening(store, "invoice")!, "reads");
    expect(plan.ruleState).toBe("retargeted");
    expect(plan.ruleMutations as unknown as Array<Record<string, unknown>>)
      .toEqual([expect.objectContaining({ kind: "rule_update", ruleId: "bare" })]);
  });
});

// ───────────────────────────── the audit surface ─────────────────────────────

describe("the why-it-went-there panel", () => {
  it("names a subject rule only for the mail whose subject satisfies it", async () => {
    // This module's own header forbids asserting anything about the router the mirror cannot see.
    // Without the conjunction check, the invoice sitting in Reads for some OTHER reason would be
    // labelled "filed by a rule" and the `[NinjaFirewall]` rule would be named — a false attribution
    // the user has no way to check.
    const store = await mirror([
      msg("alert-1", SENDER, `${TOKEN} nightly report`, "ohmail/News"),
      msg("invoice", SENDER, "Rechnung 2026-08", "ohmail/News"),
    ], [ruleRow({ id: "narrow", destination: "ohmail/News", subjectContains: TOKEN })]);

    const rows = attributeMessages(store, store.list<EngineMessage>("message"));
    const byId = new Map(rows.map((r) => [r.message.id, r.attribution]));
    expect(byId.get("alert-1")).toEqual({ kind: "rule", rule: expect.objectContaining({ id: "narrow" }) });
    expect(byId.get("invoice")).toEqual({ kind: "arrival" });
  });

  it("prefers the subject rule over a bare one when both hold", async () => {
    // The more specific TRUE statement, and also the one the router would pick.
    const store = await mirror([
      msg("alert-1", SENDER, `${TOKEN} nightly report`, "ohmail/News"),
    ], [
      ruleRow({ id: "bare", destination: "ohmail/News" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", subjectContains: TOKEN }),
    ]);
    const [row] = attributeMessages(store, store.list<EngineMessage>("message"));
    expect(row!.attribution).toEqual({
      kind: "rule", rule: expect.objectContaining({ id: "narrow" }),
    });
  });
});

// ───────────────────────────── the rules list ─────────────────────────────

describe("the rules surface can tell two rules for one address apart", () => {
  it("reads a blank term as no term", () => {
    expect(subjectTermOf(ruleRow({ subjectContains: null }))).toBe("");
    expect(subjectTermOf(ruleRow({ subjectContains: "   " }))).toBe("");
    expect(subjectTermOf(ruleRow({ subjectContains: "\t\n" }))).toBe("");
    expect(subjectTermOf(ruleRow({ subjectContains: ` ${TOKEN} ` }))).toBe(TOKEN);
  });

  it("finds a rule by its subject term, not only by its address", () => {
    // Somebody hunting for "the NinjaFirewall rule" types the token. Before this the only searchable
    // field was the address, which every rule for this sender shares.
    const rules = [
      ruleRow({ id: "bare", destination: "INBOX" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", subjectContains: TOKEN }),
    ];
    expect(filterRules(rules, "ninjafirewall", "all").map((r) => r.id)).toEqual(["narrow"]);
    expect(filterRules(rules, "sichersatt", "all").map((r) => r.id)).toEqual(["bare", "narrow"]);
  });

  it("RENDERS the two rules differently, and names the term in the revoke confirm", async () => {
    // THE ASSERTION `subjectTermOf` AND `filterRules` COULD NOT MAKE, and its absence was measured:
    // mutating `whatOf` back to the bare `what.<kind>` string left this whole file green, because
    // nothing rendered the row. Two rules for one address would then appear as identical lines with
    // identical Change and Revoke buttons, and revoking "the wrong one" is a coin toss a person
    // cannot see they are making.
    //
    // The CONFIRM matters as much as the row: it is the last thing on screen before an irreversible
    // revoke, and "mail from sender@example.test" over the narrow rule would name the wrong rule at
    // exactly the moment naming matters.
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    const rules = [
      ruleRow({ id: "bare", destination: "INBOX" }),
      ruleRow({ id: "narrow", destination: "ohmail/News", subjectContains: TOKEN }),
    ];
    await act(async () => {
      root!.render(
        React.createElement(NextIntlClientProvider, {
          locale: "en",
          messages,
          timeZone: "UTC",
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
    expect(rows).toHaveLength(2);
    const whats = rows.map((r) => r.querySelector(".what")!.textContent ?? "");
    // Both name the address; only one names the term; and the two lines are NOT the same string.
    expect(whats.every((w) => w.includes(SENDER))).toBe(true);
    expect(whats.filter((w) => w.includes(TOKEN))).toHaveLength(1);
    expect(whats[0]).not.toBe(whats[1]);

    // Revoke the NARROW rule and read the confirm.
    const narrowRow = rows.find((r) => r.dataset.ruleId === "narrow")!;
    await click([...narrowRow.querySelectorAll("button")].find((b) => (b.textContent ?? "").includes("Revoke")));
    const confirm = host!.querySelector(".rules-confirm .what");
    expect(confirm, "revoking did not open the confirm").toBeTruthy();
    expect(confirm!.textContent).toContain(TOKEN);
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

/** Type into a controlled input: the native setter plus a bubbling `input`, inside act. */
const type = async (input: HTMLInputElement, value: string) => {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

const editField = (el: HTMLElement): HTMLInputElement =>
  el.querySelector<HTMLInputElement>(".sm-edit-input")!;

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
        // `children` as a PROP: the provider declares it required, and `apps/webapp` typechecks its
        // tests, so the variadic form fails the build.
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

describe("the sheet a person actually presses", () => {
  it("shows the detected token with its size, and the editable match beside it", async () => {
    const { el } = await renderSheet(CORPUS(), "alert-1");
    const tokenBtn = byText(el, ".sm-scope button", TOKEN);
    expect(tokenBtn, "the detected token is not offered").toBeTruthy();
    // The size of the choice, ON the choice: 2 of the 3 messages carry the token.
    expect(tokenBtn!.textContent).toContain("2");
    expect(tokenBtn!.getAttribute("aria-checked")).toBe("true");
    // The manual door beside it: an editable field PREFILLED with the full subject, so the
    // untouched field is "this exact subject" and every deletion widens from there.
    expect(editField(el).value).toBe(`${TOKEN} Alert: brute-force attempt blocked`);
  });

  it("states BOTH terms and the destination before anything is written", async () => {
    // THE POINT OF THE CONFIRM. A term that is subtly wrong is this feature's failure mode and no
    // toast afterwards repairs a re-filed backlog, so the conjunction has to be readable first.
    const { onConfirm, el } = await renderSheet(CORPUS(), "alert-1");
    await click(byText(el, "li[role='option']", "News"));

    const confirm = el.querySelector(".sm-confirm p");
    expect(confirm, "pressing a destination did not open the confirm").toBeTruthy();
    const text = confirm!.textContent ?? "";
    expect(text).toContain(SENDER);
    expect(text).toContain(TOKEN);
    expect(text).toContain("News");
    expect(text.toLowerCase()).toContain("and");   // it reads as a conjunction, not a list

    // …and the FIRST press committed nothing.
    expect(onConfirm).not.toHaveBeenCalled();
    await click(byText(el, ".sm-confirm-row button.go", "News"));
    expect(onConfirm).toHaveBeenCalledWith(TOKEN, "reads", "subject", true);
  });

  it("switching to the untouched match field confirms the exact subject", async () => {
    // A control that renders and does not reach the dispatch is the "built, tested, unreachable"
    // shape this file exists to refuse.
    const { onConfirm, el } = await renderSheet(CORPUS(), "alert-1");
    await click(el.querySelector(".sm-edit"));
    await click(byText(el, "li[role='option']", "Receipts"));
    await click(byText(el, ".sm-confirm-row button.go", "Receipts"));
    expect(onConfirm).toHaveBeenCalledWith(
      `${TOKEN} Alert: brute-force attempt blocked`, "receipts", "subject", true,
    );
  });

  it("a TRIMMED fragment updates the live count and is what gets written", async () => {
    // THE MANUAL DOOR (owner request 2026-08-26): detection found `[NinjaFirewall]`, but the
    // fragment the user wants is their own. The count under the field re-runs the server's own
    // case-folded substring test on every edit, so the number and the rule cannot disagree.
    const { onConfirm, el } = await renderSheet(CORPUS(), "alert-1");
    await type(editField(el), "Alert:");
    const tile = el.querySelector(".sm-edit")!;
    // The tile's RADIO is its own atomic control beside the labeled textbox (never a textbox
    // inside a radio); typing selects the choice exactly as pressing it does.
    expect(tile.querySelector(".sm-edit-pick")!.getAttribute("aria-checked"),
      "typing must select the manual choice").toBe("true");
    // …and the count is a live status region the field is described by, so the feedback is
    // announced while focus stays in the field.
    expect(tile.querySelector(".sm-edit-status")!.getAttribute("role")).toBe("status");
    /* THE PICK IS A LINE, NOT A TILE — asserted at the stylesheet, because jsdom lays nothing
       out: the sheet's generic `.sm-scope button` tile rule (0-1-1) beats a bare single class,
       so the pick's reset must carry two classes and name the tile properties it undoes
       (review round: the lead rendered as a second full tile inside the editable tile). */
    const css = readFileSync(resolve(__dirname, "../app/shell/sender-sheet.css"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const pick = /(?:^|[};])\s*\.sm-scope \.sm-edit-pick\s*\{([^{}]*)\}/m.exec(css);
    expect(pick, "the pick reset must outrank `.sm-scope button`").not.toBeNull();
    expect(pick![1]).toMatch(/display:\s*block/);
    expect(pick![1]).toMatch(/background:\s*none/);
    expect(pick![1]).toMatch(/flex:\s*none/);
    expect(el.querySelector(".sm-edit-input")!.getAttribute("aria-describedby")).toBe("sm-edit-status");
    expect(tile.textContent).toContain("1 of this sender's messages");

    await click(byText(el, "li[role='option']", "News"));
    expect(el.querySelector(".sm-confirm p")!.textContent).toContain("Alert:");
    await click(byText(el, ".sm-confirm-row button.go", "News"));
    expect(onConfirm).toHaveBeenCalledWith("Alert:", "reads", "subject", true);
  });

  it("says so when the fragment stops narrowing — it matches ALL of the sender's mail here", async () => {
    const { el } = await renderSheet(CORPUS(), "alert-1");
    // Every CORPUS subject contains an "e" somewhere; the rule is a sender rule in disguise.
    await type(editField(el), "e");
    expect(el.querySelector(".sm-edit")!.textContent).toContain("3 of this sender's messages");
    const warn = el.querySelector(".sm-edit-warn");
    expect(warn, "a fragment matching everything went unremarked").toBeTruthy();
    expect(warn!.textContent).toContain("no longer narrows");
  });

  it("says so when the fragment matches NOTHING, and an emptied field cannot be written", async () => {
    const { onConfirm, el } = await renderSheet(CORPUS(), "alert-1");
    await type(editField(el), "zzz-not-in-any-subject");
    expect(el.querySelector(".sm-edit")!.textContent).toContain("0 of this sender's messages");
    expect(el.querySelector(".sm-edit-warn")!.textContent).toContain("none of this sender's mail");

    // Emptied: the plan answers zero mutations, so the go press is withheld, never a no-op write.
    await type(editField(el), "");
    expect(el.querySelector(".sm-edit-warn")!.textContent).toContain("Type part of the subject");
    await click(byText(el, "li[role='option']", "News"));
    const go = byText(el, ".sm-confirm-row button.go", "News") as HTMLButtonElement;
    expect(go.disabled, "an empty term must not be committable").toBe(true);
    await click(go);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("says so when nothing repeats, and still offers the exact subject", async () => {
    // Detection answering `null` is a normal outcome. A sheet that silently offered one option would
    // leave the reader wondering what it looked for.
    const { el } = await renderSheet([
      msg("only", SENDER, "[OneOff] a thing that happened once"),
      msg("other", SENDER, "Rechnung 2026-08"),
    ], "only");
    expect(el.textContent).toContain("No repeating tag");
    // …and the manual door is the standing offer: the field, prefilled with the full subject.
    expect(editField(el).value).toBe("[OneOff] a thing that happened once");
    expect(byText(el, ".sm-scope button", "[OneOff]")).toBeFalsy();
  });

  it("an over-cap fragment is said out loud and cannot be committed", async () => {
    // The server refuses a term over its cap with a 400; a sheet that let the press through
    // closed itself, lost the edit, and had already dispatched the visible moves. So the state
    // is stated at the field and the plan answers ZERO mutations, moves included.
    const { onConfirm, el } = await renderSheet(CORPUS(), "alert-1");
    await type(editField(el), "A".repeat(201));
    expect(el.querySelector(".sm-edit-warn")!.textContent).toContain("at most 200 characters");
    await click(byText(el, "li[role='option']", "News"));
    const go = byText(el, ".sm-confirm-row button.go", "News") as HTMLButtonElement;
    expect(go.disabled).toBe(true);
    await click(go);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("an emptied field is non-committable even when a BODY rule already exists for the pile", async () => {
    // A body-only rule's absent subjectContains normalizes to "" too; without the seam's
    // empty-term clause the emptied field compared equal to it, `already` went true, and the
    // press closed the sheet claiming an existing rule.
    const { onConfirm, el } = await renderSheet(CORPUS(), "alert-1", [
      ruleRow({ destination: "ohmail/News", bodyContains: "unsubscribe" }),
    ]);
    await type(editField(el), "");
    await click(byText(el, "li[role='option']", "News"));
    const go = byText(el, ".sm-confirm-row button.go", "News") as HTMLButtonElement;
    expect(go.disabled, "an empty term must never ride an unrelated rule's `already`").toBe(true);
    await click(go);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it("warns before writing a duplicate", async () => {
    const { el } = await renderSheet(CORPUS(), "alert-1", [
      ruleRow({ destination: "ohmail/News", subjectContains: TOKEN }),
    ]);
    await click(byText(el, "li[role='option']", "News"));
    expect(el.querySelector(".sm-confirm")!.textContent).toContain("already have this rule");
  });
});

describe("the sender popover offers the way in", () => {
  async function renderMenu(
    list: EngineMessage[], seedId: string,
  ): Promise<{ onSubjectRule: ReturnType<typeof vi.fn>; el: HTMLElement }> {
    const store = await mirror(list);
    const sender = senderScreening(store, seedId)!;
    const onSubjectRule = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => {
      root!.render(
        React.createElement(NextIntlClientProvider, {
          locale: "en",
          messages,
          children: React.createElement(SenderMenu, {
            state: { messageId: seedId, x: 0, y: 0 },
            sender,
            onChoose: () => {},
            onOpenDetail: () => {},
            onSubjectRule,
            onClose: () => {},
          }),
        }),
      );
    });
    return { onSubjectRule, el: host! };
  }

  it("has a row that reaches the finer sheet", async () => {
    const { onSubjectRule, el } = await renderMenu(CORPUS(), "alert-1");
    const row = byText(el, "button.sm-detail", "subject");
    expect(row, "the sender sheet offers no way to split a sender by subject").toBeTruthy();
    await click(row);
    expect(onSubjectRule).toHaveBeenCalledTimes(1);
  });

  it("does NOT offer it at domain scope — the server refuses a term on a domain rule", async () => {
    // A choice that ends in a 400 must not be presented. Domain scope is the opposite direction from
    // this feature: wider, not finer.
    const { el } = await renderMenu([
      msg("a", "no-reply-1@sichersatt.example", `${TOKEN} x`),
      msg("b", "no-reply-2@sichersatt.example", `${TOKEN} y`),
    ], "a");
    await click(byText(el, ".sm-scope button", "Everyone at sichersatt.example"));
    expect(byText(el, "button.sm-detail", "subject")).toBeFalsy();
  });
});

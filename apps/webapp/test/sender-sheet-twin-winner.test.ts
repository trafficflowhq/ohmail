/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { NextIntlClientProvider } from "next-intl";
import { ThemeProvider, ToastHost } from "@ohmail/ui";
import {
  MemoryMirrorStore,
  rulesList,
  type EngineMessage,
  type EngineMutation,
  type Folder,
  type RuleDTO,
  type SyncChange,
} from "@ohmail/client-engine";
import baseMessages from "../messages/en.json";
import { SettingsView } from "../app/views/SettingsView";
import { routedRule } from "@ohmail/app-logic/press/sender-audit";
import {
  planScreeningChange,
  screeningToast,
  senderScreening,
  type ScreeningDest,
} from "@ohmail/app-logic/press/sender-screening";

/**
 * THE SHEET OVER A SENDER'S RULE TWINS (SENDER-SHEET-ALREADY-OVER-AN-OUTRANKING-TWIN). An allow
 * into the Ohbox and a deny into Screened for one address: the deny wins under `compareRules`, so
 * the sender's mail is screened. Pressing Ohbox must change the rule that wins — never answer
 * "already" because a losing twin points there. Each case applies the plan's rule writes the way
 * the server does (a PATCH replaces the destination and collapses the row's twins under its key,
 * a POST adds a manual rule) and asks the router's reading which rule files the sender's NEXT
 * message, and the Rules page what it shows. A press is ONE write: a second would name a row the
 * first one's convergence already deleted.
 */
(globalThis as unknown as { React: unknown }).React = React;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;

const LENA = "lena@atelier.example";
let seq = 0;

function msg(id: string, folder: Folder, from = LENA): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: from }, to: [], cc: [],
    date: "2026-08-03T09:00:00.000Z", folder, snippet: `snippet ${id}`, unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-08-03T09:00:00.000Z",
  };
}

function rule(id: string, destination: Folder, over: Partial<RuleDTO> = {}): RuleDTO {
  return {
    id, kind: "sender", match: LENA, destination, priority: 0, provenance: "manual", enabled: true,
    stats: { hits: 0, lastHitAt: null, demotions: 0 },
    createdAt: "2026-08-01T09:00:00.000Z", updatedAt: "2026-08-01T09:00:00.000Z", ...over,
  };
}

/** The probe: the allow first, the deny a day later — the order a person makes them in. */
const ALLOW = () => rule("r-allow", "INBOX");
const DENY = () => rule("r-deny", "ohmail/Screened", { createdAt: "2026-08-02T09:00:00.000Z" });

async function mirror(messages: EngineMessage[], rules: RuleDTO[]): Promise<MemoryMirrorStore> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    ...messages.map((m): SyncChange => ({ type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m })),
    ...rules.map((r): SyncChange => ({ type: "rule", op: "create", id: r.id, seq: ++seq, updatedAt: r.updatedAt, entity: r })),
  ]);
  return store;
}

const keyOf = (r: RuleDTO) => JSON.stringify([r.kind, r.match.trim().toLowerCase(), r.subjectContains ?? null, r.bodyContains ?? null]);

/** The server's answer to the plan's rule writes: PATCH converges the key onto the row, POST adds a rule. */
function afterWrites(rules: readonly RuleDTO[], writes: readonly EngineMutation[]): RuleDTO[] {
  let out = rules.map((r) => ({ ...r }));
  for (const w of writes) {
    if (w.kind === "rule_update") {
      const target = out.find((r) => r.id === w.ruleId);
      if (target === undefined) throw new Error(`PATCH ${w.ruleId}: 404, the row is gone`);
      out = out.filter((r) => r.id === w.ruleId || keyOf(r) !== keyOf(target))
        .map((r) => (r.id === w.ruleId ? { ...r, destination: w.destination } : r));
    } else if (w.kind === "rule_create") {
      out.push(rule(`r-new-${out.length}`, w.destination, { kind: w.ruleKind, match: w.match }));
    }
  }
  return out;
}

async function press(rules: RuleDTO[], dest: ScreeningDest, applyRetro = true, scope: "sender" | "domain" = "sender") {
  const store = await mirror([msg("m1", "INBOX")], rules);
  const plan = planScreeningChange(senderScreening(store, "m1")!, dest, scope, true, applyRetro);
  const after = afterWrites(rulesList(store), plan.ruleMutations);
  const next = routedRule(after.filter((r) => r.enabled), msg("next", "INBOX"));
  return { plan, after, nextFiles: next?.destination ?? null };
}

const writesTo = (plan: { ruleMutations: EngineMutation[] }, id: string) =>
  plan.ruleMutations.filter((m) => m.kind === "rule_update" && m.ruleId === id);

describe("the probe — allow into the Ohbox, a newer deny into Screened", () => {
  it("the deny twin decides before any press, so the sender's next message is screened", () => {
    expect(routedRule([ALLOW(), DENY()], msg("next", "INBOX"))?.id).toBe("r-deny");
  });

  it("pressing Ohbox is not 'already': the winner files elsewhere, so the press changes it", async () => {
    const { plan, nextFiles } = await press([ALLOW(), DENY()], "ohbox");
    expect(plan.ruleState).toBe("retargeted");
    expect(writesTo(plan, "r-deny")).toEqual([
      expect.objectContaining({ kind: "rule_update", destination: "INBOX", applyRetro: true }),
    ]);
    expect(nextFiles, "the sender's next message still screened after pressing Ohbox").toBe("INBOX");
    expect(screeningToast(plan, "confirmed", 0)).toBe("toastRetargeted");
  });

  it("with the past-mail switch off the deny twin is still retargeted, and nothing re-arms", async () => {
    const { plan, nextFiles } = await press([ALLOW(), DENY()], "ohbox", false);
    expect(plan.ruleState).toBe("retargeted");
    expect(plan.ruleMutations).toEqual([
      { kind: "rule_update", ruleId: "r-deny", destination: "INBOX", applyRetro: false },
    ]);
    expect(nextFiles).toBe("INBOX");
    expect(screeningToast(plan, "confirmed", 0)).toBe("toastRuledFuture");
  });

  it("the twins' order in the mirror decides nothing — deny first reads the same", async () => {
    const { plan, nextFiles } = await press([DENY(), ALLOW()], "ohbox");
    expect(plan.ruleState).toBe("retargeted");
    expect(nextFiles).toBe("INBOX");
  });

  it("the domain scope reads its own twins by the same order", async () => {
    const dom = (id: string, d: Folder) => rule(id, d, { kind: "domain", match: "atelier.example" });
    const { plan, nextFiles } = await press([dom("d-allow", "INBOX"), dom("d-deny", "ohmail/Screened")], "ohbox", true, "domain");
    expect(plan.ruleState).toBe("retargeted");
    expect(writesTo(plan, "d-deny")).toHaveLength(1);
    expect(nextFiles).toBe("INBOX");
  });
});

describe("'already' is said only when the winning twin already files there", () => {
  it("Screen out over the same pair IS already — one write over the deny, and the allow twin is retired", async () => {
    const { plan, after, nextFiles } = await press([ALLOW(), DENY()], "screened");
    expect(plan.ruleState).toBe("already");
    expect(plan.ruleMutations).toEqual([
      { kind: "rule_update", ruleId: "r-deny", destination: "ohmail/Screened", applyRetro: true },
    ]);
    expect(after.map((r) => [r.id, r.destination])).toEqual([["r-deny", "ohmail/Screened"]]);
    expect(nextFiles).toBe("ohmail/Screened");
    expect(screeningToast(plan, "confirmed", 0)).toBe("toastAlreadyRuledRetro");
  });

  it("an allow that outranks by priority is already, and the losing deny is retired with it", async () => {
    const { plan, after } = await press([ALLOW(), DENY()].map((r) => (r.id === "r-allow" ? { ...r, priority: 1 } : r)), "ohbox");
    expect(plan.ruleState).toBe("already");
    expect(plan.ruleMutations.map((m) => m.kind === "rule_update" && m.ruleId)).toEqual(["r-allow"]);
    expect(after.map((r) => [r.id, r.destination])).toEqual([["r-allow", "INBOX"]]);
  });

  it("the ordinary one-rule cases are unchanged — a rule there is re-armed, one elsewhere retargeted", async () => {
    const there = await press([ALLOW()], "ohbox");
    expect(there.plan.ruleState).toBe("already");
    expect(there.plan.ruleMutations).toEqual([
      { kind: "rule_update", ruleId: "r-allow", destination: "INBOX", applyRetro: true },
    ]);
    expect((await press([ALLOW()], "ohbox", false)).plan.ruleMutations).toEqual([]);
    const elsewhere = await press([rule("r-news", "ohmail/News")], "ohbox");
    expect(elsewhere.plan.ruleState).toBe("retargeted");
    expect(elsewhere.nextFiles).toBe("INBOX");
    const none = await press([], "ohbox");
    expect(none.plan.ruleState).toBe("created");
    expect(none.nextFiles).toBe("INBOX");
  });
});

describe("the Rules page shows what the person pressed", () => {
  let host: HTMLDivElement;
  let root: Root | null = null;
  beforeEach(() => {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });
  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = null;
    host.remove();
  });

  it("after pressing Ohbox every rule for the sender reads 'Files into Ohbox'", async () => {
    const { after } = await press([ALLOW(), DENY()], "ohbox");
    const rules = { items: after, onRevoke: async () => ({ status: "confirmed" as const }), onRetarget: async () => ({ status: "confirmed" as const }), pastMail: () => null };
    await act(async () => {
      root!.render(h(NextIntlClientProvider, {
        locale: "en", messages: baseMessages, timeZone: "UTC", now: new Date("2026-08-04T12:00:00.000Z"),
        children: h(ThemeProvider, { children: h(ToastHost, { children: h(SettingsView, { notifications: null, tags: [], tagCounts: {}, rules }) }) }),
      }));
    });
    await act(async () => {
      [...host.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.trim() === "Rules")!
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const rows = [...host.querySelectorAll<HTMLElement>("[data-rule-id]")].map((r) => r.textContent ?? "");
    // The press converged the sender's key onto the row it named: ONE rule, and no copy behind it.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain(`Mail from ${LENA}`);
    expect(rows[0]).toContain("Files into Ohbox");
    expect(rows[0]).not.toContain("more cop");
  });
});

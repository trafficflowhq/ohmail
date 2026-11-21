/** @vitest-environment jsdom */
import { readFileSync } from "node:fs";
import { clickMounted, withMountedSender } from "./fixtures/mounted-sender-sheet.js";
import { tick as tickWeb } from "./fixtures/screening-web.js";
import { reportSays } from "./ohbox/_finders.js";
import { UNDO_MS } from "@ohmail/app-logic/press/routing-undo";
import type { EngineMessage, EngineMutation, Folder, MessageBodyWire } from "@ohmail/wire";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { within } from "@testing-library/react";
import { createTranslator } from "next-intl";
import {
  OhmailEngine,
  MemoryMirrorStore,
  mutationEffects,
  pressGained,
  type SyncChange,
} from "@ohmail/client-engine";
import messages from "../messages/en.json";
import { sliceOfDeclaration } from "./source-anchor";
import { act, answerConsentWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import type { ShellConsentFacts } from "@ohmail/app-logic/press/consent-options";
import { screeningReadBack, screeningShown } from "@ohmail/app-logic/press/press-verdict";
import { dispatchScreeningChange, planScreeningChange, senderScreening } from "@ohmail/app-logic/press/sender-screening";

/**
 * THE COUNT IS WHAT YOU GAIN. Accepting a waiting sender said "Ohbox — 1 message
 * from them moved" while two of their letters appeared in the Ohbox: one moved back from Screened,
 * one already in the INBOX and shown at the gate until the rule placed it. The count was the
 * plan's moves. A count a sentence states is the rows the list shows at the place now and did not
 * before the press, read over the lists' own partition before the dispatch and at the answer.
 * TO WATCH IT FAIL: the past-the-gate toast's `count: pressGained(before, shownAt(subject, dest))`
 * in `screener-state.ts` → `count: plan.moved`, and the first two cases read 0, not 1 and 26.
 */

const NOW = new Date("2026-09-26T12:00:00.000Z");
const ADDR = "letters@split.example";
const FACTS: ShellConsentFacts = {
  known: true, standalone: false, dormancyDays: 90, screeningBaselineAt: null,
  screeningScope: "window", foldersEnabled: false,
};
const tr = createTranslator({ locale: "en", messages: messages as never, namespace: "screening" });

let seq = 0;
let sent: EngineMutation[] = [];

function msg(id: string, folder: Folder, date = "2026-09-25T09:00:00.000Z"): EngineMessage {
  return {
    id, accountId: "acct_live_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
    subject: `Subject ${id}`, from: { name: null, address: ADDR }, to: [], cc: [],
    date, folder, snippet: `snippet ${id}`, unread: true, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-25T09:00:00.000Z",
  };
}

/** An engine that echoes every mutation's effects as the server would, and records what it was asked. */
async function engineWith(mail: EngineMessage[]): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges(mail.map((m): SyncChange => ({
    type: "message", op: "create", id: m.id, seq: ++seq, updatedAt: m.updatedAt, entity: m,
  })));
  return new OhmailEngine({
    store,
    now: () => NOW,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: NOW.toISOString(),
      }),
      mutate: async (m) => {
        sent.push(m);
        const changes: SyncChange[] = mutationEffects(store, m, { now: () => NOW, uuid: () => `id-${++seq}` }).map((e) => ({
          type: e.type, op: e.move ? "move" : "update", id: e.id, seq: ++seq,
          updatedAt: NOW.toISOString(), entity: e.entity, ...(e.move ? { move: e.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes[changes.length - 1]?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async (): Promise<MessageBodyWire> => ({
        text: "body", html: null, loadedRemoteContent: false, unsubscribe: "no_header", unsubscribeUrl: null,
      }),
    },
  });
}

async function acceptIntoOhbox(mail: EngineMessage[]): Promise<{ said: string[]; moves: number }> {
  const engine = await engineWith(mail);
  window.location.hash = "#/screener";
  const host = await mountShell([mailbox({
    id: "mb_1", lastSyncAt: NOW.toISOString(), organizerRole: "organizer", organizeConsentedAt: NOW.toISOString(),
  })], { engine, suggestWire: "none", junkWire: "none" });
  await tick(50);
  const waiting = within(host).getByRole("listbox", { name: messages.screener.title });
  const sender = within(waiting).getByRole("option", { name: /in-0|in-1/ });
  await act(async () => { sender.click(); });
  await tick(0);
  const actions = within(host).getByRole("toolbar", { name: messages.screener.place.panel });
  const ohbox = within(actions).getByRole("button", { name: messages.screener.pileOhbox });
  await act(async () => { ohbox.click(); });
  await tick(COMMIT_MS + 50);
  const said = within(host).queryAllByRole("status").map((status) => status.textContent?.trim() ?? "");
  return { said, moves: sent.filter((m) => m.kind === "move").length };
}

beforeEach(() => {
  installShellEnv();
  vi.setSystemTime(NOW);
  answerConsentWith({ dormancyDays: FACTS.dormancyDays });
  window.localStorage.clear();
  sent = [];
  seq = 0;
});

afterEach(async () => { await teardownShellEnv(); });

describe("the Screener's accept says what the Ohbox gained", () => {
  it("one letter in the INBOX and one in Screened: one is there, and the Screened one stays where it is", async () => {
    // Ruled, the card files what it shows: the rule asks no past-mail answer, so the Screened letter
    // stays and the sentence says so; the count is the INBOX letter the rule placed.
    const { said, moves } = await acceptIntoOhbox([msg("in-1", "INBOX"), msg("sc-1", "ohmail/Screened", "2026-09-20T09:00:00.000Z")]);
    expect(moves, "an Ohbox decision moves nothing: the letter is already in the INBOX").toBe(0);
    expect(said, said.join(" | ")).toContain("1 is in Ohbox · 1 is still in Screened.");
  });

  it("twenty-six already in the INBOX and one in Screened: twenty-six, and no move", async () => {
    const inbox = Array.from({ length: 26 }, (_, i) => msg(`in-${i}`, "INBOX", `2026-09-25T0${i % 10}:${String(i).padStart(2, "0")}:00.000Z`));
    const { said, moves } = await acceptIntoOhbox([...inbox, msg("sc-1", "ohmail/Screened", "2026-09-20T09:00:00.000Z")]);
    expect(moves).toBe(0);
    expect(said, said.join(" | ")).toContain("26 are in Ohbox · 1 is still in Screened.");
  });

  it("the sentence says a letter is there, never that it moved", () => {
    for (const key of ["toastRuled", "toastRuledMoved", "toastRetargeted", "toastRuleQueued", "toastRuleFailing", "toastRuleUnsent"] as const) {
      expect(tr(key, { place: "Ohbox", sender: ADDR, count: 2 }), key).not.toMatch(/\bmoved\b/);
    }
  });
});

/**
 * THE SHEET'S DECIDE, OVER THE SAME READINGS the shell composes (`changeScreening`'s `say`): a
 * waiting sender with one letter at the gate, one in the INBOX shown at the gate, one in Screened.
 * The plan moves the gate letter (the Screened one is the pass's, THE-CLIENTS-FIFTY); the Ohbox gains two.
 */
describe("the sender sheet's count is the same reading", () => {
  it("a split waiting sender gains two where the plan moves one", async () => {
    const engine = await engineWith([
      msg("gate-1", "ohmail/Screener", "2026-09-25T10:00:00.000Z"),
      msg("in-1", "INBOX"),
      msg("sc-1", "ohmail/Screened", "2026-09-20T09:00:00.000Z"),
    ]);
    await engine.start();
    const sender = senderScreening(engine.verbRead(), "gate-1")!;
    const plan = planScreeningChange(sender, "ohbox", "sender", true);
    expect(plan.ruleState).toBe("promoted");
    expect(plan.moved, "the decide moves the gate letter; the Screened one is the pass's").toBe(1);
    const facts = { consent: FACTS, now: NOW, ownAddresses: [] as string[] };
    const subject = sender.scopes.sender.messages;
    const before = screeningShown(engine.verbRead(), subject, "ohbox", facts);
    const settled: Promise<unknown>[] = [];
    await dispatchScreeningChange(plan, [], (m) => { const p = engine.mutate(m); settled.push(p); return p; });
    await Promise.all(settled);
    const back = screeningReadBack(engine.verbRead(), "gate-1", undefined, "ohbox", "sender", { ...facts, retro: plan.retro });
    expect(back?.verdict.key, "the pass still owes the Screened letter").toBe("applying");
    expect(pressGained(before, back!.shown)).toBe(2);
  });

  it("a sender whose only letter is at the gate gains the one the decide moved (the control)", async () => {
    const engine = await engineWith([msg("gate-1", "ohmail/Screener", "2026-09-25T10:00:00.000Z")]);
    await engine.start();
    const sender = senderScreening(engine.verbRead(), "gate-1")!;
    const plan = planScreeningChange(sender, "ohbox", "sender", true);
    const facts = { consent: FACTS, now: NOW, ownAddresses: [] as string[] };
    const before = screeningShown(engine.verbRead(), sender.scopes.sender.messages, "ohbox", facts);
    const settled: Promise<unknown>[] = [];
    await dispatchScreeningChange(plan, [], (m) => { const p = engine.mutate(m); settled.push(p); return p; });
    await Promise.all(settled);
    expect(plan.moved).toBe(1);
    expect(pressGained(before, screeningShown(engine.verbRead(), sender.scopes.sender.messages, "ohbox", facts))).toBe(1);
  });

  it("every sheet sentence takes its count from pressGained, never from the plan's moves", async () => {
    const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
    const bulk = sliceOfDeclaration(source("../../../packages/app-logic/src/press/selection-screening.ts"), "screenBulk");
    expect(bulk.match(/count: gained\(\)/g) ?? [], "both bulk sentences").toHaveLength(2);
    const shown = sliceOfDeclaration(source("../../../packages/app-logic/src/screener/live.ts"), "shownAt");
    expect(shown, "the Screener uses the lists' own reading")
      .toMatch(/screeningShown\(engine\.read\(\), subject, dest, \{\s*consent: demo \? null : consent/);

    await withMountedSender(async ({ sheet, writes, id }) => {
      await clickMounted(sheet.getByRole("radio", { name: /^Everyone at sender\.example/ }));
      await clickMounted(sheet.getByRole("option", { name: /^News/ }));
      await tickWeb(500);
      expect(writes.filter(({ path }) => path.endsWith("/move")).map(({ path }) => path)).toEqual([
        `/api/messages/${id}/move`,
      ]);
      expect(writes.filter(({ path }) => path === "/api/rules")).toEqual([{
        method: "POST", path: "/api/rules",
        body: expect.objectContaining({ kind: "domain", destination: "ohmail/News" }),
      }]);
      expect(reportSays()).toBe("News — 2 messages from sender.example are now there. Future mail from them files there too.");
    }, { organizerFilesBacklog: true });

    for (const refused of [true, false]) {
      await withMountedSender(async ({ sheet, writes, id }) => {
        await clickMounted(sheet.getByRole("option", { name: /^News/ }));
        await tickWeb(UNDO_MS + 500);
        expect(writes.filter(({ path }) => path.endsWith("/move")).map(({ path }) => path)).toEqual([
          `/api/messages/${id}/move`,
        ]);
        expect(writes.filter(({ path }) => path === "/api/rules")).toHaveLength(1);
        expect(reportSays()).toContain("mail already here stays where it is");
        expect(reportSays()).toContain(refused ? "the rule couldn't be made" : "the server answered the rule with an error");
        expect(reportSays()).not.toMatch(/\b[1-9] messages? from/);
      }, { refused, queued: !refused, extraPlaced: true });
    }
  }, 30_000);
});

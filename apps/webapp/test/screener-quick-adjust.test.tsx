/** @vitest-environment jsdom */
import { fireEvent, within } from "@testing-library/react";
import type { EngineMessage, EngineMutation, ScreenerSuggestionEntity } from "@ohmail/wire";
import { MemoryMirrorStore, OhmailEngine, mutationEffects, type SyncChange } from "@ohmail/client-engine";
import { confirmSyncOwner, createSyncGate, registerSyncGate } from "@ohmail/app-logic/session/sync-scheduler";
import { COMMIT_MS } from "@ohmail/app-logic/screener/screener-state";
import type { SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { message } from "./_draft-shell.js";
import { selectScreenerRow } from "./fixtures/live-screener.js";
import { ISO, act, answerConsentWith, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell.js";

const account = "acct_live_1";
const mailboxId = "mb_1";
const holder = "Office Mac";
let host: HTMLElement;
let sent: EngineMutation[];

function msg(id: string, sender: string, hour: number): EngineMessage {
  return message(id, {
    accountId: account, mailboxId, folder: "ohmail/Screener",
    from: { name: null, address: `${sender}@example.test` }, unread: true,
    date: `2026-08-02T${String(hour).padStart(2, "0")}:00:00.000Z`, updatedAt: ISO,
  });
}

function suggestion(letter: EngineMessage, folder: "ohmail/News" | "ohmail/Receipts"): ScreenerSuggestionEntity {
  return {
    id: `suggestion-${letter.id}`, messageId: letter.id, senderKey: letter.from.address,
    destination: folder, decision: "yes", spam: false, confidence: 0.88,
    boughtAt: ISO, updatedAt: ISO,
  };
}

beforeEach(() => {
  installShellEnv();
  window.localStorage.clear();
  vi.stubGlobal("innerWidth", 1280);
  answerConsentWith({ blockAutoUnsubscribeAt: ISO });
  sent = [];
});
afterEach(async () => {
  await teardownShellEnv();
  vi.unstubAllGlobals();
});

/** A mounted account with the decisions the organizer already holds and a wire that records new ones. */
async function mount(mail: EngineMessage[], opts: { advice?: ScreenerSuggestionEntity[]; pending?: boolean } = {}) {
  const store = new MemoryMirrorStore();
  let seq = 0;
  await store.load();
  const messageChange = (entity: EngineMessage): SyncChange => ({
    type: "message", op: "create", id: entity.id, seq: ++seq, updatedAt: ISO, entity,
  });
  const adviceChange = (entity: ScreenerSuggestionEntity): SyncChange => ({
    type: "screener_suggestion", op: "create", id: entity.id, seq: ++seq, updatedAt: ISO, entity,
  });
  await store.applyChanges([...mail.map(messageChange), ...(opts.advice ?? []).map(adviceChange)]);
  let arrivals: SyncChange[] = [];
  const engine = new OhmailEngine({
    store,
    now: () => new Date(),
    adapter: {
      sync: async () => {
        const creates = arrivals.filter((change) => change.op !== "delete");
        const deletes = arrivals.filter((change) => change.op === "delete");
        arrivals = [];
        return {
          changes: { creates, updates: [], moves: [], deletes },
          cursor: creates.length || deletes.length ? `c${seq}` : store.getCursor(), hasMore: false, serverTime: ISO,
        };
      },
      mutate: async (mutation) => {
        sent.push(mutation);
        if (opts.pending && mutation.kind === "screener_decide") {
          return {
            settlement: "queued" as const, queuedWith: { name: holder },
            requestId: `request-${mutation.senderId}`, changes: [], seq: null,
          };
        }
        const changes: SyncChange[] = mutationEffects(store, mutation, {
          now: () => new Date(), uuid: () => `id-${++seq}`,
        }).map((effect) => ({
          type: effect.type, op: effect.move ? "move" : "update", id: effect.id,
          seq: ++seq, updatedAt: ISO, entity: effect.entity, ...(effect.move ? { move: effect.move } : {}),
        }));
        await store.applyChanges(changes);
        return { changes, seq: changes.at(-1)?.seq ?? null };
      },
      withdrawSend: async () => ({ outcome: "unsupported" as const }),
      fetchBody: async () => null,
    },
  });
  registerSyncGate(engine, createSyncGate(account));
  confirmSyncOwner(engine, account);
  const pendingWire: SuggestWire = {
    configured: () => true,
    list: async () => ({
      items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 10 },
      pendingDecisions: [{
        subject: "dora@example.test", scope: "sender", decidedAt: ISO, sent: false, state: "pending",
      }],
    }),
    suggest: async () => { throw new Error("this scenario buys no suggestions"); },
    messageFor: (_error, fallback) => fallback,
  };
  window.location.hash = "#/screener";
  host = await mountShell([mailbox({
    id: mailboxId, lastSyncAt: ISO,
    ...(opts.pending ? {
      organizerRole: "reader", organizedBy: { kind: "cloud", name: holder, since: ISO },
      organizerAcceptsRequests: true,
    } : { organizerRole: "organizer", organizeConsentedAt: ISO }),
  })], {
    engine, suggestWire: opts.pending ? pendingWire : "none", junkWire: "none",
  });
  await tick(50);
  return {
    async arrive(letters: EngineMessage[], advice: ScreenerSuggestionEntity[] = []) {
      await act(async () => {
        arrivals = [...letters.map(messageChange), ...advice.map(adviceChange)];
        await engine.syncOnce();
      });
      await tick(0);
    },
    async depart(id: string) {
      await act(async () => {
        arrivals = [{ type: "message", op: "delete", id, seq: ++seq, updatedAt: ISO }];
        await engine.syncOnce();
      });
      await tick(0);
    },
  };
}

const list = () => within(host).getByRole("listbox", { name: "Screener" });
const pendingGroup = () => within(list()).queryByRole("group", { name: /^Waiting for / });
const rowIds = () => {
  const pending = pendingGroup();
  return within(list()).queryAllByRole("option").filter((row) => !pending?.contains(row)).map((row) => row.dataset.id!);
};
const pendingIds = () => {
  const pending = pendingGroup();
  return pending ? within(pending).queryAllByRole("option").map((row) => row.dataset.id!) : [];
};
const selId = () => within(host).queryByRole("option", { selected: true })?.dataset.id ?? null;
const row = (id: string) => host.querySelector<HTMLElement>(`[role="option"][data-id="${id}"]`);
const leaving = (id: string) => row(id)?.closest("[data-leaving]") != null;
const decided = () => sent.filter((m) => m.kind === "screener_decide").map((m) => m.senderId);
const click = async (control: HTMLElement) => {
  await act(async () => { fireEvent.click(control); });
  await tick(0);
};
const press = async (key: string) => {
  await act(async () => { fireEvent.keyDown(document.activeElement ?? document.body, { key }); });
  await tick(0);
};
const commit = () => tick(COMMIT_MS + 1);
const askNow = () => within(document.body).queryByRole("dialog", { name: /Mark \d+ as spam/ });

describe("quick-adjust — the decision on the row", () => {
  it("presses through the decide funnel: pending first, the wire only when the undo window closes", async () => {
    const letter = msg("m1", "news", 9);
    await mount([letter], { advice: [suggestion(letter, "ohmail/News")] });
    const accept = within(row("m1")!.parentElement!).getByRole("button", { name: "News" });
    await click(accept);
    expect(leaving("m1")).toBe(true);
    expect(within(host).getByRole("button", { name: "Undo" })).toBeTruthy();
    expect(decided()).toEqual([]);
    await tick(COMMIT_MS - 1);
    expect(decided()).toEqual([]);
    await tick(2);
    const decides = sent.filter((m) => m.kind === "screener_decide");
    expect(decides).toHaveLength(1);
    expect(decides[0]).toMatchObject({ senderId: "m1", decision: "yes", dest: "reads", scope: "sender", read: false });
    expect(sent.filter((m) => m.kind === "mark_seen")).toEqual([]);
  });
});

describe("the selection is the person's, not the arrival's", () => {
  it("filing the selected row from its own menu advances the same way", async () => {
    const { arrive } = await mount([msg("a1", "anna", 10), msg("b1", "bert", 9)]);
    await selectScreenerRow(host, "a1");
    await arrive([msg("x1", "xena", 11)]);
    await click(within(row("a1")!.parentElement!).getByRole("button", { name: "Choose a place" }));
    await click(within(document.body).getByRole("menuitem", { name: "Spam" }));
    expect(selId()).toBe("b1");
    expect(decided()).toEqual([]);
    await commit();
    expect(decided()).toEqual(["a1"]);
  });

  it("pending: deciding the bottom queue row moves to the row above, never onto a decided sender", async () => {
    await mount([msg("q1", "quinn", 11), msg("d1", "dora", 10), msg("r1", "rita", 9)], { pending: true });
    expect(pendingIds()).toEqual(["d1"]);
    await selectScreenerRow(host, "r1");
    await press("x");
    expect(selId()).toBe("q1");
    await press("o");
    await commit();
    expect(decided().sort()).toEqual(["q1", "r1"]);
  });

  it("pending: deciding the last queue row selects nobody, so the next key decides nobody", async () => {
    await mount([msg("d1", "dora", 10), msg("r1", "rita", 9)], { pending: true });
    expect(selId()).toBe("r1");
    await press("x");
    expect(selId()).toBeNull();
    await press("o");
    await commit();
    expect(decided()).toEqual(["r1"]);
    expect(pendingIds().sort()).toEqual(["d1", "r1"]);
    expect(selId()).toBeNull();
    await press("j");
    expect(selId()).toBe("d1");
  });

  it("under a chip, a suggestion landing on the selected sender keeps them selected and shown; c files them", async () => {
    const anna = msg("a1", "anna", 11);
    const cleo = msg("c1", "cleo", 8);
    const { arrive } = await mount([anna, msg("b1", "bert", 10), cleo], {
      advice: [suggestion(anna, "ohmail/News")],
    });
    const tools = within(within(host).getByRole("group", { name: "Act on all waiting senders" }));
    await click(tools.getByRole("button", { name: /^All/ }));
    await click(within(document.body).getByRole("menuitemradio", { name: /No suggestion/ }));
    expect(rowIds()).toEqual(["b1", "c1"]);
    await selectScreenerRow(host, "c1");
    await arrive([], [suggestion(cleo, "ohmail/Receipts")]);
    expect(rowIds()).toEqual(["b1", "c1"]);
    expect(selId()).toBe("c1");
    await arrive([msg("c2", "cleo", 9)]);
    expect(rowIds()).toEqual(["b1", "c2"]);
    expect(selId()).toBe("c2");
    await press("c");
    await commit();
    expect(sent.filter((m) => m.kind === "screener_decide")).toMatchObject([{ senderId: "c2", dest: "receipts" }]);
  });
});

describe("s is this sender, and Mark all spam asks first", () => {
  it("s opens the selected row's menu and moves nobody; x then files only that sender", async () => {
    await mount([msg("a1", "anna", 9), msg("b1", "bert", 10), msg("c1", "cleo", 11)]);
    const shown = selId();
    expect(shown).toBe("c1");
    await press("s");
    const card = within(document.body).getByRole("dialog", { name: "Change this sender's screening" });
    expect(card.textContent).toContain("cleo@example.test");
    expect(["a1", "b1", "c1"].filter(leaving)).toEqual([]);
    expect(decided()).toEqual([]);
    await press("x");
    expect(["a1", "b1", "c1"].filter(leaving)).toEqual([shown]);
  });

  it("the question follows the senders it named: sync lowers the number, the last closes it, and nothing reopens it", async () => {
    const { arrive, depart } = await mount([msg("a1", "anna", 9), msg("b1", "bert", 10)]);
    await click(within(host).getByRole("button", { name: "List" }));
    await click(within(document.body).getByRole("menuitem", { name: "Mark all spam" }));
    expect(askNow()?.textContent).toContain("Mark 2 as spam");
    await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
    await press("o");
    expect(askNow()?.textContent).toContain("Mark 2 as spam");
    await depart("b1");
    expect(askNow()?.textContent).toContain("Mark 1 as spam");
    await depart("a1");
    expect(askNow()).toBeNull();
    await commit();
    expect(decided()).toEqual([]);
    await arrive([msg("a2", "anna", 11), msg("c1", "cleo", 12)]);
    expect(rowIds()).toEqual(expect.arrayContaining(["a2", "c1"]));
    expect(askNow()).toBeNull();
  });
});

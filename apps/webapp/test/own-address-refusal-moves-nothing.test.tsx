/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  MemoryMirrorStore, MutationRejectedError, OhmailEngine,
  type EngineMessage, type Folder, type RuleDTO, type SyncChange,
} from "@ohmail/client-engine";
import { ISO, act, installShellEnv, mailbox, mountShell, teardownShellEnv, tick } from "./fixtures/live-walk-shell";
import { UNDO_MS } from "../app/shell/screener-state";
import en from "../messages/en.json";

/**
 * NO OWN-ADDRESS SENTENCE STANDS OVER MAIL THAT MOVED (REVIEW-026 HIGH-1). The sender sheet's press
 * that writes a rule moves only the letter it was made on (`movesAtLanding`: the rest of a rule's
 * backlog is the server pass's), so when the server refuses that rule as being about the account's
 * own address the letter stays filed and the sentence says the rule failed over mail that moved,
 * never the own-address sentence alone. A press with the rule switched off moves the mail and asks
 * the server for no rule (the control). The shell is the shipped one over a real engine; the adapter
 * echoes moves and refuses every rule write with `own_address`.
 */
const ME = "walker@example.invalid";
const FRIEND = "friend@example.invalid";
const INBOX = "INBOX" as Folder;
let seq = 0;

const messageRow: EngineMessage = {
  id: "fr", accountId: "acct_local_1", mailboxId: "mb_1", threadId: null, messageIdHeader: null,
  subject: "Lunch on Friday", from: { name: null, address: FRIEND }, to: [{ name: null, address: ME }], cc: [],
  date: ISO, folder: INBOX, snippet: "Lunch?", unread: false, hasAttachments: false, attachmentCount: 0,
  sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
  triage: null, labels: [], remoteContent: "none", updatedAt: ISO,
} as unknown as EngineMessage;
const ruleRow = {
  id: "rule_friend", kind: "sender", match: FRIEND, destination: "INBOX", priority: 0, provenance: "manual",
  enabled: true, stats: { hits: 0, lastHitAt: null, demotions: 0 }, createdAt: ISO, updatedAt: ISO,
} as unknown as RuleDTO;

async function rig(): Promise<OhmailEngine> {
  const store = new MemoryMirrorStore();
  await store.load();
  await store.applyChanges([
    { type: "message", op: "create", id: "fr", seq: ++seq, updatedAt: ISO, entity: messageRow },
    { type: "rule", op: "create", id: ruleRow.id, seq: ++seq, updatedAt: ISO, entity: ruleRow },
  ] as unknown as SyncChange[]);
  return new OhmailEngine({
    store,
    adapter: {
      sync: async () => ({
        changes: { creates: [], updates: [], moves: [], deletes: [] },
        cursor: store.getCursor(), hasMore: false, serverTime: ISO,
      }),
      mutate: async (m: { kind: string; [k: string]: unknown }) => {
        wire.push(m.kind);
        if (m.kind.startsWith("rule_")) throw new MutationRejectedError("refused", { status: 400, code: "own_address", retryable: false });
        if (m.kind === "move") {
          return { changes: [{ type: "message", op: "update", id: String(m.messageId), seq: ++seq, updatedAt: ISO,
            entity: { ...messageRow, folder: m.folder as Folder, updatedAt: ISO } }], seq: null };
        }
        return { changes: [], seq: null };
      },
      fetchBody: async () => null,
    },
  } as never);
}

const toasts = (): string[] =>
  [...document.querySelectorAll("[class*=toast]")].map((n) => (n.textContent ?? "").trim()).filter(Boolean);

const wire: string[] = [];
const folderOf = (engine: OhmailEngine): string | undefined =>
  (engine.read().get("message", "fr") as { folder?: string } | null)?.folder;

async function press(dest: string, ruleOff = false): Promise<{ mid: string | undefined; end: string | undefined }> {
  const engine = await rig();
  const host = await mountShell([mailbox({ id: "mb_1", address: ME, organizerRole: "organizer", lastSyncAt: ISO } as never)],
    { engine });
  await tick(50);
  const av = host.querySelector<HTMLElement>('.row[data-id="fr"] .av');
  expect(av, "the friend's row is drawn").toBeTruthy();
  await act(async () => { av!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  await tick(50);
  if (ruleOff) { await act(async () => { document.querySelector<HTMLElement>("#sender-sheet .sm-rule")!.click(); }); await tick(10); }
  const option = document.querySelector<HTMLElement>(`#sender-sheet [data-dest="${dest}"]`);
  expect(option, `the sheet offers ${dest}`).toBeTruthy();
  await act(async () => { option!.click(); });
  await tick(50);
  const mid = folderOf(engine);
  await tick(UNDO_MS + 1000);
  return { mid, end: folderOf(engine) };
}

beforeEach(() => { installShellEnv(); process.env.NEXT_PUBLIC_API_BASE = ""; });
afterEach(async () => { await teardownShellEnv(); process.env.NEXT_PUBLIC_API_BASE = "/api"; });

describe("a sender-sheet press the server refuses as being about our own address", () => {
  it("moved only the letter pressed on, and never says the own-address sentence over it", async () => {
    wire.length = 0;
    expect(await press("reads")).toEqual({ mid: "ohmail/News", end: "ohmail/News" });
    expect(wire.filter((k) => k === "move")).toEqual(["move"]);
    expect(wire.some((k) => k.startsWith("rule_"))).toBe(true);
    expect(toasts().some((t) => t.includes(en.screening.toastOwnAddress))).toBe(false);
    expect(toasts().some((t) => t.includes("but the rule couldn't be made")), toasts().join(" | ")).toBe(true);
  });

  it("CONTROL: with the rule switched off the press moves the mail and asks for no rule", async () => {
    wire.length = 0;
    expect((await press("reads", true)).end).toBe("ohmail/News");
    expect(wire.some((k) => k.startsWith("rule_"))).toBe(false);
    expect(toasts().some((t) => t.includes(en.screening.toastOwnAddress))).toBe(false);
  });
});

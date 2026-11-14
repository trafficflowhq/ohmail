import { describe, expect, it } from "vitest";
import {
  MutationRejectedError,
  OhmailEngine,
  type EngineAdapter,
  type EngineMessage,
  type MutationOutcome,
  type SyncResponse,
} from "@ohmail/client-engine";
import en from "../messages/en.json";
import {
  dispatchScreeningChange,
  planScreeningChange,
  senderScreening,
} from "@ohmail/app-logic/press/sender-screening";

/**
 * A MOVE PRESS SAYS WHAT HAPPENED, AFTER THE ANSWER.
 *
 * Measured on 0.25.1: a reader of a mailbox nothing organizes pressed Move → News on a sender
 * waiting at the gate; the decide came back 409 and the app said "News — 9 messages from X moved.
 * Future mail from them files there too." The decide was never awaited. Driven here over the real
 * engine with the Move press's own plan (sender scope, no backlog) and a server that refuses it.
 */

const ADDR = "news@shop.example";
const NOW = new Date("2026-09-25T13:10:00.000Z");

function held(id: string): EngineMessage {
  return {
    id, accountId: "acct", mailboxId: "mb", threadId: null, messageIdHeader: null,
    subject: `Issue ${id}`, from: { name: "Shop News", address: ADDR }, to: [], cc: [],
    date: "2026-09-24T09:00:00.000Z", folder: "ohmail/Screener", snippet: "", unread: true,
    hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: "2026-09-24T09:00:00.000Z",
  } as EngineMessage;
}

type Answer = "refuse" | "apply" | "organizer";

async function pressMoveToNews(answer: Answer) {
  let served = false;
  const adapter: EngineAdapter = {
    async sync(): Promise<SyncResponse> {
      const creates = served ? [] : ["h1", "h2"].map((id, i) => ({
        type: "message" as const, op: "create" as const, id, seq: i + 1, updatedAt: NOW.toISOString(), entity: held(id),
      }));
      served = true;
      return { changes: { creates, updates: [], moves: [], deletes: [] }, cursor: "9", hasMore: false, serverTime: NOW.toISOString() };
    },
    async mutate(m): Promise<MutationOutcome> {
      if (m.kind !== "screener_decide") return { changes: [], seq: null };
      if (answer === "refuse") {
        throw new MutationRejectedError("nothing organizes this mailbox", { status: 409, code: "organized_elsewhere", retryable: false });
      }
      if (answer === "organizer") {
        return { changes: [], seq: null, settlement: "queued", queuedWith: { kind: "local", name: "Studio laptop" }, requestId: null } as unknown as MutationOutcome;
      }
      return { changes: [], seq: null };
    },
    async withdrawSend() { return { outcome: "unsupported" as const }; },
    async fetchBody() { return null; },
  };
  const engine = new OhmailEngine({ adapter, now: () => NOW });
  await engine.start();
  const sender = senderScreening(engine.verbRead(), "h1")!;
  // `planMoveToPlace`'s own arguments: sender scope, a rule, no backlog.
  const plan = planScreeningChange(sender, "reads", "sender", true, false);
  expect(plan.mutations.some((m) => m.kind === "screener_decide"), "the press is not a decide").toBe(true);
  return dispatchScreeningChange(plan, [], (m) => engine.mutate(m));
}

describe("the Move press over a sender waiting at the gate", () => {
  it("a refused decide is said as a refusal — never 'moved… files there too'", async () => {
    const key = await pressMoveToNews("refuse");
    expect(key).toBe("toastDecideRefused");
    const said = en.screening.toastDecideRefused;
    expect(said).toMatch(/nothing moved/);
    expect(said).not.toMatch(/messages? from .* moved|files there too/);
  });

  it("the positive control: a decide that applies says it moved", async () => {
    expect(await pressMoveToNews("apply")).toBe("toastRuled");
  });

  it("a decide recorded for the organizer says it is queued for it", async () => {
    expect(await pressMoveToNews("organizer")).toBe("toastRuleOrganizer");
  });
});

import { describe, expect, it } from "vitest";
import { HttpAdapter } from "@ohmail/client-engine";
import type { MutationOutcome } from "@ohmail/client-engine";
import type { ScreenDecisionResult } from "@trafficflow/services";

/**
 * A DECISION WHOSE MOVE WAITS ON THIS INSTALL'S CLAIM. The door answers 200 with the
 * rule written and `mailboxes.awaiting` naming the mailbox whose takeover has not landed. Nothing
 * moved, so the adapter says so the way it says a queued half does (`pendingWith`), and the
 * Screener keeps the sender out of its queue until the move. The double answers the service's own
 * type, so a change on that side breaks this fixture rather than passing it.
 */

const decision = { kind: "screener_decide", senderId: "m1", decision: "yes", dest: "ohbox", scope: "sender" } as const;

function adapterAnswering(body: ScreenDecisionResult) {
  return new HttpAdapter({
    baseUrl: "http://x",
    fetch: async () => new Response(JSON.stringify(body), {
      status: 200, headers: { "content-type": "application/json", "x-sync-seq": "7" },
    }),
  });
}

describe("screener_decide over a takeover that has not landed", () => {
  it("names the wait, so the press does not undo itself on the confirm", async () => {
    const answer = await adapterAnswering({
      messageId: "m1", appliedFolder: "INBOX", createdRuleId: "r1",
      mailboxes: { filed: [], requested: [], awaiting: ["mb1"] },
    }).mutate(decision, { idempotencyKey: "k1" }) as MutationOutcome;
    expect(answer.pendingWith).toEqual({ name: null });
  });

  it("CONTROL: a decision filed here is an ordinary confirm", async () => {
    const answer = await adapterAnswering({
      messageId: "m1", appliedFolder: "INBOX", createdRuleId: "r1",
      mailboxes: { filed: ["mb1"], requested: [] },
    }).mutate(decision, { idempotencyKey: "k2" }) as MutationOutcome;
    expect(answer.pendingWith).toBeUndefined();
  });
});

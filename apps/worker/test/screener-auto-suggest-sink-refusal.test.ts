import { describe, it, expect } from "vitest";
import { screenerAttemptKey } from "@trafficflow/db";
import {
  SensitivePayloadRefusal, type ClassifierInput, type ClassifierPort, type ClassifierResult,
} from "@trafficflow/core";
import { fakeSpendPort } from "../../../packages/organizer/test/_spendport.js";
import { makeClassifierCircuit } from "../src/ai-circuit.js";
import { DECLINE_COOLDOWN_MS, makeDeclineMemory, screenerAutoSuggestPass } from "@ohmail/organizer/screener-auto-suggest";
import { NOW, attemptFor, gateInto, held, obligationsInto, recording, world } from "./_auto-suggest-world.js";

/**
 * A REFUSAL AT THE SINK IS ONE SENDER'S ANSWER. The automatic pass read the outbound screen's
 * refusal as a model fault: it stopped at that sender every cycle, kept the charge, and nobody
 * behind the sender was asked. Now the sender is skipped and refunded, held out for a day unless
 * it writes again, and the batch goes on; a plain outage still stops the pass. Mutations: drop the
 * pass's `SensitivePayloadRefusal` arm (the batch stops), or its `declines.remember`.
 */

const NEWSLETTER: ClassifierResult = { destination: "ohmail/News", confidence: 0.8, rationale: "a newsletter", spam: false };

/**
 * A port whose own sink refuses the named senders. Every sink in this repository honours the
 * `prescreened` the pass declares, so the class reaches the pass from a port that screens for
 * itself — the real class, with a screen that carries no content. `fails` names plain outages.
 */
function sinkRefusing(refuse: ReadonlySet<string>, fails: ReadonlySet<string> = new Set()): ClassifierPort & { asked: string[] } {
  const asked: string[] = [];
  const answer = async (input: ClassifierInput): Promise<ClassifierResult> => {
    asked.push(input.from.address);
    if (refuse.has(input.from.address)) {
      throw new SensitivePayloadRefusal({ safe: false, category: null, reason: "credential_shape" });
    }
    if (fails.has(input.from.address)) throw new Error("anthropic 529 overloaded");
    return NEWSLETTER;
  };
  return { asked, classify: answer, screen: answer };
}

describe("a refusal at the sink is one sender's answer", () => {
  it("the refused sender is skipped and refunded, and the senders behind it are bought", async () => {
    const w = await world();
    const refused = await held(w, "a@example.test", 1);
    await held(w, "b@example.test", 2);
    await held(w, "c@example.test", 3);
    const inner = sinkRefusing(new Set(["a@example.test"]));
    const circuit = makeClassifierCircuit(inner, { faultThreshold: 2 });
    const events: string[] = [];
    const gate = gateInto(events);
    const obligations = obligationsInto(events);
    const log = recording();

    const r = await screenerAutoSuggestPass(w.db, {
      accountId: w.accountId, classifier: circuit.port(), credits: gate, obligations, log: log.logger,
      declines: makeDeclineMemory(), now: () => NOW,
    });

    expect(r.stopped, "a refusal at the sink stopped the batch").toBeUndefined();
    expect(r).toMatchObject({ bought: 2, chargedAttempts: 2 });
    expect(inner.asked).toEqual(["a@example.test", "b@example.test", "c@example.test"]);
    expect(gate.releases.filter((x) => x.refund)).toEqual([
      expect.objectContaining({ attemptKey: screenerAttemptKey(refused), attempt: attemptFor(gate, refused) }),
    ]);
    expect(obligations.owed).toEqual([expect.objectContaining({ attempt: attemptFor(gate, refused), reason: "drafter_failed" })]);
    expect(obligations.settled).toEqual([attemptFor(gate, refused)]);
    const named = log.named("screener_auto_suggest_refused_at_sink");
    expect(named).toHaveLength(1);
    expect(named[0]).toMatchObject({ accountId: w.accountId, messageId: refused, refusal: "credential_shape", cooldownMs: DECLINE_COOLDOWN_MS });
    expect(named[0]!.droppedFields).toBeUndefined();
    expect(circuit.state(), "the refusal was counted as a model fault").toMatchObject({ open: false, consecutiveFaults: 0 });
  });

  it("the refused sender is held out for a day, then asked once more", async () => {
    const w = await world();
    await held(w, "a@example.test", 1);
    await held(w, "b@example.test", 2);
    const inner = sinkRefusing(new Set(["a@example.test"]));
    const declines = makeDeclineMemory();
    const gate = fakeSpendPort();
    gate.exclusive();
    const pass = (at: Date) => screenerAutoSuggestPass(w.db, {
      accountId: w.accountId, classifier: makeClassifierCircuit(inner).port(), credits: gate,
      obligations: obligationsInto([]), declines, now: () => at,
    });

    expect((await pass(NOW)).bought).toBe(1);
    await pass(NOW);
    expect(inner.asked, "the refused sender was asked again inside its day").toEqual(["a@example.test", "b@example.test"]);
    await pass(new Date(NOW.getTime() + DECLINE_COOLDOWN_MS + 1));
    expect(inner.asked.slice(2)).toEqual(["a@example.test"]);
  });

  it("a plain model fault refunds its debit and still stops the pass", async () => {
    const w = await world();
    await held(w, "a@example.test", 1);
    await held(w, "b@example.test", 2);
    const inner = sinkRefusing(new Set(), new Set(["a@example.test"]));
    const gate = fakeSpendPort();
    gate.exclusive();

    const r = await screenerAutoSuggestPass(w.db, {
      accountId: w.accountId, classifier: makeClassifierCircuit(inner, { faultThreshold: 5 }).port(), credits: gate,
      obligations: obligationsInto([]), declines: makeDeclineMemory(), now: () => NOW,
    });

    expect(r.stopped).toBe("model_unavailable");
    expect(inner.asked, "the sender behind the outage was asked").toEqual(["a@example.test"]);
    expect(gate.releases.map((x) => x.refund)).toEqual([true]);
    expect(r.chargedAttempts).toBe(0);
  });
});

/** @vitest-environment jsdom */
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useScreenerSuggestions, type SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";

afterEach(cleanup);

function names(...labels: string[]) {
  return labels.map((name) => [name, "example.invalid"].join("@"));
}

it("quotes senders beyond the local page and keeps the approved set when new mail arrives", async () => {
  const [shown, older, arrived] = names("shown", "older", "arrived");
  const requested: string[][] = [];
  const wire: SuggestWire = {
    configured: () => true,
    list: vi.fn(async (opts: { cursor?: string }) => ({
      items: [],
      nextCursor: opts.cursor ? null : "older-page",
      suggestable: { senders: opts.cursor ? [older!] : [shown!], maxPerRequest: 50 },
    })),
    suggest: async (senders, opts) => {
      const pairs = senders.map((sender) => ({ sender, messageId: sender }));
      if (!opts?.dryRun) requested.push(senders);
      return {
        dryRun: !!opts?.dryRun, requested: senders.length, quoted: senders.length,
        quotedCredits: senders.length, charged: opts?.dryRun ? 0 : senders.length,
        quoteGrant: { proof: "fixture", pairs },
        suggestions: opts?.dryRun ? [] : pairs.map((pair) => ({
          ...pair, decision: "yes" as const, confidence: 0.8, rationale: "a person",
        })),
        skipped: [],
      };
    },
    messageFor: (_error, fallback) => fallback,
  };
  const text = { screener: (key: string) => key, aiRefusal: (key: string) => key };
  const toast = vi.fn();
  const hook = renderHook(({ addresses }) =>
    useScreenerSuggestions({ active: false, wire, text, toast })
      .forSenders(addresses, [], 2, true, { readQueue: true }),
    { initialProps: { addresses: [shown!] } },
  );
  act(() => hook.result.current.open());
  await waitFor(() => expect(hook.result.current.quote?.senders).toBe(2));
  expect(hook.result.current.pool).toBe(2);

  hook.rerender({ addresses: [arrived!, shown!] });
  expect(hook.result.current.size).toBe(2);
  act(() => hook.result.current.confirm());
  await waitFor(() => expect(hook.result.current.phase).toBe("closed"));
  expect(requested).toEqual([[shown, older]]);
});

it("finishes the approved senders in a chunk when one representative changes", async () => {
  const [changed, other] = names("changed", "other") as [string, string];
  const requests: string[][] = [];
  let changedSinceQuote = false;
  const wire: SuggestWire = {
    configured: () => true,
    list: async () => ({ items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 } }),
    suggest: async (senders, opts) => {
      const pairs = senders.map((sender) => ({
        sender, messageId: sender === changed && changedSinceQuote ? "arrival" : sender,
      }));
      if (!opts?.dryRun) {
        requests.push(senders);
        if (senders.includes(changed)) {
          changedSinceQuote = true;
          throw Object.assign(new Error("changed"), { code: "suggest_quote_changed" });
        }
      }
      return {
        dryRun: !!opts?.dryRun, requested: senders.length, quoted: senders.length,
        quotedCredits: senders.length, charged: opts?.dryRun ? 0 : senders.length,
        quoteGrant: { proof: "fixture", pairs },
        suggestions: opts?.dryRun ? [] : pairs.map((pair) => ({
          ...pair, decision: "yes" as const, confidence: 0.8, rationale: "a person",
        })),
        skipped: [],
      };
    },
    messageFor: (_error, fallback) => fallback,
  };
  const text = { screener: (key: string) => key, aiRefusal: (key: string) => key };
  const hook = renderHook(() => useScreenerSuggestions({ active: false, wire, text, toast: vi.fn() })
    .forSenders([changed, other]));
  act(() => hook.result.current.open());
  await waitFor(() => expect(hook.result.current.quote?.senders).toBe(2));
  act(() => hook.result.current.confirm());
  await waitFor(() => expect(hook.result.current.phase).not.toBe("running"));
  expect(requests).toEqual([[changed, other], [other]]);
});

it("continues with later chunks when the worker already owns a deferred sender", async () => {
  const addresses = names(...Array.from({ length: 17 }, (_, i) => "sender-" + i));
  const requests: string[][] = [];
  const wire: SuggestWire = {
    configured: () => true,
    list: async () => ({ items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 } }),
    suggest: async (senders, opts) => {
      const pairs = senders.map((sender) => ({ sender, messageId: sender }));
      if (!opts?.dryRun) requests.push(senders);
      const deferred = !opts?.dryRun && requests.length === 1;
      const answered = deferred ? pairs.slice(1) : pairs;
      return {
        dryRun: !!opts?.dryRun, requested: senders.length, quoted: senders.length,
        quotedCredits: senders.length, charged: opts?.dryRun ? 0 : answered.length,
        quoteGrant: { proof: "fixture", pairs },
        suggestions: opts?.dryRun ? [] : answered.map((pair) => ({
          ...pair, decision: "yes" as const, confidence: 0.8, rationale: "a person",
        })),
        ...(deferred ? { deferred: true as const, stopped: "spend_unavailable" as const } : {}),
        skipped: deferred ? [{ sender: senders[0]!, reason: "spend_unavailable" as const }] : [],
      };
    },
    messageFor: (_error, fallback) => fallback,
  };
  const text = { screener: (key: string) => key, aiRefusal: (key: string) => key };
  const hook = renderHook(() => useScreenerSuggestions({ active: false, wire, text, toast: vi.fn() })
    .forSenders(addresses));
  act(() => hook.result.current.open());
  await waitFor(() => expect(hook.result.current.quote?.senders).toBe(addresses.length));
  act(() => hook.result.current.confirm());
  await waitFor(() => expect(hook.result.current.phase).toBe("closed"));
  expect(requests.flat()).toEqual(addresses);
});

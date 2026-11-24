/** @vitest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useScreenerSuggestions, type SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";

it("retries a busy database with the original purchase key while the Screener is open", async () => {
  vi.useFakeTimers();
  const sender = ["waiting", "example.test"].join("@");
  const requests: Array<Parameters<SuggestWire["suggest"]>> = [];
  const suggestion = { sender, messageId: "held", decision: "yes" as const, confidence: 0.9, rationale: "Known contact" };
  const wire: SuggestWire = {
    configured: () => true,
    list: async () => ({ items: [], nextCursor: null, suggestable: { senders: [], maxPerRequest: 50 } }),
    messageFor: (_error, fallback) => fallback,
    suggest: async (...request) => {
      requests.push(request);
      if (requests.length === 1) throw Object.assign(new Error("Busy"), { status: 503, code: "db_busy", retryAfterMs: 500 });
      return { dryRun: false, requested: 1, quoted: 1, suggestions: [suggestion], skipped: [], charged: 1 };
    },
  };
  const text = (key: string) => key;
  const { result, unmount } = renderHook(() => {
    const model = useScreenerSuggestions({
      active: true, autoSuggest: true, wire, toast: () => {}, text: { screener: text, aiRefusal: text },
    });
    model.forSenders([sender], [], 0, true);
    return model;
  });
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(requests).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(499); });
    expect(requests).toHaveLength(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.[0]).toEqual(requests[0]?.[0]);
    expect(requests[0]?.[1]?.idempotencyKey).toEqual(expect.any(String));
    expect(requests[1]?.[1]).toMatchObject({ automatic: true, idempotencyKey: requests[0]?.[1]?.idempotencyKey });
    expect(result.current.suggestions.size).toBe(1);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});

/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextProvider, useText } from "@ohmail/app/text";
import { useScreenerWords } from "../../../packages/app/src/screener/words.js";
import type { Translator } from "@ohmail/app-logic/text/translator";
import de from "../messages/de.json";
import en from "../messages/en.json";
import { ApiError } from "../app/api-client";
import { aiRefusalKey, clearedByAccess } from "@ohmail/app-logic/text/ai-refusal-copy";
import type { SuggestBatchControl, SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";

/**
 * AN ENGLISH SENTENCE ON A GERMAN SCREEN, ABOUT A STATE THE ACCOUNT WAS NOT IN
 *
 * The Screener card read "no AI credits remain on this account" — in English, on a German UI —
 * and was still reading it the next morning, on an account that had been spending in between.
 * Two defects in one sentence: the words were the server's, written for a log, and the line had
 * no way to come down short of a press. The fact a refusal carries is its `code`; the sentence
 * for it belongs to the catalogue, and a line claiming something about an account is re-asked
 * against that account.
 */

// See `sync-liveness-shell.test.ts` for why React is published as a global.
(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";

const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SENDER = "stranger@example.com";
const flush = async (): Promise<void> => { await act(async () => { await Promise.resolve(); }); };

let host: HTMLDivElement | null = null;
let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove();
  root = null; host = null;
});

const EMPTY_PAGE = {
  items: [], nextCursor: null,
  suggestable: { senders: [SENDER], credits: 1, maxPerRequest: 50 },
};

/**
 * A TRANSPORT THAT FAILS THE WAY THE BROWSER'S DOES: a refusal is an `ApiError` carrying the
 * envelope's status, code and message — the class `api-client` throws — so `messageFor` and the
 * code lookup are driven on the shape production hands them.
 */
function wireRefusing(
  err: () => unknown,
  available: () => Promise<boolean | null>,
): SuggestWire & { asks: number } {
  const w = {
    asks: 0,
    configured: () => true,
    list: async () => EMPTY_PAGE as never,
    suggest: async () => { throw err(); },
    messageFor: (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback),
    aiAvailable: async () => { w.asks++; return available(); },
  };
  return w;
}

async function mount(wire: SuggestWire, locale: "en" | "de"): Promise<() => SuggestBatchControl> {
  const { useScreenerSuggestions } = await import("@ohmail/app-logic/screener/screener-suggest");
  let control: SuggestBatchControl | null = null;
  function Probe(): null {
    const { screener } = useScreenerWords();
    const aiRefusal = useText("aiRefusal") as unknown as Translator;
    const s = useScreenerSuggestions({ text: { screener, aiRefusal }, active: true, toast: (() => {}) as never, wire });
    control = s.forSenders([SENDER]);
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(TextProvider, {
      locale, messages: locale === "de" ? de : en, timeZone: "UTC", children: h(Probe),
    }));
  });
  await flush();
  return () => control!;
}

/** Price, then buy — the two presses that reach the wire. */
async function press(control: () => SuggestBatchControl): Promise<void> {
  await act(async () => { control().open(); });
  await flush();
  await act(async () => { control().confirm(); });
  await flush();
  await flush();
}

describe("the code decides the sentence, the catalogue writes it", () => {
  it("maps each AI refusal to its own sentence, and nothing else", () => {
    expect(aiRefusalKey(new ApiError(402, "insufficient_credits", "x"))).toBe("insufficientCredits");
    expect(aiRefusalKey(new ApiError(409, "ai_disabled", "x"))).toBe("aiDisabled");
    expect(aiRefusalKey(new ApiError(503, "ai_unavailable", "x"))).toBe("aiUnavailable");
    // No model connected is its OWN fact, not the empty balance's or the outage's (R23-06: the
    // raw "this deployment has no AI classifier connected" was painted under Suggest).
    expect(aiRefusalKey(new ApiError(503, "suggest_unconfigured", "x"))).toBe("noModel");
    expect(aiRefusalKey(new ApiError(400, "validation_failed", "x"))).toBeNull();
    expect(aiRefusalKey(new Error("boom"))).toBeNull();
    expect(aiRefusalKey(null)).toBeNull();
  });

  it("only a refusal an access read SPEAKS TO arms the clear", () => {
    // An empty balance is not something `aiEnabled` describes. Clearing that line on an access
    // read would erase a sentence that is still true.
    expect(clearedByAccess(new ApiError(503, "ai_unavailable", "x"))).toBe(true);
    expect(clearedByAccess(new ApiError(409, "ai_disabled", "x"))).toBe(true);
    expect(clearedByAccess(new ApiError(402, "insufficient_credits", "x"))).toBe(false);
  });

  it("A GERMAN READER GETS THE GERMAN SENTENCE for a 402, never the server's English", async () => {
    const wire = wireRefusing(
      () => new ApiError(402, "insufficient_credits", "no AI credits remain on this account"),
      async () => null,
    );
    const control = await mount(wire, "de");
    await press(control);
    expect(control().notice).toBe(de.aiRefusal.insufficientCredits);
    expect(control().notice).not.toContain("no AI credits remain");
  });

  it("…and an English reader gets the English one — the same code, one catalogue each", async () => {
    const wire = wireRefusing(
      () => new ApiError(409, "ai_disabled", "managed AI is switched off for this account"),
      async () => null,
    );
    const control = await mount(wire, "en");
    await press(control);
    expect(control().notice).toBe(en.aiRefusal.aiDisabled);
  });
});

describe("no sticky false state — the line comes down when the account says AI is available", () => {
  it("THE REPORTED CASE: a refusal, then an access read saying AI is on, and the line is gone", async () => {
    const wire = wireRefusing(
      () => new ApiError(503, "ai_unavailable", "AI suggestions are temporarily unavailable; please retry"),
      async () => true,
    );
    const control = await mount(wire, "de");
    await press(control);
    await flush();
    expect(wire.asks, "the standing refusal asked nobody").toBeGreaterThan(0);
    expect(control().notice).toBeNull();
  });

  it("an access read that says AI is OFF leaves the line standing", async () => {
    // The positive control: the clear is evidence-driven, not a timer. A line the account
    // confirms must stay on screen.
    const wire = wireRefusing(
      () => new ApiError(503, "ai_unavailable", "temporarily unavailable"),
      async () => false,
    );
    const control = await mount(wire, "de");
    await press(control);
    await flush();
    expect(control().notice).toBe(de.aiRefusal.aiUnavailable);
  });

  it("an access read that CANNOT TELL leaves it standing too — unknown is not evidence", async () => {
    const wire = wireRefusing(
      () => new ApiError(503, "ai_unavailable", "temporarily unavailable"),
      async () => null,
    );
    const control = await mount(wire, "de");
    await press(control);
    await flush();
    expect(control().notice).toBe(de.aiRefusal.aiUnavailable);
  });

  it("AN EMPTY BALANCE IS NEVER CLEARED THIS WAY, and asks nothing at all", async () => {
    // No access read describes a balance. This line comes down on the next press, which is
    // evidence about the thing it claims.
    const wire = wireRefusing(
      () => new ApiError(402, "insufficient_credits", "no AI credits remain on this account"),
      async () => true,
    );
    const control = await mount(wire, "de");
    await press(control);
    await flush();
    expect(wire.asks, "an empty balance asked the access half about itself").toBe(0);
    expect(control().notice).toBe(de.aiRefusal.insufficientCredits);
  });

  it("a transport that cannot ask at all still works — the clear is optional, not required", async () => {
    const wire = wireRefusing(
      () => new ApiError(503, "ai_unavailable", "temporarily unavailable"),
      async () => true,
    ) as SuggestWire & { asks: number };
    delete (wire as { aiAvailable?: unknown }).aiAvailable;
    const control = await mount(wire, "en");
    await press(control);
    await flush();
    expect(control().notice).toBe(en.aiRefusal.aiUnavailable);
  });
});

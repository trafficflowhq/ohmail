/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { TextProvider, useText } from "@ohmail/app/text";
import en from "../messages/en.json";
import type { ScreenerSuggestions, SenderSuggestion, SuggestWire } from "@ohmail/app-logic/screener/screener-suggest";

/**
 * AN OVERLAY ENTRY NAMES THE MIRROR SUGGESTION IT LANDED OVER (SUGGESTION-GAIN-READ-COVERS-QUEUE-
 * GAINS-ONLY). Every answer the session holds is stamped as it lands with the mirror's newest
 * suggestion for that sender, so `joinSuggestion` can hand the row to a newer purchase the mirror
 * receives later — a re-ask on another device, the worker — without a re-read or a clock.
 */

(globalThis as unknown as { React: unknown }).React = React;
process.env.NEXT_PUBLIC_API_BASE = "/api";
const h = React.createElement;
const act = (React as unknown as { act: (cb: () => Promise<void> | void) => Promise<void> }).act;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLDivElement | null = null;
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  host?.remove(); root = null; host = null;
});

const wire: SuggestWire = {
  configured: () => true,
  list: async () => ({ items: [], nextCursor: null } as never),
  suggest: async () => { throw new Error("no purchase in this case"); },
  messageFor: (_e: unknown, fallback: string) => fallback,
  aiAvailable: async () => true,
} as unknown as SuggestWire;

async function mount(mirror?: (address: string) => string | null): Promise<() => ScreenerSuggestions> {
  const { useScreenerSuggestions } = await import("@ohmail/app-logic/screener/screener-suggest");
  let s: ScreenerSuggestions | null = null;
  function Probe(): null {
    s = useScreenerSuggestions({ text: { screener: useText("screener"), aiRefusal: useText("aiRefusal") }, active: false, toast: (() => {}) as never, wire, ...(mirror ? { mirrorSuggestionOf: mirror } : {}) });
    return null;
  }
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root!.render(h(TextProvider, { locale: "en", messages: en, timeZone: "UTC", children: h(Probe) }));
  });
  return () => s!;
}

const answer: SenderSuggestion = { dest: "reads", confidence: 0.9, rationale: "" };

describe("an answer lands over the mirror's newest suggestion, by name", () => {
  it("stamps each entry with the mirror suggestion it landed over, or null for none", async () => {
    const s = await mount((a) => (a.trim().toLowerCase() === "one@x.test" ? "sg-9" : null));
    await act(async () => { s().absorb([{ address: "One@X.test", suggestion: answer }, { address: "two@x.test", suggestion: answer }]); });
    expect(s().suggestions.get("one@x.test")?.over).toBe("sg-9");
    expect(s().suggestions.get("two@x.test")?.over).toBeNull();
  });

  it("with no mirror to ask, an entry names nothing and keeps winning as before (the control)", async () => {
    const s = await mount();
    await act(async () => { s().absorb([{ address: "one@x.test", suggestion: answer }]); });
    expect(s().suggestions.get("one@x.test")).toEqual(answer);
  });
});

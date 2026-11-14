/** @vitest-environment jsdom */
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useConsentState } from "@ohmail/app-logic/consent/consent-state";
import { useScreenerSuggestions } from "@ohmail/app-logic/screener/screener-suggest";
import { SUGGESTION_GRANT_HEADER, WITHDRAW_SUGGESTION_GRANT_PATH } from "@trafficflow/core/suggestion-consent";
import { bridgeFetch } from "../src/bridge-fetch.js";
import { cloudSuggestWire } from "../src/cloud-suggest.js";
import { consentOverBridge } from "../src/local-consent.js";

vi.mock("../src/bridge-fetch.js", () => ({ bridgeAvailable: () => true, bridgeFetch: vi.fn() }));
const bridge = vi.mocked(bridgeFetch);
const sender = ["sender", "example.invalid"].join("@");
const words = (key: string) => key;
const answer = (value: unknown, status: number, grant?: string) => new Response(JSON.stringify(value), {
  status, headers: grant ? { [SUGGESTION_GRANT_HEADER]: grant } : {},
});

afterEach(() => {
  cleanup();
  bridge.mockReset();
});

it("carries the consent answer's grant and withdraws it before a failed reread", async () => {
  let failed = false;
  const grant = "fixture-grant";
  const sent: Array<[string, boolean]> = [];
  bridge.mockImplementation(async (path, options) => {
    const init = options as RequestInit | undefined;
    if (path === "/consent") {
      if (!failed) return answer({ dormancyDays: 90, autoSuggestAt: null }, 200, grant);
      sent.push([path, new Headers(init?.headers).has(SUGGESTION_GRANT_HEADER)]);
      return answer({}, 503);
    }
    const carriesGrant = new Headers(init?.headers).get(SUGGESTION_GRANT_HEADER) === grant;
    sent.push([path, carriesGrant]);
    if (path === "/screener/suggest") return answer({ quoted: 1, quotedCredits: 0 }, 200);
    return new Response(null, { status: 204 });
  });
  const { result } = renderHook(() => {
    const consent = useConsentState(true, "hosted-grant-fixture", consentOverBridge);
    const run = useScreenerSuggestions({
      active: false, toast: () => undefined, text: { screener: words, aiRefusal: words },
      wire: cloudSuggestWire,
      permission: {
        known: consent.suggestionConsentKnown, version: consent.suggestionGrant,
        grant: consent.readSuggestionGrant, relayGrant: consent.relaySuggestionGrant,
      },
    });
    return run.forSenders([sender]);
  });
  await act(async () => {});
  await act(async () => { result.current.open(); });
  expect(sent).toEqual([["/screener/suggest", true]]);

  failed = true;
  await act(async () => { window.dispatchEvent(new Event("online")); });
  expect(result.current.disabled).toBe(true);
  expect(sent).toEqual([
    ["/screener/suggest", true],
    [WITHDRAW_SUGGESTION_GRANT_PATH, true],
    ["/consent", false],
    ["/local/window/consent-read-failed", false],
  ]);
});

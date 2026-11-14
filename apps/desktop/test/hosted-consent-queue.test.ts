import { afterEach, expect, it } from "vitest";
import { createCloudAuth } from "../../../test/support/sidecar-fixtures.js";
import { createWriteThroughProxy } from "../../../test/support/sidecar-fixtures.js";
import type { CloudMirror } from "../../../test/support/sidecar-fixtures.js";
import { cloudSuggestWire } from "../src/cloud-suggest.js";
import { CONSENT_READ_FAILED_PATH, consentOverBridge } from "../src/local-consent.js";
import { plantShell, type Pipe } from "./_doors-harness.js";

let pipe: Pipe | undefined;
afterEach(() => pipe?.unplant());

it.each([false, true])("orders hosted quote dispatch against a bridge refusal (failed: %s)", async (failed) => {
  let rejectNextRead = false;
  let outbound = 0;
  let releaseQuote!: () => void;
  let quoteQueued!: () => void;
  const queued = new Promise<void>((resolve) => { quoteQueued = resolve; });
  const waiting = new Promise<void>((resolve) => { releaseQuote = resolve; });
  const auth = createCloudAuth({
    baseUrl: "http://fixture.invalid",
    tokens: { accessToken: "fixture-access", refreshToken: "fixture-refresh" },
    fetchImpl: async (input) => {
      if (new URL(String(input)).pathname === "/consent") {
        return Response.json({ dormancyDays: 90, autoSuggestAt: "2026-08-13T09:00:00Z" });
      }
      outbound++;
      return Response.json({ dryRun: true, requested: 1, quoted: 1, quotedCredits: 1, charged: 0, suggestions: [], skipped: [] });
    },
  });
  const mirror = {
    online: () => true,
    awaitFreshPull: async () => true,
  } as CloudMirror;
  const proxy = createWriteThroughProxy({ auth, mirror });
  pipe = plantShell({ state: "serving", mode: "cloud" }, async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/screener/suggest") {
      quoteQueued();
      await waiting;
    }
    if (path === "/consent" && rejectNextRead) return Response.json({}, { status: 503 });
    if (path === CONSENT_READ_FAILED_PATH) return new Response(null, { status: 204 });
    return proxy.forward(request);
  }, "fixture-bearer");

  try {
    const { relaySuggestionGrant } = await consentOverBridge.state();
    expect(relaySuggestionGrant).toBeTruthy();
    const quote = cloudSuggestWire.suggest(["held@example.invalid"], { dryRun: true, relayGrant: relaySuggestionGrant ?? null })
      .then(() => true, () => false);
    await queued;
    if (failed) {
      rejectNextRead = true;
      await expect(consentOverBridge.state(relaySuggestionGrant)).rejects.toMatchObject({ status: 503 });
    }
    releaseQuote();
    expect(await quote).toBe(!failed);
    expect(outbound).toBe(failed ? 0 : 1);
  } finally {
    releaseQuote();
    auth.stop();
  }
});

import { afterEach, expect, it } from "vitest";
import { SUGGESTION_GRANT_HEADER as grantHeader } from "@trafficflow/core/suggestion-consent";
import { createCloudAuth, type CloudAuth } from "../src/cloud-auth.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import type { CloudMirror } from "../src/cloud-mirror.js";

const auths: CloudAuth[] = [];
afterEach(() => { for (const auth of auths.splice(0)) auth.stop(); });

const answer = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json" },
});
const consent = (autoSuggestAt: string | null) => ({ dormancyDays: 90, autoSuggestAt });

function relay() {
  const upstreamGrants: (string | null)[] = [];
  let consentResponse: () => Response | Promise<Response> = () => answer(consent(null));
  const auth = createCloudAuth({
    baseUrl: "http://cloud.test",
    tokens: { accessToken: "fixture-access", refreshToken: "fixture-refresh" },
    fetchImpl: async (input, init) => {
      switch (new URL(String(input)).pathname) {
        case "/consent": return consentResponse();
        case "/consent/settings": return answer({ autoSuggestAt: null });
        case "/screener/suggest":
          upstreamGrants.push(new Headers(init?.headers).get(grantHeader));
          return answer({ suggestions: [] });
      }
      return answer({}, 404);
    },
  });
  auths.push(auth);
  const mirror = {
    online: () => true, markConnectivity: () => undefined,
    awaitCloudSeq: async () => true, awaitFreshPull: async () => true,
  } as unknown as CloudMirror;
  const proxy = createWriteThroughProxy({ auth, mirror });
  return {
    upstreamGrants,
    setConsent: (reply: () => Response | Promise<Response>) => { consentResponse = reply; },
    read: () => proxy.forward(new Request("http://engine.test/consent")),
    off: (hold?: Promise<void>) => {
      const req = new Request("http://engine.test/consent/settings", {
        method: "PATCH", body: JSON.stringify({ autoSuggest: false }),
      });
      if (hold) {
        const read = req.arrayBuffer.bind(req);
        req.arrayBuffer = async () => { await hold; return read(); };
      }
      return proxy.forward(req);
    },
    send: (grant: string | null, quote: boolean, hold?: Promise<void>) => {
      const req = new Request("http://engine.test/screener/suggest", {
        method: "POST", headers: grant ? { [grantHeader]: grant } : {},
        body: JSON.stringify({ dryRun: quote }),
      });
      if (hold) {
        const read = req.arrayBuffer.bind(req);
        req.arrayBuffer = async () => { await hold; return read(); };
      }
      return proxy.forward(req);
    },
  };
}

it.each(["failed", "missing", "malformed", "off"] as const)("blocks an originating quote after %s consent arrives while the bridge request waits", async (change) => {
  const host = relay();
  const grant = (await host.read()).headers.get(grantHeader) ?? "pre-grant-control";
  let release!: () => void;
  const waiting = new Promise<void>((done) => { release = done; });
  const quote = host.send(grant, true, waiting);

  if (change === "off") await host.off();
  else {
    const response = {
      failed: () => answer({}, 503),
      missing: () => answer({ dormancyDays: 90 }),
      malformed: () => answer(consent("")),
    };
    host.setConsent(response[change]);
    await host.read();
  }
  release();
  expect((await quote).ok).toBe(false);
  expect(host.upstreamGrants).toEqual([]);

  host.setConsent(() => answer(consent(null)));
  const current = (await host.read()).headers.get(grantHeader);
  expect(current).toBeTruthy();
  expect(current).not.toBe(grant);
  expect((await host.send(current, true)).ok).toBe(true);
  expect(host.upstreamGrants).toEqual([null]);
});

it("refuses missing grants and sends a granted suggestion without relaying the grant header", async () => {
  const host = relay();
  const grant = (await host.read()).headers.get(grantHeader);
  expect((await host.send(null, false)).ok).toBe(false);
  expect(host.upstreamGrants).toEqual([]);
  expect(grant).toBeTruthy();
  expect((await host.send(grant, false)).ok).toBe(true);
  expect(host.upstreamGrants).toEqual([null]);
});

it("blocks a queued quote while an admitted consent read has yet to answer", async () => {
  const host = relay();
  const grant = (await host.read()).headers.get(grantHeader);
  expect(grant).toBeTruthy();
  let release!: () => void;
  const waiting = new Promise<void>((done) => { release = done; });
  const quote = host.send(grant, true, waiting);
  let failRead!: () => void;
  const readWaiting = new Promise<Response>((resolve) => { failRead = () => resolve(answer({}, 503)); });
  host.setConsent(() => readWaiting);
  const read = host.read();
  try {
    release();
    expect((await quote).ok).toBe(false);
    expect(host.upstreamGrants).toEqual([]);
  } finally {
    failRead();
    await read;
  }
});

it("holds a queued quote when an Off write is still arriving at the relay", async () => {
  const host = relay();
  host.setConsent(() => answer(consent("2026-08-13T09:00:00Z")));
  const grant = (await host.read()).headers.get(grantHeader);
  expect(grant).toBeTruthy();
  let releaseQuote!: () => void;
  let releaseOff!: () => void;
  const quoteBody = new Promise<void>((done) => { releaseQuote = done; });
  const offBody = new Promise<void>((done) => { releaseOff = done; });
  const quote = host.send(grant, true, quoteBody);
  const off = host.off(offBody);
  try {
    releaseQuote();
    expect((await quote).ok).toBe(false);
    expect(host.upstreamGrants).toEqual([]);
  } finally {
    releaseOff();
    expect((await off).ok).toBe(true);
  }
});

it("revokes a queued quote after an overlapping older read fails", async () => {
  const host = relay();
  const stamp = "2026-08-13T09:00:00Z";
  host.setConsent(() => answer(consent(stamp)));
  const grant = (await host.read()).headers.get(grantHeader);
  expect(grant).toBeTruthy();
  let releaseQuote!: () => void;
  let failRead!: (response: Response) => void;
  const waitingQuote = new Promise<void>((done) => { releaseQuote = done; });
  const waitingRead = new Promise<Response>((done) => { failRead = done; });
  const quote = host.send(grant, true, waitingQuote);
  host.setConsent(() => waitingRead);
  const older = host.read();
  try {
    host.setConsent(() => answer(consent(stamp)));
    expect((await host.read()).ok).toBe(true);
    failRead(answer({}, 503));
    expect((await older).ok).toBe(false);
    releaseQuote();
    expect((await quote).ok).toBe(false);
    expect(host.upstreamGrants).toEqual([]);
    const current = (await host.read()).headers.get(grantHeader);
    expect(current).toBeTruthy();
    expect(current).not.toBe(grant);
    expect((await host.send(current, true)).ok).toBe(true);
  } finally {
    releaseQuote();
    failRead(answer({}, 503));
  }
});

it("keeps the replacement grant when an older read held a different generation", async () => {
  const host = relay();
  host.setConsent(() => answer(consent("2026-08-13T09:00:00Z")));
  const oldGrant = (await host.read()).headers.get(grantHeader);
  let fail!: (response: Response) => void;
  const waiting = new Promise<Response>((resolve) => { fail = resolve; });
  host.setConsent(() => waiting);
  const older = host.read();
  try {
    host.setConsent(() => answer(consent("2026-08-13T09:01:00Z")));
    const replacement = (await host.read()).headers.get(grantHeader);
    expect(replacement).toBeTruthy();
    expect(replacement).not.toBe(oldGrant);
    fail(answer({}, 503));
    await older;
    expect((await host.send(oldGrant, true)).ok).toBe(false);
    expect((await host.send(replacement, true)).ok).toBe(true);
    expect(host.upstreamGrants).toEqual([null]);
  } finally {
    fail(answer({}, 503));
  }
});

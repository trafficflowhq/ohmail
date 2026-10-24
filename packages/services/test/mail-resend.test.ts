import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  ResendMailer, nodeHttpPost, renderTemplate, type HttpPost, type WaitlistConfirmationData,
} from "../src/index.js";

/**
 * The Resend implementation, exercised with an INJECTED transport.
 *
 * The point of the injection is not testability alone; it is that `packages/services`
 * has no code path that reaches a network client on its own. This file proves it two
 * ways: a `globalThis.fetch` trap that must never fire, and a source-level assertion
 * that nothing under `src/mail/` calls `fetch` except the one production adapter.
 */

const DATA: WaitlistConfirmationData = {
  tier: "solo", siteUrl: "https://ohmail.app", supportEmail: "support@ohmail.app",
};

interface Recorded { url: string; headers: Record<string, string>; body: string; timeoutMs: number }

function recorder(
  reply: { status: number; body: string } | (() => never),
): HttpPost & { calls: Recorded[] } {
  const calls: Recorded[] = [];
  return {
    calls,
    async post(url, init) {
      calls.push({ url, ...init });
      if (typeof reply === "function") reply();
      return reply;
    },
  };
}

const mailer = (http: HttpPost, over: Partial<ConstructorParameters<typeof ResendMailer>[0]> = {}) =>
  new ResendMailer({
    apiKey: "re_test_key_never_real", from: "ohmail <no-reply@mail.ohmail.app>",
    replyTo: "support@ohmail.app", endpoint: "https://api.resend.test/emails", http, ...over,
  });

const realFetch = globalThis.fetch;
let fetchCalls: unknown[][] = [];

beforeEach(() => {
  fetchCalls = [];
  globalThis.fetch = ((...args: unknown[]) => {
    fetchCalls.push(args);
    throw new Error(`no-network rule violated: ResendMailer called globalThis.fetch(${String(args[0])})`);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  expect(fetchCalls, "an external request escaped the Resend suite").toEqual([]);
});

describe("ResendMailer — the request it builds", () => {
  it("posts the rendered template to the configured endpoint with both parts", async () => {
    const http = recorder({ status: 200, body: JSON.stringify({ id: "b1f2-…" }) });
    const res = await mailer(http).send("Reader@Example.com", "waitlist_confirmation", DATA);

    expect(res).toEqual({ status: "sent", providerId: "b1f2-…" });
    expect(http.calls).toHaveLength(1);
    const call = http.calls[0]!;
    expect(call.url).toBe("https://api.resend.test/emails");
    expect(call.headers.Authorization).toBe("Bearer re_test_key_never_real");
    expect(call.headers["Content-Type"]).toBe("application/json");
    expect(call.headers["Idempotency-Key"]).toBeUndefined();
    expect(call.timeoutMs).toBe(10_000);

    const expected = renderTemplate("waitlist_confirmation", DATA);
    const body = JSON.parse(call.body) as Record<string, unknown>;
    expect(body).toEqual({
      from: "ohmail <no-reply@mail.ohmail.app>",
      to: ["reader@example.com"],              // normalised, and always an array
      subject: expected.subject,
      html: expected.html,
      text: expected.text,
      reply_to: "support@ohmail.app",
      headers: expected.headers,
    });
  });

  it("sends from the transactional SUBDOMAIN, never the marketing domain", async () => {
    const http = recorder({ status: 200, body: "{}" });
    await mailer(http).send("reader@example.com", "waitlist_confirmation", DATA);
    const from = (JSON.parse(http.calls[0]!.body) as { from: string }).from;
    expect(from).toMatch(/@mail\.ohmail\.app>$/);
  });

  it("passes an Idempotency-Key through when one is given", async () => {
    const http = recorder({ status: 200, body: "{}" });
    await mailer(http).send("reader@example.com", "waitlist_confirmation", DATA, { idempotencyKey: "k-1" });
    expect(http.calls[0]!.headers["Idempotency-Key"]).toBe("k-1");
  });

  it("a template's own reply address wins over the configured one", async () => {
    const http = recorder({ status: 200, body: "{}" });
    await mailer(http, { replyTo: "replies@example.com" }).send("reader@example.com", "lifecycle_notice", {
      kind: "trial_two_days", locale: "en", anchorDate: "26 October 2026, 18:05 UTC", erasureDate: null,
      accountUrl: "https://ohmail.app/#/settings/account", setupUrl: "https://ohmail.app/#/first-run/again",
      noMailbox: true, supportEmail: "support@ohmail.app",
    });
    expect((JSON.parse(http.calls[0]!.body) as { reply_to?: string }).reply_to).toBe("support@ohmail.app");
  });

  it("omits reply_to and headers when there is nothing to send", async () => {
    const http = recorder({ status: 200, body: "{}" });
    await mailer(http, { replyTo: undefined }).send("reader@example.com", "email_verification", {
      verifyUrl: "https://app.ohmail.app/verify-email?token=x", expiresIn: "24 hours",
      supportEmail: "support@ohmail.app",
    });
    const body = JSON.parse(http.calls[0]!.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty("reply_to");
    expect(body).not.toHaveProperty("headers");
  });

  it("skips an unusable recipient before building any request", async () => {
    const http = recorder({ status: 200, body: "{}" });
    expect(await mailer(http).send("not-an-address", "waitlist_confirmation", DATA))
      .toEqual({ status: "skipped", reason: "invalid_recipient" });
    expect(http.calls).toHaveLength(0);
  });
});

describe("ResendMailer — every failure is a value, never an exception", () => {
  it("classifies 429 and 5xx as retryable, other 4xx as not", async () => {
    for (const [status, retryable] of [[429, true], [500, true], [503, true], [401, false], [422, false]] as const) {
      const http = recorder({ status, body: `{"message":"nope","name":"validation_error"}` });
      const res = await mailer(http).send("reader@example.com", "waitlist_confirmation", DATA);
      expect(res, `status ${status}`).toEqual({
        status: "failed", retryable, error: `resend_${status}: validation_error`,
      });
    }
  });

  it("reduces the provider body to an allow-listed CODE, never prose", async () => {
    // The body is remote, unbounded, attacker-influenceable prose and the result goes to
    // logs. Only Resend's `name` enum survives, and only if it looks like an enum.
    const cases: [string, string][] = [
      [`{"statusCode":422,"message":"anything at all","name":"validation_error"}`, "validation_error"],
      [`{"name":"restricted_api_key"}`, "restricted_api_key"],
      [`{"message":"no name field here"}`, "unrecognised_error"],
      [`{"name":"Contains Spaces And Caps"}`, "unrecognised_error"],
      [`{"name":"${"x".repeat(200)}"}`, "unrecognised_error"],
      [`<html>502 Bad Gateway</html>`, "unrecognised_error"],
      [``, "unrecognised_error"],
    ];
    for (const [body, code] of cases) {
      const res = await mailer(recorder({ status: 422, body })).send("r@example.com", "waitlist_confirmation", DATA);
      expect((res as { error: string }).error, body.slice(0, 40)).toBe(`resend_422: ${code}`);
    }
  });

  it("turns a transport throw (DNS, abort, timeout) into a retryable failure", async () => {
    const http = recorder(() => { throw new Error("ENOTFOUND api.resend.test"); });
    const res = await mailer(http).send("reader@example.com", "waitlist_confirmation", DATA);
    expect(res).toMatchObject({ status: "failed", retryable: true });
    expect((res as { error: string }).error).toContain("ENOTFOUND");
  });

  it("turns a bad template argument into a NON-retryable failure, not a throw", async () => {
    const http = recorder({ status: 200, body: "{}" });
    const res = await mailer(http).send("reader@example.com", "invite", {
      code: "C", redeemUrl: "javascript:alert(1)", expiresAt: "soon", supportEmail: "support@ohmail.app",
    });
    expect(res).toMatchObject({ status: "failed", retryable: false });
    expect((res as { error: string }).error).toMatch(/^render_failed:/);
    expect(http.calls).toHaveLength(0);
  });

  it("never leaks the API key or the recipient into the error string", async () => {
    // Resend's real 401 body echoes the key back at us. The previous version of this test
    // asserted only that the error was SHORT — and the implementation happily returned
    // `resend_401: {"message":"API key re_test_key_never_real is invalid"}`, which is 63
    // characters and contains a live credential. Assert the secrets, not the length.
    const http = recorder({
      status: 401,
      body: `{"message":"API key re_test_key_never_real is invalid for private.person@example.com","name":"restricted_api_key"}`,
    });
    const res = await mailer(http).send("private.person@example.com", "waitlist_confirmation", DATA);
    const error = (res as { error: string }).error;
    expect(error).toBe("resend_401: restricted_api_key");
    expect(error).not.toContain("re_test_key_never_real");
    expect(error).not.toContain("private.person@example.com");
    expect(error).not.toContain("private.person");
  });

  it("scrubs a key, an address, a URL query and a token out of a TRANSPORT error", async () => {
    // The other error path: an exception thrown by the injected transport (undici, a
    // proxy, our own AbortController). Nothing bounds what that message contains.
    const secret = "SUPER-SECRET-RAW-VERIFICATION-TOKEN-abcdefgh";
    const http = recorder(() => {
      throw new Error(
        `connect failed: Bearer re_test_key_never_real sending to victim@example.com ` +
        `via https://api.resend.test/emails?token=${secret}`,
      );
    });
    const res = await mailer(http).send("reader@example.com", "waitlist_confirmation", DATA);
    const error = (res as { error: string }).error;
    for (const leak of ["re_test_key_never_real", "victim@example.com", secret]) {
      expect(error, `leaked ${leak}`).not.toContain(leak);
    }
    expect(error).toContain("transport:");
    expect(error).toContain("[redacted]");
    expect(error).toContain("[address]");
    // …and enough survives to diagnose with.
    expect(error).toContain("connect failed");
  });

  it("a render failure carries no trace of the URL that caused it", async () => {
    // The defect this whole redaction layer exists for: `safeUrl` used to embed the URL
    // it rejected, and both mailers wrap that as `render_failed: …` — a log-destined
    // string. The URL is where every credential in this slice lives.
    const raw = "LIVE-VERIFICATION-TOKEN-that-still-works-xyz";
    const res = await mailer(recorder({ status: 200, body: "{}" }))
      .send("reader@example.com", "email_verification", {
        verifyUrl: `app.ohmail.app/verify-email?token=${raw}`,   // not absolute ⇒ safeUrl throws
        expiresIn: "24 hours", supportEmail: "support@ohmail.app",
      });
    const error = (res as { error: string }).error;
    expect(res).toMatchObject({ status: "failed", retryable: false });
    expect(error).not.toContain(raw);
    expect(error).not.toContain("verify-email");
    expect(error).not.toContain("app.ohmail.app");
    expect(error).toMatch(/^render_failed: .*not an absolute URL \(\d+ chars\)$/);
  });

  it("a 200 with an unparseable body is still a send", async () => {
    const http = recorder({ status: 200, body: "<html>gateway</html>" });
    expect(await mailer(http).send("reader@example.com", "waitlist_confirmation", DATA))
      .toEqual({ status: "sent", providerId: null });
  });
});

describe("ResendMailer — it refuses to be constructed dangerously", () => {
  it("will not take the real network transport under a test runner", () => {
    // The structural half of the "Testing bar" invariant. Before this, `new ResendMailer({apiKey, from})`
    // silently defaulted `http` to `nodeHttpPost` — so one route test wiring the real
    // env would have sent a real email to a real person from a green suite.
    expect(() => new ResendMailer({
      apiKey: "re_test_key_never_real", from: "ohmail <no-reply@mail.ohmail.app>",
    })).toThrow(/refusing to construct with the real network transport/);
    expect(fetchCalls).toEqual([]);
  });

  it("rejects a `from` that could inject a header or is not an address", () => {
    const http = recorder({ status: 200, body: "{}" });
    for (const from of [
      "ohmail <no-reply@mail.ohmail.app>\r\nBcc: everyone@example.com",
      "ohmail <no-reply@mail.ohmail.app>\nBcc: everyone@example.com",
      "not-an-address",
      "",
      "   ",
    ]) {
      expect(() => new ResendMailer({ apiKey: "k", from, http }), JSON.stringify(from)).toThrow(/from/);
    }
    expect(() => new ResendMailer({
      apiKey: "k", from: "ohmail <no-reply@mail.ohmail.app>", http,
    })).not.toThrow();
  });
});

describe("nodeHttpPost — the production adapter's timeout is real", () => {
  it("aborts a request that never resolves, at exactly timeoutMs", async () => {
    // The existing transport test threw immediately, so it would have passed with the
    // AbortController deleted. This one hangs until the abort fires — the only shape that
    // proves the timeout exists. A hung outbound request in a serverless invocation is a
    // billed, blocked request handler.
    vi.useFakeTimers();
    let signalled: AbortSignal | undefined;
    globalThis.fetch = ((_url: unknown, init: { signal: AbortSignal }) => {
      signalled = init.signal;
      return new Promise((_res, rej) => {
        init.signal.addEventListener("abort", () => rej(new Error("The operation was aborted.")));
      });
    }) as unknown as typeof fetch;

    // Settle-handler attached IMMEDIATELY: the rejection fires inside a fake-timer tick,
    // and an unattached one is an unhandled rejection that fails the whole file.
    const settled = nodeHttpPost.post("https://api.resend.test/emails", {
      headers: {}, body: "{}", timeoutMs: 10_000,
    }).then(() => "resolved", (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`);

    expect(signalled!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(signalled!.aborted, "aborted early").toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(signalled!.aborted, "never aborted — the timeout is not wired").toBe(true);
    expect(await settled).toMatch(/^rejected: .*abort/i);
    vi.useRealTimers();
    // This test drives fetch on purpose; the afterEach trap counts our own calls.
    fetchCalls = [];
  });
});

describe("nothing under src/mail reaches the network on its own", () => {
  const dir = fileURLToPath(new URL("../src/mail/", import.meta.url));

  it("only `nodeHttpPost` in resend-mailer.ts mentions fetch at all", () => {
    const offenders: string[] = [];
    for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
      const src = readFileSync(dir + file, "utf8");
      // Strip comments so prose about fetch does not trip the grep.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      if (/\bfetch\s*\(|\bXMLHttpRequest\b|require\(['"]https?['"]\)|from ['"]node:https?['"]/.test(code)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual(["resend-mailer.ts"]);
  });

  it("the grep bites: it would catch a fetch added to the spy", () => {
    const hostile = `export class X { async send() { return fetch("https://x"); } }`;
    expect(/\bfetch\s*\(/.test(hostile)).toBe(true);
  });
});

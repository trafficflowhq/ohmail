import { describe, expect, it } from "vitest";
import {
  CloudSignInError, cloudSignIn, pollDesktopApproval, redeemPairingToken, requestDesktopApproval, APPROVAL_BUSY_ATTEMPTS,
} from "../src/cloud-signin.js";

/**
 * THE ONE-CONFIRM SIGN-IN, the engine's half: ask for a request, hand the window its id, poll the
 * claim with the verifier that never leaves this process. A busy server is a wait (the request
 * retries on `Retry-After`, a busy or unreachable poll reads pending), a 404 is the named fallback
 * to the code path, and each refusal keeps its sentence. The hosted side is a fake that answers
 * the way `packages/api` does; the route itself is tested there. The engine's routes, which boot
 * a whole engine per case, are `slow/cloud-approval-engine.test.ts`.
 */

const ID = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });
const busy = (retryAfter = "3"): Response =>
  json({ error: { code: "db_busy", message: "busy", retryable: true } }, 503, { "retry-after": retryAfter });

type Call = { path: string; body: Record<string, unknown> };
function fake(answers: Array<(call: Call) => Response | Promise<Response>>): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string, init?: RequestInit): Promise<Response> => {
    const call = { path: new URL(input).pathname, body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> };
    calls.push(call);
    const next = answers.shift();
    if (!next) throw new Error(`unexpected call ${call.path}`);
    return next(call);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

describe("requestDesktopApproval", () => {
  it("sends the challenge, the label and the kind, and answers the id and lifetime", async () => {
    const { fetchImpl, calls } = fake([() => json({ approvalId: ID, expiresIn: 300 })]);
    const got = await requestDesktopApproval(
      { baseUrl: "https://cloud.test/", fetchImpl, label: "studio", deviceKind: "desktop-linux" }, "c".repeat(43),
    );
    expect(got).toEqual({ approvalId: ID, expiresIn: 300 });
    expect(calls).toEqual([{ path: "/auth/desktop-approval", body: { challenge: "c".repeat(43), label: "studio", kind: "desktop-linux" } }]);
  });

  it("a busy server is retried on its own Retry-After, and the fourth busy answer is a named refusal", async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => { waits.push(ms); };
    const ok = fake([() => busy("3"), () => busy("1"), () => json({ approvalId: ID, expiresIn: 300 })]);
    await expect(requestDesktopApproval({ baseUrl: "https://cloud.test", fetchImpl: ok.fetchImpl, label: "x", sleep }, "c"))
      .resolves.toEqual({ approvalId: ID, expiresIn: 300 });
    expect(waits).toEqual([3000, 1000]);

    const never = fake(Array.from({ length: APPROVAL_BUSY_ATTEMPTS }, () => () => busy()));
    const err = await requestDesktopApproval({ baseUrl: "https://cloud.test", fetchImpl: never.fetchImpl, label: "x", sleep }, "c")
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudSignInError);
    expect((err as CloudSignInError).code).toBe("db_busy");
    expect(never.calls).toHaveLength(APPROVAL_BUSY_ATTEMPTS);
  });

  it("a 404 is the hosted service predating the door, named so the window falls back", async () => {
    const { fetchImpl } = fake([() => new Response("not found", { status: 404 })]);
    const err = (await requestDesktopApproval({ baseUrl: "https://cloud.test", fetchImpl, label: "x" }, "c")
      .catch((e: unknown) => e)) as CloudSignInError;
    expect(err.code).toBe("approval_not_offered");
    expect(err.message).toBe("Your ohmail Cloud does not offer browser approval yet. Type a code instead.");
  });
});

describe("pollDesktopApproval", () => {
  const opts = (fetchImpl: typeof fetch) => ({ baseUrl: "https://cloud.test", fetchImpl, verifier: "v".repeat(43) });

  it("pending, busy and unreachable are all a wait, at the server's cadence", async () => {
    const { fetchImpl, calls } = fake([
      () => json({ status: "pending", retryAfterMs: 2000 }, 202),
      () => busy("4"),
      () => { throw new TypeError("fetch failed"); },
    ]);
    expect(await pollDesktopApproval(opts(fetchImpl), ID)).toEqual({ status: "pending", retryAfterMs: 2000 });
    expect(await pollDesktopApproval(opts(fetchImpl), ID)).toEqual({ status: "pending", retryAfterMs: 4000, note: "busy" });
    expect(await pollDesktopApproval(opts(fetchImpl), ID)).toEqual({ status: "pending", retryAfterMs: 2000, note: "unreachable" });
    expect(calls[0]).toEqual({ path: "/auth/desktop-approval/claim", body: { approvalId: ID, verifier: "v".repeat(43) } });
  });

  it("the claim carries the install's previous family when the engine names one, and only then", async () => {
    const previousSession = "p".repeat(43);
    const { fetchImpl, calls } = fake([
      () => json({ status: "pending", retryAfterMs: 2000 }, 202),
      () => json({ status: "pending", retryAfterMs: 2000 }, 202),
    ]);
    await pollDesktopApproval({ ...opts(fetchImpl), previousSession }, ID);
    await pollDesktopApproval(opts(fetchImpl), ID);
    expect(calls.map((c) => c.body.previousSession)).toEqual([previousSession, undefined]);
  });

  it("so do the code claim, the second step of the password sign-in and a pairing redeem", async () => {
    const previousSession = "p".repeat(43);
    const pair = { tokens: { accessToken: "a", refreshToken: "r" } };
    const { fetchImpl, calls } = fake([
      () => json(pair),
      () => json({ status: "twofa_required", loginToken: "lt" }),
      () => json(pair),
      () => json({ grant: "device-pair", ...pair }),
    ]);
    const base = { baseUrl: "https://cloud.test", fetchImpl, previousSession };
    await cloudSignIn(base, { handoffCode: "code" });
    await cloudSignIn(base, { email: "e@x.test", password: "pw", totp: "123456" });
    await redeemPairingToken({ ...base, deviceKind: "desktop-linux" }, "pair-token");
    expect(calls.map((c) => [c.path, c.body.previousSession])).toEqual([
      ["/auth/desktop-claim", previousSession], ["/auth/login", undefined],
      ["/auth/2fa/totp/verify", previousSession], ["/pair/redeem", previousSession],
    ]);
  });

  it("the pair once approved, and each refusal with its own sentence", async () => {
    const approved = fake([() => json({ tokens: { accessToken: "a", refreshToken: "r" } })]);
    expect(await pollDesktopApproval(opts(approved.fetchImpl), ID))
      .toEqual({ status: "approved", tokens: { accessToken: "a", refreshToken: "r" } });
    for (const [code, sentence] of [
      ["approval_expired", "This request has expired. Start again from your computer."],
      ["approval_used", "This request was already used."],
      ["approval_denied", "This request was declined in the browser."],
    ] as const) {
      const { fetchImpl } = fake([() => json({ error: { code, message: "server words" } }, 410)]);
      const err = (await pollDesktopApproval(opts(fetchImpl), ID).catch((e: unknown) => e)) as CloudSignInError;
      expect([err.code, err.status, err.message]).toEqual([code, 410, sentence]);
    }
  });
});

import { describe, expect, it } from "vitest";
import { CLIENT_HEADER as ENGINE_CLIENT_HEADER, clientHeaderValue } from "@ohmail/client-engine";
import { CLIENT_HEADER, createCloudAuth, engineClientValue } from "../src/cloud-auth.js";
import { answerCloudProbe } from "../src/cloud-probe.js";
import { createWriteThroughProxy } from "../src/cloud-proxy.js";
import type { CloudMirror } from "../src/cloud-mirror.js";
import {
  cloudIdentity, cloudSignIn, CloudSignInError, pollDesktopApproval, redeemPairingToken, requestDesktopApproval,
  type CloudSignInOptions,
} from "../src/cloud-signin.js";
import { createStagedUploads } from "../src/cloud-staged-upload.js";

/**
 * THE DESKTOP'S ENGINE NAMES ITSELF ON EVERY HOSTED REQUEST, and a request the window made leaves
 * as the engine's: Cloud sees `desktop-engine/<release>` once, never `desktop-window/…`. The
 * header's spelling is the client engine's, held equal here because this process does not link it.
 */

const json = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json" } });

/** A hosted API that records each request's client headers, and answers 401 once to force a refresh. */
function hosted(opts: { expireFirst?: boolean } = {}) {
  const asks: Array<{ path: string; named: string[] }> = [];
  let expired = opts.expireFirst === true;
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    asks.push({ path: url.pathname, named: headers.get(CLIENT_HEADER)?.split(", ") ?? [] });
    if (url.pathname === "/auth/refresh") return json({ tokens: { accessToken: "a2", refreshToken: "r2", expiresIn: 900 } });
    if (expired) { expired = false; return json({ error: { code: "unauthorized", message: "no" } }, 401); }
    return json({ ok: true });
  }) as unknown as typeof fetch;
  return { fetchImpl, asks };
}

describe("the engine's hosted door", () => {
  it("spells the header as the client engine does", () => {
    expect(CLIENT_HEADER).toBe(ENGINE_CLIENT_HEADER);
    for (const release of ["1.0.12", "0.9.0", undefined, "", "1.0.12+abc", "x"]) {
      expect(engineClientValue(release), String(release)).toBe(clientHeaderValue("desktop-engine", release));
    }
  });

  it("names the engine and its release on a read and on the renewal that follows a 401", async () => {
    const h = hosted({ expireFirst: true });
    const auth = createCloudAuth({
      baseUrl: "https://cloud.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl: h.fetchImpl,
      clientRelease: "1.2.3", random: () => 0.5,
    });
    await auth.authedFetch("/mailboxes");
    expect(h.asks.map((a) => a.path)).toEqual(["/mailboxes", "/auth/refresh", "/mailboxes"]);
    for (const ask of h.asks) expect(ask.named, ask.path).toEqual(["desktop-engine/1.2.3"]);
    auth.stop();
  });

  it("names `dev` where no release was baked in", async () => {
    const h = hosted();
    const auth = createCloudAuth({ baseUrl: "https://cloud.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl: h.fetchImpl });
    await auth.authedFetch("/mailboxes");
    expect(h.asks[0]!.named).toEqual(["desktop-engine/dev"]);
    auth.stop();
  });

  it("the proxy hands the hosted door no name of the window's, so the engine names itself alone", async () => {
    const handed: Array<string | null> = [];
    const auth = {
      authedFetch: async (_path: string, init?: RequestInit) => {
        handed.push(new Headers(init?.headers).get(CLIENT_HEADER));
        return json({ ok: true });
      },
    } as unknown as ReturnType<typeof createCloudAuth>;
    const mirror = {
      online: () => true, markConnectivity: () => {}, awaitCloudSeq: async () => true, awaitFreshPull: async () => true,
      localSeq: async () => null,
    } as unknown as CloudMirror;
    const proxy = createWriteThroughProxy({ auth, mirror });
    await proxy.forward(new Request("http://engine/screener/11111111-1111-4111-8111-111111111111", {
      method: "POST", body: JSON.stringify({ sender: "a@b.test", decision: "in" }),
      headers: { "content-type": "application/json", [CLIENT_HEADER]: "desktop-window/9.9.9" },
    }));
    expect(handed).toEqual([null]);
  });

  it("a window's request is relayed as the engine's, once", async () => {
    const h = hosted();
    const auth = createCloudAuth({
      baseUrl: "https://cloud.test", tokens: { accessToken: "a1", refreshToken: "r1" }, fetchImpl: h.fetchImpl, clientRelease: "1.2.3",
    });
    const mirror = {
      online: () => true, markConnectivity: () => {}, awaitCloudSeq: async () => true, awaitFreshPull: async () => true,
      localSeq: async () => null,
    } as unknown as CloudMirror;
    const proxy = createWriteThroughProxy({ auth, mirror });
    const res = await proxy.forward(new Request("http://engine/screener/11111111-1111-4111-8111-111111111111", {
      method: "POST", body: JSON.stringify({ sender: "a@b.test", decision: "in" }),
      headers: { "content-type": "application/json", [CLIENT_HEADER]: "desktop-window/9.9.9", "idempotency-key": "k-1" },
    }));
    expect(res.status).toBe(200);
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0]!.named, "Cloud heard the window, or heard it twice").toEqual(["desktop-engine/1.2.3"]);
    auth.stop();
  });
});

/**
 * BEFORE THERE IS A SESSION the engine still asks a server: the sign-in, the code from a browser, the
 * browser's approval, a pairing code, the check of a server's address. Each of those names the engine
 * too, so a server reads one kind and one release from a desktop whether it is signed in or not.
 */
const APPROVAL = "4f9a3c1e-2b7d-4e8f-9a01-23456789abcd";
const PAIR = { tokens: { accessToken: "a1", refreshToken: "r1", expiresIn: 900 } };

/** A server that takes every ceremony, recording who asked each path. */
function ceremonies(answer?: (path: string) => Response | null) {
  const asks: Array<{ path: string; named: string[] }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    asks.push({ path: url.pathname, named: new Headers(init?.headers).get(CLIENT_HEADER)?.split(", ") ?? [] });
    const said = answer?.(url.pathname) ?? null;
    if (said !== null) return said;
    switch (url.pathname) {
      case "/auth/login": return json({ status: "twofa_required", loginToken: "lt-1" });
      case "/auth/session": return json({ user: { email: "me@ohmail.test" } });
      case "/auth/desktop-approval": return json({ approvalId: APPROVAL, expiresIn: 300 });
      case "/hello": return json({ product: "ohmail", flavor: url.hostname.startsWith("desk") ? "desktop-host" : "selfhost", needsSetup: false });
      case "/pair/state": return json({ state: "unknown" });
      default: return json(PAIR);
    }
  }) as unknown as typeof fetch;
  return { fetchImpl, asks };
}

/** Every ask a desktop makes with no session, each on its own server, in the order of the list. */
async function everyCeremony(opts: CloudSignInOptions): Promise<void> {
  await cloudSignIn(opts, { email: "me@ohmail.test", password: "pw", totp: "123456" });
  await cloudSignIn(opts, { handoffCode: "code-1" });
  await cloudIdentity(opts, PAIR.tokens);
  await redeemPairingToken({ ...opts, deviceKind: "desktop-linux" }, "pair-1");
  await requestDesktopApproval({ ...opts, label: "studio" }, "c".repeat(43));
  await pollDesktopApproval({ ...opts, verifier: "v".repeat(43) }, APPROVAL);
}
const CEREMONY_PATHS = [
  "/auth/login", "/auth/2fa/totp/verify", "/auth/desktop-claim", "/auth/session", "/pair/redeem",
  "/auth/desktop-approval", "/auth/desktop-approval/claim",
];

describe("the engine's asks before a session", () => {
  it("every sign-in, redeem and approval request names the engine and its release", async () => {
    const h = ceremonies();
    await everyCeremony({ baseUrl: "https://cloud.test", fetchImpl: h.fetchImpl, clientRelease: "1.2.3" });
    expect(h.asks.map((a) => a.path)).toEqual(CEREMONY_PATHS);
    for (const ask of h.asks) expect(ask.named, ask.path).toEqual(["desktop-engine/1.2.3"]);
  });

  it("names `dev` where no release was handed in, never nothing", async () => {
    const h = ceremonies();
    await everyCeremony({ baseUrl: "https://cloud.test", fetchImpl: h.fetchImpl });
    expect(h.asks.map((a) => a.path)).toEqual(CEREMONY_PATHS);
    for (const ask of h.asks) expect(ask.named, ask.path).toEqual(["desktop-engine/dev"]);
  });

  it("the check of a server's address names it: the server it is set up for, a candidate, and a computer's pairing link", async () => {
    const h = ceremonies();
    const door = (configured: boolean) => ({
      dataDir: "/nonexistent", fetchImpl: h.fetchImpl, clientRelease: "1.2.3",
      configured: configured ? { base: "https://cloud.test", fetchImpl: h.fetchImpl } : null,
    });
    const probe = (body?: unknown) => new Request("http://engine/cloud/probe", {
      method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });
    expect((await answerCloudProbe(probe(), door(true))).status, "the configured server").toBe(200);
    expect((await answerCloudProbe(probe({ origin: "https://mail.example.test" }), door(false))).status, "a candidate").toBe(200);
    const paired = await answerCloudProbe(
      probe({ origin: "https://desk.example.test", flavor: "desktop-host", tokenHash: "a".repeat(43) }), door(false),
    );
    expect(paired.status, await paired.clone().text()).toBe(200);
    expect(h.asks.map((a) => a.path)).toEqual(["/hello", "/hello", "/hello", "/pair/state"]);
    for (const ask of h.asks) expect(ask.named, ask.path).toEqual(["desktop-engine/1.2.3"]);
  });

  it("a staged upload goes to a storage host and names nobody, whatever the window's own request said", async () => {
    const seen: Array<{ host: string; named: string | null }> = [];
    const uploads = createStagedUploads({
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        seen.push({ host: new URL(String(input)).host, named: new Headers(init?.headers).get(CLIENT_HEADER) });
        return new Response(null, { status: 200 });
      }) as unknown as typeof fetch,
    });
    const minted = await uploads.rewriteMint(json({
      id: "ticket-1", uploadUrl: "https://storage.example.test/bucket/key?sig=1", uploadHeaders: { "content-type": "application/pdf" },
    }));
    const { uploadUrl } = (await minted.json()) as { uploadUrl: string };
    const res = await uploads.upload(new Request(`http://engine${uploadUrl}`, {
      method: "PUT", body: new Uint8Array([1, 2, 3]), headers: { [CLIENT_HEADER]: "desktop-window/9.9.9" },
    }));
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ host: "storage.example.test", named: null }]);
  });
});

/**
 * A SERVER THAT HAS NO USE FOR THIS RELEASE says so to every request, a sign-in included: `426` with
 * its own code and sentence in ohmail's envelope. The engine hands that on to the window as it came,
 * so the window says there what it says for that answer anywhere else. Nothing of this release
 * sends one; the stub does.
 */
describe("a sign-in that meets a server too new for this app", () => {
  const TOO_OLD = { status: 426, code: ["client", "too", "old"].join("_"), message: "This ohmail is too old for its server." };
  const tooOld = (): Response => json({ error: { code: TOO_OLD.code, message: TOO_OLD.message, retryable: true } }, 426);
  const refusalOf = async (run: () => Promise<unknown>): Promise<CloudSignInError> => {
    const err = await run().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudSignInError);
    return err as CloudSignInError;
  };
  const STEPS: Array<{ name: string; at: string; run: (opts: CloudSignInOptions) => Promise<unknown> }> = [
    { name: "the password", at: "/auth/login", run: (o) => cloudSignIn(o, { email: "me@ohmail.test", password: "pw", totp: "123456" }) },
    { name: "the six digits", at: "/auth/2fa/totp/verify", run: (o) => cloudSignIn(o, { email: "me@ohmail.test", password: "pw", totp: "123456" }) },
    { name: "a code from the browser", at: "/auth/desktop-claim", run: (o) => cloudSignIn(o, { handoffCode: "code-1" }) },
    { name: "a pairing code", at: "/pair/redeem", run: (o) => redeemPairingToken({ ...o, deviceKind: "desktop-linux" }, "pair-1") },
    { name: "the approval request", at: "/auth/desktop-approval", run: (o) => requestDesktopApproval({ ...o, label: "studio" }, "c".repeat(43)) },
    { name: "the approval's claim", at: "/auth/desktop-approval/claim", run: (o) => pollDesktopApproval({ ...o, verifier: "v".repeat(43) }, APPROVAL) },
  ];

  it("only a code is handed on as a code, and a sentence only at a sentence's length", async () => {
    const said = (error: Record<string, unknown>) => ceremonies((path) => (path === "/auth/login" ? json({ error }, 426) : null));
    const signIn = (h: ReturnType<typeof ceremonies>) => refusalOf(() =>
      cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl: h.fetchImpl }, { email: "me@ohmail.test", password: "pw", totp: "123456" }));
    for (const code of ["Not A Code", "x".repeat(65), "<b>code</b>", 426, ""]) {
      const err = await signIn(said({ code, message: "words" }));
      expect([err.status, err.code], String(code)).toEqual([502, "hosted_refused"]);
    }
    const long = await signIn(said({ code: TOO_OLD.code, message: "w".repeat(5000) }));
    expect([long.status, long.code]).toEqual([426, TOO_OLD.code]);
    expect(long.message.length).toBeLessThanOrEqual(300);
    const bare = await signIn(said({ code: TOO_OLD.code }));
    expect(bare.message, "an answer with no sentence says its code").toBe(TOO_OLD.code);
  });

  for (const step of STEPS) {
    it(`${step.name}: the answer is handed on with its status, its code and its sentence`, async () => {
      const h = ceremonies((path) => (path === step.at ? tooOld() : null));
      const err = await refusalOf(() => step.run({ baseUrl: "https://cloud.test", fetchImpl: h.fetchImpl }));
      expect({ status: err.status, code: err.code, message: err.message }).toEqual(TOO_OLD);
    });

    it(`${step.name}: a 426 that is not ohmail's stays the general refusal`, async () => {
      const h = ceremonies((path) => (path === step.at ? new Response("<html>Upgrade Required</html>", { status: 426 }) : null));
      const err = await refusalOf(() => step.run({ baseUrl: "https://cloud.test", fetchImpl: h.fetchImpl }));
      expect(err.status, err.code).toBe(502);
      expect(err.code).toMatch(/^(hosted|host)_refused$/);
    });
  }
});

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  MessageBodyBatchItem, MessageDTO, Page, SyncChange, SyncResponse, ThreadDTO,
} from "@trafficflow/services/mail";
import { hashToken } from "@trafficflow/services/mail";
import { createCloudSidecar, type CloudSidecar } from "../../src/cloud-engine.js";
import {
  challengeFor,
  cloudSignIn,
  CloudSignInError,
  desktopDeviceKind,
  newDesktopLinkPair,
  tokensFromSetCookie,
} from "../../src/cloud-signin.js";
import { cloudConfigFromEnv } from "../../src/main.js";
import { hostedMailbox, mailboxList } from "../fixtures/hosted-mailbox.js";
import { freshDataDir } from "../_datadir.js";

/**
 * SIGNING IN FROM A CLOUD INSTALL THAT HOLDS NO SESSION.
 *
 * Three claims, and they are separable on purpose:
 *
 *  1. **The wire is the hosted API's.** Two calls, `loginToken` and not `challengeToken`, and the
 *     token pair read from WHICHEVER of the two places the deployment put it — `Set-Cookie` on a
 *     cookie host, the body on a bearer-only one. Both are exercised, because a reader that handles
 *     one works against one deployment and silently returns "no session" against the other.
 *  2. **A token-less engine SERVES.** It comes up, answers `/health` with `signedIn: false`, refuses
 *     every read with `409 not_signed_in` — including the reads it could physically answer, because
 *     a mirror served to a window holding no hosted credential is access granted by the absence of
 *     one — and accepts `POST /cloud/signin`.
 *  3. **The transition is IN PLACE.** One process, one open database, one bridge: after the sign-in
 *     the same object pulls the feed and answers a read. Nothing restarts, because a restart would
 *     tear down the stdio host the window is mid-request on.
 *
 * And the door separator is re-asserted on the NEW path: a token-less cloud configuration with an
 * IMAP setting present is still a hard refusal. The point of that refusal was always that the safe
 * branch is chosen by construction rather than by the absence of a value — a pre-auth launch is
 * exactly the launch where "there is no credential here anyway" is the tempting argument for
 * relaxing it.
 */

const iso = (): string => new Date().toISOString();
const ACCOUNT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MAILBOX = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const sidecars: CloudSidecar[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const s of sidecars.splice(0)) await s.stop().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function freshDir(): Promise<string> {
  const d = await freshDataDir("ohmail-cloud-signin-");
  dirs.push(d);
  return d;
}

/**
 * What the ENGINE declares itself as on this machine — the e2e tests below drive the real
 * `createCloudSidecar`, which reads `process.platform`, so their exact-body assertions carry
 * whatever this host's declaration is (a `kind` field on the recognized platforms, nothing on
 * one the vocabulary has no word for). Computed with the same helper the engine uses: the
 * subject of those tests is the PKCE binding and the sealed transition, not the mapping — the
 * mapping has its own test.
 */
const HOST_KIND = desktopDeviceKind(process.platform);
const HOST_KIND_FIELD: { kind?: string } = HOST_KIND ? { kind: HOST_KIND } : {};

const aKek = (): Record<number, Buffer> => ({ 1: Buffer.from(crypto.getRandomValues(new Uint8Array(32))) });

function messageDTO(id: string, threadId: string): MessageDTO {
  return {
    id, accountId: ACCOUNT, mailboxId: MAILBOX, threadId,
    messageIdHeader: `<${id}@sender.test>`, subject: "After the sign-in",
    from: { name: null, address: "stranger@nowhere.test" },
    to: [{ name: null, address: "me@ohmail.test" }], cc: [],
    arrivedAt: iso(), date: iso(), folder: "INBOX", snippet: "arrived over the hosted feed", unread: true,
    lastReadAt: null, hasAttachments: false, attachmentCount: 0,
    sensitivity: { sensitive: false, category: null, no_ai: false, no_forward: false, no_kb: false, priority: false },
    triage: null, labels: [], remoteContent: "none", updatedAt: iso(),
  };
}
function threadDTO(id: string): ThreadDTO {
  return {
    id, accountId: ACCOUNT, subject: "After the sign-in", messageIds: [],
    participants: [{ name: null, address: "stranger@nowhere.test" }],
    lastMessageAt: iso(), unreadCount: 1, muted: false, folder: "INBOX", updatedAt: iso(),
  };
}
function syncPage(changes: SyncChange[], cursor: string, hasMore: boolean): SyncResponse {
  return {
    changes: {
      creates: changes.filter((c) => c.op === "create"),
      updates: changes.filter((c) => c.op === "update"),
      moves: changes.filter((c) => c.op === "move"),
      deletes: changes.filter((c) => c.op === "delete"),
    },
    cursor, hasMore, serverTime: iso(),
  };
}
const change = (type: SyncChange["type"], id: string, seq: number, entity: unknown): SyncChange =>
  ({ type, op: "create", id, seq, updatedAt: iso(), entity });

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { "content-type": "application/json", ...headers } });

/** The cookie set a cookie host answers a completed 2FA with — the real attributes, commas included. */
function sessionCookieHeaders(access: string, refresh: string): Headers {
  const h = new Headers({ "content-type": "application/json" });
  h.append("set-cookie", `tf_session=${access}; HttpOnly; SameSite=Strict; Secure; Path=/; Max-Age=900`);
  h.append("set-cookie", `tf_refresh=${refresh}; HttpOnly; SameSite=Strict; Secure; Path=/auth/refresh; Max-Age=2592000`);
  h.append("set-cookie", "tf_csrf=csrf-value; SameSite=Strict; Secure; Path=/; Max-Age=900");
  h.append("set-cookie", "tf_resume=1; HttpOnly; SameSite=Lax; Secure; Path=/; Expires=Wed, 09 Jun 2027 10:18:14 GMT");
  return h;
}

describe("tokensFromSetCookie — the reader that has to survive a comma inside a cookie", () => {
  it("lifts the pair out of a real cookie set", () => {
    const h = sessionCookieHeaders("access-1", "refresh-1");
    // `expiresIn` is the access cookie's Max-Age: the auth client arms the sign-in's first renewal from it.
    expect(tokensFromSetCookie(h.getSetCookie())).toEqual({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresIn: 900,
    });
  });

  it("answers null when the session cookies are absent or empty rather than inventing a pair", () => {
    expect(tokensFromSetCookie(["tf_csrf=x; Path=/"])).toBeNull();
    // A cleared cookie is `name=; Max-Age=0`. Reading that as a token would seal an empty string.
    expect(tokensFromSetCookie(["tf_session=; Max-Age=0", "tf_refresh=; Max-Age=0"])).toBeNull();
    // Half a pair is not a session.
    expect(tokensFromSetCookie(["tf_session=only-access; Path=/"])).toBeNull();
  });
});

/**
 * ═══ THE PKCE PAIR — the thing that makes a code safe to hand back over a URL scheme ════════
 *
 * `ohmail://` is claimed by whichever program on the machine registered it, and nothing
 * authenticates that. So the code the browser mints is bound before it exists: this process invents
 * a verifier, keeps it in memory, and publishes only `sha256(verifier)`. The account refuses to
 * spend the code for any caller that cannot produce the verifier, so an interceptor gets a string
 * worth nothing — and a failed attempt does not consume it either.
 *
 * THE ENCODING IS PINNED, and that is what the first case is for. Every wrong encoding — a hex
 * digest, padded base64, a hash of the DECODED bytes — produces a plausible 43-ish characters that
 * can never match, and the only symptom is a handoff refused with the same sentence an expired code
 * gets. So it is asserted against the hosted side's OWN primitive rather than against a second
 * implementation written here.
 */
describe("the browser handoff's commitment", () => {
  it("is exactly what the account computes over the same string", () => {
    for (const verifier of ["", "a", "hunter2", newDesktopLinkPair().verifier, "ünïcødé"]) {
      expect(challengeFor(verifier), verifier).toBe(hashToken(verifier));
    }
  });

  it("mints 32 bytes of base64url, fresh every time, with a matching digest", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      const { verifier, challenge } = newDesktopLinkPair();
      // 43 characters of base64url — no padding, no `+`, no `/`. The same shape the challenge has
      // and the same shape the account's mint validates, which is why both survive a URL untouched.
      expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(challenge).toBe(challengeFor(verifier));
      // A verifier is a secret; a repeat would mean a code minted for one handoff was claimable by
      // the next.
      expect(seen.has(verifier), "a verifier repeated").toBe(false);
      seen.add(verifier);
    }
  });
});

/**
 * ═══ THE CLAIM CARRIES THE VERIFIER THE ENGINE IS HOLDING, AND NOTHING ELSE ═════════════════
 *
 * ── THE FIELD IS OMITTED, NOT SENT EMPTY ────────────────────────────────────────────────────
 *
 * The hosted side reads an ABSENT verifier as the real predicate "this code was minted unbound".
 * An empty string is a different claim — to hold the verifier for the digest of `""`, which is a
 * challenge somebody could deliberately mint — and it would be refused. Two shapes, and the
 * difference between them is a working handoff and a broken one.
 *
 * ── AND IT COMES FROM THE OPTIONS, WHICH IS WHY THE WIRE CANNOT NAME IT ─────────────────────
 *
 * `verifier` is on `CloudSignInOptions` (composed by the engine from its own memory) and not on
 * `CloudSignInRequest` (JSON that arrived over the bridge). That placement is the whole rule: a
 * caller able to name the verifier a code is claimed with is a caller able to spend an intercepted
 * code, which is precisely the capability the binding exists to withhold.
 */
describe("claiming a handoff code", () => {
  /** A fake hosted API that records the claim body it was sent. */
  function claimRecorder(): { fetchImpl: typeof fetch; bodies: unknown[] } {
    const bodies: unknown[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      if (url.pathname === "/auth/desktop-claim") {
        bodies.push(JSON.parse(String(init?.body ?? "null")));
        return json({ tokens: { accessToken: "a", refreshToken: "r" } });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies };
  }

  it("sends the held verifier beside the code", async () => {
    const { fetchImpl, bodies } = claimRecorder();
    const { verifier } = newDesktopLinkPair();
    await cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl, verifier }, { handoffCode: " code-9 " });
    expect(bodies).toEqual([{ code: "code-9", verifier }]);
  });

  it("OMITS the field entirely when this install is holding no verifier", async () => {
    const { fetchImpl, bodies } = claimRecorder();
    // The retype flow, unchanged: a code minted with no challenge is claimed with no verifier, and
    // the absent branch on the hosted side is a real predicate rather than "no condition".
    await cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl }, { handoffCode: "code-9" });
    // …and an empty or blank one is the same as none, never `verifier: ""`.
    await cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl, verifier: "" }, { handoffCode: "code-9" });
    await cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl, verifier: "   " }, { handoffCode: "code-9" });
    for (const body of bodies) {
      expect(body).toEqual({ code: "code-9" });
      expect(Object.keys(body as object)).toEqual(["code"]);
    }
    expect(bodies).toHaveLength(3);
  });

  it("declares the platform kind beside the code when the engine hands one in — and never invents one", async () => {
    const { fetchImpl, bodies } = claimRecorder();
    const { verifier } = newDesktopLinkPair();
    await cloudSignIn(
      { baseUrl: "https://cloud.test", fetchImpl, verifier, deviceKind: "desktop-linux" },
      { handoffCode: "code-9" },
    );
    expect(bodies).toEqual([{ code: "code-9", verifier, kind: "desktop-linux" }]);
    // Absent option ⇒ absent field (the OMITS test above pins the exact key set), so the hosted
    // side keeps its legacy "macos" reading for an engine that does not know its platform.
  });
});

describe("desktopDeviceKind — what this process is, in the hosted vocabulary", () => {
  it("maps the three shipped platforms and answers null — an honest silence — for the rest", () => {
    expect(desktopDeviceKind("linux")).toBe("desktop-linux");
    expect(desktopDeviceKind("darwin")).toBe("desktop-macos");
    expect(desktopDeviceKind("win32")).toBe("desktop-windows");
    expect(desktopDeviceKind("freebsd")).toBeNull();
    expect(desktopDeviceKind("")).toBeNull();
  });
});

describe("cloudSignIn — the two-step hosted login", () => {
  it("posts login, then the code with the loginToken, and lifts the pair from Set-Cookie", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, body: JSON.parse(String(init!.body)) as Record<string, unknown> });
      if (url.pathname === "/auth/login") {
        return json({ status: "twofa_required", loginToken: "login-token-1", methods: ["totp"] });
      }
      if (url.pathname === "/auth/2fa/totp/verify") {
        // A COOKIE HOST: the tokens are stripped from the body and set as cookies. This is what
        // `api.ohmail.app` actually answers — measured, not assumed.
        return new Response(JSON.stringify({ status: "ok", user: { accountId: ACCOUNT } }), {
          status: 200,
          headers: sessionCookieHeaders("access-1", "refresh-1"),
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const tokens = await cloudSignIn(
      { baseUrl: "https://cloud.test/", fetchImpl },
      { email: " me@ohmail.test ", password: "hunter2", totp: " 123456 " },
    );

    expect(tokens).toEqual({ accessToken: "access-1", refreshToken: "refresh-1", expiresIn: 900 });
    expect(seen.map((s) => s.path)).toEqual(["/auth/login", "/auth/2fa/totp/verify"]);
    // The address and the code are trimmed; the password is passed through untouched, because a
    // trailing space in a password is a character of the password.
    expect(seen[0]!.body).toEqual({ email: "me@ohmail.test", password: "hunter2" });
    // THE FIELD IS `loginToken`. `challengeToken` answers 400 and reads exactly like a wrong code.
    // No `deviceKind` option ⇒ no `kind` field — the exact key set an old engine has always sent.
    expect(seen[1]!.body).toEqual({ loginToken: "login-token-1", code: "123456" });
  });

  it("declares the platform kind on the VERIFY — the login body stays exactly credentials", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, body: JSON.parse(String(init!.body)) as Record<string, unknown> });
      if (url.pathname === "/auth/login") {
        return json({ status: "twofa_required", loginToken: "login-token-1", methods: ["totp"] });
      }
      return new Response(JSON.stringify({ status: "ok", user: { accountId: ACCOUNT } }), {
        status: 200,
        headers: sessionCookieHeaders("access-1", "refresh-1"),
      });
    }) as unknown as typeof fetch;

    await cloudSignIn(
      { baseUrl: "https://cloud.test/", fetchImpl, deviceKind: "desktop-windows" },
      { email: "me@ohmail.test", password: "hunter2", totp: "123456" },
    );

    // The declaration rides the session-establishing request and only that one: the login is a
    // first factor with no session to label, so the kind would be a field nobody reads.
    expect(seen[0]!.body).toEqual({ email: "me@ohmail.test", password: "hunter2" });
    expect(seen[1]!.body).toEqual({ loginToken: "login-token-1", code: "123456", kind: "desktop-windows" });
  });

  it("reads the pair out of the BODY on a bearer-only host, which sets no cookies", async () => {
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(input));
      if (url.pathname === "/auth/login") return json({ status: "twofa_required", loginToken: "lt" });
      return json({ status: "ok", tokens: { accessToken: "body-access", refreshToken: "body-refresh" } });
    }) as unknown as typeof fetch;

    await expect(
      cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl }, { email: "a@b.test", password: "p", totp: "111111" }),
    ).resolves.toEqual({ accessToken: "body-access", refreshToken: "body-refresh" });
  });

  it("refuses an empty field HERE rather than spending a login attempt on it", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      return json({});
    }) as unknown as typeof fetch;
    await expect(
      cloudSignIn({ baseUrl: "https://cloud.test", fetchImpl }, { email: "a@b.test", password: "", totp: "111111" }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(calls, "an empty password reached the hosted service").toBe(0);
  });

  it("names WHICH step the hosted service refused, so a wrong password is not a wrong code", async () => {
    const refuse = (path: string): typeof fetch =>
      (async (input: string | URL | Request): Promise<Response> => {
        const url = new URL(String(input));
        if (url.pathname === path) return json({ error: { code: "unauthorized" } }, 401);
        return json({ status: "twofa_required", loginToken: "lt" });
      }) as unknown as typeof fetch;

    await expect(
      cloudSignIn({ baseUrl: "https://c.test", fetchImpl: refuse("/auth/login") }, { email: "a@b.test", password: "p", totp: "111111" }),
    ).rejects.toMatchObject({ code: "invalid_credentials", status: 401 });

    await expect(
      cloudSignIn({ baseUrl: "https://c.test", fetchImpl: refuse("/auth/2fa/totp/verify") }, { email: "a@b.test", password: "p", totp: "111111" }),
    ).rejects.toMatchObject({ code: "invalid_code", status: 401 });
  });

  it("sends an account with no authenticator to the web rather than half-building enrollment here", async () => {
    const fetchImpl = (async (): Promise<Response> =>
      json({ status: "enrollment", enrollmentToken: "e" })) as unknown as typeof fetch;
    await expect(
      cloudSignIn({ baseUrl: "https://c.test", fetchImpl }, { email: "a@b.test", password: "p", totp: "111111" }),
    ).rejects.toMatchObject({ code: "enrollment_required", status: 409 });
  });

  it("reports an unreachable hosted service as this install's 502, not as a rejected password", async () => {
    const fetchImpl = (async (): Promise<Response> => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const err = await cloudSignIn(
      { baseUrl: "https://c.test", fetchImpl }, { email: "a@b.test", password: "p", totp: "111111" },
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudSignInError);
    expect(err).toMatchObject({ code: "cloud_unreachable", status: 502 });
  });
});

describe("cloudSignIn — the browser handoff, which is ONE request and no password", () => {
  it("posts the code to /auth/desktop-claim and lifts the pair from the body", async () => {
    const seen: Array<{ path: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(input));
      seen.push({ path: url.pathname, body: JSON.parse(String(init?.body ?? "{}")) });
      return json({ tokens: { accessToken: "claimed-access", refreshToken: "claimed-refresh" } });
    }) as unknown as typeof fetch;

    const tokens = await cloudSignIn(
      { baseUrl: "https://cloud.test", fetchImpl }, { handoffCode: "  the-code  " },
    );
    expect(tokens).toEqual({ accessToken: "claimed-access", refreshToken: "claimed-refresh" });
    // ONE request, to the claim route, carrying the TRIMMED code under the field name the API
    // reads. A person retyping a code off a screen picks up whitespace; the field name is the
    // half nobody can see is wrong, because a mis-spelled one answers 400 exactly as a stale
    // code does.
    expect(seen).toEqual([{ path: "/auth/desktop-claim", body: { code: "the-code" } }]);
  });

  it("NEVER touches the password endpoints, even when the body also carries credentials", async () => {
    // The shape that matters: a caller that fills every field. The branch must be decided by the
    // code's presence, not by whichever check happens to run first — otherwise a UI bug that
    // leaves a stale password in state turns a browser sign-in into a login attempt that counts
    // against a lockout.
    const paths: string[] = [];
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      paths.push(new URL(String(input)).pathname);
      return json({ tokens: { accessToken: "a", refreshToken: "r" } });
    }) as unknown as typeof fetch;

    await cloudSignIn({ baseUrl: "https://c.test", fetchImpl }, {
      email: "a@b.test", password: "hunter2", totp: "111111", handoffCode: "code",
    });
    expect(paths).toEqual(["/auth/desktop-claim"]);
  });

  it("a stale or mistyped code is 401 invalid_handoff_code, and a spent limiter stays 429", async () => {
    const answering = (status: number): typeof fetch =>
      (async (): Promise<Response> => json({ error: { code: "invalid_code" } }, status)) as unknown as typeof fetch;

    await expect(
      cloudSignIn({ baseUrl: "https://c.test", fetchImpl: answering(400) }, { handoffCode: "stale" }),
    ).rejects.toMatchObject({ code: "invalid_handoff_code", status: 401 });

    // Kept distinct rather than folded into the refusal above: "wait a few minutes" and "get a
    // fresh code" are different things to do next, and this is exactly the person — four retypes
    // in — who needs to be told which.
    await expect(
      cloudSignIn({ baseUrl: "https://c.test", fetchImpl: answering(429) }, { handoffCode: "stale" }),
    ).rejects.toMatchObject({ code: "rate_limited", status: 429 });
  });

  it("an accepted code that returns no pair is this install's 502, not a silent signed-in state", async () => {
    const fetchImpl = (async (): Promise<Response> => json({ ok: true })) as unknown as typeof fetch;
    await expect(
      cloudSignIn({ baseUrl: "https://c.test", fetchImpl }, { handoffCode: "code" }),
    ).rejects.toMatchObject({ code: "no_session_returned", status: 502 });
  });

  it("a body with neither a code nor full credentials is refused before any request", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => { calls++; return json({}); }) as unknown as typeof fetch;
    await expect(
      cloudSignIn({ baseUrl: "https://c.test", fetchImpl }, { handoffCode: "   " }),
    ).rejects.toMatchObject({ code: "invalid_request", status: 400 });
    expect(calls, "an empty handoff code reached the hosted service").toBe(0);
  });
});

describe("the pre-auth Cloud engine", () => {
  /** A fake hosted API that answers the sign-in, then one page of feed. */
  function fakeCloud(): { fetchImpl: typeof fetch; calls: string[]; messageId: string } {
    const messageId = randomUUID();
    const threadId = randomUUID();
    const calls: string[] = [];
    let bodiesDrained = false;
    const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
      const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      calls.push(url.pathname);
      if (url.pathname === "/auth/login") return json({ status: "twofa_required", loginToken: "lt" });
      if (url.pathname === "/auth/2fa/totp/verify") {
        return new Response(JSON.stringify({ status: "ok" }), {
          status: 200,
          headers: sessionCookieHeaders("access-after-signin", "refresh-after-signin"),
        });
      }
      // WHOSE PAIR THIS IS. The engine asks before it activates anything, because the address in
      // the sign-in body is an input and the browser path sends none at all — see the mirror-owner
      // check in `cloud-engine.ts`. A fake that omits this answers 404 and every sign-in below is
      // refused, which is the guard being on the path rather than a fixture detail.
      if (url.pathname === "/auth/session") return json({ user: { email: "me@ohmail.test" }, scope: "full" });
      // The account's own mailbox. The mirror reads this ahead of every drain — a message can only
      // be filed under a mailbox row that exists — so a signed-in pull without it mirrors nothing.
      if (url.pathname === "/mailboxes") return json(mailboxList([hostedMailbox(MAILBOX, "me@ohmail.test")]));
      if (url.pathname === "/sync") {
        const since = url.searchParams.get("since") ?? "0";
        if (since === "0") {
          return json(syncPage([
            change("thread", threadId, 1, threadDTO(threadId)),
            change("message", messageId, 2, messageDTO(messageId, threadId)),
          ], Buffer.from("2", "utf8").toString("base64url"), false));
        }
        return json(syncPage([], since, false));
      }
      if (url.pathname === "/messages/bodies") {
        if (bodiesDrained) return json({ items: [], nextCursor: null });
        bodiesDrained = true;
        return json({
          items: [{ messageId, text: "the mirrored body", html: null, loadedRemoteContent: false }],
          nextCursor: null,
        } satisfies Page<MessageBodyBatchItem>);
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return { fetchImpl, calls, messageId };
  }

  it("comes up with NO token, serves /health, refuses reads, then signs in and pulls IN PLACE", async () => {
    const { fetchImpl, calls, messageId } = fakeCloud();
    const dataDir = await freshDir();

    // NO `tokens`. Before this slice that was a thrown start; it is now the pre-auth state.
    const sidecar = await createCloudSidecar({
      dataDir,
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      keks: aKek(),
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    expect(sidecar.signedIn()).toBe(false);

    // `start()` on a signed-out engine does nothing and does not throw — the launch path calls it
    // unconditionally, and a throw there would be reported as a failed start.
    await sidecar.start();
    expect(calls, "a signed-out engine dialled the hosted service").toEqual([]);

    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    const health = await sidecar.handle(new Request("http://sidecar/health"));
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true, mode: "cloud", signedIn: false, online: false });

    // EVERY read, including the ones the mirror could answer. See the header.
    for (const path of ["/sync?since=0", "/messages?view=imbox", "/mailboxes"]) {
      const res = await sidecar.handle(new Request(`http://sidecar${path}`, { headers: auth }));
      expect(res.status, path).toBe(409);
      expect((await res.json()).error.code, path).toBe("not_signed_in");
    }

    // The bearer is still the boundary: a signed-out engine does not hand its sign-in surface to
    // an unauthenticated caller either.
    const anon = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      body: JSON.stringify({ email: "a@b.test", password: "p", totp: "111111" }),
    }));
    expect(anon.status).toBe(401);

    // ── THE SIGN-IN ────────────────────────────────────────────────────────────────────────
    const signin = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ email: "me@ohmail.test", password: "hunter2", totp: "123456" }),
    }));
    expect(signin.status).toBe(200);
    expect(await signin.json()).toMatchObject({ status: "signed_in", address: "me@ohmail.test" });
    expect(sidecar.signedIn()).toBe(true);

    // SEALED. The next launch of this data directory needs no token in its environment.
    expect(existsSync(join(dataDir, "cloud-tokens.seal"))).toBe(true);

    // TRANSITIONED IN PLACE: the SAME object now pulls and answers a read. The sign-in's first pull
    // is deliberately not awaited, so poll the local surface rather than assuming it landed.
    let seen = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !seen) {
      const res = await sidecar.handle(new Request(`http://sidecar/messages/${messageId}`, { headers: auth }));
      if (res.status === 200) seen = true;
      else await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen, "the mirror never filled after the in-place sign-in").toBe(true);

    // And the bearer it pulls with is the one the sign-in lifted out of the cookies.
    expect(calls).toContain("/sync");

    // ── A SECOND SIGN-IN IS REFUSED rather than silently rotating the session ────────────────
    const again = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ email: "me@ohmail.test", password: "hunter2", totp: "123456" }),
    }));
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("already_signed_in");
  }, 30_000);

  it("A HANDOFF CODE SEALS AND TRANSITIONS EXACTLY AS THE PASSWORD PATH DOES", async () => {
    // The claim about this slice that is worth an end-to-end test rather than a unit one: the
    // browser path is a different way to obtain the SAME pair, and everything downstream of the
    // pair — sealing it under this install's key, activating the mirror in place, starting the
    // first pull — is the code that already existed and must not have been forked. So this is
    // the password path's test driven with a code, asserting the same four facts.
    const { fetchImpl: cloud, calls, messageId } = fakeCloud();
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      if (url.pathname === "/auth/desktop-claim") {
        calls.push(url.pathname);
        expect(JSON.parse(String(init?.body ?? "{}"))).toEqual({ code: "handoff-code", ...HOST_KIND_FIELD });
        // A bearer-only host: the pair is in the BODY and there are no cookies, which is what
        // `POST /auth/desktop-claim` answers with on every host by design.
        return json({ tokens: { accessToken: "claimed-access", refreshToken: "claimed-refresh" } });
      }
      return cloud(input as never, init as never);
    }) as unknown as typeof fetch;

    const dataDir = await freshDir();
    const sidecar = await createCloudSidecar({
      dataDir,
      cloudUrl: "https://cloud.test",
      // This test's stand-in for the hosted service. A hand-off code is only ever redeemed against
      // the hosted service — on a server the person runs it is a credential for a DIFFERENT server,
      // and the engine refuses it (see the self-hosted case below).
      handoffBase: "https://cloud.test",
      address: "me@ohmail.test",
      keks: aKek(),
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    expect(sidecar.signedIn()).toBe(false);
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    const signin = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ handoffCode: "handoff-code" }),
    }));
    expect(signin.status, await signin.clone().text()).toBe(200);
    expect(await signin.json()).toMatchObject({ status: "signed_in", address: "me@ohmail.test" });
    expect(sidecar.signedIn()).toBe(true);

    // 1. NEITHER PASSWORD ENDPOINT WAS DIALLED. The whole point of the path.
    expect(calls).not.toContain("/auth/login");
    expect(calls).not.toContain("/auth/2fa/totp/verify");
    // 2. SEALED, so the next launch of this data directory needs nothing in its environment.
    expect(existsSync(join(dataDir, "cloud-tokens.seal"))).toBe(true);

    // 3. TRANSITIONED IN PLACE: the same object now answers a read out of a filled mirror.
    let seen = false;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && !seen) {
      const res = await sidecar.handle(new Request(`http://sidecar/messages/${messageId}`, { headers: auth }));
      if (res.status === 200) seen = true;
      else await new Promise((r) => setTimeout(r, 50));
    }
    expect(seen, "the mirror never filled after the handoff sign-in").toBe(true);
    expect(calls).toContain("/sync");

    // 4. And a second sign-in is refused on this path too — the `already_signed_in` fence is
    //    ahead of the branch, not inside the password one.
    const again = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ handoffCode: "handoff-code" }),
    }));
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("already_signed_in");
  }, 30_000);

  /**
   * THE WHOLE HANDOFF, THROUGH THE ENGINE THAT HOLDS THE VERIFIER.
   *
   * The unit tests above prove the pair and the claim body. This proves the part only the engine
   * can: that the verifier it minted is the one the claim carries, that the verifier NEVER leaves
   * this process any other way, and that a caller over the bridge cannot name one.
   *
   * ── THE MUTATIONS THIS WAS WATCHED AGAINST ────────────────────────────────────────────────
   *
   *  · drop `verifier` from the options `cloud-engine.ts` composes → the claim body case goes red,
   *    which is the failure that would ship an unbound claim of a bound code — refused by the
   *    account with a sentence indistinguishable from an expired code;
   *  · read the verifier from `body` instead of the binding → the "the wire cannot name one" case
   *    goes red, and that is the case where an interceptor could spend the code it stole;
   *  · keep the verifier after a successful sign-in → the "spent" case goes red.
   */
  it("mints the commitment HERE, claims with it, and lets no caller supply one", async () => {
    const { fetchImpl: cloud, calls } = fakeCloud();
    const claims: unknown[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const url = new URL(String(typeof input === "string" ? input : input instanceof URL ? input.href : input.url));
      if (url.pathname === "/auth/desktop-claim") {
        calls.push(url.pathname);
        claims.push(JSON.parse(String(init?.body ?? "null")));
        return json({ tokens: { accessToken: "claimed-access", refreshToken: "claimed-refresh" } });
      }
      return cloud(input as never, init as never);
    }) as unknown as typeof fetch;

    const dataDir = await freshDir();
    const sidecar = await createCloudSidecar({
      dataDir,
      cloudUrl: "https://cloud.test",
      // THIS TEST'S STAND-IN FOR THE HOSTED SERVICE, said explicitly. The browser hand-off is
      // refused on any base that is not the hosted one, because the claim it performs carries the
      // PKCE verifier and would hand a third party a spendable pair for the person's hosted
      // account. Production never sets this field; the default is the real address.
      handoffBase: "https://cloud.test",
      address: "me@ohmail.test",
      keks: aKek(),
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };

    // The bearer is the boundary here too — a signed-out engine hands its commitment to nobody.
    const anon = await sidecar.handle(new Request("http://sidecar/cloud/signin/challenge", { method: "POST" }));
    expect(anon.status).toBe(401);

    // ── HALF ONE: THE COMMITMENT ────────────────────────────────────────────────────────────
    const minted = await sidecar.handle(new Request("http://sidecar/cloud/signin/challenge", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    }));
    expect(minted.status, await minted.clone().text()).toBe(200);
    const { challenge } = (await minted.json()) as { challenge: string };
    // The shape the page validates and the account's mint refuses anything else for.
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // NOTHING BUT THE COMMITMENT COMES OUT. A response carrying the verifier would put the secret
    // in the window, in the shell's IPC and in anything that logged a bridge answer.
    const asJson = JSON.parse(JSON.stringify({ challenge }));
    expect(Object.keys(asJson)).toEqual(["challenge"]);
    // The mint dialled nobody: the pair is this process's own.
    expect(calls).toEqual([]);

    // ── HALF TWO: THE CLAIM, WITH A VERIFIER THE CALLER NEVER SAW ───────────────────────────
    //
    // The body carries a `verifier` of its own, and it must be ignored. A bridge caller able to
    // name the verifier is a bridge caller able to spend a code it intercepted.
    const signin = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ handoffCode: "handoff-code", verifier: "attacker-supplied" }),
    }));
    expect(signin.status, await signin.clone().text()).toBe(200);
    expect(sidecar.signedIn()).toBe(true);

    expect(claims).toHaveLength(1);
    const claim = claims[0] as { code: string; verifier?: string };
    expect(claim.code).toBe("handoff-code");
    expect(claim.verifier, "the claim went out unbound — the held verifier was not used")
      .toBeDefined();
    expect(claim.verifier, "the WIRE named the verifier").not.toBe("attacker-supplied");
    // The one relationship that matters: the secret sent is the pre-image of the commitment
    // published. Computed with the hosted side's own primitive, not a second implementation.
    expect(hashToken(claim.verifier!)).toBe(challenge);

    // ── AND IT IS SPENT ─────────────────────────────────────────────────────────────────────
    //
    // Signing out and back in with a code must NOT reuse a commitment the browser has already
    // published. There is no way to read the binding from outside, so this is asserted through the
    // behaviour it produces: the second claim is unbound, because no second mint happened.
    await sidecar.handle(new Request("http://sidecar/cloud/session", { method: "DELETE", headers: auth }));
    expect(sidecar.signedIn()).toBe(false);
    const second = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ handoffCode: "handoff-code-2" }),
    }));
    expect(second.status, await second.clone().text()).toBe(200);
    expect(claims).toHaveLength(2);
    // No verifier; and the family the first sign-in held is named, so the server can end it.
    expect(Object.keys(claims[1] as object).sort(), "a spent commitment was reused")
      .toEqual(["code", ...(HOST_KIND ? ["kind"] : []), "previousSession"].sort());
    expect((claims[1] as { previousSession?: string }).previousSession).toBe(hashToken("claimed-refresh"));
  }, 30_000);

  /**
   * ── A BROWSER HAND-OFF ON A SELF-HOSTED DOOR WOULD HAND OVER THE HOSTED ACCOUNT ─────────────
   *
   * The only page the shell can open is one whose address it owns, and all of them are ohmail.app's.
   * So on a self-hosted base the ceremony sends the browser to the HOSTED service, mints a code
   * there, and then claims it against the OPERATOR's server — and the claim carries the PKCE
   * verifier (`cloudSignIn`'s browser path posts `{code, verifier}`), which is exactly the pair
   * needed to spend that code at ohmail.app. A screen saying "Sign in" would hand a third party a
   * two-minute account-takeover primitive for somebody's hosted account.
   *
   * Refused in the ENGINE and not only in the window, because an install whose session expired
   * renders the shared hosted sign-in surface for any cloud door. Watch it fail: drop the
   * `baseIsForeign` guard from `/cloud/signin/challenge` and this case mints a commitment.
   */
  it("REFUSES a browser handoff when the door is a server the person runs", async () => {
    const { fetchImpl } = fakeCloud();
    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      // A self-hosted base, and `handoffBase` left at its default — so this is exactly the
      // production shape: an operator's own server, and the hand-off page still ours.
      cloudUrl: "https://ohmail.example.com/api",
      address: "me@example.com",
      keks: aKek(),
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    const res = await sidecar.handle(new Request("http://sidecar/cloud/signin/challenge", {
      method: "POST",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: "{}",
    }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("handoff_not_available");
    // NO COMMITMENT CAME OUT, which is the property — a challenge in this answer would already be
    // a digest the page could publish.
    expect(JSON.stringify(body)).not.toContain("challenge");
    // And it names the path that does work on this door rather than only refusing.
    expect(body.error.message).toContain("password");
  }, 30_000);

  /**
   * ── AND FINISHING ONE IS REFUSED TOO, WHICH GUARDING THE MINT ALONE DID NOT COVER ───────────
   *
   * The browser path also accepts a code somebody TYPED IN, and a typed code came from the hosted
   * service. Sent to an operator's server it is a live, spendable credential for the person's
   * hosted account — unbound, so worth less than the bound pair, and still theirs to spend within
   * its couple of minutes. Found by the second review round: the first fix guarded the ceremony
   * that mints a code and left the one that redeems it open.
   */
  it("REFUSES a typed-in Cloud code on a self-hosted door, and never forwards it", async () => {
    const seen: string[] = [];
    const { fetchImpl } = fakeCloud();
    const watched = ((url: string, init?: RequestInit) => {
      seen.push(String(url));
      return (fetchImpl as unknown as typeof fetch)(url as never, init as never);
    }) as unknown as typeof fetch;

    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://ohmail.example.com/api",
      address: "me@example.com",
      keks: aKek(),
      fetchImpl: watched,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    const res = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
      method: "POST",
      headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
      body: JSON.stringify({ handoffCode: "a-code-minted-by-the-hosted-service" }),
    }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("handoff_not_available");
    // THE PROPERTY, not just the status: the code never left this process. A refusal that had
    // already forwarded it would be a refusal after the fact.
    expect(seen.filter((u) => u.includes("desktop-claim"))).toEqual([]);

    /* AND WHATEVER SHAPE THE FIELD ARRIVES IN. The refusal is on PRESENCE, so it cannot drift out
       of step with `cloudSignIn`'s own branch predicate — which yields "" for any non-string and
       would otherwise fall through to the password path with a field nobody had refused. */
    for (const shape of [{ handoffCode: "" }, { handoffCode: 42 }, { handoffCode: { a: 1 } }]) {
      const odd = await sidecar.handle(new Request("http://sidecar/cloud/signin", {
        method: "POST",
        headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify(shape),
      }));
      expect(odd.status, JSON.stringify(shape)).toBe(409);
      expect(((await odd.json()) as { error: { code: string } }).error.code).toBe("handoff_not_available");
    }
    expect(seen.filter((u) => u.includes("desktop-claim"))).toEqual([]);
  }, 30_000);

  /**
   * The relay forwards everything the mirror cannot answer locally, so the hand-off claim reached
   * a self-hosted server through it even while both sign-in routes were guarded.
   *
   * The relay is an allowlist now, so none of these spellings has an entry. Two answers, and both
   * are refusals: a path that CANONICALIZES to the hand-off route gets 409 with the sentence about
   * signing in on your own server; anything else gets the 404 the server itself would give. Case
   * variants are in the second group deliberately — the API compares static segments
   * byte-for-byte, so `/AUTH/Desktop-Claim` is not a route there either.
   *
   * Watch it fail: drop `handoffForeign` from the proxy's construction in `cloud-engine.ts`, or
   * flip a `relay` field in the API's route table.
   */
  it("REFUSES the hand-off claim through the write-through proxy, signed in and online", async () => {
    const seen: string[] = [];
    const { fetchImpl } = fakeCloud();
    const watched = ((url: string, init?: RequestInit) => {
      seen.push(String(url));
      return (fetchImpl as unknown as typeof fetch)(url as never, init as never);
    }) as unknown as typeof fetch;

    // A SELF-HOSTED door with a session already in hand, which is the state the bypass needs: the
    // proxy only forwards once there is a bearer to forward with.
    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://ohmail.example.com/api",
      address: "me@example.com",
      keks: aKek(),
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl: watched,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);

    /* Canonicalizes to the hand-off route → 409 and the sentence. Query strings, trailing and
       repeated slashes, resolved traversal, unreserved escapes, and the one `/api` the server
       strips off itself. */
    for (const path of [
      "/auth/desktop-claim",
      "/auth/desktop-link",
      "/auth/desktop-claim?x=1",
      "/auth/desktop-claim/",
      "/auth/desktop-claim//",
      "//auth//desktop-claim",
      "/x/../auth/desktop-claim",
      "/auth/desktop%2Dclaim",
      "/auth/%64esktop-claim",
      "/%61uth/desktop-claim",
      "/api/auth/desktop-claim",
      "/api/auth/desktop-link",
      "/api/auth/desktop-claim/",
      "/%61pi/auth/desktop-claim",
    ]) {
      const res = await sidecar.handle(new Request(`http://sidecar${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ code: "a-code-minted-by-the-hosted-service", verifier: "v" }),
      }));
      expect(res.status, path).toBe(409);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("handoff_not_available");
    }

    /* A DIFFERENT PATH TO THE SAME REFUSAL. The old guard folded case; the API does not, so these
       are not the hand-off route to it either and the honest answer is its own 404. */
    for (const path of [
      "/AUTH/Desktop-Claim",
      "/API/Auth/Desktop-Claim",
    ]) {
      const res = await sidecar.handle(new Request(`http://sidecar${path}`, {
        method: "POST",
        headers: { authorization: `Bearer ${sidecar.sessionToken}`, "content-type": "application/json" },
        body: JSON.stringify({ code: "a-code-minted-by-the-hosted-service", verifier: "v" }),
      }));
      expect(res.status, path).toBe(404);
      expect(((await res.json()) as { error: { code: string } }).error.code).toBe("not_found");
    }

    // THE PROPERTY, and it covers both groups: nothing carrying that code left this process.
    expect(seen.filter((u) => u.includes("desktop-claim") || u.includes("desktop-link"))).toEqual([]);
  }, 30_000);

  it("refuses to start a handoff for an install that already holds a session", async () => {
    const { fetchImpl } = fakeCloud();
    const sidecar = await createCloudSidecar({
      dataDir: await freshDir(),
      cloudUrl: "https://cloud.test",
      // See the note on the case above: this test's stand-in for the hosted service.
      handoffBase: "https://cloud.test",
      address: "me@ohmail.test",
      keks: aKek(),
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    // Minting one here would leave a live code bound to a process nobody is waiting on — the same
    // fence the sign-in itself is behind, and ahead of the branch rather than inside it.
    const res = await sidecar.handle(new Request("http://sidecar/cloud/signin/challenge", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: "{}",
    }));
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("already_signed_in");
  }, 30_000);

  it("signing out removes the sealed session and FREEZES the mirror rather than deleting it", async () => {
    const { fetchImpl } = fakeCloud();
    const dataDir = await freshDir();
    const sidecar = await createCloudSidecar({
      dataDir,
      cloudUrl: "https://cloud.test",
      address: "me@ohmail.test",
      keks: aKek(),
      tokens: { accessToken: "a", refreshToken: "r" },
      fetchImpl,
      pollIntervalMs: 3_600_000,
    });
    sidecars.push(sidecar);
    await sidecar.start();
    expect(sidecar.signedIn()).toBe(true);
    expect(existsSync(join(dataDir, "cloud-tokens.seal"))).toBe(true);
    const beforeSignOut = readdirSync(dataDir).filter((f) => f !== "cloud-tokens.seal").sort();

    const auth = { authorization: `Bearer ${sidecar.sessionToken}` };
    const out = await sidecar.handle(new Request("http://sidecar/cloud/session", { method: "DELETE", headers: auth }));
    expect(out.status).toBe(200);
    // The sign-out also asks the server to end the session; this fake has no logout door (404), so
    // the server half reads not-ended. The local half below is this case's subject and is unchanged.
    expect(await out.json()).toEqual({ status: "signed_out", revokedAtHost: false, queued: 0 });

    expect(sidecar.signedIn()).toBe(false);
    // THE SEAL IS GONE — a hosted session left on disk after "sign out" is a live credential.
    expect(existsSync(join(dataDir, "cloud-tokens.seal"))).toBe(false);
    // EVERYTHING ELSE IS EXACTLY WHERE IT WAS. The mirror is frozen, not deleted: the mail is on
    // the hosted account, and throwing the mirror away buys a full re-pull and nothing else.
    expect(readdirSync(dataDir).sort()).toEqual(beforeSignOut);

    // And the mirror it still holds is not readable by a window with no hosted session.
    const read = await sidecar.handle(new Request("http://sidecar/messages?view=imbox", { headers: auth }));
    expect(read.status).toBe(409);
  }, 30_000);
});

describe("the door separator holds on the pre-auth path", () => {
  const cloudEnv = (over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
    OHMAIL_DATA_DIR: "/tmp/does-not-need-to-exist",
    OHMAIL_CLOUD_URL: "https://cloud.test",
    OHMAIL_MAILBOX_ADDRESS: "me@ohmail.test",
    ...over,
  });

  it("a TOKEN-LESS cloud configuration is accepted — the credential is not a launch requirement", () => {
    const cfg = cloudConfigFromEnv(cloudEnv());
    expect(cfg.cloudUrl).toBe("https://cloud.test");
    expect(cfg.address).toBe("me@ohmail.test");
    expect(cfg.tokens).toBeUndefined();
  });

  it("and it is STILL refused when any OHMAIL_IMAP_* is present, token or no token", () => {
    // The tempting relaxation: "there is no session here anyway, so an IMAP variable is harmless".
    // It is not — a launch that reached the IMAP path would become a SECOND organizer of a mailbox
    // the hosted worker already holds, and having no cloud session makes that more likely, not less.
    expect(() => cloudConfigFromEnv(cloudEnv({ OHMAIL_IMAP_HOST: "imap.example.test" })))
      .toThrow(/OHMAIL_IMAP_HOST/);
    expect(() => cloudConfigFromEnv(cloudEnv({ OHMAIL_IMAP_USER: "someone@example.test" })))
      .toThrow(/never opens IMAP/);
    // An empty value is absent, so a launcher that materializes every declared variable still starts.
    expect(() => cloudConfigFromEnv(cloudEnv({ OHMAIL_IMAP_HOST: "  " }))).not.toThrow();
  });

  it("carries the paired desktop's fingerprint through, and reads a blank one as absent", () => {
    const pin = "A".repeat(43);
    expect(cloudConfigFromEnv(cloudEnv({ OHMAIL_HOST_PIN: pin })).hostPin).toBe(pin);
    // Trimmed, because the shell composes this from a value it read out of a settings file and a
    // stray newline there must not become a fingerprint that matches nothing.
    expect(cloudConfigFromEnv(cloudEnv({ OHMAIL_HOST_PIN: ` ${pin}\n` })).hostPin).toBe(pin);

    // ABSENT MEANS UNPINNED, and that is correct for the two doors that predate this one — the
    // hosted service and a self-host box are verified against the platform's trust store. It is
    // never a fallback for a desktop host: an unpinned desktop-host door cannot authenticate what
    // answers at all, which is why the shell writes the pin and the door together.
    expect(cloudConfigFromEnv(cloudEnv()).hostPin).toBeUndefined();
    expect(cloudConfigFromEnv(cloudEnv({ OHMAIL_HOST_PIN: "   " })).hostPin).toBeUndefined();
  });

  it("a PAIRED door needs no mailbox address, and every other cloud door still does", () => {
    const pin = "C".repeat(43);
    /* A pairing link names a COMPUTER. Which mailboxes this install reads is the host's answer to
       the redeem, so there is nothing to configure — and before this the engine refused to start,
       which meant a paired door could not boot at all. */
    const paired = cloudConfigFromEnv({
      OHMAIL_DATA_DIR: "/tmp/does-not-need-to-exist",
      OHMAIL_CLOUD_URL: "https://desk.tail1234.ts.net",
      OHMAIL_HOST_PIN: pin,
    });
    // NULL AND NOT "". An empty string is an address that was configured and is blank, which
    // matches nothing — a mirror recorded that way is discarded on every single launch.
    expect(paired.address).toBeNull();
    expect(paired.hostPin).toBe(pin);

    /* AND THE REFUSAL IS UNCHANGED WHERE IT ALWAYS WAS. This is the half a careless fix loses: if
       the door kind were inferred from the ABSENCE of the address, a hosted launch that lost its
       address — a truncated settings file, a launcher that dropped a variable — would come up as
       an address-less mirror instead of refusing. The discriminator is the PIN, a positive fact
       the shell writes for this door only. */
    expect(() => cloudConfigFromEnv(cloudEnv({ OHMAIL_MAILBOX_ADDRESS: "" })))
      .toThrow(/OHMAIL_MAILBOX_ADDRESS/);
    expect(() => cloudConfigFromEnv({
      OHMAIL_DATA_DIR: "/tmp/does-not-need-to-exist",
      OHMAIL_CLOUD_URL: "https://api.ohmail.app",
    })).toThrow(/OHMAIL_MAILBOX_ADDRESS/);
  });

  it("composes NO fetchImpl, so the test seam cannot be reached from a configuration", () => {
    /* `hostPin` only pins when there is no injected transport — an explicit `fetchImpl` wins, which
       is what lets a test drive the engine without a TLS server. That is safe only while nothing a
       person can write produces one, so the property is asserted here rather than assumed: this
       function is the only thing that turns an environment into a `CloudSidecarConfig`. */
    for (const env of [cloudEnv(), cloudEnv({ OHMAIL_HOST_PIN: "B".repeat(43) })]) {
      expect(cloudConfigFromEnv(env).fetchImpl).toBeUndefined();
      expect(Object.keys(cloudConfigFromEnv(env))).not.toContain("fetchImpl");
    }
  });
});

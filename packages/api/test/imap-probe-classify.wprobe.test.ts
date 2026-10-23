import { describe, it, expect } from "vitest";
import { verdictFor, probeAdmissionKey } from "../src/imap-probe.js";

/**
 * **THE SPECIMEN TABLE**, and the reason it is a table rather than a socket.
 *
 * `verdictFor` is a second copy of the ORDER in `classifyMailboxError`
 * (`apps/worker/src/mailboxes.ts:568`). It has to be one: `packages/api` may not import
 * `apps/worker`, and neither that file nor `packages/db/src/mailbox-errors.ts` — where the
 * classifier belongs, next to the taxonomy it emits — is editable in this slice. So the drift is
 * pinned here instead, on the shapes that actually distinguish the two orders.
 *
 * EVERY SPECIMEN CARRIES `authenticationFailed: true`, deliberately. imapflow stamps it on EVERY
 * failure of the LOGIN command, unconditionally (`lib/commands/login.js:38`), and a probe IS a
 * LOGIN — so a fixture without the flag would exercise a branch this code path can barely reach
 * and would leave the flag's position, which is the whole of that change, untested. Move the flag
 * check back above the structural probes and every row below flips to `auth`.
 */

interface Specimen {
  readonly what: string;
  readonly err: Record<string, unknown>;
  readonly verdict: "ok" | "store_unverified" | "refuse";
  readonly code: string;
}

const SPECIMENS: readonly Specimen[] = [
  // ── REFUSED: the server was reached and it rejected these credentials ──────────────────
  {
    what: "a bare tagged `NO Login failed.` — no atom, no errno, so the flag is the only evidence",
    err: { authenticationFailed: true, message: "Login failed." },
    verdict: "refuse", code: "auth",
  },
  {
    what: "RFC 5530 AUTHENTICATIONFAILED",
    err: { authenticationFailed: true, serverResponseCode: "AUTHENTICATIONFAILED" },
    verdict: "refuse", code: "auth",
  },
  {
    what: "AUTHORIZATIONFAILED — authenticated, not permitted to act as this user",
    err: { authenticationFailed: true, serverResponseCode: "AUTHORIZATIONFAILED" },
    verdict: "refuse", code: "auth",
  },
  {
    what: "a server with no structured marker at all, saying so in prose",
    err: { authenticationFailed: true, message: "Invalid credentials" },
    verdict: "refuse", code: "auth",
  },

  // ── REFUSED: nothing answered, so nothing about this configuration is proven ───────────
  {
    what: "THE HEADLINE CASE — a mistyped host does not resolve",
    err: { authenticationFailed: true, code: "ENOTFOUND" },
    verdict: "refuse", code: "connect",
  },
  {
    what: "a port with nothing behind it",
    err: { authenticationFailed: true, code: "ECONNREFUSED" },
    verdict: "refuse", code: "connect",
  },
  {
    what: "our own resolver having a bad moment — still unproven, still refused",
    err: { authenticationFailed: true, code: "EAI_AGAIN" },
    verdict: "refuse", code: "connect",
  },
  {
    what: "a certificate that does not match the typed hostname",
    err: { authenticationFailed: true, code: "ERR_TLS_CERT_ALTNAME_INVALID" },
    verdict: "refuse", code: "tls",
  },
  {
    what: "an expired certificate",
    err: { authenticationFailed: true, code: "CERT_HAS_EXPIRED" },
    verdict: "refuse", code: "tls",
  },
  {
    what: "cleartext on an implicit-TLS port, which OpenSSL reports as a version mismatch",
    err: { authenticationFailed: true, code: "ERR_SSL_WRONG_VERSION_NUMBER" },
    verdict: "refuse", code: "tls",
  },
  {
    what: "imapflow's own connect deadline",
    err: { authenticationFailed: true, code: "CONNECT_TIMEOUT" },
    verdict: "refuse", code: "timeout",
  },
  {
    what: "a greeting that never came",
    err: { authenticationFailed: true, code: "GREETING_TIMEOUT" },
    verdict: "refuse", code: "timeout",
  },

  // ── STORED UNVERIFIED: contact was made and the server declined to serve it now ────────
  {
    what: "a tagged `NO [LIMIT]` — an implementation limit, which a per-account cap is",
    err: { authenticationFailed: true, serverResponseCode: "LIMIT" },
    verdict: "store_unverified", code: "connect",
  },
  {
    what: "a tagged `NO [UNAVAILABLE]` — a subsystem is temporarily down",
    err: { authenticationFailed: true, serverResponseCode: "UNAVAILABLE" },
    verdict: "store_unverified", code: "connect",
  },
  {
    what: "THE COMMON iCLOUD SHAPE — `BYE [UNAVAILABLE]` whose atom the library discarded, so the "
      + "login rejects with a bare connection error and there is no code left to promote",
    err: { authenticationFailed: true, code: "EConnectionClosed" },
    verdict: "store_unverified", code: "connect",
  },
  {
    what: "a close landing while the connect promise is still pending, after TLS came up",
    err: { authenticationFailed: true, code: "ClosedAfterConnectTLS" },
    verdict: "store_unverified", code: "connect",
  },
  {
    what: "Office 365 throttling — a TAGGED reply, so the server both answered and explained",
    err: { authenticationFailed: true, code: "ETHROTTLE", throttleReset: 30 },
    verdict: "store_unverified", code: "connect",
  },

  // ── AND THE CATCH-ALL, WHICH MUST NOT BE PERMISSION ───────────────────────────────────
  {
    what: "an atom nobody knows — a hostile server may not talk us out of the safe answer",
    err: { authenticationFailed: true, serverResponseCode: "SECRETPASSWORD123" },
    verdict: "refuse", code: "auth",
  },
  {
    what: "an unnamed throw",
    err: { message: "something else entirely" },
    verdict: "refuse", code: "unknown",
  },
  {
    what: "OVERQUOTA at login stays where the worker leaves it: the flag's answer, not `storage`",
    err: { authenticationFailed: true, serverResponseCode: "OVERQUOTA" },
    verdict: "refuse", code: "auth",
  },
];

describe("the probe's classifier, specimen by specimen", () => {
  for (const s of SPECIMENS) {
    it(`${s.verdict}/${s.code} — ${s.what}`, () => {
      const got = verdictFor(Object.assign(new Error("login failed"), s.err));
      expect(got.verdict).toBe(s.verdict);
      expect((got as { code?: string }).code).toBe(s.code);
    });
  }

  /**
   * The two sets that split the `connect` class must stay DISJOINT. They are the only place this
   * file decides whether a credential is stored, and a code that appeared in both would resolve
   * by source order rather than by meaning — a silent, and permanent, wrong answer.
   */
  it("no error code is both 'the server declined' and 'nothing answered'", () => {
    const busy = ["NoConnection", "EConnectionClosed", "ClosedAfterConnectText", "ClosedAfterConnectTLS", "ETHROTTLE"];
    const unreachable = ["ECONNREFUSED", "ENOTFOUND", "EHOSTUNREACH", "EHOSTDOWN", "ENETUNREACH",
      "ENETDOWN", "ECONNRESET", "EPIPE", "EAI_AGAIN", "EADDRNOTAVAIL"];
    for (const code of busy) {
      expect(verdictFor({ code, authenticationFailed: true }).verdict, code).toBe("store_unverified");
    }
    for (const code of unreachable) {
      expect(verdictFor({ code, authenticationFailed: true }).verdict, code).toBe("refuse");
    }
    expect(busy.filter((c) => unreachable.includes(c))).toEqual([]);
  });

  it("a null or undefined throw is refused, not treated as a success", () => {
    expect(verdictFor(null)).toEqual({ verdict: "refuse", code: "unknown" });
    expect(verdictFor(undefined)).toEqual({ verdict: "refuse", code: "unknown" });
  });

  /** The admission key is a digest of the identity — never the identity. */
  it("the admission key carries no address", () => {
    const key = probeAdmissionKey("acct-1", "Mila@Example.Test");
    expect(key).not.toContain("Example");
    expect(key).not.toContain("mila");
    expect(key).toMatch(/^probe:[0-9a-f]{64}$/);
    // Case-folded, so one mailbox typed two ways shares one budget — as mail 0021's index folds.
    expect(probeAdmissionKey("acct-1", "mila@example.test")).toBe(key);
    // …and scoped per account, so one account cannot spend another's budget for an address.
    expect(probeAdmissionKey("acct-2", "mila@example.test")).not.toBe(key);
  });
});

/**
 * GOOGLE'S REFUSAL, NAMED — only with the host, only on `auth`. The two callers that pass no host
 * (`mailbox-self-check.ts`, `mail-server-refusal.ts`) and every other host get today's verdict.
 */
describe("verdictFor with a host: Google's sub-kind on `auth` only", () => {
  const appPassword = { authenticationFailed: true, serverResponseCode: "ALERT", responseText: "Application-specific password required: https://support.google.com/accounts/answer/185833 (Failure)" };
  const webAlert = { authenticationFailed: true, serverResponseCode: "WEBALERT", responseText: "Web login required." };

  it("a Google host: the hint rides the auth refusal", () => {
    expect(verdictFor(appPassword, "imap.gmail.com")).toEqual({ verdict: "refuse", code: "auth", authHint: "app_password_required" });
    expect(verdictFor(webAlert, "imap.gmail.com")).toEqual({ verdict: "refuse", code: "auth", authHint: "web_login" });
  });

  it("no host, or another host: the verdict of before, byte for byte", () => {
    for (const err of [appPassword, webAlert]) {
      expect(verdictFor(err)).toEqual({ verdict: "refuse", code: "auth" });
      expect(verdictFor(err, "imap.example.test")).toEqual({ verdict: "refuse", code: "auth" });
    }
  });

  it("a Google host that throttles or cannot be reached carries no hint", () => {
    expect(verdictFor({ authenticationFailed: true, serverResponseCode: "THROTTLED" }, "imap.gmail.com"))
      .toEqual(verdictFor({ authenticationFailed: true, serverResponseCode: "THROTTLED" }));
    expect(verdictFor({ authenticationFailed: true, code: "ECONNREFUSED" }, "imap.gmail.com")).toEqual({ verdict: "refuse", code: "connect" });
  });
});

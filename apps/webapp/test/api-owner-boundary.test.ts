/** @vitest-environment jsdom */
/**
 * ═══ EVERY CLOUD CALL SPEAKS FOR ONE ACCOUNT ══════════════════════════════════════════════
 *
 * The mail mirror's gate wraps the ENGINE'S ADAPTER, which is the wrong shape for most of the
 * signed-in product: Settings never goes near an adapter. So a browser signed into A that came
 * to hold B's session kept the mailbox correctly stopped — and left every pane beside it talking
 * to the new session. Security would show and REGENERATE the other account's recovery codes and
 * TOTP secret; Devices would list their devices and mint a fresh pairing token; billing, profile,
 * mailboxes and invitations the same. Credentials, not mail, and no amount of gating inside the
 * sync scheduler reaches them.
 *
 * `api()` is the seam every one of them already goes through, so the check lives there. What is
 * pinned here:
 *
 *  1. bound and holding → requests go out (the control; without it every refusal below is green
 *     over a client that was inert);
 *  2. bound and the marker names somebody else, says a sign-out was refused, or has gone silent
 *     → refused before the request, and refused again if the jar changes mid-flight;
 *  3. the SIGN-IN CEREMONY is never refused — a person completing a sign-in has no confirmed
 *     owner by definition, and locking the front door would be a worse failure than the one this
 *     closes;
 *  4. the ceremony allow-list is exactly the ceremony: credential MANAGEMENT under `/auth`
 *     (enrolment, step-up, device pairing) is gated like everything else, which is the
 *     distinction the obvious "allow all of /auth" would have got wrong.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.NEXT_PUBLIC_API_BASE = "/api";

const A = "acct_A";
const B = "acct_B";

const json = (body: unknown, status = 200, account?: string | null): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      // `X-Ohmail-Account` names the account the answer was produced for. A correct server sends
      // it on every response that resolved a session, so the DEFAULT stub below sends it too —
      // a fixture that omitted it would be modelling a server that does not exist any more, and
      // every case here would then be measuring the absence rule instead of what it is about.
      ...(account === undefined || account === null ? {} : { "X-Ohmail-Account": account }),
    },
  });

/** The account the cookie names right now — what a server would resolve this request to. */
const cookieAccount = (): string | null => {
  const m = /(?:^|;\s*)tf_owner=([^;]*)/.exec(document.cookie);
  const v = m?.[1] ?? "";
  return v === "" ? null : v;
};

/** Set for one test to make the server answer for somebody other than the cookie's account. */
let answerAccount: string | null | undefined = undefined;

let asked: string[] = [];
let originalFetch: typeof globalThis.fetch;
/** Runs inside the fetch handler, so a test can move the jar while a request is in flight. */
let duringFlight: (() => void) | null = null;

function setOwnerCookie(value: string | null): void {
  document.cookie = value === null
    ? "tf_owner=; Path=/; Max-Age=0"
    : `tf_owner=${value}; Path=/`;
}

beforeEach(async () => {
  asked = [];
  duringFlight = null;
  answerAccount = undefined;
  const { setAccountHeaderCapability } = await import("../app/api-client.js");
  setAccountHeaderCapability(null);
  setOwnerCookie(null);
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (input: unknown) => {
    const url = String(input);
    asked.push(url);
    /* A SERVER THAT ADVERTISES THE HEADER. `features.accountHeader` is where the real one says
       it (`GET /hello`), and an older server simply lacks the key — so this file negotiates the
       capability the way the product does rather than setting the flag by hand. What the three
       states do is `account-header-capability.test.tsx`; this file is about the comparison once
       it applies, and it needs a server that has asked for it. */
    if (url.includes("/hello")) {
      return json({
        product: "ohmail", flavor: "managed", needsSetup: false,
        features: { staging: false, ai: false, pairing: false, accountHeader: true },
      }, 200);
    }
    // The account is read BEFORE the in-flight switch, because that is when a server resolves
    // the session: the request arrived under whoever the jar named as it left.
    const resolved = answerAccount === undefined ? cookieAccount() : answerAccount;
    duringFlight?.();
    return json({ ok: true }, 200, resolved);
  }) as unknown as typeof globalThis.fetch;

  /* …and only NOW ask the server what it is: the stub has to be installed first, or this reaches
     the real `fetch`, answers null, and every case below runs against a client that never
     negotiated — passing the ones that expect an admission for exactly the wrong reason. */
  const { serverHello } = await import("../app/hello.js");
  await serverHello();
  asked.length = 0;
});

afterEach(async () => {
  const { bindApiOwner } = await import("../app/api-client.js");
  bindApiOwner(null);
  setOwnerCookie(null);
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("the storage-owner boundary", () => {
  it("is OFF on a genuinely public surface", async () => {
    const { api } = await import("../app/api-client.js");
    setOwnerCookie(null);
    // The marketing pages and `/login`: there is no account here and nothing to be wrong about.
    // What this case does NOT say any more is that an UNBOUND client is safe — review pointed out
    // that the earlier version asserted exactly that, and a named shell awaiting confirmation was
    // in the same state. See the two cases below.
    await expect(api("/mailboxes")).resolves.toBeTruthy();
    expect(asked.length).toBe(1);
  });

  /**
   * ═══ A NAMED SHELL IS NEVER A PUBLIC SURFACE ══════════════════════════════════════════════
   *
   * The sequence: a deep-linked settings pane opens over the remembered mirror for A. It mounts,
   * renders and issues requests while `/auth/session` is still in flight. Another tab establishes
   * B in that window. Security, Devices, Billing and Mailboxes all mount there — and a freshly
   * signed-in B is exactly when a step-up window is open, which is what puts recovery-code
   * generation and TOTP enrolment inside it.
   *
   * `pending` is what `null` used to be, minus the permission.
   */
  it("refuses an account read while a NAMED shell is still awaiting its confirmation", async () => {
    const { api, pendApiOwner, ApiError } = await import("../app/api-client.js");
    setOwnerCookie(A);
    pendApiOwner(A);                       // what CloudShell does on its first render
    await expect(api("/mailboxes"), "a pending shell could not read its own account")
      .resolves.toBeTruthy();
    expect(asked.length, "the control never issued a request").toBe(1);

    setOwnerCookie(B);                     // the other tab signs in, confirmation still in flight
    for (const path of ["/auth/2fa/recovery-codes", "/auth/2fa/totp/enroll", "/devices", "/mailboxes"]) {
      await expect(api(path), `${path} answered before this shell had been confirmed`)
        .rejects.toBeInstanceOf(ApiError);
    }
    expect(asked.length, "a request reached the wire from an unconfirmed shell").toBe(1);
  });

  /**
   * A COLD shell — no remembered account — cannot yet say WHICH account, and still fails closed on
   * a marker that names nobody. That is the half that matters: the states this reached through
   * were an absent marker and a refused sign-out, not a marker naming somebody else.
   */
  it("a pending shell with no remembered account still refuses a silent marker", async () => {
    const { api, pendApiOwner } = await import("../app/api-client.js");
    const { OWNER_SIGNED_OUT } = await import("../app/shell/owner-cookie.js");
    setOwnerCookie(A);
    pendApiOwner(null);
    await expect(api("/mailboxes"), "a cold shell could not read at all").resolves.toBeTruthy();

    // REFUSED EITHER WAY, and each says which way. Both of these used to answer with the
    // sentence about ANOTHER account — the state a person with one account can never be in.
    setOwnerCookie(null);
    await expect(api("/mailboxes")).rejects.toThrow(/lost the name of the account/);
    setOwnerCookie(OWNER_SIGNED_OUT);
    await expect(api("/mailboxes")).rejects.toThrow(/sign-out was asked for/);
    expect(asked.length).toBe(1);
  });

  /**
   * ═══ A REFUSED SIGN-OUT BLOCKS, IT DOES NOT UNBIND ════════════════════════════════════════
   *
   * Sign-out writes the safe marker precisely so another window stops trusting a session the
   * server would not revoke — and then unbound the client one line later, which turned the
   * boundary off for every pane mounted afterwards. The remedy waved through the sequence it
   * exists to stop.
   */
  it("blocks every account surface after a sign-out the server would not confirm", async () => {
    const { api, bindApiOwner, blockApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    blockApiOwner();
    for (const path of ["/mailboxes", "/devices", "/auth/2fa/recovery-codes", "/account"]) {
      await expect(api(path), `${path} answered after a refused sign-out`)
        .rejects.toThrow(/sign-out was asked for/);
    }
    expect(asked).toEqual([]);

    // …and the way OUT stays open: the logout retry (the web presses the door below the refresh
    // path), and the sign-in that follows.
    for (const path of ["/auth/logout", "/auth/refresh/logout", "/hello"]) {
      await expect(api(path), `${path} was refused, so the person cannot recover`).resolves.toBeTruthy();
    }
    // A pending shell mounting afterwards must not lift the block.
    const { pendApiOwner } = await import("../app/api-client.js");
    pendApiOwner(A);
    await expect(api("/mailboxes"), "a remount lifted the block").rejects.toThrow(/sign-out was asked for/);
  });

  /**
   * ═══ …AND A SIGN-IN THAT SUCCEEDS DOES LIFT IT, WHICH IS WHAT THE BLOCK IS FOR ═══════════
   *
   * The block's own rule is "fail closed until somebody signs in again". Before the account
   * header there was nothing on a sign-in response that could say somebody had, so the block was
   * lifted by the classifier a round trip later. The header says it in the answer: a credential
   * route that names an account IS the sign-in, and the account it names is the new owner.
   *
   * Split from the case above rather than folded into it, because a `/auth/login` in the middle
   * of that loop silently lifted the block and made its last assertion — "a remount must not lift
   * it" — pass over a client that was no longer blocked at all.
   */
  it("a sign-in that names an account lifts a refused sign-out's block; one that names none does not", async () => {
    const { api, blockApiOwner, apiOwnerBinding } = await import("../app/api-client.js");
    setOwnerCookie(A);
    blockApiOwner();

    // A challenge, not a session: `twofa_required` establishes nothing and names nobody.
    answerAccount = null;
    await expect(api("/auth/login", { method: "POST" })).resolves.toBeTruthy();
    expect(apiOwnerBinding().kind, "a sign-in that established nothing lifted the block")
      .toBe("blocked");

    // The second factor lands and the server names the account it resolved to.
    answerAccount = B;
    await expect(api("/auth/2fa/totp/verify", { method: "POST" })).resolves.toBeTruthy();
    expect(apiOwnerBinding(), "the completed sign-in did not become the client's account")
      .toEqual({ kind: "bound", owner: B });
    expect(document.cookie, "the marker still names the account that signed OUT").toContain(`tf_owner=${B}`);
  });

  it("lets a bound client through while the browser still holds its account", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    await expect(api("/mailboxes")).resolves.toBeTruthy();
    expect(asked.length, "the control never issued a request").toBe(1);
  });

  it("refuses every account surface once the browser holds a different account", async () => {
    const { api, bindApiOwner, ApiError } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    setOwnerCookie(B);
    /* The panes review named, by the routes they call. Credentials first: these are the ones
       that are worse than mail, because they are reusable and cannot be un-shown. */
    for (const path of [
      "/auth/2fa/recovery-codes",          // Security: generate and RENDER raw recovery codes
      "/auth/2fa/totp/enroll",             // Security: a fresh TOTP secret
      "/auth/desktop-link",                // Devices: mint a pairing token
      "/auth/step-up/webauthn/options",    // any sensitive action's re-authentication
      "/devices",
      "/mailboxes",
      "/billing/subscription",
      "/account",
      "/invites",
      "/messages/m1/body",
    ]) {
      await expect(api(path), `${path} answered under another account's session`)
        .rejects.toBeInstanceOf(ApiError);
    }
    expect(asked, "a request reached the wire under another account's session").toEqual([]);
  });

  it("refuses when a sign-out was asked for and the server did not confirm it", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    const { OWNER_SIGNED_OUT } = await import("../app/shell/owner-cookie.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    setOwnerCookie(OWNER_SIGNED_OUT);
    await expect(api("/mailboxes")).rejects.toThrow(/sign-out was asked for/);
    expect(asked).toEqual([]);
  });

  it("refuses when the marker has gone silent under a bound client", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    setOwnerCookie(null);
    /* Absence is silence, and silence is not a contradiction — that rule is about a mirror
       deciding whether to OPEN. A client that has already been told which account it speaks for
       is in a different position: it can no longer prove anything, and the sequence that puts it
       here is a sign-out whose server call failed — or, far more often, a cookie the browser
       simply lost, which is why the sentence names THAT state and the reload that undoes it
       rather than an account nobody is signed in to. */
    await expect(api("/mailboxes")).rejects.toThrow(/lost the name of the account/);
    expect(asked).toEqual([]);
  });

  it("discards an answer whose session changed while it was in flight", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    duringFlight = () => setOwnerCookie(B);
    await expect(api("/mailboxes"), "an answer issued across a session change was returned")
      .rejects.toThrow(/different account/);
    expect(asked.length, "the request never left, so nothing was discarded").toBe(1);
  });

  /**
   * ═══ A RECOVERABLE FAILURE MUST NOT REFRESH SOMEBODY ELSE'S SESSION ══════════════════════
   *
   * `api()` recovers from a 401 by refreshing once and retrying once. The storage-owner recheck sat only
   * AFTER the refresh, so a request that left under A and came back recoverable while another tab
   * established B went on to refresh — and therefore ROTATE and extend — B's session from a stale
   * A tab.
   *
   * No byte is returned either way, and that is not the whole cost: the rotation consumes B's
   * refresh token, so B's own tab can present a consumed one and be read as reuse — which is how
   * a family gets revoked and a real person gets signed out.
   */
  it("does not refresh a foreign session when a recoverable failure comes back", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    // A recoverable answer, with the jar changing hands while the request is in flight.
    globalThis.fetch = vi.fn(async (input: unknown) => {
      asked.push(String(input));
      if (String(input).includes("/auth/refresh")) return new Response(null, { status: 204 });
      setOwnerCookie(B);
      return json({ error: { code: "unauthorized", message: "no" } }, 401);
    }) as unknown as typeof globalThis.fetch;

    await expect(api("/mailboxes")).rejects.toThrow(/different account/);
    expect(asked.filter((u) => u.includes("/auth/refresh")),
      "a stale tab rotated another account's session while recovering").toEqual([]);
    expect(asked.length, "the first request never left, so nothing was recovered from").toBe(1);
  });

  it("never refuses the sign-in ceremony", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    setOwnerCookie(B);
    /* Somebody is signing in. They have no confirmed owner by definition, and every one of these
       is how an identity is established, ended, or learned about. Refusing them would lock the
       front door on exactly the person trying to fix the state this check is complaining about. */
    for (const path of [
      "/hello",
      // Asked BEFORE `/auth/login`, whose answer names the jar's account and rebinds the client:
      // after it, every entry below holds whatever the lists say.
      "/auth/refresh/logout",
      "/auth/login",
      "/auth/register",
      "/auth/refresh",
      "/auth/logout",
      "/auth/verify-email",
      "/auth/2fa/totp/verify",
      "/auth/2fa/recovery-codes/verify",
      "/auth/2fa/webauthn/assert/options",
      "/auth/2fa/webauthn/assert/verify",
    ]) {
      await expect(api(path), `${path} was refused during a sign-in`).resolves.toBeTruthy();
    }
    expect(asked.length).toBe(11);
  });

  /**
   * ═══ `/auth/session` IS TWO REQUESTS WEARING ONE PATH ═════════════════════════════════════
   *
   * The FRONT DOOR asks it to find out whether this browser holds a session at all — necessarily
   * before anybody could be bound, so it must be exempt. Six ORDINARY SHELL READS ask it for the
   * signed-in person's email, account id and enrolled factors: `MailboxSection`,
   * `AccountSection`, `LinkDesktopScreen`, `StepUpPrompt`, `SecuritySection` — and, while the
   * defect stood, the Subscription pane that has since left.
   * While the exemption was on the PATH, all six got the other account's answer whenever the
   * browser had become somebody else — email and account id are not mail, and they are not
   * nothing either.
   *
   * The exemption is on the REQUEST now: something a caller asks for by name, and something a
   * reviewer can grep for.
   */
  it("gates ordinary session reads and exempts only the front door's", async () => {
    const { api, bindApiOwner, ApiError } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    setOwnerCookie(B);

    await expect(api("/auth/session"), "an ordinary shell session read answered for another account")
      .rejects.toBeInstanceOf(ApiError);
    expect(asked, "the shell read reached the wire").toEqual([]);

    // …and the classifier's own call still goes, or the front door is locked on exactly the
    // person who needs to get back in.
    await expect(api("/auth/session", { ceremony: true })).resolves.toBeTruthy();
    expect(asked.length).toBe(1);
  });

  /**
   * THE DISTINCTION THE OBVIOUS ALLOW-LIST WOULD HAVE GOT WRONG, as its own case because it is
   * the one design decision in this file. Half of `/auth` establishes an identity and half
   * manages the credentials of one that already exists — and the second half contains two of the
   * exact disclosures this boundary was built for. `verify` passes; `enroll` does not.
   */
  it("gates credential MANAGEMENT under /auth even though the ceremony is exempt", async () => {
    const { apiOwnerHolds, bindApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    setOwnerCookie(B);
    for (const open of ["/auth/2fa/totp/verify", "/auth/2fa/webauthn/assert/verify"]) {
      expect(apiOwnerHolds(open), `${open} must stay open — it is the sign-in's second factor`)
        .toBe(true);
    }
    for (const shut of [
      "/auth/2fa/totp", "/auth/2fa/totp/enroll", "/auth/2fa/totp/activate",
      "/auth/2fa/recovery-codes",
      "/auth/2fa/webauthn/register/options", "/auth/2fa/webauthn/register/verify",
      "/auth/step-up/totp", "/auth/step-up/webauthn/options", "/auth/step-up/webauthn/verify",
      "/auth/desktop-link",
    ]) {
      expect(apiOwnerHolds(shut), `${shut} is credential management and must be gated`).toBe(false);
    }
  });
});

/**
 * ═══ THE SIGN-OUT PRESS'S OWN WAKE ROW, UNDER ITS OWN PENDING MARKER ═══════════════════════════
 *
 * The press writes the reserved word before it revokes the wake registration, so a tab opened during
 * the request is sent to the sign-in page. The row's DELETE still needs the session the press is
 * ending: it passes on that one path, with the reserved word in the jar, from a client bound (or
 * pending) to the account the jar named at the press. Anything else is today's refusal.
 */
describe("the press's own wake row under its pending sign-out", () => {
  const ROW = "/push/subscriptions/row-7";

  it("goes out with the reserved word in the jar, the client bound or pending to the account the press named", async () => {
    const { bindApiOwner, pendApiOwner, push } = await import("../app/api-client.js");
    const { OWNER_SIGNED_OUT } = await import("../app/shell/owner-cookie.js");
    answerAccount = A;                     // the session the press is ending is still A's
    for (const bind of [() => bindApiOwner(A), () => { bindApiOwner(null); pendApiOwner(A); }]) {
      setOwnerCookie(A);
      bind();
      setOwnerCookie(OWNER_SIGNED_OUT);
      await expect(push.unsubscribe("row-7", { signingOutOf: A }), "the press's own row was refused").resolves.toBeTruthy();
    }
    expect(asked, "the DELETE never reached the wire").toEqual([`/api${ROW}`, `/api${ROW}`]);
  });

  it.each([
    ["without the pass", { pass: undefined, jar: "pending", bound: "A", path: ROW }, /sign-out was asked for/],
    ["for another account", { pass: B, jar: "pending", bound: "A", path: ROW }, /sign-out was asked for/],
    ["with the jar naming another account", { pass: A, jar: B, bound: "A", path: ROW }, /different account/],
    ["with the jar silent", { pass: A, jar: null, bound: "A", path: ROW }, /lost the name of the account/],
    ["from a public client", { pass: A, jar: "pending", bound: "public", path: ROW }, /sign-out was asked for/],
    ["from a cold shell", { pass: A, jar: "pending", bound: "cold", path: ROW }, /sign-out was asked for/],
    ["after a refused sign-out", { pass: A, jar: "pending", bound: "blocked", path: ROW }, /sign-out was asked for/],
    ["on another path", { pass: A, jar: "pending", bound: "A", path: "/mailboxes" }, /sign-out was asked for/],
    ["on the registration's own announce", { pass: A, jar: "pending", bound: "A", path: "/push/subscriptions" }, /sign-out was asked for/],
  ] as const)("is refused %s", async (_case, c, refusal) => {
    const { api, bindApiOwner, blockApiOwner, pendApiOwner } = await import("../app/api-client.js");
    const { OWNER_SIGNED_OUT } = await import("../app/shell/owner-cookie.js");
    answerAccount = A;
    setOwnerCookie(A);
    if (c.bound === "A") bindApiOwner(A);
    else if (c.bound === "cold") { bindApiOwner(null); pendApiOwner(null); }
    else if (c.bound === "blocked") blockApiOwner();
    else bindApiOwner(null);
    setOwnerCookie(c.jar === "pending" ? OWNER_SIGNED_OUT : c.jar);
    await expect(api(c.path, { method: "DELETE", ...(c.pass === undefined ? {} : { signingOutOf: c.pass }) }))
      .rejects.toThrow(refusal);
    expect(asked, "a refused call reached the wire").toEqual([]);
  });
});

/**
 * ═══ AF-RESPONSE-NOT-OWNER-BOUND — THE ANSWER SAYS WHOSE IT IS ════════════════════════════
 *
 * Every other guard in this file asks the BROWSER: the marker before the request, the marker
 * after it, the gate's confirmation. A session that changes and changes back inside one request's
 * flight leaves all three reading exactly as they did before — the marker says what it said, the
 * confirmation was never seen to lapse — and the response, selected under the other account, is
 * applied. The ruling filed that as unclosable from this side rather than leaving a weaker guard
 * in place to look like one.
 *
 * `X-Ohmail-Account` closes it, because it is the one statement about the answer rather than
 * about the browser. The cases below keep the cookie CONSTANT throughout for exactly that reason:
 * if the marker moved, one of the older guards would be doing the work and these would prove
 * nothing about this one.
 */
describe("the answer names the account it was for", () => {
  it("admits the ordinary answer — the control, without which every refusal below is free", async () => {
    const { api, bindApiOwner, apiOwnerBinding } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    answerAccount = A;
    await expect(api("/mailboxes"), "an answer for this very account was refused").resolves.toBeTruthy();
    expect(apiOwnerBinding(), "an admitted answer disturbed the binding")
      .toEqual({ kind: "bound", owner: A });
  });

  it("refuses an answer produced for another account, with the marker never moving", async () => {
    const { api, bindApiOwner, ApiError, apiOwnerBinding } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    /* THE SEQUENCE, and it is the one nothing else here can see: the browser was B for the
       instant the server resolved this request and is A again by the time the answer lands. Every
       marker read in this process says A, before and after. */
    answerAccount = B;
    await expect(api("/mailboxes"), "another account's answer was applied")
      .rejects.toBeInstanceOf(ApiError);
    expect(document.cookie, "the marker moved, so an older guard could have done this")
      .toContain(`tf_owner=${A}`);
    expect(apiOwnerBinding(), "the confirmation stood after an answer that could not prove itself")
      .toEqual({ kind: "pending", owner: A });
  });

  it("refuses an answer that names NOBODY — absence is not silence", async () => {
    const { api, bindApiOwner, ApiError, accountHeaderCapability } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    /* THE PREMISE, asserted rather than assumed: the requirement is negotiated, and this server
       advertises it. Without that, this case would be measuring the negotiation instead of the
       refusal — and would pass for the wrong reason the day the negotiation broke. */
    expect(accountHeaderCapability(), "the fixture's server does not advertise the header").toBe(true);
    /* An older server, a proxy that strips it, a route that forgot: all the same answer. A client
       that has been told which account it speaks for and receives an answer that cannot say it
       agrees is a client that can no longer prove anything — which is the moment to stop. */
    answerAccount = null;
    await expect(api("/mailboxes"), "an unattributed answer was applied to somebody's mailbox")
      .rejects.toBeInstanceOf(ApiError);
  });

  it("does not ask it of the routes that have no account to name", async () => {
    const { api, bindApiOwner } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    answerAccount = null;
    /* `/hello`, `/version`, `/health` are anonymous by design and answer for nobody. Requiring a
       name here would refuse the capability probe on every signed-in browser — the shape where a
       fail-closed rule fails closed on the thing that has no such state at all. */
    for (const path of ["/hello", "/version", "/health"]) {
      await expect(api(path), `${path} was asked to name an account it has none of`).resolves.toBeTruthy();
    }
  });

  it("the pending shell is held to it too, once it knows which account it is for", async () => {
    const { api, pendApiOwner, ApiError } = await import("../app/api-client.js");
    setOwnerCookie(A);
    pendApiOwner(A);                       // a warm open: the mirror is A's, the confirm is out
    answerAccount = B;
    await expect(api("/mailboxes"), "a warm shell applied another account's answer")
      .rejects.toBeInstanceOf(ApiError);
  });
});

/**
 * ═══ THE SIGN-IN ROUTES, WHERE A DISAGREEMENT IS THE NEW OWNER ════════════════════════════
 *
 * On the credential routes the header names whoever the CREDENTIAL resolved to, which during a
 * sign-in is precisely not the account the cookie still names. Refusing there would refuse every
 * sign-in that follows somebody else's session — the shared-machine case, which is the one this
 * whole slice exists for.
 *
 * Adopting is safe because the server has already refused `409 session_conflict` for any request
 * whose live session and credential disagree. So a disagreement that came back 2xx is not a leak;
 * it is a sign-in that succeeded, and this is how the browser learns whose it now is.
 */
describe("a credential route's answer is the new owner, not a mismatch", () => {
  it("binds to the account the credential resolved to and rewrites the marker", async () => {
    const { api, bindApiOwner, apiOwnerBinding } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    answerAccount = B;                     // somebody else signs in on this machine
    await expect(api("/auth/login", { method: "POST" }), "a successful sign-in was refused")
      .resolves.toBeTruthy();
    expect(apiOwnerBinding(), "the client still speaks for the account that just left")
      .toEqual({ kind: "bound", owner: B });
    expect(document.cookie, "the marker still names the previous account, so every later request refuses")
      .toContain(`tf_owner=${B}`);
  });

  it("…and the SAME disagreement on an ordinary route is still a refusal", async () => {
    const { api, bindApiOwner, ApiError, apiOwnerBinding } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    answerAccount = B;
    /* The exemption is per route and never a general licence. If it leaked, the one sequence the
       header exists to catch would be admitted by the rule written to catch it. */
    await expect(api("/mailboxes"), "an ordinary read adopted another account from its answer")
      .rejects.toBeInstanceOf(ApiError);
    expect(apiOwnerBinding().kind, "an ordinary read bound this client to the answer's account")
      .not.toBe("bound");
  });

  it("establishes nothing when the answer names nobody", async () => {
    const { api, bindApiOwner, apiOwnerBinding } = await import("../app/api-client.js");
    setOwnerCookie(A);
    bindApiOwner(A);
    answerAccount = null;                  // a refused sign-in, or a `twofa_required` challenge
    await expect(api("/auth/login", { method: "POST" })).resolves.toBeTruthy();
    expect(apiOwnerBinding(), "an unfinished sign-in moved the client's account")
      .toEqual({ kind: "bound", owner: A });
    expect(document.cookie, "an unfinished sign-in rewrote the marker").toContain(`tf_owner=${A}`);
  });
});
